/**
 * Webhook delivery (docs.stripe.com/webhooks).
 *
 * - On 'event.emitted' every enabled endpoint subscribed to the event type (server-wide endpoints
 *   from the options plus the account's own) gets an automatic delivery, and
 *   event.pendingWebhooks counts the automatic deliveries that have not succeeded yet.
 * - Each (account, endpoint) pair has a FIFO queue sent one request at a time, so an endpoint gets
 *   first attempts in the order the events were created. A failed automatic delivery rejoins the
 *   back of its queue after webhookRetry.delaysMs[n]; nothing is ordered across endpoints.
 * - Requests are sent outside the account lock (a receiver may call the API back before it
 *   answers); preparing an attempt and recording its result run inside account.run().
 * - Every attempt renders the event in the endpoint's API version (else the account default at
 *   emission), pretty-printed like Stripe's payloads, and signs it with the current real time:
 *   Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body" keyed with the secret>.
 * - 2xx is a success; other statuses (redirects included), timeouts and connection errors fail.
 *   Manual deliveries (resend, duplicates, bad signatures) are single attempts that never change
 *   pending_webhooks: a manual resend does not settle Stripe's automatic delivery either.
 */
import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { renderEvent } from '../core/events.js';
import { invalidRequest, resourceMissing } from '../core/errors.js';
import { endpointsFor, findEndpoint, receivesEvent, replaceControlEndpoints } from './endpoints.js';

/** Sent with every delivery (the value Stripe's webhook requests carry). */
export const USER_AGENT = 'Stripe/1.0 (+https://stripe.com/docs/webhooks)';

/** Delivery statuses. queued/held/in_flight/retrying are open; the others are final. */
export const DELIVERY_STATUSES = ['queued', 'held', 'in_flight', 'retrying', 'succeeded', 'failed', 'canceled'];

/** Delivery kinds: 'automatic' deliveries retry and count in pending_webhooks. */
export const DELIVERY_KINDS = ['automatic', 'resend', 'duplicate', 'bad_signature'];

const MAX_LOGGED_DELIVERIES = 10000;
const MAX_RESPONSE_BODY = 2000;
const FILTERS = ['eventId', 'eventType', 'endpointId', 'status', 'kind', 'limit'];

const isoNow = () => new Date().toISOString();

