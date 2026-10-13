/**
 * PaymentIntents and Charges of invoice payments (docs.stripe.com/api/payment_intents,
 * docs.stripe.com/api/charges), and the simulated outcome of charging a test card.
 *
 * Routes: GET /v1/payment_intents/:id, GET /v1/charges/:id. Both objects are created only by the
 * billing engine through the functions below.
 * Objects: 'payment_intent' and 'charge' in the 2026-08-26.dahlia wire shape; the 2024-06-20 shape
 * adds `invoice` to both (kept privately as `_invoice`, removed at 2025-03-31.basil).
 * `last_payment_error.payment_method` is stored as an ID and rendered as the PaymentMethod.
 *
 * Outcome of a payment attempt, in order:
 *   1. a pending failNextCharge failure for the customer (consumed by the attempt), then
 *   2. the test card behind the PaymentMethod (test_cards.js): succeeds, declines, or, off-session
 *      with a card that needs 3D Secure, requires_action.
 * Events: payment_intent.created, then per attempt charge.succeeded + payment_intent.succeeded,
 * charge.failed + payment_intent.payment_failed, or payment_intent.requires_action;
 * payment_intent.canceled.
 */
import { hashToken } from '../core/ids.js';
import { emitEvent } from '../core/events.js';
import { StripeError, cardError, invalidRequest, resourceMissing } from '../core/errors.js';
import { render } from '../core/render.js';
import { requireCustomer } from '../customers/customers.js';
import { CARD_ERROR_MESSAGES, CARD_ERROR_PARAMS, DECLINE_CODES, cardChargeOutcome, findTestCardAlias } from './test_cards.js';
import { renderBillingDetails, requireAttachedPaymentMethod, testCardOf } from './payment_methods.js';

const GATES = { regulatedStatus: '2024-12-18.acacia', taxId: '2025-04-30.basil', customerAccount: '2025-12-15.clover' };

const docUrl = (code) => `https://docs.stripe.com/error-codes#${code.replace(/_/g, '-')}`;

/** Private module state: failNextCharge queues (customer ID → decline codes). */
function paymentsState(account) {
  return account.moduleState('payments', () => ({ failNext: {} }));
}

const idOf = (ref) => (ref && typeof ref === 'object' ? ref.id : ref ?? null);

/**
 * The next forced failure queued for `customerId` by failNextCharge (a decline code), or null.
 * `consume` removes it: the attempt counts.
 */
function nextForcedFailure(account, customerId, consume) {
  if (!customerId) return null;
  const queues = paymentsState(account).failNext;
  const queue = queues[customerId];
  if (!queue?.length) return null;
  const declineCode = consume ? queue.shift() : queue[0];
  if (!queue.length) delete queues[customerId];
  return declineCode;
}

/** { outcome, code, declineCode } of charging the test card `entry` for `customerId`. */
function attemptOutcome(account, entry, setUp, customerId, { offSession, consume }) {
  const forced = nextForcedFailure(account, customerId, consume);
  if (forced) return { outcome: 'declines', code: 'card_declined', declineCode: forced };
  return entry ? cardChargeOutcome(entry, { offSession, setUp }) : { outcome: 'succeeds', code: null, declineCode: null };
}

const messageOf = (code) => CARD_ERROR_MESSAGES[code] ?? CARD_ERROR_MESSAGES.card_declined;

/**
 * The 402 card_error of a failed payment attempt (docs.stripe.com/testing-use-cases): pass the
 * rendered PaymentIntent and PaymentMethod when the error should carry them. `failure` is a
 * predictChargeFailure() result or { code, declineCode }.
 */
export function cardDeclineError(failure, { charge, paymentIntent, paymentMethod } = {}) {
  const err = cardError({
    code: failure.code,
    declineCode: failure.declineCode ?? undefined,
    message: failure.message ?? messageOf(failure.code),
    param: CARD_ERROR_PARAMS[failure.code],
    charge,
    paymentIntent,
    paymentMethod,
  });
  if (paymentIntent) err.fields.payment_method_type = 'card';
  return err;
}

