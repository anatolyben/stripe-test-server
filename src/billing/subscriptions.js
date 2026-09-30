/**
 * Subscriptions and subscription items API, docs.stripe.com/api/subscriptions.
 *
 * Routes: POST /v1/subscriptions, GET /v1/subscriptions, GET /v1/subscriptions/:id,
 * POST /v1/subscriptions/:id, DELETE /v1/subscriptions/:id, POST /v1/subscriptions/:id/resume,
 * GET /v1/subscription_items, GET /v1/subscription_items/:id.
 * Objects: 'subscription' (2024-06-20 has subscription-level current_period_start/end and
 * `discount`; billing_mode from 2025-06-30.basil; billing_schedules from 2026-05-27.dahlia),
 * 'subscription_item' (item-level periods from 2025-03-31.basil; embedded `price` and the legacy
 * `plan` derived from the price) and 'plan'. Handlers turn params into engine calls; every state
 * change happens in engine.js.
 */
import { invalidRequest, parameterMissing, parametersExclusive, resourceMissing } from '../core/errors.js';
import { paginate, matchesRange } from '../core/list.js';
import { requireCustomer } from '../customers/customers.js';
import { insertPrice, preparePrice, requirePrice } from '../catalog/prices.js';
import {
  cancelSubscription,
  createSubscription,
  currentPeriod,
  resumeSubscription,
  updateSubscription,
} from './engine.js';
import { DAY, MAX_TRIAL_SECONDS, attachedPaymentMethod, oneIntervalAfter } from './util.js';

// Params → engine specs ------------------------------------------------------------------------

function unsupported(param, what) {
  return invalidRequest(`${what} is not supported by this test server.`, { param });
}

/** Rejects Connect-only and unmodelled parameters, and coupons (not modelled: resource_missing). */
function rejectUnsupported(p) {
  for (const key of ['transfer_data', 'on_behalf_of', 'application_fee_percent']) {
    if (p[key] !== undefined && p[key] !== '') throw unsupported(key, `The ${key} parameter (Connect)`);
  }
  if (p.customer_account !== undefined) throw unsupported('customer_account', 'The customer_account parameter (Accounts v2)');
  if (p.billing_schedules !== undefined && p.billing_schedules !== '' && p.billing_schedules.length) {
    throw unsupported('billing_schedules', 'The billing_schedules parameter (prebilling)');
  }
  for (const key of ['coupon', 'promotion_code']) {
    if (p[key] !== undefined && p[key] !== '') throw resourceMissing(key, p[key], { param: key });
  }
  rejectDiscounts(p.discounts, 'discounts');
  if (p.default_source !== undefined && p.default_source !== '') throw resourceMissing('source', p.default_source, { param: 'default_source' });
}

export function rejectDiscounts(discounts, param) {
  if (discounts === undefined || discounts === '' || !discounts.length) return;
  discounts.forEach((d, i) => {
    if (d.coupon) throw resourceMissing('coupon', d.coupon, { param: `${param}[${i}][coupon]` });
    if (d.promotion_code) throw resourceMissing('promotion_code', d.promotion_code, { param: `${param}[${i}][promotion_code]` });
    if (d.discount) throw resourceMissing('discount', d.discount, { param: `${param}[${i}][discount]` });
  });
}

/** A live, active price by ID for `param` (recurring for items, one-time for add_invoice_items). */
function lookupPrice(account, id, param, { recurring }) {
  const price = requirePrice(account, id, { param, active: true });
  if (recurring && !price.recurring) {
    throw invalidRequest(`The price specified (${id}) is set to \`type=one_time\` but this field only accepts prices with \`type=recurring\`.`, { param });
  }
  if (!recurring && price.recurring) {
    throw invalidRequest(`The price specified (${id}) is a recurring price; add_invoice_items only accepts one-time prices.`, { param });
  }
  return price;
}

