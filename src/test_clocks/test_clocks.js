/**
 * Test clocks (docs.stripe.com/api/test_clocks): each clock is a time domain of the account's time
 * engine; customers created with `test_clock` (and their subscriptions, invoices and events) live
 * on its frozen time.
 *
 * Routes: POST /v1/test_helpers/test_clocks, GET /v1/test_helpers/test_clocks,
 * GET /v1/test_helpers/test_clocks/:id, POST /v1/test_helpers/test_clocks/:id/advance,
 * DELETE /v1/test_helpers/test_clocks/:id.
 * Advancing runs every billing transition due up to the target (in time order, request null),
 * answers with status `advancing` (frozen_time still the old value, the target in
 * status_details.advancing), then turns `ready` on the next tick or before the account's next
 * request, whichever comes first. Deleting a clock deletes its customers (which cancels their
 * subscriptions). Events: test_helpers.test_clock.created / .advancing / .ready / .deleted.
 */
import { emitEvent } from '../core/events.js';
import { invalidRequest, resourceMissing } from '../core/errors.js';
import { paginate } from '../core/list.js';
import { addIntervals } from '../core/periods.js';
import { raw } from '../core/render.js';
import { changeCustomer, deleteCustomer } from '../customers/customers.js';
import { cancelSchedule } from '../schedules/schedules.js';
import { DAY, ENDED_STATUSES, intervalOf } from '../billing/util.js';

/** Clocks are deleted automatically after 30 days in Stripe; this server never deletes them. */
const DELETES_AFTER_SECONDS = 30 * DAY;
/** "Three subscriptions, including scheduled subscriptions, per customer" (docs.stripe.com/billing/testing/test-clocks/api-advanced-usage). */
const MAX_SUBSCRIPTIONS_PER_CUSTOMER = 3;
const APPROX_DAYS = { day: 1, week: 7, month: 30.44, year: 365.25 };

function customersOf(account, clockId) {
  return account.store.list('customer', (c) => c.test_clock === clockId && !c._deleted);
}

/**
 * How far a clock may advance: two intervals of the shortest recurring price among its customers'
 * subscriptions and schedules, else two years (docs.stripe.com/api/test_clocks/advance).
 */
export function advanceLimit(account, clock) {
  const customers = new Set(customersOf(account, clock.id).map((c) => c.id));
  const intervals = [];
  const add = (priceId) => {
    const price = account.store.get('price', priceId);
    if (price?.recurring) intervals.push(intervalOf(price));
  };
  for (const sub of account.store.list('subscription', (s) => customers.has(s.customer) && !ENDED_STATUSES.has(s.status))) {
    for (const item of sub.items.data) add(item.price);
  }
  for (const sched of account.store.list('subscription_schedule', (s) => customers.has(s.customer) && ['not_started', 'active'].includes(s.status))) {
    for (const phase of sched.phases) for (const item of phase.items) add(item.price);
  }
  if (!intervals.length) return addIntervals(clock.frozen_time, 'year', 1, 2);
  const shortest = intervals.reduce((a, b) => (APPROX_DAYS[b.interval] * b.count < APPROX_DAYS[a.interval] * a.count ? b : a));
  return addIntervals(clock.frozen_time, shortest.interval, shortest.count, 2);
}

/** Finishes an advance: frozen_time = target, status ready (test_helpers.test_clock.ready). */
function markReady(account, clockId) {
  const clock = account.store.get('test_helpers.test_clock', clockId);
  if (!clock || clock.status !== 'advancing') return;
  clock.frozen_time = clock.status_details.advancing.target_frozen_time;
  clock.status = 'ready';
  clock.status_details = {};
  emitEvent(account, 'test_helpers.test_clock.ready', clock, { request: null });
}

/** POST /v1/test_helpers/test_clocks (optionally attaching an existing customer). */
export function createClock(account, { frozenTime, name = null, customer = null }, { request } = {}) {
  const now = account.time.now(null);
  let target = null;
  if (customer) {
    target = account.store.get('customer', customer);
    if (!target || target._deleted) throw resourceMissing('customer', customer, { param: 'customer' });
    if (target.test_clock) throw invalidRequest(`The customer ${customer} is already attached to a test clock.`, { param: 'customer' });
    if (frozenTime < now) throw invalidRequest("The initial frozen_time can't be in the past when attaching an existing customer.", { param: 'frozen_time' });
    // "The customer must not already exceed the allowed number of subscriptions, scheduled
    // subscriptions, and quotes": three per customer, scheduled ones included (docs.stripe.com/billing/testing/test-clocks/api-advanced-usage).
    const live = account.store.list('subscription', (s) => s.customer === customer && !ENDED_STATUSES.has(s.status)).length;
    const scheduled = account.store.list('subscription_schedule', (s) => s.customer === customer && s.status === 'not_started').length;
    if (live + scheduled > MAX_SUBSCRIPTIONS_PER_CUSTOMER) {
      throw invalidRequest(
        `The customer ${customer} has more than ${MAX_SUBSCRIPTIONS_PER_CUSTOMER} subscriptions, including scheduled subscriptions, and can't be attached to a test clock.`,
        { param: 'customer' },
      );
    }
  }
  const clock = {
    id: account.mintId('clock'),
    object: 'test_helpers.test_clock',
    created: now,
    deletes_after: now + DELETES_AFTER_SECONDS,
    frozen_time: frozenTime,
    livemode: false,
    name,
    status: 'ready',
    status_details: {},
  };
  account.store.insert(clock);
  account.time.registerClock(clock.id, frozenTime);
  emitEvent(account, 'test_helpers.test_clock.created', clock, { request });
  if (target) {
    changeCustomer(account, target, (c) => { c.test_clock = clock.id; }, { request });
    moveToClock(account, target.id, clock.id);
  }
  return clock;
}

