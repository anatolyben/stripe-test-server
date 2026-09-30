/**
 * Customer portal configurations (docs.stripe.com/api/customer_portal/configurations).
 *
 * Routes: POST/GET /v1/billing_portal/configurations, GET/POST /v1/billing_portal/configurations/:id.
 * Object: 'billing_portal.configuration', rendered in its full current shape at every version;
 * includable features.subscription_update.products.
 * The first configuration an account creates is its default (is_default: true); sessions created
 * without `configuration` use it. Version gates (schedule_at_period_end ≥ 2024-10-28.acacia,
 * trial_update_behavior ≥ 2025-09-30.clover) are enforced by the parameter schema.
 * Events: billing_portal.configuration.created / .updated.
 */
import { emitEvent, updateWithEvent } from '../core/events.js';
import { invalidParam, invalidRequest, resourceMissing } from '../core/errors.js';
import { paginate } from '../core/list.js';
import { applyMetadata, checkUrl } from '../core/util.js';
import { requirePrice } from '../catalog/prices.js';
import { requireProduct } from '../catalog/products.js';

/** Up to 10 products support subscription updates (docs.stripe.com/customer-management). */
const MAX_PRODUCTS = 10;
/** Reasons shown by default when the configuration does not list its own. */
const DEFAULT_CANCEL_REASONS = ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'];

const TYPE = 'billing_portal.configuration';

/** The account's default configuration, or null. */
export function defaultConfiguration(account) {
  return account.store.list(TYPE, (c) => c.is_default)[0] ?? null;
}

/** The configuration `id`, or resource_missing (404 for a path ID, else 400 on `param`). */
export function requireConfiguration(account, id, { param = 'configuration' } = {}) {
  return account.store.require(TYPE, id, { param, noun: TYPE });
}

function emptyFeatures() {
  return {
    customer_update: { allowed_updates: [], enabled: false },
    invoice_history: { enabled: false },
    payment_method_update: { enabled: false, payment_method_configuration: null },
    subscription_cancel: {
      cancellation_reason: { enabled: false, feedback_options: null, options: [...DEFAULT_CANCEL_REASONS] },
      enabled: false,
      mode: 'at_period_end',
      proration_behavior: 'none',
    },
    subscription_update: {
      billing_cycle_anchor: null,
      default_allowed_updates: [],
      enabled: false,
      products: [],
      proration_behavior: 'none',
      schedule_at_period_end: { conditions: [] },
      trial_update_behavior: 'end_trial',
    },
  };
}

const list = (v) => (v === '' ? [] : [...v]);
const P = (...keys) => `features${keys.map((k) => `[${k}]`).join('')}`;

/** Validates `features[subscription_update][products]` and returns the stored entries. */
function readProducts(account, products) {
  if (products === '') return [];
  if (products.length > MAX_PRODUCTS) throw invalidParam(P('subscription_update', 'products'), `You can specify up to ${MAX_PRODUCTS} products.`);
  const seen = new Set();
  return products.map((entry, i) => {
    const param = P('subscription_update', 'products', i);
    requireProduct(account, entry.product, { param: `${param}[product]` });
    if (seen.has(entry.product)) throw invalidParam(`${param}[product]`, `The product ${entry.product} is listed more than once.`);
    seen.add(entry.product);
    if (!entry.prices.length) throw invalidParam(`${param}[prices]`, 'Each product needs at least one price.');
    const intervals = new Set();
    entry.prices.forEach((id, j) => {
      const price = requirePrice(account, id, { param: `${param}[prices][${j}]`, active: true });
      if (price.product !== entry.product) throw invalidParam(`${param}[prices][${j}]`, `The price ${id} does not belong to the product ${entry.product}.`);
      if (!price.recurring) throw invalidParam(`${param}[prices][${j}]`, `The price ${id} is not a recurring price.`);
      if (intervals.has(price.recurring.interval)) {
        throw invalidParam(`${param}[prices]`, `You can't define multiple prices with the same product and recurring.interval (${price.recurring.interval}).`);
      }
      intervals.add(price.recurring.interval);
    });
    const aq = entry.adjustable_quantity;
    const adjustable = { enabled: aq?.enabled ?? false, maximum: aq?.maximum ?? null, minimum: aq?.minimum ?? 1 };
    if (adjustable.minimum < 0) throw invalidParam(`${param}[adjustable_quantity][minimum]`, 'minimum must be 0 or greater.');
    if (adjustable.maximum !== null && adjustable.maximum < Math.max(1, adjustable.minimum)) {
      throw invalidParam(`${param}[adjustable_quantity][maximum]`, 'maximum must be at least 1 and not below minimum.');
    }
    return { adjustable_quantity: adjustable, prices: [...entry.prices], product: entry.product };
  });
}

