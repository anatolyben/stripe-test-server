/**
 * The billing engine: every change to subscriptions and invoices.
 * No other module changes subscriptions or invoices directly; every other module
 * (Checkout, portal, schedules, test clocks, controls) calls these functions.
 *
 * install() registers the job kinds (renewal, trial end, trial_will_end, finalization after the
 * ~1 h draft window, payment retries per account.settings.billing, the final-retry action,
 * cancel_at / period-end cancels, incomplete_expired after 23 h, pause_collection.resumes_at,
 * pending-update and resume expiry) and two hooks: 'customer.deleting' (cancel the customer's live
 * subscriptions) and 'payment_method.detached' (a detached card stops being a subscription default).
 *
 * Common option: `request` = {id, idempotency_key} | null for the events it emits (default:
 * account.currentRequest). All functions are synchronous.
 *
 * Internal subscription = the 2026-08-26.dahlia wire shape (docs.stripe.com/api/subscriptions/object)
 * with `items.data` holding the subscription_item objects (also stored in the 'subscription_item'
 * collection, same instances) whose `price` is an ID. Private fields: _version (creating request's
 * API version), _resume, _pendingPlan; items keep _billed (the full-period amount last debited,
 * for flexible-mode credits) and _lastDebit (the line a credit proration points at).
 */
import { emitEvent, emitHeld, holdEvents } from '../core/events.js';
import { cardError, invalidRequest, parameterMissing, parametersExclusive, resourceMissing } from '../core/errors.js';
import { newestFirst } from '../core/list.js';
import { JOB_PRIORITY } from '../core/time.js';
import { atLeast } from '../core/versions.js';
import { minimumCharge } from '../core/currency.js';
import { applyMetadata } from '../core/util.js';
import { changeCustomer, requireCustomer } from '../customers/customers.js';
import { attachPaymentMethod } from '../payments/payment_methods.js';
import { confirmPaymentIntent, createPaymentIntent } from '../payments/payment_intents.js';
import * as schedules from '../schedules/schedules.js';
import * as inv from './invoicing.js';
import {
  DAY,
  ENDED_STATUSES,
  INCOMPLETE_EXPIRY_SECONDS,
  MAX_ITEMS,
  MAX_TRIAL_SECONDS,
  TRIAL_WILL_END_SECONDS,
  amountFor,
  attachedPaymentMethod,
  compatibleIntervals,
  defaultPaymentMethodFor,
  hasPaymentMethod,
  intervalOf,
  itemPeriodAt,
  maxItemPeriodEnd,
  nextItemBoundary,
  nowOf,
  oneIntervalAfter,
  prorate,
  prorationDescription,
  roundAmount,
  sameInterval,
  subscriptionLineDescription,
  subscriptionPeriod,
  trialLineDescription,
} from './util.js';

const { emitUpdated } = inv;

/** Job kinds of the engine (time-driven transitions). */
export const JOB = Object.freeze({
  renewal: 'subscription.renewal',
  trialEnd: 'subscription.trial_end',
  trialWillEnd: 'subscription.trial_will_end',
  cancelAt: 'subscription.cancel_at',
  incompleteExpire: 'subscription.incomplete_expire',
  pauseCollectionResume: 'subscription.pause_collection_resume',
  pendingUpdateExpire: 'subscription.pending_update_expire',
  resumeExpire: 'subscription.resume_expire',
  finalize: 'invoice.finalize',
  retry: 'invoice.payment_retry',
  attempt: 'invoice.payment_attempt',
  due: 'invoice.due',
});

// Lookups ---------------------------------------------------------------------------------------

function customerOf(account, sub) {
  return account.store.get('customer', sub.customer);
}

function priceOf(account, item) {
  return account.store.get('price', item.price);
}

/** The subscription's current period {start, end}: latest item start, earliest item end. */
export function currentPeriod(subscription) {
  return subscriptionPeriod(subscription);
}

/** A customer's subscriptions, newest first; without includeEnded, canceled and incomplete_expired are left out. */
export function subscriptionsForCustomer(account, customerId, { includeEnded = false } = {}) {
  return account.store
    .list('subscription', (s) => s.customer === customerId && (includeEnded || !ENDED_STATUSES.has(s.status)))
    .sort(newestFirst);
}

/** billing_mode default by the creating request's version: flexible from 2025-09-30.clover (docs.stripe.com/billing/subscriptions/billing-mode). */
export function defaultBillingMode(version) {
  return atLeast(version, '2025-09-30.clover') ? 'flexible' : 'classic';
}

// Jobs ------------------------------------------------------------------------------------------

function scheduleSubJob(account, sub, kind, at, suffix, data, priority) {
  account.time.schedule({
    kind,
    at,
    domain: account.time.domainOf(sub),
    key: `${sub.id}:${suffix}`,
    data: { subscription: sub.id, ...data },
    priority,
  });
}

/** (Re)schedules a subscription's time-driven transitions from its current state. */
function syncJobs(account, sub) {
  for (const suffix of ['renewal', 'trial_end', 'trial_will_end', 'cancel_at']) account.time.cancel(`${sub.id}:${suffix}`);
  if (ENDED_STATUSES.has(sub.status)) return;
  const now = nowOf(account, sub);
  if (sub.status === 'trialing' && sub.trial_end !== null) {
    scheduleSubJob(account, sub, JOB.trialEnd, sub.trial_end, 'trial_end', { trialEnd: sub.trial_end }, JOB_PRIORITY.trialEnd);
    const warnAt = sub.trial_end - TRIAL_WILL_END_SECONDS;
    if (warnAt > now) {
      scheduleSubJob(account, sub, JOB.trialWillEnd, warnAt, 'trial_will_end', { trialEnd: sub.trial_end }, JOB_PRIORITY.trialWillEnd);
    }
  } else if (['active', 'past_due', 'unpaid'].includes(sub.status)) {
    scheduleSubJob(account, sub, JOB.renewal, currentPeriod(sub).end, 'renewal', {}, JOB_PRIORITY.renewal);
  }
  if (sub.cancel_at !== null && sub.status !== 'incomplete') {
    scheduleSubJob(account, sub, JOB.cancelAt, sub.cancel_at, 'cancel_at', { cancelAt: sub.cancel_at }, JOB_PRIORITY.cancelAt);
  }
}

function clearJobs(account, sub) {
  account.time.cancelWhere((job) => job.key !== undefined && job.key.startsWith(`${sub.id}:`));
}

/** Emits trial_will_end now when a trial ends within the lead time (docs.stripe.com/api/events/types). */
function trialWillEndNow(account, sub, { request } = {}) {
  if (sub.status !== 'trialing' || sub.trial_end === null) return;
  if (sub.trial_end - nowOf(account, sub) <= TRIAL_WILL_END_SECONDS) {
    emitEvent(account, 'customer.subscription.trial_will_end', sub, { request });
  }
}

// Validation helpers ----------------------------------------------------------------------------

/** Checks a set of recurring prices for one subscription: currency, duplicates, intervals, limits. */
function checkItemSet(prices, billingMode, { param = 'items', currency } = {}) {
  const max = MAX_ITEMS[billingMode] ?? 20;
  if (prices.length > max) {
    throw invalidRequest(`A subscription in ${billingMode} billing mode can have at most ${max} items.`, { param });
  }
  for (const p of prices) {
    if (!p.recurring) {
      throw invalidRequest(`The price specified (${p.id}) is set to \`type=one_time\` but this field only accepts prices with \`type=recurring\`.`, { param });
    }
  }
  const cur = currency ?? prices[0].currency;
  if (prices.some((p) => p.currency !== cur)) {
    throw invalidRequest(`All prices on a subscription must have the same currency (${cur}).`, { param });
  }
  const seen = new Set();
  for (const p of prices) {
    if (seen.has(p.id)) throw invalidRequest(`Cannot add multiple subscription items with the same price: ${p.id}.`, { param });
    seen.add(p.id);
  }
  if (billingMode === 'classic') {
    if (!prices.every((p) => sameInterval(p, prices[0]))) {
      throw invalidRequest('Prices on a subscription in classic billing mode must all have the same billing interval and interval_count.', { param });
    }
  } else if (!compatibleIntervals(prices.map(intervalOf))) {
    throw invalidRequest('The billing intervals of these prices cannot be combined on one subscription (each must be a multiple of the shortest; days and weeks cannot mix with months and years).', { param });
  }
}

/** "You can't have two active subscriptions with different currencies." */
function checkCustomerCurrency(account, customer, currency) {
  if (customer.currency && customer.currency !== currency) {
    throw invalidRequest(`You cannot combine currencies on a single customer. This customer has an active subscription, subscription schedule, discount, quote, or invoice item with currency ${customer.currency}.`, { param: 'currency' });
  }
  const other = subscriptionsForCustomer(account, customer.id).find((s) => s.currency !== currency);
  if (other) {
    throw invalidRequest(`You cannot combine currencies on a single customer. This customer has an active subscription with currency ${other.currency}.`, { param: 'currency' });
  }
}

const noPaymentMethod = () => inv.noPaymentMethodError();

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * billing_cycle_anchor from billing_cycle_anchor_config: the first full invoice falls on the next
 * occurrence of day_of_month (clamped to short months), and the stored anchor is the first
 * point on that grid whose month has the full day, so later periods clamp correctly
 * (docs.stripe.com/billing/subscriptions/billing-cycle).
 */
function anchorFromConfig(cfg, after, price) {
  const d = new Date(after * 1000);
  const hour = cfg.hour ?? d.getUTCHours();
  const minute = cfg.minute ?? d.getUTCMinutes();
  const second = cfg.second ?? d.getUTCSeconds();
  const yearly = price.recurring.interval === 'year';
  const stepMonths = (yearly ? 12 : 1) * (price.recurring.interval_count ?? 1);
  let first = null;
  for (let k = 0; k <= 36 && first === null; k++) {
    const total = d.getUTCMonth() + k;
    const year = d.getUTCFullYear() + Math.floor(total / 12);
    const month = total % 12;
    if (yearly && cfg.month && month !== cfg.month - 1) continue;
    const t = Date.UTC(year, month, Math.min(cfg.day_of_month, daysInMonth(year, month)), hour, minute, second) / 1000;
    if (t > after) first = { year, month };
  }
  if (!first) return after;
  for (let k = 0; k < 48; k++) {
    const total = first.month + k * stepMonths;
    const year = first.year + Math.floor(total / 12);
    const month = total % 12;
    if (daysInMonth(year, month) >= cfg.day_of_month) return Date.UTC(year, month, cfg.day_of_month, hour, minute, second) / 1000;
  }
  return Date.UTC(first.year, first.month, Math.min(cfg.day_of_month, daysInMonth(first.year, first.month)), hour, minute, second) / 1000;
}

// Construction ----------------------------------------------------------------------------------

function newItem(account, sub, { price, quantity, metadata, now, start, end }) {
  return {
    id: account.mintId('si'),
    object: 'subscription_item',
    billing_thresholds: null,
    created: now,
    current_period_end: end,
    current_period_start: start,
    discounts: [],
    metadata: { ...(metadata ?? {}) },
    price: price.id,
    quantity,
    subscription: sub.id,
    tax_rates: [],
    _billed: null,
    _lastDebit: null,
  };
}

function storeItem(account, sub, item) {
  account.store.insert(item);
  sub.items.data.push(item);
  sub.items.total_count = sub.items.data.length;
}

function removeItem(account, sub, item) {
  sub.items.data = sub.items.data.filter((i) => i.id !== item.id);
  sub.items.total_count = sub.items.data.length;
  account.store.remove('subscription_item', item.id);
}

/** trial_settings as { endBehavior: { missingPaymentMethod } } (the engine contract) or the wire shape. */
function missingPaymentMethodOf(settings) {
  return settings?.endBehavior?.missingPaymentMethod ?? settings?.end_behavior?.missing_payment_method ?? null;
}

function emptyCancellationDetails() {
  return { comment: null, feedback: null, feedback_option: null, reason: null };
}

