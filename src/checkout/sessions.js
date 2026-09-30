/**
 * Checkout Sessions in subscription mode (docs.stripe.com/api/checkout/sessions).
 *
 * Routes: POST/GET /v1/checkout/sessions, GET/POST /v1/checkout/sessions/:id,
 * POST /v1/checkout/sessions/:id/expire, GET /v1/checkout/sessions/:id/line_items.
 * Objects: 'checkout.session' (includable `line_items` and `optional_items`) and its line items,
 * 'item' (li_…, with the price embedded). `url` = `${server.url}/c/pay/${id}` while a hosted session
 * is open, null afterwards. A job expires open sessions at `expires_at`.
 * Events: checkout.session.completed (from the hosted page, see completeSession) and
 * checkout.session.expired.
 *
 * Internal session fields beyond the wire shape: _version (API version of the creating request,
 * which decides the completion flow and the subscription's billing mode), _line_items,
 * _optional_items, _subscription_data, _customer_update, _attempt (the customer an earlier
 * attempt created and, in the 2024-06-20 flow, the incomplete subscription of a declined attempt).
 */
import { emitEvent } from '../core/events.js';
import {
  invalidParam,
  invalidRequest,
  parameterMissing,
  parametersExclusive,
  resourceMissing,
} from '../core/errors.js';
import { paginate, matchesRange } from '../core/list.js';
import { JOB_PRIORITY } from '../core/time.js';
import { atLeast, familyOf } from '../core/versions.js';
import { addIntervals } from '../core/periods.js';
import { applyMetadata, checkUrl, normalizeAddress } from '../core/util.js';
import { minimumCharge } from '../core/currency.js';
import { validateParams } from '../core/validate.js';
import { createCustomer, requireCustomer, updateCustomer } from '../customers/customers.js';
import { createPrice, preparePrice, requirePrice } from '../catalog/prices.js';
import { attachPaymentMethod, testCardOf } from '../payments/payment_methods.js';
import { cardDeclineError, predictChargeFailure } from '../payments/payment_intents.js';
import * as billing from '../billing/engine.js';
import { isMetered, isRecurring, priceAmount } from './pricing.js';
import { roundAmount } from '../billing/util.js';

/** Allowed distance of expires_at from creation (docs.stripe.com/api/checkout/sessions/create#expires_at). */
const MIN_EXPIRY_SECONDS = 30 * 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
/** Subscription mode takes up to 20 recurring and 20 one-time items (line items plus optional items). */
const MAX_ITEMS_PER_KIND = 20;
const MAX_OPTIONAL_ITEMS = 10;
/** Checkout trials: trial_period_days 1–730, trial_end at least 48 hours ahead (docs.stripe.com/payments/checkout/free-trials). */
const MAX_TRIAL_DAYS = 730;
const MIN_TRIAL_END_SECONDS = 48 * 60 * 60;
const DEFAULT_ADJUSTABLE_MAX = 99;
const MAX_ADJUSTABLE_QUANTITY = 999999;

/** Pre-dahlia ui_mode values and their 2026-03-25.dahlia names. */
const UI_MODE_NAMES = { hosted: 'hosted_page', embedded: 'embedded_page', custom: 'elements' };
const UI_MODE_LEGACY = { hosted_page: 'hosted', embedded_page: 'embedded', elements: 'custom', form: 'custom' };

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function notSupported(param, what) {
  return invalidParam(param, `${what} is not supported by this test server.`);
}

function connectNotSupported(param) {
  return notSupported(param, `${param} (Connect)`);
}

/** The session's time domain: its customer's test clock, else the account clock. */
function sessionNow(account, customerId) {
  return account.time.now(account.time.domainOf(customerId ? { customer: customerId } : null));
}

/** dahlia ui_mode of a request value. */
function normalizeUiMode(value) {
  return UI_MODE_NAMES[value] ?? value;
}

// Line items ---------------------------------------------------------------------------------

function checkTaxRates(rates, param) {
  if (!rates || rates === '') return;
  rates.forEach((id, j) => {
    throw resourceMissing('tax_rate', id, { param: `${param}[${j}]` });
  });
}

/** Validates adjustable_quantity; returns the stored shape {enabled, maximum, minimum} or null. */
function readAdjustable(sent, param) {
  if (!sent) return null;
  const minimum = sent.minimum ?? 0;
  const maximum = sent.maximum ?? DEFAULT_ADJUSTABLE_MAX;
  if (minimum < 0) throw invalidParam(`${param}[minimum]`, 'adjustable_quantity.minimum must be 0 or greater.');
  if (maximum > MAX_ADJUSTABLE_QUANTITY) throw invalidParam(`${param}[maximum]`, `adjustable_quantity.maximum must be at most ${MAX_ADJUSTABLE_QUANTITY}.`);
  if (maximum < minimum) throw invalidParam(`${param}[maximum]`, 'adjustable_quantity.maximum must be greater than or equal to adjustable_quantity.minimum.');
  return { enabled: sent.enabled, maximum, minimum };
}

/** Checks a quantity against a price and an adjustable_quantity setting; returns the quantity to store. */
function checkQuantity(price, quantity, adjustable, param) {
  if (isMetered(price)) {
    if (quantity !== undefined) throw invalidParam(param, 'Quantity should not be specified for prices with recurring.usage_type=metered.');
    return null;
  }
  const q = quantity ?? 1;
  const min = adjustable?.enabled ? adjustable.minimum : 1;
  const max = adjustable?.enabled ? adjustable.maximum : Infinity;
  if (q < min || q > max) {
    throw invalidParam(param, adjustable?.enabled ? `Quantity must be between ${min} and ${max}.` : 'Quantity must be at least 1.');
  }
  return q;
}

/** Validates price_data without creating anything (catalog preparePrice); returns a creation plan. */
function readPriceData(account, data, param, version) {
  const spec = preparePrice(account, data, { version, paramPrefix: param });
  // A stand-in with the fields the checks below read (type, currency, recurring, amounts).
  return { data, param, preview: { object: 'price', ...spec.fields, _preview: true } };
}

/** Creates the inline price (and its product_data product) of a validated price_data entry. */
function createInlinePrice(account, { data, param }, version) {
  return createPrice(account, data, { inline: true, version, paramPrefix: param });
}

/**
 * Validates line_items (and optional_items) of a create request without changing anything.
 * @returns {{entries: object[], optional: object[], currency: string}}
 */
