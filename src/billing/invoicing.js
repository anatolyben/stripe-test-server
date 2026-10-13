/**
 * Invoices of the billing engine: drafts built from subscription items and pending
 * invoice items, totals and customer balance, finalization (number, hosted URLs, PaymentIntent,
 * default InvoicePayment), payment attempts, paid / void / uncollectible transitions, and the
 * events of each step. Subscription reactions (status, dunning) live in engine.js, which this
 * module calls back through onInvoiceSettled / onPaymentFailure.
 *
 * Internal invoice = the 2026-08-26.dahlia wire shape (docs.stripe.com/api/invoices/object) with
 * all lines kept in `lines.data`, plus private fields: _paymentIntent, _charge, _payments,
 * _token (hosted page), _paidOutOfBand, _dunningUncollectible, _lastFailure, _daysUntilDue.
 */
import { emitEvent } from '../core/events.js';
import { render } from '../core/render.js';
import { cardError, invalidRequest } from '../core/errors.js';
import { minimumCharge } from '../core/currency.js';
import { atLeast } from '../core/versions.js';
import { JOB_PRIORITY } from '../core/time.js';
import { changeCustomer } from '../customers/customers.js';
import { cancelPaymentIntent, confirmPaymentIntent, createPaymentIntent, updateInvoicePaymentIntentAmount } from '../payments/payment_intents.js';
import { onInvoiceSettled, onPaymentFailure } from './engine.js';
import {
  DAY,
  DRAFT_WINDOW_SECONDS,
  HARD_DECLINES,
  decimalString,
  defaultPaymentMethodFor,
  nowOf,
} from './util.js';

// Events ----------------------------------------------------------------------------------------

/**
 * Emits `type` (an *.updated event) with `previous` when the rendered object differs from it.
 * Returns the event or null.
 */
export function emitUpdated(account, obj, type, previous, opts = {}) {
  const version = account.settings.apiVersion;
  const before = JSON.stringify(render(account, previous, { version, forEvent: true }));
  const after = JSON.stringify(render(account, obj, { version, forEvent: true }));
  if (before === after) return null;
  return emitEvent(account, type, obj, { ...opts, previous });
}

/** invoice_payment.paid exists from 2025-05-28.basil; older accounts do not receive it. */
function emitsInvoicePaymentPaid(account) {
  return atLeast(account.settings.apiVersion, '2025-05-28.basil');
}

// Lookups ---------------------------------------------------------------------------------------

/** The subscription an invoice was created for, or null. */
export function subscriptionOfInvoice(account, invoice) {
  const id = invoice.parent?.subscription_details?.subscription;
  return id ? account.store.get('subscription', id) : null;
}

/** Invoices of a subscription, oldest first. */
export function invoicesOfSubscription(account, subscriptionId) {
  return account.store.list('invoice', (inv) => inv.parent?.subscription_details?.subscription === subscriptionId);
}

/** Pending (not yet invoiced) invoice items of a subscription, in creation order. */
export function pendingInvoiceItems(account, subscriptionId, { includeCustomer = false } = {}) {
  const sub = account.store.get('subscription', subscriptionId);
  return account.store.list('invoiceitem', (ii) => ii.invoice === null && !ii._deleted &&
    (ii.parent?.subscription_details?.subscription === subscriptionId ||
      (includeCustomer && !ii.parent?.subscription_details?.subscription && ii.customer === sub?.customer && ii.currency === sub?.currency)));
}

// Construction ----------------------------------------------------------------------------------

/**
 * A new draft invoice (not stored yet).
 * @param {object} o { id?, customer, subscription?, billingReason, collectionMethod, currency, now,
 *   periodStart, periodEnd, autoAdvance, daysUntilDue?, prorationDate? }
 */
