#!/usr/bin/env node
/**
 * Builds src/schemas/params.js: the request-parameter tree of every operation the server
 * implements, with the API-version gates each request is checked against.
 *
 * src/schemas/params.js is committed, so this script runs when supported operations or Stripe API versions change. Its inputs are not in this repository. All of them come from Stripe's
 * public OpenAPI repository, github.com/stripe/openapi (tags vNNNN; each tag's
 * openapi/spec3.json states its API version in `info.version`):
 *
 *   --specs <dir>    openapi/spec3.json at every tag in SNAPSHOTS below (v1267 … v2442), saved as
 *                    <tag>-spec3.json, and openapi/spec3.sdk.json at tag v2442, saved as
 *                    v2442-spec3.sdk.json. Tag v2442 (2026-08-26.dahlia) is the one
 *                    stripe-node 22.6.2 names in its OPENAPI_VERSION file, and the base of the
 *                    output.
 *   --params <file>  the parameter trees of 45 of the operations, taken from openapi/spec3.json at
 *                    tag v2526, as JSON: { "<METHOD> <path>": { path_params, query_params,
 *                    body_params, "compare_2026-08-26.dahlia" }, _meta }. Tree nodes use the
 *                    fields extractNode() below produces. The compare entry is either
 *                    "identical to latest" or lists the dotted parameter paths (prefixed body: or
 *                    query:) that differ from tag v2442: params_not_in_this_version_spec,
 *                    params_only_in_this_version_spec and changed. The script moves each tree back
 *                    to v2442 and fails unless the result matches its own extraction from
 *                    v2442-spec3.json; the other operations (EXTRA_OPERATIONS) are extracted from
 *                    v2442 directly.
 *   --latest <file>  optional: openapi/spec3.json at tag v2526. When given, the script first
 *                    proves that its extractor reproduces the --params trees node for node.
 *
 * On top of the spec, the tables below add what Stripe's changelog and API reference document but
 * the spec snapshots do not show: exact version gates, removals, relaxed requirements, Checkout
 * `ui_mode` values per version, and parameters the reference marks as required.
 *
 * Usage:
 *   node scripts/build-param-schemas.mjs --params <trees.json> --specs <dir> [--latest spec3.json]
 *
 * Output node format (see src/core/validate.js for how it is enforced):
 *   type      'string' | 'integer' | 'number' | 'boolean' | 'object' | 'map' | 'array' | 'anyOf'
 *   required  true when the parameter must be present
 *   empty     true when "" is accepted (it means "unset")
 *   enum      allowed values; the server rejects others unless `open` (only for the params in
 *             SERVER_OPEN_ENUMS: the spec's x-stripeBypassValidation only tells SDKs to accept
 *             future values, the API itself still validates)
 *   maxLength, format ('unix-time' | 'decimal' | 'currency')
 *   props / items / values / variants   children of object / array / map / anyOf nodes
 *   since / until       the parameter exists only for versions >= since and < until
 *   requiredUntil       required only for versions < requiredUntil
 *   enumGates           { value: { since?, until? } } for enum values that depend on the version
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'schemas', 'params.js');

/** Spec snapshots, oldest first, with the API version each one describes. */
const SNAPSHOTS = [
  ['v1267', '2024-06-20'],
  ['v1268', '2024-09-30.acacia'],
  ['v1617', '2025-02-24.acacia'],
  ['v1618', '2025-03-31.basil'],
  ['v2017', '2025-08-27.basil'],
  ['v2018', '2025-09-30.clover'],
  ['v2203', '2026-02-25.clover'],
  ['v2204', '2026-03-25.dahlia'],
  ['v2442', '2026-08-26.dahlia'],
];
const BASE_TAG = 'v2442';

