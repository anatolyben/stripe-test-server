/**
 * Invoices API, docs.stripe.com/api/invoices.
 *
 * Routes: GET /v1/invoices, GET /v1/invoices/:id, GET /v1/invoices/:id/lines,
 * POST /v1/invoices/:id/pay, POST /v1/invoices/:id/void, POST /v1/invoices/:id/finalize,
 * POST /v1/invoices/:id/mark_uncollectible, GET /v1/invoice_payments,
 * GET /v1/invoice_payments/:id.
 * Objects: 'invoice' (2024-06-20: subscription, paid, paid_out_of_band, payment_intent, charge,
 * subscription_details; from 2025-03-31.basil: parent, and the includable payments and
 * confirmation_secret; amount_paid_off_stripe includable from 2026-05-27.dahlia), 'line_item'
 * (2024-06-20: price, plan, type, proration; basil+: parent, pricing, taxes; subtotal from
 * 2025-12-15.clover, quantity_decimal from 2026-03-25.dahlia), 'invoice_payment' and
 * 'invoiceitem' (proration items, seen in invoiceitem.created events).
 */
import { invalidRequest, parametersExclusive, resourceMissing } from '../core/errors.js';
import { ListResult, matchesRange, paginate } from '../core/list.js';
import { JOB_PRIORITY } from '../core/time.js';
import { payInvoice } from './engine.js';
import { finalizeInvoice, markUncollectible, voidInvoice } from './invoicing.js';
import { renderPlan } from './subscriptions.js';
import { DRAFT_WINDOW_SECONDS, nowOf } from './util.js';

function cannotExpand(name) {
  return invalidRequest(`This property cannot be expanded (${name}).`, { param: 'expand' });
}

// Serializers -----------------------------------------------------------------------------------

/** An invoice line item (docs.stripe.com/api/invoice-line-item/object) for the context's version. */
export function renderLineItem(line, ctx) {
  const details = line.parent?.subscription_item_details ?? line.parent?.invoice_item_details ?? null;
  if (ctx.family === 'F1') {
    const price = line.pricing?.price_details ? ctx.lookup(line.pricing.price_details.price) : null;
    const out = {
      id: line.id,
      object: 'line_item',
      amount: line.amount,
      amount_excluding_tax: line.amount,
      currency: line.currency,
      description: line.description,
      discount_amounts: [],
      discountable: line.discountable,
      discounts: [],
      invoice: line.invoice,
    };
    if (details?.invoice_item) out.invoice_item = details.invoice_item;
    Object.assign(out, {
      livemode: false,
      metadata: { ...line.metadata },
      period: { ...line.period },
      plan: price && price.recurring ? renderPlan(price, ctx) : null,
      price: price ? ctx.render(price) : null,
      proration: Boolean(details?.proration),
      proration_details: { credited_items: structuredClone(details?.proration_details?.credited_items ?? null) },
      quantity: line.quantity,
      subscription: line.subscription,
    });
    const item = line.parent?.subscription_item_details?.subscription_item;
    if (item) out.subscription_item = item;
    Object.assign(out, {
      tax_amounts: [],
      tax_rates: [],
      type: line._type ?? (line.parent?.type === 'invoice_item_details' ? 'invoiceitem' : 'subscription'),
      unit_amount_excluding_tax: line.pricing?.unit_amount_decimal ?? null,
    });
    return out;
  }
  const out = {
    id: line.id,
    object: 'line_item',
    amount: line.amount,
    currency: line.currency,
    description: line.description,
    discount_amounts: [],
    discountable: line.discountable,
    discounts: [],
    invoice: line.invoice,
    livemode: false,
    metadata: { ...line.metadata },
    parent: structuredClone(line.parent),
    period: { ...line.period },
    pretax_credit_amounts: [],
    pricing: structuredClone(line.pricing),
    quantity: line.quantity,
  };
  if (ctx.atLeast('2026-03-25.dahlia')) out.quantity_decimal = line.quantity === null ? null : String(line.quantity);
  out.subscription = line.subscription;
  if (ctx.atLeast('2025-12-15.clover')) out.subtotal = line.subtotal;
  out.taxes = [];
  return out;
}

