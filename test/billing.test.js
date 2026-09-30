/**
 * Subscriptions, invoices and the billing engine through the real stripe SDK: direct creation,
 * trials, renewals on the account clock and on a test clock, upgrades and downgrades with
 * prorations, scheduled downgrades, period-end and immediate cancellation, dunning with recovery
 * and final actions, incomplete subscriptions, invoice operations, version shapes and the hosted
 * invoice page.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';
import { addIntervals } from '../src/core/periods.js';

const DAY = 86400;
const HOUR = 3600;
const monthAfter = (t) => addIntervals(t, 'month', 1, 1);

/** A product with three monthly prices and a customer whose default card is `card`. */
async function setup(t, { card = 'pm_card_visa', email = 'jenny.rosen@example.com', test_clock } = {}) {
  const stripe = t.stripe();
  const product = await stripe.products.create({ name: 'Pro' });
  const monthly = await stripe.prices.create({ product: product.id, unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } });
  const premium = await stripe.prices.create({ product: product.id, unit_amount: 5000, currency: 'usd', recurring: { interval: 'month' } });
  const basic = await stripe.prices.create({ product: product.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
  const customer = await stripe.customers.create({ email, name: 'Jenny Rosen', ...(test_clock ? { test_clock } : {}) });
  let pm = null;
  if (card) {
    pm = await stripe.paymentMethods.attach(card, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  }
  return { stripe, account: t.account(), product, monthly, premium, basic, customer, pm };
}

/** Every event of the account, oldest first. */
async function allEvents(stripe) {
  const out = [];
  for await (const e of stripe.events.list({ limit: 100 })) out.push(e);
  return out.reverse();
}

/** Events emitted after the first `skip` ones. */
async function eventsAfter(stripe, skip) {
  return (await allEvents(stripe)).slice(skip);
}

const typesOf = (events) => events.map((e) => e.type);

/** Asserts that `types` appear in this relative order inside `list`. */
function expectOrder(list, types) {
  let at = -1;
  for (const type of types) {
    const next = list.indexOf(type, at + 1);
    expect(next, `${type} after index ${at} in ${list.join(', ')}`).toBeGreaterThan(at);
    at = next;
  }
}

async function nowOf(account) {
  return (await account.now()).now;
}

describe('subscription creation', () => {
  it('creates a subscription directly: the first invoice is finalized and paid in the request', async () => {
    const t = await startServer();
    const { stripe, customer, monthly, pm } = await setup(t);
    const before = (await allEvents(stripe)).length;
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: monthly.id }],
      metadata: { plan: 'pro' },
      expand: ['latest_invoice.payments'],
    });
    expect(sub).toMatchObject({ object: 'subscription', status: 'active', customer: customer.id, currency: 'usd', collection_method: 'charge_automatically' });
    expect(sub.id).toMatch(/^sub_[A-Za-z0-9]{24}$/);
    expect(sub.billing_mode).toMatchObject({ type: 'flexible', flexible: { proration_discounts: 'included' } });
    expect(sub.start_date).toBe(sub.created);
    expect(sub.billing_cycle_anchor).toBe(sub.created);
    const [item] = sub.items.data;
    expect(item.id).toMatch(/^si_/);
    expect([item.current_period_start, item.current_period_end]).toEqual([sub.created, monthAfter(sub.created)]);
    expect(item.price.id).toBe(monthly.id);
    expect(item.plan).toMatchObject({ object: 'plan', id: monthly.id, amount: 2000, interval: 'month', interval_count: 1 });
    expect(sub.items).toMatchObject({ object: 'list', has_more: false, total_count: 1, url: `/v1/subscription_items?subscription=${sub.id}` });

    const invoice = sub.latest_invoice;
    expect(invoice).toMatchObject({
      object: 'invoice',
      status: 'paid',
      billing_reason: 'subscription_create',
      amount_due: 2000,
      amount_paid: 2000,
      amount_remaining: 0,
      attempt_count: 1,
      attempted: true,
      auto_advance: false,
      customer_email: 'jenny.rosen@example.com',
      period_start: sub.created,
      period_end: sub.created,
      parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: sub.id, metadata: { plan: 'pro' } } },
    });
    expect(invoice.number).toMatch(/^[0-9A-F]{8}-0001$/);
    expect(invoice.hosted_invoice_url.startsWith(`${t.url}/i/acct_`)).toBe(true);
    expect(invoice.invoice_pdf).toBe(`${invoice.hosted_invoice_url}/pdf`);
    expect(invoice.lines.data).toHaveLength(1);
    expect(invoice.lines.data[0]).toMatchObject({
      amount: 2000,
      description: '1 × Pro (at $20.00 / month)',
      period: { start: sub.created, end: monthAfter(sub.created) },
      pricing: { type: 'price_details', price_details: { price: monthly.id, product: monthly.product } },
      parent: { type: 'subscription_item_details', subscription_item_details: { proration: false, subscription: sub.id, subscription_item: item.id } },
    });
    expect(invoice.payments.data).toHaveLength(1);
    expect(invoice.payments.data[0]).toMatchObject({ object: 'invoice_payment', status: 'paid', amount_paid: 2000, is_default: true });
    const pi = await stripe.paymentIntents.retrieve(invoice.payments.data[0].payment.payment_intent);
    expect([pi.status, pi.amount, pi.payment_method]).toEqual(['succeeded', 2000, pm.id]);

    const events = await eventsAfter(stripe, before);
    const types = typesOf(events);
    expectOrder(types, [
      'customer.subscription.created',
      'invoice.created',
      'invoice.finalized',
      'invoice.paid',
      'invoice.payment_succeeded',
      'invoice_payment.paid',
      'customer.subscription.updated',
    ]);
    expect(events.find((e) => e.type === 'customer.subscription.created').data.object.status).toBe('incomplete');
    const activated = events.filter((e) => e.type === 'customer.subscription.updated').at(-1);
    expect(activated.data.previous_attributes).toEqual({ status: 'incomplete' });
    expect(activated.request.id).toBe(sub.lastResponse.requestId);
    expect(events.find((e) => e.type === 'invoice.created').data.object.status).toBe('draft');
  });

  it('starts a trial through the createSubscription control: $0 invoice, trial_will_end three days before, then a draft for an hour', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t, { card: null });
    const sub = await account.createSubscription(customer.id, { price: monthly.id, trialDays: 7, paymentMethod: 'pm_card_visa' });
    expect(sub.status).toBe('trialing');
    expect(sub.trial_end - sub.trial_start).toBe(7 * DAY);
    expect(sub.billing_cycle_anchor).toBe(sub.trial_end);
    expect(sub.items.data[0].current_period_end).toBe(sub.trial_end);
    expect(sub.default_payment_method).toMatch(/^pm_/);
    const trialInvoice = await stripe.invoices.retrieve(sub.latest_invoice);
    expect(trialInvoice).toMatchObject({ status: 'paid', amount_due: 0, billing_reason: 'subscription_create' });
    expect(trialInvoice.lines.data[0]).toMatchObject({ amount: 0, description: 'Free trial for 1 × Pro' });
    const zeroEvents = typesOf(await allEvents(stripe));
    expect(zeroEvents).toContain('invoice.paid');
    expect(zeroEvents).not.toContain('invoice.payment_succeeded');

    let before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: sub.trial_end - 3 * DAY - 1 });
    expect(typesOf(await eventsAfter(stripe, before))).not.toContain('customer.subscription.trial_will_end');
    await account.advanceTime({ to: sub.trial_end - 3 * DAY });
    const warned = await eventsAfter(stripe, before);
    expect(typesOf(warned)).toEqual(['customer.subscription.trial_will_end']);
    expect(warned[0].created).toBe(sub.trial_end - 3 * DAY);

    before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: sub.trial_end });
    const active = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(active.status).toBe('active');
    expect(active.items.data[0].current_period_start).toBe(sub.trial_end);
    expect(active.items.data[0].current_period_end).toBe(monthAfter(sub.trial_end));
    expect(active.latest_invoice).toMatchObject({
      status: 'draft',
      billing_reason: 'subscription_cycle',
      amount_due: 2000,
      automatically_finalizes_at: sub.trial_end + HOUR,
      next_payment_attempt: sub.trial_end + HOUR,
    });
    expect(typesOf(await eventsAfter(stripe, before))).toEqual(['customer.subscription.updated', 'invoice.created']);

    await account.advanceTime({ to: sub.trial_end + HOUR });
    const paid = await stripe.invoices.retrieve(active.latest_invoice.id);
    expect(paid).toMatchObject({ status: 'paid', amount_paid: 2000, attempt_count: 1, automatically_finalizes_at: null });
    expect(paid.status_transitions.finalized_at).toBe(sub.trial_end + HOUR);
  });

  it('fires trial_will_end immediately for a trial shorter than three days', async () => {
    const t = await startServer();
    const { stripe, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }], trial_period_days: 2 });
    expect(sub.status).toBe('trialing');
    const types = typesOf(await allEvents(stripe));
    expect(types.filter((x) => x === 'customer.subscription.trial_will_end')).toHaveLength(1);
    expectOrder(types, ['customer.subscription.created', 'invoice.paid', 'customer.subscription.trial_will_end']);
  });

  it('leaves a subscription incomplete when the first payment fails and expires it after 23 hours', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t, { card: null });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }], expand: ['latest_invoice'] });
    expect(sub.status).toBe('incomplete');
    expect(sub.latest_invoice).toMatchObject({ status: 'open', auto_advance: false, attempt_count: 1, next_payment_attempt: null });
    const updateErr = await rejection(stripe.subscriptions.update(sub.id, { cancel_at_period_end: true }));
    expect([updateErr.statusCode, updateErr.type, updateErr.param]).toEqual([400, 'StripeInvalidRequestError', 'cancel_at_period_end']);
    await account.advanceTime({ to: sub.created + 23 * HOUR - 1 });
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe('incomplete');
    const before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: sub.created + 23 * HOUR });
    const expired = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(expired.status).toBe('incomplete_expired');
    expect(expired.latest_invoice.status).toBe('void');
    const events = await eventsAfter(stripe, before);
    expectOrder(typesOf(events), ['customer.subscription.updated', 'invoice.voided']);
    expect(events[0].data.previous_attributes.status).toBe('incomplete');
    expect(events[0].request).toEqual({ id: null, idempotency_key: null });
  });

  it('activates an incomplete subscription when its first invoice is paid, and error_if_incomplete creates nothing on a decline', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t, { card: null });
    const noCard = await rejection(stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }], payment_behavior: 'error_if_incomplete' }));
    expect([noCard.statusCode, noCard.type]).toEqual([400, 'StripeInvalidRequestError']);
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await account.failNextCharge(customer.id);
    const declined = await rejection(
      stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }], default_payment_method: pm.id, payment_behavior: 'error_if_incomplete' }),
    );
    expect([declined.statusCode, declined.type, declined.code]).toEqual([402, 'StripeCardError', 'card_declined']);
    expect((await stripe.subscriptions.list({ customer: customer.id, status: 'all' })).data).toHaveLength(0);
    expect((await stripe.invoices.list({ customer: customer.id })).data).toHaveLength(0);

    const pending = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }], payment_behavior: 'default_incomplete' });
    expect(pending.status).toBe('incomplete');
    const invoice = await stripe.invoices.retrieve(pending.latest_invoice);
    expect([invoice.status, invoice.attempted, invoice.auto_advance]).toEqual(['open', false, false]);
    const paid = await stripe.invoices.pay(invoice.id, { payment_method: pm.id });
    expect(paid.status).toBe('paid');
    expect((await stripe.subscriptions.retrieve(pending.id)).status).toBe('active');
  });
});

