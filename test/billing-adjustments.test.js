/** Billing adjustments through the official SDK, including failures and signed deliveries. */
import { describe, expect, it } from 'vitest';
import { rejection, startServer, webhookReceiver } from './helpers.js';

const OLD = '2024-06-20';
const LATEST = '2026-08-26.dahlia';
const HOUR = 3600;
const DAY = 86400;
const SECRET = 'whsec_billing_adjustments';

async function setup({ version = LATEST, card = true, clock = false, options = {} } = {}) {
  const t = await startServer({ apiVersion: version, ...options });
  const stripe = t.stripe(t.key, { apiVersion: version });
  const testClock = clock ? await stripe.testHelpers.testClocks.create({ frozen_time: 1720000000 }) : null;
  const customer = await stripe.customers.create({ email: 'billing@example.com', ...(testClock ? { test_clock: testClock.id } : {}) });
  if (card) {
    const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  }
  return { ...t, client: t.stripe, stripe, version, customer, testClock, account: t.account() };
}

async function paidInvoice(t) {
  const product = await t.stripe.products.create({ name: 'Service' });
  const price = await t.stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 2000, recurring: { interval: 'month' } });
  const sub = await t.stripe.subscriptions.create({ customer: t.customer.id, items: [{ price: price.id }] });
  const invoice = await t.stripe.invoices.retrieve(sub.latest_invoice);
  const payments = t.version === OLD ? null : await t.stripe.invoicePayments.list({ invoice: invoice.id });
  const pi = invoice.payment_intent ?? payments.data[0].payment.payment_intent;
  const charge = (await t.stripe.paymentIntents.retrieve(pi)).latest_charge;
  return { invoice, sub, charge, pi };
}

async function openInvoice(t, amount = 2000) {
  const invoice = await t.stripe.invoices.create({ customer: t.customer.id });
  await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: invoice.id, amount, currency: 'usd', description: 'Consulting' });
  return t.stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
}

async function events(t, type) {
  return (await t.stripe.events.list({ type, limit: 100 })).data.reverse();
}

describe.each([OLD, LATEST])('invoice items at %s', (version) => {
  it('creates decimal items, rounds the extended amount, validates input and replays idempotently', async () => {
    const t = await setup({ version });
    const params = { customer: t.customer.id, currency: 'usd', unit_amount_decimal: '0.499999999999', quantity: 3, description: 'Usage', metadata: { order: 'a' } };
    const item = await t.stripe.invoiceItems.create(params, { idempotencyKey: 'usage' });
    expect(item).toMatchObject({ object: 'invoiceitem', amount: 1, quantity: 3, invoice: null, description: 'Usage', metadata: { order: 'a' } });
    expect((await t.stripe.invoiceItems.create(params, { idempotencyKey: 'usage' })).id).toBe(item.id);
    expect(await events(t, 'invoiceitem.created')).toHaveLength(1);
    for (const [sent, param] of [
      [{ customer: 'cus_missing', currency: 'usd', amount: 100 }, 'customer'],
      [{ customer: t.customer.id, currency: 'usd', amount: 100, unit_amount_decimal: '1' }, 'unit_amount_decimal'],
      [{ customer: t.customer.id, currency: 'usd', unit_amount_decimal: '1', quantity: -1 }, 'quantity'],
      [{ customer: t.customer.id, currency: 'usd' }, 'amount'],
    ]) expect(await rejection(t.stripe.invoiceItems.create(sent))).toMatchObject({ type: 'StripeInvalidRequestError', param });
    const tie = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', unit_amount_decimal: '-0.5', quantity: 3 });
    expect(tie.amount).toBe(-2);
  });

  it('retrieves and expands an item; foreign and unknown IDs are missing', async () => {
    const t = await setup({ version });
    const item = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 100 });
    expect((await t.stripe.invoiceItems.retrieve(item.id, { expand: ['customer'] })).customer.id).toBe(t.customer.id);
    expect(await rejection(t.stripe.invoiceItems.retrieve('ii_missing'))).toMatchObject({ statusCode: 404, code: 'resource_missing' });
    expect(await rejection(t.client('sk_test_other').invoiceItems.retrieve(item.id))).toMatchObject({ statusCode: 404, code: 'resource_missing' });
  });

  it('updates pending and draft-attached items atomically and refuses finalized item amounts', async () => {
    const t = await setup({ version });
    const draft = await t.stripe.invoices.create({ customer: t.customer.id });
    const item = await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', amount: 100, metadata: { a: '1' } });
    const changed = await t.stripe.invoiceItems.update(item.id, { unit_amount_decimal: '125.5', quantity: 2, description: 'Adjusted', metadata: { a: '', b: '2' } });
    expect(changed).toMatchObject({ amount: 251, quantity: 2, metadata: { b: '2' } });
    expect((await t.stripe.invoices.retrieve(draft.id)).lines.data[0]).toMatchObject({ amount: 251, description: 'Adjusted', metadata: { b: '2' } });
    expect((await events(t, 'invoiceitem.updated')).at(-1).data.previous_attributes).toMatchObject({ amount: 100, quantity: 1 });
    expect((await t.stripe.invoices.retrieve(draft.id)).total).toBe(251);
    expect(await rejection(t.stripe.invoiceItems.update(item.id, { quantity: -1, metadata: { bad: 'value' } }))).toMatchObject({ param: 'quantity' });
    expect((await t.stripe.invoiceItems.retrieve(item.id)).metadata).toEqual({ b: '2' });
    await t.stripe.invoices.finalizeInvoice(draft.id);
    expect(await rejection(t.stripe.invoiceItems.update(item.id, { amount: 999 }))).toMatchObject({ statusCode: 400 });
    expect(await rejection(t.stripe.invoiceItems.update('ii_missing', { description: 'x' }))).toMatchObject({ statusCode: 404 });
  });

  it('deletes pending items only, emits a snapshot and excludes them from retrieval and lists', async () => {
    const t = await setup({ version });
    const item = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 100 });
    expect(await t.stripe.invoiceItems.del(item.id)).toMatchObject({ id: item.id, object: 'invoiceitem', deleted: true });
    expect((await events(t, 'invoiceitem.deleted'))[0].data.object.amount).toBe(100);
    expect(await rejection(t.stripe.invoiceItems.retrieve(item.id))).toMatchObject({ statusCode: 404 });
    expect(await rejection(t.stripe.invoiceItems.del(item.id))).toMatchObject({ statusCode: 404 });
    const draft = await t.stripe.invoices.create({ customer: t.customer.id });
    const attached = await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', amount: 100 });
    expect(await rejection(t.stripe.invoiceItems.del(attached.id))).toMatchObject({ statusCode: 400 });
    expect((await t.stripe.invoiceItems.list({ customer: t.customer.id })).data.map((x) => x.id)).toEqual([attached.id]);
  });

  it('lists with customer, invoice, pending and cursor filters and validates pagination', async () => {
    const t = await setup({ version });
    const a = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 100 });
    const b = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 200 });
    const draft = await t.stripe.invoices.create({ customer: t.customer.id });
    const c = await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', amount: 300 });
    const other = await t.stripe.customers.create();
    await t.stripe.invoiceItems.create({ customer: other.id, currency: 'usd', amount: 400 });
    const first = await t.stripe.invoiceItems.list({ customer: t.customer.id, pending: true, limit: 1 });
    expect(first).toMatchObject({ has_more: true, data: [{ id: b.id }] });
    expect(await t.stripe.invoiceItems.list({ customer: t.customer.id, pending: true, limit: 1, starting_after: b.id })).toMatchObject({ has_more: false, data: [{ id: a.id }] });
    expect((await t.stripe.invoiceItems.list({ invoice: draft.id, pending: false })).data.map((x) => x.id)).toEqual([c.id]);
    expect(await rejection(t.stripe.invoiceItems.list({ limit: 0 }))).toMatchObject({ param: 'limit' });
    expect(await rejection(t.stripe.invoiceItems.list({ starting_after: 'ii_missing' }))).toMatchObject({ param: 'starting_after', code: 'resource_missing' });
  });
});

