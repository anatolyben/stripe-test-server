/**
 * Customers — the reference resource: other modules follow its pattern (ARCHITECTURE.md,
 * "Adding a resource").
 *
 * Routes: POST/GET /v1/customers, GET/POST/DELETE /v1/customers/:id.
 * Internal object: the 2026-08-26.dahlia wire shape (docs.stripe.com/api/customers/object) with IDs
 * for references, plus `_deleted` (a deleted customer stays retrievable as a stub).
 * Events: customer.created, customer.updated (previous_attributes), customer.deleted (the full
 * customer). Cross-module calls: payments (attach / default PM), the 'customer.deleting' hook.
 */
import { createHash } from 'node:crypto';
import { emitEvent, updateWithEvent } from '../core/events.js';
import { invalidRequest, resourceMissing } from '../core/errors.js';
import { paginate, matchesRange } from '../core/list.js';
import { raw } from '../core/render.js';
import { applyMetadata, mergeHash, normalizeAddress, unsetToNull } from '../core/util.js';
import { attachPaymentMethod, requireAttachedPaymentMethod } from '../payments/payment_methods.js';

/** Most customers a test clock can hold (docs.stripe.com/billing/testing/test-clocks/api-advanced-usage). */
export const MAX_CUSTOMERS_PER_CLOCK = 3;

const INVOICE_PREFIX = /^[A-Z0-9]{3,12}$/;

function generatedInvoicePrefix(id) {
  return createHash('sha256').update(id).digest('hex').slice(0, 8).toUpperCase();
}

function legacyUnsupported(param) {
  return invalidRequest(`The ${param} parameter (legacy Sources) is not supported by this test server; use PaymentMethods instead.`, { param });
}

function normalizeShipping(sent) {
  if (sent === undefined) return undefined;
  if (sent === '') return null;
  return { address: normalizeAddress(sent.address), name: sent.name ?? null, phone: unsetToNull(sent.phone) ?? null };
}

function normalizeRenderingOptions(sent) {
  if (sent === '' || sent === null) return null;
  return { amount_tax_display: unsetToNull(sent.amount_tax_display) ?? null, template: unsetToNull(sent.template) ?? null };
}

/**
 * The live customer `id`, or resource_missing: 404 for a path ID (param 'id'), else 400 with
 * `param`. Deleted customers count as missing.
 */
export function requireCustomer(account, id, { param = 'customer' } = {}) {
  return account.store.require('customer', id, { param });
}

function checkInvoicePrefix(account, prefix, self) {
  if (!INVOICE_PREFIX.test(prefix)) {
    throw invalidRequest('Invalid invoice_prefix: must be 3–12 uppercase letters or numbers.', { param: 'invoice_prefix' });
  }
  const taken = account.store.list('customer', (c) => c.id !== self.id && !c._deleted && c.invoice_prefix === prefix);
  if (taken.length) throw invalidRequest(`The invoice prefix ${prefix} is already in use by another customer.`, { param: 'invoice_prefix' });
}

function checkTestClock(account, clockId) {
  const clock = account.store.get('test_helpers.test_clock', clockId);
  if (!clock || clock._deleted) throw resourceMissing('test_helpers.test_clock', clockId, { param: 'test_clock' });
  const members = account.store.list('customer', (c) => !c._deleted && c.test_clock === clockId);
  if (members.length >= MAX_CUSTOMERS_PER_CLOCK) {
    throw invalidRequest(`The test clock ${clockId} already has the maximum of ${MAX_CUSTOMERS_PER_CLOCK} customers.`, { param: 'test_clock' });
  }
}

/** Fields shared by create and update that map one-to-one onto the object. */
function applyCommonFields(account, customer, params) {
  for (const key of ['description', 'email', 'name', 'phone', 'business_name', 'individual_name']) {
    if (params[key] !== undefined) customer[key] = unsetToNull(params[key]);
  }
  if (params.address !== undefined) {
    customer.address = params.address === '' ? null : normalizeAddress(mergeHash(customer.address, params.address));
  }
  if (params.shipping !== undefined) customer.shipping = normalizeShipping(params.shipping);
  if (params.balance !== undefined) customer.balance = params.balance;
  if (params.preferred_locales !== undefined) customer.preferred_locales = params.preferred_locales === '' ? [] : params.preferred_locales;
  if (params.tax_exempt !== undefined) customer.tax_exempt = params.tax_exempt === '' ? 'none' : params.tax_exempt;
  if (params.next_invoice_sequence !== undefined) {
    if (params.next_invoice_sequence < 1) {
      throw invalidRequest('next_invoice_sequence must be at least 1', { param: 'next_invoice_sequence' });
    }
    customer.next_invoice_sequence = params.next_invoice_sequence;
  }
  if (params.invoice_prefix !== undefined) {
    checkInvoicePrefix(account, params.invoice_prefix, customer);
    customer.invoice_prefix = params.invoice_prefix;
  }
  customer.metadata = applyMetadata(customer.metadata, params.metadata);
  if (params.source !== undefined && params.source !== '') throw legacyUnsupported('source');
  for (const legacy of ['bank_account', 'card', 'default_alipay_account', 'default_bank_account', 'default_card']) {
    if (params[legacy] !== undefined) throw legacyUnsupported(legacy);
  }
  if (params.default_source !== undefined) {
    if (params.default_source !== '') throw resourceMissing('source', params.default_source, { param: 'default_source' });
    customer.default_source = null;
  }
  for (const coupon of ['coupon', 'promotion_code']) {
    if (params[coupon] !== undefined && params[coupon] !== '') throw resourceMissing(coupon, params[coupon], { param: coupon });
  }
}