/**
 * Resolves an item's price param (price, legacy plan, or price_data). price_data is validated now
 * (as a POST /v1/prices body) and becomes an inline price only when the request is applied
 * (`materialize`); until then the engine works with a draft carrying the same fields.
 */
export function resolveItemPrice(ctx, entry, param, { recurring, required }) {
  const { account } = ctx;
  const given = ['price', 'plan', 'price_data'].filter((k) => entry[k] !== undefined);
  if (given.length > 1) throw parametersExclusive(given.map((k) => `${param}[${k}]`), { param: `${param}[${given[1]}]` });
  if (entry.price !== undefined) return { price: lookupPrice(account, entry.price, `${param}[price]`, { recurring }) };
  if (entry.plan !== undefined) return { price: lookupPrice(account, entry.plan, `${param}[plan]`, { recurring }) };
  if (entry.price_data !== undefined) {
    const prefix = `${param}[price_data]`;
    const prepared = preparePrice(account, { ...entry.price_data }, { version: ctx.version, paramPrefix: prefix });
    if (recurring && !prepared.fields.recurring) throw parameterMissing(`${prefix}[recurring]`);
    const draft = {
      id: prefix,
      object: 'price',
      ...structuredClone(prepared.fields),
      created: ctx.now(),
      livemode: false,
      product: prepared.productId,
    };
    return { price: draft, prepared };
  }
  if (required) throw parameterMissing(`${param}[price]`);
  return { price: null };
}

/**
 * Creates the inline prices of price_data entries once every check passed (the engine calls this
 * right before its first change). The draft objects the engine already holds become the real
 * prices in place, so its plan keeps pointing at them.
 */
export function materialize(account, resolved) {
  for (const r of resolved) {
    if (!r.prepared || r.materialized) continue;
    const price = insertPrice(account, r.prepared, { product: r.prepared.productId, inline: true });
    for (const key of Object.keys(r.price)) delete r.price[key];
    Object.assign(r.price, price);
    r.materialized = true;
  }
}

export function checkQuantity(price, quantity, param) {
  if (quantity === undefined) return;
  if (quantity < 0) throw invalidRequest('Invalid quantity: must be a non-negative integer.', { param });
  if (price?.recurring?.usage_type === 'metered') throw invalidRequest('Quantity cannot be set for metered prices.', { param });
}

function checkAnchorConfig(cfg, price) {
  const bad = (key, lo, hi) => cfg[key] !== undefined && (cfg[key] < lo || cfg[key] > hi);
  const param = (key) => `billing_cycle_anchor_config[${key}]`;
  if (bad('day_of_month', 1, 31)) throw invalidRequest('day_of_month must be between 1 and 31.', { param: param('day_of_month') });
  if (bad('hour', 0, 23)) throw invalidRequest('hour must be between 0 and 23.', { param: param('hour') });
  if (bad('minute', 0, 59)) throw invalidRequest('minute must be between 0 and 59.', { param: param('minute') });
  if (bad('second', 0, 59)) throw invalidRequest('second must be between 0 and 59.', { param: param('second') });
  if (bad('month', 1, 12)) throw invalidRequest('month must be between 1 and 12.', { param: param('month') });
  if (!['month', 'year'].includes(price.recurring.interval)) {
    throw invalidRequest('billing_cycle_anchor_config is only valid with monthly and yearly prices.', { param: 'billing_cycle_anchor_config' });
  }
  if (cfg.month !== undefined && price.recurring.interval !== 'year') {
    throw invalidRequest('billing_cycle_anchor_config[month] is only valid with yearly prices.', { param: param('month') });
  }
}

function checkPaymentMethod(account, id, customer, param) {
  if (id === undefined) return;
  if (!attachedPaymentMethod(account, id, customer.id)) {
    if (!account.store.get('payment_method', id)) throw resourceMissing('payment_method', id, { param });
    throw invalidRequest(`The customer does not have a payment method with the ID ${id}. The payment method must be attached to the customer.`, { param });
  }
}