describe('manual invoices', () => {
  it('creates drafts with explicit include/exclude and idempotency, validates customer and subscription ownership', async () => {
    const t = await setup();
    const { sub } = await paidInvoice(t);
    const item = await t.stripe.invoiceItems.create({ customer: t.customer.id, subscription: sub.id, amount: 350, currency: 'usd' });
    const excluded = await t.stripe.invoices.create({ customer: t.customer.id, subscription: sub.id, pending_invoice_items_behavior: 'exclude' });
    expect(excluded).toMatchObject({ status: 'draft', auto_advance: false, total: 0 });
    expect((await t.stripe.invoiceItems.retrieve(item.id)).invoice).toBeNull();
    const p = { customer: t.customer.id, subscription: sub.id, pending_invoice_items_behavior: 'include', description: 'Final work', metadata: { order: 'x' } };
    const draft = await t.stripe.invoices.create(p, { idempotencyKey: 'final' });
    expect(draft).toMatchObject({ status: 'draft', total: 350, billing_reason: 'manual', description: 'Final work', metadata: { order: 'x' } });
    expect((await t.stripe.invoiceItems.retrieve(item.id)).invoice).toBe(draft.id);
    expect((await t.stripe.invoices.create(p, { idempotencyKey: 'final' })).id).toBe(draft.id);
    const other = await t.stripe.customers.create();
    expect(await rejection(t.stripe.invoices.create({ customer: other.id, subscription: sub.id }))).toMatchObject({ statusCode: 400, param: 'subscription' });
    expect(await rejection(t.stripe.invoices.create({ customer: 'cus_missing' }))).toMatchObject({ param: 'customer', code: 'resource_missing' });
    expect(await rejection(t.stripe.invoiceItems.create({ customer: other.id, invoice: draft.id, amount: 100, currency: 'usd' }))).toMatchObject({ param: 'invoice' });
    expect(await rejection(t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, amount: 100, currency: 'eur' }))).toMatchObject({ param: 'currency' });
  });

  it('updates draft metadata and automation; disabling automation stops scheduled collection', async () => {
    const t = await setup();
    const draft = await t.stripe.invoices.create({ customer: t.customer.id, auto_advance: true, metadata: { a: '1' } });
    await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, amount: 100, currency: 'usd' });
    expect(await t.stripe.invoices.update(draft.id, { auto_advance: false, description: 'Updated', metadata: { a: '', b: '2' } })).toMatchObject({ auto_advance: false, description: 'Updated', metadata: { b: '2' } });
    await t.account.advanceTime({ seconds: 2 * HOUR });
    expect((await t.stripe.invoices.retrieve(draft.id)).status).toBe('draft');
    expect(await rejection(t.stripe.invoices.update('in_missing', { description: 'x' }))).toMatchObject({ statusCode: 404 });
    await t.stripe.invoices.finalizeInvoice(draft.id);
    expect(await rejection(t.stripe.invoices.update(draft.id, { collection_method: 'send_invoice' }))).toMatchObject({ statusCode: 400 });
  });

  it('deletes drafts and attached items and refuses deletion of finalized invoices', async () => {
    const t = await setup();
    const draft = await t.stripe.invoices.create({ customer: t.customer.id, auto_advance: true });
    const ii = await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, amount: 100, currency: 'usd' });
    expect(await t.stripe.invoices.del(draft.id)).toEqual({ id: draft.id, object: 'invoice', deleted: true });
    expect(await rejection(t.stripe.invoices.retrieve(draft.id))).toMatchObject({ statusCode: 404 });
    expect(await rejection(t.stripe.invoiceItems.retrieve(ii.id))).toMatchObject({ statusCode: 404 });
    expect((await t.stripe.invoices.list({ customer: t.customer.id })).data).toEqual([]);
    const open = await openInvoice(t);
    expect(await rejection(t.stripe.invoices.del(open.id))).toMatchObject({ statusCode: 400 });
    expect(await rejection(t.stripe.invoices.del('in_missing'))).toMatchObject({ statusCode: 404 });
  });

  it('lists invoices by customer and subscription with cursor pagination', async () => {
    const t = await setup();
    const { invoice, sub } = await paidInvoice(t);
    const draft = await t.stripe.invoices.create({ customer: t.customer.id, subscription: sub.id });
    await t.stripe.invoices.create({ customer: t.customer.id });
    const first = await t.stripe.invoices.list({ customer: t.customer.id, subscription: sub.id, limit: 1 });
    expect(first).toMatchObject({ has_more: true, data: [{ id: draft.id }] });
    expect(await t.stripe.invoices.list({ subscription: sub.id, limit: 1, starting_after: draft.id })).toMatchObject({ has_more: false, data: [{ id: invoice.id }] });
    expect(await rejection(t.stripe.invoices.list({ limit: 101 }))).toMatchObject({ param: 'limit' });
  });

  it('includes a mid-period subscription item at test-clock renewal and charges it exactly once', async () => {
    const t = await setup({ clock: true });
    const { sub } = await paidInvoice(t);
    const otherProduct = await t.stripe.products.create({ name: 'Other' });
    const otherPrice = await t.stripe.prices.create({ product: otherProduct.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
    const other = await t.stripe.subscriptions.create({ customer: t.customer.id, items: [{ price: otherPrice.id }] });
    await t.stripe.testHelpers.testClocks.advance(t.testClock.id, { frozen_time: sub.created + 10 * DAY });
    const scoped = await t.stripe.invoiceItems.create({ customer: t.customer.id, subscription: sub.id, currency: 'usd', amount: 450, description: 'Extra work' });
    const otherItem = await t.stripe.invoiceItems.create({ customer: t.customer.id, subscription: other.id, currency: 'usd', amount: 70 });
    const pending = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 80 });
    await t.stripe.testHelpers.testClocks.advance(t.testClock.id, { frozen_time: sub.items.data[0].current_period_end + HOUR });
    const renewed = await t.stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(renewed.latest_invoice).toMatchObject({ status: 'paid', amount_paid: 2530 });
    expect(renewed.latest_invoice.lines.data.map((l) => l.amount)).toEqual(expect.arrayContaining([2000, 450, 80]));
    expect((await t.stripe.invoiceItems.retrieve(scoped.id)).invoice).toBe(renewed.latest_invoice.id);
    expect((await t.stripe.invoiceItems.retrieve(pending.id)).invoice).toBe(renewed.latest_invoice.id);
    const otherRenewed = await t.stripe.subscriptions.retrieve(other.id, { expand: ['latest_invoice'] });
    expect(otherRenewed.latest_invoice.amount_paid).toBe(1070);
    expect((await t.stripe.invoiceItems.retrieve(otherItem.id)).invoice).toBe(otherRenewed.latest_invoice.id);
    await t.stripe.testHelpers.testClocks.advance(t.testClock.id, { frozen_time: renewed.items.data[0].current_period_end + HOUR });
    const next = await t.stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
    expect(next.latest_invoice.amount_paid).toBe(2000);
    expect((await t.stripe.invoiceItems.list({ customer: t.customer.id, pending: true })).data).toEqual([]);
  });

  it('creates a final invoice from pending items, finalizes, pays and displays every line', async () => {
    const t = await setup({ version: OLD });
    const item = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 1200, description: 'Final consulting' });
    const draft = await t.stripe.invoices.create({ customer: t.customer.id, pending_invoice_items_behavior: 'include', auto_advance: true });
    const open = await t.stripe.invoices.finalizeInvoice(draft.id);
    expect(open.status).toBe('open');
    expect(await (await fetch(open.hosted_invoice_url)).text()).toContain('Final consulting');
    await t.account.advanceTime({ seconds: HOUR });
    const paid = await t.stripe.invoices.retrieve(draft.id, { expand: ['payment_intent', 'charge'] });
    expect(paid).toMatchObject({ status: 'paid', amount_paid: 1200, payment_intent: { amount: 1200, status: 'succeeded' }, charge: { amount: 1200 } });
    expect((await t.stripe.invoiceItems.retrieve(item.id)).invoice).toBe(draft.id);
    expect(await rejection(t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: paid.id, currency: 'usd', amount: 1 }))).toMatchObject({ statusCode: 400, param: 'invoice' });
  });

  it('retries a manually created automatic invoice through the existing dunning engine', async () => {
    const t = await setup({ options: { billing: { retrySchedule: [1] } } });
    await t.account.failNextCharge(t.customer.id);
    await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 1200 });
    const draft = await t.stripe.invoices.create({ customer: t.customer.id, pending_invoice_items_behavior: 'include', auto_advance: true });
    await t.stripe.invoices.finalizeInvoice(draft.id);
    await t.account.advanceTime({ seconds: HOUR });
    expect(await t.stripe.invoices.retrieve(draft.id)).toMatchObject({ status: 'open', attempt_count: 1 });
    await t.account.advanceTime({ seconds: DAY });
    expect(await t.stripe.invoices.retrieve(draft.id)).toMatchObject({ status: 'paid', amount_paid: 1200, attempt_count: 2 });
    expect(await events(t, 'invoice.payment_failed')).toHaveLength(1);
  });
});