function newSubscription(account, o) {
  const id = o.id;
  return {
    id,
    object: 'subscription',
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: Boolean(o.automaticTax?.enabled), liability: o.automaticTax?.liability ?? null },
    billing_cycle_anchor: o.anchor,
    billing_cycle_anchor_config: o.anchorConfig
      ? {
          day_of_month: o.anchorConfig.day_of_month,
          hour: o.anchorConfig.hour ?? null,
          minute: o.anchorConfig.minute ?? null,
          month: o.anchorConfig.month ?? null,
          second: o.anchorConfig.second ?? null,
        }
      : null,
    billing_mode: {
      flexible: o.billingMode === 'flexible' ? { proration_discounts: o.prorationDiscounts ?? 'included' } : null,
      type: o.billingMode,
      updated_at: o.now,
    },
    billing_schedules: [],
    billing_thresholds: o.billingThresholds ?? null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    cancellation_details: emptyCancellationDetails(),
    collection_method: o.collectionMethod,
    created: o.now,
    currency: o.currency,
    customer: o.customer.id,
    customer_account: null,
    days_until_due: o.collectionMethod === 'send_invoice' ? o.daysUntilDue ?? null : null,
    default_payment_method: o.defaultPaymentMethod ?? null,
    default_source: null,
    default_tax_rates: [],
    description: o.description ?? null,
    discounts: [],
    ended_at: null,
    invoice_settings: {
      account_tax_ids: o.invoiceSettings?.account_tax_ids ?? null,
      custom_fields: o.invoiceSettings?.custom_fields ?? null,
      description: o.invoiceSettings?.description ?? null,
      footer: o.invoiceSettings?.footer ?? null,
      issuer: o.invoiceSettings?.issuer ?? { type: 'self' },
    },
    items: { object: 'list', data: [], has_more: false, total_count: 0, url: `/v1/subscription_items?subscription=${id}` },
    latest_invoice: null,
    livemode: false,
    managed_payments: null,
    metadata: { ...(o.metadata ?? {}) },
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: o.paymentSettings ?? { payment_method_options: null, payment_method_types: null, save_default_payment_method: 'off' },
    pending_invoice_item_interval: o.pendingInvoiceItemInterval ?? null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: o.schedule ?? null,
    start_date: o.start,
    status: o.status,
    test_clock: o.customer.test_clock ?? null,
    transfer_data: null,
    trial_end: o.trialEnd,
    trial_settings: { end_behavior: { missing_payment_method: missingPaymentMethodOf(o.trialSettings) ?? 'create_invoice' } },
    trial_start: o.trialEnd !== null ? o.start : null,
    _version: o.version,
    _resume: null,
    _pendingPlan: null,
  };
}

/**
 * The amount of an item for [from, end) where its anchor-aligned periods may start before `from`
 * (future anchors, backdating) or run past `end` (a cancel_at in the period): { amount, proration }.
 */
function periodCharge(price, quantity, anchor, from, end) {
  const full = amountFor(price, quantity);
  let total = 0;
  let proration = false;
  let s = from;
  while (s < end) {
    const p = itemPeriodAt(price, anchor, s);
    const segmentEnd = Math.min(p.end, end);
    const whole = p.start === s && segmentEnd === p.end;
    if (!whole) proration = true;
    total += whole ? full : roundAmount((full * (segmentEnd - s)) / (p.end - p.start));
    s = segmentEnd;
  }
  return { amount: total, proration: proration && total !== full };
}

/**
 * The end of a period that starts at `start`: its anchor boundary, or cancel_at when that falls
 * inside it ("if set during a future period, this will always cause a proration for that period",
 * docs.stripe.com/api/subscriptions/update).
 */
function periodEndBefore(sub, boundary, start) {
  return sub.cancel_at !== null && sub.cancel_at > start && sub.cancel_at < boundary ? sub.cancel_at : boundary;
}

// Creation --------------------------------------------------------------------------------------

/**
 * Creates a subscription and runs its first-invoice flow in the call (docs.stripe.com/api/subscriptions/create).
 * @param {object} spec
 * @param {object} spec.customer internal customer (live)
 * @param {{price: object, quantity?: number, metadata?: object}[]} spec.items recurring prices (internal objects)
 * @param {{price: object, quantity?: number}[]} [spec.addInvoiceItems] one-time prices for the first invoice
 * @param {object} [spec.metadata]
 * @param {string|null} [spec.description]
 * @param {string|null} [spec.defaultPaymentMethod] pm_ ID attached to the customer
 * @param {'charge_automatically'|'send_invoice'} [spec.collectionMethod]
 * @param {number} [spec.daysUntilDue]
 * @param {number|'now'} [spec.trialEnd]
 * @param {number} [spec.trialPeriodDays]
 * @param {boolean} [spec.trialFromPlan]
 * @param {{endBehavior: {missingPaymentMethod: 'cancel'|'create_invoice'|'pause'}}} [spec.trialSettings]
 *   (the wire shape {end_behavior: {missing_payment_method}} is accepted too)
 * @param {number} [spec.billingCycleAnchor]
 * @param {object} [spec.billingCycleAnchorConfig] {day_of_month, hour?, minute?, second?, month?}
 * @param {number} [spec.backdateStartDate]
 * @param {'classic'|'flexible'} [spec.billingMode] default: flexible when opts.version >= 2025-09-30.clover
 * @param {'included'|'itemized'} [spec.prorationDiscounts]
 * @param {number|null|'min_period_end'|'max_period_end'|'max_billed_until'} [spec.cancelAt]
 * @param {boolean} [spec.cancelAtPeriodEnd]
 * @param {'allow_incomplete'|'default_incomplete'|'error_if_incomplete'} [spec.paymentBehavior] default allow_incomplete
 * @param {'create_prorations'|'none'} [spec.prorationBehavior]
 * @param {boolean} [spec.offSession]
 * @param {string} [spec.schedule] sub_sched_ ID when a schedule creates it
 * @param {number} [spec.startDate] start time (schedule phase start); default now
 * @param {object} opts
 * @param {'api'|'checkout'|'schedule'|'control'} opts.source
 * @param {string} opts.version API version of the causing request (billing_mode default, and the
 *   Checkout flow: F1 creates `incomplete` on a failed first payment, F2/F3 pass error_if_incomplete)
 * @param {object|null} [opts.request]
 * @param {() => void} [opts.beforeApply] called once every check passed, right before the first
 *   change (the API route creates price_data prices there)
 * @returns {{subscription: object, invoice: object|null, paymentError: import('../core/errors.js').StripeError|null}}
 * @throws StripeError 402 with error_if_incomplete when the first payment fails (nothing is created)
 */
export function createSubscription(account, spec, opts = {}) {
  const source = opts.source ?? 'api';
  const version = opts.version ?? account.settings.apiVersion;
  const { request } = opts;
  const customer = spec.customer;
  if (!customer || customer._deleted) throw resourceMissing('customer', customer?.id ?? null, { param: 'customer' });
  const items = spec.items ?? [];
  if (!items.length) throw parameterMissing('items');
  const domain = account.time.domainOf(customer);
  const now = account.time.now(domain);
  const billingMode = spec.billingMode ?? defaultBillingMode(version);
  const collectionMethod = spec.collectionMethod ?? 'charge_automatically';
  const paymentBehavior = spec.paymentBehavior ?? 'allow_incomplete';
  const prorationBehavior = spec.prorationBehavior ?? 'create_prorations';
  const backdated = spec.backdateStartDate !== undefined && spec.backdateStartDate < now;
  const start = backdated ? spec.backdateStartDate : spec.startDate ?? now;

  checkItemSet(items.map((i) => i.price), billingMode, { param: 'items' });
  const currency = items[0].price.currency;
  checkCustomerCurrency(account, customer, currency);
  if (spec.cancelAtPeriodEnd === true && spec.cancelAt !== undefined && spec.cancelAt !== null) {
    throw parametersExclusive(['cancel_at', 'cancel_at_period_end'], { param: 'cancel_at_period_end' });
  }
  if (typeof spec.cancelAt === 'number' && spec.cancelAt <= now) {
    throw invalidRequest('cancel_at must be a timestamp in the future.', { param: 'cancel_at' });
  }
  for (const add of spec.addInvoiceItems ?? []) {
    if (add.price.currency !== currency) throw invalidRequest('add_invoice_items prices must have the same currency as the subscription.', { param: 'add_invoice_items' });
  }

  // Trial (docs.stripe.com/billing/subscriptions/trials).
  let trialEnd = null;
  if (typeof spec.trialEnd === 'number') trialEnd = spec.trialEnd;
  else if (spec.trialPeriodDays) trialEnd = start + spec.trialPeriodDays * DAY;
  else if (spec.trialFromPlan) {
    const days = Math.max(0, ...items.map((i) => i.price.recurring?.trial_period_days ?? 0));
    if (days) trialEnd = start + days * DAY;
  }
  if (trialEnd !== null && trialEnd <= now) trialEnd = null;

  // Billing cycle anchor: explicit, from a config, else the trial end, else the start. In classic
  // mode a cancel_at before the first renewal becomes the anchor (docs.stripe.com/billing/subscriptions/billing-cycle).
  let anchor = spec.billingCycleAnchor ?? null;
  if (spec.billingCycleAnchorConfig) anchor = anchorFromConfig(spec.billingCycleAnchorConfig, trialEnd ?? start, items[0].price);
  if (anchor === null && trialEnd === null && billingMode === 'classic' && typeof spec.cancelAt === 'number' && spec.cancelAt < oneIntervalAfter(items[0].price, start)) {
    anchor = spec.cancelAt;
  }
  if (anchor === null) anchor = trialEnd ?? start;

  // Items with their first periods, and the first invoice's lines.
  const subId = account.mintId('sub');
  const periodFrom = trialEnd !== null ? null : backdated ? now : start;
  const itemPlans = items.map(({ price, quantity: sent, metadata }) => {
    const quantity = quantityFor(price, sent);
    if (trialEnd !== null) return { price, quantity, metadata, start, end: trialEnd, amount: 0, lineStart: start, proration: false };
    const p = backdated ? itemPeriodAt(price, anchor, periodFrom) : { start, end: nextItemBoundary(price, anchor, start) };
    const charge = periodCharge(price, quantity, anchor, start, p.end);
    return { price, quantity, metadata, start: backdated ? p.start : start, end: p.end, amount: charge.amount, lineStart: start, proration: charge.proration };
  });
  const freeFirstPeriod = trialEnd === null && prorationBehavior === 'none' && itemPlans.some((p) => p.proration);
  const oneTime = (spec.addInvoiceItems ?? []).map(({ price, quantity = 1 }) => ({ price, quantity, amount: amountFor(price, quantity) }));
  const lineTotal = (freeFirstPeriod ? 0 : itemPlans.reduce((s, p) => s + p.amount, 0)) + oneTime.reduce((s, o) => s + o.amount, 0);
  const needsInvoice = !freeFirstPeriod || oneTime.length > 0;
  let due = Math.max(0, lineTotal + (customer.balance ?? 0));
  if (due > 0 && due < minimumCharge(currency)) due = 0;
  const deferred = collectionMethod === 'send_invoice' || source === 'schedule';
  const chargeNow = needsInvoice && !deferred && due > 0;
  const invoiceId = needsInvoice ? account.mintId('in') : null;
  opts.beforeApply?.();

  // error_if_incomplete: pay before anything is created (a decline creates nothing).
  let prepared = null;
  if (chargeNow && paymentBehavior === 'error_if_incomplete') {
    const pmId = defaultPaymentMethodFor(account, null, { default_payment_method: spec.defaultPaymentMethod ?? null }, customer);
    if (!pmId) throw noPaymentMethod();
    const pi = createPaymentIntent(
      account,
      { amount: due, currency, customer: customer.id, description: 'Subscription creation', metadata: {}, invoice: invoiceId },
      { request },
    );
    const r = confirmPaymentIntent(account, pi, { paymentMethod: pmId, offSession: spec.offSession ?? false }, { request });
    if (!r.ok) {
      inv.discardPaymentIntent(account, pi, { request });
      throw r.error ?? cardError();
    }
    prepared = { pi, charge: r.charge ?? null };
  }

  if (!customer.currency) changeCustomer(account, customer, (c) => { c.currency = currency; }, { request });
  const status = trialEnd !== null ? 'trialing' : chargeNow && !prepared ? 'incomplete' : 'active';
  const sub = newSubscription(account, {
    id: subId,
    customer,
    currency,
    billingMode,
    prorationDiscounts: spec.prorationDiscounts,
    collectionMethod,
    daysUntilDue: spec.daysUntilDue,
    now,
    start,
    anchor,
    anchorConfig: spec.billingCycleAnchorConfig ?? null,
    trialEnd,
    trialSettings: spec.trialSettings,
    status,
    metadata: spec.metadata,
    description: spec.description,
    defaultPaymentMethod: spec.defaultPaymentMethod,
    invoiceSettings: spec.invoiceSettings,
    paymentSettings: spec.paymentSettings,
    automaticTax: spec.automaticTax,
    billingThresholds: spec.billingThresholds,
    pendingInvoiceItemInterval: spec.pendingInvoiceItemInterval,
    schedule: spec.schedule,
    version,
  });
  sub.latest_invoice = invoiceId;
  account.store.insert(sub);
  const itemObjs = itemPlans.map((p) => {
    const item = newItem(account, sub, { price: p.price, quantity: p.quantity, metadata: p.metadata, now, start: p.start, end: p.end });
    item._billed = { amount: trialEnd !== null ? 0 : amountFor(p.price, p.quantity) };
    storeItem(account, sub, item);
    return item;
  });
  applyCancelPlan(account, sub, planCancel(account, sub, { cancelAtPeriodEnd: spec.cancelAtPeriodEnd, cancelAt: spec.cancelAt }, { source, now }));
  emitEvent(account, 'customer.subscription.created', sub, { request });

  let invoice = null;
  let paymentError = null;
  if (needsInvoice) {
    invoice = inv.newInvoice(account, {
      id: invoiceId,
      customer,
      subscription: sub,
      billingReason: 'subscription_create',
      collectionMethod,
      currency,
      now,
      periodStart: start,
      periodEnd: start,
      autoAdvance: deferred || !chargeNow || Boolean(prepared),
      daysUntilDue: spec.daysUntilDue,
    });
    for (const o of oneTime) {
      const ii = inv.createInvoiceItem(account, {
        customer,
        subscription: sub,
        price: o.price,
        quantity: o.quantity,
        amount: o.amount,
        start: now,
        end: now,
        description: oneTimeDescription(account, o.price, o.quantity),
        proration: false,
      });
      inv.attachInvoiceItem(account, invoice, ii);
    }
    if (!freeFirstPeriod) {
      itemPlans.forEach((p, i) => {
        inv.addSubscriptionLine(account, invoice, {
          subscription: sub,
          item: itemObjs[i],
          price: p.price,
          quantity: p.quantity,
          amount: p.amount,
          start: p.lineStart,
          end: p.end,
          description:
            trialEnd !== null
              ? trialLineDescription(account, p.price, p.quantity, billingMode)
              : p.proration
                ? prorationDescription(account, p.price, p.quantity, p.lineStart, false)
                : subscriptionLineDescription(account, p.price, p.quantity),
          proration: p.proration,
        });
      });
    }
    inv.insertDraft(account, invoice, { request, scheduleFinalization: deferred });
    if (!deferred) {
      inv.finalizeInvoice(account, invoice, { request, paymentIntent: prepared?.pi });
      if (prepared && invoice.status === 'open') {
        invoice._charge = prepared.charge?.id ?? null;
        const previous = structuredClone(invoice);
        invoice.attempt_count = 1;
        inv.markPaid(account, invoice, { request, viaPayment: true, previous });
      } else if (invoice.status === 'open' && invoice.collection_method === 'charge_automatically') {
        if (paymentBehavior === 'default_incomplete') {
          invoice.auto_advance = false;
          invoice.next_payment_attempt = null;
        } else {
          paymentError = inv.attemptPayment(account, invoice, { mode: 'create', offSession: spec.offSession ?? false, request }).error;
        }
      }
    }
  }
  if (sub.status === 'incomplete') {
    scheduleSubJob(account, sub, JOB.incompleteExpire, sub.created + INCOMPLETE_EXPIRY_SECONDS, 'incomplete_expire', {}, JOB_PRIORITY.incompleteExpire);
  }
  syncJobs(account, sub);
  trialWillEndNow(account, sub, { request });
  return { subscription: sub, invoice, paymentError };
}