/** An invoice (docs.stripe.com/api/invoices/object) for the context's version. */
export function renderInvoice(invoice, ctx) {
  const f1 = ctx.family === 'F1';
  const lines = invoice.lines.data;
  const out = {
    id: invoice.id,
    object: 'invoice',
    account_country: invoice.account_country,
    account_name: invoice.account_name,
    account_tax_ids: structuredClone(invoice.account_tax_ids),
    amount_due: invoice.amount_due,
  };
  if (!f1) out.amount_overpaid = invoice.amount_overpaid;
  out.amount_paid = f1 && invoice._paidOutOfBand ? 0 : invoice.amount_paid;
  out.amount_remaining = invoice.amount_remaining;
  out.amount_shipping = invoice.amount_shipping;
  out.application = null;
  if (f1) out.application_fee_amount = null;
  Object.assign(out, {
    attempt_count: invoice.attempt_count,
    attempted: invoice.attempted,
    auto_advance: invoice.auto_advance,
    automatic_tax: f1
      ? { enabled: invoice.automatic_tax.enabled, liability: structuredClone(invoice.automatic_tax.liability), status: invoice.automatic_tax.status }
      : structuredClone(invoice.automatic_tax),
    automatically_finalizes_at: invoice.automatically_finalizes_at,
    billing_reason: invoice.billing_reason,
  });
  if (f1) out.charge = invoice._charge;
  Object.assign(out, {
    collection_method: invoice.collection_method,
    created: invoice.created,
    currency: invoice.currency,
    custom_fields: structuredClone(invoice.custom_fields),
    customer: invoice.customer,
  });
  if (ctx.family === 'F3') out.customer_account = invoice.customer_account ?? null;
  Object.assign(out, {
    customer_address: structuredClone(invoice.customer_address),
    customer_email: invoice.customer_email,
    customer_name: invoice.customer_name,
    customer_phone: invoice.customer_phone,
    customer_shipping: structuredClone(invoice.customer_shipping),
    customer_tax_exempt: invoice.customer_tax_exempt,
    customer_tax_ids: structuredClone(invoice.customer_tax_ids),
    default_payment_method: invoice.default_payment_method,
    default_source: invoice.default_source,
    default_tax_rates: [...invoice.default_tax_rates],
    description: invoice.description,
  });
  if (f1) out.discount = null;
  Object.assign(out, {
    discounts: [...invoice.discounts],
    due_date: invoice.due_date,
    effective_at: invoice.effective_at,
    ending_balance: invoice.ending_balance,
    footer: invoice.footer,
    from_invoice: structuredClone(invoice.from_invoice),
    hosted_invoice_url: invoice.hosted_invoice_url,
    invoice_pdf: invoice.invoice_pdf,
    issuer: structuredClone(invoice.issuer),
    last_finalization_error: structuredClone(invoice.last_finalization_error),
    latest_revision: invoice.latest_revision,
    lines: {
      object: 'list',
      data: lines.slice(0, 10).map((l) => renderLineItem(l, ctx)),
      has_more: lines.length > 10,
      total_count: lines.length,
      url: invoice.lines.url,
    },
    livemode: false,
    metadata: { ...invoice.metadata },
    next_payment_attempt: invoice.next_payment_attempt,
    number: invoice.number,
    on_behalf_of: invoice.on_behalf_of,
  });
  if (f1) {
    out.paid = invoice.status === 'paid';
    out.paid_out_of_band = Boolean(invoice._paidOutOfBand);
    out.payment_intent = invoice._paymentIntent;
  } else {
    out.parent = structuredClone(invoice.parent);
  }
  Object.assign(out, {
    payment_settings: structuredClone(invoice.payment_settings),
    period_end: invoice.period_end,
    period_start: invoice.period_start,
    post_payment_credit_notes_amount: invoice.post_payment_credit_notes_amount,
    pre_payment_credit_notes_amount: invoice.pre_payment_credit_notes_amount,
  });
  if (f1) out.quote = null;
  Object.assign(out, {
    receipt_number: invoice.receipt_number,
    rendering: structuredClone(invoice.rendering),
    shipping_cost: structuredClone(invoice.shipping_cost),
    shipping_details: structuredClone(invoice.shipping_details),
    starting_balance: invoice.starting_balance,
    statement_descriptor: invoice.statement_descriptor,
    status: invoice.status,
    status_transitions: { ...invoice.status_transitions },
  });
  if (f1) {
    const details = invoice.parent?.subscription_details ?? null;
    out.subscription = details?.subscription ?? null;
    out.subscription_details = details ? { metadata: structuredClone(details.metadata) } : null;
    if (details?.subscription_proration_date !== undefined) out.subscription_proration_date = details.subscription_proration_date;
  }
  out.subtotal = invoice.subtotal;
  out.subtotal_excluding_tax = invoice.subtotal_excluding_tax;
  if (f1) out.tax = null;
  Object.assign(out, {
    test_clock: invoice.test_clock,
    total: invoice.total,
    total_discount_amounts: [...invoice.total_discount_amounts],
    total_excluding_tax: invoice.total_excluding_tax,
  });
  if (f1) {
    out.total_tax_amounts = [];
    out.transfer_data = null;
  } else {
    out.total_pretax_credit_amounts = [];
    out.total_taxes = [];
  }
  out.webhooks_delivered_at = invoice.webhooks_delivered_at;
  return out;
}

