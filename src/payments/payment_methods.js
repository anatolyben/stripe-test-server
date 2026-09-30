/**
 * Card PaymentMethods (docs.stripe.com/api/payment_methods), made only from Stripe's test cards.
 *
 * Routes: POST /v1/payment_methods/:id/attach, POST /v1/payment_methods/:id/detach,
 * GET /v1/payment_methods/:id, GET /v1/payment_methods, GET /v1/customers/:customer/payment_methods,
 * GET /v1/customers/:customer/payment_methods/:id.
 *
 * Where PaymentMethods come from:
 *   - `pm_card_*` aliases: attaching one (or retrieving it) mints a new PaymentMethod, as in
 *     Stripe's Billing testing recipe ("With the resulting Payment Method ID, create the subscription").
 *   - card numbers typed on hosted pages: createCardPaymentMethod().
 * Internal object: the 2026-08-26.dahlia wire shape, `customer` as ID or null, plus `_card`
 * ({ number, setUp }: the test card and whether it was saved on-session) and `_detached`
 * (detaching is permanent). Version gates: `card.regulated_status` from 2024-12-18.acacia,
 * `billing_details.tax_id` from 2025-04-30.basil, `customer_account` from 2025-12-15.clover.
 * Events: payment_method.attached, payment_method.detached (no customer.updated on attach).
 * Hook run after a detach: 'payment_method.detached' (account, pm, { customer, request }), so
 * billing can clear subscription defaults that pointed at the card.
 */
import { hashToken } from '../core/ids.js';
import { emitEvent } from '../core/events.js';
import { cardError, invalidParam, invalidRequest, resourceMissing } from '../core/errors.js';
import { paginate } from '../core/list.js';
import { changeCustomer, requireCustomer } from '../customers/customers.js';
import { CARD_ERROR_MESSAGES, CARD_ERROR_PARAMS, findTestCard, findTestCardAlias } from './test_cards.js';

/** Expiry of alias-minted cards and of hosted-page cards typed without one ("a valid future date, such as 12/34"). */
export const DEFAULT_EXPIRY = Object.freeze({ month: 12, year: 2034 });

const DISPLAY_BRANDS = { amex: 'american_express', diners: 'diners_club', unionpay: 'union_pay' };

const GATES = { regulatedStatus: '2024-12-18.acacia', taxId: '2025-04-30.basil', customerAccount: '2025-12-15.clover' };

/** The test-card entry behind a PaymentMethod. */
export function testCardOf(paymentMethod) {
  return paymentMethod?._card ? findTestCard(paymentMethod._card.number) : null;
}

/** 402 card_error for a card field problem (incorrect_number, invalid_expiry_month, ...). */
export function cardFieldError(code) {
  return cardError({ code, message: CARD_ERROR_MESSAGES[code], param: CARD_ERROR_PARAMS[code] });
}

/** 402 card_error of an issuer-decline card that cannot be attached (no charge is involved). */
function attachDeclineError(entry) {
  return cardError({
    code: entry.code,
    declineCode: entry.declineCode ?? undefined,
    message: CARD_ERROR_MESSAGES[entry.code] ?? CARD_ERROR_MESSAGES.card_declined,
    param: CARD_ERROR_PARAMS[entry.code],
  });
}

/** Stores a new, unattached card PaymentMethod for a test card (no event: Stripe has none). */
function mintCardPaymentMethod(account, entry, { expMonth, expYear, cvcCheck, name = null, email = null, allowRedisplay, setUp, domain = null }) {
  return account.store.insert({
    id: account.mintId('pm'),
    object: 'payment_method',
    allow_redisplay: allowRedisplay,
    billing_details: {
      address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
      email,
      name,
      phone: null,
      tax_id: null,
    },
    card: {
      brand: entry.brand,
      checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: cvcCheck },
      country: entry.country,
      display_brand: DISPLAY_BRANDS[entry.brand] ?? entry.brand,
      exp_month: expMonth,
      exp_year: expYear,
      fingerprint: hashToken(`card-fingerprint|${entry.number}`, 16),
      funding: entry.funding,
      generated_from: null,
      last4: entry.last4,
      networks: { available: [entry.brand], preferred: null },
      regulated_status: null,
      three_d_secure_usage: { supported: entry.threeDSecureSupported },
      wallet: null,
    },
    created: account.time.now(domain),
    customer: null,
    customer_account: null,
    livemode: false,
    metadata: {},
    type: 'card',
    _card: { number: entry.number, setUp },
    _detached: false,
  });
}