export function newInvoice(account, o) {
  const { customer, subscription } = o;
  const id = o.id ?? account.mintId('in');
  const settings = subscription?.invoice_settings ?? {};
  const details = subscription ? { metadata: { ...subscription.metadata }, subscription: subscription.id } : null;
  if (details && o.prorationDate !== undefined) details.subscription_proration_date = o.prorationDate;
  return {
    id,
    object: 'invoice',
    account_country: 'US',
    account_name: null,
    account_tax_ids: null,
    amount_due: 0,
    amount_overpaid: 0,
    amount_paid: 0,
    amount_remaining: 0,
    amount_shipping: 0,
    application: null,
    attempt_count: 0,
    attempted: false,
    auto_advance: o.autoAdvance,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null, provider: null, status: null },
    automatically_finalizes_at: null,
    billing_reason: o.billingReason,
    collection_method: o.collectionMethod,
    created: o.now,
    currency: o.currency,
    custom_fields: structuredClone(settings.custom_fields ?? customer.invoice_settings?.custom_fields ?? null),
    customer: customer.id,
    customer_account: null,
    customer_address: structuredClone(customer.address ?? null),
    customer_email: customer.email ?? null,
    customer_name: customer.name ?? null,
    customer_phone: customer.phone ?? null,
    customer_shipping: structuredClone(customer.shipping ?? null),
    customer_tax_exempt: customer.tax_exempt ?? 'none',
    customer_tax_ids: [],
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: settings.description ?? null,
    discounts: [],
    due_date: null,
    effective_at: null,
    ending_balance: null,
    footer: settings.footer ?? customer.invoice_settings?.footer ?? null,
    from_invoice: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    issuer: { type: 'self' },
    last_finalization_error: null,
    latest_revision: null,
    lines: { object: 'list', data: [], has_more: false, total_count: 0, url: `/v1/invoices/${id}/lines` },
    livemode: false,
    metadata: {},
    next_payment_attempt: null,
    number: null,
    on_behalf_of: null,
    parent: details ? { quote_details: null, subscription_details: details, type: 'subscription_details' } : null,
    payment_settings: { default_mandate: null, payment_method_options: null, payment_method_types: null },
    period_end: o.periodEnd,
    period_start: o.periodStart,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    rendering: null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: customer.balance ?? 0,
    statement_descriptor: null,
    status: 'draft',
    status_transitions: { finalized_at: null, marked_uncollectible_at: null, paid_at: null, voided_at: null },
    subtotal: 0,
    subtotal_excluding_tax: 0,
    test_clock: customer.test_clock ?? null,
    total: 0,
    total_discount_amounts: [],
    total_excluding_tax: 0,
    total_pretax_credit_amounts: [],
    total_taxes: [],
    webhooks_delivered_at: o.now,
    _paymentIntent: null,
    _charge: null,
    _payments: [],
    _token: account.mintId('test'),
    _paidOutOfBand: false,
    _dunningUncollectible: false,
    _lastFailure: null,
    _daysUntilDue: o.daysUntilDue ?? null,
  };
}

/**
 * Appends a subscription line (type "subscription" at 2024-06-20).
 * @param {object} l { subscription, item, price, quantity, amount, start, end, description,
 *   proration?, discountable?, invoiceItem? (ii_ for proration lines), creditedItems? }
 */
export function addSubscriptionLine(account, invoice, l) {
  const line = {
    id: account.mintId('il'),
    object: 'line_item',
    amount: l.amount,
    currency: invoice.currency,
    description: l.description,
    discount_amounts: [],
    discountable: l.discountable ?? !l.proration,
    discounts: [],
    invoice: invoice.id,
    livemode: false,
    // Subscription lines reflect the subscription's metadata; proration lines carry their invoice item's.
    metadata: l.invoiceItem ? { ...(l.metadata ?? {}) } : { ...(l.subscription?.metadata ?? {}) },
    parent: {
      invoice_item_details: null,
      subscription_item_details: {
        invoice_item: l.invoiceItem ?? null,
        proration: Boolean(l.proration),
        proration_details: { credited_items: l.creditedItems ?? null },
        subscription: l.subscription?.id ?? null,
        subscription_item: l.item?.id ?? null,
      },
      type: 'subscription_item_details',
    },
    period: { end: l.end, start: l.start },
    pretax_credit_amounts: [],
    pricing: {
      price_details: { price: l.price.id, product: l.price.product },
      type: 'price_details',
      unit_amount_decimal: l.unitAmountDecimal ?? decimalString(l.quantity ? l.amount / l.quantity : 0),
    },
    quantity: l.quantity,
    subscription: l.subscription?.id ?? null,
    subtotal: l.amount,
    taxes: [],
    _type: l.invoiceItem ? 'invoiceitem' : 'subscription',
  };
  if (!l.invoiceItem && l.item) {
    // A full-period debit: remember it so a later credit proration can point at it.
    l.item._lastDebit = { invoice: invoice.id, line: line.id };
  }
  invoice.lines.data.push(line);
  return line;
}