describe.each([OLD, LATEST])('refunds at %s', (version) => {
  it('creates partial and full refunds by charge or PaymentIntent, updates charge totals, and refuses over-refunds', async () => {
    const t = await setup({ version });
    const { charge, pi } = await paidInvoice(t);
    const refund = await t.stripe.refunds.create({ charge, amount: 500, reason: 'requested_by_customer', metadata: { order: 'x' } }, { idempotencyKey: 'refund' });
    expect(refund).toMatchObject({ object: 'refund', charge, payment_intent: pi, amount: 500, status: 'succeeded', reason: 'requested_by_customer' });
    expect((await t.stripe.refunds.create({ charge, amount: 500, reason: 'requested_by_customer', metadata: { order: 'x' } }, { idempotencyKey: 'refund' })).id).toBe(refund.id);
    expect(await t.stripe.charges.retrieve(charge, { expand: ['refunds'] })).toMatchObject({ amount_refunded: 500, refunded: false, refunds: { data: [{ id: refund.id }] } });
    expect(await rejection(t.stripe.refunds.create({ charge, amount: 1501 }))).toMatchObject({ statusCode: 400, param: 'amount' });
    expect(await rejection(t.stripe.refunds.create({ charge, amount: 0 }))).toMatchObject({ param: 'amount' });
    expect(await rejection(t.stripe.refunds.create({ charge, payment_intent: pi }))).toMatchObject({ code: 'parameters_exclusive' });
    expect(await rejection(t.stripe.refunds.create({ charge: 'ch_missing' }))).toMatchObject({ code: 'resource_missing', param: 'charge' });
    expect(await t.stripe.refunds.create({ payment_intent: pi })).toMatchObject({ amount: 1500 });
    expect(await t.stripe.charges.retrieve(charge)).toMatchObject({ amount_refunded: 2000, refunded: true });
    expect(await rejection(t.stripe.refunds.create({ charge }))).toMatchObject({ code: 'charge_already_refunded' });
    expect(await events(t, 'charge.refunded')).toHaveLength(2);
  });

  it('retrieves and expands refunds and rejects unknown or foreign IDs', async () => {
    const t = await setup({ version });
    const { charge } = await paidInvoice(t);
    const r = await t.stripe.refunds.create({ charge, amount: 100 });
    expect((await t.stripe.refunds.retrieve(r.id, { expand: ['charge'] })).charge.id).toBe(charge);
    expect(await rejection(t.stripe.refunds.retrieve('re_missing'))).toMatchObject({ statusCode: 404 });
    expect(await rejection(t.client('sk_test_other').refunds.retrieve(r.id))).toMatchObject({ statusCode: 404 });
  });

  it('updates refund metadata with previous_attributes and rejects unsupported fields', async () => {
    const t = await setup({ version });
    const { charge } = await paidInvoice(t);
    const r = await t.stripe.refunds.create({ charge, amount: 100, metadata: { a: '1' } });
    expect((await t.stripe.refunds.update(r.id, { metadata: { a: '', b: '2' } })).metadata).toEqual({ b: '2' });
    expect((await events(t, 'refund.updated')).at(-1).data.previous_attributes).toEqual({ metadata: { a: '1', b: null } });
    expect(await rejection(t.stripe.refunds.update('re_missing', { metadata: {} }))).toMatchObject({ statusCode: 404 });
    expect(await rejection(t.stripe.refunds.update(r.id, { amount: 999 }))).toMatchObject({ code: 'parameter_unknown', param: 'amount' });
  });

  it('lists refunds by charge or PaymentIntent with pagination and errors', async () => {
    const t = await setup({ version });
    const { charge, pi } = await paidInvoice(t);
    const a = await t.stripe.refunds.create({ charge, amount: 100 });
    const b = await t.stripe.refunds.create({ charge, amount: 200 });
    const other = await paidInvoice(t);
    await t.stripe.refunds.create({ charge: other.charge, amount: 300 });
    expect(await t.stripe.refunds.list({ charge, limit: 1 })).toMatchObject({ has_more: true, data: [{ id: b.id }] });
    expect(await t.stripe.refunds.list({ payment_intent: pi, limit: 1, starting_after: b.id })).toMatchObject({ has_more: false, data: [{ id: a.id }] });
    expect(await rejection(t.stripe.refunds.list({ limit: 0 }))).toMatchObject({ param: 'limit' });
    expect(await rejection(t.stripe.refunds.list({ starting_after: 're_missing' }))).toMatchObject({ param: 'starting_after', code: 'resource_missing' });
  });

  it('allows cancellation only in requires_action and restores refundable capacity', async () => {
    const t = await setup({ version });
    const { charge } = await paidInvoice(t);
    const r = await t.stripe.refunds.create({ charge, amount: 100 });
    expect(await rejection(t.stripe.refunds.cancel(r.id))).toMatchObject({ statusCode: 400 });
    // Cards never enter requires_action; arrange the documented state to exercise the endpoint.
    t.server.context.accounts.get(t.key).store.get('refund', r.id).status = 'requires_action';
    expect(await t.stripe.refunds.cancel(r.id)).toMatchObject({ status: 'canceled', failure_reason: 'merchant_request' });
    expect((await t.stripe.charges.retrieve(charge)).amount_refunded).toBe(0);
    expect(await rejection(t.stripe.refunds.cancel('re_missing'))).toMatchObject({ statusCode: 404 });
    expect((await t.stripe.refunds.create({ charge })).amount).toBe(2000);
  });
});