function readItems(account, params, version) {
  const entries = (params.line_items ?? []).map((li, i) => {
    const param = `line_items[${i}]`;
    if (li.price !== undefined && li.price_data !== undefined) throw parametersExclusive([`${param}[price]`, `${param}[price_data]`]);
    if (li.price === undefined && li.price_data === undefined) throw parameterMissing(`${param}[price]`);
    checkTaxRates(li.tax_rates, `${param}[tax_rates]`);
    checkTaxRates(li.dynamic_tax_rates, `${param}[dynamic_tax_rates]`);
    const inline = li.price_data !== undefined ? readPriceData(account, li.price_data, `${param}[price_data]`, version) : null;
    const price = inline ? inline.preview : requirePrice(account, li.price, { param: `${param}[price]`, active: true });
    const adjustable = readAdjustable(li.adjustable_quantity, `${param}[adjustable_quantity]`);
    if (adjustable && isMetered(price)) throw invalidParam(`${param}[adjustable_quantity]`, 'adjustable_quantity cannot be used with metered prices.');
    const quantity = checkQuantity(price, li.quantity, adjustable, `${param}[quantity]`);
    return { price, inline, quantity, adjustable, metadata: li.metadata ?? null, param };
  });
  if (params.optional_items && params.optional_items.length > MAX_OPTIONAL_ITEMS) {
    throw invalidParam('optional_items', `You can specify up to ${MAX_OPTIONAL_ITEMS} optional items.`);
  }
  const optional = (params.optional_items ?? []).map((oi, i) => {
    const param = `optional_items[${i}]`;
    const price = requirePrice(account, oi.price, { param: `${param}[price]`, active: true });
    if (isMetered(price)) throw invalidParam(`${param}[price]`, 'Optional items cannot use metered prices.');
    const adjustable = readAdjustable(oi.adjustable_quantity, `${param}[adjustable_quantity]`);
    const quantity = checkQuantity(price, oi.quantity, adjustable ? { ...adjustable, minimum: Math.max(1, adjustable.minimum) } : null, `${param}[quantity]`);
    return { price, quantity, adjustable, param };
  });
  const all = [...entries, ...optional];
  const recurring = all.filter((e) => isRecurring(e.price));
  if (!entries.some((e) => isRecurring(e.price))) {
    throw invalidParam('line_items', 'You must provide at least one recurring price in `subscription` mode when using prices.');
  }
  if (recurring.length > MAX_ITEMS_PER_KIND || all.length - recurring.length > MAX_ITEMS_PER_KIND) {
    throw invalidParam('line_items', `Subscription mode supports up to ${MAX_ITEMS_PER_KIND} line items with recurring prices and ${MAX_ITEMS_PER_KIND} with one-time prices.`);
  }
  const currency = entries[0].price.currency;
  for (const e of all) {
    if (e.price.currency !== currency) {
      throw invalidParam(`${e.param}[price]`, 'All prices on a Checkout Session must use the same currency.');
    }
  }
  if (params.currency !== undefined && params.currency !== currency) {
    throw invalidParam('currency', `The currency ${params.currency} does not match the currency of the line items (${currency}).`);
  }
  return { entries, optional, currency };
}

/** Classic subscriptions bill every item on one cycle, so their recurring items share one interval. */
function checkIntervals(entries, billingModeType) {
  if (billingModeType !== 'classic') return;
  const recurring = entries.filter((e) => isRecurring(e.price)).map((e) => e.price.recurring);
  const first = recurring[0];
  for (const r of recurring) {
    if (r.interval !== first.interval || (r.interval_count ?? 1) !== (first.interval_count ?? 1)) {
      throw invalidParam('line_items', 'All recurring prices must have the same billing interval in classic billing mode.');
    }
  }
}

function productName(account, price) {
  return account.store.get('product', price?.product)?.name ?? null;
}

/** A stored Checkout line item (`mint: false` leaves the ID null, for checks that change nothing). */
function buildItem(account, { price, quantity, adjustable, metadata }, { mint = true } = {}) {
  const amount = isMetered(price) ? 0 : priceAmount(price, quantity);
  return {
    id: mint ? account.mintId('li') : null,
    object: 'item',
    adjustable_quantity: adjustable ? { ...adjustable } : null,
    amount_discount: 0,
    amount_subtotal: amount,
    amount_tax: 0,
    amount_total: amount,
    currency: price.currency,
    description: productName(account, price),
    metadata: metadata ? { ...metadata } : null,
    price: price.id,
    quantity,
  };
}

// Amounts ------------------------------------------------------------------------------------

/** True when the session starts the subscription with a trial. */
export function hasTrial(session) {
  const sd = session._subscription_data ?? {};
  return Boolean(sd.trial_period_days || sd.trial_end);
}

/** The first-period amount of a recurring item billed now and cycling on `anchor`. */
function proratedToAnchor(price, amount, anchor, now) {
  const { interval, interval_count: count = 1 } = price.recurring;
  const previous = addIntervals(anchor, interval, count, -1);
  const factor = Math.max(0, Math.min(1, (anchor - now) / (anchor - previous)));
  return roundAmount(amount * factor);
}

/**
 * Amount due today for `items` (stored line items): one-time items, plus recurring items unless a
 * trial or a future billing cycle anchor defers them (prorated to the anchor unless
 * proration_behavior is none). Metered items are billed in arrears.
 */
export function amountDueToday(account, session, items = session._line_items) {
  const sd = session._subscription_data ?? {};
  const trial = hasTrial(session);
  const now = sessionNow(account, session.customer);
  let total = 0;
  for (const item of items) {
    const price = account.store.get('price', item.price);
    if (!isRecurring(price)) {
      total += item.amount_total;
      continue;
    }
    if (trial || isMetered(price)) continue;
    if (sd.billing_cycle_anchor) {
      if (sd.proration_behavior !== 'none') total += proratedToAnchor(price, item.amount_total, sd.billing_cycle_anchor, now);
      continue;
    }
    total += item.amount_total;
  }
  return total;
}

/** Payment is deferred to the billing cycle anchor (no proration): payment_status no_payment_required. */
function deferredToAnchor(session) {
  const sd = session._subscription_data ?? {};
  return Boolean(sd.billing_cycle_anchor && sd.proration_behavior === 'none' && !hasTrial(session));
}

// Create -------------------------------------------------------------------------------------