/** The Stripe-Signature header value for `payload` (string) signed at `timestamp` (unix seconds). */
export function signatureHeader(payload, secret, timestamp) {
  const t = Math.floor(timestamp);
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

// State ----------------------------------------------------------------------------------------

/**
 * Per-account delivery state: the delivery log (oldest first), one queue per endpoint, the hold
 * flag, timers and requests in flight (so reset and close can stop them), and settle() waiters.
 */
function stateOf(account) {
  return account.moduleState('webhooks', () => ({
    deliveries: [],
    queues: new Map(),
    held: false,
    closed: false,
    timers: new Set(),
    inflight: new Set(),
    waiters: [],
  }));
}

function queueOf(st, endpointId) {
  let q = st.queues.get(endpointId);
  if (!q) {
    q = { endpointId, items: [], running: false };
    st.queues.set(endpointId, q);
  }
  return q;
}

const isBusy = (d) => d.status === 'queued' || d.status === 'in_flight' || d.status === 'retrying';

function isIdle(st) {
  return st.closed || !st.deliveries.some(isBusy);
}

/** Resolves settle() waiters once nothing is queued, in flight or waiting to retry. */
function notify(st) {
  if (st.waiters.length && isIdle(st)) for (const resolve of st.waiters.splice(0)) resolve();
}

/** Stops everything of a state: timers, requests in flight, waiters (reset and close). */
function closeState(st) {
  st.closed = true;
  for (const timer of st.timers) clearTimeout(timer);
  st.timers.clear();
  for (const req of st.inflight) req.destroy();
  st.inflight.clear();
  for (const resolve of st.waiters.splice(0)) resolve();
}

/** Drops the oldest finished deliveries beyond the log limit. */
function trimLog(st) {
  while (st.deliveries.length > MAX_LOGGED_DELIVERIES) {
    const index = st.deliveries.findIndex((d) => !isBusy(d) && d.status !== 'held');
    if (index < 0) return;
    st.deliveries.splice(index, 1);
  }
}

// Deliveries -----------------------------------------------------------------------------------

function createDelivery(account, st, event, endpoint, kind) {
  const delivery = {
    id: account.mintId('delivery', 16),
    eventId: event.id,
    eventType: event.type,
    endpointId: endpoint.id,
    url: endpoint.url,
    apiVersion: endpoint.apiVersion || event.apiVersion,
    kind,
    status: st.held ? 'held' : 'queued',
    attempts: 0,
    responseStatus: null,
    error: null,
    createdAt: isoNow(),
    nextAttemptAt: null,
    completedAt: null,
    history: [],
    _event: event,
    _timer: null,
  };
  st.deliveries.push(delivery);
  queueOf(st, endpoint.id).items.push(delivery);
  trimLog(st);
  return delivery;
}

/** A plain copy of a delivery record for control results. */
function publicDelivery(d) {
  return {
    id: d.id,
    eventId: d.eventId,
    eventType: d.eventType,
    endpointId: d.endpointId,
    url: d.url,
    apiVersion: d.apiVersion,
    kind: d.kind,
    status: d.status,
    attempts: d.attempts,
    responseStatus: d.responseStatus,
    error: d.error,
    createdAt: d.createdAt,
    nextAttemptAt: d.nextAttemptAt,
    completedAt: d.completedAt,
    history: d.history.map((entry) => ({ ...entry })),
  };
}

/** Moves a delivery to a final status; a succeeded or dropped automatic one leaves pending_webhooks. */
function finish(st, d, status, reason) {
  if (d._timer) {
    clearTimeout(d._timer);
    st.timers.delete(d._timer);
    d._timer = null;
  }
  if (d.kind === 'automatic' && (status === 'succeeded' || status === 'canceled')) {
    d._event.pendingWebhooks = Math.max(0, d._event.pendingWebhooks - 1);
  }
  d.status = status;
  if (reason) d.error = reason;
  d.nextAttemptAt = null;
  d.completedAt = isoNow();
  notify(st);
}

/**
 * Cancels the open deliveries (queued, held, waiting to retry) to endpoints that were removed.
 * Requests already in flight finish, but are not retried.
 */
export function dropEndpointDeliveries(account, endpointIds, reason) {
  const st = account.state.webhooks;
  if (!st || !endpointIds.length) return;
  const ids = new Set(endpointIds);
  for (const d of st.deliveries) {
    if (ids.has(d.endpointId) && (d.status === 'queued' || d.status === 'held' || d.status === 'retrying')) {
      finish(st, d, 'canceled', reason);
    }
  }
  for (const id of ids) {
    const q = st.queues.get(id);
    if (q) q.items = [];
  }
  notify(st);
}

/** Queues the automatic deliveries of a new event (the 'event.emitted' hook). */
function queueEvent(account, event) {
  const endpoints = endpointsFor(account).filter((e) => receivesEvent(e, event.type));
  event.pendingWebhooks = endpoints.length;
  if (!endpoints.length) return;
  const st = stateOf(account);
  for (const endpoint of endpoints) createDelivery(account, st, event, endpoint, 'automatic');
  for (const endpoint of endpoints) pump(account, st, endpoint.id);
}

// Sending --------------------------------------------------------------------------------------

/** Starts the sender of an endpoint's queue unless it is running, held or closed. */
function pump(account, st, endpointId) {
  const q = queueOf(st, endpointId);
  if (q.running || st.closed || st.held || !q.items.length) return;
  q.running = true;
  setImmediate(() => runQueue(account, st, q));
}

async function runQueue(account, st, q) {
  let attempt = null;
  try {
    for (;;) {
      attempt = await account.run(() => {
        const next = st.closed ? null : startAttempt(account, st, q);
        if (!next) q.running = false;
        return next;
      });
      if (!attempt) return;
      const result = await post(st, attempt, account.server.options.webhookRetry.timeoutMs);
      await account.run(() => finishAttempt(account, st, attempt, result));
      attempt = null;
    }
  } catch (err) {
    q.running = false;
    account.server.log('error', `webhook delivery: ${err && err.stack ? err.stack : err}`);
    if (attempt && attempt.delivery.status === 'in_flight') finish(st, attempt.delivery, 'failed', `Internal error: ${err && err.message}`);
    pump(account, st, q.endpointId);
  }
}

/** Takes the next queued delivery, renders and signs it; null when there is nothing to send. */
function startAttempt(account, st, q) {
  while (!st.held && q.items.length) {
    const d = q.items.shift();
    if (d.status !== 'queued') continue;
    const endpoint = findEndpoint(account, d.endpointId);
    if (!endpoint || endpoint.status !== 'enabled') {
      finish(st, d, 'canceled', endpoint ? 'Endpoint disabled' : 'Endpoint removed');
      continue;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    // A bad signature is a well-formed v1 made with another secret: what a wrong secret looks like.
    const secret = d.kind === 'bad_signature' ? `${endpoint.secret}_not_the_endpoint_secret` : endpoint.secret;
    let payload;
    let signature;
    try {
      payload = JSON.stringify(renderEvent(account, d._event, d.apiVersion), null, 2);
      signature = signatureHeader(payload, secret, timestamp);
    } catch (err) {
      account.server.log('error', `webhook ${d.eventId}: ${err && err.stack ? err.stack : err}`);
      finish(st, d, 'failed', `Could not render the event: ${err && err.message}`);
      continue;
    }
    const entry = {
      attempt: d.attempts + 1,
      url: endpoint.url,
      signatureTimestamp: timestamp,
      startedAt: isoNow(),
      finishedAt: null,
      durationMs: null,
      responseStatus: null,
      error: null,
      responseBody: null,
    };
    d.status = 'in_flight';
    d.attempts += 1;
    d.url = endpoint.url;
    d.history.push(entry);
    return {
      delivery: d,
      entry,
      url: endpoint.url,
      payload,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': USER_AGENT,
        'Stripe-Signature': signature,
      },
      started: Date.now(),
    };
  }
  return null;
}

/** One POST; resolves { status, body } or { error } (never rejects). */
function post(st, { url, payload, headers }, timeoutMs) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      st.inflight.delete(req);
      resolve(result);
    };
    const timer = setTimeout(() => {
      done({ error: `Timed out after ${timeoutMs} ms` });
      req?.destroy();
    }, timeoutMs);
    try {
      const target = new URL(url);
      const transport = target.protocol === 'https:' ? https : http;
      req = transport.request(
        target,
        { method: 'POST', agent: false, headers: { ...headers, 'Content-Length': Buffer.byteLength(payload), Connection: 'close' } },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            if (size < MAX_RESPONSE_BODY) chunks.push(chunk);
            size += chunk.length;
          });
          res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BODY) }));
          res.on('error', (err) => done({ status: res.statusCode, error: `Response interrupted: ${err.message}` }));
          res.on('close', () => done({ status: res.statusCode, error: 'Response interrupted: connection closed' }));
        },
      );
      req.on('error', (err) => done({ error: `Unable to connect: ${err.message}` }));
      st.inflight.add(req);
      req.end(payload);
    } catch (err) {
      done({ error: `Unable to send: ${err.message}` });
    }
  });
}

