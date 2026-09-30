/**
 * Robustness: parallel isolation between keys, idempotency under concurrency and expiry, faults
 * consumed per SDK retry attempt, webhook retry backoff, clean shutdown (no handles left),
 * reset(), malformed request bodies and the CLI. The SDK is the client everywhere except for
 * wire-level malformed bodies and /_test/ controls.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { describe, expect, it, onTestFinished } from 'vitest';
import { rejection, startServer, testKey, webhookReceiver } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/stripe-test-server.js', import.meta.url));
const SECRET = 'whsec_robustness_secret';

/** An SDK client with the SDK's own defaults (maxNetworkRetries 2), unlike t.stripe(). */
function defaultSdk(t, key = t.key, opts = {}) {
  return new Stripe(key, { host: '127.0.0.1', port: t.port, protocol: 'http', telemetry: false, ...opts });
}

describe('parallel isolation between keys', () => {
  it('keeps two keys hammering concurrently apart, including idempotency keys reused across keys', async () => {
    const t = await startServer();
    const keyA = t.key;
    const keyB = testKey('hammer');
    const a = t.stripe(keyA);
    const b = t.stripe(keyB);
    // 30 creates per key, interleaved, with 10 idempotency keys shared by both accounts.
    const calls = [];
    for (let i = 0; i < 30; i++) {
      calls.push(a.customers.create({ name: `a${i % 10}` }, { idempotencyKey: `shared-${i % 10}` }).then((c) => ['A', c]));
      calls.push(b.customers.create({ name: `b${i % 10}` }, { idempotencyKey: `shared-${i % 10}` }).then((c) => ['B', c]));
      if (i % 5 === 0) calls.push(a.customers.list({ limit: 3 }).then(() => null), b.events.list({ limit: 3 }).then(() => null));
    }
    const results = (await Promise.all(calls)).filter(Boolean);
    const byKey = { A: results.filter(([k]) => k === 'A').map(([, c]) => c), B: results.filter(([k]) => k === 'B').map(([, c]) => c) };
    for (const [label, list] of Object.entries(byKey)) {
      expect(new Set(list.map((c) => c.id)).size).toBe(10);
      expect(list.filter((c) => c.lastResponse.headers['idempotent-replayed'] === 'true')).toHaveLength(20);
      // A replay under one key never returns the other key's customer.
      const prefix = label === 'A' ? 'a' : 'b';
      expect(list.every((c) => c.name.startsWith(prefix))).toBe(true);
    }
    const idsA = new Set(byKey.A.map((c) => c.id));
    expect(byKey.B.some((c) => idsA.has(c.id))).toBe(false);

    const listedA = await a.customers.list({ limit: 100 });
    const listedB = await b.customers.list({ limit: 100 });
    expect(listedA.data.map((c) => c.id).sort()).toEqual([...idsA].sort());
    expect(listedB.data).toHaveLength(10);
    const eventsA = await a.events.list({ limit: 100, type: 'customer.created' });
    expect(eventsA.data).toHaveLength(10);
    expect(eventsA.data.every((e) => idsA.has(e.data.object.id))).toBe(true);
    // Cross-key lookups miss.
    const missing = await rejection(b.customers.retrieve(byKey.A[0].id));
    expect([missing.statusCode, missing.code]).toEqual([404, 'resource_missing']);
    // Each ledger holds only its own requests.
    const ledgerB = await t.account(keyB).requests({ limit: 1000 });
    expect(ledgerB.filter((r) => r.method === 'POST' && r.path === '/v1/customers')).toHaveLength(30);
  });
});