/** A PaymentMethod minted from an alias (the docs' alias examples show cvc_check "pass"). */
function mintFromAlias(account, entry, domain = null) {
  return mintCardPaymentMethod(account, entry, {
    expMonth: DEFAULT_EXPIRY.month,
    expYear: DEFAULT_EXPIRY.year,
    cvcCheck: 'pass',
    allowRedisplay: 'unspecified',
    setUp: false,
    domain,
  });
}

const present = (v) => v !== undefined && v !== null && v !== '';

/** Expiry month/year typed on a hosted page (2-digit years allowed) → [month, year], or a 402. */
function parseExpiry(account, monthValue, yearValue) {
  if (!present(monthValue) && !present(yearValue)) return [DEFAULT_EXPIRY.month, DEFAULT_EXPIRY.year];
  const month = /^\d{1,2}$/.test(String(monthValue ?? '').trim()) ? Number(String(monthValue).trim()) : NaN;
  if (!(month >= 1 && month <= 12)) throw cardFieldError('invalid_expiry_month');
  const yearText = String(yearValue ?? '').trim();
  if (!/^(\d{2}|\d{4})$/.test(yearText)) throw cardFieldError('invalid_expiry_year');
  const today = new Date(account.time.now() * 1000);
  const thisYear = today.getUTCFullYear();
  let year = Number(yearText);
  if (yearText.length === 2) {
    year += 2000;
    if (year > thisYear + 50) year -= 100;
  }
  if (year < thisYear) throw cardFieldError('invalid_expiry_year');
  if (year === thisYear && month < today.getUTCMonth() + 1) throw cardFieldError('invalid_expiry_month');
  return [month, year];
}

/**
 * Creates an unattached card PaymentMethod from a test card typed on a hosted page (a number or
 * an alias). Throws 402 card_error for numbers that are not test cards (incorrect_number) and for
 * invalid expiry dates or CVCs ("Trigger an error with invalid data", docs.stripe.com/testing).
 * Hosted-page cards count as set up for off-session use and default to allow_redisplay
 * 'limited', as cards saved by Checkout are.
 * @param {{number: string, expMonth?: number|string, expYear?: number|string, cvc?: string, name?: string, email?: string}} card
 * @returns {object} the internal PaymentMethod
 */
export function createCardPaymentMethod(account, card = {}, { request, allowRedisplay = 'limited' } = {}) {
  const entry = findTestCard(card.number);
  if (!entry) throw cardFieldError('incorrect_number');
  const [expMonth, expYear] = parseExpiry(account, card.expMonth, card.expYear);
  const cvc = present(card.cvc) ? String(card.cvc).trim() : null;
  if (cvc !== null && !/^\d{3,4}$/.test(cvc)) throw cardFieldError('invalid_cvc');
  return mintCardPaymentMethod(account, entry, {
    expMonth,
    expYear,
    cvcCheck: cvc === null ? null : 'pass',
    name: present(card.name) ? String(card.name) : null,
    email: present(card.email) ? String(card.email) : null,
    allowRedisplay,
    setUp: true,
  });
}

function resolveCustomer(account, customer) {
  return typeof customer === 'string' ? requireCustomer(account, customer, { param: 'customer' }) : customer;
}

/**
 * Attaches a PaymentMethod to `customer` (an internal customer or a cus_ ID). `ref` is a pm_ ID
 * or a test alias (pm_card_visa, …); an alias mints a new PaymentMethod on every attach.
 * Attaching to the customer it already belongs to returns it unchanged. Emits
 * payment_method.attached.
 * Errors: unknown ID → resource_missing on `param` (404 for 'id'); a card that simulates an
 * issuer decline → 402 card_error ("You can't attach cards that simulate issuer declines");
 * attached elsewhere or detached → 400 invalid_request_error.
 * @returns {object} the internal PaymentMethod
 */