describe.each([OLD, LATEST])('credit notes at %s', (version) => {
  it('creates a credit note with a refund on a paid invoice, updates amounts and emits events', async () => {
    const t = await setup({ version });
    const { invoice, charge } = await paidInvoice(t);
    const p = { invoice: invoice.id, amount: 700, refund_amount: 500, credit_amount: 100, out_of_band_amount: 100, reason: 'order_change', memo: 'Adjustment', metadata: { case: '1' } };
    const note = await t.stripe.creditNotes.create(p, { idempotencyKey: 'credit' });
    expect(note).toMatchObject({ object: 'credit_note', amount: 700, total: 700, type: 'post_payment', status: 'issued', memo: 'Adjustment' });
    const refundId = version === OLD ? note.refund : note.refunds[0].refund;
    expect(refundId).toMatch(/^re_/);
    expect(await t.stripe.refunds.retrieve(refundId)).toMatchObject({ charge, amount: 500 });
    expect(await t.stripe.invoices.retrieve(invoice.id)).toMatchObject({ amount_due: 2000, amount_paid: 2000, amount_remaining: 0, total: 2000, post_payment_credit_notes_amount: 700, pre_payment_credit_notes_amount: 0 });
    expect((await t.stripe.customers.retrieve(t.customer.id)).balance).toBe(-100);
    expect((await t.stripe.creditNotes.create(p, { idempotencyKey: 'credit' })).id).toBe(note.id);
    expect(await events(t, 'credit_note.created')).toHaveLength(1);
    expect(await events(t, 'refund.created')).toHaveLength(1);
    expect(await events(t, 'charge.refunded')).toHaveLength(1);
    expect(await rejection(t.stripe.creditNotes.create({ invoice: invoice.id, amount: 2000, refund_amount: 2000 }))).toMatchObject({ statusCode: 400 });
    expect(await rejection(t.stripe.creditNotes.create({ invoice: invoice.id, amount: 100 }))).toMatchObject({ statusCode: 400 });
    expect(await rejection(t.stripe.creditNotes.create({ invoice: 'in_missing', amount: 100 }))).toMatchObject({ param: 'invoice', code: 'resource_missing' });
  });

  it('retrieves and expands a credit note and refuses missing or foreign IDs', async () => {
    const t = await setup({ version });
    const { invoice } = await paidInvoice(t);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 100, refund_amount: 100 });
    expect((await t.stripe.creditNotes.retrieve(note.id, { expand: ['invoice', 'customer'] })).invoice.id).toBe(invoice.id);
    expect(await rejection(t.stripe.creditNotes.retrieve('cn_missing'))).toMatchObject({ statusCode: 404 });
    expect(await rejection(t.client('sk_test_other').creditNotes.retrieve(note.id))).toMatchObject({ statusCode: 404 });
  });

  it('updates memo and metadata and reports previous attributes', async () => {
    const t = await setup({ version });
    const { invoice } = await paidInvoice(t);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 100, out_of_band_amount: 100, memo: 'Before', metadata: { a: '1' } });
    expect(await t.stripe.creditNotes.update(note.id, { memo: 'After', metadata: { a: '', b: '2' } })).toMatchObject({ memo: 'After', metadata: { b: '2' } });
    expect((await events(t, 'credit_note.updated')).at(-1).data.previous_attributes).toEqual({ memo: 'Before', metadata: { a: '1', b: null } });
    expect(await rejection(t.stripe.creditNotes.update('cn_missing', { memo: 'x' }))).toMatchObject({ statusCode: 404 });
    expect(await rejection(t.stripe.creditNotes.update(note.id, { amount: 1 }))).toMatchObject({ code: 'parameter_unknown', param: 'amount' });
  });

  it('lists by customer and invoice with pagination', async () => {
    const t = await setup({ version });
    const { invoice } = await paidInvoice(t);
    const a = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 100, out_of_band_amount: 100 });
    const b = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 200, out_of_band_amount: 200 });
    const other = await paidInvoice(t);
    await t.stripe.creditNotes.create({ invoice: other.invoice.id, amount: 300, out_of_band_amount: 300 });
    expect(await t.stripe.creditNotes.list({ invoice: invoice.id, customer: t.customer.id, limit: 1 })).toMatchObject({ has_more: true, data: [{ id: b.id }] });
    expect(await t.stripe.creditNotes.list({ invoice: invoice.id, limit: 1, starting_after: b.id })).toMatchObject({ has_more: false, data: [{ id: a.id }] });
    expect(await rejection(t.stripe.creditNotes.list({ limit: 0 }))).toMatchObject({ param: 'limit' });
    expect(await rejection(t.stripe.creditNotes.list({ starting_after: 'cn_missing' }))).toMatchObject({ param: 'starting_after' });
  });

  it('voids a pre-payment credit note, restores invoice amounts and refuses paid-invoice voids', async () => {
    const t = await setup({ version });
    const invoice = await openInvoice(t);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, lines: [{ type: 'invoice_line_item', invoice_line_item: invoice.lines.data[0].id, amount: 500 }] });
    expect(await t.stripe.invoices.retrieve(invoice.id)).toMatchObject({ amount_due: 1500, amount_remaining: 1500, pre_payment_credit_notes_amount: 500, total: 2000 });
    expect(await t.stripe.creditNotes.voidCreditNote(note.id)).toMatchObject({ status: 'void', voided_at: expect.any(Number) });
    expect(await t.stripe.invoices.retrieve(invoice.id)).toMatchObject({ amount_due: 2000, amount_remaining: 2000, pre_payment_credit_notes_amount: 0 });
    expect(await rejection(t.stripe.creditNotes.voidCreditNote(note.id))).toMatchObject({ statusCode: 400 });
    expect(await rejection(t.stripe.creditNotes.voidCreditNote('cn_missing'))).toMatchObject({ statusCode: 404 });
    expect(await events(t, 'credit_note.voided')).toHaveLength(1);
    const paid = await paidInvoice(t);
    const post = await t.stripe.creditNotes.create({ invoice: paid.invoice.id, amount: 100, refund_amount: 100 });
    expect(await rejection(t.stripe.creditNotes.voidCreditNote(post.id))).toMatchObject({ statusCode: 400 });
  });

  it('previews without storing, refunding or emitting, and rejects invalid lines', async () => {
    const t = await setup({ version });
    const { invoice, charge } = await paidInvoice(t);
    const p = { invoice: invoice.id, amount: 300, refund_amount: 300 };
    const before = await t.account.state();
    const preview = await t.stripe.creditNotes.preview(p);
    expect(preview).toMatchObject({ object: 'credit_note', amount: 300, type: 'post_payment' });
    expect(await t.account.state()).toEqual(before);
    expect((await t.stripe.charges.retrieve(charge)).amount_refunded).toBe(0);
    expect(await rejection(t.stripe.creditNotes.preview({ invoice: invoice.id, lines: [{ type: 'invoice_line_item', invoice_line_item: 'il_missing', amount: 100 }], refund_amount: 100 }))).toMatchObject({ param: 'lines[0][invoice_line_item]' });
  });

  it('paginates preview lines and validates preview parameters without side effects', async () => {
    const t = await setup({ version });
    const { invoice } = await paidInvoice(t);
    const p = { invoice: invoice.id, lines: [1, 2, 3].map((i) => ({ type: 'custom_line_item', description: `Credit ${i}`, quantity: 1, unit_amount: i * 100 })), out_of_band_amount: 600, limit: 1 };
    const a = await t.stripe.creditNotes.listPreviewLineItems(p);
    expect(a).toMatchObject({ object: 'list', has_more: true, data: [{ amount: 100 }] });
    const b = await t.stripe.creditNotes.listPreviewLineItems({ ...p, starting_after: a.data[0].id });
    expect(b).toMatchObject({ has_more: true, data: [{ amount: 200 }] });
    expect(await rejection(t.stripe.creditNotes.listPreviewLineItems({ ...p, limit: 0 }))).toMatchObject({ param: 'limit' });
    expect(await rejection(t.stripe.creditNotes.listPreviewLineItems({ ...p, starting_after: 'cnli_missing' }))).toMatchObject({ param: 'starting_after' });
    expect((await t.stripe.creditNotes.list({ invoice: invoice.id })).data).toEqual([]);
  });

  it('lists issued credit-note lines and validates missing notes and cursors', async () => {
    const t = await setup({ version });
    const { invoice } = await paidInvoice(t);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, lines: [{ type: 'custom_line_item', description: 'A', unit_amount: 100, quantity: 1 }, { type: 'custom_line_item', description: 'B', unit_amount: 200, quantity: 1 }], out_of_band_amount: 300 });
    expect(await t.stripe.creditNotes.listLineItems(note.id, { limit: 1 })).toMatchObject({ has_more: true, data: [{ amount: 100 }] });
    expect(await t.stripe.creditNotes.listLineItems(note.id, { starting_after: note.lines.data[0].id })).toMatchObject({ has_more: false, data: [{ amount: 200 }] });
    expect(await rejection(t.stripe.creditNotes.listLineItems('cn_missing'))).toMatchObject({ statusCode: 404 });
  });
});

