/**
 * Time domains and the due-transition engine.
 *
 * Each account has a virtual clock (real time + offset) — the `null` domain — and one domain per
 * Stripe test clock ('clock_…'), whose time is the clock's frozen time. Objects of a customer with
 * a test clock live in that clock's domain.
 *
 * Billing work that happens later (renewals, trial ends, finalizations, retries, ...) is scheduled
 * as jobs. Jobs of a domain run in chronological order (then by priority, then scheduling order)
 * when the domain's time moves: `advance` (advanceTime control, test clock advance) or `catchUp`
 * (before every request, up to the account clock's current time). While a job runs, `now(domain)`
 * returns the job's time, so objects and events it creates carry that timestamp.
 */

/** Priorities for jobs due at the same second (lower runs first). Shared by every module. */
export const JOB_PRIORITY = Object.freeze({
  schedulePhase: 10,
  trialWillEnd: 15,
  trialEnd: 20,
  cancelAt: 25,
  renewal: 30,
  invoiceFinalize: 40,
  paymentRetry: 50,
  incompleteExpire: 60,
  checkoutExpire: 70,
  default: 100,
});

const MAX_JOBS_PER_RUN = 100000;

export class TimeEngine {
  /**
   * @param {import('./account.js').Account} account
   * @param {Map<string, Function>} handlers job kind → handler(account, job)
   */
  constructor(account, handlers) {
    this.account = account;
    this.handlers = handlers;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.clocks = new Map();
    this.jobs = [];
    this.seq = 0;
    this.processing = new Map();
    this.lastRun = new Map();
    this.running = false;
  }

  realNow() {
    return Math.floor(Date.now() / 1000);
  }

  /** Current time (unix seconds) of a domain: null = the account clock, 'clock_…' = a test clock. */
  now(domain = null) {
    const d = domain && this.clocks.has(domain) ? domain : null;
    if (this.processing.has(d)) return this.processing.get(d);
    if (d) return this.clocks.get(d);
    return this.realNow() + this.offset;
  }

  /**
   * The domain an object lives in: its test clock, or its customer's test clock, else null.
   * Accepts an object or an ID.
   */
  domainOf(ref) {
    if (!ref) return null;
    const obj = typeof ref === 'string' ? this.account.store.find(ref) : ref;
    if (!obj) return null;
    let clock = null;
    if (obj.object === 'test_helpers.test_clock') clock = obj.id;
    else if (typeof obj.test_clock === 'string') clock = obj.test_clock;
    else if (obj.test_clock && typeof obj.test_clock === 'object') clock = obj.test_clock.id;
    else if (typeof obj.customer === 'string') clock = this.account.store.get('customer', obj.customer)?.test_clock ?? null;
    return clock && this.clocks.has(clock) ? clock : null;
  }

  // Test clock domains ---------------------------------------------------------------------------

  registerClock(clockId, frozenTime) {
    this.clocks.set(clockId, frozenTime);
  }

  /** Forgets a clock and drops its pending jobs. */
  removeClock(clockId) {
    this.clocks.delete(clockId);
    this.jobs = this.jobs.filter((j) => j.domain !== clockId);
  }

  // Jobs ---------------------------------------------------------------------------------------

  /**
   * Schedules a job. A job with the same `key` is replaced (use keys such as `${sub.id}:renewal`).
   * @returns the job record { id, kind, at, domain, key, data, priority, seq }
   */
  schedule({ kind, at, domain = null, key, data = {}, priority = JOB_PRIORITY.default }) {
    if (!this.handlers.has(kind)) throw new Error(`Unknown job kind: ${kind}`);
    if (!Number.isFinite(at)) throw new Error(`Job ${kind} needs a numeric 'at'`);
    if (key !== undefined) this.cancel(key);
    const job = { id: `job_${++this.seq}`, kind, at: Math.floor(at), domain, key, data, priority, seq: this.seq };
    this.jobs.push(job);
    return job;
  }

  /** Cancels the job with `key`. Returns true when one was removed. */
  cancel(key) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.key !== key);
    return this.jobs.length !== before;
  }

  /** Cancels every job matching `predicate(job)`; returns how many were removed. */
  cancelWhere(predicate) {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => !predicate(j));
    return before - this.jobs.length;
  }

  /** Pending jobs, soonest first; filter by domain (use undefined for all) and kind. */
  list({ domain, kind } = {}) {
    return this.jobs
      .filter((j) => (domain === undefined || j.domain === domain) && (!kind || j.kind === kind))
      .sort(compareJobs)
      .map((j) => ({ ...j, data: structuredClone(j.data) }));
  }

  /** Earliest job of `domain` due at or before `target`, or null. */
  nextDue(domain, target) {
    let best = null;
    for (const j of this.jobs) {
      if (j.domain !== domain || j.at > target) continue;
      if (!best || compareJobs(j, best) < 0) best = j;
    }
    return best;
  }

  /**
   * Runs every job of `domain` due up to `target`, in order. Jobs may schedule further jobs; those
   * run too when due before `target`. Afterwards a test clock's time is set to `target`.
   * @returns the number of jobs run
   */
  advance(domain, target) {
    if (this.running) throw new Error('time.advance called while jobs are running');
    const d = domain ?? null;
    this.running = true;
    let count = 0;
    try {
      let floor = d ? this.clocks.get(d) ?? 0 : this.lastRun.get(null) ?? 0;
      for (;;) {
        const job = this.nextDue(d, target);
        if (!job) break;
        this.jobs.splice(this.jobs.indexOf(job), 1);
        floor = Math.max(floor, job.at);
        this.processing.set(d, floor);
        const handler = this.handlers.get(job.kind);
        const previousRequest = this.account.currentRequest;
        this.account.currentRequest = null;
        try {
          handler(this.account, job);
        } catch (err) {
          this.account.server.log('error', `job ${job.kind} failed: ${err && err.stack ? err.stack : err}`);
        } finally {
          this.account.currentRequest = previousRequest;
        }
        if (++count > MAX_JOBS_PER_RUN) throw new Error('Too many jobs in one time advance (runaway schedule?)');
      }
    } finally {
      this.processing.delete(d);
      this.running = false;
    }
    if (d) this.clocks.set(d, Math.max(this.clocks.get(d) ?? 0, target));
    else this.lastRun.set(null, Math.max(this.lastRun.get(null) ?? 0, target));
    return count;
  }

  /** Runs account-clock jobs that became due with the passage of real time. */
  catchUp() {
    if (this.running) return 0;
    return this.advance(null, this.now(null));
  }

  /**
   * Moves the account clock forward by `seconds` or to `to` (unix seconds), running due jobs.
   * @returns the new account time
   */
  advanceAccountClock({ seconds, to }) {
    const current = this.now(null);
    const target = to !== undefined ? Math.floor(to) : current + Math.floor(seconds);
    if (!Number.isFinite(target)) throw new Error('advanceTime needs seconds or to');
    if (target < current) throw new RangeError(`Cannot move the clock backwards (now ${current}, requested ${target})`);
    this.advance(null, target);
    this.offset = target - this.realNow();
    return target;
  }
}

function compareJobs(a, b) {
  return a.at - b.at || a.priority - b.priority || a.seq - b.seq;
}