/**
 * Creates and stores an invoice item (ii_). Pending (invoice: null) unless attached right away.
 * @param {object} s { customer, subscription?, item?, price, quantity, amount, start, end,
 *   description, proration, creditedItems?, metadata? }
 */
export function createInvoiceItem(account, s) {
  const now = nowOf(account, s.customer);
  const ii = {
    id: account.mintId('ii'),
    object: 'invoiceitem',
    amount: s.amount,
    currency: s.currency ?? s.price.currency,
    customer: s.customer.id,
    customer_account: null,
    date: now,
    description: s.description,
    discountable: !s.proration,
    discounts: [],
    invoice: null,
    livemode: false,
    metadata: { ...(s.metadata ?? {}) },
    parent: s.subscription
      ? { subscription_details: { subscription: s.subscription.id, ...(s.item ? { subscription_item: s.item.id } : {}) }, type: 'subscription_details' }
      : null,
    period: { end: s.end, start: s.start },
    pricing: {
      ...(s.price ? { price_details: { price: s.price.id, product: s.price.product } } : {}),
      type: 'price_details',
      unit_amount_decimal: s.unitAmountDecimal ?? decimalString(s.quantity ? s.amount / s.quantity : 0),
    },
    proration: Boolean(s.proration),
    proration_details: { credited_items: s.creditedItems ?? null, discount_amounts: [] },
    quantity: s.quantity,
    quantity_decimal: String(s.quantity),
    tax_rates: [],
    test_clock: s.customer.test_clock ?? null,
    _deleted: false,
  };
  account.store.insert(ii);
  return ii;
}

/** Moves an invoice item onto an invoice as a line (proration lines keep their subscription item). */
export function attachInvoiceItem(account, invoice, ii) {
  if (ii.invoice === invoice.id) return invoice.lines.data.find((l) => (l.parent?.invoice_item_details ?? l.parent?.subscription_item_details)?.invoice_item === ii.id);
  if (ii.invoice || invoice.status !== 'draft' || ii.customer !== invoice.customer || ii.currency !== invoice.currency) throw invalidRequest('Invoice item cannot be attached to this invoice.', { param: 'invoice' });
  ii.invoice = invoice.id;
  const price = account.store.get('price', ii.pricing?.price_details?.price);
  const sub = ii.parent?.subscription_details?.subscription ? account.store.get('subscription', ii.parent.subscription_details.subscription) : null;
  const itemId = ii.parent?.subscription_details?.subscription_item ?? null;
  if (ii.proration && itemId) {
    return addSubscriptionLine(account, invoice, {
      subscription: sub,
      item: { id: itemId },
      price,
      quantity: ii.quantity,
      amount: ii.amount,
      start: ii.period.start,
      end: ii.period.end,
      description: ii.description,
      proration: true,
      discountable: false,
      invoiceItem: ii.id,
      creditedItems: ii.proration_details.credited_items,
      unitAmountDecimal: ii.pricing.unit_amount_decimal,
      metadata: ii.metadata,
    });
  }
  const line = {
    id: account.mintId('il'),
    object: 'line_item',
    amount: ii.amount,
    currency: invoice.currency,
    description: ii.description,
    discount_amounts: [],
    discountable: ii.discountable,
    discounts: [],
    invoice: invoice.id,
    livemode: false,
    metadata: { ...ii.metadata },
    parent: {
      invoice_item_details: {
        invoice_item: ii.id,
        proration: ii.proration,
        proration_details: { credited_items: ii.proration_details.credited_items },
        subscription: sub?.id ?? null,
      },
      subscription_item_details: null,
      type: 'invoice_item_details',
    },
    period: { ...ii.period },
    pretax_credit_amounts: [],
    pricing: structuredClone(ii.pricing),
    quantity: ii.quantity,
    subscription: sub?.id ?? null,
    subtotal: ii.amount,
    taxes: [],
    _type: 'invoiceitem',
  };
  invoice.lines.data.push(line);
  return line;
}

