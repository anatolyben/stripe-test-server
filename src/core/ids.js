/**
 * Deterministic IDs: prefix + "_" + base62 characters derived from a hash of (seed, prefix, n).
 * Each account seeds its minter with its API key, so the same sequence of calls always yields the
 * same IDs, and IDs from different accounts never collide in practice (24 characters).
 */
import { createHash } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** `length` base62 characters derived from `input`. */
export function hashToken(input, length = 24) {
  let out = '';
  for (let block = 0; out.length < length; block++) {
    const digest = createHash('sha256').update(`${input}#${block}`).digest();
    for (const byte of digest) {
      if (byte >= 248) continue; // 248 = 62 * 4: keeps the characters uniform
      out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export class IdMinter {
  constructor(seed) {
    this.seed = seed;
    this.counters = new Map();
  }

  /** Next ID for `prefix` ('cus', 'cs_test', 'req', ...). */
  next(prefix, length = 24) {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${hashToken(`${this.seed}|${prefix}|${n}`, length)}`;
  }

  reset() {
    this.counters.clear();
  }
}
