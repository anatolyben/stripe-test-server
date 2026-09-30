/**
 * Customer portal sessions (docs.stripe.com/api/customer_portal/sessions).
 *
 * Route: POST /v1/billing_portal/sessions (there is no retrieve or list).
 * Object: 'billing_portal.session', url = `${server.url}/p/session/${token}` (the token is minted
 * with account.mintId, so the hosted page finds the account). flow_data deep links
 * (docs.stripe.com/customer-management/portal-deep-links) are validated against the configuration
 * and the subscription here; the hosted page (portal_page.js) carries them out.
 * Sessions expire 5 minutes after creation unless used; each use keeps them alive for an hour
 * (docs.stripe.com/customer-management), measured on the account clock.
 * Events: billing_portal.session.created.
 */
import { emitEvent } from '../core/events.js';
import { invalidParam, invalidRequest, parameterMissing, parametersExclusive, resourceMissing } from '../core/errors.js';
import { atLeast } from '../core/versions.js';
import { requireCustomer } from '../customers/customers.js';
import { requirePrice } from '../catalog/prices.js';
import { defaultConfiguration, requireConfiguration } from './configurations.js';
import { checkUrl } from '../core/util.js';

const TYPE = 'billing_portal.session';
/** Unused sessions expire after 5 minutes; used ones 1 hour after the last activity. */
export const FIRST_USE_SECONDS = 5 * 60;
export const IDLE_SECONDS = 60 * 60;

const NO_DEFAULT_MESSAGE =
  'No configuration provided and your test mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal.';

const FLOW_FEATURE = {
  customer_update: 'customer_update',
  payment_method_update: 'payment_method_update',
  subscription_cancel: 'subscription_cancel',
  subscription_update: 'subscription_update',
  subscription_update_confirm: 'subscription_update',
};
const FLOW_BRANCHES = ['subscription_cancel', 'subscription_update', 'subscription_update_confirm'];

/**
 * Why the portal cannot update `sub` (docs.stripe.com/customer-management: multiple products,
 * usage-based billing, invoices sent for collection), or null when it can.
 */
export function updateBlocker(account, sub) {
  const items = sub.items?.data ?? [];
  if (items.length !== 1) return 'Subscriptions with multiple items cannot be updated in the portal.';
  const price = account.store.get('price', items[0].price);
  if (price?.recurring?.usage_type === 'metered') return 'Usage-based subscriptions cannot be updated in the portal.';
  if (sub.collection_method === 'send_invoice') return 'Subscriptions that send invoices cannot be updated in the portal.';
  return null;
}

/** The live subscription `id` of `customer` for a flow, or a 400 on `param`. */
function flowSubscription(account, id, customer, param) {
  const sub = account.store.require('subscription', id, { param });
  if (sub.customer !== customer.id) throw invalidRequest(`The subscription ${id} does not belong to the customer ${customer.id}.`, { param });
  if (['canceled', 'incomplete_expired'].includes(sub.status)) {
    throw invalidRequest(`The subscription ${id} has ended and can no longer be updated or canceled.`, { param });
  }
  if (sub.schedule) {
    throw invalidRequest(`The subscription ${id} has an update scheduled with a subscription schedule, so it cannot be updated or canceled in the portal.`, { param });
  }
  return sub;
}

/** The configured products entry that offers `priceId`, or null. */
export function configuredProductFor(config, priceId) {
  return config.features.subscription_update.products.find((p) => p.prices.includes(priceId)) ?? null;
}

function readAfterCompletion(ac) {
  if (!ac) return { hosted_confirmation: { custom_message: null }, redirect: null, type: 'hosted_confirmation' };
  const p = (k) => `flow_data[after_completion][${k}]`;
  if (ac.redirect !== undefined && ac.type !== 'redirect') throw invalidParam(p('redirect'), 'redirect can only be set when after_completion[type] is redirect.');
  if (ac.hosted_confirmation !== undefined && ac.type !== 'hosted_confirmation') {
    throw invalidParam(p('hosted_confirmation'), 'hosted_confirmation can only be set when after_completion[type] is hosted_confirmation.');
  }
  if (ac.type === 'redirect') {
    if (!ac.redirect) throw parameterMissing(p('redirect'));
    checkUrl(ac.redirect.return_url, `${p('redirect')}[return_url]`);
  }
  return {
    hosted_confirmation: ac.type === 'hosted_confirmation' ? { custom_message: ac.hosted_confirmation?.custom_message ?? null } : null,
    redirect: ac.type === 'redirect' ? { return_url: ac.redirect.return_url } : null,
    type: ac.type,
  };
}