/** Pending items in invoice order: newest first, items created in the same second in creation order. */
export function sortPending(items) {
  return [...items].sort((a, b) => b.date - a.date || a._seq - b._seq);
}

/** Recomputes subtotal, total and (while draft) amount_due from the lines and the customer balance. */
export function computeTotals(account, invoice) {
  const subtotal = invoice.lines.data.reduce((sum, l) => sum + l.amount, 0);
  invoice.subtotal = subtotal;
  invoice.subtotal_excluding_tax = subtotal;
  invoice.total = subtotal;
  invoice.total_excluding_tax = subtotal;
  invoice.lines.total_count = invoice.lines.data.length;
  if (invoice.status === 'draft') {
    const customer = account.store.get('customer', invoice.customer);
    const balance = customer?.balance ?? 0;
    invoice.starting_balance = balance;
    invoice.amount_due = Math.max(0, subtotal + balance);
    invoice.amount_remaining = invoice.amount_due - invoice.amount_paid;
  }
  return invoice;
}

/**
 * Stores a new draft and emits invoice.created. With `autoAdvance` drafts (renewals,
 * schedule-started and send_invoice first invoices) schedules finalization after the ~1 h window.
 */
export function insertDraft(account, invoice, { request, scheduleFinalization = false } = {}) {
  computeTotals(account, invoice);
  if (scheduleFinalization && invoice.auto_advance) {
    invoice.automatically_finalizes_at = invoice.created + DRAFT_WINDOW_SECONDS;
    if (invoice.collection_method === 'charge_automatically') invoice.next_payment_attempt = invoice.automatically_finalizes_at;
  }
  account.store.insert(invoice);
  emitEvent(account, 'invoice.created', invoice, { request });
  if (invoice.automatically_finalizes_at !== null) {
    account.time.schedule({
      kind: 'invoice.finalize',
      at: invoice.automatically_finalizes_at,
      domain: account.time.domainOf(invoice),
      key: `${invoice.id}:finalize`,
      data: { invoice: invoice.id },
      priority: JOB_PRIORITY.invoiceFinalize,
    });
  }
  return invoice;
}

// Finalization ---------------------------------------------------------------------------------

function paymentIntentDescription(invoice) {
  if (invoice.billing_reason === 'subscription_create') return 'Subscription creation';
  if (invoice.billing_reason === 'subscription_update') return 'Subscription update';
  return null;
}

/** The invoice's PaymentIntent, created on first need ("finalization creates an incomplete payment intent"). */
export function ensurePaymentIntent(account, invoice, { request } = {}) {
  let pi = invoice._paymentIntent ? account.store.get('payment_intent', invoice._paymentIntent) : null;
  if (!pi) {
    pi = createPaymentIntent(
      account,
      {
        amount: invoice.amount_remaining,
        currency: invoice.currency,
        customer: invoice.customer,
        description: paymentIntentDescription(invoice),
        metadata: {},
        invoice: invoice.id,
      },
      { request },
    );
    linkPaymentIntent(account, invoice, pi);
  }
  return pi;
}