/**
 * Creates a PaymentIntent in status requires_payment_method (invoice finalization "creates an
 * incomplete payment intent"). Emits payment_intent.created.
 * @param {{amount: number, currency: string, customer: string|object|null, description?: string,
 *   metadata?: object, invoice?: string}} spec  `invoice` is recorded for 2024-06-20 rendering
 * @returns {object} internal PaymentIntent
 */
export function createPaymentIntent(account, spec, { request } = {}) {
  if (!Number.isInteger(spec.amount) || spec.amount < 1) throw new Error(`createPaymentIntent needs a positive integer amount, got ${spec.amount}`);
  const customer = idOf(spec.customer);
  const id = account.mintId('pi');
  const pi = {
    id,
    object: 'payment_intent',
    allowed_payment_method_types: null,
    amount: spec.amount,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: null,
    cancellation_reason: null,
    capture_method: 'automatic',
    client_secret: `${id}_secret_${hashToken(`${id}|client_secret`, 25)}`,
    confirmation_method: 'automatic',
    created: account.time.now(account.time.domainOf(customer)),
    currency: spec.currency,
    customer,
    customer_account: null,
    description: spec.description ?? null,
    excluded_payment_method_types: null,
    last_payment_error: null,
    latest_charge: null,
    livemode: false,
    managed_payments: null,
    metadata: { ...(spec.metadata ?? {}) },
    next_action: null,
    on_behalf_of: null,
    payment_method: null,
    payment_method_configuration_details: null,
    payment_method_options: { card: { installments: null, mandate_options: null, network: null, request_three_d_secure: 'automatic' } },
    payment_method_types: ['card'],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    source: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: 'requires_payment_method',
    transfer_data: null,
    transfer_group: null,
    _invoice: idOf(spec.invoice),
  };
  account.store.insert(pi);
  emitEvent(account, 'payment_intent.created', pi, { request });
  return pi;
}

/** A Charge for one attempt: succeeded, or failed with the decline's code and message. */
function createCharge(account, pi, pm, { succeeded, code = null, declineCode = null }) {
  const reason = declineCode ?? code;
  const outcome = succeeded
    ? { network_status: 'approved_by_network', reason: null, risk_level: 'normal', seller_message: 'Payment complete.', type: 'authorized' }
    : {
        network_status: 'declined_by_network',
        reason,
        risk_level: 'normal',
        seller_message: `The bank returned the decline code \`${reason}\`.`,
        type: 'issuer_declined',
      };
  const card = pm.card;
  return account.store.insert({
    id: account.mintId('ch'),
    object: 'charge',
    amount: pi.amount,
    amount_captured: succeeded ? pi.amount : 0,
    amount_refunded: 0,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: null,
    billing_details: structuredClone(pm.billing_details),
    calculated_statement_descriptor: null,
    captured: succeeded,
    created: account.time.now(account.time.domainOf(pi.customer)),
    currency: pi.currency,
    customer: pi.customer,
    description: pi.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: succeeded ? null : code,
    failure_message: succeeded ? null : messageOf(code),
    fraud_details: {},
    livemode: false,
    metadata: {},
    on_behalf_of: null,
    outcome: { advice_code: null, network_advice_code: null, network_decline_code: null, ...outcome },
    paid: succeeded,
    payment_intent: pi.id,
    payment_method: pm.id,
    payment_method_details: {
      card: {
        amount_authorized: succeeded ? pi.amount : null,
        authorization_code: null,
        brand: card.brand,
        checks: card.checks ? { ...card.checks } : null,
        country: card.country,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
        fingerprint: card.fingerprint,
        funding: card.funding,
        installments: null,
        last4: card.last4,
        mandate: null,
        network: card.brand,
        network_transaction_id: null,
        regulated_status: card.regulated_status,
        three_d_secure: null,
        transaction_link_id: null,
        wallet: null,
      },
      type: 'card',
    },
    receipt_email: null,
    receipt_number: null,
    receipt_url: null,
    refunded: false,
    review: null,
    shipping: null,
    source: null,
    source_transfer: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: succeeded ? 'succeeded' : 'failed',
    transfer_data: null,
    transfer_group: null,
    _invoice: pi._invoice,
  });
}