/** Applies invoice_settings (except default_payment_method, which needs the PM checks). */
function applyInvoiceSettings(customer, sent) {
  if (sent === undefined) return;
  const s = customer.invoice_settings;
  if (sent.custom_fields !== undefined) s.custom_fields = sent.custom_fields === '' ? null : sent.custom_fields.map((f) => ({ name: f.name, value: f.value }));
  if (sent.footer !== undefined) s.footer = unsetToNull(sent.footer);
  if (sent.rendering_options !== undefined) s.rendering_options = normalizeRenderingOptions(sent.rendering_options);
}

/**
 * Creates a customer from validated POST /v1/customers params (other modules pass the same shape,
 * e.g. Checkout: { email, name }). When `payment_method` is given, payment_method.attached is
 * emitted first (the card is attached while the customer is built), then customer.created.
 */
export function createCustomer(account, params = {}, { request } = {}) {
  if (params.test_clock) checkTestClock(account, params.test_clock);
  // Without test_clock, the 'customer.creating' hook may still choose one (testClockPerCustomer).
  const placement = { testClock: params.test_clock ?? null };
  if (!placement.testClock) account.server.registry.runHooks('customer.creating', account, placement, { request });
  const domain = placement.testClock && account.time.clocks.has(placement.testClock) ? placement.testClock : null;
  const id = account.mintId('cus');
  const customer = {
    id,
    object: 'customer',
    address: null,
    balance: 0,
    business_name: null,
    created: account.time.now(domain),
    currency: null,
    default_source: null,
    delinquent: false,
    description: null,
    discount: null,
    email: null,
    individual_name: null,
    invoice_prefix: generatedInvoicePrefix(id),
    invoice_settings: { custom_fields: null, default_payment_method: null, footer: null, rendering_options: null },
    livemode: false,
    metadata: {},
    name: null,
    next_invoice_sequence: 1,
    phone: null,
    preferred_locales: [],
    shipping: null,
    tax_exempt: 'none',
    test_clock: placement.testClock,
    _deleted: false,
  };
  applyCommonFields(account, customer, params);
  applyInvoiceSettings(customer, params.invoice_settings);
  const defaultPm = params.invoice_settings?.default_payment_method;
  // A new customer has no payment methods yet, so the default can only be the one attached in this
  // same request (payment_method=pm_card_visa + invoice_settings[default_payment_method]=pm_card_visa
  // resolve to one new PaymentMethod).
  if (defaultPm !== undefined && defaultPm !== '' && defaultPm !== params.payment_method) {
    throw invalidRequest(`The customer does not have a payment method with the ID ${defaultPm}. The payment method must be attached to the customer.`, {
      param: 'invoice_settings[default_payment_method]',
    });
  }
  account.store.insert(customer);
  if (params.payment_method) {
    let pm;
    try {
      pm = attachPaymentMethod(account, params.payment_method, customer, { param: 'payment_method', request });
    } catch (err) {
      account.store.remove('customer', customer.id);
      throw err;
    }
    if (defaultPm !== undefined && defaultPm !== '') customer.invoice_settings.default_payment_method = pm.id;
  }
  emitEvent(account, 'customer.created', customer, { request });
  return customer;
}

/**
 * Updates a customer from validated POST /v1/customers/:id params; emits customer.updated with
 * previous_attributes when anything visible changed.
 */
export function updateCustomer(account, customer, params = {}, { request } = {}) {
  // Apply to a draft first so a rejected param leaves the customer untouched.
  const draft = structuredClone(customer);
  applyCommonFields(account, draft, params);
  applyInvoiceSettings(draft, params.invoice_settings);
  const sentDefault = params.invoice_settings?.default_payment_method;
  if (sentDefault !== undefined) {
    draft.invoice_settings.default_payment_method =
      sentDefault === '' ? null : requireAttachedPaymentMethod(account, sentDefault, customer, { param: 'invoice_settings[default_payment_method]' }).id;
  }
  updateWithEvent(account, customer, 'customer.updated', (c) => Object.assign(c, draft), { request });
  return customer;
}