/** An item's quantity: none for metered prices (usage is billed, not seats), else the sent value or 1. */
function quantityFor(price, sent) {
  if (price.recurring?.usage_type === 'metered') return null;
  return sent ?? 1;
}

function oneTimeDescription(account, price, quantity) {
  const product = account.store.get('product', price.product);
  const name = product?.name ?? price.product;
  return quantity > 1 ? `${quantity} × ${name}` : name;
}

// Updates ---------------------------------------------------------------------------------------

const TERMINAL_UPDATABLE = new Set(['metadata', 'cancellationDetails']);
const INCOMPLETE_UPDATABLE = new Set(['metadata', 'defaultPaymentMethod', 'defaultSource', 'cancellationDetails']);
const PARAM_NAMES = {
  items: 'items',
  cancelAtPeriodEnd: 'cancel_at_period_end',
  cancelAt: 'cancel_at',
  trialEnd: 'trial_end',
  trialFromPlan: 'trial_from_plan',
  trialSettings: 'trial_settings',
  prorationBehavior: 'proration_behavior',
  prorationDate: 'proration_date',
  billingCycleAnchor: 'billing_cycle_anchor',
  paymentBehavior: 'payment_behavior',
  description: 'description',
  defaultPaymentMethod: 'default_payment_method',
  defaultSource: 'default_source',
  collectionMethod: 'collection_method',
  daysUntilDue: 'days_until_due',
  pauseCollection: 'pause_collection',
  addInvoiceItems: 'add_invoice_items',
  invoiceSettings: 'invoice_settings',
  paymentSettings: 'payment_settings',
  automaticTax: 'automatic_tax',
  billingThresholds: 'billing_thresholds',
  pendingInvoiceItemInterval: 'pending_invoice_item_interval',
  offSession: 'off_session',
};

function guardUpdatable(sub, u) {
  const given = Object.keys(u).filter((k) => u[k] !== undefined && k !== 'trialUpdateBehavior');
  if (ENDED_STATUSES.has(sub.status)) {
    const bad = given.find((k) => !TERMINAL_UPDATABLE.has(k));
    if (bad) {
      throw invalidRequest(`A ${sub.status === 'canceled' ? 'canceled' : 'expired'} subscription can only update its cancellation_details and metadata.`, { param: PARAM_NAMES[bad] ?? bad });
    }
  } else if (sub.status === 'incomplete') {
    const bad = given.find((k) => !INCOMPLETE_UPDATABLE.has(k));
    if (bad) {
      throw invalidRequest('This subscription is incomplete: it can only have its metadata, default_payment_method and default_source updated until its first invoice is paid.', { param: PARAM_NAMES[bad] ?? bad });
    }
  }
}

/**
 * Plans an items change (Stripe semantics: with id → update or delete that item, without id → add
 * one; a price change resets quantity to 1 unless given). Returns item states; changes nothing.
 */
function planItems(account, sub, entries, { param = 'items' } = {}) {
  const states = sub.items.data.map((item) => {
    const price = priceOf(account, item);
    return { item, price, quantity: item.quantity, metadata: item.metadata, deleted: false, oldPrice: price, oldQuantity: item.quantity };
  });
  const byId = new Map(states.map((s) => [s.item.id, s]));
  const added = [];
  entries.forEach((e, i) => {
    const p = e.param ?? `${param}[${i}]`;
    if (e.id !== undefined) {
      const s = byId.get(e.id);
      if (!s) throw invalidRequest(`No such subscription item: '${e.id}'`, { param: `${p}[id]`, code: 'resource_missing', validation: false });
      if (e.deleted) {
        s.deleted = true;
        return;
      }
      if (e.price && e.price.id !== s.price.id) {
        s.price = e.price;
        s.quantity = quantityFor(e.price, e.quantity);
      } else if (e.quantity !== undefined) s.quantity = quantityFor(s.price, e.quantity);
      if (e.metadata !== undefined) s.metadata = e.metadata === '' ? {} : applyMetadata(s.metadata, e.metadata);
    } else {
      if (e.deleted) throw invalidRequest('To delete a subscription item, pass its id with deleted=true.', { param: `${p}[id]` });
      if (!e.price) throw parameterMissing(`${p}[price]`);
      added.push({ item: null, price: e.price, quantity: quantityFor(e.price, e.quantity), metadata: e.metadata && e.metadata !== '' ? { ...e.metadata } : {}, deleted: false, oldPrice: null, oldQuantity: 0 });
    }
  });
  const next = [...states.filter((s) => !s.deleted), ...added];
  if (!next.length) throw invalidRequest('A subscription must have at least one item; cancel the subscription instead.', { param });
  checkItemSet(next.map((s) => s.price), sub.billing_mode.type, { param, currency: sub.currency });
  const changed = (s) => !s.item || s.deleted || s.price.id !== s.oldPrice.id || s.quantity !== s.oldQuantity;
  return { states, added, next, changedStates: [...states, ...added].filter(changed) };
}

/** The resulting cancel fields of an update, or null when nothing about cancellation changes. */
function planCancel(account, sub, u, { source, now }) {
  const { cancelAtPeriodEnd, cancelAt } = u;
  const details = u.cancellationDetails;
  if (cancelAtPeriodEnd === undefined && cancelAt === undefined) return details ? { details } : null;
  if (cancelAtPeriodEnd === true && cancelAt !== undefined && cancelAt !== null && cancelAt !== '') {
    throw parametersExclusive(['cancel_at', 'cancel_at_period_end'], { param: 'cancel_at_period_end' });
  }
  const flexible = sub.billing_mode.type === 'flexible';
  const requested = source === 'schedule' ? null : 'cancellation_requested';
  if (cancelAt !== undefined) {
    if (cancelAt === null || cancelAt === '') return { cancelAt: null, periodEnd: false, canceledAt: null, reason: null, details, clear: true };
    let at = cancelAt;
    if (cancelAt === 'min_period_end') at = currentPeriod(sub).end;
    else if (cancelAt === 'max_period_end' || cancelAt === 'max_billed_until') at = maxItemPeriodEnd(sub);
    else if (at <= now) throw invalidRequest('cancel_at must be a timestamp in the future.', { param: 'cancel_at' });
    return { cancelAt: at, periodEnd: false, canceledAt: source === 'schedule' ? sub.canceled_at : now, reason: requested, details };
  }
  if (cancelAtPeriodEnd === true) {
    // Classic: cancel_at_period_end true and cancel_at = period end; flexible via the portal:
    // cancel_at = latest item period end with cancel_at_period_end false (billing-mode/compare).
    if (flexible && source === 'portal') return { cancelAt: maxItemPeriodEnd(sub), periodEnd: false, canceledAt: now, reason: requested, details };
    return { cancelAt: currentPeriod(sub).end, periodEnd: true, canceledAt: now, reason: requested, details };
  }
  // cancel_at_period_end=false renews a period-end (or portal) cancellation.
  if (sub.cancel_at_period_end || source === 'portal' || sub.cancel_at !== null) {
    return { cancelAt: null, periodEnd: false, canceledAt: null, reason: null, details, clear: true };
  }
  return details ? { details } : null;
}

function applyCancelPlan(account, sub, plan) {
  if (!plan) return;
  if (plan.cancelAt !== undefined) {
    sub.cancel_at = plan.cancelAt;
    sub.cancel_at_period_end = plan.periodEnd;
    sub.canceled_at = plan.canceledAt;
    if (plan.clear) sub.cancellation_details = emptyCancellationDetails();
    if (plan.reason) sub.cancellation_details.reason = plan.reason;
  }
  if (plan.details) {
    const d = plan.details;
    for (const key of ['comment', 'feedback', 'feedback_option']) {
      if (d[key] !== undefined) sub.cancellation_details[key] = d[key] === '' ? null : d[key];
    }
  }
}

/** Keeps a period-end cancellation on the (possibly moved) period end. */
function trackPeriodEndCancel(sub) {
  if (sub.cancel_at_period_end && !ENDED_STATUSES.has(sub.status)) sub.cancel_at = currentPeriod(sub).end;
}

/**
 * The credit base of an item for a proration: classic uses the current price, flexible the amount
 * last debited (docs.stripe.com/billing/subscriptions/billing-mode/compare).
 */
function creditBase(sub, state) {
  if (sub.billing_mode.type === 'flexible' && state.item?._billed) return state.item._billed.amount;
  return amountFor(state.oldPrice, state.oldQuantity ?? 1);
}

