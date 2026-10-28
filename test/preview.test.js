/**
 * Mid-period plan upgrades as an app makes them at API version 2024-06-20: preview the proration
 * with invoices.createPreview (subscription_details.proration_date), then apply it with
 * subscriptions.update (always_invoice, the same proration_date, error_if_incomplete and an
 * Idempotency-Key). The charge must equal the preview; a decline must change nothing; a retry with
 * the same key must not charge again.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';

const DAY = 86400;
const VERSION = '2024-06-20';

/** A Pro product at 20 USD and 50 USD a month, and a customer whose default card is `card`. */
async function setup(t, { card = 'pm_card_visa' } = {}) {
  const stripe = t.stripe(t.key, { apiVersion: VERSION });
  const product = await stripe.products.create({ name: 'Pro' });
  const monthly = await stripe.prices.create({ product: product.id, unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } });
  const premium = await stripe.prices.create({ product: product.id, unit_amount: 5000, currency: 'usd', recurring: { interval: 'month' } });
  const customer = await stripe.customers.create({ email: 'jenny.rosen@example.com', name: 'Jenny Rosen' });
  const pm = await stripe.paymentMethods.attach(card, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  return { stripe, account: t.account(), monthly, premium, customer };
}

/** An active monthly subscription moved `offset` seconds into its first period. */
async function activeAt(ctx, offset) {
  const sub = await ctx.stripe.subscriptions.create({ customer: ctx.customer.id, items: [{ price: ctx.monthly.id }] });
  const at = sub.current_period_start + offset;
  await ctx.account.advanceTime({ to: at });
  return { sub, item: sub.items.data[0], at, start: sub.current_period_start, end: sub.current_period_end };
}

function previewUpgrade(ctx, sub, item, at, extra = {}) {
  return ctx.stripe.invoices.createPreview({
    customer: ctx.customer.id,
    subscription: sub.id,
    subscription_details: { items: [{ id: item.id, price: ctx.premium.id }], proration_behavior: 'always_invoice', proration_date: at, ...extra },
  });
}

function upgrade(ctx, sub, item, at, { key = 'upgrade-1', price = ctx.premium.id } = {}) {
  return ctx.stripe.subscriptions.update(
    sub.id,
    { items: [{ id: item.id, price }], proration_behavior: 'always_invoice', proration_date: at, payment_behavior: 'error_if_incomplete', expand: ['latest_invoice'] },
    { idempotencyKey: key },
  );
}

/** What the account holds: invoices, invoice items, events, and charges tried (a preview adds none). */
async function counts(stripe) {
  const [invoices, items, events] = await Promise.all([
    stripe.invoices.list({ limit: 100 }),
    stripe.invoiceItems.list({ limit: 100 }),
    stripe.events.list({ limit: 100 }),
  ]);
  const charges = events.data.filter((e) => e.type === 'charge.succeeded' || e.type === 'charge.failed').length;
  return { invoices: invoices.data.length, items: items.data.length, events: events.data.length, charges };
}

const prorated = (amount, at, start, end) => Math.round((amount * (end - at)) / (end - start));

