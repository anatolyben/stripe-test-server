/**
 * Small shared helpers for resource modules.
 */
import { invalidParam, invalidRequest } from './errors.js';
import { METADATA_LIMITS } from './validate.js';

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Applies a metadata param to existing metadata (docs.stripe.com/metadata): keys merge, `key: ''` removes
 * one key, `''` removes all. Returns the new metadata object; throws past 50 keys.
 */
export function applyMetadata(existing, sent, { param = 'metadata' } = {}) {
  if (sent === undefined) return existing ?? {};
  if (sent === '') return {};
  const out = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(sent)) {
    if (v === '') delete out[k];
    else out[k] = String(v);
  }
  if (Object.keys(out).length > METADATA_LIMITS.keys) {
    throw invalidParam(param, `Invalid ${param}: metadata can have at most ${METADATA_LIMITS.keys} keys`);
  }
  return out;
}

/**
 * Merges an update param into a nested hash: objects merge key by key, arrays and
 * scalars replace, '' clears a key to null. `''` for the whole param returns null.
 */
export function mergeHash(existing, sent) {
  if (sent === undefined) return existing;
  if (sent === '') return null;
  if (!isPlainObject(sent)) return sent;
  const out = isPlainObject(existing) ? { ...existing } : {};
  for (const [k, v] of Object.entries(sent)) {
    if (v === '') out[k] = null;
    else if (isPlainObject(v)) out[k] = mergeHash(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** An address param → the six-key address object (null for absent fields), or null for ''. */
export function normalizeAddress(sent) {
  if (sent === undefined) return undefined;
  if (sent === '' || sent === null) return null;
  return {
    city: sent.city ?? null,
    country: sent.country ?? null,
    line1: sent.line1 ?? null,
    line2: sent.line2 ?? null,
    postal_code: sent.postal_code ?? null,
    state: sent.state ?? null,
  };
}

/** True for an absolute http(s) URL (webhook endpoints, portal URLs). */
export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Throws url_invalid ("The URL provided is invalid.", docs.stripe.com/error-codes) for a value that
 * is not an absolute http(s) URL; null and undefined pass. Portal configurations and sessions,
 * Checkout Sessions (success_url, cancel_url, return_url).
 */
export function checkUrl(value, param) {
  if (value !== null && value !== undefined && !isHttpUrl(value)) {
    throw invalidRequest('The URL provided is invalid.', { param, code: 'url_invalid', validation: true });
  }
}

/** '' (the unset marker) → null; anything else unchanged. */
export function unsetToNull(value) {
  return value === '' ? null : value;
}

/** Copies the listed keys of `src` that are present (not undefined) into `dst`. */
export function assignDefined(dst, src, keys) {
  for (const k of keys) if (src[k] !== undefined) dst[k] = src[k];
  return dst;
}