/** Converts validated POST /v1/subscriptions params into an engine spec (checks included). */
function createSpec(ctx) {
  const { account, params: p } = ctx;
  rejectUnsupported(p);
  const customer = requireCustomer(account, p.customer, { param: 'customer' });
  const now = account.time.now(account.time.domainOf(customer));
  if (!p.items || !p.items.length) throw parameterMissing('items');
  if (p.payment_behavior === 'pending_if_incomplete') {
    throw invalidRequest('payment_behavior=pending_if_incomplete can only be used when updating a subscription.', { param: 'payment_behavior' });
  }
  if (p.proration_behavior === 'always_invoice') {
    throw invalidRequest('proration_behavior=always_invoice is not supported when creating a subscription.', { param: 'proration_behavior' });
  }
  const items = p.items.map((e, i) => {
    const param = `items[${i}]`;
    rejectDiscounts(e.discounts, `${param}[discounts]`);
    if (e.tax_rates !== undefined && e.tax_rates !== '' && e.tax_rates.length) throw resourceMissing('tax_rate', e.tax_rates[0], { param: `${param}[tax_rates][0]` });
    const r = resolveItemPrice(ctx, e, param, { recurring: true, required: true });
    checkQuantity(r.price, e.quantity, `${param}[quantity]`);
    return { ...r, quantity: r.price.recurring.usage_type === 'metered' ? undefined : e.quantity ?? 1, metadata: e.metadata === '' ? {} : e.metadata };
  });
  const adds = (p.add_invoice_items ?? []).map((e, i) => {
    const param = `add_invoice_items[${i}]`;
    rejectDiscounts(e.discounts, `${param}[discounts]`);
    const r = resolveItemPrice(ctx, e, param, { recurring: false, required: true });
    checkQuantity(r.price, e.quantity, `${param}[quantity]`);
    return { ...r, quantity: e.quantity ?? 1, metadata: e.metadata };
  });
  if (p.currency !== undefined && items.some((it) => it.price.currency !== p.currency)) {
    throw invalidRequest(`The currency ${p.currency} does not match the currency of the prices on this subscription.`, { param: 'currency' });
  }
  if (p.trial_end !== undefined && p.trial_period_days !== undefined) throw parametersExclusive(['trial_end', 'trial_period_days'], { param: 'trial_period_days' });
  if (p.trial_from_plan && p.trial_end !== undefined) throw invalidRequest('trial_from_plan cannot be set together with trial_end.', { param: 'trial_from_plan' });
  if (typeof p.trial_end === 'number' && p.trial_end <= now) {
    throw invalidRequest('Invalid timestamp: must be an integer Unix timestamp in the future.', { param: 'trial_end' });
  }
  if (typeof p.trial_end === 'number' && p.trial_end - now > MAX_TRIAL_SECONDS) {
    throw invalidRequest('trial_end can be at most two years from the billing cycle anchor.', { param: 'trial_end' });
  }
  if (p.trial_period_days !== undefined && (p.trial_period_days < 0 || p.trial_period_days > 730)) {
    throw invalidRequest('The trial period must be 730 days (2 years) or less.', { param: 'trial_period_days' });
  }
  if (p.billing_cycle_anchor !== undefined && p.billing_cycle_anchor_config !== undefined) {
    throw parametersExclusive(['billing_cycle_anchor', 'billing_cycle_anchor_config'], { param: 'billing_cycle_anchor_config' });
  }
  const trialEnd = typeof p.trial_end === 'number' ? p.trial_end : p.trial_period_days ? now + p.trial_period_days * DAY : null;
  if (p.billing_cycle_anchor !== undefined) {
    const from = trialEnd ?? now;
    if (p.billing_cycle_anchor <= now) throw invalidRequest('billing_cycle_anchor must be a timestamp in the future.', { param: 'billing_cycle_anchor' });
    if (trialEnd !== null && p.billing_cycle_anchor < trialEnd) throw invalidRequest('billing_cycle_anchor cannot be earlier than trial_end.', { param: 'billing_cycle_anchor' });
    if (p.billing_cycle_anchor > oneIntervalAfter(items[0].price, from)) {
      throw invalidRequest('billing_cycle_anchor cannot be more than one billing interval in the future.', { param: 'billing_cycle_anchor' });
    }
  }
  if (p.billing_cycle_anchor_config !== undefined) checkAnchorConfig(p.billing_cycle_anchor_config, items[0].price);
  if (p.backdate_start_date !== undefined) {
    if (p.backdate_start_date >= now) throw invalidRequest('backdate_start_date must be in the past.', { param: 'backdate_start_date' });
    if (p.billing_cycle_anchor_config !== undefined) throw invalidRequest('billing_cycle_anchor_config does not support a backdated start date.', { param: 'backdate_start_date' });
  }
  const collectionMethod = p.collection_method ?? 'charge_automatically';
  if (collectionMethod === 'send_invoice' && p.days_until_due === undefined) throw parameterMissing('days_until_due');
  if (collectionMethod === 'charge_automatically' && p.days_until_due !== undefined) {
    throw invalidRequest('days_until_due can only be set when collection_method is send_invoice.', { param: 'days_until_due' });
  }
  checkPaymentMethod(account, p.default_payment_method, customer, 'default_payment_method');
  if (p.billing_mode?.flexible && p.billing_mode.type !== 'flexible') {
    throw invalidRequest('billing_mode[flexible] can only be set with billing_mode[type]=flexible.', { param: 'billing_mode[flexible]' });
  }
  const spec = {
    customer,
    items: items.map((it) => ({ price: it.price, quantity: it.quantity, metadata: it.metadata })),
    addInvoiceItems: adds.map((a) => ({ price: a.price, quantity: a.quantity })),
    metadata: p.metadata === '' ? {} : p.metadata,
    description: p.description,
    defaultPaymentMethod: p.default_payment_method,
    collectionMethod,
    daysUntilDue: p.days_until_due,
    trialEnd: p.trial_end,
    trialPeriodDays: p.trial_period_days,
    trialFromPlan: p.trial_from_plan,
    trialSettings: trialSettingsOf(p.trial_settings),
    billingCycleAnchor: p.billing_cycle_anchor,
    billingCycleAnchorConfig: p.billing_cycle_anchor_config,
    backdateStartDate: p.backdate_start_date,
    billingMode: p.billing_mode?.type,
    prorationDiscounts: p.billing_mode?.flexible?.proration_discounts,
    cancelAt: p.cancel_at,
    cancelAtPeriodEnd: p.cancel_at_period_end,
    paymentBehavior: p.payment_behavior,
    prorationBehavior: p.proration_behavior,
    offSession: p.off_session,
    invoiceSettings: normalizeInvoiceSettings(p.invoice_settings),
    paymentSettings: normalizePaymentSettings(p.payment_settings),
    automaticTax: p.automatic_tax,
    billingThresholds: p.billing_thresholds === '' ? null : p.billing_thresholds,
    pendingInvoiceItemInterval: p.pending_invoice_item_interval === '' ? null : p.pending_invoice_item_interval,
  };
  return { spec, resolved: [...items, ...adds] };
}

