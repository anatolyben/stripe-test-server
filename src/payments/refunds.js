/** Card refunds and deterministic refund failures; all events use the shared event bus. */
import { emitEvent, updateWithEvent } from '../core/events.js';
import { invalidParam, invalidRequest, parameterMissing, parametersExclusive } from '../core/errors.js';
import { matchesRange, paginate } from '../core/list.js';
import { applyMetadata } from '../core/util.js';
import { requireCustomer } from '../customers/customers.js';
import { nowOf } from '../billing/util.js';
import { updateChargeRefunded } from './payment_intents.js';

const FAILURE_REASONS = ['declined', 'expired_or_canceled_card', 'insufficient_funds', 'lost_or_stolen_card', 'unknown'];
const stateOf = (account) => account.moduleState('refunds', () => ({ failNext: {} }));

/** Resolve and validate without consuming a failure or changing state (also used by previews). */
export function prepareRefund(account, p) {
  if (p.charge && p.payment_intent) throw parametersExclusive(['charge', 'payment_intent'], { param: 'payment_intent' });
  if (!p.charge && !p.payment_intent) throw parameterMissing('charge');
  let charge;
  if (p.charge) charge = account.store.require('charge', p.charge, { param: 'charge' });
  else {
    const pi = account.store.require('payment_intent', p.payment_intent, { param: 'payment_intent' });
    if (pi.status !== 'succeeded' || !pi.latest_charge) throw invalidRequest('PaymentIntent has no successful charge to refund.', { param: 'payment_intent' });
    charge = account.store.require('charge', pi.latest_charge, { param: 'payment_intent' });
  }
  if (!charge.paid || !charge.captured) throw invalidRequest('Only successful captured charges can be refunded.', { param: 'charge' });
  const reserved = account.store.list('refund', (r) => r.charge === charge.id && !['failed', 'canceled'].includes(r.status)).reduce((n, r) => n + r.amount, 0);
  const available = charge.amount_captured - reserved;
  if (available <= 0) throw invalidRequest('Charge has already been refunded.', { code: 'charge_already_refunded' });
  const amount = p.amount ?? available;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > available) throw invalidParam('amount', 'Refund amount must be positive and no greater than the unrefunded amount.');
  return { charge, amount, reason: p.reason ?? null, metadata: applyMetadata({}, p.metadata) };
}

/** Inserts a validated refund. A queued failure goes pending → failed during this call. */
export function createRefund(account, p, { request } = {}) {
  for (const key of Object.keys(p)) if (!['charge', 'payment_intent', 'amount', 'reason', 'metadata', 'expand'].includes(key)) throw invalidRequest(`Refund parameter ${key} is not modelled.`, { param: key });
  const prepared = prepareRefund(account, p);
  const { charge, amount, reason, metadata } = prepared;
  const queue = stateOf(account).failNext[charge.customer];
  const failure = queue?.shift() ?? null;
  const refund = account.store.insert({
    id: account.mintId('re'), object: 'refund', amount, balance_transaction: null,
    charge: charge.id, created: nowOf(account, charge), currency: charge.currency,
    customer: charge.customer, customer_account: null, payment_method: charge.payment_method,
    metadata, payment_intent: charge.payment_intent, reason, receipt_number: null,
    source_transfer_reversal: null, transfer_reversal: null,
    status: failure ? 'pending' : 'succeeded', _failureReason: null,
  });
  emitEvent(account, 'refund.created', refund, { request, domain: account.time.domainOf(charge) });
  if (failure) {
    updateWithEvent(account, refund, 'refund.updated', () => {
      refund.status = 'failed';
      refund._failureReason = failure;
    }, { request, domain: account.time.domainOf(charge) });
    emitEvent(account, 'refund.failed', refund, { request, domain: account.time.domainOf(charge) });
  } else updateChargeRefunded(account, charge, { request, refundedEvent: true });
  return refund;
}

export function updateRefund(account, refund, p, { request } = {}) {
  for (const key of Object.keys(p)) if (!['metadata', 'expand'].includes(key)) throw invalidRequest(`Refund parameter ${key} is not modelled.`, { param: key });
  updateWithEvent(account, refund, 'refund.updated', () => {
    if (p.metadata !== undefined) refund.metadata = applyMetadata(refund.metadata, p.metadata);
  }, { request });
  return refund;
}

export function cancelRefund(account, refund, { request } = {}) {
  // docs.stripe.com/api/refunds/cancel: only requires_action refunds can be canceled.
  if (refund.status !== 'requires_action') throw invalidRequest('Only refunds requiring customer action can be canceled.');
  updateWithEvent(account, refund, 'refund.updated', () => {
    refund.status = 'canceled';
    refund._failureReason = 'merchant_request';
  }, { request });
  updateChargeRefunded(account, account.store.get('charge', refund.charge), { request });
  return refund;
}

export function failNextRefund(account, customerId, { times = 1, failureReason = 'declined' } = {}) {
  requireCustomer(account, customerId);
  if (!Number.isSafeInteger(times) || times < 1) throw invalidParam('times', 'times must be a positive integer.');
  if (!FAILURE_REASONS.includes(failureReason)) throw invalidParam('failureReason', 'Unknown refund failure reason.');
  const queue = stateOf(account).failNext[customerId] ??= [];
  for (let i = 0; i < times; i++) queue.push(failureReason);
  return { customer: customerId, remaining: queue.length, failureReason };
}

export function renderRefund(r, ctx) {
  const out = {
    id: r.id, object: 'refund', amount: r.amount, balance_transaction: null,
    charge: r.charge, created: r.created, currency: r.currency,
    metadata: { ...r.metadata }, payment_intent: r.payment_intent,
    reason: r.reason, receipt_number: null, source_transfer_reversal: null,
    status: r.status, transfer_reversal: null,
  };
  if (r._failureReason) Object.assign(out, { failure_balance_transaction: null, failure_reason: r._failureReason });
  if (ctx.atLeast('2026-08-26.dahlia')) Object.assign(out, { customer: r.customer, customer_account: null, payment_method: r.payment_method });
  return out;
}

export function install(app) {
  app.object('refund', { render: renderRefund,
    expandable: ['charge', 'payment_intent', 'balance_transaction', 'failure_balance_transaction', 'source_transfer_reversal', 'transfer_reversal', 'customer', 'payment_method'],
    links: { charge: 'charge', payment_intent: 'payment_intent', customer: { to: 'customer', since: '2026-08-26.dahlia' }, payment_method: { to: 'payment_method', since: '2026-08-26.dahlia' } },
  });
  app.route('POST', '/v1/refunds', (c) => createRefund(c.account, c.params), { returns: 'refund' });
  app.route('GET', '/v1/refunds/:id', (c) => c.account.store.require('refund', c.pathParams.id), { returns: 'refund' });
  app.route('POST', '/v1/refunds/:id', (c) => updateRefund(c.account, c.account.store.require('refund', c.pathParams.id), c.params), { returns: 'refund' });
  app.route('POST', '/v1/refunds/:id/cancel', (c) => cancelRefund(c.account, c.account.store.require('refund', c.pathParams.id)), { returns: 'refund' });
  app.route('GET', '/v1/refunds', (c) => {
    const p = c.params;
    return paginate(c.account.store.list('refund', (r) => (p.charge === undefined || r.charge === p.charge) &&
      (p.payment_intent === undefined || r.payment_intent === p.payment_intent) && matchesRange(r.created, p.created)), p,
    { url: '/v1/refunds', noun: 'refund', find: (id) => c.account.store.get('refund', id) });
  }, { returns: 'list<refund>' });
}
