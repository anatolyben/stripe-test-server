/**
 * Idempotency keys (docs.stripe.com/api/idempotent_requests).
 * Per account: key → the first request's endpoint, canonical params, status and body. Entries
 * expire 24 hours after creation on the account clock.
 */
import { toArray } from './form.js';
import { idempotencyError } from './errors.js';

export const MAX_KEY_LENGTH = 255;
export const KEY_TTL_SECONDS = 24 * 60 * 60;

/** Canonical JSON of a parsed param tree: sorted keys, index maps as arrays. */
export function canonicalParams(value) {
  const norm = (v) => {
    const arr = toArray(v);
    if (arr) return arr.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value ?? {}));
}

export class IdempotencyStore {
  constructor() {
    this.entries = new Map();
  }

  /** Throws the 400 idempotency_error for an over-long key (not saved). */
  static checkKey(key) {
    if (key.length > MAX_KEY_LENGTH) {
      throw idempotencyError(`Idempotency keys can be at most ${MAX_KEY_LENGTH} characters long; the key you passed has ${key.length}.`);
    }
  }

  /** The live entry for `key`, or undefined (expired entries are dropped). */
  lookup(key, now) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.createdAt >= KEY_TTL_SECONDS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Throws when a stored entry was made for another endpoint or other params. */
  static assertSameRequest(entry, key, method, path, params) {
    if (entry.method !== method || entry.path !== path || entry.params !== params) {
      throw idempotencyError(
        `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
      );
    }
  }

  /**
   * Saves an entry (entry.createdAt = account-clock seconds) and prunes the expired ones: keys "can
   * be pruned" 24 hours after creation. The Map keeps insertion order and the account clock never
   * goes back without a reset, so the expired entries are at the front.
   */
  save(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    for (const [k, e] of this.entries) {
      if (entry.createdAt - e.createdAt < KEY_TTL_SECONDS) break;
      this.entries.delete(k);
    }
  }

  clear() {
    this.entries.clear();
  }
}