/** trial_settings param → the engine's { endBehavior: { missingPaymentMethod } }. */
function trialSettingsOf(s) {
  if (s === undefined) return undefined;
  return { endBehavior: { missingPaymentMethod: s.end_behavior.missing_payment_method } };
}

function normalizeInvoiceSettings(s) {
  if (s === undefined) return undefined;
  return {
    account_tax_ids: s.account_tax_ids === '' ? null : s.account_tax_ids ?? null,
    custom_fields: s.custom_fields === '' ? null : s.custom_fields?.map((f) => ({ name: f.name, value: f.value })) ?? null,
    description: s.description === '' ? null : s.description ?? null,
    footer: s.footer === '' ? null : s.footer ?? null,
    issuer: s.issuer ?? { type: 'self' },
  };
}

function normalizePaymentSettings(s) {
  if (s === undefined) return undefined;
  return {
    payment_method_options: s.payment_method_options ?? null,
    payment_method_types: s.payment_method_types === '' ? null : s.payment_method_types ?? null,
    save_default_payment_method: s.save_default_payment_method ?? 'off',
  };
}

/** Converts validated POST /v1/subscriptions/:id params into an engine update (checks included). */
function updateSpec(ctx, sub) {
  const { account, params: p } = ctx;
  rejectUnsupported(p);
  const customer = account.store.get('customer', sub.customer);
  const resolved = [];
  const items = p.items?.map((e, i) => {
    const param = `items[${i}]`;
    rejectDiscounts(e.discounts, `${param}[discounts]`);
    if (e.tax_rates !== undefined && e.tax_rates !== '' && e.tax_rates.length) throw resourceMissing('tax_rate', e.tax_rates[0], { param: `${param}[tax_rates][0]` });
    const r = resolveItemPrice(ctx, e, param, { recurring: true, required: false });
    resolved.push(r);
    const current = e.id ? sub.items.data.find((it) => it.id === e.id) : null;
    checkQuantity(r.price ?? (current ? account.store.get('price', current.price) : null), e.quantity, `${param}[quantity]`);
    return { id: e.id, deleted: e.deleted, quantity: e.quantity, metadata: e.metadata, param, price: r.price ?? undefined };
  });
  const adds = (p.add_invoice_items ?? []).map((e, i) => {
    const param = `add_invoice_items[${i}]`;
    rejectDiscounts(e.discounts, `${param}[discounts]`);
    const r = resolveItemPrice(ctx, e, param, { recurring: false, required: true });
    checkQuantity(r.price, e.quantity, `${param}[quantity]`);
    resolved.push(r);
    return { price: r.price, quantity: e.quantity ?? 1, metadata: e.metadata };
  });
  if (p.default_payment_method !== undefined) checkPaymentMethod(account, p.default_payment_method, customer, 'default_payment_method');
  if (p.pause_collection && p.pause_collection !== '' && p.pause_collection.resumes_at !== undefined) {
    if (p.pause_collection.resumes_at <= account.time.now(account.time.domainOf(sub))) {
      throw invalidRequest('pause_collection[resumes_at] must be in the future.', { param: 'pause_collection[resumes_at]' });
    }
  }
  const u = {
    items,
    prorationBehavior: p.proration_behavior,
    prorationDate: p.proration_date,
    billingCycleAnchor: p.billing_cycle_anchor === 'unchanged' ? undefined : p.billing_cycle_anchor,
    paymentBehavior: p.payment_behavior,
    offSession: p.off_session,
    cancelAtPeriodEnd: p.cancel_at_period_end,
    cancelAt: p.cancel_at === '' ? null : p.cancel_at,
    cancellationDetails: p.cancellation_details,
    trialEnd: p.trial_end,
    trialFromPlan: p.trial_from_plan,
    trialSettings: trialSettingsOf(p.trial_settings),
    metadata: p.metadata,
    description: p.description,
    defaultPaymentMethod: p.default_payment_method,
    defaultSource: p.default_source,
    collectionMethod: p.collection_method,
    daysUntilDue: p.days_until_due,
    pauseCollection: p.pause_collection,
    addInvoiceItems: adds.length ? adds : undefined,
    invoiceSettings: p.invoice_settings,
    paymentSettings: normalizePaymentSettings(p.payment_settings),
    automaticTax: p.automatic_tax,
    billingThresholds: p.billing_thresholds,
    pendingInvoiceItemInterval: p.pending_invoice_item_interval,
  };
  return { u, resolved };
}

