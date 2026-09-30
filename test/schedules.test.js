/**
 * Subscription schedules through the real stripe SDK: phases driving a subscription, start of a
 * not_started schedule, completion with end_behavior cancel, cancel and release, direct updates
 * of a scheduled subscription, dunning aborts and the 2024-06-20 shape.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';
import { addIntervals } from '../src/core/periods.js';

const DAY = 86400;
const HOUR = 3600;

async function setup(t, { card = 'pm_card_visa' } = {}) {
  const stripe = t.stripe();
  const product = await stripe.products.create({ name: 'Pro' });
  const basic = await stripe.prices.create({ product: product.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
  const plus = await stripe.prices.create({ product: product.id, unit_amount: 2500, currency: 'usd', recurring: { interval: 'month' } });
  const customer = await stripe.customers.create({ email: 'jenny.rosen@example.com' });
  const pm = card ? await stripe.paymentMethods.attach(card, { customer: customer.id }) : null;
  return { stripe, account: t.account(), basic, plus, customer, pm };
}

async function allEvents(stripe) {
  const out = [];
  for await (const e of stripe.events.list({ limit: 100 })) out.push(e);
  return out.reverse();
}

function expectOrder(list, types) {
  let at = -1;
  for (const type of types) {
    const next = list.indexOf(type, at + 1);
    expect(next, `${type} after index ${at} in ${list.join(', ')}`).toBeGreaterThan(at);
    at = next;
  }
}

describe('subscription schedules', () => {
  it('drives a subscription through its phases and cancels it at the end with end_behavior=cancel', async () => {
    const t = await startServer();
    const { stripe, account, basic, plus, customer, pm } = await setup(t);
    const schedule = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: 'now',
      end_behavior: 'cancel',
      default_settings: { default_payment_method: pm.id },
      phases: [
        { items: [{ price: basic.id }], duration: { interval: 'month', interval_count: 1 } },
        { items: [{ price: plus.id, quantity: 2 }], duration: { interval: 'month', interval_count: 2 } },
      ],
    });
    const [first, second] = schedule.phases;
    expect(schedule).toMatchObject({ object: 'subscription_schedule', status: 'active', end_behavior: 'cancel', customer: customer.id });
    expect(schedule.id).toMatch(/^sub_sched_/);
    expect(schedule.current_phase).toEqual({ start_date: first.start_date, end_date: first.end_date });
    expect(first.end_date).toBe(addIntervals(first.start_date, 'month', 1, 1));
    expect([second.start_date, second.end_date]).toEqual([first.end_date, addIntervals(first.end_date, 'month', 2, 1)]);
    expect(first.items[0]).toMatchObject({ price: basic.id, plan: basic.id, quantity: 1 });

    const sub = await stripe.subscriptions.retrieve(schedule.subscription, { expand: ['latest_invoice'] });
    expect(sub).toMatchObject({ status: 'active', schedule: schedule.id, default_payment_method: pm.id, cancel_at: null });
    expect(sub.latest_invoice).toMatchObject({ status: 'draft', billing_reason: 'subscription_create', automatically_finalizes_at: sub.created + HOUR });

    let before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: first.end_date + HOUR });
    const second_ = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(second_.items.data.map((i) => [i.price.id, i.quantity])).toEqual([[plus.id, 2]]);
    expect(second_.cancel_at).toBe(second.end_date);
    expect(second_.latest_invoice).toMatchObject({ billing_reason: 'subscription_cycle', total: 5000, status: 'paid' });
    const atPhase = (await allEvents(stripe)).slice(before);
    expectOrder(atPhase.map((e) => e.type), ['subscription_schedule.updated', 'customer.subscription.updated', 'invoice.created']);
    expect(atPhase.find((e) => e.type === 'subscription_schedule.updated').data.previous_attributes.current_phase).toEqual({
      end_date: first.end_date,
      start_date: first.start_date,
    });

    before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: second.end_date });
    const done = await stripe.subscriptionSchedules.retrieve(schedule.id);
    expect(done).toMatchObject({ status: 'completed', completed_at: second.end_date, current_phase: null });
    expect(await stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'canceled', ended_at: second.end_date });
    expectOrder((await allEvents(stripe)).slice(before).map((e) => e.type), [
      'subscription_schedule.expiring',
      'customer.subscription.deleted',
      'subscription_schedule.completed',
    ]);
  });

  it('starts a not_started schedule at its start_date', async () => {
    const t = await startServer();
    const { stripe, account, basic, customer, pm } = await setup(t);
    const startAt = (await account.now()).now + 5 * DAY;
    const schedule = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: startAt,
      default_settings: { default_payment_method: pm.id },
      phases: [{ items: [{ price: basic.id }] }],
    });
    expect(schedule).toMatchObject({ status: 'not_started', subscription: null, current_phase: null });
    expect(schedule.phases[0].end_date).toBe(addIntervals(startAt, 'month', 1, 1));
    expect((await stripe.subscriptionSchedules.list({ scheduled: true })).data.map((s) => s.id)).toEqual([schedule.id]);
    await account.advanceTime({ to: startAt + HOUR });
    const started = await stripe.subscriptionSchedules.retrieve(schedule.id);
    expect(started.status).toBe('active');
    const sub = await stripe.subscriptions.retrieve(started.subscription, { expand: ['latest_invoice'] });
    expect(sub).toMatchObject({ status: 'active', created: startAt, start_date: startAt, schedule: schedule.id, default_payment_method: pm.id });
    expect(sub.latest_invoice).toMatchObject({ status: 'paid', amount_paid: 1000 });
  });

  it('cancels a schedule and its subscription, invoicing a proration credit by default', async () => {
    const t = await startServer();
    const { stripe, account, basic, customer, pm } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: basic.id }], default_payment_method: pm.id });
    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    expect(schedule.phases).toHaveLength(1);
    expect(schedule.phases[0]).toMatchObject({ start_date: sub.created, end_date: sub.items.data[0].current_period_end });
    await account.advanceTime({ seconds: 10 * DAY });
    const before = (await allEvents(stripe)).length;
    const canceled = await stripe.subscriptionSchedules.cancel(schedule.id);
    expect(canceled).toMatchObject({ status: 'canceled', subscription: null, current_phase: null });
    const ended = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(ended.status).toBe('canceled');
    expect(ended.latest_invoice.billing_reason).toBe('subscription_update');
    expect(ended.latest_invoice.total).toBeLessThan(0);
    expectOrder((await allEvents(stripe)).slice(before).map((e) => e.type), ['subscription_schedule.canceled', 'customer.subscription.deleted']);
    const again = await rejection(stripe.subscriptionSchedules.cancel(schedule.id));
    expect([again.statusCode, again.type]).toEqual([400, 'StripeInvalidRequestError']);
  });

  it('charges pending prorations on a final invoice when end_behavior=cancel ends the subscription', async () => {
    const t = await startServer();
    const { stripe, account, basic, plus, customer, pm } = await setup(t);
    const schedule = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: 'now',
      end_behavior: 'cancel',
      default_settings: { default_payment_method: pm.id },
      phases: [{ items: [{ price: basic.id }], duration: { interval: 'month', interval_count: 1 } }],
    });
    const { start_date: start, end_date: end } = schedule.phases[0];
    const sub = await stripe.subscriptions.retrieve(schedule.subscription);
    expect(sub.cancel_at).toBe(end);
    await account.advanceTime({ seconds: 15 * DAY });
    const changeAt = (await account.now()).now;
    await stripe.subscriptions.update(sub.id, { items: [{ id: sub.items.data[0].id, price: plus.id }] });
    const net = Math.round((2500 * (end - changeAt)) / (end - start)) - Math.round((1000 * (end - changeAt)) / (end - start));

    await account.advanceTime({ to: end + 1 });
    const ended = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect([ended.status, ended.ended_at, ended.cancel_at, ended.canceled_at]).toEqual(['canceled', end, end, end]);
    expect(ended.latest_invoice).toMatchObject({ billing_reason: 'subscription_cycle', total: net, status: 'paid' });
    expect((await stripe.subscriptionSchedules.retrieve(schedule.id)).status).toBe('completed');
  });

  it('copies a direct update of a scheduled subscription into its current phase, and releases once', async () => {
    const t = await startServer();
    const { stripe, basic, customer, pm } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: basic.id }], default_payment_method: pm.id });
    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    const second = await rejection(stripe.subscriptionSchedules.create({ from_subscription: sub.id }));
    expect([second.statusCode, second.param]).toEqual([400, 'from_subscription']);
    const mixed = await rejection(stripe.subscriptionSchedules.create({ from_subscription: sub.id, end_behavior: 'cancel' }));
    expect([mixed.statusCode, mixed.param]).toEqual([400, 'end_behavior']);
    await stripe.subscriptions.update(sub.id, { items: [{ id: sub.items.data[0].id, quantity: 3 }] });
    expect((await stripe.subscriptionSchedules.retrieve(schedule.id)).phases[0].items[0].quantity).toBe(3);
    const released = await stripe.subscriptionSchedules.release(schedule.id);
    expect(released).toMatchObject({ status: 'released', subscription: null, released_subscription: sub.id });
    expect(released.released_at).not.toBeNull();
    expect((await stripe.subscriptions.retrieve(sub.id)).schedule).toBeNull();
    expect((await rejection(stripe.subscriptionSchedules.release(schedule.id))).statusCode).toBe(400);
  });

  it('aborts the schedule when dunning cancels its subscription', async () => {
    const t = await startServer({ billing: { retrySchedule: [], afterFinalRetry: 'cancel' } });
    const { stripe, account, basic, customer, pm } = await setup(t, { card: 'pm_card_chargeCustomerFail' });
    const schedule = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      default_settings: { default_payment_method: pm.id },
      phases: [{ items: [{ price: basic.id }], duration: { interval: 'month', interval_count: 3 } }],
    });
    await account.advanceTime({ seconds: HOUR + 5 });
    expect((await stripe.subscriptions.retrieve(schedule.subscription)).cancellation_details.reason).toBe('payment_failed');
    expect((await stripe.subscriptionSchedules.retrieve(schedule.id)).status).toBe('canceled');
    expectOrder((await allEvents(stripe)).map((e) => e.type), ['customer.subscription.deleted', 'subscription_schedule.aborted']);
  });

  it('validates phases and renders the 2024-06-20 shape', async () => {
    const t = await startServer();
    const { stripe, basic, plus, customer } = await setup(t);
    const noItems = await rejection(stripe.subscriptionSchedules.create({ customer: customer.id, phases: [{ metadata: { tier: 'basic' } }] }));
    expect([noItems.code, noItems.param]).toEqual(['parameter_missing', 'phases[0][items]']);
    const gap = await rejection(
      stripe.subscriptionSchedules.create({
        customer: customer.id,
        phases: [
          { items: [{ price: basic.id }], duration: { interval: 'month' } },
          { items: [{ price: plus.id }], start_date: 1, duration: { interval: 'month' } },
        ],
      }),
    );
    expect(gap.param).toBe('phases[1][start_date]');
    const removed = await rejection(stripe.subscriptionSchedules.create({ customer: customer.id, phases: [{ items: [{ price: basic.id }], iterations: 2 }] }));
    expect([removed.code, removed.param]).toEqual(['parameter_unknown', 'phases[0][iterations]']);
    const legacy = await stripe.subscriptionSchedules.create(
      { customer: customer.id, start_date: (await t.account().now()).now + DAY, phases: [{ items: [{ price: basic.id }], iterations: 2 }] },
      { apiVersion: '2024-06-20' },
    );
    expect(legacy.billing_mode).toBeUndefined();
    expect(legacy.phases[0].coupon).toBeNull();
    expect(legacy.phases[0].end_date).toBe(addIntervals(legacy.phases[0].start_date, 'month', 2, 1));
    const expanded = await stripe.subscriptionSchedules.retrieve(legacy.id, { expand: ['phases.items.price', 'customer'] });
    expect(expanded.phases[0].items[0].price.object).toBe('price');
    expect(expanded.customer.object).toBe('customer');
  });
});