/** Records an attempt's outcome: success, a retry (automatic deliveries only) or failure. */
function finishAttempt(account, st, attempt, result) {
  if (st.closed) return;
  const { delivery: d, entry } = attempt;
  entry.finishedAt = isoNow();
  entry.durationMs = Date.now() - attempt.started;
  entry.responseStatus = result.status ?? null;
  entry.error = result.error ?? null;
  entry.responseBody = result.body ?? null;
  d.responseStatus = entry.responseStatus;
  d.error = entry.error;
  const ok = !result.error && result.status >= 200 && result.status < 300;
  const delays = account.server.options.webhookRetry.delaysMs;
  if (ok) finish(st, d, 'succeeded');
  else if (d.kind !== 'automatic' || d.attempts > delays.length) finish(st, d, 'failed');
  else if (!findEndpoint(account, d.endpointId)) finish(st, d, 'canceled', 'Endpoint removed');
  else scheduleRetry(account, st, d, delays[d.attempts - 1]);
  account.server.log('info', `webhook ${d.eventType} ${d.eventId} -> ${entry.url}: ${result.error ?? result.status} (attempt ${entry.attempt}, ${d.status})`);
}

/** Waits `delayMs`, then puts the delivery at the back of its endpoint's queue. */
function scheduleRetry(account, st, d, delayMs) {
  d.status = 'retrying';
  d.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  const timer = setTimeout(() => {
    st.timers.delete(timer);
    d._timer = null;
    account
      .run(() => {
        if (st.closed || d.status !== 'retrying') return;
        d.nextAttemptAt = null;
        d.status = st.held ? 'held' : 'queued';
        queueOf(st, d.endpointId).items.push(d);
        pump(account, st, d.endpointId);
        notify(st);
      })
      .catch((err) => account.server.log('error', `webhook retry: ${err && err.stack ? err.stack : err}`));
  }, delayMs);
  st.timers.add(timer);
  d._timer = timer;
}

