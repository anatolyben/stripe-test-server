/**
 * Fault injection for /v1 requests (per account). A fault answers matching requests before they
 * reach idempotency, validation or the handler, so it never changes state:
 *   "500"     500 api_error (the SDK retries 5xx by default; `times` decides how many attempts fail)
 *   "429"     429 rate_limit with Stripe-Rate-Limited-Reason (the SDK does not retry it)
 *   "timeout" no response: the connection is held until the client gives up (so the SDK's own
 *             timeout fires and it reports StripeConnectionError), or, when `timeoutMs` is set,
 *             dropped after that many ms. A dropped connection is a reset to the SDK, which
 *             retries it once even with maxNetworkRetries 0, so `times` must cover it.
 */
import { invalidRequest } from './errors.js';

export const FAULT_KINDS = ['500', '429', 'timeout'];
/** The largest delay setTimeout honours (larger values fire after 1 ms). */
export const MAX_TIMEOUT_MS = 2147483647;

export class FaultList {
  constructor() {
    this.faults = [];
    this.seq = 0;
  }

  /** Validates and adds a fault; returns its description. */
  add(spec = {}) {
    const kind = String(spec.kind ?? '');
    if (!FAULT_KINDS.includes(kind)) {
      throw invalidRequest(`Invalid kind: must be one of ${FAULT_KINDS.join(', ')}`, { param: 'kind' });
    }
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
      throw invalidRequest('path must be a string starting with "/" (end it with * to match a prefix)', { param: 'path' });
    }
    const times = spec.times === undefined ? 1 : Number(spec.times);
    if (!Number.isInteger(times) || times < 1) throw invalidRequest('times must be a positive integer', { param: 'times' });
    const timeoutMs = spec.timeoutMs === undefined || spec.timeoutMs === null ? null : Number(spec.timeoutMs);
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS)) {
      throw invalidRequest(`timeoutMs must be a number between 0 and ${MAX_TIMEOUT_MS}`, { param: 'timeoutMs' });
    }
    const fault = {
      id: `fault_${++this.seq}`,
      method: spec.method ? String(spec.method).toUpperCase() : null,
      path: spec.path,
      kind,
      times,
      remaining: times,
      timeoutMs,
    };
    this.faults.push(fault);
    return { ...fault };
  }

  /** The first matching fault with attempts left (consuming one), or null. */
  take(method, path) {
    for (const f of this.faults) {
      if (f.remaining < 1) continue;
      if (f.method && f.method !== method) continue;
      const matches = f.path.endsWith('*') ? path.startsWith(f.path.slice(0, -1)) : path === f.path;
      if (!matches) continue;
      f.remaining -= 1;
      return { ...f };
    }
    return null;
  }

  list() {
    return this.faults.map((f) => ({ ...f }));
  }

  clear() {
    const n = this.faults.length;
    this.faults = [];
    return n;
  }
}
