/**
 * Webhook delivery through the real stripe SDK: signatures (constructEvent), retries, timeouts,
 * manual deliveries, hold/release ordering, per-endpoint API versions, isolation between keys,
 * the webhook endpoints API and the events API filters.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer, testKey, webhookReceiver } from './helpers.js';

const SECRET = 'whsec_test_secret';
const FAST_RETRY = { delaysMs: [20, 20, 20], timeoutMs: 2000 };

/** The event of a received delivery, verified like a production handler does. */
function verify(stripe, delivery, secret = SECRET) {
  return stripe.webhooks.constructEvent(delivery.rawBody, delivery.headers['stripe-signature'], secret);
}

describe('signatures', () => {
  it('signs every delivery so constructEvent verifies it, with real time in t even when the account clock is ahead', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }] });
    const stripe = t.stripe();
    await t.account().advanceTime({ seconds: 30 * 86400 });
    const customer = await stripe.customers.create({ email: 'a@example.com' });
    await stripe.customers.update(customer.id, { name: 'Jenny' });
    await t.server.settle();

    const events = hooks.deliveries.map((d) => verify(stripe, d));
    expect(events.map((e) => e.type)).toEqual(['customer.created', 'customer.updated']);
    const [created, updated] = events;
    expect(created.data.object.id).toBe(customer.id);
    expect(updated.data.previous_attributes).toEqual({ name: null });
    expect(await stripe.events.retrieve(updated.id)).toMatchObject({ id: updated.id, data: updated.data, pending_webhooks: 0 });

    const [first] = hooks.deliveries;
    expect(first.headers['content-type']).toMatch(/^application\/json/);
    const signedAt = Number(/^t=(\d+),v1=[0-9a-f]{64}$/.exec(first.headers['stripe-signature'])[1]);
    expect(Math.abs(signedAt - Date.now() / 1000)).toBeLessThan(10);
    expect(created.created - signedAt).toBeGreaterThan(29 * 86400);
  });

  it('is rejected by constructEvent when the body is tampered with or the signature is bad', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const hooks = await webhookReceiver({
      status: (delivery) => {
        try {
          verify(stripe, delivery);
          return 200;
        } catch {
          return 400;
        }
      },
    });
    await t.account().setWebhookEndpoints([{ url: hooks.url, secret: SECRET }]);
    await stripe.customers.create({ email: 'a@example.com' });
    await t.account().webhooks.settle();
    const [genuine] = hooks.deliveries;
    const tampered = { ...genuine, rawBody: genuine.rawBody.replace('a@example.com', 'b@example.com') };
    expect(() => verify(stripe, tampered)).toThrow(/No signatures found matching the expected signature/);

    const { deliveries } = await t.account().webhooks.sendWithBadSignature(genuine.json.id);
    expect(deliveries).toMatchObject([{ kind: 'bad_signature', status: 'queued' }]);
    await t.account().webhooks.settle();
    const bad = hooks.deliveries[1];
    expect(bad.json.id).toBe(genuine.json.id);
    expect(() => verify(stripe, bad)).toThrow(/No signatures found matching the expected signature/);
    const [record] = await t.account().webhooks.deliveries({ kind: 'bad_signature' });
    expect(record).toMatchObject({ status: 'failed', attempts: 1, responseStatus: 400 });
  });
});