/** An InvoicePayment (docs.stripe.com/api/invoice-payment/object). */
export function renderInvoicePayment(p) {
  return {
    id: p.id,
    object: 'invoice_payment',
    amount_paid: p.amount_paid,
    amount_requested: p.amount_requested,
    created: p.created,
    currency: p.currency,
    invoice: p.invoice,
    is_default: p.is_default,
    livemode: false,
    payment: { ...p.payment },
    status: p.status,
    status_transitions: { ...p.status_transitions },
  };
}

/** An invoice item (docs.stripe.com/api/invoiceitems/object) for the context's version. */
export function renderInvoiceItem(ii, ctx) {
  if (ctx.family === 'F1') {
    const price = ctx.lookup(ii.pricing?.price_details?.price);
    const sub = ii.parent?.subscription_details ?? null;
    const out = {
      id: ii.id,
      object: 'invoiceitem',
      amount: ii.amount,
      currency: ii.currency,
      customer: ii.customer,
      date: ii.date,
      description: ii.description,
      discountable: ii.discountable,
      discounts: [],
      invoice: ii.invoice,
      livemode: false,
      metadata: { ...ii.metadata },
      period: { ...ii.period },
      plan: price && price.recurring ? renderPlan(price, ctx) : null,
      price: price ? ctx.render(price) : null,
      proration: ii.proration,
      quantity: ii.quantity,
      subscription: sub?.subscription ?? null,
    };
    if (sub?.subscription_item) out.subscription_item = sub.subscription_item;
    Object.assign(out, {
      tax_rates: [],
      test_clock: ii.test_clock,
      unit_amount: Math.round(Number(ii.pricing?.unit_amount_decimal ?? 0)),
      unit_amount_decimal: ii.pricing?.unit_amount_decimal ?? null,
    });
    return out;
  }
  const out = { id: ii.id, object: 'invoiceitem', amount: ii.amount, currency: ii.currency, customer: ii.customer };
  if (ctx.family === 'F3') out.customer_account = null;
  Object.assign(out, {
    date: ii.date,
    description: ii.description,
    discountable: ii.discountable,
    discounts: [],
    invoice: ii.invoice,
    livemode: false,
    metadata: { ...ii.metadata },
    parent: structuredClone(ii.parent),
    period: { ...ii.period },
    pricing: structuredClone(ii.pricing),
    proration: ii.proration,
    proration_details: structuredClone(ii.proration_details),
    quantity: ii.quantity,
  });
  if (ctx.atLeast('2026-03-25.dahlia')) out.quantity_decimal = ii.quantity_decimal;
  out.tax_rates = [];
  out.test_clock = ii.test_clock;
  return out;
}

