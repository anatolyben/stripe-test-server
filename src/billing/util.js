/**
 * Shared helpers of the billing engine: timing constants, money arithmetic, line
 * descriptions and store lookups. Pure functions only; nothing here changes state.
 */
import { formatAmount, describeInterval } from '../core/currency.js';
import { addIntervals, nextBoundaryAfter, periodContaining } from '../core/periods.js';

export const DAY = 86400;
/** Renewal and schedule-started drafts stay drafts ~1 h (docs.stripe.com/billing/invoices/subscription). */
export const DRAFT_WINDOW_SECONDS = 3600;
/** An unpaid first invoice expires the subscription after 23 h (docs.stripe.com/api/subscriptions/object). */
export const INCOMPLETE_EXPIRY_SECONDS = 23 * 3600;
/** customer.subscription.trial_will_end fires 3 days before trial_end (Dashboard default). */
export const TRIAL_WILL_END_SECONDS = 3 * DAY;
/** Longest trial: 730 days (docs.stripe.com/billing/subscriptions/trials/free-trials). */
export const MAX_TRIAL_SECONDS = 730 * DAY;
/** Subscription item limits (docs.stripe.com/billing/subscriptions/billing-mode/compare). */
export const MAX_ITEMS = { classic: 20, flexible: 100 };
/** Declines after which retries wait for a new payment method (docs.stripe.com/billing/revenue-recovery/smart-retries). */
export const HARD_DECLINES = new Set([
  'incorrect_number',
  'lost_card',
  'pickup_card',
  'stolen_card',
  'revocation_of_authorization',
  'revocation_of_all_authorizations',
  'authentication_required',
  'highest_risk_level',
  'transaction_not_allowed',
]);

/** Subscription statuses that no longer bill. */
export const ENDED_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** The time of the domain an object lives in (its customer's test clock, else the account clock). */
export function nowOf(account, obj) {
  return account.time.now(account.time.domainOf(obj));
}

/** Rounds half away from zero (the tie rule chosen for prorations). */
export function roundAmount(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** The unit amount of a price as a number (unit_amount_decimal wins: it carries fractions). */
export function unitAmountOf(price) {
  if (price.unit_amount_decimal !== null && price.unit_amount_decimal !== undefined) return Number(price.unit_amount_decimal);
  return price.unit_amount ?? 0;
}

function decimalOf(value, fallback) {
  if (value !== null && value !== undefined) return Number(value);
  return fallback ?? 0;
}

function tieredAmount(price, quantity) {
  const tiers = price.tiers;
  const upTo = (t) => (t.up_to === null || t.up_to === undefined || t.up_to === 'inf' ? Infinity : Number(t.up_to));
  const unit = (t) => decimalOf(t.unit_amount_decimal, t.unit_amount);
  const flat = (t) => decimalOf(t.flat_amount_decimal, t.flat_amount);
  if (price.tiers_mode === 'volume') {
    const tier = tiers.find((t) => quantity <= upTo(t)) ?? tiers[tiers.length - 1];
    return roundAmount(unit(tier) * quantity + flat(tier));
  }
  let total = 0;
  let floor = 0;
  for (const tier of tiers) {
    if (quantity <= floor) break;
    const inTier = Math.min(quantity, upTo(tier)) - floor;
    total += unit(tier) * inTier + flat(tier);
    floor = upTo(tier);
  }
  return roundAmount(total);
}

/** The amount of `quantity` units of a price for one full period (per-unit or tiered). */
export function amountFor(price, quantity) {
  if (price.recurring?.usage_type === 'metered') return 0;
  if (price.billing_scheme === 'tiered' && Array.isArray(price.tiers) && price.tiers.length) return tieredAmount(price, quantity);
  let q = quantity;
  if (price.transform_quantity) {
    const { divide_by: divideBy, round } = price.transform_quantity;
    q = round === 'up' ? Math.ceil(q / divideBy) : Math.floor(q / divideBy);
  }
  return roundAmount(unitAmountOf(price) * q);
}

/**
 * A prorated share of `amount` for [t, end) out of the period [start, end), to the second,
 * rounded to the minor unit (docs.stripe.com/billing/subscriptions/prorations).
 */
export function prorate(amount, start, end, t) {
  if (t >= end || end <= start) return 0;
  const from = Math.max(t, start);
  return roundAmount((amount * (end - from)) / (end - start));
}

/** A decimal string for a unit amount (at most 12 decimal places, no trailing zeros). */
export function decimalString(value) {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(12)));
}

