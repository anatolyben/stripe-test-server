/**
 * Request-parameter validation against the generated OpenAPI trees (src/schemas/params.js).
 *
 * Three passes over the parsed params, so errors come in a stable order:
 *   1. unknown parameters (including ones the request's version does not have) → parameter_unknown
 *   2. missing required parameters                                            → parameter_missing
 *   3. types, enums, lengths, '' rules; values are converted (integers, booleans, arrays, ...)
 * Every error is a 400 invalid_request_error marked `validation`, so the idempotency layer never
 * saves it (docs.stripe.com/api/idempotent_requests).
 */
import { OPERATIONS } from '../schemas/params.js';
import { atLeast } from './versions.js';
import { bracketed, toArray } from './form.js';
import { invalidEmpty, invalidInteger, invalidParam, parameterMissing, parameterUnknown } from './errors.js';
import { isSupportedCurrency } from './currency.js';

/** Metadata limits (docs.stripe.com/api/metadata). */
export const METADATA_LIMITS = { keys: 50, keyLength: 40, valueLength: 500 };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Returns the parameter tree of an operation key such as "POST /v1/customers", or undefined. */
export function operationParams(opKey) {
  return OPERATIONS[opKey];
}

/** Finds the operation key for a route such as ('GET', '/v1/customers/:id'). */
export function findOperationKey(method, routePath) {
  const shape = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_]+/g, '{}');
  const want = `${method.toUpperCase()} ${shape(routePath)}`;
  return Object.keys(OPERATIONS).find((key) => {
    const [m, p] = key.split(' ');
    return `${m} ${shape(p)}` === want;
  });
}

/** True when a node exists at `version` (since/until gates). */
function visible(node, version) {
  if (node.since && !atLeast(version, node.since)) return false;
  if (node.until && atLeast(version, node.until)) return false;
  return true;
}

function isRequired(node, version) {
  return Boolean(node.required || (node.requiredUntil && !atLeast(version, node.requiredUntil)));
}

/** Entries of an array given as a real array or as an index map, keeping the sent index. */
function arrayEntries(value) {
  if (Array.isArray(value)) return value.map((v, i) => [String(i), v]);
  if (toArray(value)) {
    return Object.keys(value)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => [String(i), value[String(i)]]);
  }
  return null;
}

function objectVariants(node) {
  return (node.variants || []).filter((v) => v.type === 'object' || v.type === 'map');
}

// Pass 1 ---------------------------------------------------------------------------------------

function checkUnknown(node, value, path, version) {
  if (value === null || typeof value !== 'object') return;
  switch (node.type) {
    case 'object':
      if (!isPlainObject(value)) return;
      for (const [key, child] of Object.entries(value)) {
        const childNode = node.props && Object.hasOwn(node.props, key) ? node.props[key] : undefined;
        if (!childNode || !visible(childNode, version)) throw parameterUnknown(bracketed([...path, key]));
        checkUnknown(childNode, child, [...path, key], version);
      }
      return;
    case 'array': {
      const entries = arrayEntries(value);
      if (entries && node.items) for (const [i, v] of entries) checkUnknown(node.items, v, [...path, i], version);
      return;
    }
    case 'map':
      if (isPlainObject(value) && node.values) {
        for (const [key, child] of Object.entries(value)) checkUnknown(node.values, child, [...path, key], version);
      }
      return;
    case 'anyOf': {
      const candidates = objectVariants(node);
      let firstError = null;
      for (const variant of candidates) {
        try {
          checkUnknown(variant, value, path, version);
          return;
        } catch (err) {
          firstError ||= err;
        }
      }
      if (firstError) throw firstError;
      return;
    }
    default:
  }
}

// Pass 2 ---------------------------------------------------------------------------------------

function checkRequired(node, value, path, version) {
  if (value === '' || value === null || value === undefined) return;
  switch (node.type) {
    case 'object':
      if (!isPlainObject(value)) return;
      for (const [key, child] of Object.entries(node.props || {})) {
        if (!visible(child, version)) continue;
        if (!(key in value)) {
          if (isRequired(child, version)) throw parameterMissing(bracketed([...path, key]));
          continue;
        }
        checkRequired(child, value[key], [...path, key], version);
      }
      return;
    case 'array': {
      const entries = arrayEntries(value);
      if (entries && node.items) for (const [i, v] of entries) checkRequired(node.items, v, [...path, i], version);
      return;
    }
    case 'map':
      if (isPlainObject(value) && node.values) {
        for (const [key, child] of Object.entries(value)) checkRequired(node.values, child, [...path, key], version);
      }
      return;
    case 'anyOf':
      if (isPlainObject(value)) {
        const variants = objectVariants(node);
        if (variants.length === 1) checkRequired(variants[0], value, path, version);
      }
      return;
    default:
  }
}

// Pass 3 ---------------------------------------------------------------------------------------