/** Operations outside the 45 in the params file, taken from the v2442 spec with the same extractor. */
const EXTRA_OPERATIONS = [
  "POST /v1/invoiceitems",
  "GET /v1/invoiceitems",
  "GET /v1/invoiceitems/{invoiceitem}",
  "POST /v1/invoiceitems/{invoiceitem}",
  "DELETE /v1/invoiceitems/{invoiceitem}",
  "POST /v1/invoices",
  "POST /v1/invoices/{invoice}",
  "DELETE /v1/invoices/{invoice}",
  "POST /v1/refunds",
  "GET /v1/refunds",
  "GET /v1/refunds/{refund}",
  "POST /v1/refunds/{refund}",
  "POST /v1/refunds/{refund}/cancel",
  "POST /v1/credit_notes",
  "GET /v1/credit_notes",
  "GET /v1/credit_notes/{id}",
  "POST /v1/credit_notes/{id}",
  "POST /v1/credit_notes/{id}/void",
  "GET /v1/credit_notes/{credit_note}/lines",
  "GET /v1/credit_notes/preview",
  "GET /v1/credit_notes/preview/lines",
  'GET /v1/customers',
  'GET /v1/products',
  'DELETE /v1/products/{id}',
  'GET /v1/checkout/sessions',
  'POST /v1/checkout/sessions/{session}',
  'GET /v1/checkout/sessions/{session}/line_items',
  'POST /v1/subscription_schedules/{schedule}',
  'GET /v1/subscription_items',
  'GET /v1/subscription_items/{item}',
  'GET /v1/invoices/{invoice}/lines',
  'POST /v1/invoices/{invoice}/mark_uncollectible',
  'GET /v1/invoice_payments',
  'GET /v1/invoice_payments/{invoice_payment}',
  'GET /v1/payment_intents/{intent}',
  'GET /v1/charges/{charge}',
  'GET /v1/payment_methods',
  'GET /v1/customers/{customer}/payment_methods/{payment_method}',
  'DELETE /v1/test_helpers/test_clocks/{test_clock}',
  'POST /v1/webhook_endpoints',
  'GET /v1/webhook_endpoints',
  'GET /v1/webhook_endpoints/{webhook_endpoint}',
  'POST /v1/webhook_endpoints/{webhook_endpoint}',
  'DELETE /v1/webhook_endpoints/{webhook_endpoint}',
];

/**
 * Documented version gates: parameters added in a later version than the snapshots show (Stripe's
 * changelog and API reference). Keys are dotted parameter paths; `[]` steps into array items.
 */
const ADDED_SINCE = {
  'POST /v1/credit_notes': { refunds: '2025-03-31.basil' },
  'GET /v1/credit_notes/preview': { refunds: '2025-03-31.basil' },
  'GET /v1/credit_notes/preview/lines': { refunds: '2025-03-31.basil' },
  'POST /v1/subscriptions': { billing_schedules: '2026-05-27.dahlia', billing_mode: '2025-06-30.basil' },
  'POST /v1/subscriptions/{subscription_exposed_id}': { billing_schedules: '2026-05-27.dahlia' },
  'POST /v1/subscription_schedules': { billing_mode: '2025-06-30.basil' },
  'POST /v1/checkout/sessions': { 'subscription_data.billing_mode': '2025-06-30.basil' },
  'POST /v1/billing_portal/configurations': {
    'features.subscription_update.schedule_at_period_end': '2024-10-28.acacia',
    'features.subscription_update.trial_update_behavior': '2025-09-30.clover',
  },
  'POST /v1/billing_portal/configurations/{configuration}': {
    'features.subscription_update.schedule_at_period_end': '2024-10-28.acacia',
    'features.subscription_update.trial_update_behavior': '2025-09-30.clover',
  },
};

/** Removal dates that the changelog states more precisely than the snapshot interval. */
const REMOVED_AT = {
  'POST /v1/checkout/sessions': { 'line_items[].dynamic_tax_rates': '2026-07-29.dahlia' },
};

/** Required-before dates that the changelog states more precisely than the snapshot interval. */
const REQUIRED_UNTIL = {
  'POST /v1/billing_portal/configurations': { business_profile: '2024-10-28.acacia' },
};

/** Enum values that exist only in some versions (Checkout ui_mode, renamed in 2026-03-25.dahlia). */
const DAHLIA = '2026-03-25.dahlia';
const ENUM_GATES = {
  'POST /v1/checkout/sessions': {
    ui_mode: {
      hosted: { until: DAHLIA },
      embedded: { until: DAHLIA },
      custom: { since: '2025-03-31.basil', until: DAHLIA },
      hosted_page: { since: DAHLIA },
      embedded_page: { since: DAHLIA },
      elements: { since: DAHLIA },
      form: { since: DAHLIA },
    },
  },
};

/**
 * Enums the server leaves open: webhook endpoint api_version also takes dated `.preview` versions,
 * which the enum does not list (the endpoint module validates the value itself).
 */
const SERVER_OPEN_ENUMS = {
  'POST /v1/webhook_endpoints': ['api_version'],
};

/**
 * Parameters the API reference marks required although the spec does not, and `customer`, which
 * this server always requires because Accounts v2 (`customer_account`) is not modelled.
 */