/** Validates flow_data against the configuration and the customer's subscription; returns the stored flow. */
function readFlow(account, flowData, { customer, config, version }) {
  if (!flowData) return null;
  const { type } = flowData;
  if (type === 'customer_update' && !atLeast(version, '2026-08-26.dahlia')) {
    throw invalidParam('flow_data[type]', 'Invalid flow_data[type]: must be one of payment_method_update, subscription_cancel, subscription_update, or subscription_update_confirm');
  }
  for (const branch of FLOW_BRANCHES) {
    if (flowData[branch] !== undefined && branch !== type) {
      throw invalidParam(`flow_data[${branch}]`, `flow_data[${branch}] can only be set when flow_data[type] is ${branch}.`);
    }
  }
  if (FLOW_BRANCHES.includes(type) && flowData[type] === undefined) throw parameterMissing(`flow_data[${type}]`);
  const afterCompletion = readAfterCompletion(flowData.after_completion);
  const feature = FLOW_FEATURE[type];
  if (!config.features[feature].enabled) {
    throw invalidRequest(`The ${type} flow requires features[${feature}][enabled] to be true in the portal configuration ${config.id}.`, { param: 'flow_data[type]' });
  }
  const flow = {
    after_completion: afterCompletion,
    customer_update: type === 'customer_update' ? {} : null,
    subscription_cancel: null,
    subscription_update: null,
    subscription_update_confirm: null,
    type,
  };
  if (type === 'subscription_cancel') {
    const data = flowData.subscription_cancel;
    const param = 'flow_data[subscription_cancel][subscription]';
    flowSubscription(account, data.subscription, customer, param);
    if (data.retention) {
      throw resourceMissing('coupon', data.retention.coupon_offer.coupon, { param: 'flow_data[subscription_cancel][retention][coupon_offer][coupon]' });
    }
    flow.subscription_cancel = { retention: null, subscription: data.subscription };
  } else if (type === 'subscription_update') {
    const param = 'flow_data[subscription_update][subscription]';
    const sub = flowSubscription(account, flowData.subscription_update.subscription, customer, param);
    const blocker = updateBlocker(account, sub);
    if (blocker) throw invalidRequest(blocker, { param });
    if (!config.features.subscription_update.products.length) {
      throw invalidRequest(`The portal configuration ${config.id} has no products in features[subscription_update][products], so subscriptions cannot be updated.`, { param: 'flow_data[type]' });
    }
    flow.subscription_update = { subscription: sub.id };
  } else if (type === 'subscription_update_confirm') {
    flow.subscription_update_confirm = readUpdateConfirm(account, flowData.subscription_update_confirm, { customer, config });
  }
  return flow;
}

function readUpdateConfirm(account, data, { customer, config }) {
  const base = 'flow_data[subscription_update_confirm]';
  const sub = flowSubscription(account, data.subscription, customer, `${base}[subscription]`);
  const blocker = updateBlocker(account, sub);
  if (blocker) throw invalidRequest(blocker, { param: `${base}[subscription]` });
  if (data.items.length !== 1) throw invalidParam(`${base}[items]`, 'Only one item can be specified in subscription_update_confirm.');
  if (data.discounts?.length) {
    const d = data.discounts[0];
    if (d.coupon !== undefined) throw resourceMissing('coupon', d.coupon, { param: `${base}[discounts][0][coupon]` });
    if (d.promotion_code !== undefined) throw resourceMissing('promotion_code', d.promotion_code, { param: `${base}[discounts][0][promotion_code]` });
  }
  const item = data.items[0];
  const current = sub.items.data[0];
  if (item.id !== current.id) throw resourceMissing('subscription_item', item.id, { param: `${base}[items][0][id]` });
  const priceId = item.price ?? current.price;
  if (item.price !== undefined) {
    const price = requirePrice(account, item.price, { param: `${base}[items][0][price]`, active: true });
    if (!configuredProductFor(config, price.id)) {
      throw invalidRequest(
        `The price ${price.id} is not in the portal configuration's features[subscription_update][products], so the customer cannot switch to it.`,
        { param: `${base}[items][0][price]` },
      );
    }
    if (price.currency !== sub.currency) {
      throw invalidRequest(`The price ${price.id} uses ${price.currency}, but the subscription is billed in ${sub.currency}.`, { param: `${base}[items][0][price]` });
    }
  }
  if (item.quantity !== undefined) {
    const entry = configuredProductFor(config, priceId);
    const aq = entry?.adjustable_quantity;
    const min = aq?.enabled ? Math.max(1, aq.minimum) : 1;
    const max = aq?.enabled && aq.maximum !== null ? aq.maximum : Infinity;
    if (item.quantity < min || item.quantity > max) {
      throw invalidParam(`${base}[items][0][quantity]`, `quantity must be between ${min} and ${max === Infinity ? 'any higher number' : max}.`);
    }
  }
  return {
    discounts: null,
    items: [{ id: item.id, price: item.price ?? null, quantity: item.quantity ?? null }],
    subscription: sub.id,
  };
}