function unexpectedState(pi, action) {
  return invalidRequest(`This PaymentIntent's status is ${pi.status}, so it cannot be ${action}.`, { code: 'payment_intent_unexpected_state' });
}

/** The PaymentMethod to charge: attached to the PaymentIntent's customer (or any live one without a customer). */
function chargeablePaymentMethod(account, pi, paymentMethod) {
  const id = idOf(paymentMethod);
  if (!id) {
    throw invalidRequest('You cannot confirm this PaymentIntent because it has no payment method.', { code: 'payment_intent_unexpected_state' });
  }
  if (pi.customer) return requireAttachedPaymentMethod(account, id, pi.customer, { param: 'payment_method' });
  const pm = account.store.get('payment_method', id);
  if (!pm) throw resourceMissing('payment_method', id, { param: 'payment_method' });
  if (pm._detached) throw invalidRequest(`The PaymentMethod ${pm.id} was detached from a customer and cannot be used again.`, { param: 'payment_method' });
  return pm;
}

/**
 * Attempts payment with `paymentMethod` (a pm_ ID attached to the PI's customer). `offSession`
 * (default true) is false for hosted pages and Checkout, where the customer is present and
 * completes any 3D Secure authentication.
 * Success: PI succeeded, Charge succeeded. Decline: PI back to requires_payment_method with
 * last_payment_error (payment_method null), Charge failed, and `error` = the 402 card_error to
 * surface. 3DS cards off-session: PI requires_action (next_action use_stripe_sdk), no Charge,
 * `error` code authentication_required.
 * A PaymentMethod that cannot be charged (none, unknown, detached, another customer's) is a
 * failed attempt without a Charge: `error` is the 400 invalid_request_error and the
 * PaymentIntent is unchanged. A PaymentIntent that is not open throws
 * (payment_intent_unexpected_state).
 * `version` (second options) renders the PaymentIntent and PaymentMethod carried by `error`
 * (default: the account's API version).
 * @returns {{ok: true, paymentIntent, charge} | {ok: false, paymentIntent, charge: object|null, error: StripeError}}
 */