/**
 * Applies a subscription update (POST /v1/subscriptions/:id and the engine's single-purpose
 * functions) and emits one customer.subscription.updated for it, after any proration
 * invoiceitem.created events and before the events of an immediate invoice.
 *
 * @param {object} u { items?, prorationBehavior?, prorationDate?, billingCycleAnchor?,
 *   paymentBehavior?, offSession?, cancelAtPeriodEnd?, cancelAt?, cancellationDetails?,
 *   trialEnd?, trialFromPlan?, trialSettings?, trialUpdateBehavior?, metadata?, description?,
 *   defaultPaymentMethod?, defaultSource?, collectionMethod?, daysUntilDue?, pauseCollection?,
 *   addInvoiceItems?, invoiceSettings?, paymentSettings?, automaticTax?, billingThresholds?,
 *   pendingInvoiceItemInterval? } (prices as internal objects)
 * @param {{source?: 'api'|'portal'|'schedule', request?: object|null, beforeApply?: () => void}} opts
 * @returns {{subscription: object, invoice: object|null, paymentError: object|null}}
 */
export function updateSubscription(account, sub, u, opts = {}) {
  const source = opts.source ?? 'api';
  const { request } = opts;
  guardUpdatable(sub, u);
  const customer = customerOf(account, sub);
  const now = nowOf(account, sub);
  const flexible = sub.billing_mode.type === 'flexible';
  const prorationBehavior = u.prorationBehavior ?? 'create_prorations';
  const paymentBehavior = u.paymentBehavior ?? 'allow_incomplete';
  const period = currentPeriod(sub);
  if (u.prorationDate !== undefined && (u.prorationDate < period.start || u.prorationDate > period.end)) {
    throw invalidRequest('proration_date must be within the current period of the subscription items.', { param: 'proration_date' });
  }
  const t = u.prorationDate ?? now;

  // --- Plan (validates; changes nothing) -----------------------------------------------------
  const itemPlan = u.items ? planItems(account, sub, u.items) : null;
  const cancelPlan = planCancel(account, sub, u, { source, now });
  if (u.defaultPaymentMethod) {
    if (!attachedPaymentMethod(account, u.defaultPaymentMethod, customer.id)) {
      if (!account.store.get('payment_method', u.defaultPaymentMethod)) throw resourceMissing('payment_method', u.defaultPaymentMethod, { param: 'default_payment_method' });
      throw invalidRequest(`The customer does not have a payment method with the ID ${u.defaultPaymentMethod}. The payment method must be attached to the customer.`, { param: 'default_payment_method' });
    }
  }
  const collectionMethod = u.collectionMethod ?? sub.collection_method;
  const daysUntilDue = u.daysUntilDue !== undefined ? u.daysUntilDue : sub.days_until_due;
  if (collectionMethod === 'send_invoice' && (daysUntilDue === null || daysUntilDue === undefined)) throw parameterMissing('days_until_due');
  if (collectionMethod === 'charge_automatically' && u.daysUntilDue !== undefined) {
    throw invalidRequest('days_until_due can only be set when collection_method is send_invoice.', { param: 'days_until_due' });
  }
  for (const add of u.addInvoiceItems ?? []) {
    if (add.price.currency !== sub.currency) throw invalidRequest('add_invoice_items prices must have the same currency as the subscription.', { param: 'add_invoice_items' });
  }

  // Trial changes.
  const trialing = sub.status === 'trialing';
  let trialEnd = u.trialEnd;
  if (u.trialFromPlan && trialEnd === undefined) {
    const prices = (itemPlan ? itemPlan.next : sub.items.data.map((i) => ({ price: priceOf(account, i) }))).map((s) => s.price);
    const days = Math.max(0, ...prices.map((p) => p.recurring?.trial_period_days ?? 0));
    if (days) trialEnd = now + days * DAY;
  }
  if (typeof trialEnd === 'number') {
    if (trialEnd <= now) throw invalidRequest('Invalid timestamp: must be an integer Unix timestamp in the future.', { param: 'trial_end' });
    if (trialEnd - sub.billing_cycle_anchor > MAX_TRIAL_SECONDS) throw invalidRequest('trial_end can be at most two years from billing_cycle_anchor.', { param: 'trial_end' });
  }
  const portalEndsTrial = source === 'portal' && trialing && itemPlan && (u.trialUpdateBehavior ?? 'end_trial') === 'end_trial' && itemPlan.changedStates.length > 0;
  const endTrialNow = trialing && (trialEnd === 'now' || portalEndsTrial);
  const moveTrial = typeof trialEnd === 'number';
  if (moveTrial && !['trialing', 'active'].includes(sub.status)) {
    throw invalidRequest(`trial_end can only be changed on an active or trialing subscription (this subscription is ${sub.status}).`, { param: 'trial_end' });
  }

  // Billing effects of an item change.
  const paused = sub.status === 'paused';
  let resetAnchor = false;
  if (!trialing && !paused && !moveTrial) {
    if (u.billingCycleAnchor === 'now') resetAnchor = true;
    else if (itemPlan && !flexible && itemPlan.changedStates.length) {
      const oldPrices = itemPlan.states.map((s) => s.oldPrice);
      const newPrices = itemPlan.next.map((s) => s.price);
      const intervalChanged = !sameInterval(oldPrices[0], newPrices[0]);
      const oldTotal = itemPlan.states.reduce((sum, s) => sum + amountFor(s.oldPrice, s.oldQuantity ?? 1), 0);
      const newTotal = itemPlan.next.reduce((sum, s) => sum + amountFor(s.price, s.quantity ?? 1), 0);
      resetAnchor = intervalChanged || (oldTotal === 0 && newTotal > 0);
    }
  }

  // Proration invoice items (specs; created when applied).
  const prorations = [];
  const pushProration = (state, amount, credit, start, end, extra = {}) => {
    if (!amount) return;
    prorations.push({ state, amount, credit, start, end, ...extra });
  };
  if (itemPlan && !trialing && !paused && !moveTrial && prorationBehavior !== 'none') {
    if (resetAnchor) {
      for (const s of itemPlan.states) {
        pushProration(s, -prorate(creditBase(sub, s), s.item.current_period_start, s.item.current_period_end, t), true, t, s.item.current_period_end);
      }
    } else {
      for (const s of itemPlan.changedStates) {
        if (s.item) {
          pushProration(s, -prorate(creditBase(sub, s), s.item.current_period_start, s.item.current_period_end, t), true, t, s.item.current_period_end);
        }
        if (!s.deleted) {
          const p = newItemPeriod(account, sub, s, t);
          pushProration(s, prorate(amountFor(s.price, s.quantity ?? 1), p.start, p.end, t), false, t, p.end);
        }
      }
    }
  } else if (!itemPlan && resetAnchor && prorationBehavior !== 'none') {
    for (const item of sub.items.data) {
      const state = { item, price: priceOf(account, item), quantity: item.quantity, oldPrice: priceOf(account, item), oldQuantity: item.quantity };
      pushProration(state, -prorate(creditBase(sub, state), item.current_period_start, item.current_period_end, t), true, t, item.current_period_end);
    }
  }
  if (moveTrial && sub.status === 'active' && prorationBehavior !== 'none') {
    for (const item of sub.items.data) {
      const state = { item, price: priceOf(account, item), quantity: item.quantity, oldPrice: priceOf(account, item), oldQuantity: item.quantity };
      pushProration(state, -prorate(creditBase(sub, state), item.current_period_start, item.current_period_end, t), true, t, item.current_period_end);
    }
  }
  // A cancel_at before an item's period end credits the time after it ("this will cause a
  // proration if prorations have been enabled", docs.stripe.com/api/subscriptions/update).
  if (cancelPlan?.cancelAt && !cancelPlan.periodEnd && source !== 'schedule' && prorationBehavior !== 'none' && ['active', 'past_due', 'unpaid'].includes(sub.status)) {
    for (const item of sub.items.data) {
      if (cancelPlan.cancelAt >= item.current_period_end || itemPlan?.states.find((s) => s.item === item && (s.deleted || s.price.id !== s.oldPrice.id))) continue;
      const state = { item, price: priceOf(account, item), quantity: item.quantity, oldPrice: priceOf(account, item), oldQuantity: item.quantity };
      const at = Math.max(cancelPlan.cancelAt, item.current_period_start);
      pushProration(state, -prorate(creditBase(sub, state), item.current_period_start, item.current_period_end, at), true, at, item.current_period_end, { forCancelAt: true });
    }
  }
  // Clearing or moving cancel_at withdraws the pending credits an earlier cancel_at created.
  const withdrawn = cancelPlan && cancelPlan.cancelAt !== undefined && sub.cancel_at !== null
    ? inv.pendingInvoiceItems(account, sub.id).filter((ii) => ii._forCancelAt)
    : [];

  // Immediate invoice: anchor resets and trial ends always; prorations with always_invoice.
  const immediate = endTrialNow || resetAnchor || (prorationBehavior === 'always_invoice' && prorations.length > 0);
  const sweepPending = endTrialNow || resetAnchor || flexible;
  const nextStates = itemPlan ? itemPlan.next : sub.items.data.map((item) => ({ item, price: priceOf(account, item), quantity: item.quantity }));
  let fullLines = [];
  if (endTrialNow || resetAnchor) {
    fullLines = nextStates.map((s) => ({ state: s, amount: amountFor(s.price, s.quantity ?? 1), start: now, end: oneIntervalAfter(s.price, now) }));
  }
  let dueNow = 0;
  if (immediate) {
    const pendingTotal = sweepPending && paymentBehavior !== 'pending_if_incomplete'
      ? inv.pendingInvoiceItems(account, sub.id).reduce((sum, ii) => sum + ii.amount, 0)
      : 0;
    const addTotal = (u.addInvoiceItems ?? []).reduce((sum, a) => sum + amountFor(a.price, a.quantity ?? 1), 0);
    const total = prorations.reduce((sum, p) => sum + p.amount, 0) + fullLines.reduce((sum, l) => sum + l.amount, 0) + pendingTotal + addTotal;
    dueNow = Math.max(0, total + (customer.balance ?? 0));
    if (dueNow > 0 && dueNow < minimumCharge(sub.currency)) dueNow = 0;
  }
  const payNow = immediate && dueNow > 0 && collectionMethod === 'charge_automatically';
  const invoiceId = immediate ? account.mintId('in') : null;
  opts.beforeApply?.();

  // error_if_incomplete / pending_if_incomplete: try the payment before changing anything.
  let prepared = null;
  let pendingFailure = null;
  if (payNow && (paymentBehavior === 'error_if_incomplete' || paymentBehavior === 'pending_if_incomplete')) {
    const pmId = defaultPaymentMethodFor(account, null, { default_payment_method: u.defaultPaymentMethod ?? sub.default_payment_method, default_source: sub.default_source }, customer);
    if (!pmId && paymentBehavior === 'error_if_incomplete') throw noPaymentMethod();
    // A successful payment's events go out where an allow_incomplete update sends them (after
    // invoice.created / invoice.finalized); a failed one's go out now.
    const { result: { pi, r }, held } = holdEvents(account, () => {
      const pi = createPaymentIntent(
        account,
        { amount: dueNow, currency: sub.currency, customer: customer.id, description: 'Subscription update', metadata: {}, invoice: invoiceId },
        { request },
      );
      const r = pmId ? confirmPaymentIntent(account, pi, { paymentMethod: pmId, offSession: u.offSession ?? false }, { request }) : { ok: false, error: noPaymentMethod() };
      return { pi, r };
    });
    if (!r.ok) {
      emitHeld(account, held);
      if (paymentBehavior === 'error_if_incomplete') {
        inv.discardPaymentIntent(account, pi, { request });
        throw r.error ?? cardError();
      }
      pendingFailure = { pi, error: r.error, charge: r.charge ?? null, paymentMethod: pmId };
    } else prepared = { pi, charge: r.charge ?? null, held };
  }
  if (pendingFailure) {
    return createPendingUpdate(account, sub, { u, itemPlan, prorations, fullLines, invoiceId, pendingFailure, resetAnchor, endTrialNow, now, request });
  }

  // --- Apply ---------------------------------------------------------------------------------
  const previous = structuredClone(sub);
  const wasTrialing = trialing;
  if (itemPlan) applyItemStates(account, sub, itemPlan, { now, t, trialing: trialing && !endTrialNow, resetAnchor: resetAnchor || endTrialNow, prorationBehavior });
  if (endTrialNow || resetAnchor) {
    sub.billing_cycle_anchor = now;
    for (const l of fullLines) {
      const item = l.state.item ?? sub.items.data.find((i) => i.price === l.state.price.id);
      item.current_period_start = l.start;
      item.current_period_end = l.end;
      l.item = item;
    }
  }
  if (endTrialNow) {
    sub.status = 'active';
    sub.trial_end = now;
  } else if (moveTrial) {
    if (sub.status === 'active') {
      sub.status = 'trialing';
      if (flexible || sub.trial_start === null) sub.trial_start = now;
      for (const item of sub.items.data) item.current_period_start = now;
    }
    sub.trial_end = trialEnd;
    sub.billing_cycle_anchor = trialEnd;
    for (const item of sub.items.data) item.current_period_end = trialEnd;
  }
  applyCancelPlan(account, sub, cancelPlan);
  applySimpleFields(account, sub, u);
  trackPeriodEndCancel(sub);

  for (const ii of withdrawn) ii._deleted = true;
  const items = createProrationItems(account, sub, customer, prorations);
  for (const add of u.addInvoiceItems ?? []) {
    items.push(inv.createInvoiceItem(account, {
      customer,
      subscription: sub,
      price: add.price,
      quantity: add.quantity ?? 1,
      amount: amountFor(add.price, add.quantity ?? 1),
      start: now,
      end: now,
      description: oneTimeDescription(account, add.price, add.quantity ?? 1),
      proration: false,
      metadata: add.metadata,
    }));
  }
  if (immediate) sub.latest_invoice = invoiceId;

  for (const ii of withdrawn) emitEvent(account, 'invoiceitem.deleted', ii, { request });
  for (const ii of items) emitEvent(account, 'invoiceitem.created', ii, { request });
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  // trial_will_end fires immediately when a trial is ended early or shortened below the lead time.
  if (endTrialNow && wasTrialing) emitEvent(account, 'customer.subscription.trial_will_end', sub, { request });
  else if (moveTrial) trialWillEndNow(account, sub, { request });

  // --- Immediate invoice ---------------------------------------------------------------------
  let invoice = null;
  let paymentError = null;
  if (immediate) {
    invoice = inv.newInvoice(account, {
      id: invoiceId,
      customer,
      subscription: sub,
      billingReason: 'subscription_update',
      collectionMethod,
      currency: sub.currency,
      now,
      periodStart: now,
      periodEnd: now,
      autoAdvance: false,
      daysUntilDue,
      prorationDate: u.prorationDate,
    });
    const pending = sweepPending ? inv.pendingInvoiceItems(account, sub.id) : items;
    for (const ii of inv.sortPending(pending)) inv.attachInvoiceItem(account, invoice, ii);
    for (const l of [...fullLines].reverse()) {
      inv.addSubscriptionLine(account, invoice, {
        subscription: sub,
        item: l.item,
        price: l.state.price,
        quantity: l.state.quantity,
        amount: l.amount,
        start: l.start,
        end: l.end,
        description: subscriptionLineDescription(account, l.state.price, l.state.quantity),
      });
      l.item._billed = { amount: l.amount };
    }
    inv.insertDraft(account, invoice, { request });
    if (prepared) emitHeld(account, prepared.held.filter((h) => h.type === 'payment_intent.created'));
    inv.finalizeInvoice(account, invoice, { request, paymentIntent: prepared?.pi });
    if (prepared) emitHeld(account, prepared.held.filter((h) => h.type !== 'payment_intent.created'));
    if (invoice.status === 'open' && invoice.collection_method === 'charge_automatically') {
      if (prepared) {
        invoice._charge = prepared.charge?.id ?? null;
        const before = structuredClone(invoice);
        invoice.attempt_count = 1;
        inv.markPaid(account, invoice, { request, viaPayment: true, previous: before });
      } else if (paymentBehavior === 'default_incomplete') {
        toPastDue(account, sub, { request });
      } else {
        paymentError = inv.attemptPayment(account, invoice, { mode: 'update', offSession: u.offSession ?? false, request }).error;
      }
    }
  }
  syncJobs(account, sub);
  syncPauseCollectionJob(account, sub);
  if (source === 'api' && sub.schedule && (itemPlan || u.trialEnd !== undefined || cancelPlan)) {
    schedules.onSubscriptionUpdated(account, sub, { request });
  }
  return { subscription: sub, invoice, paymentError };
}