describe('idempotency under concurrency and expiry', () => {
  it('answers concurrent requests with one key and different parameters with one result and one idempotency_error', async () => {
    // Requests sharing a key are serialized, so the later ones replay or mismatch (no 409).
    const t = await startServer();
    const stripe = t.stripe();
    const settled = await Promise.allSettled([
      stripe.customers.create({ name: 'first' }, { idempotencyKey: 'race' }),
      stripe.customers.create({ name: 'second' }, { idempotencyKey: 'race' }),
      stripe.customers.create({ name: 'first' }, { idempotencyKey: 'race' }),
    ]);
    const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    const failed = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
    expect(ok).toHaveLength(2);
    expect(new Set(ok.map((c) => c.id)).size).toBe(1);
    expect(failed.map((e) => [e.type, e.statusCode])).toEqual([['StripeIdempotencyError', 400]]);
    expect((await stripe.customers.list()).data).toHaveLength(1);
  });

  it('replays until just before 24 h of advanced account time and runs anew (without a mismatch error) after', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const acct = t.account();
    const first = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'ttl' });
    await acct.advanceTime({ seconds: 24 * 3600 - 5 });
    const replay = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'ttl' });
    expect(replay.id).toBe(first.id);
    expect(replay.lastResponse.headers['idempotent-replayed']).toBe('true');
    const mismatch = await rejection(stripe.customers.create({ email: 'z@b.c' }, { idempotencyKey: 'ttl' }));
    expect(mismatch.type).toBe('StripeIdempotencyError');
    await acct.advanceTime({ seconds: 10 });
    // Pruned: other parameters under the same key now execute as a new request.
    const fresh = await stripe.customers.create({ email: 'z@b.c' }, { idempotencyKey: 'ttl' });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.email).toBe('z@b.c');
    expect(fresh.lastResponse.headers['idempotent-replayed']).toBeUndefined();
    // And the new entry lives its own 24 hours.
    const again = await stripe.customers.create({ email: 'z@b.c' }, { idempotencyKey: 'ttl' });
    expect(again.id).toBe(fresh.id);
    // Advancing one key's clock does not expire another key's entries.
    const otherKey = testKey('ttl');
    const other = t.stripe(otherKey);
    const o1 = await other.customers.create({ email: 'o@b.c' }, { idempotencyKey: 'ttl2' });
    await acct.advanceTime({ seconds: 48 * 3600 });
    const o2 = await other.customers.create({ email: 'o@b.c' }, { idempotencyKey: 'ttl2' });
    expect(o2.id).toBe(o1.id);
  });
});