/**
 * Applies `mutate(customer)` for another module (currency, delinquent, balance, default PM,
 * next_invoice_sequence, ...) and emits customer.updated when something visible changed, unless
 * `silent` (a change Stripe does not announce). Returns true when something visible changed.
 */
export function changeCustomer(account, customer, mutate, { request, silent = false } = {}) {
  if (silent) {
    mutate(customer);
    return true;
  }
  return updateWithEvent(account, customer, 'customer.updated', mutate, { request });
}

/**
 * Deletes a customer (docs.stripe.com/api/customers/delete): runs the 'customer.deleting' hook (billing
 * cancels subscriptions, emitting customer.subscription.deleted), emits customer.deleted with the
 * full customer, then keeps a stub. Returns the deleted stub.
 */
export function deleteCustomer(account, customer, { request } = {}) {
  account.server.registry.runHooks('customer.deleting', account, customer, { request });
  emitEvent(account, 'customer.deleted', customer, { request });
  customer._deleted = true;
  return { id: customer.id, object: 'customer', deleted: true };
}

/** The wire form of a customer (the fields the API reference shows by default; 2024-06-20 adds `discount`). */
export function renderCustomer(c, ctx) {
  if (c._deleted) return { id: c.id, object: 'customer', deleted: true };
  const out = {
    id: c.id,
    object: 'customer',
    address: structuredClone(c.address),
    balance: c.balance,
    created: c.created,
    currency: c.currency,
    default_source: c.default_source,
    delinquent: c.delinquent,
    description: c.description,
  };
  if (ctx.family === 'F1') out.discount = c.discount ?? null;
  Object.assign(out, {
    email: c.email,
    invoice_prefix: c.invoice_prefix,
    invoice_settings: structuredClone(c.invoice_settings),
    livemode: false,
    metadata: { ...c.metadata },
    name: c.name,
    next_invoice_sequence: c.next_invoice_sequence,
    phone: c.phone,
    preferred_locales: [...c.preferred_locales],
    shipping: structuredClone(c.shipping),
    tax_exempt: c.tax_exempt,
    test_clock: c.test_clock,
  });
  if (ctx.family === 'F3') {
    if (c.business_name) out.business_name = c.business_name;
    if (c.individual_name) out.individual_name = c.individual_name;
  }
  return out;
}

const emptyList = (url) => ({ object: 'list', data: [], has_more: false, url });

export function install(app) {
  app.object('customer', {
    render: renderCustomer,
    expandable: ['default_source', 'test_clock', 'invoice_settings.default_payment_method'],
    includable: {
      subscriptions: (json, ctx) => {
        const subs = ctx.account.store
          .list('subscription', (s) => s.customer === json.id && !['canceled', 'incomplete_expired'].includes(s.status))
          .sort((a, b) => b.created - a.created || b._seq - a._seq);
        return { object: 'list', data: subs.map((s) => ctx.render(s)), has_more: false, url: `/v1/customers/${json.id}/subscriptions` };
      },
      sources: (json) => emptyList(`/v1/customers/${json.id}/sources`),
      tax_ids: (json) => emptyList(`/v1/customers/${json.id}/tax_ids`),
      tax: (json, ctx) => {
        const tax = { automatic_tax: 'unrecognized_location', ip_address: null, location: null };
        if (ctx.family === 'F3') tax.provider = 'stripe';
        return tax;
      },
      cash_balance: () => null,
      invoice_credit_balance: () => ({}),
    },
  });

  app.route('POST', '/v1/customers', (ctx) => createCustomer(ctx.account, ctx.params));

  app.route('GET', '/v1/customers/:id', (ctx) => {
    const customer = ctx.account.store.get('customer', ctx.pathParams.id);
    if (!customer) throw resourceMissing('customer', ctx.pathParams.id);
    return customer._deleted ? raw({ id: customer.id, object: 'customer', deleted: true }) : customer;
  });

  app.route('POST', '/v1/customers/:id', (ctx) => {
    const customer = ctx.account.store.require('customer', ctx.pathParams.id);
    return updateCustomer(ctx.account, customer, ctx.params);
  });

  app.route('DELETE', '/v1/customers/:id', (ctx) => {
    const customer = ctx.account.store.require('customer', ctx.pathParams.id);
    return raw(deleteCustomer(ctx.account, customer));
  });

  app.route('GET', '/v1/customers', (ctx) => {
    const { params, account } = ctx;
    const customers = account.store.list('customer', (c) => {
      if (c._deleted) return false;
      if (params.test_clock !== undefined ? c.test_clock !== params.test_clock : c.test_clock) return false;
      if (params.email !== undefined && c.email !== params.email) return false;
      return matchesRange(c.created, params.created);
    });
    return paginate(customers, params, { url: '/v1/customers', noun: 'customer', find: (id) => account.store.get('customer', id) });
  });
}
