/**
 * Prices (docs.stripe.com/api/prices). There is no delete: prices are archived with active=false.
 *
 * Routes: POST/GET /v1/prices, GET/POST /v1/prices/:id.
 * Internal object: the 2026-08-26.dahlia wire shape with `product` as an ID, plus
 *   tiers, currency_options  includable: rendered only when expanded
 *   _inline                  created from `price_data`: never listed, no price.created event
 *   _aggregateUsage          legacy metered prices (2024-06-20 `recurring.aggregate_usage`)
 * `unit_amount_decimal` is always a decimal string; `recurring.meter` and
 * `recurring.trial_period_days` are always present; 2024-06-20 adds `recurring.aggregate_usage`.
 * Events: price.created, price.updated (previous_attributes; also for the price that loses its
 * lookup key through transfer_lookup_key, emitted first).
 */
import { emitEvent, updateWithEvent } from '../core/events.js';
import { invalidParam, invalidRequest, parameterMissing, parametersExclusive } from '../core/errors.js';
import { paginate, matchesRange } from '../core/list.js';
import { isIntervalWithinLimit } from '../core/periods.js';
import { isSupportedCurrency, minimumCharge } from '../core/currency.js';
import { applyMetadata } from '../core/util.js';
import { atLeast } from '../core/versions.js';
import { createProduct, requireProduct, validateProductParams } from './products.js';
import { canonicalDecimal, decimalToInteger, nestParam } from './shared.js';

/** "You can specify up to 10 lookup_keys" (docs.stripe.com/api/prices/list). */
const MAX_LOOKUP_KEYS = 10;
/** Trial limit: "The trial period must be 730 days (2 years) or less." */
const MAX_TRIAL_PERIOD_DAYS = 730;
/** From this version a metered price needs a meter (docs.stripe.com/changelog/basil/2025-03-31/deprecate-legacy-usage-based-billing). */
const METER_REQUIRED_FROM = '2025-03-31.basil';

/**
 * The live price `id`, or resource_missing (404 for param 'id', else 400 with `param`).
 * With `active: true`, an archived price (or a price of an archived product) is rejected with a
 * 400 on `param`: archiving "prevents a price from being added to new invoices or subscriptions".
 * @returns {object} internal price
 */
export function requirePrice(account, id, { param = 'price', active = false } = {}) {
  const price = account.store.require('price', id, { param });
  if (active) {
    if (!price.active) {
      throw invalidRequest(`The price specified (${price.id}) is inactive. This field only accepts active prices.`, { param });
    }
    const product = account.store.get('product', price.product);
    if (product && !product.active) {
      throw invalidRequest(`The product of the price specified (${product.id}) is inactive. This field only accepts prices of active products.`, {
        param,
      });
    }
  }
  return price;
}

// Validation and normalization ------------------------------------------------------------------

const negativeInteger = (param, value) =>
  invalidRequest(`Invalid integer: ${value}; ${param} must be 0 or greater.`, { param, code: 'parameter_invalid_integer' });

/** An amount given as integer or decimal string → [integer | null, canonical decimal string]. */
function amountPair(sent, intKey, decKey, param) {
  if (sent[intKey] !== undefined && sent[decKey] !== undefined) throw parametersExclusive([param(intKey), param(decKey)]);
  if (sent[intKey] !== undefined) {
    if (sent[intKey] < 0) throw negativeInteger(param(intKey), sent[intKey]);
    return [sent[intKey], String(sent[intKey])];
  }
  if (sent[decKey] !== undefined) {
    const decimal = canonicalDecimal(sent[decKey]);
    if (decimal === null) throw invalidParam(param(decKey), `Invalid decimal: ${sent[decKey]}; ${param(decKey)} must be 0 or greater.`);
    return [decimalToInteger(decimal), decimal];
  }
  return [null, null];
}