/** The period a changed or added item gets: its interval's anchor-aligned period containing `t`. */
function newItemPeriod(account, sub, state, t) {
  if (state.item && state.oldPrice && sameInterval(state.price, state.oldPrice)) {
    return { start: state.item.current_period_start, end: state.item.current_period_end };
  }
  if (sub.billing_mode.type === 'classic') return currentPeriod(sub);
  return itemPeriodAt(state.price, sub.billing_cycle_anchor, t);
}

function applyItemStates(account, sub, plan, { now, t, trialing, resetAnchor, prorationBehavior }) {
  const period = currentPeriod(sub);
  for (const s of plan.states) {
    if (s.deleted) {
      removeItem(account, sub, s.item);
      continue;
    }
    const priceChanged = s.price.id !== s.oldPrice.id;
    if (priceChanged && !trialing && !resetAnchor) {
      const p = newItemPeriod(account, sub, s, t);
      s.item.current_period_start = p.start;
      s.item.current_period_end = p.end;
    }
    s.item.price = s.price.id;
    s.item.quantity = s.quantity;
    s.item.metadata = s.metadata;
    if ((priceChanged || s.quantity !== s.oldQuantity) && prorationBehavior !== 'none' && !trialing) {
      s.item._billed = { amount: amountFor(s.price, s.quantity ?? 1) };
    }
  }
  for (const s of plan.added) {
    const p = trialing ? period : resetAnchor ? { start: now, end: oneIntervalAfter(s.price, now) } : newItemPeriod(account, sub, s, t);
    const item = newItem(account, sub, { price: s.price, quantity: s.quantity, metadata: s.metadata, now, start: p.start, end: p.end });
    item._billed = { amount: trialing || prorationBehavior === 'none' ? 0 : amountFor(s.price, s.quantity ?? 1) };
    storeItem(account, sub, item);
    s.item = item;
  }
}

/** Creates the proration invoice items (pending) of an update. */
function createProrationItems(account, sub, customer, prorations) {
  return prorations.map((p) => {
    const price = p.credit ? p.state.oldPrice : p.state.price;
    const quantity = (p.credit ? p.state.oldQuantity : p.state.quantity) ?? 1;
    const itemId = p.state.item?.id;
    const debit = p.state.item?._lastDebit;
    const ii = inv.createInvoiceItem(account, {
      customer,
      subscription: sub,
      item: itemId ? { id: itemId } : null,
      price,
      quantity,
      amount: p.amount,
      start: p.start,
      end: p.end,
      description: prorationDescription(account, price, quantity, p.start, p.credit),
      proration: true,
      creditedItems: p.credit && debit ? { invoice: debit.invoice, invoice_line_items: [debit.line] } : null,
    });
    if (p.forCancelAt) ii._forCancelAt = true;
    return ii;
  });
}

/** Scalar and hash fields of an update that need no billing logic. */
function applySimpleFields(account, sub, u) {
  if (u.metadata !== undefined) sub.metadata = applyMetadata(sub.metadata, u.metadata);
  if (u.description !== undefined) sub.description = u.description === '' ? null : u.description;
  if (u.defaultPaymentMethod !== undefined) sub.default_payment_method = u.defaultPaymentMethod || null;
  if (u.defaultSource !== undefined) sub.default_source = null;
  if (u.collectionMethod !== undefined) sub.collection_method = u.collectionMethod;
  if (u.daysUntilDue !== undefined) sub.days_until_due = u.daysUntilDue;
  if (sub.collection_method === 'charge_automatically') sub.days_until_due = null;
  if (u.pauseCollection !== undefined) {
    sub.pause_collection = u.pauseCollection === '' || u.pauseCollection === null
      ? null
      : { behavior: u.pauseCollection.behavior, resumes_at: u.pauseCollection.resumes_at ?? null };
  }
  if (u.trialSettings !== undefined) {
    sub.trial_settings = { end_behavior: { missing_payment_method: missingPaymentMethodOf(u.trialSettings) ?? 'create_invoice' } };
  }
  if (u.invoiceSettings !== undefined) {
    const s = u.invoiceSettings;
    const cur = sub.invoice_settings;
    if (s.account_tax_ids !== undefined) cur.account_tax_ids = s.account_tax_ids === '' ? null : s.account_tax_ids;
    if (s.custom_fields !== undefined) cur.custom_fields = s.custom_fields === '' ? null : s.custom_fields.map((f) => ({ name: f.name, value: f.value }));
    if (s.description !== undefined) cur.description = s.description === '' ? null : s.description;
    if (s.footer !== undefined) cur.footer = s.footer === '' ? null : s.footer;
    if (s.issuer !== undefined) cur.issuer = s.issuer;
  }
  if (u.paymentSettings !== undefined) sub.payment_settings = u.paymentSettings;
  if (u.automaticTax !== undefined) sub.automatic_tax = { disabled_reason: null, enabled: Boolean(u.automaticTax.enabled), liability: u.automaticTax.liability ?? null };
  if (u.billingThresholds !== undefined) sub.billing_thresholds = u.billingThresholds === '' ? null : u.billingThresholds;
  if (u.pendingInvoiceItemInterval !== undefined) {
    sub.pending_invoice_item_interval = u.pendingInvoiceItemInterval === '' ? null : u.pendingInvoiceItemInterval;
  }
}

function syncPauseCollectionJob(account, sub) {
  account.time.cancel(`${sub.id}:pause_resume`);
  const at = sub.pause_collection?.resumes_at;
  if (at && !ENDED_STATUSES.has(sub.status)) scheduleSubJob(account, sub, JOB.pauseCollectionResume, at, 'pause_resume', { resumesAt: at });
}

/** active/trialing → past_due (a payment failed or is required but was not attempted). */
function toPastDue(account, sub, { request } = {}) {
  if (!['active', 'trialing'].includes(sub.status)) return;
  const previous = structuredClone(sub);
  sub.status = 'past_due';
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  syncJobs(account, sub);
}

// Pending updates (payment_behavior=pending_if_incomplete) -----------------------------------------

/**
 * A failed pending_if_incomplete update: the subscription keeps its items; the changes wait in
 * `pending_update` until the invoice is paid, or expire (docs.stripe.com/billing/subscriptions/pending-updates).
 */