describe('renewals', () => {
  it('renews on the account clock: the period rolls at its end, the invoice stays a draft for an hour, then is paid', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const end = sub.items.data[0].current_period_end;
    await account.advanceTime({ to: end - 1 });
    const before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: end });
    const renewed = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect([renewed.items.data[0].current_period_start, renewed.items.data[0].current_period_end]).toEqual([end, monthAfter(end)]);
    expect(renewed.latest_invoice).toMatchObject({
      status: 'draft',
      billing_reason: 'subscription_cycle',
      created: end,
      period_start: sub.created,
      period_end: end,
      number: null,
      hosted_invoice_url: null,
      amount_due: 2000,
    });
    expect(renewed.latest_invoice.lines.data[0].period).toEqual({ start: end, end: monthAfter(end) });
    const rollover = await eventsAfter(stripe, before);
    expect(typesOf(rollover)).toEqual(['customer.subscription.updated', 'invoice.created']);
    expect(rollover[0].created).toBe(end);
    expect(rollover[0].data.previous_attributes.latest_invoice).toBe(sub.latest_invoice);
    expect(rollover[0].data.previous_attributes.items.data[0].current_period_start).toBe(sub.created);

    await account.advanceTime({ to: end + HOUR - 1 });
    expect((await stripe.invoices.retrieve(renewed.latest_invoice.id)).status).toBe('draft');
    await account.advanceTime({ to: end + HOUR });
    const paid = await stripe.invoices.retrieve(renewed.latest_invoice.id);
    expect(paid).toMatchObject({ status: 'paid', amount_paid: 2000, attempt_count: 1 });
    expect(paid.number).toMatch(/-0002$/);
    const invoices = await stripe.invoices.list({ subscription: sub.id });
    expect(invoices.data.map((i) => i.billing_reason)).toEqual(['subscription_cycle', 'subscription_create']);
  });

  it('renews on a test clock with events stamped at the clock time', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const start = Math.floor(Date.UTC(2031, 0, 31, 10) / 1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start });
    const { customer, monthly } = await setup(t, { test_clock: clock.id });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    expect([sub.created, sub.test_clock]).toEqual([start, clock.id]);
    const end = sub.items.data[0].current_period_end;
    expect(end).toBe(Math.floor(Date.UTC(2031, 1, 28, 10) / 1000));
    expect((await stripe.subscriptions.list()).data.map((s) => s.id)).not.toContain(sub.id);
    expect((await stripe.subscriptions.list({ customer: customer.id })).data.map((s) => s.id)).toEqual([sub.id]);

    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: end + HOUR });
    for (let i = 0; i < 50; i++) {
      if ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const renewed = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(renewed.items.data[0].current_period_end).toBe(Math.floor(Date.UTC(2031, 2, 31, 10) / 1000));
    expect(renewed.latest_invoice).toMatchObject({ status: 'paid', created: end, billing_reason: 'subscription_cycle', test_clock: clock.id });
    expect(renewed.latest_invoice.status_transitions.paid_at).toBe(end + HOUR);
    expect((await stripe.invoices.list()).data).toHaveLength(0);
    const paidEvent = (await allEvents(stripe)).filter((e) => e.type === 'invoice.paid').at(-1);
    expect(paidEvent.created).toBe(end + HOUR);
    expect(paidEvent.request).toEqual({ id: null, idempotency_key: null });
  });
});