describe('retries', () => {
  it('retries a receiver that fails twice, re-signing each attempt, and then counts the event as delivered', async () => {
    const hooks = await webhookReceiver({ status: (delivery, index) => (index < 2 ? 500 : 200) });
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }], webhookRetry: FAST_RETRY });
    const stripe = t.stripe();
    await stripe.customers.create();
    await t.server.settle();

    expect(hooks.deliveries).toHaveLength(3);
    const events = hooks.deliveries.map((d) => verify(stripe, d));
    expect(new Set(events.map((e) => e.id)).size).toBe(1);
    expect(events[0].pending_webhooks).toBe(1);
    const [record] = await t.account().webhooks.deliveries();
    expect(record).toMatchObject({ kind: 'automatic', status: 'succeeded', attempts: 3, responseStatus: 200 });
    expect(record.history.map((h) => h.responseStatus)).toEqual([500, 500, 200]);
    expect((await stripe.events.retrieve(events[0].id)).pending_webhooks).toBe(0);
    expect((await stripe.events.list({ delivery_success: true })).data.map((e) => e.id)).toEqual([events[0].id]);
  });

  it('treats timeouts and refused connections as failures, gives up after the last retry and keeps the event pending', async () => {
    const slow = await webhookReceiver({ delayMs: 400 });
    const gone = await webhookReceiver();
    await gone.close();
    const t = await startServer({
      webhooks: [
        { url: slow.url, secret: SECRET },
        { url: gone.url, secret: SECRET },
      ],
      webhookRetry: { delaysMs: [10], timeoutMs: 100 },
    });
    const stripe = t.stripe();
    const customer = await stripe.customers.create();
    await t.server.settle();

    const records = await t.account().webhooks.deliveries();
    expect(records.map((r) => [r.url, r.status, r.attempts])).toEqual([
      [slow.url, 'failed', 2],
      [gone.url, 'failed', 2],
    ]);
    expect(records[0].error).toMatch(/Timed out/);
    expect(records[1].error).toMatch(/Unable to connect/);
    const [event] = (await stripe.events.list({ delivery_success: false })).data;
    expect(event.data.object.id).toBe(customer.id);
    expect(event.pending_webhooks).toBe(2);
  });
});

describe('manual deliveries', () => {
  it('resends once and delivers duplicates twice more, same event ID, without settling the failed automatic delivery', async () => {
    const hooks = await webhookReceiver({ status: (delivery, index) => (index === 0 ? 500 : 200) });
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }], webhookRetry: { delaysMs: [], timeoutMs: 2000 } });
    const stripe = t.stripe();
    await stripe.customers.create();
    await t.server.settle();
    const eventId = hooks.deliveries[0].json.id;
    expect((await t.account().webhooks.deliveries()).map((d) => [d.kind, d.status])).toEqual([['automatic', 'failed']]);

    const resent = await t.account().webhooks.resend(eventId);
    expect(resent.deliveries.map((d) => d.kind)).toEqual(['resend']);
    const duplicates = await t.account().webhooks.deliverDuplicate(eventId);
    expect(duplicates.deliveries.map((d) => d.kind)).toEqual(['duplicate', 'duplicate']);
    await t.server.settle();

    expect(hooks.deliveries.map((d) => verify(stripe, d).id)).toEqual([eventId, eventId, eventId, eventId]);
    expect((await t.account().webhooks.deliveries({ status: 'succeeded' })).map((d) => d.kind)).toEqual(['resend', 'duplicate', 'duplicate']);
    expect((await stripe.events.retrieve(eventId)).pending_webhooks).toBe(1);
    expect((await stripe.events.list({ delivery_success: false })).data.map((e) => e.id)).toEqual([eventId]);
    expect((await rejection(t.account().webhooks.resend('evt_unknown'))).code).toBe('resource_missing');
  });
});

describe('hold and release', () => {
  it('holds deliveries until released, then sends them in reverse or in a chosen order', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }] });
    const stripe = t.stripe();
    const acct = t.account();
    await acct.webhooks.hold();
    for (const name of ['one', 'two', 'three']) await stripe.customers.create({ name });
    await acct.webhooks.settle();
    expect(hooks.deliveries).toHaveLength(0);
    expect((await acct.webhooks.deliveries()).map((d) => d.status)).toEqual(['held', 'held', 'held']);

    const released = await acct.webhooks.release({ order: 'reverse' });
    expect(released.released).toBe(3);
    await acct.webhooks.settle();
    expect(hooks.deliveries.map((d) => verify(stripe, d).data.object.name)).toEqual(['three', 'two', 'one']);

    await acct.webhooks.hold();
    for (const name of ['four', 'five', 'six']) await stripe.customers.create({ name });
    const [, five] = (await stripe.events.list({ limit: 3 })).data.reverse();
    await acct.webhooks.release({ order: [five.id] });
    await acct.webhooks.settle();
    expect(hooks.deliveries.slice(3).map((d) => d.json.data.object.name)).toEqual(['five', 'four', 'six']);
    expect((await rejection(acct.webhooks.release({ order: ['evt_unknown'] }))).param).toBe('order');
  });
});