describe('invoices.createPreview for a subscription update', () => {
  it('previews a mid-period upgrade by the second as an invoice, and stores and charges nothing', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at, start, end } = await activeAt(ctx, 10 * DAY + 3 * 3600 + 7);
    const before = await counts(ctx.stripe);
    const preview = await previewUpgrade(ctx, sub, item, at);

    const credit = -prorated(2000, at, start, end);
    const debit = prorated(5000, at, start, end);
    expect(preview).toMatchObject({
      object: 'invoice',
      customer: ctx.customer.id,
      subscription: sub.id,
      subscription_proration_date: at,
      billing_reason: 'subscription_update',
      status: 'draft',
      currency: 'usd',
      subtotal: credit + debit,
      total: credit + debit,
      amount_due: credit + debit,
      amount_paid: 0,
      period_start: at,
      period_end: at,
      paid: false,
      payment_intent: null,
    });
    expect(preview.id).toMatch(/^upcoming_in_/);
    const day = new Date(at * 1000).toUTCString().slice(5, 16);
    expect(preview.lines.data.map((l) => [l.description, l.amount, l.proration, l.type, l.period, l.price.id, l.subscription_item])).toEqual([
      [`Unused time on Pro after ${day}`, credit, true, 'invoiceitem', { start: at, end }, ctx.monthly.id, item.id],
      [`Remaining time on Pro after ${day}`, debit, true, 'invoiceitem', { start: at, end }, ctx.premium.id, item.id],
    ]);
    expect(preview.lines.data.every((l) => l.id.startsWith('il_tmp_') && l.discountable === false)).toBe(true);

    expect(await counts(ctx.stripe)).toEqual(before);
    const unchanged = await ctx.stripe.subscriptions.retrieve(sub.id);
    expect([unchanged.items.data[0].price.id, unchanged.latest_invoice]).toEqual([ctx.monthly.id, sub.latest_invoice]);
    const missing = await rejection(ctx.stripe.invoices.retrieve(preview.id));
    expect([missing.statusCode, missing.code]).toEqual([404, 'resource_missing']);
  });

  it('previews the last day of the period', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const sub = await ctx.stripe.subscriptions.create({ customer: ctx.customer.id, items: [{ price: ctx.monthly.id }] });
    const { current_period_start: start, current_period_end: end } = sub;
    const at = end - DAY;
    await ctx.account.advanceTime({ to: at });
    const preview = await previewUpgrade(ctx, sub, sub.items.data[0], at);
    const credit = -prorated(2000, at, start, end);
    const debit = prorated(5000, at, start, end);
    expect(preview.lines.data.map((l) => [l.amount, l.period])).toEqual([
      [credit, { start: at, end }],
      [debit, { start: at, end }],
    ]);
    expect(preview.amount_due).toBe(credit + debit);
    // About a thirtieth of the 30 USD difference.
    expect(preview.amount_due).toBeGreaterThan(90);
    expect(preview.amount_due).toBeLessThan(110);
  });

  it('previews the first paid period of a trialing subscription: an upgrade in a trial has no prorations and charges nothing now', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const sub = await ctx.stripe.subscriptions.create({ customer: ctx.customer.id, items: [{ price: ctx.monthly.id }], trial_period_days: 14 });
    const at = sub.current_period_start + 3 * DAY;
    await ctx.account.advanceTime({ to: at });
    const before = await counts(ctx.stripe);
    const preview = await previewUpgrade(ctx, sub, sub.items.data[0], at);
    // Stripe previews the next invoice, the one at the end of the trial, at the new price.
    expect(preview.lines.data.filter((l) => l.proration)).toEqual([]);
    expect(preview.lines.data.map((l) => [l.amount, l.type, l.price.id, l.period.start])).toEqual([[5000, 'subscription', ctx.premium.id, sub.trial_end]]);
    expect(preview).toMatchObject({ billing_reason: 'upcoming', amount_due: 5000, period_end: sub.trial_end, created: sub.trial_end });

    const updated = await upgrade(ctx, sub, sub.items.data[0], at);
    expect([updated.status, updated.items.data[0].price.id, updated.latest_invoice.id]).toEqual(['trialing', ctx.premium.id, sub.latest_invoice]);
    expect(updated.latest_invoice.amount_paid).toBe(0);
    const after = await counts(ctx.stripe);
    expect([after.invoices, after.charges]).toEqual([before.invoices, before.charges]);
  });

  it('with create_prorations previews the next invoice: the prorations, then the next period at the new price', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at, start, end } = await activeAt(ctx, 12 * DAY);
    const preview = await previewUpgrade(ctx, sub, item, at, { proration_behavior: 'create_prorations' });
    const credit = -prorated(2000, at, start, end);
    const debit = prorated(5000, at, start, end);
    expect(preview.lines.data.map((l) => [l.amount, l.proration, l.period.start])).toEqual([
      [credit, true, at],
      [debit, true, at],
      [5000, false, end],
    ]);
    expect(preview).toMatchObject({ billing_reason: 'upcoming', amount_due: credit + debit + 5000, period_start: start, period_end: end });
  });

  it('rejects a proration_date outside the current period and parameters it does not model', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, end } = await activeAt(ctx, DAY);
    const late = await rejection(previewUpgrade(ctx, sub, item, end + 1));
    expect([late.statusCode, late.param]).toEqual([400, 'subscription_details[proration_date]']);
    const none = await rejection(previewUpgrade(ctx, sub, item, end - DAY, { proration_behavior: 'none' }));
    expect([none.statusCode, none.param]).toEqual([400, 'subscription_details[proration_behavior]']);
    const schedule = await rejection(ctx.stripe.invoices.createPreview({ customer: ctx.customer.id, schedule: 'sub_sched_123' }));
    expect([schedule.statusCode, schedule.param]).toEqual([400, 'schedule']);
    const other = await ctx.stripe.customers.create({ email: 'other@example.com' });
    const wrongCustomer = await rejection(ctx.stripe.invoices.createPreview({ customer: other.id, subscription: sub.id }));
    expect([wrongCustomer.statusCode, wrongCustomer.param]).toEqual([400, 'customer']);
  });
});