function checkSubscriptionData(sd, { now, entries, billingModeType }) {
  if (!sd) return;
  const p = (k) => `subscription_data[${k}]`;
  if (sd.trial_period_days !== undefined && sd.trial_end !== undefined) {
    throw parametersExclusive([p('trial_end'), p('trial_period_days')]);
  }
  if (sd.trial_period_days !== undefined && (sd.trial_period_days < 1 || sd.trial_period_days > MAX_TRIAL_DAYS)) {
    throw invalidParam(p('trial_period_days'), `The trial period must be between 1 and ${MAX_TRIAL_DAYS} days.`);
  }
  if (sd.trial_end !== undefined) {
    if (sd.trial_end < now + MIN_TRIAL_END_SECONDS) throw invalidParam(p('trial_end'), 'subscription_data[trial_end] must be at least 48 hours in the future.');
    if (sd.trial_end > now + MAX_TRIAL_DAYS * 86400) throw invalidParam(p('trial_end'), `The trial period must be ${MAX_TRIAL_DAYS} days or less.`);
  }
  if (sd.billing_cycle_anchor_config !== undefined) {
    if (sd.billing_cycle_anchor !== undefined) throw parametersExclusive([p('billing_cycle_anchor'), p('billing_cycle_anchor_config')]);
    if (sd.trial_period_days !== undefined || sd.trial_end !== undefined) {
      throw parametersExclusive([p(sd.trial_end !== undefined ? 'trial_end' : 'trial_period_days'), p('billing_cycle_anchor_config')]);
    }
    const c = sd.billing_cycle_anchor_config;
    const ranges = { day_of_month: [1, 31], month: [1, 12], hour: [0, 23], minute: [0, 59], second: [0, 59] };
    for (const [key, [lo, hi]] of Object.entries(ranges)) {
      if (c[key] !== undefined && (c[key] < lo || c[key] > hi)) throw invalidParam(`${p('billing_cycle_anchor_config')}[${key}]`, `${key} must be between ${lo} and ${hi}.`);
    }
  }
  if (sd.billing_cycle_anchor !== undefined) {
    const recurring = entries.find((e) => isRecurring(e.price)).price.recurring;
    const limit = addIntervals(now, recurring.interval, recurring.interval_count ?? 1, 1);
    if (sd.billing_cycle_anchor <= now) throw invalidParam(p('billing_cycle_anchor'), 'subscription_data[billing_cycle_anchor] must be in the future.');
    if (sd.billing_cycle_anchor > limit) throw invalidParam(p('billing_cycle_anchor'), 'subscription_data[billing_cycle_anchor] cannot be later than one billing period from now.');
  }
  checkTaxRates(sd.default_tax_rates, p('default_tax_rates'));
  for (const key of ['on_behalf_of', 'transfer_data', 'application_fee_percent']) if (sd[key] !== undefined) throw connectNotSupported(p(key));
  if (sd.invoice_settings?.issuer?.type === 'account') throw connectNotSupported(`${p('invoice_settings')}[issuer][account]`);
  if (sd.pending_invoice_item_interval !== undefined) throw notSupported(p('pending_invoice_item_interval'), 'pending_invoice_item_interval');
  if (billingModeType === 'flexible' && entries.filter((e) => isRecurring(e.price)).length > 100) {
    throw invalidParam('line_items', 'A subscription supports up to 100 items.');
  }
}

function checkCustomFields(fields) {
  if (!fields) return;
  if (fields.length > 3) throw invalidParam('custom_fields', 'You can specify up to 3 custom fields.');
  const keys = new Set();
  fields.forEach((f, i) => {
    const param = `custom_fields[${i}]`;
    if (!/^[A-Za-z0-9]+$/.test(f.key)) throw invalidParam(`${param}[key]`, 'Custom field keys must be alphanumeric.');
    if (keys.has(f.key)) throw invalidParam(`${param}[key]`, `Custom field keys must be unique; ${f.key} is used twice.`);
    keys.add(f.key);
    for (const kind of ['dropdown', 'numeric', 'text']) {
      if (f[kind] !== undefined && f.type !== kind) throw invalidParam(`${param}[${kind}]`, `${kind} can only be set when type is ${kind}.`);
    }
    if (f.type === 'dropdown') {
      if (!f.dropdown) throw parameterMissing(`${param}[dropdown]`);
      const values = f.dropdown.options.map((o) => o.value);
      if (values.length > 200) throw invalidParam(`${param}[dropdown][options]`, 'A dropdown can have up to 200 options.');
      if (new Set(values).size !== values.length) throw invalidParam(`${param}[dropdown][options]`, 'Dropdown option values must be unique.');
      if (f.dropdown.default_value !== undefined && !values.includes(f.dropdown.default_value)) {
        throw invalidParam(`${param}[dropdown][default_value]`, 'default_value must match the value of one of the options.');
      }
    }
  });
}

/** The response shape of a custom_fields entry (values filled in at completion). */
function customFieldShape(f) {
  const out = { key: f.key, label: { custom: f.label.custom, type: f.label.type }, optional: f.optional ?? false, type: f.type };
  if (f.type === 'dropdown') {
    out.dropdown = { default_value: f.dropdown.default_value ?? null, options: f.dropdown.options.map((o) => ({ label: o.label, value: o.value })), value: null };
  } else {
    const cfg = f[f.type] ?? {};
    out[f.type] = { default_value: cfg.default_value ?? null, maximum_length: cfg.maximum_length ?? null, minimum_length: cfg.minimum_length ?? null, value: null };
  }
  return out;
}

function checkUiMode(params, uiMode) {
  const embedded = uiMode === 'embedded_page' || uiMode === 'form';
  if (uiMode === 'hosted_page') {
    if (params.success_url === undefined) throw parameterMissing('success_url');
    if (params.permissions !== undefined) throw invalidParam('permissions', 'permissions can only be set when ui_mode is embedded_page or elements.');
  } else {
    for (const key of ['success_url', 'cancel_url']) {
      if (params[key] !== undefined) throw invalidParam(key, `${key} is not allowed when ui_mode is ${uiMode}; use return_url instead.`);
    }
  }
  if (params.redirect_on_completion !== undefined && !embedded) {
    throw invalidParam('redirect_on_completion', 'redirect_on_completion only applies when ui_mode is embedded_page.');
  }
  // Absolute http(s) URLs only; the {CHECKOUT_SESSION_ID} placeholder parses as part of the URL.
  for (const key of ['success_url', 'cancel_url', 'return_url']) checkUrl(params[key], key);
  // Embedded sessions redirect to return_url after completion by default (redirect_on_completion=always).
  if (embedded && params.return_url === undefined && (params.redirect_on_completion ?? 'always') === 'always') throw parameterMissing('return_url');
  if (uiMode === 'elements') {
    for (const key of ['after_expiration', 'branding_settings', 'custom_fields', 'custom_text', 'origin_context', 'submit_type']) {
      if (params[key] !== undefined) throw invalidParam(key, `${key} cannot be set when ui_mode is elements.`);
    }
  }
}