describe('endpoints and versions', () => {
  it('renders one event per endpoint API version under the same event ID', async () => {
    const legacy = await webhookReceiver();
    const current = await webhookReceiver();
    const t = await startServer({ webhooks: [{ url: legacy.url, secret: SECRET, apiVersion: '2024-06-20' }] });
    await t.account().setWebhookEndpoints([{ url: current.url, secret: 'whsec_other' }]);
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'a@example.com' });
    await stripe.customers.update(customer.id, { email: 'b@example.com' });
    await t.server.settle();

    const old = legacy.deliveries.map((d) => verify(stripe, d));
    const now = current.deliveries.map((d) => verify(stripe, d, 'whsec_other'));
    expect(old.map((e) => e.id)).toEqual(now.map((e) => e.id));
    expect(old.map((e) => e.api_version)).toEqual(['2024-06-20', '2024-06-20']);
    expect(now.map((e) => e.api_version)).toEqual(['2026-08-26.dahlia', '2026-08-26.dahlia']);
    expect(old[0].data.object.discount).toBeNull();
    expect('discount' in now[0].data.object).toBe(false);
    expect(old[1].data.previous_attributes).toEqual({ email: 'a@example.com' });
    expect(now[1].data.previous_attributes).toEqual({ email: 'a@example.com' });
  });

  it('keeps endpoints, deliveries and events separate per key; server-wide endpoints get every account', async () => {
    const shared = await webhookReceiver();
    const onlyA = await webhookReceiver();
    const onlyB = await webhookReceiver();
    const t = await startServer({ webhooks: [{ url: shared.url, secret: SECRET }] });
    const keyB = testKey('b');
    await t.account().setWebhookEndpoints([{ url: onlyA.url, secret: 'whsec_a' }]);
    await t.account(keyB).setWebhookEndpoints([{ url: onlyB.url, secret: 'whsec_b' }]);
    const a = await t.stripe().customers.create({ name: 'A' });
    const b = await t.stripe(keyB).customers.create({ name: 'B' });
    await t.server.settle();

    expect(onlyA.deliveries.map((d) => d.json.data.object.id)).toEqual([a.id]);
    expect(onlyB.deliveries.map((d) => d.json.data.object.id)).toEqual([b.id]);
    expect(shared.deliveries.map((d) => d.json.data.object.id).sort()).toEqual([a.id, b.id].sort());
    const recordsA = await t.account().webhooks.deliveries();
    expect(recordsA.map((r) => r.url).sort()).toEqual([onlyA.url, shared.url].sort());
    expect(recordsA.every((r) => r.eventId === onlyA.deliveries[0].json.id)).toBe(true);
  });

  it('manages endpoints through /v1/webhook_endpoints: secret on create only, subscriptions, disable, delete', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer();
    const stripe = t.stripe();
    const endpoint = await stripe.webhookEndpoints.create({
      url: hooks.url,
      enabled_events: ['customer.updated'],
      api_version: '2025-03-31.basil',
      description: 'Updates only',
    });
    expect(endpoint).toMatchObject({ object: 'webhook_endpoint', status: 'enabled', api_version: '2025-03-31.basil', application: null, livemode: false });
    expect(endpoint.secret).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    expect('secret' in (await stripe.webhookEndpoints.retrieve(endpoint.id))).toBe(false);
    expect((await stripe.webhookEndpoints.list()).data.map((e) => e.id)).toEqual([endpoint.id]);

    const customer = await stripe.customers.create();
    await stripe.customers.update(customer.id, { name: 'Jenny' });
    await t.account().webhooks.settle();
    const received = hooks.deliveries.map((d) => verify(stripe, d, endpoint.secret));
    expect(received.map((e) => [e.type, e.api_version])).toEqual([['customer.updated', '2025-03-31.basil']]);

    const disabled = await stripe.webhookEndpoints.update(endpoint.id, { disabled: true });
    expect(disabled.status).toBe('disabled');
    await stripe.customers.update(customer.id, { name: 'Rosen' });
    await t.account().webhooks.settle();
    expect(hooks.deliveries).toHaveLength(1);
    expect(await t.account().webhooks.deliveries()).toHaveLength(1);

    expect(await stripe.webhookEndpoints.del(endpoint.id)).toEqual(expect.objectContaining({ id: endpoint.id, deleted: true }));
    expect((await rejection(stripe.webhookEndpoints.retrieve(endpoint.id))).statusCode).toBe(404);

    const bad = (params) => rejection(stripe.webhookEndpoints.create({ url: hooks.url, enabled_events: ['*'], ...params }));
    expect(await bad({ url: 'not a url' })).toMatchObject({ code: 'url_invalid', param: 'url' });
    expect((await bad({ api_version: '2019-13-45' })).param).toBe('api_version');
    expect((await bad({ enabled_events: ['customer.exploded'] })).param).toBe('enabled_events[0]');
    expect((await bad({ connect: true })).param).toBe('connect');
  });
});

