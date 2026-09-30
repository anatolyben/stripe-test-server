/**
 * Core behaviour through the real stripe SDK: auth, wire format, validation, customers,
 * idempotency, lists, expand, versions, isolation, faults, time and the control API.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { rejection, startServer, testKey, webhookReceiver } from './helpers.js';
import { normalizeOptions } from '../src/core/options.js';
import { ServerContext } from '../src/core/server.js';
import { h, html, redirect } from '../src/core/html.js';
import * as eventsModule from '../src/core/events.js';
import * as customersModule from '../src/customers/customers.js';
import { createCustomer, updateCustomer } from '../src/customers/customers.js';
import { parseForm } from '../src/core/form.js';
import { validateParams } from '../src/core/validate.js';
import { addIntervals, nextBoundaryAfter, periodContaining } from '../src/core/periods.js';
import { TimeEngine, JOB_PRIORITY } from '../src/core/time.js';
import { Registry } from '../src/core/registry.js';
import { checkExpand, render } from '../src/core/render.js';

const iso = (t) => new Date(t * 1000).toISOString();

describe('authentication', () => {
  it('rejects a request without a key with 401 invalid_request_error and a Request-Id', async () => {
    const t = await startServer();
    const res = await t.request('GET', '/v1/customers', { key: null });
    expect(res.status).toBe(401);
    expect(res.json.error.type).toBe('invalid_request_error');
    expect(res.json.error.message).toMatch(/did not provide an API key/);
    expect(res.headers.get('request-id')).toMatch(/^req_[A-Za-z0-9]{14}$/);
  });

  it('maps an invalid key to StripeAuthenticationError and a publishable key to secret_key_required', async () => {
    const t = await startServer();
    const bad = await rejection(t.stripe('sk_live_abcdef1234').customers.list());
    expect(bad.type).toBe('StripeAuthenticationError');
    expect(bad.statusCode).toBe(401);
    expect(bad.message).toContain('sk_live_****1234');
    const pk = await rejection(t.stripe('pk_test_abcdef').customers.list());
    expect(pk.statusCode).toBe(401);
    expect(pk.code).toBe('secret_key_required');
  });

  it('accepts HTTP Basic auth with the key as the username', async () => {
    const t = await startServer();
    const res = await t.request('GET', '/v1/customers', {
      key: null,
      headers: { Authorization: `Basic ${Buffer.from(`${t.key}:`).toString('base64')}` },
    });
    expect(res.status).toBe(200);
    expect(res.json.object).toBe('list');
  });
});

describe('wire format and validation', () => {
  it('rejects unknown parameters with parameter_unknown and the bracketed name', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const top = await rejection(stripe.customers.create({ foo: 'bar' }));
    expect([top.type, top.statusCode, top.code, top.param]).toEqual(['StripeInvalidRequestError', 400, 'parameter_unknown', 'foo']);
    expect(top.message).toBe('Received unknown parameter: foo');
    const nested = await rejection(stripe.customers.create({ invoice_settings: { custom_fields: [{ name: 'a', value: 'b', extra: 1 }] } }));
    expect(nested.param).toBe('invoice_settings[custom_fields][0][extra]');
  });

  it('rejects parameters named after Object.prototype members without touching the prototype', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    for (const [params, param] of [
      [{ valueOf: 'x' }, 'valueOf'],
      [{ hasOwnProperty: 'x' }, 'hasOwnProperty'],
      [JSON.parse('{"__proto__": {"polluted": "yes"}}'), '__proto__'],
    ]) {
      const err = await rejection(stripe.customers.create(params));
      expect([err.statusCode, err.code, err.param]).toEqual([400, 'parameter_unknown', param]);
    }
    expect({}.polluted).toBeUndefined();
    const c = await stripe.customers.create({ metadata: { valueOf: '1', constructor: '2' } });
    expect(c.metadata).toEqual({ valueOf: '1', constructor: '2' });
  });

  it('parses nested objects, indexed arrays and metadata exactly as the SDK encodes them', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const params = {
      email: 'jenny@example.com',
      metadata: { plan: 'pro', 'with space': 'a&b=c!*()\'~ é' },
      address: { line1: '1 Main St', city: 'Springfield', country: 'US' },
      invoice_settings: { custom_fields: [{ name: 'PO', value: '12 34' }, { name: 'Ref', value: 'x+y' }], footer: 'Thanks' },
      preferred_locales: ['en', 'fr'],
      balance: -500,
    };
    const c = await stripe.customers.create(params);
    const [entry] = await t.account().requests({ path: '/v1/customers', method: 'POST', limit: 1 });
    expect(entry.body).toEqual({
      ...params,
      balance: '-500',
      invoice_settings: { custom_fields: { 0: { name: 'PO', value: '12 34' }, 1: { name: 'Ref', value: 'x+y' } }, footer: 'Thanks' },
      preferred_locales: { 0: 'en', 1: 'fr' },
    });
    const again = await stripe.customers.retrieve(c.id);
    expect(again.metadata).toEqual(params.metadata);
    expect(again.address).toEqual({ city: 'Springfield', country: 'US', line1: '1 Main St', line2: null, postal_code: null, state: null });
    expect(again.invoice_settings.custom_fields).toEqual(params.invoice_settings.custom_fields);
    expect(again.preferred_locales).toEqual(['en', 'fr']);
    expect(again.balance).toBe(-500);
  });

  it('accepts expand[] (curl style), expand[0] (SDK style) and percent-encoded brackets', async () => {
    const t = await startServer();
    const created = await t.request('POST', '/v1/customers', { form: 'email=a%40b.c&metadata%5Bk%5D=v&expand[]=tax&expand[]=sources' });
    expect(created.status).toBe(200);
    expect(created.json.metadata).toEqual({ k: 'v' });
    expect(created.json.tax).toBeDefined();
    expect(created.json.sources.object).toBe('list');
    const fetched = await t.request('GET', `/v1/customers/${created.json.id}?expand[0]=tax_ids`);
    expect(fetched.json.tax_ids).toEqual({ object: 'list', data: [], has_more: false, url: `/v1/customers/${created.json.id}/tax_ids` });
  });

  it('enforces types, lengths and the "" (unset) rules of the OpenAPI schema', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const int = await rejection(stripe.customers.create({ balance: 'lots' }));
    expect([int.code, int.param]).toEqual(['parameter_invalid_integer', 'balance']);
    const long = await rejection(stripe.customers.create({ phone: 'x'.repeat(21) }));
    expect(long.param).toBe('phone');
    const c = await stripe.customers.create({ email: 'a@b.c', tax_exempt: 'exempt', metadata: { a: '1', b: '2' } });
    const cleared = await stripe.customers.update(c.id, { tax_exempt: '', metadata: { a: '' } });
    expect(cleared.tax_exempt).toBe('none');
    expect(cleared.metadata).toEqual({ b: '2' });
    expect((await stripe.customers.update(c.id, { metadata: '' })).metadata).toEqual({});
    const notUnsettable = await rejection(stripe.customers.update(c.id, { email: '' }));
    expect([notUnsettable.code, notUnsettable.param]).toEqual(['parameter_invalid_empty', 'email']);
    const enumErr = await rejection(stripe.customers.create({ tax_exempt: 'sometimes' }));
    expect([enumErr.type, enumErr.param, enumErr.code]).toEqual(['StripeInvalidRequestError', 'tax_exempt', undefined]);
    const tooMany = await rejection(stripe.customers.create({ metadata: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v'])) }));
    expect(tooMany.param).toBe('metadata');
  });

  it('answers an unknown route with 404 Unrecognized request URL', async () => {
    const t = await startServer();
    const err = await rejection(t.stripe().rawRequest('GET', '/v1/foo'));
    expect(err.statusCode).toBe(404);
    expect(err.message).toMatch(/^Unrecognized request URL \(GET: \/v1\/foo\)/);
    expect(err.requestId).toMatch(/^req_/);
  });

  it('echoes Stripe-Version and rejects versions the SDK does not know', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c' });
    expect(c.lastResponse.apiVersion).toBe('2026-08-26.dahlia');
    expect(c.lastResponse.requestId).toMatch(/^req_/);
    expect(c.lastResponse.idempotencyKey).toMatch(/^stripe-node-retry-/);
    const old = await stripe.customers.retrieve(c.id, {}, { apiVersion: '2025-01-27.acacia' });
    expect(old.lastResponse.apiVersion).toBe('2025-01-27.acacia');
    const preview = await stripe.customers.retrieve(c.id, {}, { apiVersion: '2026-08-26.preview' });
    expect(preview.lastResponse.apiVersion).toBe('2026-08-26.preview');
    const bad = await rejection(stripe.customers.retrieve(c.id, {}, { apiVersion: '2026-99-99.zinnia' }));
    expect([bad.statusCode, bad.rawType, bad.code, bad.param]).toEqual([400, 'invalid_request_error', undefined, undefined]);
  });
});

describe('customers', () => {
  it('creates, retrieves, updates, lists and deletes', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'jenny@example.com', name: 'Jenny', description: 'first' });
    expect(c).toMatchObject({ object: 'customer', email: 'jenny@example.com', name: 'Jenny', livemode: false, delinquent: false });
    expect(c.id).toMatch(/^cus_[A-Za-z0-9]{24}$/);
    expect(c.invoice_prefix).toMatch(/^[0-9A-F]{8}$/);
    expect('deleted' in c).toBe(false);
    expect('discount' in c).toBe(false);
    const updated = await stripe.customers.update(c.id, { name: 'Jenny Rosen', address: { city: 'Paris' }, shipping: { name: 'J', address: { line1: 'x' } } });
    expect(updated.name).toBe('Jenny Rosen');
    expect(updated.address.city).toBe('Paris');
    expect(updated.shipping).toEqual({ address: { city: null, country: null, line1: 'x', line2: null, postal_code: null, state: null }, name: 'J', phone: null });
    const byEmail = await stripe.customers.list({ email: 'jenny@example.com' });
    expect(byEmail.data.map((x) => x.id)).toEqual([c.id]);
    const deleted = await stripe.customers.del(c.id);
    expect(deleted).toEqual({ id: c.id, object: 'customer', deleted: true });
    expect(await stripe.customers.retrieve(c.id)).toEqual({ id: c.id, object: 'customer', deleted: true });
    expect((await stripe.customers.list()).data).toEqual([]);
  });

  it('leaves the customer untouched when an update is rejected, and enforces unique invoice prefixes', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const a = await stripe.customers.create({ invoice_prefix: 'ACME01' });
    const b = await stripe.customers.create({ name: 'before' });
    const err = await rejection(stripe.customers.update(b.id, { name: 'after', invoice_prefix: 'ACME01' }));
    expect(err.param).toBe('invoice_prefix');
    expect((await stripe.customers.retrieve(b.id)).name).toBe('before');
    expect((await rejection(stripe.customers.create({ invoice_prefix: 'ab' }))).param).toBe('invoice_prefix');
    expect((await stripe.customers.update(a.id, { invoice_prefix: 'ACME01', name: 'same prefix' })).invoice_prefix).toBe('ACME01');
    expect((await stripe.events.list({ type: 'customer.updated' })).data).toHaveLength(1);
  });

  it('answers resource_missing for unknown and deleted customers', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const missing = await rejection(stripe.customers.retrieve('cus_doesnotexist'));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([404, 'resource_missing', 'id']);
    expect(missing.message).toBe("No such customer: 'cus_doesnotexist'");
    const c = await stripe.customers.create();
    await stripe.customers.del(c.id);
    const update = await rejection(stripe.customers.update(c.id, { name: 'x' }));
    expect([update.statusCode, update.code]).toEqual([404, 'resource_missing']);
    const again = await rejection(stripe.customers.del(c.id));
    expect([again.statusCode, again.code]).toEqual([404, 'resource_missing']);
  });

  it('emits customer.created, customer.updated with previous_attributes and customer.deleted', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c', metadata: { x: '1' } }, { idempotencyKey: 'create-1' });
    await stripe.customers.update(c.id, { email: 'new@b.c', invoice_settings: { footer: 'hi' }, metadata: { x: '2' } });
    await stripe.customers.update(c.id, { email: 'new@b.c' }); // no change → no event
    await stripe.customers.del(c.id);
    const events = await stripe.events.list();
    expect(events.data.map((e) => e.type)).toEqual(['customer.deleted', 'customer.updated', 'customer.created']);
    const [del, upd, cre] = events.data;
    expect(cre.request).toEqual({ id: c.lastResponse.requestId, idempotency_key: 'create-1' });
    expect(cre.data.previous_attributes).toBeUndefined();
    expect(upd.data.previous_attributes).toEqual({ email: 'a@b.c', invoice_settings: { footer: null }, metadata: { x: '1' } });
    expect(upd.api_version).toBe('2026-08-26.dahlia');
    expect(del.data.object.id).toBe(c.id);
    expect(del.data.object.email).toBe('new@b.c');
    expect('deleted' in del.data.object).toBe(false);
    expect(del.request.idempotency_key).toBeNull();
    const one = await stripe.events.retrieve(upd.id);
    expect(one).toEqual(JSON.parse(JSON.stringify({ ...upd, lastResponse: undefined })));
  });

  it('renders the 2024-06-20 shape (discount) and keeps the dahlia shape by default', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c' });
    const legacy = await stripe.customers.retrieve(c.id, {}, { apiVersion: '2024-06-20' });
    expect(legacy.discount).toBeNull();
    const legacyServer = await startServer({ apiVersion: '2024-06-20' });
    const s2 = legacyServer.stripe();
    await legacyServer.request('POST', '/v1/customers', { form: 'email=x%40y.z', headers: {} });
    const [event] = (await s2.events.list({}, { apiVersion: '2024-06-20' })).data;
    expect(event.api_version).toBe('2024-06-20');
    expect(event.data.object.discount).toBeNull();
  });

  it('attaches customers to an existing test clock (at most three) and expands test_clock', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const account = t.server.context.account(t.key);
    account.store.insert({ id: 'clock_fixture', object: 'test_helpers.test_clock', created: 1, deletes_after: 2, frozen_time: 1700000000, livemode: false, name: null, status: 'ready', status_details: {} });
    account.time.registerClock('clock_fixture', 1700000000);
    const missing = await rejection(stripe.customers.create({ test_clock: 'clock_nope' }));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([400, 'resource_missing', 'test_clock']);
    const first = await stripe.customers.create({ test_clock: 'clock_fixture' });
    expect(first.created).toBe(1700000000);
    expect(first.test_clock).toBe('clock_fixture');
    await stripe.customers.create({ test_clock: 'clock_fixture' });
    await stripe.customers.create({ test_clock: 'clock_fixture' });
    const fourth = await rejection(stripe.customers.create({ test_clock: 'clock_fixture' }));
    expect(fourth.param).toBe('test_clock');
    expect((await stripe.customers.list()).data).toEqual([]);
    expect((await stripe.customers.list({ test_clock: 'clock_fixture' })).data).toHaveLength(3);
    const expanded = await stripe.customers.retrieve(first.id, { expand: ['test_clock'] });
    expect(expanded.test_clock).toMatchObject({ id: 'clock_fixture', object: 'test_helpers.test_clock', frozen_time: 1700000000 });
    const [event] = (await stripe.events.list({ limit: 1 })).data;
    expect(event.created).toBe(1700000000);
  });
});

describe('idempotency', () => {
  it('replays the saved response for the same key and parameters', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const a = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'same' });
    const b = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'same' });
    expect(b.id).toBe(a.id);
    expect(b.lastResponse.headers['idempotent-replayed']).toBe('true');
    expect(a.lastResponse.headers['idempotent-replayed']).toBeUndefined();
    expect(b.lastResponse.requestId).not.toBe(a.lastResponse.requestId);
    expect((await stripe.customers.list()).data).toHaveLength(1);
  });

  it('rejects the same key with other parameters or another endpoint as idempotency_error', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'k1' });
    const params = await rejection(stripe.customers.create({ email: 'z@b.c' }, { idempotencyKey: 'k1' }));
    expect([params.type, params.statusCode, params.rawType]).toEqual(['StripeIdempotencyError', 400, 'idempotency_error']);
    const endpoint = await rejection(stripe.customers.update(c.id, { email: 'a@b.c' }, { idempotencyKey: 'k1' }));
    expect(endpoint.type).toBe('StripeIdempotencyError');
    const tooLong = await rejection(stripe.customers.create({}, { idempotencyKey: 'x'.repeat(256) }));
    expect(tooLong.type).toBe('StripeIdempotencyError');
  });

  it('does not save validation failures but saves errors raised during execution', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    await rejection(stripe.customers.create({ bogus: 1 }, { idempotencyKey: 'v1' }));
    const ok = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'v1' });
    expect(ok.lastResponse.headers['idempotent-replayed']).toBeUndefined();
    const first = await rejection(stripe.customers.update('cus_missing', { name: 'x' }, { idempotencyKey: 'e1' }));
    const second = await rejection(stripe.customers.update('cus_missing', { name: 'x' }, { idempotencyKey: 'e1' }));
    expect(first.statusCode).toBe(404);
    expect(second.statusCode).toBe(404);
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('forgets keys after 24 hours of account time', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const a = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'day' });
    await t.account().advanceTime({ seconds: 24 * 3600 });
    const b = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'day' });
    expect(b.id).not.toBe(a.id);
    expect(b.lastResponse.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('lists and pagination', () => {
  it('pages newest first with limit, starting_after, ending_before and auto-pagination', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await stripe.customers.create({ name: `c${i}` })).id);
    const newest = [...ids].reverse();
    const page1 = await stripe.customers.list({ limit: 2 });
    expect(page1).toMatchObject({ object: 'list', url: '/v1/customers', has_more: true });
    expect(page1.data.map((c) => c.id)).toEqual(newest.slice(0, 2));
    const page2 = await stripe.customers.list({ limit: 2, starting_after: page1.data[1].id });
    expect(page2.data.map((c) => c.id)).toEqual(newest.slice(2, 4));
    const last = await stripe.customers.list({ limit: 2, starting_after: page2.data[1].id });
    expect([last.data.map((c) => c.id), last.has_more]).toEqual([newest.slice(4), false]);
    const before = await stripe.customers.list({ limit: 2, ending_before: newest[4] });
    expect([before.data.map((c) => c.id), before.has_more]).toEqual([newest.slice(2, 4), true]);
    expect((await stripe.customers.list({ limit: 2 }).autoPagingToArray({ limit: 100 })).map((c) => c.id)).toEqual(newest);
    expect((await stripe.customers.list({ ending_before: newest[4], limit: 2 }).autoPagingToArray({ limit: 100 })).map((c) => c.id)).toEqual(
      newest.slice(0, 4).reverse(),
    );
  });

  it('validates limit and cursors', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    expect((await rejection(stripe.customers.list({ limit: 0 }))).param).toBe('limit');
    expect((await rejection(stripe.customers.list({ limit: 101 }))).param).toBe('limit');
    const both = await rejection(stripe.customers.list({ starting_after: 'cus_a', ending_before: 'cus_b' }));
    expect(both.code).toBe('parameters_exclusive');
    const unknown = await rejection(stripe.customers.list({ starting_after: 'cus_unknown' }));
    expect([unknown.statusCode, unknown.code, unknown.param]).toEqual([400, 'resource_missing', 'starting_after']);
  });
});

describe('expand', () => {
  it('adds includable fields only when expanded, also inside lists (data.*)', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c' });
    expect(c.subscriptions).toBeUndefined();
    const withIncludes = await stripe.customers.retrieve(c.id, { expand: ['subscriptions', 'tax', 'invoice_credit_balance'] });
    expect(withIncludes.subscriptions).toEqual({ object: 'list', data: [], has_more: false, url: `/v1/customers/${c.id}/subscriptions` });
    expect(withIncludes.tax).toEqual({ automatic_tax: 'unrecognized_location', ip_address: null, location: null, provider: 'stripe' });
    expect(withIncludes.invoice_credit_balance).toEqual({});
    const listed = await stripe.customers.list({ expand: ['data.sources'] });
    expect(listed.data[0].sources.object).toBe('list');
  });

  it('rejects non-expandable paths, unknown paths, total_count on F2/F3 and paths over four hops', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c' });
    for (const path of ['email', 'nope', 'invoice_settings', 'invoice_settings.footer', 'data.email']) {
      const err = await rejection(stripe.customers.retrieve(c.id, { expand: [path] }));
      expect([err.statusCode, err.param]).toEqual([400, 'expand']);
    }
    const tc = await rejection(stripe.customers.list({ expand: ['total_count'] }));
    expect(tc.message).toMatch(/property_forbidden/);
    await stripe.customers.create();
    await stripe.customers.create();
    const legacy = await stripe.customers.list({ limit: 1, expand: ['total_count'] }, { apiVersion: '2024-06-20' });
    expect([legacy.data.length, legacy.total_count]).toEqual([1, 3]);
  });

  it('replaces IDs with objects through declared paths, lists and arrays, up to four hops', () => {
    const registry = new Registry();
    registry.object('node', { expandable: ['next', 'meta.owner', 'peers'], links: { next: 'node', 'meta.owner': 'node', peers: 'node', items: { to: 'list<line>', embedded: true } }, render: (o) => ({ id: o.id, object: 'node', next: o.next, meta: { owner: o.owner }, peers: o.peers, items: { object: 'list', data: o.items, url: '/x' } }) });
    const objects = new Map();
    for (let i = 1; i <= 6; i++) objects.set(`n${i}`, { id: `n${i}`, object: 'node', next: i < 6 ? `n${i + 1}` : null, owner: 'n6', peers: ['n2', 'n3'], items: [] });
    objects.get('n1').items = [{ id: 'li_1', object: 'line', ref: 'n4' }];
    registry.object('line', { expandable: ['ref'], links: { ref: 'node' }, render: (o) => ({ ...o }) });
    const account = { store: { find: (id) => objects.get(id) ?? null }, server: { registry } };
    const out = render(account, objects.get('n1'), { version: '2026-08-26.dahlia', expand: ['next.next.next.next', 'meta.owner', 'peers', 'items.data.ref.next'] });
    expect(out.next.next.next.next.id).toBe('n5');
    expect(out.next.next.next.next.next).toBe('n6');
    expect(out.meta.owner.id).toBe('n6');
    expect(out.peers.map((p) => p.id)).toEqual(['n2', 'n3']);
    expect(out.items.data[0].ref.next.id).toBe('n5');
    const paths = ['next.next.next.next', 'meta.owner', 'peers', 'items.data.ref.next'];
    expect(() => checkExpand(registry, 'node', paths, '2026-08-26.dahlia')).not.toThrow();
    expect(() => checkExpand(registry, 'node', ['next.next.next.next.next'], '2026-08-26.dahlia')).toThrow(/cannot be expanded/);
  });
});

describe('concurrency', () => {
  it('serializes parallel requests of an account, including ones sharing an idempotency key', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => stripe.customers.create({ name: `p${i}` })));
    expect(new Set(created.map((c) => c.id)).size).toBe(20);
    const same = await Promise.all([1, 2, 3].map(() => stripe.customers.create({ name: 'once' }, { idempotencyKey: 'parallel' })));
    expect(new Set(same.map((c) => c.id)).size).toBe(1);
    expect(same.filter((c) => c.lastResponse.headers['idempotent-replayed'] === 'true')).toHaveLength(2);
    expect((await stripe.customers.list({ limit: 100 })).data).toHaveLength(21);
  });
});

describe('event rendering per endpoint version', () => {
  it('pre-renders each event for the account default and every endpoint version', async () => {
    const t = await startServer({ webhooks: [{ url: 'http://127.0.0.1:9/hook', secret: 'whsec_test', apiVersion: '2024-06-20' }] });
    const stripe = t.stripe();
    const c = await stripe.customers.create({ email: 'a@b.c' });
    await stripe.customers.update(c.id, { email: 'b@b.c' });
    const account = t.server.context.account(t.key);
    const [created, updated] = account.events.all();
    expect([...created._renders.keys()].sort()).toEqual(['2024-06-20', '2026-08-26.dahlia']);
    expect(created._renders.get('2024-06-20').object.discount).toBeNull();
    expect('discount' in created._renders.get('2026-08-26.dahlia').object).toBe(false);
    expect(updated._renders.get('2024-06-20').previous_attributes).toEqual({ email: 'a@b.c' });
  });
});

describe('isolation between keys', () => {
  it('keeps objects, events, faults and clocks separate per secret key', async () => {
    const t = await startServer();
    const a = t.stripe();
    const otherKey = testKey('other');
    const b = t.stripe(otherKey);
    const c = await a.customers.create({ email: 'a@b.c' });
    const missing = await rejection(b.customers.retrieve(c.id));
    expect(missing.code).toBe('resource_missing');
    expect((await b.customers.list()).data).toEqual([]);
    expect((await b.events.list()).data).toEqual([]);
    await t.account().faults.add({ path: '/v1/customers', kind: '429' });
    expect((await b.customers.create()).object).toBe('customer');
    await t.account(otherKey).advanceTime({ seconds: 3600 });
    const nowA = (await t.account().now()).now;
    const nowB = (await t.account(otherKey).now()).now;
    expect(nowB - nowA).toBeGreaterThanOrEqual(3599);
    expect(t.account().id).not.toBe(t.account(otherKey).id);
  });
});

describe('faults', () => {
  it('answers a 429 fault as StripeRateLimitError for `times` requests only', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: '429', times: 1 });
    const err = await rejection(stripe.customers.create());
    expect([err.type, err.statusCode, err.code]).toEqual(['StripeRateLimitError', 429, 'rate_limit']);
    expect(err.headers['stripe-rate-limited-reason']).toBe('global-rate');
    expect((await stripe.customers.create()).object).toBe('customer');
  });

  it('answers a 500 fault as StripeAPIError and lets SDK retries with the same key succeed', async () => {
    const t = await startServer();
    await t.account().faults.add({ path: '/v1/customers*', kind: '500', times: 1 });
    const err = await rejection(t.stripe().customers.list());
    expect([err.type, err.statusCode, err.rawType]).toEqual(['StripeAPIError', 500, 'api_error']);
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: '500', times: 1 });
    const retrying = t.stripe(t.key, { maxNetworkRetries: 1 });
    const c = await retrying.customers.create({ email: 'retry@b.c' });
    expect(c.email).toBe('retry@b.c');
    const posts = await t.account().requests({ method: 'POST', path: '/v1/customers' });
    expect(posts.map((p) => [p.status, p.fault])).toEqual([
      [500, '500'],
      [200, null],
    ]);
    expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
    expect((await retrying.customers.list()).data).toHaveLength(1);
  });

  it('holds the connection on a timeout fault so the SDK times out, without executing the request', async () => {
    const t = await startServer();
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: 'timeout', timeoutMs: 5000 });
    const started = Date.now();
    const err = await rejection(t.stripe(t.key, { timeout: 300 }).customers.create({ email: 'slow@b.c' }));
    expect(err.type).toBe('StripeConnectionError');
    expect(Date.now() - started).toBeLessThan(3000);
    const stripe = t.stripe();
    expect((await stripe.customers.list()).data).toEqual([]);
    expect((await stripe.customers.create({ email: 'fast@b.c' })).email).toBe('fast@b.c');
    const [entry] = await t.account().requests({ method: 'POST', limit: 2 });
    expect([entry.status, entry.fault]).toEqual([null, 'timeout']);
  });

  it('validates fault specs and clears them', async () => {
    const t = await startServer();
    const acct = t.account();
    await expect(acct.faults.add({ path: '/v1/customers', kind: '418' })).rejects.toMatchObject({ status: 400 });
    await acct.faults.add({ path: '/v1/customers', kind: '500', times: 3 });
    expect((await acct.faults.list())[0]).toMatchObject({ remaining: 3, method: null, kind: '500' });
    expect(await acct.faults.clear()).toEqual({ cleared: 1 });
    expect((await t.stripe().customers.list()).object).toBe('list');
  });
});

describe('time and controls', () => {
  it('advances the account clock and stamps new objects with it', async () => {
    const t = await startServer();
    const acct = t.account();
    const { now } = await acct.now();
    expect(Math.abs(now - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
    const moved = await acct.advanceTime({ seconds: 10 * 86400 });
    expect(moved.now - now).toBeGreaterThanOrEqual(10 * 86400);
    const c = await t.stripe().customers.create();
    expect(c.created).toBeGreaterThanOrEqual(moved.now);
    const to = await acct.advanceTime({ to: moved.now + 100 });
    expect(to.now).toBe(moved.now + 100);
    await expect(acct.advanceTime({ to: now })).rejects.toMatchObject({ status: 400 });
  });

  it('exposes the same controls over HTTP under /_test/ with the Bearer key', async () => {
    const t = await startServer();
    await t.stripe().customers.create({ email: 'a@b.c' });
    const now = await t.request('GET', '/_test/now');
    expect(now.status).toBe(200);
    expect(typeof now.json.now).toBe('number');
    expect(now.headers.get('request-id')).toMatch(/^req_\w{14}$/);
    const advanced = await t.request('POST', '/_test/advance_time', { json: { seconds: 60 } });
    expect(advanced.json.now).toBeGreaterThanOrEqual(now.json.now + 60);
    const requests = await t.request('GET', '/_test/requests?limit=1');
    expect(requests.json).toHaveLength(1);
    expect(requests.json[0]).toMatchObject({ method: 'POST', path: '/v1/customers', status: 200 });
    const state = await t.request('GET', '/_test/state?type=customer');
    expect(state.json.objects.customer[0].email).toBe('a@b.c');
    const settings = await t.request('POST', '/_test/billing_settings', { json: { afterFinalRetry: 'unpaid' } });
    expect(settings.json).toEqual({ retrySchedule: [2, 2, 2, 2, 2, 2, 2], afterFinalRetry: 'unpaid', markUncollectible: false });
    expect((await t.request('POST', '/_test/billing_settings', { json: { afterFinalRetry: 'maybe' } })).status).toBe(400);
    const unknown = await t.request('GET', '/_test/nope');
    expect([unknown.status, unknown.headers.get('request-id')]).toEqual([404, expect.stringMatching(/^req_/)]);
    const unauthenticated = await t.request('GET', '/_test/now', { key: null });
    expect([unauthenticated.status, unauthenticated.headers.get('request-id')]).toEqual([401, expect.stringMatching(/^req_/)]);
    const reset = await t.request('POST', '/_test/reset');
    expect(reset.json).toEqual({ reset: true });
    expect((await t.stripe().customers.list()).data).toEqual([]);
  });

  it('deletes a customer through the control with request: null on the event', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create();
    expect(await t.account().deleteCustomer(c.id)).toEqual({ id: c.id, object: 'customer', deleted: true });
    const [event] = (await stripe.events.list({ type: 'customer.deleted' })).data;
    expect(event.request).toEqual({ id: null, idempotency_key: null });
  });

  it('redacts secret keys in the ledger', async () => {
    const t = await startServer();
    await t.stripe().customers.create({ description: 'key sk_test_abcdefgh1234 and whsec_secret' });
    const [entry] = await t.account().requests({ limit: 1 });
    expect(entry.body.description).toBe('key sk_test_****1234 and whsec_****');
  });

  it('serves the events API with type filters', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await stripe.customers.create();
    await stripe.customers.update(c.id, { name: 'x' });
    expect((await stripe.events.list({ type: 'customer.*' })).data).toHaveLength(2);
    expect((await stripe.events.list({ types: ['customer.updated'] })).data.map((e) => e.type)).toEqual(['customer.updated']);
    expect((await rejection(stripe.events.list({ type: 'a', types: ['b'] }))).code).toBe('parameters_exclusive');
    expect((await rejection(stripe.events.retrieve('evt_missing'))).statusCode).toBe(404);
  });
});

describe('hosted pages', () => {
  it('resolve the account from a minted ID, run in the account lock and post forms back', async () => {
    const registry = new Registry();
    for (const mod of [eventsModule, customersModule]) mod.install(registry);
    registry.page('GET', '/t/:id', (p) => {
      const customer = p.account.store.require('customer', p.pathParams.id);
      return html('Test page', h`<p id="name">${customer.name}</p><form method="post"><input name="name"></form>`);
    }, { account: (params, server) => server.accountForId(params.id) });
    registry.page('POST', '/t/:id', (p) => {
      const customer = p.account.store.require('customer', p.pathParams.id);
      updateCustomer(p.account, customer, { name: p.form.name });
      return redirect(`/t/${customer.id}?done=1`);
    }, { account: (params, server) => server.accountForId(params.id) });
    const context = new ServerContext(normalizeOptions({ port: 0 }), registry);
    await context.listen();
    onTestFinished(() => context.close());
    const account = context.account(testKey('pages'));
    const customer = await account.run(() => createCustomer(account, { name: '<b>Jenny</b>' }));
    const page = await fetch(`${context.url}/t/${customer.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('request-id')).toMatch(/^req_\w{14}$/);
    expect(await page.text()).toContain('<p id="name">&lt;b&gt;Jenny&lt;/b&gt;</p>');
    const posted = await fetch(`${context.url}/t/${customer.id}`, { method: 'POST', body: 'name=Rosen+J', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    expect([posted.status, posted.headers.get('location')]).toEqual([303, `/t/${customer.id}?done=1`]);
    expect(customer.name).toBe('Rosen J');
    const [event] = account.events.all().slice(-1);
    expect([event.type, event.request]).toEqual(['customer.updated', { id: null, idempotency_key: null }]);
    expect((await fetch(`${context.url}/t/cus_unknown`)).status).toBe(404);
  });
});

describe('test helpers', () => {
  it('webhookReceiver records raw bodies and headers and answers with the configured status', async () => {
    const hooks = await webhookReceiver({ status: (delivery, i) => (i === 0 ? 500 : 200) });
    const body = '{"id":"evt_1","object":"event"}';
    const first = await fetch(hooks.url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc' } });
    const second = await fetch(hooks.url, { method: 'POST', body });
    expect([first.status, second.status]).toEqual([500, 200]);
    const deliveries = await hooks.waitFor(2);
    expect(deliveries[0]).toMatchObject({ method: 'POST', path: '/webhooks', rawBody: body, json: { id: 'evt_1', object: 'event' } });
    expect(deliveries[0].headers['stripe-signature']).toBe('t=1,v1=abc');
    await expect(hooks.waitFor(3, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });
});

describe('form parser', () => {
  it('builds nested trees from bracket notation', () => {
    expect(parseForm('a[]=1&a[]=2&b[0][x]=1&b[1][x]=2&c[][p]=1&c[][q]=2&c[][p]=3&d=&e+f=g+h')).toEqual({
      a: ['1', '2'],
      b: { 0: { x: '1' }, 1: { x: '2' } },
      c: [{ p: '1', q: '2' }, { p: '3' }],
      d: '',
      'e f': 'g h',
    });
    expect(parseForm('m%5Bk%5D=v')).toEqual({ m: { k: 'v' } });
    expect(() => parseForm('a=1&a[b]=2')).toThrow(/Invalid value for a\[b\]|Invalid value for a/);
  });
});

describe('parameter schemas and version gates', () => {
  const portal = 'POST /v1/billing_portal/configurations';
  const features = (extra) => ({ features: { subscription_update: { enabled: 'true', ...extra } }, business_profile: {} });

  it('rejects portal parameters on versions that do not have them, like unknown parameters', () => {
    const sape = features({ schedule_at_period_end: { conditions: { 0: { type: 'decreasing_item_amount' } } } });
    const err = (() => {
      try {
        validateParams(portal, sape, '2024-09-30.acacia');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err.fields).toMatchObject({
      code: 'parameter_unknown',
      param: 'features[subscription_update][schedule_at_period_end]',
      message: 'Received unknown parameter: features[subscription_update][schedule_at_period_end]',
    });
    expect(validateParams(portal, sape, '2024-10-28.acacia').features.subscription_update.schedule_at_period_end.conditions).toEqual([
      { type: 'decreasing_item_amount' },
    ]);
    expect(() => validateParams(portal, features({ trial_update_behavior: 'continue_trial' }), '2025-08-27.basil')).toThrow(
      /unknown parameter: features\[subscription_update\]\[trial_update_behavior\]/,
    );
    expect(validateParams(portal, features({ trial_update_behavior: 'continue_trial' }), '2025-09-30.clover').features.subscription_update.enabled).toBe(true);
  });

  it('applies removals, value gates and relaxed requirements by version', () => {
    expect(() => validateParams('POST /v1/customers', { coupon: 'x' }, '2025-03-31.basil')).toThrow(/unknown parameter: coupon/);
    expect(validateParams('POST /v1/customers', { coupon: 'x' }, '2025-02-24.acacia').coupon).toBe('x');
    const checkout = (uiMode) => ({ mode: 'subscription', ui_mode: uiMode });
    expect(() => validateParams('POST /v1/checkout/sessions', checkout('hosted'), '2026-08-26.dahlia')).toThrow(/Invalid ui_mode/);
    expect(() => validateParams('POST /v1/checkout/sessions', checkout('hosted_page'), '2025-01-27.acacia')).toThrow(/Invalid ui_mode/);
    expect(validateParams('POST /v1/checkout/sessions', checkout('hosted'), '2025-01-27.acacia').ui_mode).toBe('hosted');
    expect(validateParams('POST /v1/checkout/sessions', checkout('form'), '2026-08-26.dahlia').ui_mode).toBe('form');
    expect(() => validateParams('POST /v1/checkout/sessions', checkout('bogus'), '2026-08-26.dahlia')).toThrow(/Invalid ui_mode/);
    expect(() => validateParams('POST /v1/checkout/sessions', {}, '2026-08-26.dahlia')).toThrow(/Missing required param: mode/);
    const minimal = { features: { invoice_history: { enabled: 'true' } } };
    expect(() => validateParams(portal, minimal, '2024-06-20')).toThrow(/Missing required param: business_profile/);
    expect(validateParams(portal, minimal, '2026-08-26.dahlia').features.invoice_history.enabled).toBe(true);
    expect(() => validateParams('POST /v1/subscription_schedules', { phases: { 0: { items: { 0: { price: 'p' } }, iterations: '2' } } }, '2025-09-30.clover')).toThrow(
      /unknown parameter: phases\[0\]\[iterations\]/,
    );
    expect(validateParams('POST /v1/subscriptions', { customer: 'c', items: { 0: { price: 'p' } }, billing_mode: { type: 'flexible' } }, '2025-06-30.basil').billing_mode.type).toBe('flexible');
    expect(() => validateParams('POST /v1/subscriptions', { customer: 'c', items: { 0: { price: 'p' } }, billing_mode: { type: 'flexible' } }, '2025-05-28.basil')).toThrow(
      /unknown parameter: billing_mode/,
    );
  });

  it('converts anyOf values such as trial_end (now | timestamp) and created ranges', () => {
    const upd = 'POST /v1/subscriptions/{subscription_exposed_id}';
    expect(validateParams(upd, { trial_end: 'now' }, '2026-08-26.dahlia').trial_end).toBe('now');
    expect(validateParams(upd, { trial_end: '1700000000' }, '2026-08-26.dahlia').trial_end).toBe(1700000000);
    expect(() => validateParams(upd, { trial_end: 'later' }, '2026-08-26.dahlia')).toThrow();
    expect(validateParams('GET /v1/customers', { created: { gte: '5' }, limit: '3' }, '2026-08-26.dahlia')).toEqual({ created: { gte: 5 }, limit: 3 });
  });
});

describe('billing period arithmetic', () => {
  it('clamps month ends from the anchor day (billing-cycle examples from the docs)', () => {
    const anchor = Date.UTC(2026, 0, 31, 10) / 1000;
    expect([1, 2, 3, 4].map((k) => iso(addIntervals(anchor, 'month', 1, k)))).toEqual([
      '2026-02-28T10:00:00.000Z',
      '2026-03-31T10:00:00.000Z',
      '2026-04-30T10:00:00.000Z',
      '2026-05-31T10:00:00.000Z',
    ]);
    expect([1, 2, 3, 4].map((k) => iso(addIntervals(anchor, 'month', 3, k)).slice(0, 10))).toEqual(['2026-04-30', '2026-07-31', '2026-10-31', '2027-01-31']);
    const leap = Date.UTC(2028, 1, 29) / 1000;
    expect([1, 2, 3, 4].map((k) => iso(addIntervals(leap, 'year', 1, k)).slice(0, 10))).toEqual(['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });

  it('finds the period containing a time and the next boundary', () => {
    const anchor = Date.UTC(2026, 0, 31, 10) / 1000;
    const t = Date.UTC(2026, 2, 15) / 1000;
    expect(iso(nextBoundaryAfter(anchor, 'month', 1, t))).toBe('2026-03-31T10:00:00.000Z');
    expect(periodContaining(anchor, 'month', 1, t)).toEqual({ start: Date.UTC(2026, 1, 28, 10) / 1000, end: Date.UTC(2026, 2, 31, 10) / 1000 });
    expect(nextBoundaryAfter(anchor, 'week', 2, anchor)).toBe(anchor + 14 * 86400);
    expect(nextBoundaryAfter(anchor, 'day', 1, anchor - 1)).toBe(anchor);
  });
});

describe('time engine', () => {
  const fakeAccount = () => {
    const account = { currentRequest: null, server: { log: () => {} }, store: { find: () => null, get: () => null } };
    const runs = [];
    const handlers = new Map([
      ['record', (acct, job) => runs.push([job.data.name, acct.time.now(job.domain)])],
      ['chain', (acct, job) => {
        runs.push([job.data.name, acct.time.now(job.domain)]);
        if (job.data.next) acct.time.schedule({ kind: 'record', at: job.at + 10, domain: job.domain, data: { name: job.data.next } });
      }],
    ]);
    account.time = new TimeEngine(account, handlers);
    return { account, runs };
  };

  it('runs due jobs in time, priority and scheduling order, including jobs scheduled while running', () => {
    const { account, runs } = fakeAccount();
    const t0 = account.time.now();
    account.time.schedule({ kind: 'record', at: t0 + 100, data: { name: 'renewal' }, priority: JOB_PRIORITY.renewal });
    account.time.schedule({ kind: 'record', at: t0 + 100, data: { name: 'phase' }, priority: JOB_PRIORITY.schedulePhase });
    account.time.schedule({ kind: 'chain', at: t0 + 50, data: { name: 'first', next: 'chained' } });
    account.time.schedule({ kind: 'record', at: t0 + 500, data: { name: 'later' } });
    account.time.schedule({ kind: 'record', at: t0 + 90, key: 'k', data: { name: 'replaced' } });
    account.time.schedule({ kind: 'record', at: t0 + 95, key: 'k', data: { name: 'replacement' } });
    const now = account.time.advanceAccountClock({ seconds: 200 });
    expect(runs).toEqual([
      ['first', t0 + 50],
      ['chained', t0 + 60],
      ['replacement', t0 + 95],
      ['phase', t0 + 100],
      ['renewal', t0 + 100],
    ]);
    expect(now).toBe(t0 + 200);
    expect(account.time.list().map((j) => j.data.name)).toEqual(['later']);
  });

  it('keeps test clock domains separate from the account clock', () => {
    const { account, runs } = fakeAccount();
    account.time.registerClock('clock_1', 1000);
    account.time.schedule({ kind: 'record', at: 1500, domain: 'clock_1', data: { name: 'clock' } });
    account.time.advanceAccountClock({ seconds: 3600 });
    expect(runs).toEqual([]);
    expect(account.time.now('clock_1')).toBe(1000);
    account.time.advance('clock_1', 2000);
    expect(runs).toEqual([['clock', 1500]]);
    expect(account.time.now('clock_1')).toBe(2000);
    account.time.removeClock('clock_1');
    expect(account.time.now('clock_1')).toBe(account.time.now());
  });
});