describe('plan changes', () => {
  it('upgrades with always_invoice: prorations are invoiced and charged in the request', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly, premium } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const [item] = sub.items.data;
    const { current_period_start: start, current_period_end: end } = item;
    const at = start + Math.floor((end - start) / 3);
    await account.advanceTime({ to: at });
    const before = (await allEvents(stripe)).length;
    const updated = await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: premium.id }],
      proration_behavior: 'always_invoice',
      proration_date: at,
      expand: ['latest_invoice'],
    });
    expect(updated.items.data.map((i) => [i.id, i.price.id, i.quantity])).toEqual([[item.id, premium.id, 1]]);
    expect([updated.items.data[0].current_period_start, updated.items.data[0].current_period_end]).toEqual([start, end]);
    const credit = -Math.round((2000 * (end - at)) / (end - start));
    const debit = Math.round((5000 * (end - at)) / (end - start));
    const invoice = updated.latest_invoice;
    expect(invoice).toMatchObject({
      billing_reason: 'subscription_update',
      status: 'paid',
      auto_advance: false,
      total: credit + debit,
      amount_paid: credit + debit,
      parent: { subscription_details: { subscription: sub.id, subscription_proration_date: at } },
    });
    const day = new Date(at * 1000).toUTCString().slice(5, 16);
    expect(invoice.lines.data.map((l) => [l.description, l.amount, l.period.start, l.period.end, l.discountable])).toEqual([
      [`Unused time on Pro after ${day}`, credit, at, end, false],
      [`Remaining time on Pro after ${day}`, debit, at, end, false],
    ]);
    expect(invoice.lines.data.every((l) => l.parent.subscription_item_details.proration && l.parent.subscription_item_details.invoice_item)).toBe(true);
    expect(invoice.lines.data[0].parent.subscription_item_details.proration_details.credited_items).toEqual({
      invoice: sub.latest_invoice,
      invoice_line_items: [(await stripe.invoices.retrieve(sub.latest_invoice)).lines.data[0].id],
    });

    const events = await eventsAfter(stripe, before);
    expectOrder(typesOf(events), [
      'invoiceitem.created',
      'invoiceitem.created',
      'customer.subscription.updated',
      'invoice.created',
      'invoice.finalized',
      'invoice.paid',
      'invoice.payment_succeeded',
    ]);
    const change = events.find((e) => e.type === 'customer.subscription.updated');
    expect(change.data.previous_attributes.items.data[0].price.id).toBe(monthly.id);
    expect(change.data.previous_attributes.latest_invoice).toBe(sub.latest_invoice);
    expect(events.find((e) => e.type === 'invoiceitem.created').data.object).toMatchObject({ object: 'invoiceitem', proration: true, amount: credit });
  });

  it('downgrades with create_prorations: pending items are collected on the next renewal invoice', async () => {
    const t = await startServer();
    const { stripe, account, customer, premium, basic } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: premium.id, quantity: 2 }] });
    const [item] = sub.items.data;
    const { current_period_start: start, current_period_end: end } = item;
    const at = start + 10 * DAY;
    await account.advanceTime({ to: at });
    const before = (await allEvents(stripe)).length;
    const updated = await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price: basic.id }], proration_date: at });
    expect(updated.items.data[0].quantity).toBe(1);
    expect(updated.latest_invoice).toBe(sub.latest_invoice);
    expect(typesOf(await eventsAfter(stripe, before))).toEqual(['invoiceitem.created', 'invoiceitem.created', 'customer.subscription.updated']);

    await account.advanceTime({ to: end + HOUR });
    const renewal = await stripe.invoices.retrieve((await stripe.subscriptions.retrieve(sub.id)).latest_invoice);
    const credit = -Math.round((10000 * (end - at)) / (end - start));
    const debit = Math.round((1000 * (end - at)) / (end - start));
    expect(renewal.lines.data.map((l) => [l.amount, l.parent.subscription_item_details.proration])).toEqual([
      [credit, true],
      [debit, true],
      [1000, false],
    ]);
    expect(renewal.lines.data[0].description).toBe(`Unused time on 2 × Pro after ${new Date(at * 1000).toUTCString().slice(5, 16)}`);
    expect(renewal.total).toBe(credit + debit + 1000);
    expect(renewal.status).toBe('paid');
    expect(renewal.amount_due).toBe(0);
    expect(renewal.ending_balance).toBe(credit + debit + 1000);
    expect((await stripe.customers.retrieve(customer.id)).balance).toBe(credit + debit + 1000);
  });

  it('keeps a pending_if_incomplete upgrade pending until its invoice is paid', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly, premium } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    await account.advanceTime({ seconds: 3 * DAY });
    await account.failNextCharge(customer.id);
    const pending = await stripe.subscriptions.update(sub.id, {
      items: [{ id: sub.items.data[0].id, price: premium.id }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'pending_if_incomplete',
    });
    expect(pending.status).toBe('active');
    expect(pending.items.data[0].price.id).toBe(monthly.id);
    expect(pending.pending_update.subscription_items[0].price.id).toBe(premium.id);
    expect(pending.pending_update.expires_at - (await nowOf(account))).toBeLessThanOrEqual(23 * HOUR);
    const invoice = await stripe.invoices.retrieve(pending.latest_invoice);
    expect([invoice.status, invoice.billing_reason, invoice.attempt_count]).toEqual(['open', 'subscription_update', 1]);

    const before = (await allEvents(stripe)).length;
    await stripe.invoices.pay(invoice.id);
    const applied = await stripe.subscriptions.retrieve(sub.id);
    expect(applied.items.data[0].price.id).toBe(premium.id);
    expect(applied.pending_update).toBeNull();
    expectOrder(typesOf(await eventsAfter(stripe, before)), ['invoice.paid', 'customer.subscription.pending_update_applied', 'customer.subscription.updated']);
  });

  it('schedules a downgrade at the period end, applies it at renewal, then releases the schedule', async () => {
    const t = await startServer();
    const { stripe, account, customer, premium, basic } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: premium.id }] });
    const end = sub.items.data[0].current_period_end;
    const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    expect((await stripe.subscriptions.retrieve(sub.id)).schedule).toBe(schedule.id);
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release',
      phases: [
        { items: [{ price: premium.id, quantity: 1 }], start_date: schedule.phases[0].start_date, end_date: end },
        { items: [{ price: basic.id, quantity: 1 }], duration: { interval: 'month', interval_count: 1 } },
      ],
    });
    await account.advanceTime({ to: end + HOUR });
    const downgraded = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(downgraded.items.data[0].price.id).toBe(basic.id);
    expect(downgraded.latest_invoice).toMatchObject({ billing_reason: 'subscription_cycle', status: 'paid', total: 1000 });
    expect(downgraded.latest_invoice.lines.data.map((l) => l.amount)).toEqual([1000]);

    const before = (await allEvents(stripe)).length;
    const released = await stripe.subscriptionSchedules.release(schedule.id);
    expect(released).toMatchObject({ status: 'released', released_subscription: sub.id, subscription: null });
    expect((await stripe.subscriptions.retrieve(sub.id)).schedule).toBeNull();
    const types = typesOf(await eventsAfter(stripe, before));
    expect(types).toContain('subscription_schedule.released');
    expect(types).toContain('customer.subscription.updated');
  });
});