// Serializers -----------------------------------------------------------------------------------

/** The legacy `plan` object derived from a recurring price (docs.stripe.com/api/plans/object). */
export function renderPlan(price, ctx) {
  if (!price || !price.recurring) return null;
  const tiered = price.billing_scheme === 'tiered';
  const out = { id: price.id, object: 'plan', active: price.active };
  if (ctx.family === 'F1') out.aggregate_usage = price._aggregateUsage ?? price.recurring.aggregate_usage ?? null;
  Object.assign(out, {
    amount: tiered ? null : price.unit_amount ?? null,
    amount_decimal: tiered ? null : price.unit_amount_decimal ?? (price.unit_amount !== null && price.unit_amount !== undefined ? String(price.unit_amount) : null),
    billing_scheme: price.billing_scheme ?? 'per_unit',
    created: price.created,
    currency: price.currency,
    interval: price.recurring.interval,
    interval_count: price.recurring.interval_count ?? 1,
    livemode: false,
    metadata: { ...(price.metadata ?? {}) },
    meter: price.recurring.meter ?? null,
    nickname: price.nickname ?? null,
    product: price.product,
    tiers_mode: price.tiers_mode ?? null,
    transform_usage: price.transform_quantity ? { divide_by: price.transform_quantity.divide_by, round: price.transform_quantity.round } : null,
    trial_period_days: price.recurring.trial_period_days ?? null,
    usage_type: price.recurring.usage_type ?? 'licensed',
  });
  return out;
}

