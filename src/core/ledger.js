/**
 * The request ledger: every /v1 request an account made, oldest first, with secrets redacted.
 */

const MAX_ENTRIES = 10000;
const KEY_PATTERN = /\b(sk|rk|pk)_(test|live)_([A-Za-z0-9]+)/g;
const SECRET_PATTERN = /\bwhsec_[A-Za-z0-9]+/g;
const SENSITIVE_FIELDS = new Set(['number', 'card_number', 'cvc', 'cvv', 'password', 'secret']);

/** Redacts an API key to its prefix and last four characters: sk_test_****abcd. */
export function redactKey(key) {
  const m = /^((?:sk|rk|pk)_(?:test|live)_)(.*)$/.exec(String(key));
  if (!m) return `****${String(key).slice(-4)}`;
  return `${m[1]}****${m[2].slice(-4)}`;
}

function redactString(s) {
  return s.replace(KEY_PATTERN, (all, a, b, rest) => `${a}_${b}_****${rest.slice(-4)}`).replace(SECRET_PATTERN, 'whsec_****');
}

function maskField(fieldName, value) {
  return fieldName === 'number' || fieldName === 'card_number' ? `****${value.slice(-4)}` : '****';
}

function decodeFormPart(s) {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/**
 * Redacts a raw form string (a body or query that could not be parsed): each `key=value` pair
 * whose last key segment is a sensitive field (card[number] → number) gets its value masked.
 */
export function redactFormString(s) {
  const pairs = s.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const key = decodeFormPart(pair.slice(0, eq));
    const segments = key.match(/[^[\]]+|\[\]/g) || [];
    const field = segments.length ? segments[segments.length - 1] : key;
    if (!SENSITIVE_FIELDS.has(field)) return pair;
    return `${pair.slice(0, eq)}=${encodeURIComponent(maskField(field, decodeFormPart(pair.slice(eq + 1))))}`;
  });
  return redactString(pairs.join('&'));
}

/**
 * Deep copy of a params tree or header map with keys, secrets and card data redacted. A raw
 * `_unparseable` form string is redacted pair by pair.
 */
export function redact(value, fieldName) {
  if (typeof value === 'string') {
    if (fieldName && SENSITIVE_FIELDS.has(fieldName)) return maskField(fieldName, value);
    if (fieldName === '_unparseable') return redactFormString(value);
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export class RequestLedger {
  constructor() {
    this.entries = [];
  }

  /**
   * Records a request. `entry` = { id, method, path, query, body, status, version, idempotencyKey,
   * replayed, fault, time (account clock), durationMs }. query/body are redacted here.
   */
  add(entry) {
    this.entries.push({ ...entry, query: redact(entry.query ?? {}), body: redact(entry.body ?? {}) });
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  /** Entries oldest first; filter by method/path (exact, or prefix ending in '*'); last `limit`. */
  list({ limit, method, path } = {}) {
    let out = this.entries;
    if (method) out = out.filter((e) => e.method === String(method).toUpperCase());
    if (path) {
      const prefix = path.endsWith('*') ? path.slice(0, -1) : null;
      out = out.filter((e) => (prefix !== null ? e.path.startsWith(prefix) : e.path === path));
    }
    if (limit) out = out.slice(-Number(limit));
    return structuredClone(out);
  }

  clear() {
    this.entries = [];
  }
}