describe('cancellation', () => {
  it('cancels at the period end: flags now, can be renewed, and ends with customer.subscription.deleted', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const end = sub.items.data[0].current_period_end;
    await account.advanceTime({ seconds: 5 * DAY });
    let before = (await allEvents(stripe)).length;
    const canceling = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true, cancellation_details: { comment: 'Too pricey', feedback: 'too_expensive' } });
    const requestedAt = canceling.canceled_at;
    expect(Math.abs(requestedAt - (await nowOf(account)))).toBeLessThanOrEqual(2);
    expect(canceling).toMatchObject({
      status: 'active',
      cancel_at_period_end: true,
      cancel_at: end,
      cancellation_details: { comment: 'Too pricey', feedback: 'too_expensive', feedback_option: null, reason: 'cancellation_requested' },
    });
    const [flagged] = await eventsAfter(stripe, before);
    expect(flagged.type).toBe('customer.subscription.updated');
    expect(flagged.data.previous_attributes).toEqual({
      cancel_at: null,
      cancel_at_period_end: false,
      canceled_at: null,
      cancellation_details: { comment: null, feedback: null, reason: null },
    });

    const renewed = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    expect([renewed.cancel_at_period_end, renewed.cancel_at, renewed.canceled_at, renewed.cancellation_details.reason]).toEqual([false, null, null, null]);
    const again = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: end + 2 * HOUR });
    const ended = await stripe.subscriptions.retrieve(sub.id);
    expect(ended).toMatchObject({ status: 'canceled', ended_at: end, canceled_at: again.canceled_at, cancel_at_period_end: true, latest_invoice: sub.latest_invoice });
    const events = await eventsAfter(stripe, before);
    expect(typesOf(events)).toEqual(['customer.subscription.deleted']);
    expect(events[0].created).toBe(end);
    expect((await stripe.invoices.list({ subscription: sub.id })).data).toHaveLength(1);
    const late = await rejection(stripe.subscriptions.update(sub.id, { cancel_at_period_end: false }));
    expect([late.statusCode, late.param]).toEqual([400, 'cancel_at_period_end']);
    expect((await stripe.subscriptions.update(sub.id, { metadata: { note: 'kept' } })).metadata).toEqual({ note: 'kept' });
  });

  it('credits the time after a mid-period cancel_at, withdraws the credit when cancel_at is cleared, and cancels at cancel_at', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const { current_period_start: start, current_period_end: end } = sub.items.data[0];
    const cancelAt = start + 10 * DAY;
    const credit = -Math.round((2000 * (end - cancelAt)) / (end - start));
    let before = (await allEvents(stripe)).length;
    const scheduled = await stripe.subscriptions.update(sub.id, { cancel_at: cancelAt });
    expect([scheduled.cancel_at, scheduled.cancel_at_period_end, scheduled.cancellation_details.reason]).toEqual([cancelAt, false, 'cancellation_requested']);
    const created = await eventsAfter(stripe, before);
    expect(typesOf(created)).toEqual(['invoiceitem.created', 'customer.subscription.updated']);
    expect(created[0].data.object).toMatchObject({ amount: credit, proration: true, period: { start: cancelAt, end }, invoice: null });

    before = (await allEvents(stripe)).length;
    const cleared = await stripe.subscriptions.update(sub.id, { cancel_at: '' });
    expect([cleared.cancel_at, cleared.canceled_at]).toEqual([null, null]);
    expect(typesOf(await eventsAfter(stripe, before))).toEqual(['invoiceitem.deleted', 'customer.subscription.updated']);

    await stripe.subscriptions.update(sub.id, { cancel_at: cancelAt });
    await account.advanceTime({ to: cancelAt });
    const ended = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect([ended.status, ended.ended_at]).toEqual(['canceled', cancelAt]);
    expect(ended.latest_invoice).toMatchObject({ total: credit, amount_due: 0, status: 'paid' });
    expect((await stripe.customers.retrieve(customer.id)).balance).toBe(credit);
  });

  it('prorates the final period of a cancel_at set during a future period and cancels at cancel_at', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const renewal = sub.items.data[0].current_period_end;
    const cancelAt = renewal + 14 * DAY;
    let before = (await allEvents(stripe)).length;
    await stripe.subscriptions.update(sub.id, { cancel_at: cancelAt });
    expect(typesOf(await eventsAfter(stripe, before))).toEqual(['customer.subscription.updated']);

    await account.advanceTime({ to: renewal + HOUR + 1 });
    const renewed = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect([renewed.items.data[0].current_period_start, renewed.items.data[0].current_period_end]).toEqual([renewal, cancelAt]);
    const amount = Math.round((2000 * (cancelAt - renewal)) / (monthAfter(renewal) - renewal));
    expect(renewed.latest_invoice).toMatchObject({ billing_reason: 'subscription_cycle', total: amount, status: 'paid' });
    expect(renewed.latest_invoice.lines.data.map((l) => [l.amount, l.period.start, l.period.end])).toEqual([[amount, renewal, cancelAt]]);

    before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: cancelAt });
    const ended = await stripe.subscriptions.retrieve(sub.id);
    expect([ended.status, ended.ended_at, ended.latest_invoice]).toEqual(['canceled', cancelAt, renewed.latest_invoice.id]);
    expect(typesOf(await eventsAfter(stripe, before))).toEqual(['customer.subscription.deleted']);
  });

  it('cancels immediately with DELETE, crediting unused time on a final invoice with invoice_now and prorate', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const { current_period_start: start, current_period_end: end } = sub.items.data[0];
    await account.advanceTime({ to: start + 15 * DAY });
    const before = (await allEvents(stripe)).length;
    const canceled = await stripe.subscriptions.cancel(sub.id, { invoice_now: true, prorate: true });
    const at = canceled.canceled_at;
    expect(canceled).toMatchObject({ status: 'canceled', ended_at: at, cancel_at: null, cancel_at_period_end: false, cancellation_details: { reason: 'cancellation_requested' } });
    const final = await stripe.invoices.retrieve(canceled.latest_invoice);
    const credit = -Math.round((2000 * (end - at)) / (end - start));
    expect(final).toMatchObject({ status: 'paid', total: credit, amount_due: 0, ending_balance: credit });
    expect((await stripe.customers.retrieve(customer.id)).balance).toBe(credit);
    const cancelEvents = await eventsAfter(stripe, before);
    expectOrder(typesOf(cancelEvents), ['invoiceitem.created', 'customer.subscription.deleted', 'invoice.created', 'invoice.finalized', 'invoice.paid']);
    // The deleted event already shows the final invoice: no later change goes unannounced.
    expect(cancelEvents.find((e) => e.type === 'customer.subscription.deleted').data.object.latest_invoice).toBe(final.id);
    const twice = await rejection(stripe.subscriptions.cancel(sub.id));
    expect([twice.statusCode, twice.type]).toEqual([400, 'StripeInvalidRequestError']);
  });
});