const REQUIRED_OVERLAYS = {
  'POST /v1/invoiceitems': ['customer'],
  'GET /v1/credit_notes/preview': ['invoice'],
  'GET /v1/credit_notes/preview/lines': ['invoice'],
  'POST /v1/checkout/sessions': ['mode'],
  'POST /v1/subscriptions': ['items', 'customer'],
  'POST /v1/billing_portal/sessions': ['customer'],
  'POST /v1/payment_methods/{payment_method}/attach': ['customer'],
};

// ---------------------------------------------------------------------------------------------
// Extraction from a spec, mirroring the node format of the params file.

function isEmptyAlternative(schema) {
  return (
    schema &&
    schema.type === 'string' &&
    Array.isArray(schema.enum) &&
    schema.enum.length === 1 &&
    schema.enum[0] === '' &&
    Object.keys(schema).length === 2
  );
}

function resolveRef(spec, schema) {
  let s = schema;
  while (s && s.$ref) {
    const path = s.$ref.replace(/^#\//, '').split('/');
    s = path.reduce((acc, key) => acc[key], spec);
  }
  return s;
}

function extractNode(spec, rawSchema, required = false) {
  const schema = resolveRef(spec, rawSchema) || {};
  const n = {};
  if (required) n.required = true;
  if (schema.anyOf) {
    const alternatives = schema.anyOf.map((v) => resolveRef(spec, v));
    const nonEmpty = alternatives.filter((v) => !isEmptyAlternative(v));
    if (nonEmpty.length < alternatives.length) n.accepts_empty_string = true;
    if (nonEmpty.length === 1) {
      const sub = extractNode(spec, nonEmpty[0]);
      delete sub.required;
      const acceptsEmpty = sub.accepts_empty_string;
      delete sub.accepts_empty_string;
      Object.assign(n, sub);
      if (acceptsEmpty) n.accepts_empty_string = true;
    } else {
      n.type = 'anyOf';
      n.variants = nonEmpty.map((v) => extractNode(spec, v));
    }
  } else {
    const t = schema.type;
    if (t === 'object' && schema.properties) {
      n.type = 'object';
      const req = new Set(schema.required || []);
      n.children = {};
      for (const key of Object.keys(schema.properties).sort()) {
        n.children[key] = extractNode(spec, schema.properties[key], req.has(key));
      }
    } else if (t === 'object') {
      const ap = schema.additionalProperties;
      n.type = ap ? 'map' : 'object';
      if (ap && typeof ap === 'object') n.values = extractNode(spec, ap);
    } else if (t === 'array') {
      n.type = 'array';
      n.items = extractNode(spec, schema.items || {});
    } else {
      if (t) n.type = t;
      if (Array.isArray(schema.enum)) {
        if (schema.enum.includes('')) n.accepts_empty_string = true;
        const values = schema.enum.filter((e) => e !== '');
        if (values.length) n.enum = values;
        else if (schema.enum.length === 1) n.enum = [''];
      }
      for (const k of ['format', 'maxLength']) if (k in schema) n[k] = schema[k];
    }
  }
  if (schema['x-stripeBypassValidation']) n.stripeBypassValidation = true;
  return n;
}

/** Returns {path, params} for "METHOD /path" in a spec, or null when the spec lacks it. */
function extractOperation(spec, opKey) {
  const [method, path] = opKey.split(' ');
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  if (!op) return null;
  const pathParams = {};
  const params = {};
  for (const prm of op.parameters || []) {
    const node = extractNode(spec, prm.schema || {}, prm.required || false);
    if (prm.in === 'path') pathParams[prm.name] = node;
    else if (prm.in === 'query') params[prm.name] = node;
  }
  const body = op.requestBody?.content?.['application/x-www-form-urlencoded']?.schema;
  if (body) {
    const resolved = resolveRef(spec, body);
    const req = new Set(resolved.required || []);
    for (const key of Object.keys(resolved.properties || {}).sort()) {
      params[key] = extractNode(spec, resolved.properties[key], req.has(key));
    }
  }
  return { path: pathParams, params };
}

/** Converts one params-file operation into the same {path, params} shape. */
function fromParamsFile(entry) {
  const strip = (node) => {
    const n = {};
    for (const k of ['required', 'accepts_empty_string', 'type', 'enum', 'format', 'maxLength', 'stripeBypassValidation']) {
      if (k in node) n[k] = node[k];
    }
    if (node.children) n.children = Object.fromEntries(Object.entries(node.children).map(([k, v]) => [k, strip(v)]));
    if (node.items) n.items = strip(node.items);
    if (node.values) n.values = strip(node.values);
    if (node.variants) n.variants = node.variants.map(strip);
    return n;
  };
  const params = {};
  for (const section of ['query_params', 'body_params']) {
    for (const [k, v] of Object.entries(entry[section] || {})) params[k] = strip(v);
  }
  const path = Object.fromEntries(Object.entries(entry.path_params || {}).map(([k, v]) => [k, strip(v)]));
  return { path, params };
}

// ---------------------------------------------------------------------------------------------
// Tree helpers.

const COMPARED = ['type', 'enum', 'required', 'accepts_empty_string', 'format', 'maxLength', 'stripeBypassValidation'];

/** Flattens a params tree to {"a.b[].c": signature}. */
function flatten(params, prefix = '', out = {}) {
  for (const [key, node] of Object.entries(params)) flattenNode(node, prefix + key, out);
  return out;
}
function flattenNode(node, path, out) {
  const sig = {};
  for (const k of COMPARED) if (k in node) sig[k] = k === 'enum' ? [...node[k]].sort() : node[k];
  out[path] = sig;
  if (node.children) flatten(node.children, path + '.', out);
  if (node.items) flattenNode(node.items, path + '[]', out);
  if (node.values) flattenNode(node.values, path + '{}', out);
  (node.variants || []).forEach((v, i) => flattenNode(v, `${path}<v${i}>`, out));
  return out;
}

function diffTrees(a, b) {
  const fa = flatten(a);
  const fb = flatten(b);
  const problems = [];
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (!(k in fa)) problems.push(`only in second: ${k}`);
    else if (!(k in fb)) problems.push(`only in first: ${k}`);
    else if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) {
      problems.push(`differs: ${k} ${JSON.stringify(fa[k])} vs ${JSON.stringify(fb[k])}`);
    }
  }
  return problems;
}