describe('billing adjustment webhooks and refund failure', () => {
  it('delivers all adjustment events with signatures, hold/retry controls, versioned refunds and API faults', async () => {
    const hooks = await webhookReceiver({ status: (_, i) => i === 0 ? 500 : 200 });
    const t = await setup({ options: { webhooks: [{ url: hooks.url, secret: SECRET, apiVersion: OLD }], webhookRetry: { delaysMs: [5], timeoutMs: 1000 } } });
    await t.server.settle();
    hooks.deliveries.length = 0;
    await t.account.webhooks.hold();
    const { invoice, charge } = await paidInvoice(t);
    const item = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 100 });
    await t.stripe.invoiceItems.update(item.id, { description: 'Updated' });
    await t.stripe.invoiceItems.del(item.id);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 200, refund_amount: 200 });
    await t.stripe.creditNotes.update(note.id, { memo: 'Corrected' });
    await t.stripe.refunds.update(note.refunds[0].refund, { metadata: { order: '1' } });
    const open = await openInvoice(t);
    const pre = await t.stripe.creditNotes.create({ invoice: open.id, amount: 100 });
    await t.stripe.creditNotes.voidCreditNote(pre.id);
    expect(hooks.deliveries).toEqual([]);
    await t.account.webhooks.release({ order: 'reverse' });
    await t.server.settle();
    const delivered = hooks.deliveries.map((d) => t.stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], SECRET));
    for (const type of ['invoiceitem.created', 'invoiceitem.updated', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'refund.created', 'refund.updated', 'charge.refunded']) expect(delivered.some((e) => e.type === type)).toBe(true);
    expect(delivered.find((e) => e.type === 'credit_note.created' && e.data.object.id === note.id).data.object.refund).toBe(note.refunds[0].refund);
    expect((await t.account.webhooks.deliveries()).some((d) => d.attempts === 2)).toBe(true);
    await t.account.faults.add({ path: '/v1/refunds', method: 'POST', kind: '500' });
    expect(await rejection(t.stripe.refunds.create({ charge, amount: 100 }))).toMatchObject({ statusCode: 500 });
    expect((await t.stripe.charges.retrieve(charge)).amount_refunded).toBe(200);
  });

  it('fails the next refund, sends refund.failed and permits retrying the released amount', async () => {
    const hooks = await webhookReceiver();
    const t = await setup({ options: { webhooks: [{ url: hooks.url, secret: SECRET }] } });
    const { charge } = await paidInvoice(t);
    expect(await t.account.failNextRefund(t.customer.id)).toMatchObject({ customer: t.customer.id, remaining: 1 });
    const failed = await t.stripe.refunds.create({ charge, amount: 600 });
    expect(failed).toMatchObject({ status: 'failed', failure_reason: 'declined' });
    expect((await t.stripe.refunds.retrieve(failed.id)).status).toBe('failed');
    expect((await t.stripe.charges.retrieve(charge)).amount_refunded).toBe(0);
    await t.server.settle();
    const failure = hooks.deliveries.map((d) => t.stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], SECRET)).find((e) => e.type === 'refund.failed');
    expect(failure.data.object).toMatchObject({ id: failed.id, status: 'failed', amount: 600 });
    expect((await t.stripe.refunds.create({ charge })).amount).toBe(2000);
    expect((await t.request('POST', '/_test/fail_next_refund', { json: { customer: t.customer.id, times: 0 } })).status).toBe(400);
    expect((await t.request('POST', '/_test/fail_next_refund', { json: { customer: t.customer.id } })).json.remaining).toBe(1);
  });
});