describe('faults per SDK retry attempt', () => {
  it('lets the default SDK (2 retries) recover from a 500 fault with times 1 and 2, all attempts sharing one key', async () => {
    const t = await startServer();
    const stripe = defaultSdk(t);
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: '500', times: 1 });
    const c1 = await stripe.customers.create({ email: 'one@b.c' });
    expect(c1.email).toBe('one@b.c');
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: '500', times: 2 });
    const c2 = await stripe.customers.create({ email: 'two@b.c' });
    expect(c2.email).toBe('two@b.c');
    const posts = await t.account().requests({ method: 'POST', path: '/v1/customers' });
    expect(posts.map((p) => p.fault)).toEqual(['500', null, '500', '500', null]);
    expect(new Set(posts.slice(0, 2).map((p) => p.idempotencyKey)).size).toBe(1);
    expect(new Set(posts.slice(2).map((p) => p.idempotencyKey)).size).toBe(1);
    expect((await stripe.customers.list()).data).toHaveLength(2);
    expect((await t.account().faults.list()).every((f) => f.remaining === 0)).toBe(true);
  }, 20000);

  it('surfaces the 500 when the fault outlasts the SDK retries (times 3), without executing the request', async () => {
    const t = await startServer();
    const stripe = defaultSdk(t);
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: '500', times: 3 });
    const err = await rejection(stripe.customers.create({ email: 'never@b.c' }));
    expect([err.type, err.statusCode, err.rawType]).toEqual(['StripeAPIError', 500, 'api_error']);
    const posts = await t.account().requests({ method: 'POST', path: '/v1/customers' });
    expect(posts.map((p) => [p.status, p.fault])).toEqual([
      [500, '500'],
      [500, '500'],
      [500, '500'],
    ]);
    expect((await stripe.customers.list()).data).toEqual([]);
    expect((await stripe.events.list()).data).toEqual([]);
  }, 20000);

  it('retries a timeout fault after a short SDK timeout and executes the request exactly once', async () => {
    const t = await startServer();
    const stripe = defaultSdk(t, t.key, { timeout: 300 });
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: 'timeout', timeoutMs: 10000, times: 1 });
    const started = Date.now();
    const c = await stripe.customers.create({ email: 'late@b.c' });
    expect(c.email).toBe('late@b.c');
    expect(Date.now() - started).toBeLessThan(5000);
    const posts = await t.account().requests({ method: 'POST', path: '/v1/customers' });
    expect(posts.map((p) => [p.status, p.fault])).toEqual([
      [null, 'timeout'],
      [200, null],
    ]);
    expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey);
    expect((await stripe.customers.list()).data).toHaveLength(1);
    // The abandoned connection's drop timer went away with the client.
    expect(t.server.context.timers.size).toBe(0);
  }, 20000);

  it('surfaces StripeConnectionError when every attempt times out', async () => {
    const t = await startServer();
    const stripe = defaultSdk(t, t.key, { timeout: 200, maxNetworkRetries: 1 });
    await t.account().faults.add({ method: 'GET', path: '/v1/customers', kind: 'timeout', timeoutMs: 10000, times: 5 });
    const err = await rejection(stripe.customers.list());
    expect(err.type).toBe('StripeConnectionError');
    const gets = await t.account().requests({ method: 'GET', path: '/v1/customers' });
    expect(gets.map((g) => g.fault)).toEqual(['timeout', 'timeout']);
    expect((await t.account().faults.list())[0].remaining).toBe(3);
  }, 20000);
});

describe('webhook retry backoff', () => {
  it('retries a receiver answering 500 then 200 after the configured delay, re-signed and verifiable each time', async () => {
    const hooks = await webhookReceiver({ status: (d, index) => (index === 0 ? 500 : 200) });
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }], webhookRetry: { delaysMs: [400, 5000], timeoutMs: 2000 } });
    const stripe = t.stripe();
    await stripe.customers.create({ email: 'hook@b.c' });
    await hooks.waitFor(1);
    // While waiting for the retry the delivery says so, and the event is still pending.
    await new Promise((r) => setTimeout(r, 50));
    const [waiting] = await t.account().webhooks.deliveries();
    expect(waiting).toMatchObject({ status: 'retrying', attempts: 1, responseStatus: 500 });
    expect(Date.parse(waiting.nextAttemptAt) - hooks.deliveries[0].receivedAt).toBeGreaterThanOrEqual(300);
    const eventId = hooks.deliveries[0].json.id;
    expect((await stripe.events.retrieve(eventId)).pending_webhooks).toBe(1);

    await hooks.waitFor(2, { timeoutMs: 4000 });
    await t.server.settle();
    const gap = hooks.deliveries[1].receivedAt - hooks.deliveries[0].receivedAt;
    expect(gap).toBeGreaterThanOrEqual(380);
    expect(gap).toBeLessThan(3000);
    const events = hooks.deliveries.map((d) => stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], SECRET));
    expect(events.map((e) => e.id)).toEqual([eventId, eventId]);
    const [done] = await t.account().webhooks.deliveries();
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2, responseStatus: 200, nextAttemptAt: null });
    expect(done.history.map((h) => h.responseStatus)).toEqual([500, 200]);
    expect((await stripe.events.retrieve(eventId)).pending_webhooks).toBe(0);
    expect(hooks.deliveries).toHaveLength(2);
  }, 15000);
});

