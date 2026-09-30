/**
 * Form and query-string parsing with Stripe's bracket notation.
 *
 *   a[b][c]=v           → { a: { b: { c: 'v' } } }
 *   items[0][price]=p   → { items: { 0: { price: 'p' } } }   (index maps; the validator turns
 *                                                             them into arrays where the schema
 *                                                             says "array": see toArray)
 *   expand[]=a&expand[]=b → { expand: ['a', 'b'] }
 *   k=                  → { k: '' }   ('' means "unset")
 *
 * Brackets may be percent-encoded; '+' decodes to a space. Values are always strings.
 */
import { invalidRequest } from './errors.js';

const INDEX = /^(0|[1-9]\d*)$/;

function decode(s) {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch {
    return plus;
  }
}

/** Splits "items[0][price]" into ["items", "0", "price"]; "expand[]" into ["expand", ""]. */
export function splitKey(key) {
  const m = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
  if (!m) return [key];
  const parts = [m[1]];
  const re = /\[([^[\]]*)\]/g;
  let x;
  while ((x = re.exec(m[2]))) parts.push(x[1]);
  return parts;
}

function conflict(path) {
  return invalidRequest(`Invalid value for ${bracketed(path)}: it is given both as a value and as a hash.`, {
    param: bracketed(path),
    validation: true,
  });
}

/** Formats a path array as Stripe's bracketed parameter name: items[0][price]. */
export function bracketed(path) {
  return path.length ? path[0] + path.slice(1).map((p) => `[${p}]`).join('') : '';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** An own property of `obj`, never an inherited one (so `valueOf[x]=1` cannot reach Object.prototype). */
function getOwn(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Defines an own data property, so no key (not even `__proto__`) runs a setter or touches a prototype. */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Sets `value` at `parts` inside `container` (an object or array). Every key, including names such
 * as `__proto__`, `constructor` or `valueOf`, becomes an ordinary own key, which the validator then
 * rejects as an unknown parameter where the schema does not have it.
 */
function assign(container, parts, value, trail) {
  const [head, ...rest] = parts;
  if (Array.isArray(container) && head === '') {
    // "[]": push, or keep filling the last element until one of its keys repeats (Rails style).
    if (!rest.length) {
      container.push(value);
      return;
    }
    let last = container[container.length - 1];
    if (!isPlainObject(last) || hasPath(last, rest)) {
      last = {};
      container.push(last);
    }
    assign(last, rest, value, [...trail, String(container.length - 1)]);
    return;
  }
  const key = head;
  if (!rest.length) {
    const existing = getOwn(container, key);
    if (isPlainObject(existing) || Array.isArray(existing)) throw conflict([...trail, key]);
    setOwn(container, key, value);
    return;
  }
  const wantsArray = rest[0] === '';
  let child = getOwn(container, key);
  if (child === undefined) {
    child = wantsArray ? [] : {};
    setOwn(container, key, child);
  } else if (typeof child === 'string') {
    throw conflict([...trail, key]);
  } else if (wantsArray && !Array.isArray(child)) {
    throw conflict([...trail, key]);
  } else if (!wantsArray && Array.isArray(child)) {
    if (!INDEX.test(rest[0])) throw conflict([...trail, key]);
    // Mixed "a[]=x&a[3]=y": continue as an index map.
    child = Object.fromEntries(child.map((v, i) => [String(i), v]));
    setOwn(container, key, child);
  }
  assign(child, rest, value, [...trail, key]);
}

function hasPath(obj, parts) {
  let cur = obj;
  for (const p of parts) {
    if (p === '' || !isPlainObject(cur) || !Object.hasOwn(cur, p)) return false;
    cur = cur[p];
  }
  return true;
}

/** Parses a form-encoded string (request body or query string) into a nested object. */
export function parseForm(input) {
  const out = {};
  if (!input) return out;
  for (const segment of String(input).split('&')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    const rawKey = eq === -1 ? segment : segment.slice(0, eq);
    const rawValue = eq === -1 ? '' : segment.slice(eq + 1);
    const key = decode(rawKey);
    if (!key) continue;
    assign(out, splitKey(key), decode(rawValue), []);
  }
  return out;
}

/**
 * Turns an index map ({0: a, 1: b}) into an array. Returns null when `value` is not an index map.
 * Arrays pass through unchanged.
 */
export function toArray(value) {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length || !keys.every((k) => INDEX.test(k))) return null;
  return keys
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => value[String(i)]);
}

/**
 * Encodes an object in the SDK's style (indexed arrays, literal brackets). Used by tests and by
 * hosted pages that post forms back to the API shape.
 */
export function encodeForm(data) {
  const pairs = [];
  const enc = (s) => encodeURIComponent(s).replace(/%5B/g, '[').replace(/%5D/g, ']');
  const walk = (key, value) => {
    if (value === undefined) return;
    if (value === null || typeof value !== 'object') {
      pairs.push(`${enc(key)}=${enc(value === null ? '' : String(value))}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else {
      for (const k of Object.keys(value)) walk(`${key}[${k}]`, value[k]);
    }
  };
  for (const k of Object.keys(data || {})) walk(k, data[k]);
  return pairs.join('&');
}