describe('billing accounting edges', () => {
  it('accepts zero quantity and defaults negative invoice items to non-discountable', async () => {
    const t = await setup({ version: OLD });
    const zero = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', unit_amount_decimal: '125.5', quantity: 0 });
    expect(zero).toMatchObject({ amount: 0, quantity: 0, unit_amount_decimal: '125.5' });
    const negative = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: -100 });
    expect(negative.discountable).toBe(false);
    expect(await t.stripe.invoiceItems.update(zero.id, { quantity: 2 })).toMatchObject({ amount: 251, quantity: 2 });
  });

  it('charges the reduced amount after a pre-payment credit and settles fully credited invoices without a charge', async () => {
    const t = await setup({ version: OLD });
    const invoice = await openInvoice(t);
    await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 500 });
    const paid = await t.stripe.invoices.pay(invoice.id, { expand: ['payment_intent', 'charge'] });
    expect(paid).toMatchObject({ status: 'paid', amount_due: 1500, amount_paid: 1500, pre_payment_credit_notes_amount: 500, total: 2000, payment_intent: { amount: 1500 }, charge: { amount: 1500 } });
    const fullyCredited = await openInvoice(t);
    const note = await t.stripe.creditNotes.create({ invoice: fullyCredited.id, amount: 2000 });
    expect(await t.stripe.invoices.retrieve(fullyCredited.id, { expand: ['payment_intent'] })).toMatchObject({ status: 'paid', amount_due: 0, amount_paid: 0, amount_remaining: 0, pre_payment_credit_notes_amount: 2000, payment_intent: { status: 'canceled' }, charge: null });
    expect(await rejection(t.stripe.creditNotes.voidCreditNote(note.id))).toMatchObject({ statusCode: 400 });
  });

  it('bounds cumulative quantity credits, disallows changing credit mode, and validates before mutations', async () => {
    const t = await setup();
    const draft = await t.stripe.invoices.create({ customer: t.customer.id });
    await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', unit_amount_decimal: '500', quantity: 3 });
    const invoice = await t.stripe.invoices.finalizeInvoice(draft.id);
    const line = invoice.lines.data[0].id;
    const first = await t.stripe.creditNotes.create({ invoice: invoice.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line, quantity: 1 }] });
    expect(first.total).toBe(500);
    const before = await t.account.state();
    expect(await rejection(t.stripe.creditNotes.create({ invoice: invoice.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line, amount: 100 }] }))).toMatchObject({ param: 'lines[0]' });
    expect(await rejection(t.stripe.creditNotes.create({ invoice: invoice.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line, quantity: 3 }] }))).toMatchObject({ statusCode: 400 });
    expect(await t.account.state()).toEqual(before);
    await t.stripe.creditNotes.create({ invoice: invoice.id, lines: [{ type: 'invoice_line_item', invoice_line_item: line, quantity: 1 }] });
    expect((await t.stripe.invoices.retrieve(invoice.id)).amount_due).toBe(500);
  });

  it.each([OLD, '2025-03-31.basil', '2025-09-30.clover', LATEST])('links existing refunds at %s with the version-specific field', async (version) => {
    const t = await setup({ version });
    const { invoice, charge } = await paidInvoice(t);
    const refund = await t.stripe.refunds.create({ charge, amount: 400 });
    const params = version === OLD ? { refund: refund.id } : { refunds: [{ refund: refund.id, amount_refunded: 400 }] };
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 400, ...params });
    const expanded = await t.stripe.creditNotes.retrieve(note.id, { expand: [version === OLD ? 'refund' : 'refunds.refund'] });
    expect(version === OLD ? expanded.refund.id : expanded.refunds[0].refund.id).toBe(refund.id);
    expect(await events(t, 'refund.created')).toHaveLength(1);
    expect(await rejection(t.stripe.creditNotes.create({ invoice: invoice.id, amount: 400, ...params }))).toMatchObject({ statusCode: 400 });
    if (version !== OLD) expect(await rejection(t.stripe.creditNotes.create({ invoice: invoice.id, amount: 400, refund: refund.id }))).toMatchObject({ code: 'parameter_unknown', param: 'refund' });
    if (version === '2025-03-31.basil') expect(note).not.toHaveProperty('pre_payment_amount');
    if (version === '2025-09-30.clover') expect(note).toMatchObject({ pre_payment_amount: 0, post_payment_amount: 400 });
  });

  it('credits negative invoice lines while keeping the credit total positive', async () => {
    const t = await setup();
    const draft = await t.stripe.invoices.create({ customer: t.customer.id });
    await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', amount: 10000 });
    await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', amount: -5000 });
    const invoice = await t.stripe.invoices.finalizeInvoice(draft.id);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, lines: invoice.lines.data.map((l) => ({ type: 'invoice_line_item', invoice_line_item: l.id, amount: l.amount })) });
    expect(note.total).toBe(5000);
    expect((await t.stripe.invoices.retrieve(invoice.id)).status).toBe('paid');
  });

  it('keeps failed charges unrefundable and failed refunds separate from credit-note accounting', async () => {
    const t = await setup({ version: OLD });
    const open = await openInvoice(t);
    await t.account.failNextCharge(t.customer.id);
    await rejection(t.stripe.invoices.pay(open.id));
    const failedCharge = (await t.stripe.invoices.retrieve(open.id)).charge;
    expect(await rejection(t.stripe.refunds.create({ charge: failedCharge }))).toMatchObject({ param: 'charge' });
    const { invoice, charge } = await paidInvoice(t);
    await t.account.failNextRefund(t.customer.id);
    const note = await t.stripe.creditNotes.create({ invoice: invoice.id, amount: 300, refund_amount: 300 });
    expect((await t.stripe.refunds.retrieve(note.refund)).status).toBe('failed');
    expect((await t.stripe.invoices.retrieve(invoice.id)).post_payment_credit_notes_amount).toBe(300);
    expect((await t.stripe.charges.retrieve(charge)).amount_refunded).toBe(0);
  });
});