describe('mid-period upgrade with always_invoice', () => {
  it('charges exactly the previewed amount, switches the price and keeps the billing period', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at, end } = await activeAt(ctx, 17 * DAY + 41);
    const preview = await previewUpgrade(ctx, sub, item, at);
    // The update runs later than the preview; proration_date pins the amount.
    await ctx.account.advanceTime({ to: at + 2 * 3600 });
    const updated = await upgrade(ctx, sub, item, at);

    expect(updated.items.data.map((i) => [i.id, i.price.id])).toEqual([[item.id, ctx.premium.id]]);
    expect([updated.status, updated.current_period_end]).toEqual(['active', end]);
    const invoice = updated.latest_invoice;
    expect(invoice).toMatchObject({ status: 'paid', billing_reason: 'subscription_update', subscription_proration_date: at, paid: true });
    expect([invoice.amount_due, invoice.amount_paid, invoice.total]).toEqual([preview.amount_due, preview.amount_due, preview.total]);
    expect(invoice.lines.data.map((l) => [l.description, l.amount, l.period, l.proration])).toEqual(
      preview.lines.data.map((l) => [l.description, l.amount, l.period, l.proration]),
    );
    const pi = await ctx.stripe.paymentIntents.retrieve(invoice.payment_intent);
    expect([pi.status, pi.amount, pi.customer]).toEqual(['succeeded', preview.amount_due, ctx.customer.id]);
  });

  it('answers a declined card with a 402 card_error and leaves the subscription unchanged', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at } = await activeAt(ctx, 10 * DAY);
    // The customer's card now attaches but declines every charge (Stripe's 4000 0000 0000 0341).
    const failing = await ctx.stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: ctx.customer.id });
    await ctx.stripe.customers.update(ctx.customer.id, { invoice_settings: { default_payment_method: failing.id } });
    const before = await counts(ctx.stripe);
    const subBefore = await ctx.stripe.subscriptions.retrieve(sub.id);

    const err = await rejection(upgrade(ctx, sub, item, at));
    expect([err.statusCode, err.type, err.raw.type, err.code, err.decline_code]).toEqual([402, 'StripeCardError', 'card_error', 'card_declined', 'generic_decline']);

    const subAfter = await ctx.stripe.subscriptions.retrieve(sub.id);
    expect(subAfter).toEqual(subBefore);
    const after = await counts(ctx.stripe);
    expect([after.invoices, after.items]).toEqual([before.invoices, before.items]);
    expect((await ctx.stripe.invoiceItems.list({ customer: ctx.customer.id, pending: true })).data).toEqual([]);
  });

  it('a failNextCharge decline leaves it unchanged too, and the upgrade succeeds on a new key', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at } = await activeAt(ctx, 5 * DAY);
    await ctx.account.failNextCharge(ctx.customer.id, { declineCode: 'insufficient_funds' });
    const err = await rejection(upgrade(ctx, sub, item, at, { key: 'attempt-1' }));
    expect([err.statusCode, err.code, err.decline_code]).toEqual([402, 'card_declined', 'insufficient_funds']);
    expect((await ctx.stripe.subscriptions.retrieve(sub.id)).items.data[0].price.id).toBe(ctx.monthly.id);
    // The same key replays the saved 402 without trying the card again.
    const tried = (await counts(ctx.stripe)).charges;
    const replay = await rejection(upgrade(ctx, sub, item, at, { key: 'attempt-1' }));
    expect([replay.statusCode, replay.decline_code, replay.headers['idempotent-replayed']]).toEqual([402, 'insufficient_funds', 'true']);
    expect((await counts(ctx.stripe)).charges).toBe(tried);
    const ok = await upgrade(ctx, sub, item, at, { key: 'attempt-2' });
    expect([ok.items.data[0].price.id, ok.latest_invoice.status]).toEqual([ctx.premium.id, 'paid']);
  });

  it('is idempotent: a retry with the same key and body replays the response without charging again', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at } = await activeAt(ctx, 9 * DAY);
    const first = await upgrade(ctx, sub, item, at);
    const afterFirst = await counts(ctx.stripe);
    const retry = await upgrade(ctx, sub, item, at);
    expect(retry).toEqual(first);
    expect(retry.lastResponse.headers['idempotent-replayed']).toBe('true');
    expect(await counts(ctx.stripe)).toEqual(afterFirst);
    expect(afterFirst.charges).toBe(2); // the first invoice and the upgrade
  });

  it('answers 400 idempotency_error for the same key with a different body', async () => {
    const t = await startServer();
    const ctx = await setup(t);
    const { sub, item, at } = await activeAt(ctx, 9 * DAY);
    await upgrade(ctx, sub, item, at);
    const before = await counts(ctx.stripe);
    const err = await rejection(upgrade(ctx, sub, item, at, { price: ctx.monthly.id }));
    expect([err.statusCode, err.type, err.raw.type]).toEqual([400, 'StripeIdempotencyError', 'idempotency_error']);
    expect(await counts(ctx.stripe)).toEqual(before);
    expect((await ctx.stripe.subscriptions.retrieve(sub.id)).items.data[0].price.id).toBe(ctx.premium.id);
  });
});