/** The request checks that do not depend on line items. */
function checkTopLevel(account, params) {
  if (params.mode !== 'subscription') {
    throw invalidParam('mode', `This test server supports Checkout Sessions in subscription mode only (mode=${params.mode} is not supported).`);
  }
  if (params.line_items === undefined) throw parameterMissing('line_items');
  if (params.customer_account !== undefined) throw notSupported('customer_account', 'customer_account (Accounts v2)');
  if (params.customer !== undefined && params.customer_email !== undefined) {
    throw parametersExclusive(['customer', 'customer_email'], { param: 'customer_email' });
  }
  if (params.customer_creation !== undefined) throw invalidParam('customer_creation', 'customer_creation can only be set in payment and setup mode.');
  if (params.customer_update !== undefined && params.customer === undefined) {
    throw invalidParam('customer_update', 'customer_update can only be used together with customer.');
  }
  for (const [key, mode] of [['payment_intent_data', 'payment'], ['invoice_creation', 'payment'], ['setup_intent_data', 'setup']]) {
    if (params[key] !== undefined) throw invalidParam(key, `${key} can only be used in ${mode} mode.`);
  }
  if (params.payment_method_types !== undefined && !params.payment_method_types.includes('card')) {
    throw notSupported('payment_method_types', 'A Checkout Session without card payments');
  }
  if (params.excluded_payment_method_types?.includes('card')) throw notSupported('excluded_payment_method_types', 'Excluding card payments');
  if (params.payment_method_configuration !== undefined) {
    throw resourceMissing('payment_method_configuration', params.payment_method_configuration, { param: 'payment_method_configuration' });
  }
  if (params.allow_promotion_codes !== undefined && params.discounts !== undefined) {
    throw parametersExclusive(['allow_promotion_codes', 'discounts'], { param: 'discounts' });
  }
  if (params.discounts) {
    if (params.discounts.length > 1) throw invalidParam('discounts', 'You may only specify one discount.');
    const d = params.discounts[0] ?? {};
    if (d.coupon !== undefined && d.promotion_code !== undefined) throw parametersExclusive(['discounts[0][coupon]', 'discounts[0][promotion_code]']);
    if (d.coupon !== undefined) throw resourceMissing('coupon', d.coupon, { param: 'discounts[0][coupon]' });
    if (d.promotion_code !== undefined) throw resourceMissing('promotion_code', d.promotion_code, { param: 'discounts[0][promotion_code]' });
  }
  (params.shipping_options ?? []).forEach((o, i) => {
    if (o.shipping_rate !== undefined) throw resourceMissing('shipping_rate', o.shipping_rate, { param: `shipping_options[${i}][shipping_rate]` });
    if (o.shipping_rate_data !== undefined) throw notSupported(`shipping_options[${i}][shipping_rate_data]`, 'Shipping rates');
  });
  if (params.automatic_tax?.liability?.type === 'account') throw connectNotSupported('automatic_tax[liability][account]');
  checkCustomFields(params.custom_fields);
}

/** The session shape of the optional hashes that are echoed as sent (null when absent). */
function echoed(params) {
  const recovery = params.after_expiration?.recovery;
  const consent = params.consent_collection;
  return {
    adaptive_pricing: params.adaptive_pricing ? { enabled: params.adaptive_pricing.enabled ?? false } : null,
    after_expiration: recovery
      ? { recovery: { allow_promotion_codes: recovery.allow_promotion_codes ?? false, enabled: recovery.enabled, expires_at: null, url: null } }
      : null,
    consent_collection: consent
      ? {
          payment_method_reuse_agreement: consent.payment_method_reuse_agreement ? { position: consent.payment_method_reuse_agreement.position } : null,
          promotions: consent.promotions ?? null,
          terms_of_service: consent.terms_of_service ?? null,
        }
      : null,
    custom_text: {
      after_submit: params.custom_text?.after_submit ? { message: params.custom_text.after_submit.message } : null,
      shipping_address: params.custom_text?.shipping_address ? { message: params.custom_text.shipping_address.message } : null,
      submit: params.custom_text?.submit ? { message: params.custom_text.submit.message } : null,
      terms_of_service_acceptance: params.custom_text?.terms_of_service_acceptance ? { message: params.custom_text.terms_of_service_acceptance.message } : null,
    },
    saved_payment_method_options: params.saved_payment_method_options
      ? {
          allow_redisplay_filters: params.saved_payment_method_options.allow_redisplay_filters ?? null,
          payment_method_remove: params.saved_payment_method_options.payment_method_remove ?? null,
          payment_method_save: params.saved_payment_method_options.payment_method_save ?? null,
        }
      : null,
    shipping_address_collection: params.shipping_address_collection ? { allowed_countries: [...params.shipping_address_collection.allowed_countries] } : null,
    wallet_options: params.wallet_options ? (params.wallet_options.link ? { link: { display: params.wallet_options.link.display ?? 'auto' } } : {}) : null,
  };
}

/**
 * Creates a Checkout Session from validated POST /v1/checkout/sessions params (subscription mode).
 * Nothing is charged or created for the customer until the hosted page completes it.
 * @param {{version: string, server: object}} opts version of the creating request
 * @returns {object} the internal session
 */