describe('invoice list ordering and exhausted retries', () => {
  it('orders invoice items by their customer clock date before the insertion sequence', async () => {
    const t = await setup();
    const latest = await t.stripe.invoiceItems.create({ customer: t.customer.id, currency: 'usd', amount: 100 });
    const clock = await t.stripe.testHelpers.testClocks.create({ frozen_time: 1720000000 });
    const customer = await t.stripe.customers.create({ test_clock: clock.id });
    const earlier = await t.stripe.invoiceItems.create({ customer: customer.id, currency: 'usd', amount: 200 });
    expect(latest.date).toBeGreaterThan(earlier.date);
    expect(await t.stripe.invoiceItems.list({ limit: 1 })).toMatchObject({ has_more: true, data: [{ id: latest.id }] });
    expect(await t.stripe.invoiceItems.list({ starting_after: latest.id })).toMatchObject({ has_more: false, data: [{ id: earlier.id }] });
  });

  it('marks a standalone invoice uncollectible when its automatic retries are exhausted', async () => {
    const t = await setup({ options: { billing: { retrySchedule: [], markUncollectible: true } } });
    await t.account.failNextCharge(t.customer.id);
    const draft = await t.stripe.invoices.create({ customer: t.customer.id, auto_advance: true });
    await t.stripe.invoiceItems.create({ customer: t.customer.id, invoice: draft.id, currency: 'usd', amount: 1000 });
    await t.account.advanceTime({ seconds: HOUR });
    expect(await t.stripe.invoices.retrieve(draft.id)).toMatchObject({ status: 'uncollectible', amount_remaining: 1000, next_payment_attempt: null, attempt_count: 1 });
    expect(await events(t, 'invoice.marked_uncollectible')).toHaveLength(1);
  });
});