function createPendingUpdate(account, sub, { u, itemPlan, prorations, fullLines, invoiceId, pendingFailure, resetAnchor, endTrialNow, now, request }) {
  const customer = customerOf(account, sub);
  const previous = structuredClone(sub);
  const plannedItems = (itemPlan ? itemPlan.next : sub.items.data.map((item) => ({ item, price: priceOf(account, item), quantity: item.quantity, metadata: item.metadata }))).map((s) => {
    const base = s.item ? structuredClone(s.item) : newItem(account, sub, { price: s.price, quantity: s.quantity, metadata: s.metadata, now, ...currentPeriod(sub) });
    base.price = s.price.id;
    base.quantity = s.quantity;
    base.metadata = { ...(s.metadata ?? base.metadata) };
    const line = fullLines.find((l) => l.state === s);
    if (line) {
      base.current_period_start = line.start;
      base.current_period_end = line.end;
    } else if (!s.item || s.price.id !== s.oldPrice?.id) {
      const p = newItemPeriod(account, sub, s, now);
      base.current_period_start = p.start;
      base.current_period_end = p.end;
    }
    delete base._seq;
    return base;
  });
  const soonest = Math.min(sub.trial_end ?? Infinity, currentPeriod(sub).end);
  const expiresAt = soonest - now <= INCOMPLETE_EXPIRY_SECONDS ? soonest : now + INCOMPLETE_EXPIRY_SECONDS;
  sub.pending_update = {
    billing_cycle_anchor: resetAnchor || endTrialNow ? now : null,
    discount: null,
    discounts: null,
    expires_at: expiresAt,
    metadata: null,
    subscription_items: plannedItems,
    trial_end: endTrialNow ? now : null,
    trial_from_plan: null,
  };
  sub._pendingPlan = { invoice: invoiceId, removed: itemPlan ? itemPlan.states.filter((s) => s.deleted).map((s) => s.item.id) : [], endTrial: endTrialNow, resetAnchor };
  sub.latest_invoice = invoiceId;
  const items = createProrationItems(account, sub, customer, prorations);
  for (const ii of items) emitEvent(account, 'invoiceitem.created', ii, { request });
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });

  const invoice = inv.newInvoice(account, {
    id: invoiceId,
    customer,
    subscription: sub,
    billingReason: 'subscription_update',
    collectionMethod: sub.collection_method,
    currency: sub.currency,
    now,
    periodStart: now,
    periodEnd: now,
    autoAdvance: false,
    daysUntilDue: sub.days_until_due,
  });
  for (const ii of inv.sortPending(items)) inv.attachInvoiceItem(account, invoice, ii);
  for (const l of fullLines) {
    const planned = plannedItems.find((i) => i.price === l.state.price.id);
    inv.addSubscriptionLine(account, invoice, {
      subscription: sub,
      item: planned,
      price: l.state.price,
      quantity: l.state.quantity,
      amount: l.amount,
      start: l.start,
      end: l.end,
      description: subscriptionLineDescription(account, l.state.price, l.state.quantity),
    });
  }
  inv.insertDraft(account, invoice, { request });
  inv.finalizeInvoice(account, invoice, { request, paymentIntent: pendingFailure.pi });
  if (invoice.status === 'open') {
    const before = structuredClone(invoice);
    invoice.attempted = true;
    invoice.attempt_count = 1;
    invoice._charge = pendingFailure.charge?.id ?? null;
    invoice._lastFailure = inv.failureRecord(pendingFailure.paymentMethod, pendingFailure.error);
    inv.emitPaymentFailure(account, invoice, { previous: before, request });
  }
  scheduleSubJob(account, sub, JOB.pendingUpdateExpire, expiresAt, 'pending_update_expire', { invoice: invoiceId });
  return { subscription: sub, invoice, paymentError: pendingFailure.error };
}

function applyPendingUpdate(account, sub, { request } = {}) {
  const plan = sub._pendingPlan;
  const pending = sub.pending_update;
  const previous = structuredClone(sub);
  for (const id of plan.removed) {
    const item = sub.items.data.find((i) => i.id === id);
    if (item) removeItem(account, sub, item);
  }
  for (const planned of pending.subscription_items) {
    const existing = sub.items.data.find((i) => i.id === planned.id);
    if (existing) Object.assign(existing, { ...planned, _billed: { amount: amountFor(account.store.get('price', planned.price), planned.quantity ?? 1) } });
    else {
      const item = { ...planned, _billed: { amount: amountFor(account.store.get('price', planned.price), planned.quantity ?? 1) } };
      storeItem(account, sub, item);
    }
  }
  if (pending.billing_cycle_anchor !== null) sub.billing_cycle_anchor = pending.billing_cycle_anchor;
  if (plan.endTrial && sub.status === 'trialing') {
    sub.status = 'active';
    sub.trial_end = pending.trial_end;
  }
  sub.pending_update = null;
  sub._pendingPlan = null;
  account.time.cancel(`${sub.id}:pending_update_expire`);
  trackPeriodEndCancel(sub);
  emitEvent(account, 'customer.subscription.pending_update_applied', sub, { request });
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  syncJobs(account, sub);
}

function expirePendingUpdate(account, sub, { request = null } = {}) {
  if (!sub.pending_update) return;
  const previous = structuredClone(sub);
  const invoiceId = sub._pendingPlan?.invoice;
  sub.pending_update = null;
  sub._pendingPlan = null;
  account.time.cancel(`${sub.id}:pending_update_expire`);
  emitEvent(account, 'customer.subscription.pending_update_expired', sub, { request });
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  const invoice = invoiceId ? account.store.get('invoice', invoiceId) : null;
  if (invoice && ['open', 'uncollectible'].includes(invoice.status)) inv.voidInvoice(account, invoice, { request });
}

// Single-purpose changes (portal, schedules, controls) -------------------------------------------

/**
 * Changes a subscription's items (API update, portal plan switch, schedule phase change).
 * @param {object} change
 * @param {{id?: string, price?: object, quantity?: number, deleted?: boolean, metadata?: object|''}[]} change.items
 *   Stripe semantics: with id → update or delete that item, without id → add one; a price change
 *   resets quantity to 1 unless given.
 * @param {'create_prorations'|'always_invoice'|'none'} [change.prorationBehavior] default create_prorations
 * @param {number} [change.prorationDate]
 * @param {'now'|'unchanged'} [change.billingCycleAnchor]
 * @param {'allow_incomplete'|'default_incomplete'|'error_if_incomplete'|'pending_if_incomplete'} [change.paymentBehavior]
 * @param {number|'now'} [change.trialEnd]
 * @param {'end_trial'|'continue_trial'} [change.trialUpdateBehavior] portal only
 * @param {{source: 'api'|'portal'|'schedule', request?: object|null}} opts
 * @returns {{subscription: object, invoice: object|null, paymentError: object|null}}
 */
export function changeSubscriptionItems(account, subscription, change, opts = {}) {
  return updateSubscription(
    account,
    subscription,
    {
      items: change.items,
      prorationBehavior: change.prorationBehavior,
      prorationDate: change.prorationDate,
      billingCycleAnchor: change.billingCycleAnchor === 'unchanged' ? undefined : change.billingCycleAnchor,
      paymentBehavior: change.paymentBehavior,
      trialEnd: change.trialEnd,
      trialUpdateBehavior: change.trialUpdateBehavior,
    },
    opts,
  );
}

/**
 * Sets (true) or clears (false) a period-end cancellation. Classic: cancel_at_period_end = value
 * and cancel_at = period end / null. Flexible via the portal: cancel_at = max item period end with
 * cancel_at_period_end false (docs.stripe.com/billing/subscriptions/billing-mode/compare).
 * @param {{source: 'api'|'portal', cancellationDetails?: object, request?: object|null}} opts
 * @returns {object} the subscription
 */
export function setCancelAtPeriodEnd(account, subscription, value, opts = {}) {
  return updateSubscription(account, subscription, { cancelAtPeriodEnd: Boolean(value), cancellationDetails: opts.cancellationDetails }, opts).subscription;
}

/**
 * Sets cancel_at: a timestamp, null to clear, or 'min_period_end' / 'max_period_end'.
 * @param {{source: 'api'|'portal'|'schedule', request?: object|null}} opts
 */
export function setCancelAt(account, subscription, cancelAt, opts = {}) {
  return updateSubscription(account, subscription, { cancelAt }, opts).subscription;
}

/**
 * Sets subscription.schedule (a schedule attached, released or completed) and emits
 * customer.subscription.updated.
 */
export function setSubscriptionSchedule(account, subscription, scheduleId, { request } = {}) {
  const previous = structuredClone(subscription);
  subscription.schedule = scheduleId ?? null;
  emitUpdated(account, subscription, 'customer.subscription.updated', previous, { request });
  return subscription;
}

// Cancellation ----------------------------------------------------------------------------------

/**
 * Ends a subscription now: status canceled, jobs stopped, open and draft invoices stop automatic
 * collection, customer.subscription.deleted, then an optional final invoice.
 */
function endSubscription(account, sub, o) {
  const { reason = 'cancellation_requested', request, cancellationDetails, invoiceNow = false, prorate: prorateCredit = false, periodEnd = false } = o;
  const at = o.at ?? nowOf(account, sub);
  const customer = customerOf(account, sub);
  const credits = [];
  if (prorateCredit && ['active', 'past_due', 'unpaid'].includes(sub.status)) {
    for (const item of sub.items.data) {
      const state = { item, price: priceOf(account, item), quantity: item.quantity, oldPrice: priceOf(account, item), oldQuantity: item.quantity };
      const amount = -prorate(creditBase(sub, state), item.current_period_start, item.current_period_end, at);
      if (amount) credits.push({ state, amount, credit: true, start: at, end: item.current_period_end });
    }
  }
  if (!periodEnd && !invoiceNow && !prorateCredit) {
    // An immediate cancel drops pending prorations unless invoice_now or prorate (docs.stripe.com/api/subscriptions/cancel).
    for (const ii of inv.pendingInvoiceItems(account, sub.id)) if (ii.proration) ii._deleted = true;
  }
  sub.status = 'canceled';
  sub.ended_at = at;
  if (!periodEnd || sub.canceled_at === null) sub.canceled_at = at;
  if (!periodEnd) {
    sub.cancel_at_period_end = false;
    sub.cancel_at = null;
  }
  sub.pending_update = null;
  sub._pendingPlan = null;
  sub.cancellation_details.reason = reason;
  if (cancellationDetails) {
    for (const key of ['comment', 'feedback', 'feedback_option']) {
      if (cancellationDetails[key] !== undefined) sub.cancellation_details[key] = cancellationDetails[key] === '' ? null : cancellationDetails[key];
    }
  }
  clearJobs(account, sub);
  const items = createProrationItems(account, sub, customer, credits);
  // Final invoice: invoice_now, or pending items at a period-end cancel ("pending invoice items are
  // always charged when the billing period ends for any canceled subscription"). The deleted
  // subscription already points at it, as a created subscription points at its first invoice.
  const pending = inv.pendingInvoiceItems(account, sub.id);
  const finalInvoiceId = (invoiceNow || periodEnd) && pending.length ? account.mintId('in') : null;
  if (finalInvoiceId) sub.latest_invoice = finalInvoiceId;
  for (const ii of items) emitEvent(account, 'invoiceitem.created', ii, { request });
  emitEvent(account, 'customer.subscription.deleted', sub, { request });
  for (const invoice of inv.invoicesOfSubscription(account, sub.id)) inv.stopAutomaticCollection(account, invoice, { request });

  if (finalInvoiceId) {
    const invoice = inv.newInvoice(account, {
      id: finalInvoiceId,
      customer,
      subscription: sub,
      billingReason: periodEnd ? 'subscription_cycle' : 'subscription_update',
      collectionMethod: sub.collection_method,
      currency: sub.currency,
      now: at,
      periodStart: at,
      periodEnd: at,
      autoAdvance: false,
      daysUntilDue: sub.days_until_due,
    });
    for (const ii of inv.sortPending(pending)) inv.attachInvoiceItem(account, invoice, ii);
    inv.insertDraft(account, invoice, { request });
    inv.finalizeInvoice(account, invoice, { request });
    if (invoice.status === 'open' && invoice.collection_method === 'charge_automatically') {
      inv.attemptPayment(account, invoice, { mode: 'manual', request });
    }
  }
  // The schedule is told about cancellations it did not make itself (dunning, API, portal, customer deleted).
  if (sub.schedule && o.source !== 'schedule') schedules.onSubscriptionCanceled(account, sub, { reason, request });
  return sub;
}

/**
 * Cancels a subscription now and emits customer.subscription.deleted (docs.stripe.com/api/subscriptions/cancel).
 * @param {object} opts { invoiceNow = false, prorate = false, reason = 'cancellation_requested',
 *   cancellationDetails?: {comment, feedback, feedback_option},
 *   source: 'api'|'portal'|'schedule'|'customer_deleted'|'dunning', request? }
 * @returns {object} the subscription
 */
export function cancelSubscription(account, subscription, opts = {}) {
  if (ENDED_STATUSES.has(subscription.status)) {
    throw invalidRequest(`This subscription is already ${subscription.status === 'canceled' ? 'canceled' : 'expired'}; a ${subscription.status} subscription cannot be canceled again.`);
  }
  const reason = opts.reason ?? (opts.source === 'dunning' ? 'payment_failed' : 'cancellation_requested');
  return endSubscription(account, subscription, { ...opts, reason });
}

// Resume ----------------------------------------------------------------------------------------

/**
 * POST /v1/subscriptions/:id/resume (docs.stripe.com/api/subscriptions/resume): a paused
 * subscription gets a resumption invoice, finalized now without a payment attempt; it becomes
 * active (customer.subscription.resumed) once that invoice is paid or marked uncollectible, and
 * stays paused if it is voided or left unpaid for 23 h.
 * @param {{billingCycleAnchor?: 'now'|'unchanged', prorationBehavior?: string, prorationDate?: number}} params
 */