describe('dunning', () => {
  it('moves a failed renewal to past_due and recovers when a retry succeeds', async () => {
    const t = await startServer({ billing: { retrySchedule: [1, 1] } });
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const end = sub.items.data[0].current_period_end;
    await account.advanceTime({ to: end });
    await account.failNextCharge(customer.id);
    const before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: end + HOUR });
    const pastDue = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice', 'customer'] });
    expect(pastDue.status).toBe('past_due');
    expect(pastDue.customer.delinquent).toBe(true);
    expect(pastDue.latest_invoice).toMatchObject({ status: 'open', attempt_count: 1, attempted: true, next_payment_attempt: end + HOUR + DAY });
    const failed = await eventsAfter(stripe, before);
    expectOrder(typesOf(failed), ['invoice.finalized', 'invoice.payment_failed', 'invoice.updated', 'customer.subscription.updated']);
    expect(failed.find((e) => e.type === 'invoice.payment_failed').data.object.attempt_count).toBe(1);
    expect(failed.filter((e) => e.type === 'customer.subscription.updated').at(-1).data.previous_attributes).toEqual({ status: 'active' });

    await account.advanceTime({ to: end + HOUR + DAY });
    const recovered = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice', 'customer'] });
    expect(recovered.status).toBe('active');
    expect(recovered.customer.delinquent).toBe(false);
    expect(recovered.latest_invoice).toMatchObject({ status: 'paid', attempt_count: 2, next_payment_attempt: null });
    const renewalAfter = await stripe.subscriptions.retrieve(sub.id);
    expect(renewalAfter.items.data[0].current_period_end).toBe(monthAfter(end));
  });

  it('cancels the subscription after the final retry fails (payment_failed), leaving the invoice open', async () => {
    const t = await startServer({ billing: { retrySchedule: [1, 2], afterFinalRetry: 'cancel' } });
    const { stripe, account, customer, monthly } = await setup(t, { card: 'pm_card_chargeCustomerFail' });
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }], trial_period_days: 1 });
    const trialEnd = sub.trial_end;
    await account.advanceTime({ to: trialEnd + HOUR });
    const invoiceId = (await stripe.subscriptions.retrieve(sub.id)).latest_invoice;
    expect((await stripe.invoices.retrieve(invoiceId)).next_payment_attempt).toBe(trialEnd + HOUR + DAY);
    await account.advanceTime({ to: trialEnd + HOUR + DAY });
    expect((await stripe.invoices.retrieve(invoiceId)).next_payment_attempt).toBe(trialEnd + HOUR + 3 * DAY);
    const before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: trialEnd + HOUR + 3 * DAY });
    const canceled = await stripe.subscriptions.retrieve(sub.id);
    expect(canceled).toMatchObject({ status: 'canceled', ended_at: trialEnd + HOUR + 3 * DAY, cancellation_details: { reason: 'payment_failed' } });
    expect(await stripe.invoices.retrieve(invoiceId)).toMatchObject({ status: 'open', attempt_count: 3, next_payment_attempt: null, auto_advance: false });
    expectOrder(typesOf(await eventsAfter(stripe, before)), ['invoice.payment_failed', 'invoice.updated', 'customer.subscription.deleted']);
  });

  it('marks the subscription unpaid and the invoice uncollectible after the final retry, and recovers when the invoice is paid', async () => {
    const t = await startServer({ billing: { retrySchedule: [], afterFinalRetry: 'unpaid', markUncollectible: true } });
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const end = sub.items.data[0].current_period_end;
    await account.failNextCharge(customer.id);
    await account.advanceTime({ to: end + HOUR });
    const unpaid = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice', 'customer'] });
    expect(unpaid.status).toBe('unpaid');
    expect(unpaid.latest_invoice.status).toBe('uncollectible');
    expect(unpaid.customer.delinquent).toBe(true);
    const events = typesOf(await allEvents(stripe));
    expectOrder(events, ['invoice.payment_failed', 'customer.subscription.updated', 'invoice.marked_uncollectible']);

    const card = await stripe.paymentMethods.attach('pm_card_mastercard', { customer: customer.id });
    const paid = await stripe.invoices.pay(unpaid.latest_invoice.id, { payment_method: card.id });
    expect(paid.status).toBe('paid');
    const recovered = await stripe.subscriptions.retrieve(sub.id, { expand: ['customer'] });
    expect(recovered.status).toBe('active');
    expect(recovered.customer.delinquent).toBe(false);
  });

  it('returns the 402 card error from invoices.pay and records the attempt', async () => {
    const t = await startServer({ billing: { retrySchedule: [3] } });
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const end = sub.items.data[0].current_period_end;
    await account.failNextCharge(customer.id, { times: 2 });
    await account.advanceTime({ to: end + HOUR });
    const invoiceId = (await stripe.subscriptions.retrieve(sub.id)).latest_invoice;
    const err = await rejection(stripe.invoices.pay(invoiceId));
    expect([err.statusCode, err.type, err.code, err.decline_code]).toEqual([402, 'StripeCardError', 'card_declined', 'generic_decline']);
    const invoice = await stripe.invoices.retrieve(invoiceId);
    expect(invoice).toMatchObject({ status: 'open', attempt_count: 1, next_payment_attempt: end + HOUR + 3 * DAY });
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe('past_due');
    expect((await stripe.invoices.pay(invoiceId)).status).toBe('paid');
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe('active');
  });
});