/**
 * An attached customer's subscriptions, schedules and invoices move onto the clock: their
 * `test_clock` names it and their pending transitions run on its frozen time from now on.
 */
function moveToClock(account, customerId, clockId) {
  for (const type of ['subscription', 'subscription_schedule', 'invoice']) {
    for (const obj of account.store.list(type, (o) => o.customer === customerId)) {
      if ('test_clock' in obj) obj.test_clock = clockId;
    }
  }
  const owned = (value) => typeof value === 'string' && account.store.find(value)?.customer === customerId;
  for (const job of account.time.list({ domain: null })) {
    if (!Object.values(job.data).some(owned)) continue;
    account.time.cancelWhere((j) => j.id === job.id);
    const { kind, at, key, data, priority } = job;
    account.time.schedule({ kind, at, domain: clockId, key, data, priority });
  }
}

/**
 * POST /v1/test_helpers/test_clocks/:id/advance: runs everything due up to `frozenTime` now and
 * answers `advancing`; the clock turns ready right after.
 */
export function advanceClock(account, clock, frozenTime, { request } = {}) {
  if (clock.status !== 'ready') {
    throw invalidRequest(`The test clock ${clock.id} is ${clock.status}; wait until it is ready before advancing it again.`, { param: 'frozen_time' });
  }
  if (frozenTime <= clock.frozen_time) {
    throw invalidRequest(`frozen_time must be after the test clock's current frozen time (${clock.frozen_time}).`, { param: 'frozen_time' });
  }
  const limit = advanceLimit(account, clock);
  if (frozenTime > limit) {
    throw invalidRequest(
      `Cannot advance more than two intervals of the shortest subscription on this test clock (two years without subscriptions): frozen_time can be at most ${limit}.`,
      { param: 'frozen_time' },
    );
  }
  clock.status = 'advancing';
  clock.status_details = { advancing: { target_frozen_time: frozenTime } };
  emitEvent(account, 'test_helpers.test_clock.advancing', clock, { request });
  account.time.advance(clock.id, frozenTime);
  const { server } = account;
  const timer = setTimeout(() => {
    server.timers.delete(timer);
    account.run(() => markReady(account, clock.id)).catch(() => {});
  }, 0);
  server.timers.add(timer);
  return clock;
}

/**
 * DELETE /v1/test_helpers/test_clocks/:id: deletes the clock's customers (their subscriptions are
 * canceled first), then the clock.
 */
export function deleteClock(account, clock, { request } = {}) {
  for (const customer of customersOf(account, clock.id)) {
    for (const sched of account.store.list('subscription_schedule', (s) => s.customer === customer.id && s.status === 'not_started')) {
      cancelSchedule(account, sched, { invoiceNow: false, prorate: false, request });
    }
    deleteCustomer(account, customer, { request });
  }
  // Announced on the clock's own time, like everything that happened on it.
  emitEvent(account, 'test_helpers.test_clock.deleted', clock, { request });
  account.time.removeClock(clock.id);
  account.store.remove('test_helpers.test_clock', clock.id);
  return { id: clock.id, object: 'test_helpers.test_clock', deleted: true };
}

export function renderClock(c) {
  return {
    id: c.id,
    object: 'test_helpers.test_clock',
    created: c.created,
    deletes_after: c.deletes_after,
    frozen_time: c.frozen_time,
    livemode: false,
    name: c.name,
    status: c.status,
    status_details: structuredClone(c.status_details),
  };
}

/** Routes, serializer and the ready flip before requests. */
export function install(app) {
  app.object('test_helpers.test_clock', { render: renderClock });

  // An advanced clock is ready before the account's next request is handled.
  app.hook('account.beforeRequest', (account) => {
    for (const clock of account.store.list('test_helpers.test_clock', (c) => c.status === 'advancing')) markReady(account, clock.id);
  });

  app.route('POST', '/v1/test_helpers/test_clocks', (ctx) =>
    createClock(ctx.account, { frozenTime: ctx.params.frozen_time, name: ctx.params.name ?? null, customer: ctx.params.customer ?? null }),
  );

  app.route('GET', '/v1/test_helpers/test_clocks', (ctx) => {
    const { account, params } = ctx;
    return paginate(account.store.list('test_helpers.test_clock'), params, {
      url: '/v1/test_helpers/test_clocks',
      noun: 'test_helpers.test_clock',
      find: (id) => account.store.get('test_helpers.test_clock', id),
    });
  });

  app.route('GET', '/v1/test_helpers/test_clocks/:id', (ctx) => ctx.account.store.require('test_helpers.test_clock', ctx.pathParams.id));

  app.route('POST', '/v1/test_helpers/test_clocks/:id/advance', (ctx) =>
    advanceClock(ctx.account, ctx.account.store.require('test_helpers.test_clock', ctx.pathParams.id), ctx.params.frozen_time),
  );

  app.route('DELETE', '/v1/test_helpers/test_clocks/:id', (ctx) =>
    raw(deleteClock(ctx.account, ctx.account.store.require('test_helpers.test_clock', ctx.pathParams.id))),
  );
}