/** "01 Sep 2020" (UTC), as in Stripe's proration line descriptions. */
export function formatDay(t) {
  const d = new Date(t * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The product name of a price (falls back to the product ID). */
export function productName(account, price) {
  const product = account.store.get('product', price.product);
  return product?.name ?? price.product;
}

/** "1 × Pro (at $20.00 / month)" (docs.stripe.com/billing/subscriptions/billing-mode example). */
export function subscriptionLineDescription(account, price, quantity) {
  const name = productName(account, price);
  if (quantity === null || quantity === undefined) return `${name} (metered usage)`;
  if (price.billing_scheme === 'tiered') return `${quantity} × ${name} (Tier pricing)`;
  const unit = formatAmount(Math.round(unitAmountOf(price)), price.currency);
  return `${quantity} × ${name} (at ${unit} ${describeInterval(price.recurring.interval, price.recurring.interval_count ?? 1)})`;
}

/**
 * The $0 trial line: classic "Trial period for Pro", flexible "Free trial for 1 × Pro"
 * (docs.stripe.com/billing/subscriptions/billing-mode/compare).
 */
export function trialLineDescription(account, price, quantity, billingMode) {
  const name = productName(account, price);
  if (price.recurring?.usage_type === 'metered') return `${quantity ?? 0} × ${name} (Free trial)`;
  return billingMode === 'flexible' ? `Free trial for ${quantity} × ${name}` : `Trial period for ${name}`;
}

/** "Unused time on Pro after 01 Sep 2020" / "Remaining time on 2 × Pro after 01 Sep 2020". */
export function prorationDescription(account, price, quantity, t, credit) {
  const name = productName(account, price);
  const what = quantity > 1 ? `${quantity} × ${name}` : name;
  return `${credit ? 'Unused time on' : 'Remaining time on'} ${what} after ${formatDay(t)}`;
}

/** Description of a one-time price line (the product name; "2 × Setup" for quantities above one). */
export function oneTimeLineDescription(account, price, quantity) {
  const name = productName(account, price);
  return quantity > 1 ? `${quantity} × ${name}` : name;
}

/** The interval of a recurring price as { interval, count }. */
export function intervalOf(price) {
  return { interval: price.recurring.interval, count: price.recurring.interval_count ?? 1 };
}

/** True when two recurring prices bill on the same interval and interval_count. */
export function sameInterval(a, b) {
  const x = intervalOf(a);
  const y = intervalOf(b);
  return x.interval === y.interval && x.count === y.count;
}

/**
 * Whether items with these intervals may share a flexible subscription: each interval must be a
 * whole multiple of the shortest, and days/weeks never mix with months/years
 * (docs.stripe.com/billing/subscriptions/mixed-interval).
 */
export function compatibleIntervals(intervals) {
  const calendar = intervals.some((i) => i.interval === 'month' || i.interval === 'year');
  const fixed = intervals.some((i) => i.interval === 'day' || i.interval === 'week');
  if (calendar && fixed) return false;
  const inUnits = intervals.map((i) =>
    calendar ? (i.interval === 'year' ? 12 : 1) * i.count : (i.interval === 'week' ? 7 : 1) * i.count,
  );
  const shortest = Math.min(...inUnits);
  return inUnits.every((u) => u % shortest === 0);
}

/** The period of an item on `anchor` that contains `t`: { start, end } (UTC, month-end clamped). */
export function itemPeriodAt(price, anchor, t) {
  const { interval, count } = intervalOf(price);
  return periodContaining(anchor, interval, count, t);
}

/** The first period boundary of an item after `t`. */
export function nextItemBoundary(price, anchor, t) {
  const { interval, count } = intervalOf(price);
  return nextBoundaryAfter(anchor, interval, count, t);
}

/** `t` advanced by one interval of the price. */
export function oneIntervalAfter(price, t) {
  const { interval, count } = intervalOf(price);
  return addIntervals(t, interval, count, 1);
}

/** The subscription's current period: latest item start, earliest item end (mixed intervals). */
export function subscriptionPeriod(subscription) {
  const items = subscription.items.data;
  if (!items.length) return { start: subscription.start_date, end: subscription.start_date };
  return {
    start: Math.max(...items.map((i) => i.current_period_start)),
    end: Math.min(...items.map((i) => i.current_period_end)),
  };
}

/** The latest item period end (portal cancels in flexible mode, cancel_at=max_period_end). */
export function maxItemPeriodEnd(subscription) {
  return Math.max(...subscription.items.data.map((i) => i.current_period_end));
}

/** A live PaymentMethod attached to `customerId`, or null. */
export function attachedPaymentMethod(account, id, customerId) {
  if (!id) return null;
  const pm = account.store.get('payment_method', id);
  if (!pm || pm._deleted || pm.customer !== customerId) return null;
  return pm;
}

/**
 * The PaymentMethod an invoice charges when none is given: invoice default, subscription default
 * (payment method, then source), customer invoice_settings default, customer default_source
 * (docs.stripe.com/billing/revenue-recovery/smart-retries "Payment method ordering").
 */
export function defaultPaymentMethodFor(account, invoice, subscription, customer) {
  const candidates = [
    invoice?.default_payment_method,
    subscription?.default_payment_method,
    subscription?.default_source,
    customer?.invoice_settings?.default_payment_method,
    customer?.default_source,
  ];
  for (const id of candidates) {
    if (id && attachedPaymentMethod(account, id, customer?.id)) return id;
  }
  return null;
}

/** True when a subscription or its customer has a payment method to charge (trial-end check). */
export function hasPaymentMethod(account, subscription, customer) {
  return Boolean(defaultPaymentMethodFor(account, null, subscription, customer));
}