export function createSession(account, params, { version, server }) {
  checkTopLevel(account, params);
  const uiMode = normalizeUiMode(params.ui_mode ?? 'hosted_page');
  checkUiMode(params, uiMode);
  const customer = params.customer !== undefined ? requireCustomer(account, params.customer, { param: 'customer' }) : null;
  const now = sessionNow(account, customer?.id);
  const { entries, optional, currency } = readItems(account, params, version);
  const sd = params.subscription_data;
  const billingModeType = sd?.billing_mode?.type ?? (atLeast(version, '2025-09-30.clover') ? 'flexible' : 'classic');
  checkIntervals(entries, billingModeType);
  checkSubscriptionData(sd, { now, entries, billingModeType });
  if (params.expires_at !== undefined && (params.expires_at < now + MIN_EXPIRY_SECONDS || params.expires_at > now + MAX_EXPIRY_SECONDS)) {
    throw invalidParam('expires_at', 'The expires_at timestamp must be between 30 minutes and 24 hours after the Checkout Session is created.');
  }

  // Everything is valid: create inline prices, then the session.
  const lineItems = entries.map((e) => buildItem(account, { ...e, price: e.inline ? createInlinePrice(account, e.inline, version) : e.price }));
  const id = account.mintId('cs_test');
  const methodTypes = params.payment_method_types ? [...params.payment_method_types] : ['card'];
  const echo = echoed(params);
  const session = {
    id,
    object: 'checkout.session',
    adaptive_pricing: echo.adaptive_pricing,
    after_expiration: echo.after_expiration,
    allow_promotion_codes: params.allow_promotion_codes ?? null,
    amount_subtotal: 0,
    amount_total: 0,
    automatic_tax: params.automatic_tax?.enabled
      ? { enabled: true, liability: { type: 'self' }, provider: 'stripe', status: 'complete' }
      : { enabled: false, liability: null, provider: null, status: null },
    billing_address_collection: params.billing_address_collection ?? null,
    cancel_url: params.cancel_url ?? null,
    client_reference_id: params.client_reference_id ?? null,
    client_secret: uiMode === 'hosted_page' ? null : `${id}_secret_${account.mintId('sec').slice(4)}`,
    collected_information: null,
    consent: null,
    consent_collection: echo.consent_collection,
    created: now,
    currency,
    currency_conversion: null,
    custom_fields: (params.custom_fields ?? []).map(customFieldShape),
    custom_text: echo.custom_text,
    customer: customer?.id ?? null,
    customer_account: null,
    customer_creation: 'always',
    customer_details: null,
    customer_email: params.customer_email ?? null,
    discounts: [],
    expires_at: params.expires_at ?? now + MAX_EXPIRY_SECONDS,
    integration_identifier: params.integration_identifier ?? null,
    invoice: null,
    invoice_creation: null,
    livemode: false,
    locale: params.locale ?? null,
    managed_payments: params.managed_payments ? { enabled: params.managed_payments.enabled ?? false } : null,
    metadata: applyMetadata({}, params.metadata),
    mode: 'subscription',
    origin_context: params.origin_context ?? null,
    payment_intent: null,
    payment_link: null,
    payment_method_collection: params.payment_method_collection ?? 'always',
    payment_method_configuration_details: null,
    payment_method_options: methodTypes.includes('card')
      ? { card: { request_three_d_secure: 'automatic', ...clone(params.payment_method_options?.card ?? {}) } }
      : {},
    payment_method_types: methodTypes,
    payment_status: 'unpaid',
    permissions: params.permissions ? { update_shipping_details: params.permissions.update_shipping_details ?? null } : null,
    phone_number_collection: { enabled: params.phone_number_collection?.enabled ?? false },
    recovered_from: null,
    saved_payment_method_options: echo.saved_payment_method_options,
    setup_intent: null,
    shipping_address_collection: echo.shipping_address_collection,
    shipping_cost: null,
    shipping_options: [],
    status: 'open',
    submit_type: params.submit_type ?? null,
    subscription: null,
    success_url: params.success_url ?? null,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    ui_mode: uiMode,
    url: uiMode === 'hosted_page' ? `${server.url}/c/pay/${id}` : null,
    wallet_options: echo.wallet_options,
    _version: version,
    _line_items: lineItems,
    _optional_items: optional.map((o) => ({ adjustable_quantity: o.adjustable ? { ...o.adjustable } : null, price: o.price.id, quantity: o.quantity })),
    _subscription_data: clone(sd) ?? {},
    _customer_update: clone(params.customer_update) ?? null,
    _name_collection: clone(params.name_collection) ?? null,
    _tax_id_collection: clone(params.tax_id_collection) ?? null,
    _excluded_payment_method_types: params.excluded_payment_method_types ? [...params.excluded_payment_method_types] : null,
    _redirect_on_completion: uiMode === 'embedded_page' ? params.redirect_on_completion ?? 'always' : params.redirect_on_completion ?? null,
    _return_url: params.return_url ?? null,
    _attempt: null,
  };
  const due = amountDueToday(account, session, lineItems);
  session.amount_subtotal = due;
  session.amount_total = due;
  if (deferredToAnchor(session)) session.payment_status = 'no_payment_required';
  account.store.insert(session);
  account.time.schedule({
    kind: 'checkout.session.expire',
    at: session.expires_at,
    domain: account.time.domainOf(session),
    key: `${id}:expire`,
    data: { session: id },
    priority: JOB_PRIORITY.checkoutExpire,
  });
  return session;
}

// Expire and update --------------------------------------------------------------------------

/** Expires an open session (API expire or expires_at reached); emits checkout.session.expired. */
export function expireSession(account, session, { request } = {}) {
  if (session.status !== 'open') {
    throw invalidRequest(`This Checkout Session is ${session.status} and can no longer be expired; only open sessions can be expired.`);
  }
  session.status = 'expired';
  session.url = null;
  account.time.cancel(`${session.id}:expire`);
  emitEvent(account, 'checkout.session.expired', session, { request });
  return session;
}

/** POST /v1/checkout/sessions/:id: metadata; the dynamic-update parameters are not modelled. */
function updateSession(account, session, params) {
  for (const key of ['line_items', 'shipping_options', 'collected_information']) {
    if (params[key] !== undefined) throw notSupported(key, `Updating ${key} on a Checkout Session`);
  }
  session.metadata = applyMetadata(session.metadata, params.metadata);
  return session;
}

// Completion ---------------------------------------------------------------------------------

/**
 * The line items the customer checks out with: `quantities` ({li_id: n}) adjusts items whose
 * quantity is adjustable (0 drops the item), `optionalItems` ({index: n}) adds optional items.
 * Changes nothing on the session; added items get IDs unless `mint` is false.
 */
export function finalLineItems(account, session, { quantities = {}, optionalItems = {}, mint = true } = {}) {
  const items = [];
  for (const item of session._line_items) {
    const price = account.store.get('price', item.price);
    let quantity = item.quantity;
    const wanted = quantities[item.id];
    if (wanted !== undefined && wanted !== null && wanted !== item.quantity) {
      const adj = item.adjustable_quantity;
      if (!adj?.enabled) throw invalidRequest(`The quantity of ${item.description ?? item.id} cannot be changed.`, { param: 'quantity' });
      if (!Number.isInteger(wanted) || wanted < adj.minimum || wanted > adj.maximum) {
        throw invalidRequest(`The quantity of ${item.description ?? item.id} must be between ${adj.minimum} and ${adj.maximum}.`, { param: 'quantity' });
      }
      quantity = wanted;
    }
    if (quantity === 0) continue;
    const amount = isMetered(price) ? 0 : priceAmount(price, quantity);
    items.push({ ...structuredClone(item), quantity, amount_subtotal: amount, amount_total: amount });
  }
  const added = [];
  for (const [index, wanted] of Object.entries(optionalItems)) {
    const opt = session._optional_items[Number(index)];
    if (!opt || !wanted) continue;
    const price = account.store.get('price', opt.price);
    const adj = opt.adjustable_quantity;
    const min = adj?.enabled ? Math.max(1, adj.minimum) : opt.quantity;
    const max = adj?.enabled ? adj.maximum : opt.quantity;
    if (!Number.isInteger(wanted) || wanted < min || wanted > max) {
      throw invalidRequest(`The quantity of the optional item ${productName(account, price) ?? opt.price} must be between ${min} and ${max}.`, { param: 'quantity' });
    }
    added.push({ price, quantity: wanted, adjustable: adj, metadata: null });
  }
  if (!items.some((i) => isRecurring(account.store.get('price', i.price)))) {
    throw invalidRequest('At least one recurring item is required to start a subscription.', { param: 'quantity' });
  }
  return [...items, ...added.map((a) => buildItem(account, a, { mint }))];
}