describe('invoices', () => {
  it('follows the invoice state machine for void, mark_uncollectible, finalize and pay', async () => {
    const t = await startServer({ billing: { retrySchedule: [5] } });
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const first = await stripe.invoices.retrieve(sub.latest_invoice);
    const voidPaid = await rejection(stripe.invoices.voidInvoice(first.id));
    expect([voidPaid.statusCode, voidPaid.type]).toEqual([400, 'StripeInvalidRequestError']);
    expect((await rejection(stripe.invoices.pay(first.id))).statusCode).toBe(400);
    expect((await rejection(stripe.invoices.markUncollectible(first.id))).statusCode).toBe(400);

    const end = sub.items.data[0].current_period_end;
    await account.advanceTime({ to: end });
    const draftId = (await stripe.subscriptions.retrieve(sub.id)).latest_invoice;
    expect((await rejection(stripe.invoices.voidInvoice(draftId))).statusCode).toBe(400);
    const finalized = await stripe.invoices.finalizeInvoice(draftId, { auto_advance: false });
    expect(finalized).toMatchObject({ status: 'open', auto_advance: false, attempted: false, next_payment_attempt: null });
    expect(finalized.number).toMatch(/-0002$/);
    expect((await rejection(stripe.invoices.finalizeInvoice(draftId))).statusCode).toBe(400);
    const uncollectible = await stripe.invoices.markUncollectible(draftId);
    expect(uncollectible.status).toBe('uncollectible');
    const voided = await stripe.invoices.voidInvoice(draftId);
    expect(voided.status).toBe('void');
    expect(voided.status_transitions.voided_at).not.toBeNull();
    const pi = await stripe.paymentIntents.retrieve((await stripe.invoicePayments.list({ invoice: draftId })).data[0].payment.payment_intent);
    expect([pi.status, pi.cancellation_reason]).toEqual(['canceled', 'void_invoice']);
    const types = typesOf(await allEvents(stripe));
    expectOrder(types, ['invoice.finalized', 'invoice.marked_uncollectible', 'invoice.voided']);
  });

  it('lists invoices and lines with filters and pagination', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly, basic } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }, { price: basic.id, quantity: 3 }] });
    await account.advanceTime({ to: sub.items.data[0].current_period_end });
    const all = await stripe.invoices.list({ customer: customer.id });
    expect(all.data.map((i) => i.status)).toEqual(['draft', 'paid']);
    expect((await stripe.invoices.list({ status: 'paid' })).data.map((i) => i.id)).toEqual([sub.latest_invoice]);
    expect((await stripe.invoices.list({ subscription: 'sub_nope' })).data).toEqual([]);
    const page1 = await stripe.invoices.listLineItems(sub.latest_invoice, { limit: 1 });
    expect([page1.data.length, page1.has_more]).toEqual([1, true]);
    const page2 = await stripe.invoices.listLineItems(sub.latest_invoice, { limit: 1, starting_after: page1.data[0].id });
    expect(page2.data[0]).toMatchObject({ quantity: 3, amount: 3000, description: '3 × Pro (at $10.00 / month)' });
    const items = await stripe.subscriptionItems.list({ subscription: sub.id });
    expect(items.data.map((i) => i.quantity).sort()).toEqual([1, 3]);
    expect((await stripe.subscriptionItems.retrieve(items.data[0].id)).subscription).toBe(sub.id);
  });

  it('serves the hosted invoice page: shows the invoice, pays it with a test card, and renders the text PDF', async () => {
    const t = await startServer({ billing: { retrySchedule: [5] } });
    const { stripe, account, customer, monthly } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    await account.failNextCharge(customer.id);
    await account.advanceTime({ to: sub.items.data[0].current_period_end + HOUR });
    const invoice = await stripe.invoices.retrieve((await stripe.subscriptions.retrieve(sub.id)).latest_invoice);
    const path = invoice.hosted_invoice_url.slice(t.url.length);
    const page = await t.request('GET', path, { key: null });
    expect(page.status).toBe(200);
    expect(page.text).toContain(invoice.number);
    expect(page.text).toContain('name="card_number"');
    const declined = await t.request('POST', path, { key: null, form: 'card_number=4000000000000341' });
    expect(declined.status).toBe(402);
    expect(declined.text).toContain('declined');
    const paid = await t.request('POST', path, { key: null, form: 'card_number=4242424242424242' });
    expect([paid.status, paid.headers.get('location')]).toEqual([303, path]);
    expect((await stripe.invoices.retrieve(invoice.id)).status).toBe('paid');
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe('active');
    const pdf = await t.request('GET', `${path}/pdf`, { key: null });
    expect(pdf.headers.get('content-type')).toContain('text/plain');
    expect(pdf.text).toContain(`INVOICE ${invoice.number}`);
    expect((await t.request('GET', `/i/${t.account().id}/test_unknown`, { key: null })).status).toBe(404);
  });
});