describe('endpoint changes and reset', () => {
  it('drops queued deliveries of replaced endpoints', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer();
    const stripe = t.stripe();
    const acct = t.account();
    await acct.setWebhookEndpoints([{ url: hooks.url, secret: SECRET }]);
    await acct.webhooks.hold();
    await stripe.customers.create();
    const [event] = (await stripe.events.list()).data;
    expect(event.pending_webhooks).toBe(1);

    await acct.setWebhookEndpoints([]);
    expect((await acct.webhooks.deliveries()).map((d) => [d.status, d.error])).toEqual([['canceled', 'Endpoint replaced']]);
    expect((await stripe.events.retrieve(event.id)).pending_webhooks).toBe(0);
    await acct.webhooks.release();
    await acct.webhooks.settle();
    expect(hooks.deliveries).toHaveLength(0);
    expect((await rejection(acct.webhooks.resend(event.id))).param).toBe('eventId');
  });

  it('stops pending retries on reset, so no event from before the reset arrives afterwards', async () => {
    const hooks = await webhookReceiver({ status: 500 });
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }], webhookRetry: { delaysMs: [50], timeoutMs: 2000 } });
    await t.stripe().customers.create();
    await hooks.waitFor(1);
    await t.account().reset();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(hooks.deliveries).toHaveLength(1);
    expect(await t.account().webhooks.deliveries()).toEqual([]);
  });
});

describe('controls over HTTP', () => {
  it('exposes the webhook controls under /_test/ with the Bearer key', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer();
    const put = await t.request('PUT', '/_test/webhook_endpoints', { json: { endpoints: [{ url: hooks.url, secret: SECRET }] } });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject([{ object: 'webhook_endpoint', scope: 'account', url: hooks.url, apiVersion: null, enabledEvents: ['*'] }]);
    await t.stripe().customers.create();
    expect((await t.request('POST', '/_test/webhooks/settle', { json: {} })).json).toEqual({ settled: true });
    const eventId = hooks.deliveries[0].json.id;
    const list = await t.request('GET', `/_test/webhooks/deliveries?eventId=${eventId}`);
    expect(list.json.map((d) => [d.eventId, d.status])).toEqual([[eventId, 'succeeded']]);
    const invalid = await t.request('PUT', '/_test/webhook_endpoints', { json: { endpoints: [{ url: 'ftp://x', secret: SECRET }] } });
    expect([invalid.status, invalid.json.error.param]).toEqual([400, 'endpoints[0][url]']);
  });
});

describe('events API', () => {
  it('filters by created range and types, pages with starting_after and serves frozen snapshots', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const acct = t.account();
    const first = await stripe.customers.create({ name: 'first' });
    const { now } = await acct.advanceTime({ seconds: 3600 });
    await stripe.customers.update(first.id, { name: 'renamed' });
    await stripe.customers.create({ name: 'second' });

    expect((await stripe.events.list({ created: { gte: now } })).data.map((e) => e.type)).toEqual(['customer.created', 'customer.updated']);
    expect((await stripe.events.list({ created: { lt: now } })).data.map((e) => e.data.object.name)).toEqual(['first']);
    expect((await stripe.events.list({ types: ['customer.up*', 'customer.deleted'] })).data.map((e) => e.type)).toEqual(['customer.updated']);

    const page1 = await stripe.events.list({ limit: 2 });
    expect([page1.data.length, page1.has_more]).toEqual([2, true]);
    const page2 = await stripe.events.list({ limit: 2, starting_after: page1.data[1].id });
    expect([page2.data.map((e) => e.data.object.name), page2.has_more]).toEqual([['first'], false]);
    expect((await stripe.events.retrieve(page2.data[0].id)).data.object.name).toBe('first');
  });
});