/** Runs a Node ESM snippet in a child process (cwd = project root); resolves { code, stdout, stderr, ms }. */
function runNode(source, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

describe('server.close()', () => {
  it('leaves no timers or sockets behind: the process exits on its own right after close', async () => {
    // Busy state at close: a held timeout-fault connection, an in-flight webhook to a receiver
    // that never answers, a webhook waiting 60 s to retry, a keep-alive SDK socket, scheduled jobs.
    const source = `
            import Stripe from 'stripe';
      import { createStripeTestServer } from './src/index.js';
      const silent = http.createServer(() => {});           // accepts and never answers
      await new Promise((r) => silent.listen(0, '127.0.0.1', r));
      const server = await createStripeTestServer({
        webhooks: [
          { url: 'http://127.0.0.1:' + silent.address().port + '/hang', secret: 'whsec_a' },
          { url: 'http://127.0.0.1:9/refused', secret: 'whsec_b' },
        ],
        webhookRetry: { delaysMs: [60000], timeoutMs: 60000 },
      });
      const stripe = new Stripe('sk_test_close', { host: '127.0.0.1', port: server.port, protocol: 'http', telemetry: false, maxNetworkRetries: 0 });
      const c = await stripe.customers.create({ email: 'x@y.z' });
      const prod = await stripe.products.create({ name: 'P' });
      const price = await stripe.prices.create({ product: prod.id, currency: 'usd', unit_amount: 500, recurring: { interval: 'month' } });
      await server.account('sk_test_close').createSubscription(c.id, { price: price.id, trialDays: 3 });
      await server.account('sk_test_close').faults.add({ method: 'GET', path: '/v1/customers', kind: 'timeout', timeoutMs: 60000 });
      const hung = fetch(server.url + '/v1/customers', { headers: { Authorization: 'Bearer sk_test_close' } }).catch(() => 'dropped');
      await new Promise((r) => setTimeout(r, 300));          // let deliveries start and fail
      await server.close();
      silent.close();
      silent.closeAllConnections?.();
      await hung;
      await new Promise((r) => setImmediate(r));
      const left = process.getActiveResourcesInfo().filter((r) => !['TTYWrap', 'PipeWrap'].includes(r));
      process.stdout.write(JSON.stringify(left));
    `;
    const result = await runNode(source, { timeoutMs: 8000 });
    // Nothing the snippet or the server writes to stderr may be an error or warning.
    expect(result.stderr).not.toMatch(/Error|Unhandled|Warning/);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    // Only the timer of the final setImmediate check may remain in the list at write time.
    const left = JSON.parse(result.stdout || '[]').filter((r) => r !== 'Immediate');
    expect(left).toEqual([]);
    expect(result.ms).toBeLessThan(6000);
  }, 15000);

  it('closes promptly while an SDK request is held by a timeout fault', async () => {
    const t = await startServer();
    await t.account().faults.add({ method: 'POST', path: '/v1/customers', kind: 'timeout', timeoutMs: 60000 });
    const pending = rejection(t.stripe().customers.create({ email: 'held@b.c' }));
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await t.server.close();
    expect(Date.now() - started).toBeLessThan(1000);
    const err = await pending;
    expect(err.type).toBe('StripeConnectionError');
  });
});

describe('reset()', () => {
  it('clears objects, events, jobs, clocks, idempotency keys, ledger, faults, settings, endpoints and time of one account only', async () => {
    const hooks = await webhookReceiver({ status: 500 });
    const t = await startServer({ webhookRetry: { delaysMs: [60000], timeoutMs: 2000 } });
    const stripe = t.stripe();
    const acct = t.account();
    const otherKey = testKey('keep');
    const other = t.stripe(otherKey);
    const kept = await other.customers.create({ email: 'kept@b.c' });

    await acct.setWebhookEndpoints([{ url: hooks.url, secret: SECRET }]);
    await stripe.webhookEndpoints.create({ url: 'http://127.0.0.1:9/api', enabled_events: ['*'] });
    const c = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'before-reset' });
    const prod = await stripe.products.create({ name: 'Plan' });
    const price = await stripe.prices.create({ product: prod.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } });
    await acct.createSubscription(c.id, { price: price.id, trialDays: 7 });
    await stripe.testHelpers.testClocks.create({ frozen_time: Math.floor(Date.now() / 1000) });
    await acct.advanceTime({ seconds: 5 * 86400 });
    await acct.faults.add({ method: 'DELETE', path: '/v1/customers*', kind: '500', times: 5 });
    await acct.updateBillingSettings({ afterFinalRetry: 'unpaid', retrySchedule: [1] });
    await hooks.waitFor(1);

    const before = await acct.state();
    expect(before.jobs.length).toBeGreaterThan(0);
    expect(Object.keys(before.clocks)).toHaveLength(1);

    const resetResult = await t.request('POST', '/_test/reset', { json: {} });
    expect(resetResult.json).toEqual({ reset: true });

    const after = await acct.state();
    expect(Object.values(after.objects).flat()).toEqual([]);
    expect(after.jobs).toEqual([]);
    expect(after.clocks).toEqual({});
    expect(after.events).toBe(0);
    expect(Math.abs(after.now - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect(await acct.faults.list()).toEqual([]);
    expect(await acct.webhooks.deliveries()).toEqual([]);
    expect((await stripe.webhookEndpoints.list()).data).toEqual([]);
    expect(await acct.billingSettings()).toEqual({ retrySchedule: [2, 2, 2, 2, 2, 2, 2], afterFinalRetry: 'cancel', markUncollectible: false });
    // Ledger: only what happened after the reset (the reset itself is a control, not /v1).
    expect((await acct.requests()).filter((r) => r.path !== '/v1/webhook_endpoints')).toEqual([]);
    // Idempotency keys are forgotten: the same key runs anew.
    const again = await stripe.customers.create({ email: 'a@b.c' }, { idempotencyKey: 'before-reset' });
    expect(again.lastResponse.headers['idempotent-replayed']).toBeUndefined();
    expect((await stripe.customers.list()).data.map((x) => x.id)).toEqual([again.id]);
    // Old objects are gone for the API too, and no event goes to the dropped control endpoint.
    await t.server.settle();
    const count = hooks.deliveries.length;
    await stripe.customers.update(again.id, { name: 'n' });
    await t.server.settle();
    expect(hooks.deliveries.length).toBe(count);
    // The other key is untouched.
    expect((await other.customers.retrieve(kept.id)).email).toBe('kept@b.c');
    expect((await other.customers.list()).data).toHaveLength(1);
  }, 15000);

  it('server.reset() resets every account', async () => {
    const t = await startServer();
    const keyB = testKey('all');
    await t.stripe().customers.create();
    await t.stripe(keyB).customers.create();
    await t.server.reset();
    expect((await t.stripe().customers.list()).data).toEqual([]);
    expect((await t.stripe(keyB).customers.list()).data).toEqual([]);
    expect((await t.stripe(keyB).events.list()).data).toEqual([]);
  });
});