/** Records a PaymentIntent on the invoice and creates its default InvoicePayment. */
function linkPaymentIntent(account, invoice, pi) {
  invoice._paymentIntent = pi.id;
  const now = nowOf(account, invoice);
  const payment = {
    id: account.mintId('inpay'),
    object: 'invoice_payment',
    amount_paid: null,
    amount_requested: invoice.amount_remaining,
    created: now,
    currency: invoice.currency,
    invoice: invoice.id,
    is_default: true,
    livemode: false,
    payment: { payment_intent: pi.id, type: 'payment_intent' },
    status: 'open',
    status_transitions: { canceled_at: null, paid_at: null },
  };
  account.store.insert(payment);
  invoice._payments.push(payment.id);
}

function defaultPayment(account, invoice) {
  return invoice._payments.map((id) => account.store.get('invoice_payment', id)).find((p) => p && p.is_default) ?? null;
}

/**
 * Finalizes a draft (docs.stripe.com/invoicing/integration/workflow-transitions): number, customer
 * snapshot, balance applied, hosted URLs, PaymentIntent and default InvoicePayment when money is
 * due; emits invoice.finalized. A $0 (or below-minimum) invoice is paid at once (invoice.paid).
 * @param {object} [o] { request, paymentIntent (an already confirmed PI to link) }
 */
export function finalizeInvoice(account, invoice, o = {}) {
  if (invoice.status !== 'draft') throw invalidRequest(`This invoice is already finalized, you can't re-finalize a non-draft invoice.`);
  const { request } = o;
  const customer = account.store.get('customer', invoice.customer);
  const now = nowOf(account, invoice);
  computeTotals(account, invoice);

  const seq = customer.next_invoice_sequence ?? 1;
  invoice.number = `${customer.invoice_prefix}-${String(seq).padStart(4, '0')}`;
  changeCustomer(account, customer, (c) => { c.next_invoice_sequence = seq + 1; }, { silent: true });
  Object.assign(invoice, {
    customer_address: structuredClone(customer.address ?? null),
    customer_email: customer.email ?? null,
    customer_name: customer.name ?? null,
    customer_phone: customer.phone ?? null,
    customer_shipping: structuredClone(customer.shipping ?? null),
    customer_tax_exempt: customer.tax_exempt ?? 'none',
  });

  // Customer balance: credit applies up to the total, a debit in full (docs.stripe.com/billing/customer/balance).
  const balance = customer.balance ?? 0;
  const net = invoice.total + balance;
  let due = Math.max(0, net);
  let ending = Math.min(0, net);
  if (due > 0 && due < minimumCharge(invoice.currency)) {
    // Below the minimum charge: paid now, the amount moves to the balance (invoice_too_small).
    ending = due;
    due = 0;
  }
  invoice.starting_balance = balance;
  invoice.ending_balance = ending;
  invoice.amount_due = due;
  invoice.amount_remaining = due - invoice.amount_paid;
  if (balance !== ending) changeCustomer(account, customer, (c) => { c.balance = ending; }, { request });

  invoice.status = 'open';
  invoice.status_transitions.finalized_at = now;
  invoice.effective_at = now;
  invoice.automatically_finalizes_at = null;
  const base = `${account.server.url}/i/${account.id}/${invoice._token}`;
  invoice.hosted_invoice_url = base;
  invoice.invoice_pdf = `${base}/pdf`;
  if (invoice.collection_method === 'send_invoice') {
    invoice.due_date = now + (invoice._daysUntilDue ?? 30) * DAY;
    invoice.next_payment_attempt = null;
    scheduleDueDate(account, invoice);
  }
  if (due > 0) {
    if (o.paymentIntent) linkPaymentIntent(account, invoice, o.paymentIntent);
    else ensurePaymentIntent(account, invoice, { request });
  }
  if (!invoice.auto_advance || due === 0) invoice.next_payment_attempt = null;
  emitEvent(account, 'invoice.finalized', invoice, { request });
  if (due === 0) markPaid(account, invoice, { request, viaPayment: false });
  return invoice;
}