/**
 * Creates a portal session from validated POST /v1/billing_portal/sessions params. Emits
 * billing_portal.session.created.
 * @param {{version: string, request?: object|null, allowNoReturnUrl?: boolean}} opts version of the
 *   request (flow type gates); allowNoReturnUrl for sessions opened from the login page
 */
export function createPortalSession(account, params, { version, request, allowNoReturnUrl = false } = {}) {
  if (params.customer_account !== undefined) throw parametersExclusive(['customer', 'customer_account'], { param: 'customer_account' });
  if (params.on_behalf_of !== undefined) throw invalidParam('on_behalf_of', 'on_behalf_of (Connect) is not supported by this test server.');
  const customer = requireCustomer(account, params.customer, { param: 'customer' });
  let config;
  if (params.configuration !== undefined) {
    config = requireConfiguration(account, params.configuration, { param: 'configuration' });
  } else {
    config = defaultConfiguration(account);
    if (!config) throw invalidRequest(NO_DEFAULT_MESSAGE);
  }
  if (!config.active) throw invalidRequest(`The portal configuration ${config.id} is not active.`, { param: 'configuration' });
  const returnUrl = params.return_url ?? config.default_return_url;
  if (params.return_url !== undefined) checkUrl(params.return_url, 'return_url');
  if (!returnUrl && !allowNoReturnUrl) {
    throw invalidRequest('return_url is required because the portal configuration has no default_return_url.', { param: 'return_url' });
  }
  const flow = readFlow(account, params.flow_data, { customer, config, version });
  const token = account.mintId('test');
  const session = {
    id: account.mintId('bps'),
    object: TYPE,
    configuration: config.id,
    created: account.time.now(account.time.domainOf(customer)),
    customer: customer.id,
    customer_account: null,
    flow,
    livemode: false,
    locale: params.locale ?? null,
    on_behalf_of: null,
    return_url: returnUrl ?? null,
    url: `${account.server.url}/p/session/${token}`,
    _token: token,
    _expires_at: account.time.now() + FIRST_USE_SECONDS,
    _flow_done: false,
  };
  account.store.insert(session);
  emitEvent(account, 'billing_portal.session.created', session, { request });
  return session;
}

/** The session with hosted-page token `token`, or null. */
export function sessionForToken(account, token) {
  return account.store.list(TYPE, (s) => s._token === token)[0] ?? null;
}

/** True when the session can no longer be used (account clock). */
export function isExpired(account, session) {
  return account.time.now() > session._expires_at;
}

/** Records activity on a session: it stays usable for another hour. */
export function touch(account, session) {
  session._expires_at = Math.max(session._expires_at, account.time.now() + IDLE_SECONDS);
}

function renderFlow(flow, ctx) {
  if (!flow) return null;
  const out = {
    after_completion: {
      hosted_confirmation: flow.after_completion.hosted_confirmation ? { ...flow.after_completion.hosted_confirmation } : null,
      redirect: flow.after_completion.redirect ? { ...flow.after_completion.redirect } : null,
      type: flow.after_completion.type,
    },
  };
  if (ctx.atLeast('2026-08-26.dahlia')) out.customer_update = flow.customer_update ? {} : null;
  out.subscription_cancel = flow.subscription_cancel ? { retention: null, subscription: flow.subscription_cancel.subscription } : null;
  out.subscription_update = flow.subscription_update ? { subscription: flow.subscription_update.subscription } : null;
  out.subscription_update_confirm = flow.subscription_update_confirm
    ? {
        discounts: flow.subscription_update_confirm.discounts,
        items: flow.subscription_update_confirm.items.map((i) => ({ ...i })),
        subscription: flow.subscription_update_confirm.subscription,
      }
    : null;
  out.type = flow.type;
  return out;
}

/** The wire form of a portal session. */
export function renderPortalSession(s, ctx) {
  const out = {
    id: s.id,
    object: TYPE,
    configuration: s.configuration,
    created: s.created,
    customer: s.customer,
  };
  if (ctx.atLeast('2025-12-15.clover')) out.customer_account = null;
  Object.assign(out, {
    flow: renderFlow(s.flow, ctx),
    livemode: false,
    locale: s.locale,
    on_behalf_of: null,
    return_url: s.return_url,
    url: s.url,
  });
  return out;
}

export function install(app) {
  app.object(TYPE, { render: renderPortalSession, expandable: ['configuration'] });
  app.route('POST', '/v1/billing_portal/sessions', (ctx) => createPortalSession(ctx.account, ctx.params, { version: ctx.version }));
}