/** The wire form of a subscription item (item-level periods from 2025-03-31.basil). */
export function renderSubscriptionItem(item, ctx) {
  const price = ctx.lookup(item.price);
  const out = { id: item.id, object: 'subscription_item', billing_thresholds: structuredClone(item.billing_thresholds ?? null), created: item.created };
  if (ctx.family !== 'F1') {
    out.current_period_end = item.current_period_end;
    out.current_period_start = item.current_period_start;
  }
  Object.assign(out, {
    discounts: [...(item.discounts ?? [])],
    metadata: { ...(item.metadata ?? {}) },
    plan: renderPlan(price, ctx),
    price: price ? ctx.render(price) : item.price,
  });
  if (item.quantity !== undefined && item.quantity !== null) out.quantity = item.quantity;
  out.subscription = item.subscription;
  out.tax_rates = [];
  return out;
}

function renderPendingUpdate(pending, ctx) {
  if (!pending) return null;
  const out = { billing_cycle_anchor: pending.billing_cycle_anchor };
  if (ctx.family !== 'F1') {
    out.discount = pending.discount ?? null;
    out.discounts = pending.discounts ?? null;
  }
  out.expires_at = pending.expires_at;
  if (ctx.family !== 'F1') out.metadata = pending.metadata ?? null;
  out.subscription_items = pending.subscription_items ? pending.subscription_items.map((i) => renderSubscriptionItem(i, ctx)) : null;
  out.trial_end = pending.trial_end;
  out.trial_from_plan = pending.trial_from_plan;
  return out;
}