function customUnitAmount(sent, { param, currency }) {
  if (sent.enabled !== true) {
    throw invalidParam(param('custom_unit_amount[enabled]'), 'Pass true to enable custom_unit_amount, otherwise omit custom_unit_amount.');
  }
  const out = { maximum: sent.maximum ?? null, minimum: sent.minimum ?? null, preset: sent.preset ?? null };
  for (const key of ['maximum', 'minimum', 'preset']) {
    if (out[key] !== null && out[key] < 0) throw negativeInteger(param(`custom_unit_amount[${key}]`), out[key]);
  }
  if (out.minimum !== null && out.minimum < minimumCharge(currency)) {
    throw invalidParam(param('custom_unit_amount[minimum]'), `The minimum must be at least the minimum charge amount (${minimumCharge(currency)}).`);
  }
  if (out.minimum !== null && out.maximum !== null && out.minimum > out.maximum) {
    throw invalidParam(param('custom_unit_amount[maximum]'), 'The maximum must be greater than or equal to the minimum.');
  }
  if (out.preset !== null && ((out.minimum !== null && out.preset < out.minimum) || (out.maximum !== null && out.preset > out.maximum))) {
    throw invalidParam(param('custom_unit_amount[preset]'), 'The preset must be between the minimum and the maximum.');
  }
  return out;
}

/**
 * The amount of a per-unit price or currency option: "One of unit_amount, unit_amount_decimal,
 * or custom_unit_amount is required", and "Only one of unit_amount and unit_amount_decimal can be set".
 */
function perUnitAmount(sent, { param, currency }) {
  const given = ['unit_amount', 'unit_amount_decimal'].filter((k) => sent[k] !== undefined);
  if (sent.custom_unit_amount !== undefined && given.length) throw parametersExclusive([param('custom_unit_amount'), param(given[0])]);
  if (sent.custom_unit_amount !== undefined) {
    return { custom_unit_amount: customUnitAmount(sent.custom_unit_amount, { param, currency }), unit_amount: null, unit_amount_decimal: null };
  }
  if (!given.length) throw parameterMissing(param('unit_amount'));
  const [unit_amount, unit_amount_decimal] = amountPair(sent, 'unit_amount', 'unit_amount_decimal', param);
  return { custom_unit_amount: null, unit_amount, unit_amount_decimal };
}

/** Tiers in the object's shape; `up_to: null` is the last, unbounded tier ("inf"). */
function normalizeTiers(sent, { param }) {
  const tiers = sent.map((tier, i) => {
    const tierParam = (key) => param(`tiers[${i}][${key}]`);
    const [flat_amount, flat_amount_decimal] = amountPair(tier, 'flat_amount', 'flat_amount_decimal', tierParam);
    const [unit_amount, unit_amount_decimal] = amountPair(tier, 'unit_amount', 'unit_amount_decimal', tierParam);
    const upTo = tier.up_to === 'inf' ? null : tier.up_to;
    if (upTo !== null && upTo < 1) throw invalidParam(tierParam('up_to'), 'up_to must be a positive integer or inf.');
    return { flat_amount, flat_amount_decimal, unit_amount, unit_amount_decimal, up_to: upTo };
  });
  tiers.forEach((tier, i) => {
    const last = i === tiers.length - 1;
    if (last && tier.up_to !== null) throw invalidParam(param(`tiers[${i}][up_to]`), 'The last tier must have up_to=inf.');
    if (!last && tier.up_to === null) throw invalidParam(param(`tiers[${i}][up_to]`), 'Only the last tier can have up_to=inf.');
    if (!last && i > 0 && tier.up_to <= tiers[i - 1].up_to) {
      throw invalidParam(param(`tiers[${i}][up_to]`), 'Tier bounds (up_to) must increase from one tier to the next.');
    }
  });
  return tiers;
}

