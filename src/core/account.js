/**
 * An account: everything that belongs to one API key. Objects, clocks, jobs,
 * events, idempotency keys, the request ledger, faults, settings, webhook endpoints and every
 * module's private state are separate per key and are cleared by reset().
 */
import { IdMinter, hashToken } from './ids.js';
import { Store } from './store.js';
import { TimeEngine } from './time.js';
import { EventStore } from './events.js';
import { IdempotencyStore } from './idempotency.js';
import { RequestLedger } from './ledger.js';
import { FaultList } from './faults.js';

export class Account {
  /**
   * @param {import('./server.js').ServerContext} server
   * @param {string} key the API key (sk_test_… / rk_test_…)
   */
  constructor(server, key) {
    this.server = server;
    this.key = key;
    this.id = `acct_${hashToken(`account|${key}`, 16)}`;
    this.ids = new IdMinter(key);
    this.store = new Store();
    this.time = new TimeEngine(this, server.registry.jobs);
    this.events = new EventStore();
    this.idempotency = new IdempotencyStore();
    this.ledger = new RequestLedger();
    this.faults = new FaultList();
    this.queue = Promise.resolve();
    this.initState();
  }

  initState() {
    /** Account settings: default API version and Billing settings. */
    this.settings = {
      apiVersion: this.server.options.apiVersion,
      billing: structuredClone(this.server.options.billing),
    };
    /** Webhook endpoints added for this account; server-wide ones live on the server. */
    this.webhookEndpoints = [];
    /** Private state of modules: account.state.<module> (use moduleState()). */
    this.state = {};
    /** The API request being handled ({id, idempotency_key}) or null. */
    this.currentRequest = null;
  }

  /** A new deterministic ID ('cus' → 'cus_…'), registered so hosted pages can find the account. */
  mintId(prefix, length = 24) {
    const id = this.ids.next(prefix, length);
    this.server.registerId(id, this);
    return id;
  }

  /** Current time of a domain (null = the account clock). */
  now(domain = null) {
    return this.time.now(domain);
  }

  /** A module's private state bag, created by `init()` on first use and cleared on reset. */
  moduleState(name, init) {
    if (!(name in this.state)) this.state[name] = init();
    return this.state[name];
  }

  /** Runs `fn` after every earlier queued task of this account (all mutations are serialized). */
  run(fn) {
    const next = this.queue.then(() => fn());
    this.queue = next.catch(() => {});
    return next;
  }

  /** Clears all state of this account (objects, time, events, keys, ledger, faults, settings). */
  reset() {
    this.server.registry.runHooks('account.reset', this);
    this.server.unregisterIds(this);
    this.ids.reset();
    this.store.clear();
    this.time.reset();
    this.events.clear();
    this.idempotency.clear();
    this.ledger.clear();
    this.faults.clear();
    this.initState();
  }
}