function scheduleDueDate(account, invoice) {
  account.time.schedule({
    kind: 'invoice.due',
    at: invoice.due_date,
    domain: account.time.domainOf(invoice),
    key: `${invoice.id}:due`,
    data: { invoice: invoice.id },
  });
}

// Payment ---------------------------------------------------------------------------------------

/**
 * Marks an invoice paid and emits invoice.paid; after a real payment also
 * invoice.payment_succeeded and invoice_payment.paid ($0, below-minimum and out-of-band invoices
 * get invoice.paid only: docs.stripe.com/invoicing/overview), then invoice.updated when a
 * `previous` snapshot is given. Calls back the engine for the subscription.
 */
export function markPaid(account, invoice, { request, viaPayment, outOfBand = false, previous = null } = {}) {
  const now = nowOf(account, invoice);
  invoice.status = 'paid';
  invoice.amount_paid = invoice.amount_due;
  invoice.amount_remaining = 0;
  invoice.attempted = true;
  invoice.auto_advance = false;
  invoice.next_payment_attempt = null;
  invoice.automatically_finalizes_at = null;
  invoice.status_transitions.paid_at = now;
  invoice._paidOutOfBand = outOfBand;
  account.time.cancel(`${invoice.id}:retry`);
  account.time.cancel(`${invoice.id}:due`);
  const payment = defaultPayment(account, invoice);
  if (payment) {
    if (viaPayment) {
      payment.status = 'paid';
      payment.amount_paid = invoice.amount_paid;
      payment.status_transitions.paid_at = now;
    } else if (outOfBand) {
      payment.status = 'canceled';
      payment.status_transitions.canceled_at = now;
    }
  }
  emitEvent(account, 'invoice.paid', invoice, { request });
  if (viaPayment) {
    emitEvent(account, 'invoice.payment_succeeded', invoice, { request });
    if (payment && emitsInvoicePaymentPaid(account)) {
      emitEvent(account, 'invoice_payment.paid', payment, { request, domain: account.time.domainOf(invoice) });
    }
  }
  if (previous) emitUpdated(account, invoice, 'invoice.updated', previous, { request });
  const customer = account.store.get('customer', invoice.customer);
  if (customer?.delinquent) changeCustomer(account, customer, (c) => { c.delinquent = false; }, { request });
  onInvoiceSettled(account, invoice, { request, cause: 'paid' });
  return invoice;
}

/** 400 for a payment with nothing to charge (the documented "payment method priority" has no match). */
export function noPaymentMethodError() {
  return invalidRequest(
    'This customer has no attached payment source or default payment method. Please consider adding a default payment method. For more information, visit https://docs.stripe.com/billing/subscriptions/payment-methods-setting#payment-method-priority.',
    { validation: false },
  );
}

/**
 * Attempts to collect an open invoice with `paymentMethod` or the default order. On success the
 * invoice is paid (events included). On failure the invoice stays open: attempted, attempt_count
 * ("any payment attempt counts as the first attempt, and subsequently only automatic retries
 * increment the attempt count"), the PaymentIntent's error, then the engine's onPaymentFailure
 * decides retries and the subscription's status; invoice.payment_failed (or
 * .payment_action_required) and invoice.updated are emitted there.
 * @param {object} o { paymentMethod?, mode: 'create'|'update'|'automatic'|'manual', offSession?, request }
 * @returns {{ok: boolean, error: object|null}}
 */