/** Applies a `features` param to `features` in place (objects merge; arrays are replaced). */
function applyFeatures(account, features, sent) {
  if (!sent) return;
  const cu = sent.customer_update;
  if (cu) {
    if (cu.enabled !== undefined) features.customer_update.enabled = cu.enabled;
    if (cu.allowed_updates !== undefined) features.customer_update.allowed_updates = list(cu.allowed_updates);
  }
  if (sent.invoice_history) features.invoice_history.enabled = sent.invoice_history.enabled;
  const pm = sent.payment_method_update;
  if (pm) {
    features.payment_method_update.enabled = pm.enabled;
    if (pm.payment_method_configuration !== undefined) {
      if (pm.payment_method_configuration !== '') {
        throw resourceMissing('payment_method_configuration', pm.payment_method_configuration, { param: P('payment_method_update', 'payment_method_configuration') });
      }
      features.payment_method_update.payment_method_configuration = null;
    }
  }
  const sc = sent.subscription_cancel;
  if (sc) {
    const target = features.subscription_cancel;
    if (sc.enabled !== undefined) target.enabled = sc.enabled;
    if (sc.mode !== undefined) target.mode = sc.mode;
    if (sc.proration_behavior !== undefined) {
      if (sc.proration_behavior === 'always_invoice') {
        throw invalidParam(P('subscription_cancel', 'proration_behavior'), 'Passing always_invoice for subscription_cancel.proration_behavior is not supported; use none or create_prorations.');
      }
      target.proration_behavior = sc.proration_behavior;
    }
    const reason = sc.cancellation_reason;
    if (reason) {
      target.cancellation_reason.enabled = reason.enabled;
      if (reason.options !== undefined) target.cancellation_reason.options = list(reason.options);
      if (reason.feedback_options !== undefined) {
        if (reason.feedback_options !== '' && reason.feedback_options.length) {
          throw resourceMissing('billing.feedback_option', reason.feedback_options[0], { param: P('subscription_cancel', 'cancellation_reason', 'feedback_options', 0) });
        }
        target.cancellation_reason.feedback_options = null;
      }
    }
    if (target.mode === 'at_period_end' && target.proration_behavior === 'create_prorations') {
      const param = sc.proration_behavior !== undefined ? P('subscription_cancel', 'proration_behavior') : P('subscription_cancel', 'mode');
      throw invalidParam(param, 'subscription_cancel.proration_behavior=create_prorations is only compatible with mode=immediately.');
    }
  }
  const su = sent.subscription_update;
  if (su) {
    const target = features.subscription_update;
    if (su.enabled !== undefined) target.enabled = su.enabled;
    if (su.default_allowed_updates !== undefined) target.default_allowed_updates = list(su.default_allowed_updates);
    if (su.products !== undefined) target.products = readProducts(account, su.products);
    if (su.proration_behavior !== undefined) target.proration_behavior = su.proration_behavior;
    if (su.billing_cycle_anchor !== undefined) target.billing_cycle_anchor = su.billing_cycle_anchor;
    if (su.trial_update_behavior !== undefined) target.trial_update_behavior = su.trial_update_behavior;
    if (su.schedule_at_period_end !== undefined) {
      const conditions = su.schedule_at_period_end.conditions;
      if (conditions !== undefined) target.schedule_at_period_end.conditions = conditions === '' ? [] : conditions.map((c) => ({ type: c.type }));
    }
  }
}

function applyBusinessProfile(config, sent) {
  if (!sent) return;
  const bp = config.business_profile;
  for (const key of ['headline', 'privacy_policy_url', 'terms_of_service_url']) {
    if (sent[key] === undefined) continue;
    const value = sent[key] === '' ? null : sent[key];
    if (key !== 'headline') checkUrl(value, `business_profile[${key}]`);
    bp[key] = value;
  }
}

function applyLoginPage(account, config, sent) {
  if (!sent) return;
  if (sent.enabled && !config.login_page.enabled) {
    config._login_token = account.mintId('test');
    config.login_page = { enabled: true, url: `${account.server.url}/p/login/${config._login_token}` };
  } else if (!sent.enabled) {
    config._login_token = null;
    config.login_page = { enabled: false, url: null };
  }
}

/** Applies create/update params (except features) to a draft configuration. */
function applyCommon(account, config, params) {
  applyBusinessProfile(config, params.business_profile);
  if (params.default_return_url !== undefined) {
    const value = params.default_return_url === '' ? null : params.default_return_url;
    checkUrl(value, 'default_return_url');
    config.default_return_url = value;
  }
  if (params.name !== undefined) config.name = params.name === '' ? null : params.name;
  config.metadata = applyMetadata(config.metadata, params.metadata);
  applyFeatures(account, config.features, params.features);
  applyLoginPage(account, config, params.login_page);
}

/**
 * Creates a configuration from validated POST params. The account's first configuration becomes
 * its default. Emits billing_portal.configuration.created.
 */