export function resumeSubscription(account, subscription, params = {}, opts = {}) {
  const sub = subscription;
  const { request } = opts;
  if (sub.status !== 'paused') throw invalidRequest(`Only a paused subscription can be resumed (this subscription is ${sub.status}).`);
  if (sub.collection_method !== 'charge_automatically') throw invalidRequest('Only subscriptions with collection_method=charge_automatically can be resumed.');
  if (sub._resume) throw invalidRequest('This subscription already has a resumption invoice waiting to be paid.');
  const customer = customerOf(account, sub);
  const now = nowOf(account, sub);
  const anchorMode = params.billingCycleAnchor ?? 'now';
  const prorationBehavior = params.prorationBehavior ?? 'create_prorations';
  const t = params.prorationDate ?? now;
  const planned = {};
  const lines = [];
  for (const item of sub.items.data) {
    const price = priceOf(account, item);
    const quantity = item.quantity;
    if (anchorMode === 'now') {
      const end = oneIntervalAfter(price, now);
      planned[item.id] = { start: now, end };
      lines.push({ item, price, quantity, amount: amountFor(price, quantity), start: now, end, proration: false });
    } else {
      const p = itemPeriodAt(price, sub.billing_cycle_anchor, now);
      planned[item.id] = p;
      if (prorationBehavior !== 'none') {
        lines.push({ item, price, quantity, amount: prorate(amountFor(price, quantity), p.start, p.end, t), start: t, end: p.end, proration: true });
      }
    }
  }
  const invoice = inv.newInvoice(account, {
    customer,
    subscription: sub,
    billingReason: 'subscription_update',
    collectionMethod: sub.collection_method,
    currency: sub.currency,
    now,
    periodStart: now,
    periodEnd: now,
    autoAdvance: false,
  });
  for (const ii of inv.sortPending(inv.pendingInvoiceItems(account, sub.id))) inv.attachInvoiceItem(account, invoice, ii);
  for (const l of lines) {
    if (!l.amount && l.proration) continue;
    inv.addSubscriptionLine(account, invoice, {
      subscription: sub,
      item: l.item,
      price: l.price,
      quantity: l.quantity,
      amount: l.amount,
      start: l.start,
      end: l.end,
      proration: l.proration,
      description: l.proration ? prorationDescription(account, l.price, l.quantity, l.start, false) : subscriptionLineDescription(account, l.price, l.quantity),
    });
  }
  const previous = structuredClone(sub);
  sub._resume = { invoice: invoice.id, anchor: anchorMode === 'now' ? now : null, periods: planned, amounts: Object.fromEntries(lines.map((l) => [l.item.id, amountFor(l.price, l.quantity)])) };
  sub.pending_update = {
    billing_cycle_anchor: anchorMode === 'now' ? now : null,
    discount: null,
    discounts: null,
    expires_at: now + INCOMPLETE_EXPIRY_SECONDS,
    metadata: null,
    subscription_items: null,
    trial_end: null,
    trial_from_plan: null,
  };
  sub.latest_invoice = invoice.id;
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  inv.insertDraft(account, invoice, { request });
  inv.finalizeInvoice(account, invoice, { request });
  if (sub._resume) {
    scheduleSubJob(account, sub, JOB.resumeExpire, now + INCOMPLETE_EXPIRY_SECONDS, 'resume_expire', { invoice: invoice.id });
  }
  return sub;
}

function completeResume(account, sub, { request } = {}) {
  const plan = sub._resume;
  const previous = structuredClone(sub);
  for (const item of sub.items.data) {
    const p = plan.periods[item.id];
    if (p) {
      item.current_period_start = p.start;
      item.current_period_end = p.end;
    }
    if (plan.amounts[item.id] !== undefined) item._billed = { amount: plan.amounts[item.id] };
  }
  if (plan.anchor !== null) sub.billing_cycle_anchor = plan.anchor;
  sub.status = 'active';
  sub.pending_update = null;
  sub._resume = null;
  account.time.cancel(`${sub.id}:resume_expire`);
  emitEvent(account, 'customer.subscription.resumed', sub, { request });
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  syncJobs(account, sub);
}

function abandonResume(account, sub, { request } = {}) {
  const previous = structuredClone(sub);
  sub._resume = null;
  sub.pending_update = null;
  account.time.cancel(`${sub.id}:resume_expire`);
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
}

// Invoices --------------------------------------------------------------------------------------

/**
 * Attempts to pay an invoice now (POST /v1/invoices/:id/pay, hosted invoice page, Checkout F1
 * retry). Finalizes a draft first. PM order: `paymentMethod`, invoice.default_payment_method,
 * subscription.default_payment_method, subscription.default_source, the customer's
 * invoice_settings.default_payment_method, customer.default_source.
 * @returns {{invoice: object, ok: boolean, error: object|null}}
 */
export function payInvoice(account, invoice, { paymentMethod, offSession = true, source = 'api', request, paidOutOfBand = false } = {}) {
  if (invoice.status === 'paid') throw invalidRequest('Invoice is already paid.');
  if (invoice.status === 'void') throw invalidRequest('This invoice has been voided and can no longer be paid.');
  const customer = account.store.get('customer', invoice.customer);
  if (paymentMethod && !paidOutOfBand && !attachedPaymentMethod(account, paymentMethod, customer?.id)) {
    if (!account.store.get('payment_method', paymentMethod)) throw resourceMissing('payment_method', paymentMethod, { param: 'payment_method' });
    throw invalidRequest(`The payment method ${paymentMethod} does not belong to this invoice's customer.`, { param: 'payment_method' });
  }
  if (!paidOutOfBand && !paymentMethod) {
    if (invoice.status === 'draft') inv.computeTotals(account, invoice);
    const payable = invoice.status === 'draft' ? invoice.amount_due >= minimumCharge(invoice.currency) : invoice.amount_remaining > 0;
    const sub = inv.subscriptionOfInvoice(account, invoice);
    if (payable && !defaultPaymentMethodFor(account, invoice, sub, customer)) throw noPaymentMethod();
  }
  if (invoice.status === 'draft') inv.finalizeInvoice(account, invoice, { request });
  if (invoice.status === 'paid') return { invoice, ok: true, error: null };
  if (paidOutOfBand) {
    inv.payOutOfBand(account, invoice, { request });
    return { invoice, ok: true, error: null };
  }
  const res = inv.attemptPayment(account, invoice, { paymentMethod, mode: source === 'automatic' ? 'automatic' : 'manual', offSession, request });
  return { invoice, ok: res.ok, error: res.error };
}

/**
 * Called by invoicing when an invoice is paid, voided or (manually) marked uncollectible:
 * resolves the subscription's status from its most recent invoice (docs.stripe.com/billing/subscriptions/overview),
 * applies a pending update or a resumption, activates an incomplete subscription.
 */
export function onInvoiceSettled(account, invoice, { request, cause }) {
  const sub = inv.subscriptionOfInvoice(account, invoice);
  if (!sub || ENDED_STATUSES.has(sub.status)) return;
  if (sub._pendingPlan && sub._pendingPlan.invoice === invoice.id) {
    if (cause === 'paid') applyPendingUpdate(account, sub, { request });
    else if (cause === 'void') expirePendingUpdate(account, sub, { request });
    return;
  }
  if (sub._resume && sub._resume.invoice === invoice.id) {
    if (cause === 'void') abandonResume(account, sub, { request });
    else completeResume(account, sub, { request });
    return;
  }
  const previous = structuredClone(sub);
  if (sub.status === 'incomplete') {
    const first = inv.invoicesOfSubscription(account, sub.id)[0];
    if (!first || first.id !== invoice.id) return;
    if (cause === 'void') {
      sub.status = 'incomplete_expired';
      sub.ended_at = nowOf(account, sub);
      clearJobs(account, sub);
    } else {
      sub.status = 'active';
      account.time.cancel(`${sub.id}:incomplete_expire`);
    }
  } else if (['past_due', 'unpaid'].includes(sub.status)) {
    const latest = inv
      .invoicesOfSubscription(account, sub.id)
      .filter((i) => ['open', 'paid', 'uncollectible'].includes(i.status))
      .sort((a, b) => b.created - a.created || b._seq - a._seq)[0];
    const settled = !latest || latest.status === 'paid' || (latest.status === 'uncollectible' && !latest._dunningUncollectible);
    if (!settled) return;
    sub.status = 'active';
  } else return;
  emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
  syncJobs(account, sub);
}

/**
 * Called by invoicing after a failed payment attempt. `mode`: 'create' (first invoice: no
 * retries, the subscription stays incomplete), 'update' (an update's invoice: no retries,
 * past_due), 'automatic' (renewal finalization or a retry: the account's retry schedule, then
 * the final-retry action), 'manual' (pay endpoint, hosted page: no change to retries or status).
 */
export function onPaymentFailure(account, invoice, o) {
  const { mode, previous, request, requiresAction } = o;
  const sub = inv.subscriptionOfInvoice(account, invoice);
  const settings = account.settings.billing;
  const now = nowOf(account, invoice);
  let final = false;
  if (mode === 'automatic') {
    const retriesUsed = invoice.attempt_count - 1;
    if (retriesUsed < settings.retrySchedule.length) {
      const next = now + Math.round(settings.retrySchedule[retriesUsed] * DAY);
      invoice.next_payment_attempt = next;
      account.time.schedule({
        kind: JOB.retry,
        at: next,
        domain: account.time.domainOf(invoice),
        key: `${invoice.id}:retry`,
        data: { invoice: invoice.id },
        priority: JOB_PRIORITY.paymentRetry,
      });
    } else {
      invoice.next_payment_attempt = null;
      final = true;
    }
  } else if (mode === 'create' || mode === 'update') {
    invoice.next_payment_attempt = null;
    invoice.auto_advance = false;
  }
  inv.emitPaymentFailure(account, invoice, { previous, request, requiresAction });
  if (mode === 'automatic') {
    const customer = account.store.get('customer', invoice.customer);
    if (customer && !customer.delinquent) changeCustomer(account, customer, (c) => { c.delinquent = true; }, { request });
  }
  if (!sub) {
    if (final && settings.markUncollectible && invoice.status === 'open') inv.markUncollectible(account, invoice, { request, byDunning: true });
    return;
  }
  if (ENDED_STATUSES.has(sub.status)) return;
  if (mode === 'automatic' || mode === 'update') toPastDue(account, sub, { request });
  if (final) applyFinalRetryAction(account, sub, invoice, { request });
}

/** After the final retry: cancel, unpaid or stay past_due; optionally mark the invoice uncollectible. */
function applyFinalRetryAction(account, sub, invoice, { request } = {}) {
  const { afterFinalRetry, markUncollectible } = account.settings.billing;
  if (sub.status !== 'incomplete' && !ENDED_STATUSES.has(sub.status)) {
    if (afterFinalRetry === 'cancel') endSubscription(account, sub, { reason: 'payment_failed', source: 'dunning', request });
    else if (afterFinalRetry === 'unpaid' && sub.status !== 'unpaid') {
      const previous = structuredClone(sub);
      sub.status = 'unpaid';
      emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
    }
  }
  if (markUncollectible && invoice.status === 'open') inv.markUncollectible(account, invoice, { request, byDunning: true });
}

// Time-driven transitions -----------------------------------------------------------------------

function subOfJob(account, job) {
  return account.store.get('subscription', job.data.subscription);
}