export function confirmPaymentIntent(account, paymentIntent, { paymentMethod, offSession = true } = {}, { request, version } = {}) {
  const pi = paymentIntent;
  if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) throw unexpectedState(pi, 'confirmed');
  let pm;
  try {
    pm = chargeablePaymentMethod(account, pi, paymentMethod);
  } catch (err) {
    if (err instanceof StripeError) return { ok: false, paymentIntent: pi, charge: null, error: err };
    throw err;
  }
  const entry = testCardOf(pm);
  const result = attemptOutcome(account, entry, pm._card?.setUp ?? false, pi.customer, { offSession, consume: true });
  const renderVersion = version ?? account.settings.apiVersion;

  if (result.outcome === 'succeeds') {
    const charge = createCharge(account, pi, pm, { succeeded: true });
    Object.assign(pi, {
      status: 'succeeded',
      amount_received: pi.amount,
      latest_charge: charge.id,
      payment_method: pm.id,
      last_payment_error: null,
      next_action: null,
    });
    // A card paid for with the customer present is set up for later off-session charges.
    if (!offSession && pm.customer) pm._card.setUp = true;
    emitEvent(account, 'charge.succeeded', charge, { request });
    emitEvent(account, 'payment_intent.succeeded', pi, { request });
    return { ok: true, paymentIntent: pi, charge };
  }

  if (result.outcome === 'requires_action') {
    Object.assign(pi, {
      status: 'requires_action',
      payment_method: pm.id,
      last_payment_error: null,
      next_action: { type: 'use_stripe_sdk', use_stripe_sdk: {} },
    });
    emitEvent(account, 'payment_intent.requires_action', pi, { request });
    const error = cardDeclineError(result, {
      paymentIntent: render(account, pi, { version: renderVersion }),
      paymentMethod: render(account, pm, { version: renderVersion }),
    });
    return { ok: false, paymentIntent: pi, charge: null, error };
  }

  const charge = createCharge(account, pi, pm, { succeeded: false, code: result.code, declineCode: result.declineCode });
  Object.assign(pi, {
    status: 'requires_payment_method',
    latest_charge: charge.id,
    payment_method: null,
    next_action: null,
    last_payment_error: {
      charge: charge.id,
      code: result.code,
      decline_code: result.declineCode ?? null,
      doc_url: docUrl(result.code),
      message: messageOf(result.code),
      param: CARD_ERROR_PARAMS[result.code] ?? null,
      payment_method: pm.id,
      type: 'card_error',
    },
  });
  emitEvent(account, 'charge.failed', charge, { request });
  emitEvent(account, 'payment_intent.payment_failed', pi, { request });
  const error = cardDeclineError(result, {
    charge: charge.id,
    paymentIntent: render(account, pi, { version: renderVersion }),
    paymentMethod: render(account, pm, { version: renderVersion }),
  });
  return { ok: false, paymentIntent: pi, charge, error };
}

/**
 * Cancels a PaymentIntent (voided invoice: "voiding an invoice will cancel the PaymentIntent").
 * Emits payment_intent.canceled; a canceled one is returned unchanged; a succeeded one cannot be
 * canceled (400 payment_intent_unexpected_state).
 */
export function cancelPaymentIntent(account, paymentIntent, { reason = 'void_invoice' } = {}, { request } = {}) {
  if (paymentIntent.status === 'canceled') return paymentIntent;
  if (paymentIntent.status === 'succeeded') throw unexpectedState(paymentIntent, 'canceled');
  Object.assign(paymentIntent, {
    status: 'canceled',
    canceled_at: account.time.now(account.time.domainOf(paymentIntent.customer)),
    cancellation_reason: reason,
    next_action: null,
  });
  emitEvent(account, 'payment_intent.canceled', paymentIntent, { request });
  return paymentIntent;
}

/**
 * Predicts, without side effects, whether charging `amount` with `paymentMethod` (pm_ ID or
 * alias) for `customer` (ID, object or null) would fail. Checkout uses it to decline before
 * creating anything. `offSession` defaults to false (the customer is on the page).
 * `consume: true` counts the prediction as the payment attempt for failNextCharge: a queued
 * forced failure it reports is used up (pass it when declining on the strength of the result).
 * @returns {null | {code: string, declineCode: string|null, message: string}}
 */
export function predictChargeFailure(account, { paymentMethod, customer, amount, currency, offSession = false, consume = false } = {}) {
  if (!(amount > 0)) return null;
  const id = idOf(paymentMethod);
  const pm = account.store.get('payment_method', id);
  const entry = pm ? testCardOf(pm) : findTestCardAlias(id);
  if (!entry) throw resourceMissing('payment_method', id, { param: 'payment_method' });
  const result = attemptOutcome(account, entry, pm?._card?.setUp ?? false, idOf(customer), { offSession, consume });
  if (result.outcome === 'succeeds') return null;
  return { code: result.code, declineCode: result.declineCode ?? null, message: messageOf(result.code) };
}

/**
 * The failNextCharge control: the next `times` payment attempts for `customerId` fail with
 * card_declined / `declineCode`, whatever the card. Calls add up (a queue per customer).
 * Returns { customer, remaining, declineCode }.
 */