function normalizeRecurring(sent, { param, version }) {
  if (sent === undefined) return { recurring: null, aggregateUsage: null };
  const intervalCount = sent.interval_count ?? 1;
  if (!isIntervalWithinLimit(sent.interval, intervalCount)) {
    throw invalidParam(
      param('recurring[interval_count]'),
      'Invalid recurring[interval_count]: it must be at least 1, and the interval at most three years (3 years, 36 months, 156 weeks or 1095 days).',
    );
  }
  const usageType = sent.usage_type ?? 'licensed';
  const meter = sent.meter ?? null;
  if (usageType === 'metered' && meter === null && atLeast(version, METER_REQUIRED_FROM)) {
    throw parameterMissing(param('recurring[meter]'));
  }
  const trialDays = sent.trial_period_days ?? null;
  if (trialDays !== null && (trialDays < 0 || trialDays > MAX_TRIAL_PERIOD_DAYS)) {
    throw invalidParam(param('recurring[trial_period_days]'), `The trial period must be ${MAX_TRIAL_PERIOD_DAYS} days (2 years) or less.`);
  }
  // Legacy metered prices aggregate usage with "sum" unless told otherwise (2024-06-20).
  const aggregateUsage = usageType === 'metered' ? sent.aggregate_usage ?? (meter === null ? 'sum' : null) : null;
  return {
    recurring: { interval: sent.interval, interval_count: intervalCount, meter, trial_period_days: trialDays, usage_type: usageType },
    aggregateUsage,
  };
}

function normalizeTransform(sent, { param }) {
  if (sent.divide_by < 1) throw invalidParam(param('transform_quantity[divide_by]'), 'divide_by must be at least 1.');
  return { divide_by: sent.divide_by, round: sent.round };
}

/** One currency option ({custom_unit_amount, tax_behavior, tiers?, unit_amount, unit_amount_decimal}). */
function currencyOption(sent, { param, currency, billingScheme, taxBehavior }) {
  const base = { tax_behavior: sent.tax_behavior ?? taxBehavior };
  if (billingScheme === 'tiered') {
    if (sent.tiers === undefined) throw parameterMissing(param('tiers'));
    return { custom_unit_amount: null, ...base, tiers: normalizeTiers(sent.tiers, { param }), unit_amount: null, unit_amount_decimal: null };
  }
  if (sent.tiers !== undefined) throw invalidParam(param('tiers'), 'tiers requires billing_scheme=tiered.');
  const amounts = perUnitAmount(sent, { param, currency });
  return { custom_unit_amount: amounts.custom_unit_amount, ...base, unit_amount: amounts.unit_amount, unit_amount_decimal: amounts.unit_amount_decimal };
}

/** `currency_options` merged into `existing` (a sent `''` for one currency removes it). */
function normalizeCurrencyOptions(sent, existing, { param, price }) {
  const out = { ...(existing ?? {}) };
  for (const [code, option] of Object.entries(sent)) {
    const currency = code.toLowerCase();
    const optionParam = (key) => nestParam(param(`currency_options[${code}]`), key);
    if (!isSupportedCurrency(currency)) throw invalidParam(param(`currency_options[${code}]`), `Invalid currency: ${code}.`);
    if (currency === price.currency) {
      throw invalidParam(param(`currency_options[${code}]`), `currency_options cannot redefine the price's own currency (${price.currency}).`);
    }
    if (option === '') {
      delete out[currency];
      continue;
    }
    out[currency] = currencyOption(option, { param: optionParam, currency, billingScheme: price.billing_scheme, taxBehavior: price.tax_behavior });
  }
  return Object.keys(out).length ? out : null;
}

function lookupKeyHolder(account, key, exceptId = null) {
  return account.store.list('price', (p) => p.lookup_key === key && p.id !== exceptId)[0] ?? null;
}

function lookupKeyTaken(holder, param) {
  return invalidRequest(`A price (\`${holder.id}\`) already uses that lookup key.`, { param });
}

/**
 * Validates POST /v1/prices-style params (also `default_price_data` and `price_data`) without
 * changing anything. Returns a spec for insertPrice. `productPending`: the product is being
 * created by the caller (product create with default_price_data), so `product` is not checked.
 */