export function attachPaymentMethod(account, ref, customer, { param = 'payment_method', request } = {}) {
  const target = resolveCustomer(account, customer);
  let pm = account.store.get('payment_method', ref);
  if (!pm) {
    const entry = findTestCardAlias(ref);
    if (!entry) throw resourceMissing('payment_method', ref, { param });
    if (!entry.attachable) throw attachDeclineError(entry);
    pm = mintFromAlias(account, entry, account.time.domainOf(target));
  } else {
    if (pm._detached) {
      throw invalidRequest(`The PaymentMethod ${pm.id} was detached from a customer and cannot be used again.`);
    }
    if (pm.customer === target.id) return pm;
    if (pm.customer) throw invalidRequest(`The PaymentMethod ${pm.id} is already attached to another customer.`);
    const entry = testCardOf(pm);
    if (entry && !entry.attachable) throw attachDeclineError(entry);
  }
  pm.customer = target.id;
  emitEvent(account, 'payment_method.attached', pm, { request });
  return pm;
}

function notAttachedError(id) {
  return invalidRequest(`The PaymentMethod ${id} is not attached to a customer, so it cannot be detached.`);
}

/**
 * Detaches a PaymentMethod ("Detachment is permanent and irreversible"): customer → null.
 * Emits payment_method.detached, then customer.updated when it was the customer's
 * invoice_settings.default_payment_method (now cleared), then runs the
 * 'payment_method.detached' hook.
 */
export function detachPaymentMethod(account, paymentMethod, { request } = {}) {
  if (!paymentMethod.customer) throw notAttachedError(paymentMethod.id);
  const customerId = paymentMethod.customer;
  const domain = account.time.domainOf(customerId);
  paymentMethod.customer = null;
  paymentMethod._detached = true;
  emitEvent(account, 'payment_method.detached', paymentMethod, { request, domain });
  const customer = account.store.get('customer', customerId);
  if (customer && !customer._deleted && customer.invoice_settings?.default_payment_method === paymentMethod.id) {
    changeCustomer(
      account,
      customer,
      (c) => {
        c.invoice_settings.default_payment_method = null;
      },
      { request },
    );
  }
  account.server.registry.runHooks('payment_method.detached', account, paymentMethod, { customer: customerId, request });
  return paymentMethod;
}

/**
 * A PaymentMethod attached to `customer` (internal customer or cus_ ID), for params such as
 * default_payment_method. Unknown → 400 resource_missing on `param`; an alias or a PaymentMethod
 * not attached to this customer → 400 invalid_request_error on `param`.
 * @returns {object} the internal PaymentMethod
 */
export function requireAttachedPaymentMethod(account, id, customer, { param }) {
  const customerId = typeof customer === 'string' ? customer : customer?.id ?? null;
  const pm = account.store.get('payment_method', id);
  if (!pm && !findTestCardAlias(id)) throw resourceMissing('payment_method', id, { param });
  if (!pm || pm.customer !== customerId || pm._detached) {
    throw invalidRequest(`The customer does not have a payment method with the ID ${id}. The payment method must be attached to the customer.`, {
      param,
    });
  }
  return pm;
}

// Rendering -----------------------------------------------------------------------------------------

/** billing_details in the version's shape (shared with charges). */
export function renderBillingDetails(details, ctx) {
  const out = {
    address: details.address ? { ...details.address } : null,
    email: details.email,
    name: details.name,
    phone: details.phone,
  };
  if (ctx.atLeast(GATES.taxId)) out.tax_id = details.tax_id ?? null;
  return out;
}

function renderCard(card, ctx) {
  const out = {
    brand: card.brand,
    checks: card.checks ? { ...card.checks } : null,
    country: card.country,
    display_brand: card.display_brand,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
    fingerprint: card.fingerprint,
    funding: card.funding,
    generated_from: null,
    last4: card.last4,
    networks: { available: [...card.networks.available], preferred: card.networks.preferred },
  };
  if (ctx.atLeast(GATES.regulatedStatus)) out.regulated_status = card.regulated_status;
  out.three_d_secure_usage = { ...card.three_d_secure_usage };
  out.wallet = null;
  return out;
}