/** At a period end: roll the items' periods, draft the next invoice (finalized ~1 h later). */
function renew(account, sub, at) {
  const customer = customerOf(account, sub);
  const previous = structuredClone(sub);
  const lookBack = currentPeriod(sub);
  const renewed = [];
  for (const item of sub.items.data) {
    if (item.current_period_end > at) continue;
    const price = priceOf(account, item);
    const start = item.current_period_end;
    const end = periodEndBefore(sub, nextItemBoundary(price, sub.billing_cycle_anchor, start), start);
    item.current_period_start = start;
    item.current_period_end = end;
    const charge = periodCharge(price, item.quantity ?? 1, sub.billing_cycle_anchor, start, end);
    item._billed = { amount: amountFor(price, item.quantity ?? 1) };
    renewed.push({ item, price, amount: charge.amount, proration: charge.proration, start, end });
  }
  const pause = sub.pause_collection?.behavior ?? null;
  const draftOnly = sub.status === 'unpaid' || pause === 'keep_as_draft';
  const invoice = inv.newInvoice(account, {
    customer,
    subscription: sub,
    billingReason: 'subscription_cycle',
    collectionMethod: sub.collection_method,
    currency: sub.currency,
    now: at,
    periodStart: lookBack.start,
    periodEnd: lookBack.end,
    autoAdvance: !draftOnly,
    daysUntilDue: sub.days_until_due,
  });
  for (const ii of inv.sortPending(inv.pendingInvoiceItems(account, sub.id, { includeCustomer: true }))) inv.attachInvoiceItem(account, invoice, ii);
  renewed.sort((a, b) => b.item.created - a.item.created || a.item._seq - b.item._seq);
  for (const r of renewed) {
    inv.addSubscriptionLine(account, invoice, {
      subscription: sub,
      item: r.item,
      price: r.price,
      quantity: r.item.quantity,
      amount: r.amount,
      start: r.start,
      end: r.end,
      proration: r.proration,
      description: r.proration ? prorationDescription(account, r.price, r.item.quantity, r.start, false) : subscriptionLineDescription(account, r.price, r.item.quantity),
    });
  }
  sub.latest_invoice = invoice.id;
  trackPeriodEndCancel(sub);
  emitUpdated(account, sub, 'customer.subscription.updated', previous);
  inv.insertDraft(account, invoice, { scheduleFinalization: true });
  if (pause === 'void' || pause === 'mark_uncollectible') {
    inv.finalizeInvoice(account, invoice);
    if (invoice.status === 'open') {
      if (pause === 'void') inv.voidInvoice(account, invoice);
      else inv.markUncollectible(account, invoice);
    }
  }
  syncJobs(account, sub);
}

function renewalJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || !['active', 'past_due', 'unpaid'].includes(sub.status)) return;
  const at = account.time.now(job.domain);
  if (sub.cancel_at !== null && sub.cancel_at <= at) return endAtCancel(account, sub, at);
  if (currentPeriod(sub).end > at) return syncJobs(account, sub);
  renew(account, sub, at);
}

/** A trial reaches its end: invoice the first paid period, or cancel / pause without a payment method. */
function trialEndJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || sub.status !== 'trialing' || sub.trial_end !== job.data.trialEnd) return;
  const at = account.time.now(job.domain);
  if (sub.cancel_at !== null && sub.cancel_at <= at) return endAtCancel(account, sub, at);
  const customer = customerOf(account, sub);
  if (!hasPaymentMethod(account, sub, customer)) {
    const behavior = sub.trial_settings?.end_behavior?.missing_payment_method ?? 'create_invoice';
    if (behavior === 'cancel') {
      endSubscription(account, sub, { at, reason: 'cancellation_requested', source: 'trial_end', request: null });
      return;
    }
    if (behavior === 'pause') {
      const previous = structuredClone(sub);
      sub.status = 'paused';
      emitEvent(account, 'customer.subscription.paused', sub);
      emitUpdated(account, sub, 'customer.subscription.updated', previous);
      syncJobs(account, sub);
      return;
    }
  }
  const previous = structuredClone(sub);
  const trialStart = sub.trial_start ?? sub.start_date;
  sub.status = 'active';
  const lines = [];
  for (const item of sub.items.data) {
    const price = priceOf(account, item);
    const quantity = item.quantity;
    const end = periodEndBefore(sub, nextItemBoundary(price, sub.billing_cycle_anchor, at), at);
    const charge = periodCharge(price, quantity, sub.billing_cycle_anchor, at, end);
    item.current_period_start = at;
    item.current_period_end = end;
    item._billed = { amount: amountFor(price, quantity) };
    lines.push({ item, price, quantity, amount: charge.amount, proration: charge.proration, end });
  }
  const invoice = inv.newInvoice(account, {
    customer,
    subscription: sub,
    billingReason: 'subscription_cycle',
    collectionMethod: sub.collection_method,
    currency: sub.currency,
    now: at,
    periodStart: trialStart,
    periodEnd: at,
    autoAdvance: true,
    daysUntilDue: sub.days_until_due,
  });
  for (const ii of inv.sortPending(inv.pendingInvoiceItems(account, sub.id, { includeCustomer: true }))) inv.attachInvoiceItem(account, invoice, ii);
  for (const l of lines) {
    inv.addSubscriptionLine(account, invoice, {
      subscription: sub,
      item: l.item,
      price: l.price,
      quantity: l.quantity,
      amount: l.amount,
      start: at,
      end: l.end,
      proration: l.proration,
      description: l.proration ? prorationDescription(account, l.price, l.quantity, at, false) : subscriptionLineDescription(account, l.price, l.quantity),
    });
  }
  sub.latest_invoice = invoice.id;
  trackPeriodEndCancel(sub);
  emitUpdated(account, sub, 'customer.subscription.updated', previous);
  inv.insertDraft(account, invoice, { scheduleFinalization: true });
  syncJobs(account, sub);
}

function trialWillEndJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || sub.status !== 'trialing' || sub.trial_end !== job.data.trialEnd) return;
  emitEvent(account, 'customer.subscription.trial_will_end', sub);
}

/** cancel_at (or the period end of cancel_at_period_end) is reached. */
function endAtCancel(account, sub, at) {
  endSubscription(account, sub, { at, reason: sub.cancellation_details.reason ?? 'cancellation_requested', source: 'cancel_at', periodEnd: true, request: null });
}

function cancelAtJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || ENDED_STATUSES.has(sub.status) || sub.cancel_at !== job.data.cancelAt) return;
  endAtCancel(account, sub, account.time.now(job.domain));
}

/** An incomplete subscription whose first invoice is unpaid after 23 h expires; the invoice is voided. */
function incompleteExpireJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || sub.status !== 'incomplete') return;
  const previous = structuredClone(sub);
  sub.status = 'incomplete_expired';
  sub.ended_at = account.time.now(job.domain);
  clearJobs(account, sub);
  emitUpdated(account, sub, 'customer.subscription.updated', previous);
  for (const invoice of inv.invoicesOfSubscription(account, sub.id)) {
    if (invoice.status === 'open' || invoice.status === 'uncollectible') inv.voidInvoice(account, invoice);
    else if (invoice.status === 'draft') inv.stopAutomaticCollection(account, invoice);
  }
}

function pauseCollectionResumeJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || sub.pause_collection?.resumes_at !== job.data.resumesAt) return;
  const previous = structuredClone(sub);
  sub.pause_collection = null;
  emitUpdated(account, sub, 'customer.subscription.updated', previous);
}

function pendingUpdateExpireJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || !sub._pendingPlan || sub._pendingPlan.invoice !== job.data.invoice) return;
  expirePendingUpdate(account, sub, { request: null });
}

function resumeExpireJob(account, job) {
  const sub = subOfJob(account, job);
  if (!sub || !sub._resume || sub._resume.invoice !== job.data.invoice) return;
  const invoice = account.store.get('invoice', job.data.invoice);
  abandonResume(account, sub);
  if (invoice && ['open', 'uncollectible'].includes(invoice.status)) inv.voidInvoice(account, invoice);
}

/** The draft window has passed: finalize, then collect automatically. */
function finalizeJob(account, job) {
  const invoice = account.store.get('invoice', job.data.invoice);
  if (!invoice || invoice.status !== 'draft' || !invoice.auto_advance) return;
  inv.finalizeInvoice(account, invoice, { request: null });
  if (invoice.status === 'open' && invoice.collection_method === 'charge_automatically' && invoice.auto_advance) {
    inv.attemptPayment(account, invoice, { mode: 'automatic', request: null });
  }
}

/** A scheduled retry (or the first automatic attempt after a manual finalization). */
function retryJob(account, job) {
  const invoice = account.store.get('invoice', job.data.invoice);
  if (!invoice || invoice.status !== 'open' || !invoice.auto_advance) return;
  const sub = inv.subscriptionOfInvoice(account, invoice);
  if (sub && ENDED_STATUSES.has(sub.status)) return;
  inv.attemptPayment(account, invoice, { mode: 'automatic', request: null });
}

/** send_invoice: the due date passes unpaid → past_due, customer delinquent. */
function dueJob(account, job) {
  const invoice = account.store.get('invoice', job.data.invoice);
  if (!invoice || invoice.status !== 'open') return;
  const customer = account.store.get('customer', invoice.customer);
  if (customer && !customer.delinquent) changeCustomer(account, customer, (c) => { c.delinquent = true; });
  const sub = inv.subscriptionOfInvoice(account, invoice);
  if (sub && sub.latest_invoice === invoice.id) toPastDue(account, sub);
}

// Controls --------------------------------------------------------------------------------------

/**
 * The createSubscription control: a live subscription for `customerId`, bypassing
 * Checkout (e.g. a second subscription). `price` is a price ID; `trialDays` sets a trial;
 * `paymentMethod` (pm_ ID or alias) is attached and becomes default_payment_method. Without it the
 * customer's default card is charged, else the card of their newest live subscription (Checkout
 * saves the card there), else their newest attached card.
 * @returns {object} the internal subscription
 */
export function createSubscriptionForTest(account, customerId, { price, quantity = 1, trialDays, paymentMethod } = {}) {
  const customer = requireCustomer(account, customerId, { param: 'customer' });
  const priceObj = account.store.get('price', price);
  if (!priceObj || priceObj._deleted) throw resourceMissing('price', price, { param: 'price' });
  if (!priceObj.recurring) throw invalidRequest(`The price ${price} is not recurring.`, { param: 'price' });
  if (!Number.isInteger(quantity) || quantity < 1) throw invalidRequest('quantity must be a positive integer', { param: 'quantity' });
  if (trialDays !== undefined && (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 730)) {
    throw invalidRequest('trialDays must be an integer between 0 and 730', { param: 'trialDays' });
  }
  let pmId = null;
  if (paymentMethod) {
    const existing = attachedPaymentMethod(account, paymentMethod, customer.id);
    pmId = existing ? existing.id : attachPaymentMethod(account, paymentMethod, customer, { param: 'paymentMethod', request: null }).id;
  } else if (!defaultPaymentMethodFor(account, null, null, customer)) {
    const fromSubscription = subscriptionsForCustomer(account, customer.id)
      .map((s) => s.default_payment_method)
      .find((id) => attachedPaymentMethod(account, id, customer.id));
    const newestCard = account.store
      .list('payment_method', (pm) => pm.customer === customer.id && !pm._detached)
      .sort(newestFirst)[0];
    pmId = fromSubscription ?? newestCard?.id ?? null;
  }
  const { subscription } = createSubscription(
    account,
    {
      customer,
      items: [{ price: priceObj, quantity }],
      trialPeriodDays: trialDays || undefined,
      defaultPaymentMethod: pmId,
      paymentBehavior: 'allow_incomplete',
    },
    { source: 'control', version: account.settings.apiVersion, request: null },
  );
  return subscription;
}

export function install(app) {
  app.job(JOB.renewal, renewalJob);
  app.job(JOB.trialEnd, trialEndJob);
  app.job(JOB.trialWillEnd, trialWillEndJob);
  app.job(JOB.cancelAt, cancelAtJob);
  app.job(JOB.incompleteExpire, incompleteExpireJob);
  app.job(JOB.pauseCollectionResume, pauseCollectionResumeJob);
  app.job(JOB.pendingUpdateExpire, pendingUpdateExpireJob);
  app.job(JOB.resumeExpire, resumeExpireJob);
  app.job(JOB.finalize, finalizeJob);
  app.job(JOB.retry, retryJob);
  app.job(JOB.attempt, retryJob);
  app.job(JOB.due, dueJob);
  app.hook('customer.deleting', (account, customer, { request } = {}) => {
    for (const sub of subscriptionsForCustomer(account, customer.id)) {
      endSubscription(account, sub, { reason: 'cancellation_requested', source: 'customer_deleted', request });
    }
  });
  // A detached card stops being a subscription's default (customer.subscription.updated).
  app.hook('payment_method.detached', (account, pm, { customer, request } = {}) => {
    for (const sub of subscriptionsForCustomer(account, customer)) {
      if (sub.default_payment_method !== pm.id) continue;
      const previous = structuredClone(sub);
      sub.default_payment_method = null;
      emitUpdated(account, sub, 'customer.subscription.updated', previous, { request });
    }
  });
}