export function preparePrice(account, params = {}, { version = account.settings.apiVersion, paramPrefix, productPending = false } = {}) {
  const param = (name) => nestParam(paramPrefix, name);
  let productId = null;
  if (!productPending) {
    if (params.product !== undefined && params.product_data !== undefined) throw parametersExclusive([param('product'), param('product_data')]);
    if (params.product === undefined && params.product_data === undefined) throw parameterMissing(param('product'));
    if (params.product !== undefined) {
      productId = requireProduct(account, params.product, { param: param('product') }).id;
    } else {
      validateProductParams(params.product_data, { prefix: param('product_data') });
      if (params.product_data.id !== undefined && account.store.find(params.product_data.id)) {
        throw invalidRequest(`A product with the ID '${params.product_data.id}' already exists.`, {
          param: param('product_data[id]'),
          code: 'resource_already_exists',
        });
      }
    }
  }
  const billingScheme = params.billing_scheme ?? 'per_unit';
  let amounts;
  let tiers = null;
  if (billingScheme === 'tiered') {
    for (const key of ['unit_amount', 'unit_amount_decimal', 'custom_unit_amount']) {
      if (params[key] !== undefined) throw invalidParam(param(key), `${key} cannot be used with billing_scheme=tiered.`);
    }
    if (params.tiers === undefined) throw parameterMissing(param('tiers'));
    if (params.tiers_mode === undefined) throw parameterMissing(param('tiers_mode'));
    if (params.transform_quantity !== undefined) throw parametersExclusive([param('tiers'), param('transform_quantity')]);
    tiers = normalizeTiers(params.tiers, { param });
    amounts = { custom_unit_amount: null, unit_amount: null, unit_amount_decimal: null };
  } else {
    for (const key of ['tiers', 'tiers_mode']) {
      if (params[key] !== undefined) throw invalidParam(param(key), `${key} requires billing_scheme=tiered.`);
    }
    amounts = perUnitAmount(params, { param, currency: params.currency });
  }
  const { recurring, aggregateUsage } = normalizeRecurring(params.recurring, { param, version });
  const taxBehavior = params.tax_behavior ?? 'unspecified';
  const shape = { currency: params.currency, billing_scheme: billingScheme, tax_behavior: taxBehavior };
  const currencyOptions = params.currency_options === undefined ? null : normalizeCurrencyOptions(params.currency_options, null, { param, price: shape });
  const lookupKey = params.lookup_key ?? null;
  const holder = lookupKey === null ? null : lookupKeyHolder(account, lookupKey);
  if (holder && params.transfer_lookup_key !== true) throw lookupKeyTaken(holder, param('lookup_key'));
  return {
    productId,
    productData: productPending ? null : params.product_data ?? null,
    transferFrom: holder,
    aggregateUsage,
    fields: {
      active: params.active ?? true,
      billing_scheme: billingScheme,
      currency: params.currency,
      currency_options: currencyOptions,
      custom_unit_amount: amounts.custom_unit_amount,
      lookup_key: lookupKey,
      metadata: applyMetadata({}, params.metadata),
      nickname: params.nickname ?? null,
      recurring,
      tax_behavior: taxBehavior,
      tiers,
      tiers_mode: billingScheme === 'tiered' ? params.tiers_mode : null,
      transform_quantity: params.transform_quantity === undefined ? null : normalizeTransform(params.transform_quantity, { param }),
      type: recurring ? 'recurring' : 'one_time',
      unit_amount: amounts.unit_amount,
      unit_amount_decimal: amounts.unit_amount_decimal,
    },
  };
}