// Controls -------------------------------------------------------------------------------------

/**
 * The setWebhookEndpoints control: replaces the endpoints added through controls for this
 * account (those created with POST /v1/webhook_endpoints stay). Each input is
 * { url, secret, apiVersion? }; returns the endpoint records.
 */
export function setWebhookEndpoints(account, endpoints) {
  return replaceControlEndpoints(account, endpoints);
}

/** Delivery records of this account, oldest first. */
export function listDeliveries(account, filter = {}) {
  const unknown = Object.keys(filter).find((key) => !FILTERS.includes(key));
  if (unknown) throw invalidRequest(`Unknown filter: ${unknown} (use ${FILTERS.join(', ')}).`, { param: unknown });
  if (filter.status !== undefined && !DELIVERY_STATUSES.includes(filter.status)) {
    throw invalidRequest(`status must be one of ${DELIVERY_STATUSES.join(', ')}.`, { param: 'status' });
  }
  if (filter.kind !== undefined && !DELIVERY_KINDS.includes(filter.kind)) {
    throw invalidRequest(`kind must be one of ${DELIVERY_KINDS.join(', ')}.`, { param: 'kind' });
  }
  let out = stateOf(account).deliveries;
  for (const key of ['eventId', 'eventType', 'endpointId', 'status', 'kind']) {
    if (filter[key] !== undefined) out = out.filter((d) => d[key] === filter[key]);
  }
  if (filter.limit !== undefined) {
    const limit = Number(filter.limit);
    if (!Number.isInteger(limit) || limit < 1) throw invalidRequest('limit must be a positive integer.', { param: 'limit' });
    out = out.slice(-limit);
  }
  return out.map(publicDelivery);
}