export function createConfiguration(account, params, { request } = {}) {
  const now = account.time.now();
  const draft = {
    id: null,
    object: TYPE,
    active: true,
    application: null,
    business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
    created: now,
    default_return_url: null,
    features: emptyFeatures(),
    is_default: !defaultConfiguration(account),
    livemode: false,
    login_page: { enabled: false, url: null },
    metadata: {},
    name: null,
    updated: now,
    _login_token: null,
  };
  applyCommon(account, draft, params);
  draft.id = account.mintId('bpc');
  account.store.insert(draft);
  emitEvent(account, 'billing_portal.configuration.created', draft, { request });
  return draft;
}

/**
 * Updates a configuration (nested objects merge, arrays are replaced; only the keys sent change).
 * Emits billing_portal.configuration.updated when something changed.
 */
export function updateConfiguration(account, config, params, { request } = {}) {
  const draft = structuredClone(config);
  applyCommon(account, draft, params);
  if (params.active !== undefined) draft.active = params.active;
  const strip = ({ updated, _login_token, ...rest }) => JSON.stringify(rest);
  if (strip(draft) !== strip(config)) draft.updated = account.time.now();
  updateWithEvent(account, config, 'billing_portal.configuration.updated', (c) => Object.assign(c, draft), { request });
  return config;
}

/** The subscription_update products of a configuration, as the API returns them. */
function renderProducts(config) {
  return config.features.subscription_update.products.map((p) => ({
    adjustable_quantity: { ...p.adjustable_quantity },
    prices: [...p.prices],
    product: p.product,
  }));
}

/** The wire form: the full current shape at every API version. */
export function renderConfiguration(c) {
  const f = c.features;
  const subscriptionUpdate = {
    billing_cycle_anchor: f.subscription_update.billing_cycle_anchor,
    default_allowed_updates: [...f.subscription_update.default_allowed_updates],
    enabled: f.subscription_update.enabled,
    proration_behavior: f.subscription_update.proration_behavior,
    schedule_at_period_end: { conditions: f.subscription_update.schedule_at_period_end.conditions.map((x) => ({ ...x })) },
    trial_update_behavior: f.subscription_update.trial_update_behavior,
  };
  return {
    id: c.id,
    object: TYPE,
    active: c.active,
    application: null,
    business_profile: { ...c.business_profile },
    created: c.created,
    default_return_url: c.default_return_url,
    features: {
      customer_update: { allowed_updates: [...f.customer_update.allowed_updates], enabled: f.customer_update.enabled },
      invoice_history: { enabled: f.invoice_history.enabled },
      payment_method_update: { enabled: f.payment_method_update.enabled, payment_method_configuration: f.payment_method_update.payment_method_configuration },
      subscription_cancel: {
        cancellation_reason: {
          enabled: f.subscription_cancel.cancellation_reason.enabled,
          feedback_options: f.subscription_cancel.cancellation_reason.feedback_options,
          options: [...f.subscription_cancel.cancellation_reason.options],
        },
        enabled: f.subscription_cancel.enabled,
        mode: f.subscription_cancel.mode,
        proration_behavior: f.subscription_cancel.proration_behavior,
      },
      subscription_update: subscriptionUpdate,
    },
    is_default: c.is_default,
    livemode: false,
    login_page: { ...c.login_page },
    metadata: { ...c.metadata },
    name: c.name,
    updated: c.updated,
  };
}

export function install(app) {
  app.object(TYPE, {
    render: renderConfiguration,
    expandable: ['application', 'features.subscription_cancel.cancellation_reason.feedback_options'],
    includable: {
      'features.subscription_update.products': (json, ctx, configuration) => {
        const config = ctx.lookup(configuration.id);
        return config ? renderProducts(config) : null;
      },
    },
  });

  app.route('POST', '/v1/billing_portal/configurations', (ctx) => createConfiguration(ctx.account, ctx.params));
  app.route('GET', '/v1/billing_portal/configurations', (ctx) => {
    const { params, account } = ctx;
    const configs = account.store.list(TYPE, (c) => {
      if (params.active !== undefined && c.active !== params.active) return false;
      if (params.is_default !== undefined && c.is_default !== params.is_default) return false;
      return true;
    });
    return paginate(configs, params, { url: '/v1/billing_portal/configurations', noun: TYPE, find: (id) => account.store.get(TYPE, id) });
  });
  app.route('GET', '/v1/billing_portal/configurations/:id', (ctx) => requireConfiguration(ctx.account, ctx.pathParams.id, { param: 'id' }));
  app.route('POST', '/v1/billing_portal/configurations/:id', (ctx) =>
    updateConfiguration(ctx.account, requireConfiguration(ctx.account, ctx.pathParams.id, { param: 'id' }), ctx.params),
  );
}