/** Stores a price from a preparePrice spec (no events, no lookup-key transfer). */
export function insertPrice(account, spec, { product, inline = false } = {}) {
  const f = spec.fields;
  return account.store.insert({
    id: account.mintId('price'),
    object: 'price',
    active: f.active,
    billing_scheme: f.billing_scheme,
    created: account.time.now(),
    currency: f.currency,
    currency_options: f.currency_options,
    custom_unit_amount: f.custom_unit_amount,
    livemode: false,
    lookup_key: f.lookup_key,
    metadata: f.metadata,
    nickname: f.nickname,
    product,
    recurring: f.recurring,
    tax_behavior: f.tax_behavior,
    tiers: f.tiers,
    tiers_mode: f.tiers_mode,
    transform_quantity: f.transform_quantity,
    type: f.type,
    unit_amount: f.unit_amount,
    unit_amount_decimal: f.unit_amount_decimal,
    _inline: inline,
    _aggregateUsage: spec.aggregateUsage,
  });
}

/** Removes a lookup key from the price holding it (transfer_lookup_key) and emits price.updated. */
function releaseLookupKey(account, holder, { request }) {
  updateWithEvent(account, holder, 'price.updated', (p) => {
    p.lookup_key = null;
  }, { request });
}

/**
 * Creates a price from validated POST /v1/prices params. `inline: true` creates an inline price
 * (Checkout / subscription `price_data`), which GET /v1/prices never lists and no event announces.
 * `product_data` creates the product first (product.created). `version` is the causing request's
 * API version (default: the account's); `paramPrefix` nests error params
 * ('line_items[0][price_data]').
 * @returns {object} internal price
 */
export function createPrice(account, params = {}, { request, inline = false, version, paramPrefix } = {}) {
  const spec = preparePrice(account, params, { version, paramPrefix });
  let productId = spec.productId;
  if (spec.productData) {
    productId = createProduct(account, spec.productData, { request, version, paramPrefix: nestParam(paramPrefix, 'product_data') }).id;
  }
  if (spec.transferFrom) releaseLookupKey(account, spec.transferFrom, { request });
  const price = insertPrice(account, spec, { product: productId, inline });
  if (!inline) emitEvent(account, 'price.created', price, { request });
  return price;
}

/**
 * Updates a price from validated POST /v1/prices/:id params. Only active, currency_options,
 * lookup_key (+ transfer_lookup_key), metadata, nickname and tax_behavior change ("You can't
 * change a price's amount"); tax_behavior only while it is `unspecified`. Emits price.updated.
 */
export function updatePrice(account, price, params = {}, { request } = {}) {
  if (params.tax_behavior !== undefined && price.tax_behavior !== 'unspecified' && params.tax_behavior !== price.tax_behavior) {
    throw invalidRequest(`The tax_behavior of ${price.id} is ${price.tax_behavior} and can no longer be changed.`, { param: 'tax_behavior' });
  }
  let holder = null;
  if (params.lookup_key !== undefined && params.lookup_key !== price.lookup_key) {
    holder = lookupKeyHolder(account, params.lookup_key, price.id);
    if (holder && params.transfer_lookup_key !== true) throw lookupKeyTaken(holder, 'lookup_key');
  }
  const draft = structuredClone(price);
  if (params.active !== undefined) draft.active = params.active;
  if (params.nickname !== undefined) draft.nickname = params.nickname;
  if (params.tax_behavior !== undefined) draft.tax_behavior = params.tax_behavior;
  if (params.lookup_key !== undefined) draft.lookup_key = params.lookup_key;
  draft.metadata = applyMetadata(draft.metadata, params.metadata);
  if (params.currency_options !== undefined) {
    draft.currency_options = params.currency_options === '' ? null : normalizeCurrencyOptions(params.currency_options, price.currency_options, { param: (n) => n, price });
  }
  if (holder) releaseLookupKey(account, holder, { request });
  updateWithEvent(account, price, 'price.updated', (p) => Object.assign(p, draft), { request });
  return price;
}

// Rendering ----------------------------------------------------------------------------------------

function renderRecurring(price, ctx) {
  const r = price.recurring;
  if (!r) return null;
  const out = {};
  if (ctx.family === 'F1') out.aggregate_usage = price._aggregateUsage ?? null;
  return Object.assign(out, {
    interval: r.interval,
    interval_count: r.interval_count,
    meter: r.meter,
    trial_period_days: r.trial_period_days,
    usage_type: r.usage_type,
  });
}