export function failNextCharge(account, customerId, { times = 1, declineCode = 'generic_decline' } = {}) {
  requireCustomer(account, customerId, { param: 'customer' });
  if (!Number.isInteger(times) || times < 1) throw invalidRequest('times must be a positive integer', { param: 'times' });
  if (!DECLINE_CODES.includes(declineCode)) {
    throw invalidRequest(`Unknown decline code: ${declineCode}. Use a card decline code from docs.stripe.com/declines/codes.`, {
      param: 'declineCode',
    });
  }
  const queues = paymentsState(account).failNext;
  const queue = (queues[customerId] ??= []);
  for (let i = 0; i < times; i++) queue.push(declineCode);
  return { customer: customerId, remaining: queue.length, declineCode };
}

// Rendering -------------------------------------------------------------------------------------------

function renderPaymentError(error, ctx) {
  if (!error) return null;
  const out = {};
  if (error.charge) out.charge = error.charge;
  out.code = error.code;
  if (error.decline_code) out.decline_code = error.decline_code;
  out.doc_url = error.doc_url;
  out.message = error.message;
  if (error.param) out.param = error.param;
  const pm = error.payment_method ? ctx.lookup(error.payment_method) : null;
  if (pm) out.payment_method = ctx.render(pm);
  out.type = error.type;
  return out;
}

/** The wire form of a PaymentIntent per version (docs.stripe.com/api/payment_intents/object). */
export function renderPaymentIntent(pi, ctx) {
  const legacy = ctx.family === 'F1';
  const out = { id: pi.id, object: 'payment_intent' };
  if (!legacy) out.allowed_payment_method_types = null;
  Object.assign(out, {
    amount: pi.amount,
    amount_capturable: pi.amount_capturable,
    amount_details: structuredClone(pi.amount_details),
    amount_received: pi.amount_received,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: pi.canceled_at,
    cancellation_reason: pi.cancellation_reason,
    capture_method: pi.capture_method,
    client_secret: pi.client_secret,
    confirmation_method: pi.confirmation_method,
    created: pi.created,
    currency: pi.currency,
    customer: pi.customer,
  });
  if (ctx.atLeast(GATES.customerAccount)) out.customer_account = null;
  out.description = pi.description;
  if (!legacy) out.excluded_payment_method_types = null;
  if (legacy) out.invoice = pi._invoice ?? null;
  out.last_payment_error = renderPaymentError(pi.last_payment_error, ctx);
  out.latest_charge = pi.latest_charge;
  out.livemode = false;
  if (!legacy) out.managed_payments = null;
  return Object.assign(out, {
    metadata: { ...pi.metadata },
    next_action: pi.next_action ? structuredClone(pi.next_action) : null,
    on_behalf_of: null,
    payment_method: pi.payment_method,
    payment_method_configuration_details: null,
    payment_method_options: structuredClone(pi.payment_method_options),
    payment_method_types: [...pi.payment_method_types],
    processing: null,
    receipt_email: null,
    review: null,
    setup_future_usage: null,
    shipping: null,
    source: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: pi.status,
    transfer_data: null,
    transfer_group: null,
  });
}