function isF1(session) {
  return familyOf(session._version) === 'F1';
}

/** The error of attaching a test card that simulates an issuer decline ("You can't attach cards that simulate issuer declines"). */
function attachDecline(card) {
  return cardDeclineError({ code: card.code ?? 'card_declined', declineCode: card.declineCode });
}

/** The PaymentIntent that paid `invoice`, from its InvoicePayment (or the invoice's own field). */
function paymentIntentOf(account, invoice) {
  if (!invoice) return null;
  const payment = account.store.list('invoice_payment', (p) => p.invoice === invoice.id && p.status === 'paid')[0];
  if (payment?.payment?.payment_intent) return payment.payment.payment_intent;
  if (typeof invoice.payment_intent === 'string') return invoice.payment_intent;
  if (typeof invoice._payment_intent === 'string') return invoice._payment_intent;
  return null;
}

/** The incomplete subscription left by an earlier declined 2024-06-20 attempt, if it is still payable. */
function pendingAttempt(account, session) {
  const a = session._attempt;
  if (!a?.subscription) return null;
  const subscription = account.store.get('subscription', a.subscription);
  const invoice = a.invoice ? account.store.get('invoice', a.invoice) : null;
  if (!subscription || subscription.status !== 'incomplete' || !invoice || invoice.status !== 'open') return null;
  return { subscription, invoice };
}

/** Sets a subscription's default_payment_method through the billing engine. */
function setSubscriptionPaymentMethod(account, subscription, paymentMethodId) {
  if (subscription.default_payment_method === paymentMethodId) return;
  billing.updateSubscription(account, subscription, { defaultPaymentMethod: paymentMethodId }, { source: 'api', request: null });
}

function subscriptionSpec(account, session, customer, items, paymentMethod) {
  const sd = session._subscription_data ?? {};
  const recurring = [];
  const oneTime = [];
  for (const item of items) {
    const price = account.store.get('price', item.price);
    const entry = { price };
    if (item.quantity !== null && item.quantity !== undefined) entry.quantity = item.quantity;
    (isRecurring(price) ? recurring : oneTime).push(entry);
  }
  const spec = {
    customer,
    items: recurring,
    addInvoiceItems: oneTime,
    metadata: { ...(sd.metadata ?? {}) },
    description: sd.description ?? null,
    defaultPaymentMethod: paymentMethod ? paymentMethod.id : null,
    collectionMethod: 'charge_automatically',
    paymentBehavior: isF1(session) ? 'allow_incomplete' : 'error_if_incomplete',
  };
  if (sd.trial_end !== undefined) spec.trialEnd = sd.trial_end;
  if (sd.trial_period_days !== undefined) spec.trialPeriodDays = sd.trial_period_days;
  if (sd.trial_settings) spec.trialSettings = { endBehavior: { missingPaymentMethod: sd.trial_settings.end_behavior.missing_payment_method } };
  if (sd.billing_cycle_anchor !== undefined) spec.billingCycleAnchor = sd.billing_cycle_anchor;
  if (sd.billing_cycle_anchor_config !== undefined) spec.billingCycleAnchorConfig = { ...sd.billing_cycle_anchor_config };
  if (sd.billing_mode) spec.billingMode = sd.billing_mode.type;
  if (sd.proration_behavior !== undefined) spec.prorationBehavior = sd.proration_behavior;
  return spec;
}

/**
 * What the first invoice will charge: the amount due today less the customer's credit balance;
 * amounts below the currency's minimum charge are not charged (docs.stripe.com/currencies).
 */
function chargeableToday(due, customer, currency) {
  const charge = Math.max(0, due + (customer?.balance ?? 0));
  return charge > 0 && charge < minimumCharge(currency) ? 0 : charge;
}

/** An address from the page as request params (empty fields left out). */
function addressParams(address) {
  const out = {};
  for (const [key, value] of Object.entries(address ?? {})) if (value) out[key] = value;
  return out;
}

/** The customer fields collected on the page, validated like POST /v1/customers(/:id) params. */
function customerParams(session, details, opts, { existing }) {
  const params = {};
  const cu = session._customer_update ?? {};
  const set = (key, allowed) => allowed && details[key] && (params[key] = details[key]);
  set('email', !existing || !existing.email);
  set('name', !existing || cu.name === 'auto');
  set('phone', !existing);
  if (details.address && (!existing || cu.address === 'auto')) params.address = addressParams(details.address);
  if (details.shipping && (!existing || cu.shipping === 'auto')) {
    params.shipping = { name: details.shipping.name, address: addressParams(details.shipping.address) };
  }
  if (!existing && atLeast(session._version, '2025-09-30.clover')) {
    if (opts.businessName) params.business_name = opts.businessName;
    if (opts.individualName) params.individual_name = opts.individualName;
  }
  return validateParams(existing ? 'POST /v1/customers/{customer}' : 'POST /v1/customers', params, session._version);
}

/**
 * Completes an open session with a PaymentMethod created from the hosted page's card
 * (docs.stripe.com/payments/checkout/how-checkout-works): creates the customer if needed, attaches
 * the card, creates the subscription through billing.createSubscription(…, {source: 'checkout'}),
 * marks the session complete and emits checkout.session.completed.
 *
 * On 2025-03-31.basil and later a decline creates nothing and leaves the session open. Sessions
 * created on 2024-06-20-family versions create an incomplete subscription on a decline; a later
 * card on the same session pays its open invoice.
 *
 * @param {object} opts
 * @param {object|null} opts.paymentMethod unattached PaymentMethod (null: nothing is collected)
 * @param {object|null} [opts.card] the TEST_CARDS entry behind paymentMethod
 * @param {string} [opts.email] @param {string} [opts.name] @param {string} [opts.phone]
 * @param {object} [opts.address] billing address @param {object} [opts.shipping] {name, address}
 * @param {string} [opts.businessName] @param {string} [opts.individualName]
 * @param {object} [opts.customFields] {key: value} @param {object} [opts.consent] {promotions, terms_of_service}
 * @param {object} [opts.quantities] {li_id: quantity} @param {object} [opts.optionalItems] {index: quantity}
 * @throws StripeError 402 card_error on a decline
 * @returns {object} the internal session (status 'complete')
 */