const cloneOrNull = (value) => (value === null || value === undefined ? null : structuredClone(value));

/** The wire form of a price (the API reference example's order). */
export function renderPrice(p, ctx) {
  return {
    id: p.id,
    object: 'price',
    active: p.active,
    billing_scheme: p.billing_scheme,
    created: p.created,
    currency: p.currency,
    custom_unit_amount: cloneOrNull(p.custom_unit_amount),
    livemode: false,
    lookup_key: p.lookup_key,
    metadata: { ...p.metadata },
    nickname: p.nickname,
    product: p.product,
    recurring: renderRecurring(p, ctx),
    tax_behavior: p.tax_behavior,
    tiers_mode: p.tiers_mode,
    transform_quantity: cloneOrNull(p.transform_quantity),
    type: p.type,
    unit_amount: p.unit_amount,
    unit_amount_decimal: p.unit_amount_decimal,
  };
}

/** Expanded `currency_options`: the price's own currency first, then the extra currencies. */
function renderCurrencyOptions(p) {
  const entry = (o) => {
    const out = { custom_unit_amount: cloneOrNull(o.custom_unit_amount), tax_behavior: o.tax_behavior };
    if (o.tiers) out.tiers = structuredClone(o.tiers);
    return Object.assign(out, { unit_amount: o.unit_amount, unit_amount_decimal: o.unit_amount_decimal });
  };
  const out = { [p.currency]: entry(p) };
  for (const [currency, option] of Object.entries(p.currency_options ?? {})) out[currency] = entry(option);
  return out;
}

export function install(app) {
  app.object('price', {
    render: renderPrice,
    expandable: ['product'],
    includable: {
      tiers: (json, ctx) => cloneOrNull(ctx.lookup(json.id)?.tiers),
      currency_options: (json, ctx) => {
        const price = ctx.lookup(json.id);
        return price ? renderCurrencyOptions(price) : null;
      },
    },
  });

  app.route('POST', '/v1/prices', (ctx) => createPrice(ctx.account, ctx.params, { version: ctx.version }));

  app.route('GET', '/v1/prices/:id', (ctx) => requirePrice(ctx.account, ctx.pathParams.id, { param: 'id' }));

  app.route('POST', '/v1/prices/:id', (ctx) =>
    updatePrice(ctx.account, requirePrice(ctx.account, ctx.pathParams.id, { param: 'id' }), ctx.params),
  );

  app.route('GET', '/v1/prices', (ctx) => {
    const { params, account } = ctx;
    if (params.lookup_keys !== undefined && params.lookup_keys.length > MAX_LOOKUP_KEYS) {
      throw invalidParam('lookup_keys', `You can specify up to ${MAX_LOOKUP_KEYS} lookup_keys.`);
    }
    // "Returns a list of your active prices, excluding inline prices." active=false lists archived ones.
    const active = params.active ?? true;
    const recurring = params.recurring ?? {};
    const prices = account.store.list('price', (p) => {
      if (p._inline || p.active !== active) return false;
      if (params.currency !== undefined && p.currency !== params.currency) return false;
      if (params.product !== undefined && p.product !== params.product) return false;
      if (params.type !== undefined && p.type !== params.type) return false;
      if (params.lookup_keys !== undefined && !params.lookup_keys.includes(p.lookup_key)) return false;
      if (params.recurring !== undefined) {
        if (!p.recurring) return false;
        if (recurring.interval !== undefined && p.recurring.interval !== recurring.interval) return false;
        if (recurring.usage_type !== undefined && p.recurring.usage_type !== recurring.usage_type) return false;
        if (recurring.meter !== undefined && p.recurring.meter !== recurring.meter) return false;
      }
      return matchesRange(p.created, params.created);
    });
    return paginate(prices, params, { url: '/v1/prices', noun: 'price', find: (id) => account.store.get('price', id) });
  });
}