/** The wire form of a Charge per version (docs.stripe.com/api/charges/object). */
export function renderCharge(ch, ctx) {
  const legacy = ctx.family === 'F1';
  const outcome = {};
  if (!legacy) Object.assign(outcome, { advice_code: null, network_advice_code: null, network_decline_code: null });
  Object.assign(outcome, {
    network_status: ch.outcome.network_status,
    reason: ch.outcome.reason,
    risk_level: ch.outcome.risk_level,
    seller_message: ch.outcome.seller_message,
    type: ch.outcome.type,
  });
  const c = ch.payment_method_details.card;
  const card = {
    amount_authorized: c.amount_authorized,
    authorization_code: c.authorization_code,
    brand: c.brand,
    checks: c.checks ? { ...c.checks } : null,
    country: c.country,
    exp_month: c.exp_month,
    exp_year: c.exp_year,
    fingerprint: c.fingerprint,
    funding: c.funding,
    installments: null,
    last4: c.last4,
    mandate: null,
    network: c.network,
  };
  if (!legacy) card.network_transaction_id = c.network_transaction_id;
  if (ctx.atLeast(GATES.regulatedStatus)) card.regulated_status = c.regulated_status;
  card.three_d_secure = null;
  if (!legacy) card.transaction_link_id = c.transaction_link_id;
  card.wallet = null;

  const out = {
    id: ch.id,
    object: 'charge',
    amount: ch.amount,
    amount_captured: ch.amount_captured,
    amount_refunded: ch.amount_refunded,
    application: null,
    application_fee: null,
    application_fee_amount: null,
    balance_transaction: ch.balance_transaction,
    billing_details: renderBillingDetails(ch.billing_details, ctx),
    calculated_statement_descriptor: ch.calculated_statement_descriptor,
    captured: ch.captured,
    created: ch.created,
    currency: ch.currency,
    customer: ch.customer,
    description: ch.description,
    disputed: false,
    failure_balance_transaction: null,
    failure_code: ch.failure_code,
    failure_message: ch.failure_message,
    fraud_details: {},
  };
  if (legacy) out.invoice = ch._invoice ?? null;
  return Object.assign(out, {
    livemode: false,
    metadata: { ...ch.metadata },
    on_behalf_of: null,
    outcome,
    paid: ch.paid,
    payment_intent: ch.payment_intent,
    payment_method: ch.payment_method,
    payment_method_details: { card, type: 'card' },
    receipt_email: null,
    receipt_number: null,
    receipt_url: ch.receipt_url,
    refunded: ch.refunded,
    review: null,
    shipping: null,
    source: null,
    source_transfer: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: ch.status,
    transfer_data: null,
    transfer_group: null,
  });
}

export function install(app) {
  app.object('payment_intent', {
    render: renderPaymentIntent,
    expandable: ['customer', 'payment_method', 'latest_charge', 'invoice', 'application', 'on_behalf_of', 'review'],
  });
  app.object('charge', {
    render: renderCharge,
    expandable: [
      'customer',
      'payment_intent',
      'invoice',
      'application',
      'application_fee',
      'balance_transaction',
      'failure_balance_transaction',
      'on_behalf_of',
      'review',
      'source_transfer',
    ],
    includable: {
      refunds: (json, ctx) => {
        const refunds = ctx.account.store.list('refund', (r) => r.charge === json.id).sort((a, b) => b.created - a.created || b._seq - a._seq);
        return { object: 'list', data: refunds.slice(0, 10).map((r) => ctx.render(r)), has_more: refunds.length > 10, total_count: refunds.length, url: `/v1/charges/${json.id}/refunds` };
      },
    },
  });

  app.route('GET', '/v1/payment_intents/:id', (ctx) => ctx.account.store.require('payment_intent', ctx.pathParams.id));
  app.route('GET', '/v1/charges/:id', (ctx) => ctx.account.store.require('charge', ctx.pathParams.id));
}

/** Invoice owner asks the payment owner to resize an unpaid PaymentIntent after a credit note. */
export function updateInvoicePaymentIntentAmount(account, pi, amount) {
  if (['succeeded', 'canceled'].includes(pi.status)) throw unexpectedState(pi, 'resized');
  pi.amount = amount;
}

/** Recompute successful/pending refund totals; failed and canceled refunds release capacity. */
export function updateChargeRefunded(account, charge, { request, refundedEvent = false } = {}) {
  charge.amount_refunded = account.store.list('refund', (r) => r.charge === charge.id && !['failed', 'canceled'].includes(r.status)).reduce((sum, r) => sum + r.amount, 0);
  charge.refunded = charge.amount_refunded === charge.amount;
  if (refundedEvent) emitEvent(account, 'charge.refunded', charge, { request });
}