/** Finds the node at a dotted path ("a.b[].c") inside a params tree. */
function nodeAt(params, dotted) {
  const tokens = dotted.split('.');
  let node = null;
  let children = params;
  for (const token of tokens) {
    const arrayDepth = (token.match(/\[\]/g) || []).length;
    const key = token.replace(/\[\]/g, '');
    node = children?.[key];
    if (!node) return null;
    for (let i = 0; i < arrayDepth; i++) node = node.items;
    if (!node) return null;
    children = node.children;
  }
  return node;
}

/** Removes the node at a dotted path. */
function removeAt(params, dotted) {
  const tokens = dotted.split('.');
  const last = tokens.pop();
  const parent = tokens.length ? nodeAt(params, tokens.join('.')) : null;
  const container = parent ? parent.children : params;
  if (container) delete container[last.replace(/\[\]/g, '')];
}

/** Sets the node at a dotted path (the parent must exist). */
function setAt(params, dotted, node) {
  if (dotted.endsWith('[]')) {
    const arrayNode = nodeAt(params, dotted.slice(0, -2));
    if (!arrayNode) throw new Error(`no array node for ${dotted}`);
    arrayNode.items = node;
    return;
  }
  const tokens = dotted.split('.');
  const last = tokens.pop().replace(/\[\]/g, '');
  const parent = tokens.length ? nodeAt(params, tokens.join('.')) : null;
  if (tokens.length && !parent) throw new Error(`no parent for ${dotted}`);
  if (parent) {
    parent.children ||= {};
    parent.children[last] = node;
  } else {
    params[last] = node;
  }
}

/** Adds to `into` every node of `older` it lacks, gated with until=untilVersion; merges enums. */
function mergeOlder(into, older, untilVersion) {
  for (const [key, oldNode] of Object.entries(older)) {
    const cur = into[key];
    if (!cur) {
      into[key] = { ...structuredClone(oldNode), until: untilVersion };
      continue;
    }
    mergeOlderNode(cur, oldNode, untilVersion);
  }
}
function mergeOlderNode(cur, oldNode, untilVersion) {
  if (oldNode.required && !cur.required && !cur.requiredUntil) cur.requiredUntil = untilVersion;
  if (cur.type !== oldNode.type) return;
  if (cur.enum && oldNode.enum) {
    for (const v of oldNode.enum) if (!cur.enum.includes(v)) cur.enum.push(v);
  }
  if (cur.children && oldNode.children) mergeOlder(cur.children, oldNode.children, untilVersion);
  if (cur.items && oldNode.items) mergeOlderNode(cur.items, oldNode.items, untilVersion);
  if (cur.values && oldNode.values) mergeOlderNode(cur.values, oldNode.values, untilVersion);
  if (cur.variants && oldNode.variants && cur.variants.length === oldNode.variants.length) {
    cur.variants.forEach((v, i) => mergeOlderNode(v, oldNode.variants[i], untilVersion));
  }
}