export function completeSession(account, session, opts = {}) {
  const { paymentMethod = null } = opts;
  const card = opts.card ?? (paymentMethod ? testCardOf(paymentMethod) : null);
  if (session.status !== 'open') throw invalidRequest(`This Checkout Session is ${session.status}.`);
  const items = finalLineItems(account, session, opts);
  const due = amountDueToday(account, session, items);
  const currency = session.currency;
  if (!paymentMethod && (due > 0 || session.payment_method_collection !== 'if_required')) {
    throw invalidRequest('A payment method is required to complete this Checkout Session.', { param: 'payment_method' });
  }
  if (paymentMethod && card && card.attachable === false) throw attachDecline(card);
  const existing = session.customer ? requireCustomer(account, session.customer) : null;
  const f1 = isF1(session);
  const details = {
    email: opts.email || existing?.email || session.customer_email || null,
    name: opts.individualName || opts.name || null,
    phone: opts.phone || null,
    address: opts.address ? normalizeAddress(opts.address) : null,
    shipping: opts.shipping ? { name: opts.shipping.name, address: normalizeAddress(opts.shipping.address) } : null,
  };
  let customer = existing;
  if (!customer && session._attempt?.customer) {
    // A customer created by an earlier attempt on this session is used again.
    const earlier = account.store.get('customer', session._attempt.customer);
    if (earlier && !earlier._deleted) customer = earlier;
  }
  const params = customer === existing ? customerParams(session, details, opts, { existing }) : null;
  const charge = chargeableToday(due, customer, currency);
  if (!f1 && charge > 0) {
    const failure = predictChargeFailure(account, { paymentMethod: paymentMethod.id, customer: customer?.id ?? null, amount: charge, currency, consume: true });
    if (failure) throw cardDeclineError(failure);
  }

  if (!customer) {
    customer = createCustomer(account, params, { request: null });
    if (!existing) session._attempt = { customer: customer.id, subscription: null, invoice: null };
  } else if (params && Object.keys(params).length) updateCustomer(account, customer, params, { request: null });
  if (paymentMethod) attachPaymentMethod(account, paymentMethod.id, customer, { param: 'payment_method', request: null });

  let subscription;
  let invoice;
  const pending = f1 ? pendingAttempt(account, session) : null;
  if (pending) {
    const paid = billing.payInvoice(account, pending.invoice, { paymentMethod: paymentMethod.id, offSession: false, source: 'checkout', request: null });
    if (!paid.ok) throw paid.error;
    subscription = account.store.get('subscription', pending.subscription.id);
    invoice = paid.invoice;
    setSubscriptionPaymentMethod(account, subscription, paymentMethod.id);
  } else {
    const result = billing.createSubscription(account, subscriptionSpec(account, session, customer, items, paymentMethod), {
      source: 'checkout',
      version: session._version,
      request: null,
    });
    if (result.paymentError) {
      session._attempt = { customer: customer.id, subscription: result.subscription.id, invoice: result.invoice?.id ?? null };
      throw result.paymentError;
    }
    subscription = result.subscription;
    invoice = result.invoice;
  }
  invoice ??= subscription.latest_invoice ? account.store.get('invoice', subscription.latest_invoice) : null;

  const deferred = deferredToAnchor(session);
  session.status = 'complete';
  session.payment_status = deferred ? 'no_payment_required' : 'paid';
  session.customer = customer.id;
  session.customer_details = {
    address: details.address,
    business_name: opts.businessName || null,
    email: customer.email ?? details.email,
    individual_name: opts.individualName || null,
    name: details.name ?? customer.name ?? null,
    phone: details.phone ?? customer.phone ?? null,
    tax_exempt: customer.tax_exempt ?? 'none',
    tax_ids: [],
  };
  if (session._name_collection || details.shipping) {
    session.collected_information = {
      business_name: opts.businessName || null,
      individual_name: opts.individualName || null,
      shipping_details: details.shipping ? { address: details.shipping.address, name: details.shipping.name } : null,
    };
  }
  if (session.consent_collection) {
    session.consent = {
      promotions: session.consent_collection.promotions === 'auto' ? (opts.consent?.promotions ? 'opt_in' : 'opt_out') : null,
      terms_of_service: session.consent_collection.terms_of_service === 'required' ? 'accepted' : null,
    };
  }
  for (const field of session.custom_fields) {
    const value = opts.customFields?.[field.key];
    if (value !== undefined && value !== '') field[field.type].value = String(value);
  }
  session.subscription = subscription.id;
  session.invoice = invoice?.id ?? null;
  session.payment_intent = f1 ? null : paymentIntentOf(account, invoice);
  session._line_items = items;
  session.amount_subtotal = due;
  session.amount_total = due;
  session.url = null;
  account.time.cancel(`${session.id}:expire`);
  emitEvent(account, 'checkout.session.completed', session, { request: null });
  return session;
}

// Rendering ----------------------------------------------------------------------------------

function renderUiMode(value, ctx) {
  if (ctx.atLeast('2026-03-25.dahlia')) return value;
  return UI_MODE_LEGACY[value] ?? value;
}

function renderCustomerDetails(d, ctx) {
  if (!d) return null;
  const out = { address: clone(d.address) };
  if (ctx.family !== 'F1') out.business_name = d.business_name;
  out.email = d.email;
  if (ctx.family !== 'F1') out.individual_name = d.individual_name;
  Object.assign(out, { name: d.name, phone: d.phone, tax_exempt: d.tax_exempt, tax_ids: clone(d.tax_ids) });
  return out;
}