/** Queues `copies` manual deliveries of an event to every endpoint subscribed to its type. */
function manualDelivery(account, eventId, kind, copies) {
  const event = account.events.get(eventId);
  if (!event) throw resourceMissing('event', eventId, { param: 'eventId' });
  const endpoints = endpointsFor(account).filter((e) => receivesEvent(e, event.type));
  if (!endpoints.length) throw invalidRequest(`No enabled webhook endpoint receives ${event.type} events.`, { param: 'eventId' });
  const st = stateOf(account);
  const created = [];
  for (const endpoint of endpoints) {
    for (let i = 0; i < copies; i++) created.push(createDelivery(account, st, event, endpoint, kind));
  }
  for (const endpoint of endpoints) pump(account, st, endpoint.id);
  return { eventId, deliveries: created.map(publicDelivery) };
}

/** Queues a new delivery of an existing event to every subscribed endpoint (a manual resend). */
export function resendEvent(account, eventId) {
  return manualDelivery(account, eventId, 'resend', 1);
}

/** Queues the same event twice more to every subscribed endpoint (duplicates by design). */
export function deliverDuplicate(account, eventId) {
  return manualDelivery(account, eventId, 'duplicate', 2);
}

/** Holds new and queued deliveries until releaseDeliveries(). */
export function holdDeliveries(account) {
  const st = stateOf(account);
  st.held = true;
  for (const d of st.deliveries) if (d.status === 'queued') d.status = 'held';
  notify(st);
  return { held: true, deliveries: st.deliveries.filter((d) => d.status === 'held').length };
}

function releaseOrder(held, order) {
  if (order === 'fifo') return held;
  if (order === 'reverse') return [...held].reverse();
  if (!Array.isArray(order) || !order.every((id) => typeof id === 'string')) {
    throw invalidRequest("order must be 'fifo', 'reverse' or an array of event IDs.", { param: 'order' });
  }
  const listed = [];
  for (const eventId of new Set(order)) {
    const matching = held.filter((d) => d.eventId === eventId);
    if (!matching.length) throw invalidRequest(`No held delivery of event ${eventId}.`, { param: 'order' });
    listed.push(...matching);
  }
  return [...listed, ...held.filter((d) => !listed.includes(d))];
}

/** Sends held deliveries in `order`: 'fifo' | 'reverse' | [eventIds] (listed events first, in that order). */
export function releaseDeliveries(account, { order = 'fifo' } = {}) {
  const st = stateOf(account);
  const ordered = releaseOrder(
    st.deliveries.filter((d) => d.status === 'held'),
    order,
  );
  st.held = false;
  for (const q of st.queues.values()) q.items = q.items.filter((d) => d.status !== 'held');
  for (const d of ordered) {
    d.status = 'queued';
    queueOf(st, d.endpointId).items.push(d);
  }
  for (const endpointId of st.queues.keys()) pump(account, st, endpointId);
  return { released: ordered.length, deliveries: ordered.map(publicDelivery) };
}

/** Queues a delivery of the event whose Stripe-Signature does not verify. */
export function sendWithBadSignature(account, eventId) {
  return manualDelivery(account, eventId, 'bad_signature', 1);
}

/** Resolves when no delivery of this account is queued, in flight or waiting to retry (held ones excepted). */
export async function settleAccount(account) {
  await account.run(() => {});
  const st = account.state.webhooks;
  if (!st || isIdle(st)) return;
  await new Promise((resolve) => st.waiters.push(resolve));
}

/** settleAccount for every account of the server. */
export async function settleServer(server) {
  for (;;) {
    const accounts = [...server.accounts.values()];
    await Promise.all(accounts.map((account) => settleAccount(account)));
    const busy = [...server.accounts.values()].some((account) => account.state.webhooks && !isIdle(account.state.webhooks));
    if (!busy && server.accounts.size === accounts.length) return;
  }
}

export function install(app) {
  app.hook('event.emitted', queueEvent);
  app.hook('account.reset', (account) => {
    if (account.state.webhooks) closeState(account.state.webhooks);
  });
  app.hook('server.close', (server) => {
    for (const account of server.accounts.values()) if (account.state.webhooks) closeState(account.state.webhooks);
  });
}