export function attemptPayment(account, invoice, o = {}) {
  const { mode = 'manual', request } = o;
  const offSession = o.offSession ?? true;
  if (!['open', 'uncollectible'].includes(invoice.status)) throw invalidRequest(`Invoice ${invoice.id} is not payable in status ${invoice.status}.`);
  const customer = account.store.get('customer', invoice.customer);
  const sub = subscriptionOfInvoice(account, invoice);
  const previous = structuredClone(invoice);
  const automatic = mode === 'automatic';
  const pmId = o.paymentMethod ?? defaultPaymentMethodFor(account, invoice, sub, customer);
  invoice.attempted = true;
  invoice.attempt_count = invoice.attempt_count === 0 ? 1 : automatic ? invoice.attempt_count + 1 : invoice.attempt_count;

  let result;
  const last = invoice._lastFailure;
  if (!pmId) {
    result = { ok: false, error: noPaymentMethodError(), requiresAction: false };
  } else if (automatic && last && HARD_DECLINES.has(last.declineCode) && last.paymentMethod === pmId) {
    // Hard decline: the retry is scheduled and counted but only runs with a new payment method.
    const error = cardError({ code: last.code ?? 'card_declined', declineCode: last.declineCode, message: last.message ?? undefined });
    result = { ok: false, error, requiresAction: false, skipped: true };
  } else {
    const pi = ensurePaymentIntent(account, invoice, { request });
    const r = confirmPaymentIntent(account, pi, { paymentMethod: pmId, offSession }, { request });
    if (r.charge) invoice._charge = r.charge.id;
    result = { ok: r.ok, error: r.error ?? null, requiresAction: r.paymentIntent?.status === 'requires_action' };
  }
  if (result.ok) {
    invoice._lastFailure = null;
    markPaid(account, invoice, { request, viaPayment: true, previous });
    return { ok: true, error: null };
  }
  invoice._lastFailure = failureRecord(pmId, result.error);
  onPaymentFailure(account, invoice, { mode, previous, request, error: result.error, requiresAction: result.requiresAction, skipped: result.skipped });
  return { ok: false, error: result.error };
}

/** What an invoice remembers of a failed attempt (plain data). */
export function failureRecord(paymentMethod, error) {
  const f = error?.fields ?? {};
  return { paymentMethod: paymentMethod ?? null, code: f.code ?? null, declineCode: f.decline_code ?? f.code ?? null, message: f.message ?? null };
}

/**
 * Emits the failure events of an attempt: invoice.payment_failed (or
 * invoice.payment_action_required when the card needs authentication), then invoice.updated.
 */
export function emitPaymentFailure(account, invoice, { previous, request, requiresAction = false } = {}) {
  emitEvent(account, requiresAction ? 'invoice.payment_action_required' : 'invoice.payment_failed', invoice, { request });
  emitUpdated(account, invoice, 'invoice.updated', previous, { request });
}

/** Marks an open or uncollectible invoice paid outside Stripe (pay with paid_out_of_band). */
export function payOutOfBand(account, invoice, { request } = {}) {
  const previous = structuredClone(invoice);
  markPaid(account, invoice, { request, viaPayment: false, outOfBand: true, previous });
  return invoice;
}

// Void and uncollectible -------------------------------------------------------------------------

/** Voids an open or uncollectible invoice (terminal); cancels its PaymentIntent. Emits invoice.voided. */
export function voidInvoice(account, invoice, { request } = {}) {
  if (!['open', 'uncollectible'].includes(invoice.status)) {
    throw invalidRequest(`You can only void invoices in the open or uncollectible status (this invoice is ${invoice.status}).`);
  }
  const now = nowOf(account, invoice);
  invoice.status = 'void';
  invoice.status_transitions.voided_at = now;
  invoice.auto_advance = false;
  invoice.next_payment_attempt = null;
  account.time.cancel(`${invoice.id}:retry`);
  account.time.cancel(`${invoice.id}:due`);
  const payment = defaultPayment(account, invoice);
  if (payment && payment.status === 'open') {
    payment.status = 'canceled';
    payment.status_transitions.canceled_at = now;
  }
  const pi = invoice._paymentIntent ? account.store.get('payment_intent', invoice._paymentIntent) : null;
  if (pi && !['succeeded', 'canceled'].includes(pi.status)) cancelPaymentIntent(account, pi, { reason: 'void_invoice' }, { request });
  emitEvent(account, 'invoice.voided', invoice, { request });
  onInvoiceSettled(account, invoice, { request, cause: 'void' });
  return invoice;
}

/**
 * Marks an open invoice uncollectible. `byDunning` marks it after the final retry: it then stays
 * outstanding for the subscription's status and does not clear customer.delinquent.
 */