/** The wire form of a Checkout Session (field order of the API reference example). */
export function renderSession(s, ctx) {
  const f1 = ctx.family === 'F1';
  const out = { id: s.id, object: 'checkout.session' };
  if (!f1) out.adaptive_pricing = clone(s.adaptive_pricing);
  out.after_expiration = clone(s.after_expiration);
  out.allow_promotion_codes = s.allow_promotion_codes;
  out.amount_subtotal = s.amount_subtotal;
  out.amount_total = s.amount_total;
  out.automatic_tax = f1
    ? { enabled: s.automatic_tax.enabled, liability: clone(s.automatic_tax.liability), status: s.automatic_tax.status }
    : clone(s.automatic_tax);
  out.billing_address_collection = s.billing_address_collection;
  out.cancel_url = s.cancel_url;
  out.client_reference_id = s.client_reference_id;
  out.client_secret = s.client_secret;
  if (!f1) out.collected_information = clone(s.collected_information);
  out.consent = clone(s.consent);
  out.consent_collection = clone(s.consent_collection);
  out.created = s.created;
  out.currency = s.currency;
  out.currency_conversion = null;
  out.custom_fields = clone(s.custom_fields);
  out.custom_text = clone(s.custom_text);
  out.customer = s.customer;
  if (ctx.atLeast('2025-12-15.clover')) out.customer_account = null;
  out.customer_creation = s.customer_creation;
  out.customer_details = renderCustomerDetails(s.customer_details, ctx);
  out.customer_email = s.customer_email;
  if (!f1) out.discounts = clone(s.discounts);
  if (!f1 && s._excluded_payment_method_types) out.excluded_payment_method_types = [...s._excluded_payment_method_types];
  out.expires_at = s.expires_at;
  if (!f1) out.integration_identifier = s.integration_identifier;
  out.invoice = s.invoice;
  out.invoice_creation = null;
  out.livemode = false;
  out.locale = s.locale;
  if (!f1) out.managed_payments = clone(s.managed_payments);
  out.metadata = { ...s.metadata };
  out.mode = s.mode;
  if (!f1 && s._name_collection) {
    out.name_collection = {};
    for (const kind of ['business', 'individual']) {
      if (s._name_collection[kind]) out.name_collection[kind] = { enabled: s._name_collection[kind].enabled, optional: s._name_collection[kind].optional ?? false };
    }
  }
  if (!f1) out.origin_context = s.origin_context;
  out.payment_intent = s.payment_intent;
  out.payment_link = null;
  out.payment_method_collection = s.payment_method_collection;
  out.payment_method_configuration_details = null;
  out.payment_method_options = clone(s.payment_method_options);
  out.payment_method_types = [...s.payment_method_types];
  out.payment_status = s.payment_status;
  if (!f1) out.permissions = clone(s.permissions);
  out.phone_number_collection = { ...s.phone_number_collection };
  out.recovered_from = null;
  if (s._redirect_on_completion) out.redirect_on_completion = s._redirect_on_completion;
  if (s._return_url) out.return_url = s._return_url;
  out.saved_payment_method_options = clone(s.saved_payment_method_options);
  out.setup_intent = null;
  out.shipping_address_collection = clone(s.shipping_address_collection);
  out.shipping_cost = null;
  if (f1) {
    const sh = s.collected_information?.shipping_details;
    out.shipping_details = sh ? { address: clone(sh.address), carrier: null, name: sh.name, phone: null, tracking_number: null } : null;
  }
  out.shipping_options = [];
  out.status = s.status;
  out.submit_type = s.submit_type;
  out.subscription = s.subscription;
  out.success_url = s.success_url;
  if (s._tax_id_collection) out.tax_id_collection = { enabled: s._tax_id_collection.enabled, required: s._tax_id_collection.required ?? 'never' };
  out.total_details = { ...s.total_details };
  out.ui_mode = renderUiMode(s.ui_mode, ctx);
  out.url = s.url;
  if (!f1) out.wallet_options = clone(s.wallet_options);
  return out;
}

/** The wire form of a Checkout line item ('item'), with its price embedded. */
export function renderItem(item, ctx) {
  const f1 = ctx.family === 'F1';
  const out = { id: item.id, object: 'item' };
  if (!f1) out.adjustable_quantity = item.adjustable_quantity ? { ...item.adjustable_quantity } : null;
  Object.assign(out, {
    amount_discount: item.amount_discount,
    amount_subtotal: item.amount_subtotal,
    amount_tax: item.amount_tax,
    amount_total: item.amount_total,
    currency: item.currency,
    description: item.description,
  });
  if (!f1) out.metadata = item.metadata ? { ...item.metadata } : null;
  const price = ctx.lookup(item.price);
  out.price = price ? ctx.render(price) : item.price;
  out.quantity = item.quantity;
  return out;
}

function lineItemsList(session, ctx) {
  return {
    object: 'list',
    data: session._line_items.map((i) => ctx.render(i)),
    has_more: false,
    url: `/v1/checkout/sessions/${session.id}/line_items`,
  };
}

// Routes -------------------------------------------------------------------------------------

function listSessions(ctx) {
  const { params, account } = ctx;
  if (params.customer_account !== undefined) throw notSupported('customer_account', 'customer_account (Accounts v2)');
  const sessions = account.store.list('checkout.session', (s) => {
    if (params.customer !== undefined && s.customer !== params.customer) return false;
    if (params.customer_details?.email !== undefined && s.customer_details?.email !== params.customer_details.email) return false;
    if (params.payment_intent !== undefined && s.payment_intent !== params.payment_intent) return false;
    if (params.payment_link !== undefined && s.payment_link !== params.payment_link) return false;
    if (params.status !== undefined && s.status !== params.status) return false;
    if (params.subscription !== undefined && s.subscription !== params.subscription) return false;
    return matchesRange(s.created, params.created);
  });
  return paginate(sessions, params, {
    url: '/v1/checkout/sessions',
    noun: 'checkout.session',
    find: (id) => account.store.get('checkout.session', id),
  });
}

function listLineItems(ctx) {
  const session = ctx.account.store.require('checkout.session', ctx.pathParams.id);
  // In the order given; paginate sorts newest first, so later items get lower sequence numbers.
  const items = session._line_items.map((item, i) => ({ ...item, created: 0, _seq: -i }));
  return paginate(items, ctx.params, { url: `/v1/checkout/sessions/${session.id}/line_items`, noun: 'item' });
}

export function install(app) {
  app.object('checkout.session', {
    render: renderSession,
    expandable: ['customer', 'invoice', 'payment_intent', 'payment_link', 'setup_intent', 'subscription', 'discounts.coupon', 'discounts.promotion_code'],
    includable: {
      line_items: (json, ctx) => {
        const session = ctx.lookup(json.id);
        return session ? lineItemsList(session, ctx) : null;
      },
      optional_items: (json, ctx) => {
        const session = ctx.lookup(json.id);
        if (!session || ctx.family === 'F1' || !session._optional_items.length) return null;
        return session._optional_items.map((o) => ({ adjustable_quantity: o.adjustable_quantity ? { ...o.adjustable_quantity } : null, price: o.price, quantity: o.quantity }));
      },
    },
  });
  app.object('item', { render: renderItem });

  app.job('checkout.session.expire', (account, job) => {
    const session = account.store.get('checkout.session', job.data.session);
    if (session && session.status === 'open') expireSession(account, session, { request: null });
  });

  app.route('POST', '/v1/checkout/sessions', (ctx) => createSession(ctx.account, ctx.params, { version: ctx.version, server: ctx.server }));
  app.route('GET', '/v1/checkout/sessions', listSessions);
  app.route('GET', '/v1/checkout/sessions/:id', (ctx) => ctx.account.store.require('checkout.session', ctx.pathParams.id));
  app.route('POST', '/v1/checkout/sessions/:id', (ctx) =>
    updateSession(ctx.account, ctx.account.store.require('checkout.session', ctx.pathParams.id), ctx.params),
  );
  app.route('POST', '/v1/checkout/sessions/:id/expire', (ctx) =>
    expireSession(ctx.account, ctx.account.store.require('checkout.session', ctx.pathParams.id)),
  );
  app.route('GET', '/v1/checkout/sessions/:id/line_items', listLineItems);
}