/** Adds nodes and enum values that only the SDK's spec (spec3.sdk.json) has; never removes anything. */
function mergeSdkOnly(into, sdk) {
  for (const [key, sdkNode] of Object.entries(sdk)) {
    const cur = into[key];
    if (!cur) {
      into[key] = structuredClone(sdkNode);
      continue;
    }
    mergeSdkNode(cur, sdkNode);
  }
}
function mergeSdkNode(cur, sdkNode) {
  if (cur.type !== sdkNode.type) return;
  if (cur.enum && sdkNode.enum) {
    for (const v of sdkNode.enum) if (!cur.enum.includes(v)) cur.enum.push(v);
  }
  if (cur.children && sdkNode.children) mergeSdkOnly(cur.children, sdkNode.children);
  if (cur.items && sdkNode.items) mergeSdkNode(cur.items, sdkNode.items);
  if (cur.values && sdkNode.values) mergeSdkNode(cur.values, sdkNode.values);
  if (cur.variants && sdkNode.variants && cur.variants.length === sdkNode.variants.length) {
    cur.variants.forEach((v, i) => mergeSdkNode(v, sdkNode.variants[i]));
  }
}

/** Converts an extracted node to the compact output format. */
function compact(node) {
  const out = {};
  if (node.type) out.type = node.type;
  if (node.required) out.required = true;
  if (node.accepts_empty_string) out.empty = true;
  if (node.enum) out.enum = node.enum;
  if (node.serverOpen) out.open = true;
  if (node.maxLength) out.maxLength = node.maxLength;
  if (node.format) out.format = node.format;
  if (node.since) out.since = node.since;
  if (node.until) out.until = node.until;
  if (node.requiredUntil) out.requiredUntil = node.requiredUntil;
  if (node.enumGates) out.enumGates = node.enumGates;
  if (node.children) out.props = Object.fromEntries(Object.entries(node.children).map(([k, v]) => [k, compact(v)]));
  if (node.items) out.items = compact(node.items);
  if (node.values) out.values = compact(node.values);
  if (node.variants) out.variants = node.variants.map(compact);
  return out;
}

// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!args.params || !args.specs) {
    console.error('usage: node scripts/build-param-schemas.mjs --params <trees.json> --specs <dir> [--latest <spec3.json>]');
    process.exit(2);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const paramsFile = JSON.parse(readFileSync(args.params, 'utf8'));
  const specCache = new Map();
  const spec = (name) => {
    if (!specCache.has(name)) specCache.set(name, JSON.parse(readFileSync(join(args.specs, `${name}.json`), 'utf8')));
    return specCache.get(name);
  };
  const failures = [];

  const fileOps = Object.keys(paramsFile).filter((k) => k !== '_meta');

  // 1. The extractor must reproduce the params file exactly (same spec, same rules).
  if (args.latest) {
    const latest = JSON.parse(readFileSync(args.latest, 'utf8'));
    for (const opKey of fileOps) {
      const mine = extractOperation(latest, opKey);
      const theirs = fromParamsFile(paramsFile[opKey]);
      const problems = diffTrees(mine.params, theirs.params);
      if (problems.length) failures.push(`${opKey} (extractor vs params file): ${problems.slice(0, 5).join('; ')}`);
    }
  }

  const operations = {};
  const baseSpec = spec(`${BASE_TAG}-spec3`);
  const sdkSpec = spec(`${BASE_TAG}-spec3.sdk`);

  for (const opKey of [...fileOps, ...EXTRA_OPERATIONS]) {
    let tree;
    if (paramsFile[opKey]) {
      // 2. Start from the params file (latest spec) and move it back to the SDK's version,
      //    using the file's own comparison against 2026-08-26.dahlia.
      tree = fromParamsFile(paramsFile[opKey]);
      const cmp = paramsFile[opKey]['compare_2026-08-26.dahlia'];
      const dahlia = extractOperation(baseSpec, opKey);
      if (cmp && typeof cmp === 'object') {
        for (const p of cmp.params_not_in_this_version_spec || []) removeAt(tree.params, p.replace(/^(body|query):/, ''));
        for (const p of [...(cmp.params_only_in_this_version_spec || []), ...Object.keys(cmp.changed || {})]) {
          const dotted = p.replace(/^(body|query):/, '');
          const node = nodeAt(dahlia.params, dotted);
          if (!node) throw new Error(`${opKey}: ${dotted} missing from ${BASE_TAG}`);
          setAt(tree.params, dotted, structuredClone(node));
        }
      }
      const problems = diffTrees(tree.params, dahlia.params);
      if (problems.length) failures.push(`${opKey} (patched params file vs ${BASE_TAG}): ${problems.slice(0, 5).join('; ')}`);
    } else {
      tree = extractOperation(baseSpec, opKey);
      if (!tree) throw new Error(`${opKey} is not in ${BASE_TAG}`);
    }

    // 3. Parameters and enum values that only the SDK's spec has.
    const sdkTree = extractOperation(sdkSpec, opKey);
    if (sdkTree) mergeSdkOnly(tree.params, sdkTree.params);

    // 4. Parameters that older versions had and later removed, and relaxed requirements.
    const baseIndex = SNAPSHOTS.findIndex(([tag]) => tag === BASE_TAG);
    for (let i = baseIndex - 1; i >= 0; i--) {
      const older = extractOperation(spec(`${SNAPSHOTS[i][0]}-spec3`), opKey);
      if (older) mergeOlder(tree.params, older.params, SNAPSHOTS[i + 1][1]);
    }

    // 5. Documented gates and overlays.
    for (const [p, version] of Object.entries(REMOVED_AT[opKey] || {})) {
      const node = nodeAt(tree.params, p);
      if (!node) throw new Error(`${opKey}: removed param ${p} not found`);
      node.until = version;
    }
    for (const [p, version] of Object.entries(REQUIRED_UNTIL[opKey] || {})) {
      const node = nodeAt(tree.params, p);
      if (!node) throw new Error(`${opKey}: ${p} not found`);
      node.requiredUntil = version;
    }
    for (const [p, version] of Object.entries(ADDED_SINCE[opKey] || {})) {
      const node = nodeAt(tree.params, p);
      if (!node) throw new Error(`${opKey}: gated param ${p} not found`);
      node.since = version;
    }
    for (const [p, gates] of Object.entries(ENUM_GATES[opKey] || {})) {
      const node = nodeAt(tree.params, p);
      if (!node?.enum) throw new Error(`${opKey}: enum ${p} not found`);
      for (const value of Object.keys(gates)) if (!node.enum.includes(value)) node.enum.push(value);
      node.enumGates = gates;
    }
    for (const p of SERVER_OPEN_ENUMS[opKey] || []) {
      const node = nodeAt(tree.params, p);
      if (!node?.enum) throw new Error(`${opKey}: open enum ${p} not found`);
      node.serverOpen = true;
    }
    for (const p of REQUIRED_OVERLAYS[opKey] || []) {
      const node = nodeAt(tree.params, p);
      if (!node) throw new Error(`${opKey}: required overlay ${p} not found`);
      node.required = true;
      delete node.requiredUntil;
    }

    operations[opKey] = compact({ type: 'object', children: tree.params }).props;
  }

  if (failures.length) {
    console.error(`Verification failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  const lines = [
    '// Generated by scripts/build-param-schemas.mjs from Stripe\'s public OpenAPI spec. Do not edit.',
    `// Base: openapi/spec3.json at tag ${BASE_TAG} (2026-08-26.dahlia) plus spec3.sdk.json-only parameters;`,
    `// older parameters from tags ${SNAPSHOTS.slice(0, -1).map(([t]) => t).join(', ')}. Node format: see the script header.`,
    '',
    '/** Request parameters per operation ("METHOD /v1/path/{param}"), body and query merged. */',
    'export const OPERATIONS = {',
  ];
  for (const opKey of Object.keys(operations).sort()) {
    lines.push(`  ${JSON.stringify(opKey)}: {`);
    for (const [name, node] of Object.entries(operations[opKey])) {
      lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(node)},`);
    }
    lines.push('  },');
  }
  lines.push('};', '');
  writeFileSync(OUT, lines.join('\n'));
  const size = lines.join('\n').length;
  console.log(`wrote ${OUT}: ${Object.keys(operations).length} operations, ${(size / 1024).toFixed(0)} KiB`);
}

main();