/** The wire form of a subscription for the context's version family. */
export function renderSubscription(sub, ctx) {
  const f1 = ctx.family === 'F1';
  const itemsData = sub.items.data;
  const out = {
    id: sub.id,
    object: 'subscription',
    application: null,
    application_fee_percent: sub.application_fee_percent ?? null,
    automatic_tax: f1
      ? { enabled: sub.automatic_tax.enabled, liability: structuredClone(sub.automatic_tax.liability) }
      : { disabled_reason: sub.automatic_tax.disabled_reason ?? null, enabled: sub.automatic_tax.enabled, liability: structuredClone(sub.automatic_tax.liability) },
    billing_cycle_anchor: sub.billing_cycle_anchor,
    billing_cycle_anchor_config: structuredClone(sub.billing_cycle_anchor_config),
  };
  if (!f1 && ctx.atLeast('2025-06-30.basil')) out.billing_mode = structuredClone(sub.billing_mode);
  if (ctx.atLeast('2026-05-27.dahlia')) out.billing_schedules = structuredClone(sub.billing_schedules ?? []);
  Object.assign(out, {
    billing_thresholds: structuredClone(sub.billing_thresholds),
    cancel_at: sub.cancel_at,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at,
    cancellation_details: f1
      ? { comment: sub.cancellation_details.comment, feedback: sub.cancellation_details.feedback, reason: sub.cancellation_details.reason }
      : { ...sub.cancellation_details },
    collection_method: sub.collection_method,
    created: sub.created,
    currency: sub.currency,
  });
  if (f1) {
    const period = currentPeriod(sub);
    out.current_period_end = period.end;
    out.current_period_start = period.start;
  }
  out.customer = sub.customer;
  if (ctx.family === 'F3') out.customer_account = sub.customer_account ?? null;
  Object.assign(out, {
    days_until_due: sub.days_until_due,
    default_payment_method: sub.default_payment_method,
    default_source: sub.default_source,
    default_tax_rates: [...(sub.default_tax_rates ?? [])],
    description: sub.description,
  });
  if (f1) out.discount = null;
  Object.assign(out, {
    discounts: [...sub.discounts],
    ended_at: sub.ended_at,
    invoice_settings: f1
      ? { account_tax_ids: structuredClone(sub.invoice_settings.account_tax_ids), issuer: structuredClone(sub.invoice_settings.issuer) }
      : structuredClone(sub.invoice_settings),
    items: {
      object: 'list',
      data: itemsData.slice(0, 10).map((i) => renderSubscriptionItem(i, ctx)),
      has_more: itemsData.length > 10,
      total_count: itemsData.length,
      url: sub.items.url,
    },
    latest_invoice: sub.latest_invoice,
    livemode: false,
  });
  if (ctx.atLeast('2026-03-25.dahlia')) out.managed_payments = sub.managed_payments ?? null;
  Object.assign(out, {
    metadata: { ...sub.metadata },
    next_pending_invoice_item_invoice: sub.next_pending_invoice_item_invoice,
    on_behalf_of: sub.on_behalf_of,
    pause_collection: structuredClone(sub.pause_collection),
    payment_settings: structuredClone(sub.payment_settings),
    pending_invoice_item_interval: structuredClone(sub.pending_invoice_item_interval),
    pending_setup_intent: sub.pending_setup_intent,
    pending_update: renderPendingUpdate(sub.pending_update, ctx),
    schedule: sub.schedule,
    start_date: sub.start_date,
    status: sub.status,
    test_clock: sub.test_clock,
    transfer_data: structuredClone(sub.transfer_data),
    trial_end: sub.trial_end,
    trial_settings: structuredClone(sub.trial_settings),
    trial_start: sub.trial_start,
  });
  return out;
}

// Lists -----------------------------------------------------------------------------------------

function listSubscriptions(ctx) {
  const { account, params: p } = ctx;
  const priceFilter = p.price ?? p.plan;
  const subs = account.store.list('subscription', (s) => {
    if (p.customer !== undefined && s.customer !== p.customer) return false;
    if (p.test_clock !== undefined ? s.test_clock !== p.test_clock : p.customer === undefined && s.test_clock) return false;
    if (p.status === undefined) {
      if (s.status === 'canceled') return false;
    } else if (p.status === 'ended') {
      if (!['canceled', 'incomplete_expired'].includes(s.status)) return false;
    } else if (p.status !== 'all' && s.status !== p.status) return false;
    if (priceFilter !== undefined && !s.items.data.some((i) => i.price === priceFilter)) return false;
    if (p.collection_method !== undefined && s.collection_method !== p.collection_method) return false;
    if (p.automatic_tax?.enabled !== undefined && s.automatic_tax.enabled !== p.automatic_tax.enabled) return false;
    if (!matchesRange(s.created, p.created)) return false;
    const period = currentPeriod(s);
    if (!matchesRange(period.end, p.current_period_end)) return false;
    if (!matchesRange(period.start, p.current_period_start)) return false;
    return true;
  });
  return paginate(subs, p, { url: '/v1/subscriptions', noun: 'subscription', find: (id) => account.store.get('subscription', id) });
}

