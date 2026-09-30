/**
 * Test clocks through the real stripe SDK: advancing (advancing → ready, due work on the clock's
 * time, limits), hiding clock objects from unfiltered lists, and deleting a clock with its customers.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';
import { addIntervals } from '../src/core/periods.js';

const DAY = 86400;
const HOUR = 3600;
const T0 = Math.floor(Date.UTC(2031, 5, 1) / 1000);

async function allEvents(stripe) {
  const out = [];
  for await (const e of stripe.events.list({ limit: 100 })) out.push(e);
  return out.reverse();
}

async function clockWithSubscription(t, { trialDays } = {}) {
  const stripe = t.stripe();
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: T0, name: 'Weekly' });
  const product = await stripe.products.create({ name: 'Pro' });
  const weekly = await stripe.prices.create({ product: product.id, unit_amount: 500, currency: 'usd', recurring: { interval: 'week' } });
  const customer = await stripe.customers.create({ email: 'jenny.rosen@example.com', test_clock: clock.id });
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: weekly.id }], ...(trialDays ? { trial_period_days: trialDays } : {}) });
  return { stripe, clock, customer, sub };
}

describe('test clocks', () => {
  it('advances: answers advancing, runs due work on the clock time, then turns ready', async () => {
    const t = await startServer();
    const { stripe, clock, sub } = await clockWithSubscription(t, { trialDays: 7 });
    expect(clock).toMatchObject({ object: 'test_helpers.test_clock', status: 'ready', frozen_time: T0, name: 'Weekly', status_details: {} });
    expect(sub).toMatchObject({ status: 'trialing', created: T0, trial_end: T0 + 7 * DAY, test_clock: clock.id });

    const before = (await allEvents(stripe)).length;
    const advancing = await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: T0 + 7 * DAY + HOUR });
    expect(advancing).toMatchObject({ status: 'advancing', frozen_time: T0, status_details: { advancing: { target_frozen_time: T0 + 7 * DAY + HOUR } } });
    const ready = await stripe.testHelpers.testClocks.retrieve(clock.id);
    expect(ready).toMatchObject({ status: 'ready', frozen_time: T0 + 7 * DAY + HOUR, status_details: {} });

    const events = (await allEvents(stripe)).slice(before);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('test_helpers.test_clock.advancing');
    expect(types.at(-1)).toBe('test_helpers.test_clock.ready');
    const willEnd = events.find((e) => e.type === 'customer.subscription.trial_will_end');
    expect(willEnd.created).toBe(T0 + 4 * DAY);
    expect(willEnd.request).toEqual({ id: null, idempotency_key: null });
    const paid = events.filter((e) => e.type === 'invoice.paid').at(-1);
    expect(paid.created).toBe(T0 + 7 * DAY + HOUR);
    expect(paid.data.object.billing_reason).toBe('subscription_cycle');
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe('active');
  });

  it('rejects advancing backwards or beyond two intervals of the shortest subscription', async () => {
    const t = await startServer();
    const { stripe, clock } = await clockWithSubscription(t);
    const back = await rejection(stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: T0 }));
    expect([back.statusCode, back.param]).toEqual([400, 'frozen_time']);
    const far = await rejection(stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: T0 + 14 * DAY + 1 }));
    expect([far.statusCode, far.param]).toEqual([400, 'frozen_time']);
    expect((await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: T0 + 14 * DAY })).status).toBe('advancing');
    const empty = await stripe.testHelpers.testClocks.create({ frozen_time: T0 });
    const twoYears = addIntervals(T0, 'year', 1, 2);
    expect((await rejection(stripe.testHelpers.testClocks.advance(empty.id, { frozen_time: twoYears + 1 }))).param).toBe('frozen_time');
    expect((await stripe.testHelpers.testClocks.advance(empty.id, { frozen_time: twoYears })).status).toBe('advancing');
  });

  it('hides clock objects from unfiltered lists', async () => {
    const t = await startServer();
    const { stripe, clock, customer, sub } = await clockWithSubscription(t);
    expect((await stripe.subscriptions.list()).data).toEqual([]);
    expect((await stripe.invoices.list()).data).toEqual([]);
    expect((await stripe.subscriptions.list({ test_clock: clock.id })).data.map((s) => s.id)).toEqual([sub.id]);
    expect((await stripe.invoices.list({ customer: customer.id })).data).toHaveLength(1);
    expect((await stripe.testHelpers.testClocks.list()).data.map((c) => c.id)).toEqual([clock.id]);
  });

  it('deletes a clock with its customers, canceling their subscriptions first', async () => {
    const t = await startServer();
    const { stripe, clock, customer, sub } = await clockWithSubscription(t);
    const before = (await allEvents(stripe)).length;
    const deleted = await stripe.testHelpers.testClocks.del(clock.id);
    expect(deleted).toEqual({ id: clock.id, object: 'test_helpers.test_clock', deleted: true });
    expect(await stripe.customers.retrieve(customer.id)).toEqual({ id: customer.id, object: 'customer', deleted: true });
    expect(await stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'canceled', cancellation_details: { reason: 'cancellation_requested' } });
    const types = (await allEvents(stripe)).slice(before).map((e) => e.type);
    expect(types.indexOf('customer.subscription.deleted')).toBeLessThan(types.indexOf('customer.deleted'));
    expect(types.indexOf('customer.deleted')).toBeLessThan(types.indexOf('test_helpers.test_clock.deleted'));
    const gone = await rejection(stripe.testHelpers.testClocks.retrieve(clock.id));
    expect([gone.statusCode, gone.code]).toEqual([404, 'resource_missing']);
  });
});