export function markUncollectible(account, invoice, { request, byDunning = false } = {}) {
  if (invoice.status !== 'open') {
    throw invalidRequest(`You can only mark open invoices as uncollectible (this invoice is ${invoice.status}).`);
  }
  const now = nowOf(account, invoice);
  invoice.status = 'uncollectible';
  invoice.status_transitions.marked_uncollectible_at = now;
  invoice.auto_advance = false;
  invoice.next_payment_attempt = null;
  invoice._dunningUncollectible = byDunning;
  account.time.cancel(`${invoice.id}:retry`);
  account.time.cancel(`${invoice.id}:due`);
  emitEvent(account, 'invoice.marked_uncollectible', invoice, { request });
  if (!byDunning) {
    const customer = account.store.get('customer', invoice.customer);
    if (customer?.delinquent) changeCustomer(account, customer, (c) => { c.delinquent = false; }, { request });
    onInvoiceSettled(account, invoice, { request, cause: 'uncollectible' });
  }
  return invoice;
}

/** Turns off automatic collection (subscription canceled): auto_advance false, retries and finalization stopped. */
export function stopAutomaticCollection(account, invoice, { request } = {}) {
  if (!['draft', 'open'].includes(invoice.status)) return;
  account.time.cancel(`${invoice.id}:retry`);
  account.time.cancel(`${invoice.id}:finalize`);
  account.time.cancel(`${invoice.id}:attempt`);
  const previous = structuredClone(invoice);
  invoice.auto_advance = false;
  invoice.next_payment_attempt = null;
  invoice.automatically_finalizes_at = null;
  emitUpdated(account, invoice, 'invoice.updated', previous, { request });
}

/** Cancels an unused PaymentIntent created for a payment that did not happen (error_if_incomplete). */
export function discardPaymentIntent(account, pi, { request } = {}) {
  if (pi && !['succeeded', 'canceled'].includes(pi.status)) cancelPaymentIntent(account, pi, { reason: 'failed_invoice' }, { request });
}

/** Refresh the corresponding draft line without changing its ID or position. */
export function refreshInvoiceItem(account, invoice, item) {
  const line = invoice.lines.data.find((l) => (l.parent?.invoice_item_details ?? l.parent?.subscription_item_details)?.invoice_item === item.id);
  if (!line || invoice.status !== 'draft') throw invalidRequest('Invoice item has no editable draft line.');
  Object.assign(line, { amount: item.amount, subtotal: item.amount, description: item.description,
    quantity: item.quantity, metadata: { ...item.metadata }, period: { ...item.period },
    discountable: item.discountable, pricing: structuredClone(item.pricing) });
  computeTotals(account, invoice);
}

/** Apply or reverse credit-note accounting; the invoice total and original lines stay intact. */
export function adjustInvoiceCreditNotes(account, invoice, { pre, post }, { request } = {}) {
  const previous = structuredClone(invoice);
  invoice.pre_payment_credit_notes_amount += pre;
  invoice.post_payment_credit_notes_amount += post;
  invoice.amount_due -= pre;
  invoice.amount_remaining -= pre;
  const pi = invoice._paymentIntent ? account.store.get('payment_intent', invoice._paymentIntent) : null;
  const payment = defaultPayment(account, invoice);
  if (invoice.status === 'open' && pi) {
    if (invoice.amount_remaining > 0) {
      updateInvoicePaymentIntentAmount(account, pi, invoice.amount_remaining);
      if (payment) payment.amount_requested = invoice.amount_remaining;
    } else {
      cancelPaymentIntent(account, pi, { reason: 'credit_note' }, { request });
      if (payment) { payment.status = 'canceled'; payment.status_transitions.canceled_at = nowOf(account, invoice); }
    }
  }
  if (invoice.status === 'open' && invoice.amount_remaining === 0) markPaid(account, invoice, { request, viaPayment: false, previous });
  else emitUpdated(account, invoice, 'invoice.updated', previous, { request });
}