/** The wire form of a PaymentMethod (the docs' 4242 example, per version). */
export function renderPaymentMethod(pm, ctx) {
  const out = {
    id: pm.id,
    object: 'payment_method',
    allow_redisplay: pm.allow_redisplay,
    billing_details: renderBillingDetails(pm.billing_details, ctx),
    card: renderCard(pm.card, ctx),
    created: pm.created,
    customer: pm.customer,
  };
  if (ctx.atLeast(GATES.customerAccount)) out.customer_account = null;
  out.livemode = false;
  out.metadata = { ...pm.metadata };
  out.type = 'card';
  return out;
}

/** A list of PaymentMethods, newest first, filtered by `type` and `allow_redisplay`. */
function listPaymentMethods(account, params, predicate, url) {
  const pms = account.store.list(
    'payment_method',
    (pm) =>
      predicate(pm) &&
      (params.type === undefined || pm.type === params.type) &&
      (params.allow_redisplay === undefined || pm.allow_redisplay === params.allow_redisplay),
  );
  return paginate(pms, params, { url, noun: 'payment_method', find: (id) => account.store.get('payment_method', id) });
}

export function install(app) {
  app.object('payment_method', { render: renderPaymentMethod, expandable: ['customer'] });

  // Deleting a customer "removes card details": its PaymentMethods are detached, silently.
  app.hook('customer.deleting', (account, customer) => {
    for (const pm of account.store.list('payment_method', (p) => p.customer === customer.id)) {
      pm.customer = null;
      pm._detached = true;
    }
  });

  app.route('POST', '/v1/payment_methods/:id/attach', (ctx) => {
    const { account, params } = ctx;
    const ref = ctx.pathParams.id;
    if (!account.store.get('payment_method', ref) && !findTestCardAlias(ref)) throw resourceMissing('payment_method', ref);
    if (params.customer_account !== undefined) {
      throw invalidParam('customer_account', 'customer_account (Accounts v2) is not supported by this test server; attach to a customer instead.');
    }
    const customer = requireCustomer(account, params.customer, { param: 'customer' });
    return attachPaymentMethod(account, ref, customer, { param: 'id' });
  });

  app.route('POST', '/v1/payment_methods/:id/detach', (ctx) => {
    const pm = ctx.account.store.get('payment_method', ctx.pathParams.id);
    if (!pm) {
      if (findTestCardAlias(ctx.pathParams.id)) throw notAttachedError(ctx.pathParams.id);
      throw resourceMissing('payment_method', ctx.pathParams.id);
    }
    return detachPaymentMethod(ctx.account, pm);
  });

  app.route('GET', '/v1/payment_methods/:id', (ctx) => {
    const { account } = ctx;
    const pm = account.store.get('payment_method', ctx.pathParams.id);
    if (pm) return pm;
    // An alias used on its own behaves like a fresh, unattached PaymentMethod.
    const entry = findTestCardAlias(ctx.pathParams.id);
    if (!entry) throw resourceMissing('payment_method', ctx.pathParams.id);
    return mintFromAlias(account, entry);
  });

  app.route('GET', '/v1/payment_methods', (ctx) => {
    const { account, params } = ctx;
    // customer_account (Accounts v2) holds no PaymentMethods here.
    if (params.customer_account !== undefined) return listPaymentMethods(account, params, () => false, '/v1/payment_methods');
    if (params.customer !== undefined) {
      const customer = requireCustomer(account, params.customer, { param: 'customer' });
      return listPaymentMethods(account, params, (pm) => pm.customer === customer.id, '/v1/payment_methods');
    }
    return listPaymentMethods(account, params, () => true, '/v1/payment_methods');
  });

  app.route('GET', '/v1/customers/:customer/payment_methods', (ctx) => {
    const customer = ctx.account.store.require('customer', ctx.pathParams.customer);
    return listPaymentMethods(ctx.account, ctx.params, (pm) => pm.customer === customer.id, `/v1/customers/${customer.id}/payment_methods`);
  });

  app.route('GET', '/v1/customers/:customer/payment_methods/:id', (ctx) => {
    const customer = ctx.account.store.require('customer', ctx.pathParams.customer);
    const pm = ctx.account.store.get('payment_method', ctx.pathParams.id);
    if (!pm || pm.customer !== customer.id) throw resourceMissing('payment_method', ctx.pathParams.id);
    return pm;
  });
}