function listWords(values) {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

function allowedEnum(node, version) {
  return node.enum.filter((v) => {
    const gate = node.enumGates?.[v];
    return !gate || visible(gate, version);
  });
}

function convertString(node, value, param, version) {
  if (typeof value !== 'string') throw invalidParam(param, `Invalid string: ${JSON.stringify(value)}`);
  let out = value;
  if (node.format === 'currency') {
    out = value.toLowerCase();
    if (!isSupportedCurrency(out)) throw invalidParam(param, `Invalid currency: ${value}.`);
  }
  if (node.format === 'decimal' && !/^-?\d+(\.\d{1,12})?$/.test(out)) {
    throw invalidParam(param, `Invalid decimal: ${value}`);
  }
  if (node.maxLength && out.length > node.maxLength) {
    throw invalidParam(param, `Invalid string: ${out.slice(0, 50)}${out.length > 50 ? '...' : ''}; must be at most ${node.maxLength} characters`);
  }
  if (node.enum) {
    const allowed = allowedEnum(node, version);
    const gated = node.enumGates?.[out] && !allowed.includes(out);
    if (gated || (!node.open && !allowed.includes(out))) {
      throw invalidParam(param, `Invalid ${param}: must be one of ${listWords(allowed)}`);
    }
  }
  return out;
}

function checkMetadata(value, path) {
  const keys = Object.keys(value);
  const param = bracketed(path);
  if (keys.length > METADATA_LIMITS.keys) {
    throw invalidParam(param, `Invalid ${param}: metadata can have at most ${METADATA_LIMITS.keys} keys`);
  }
  for (const key of keys) {
    if (key.length > METADATA_LIMITS.keyLength) {
      throw invalidParam(bracketed([...path, key]), `Metadata key length must be at most ${METADATA_LIMITS.keyLength} characters: ${key}`);
    }
    const v = value[key];
    if (typeof v === 'string' && v.length > METADATA_LIMITS.valueLength) {
      throw invalidParam(bracketed([...path, key]), `Metadata values can have up to ${METADATA_LIMITS.valueLength} characters, but you passed in a value that is ${v.length} characters.`);
    }
  }
}

function convert(node, value, path, version) {
  const param = bracketed(path);
  if (value === '') {
    if (node.empty) return '';
    throw invalidEmpty(param);
  }
  switch (node.type) {
    case 'string':
      return convertString(node, value, param, version);
    case 'integer': {
      if (typeof value !== 'string' || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw invalidInteger(param, typeof value === 'string' ? value : JSON.stringify(value));
      }
      return Number(value);
    }
    case 'number': {
      if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) {
        throw invalidParam(param, `Invalid decimal: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
      return Number(value);
    }
    case 'boolean':
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw invalidParam(param, `Invalid boolean: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    case 'object': {
      if (!isPlainObject(value)) throw invalidParam(param, `Invalid object`);
      const out = {};
      for (const [key, child] of Object.entries(value)) out[key] = convert(node.props[key], child, [...path, key], version);
      return out;
    }
    case 'map': {
      if (!isPlainObject(value)) throw invalidParam(param, `Invalid object`);
      if (path[path.length - 1] === 'metadata') checkMetadata(value, path);
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        // '' inside a map unsets that key (docs.stripe.com/metadata).
        out[key] = child === '' ? '' : node.values ? convert(node.values, child, [...path, key], version) : child;
      }
      return out;
    }
    case 'array': {
      const entries = arrayEntries(value);
      if (!entries) throw invalidParam(param, `Invalid array`);
      return entries.map(([i, v]) => (node.items ? convert(node.items, v, [...path, i], version) : v));
    }
    case 'anyOf': {
      const errors = [];
      for (const variant of node.variants) {
        try {
          return convert(variant, value, path, version);
        } catch (err) {
          errors.push({ type: variant.type, err });
        }
      }
      // Report the error of the alternative the value was most likely meant for.
      const pick = (...types) => errors.find((e) => types.includes(e.type));
      const numeric = typeof value === 'string' && /^-?\d/.test(value);
      const best = isPlainObject(value)
        ? pick('object', 'map')
        : Array.isArray(value)
          ? pick('array')
          : numeric
            ? pick('integer', 'number') || pick('string')
            : pick('string') || pick('integer', 'number', 'boolean');
      throw (best || errors[0])?.err ?? invalidParam(param, `Invalid ${param}`);
    }
    default:
      return value;
  }
}

/**
 * Validates `raw` (the parsed body or query) for operation `opKey` at `version`.
 * Returns the converted params; throws a StripeError on the first problem.
 */
export function validateParams(opKey, raw, version) {
  const props = OPERATIONS[opKey];
  if (!props) throw new Error(`No parameter schema for ${opKey}`);
  const root = { type: 'object', props };
  const value = raw || {};
  checkUnknown(root, value, [], version);
  checkRequired(root, value, [], version);
  return convert(root, value, [], version);
}

/** Validates against an ad-hoc tree in the same node format (used for control inputs and tests). */
export function validateTree(props, raw, version) {
  const root = { type: 'object', props };
  checkUnknown(root, raw, [], version);
  checkRequired(root, raw, [], version);
  return convert(root, raw, [], version);
}