describe('versions and validation', () => {
  it('renders 2024-06-20 shapes: subscription-level periods, invoice.subscription/paid/payment_intent, line price and type', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly, premium } = await setup(t);
    const legacy = { apiVersion: '2024-06-20' };
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] }, legacy);
    expect(sub.billing_mode).toBeUndefined();
    expect([sub.current_period_start, sub.current_period_end]).toEqual([sub.created, monthAfter(sub.created)]);
    expect(sub.items.data[0].current_period_end).toBeUndefined();
    expect(sub.discount).toBeNull();
    expect(sub.items.data[0].plan.aggregate_usage).toBeNull();
    const invoice = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['payment_intent'] }, legacy);
    expect(invoice).toMatchObject({ subscription: sub.id, paid: true, paid_out_of_band: false, subscription_details: { metadata: {} } });
    expect(invoice.parent).toBeUndefined();
    expect(invoice.payment_intent).toMatchObject({ object: 'payment_intent', status: 'succeeded', invoice: invoice.id });
    expect(invoice.charge).toMatch(/^ch_/);
    expect(invoice.lines.data[0]).toMatchObject({ type: 'subscription', proration: false, subscription_item: sub.items.data[0].id, price: { id: monthly.id }, plan: { id: monthly.id } });
    const payments = await rejection(stripe.invoices.retrieve(sub.latest_invoice, { expand: ['payments'] }, legacy));
    expect(payments.param).toBe('expand');

    // Subscriptions created on 2024-06-20 default to classic billing mode; classic credits unused time at the current price.
    const classic = await stripe.subscriptions.retrieve(sub.id, { expand: [] });
    expect(classic.billing_mode.type).toBe('classic');
    await account.advanceTime({ seconds: 10 * DAY });
    const up = await stripe.subscriptions.update(sub.id, { items: [{ id: sub.items.data[0].id, price: premium.id }], proration_behavior: 'always_invoice', expand: ['latest_invoice'] }, legacy);
    expect(up.latest_invoice.lines.data.map((l) => [l.type, l.proration, Boolean(l.invoice_item)])).toEqual([
      ['invoiceitem', true, true],
      ['invoiceitem', true, true],
    ]);
    const change = (await allEvents(stripe)).filter((e) => e.type === 'customer.subscription.updated').at(-1);
    expect(change.api_version).toBe('2026-08-26.dahlia');
    expect(change.data.previous_attributes.items.data[0].price.id).toBe(monthly.id);
  });

  it('rejects invalid subscription requests without creating anything', async () => {
    const t = await startServer();
    const { stripe, customer, monthly, product } = await setup(t);
    const oneTime = await stripe.prices.create({ product: product.id, unit_amount: 500, currency: 'usd' });
    const cases = [
      [{ items: [{ price: 'price_missing' }] }, 400, 'resource_missing', 'items[0][price]'],
      [{ items: [{ price: oneTime.id }] }, 400, undefined, 'items[0][price]'],
      [{ items: [{ price: monthly.id }], payment_behavior: 'pending_if_incomplete' }, 400, undefined, 'payment_behavior'],
      [{ items: [{ price: monthly.id }], proration_behavior: 'always_invoice' }, 400, undefined, 'proration_behavior'],
      [{ items: [{ price: monthly.id }], cancel_at_period_end: true, cancel_at: 'max_period_end' }, 400, 'parameters_exclusive', 'cancel_at_period_end'],
      [{ items: [{ price: monthly.id }], trial_end: 1000 }, 400, undefined, 'trial_end'],
      [{ items: [{ price: monthly.id }], collection_method: 'send_invoice' }, 400, 'parameter_missing', 'days_until_due'],
      [{ items: [{ price: monthly.id }, { price: monthly.id }] }, 400, undefined, 'items'],
      [{ items: [{ price: monthly.id }], currency: 'eur' }, 400, undefined, 'currency'],
      [{ items: [{ price: monthly.id, bogus: 1 }] }, 400, 'parameter_unknown', 'items[0][bogus]'],
    ];
    for (const [params, status, code, param] of cases) {
      const err = await rejection(stripe.subscriptions.create({ customer: customer.id, ...params }));
      expect([err.statusCode, err.code, err.param], JSON.stringify(params)).toEqual([status, code, param]);
    }
    const missing = await rejection(stripe.subscriptions.create({ customer: 'cus_missing', items: [{ price: monthly.id }] }));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([400, 'resource_missing', 'customer']);
    expect((await stripe.subscriptions.list({ status: 'all' })).data).toEqual([]);
    const notFound = await rejection(stripe.subscriptions.retrieve('sub_missing'));
    expect([notFound.statusCode, notFound.code, notFound.param]).toEqual([404, 'resource_missing', 'id']);
  });

  it('lists subscriptions by status: the default leaves out canceled ones', async () => {
    const t = await startServer();
    const { stripe, customer, monthly, basic } = await setup(t);
    const a = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: monthly.id }] });
    const b = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: basic.id }] });
    await stripe.subscriptions.cancel(a.id);
    expect((await stripe.subscriptions.list()).data.map((s) => s.id)).toEqual([b.id]);
    expect((await stripe.subscriptions.list({ status: 'canceled' })).data.map((s) => s.id)).toEqual([a.id]);
    expect((await stripe.subscriptions.list({ status: 'ended' })).data.map((s) => s.id)).toEqual([a.id]);
    expect((await stripe.subscriptions.list({ status: 'all' })).data.map((s) => s.id)).toEqual([b.id, a.id]);
    expect((await stripe.subscriptions.list({ price: basic.id })).data.map((s) => s.id)).toEqual([b.id]);
  });
});