/** A raw POST with a Buffer or string body; resolves { status, json } or { error: code }. */
async function rawPost(t, path, body, headers = {}) {
  try {
    const res = await fetch(`${t.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  } catch (err) {
    return { error: err.cause?.code || err.message };
  }
}

describe('malformed request bodies', () => {
  it('answers bad percent-encoding and invalid UTF-8 without a 5xx, always with JSON', async () => {
    const t = await startServer();
    const bodies = ['name=%E0%A4%A', 'name=%', 'name=%ZZ', Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x3d, 0xff, 0xfe, 0xc3]), '&&&=&=', '%5B%5D=1'];
    for (const body of bodies) {
      const r = await rawPost(t, '/v1/customers', body);
      expect(r.error).toBeUndefined();
      expect(r.status).toBeLessThan(500);
      expect(r.json).not.toBeNull();
      if (r.status !== 200) expect(r.json.error.type).toBe('invalid_request_error');
      else expect(r.json.object).toBe('customer');
      expect(r.headers.get('request-id')).toMatch(/^req_/);
    }
    expect((await t.stripe().customers.list({ limit: 1 })).object).toBe('list');
  });

  it('rejects structurally broken bodies as invalid_request_error with the param', async () => {
    const t = await startServer();
    const conflict = await rawPost(t, '/v1/customers', 'metadata=x&metadata[a]=1');
    expect([conflict.status, conflict.json.error.type, conflict.json.error.param]).toEqual([400, 'invalid_request_error', 'metadata']);
    const asJson = await rawPost(t, '/v1/customers', '{"email":"a@b.c"}', { 'Content-Type': 'application/json' });
    expect([asJson.status, asJson.json.error.type, asJson.json.error.code]).toEqual([400, 'invalid_request_error', 'parameter_unknown']);
    const manyKeys = Array.from({ length: 50000 }, (_, i) => `metadata[k${i}]=v`).join('&');
    const started = Date.now();
    const tooMany = await rawPost(t, '/v1/customers', manyKeys);
    expect(Date.now() - started).toBeLessThan(5000);
    expect([tooMany.status, tooMany.json.error.type]).toEqual([400, 'invalid_request_error']);
    const badControl = await t.request('POST', '/_test/faults', { form: '{not json', headers: { 'Content-Type': 'application/json' } });
    expect([badControl.status, badControl.json.error.type]).toEqual([400, 'invalid_request_error']);
    expect((await t.stripe().customers.list()).data).toEqual([]);
  });

  it('answers a body over the size limit with a Stripe error instead of resetting the connection', async () => {
    // The status for an over-long body is not documented: accept 400 or 413, but it must be the
    // Stripe error envelope, not a dropped connection.
    const t = await startServer();
    const huge = `description=${'x'.repeat(11 * 1024 * 1024)}`;
    const r = await rawPost(t, '/v1/customers', huge);
    expect(r.error).toBeUndefined();
    expect([400, 413]).toContain(r.status);
    expect(r.json.error.type).toBe('invalid_request_error');
    // The server keeps serving afterwards, and nothing was created.
    expect((await t.stripe().customers.list()).data).toEqual([]);
  }, 15000);
});

describe('CLI', () => {
  it('serves the SDK and delivers signed webhooks with --port 0 --webhook-url --webhook-secret, and exits cleanly on SIGTERM', async () => {
    const hooks = await webhookReceiver();
    const child = spawn(process.execPath, [BIN, '--port', '0', '--webhook-url', hooks.url, '--webhook-secret', SECRET], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const url = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`CLI did not start: ${out} ${stderr}`)), 5000);
      child.stdout.on('data', (c) => {
        out += c;
        const m = /listening on (http:\/\/\S+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
    });
    const { port, hostname } = new URL(url);
    expect(Number(port)).toBeGreaterThan(0);
    const stripe = new Stripe(testKey('cli'), { host: hostname, port: Number(port), protocol: 'http', telemetry: false, maxNetworkRetries: 0 });
    const customer = await stripe.customers.create({ email: 'cli@b.c' });
    await hooks.waitFor((ds) => ds.some((d) => d.json?.type === 'customer.created'));
    const delivery = hooks.deliveries.find((d) => d.json?.type === 'customer.created');
    const event = stripe.webhooks.constructEvent(delivery.rawBody, delivery.headers['stripe-signature'], SECRET);
    expect(event.data.object.id).toBe(customer.id);
    expect(() => stripe.webhooks.constructEvent(delivery.rawBody, delivery.headers['stripe-signature'], 'whsec_wrong')).toThrow();

    child.kill('SIGTERM');
    const { code } = await exited;
    expect(code).toBe(0);
    expect(stderr).toBe('');
  }, 15000);

  it('exits with status 2 and the usage on a bad option', async () => {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, '--webhook-url', 'http://127.0.0.1:9/x'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Usage: stripe-test-server/);
  });
});