// Lines pagination (invoice order, not newest first) -----------------------------------------------

function paginateLines(invoice, params) {
  const limit = params.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalidRequest('Invalid limit: must be between 1 and 100', { param: 'limit', validation: true });
  }
  if (params.starting_after && params.ending_before) throw parametersExclusive(['starting_after', 'ending_before'], { param: 'ending_before' });
  const lines = invoice.lines.data;
  const url = invoice.lines.url;
  const indexOf = (param) => {
    const i = lines.findIndex((l) => l.id === params[param]);
    if (i < 0) throw resourceMissing('line_item', params[param], { param });
    return i;
  };
  if (params.starting_after) {
    const rest = lines.slice(indexOf('starting_after') + 1);
    return new ListResult({ data: rest.slice(0, limit), hasMore: rest.length > limit, url, total: lines.length });
  }
  if (params.ending_before) {
    const before = lines.slice(0, indexOf('ending_before'));
    return new ListResult({ data: before.slice(Math.max(0, before.length - limit)), hasMore: before.length > limit, url, total: lines.length });
  }
  return new ListResult({ data: lines.slice(0, limit), hasMore: lines.length > limit, url, total: lines.length });
}

// Install ---------------------------------------------------------------------------------------

export function install(app) {
  app.object('invoice', {
    render: renderInvoice,
    expandable: [
      'customer',
      'default_payment_method',
      'default_source',
      'latest_revision',
      'on_behalf_of',
      'application',
      'test_clock',
      'discounts',
      'account_tax_ids',
      'default_tax_rates',
      'issuer.account',
      'automatic_tax.liability.account',
      'from_invoice.invoice',
      'total_discount_amounts.discount',
      'parent.subscription_details.subscription',
      'parent.quote_details.quote',
      'subscription',
      'payment_intent',
      'charge',
      'quote',
    ],
    includable: {
      payments: (json, ctx) => {
        if (ctx.family === 'F1') throw cannotExpand('payments');
        const invoice = ctx.lookup(json.id);
        const payments = (invoice?._payments ?? []).map((id) => ctx.lookup(id)).filter(Boolean);
        return { object: 'list', data: payments.map((p) => ctx.render(p)), has_more: false, total_count: payments.length, url: '/v1/invoice_payments' };
      },
      confirmation_secret: (json, ctx) => {
        if (ctx.family === 'F1') throw cannotExpand('confirmation_secret');
        const invoice = ctx.lookup(json.id);
        const pi = invoice?._paymentIntent ? ctx.lookup(invoice._paymentIntent) : null;
        if (!pi || invoice.status !== 'open') return null;
        return { client_secret: pi.client_secret ?? `${pi.id}_secret_${invoice._token.slice(5, 29)}`, type: 'payment_intent' };
      },
      amount_paid_off_stripe: (json, ctx) => {
        if (!ctx.atLeast('2026-05-27.dahlia')) throw cannotExpand('amount_paid_off_stripe');
        const invoice = ctx.lookup(json.id);
        return invoice?._paidOutOfBand ? invoice.amount_paid : 0;
      },
    },
  });
  app.object('line_item', {
    render: renderLineItem,
    expandable: ['discounts', 'subscription', 'pricing.price_details.price', 'invoice_item', 'subscription_item', 'discount_amounts.discount'],
  });
  app.object('invoice_payment', {
    render: renderInvoicePayment,
    expandable: ['invoice', 'payment.payment_intent', 'payment.charge'],
  });
  app.object('invoiceitem', {
    render: renderInvoiceItem,
    expandable: ['customer', 'invoice', 'discounts', 'test_clock', 'pricing.price_details.price', 'subscription'],
  });

  app.route('GET', '/v1/invoices', (ctx) => {
    const { account, params: p } = ctx;
    const invoices = account.store.list('invoice', (i) => {
      const sub = i.parent?.subscription_details?.subscription ?? null;
      if (p.customer !== undefined && i.customer !== p.customer) return false;
      if (p.subscription !== undefined && sub !== p.subscription) return false;
      // Test-clock invoices appear only with a customer or subscription clause.
      if (p.customer === undefined && p.subscription === undefined && i.test_clock) return false;
      if (p.status !== undefined && i.status !== p.status) return false;
      if (p.collection_method !== undefined && i.collection_method !== p.collection_method) return false;
      if (!matchesRange(i.created, p.created)) return false;
      if (p.due_date !== undefined && (i.due_date === null || !matchesRange(i.due_date, p.due_date))) return false;
      return true;
    });
    return paginate(invoices, p, { url: '/v1/invoices', noun: 'invoice', find: (id) => account.store.get('invoice', id) });
  });

  app.route('GET', '/v1/invoices/:id', (ctx) => ctx.account.store.require('invoice', ctx.pathParams.id));

  app.route('GET', '/v1/invoices/:id/lines', (ctx) => paginateLines(ctx.account.store.require('invoice', ctx.pathParams.id), ctx.params));

  app.route('POST', '/v1/invoices/:id/pay', (ctx) => {
    const { account, params: p } = ctx;
    const invoice = account.store.require('invoice', ctx.pathParams.id);
    if (p.source !== undefined) throw resourceMissing('source', p.source, { param: 'source' });
    const res = payInvoice(account, invoice, {
      paymentMethod: p.payment_method,
      offSession: p.off_session ?? true,
      paidOutOfBand: p.paid_out_of_band ?? false,
      source: 'api',
    });
    if (!res.ok) throw res.error;
    return invoice;
  });

  app.route('POST', '/v1/invoices/:id/void', (ctx) => voidInvoice(ctx.account, ctx.account.store.require('invoice', ctx.pathParams.id)));

  app.route('POST', '/v1/invoices/:id/finalize', (ctx) => {
    const { account, params: p } = ctx;
    const invoice = account.store.require('invoice', ctx.pathParams.id);
    if (invoice.status !== 'draft') throw invalidRequest(`This invoice is already finalized, you can't re-finalize a non-draft invoice.`);
    if (p.auto_advance !== undefined) invoice.auto_advance = p.auto_advance;
    account.time.cancel(`${invoice.id}:finalize`);
    // With auto_advance on, automatic collection follows (not before the ~1 h after creation).
    const collect = invoice.auto_advance && invoice.collection_method === 'charge_automatically';
    const at = Math.max(nowOf(account, invoice), invoice.created + DRAFT_WINDOW_SECONDS);
    invoice.next_payment_attempt = collect ? at : null;
    finalizeInvoice(account, invoice);
    if (invoice.status === 'open' && collect) {
      account.time.schedule({
        kind: 'invoice.payment_attempt',
        at,
        domain: account.time.domainOf(invoice),
        key: `${invoice.id}:attempt`,
        data: { invoice: invoice.id },
        priority: JOB_PRIORITY.paymentRetry,
      });
    }
    return invoice;
  });

  app.route('POST', '/v1/invoices/:id/mark_uncollectible', (ctx) =>
    markUncollectible(ctx.account, ctx.account.store.require('invoice', ctx.pathParams.id)),
  );

  app.route('GET', '/v1/invoice_payments', (ctx) => {
    const { account, params: p } = ctx;
    const payments = account.store.list('invoice_payment', (x) => {
      if (p.invoice !== undefined && x.invoice !== p.invoice) return false;
      if (p.status !== undefined && x.status !== p.status) return false;
      if (p.payment !== undefined) {
        if (x.payment.type !== p.payment.type) return false;
        if (p.payment.payment_intent !== undefined && x.payment.payment_intent !== p.payment.payment_intent) return false;
        if (p.payment.payment_record !== undefined && x.payment.payment_record !== p.payment.payment_record) return false;
      }
      return matchesRange(x.created, p.created);
    });
    return paginate(payments, p, { url: '/v1/invoice_payments', noun: 'invoice_payment', find: (id) => account.store.get('invoice_payment', id) });
  });

  app.route('GET', '/v1/invoice_payments/:id', (ctx) => ctx.account.store.require('invoice_payment', ctx.pathParams.id));
}
