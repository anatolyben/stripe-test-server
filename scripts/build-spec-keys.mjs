#!/usr/bin/env node
/**
 * Builds test/fixtures/spec-keys.json: the top-level key sets of the objects the server renders,
 * at API version 2024-06-20 and at 2026-08-26.dahlia, taken from Stripe's public OpenAPI specs
 * (github.com/stripe/openapi: openapi/spec3.json and openapi/spec3.sdk.json at tag v1267, the last
 * 2024-06-20 tag, and at tag v2442, the 2026-08-26.dahlia tag stripe-node 22.6.2 is built from).
 * test/shapes.test.js checks every rendered object against it.
 *
 * test/fixtures/spec-keys.json is committed, so this script only needs to run when the server
 * moves to a newer Stripe API version. Its input is not in this repository: a JSON summary of the
 * object schemas of those specs, with one entry per `<object>@2024-06-20` and `<object>@latest`
 * (latest = 2026-08-26.dahlia) for every type in TYPES below, shaped
 * { properties: { <name>: { required, nullable, docs: { includable } } } }:
 *   required          the key is in the `required` array of the object schema in spec3.json or
 *                     spec3.sdk.json at that tag (spec3.sdk.json also lists nullable keys that are
 *                     always present), so every response carries it
 *   nullable          the schema allows null
 *   docs.includable   the API reference (docs.stripe.com/api/<object>/object) marks the key as
 *                     includable: returned only when requested with `expand[]`. The specs have no
 *                     such flag.
 *
 * Usage:
 *   node scripts/build-spec-keys.mjs --objects <summary.json>
 *
 * Output, per version and object type (all lists sorted):
 *   required    keys every response carries (includable keys excluded, even when a spec lists them)
 *   optional    other keys the spec defines, which may be absent
 *   includable  keys that appear only when expanded (absent from a default response)
 *   nullable    keys (of any of the three lists) whose value may be null
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'test', 'fixtures', 'spec-keys.json');

const TYPES = [
  'customer',
  'product',
  'price',
  'payment_method',
  'checkout.session',
  'subscription',
  'subscription_item',
  'subscription_schedule',
  'invoice',
  'line_item',
  'billing_portal.configuration',
  'billing_portal.session',
  'test_helpers.test_clock',
  'event',
];

/** Output version label → the input's entry suffix. */
const VERSIONS = { '2024-06-20': '2024-06-20', '2026-08-26.dahlia': 'latest' };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name} <file>`);
  return process.argv[i + 1];
}

const source = JSON.parse(readFileSync(arg('objects'), 'utf8'));
const out = {
  source: 'github.com/stripe/openapi spec3.json + spec3.sdk.json: 2024-06-20 = tag v1267, 2026-08-26.dahlia = tag v2442',
  versions: {},
};

for (const [label, suffix] of Object.entries(VERSIONS)) {
  const types = {};
  for (const type of TYPES) {
    const entry = source[`${type}@${suffix}`];
    if (!entry) throw new Error(`no entry for ${type}@${suffix}`);
    const required = [];
    const optional = [];
    const includable = [];
    const nullable = [];
    for (const [key, prop] of Object.entries(entry.properties)) {
      if (prop.docs?.includable) includable.push(key);
      else if (prop.required) required.push(key);
      else optional.push(key);
      if (prop.nullable) nullable.push(key);
    }
    types[type] = { required: required.sort(), optional: optional.sort(), includable: includable.sort(), nullable: nullable.sort() };
  }
  out.versions[label] = types;
}

mkdirSync(dirname(OUT), { recursive: true });
// One line per key list keeps the fixture short and its diffs readable.
const json = JSON.stringify(out, null, 2).replace(/\[\n\s*([^\]]*?)\n\s*\]/g, (_, body) => `[${body.replace(/,\n\s*/g, ', ')}]`);
writeFileSync(OUT, `${json}\n`);
console.log(`wrote ${OUT}`);