// Install ---------------------------------------------------------------------------------------

export function install(app) {
  app.object('subscription', {
    render: renderSubscription,
    expandable: [
      'customer',
      'default_payment_method',
      'default_source',
      'latest_invoice',
      'pending_setup_intent',
      'schedule',
      'test_clock',
      'on_behalf_of',
      'application',
      'discounts',
      'default_tax_rates',
      'transfer_data.destination',
      'automatic_tax.liability.account',
      'invoice_settings.issuer.account',
      'invoice_settings.account_tax_ids',
      'cancellation_details.feedback_option',
      'pending_update.discounts',
    ],
  });
  app.object('subscription_item', {
    render: renderSubscriptionItem,
    expandable: ['discounts', 'tax_rates'],
    includable: {
      billed_until: (json, ctx) => {
        if (!ctx.atLeast('2026-05-27.dahlia')) throw invalidRequest('This property cannot be expanded (billed_until).', { param: 'expand' });
        return json.current_period_end ?? ctx.account.store.get('subscription_item', json.id)?.current_period_end ?? null;
      },
    },
  });
  app.object('plan', {
    render: (plan) => structuredClone(plan),
    expandable: ['product'],
    includable: {
      tiers: (json, ctx) => structuredClone(ctx.lookup(json.id)?.tiers ?? null),
    },
  });

  app.route('POST', '/v1/subscriptions', (ctx) => {
    const { spec, resolved } = createSpec(ctx);
    const beforeApply = () => materialize(ctx.account, resolved);
    return createSubscription(ctx.account, spec, { source: 'api', version: ctx.version, beforeApply }).subscription;
  });

  app.route('GET', '/v1/subscriptions', listSubscriptions);

  app.route('GET', '/v1/subscriptions/:id', (ctx) => {
    const sub = ctx.account.store.get('subscription', ctx.pathParams.id);
    if (!sub) throw resourceMissing('subscription', ctx.pathParams.id);
    return sub;
  });

  app.route('POST', '/v1/subscriptions/:id', (ctx) => {
    const sub = ctx.account.store.require('subscription', ctx.pathParams.id);
    const { u, resolved } = updateSpec(ctx, sub);
    // Inline prices (price_data) are created only once the engine has validated the whole update.
    const beforeApply = () => materialize(ctx.account, resolved);
    return updateSubscription(ctx.account, sub, u, { source: 'api', beforeApply }).subscription;
  });

  app.route('DELETE', '/v1/subscriptions/:id', (ctx) => {
    const sub = ctx.account.store.require('subscription', ctx.pathParams.id);
    const p = ctx.params;
    return cancelSubscription(ctx.account, sub, {
      invoiceNow: p.invoice_now ?? false,
      prorate: p.prorate ?? false,
      cancellationDetails: p.cancellation_details,
      source: 'api',
    });
  });

  app.route('POST', '/v1/subscriptions/:id/resume', (ctx) => {
    const sub = ctx.account.store.require('subscription', ctx.pathParams.id);
    const p = ctx.params;
    return resumeSubscription(ctx.account, sub, {
      billingCycleAnchor: p.billing_cycle_anchor,
      prorationBehavior: p.proration_behavior,
      prorationDate: p.proration_date,
    });
  });

  app.route('GET', '/v1/subscription_items', (ctx) => {
    const { account, params: p } = ctx;
    const sub = account.store.get('subscription', p.subscription);
    if (!sub) throw resourceMissing('subscription', p.subscription, { param: 'subscription' });
    return paginate(sub.items.data, p, {
      url: '/v1/subscription_items',
      noun: 'subscription_item',
      find: (id) => account.store.get('subscription_item', id),
    });
  });

  app.route('GET', '/v1/subscription_items/:id', (ctx) => {
    const item = ctx.account.store.get('subscription_item', ctx.pathParams.id);
    if (!item) throw resourceMissing('subscription_item', ctx.pathParams.id);
    return item;
  });
}