describe('trial end without a payment method', () => {
  it('pauses (missing_payment_method=pause) and resumes once the resumption invoice is paid', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t, { card: null });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: monthly.id }],
      trial_period_days: 5,
      trial_settings: { end_behavior: { missing_payment_method: 'pause' } },
    });
    await account.advanceTime({ to: sub.trial_end - 1 });
    const before = (await allEvents(stripe)).length;
    await account.advanceTime({ to: sub.trial_end });
    const paused = await stripe.subscriptions.retrieve(sub.id);
    expect(paused.status).toBe('paused');
    expect(paused.latest_invoice).toBe(sub.latest_invoice);
    expect(typesOf(await eventsAfter(stripe, before))).toEqual(['customer.subscription.paused', 'customer.subscription.updated']);

    const resuming = await stripe.subscriptions.resume(sub.id);
    expect(resuming.status).toBe('paused');
    expect(resuming.pending_update).toMatchObject({ billing_cycle_anchor: expect.any(Number), subscription_items: null });
    const invoice = await stripe.invoices.retrieve(resuming.latest_invoice);
    expect(invoice).toMatchObject({ status: 'open', auto_advance: false, attempted: false, total: 2000 });
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await stripe.invoices.pay(invoice.id, { payment_method: pm.id });
    const active = await stripe.subscriptions.retrieve(sub.id);
    expect(active.status).toBe('active');
    expect(active.pending_update).toBeNull();
    expect(active.items.data[0].current_period_start).toBe(resuming.pending_update.billing_cycle_anchor);
    expectOrder(typesOf(await allEvents(stripe)), ['invoice.paid', 'customer.subscription.resumed', 'customer.subscription.updated']);
  });

  it('cancels at trial end when missing_payment_method=cancel', async () => {
    const t = await startServer();
    const { stripe, account, customer, monthly } = await setup(t, { card: null });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: monthly.id }],
      trial_period_days: 4,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    });
    await account.advanceTime({ to: sub.trial_end });
    const ended = await stripe.subscriptions.retrieve(sub.id);
    expect([ended.status, ended.ended_at, ended.cancellation_details.reason]).toEqual(['canceled', sub.trial_end, 'cancellation_requested']);
  });
});
