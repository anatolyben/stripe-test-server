/**
 * Payments through the real stripe SDK and the module contract the billing engine uses:
 * test cards, PaymentMethods (aliases, attach, detach, lists, version shapes), PaymentIntents and
 * Charges (success, declines, 3D Secure, cancel), predictChargeFailure and failNextCharge.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';
import { TEST_CARDS, findTestCard } from '../src/payments/test_cards.js';
import { attachPaymentMethod, createCardPaymentMethod } from '../src/payments/payment_methods.js';
import {
  cancelPaymentIntent,
  confirmPaymentIntent,
  createPaymentIntent,
  predictChargeFailure,
} from '../src/payments/payment_intents.js';

const accountOf = (t) => t.server.context.account(t.key);

/** Runs `fn(account)` inside the account lock; a thrown error is returned instead. */
async function inAccount(t, fn) {
  const account = accountOf(t);
  return account.run(() => {
    try {
      return fn(account);
    } catch (err) {
      return err;
    }
  });
}

/** A customer with `alias` attached as its default payment method. */
async function customerWithCard(stripe, alias = 'pm_card_visa') {
  const customer = await stripe.customers.create({ email: 'jenny@example.com', payment_method: alias, invoice_settings: { default_payment_method: alias } });
  return { customer, pm: customer.invoice_settings.default_payment_method };
}

describe('test cards', () => {
  it('resolves every number and alias, and marks issuer declines as not attachable', () => {
    for (const card of TEST_CARDS) {
      expect(findTestCard(card.number)).toBe(card);
      for (const alias of card.aliases) expect(findTestCard(alias)).toBe(card);
      expect(card.last4).toBe(card.number.slice(-4));
      expect(typeof card.label).toBe('string');
    }
    expect(findTestCard('4242 4242-4242 4242')).toMatchObject({ brand: 'visa', alias: 'pm_card_visa', charge: 'succeeds' });
    expect(findTestCard('4000000000000002')).toMatchObject({ attachable: false, code: 'card_declined', declineCode: 'generic_decline' });
    expect(findTestCard('pm_card_chargeCustomerFail')).toMatchObject({ number: '4000000000000341', attachable: true, charge: 'declines' });
    expect(findTestCard('4242424242424241')).toBeNull();
  });
});

describe('payment methods', () => {
  it('mints a new PaymentMethod for every attach of an alias, with the 4242 card details', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'jenny@example.com' });
    const a = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    const b = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    expect(a.id).toMatch(/^pm_[A-Za-z0-9]{24}$/);
    expect(b.id).not.toBe(a.id);
    const { json } = await t.request('GET', `/v1/payment_methods/${a.id}`);
    expect(json).toEqual({
      id: a.id,
      object: 'payment_method',
      allow_redisplay: 'unspecified',
      billing_details: {
        address: { city: null, country: null, line1: null, line2: null, postal_code: null, state: null },
        email: null,
        name: null,
        phone: null,
        tax_id: null,
      },
      card: {
        brand: 'visa',
        checks: { address_line1_check: null, address_postal_code_check: null, cvc_check: 'pass' },
        country: 'US',
        display_brand: 'visa',
        exp_month: 12,
        exp_year: 2034,
        fingerprint: a.card.fingerprint,
        funding: 'credit',
        generated_from: null,
        last4: '4242',
        networks: { available: ['visa'], preferred: null },
        regulated_status: null,
        three_d_secure_usage: { supported: true },
        wallet: null,
      },
      created: a.created,
      customer: customer.id,
      customer_account: null,
      livemode: false,
      metadata: {},
      type: 'card',
    });
    expect(a.card.fingerprint).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(b.card.fingerprint).toBe(a.card.fingerprint);
    const amex = await stripe.paymentMethods.attach('pm_card_amex', { customer: customer.id });
    expect(amex.card).toMatchObject({ brand: 'amex', display_brand: 'american_express', last4: '0005', three_d_secure_usage: { supported: false } });
    expect(amex.card.fingerprint).not.toBe(a.card.fingerprint);
    const attached = (await stripe.events.list({ type: 'payment_method.attached' })).data;
    expect(attached.map((e) => [e.data.object.id, e.data.object.customer])).toEqual([
      [amex.id, customer.id],
      [b.id, customer.id],
      [a.id, customer.id],
    ]);
    expect((await stripe.events.list({ type: 'customer.updated' })).data).toEqual([]);
  });

  it('renders the version shapes: no tax_id before basil, no regulated_status before 2024-12-18, no customer_account before 2025-12-15', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { pm } = await customerWithCard(stripe);
    const legacy = await stripe.paymentMethods.retrieve(pm, {}, { apiVersion: '2024-06-20' });
    expect(['customer_account' in legacy, 'regulated_status' in legacy.card, 'tax_id' in legacy.billing_details]).toEqual([false, false, false]);
    const acacia = await stripe.paymentMethods.retrieve(pm, {}, { apiVersion: '2025-01-27.acacia' });
    expect(['customer_account' in acacia, 'regulated_status' in acacia.card, 'tax_id' in acacia.billing_details]).toEqual([false, true, false]);
    const basil = await stripe.paymentMethods.retrieve(pm, {}, { apiVersion: '2025-06-30.basil' });
    expect(['customer_account' in basil, 'regulated_status' in basil.card, 'tax_id' in basil.billing_details]).toEqual([false, true, true]);
    const clover = await stripe.paymentMethods.retrieve(pm, {}, { apiVersion: '2025-12-15.clover' });
    expect(['customer_account' in clover, 'regulated_status' in clover.card, 'tax_id' in clover.billing_details]).toEqual([true, true, true]);
  });

  it('rejects issuer-decline cards at attach with a 402 card error, but attaches 0341', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create();
    const declined = await rejection(stripe.paymentMethods.attach('pm_card_visa_chargeDeclined', { customer: customer.id }));
    expect([declined.type, declined.statusCode, declined.code, declined.decline_code, declined.message]).toEqual([
      'StripeCardError',
      402,
      'card_declined',
      'generic_decline',
      'Your card was declined.',
    ]);
    expect(declined.raw.charge).toBeUndefined();
    const expired = await rejection(stripe.paymentMethods.attach('pm_card_chargeDeclinedExpiredCard', { customer: customer.id }));
    expect([expired.statusCode, expired.code, expired.raw.decline_code]).toEqual([402, 'expired_card', undefined]);
    const cvc = await rejection(stripe.paymentMethods.attach('pm_card_chargeDeclinedIncorrectCvc', { customer: customer.id }));
    expect([cvc.code, cvc.param]).toEqual(['incorrect_cvc', 'cvc']);
    const failLater = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: customer.id });
    expect([failLater.customer, failLater.card.last4]).toEqual([customer.id, '0341']);
    const viaCustomer = await rejection(stripe.customers.create({ payment_method: 'pm_card_visa_chargeDeclined' }));
    expect(viaCustomer.statusCode).toBe(402);
    expect((await stripe.customers.list()).data.map((c) => c.id)).toEqual([customer.id]);
    expect((await stripe.customers.listPaymentMethods(customer.id)).data.map((p) => p.id)).toEqual([failLater.id]);
  });

  it('answers resource_missing for unknown PaymentMethods and customers, and 400 for foreign attaches', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const other = await stripe.customers.create();
    const unknownPm = await rejection(stripe.paymentMethods.attach('pm_missing', { customer: customer.id }));
    expect([unknownPm.statusCode, unknownPm.code, unknownPm.param]).toEqual([404, 'resource_missing', 'id']);
    const unknownCustomer = await rejection(stripe.paymentMethods.attach('pm_card_visa', { customer: 'cus_missing' }));
    expect([unknownCustomer.statusCode, unknownCustomer.code, unknownCustomer.param]).toEqual([400, 'resource_missing', 'customer']);
    const noCustomer = await rejection(stripe.paymentMethods.attach('pm_card_visa', {}));
    expect([noCustomer.code, noCustomer.param]).toEqual(['parameter_missing', 'customer']);
    const foreign = await rejection(stripe.paymentMethods.attach(pm, { customer: other.id }));
    expect([foreign.statusCode, foreign.type]).toEqual([400, 'StripeInvalidRequestError']);
    const again = await stripe.paymentMethods.attach(pm, { customer: customer.id });
    expect(again.id).toBe(pm);
    expect((await stripe.events.list({ type: 'payment_method.attached' })).data).toHaveLength(1);
    const badDefault = await rejection(stripe.customers.update(other.id, { invoice_settings: { default_payment_method: pm } }));
    expect([badDefault.statusCode, badDefault.param]).toEqual([400, 'invoice_settings[default_payment_method]']);
    const aliasDefault = await rejection(stripe.customers.update(other.id, { invoice_settings: { default_payment_method: 'pm_card_visa' } }));
    expect(aliasDefault.param).toBe('invoice_settings[default_payment_method]');
  });

  it('lists a customer’s PaymentMethods newest first, through both list endpoints', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create();
    const other = await stripe.customers.create();
    const first = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    const second = await stripe.paymentMethods.attach('pm_card_mastercard', { customer: customer.id });
    const foreign = await stripe.paymentMethods.attach('pm_card_visa', { customer: other.id });
    const page = await stripe.customers.listPaymentMethods(customer.id, { type: 'card' });
    expect(page).toMatchObject({ object: 'list', has_more: false, url: `/v1/customers/${customer.id}/payment_methods` });
    expect(page.data.map((p) => p.id)).toEqual([second.id, first.id]);
    const top = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1, expand: ['data.customer'] });
    expect([top.data.map((p) => p.id), top.has_more, top.data[0].customer.id]).toEqual([[second.id], true, customer.id]);
    expect((await stripe.customers.retrievePaymentMethod(customer.id, first.id)).id).toBe(first.id);
    const notTheirs = await rejection(stripe.customers.retrievePaymentMethod(customer.id, foreign.id));
    expect([notTheirs.statusCode, notTheirs.code]).toEqual([404, 'resource_missing']);
    const unknownCustomer = await rejection(stripe.customers.listPaymentMethods('cus_missing'));
    expect(unknownCustomer.statusCode).toBe(404);
    const badFilter = await rejection(stripe.paymentMethods.list({ customer: 'cus_missing' }));
    expect([badFilter.statusCode, badFilter.param]).toEqual([400, 'customer']);
    const unknownParam = await rejection(stripe.paymentMethods.list({ customer: customer.id, colour: 'blue' }));
    expect([unknownParam.code, unknownParam.param]).toEqual(['parameter_unknown', 'colour']);
  });

  it('retrieving an alias mints a fresh unattached PaymentMethod', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const pm = await stripe.paymentMethods.retrieve('pm_card_mastercard_debit');
    expect(pm).toMatchObject({ customer: null, card: { brand: 'mastercard', funding: 'debit', last4: '8210' } });
    expect(pm.id).not.toBe('pm_card_mastercard_debit');
    expect((await stripe.paymentMethods.retrieve(pm.id)).id).toBe(pm.id);
    expect((await rejection(stripe.paymentMethods.retrieve('pm_card_nonexistent'))).statusCode).toBe(404);
  });

  it('detaches for good, clearing the customer default with customer.updated', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const detached = await stripe.paymentMethods.detach(pm);
    expect(detached.customer).toBeNull();
    expect((await stripe.customers.retrieve(customer.id)).invoice_settings.default_payment_method).toBeNull();
    const types = (await stripe.events.list()).data.map((e) => e.type).reverse();
    expect(types.slice(-2)).toEqual(['payment_method.detached', 'customer.updated']);
    const [updated] = (await stripe.events.list({ type: 'customer.updated' })).data;
    expect(updated.data.previous_attributes).toEqual({ invoice_settings: { default_payment_method: pm } });
    const [detachEvent] = (await stripe.events.list({ type: 'payment_method.detached' })).data;
    expect(detachEvent.data.object).toMatchObject({ id: pm, customer: null });
    expect((await rejection(stripe.paymentMethods.attach(pm, { customer: customer.id }))).statusCode).toBe(400);
    expect((await rejection(stripe.paymentMethods.detach(pm))).statusCode).toBe(400);
    expect((await stripe.customers.listPaymentMethods(customer.id)).data).toEqual([]);
  });

  it('detaches a deleted customer’s cards without events', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    await stripe.customers.del(customer.id);
    expect((await stripe.paymentMethods.retrieve(pm)).customer).toBeNull();
    expect((await stripe.events.list({ type: 'payment_method.detached' })).data).toEqual([]);
  });
});

describe('cards typed on hosted pages', () => {
  it('creates set-up PaymentMethods with billing details and rejects invalid card data with 402s', async () => {
    const t = await startServer();
    const typed = await inAccount(t, (account) => createCardPaymentMethod(account, { number: '4242 4242 4242 4242', expMonth: '4', expYear: '41', cvc: '123', name: 'Jenny Rosen', email: 'jenny@example.com' }));
    expect(typed).toMatchObject({
      customer: null,
      allow_redisplay: 'limited',
      billing_details: { name: 'Jenny Rosen', email: 'jenny@example.com' },
      card: { last4: '4242', exp_month: 4, exp_year: 2041, checks: { cvc_check: 'pass' } },
    });
    const noCvc = await inAccount(t, (account) => createCardPaymentMethod(account, { number: '5555555555554444' }));
    expect([noCvc.card.exp_month, noCvc.card.exp_year, noCvc.card.checks.cvc_check]).toEqual([12, 2034, null]);
    const errors = await Promise.all([
      inAccount(t, (account) => createCardPaymentMethod(account, { number: '4242424242424241' })),
      inAccount(t, (account) => createCardPaymentMethod(account, { number: '4242424242424242', expMonth: '13', expYear: '30' })),
      inAccount(t, (account) => createCardPaymentMethod(account, { number: '4242424242424242', expMonth: '12', expYear: '95' })),
      inAccount(t, (account) => createCardPaymentMethod(account, { number: '4242424242424242', cvc: '99' })),
    ]);
    expect(errors.map((e) => [e.status, e.type, e.code, e.param])).toEqual([
      [402, 'card_error', 'incorrect_number', 'number'],
      [402, 'card_error', 'invalid_expiry_month', 'exp_month'],
      [402, 'card_error', 'invalid_expiry_year', 'exp_year'],
      [402, 'card_error', 'invalid_cvc', 'cvc'],
    ]);
    const stripe = t.stripe();
    const customer = await stripe.customers.create();
    const unattachable = await inAccount(t, (account) => createCardPaymentMethod(account, { number: '4000000000000002' }));
    const refused = await inAccount(t, (account) => attachPaymentMethod(account, unattachable.id, customer.id));
    expect([refused.status, refused.code, refused.fields.decline_code]).toEqual([402, 'card_declined', 'generic_decline']);
    expect((await stripe.paymentMethods.retrieve(unattachable.id)).customer).toBeNull();
    const ok = await inAccount(t, (account) => attachPaymentMethod(account, typed.id, customer.id, { request: null }));
    expect(ok.customer).toBe(customer.id);
    const [event] = (await stripe.events.list({ type: 'payment_method.attached' })).data;
    expect(event.request).toEqual({ id: null, idempotency_key: null });
  });
});

describe('payment intents and charges', () => {
  it('charges a working card: PaymentIntent and Charge succeed, events in order, retrievable through the API', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const outcome = await inAccount(t, (account) => {
      const pi = createPaymentIntent(account, { amount: 2000, currency: 'usd', customer: customer.id, description: 'Subscription creation', invoice: 'in_fixture' });
      return confirmPaymentIntent(account, pi, { paymentMethod: pm });
    });
    expect(outcome.ok).toBe(true);
    const pi = await stripe.paymentIntents.retrieve(outcome.paymentIntent.id, { expand: ['latest_charge'] });
    expect(pi).toMatchObject({
      object: 'payment_intent',
      amount: 2000,
      amount_received: 2000,
      currency: 'usd',
      customer: customer.id,
      description: 'Subscription creation',
      payment_method: pm,
      status: 'succeeded',
      last_payment_error: null,
      payment_method_types: ['card'],
      capture_method: 'automatic',
      latest_charge: { object: 'charge', status: 'succeeded', paid: true, captured: true, amount_captured: 2000, payment_intent: pi.id },
    });
    expect(pi.client_secret).toMatch(new RegExp(`^${pi.id}_secret_`));
    expect('invoice' in pi).toBe(false);
    const legacy = await stripe.paymentIntents.retrieve(pi.id, {}, { apiVersion: '2024-06-20' });
    expect([legacy.invoice, 'allowed_payment_method_types' in legacy, 'managed_payments' in legacy]).toEqual(['in_fixture', false, false]);
    const charge = await stripe.charges.retrieve(outcome.charge.id);
    expect(charge).toMatchObject({
      outcome: { network_status: 'approved_by_network', reason: null, seller_message: 'Payment complete.', type: 'authorized' },
      payment_method: pm,
      payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242', network: 'visa', amount_authorized: 2000 } },
      failure_code: null,
    });
    expect((await stripe.charges.retrieve(charge.id, {}, { apiVersion: '2024-06-20' })).invoice).toBe('in_fixture');
    const types = (await stripe.events.list()).data.map((e) => e.type).reverse();
    expect(types.slice(-3)).toEqual(['payment_intent.created', 'charge.succeeded', 'payment_intent.succeeded']);
  });

  it('declines 0341: requires_payment_method, last_payment_error with the card, failed Charge and a 402 card error', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe, 'pm_card_chargeCustomerFail');
    const outcome = await inAccount(t, (account) =>
      confirmPaymentIntent(account, createPaymentIntent(account, { amount: 1500, currency: 'usd', customer: customer.id }), { paymentMethod: pm }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error.status).toBe(402);
    const body = outcome.error.toBody('req_test');
    expect(body.error).toMatchObject({
      type: 'card_error',
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
      charge: outcome.charge.id,
      doc_url: 'https://docs.stripe.com/error-codes#card-declined',
      payment_method_type: 'card',
      payment_intent: { id: outcome.paymentIntent.id, object: 'payment_intent', status: 'requires_payment_method' },
      payment_method: { id: pm, object: 'payment_method' },
    });
    const pi = await stripe.paymentIntents.retrieve(outcome.paymentIntent.id);
    expect(pi).toMatchObject({ status: 'requires_payment_method', payment_method: null, latest_charge: outcome.charge.id, amount_received: 0 });
    expect(pi.last_payment_error).toMatchObject({
      charge: outcome.charge.id,
      code: 'card_declined',
      decline_code: 'generic_decline',
      message: 'Your card was declined.',
      type: 'card_error',
      payment_method: { id: pm, object: 'payment_method', card: { last4: '0341' } },
    });
    const charge = await stripe.charges.retrieve(outcome.charge.id);
    expect(charge).toMatchObject({
      status: 'failed',
      paid: false,
      captured: false,
      amount_captured: 0,
      failure_code: 'card_declined',
      failure_message: 'Your card was declined.',
      outcome: { network_status: 'declined_by_network', reason: 'generic_decline', type: 'issuer_declined', seller_message: 'The bank returned the decline code `generic_decline`.' },
    });
    const types = (await stripe.events.list()).data.map((e) => e.type).reverse();
    expect(types.slice(-2)).toEqual(['charge.failed', 'payment_intent.payment_failed']);
    const retry = await inAccount(t, (account) => confirmPaymentIntent(account, account.store.get('payment_intent', pi.id), { paymentMethod: pm }));
    expect([retry.ok, retry.paymentIntent.status]).toEqual([false, 'requires_payment_method']);
  });

  it('stops off-session charges of 3D Secure cards at requires_action, while on-session they succeed', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe, 'pm_card_authenticationRequired');
    const offSession = await inAccount(t, (account) =>
      confirmPaymentIntent(account, createPaymentIntent(account, { amount: 1000, currency: 'usd', customer: customer.id }), { paymentMethod: pm }),
    );
    expect([offSession.ok, offSession.charge, offSession.error.code, offSession.error.fields.decline_code]).toEqual([
      false,
      null,
      'authentication_required',
      'authentication_required',
    ]);
    expect(await stripe.paymentIntents.retrieve(offSession.paymentIntent.id)).toMatchObject({
      status: 'requires_action',
      payment_method: pm,
      next_action: { type: 'use_stripe_sdk' },
      latest_charge: null,
    });
    const [event] = (await stripe.events.list({ limit: 1 })).data;
    expect(event.type).toBe('payment_intent.requires_action');
    const onSession = await inAccount(t, (account) =>
      confirmPaymentIntent(account, createPaymentIntent(account, { amount: 1000, currency: 'usd', customer: customer.id }), { paymentMethod: pm, offSession: false }),
    );
    expect(onSession.ok).toBe(true);

    // "Authenticate unless set up": an API-attached alias is not set up, a hosted-page card is.
    const apiCard = await customerWithCard(stripe, 'pm_card_authenticationRequiredOnSetup');
    const notSetUp = await inAccount(t, (account) =>
      confirmPaymentIntent(account, createPaymentIntent(account, { amount: 1000, currency: 'usd', customer: apiCard.customer.id }), { paymentMethod: apiCard.pm }),
    );
    expect(notSetUp.paymentIntent.status).toBe('requires_action');
    const setUp = await inAccount(t, (account) => {
      const pmObj = attachPaymentMethod(account, createCardPaymentMethod(account, { number: '4000002500003155' }).id, apiCard.customer.id);
      return confirmPaymentIntent(account, createPaymentIntent(account, { amount: 1000, currency: 'usd', customer: apiCard.customer.id }), { paymentMethod: pmObj.id });
    });
    expect(setUp.paymentIntent.status).toBe('succeeded');
  });

  it('treats a card that can no longer be charged as a failed attempt without a Charge', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const other = await customerWithCard(stripe);
    await stripe.paymentMethods.detach(pm);
    const eventsBefore = (await stripe.events.list()).data.length;
    const attempts = await inAccount(t, (account) => {
      const pi = createPaymentIntent(account, { amount: 1000, currency: 'usd', customer: customer.id });
      return [pm, other.pm, null].map((paymentMethod) => confirmPaymentIntent(account, pi, { paymentMethod }));
    });
    expect(attempts.map((a) => [a.ok, a.charge, a.error.status, a.error.type, a.paymentIntent.status])).toEqual([
      [false, null, 400, 'invalid_request_error', 'requires_payment_method'],
      [false, null, 400, 'invalid_request_error', 'requires_payment_method'],
      [false, null, 400, 'invalid_request_error', 'requires_payment_method'],
    ]);
    const events = (await stripe.events.list()).data;
    expect(events.slice(0, events.length - eventsBefore).map((e) => e.type)).toEqual(['payment_intent.created']);
  });

  it('cancels open PaymentIntents (void_invoice) but not succeeded ones', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const canceled = await inAccount(t, (account) => cancelPaymentIntent(account, createPaymentIntent(account, { amount: 900, currency: 'usd', customer: customer.id })));
    const pi = await stripe.paymentIntents.retrieve(canceled.id);
    expect([pi.status, pi.cancellation_reason, typeof pi.canceled_at]).toEqual(['canceled', 'void_invoice', 'number']);
    expect((await stripe.events.list({ limit: 1 })).data[0].type).toBe('payment_intent.canceled');
    const refused = await inAccount(t, (account) => {
      const paid = confirmPaymentIntent(account, createPaymentIntent(account, { amount: 900, currency: 'usd', customer: customer.id }), { paymentMethod: pm });
      return cancelPaymentIntent(account, paid.paymentIntent);
    });
    expect([refused.status, refused.code]).toEqual([400, 'payment_intent_unexpected_state']);
    expect((await rejection(stripe.paymentIntents.retrieve('pi_missing'))).statusCode).toBe(404);
    expect((await rejection(stripe.charges.retrieve('ch_missing'))).statusCode).toBe(404);
  });
});

describe('failNextCharge and predictChargeFailure', () => {
  it('forces the next attempts of a customer to fail, whatever the card, through JS and HTTP controls', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const control = t.account();
    expect(await control.failNextCharge(customer.id, { declineCode: 'insufficient_funds' })).toEqual({
      customer: customer.id,
      remaining: 1,
      declineCode: 'insufficient_funds',
    });
    const http = await t.request('POST', '/_test/fail_next_charge', { json: { customer: customer.id, times: 2 } });
    expect(http.json).toEqual({ customer: customer.id, remaining: 3, declineCode: 'generic_decline' });
    const attempt = () =>
      inAccount(t, (account) =>
        confirmPaymentIntent(account, createPaymentIntent(account, { amount: 1000, currency: 'usd', customer: customer.id }), { paymentMethod: pm }),
      );
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = await attempt();
      results.push(r.ok ? 'ok' : r.error.fields.decline_code);
    }
    expect(results).toEqual(['insufficient_funds', 'generic_decline', 'generic_decline', 'ok']);

    await expect(control.failNextCharge('cus_missing')).rejects.toMatchObject({ status: 400 });
    const unknown = await t.request('POST', '/_test/fail_next_charge', { json: { customer: 'cus_missing' } });
    expect([unknown.status, unknown.json.error.code, unknown.json.error.param]).toEqual([400, 'resource_missing', 'customer']);
    const badCode = await t.request('POST', '/_test/fail_next_charge', { json: { customer: customer.id, declineCode: 'nope' } });
    expect([badCode.status, badCode.json.error.param]).toEqual([400, 'declineCode']);
  });

  it('predicts declines without side effects unless asked to count the attempt', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { customer, pm } = await customerWithCard(stripe);
    const eventsBefore = (await stripe.events.list()).data.length;
    const predict = (opts) => inAccount(t, (account) => predictChargeFailure(account, { paymentMethod: pm, customer: customer.id, amount: 1000, currency: 'usd', ...opts }));
    expect(await predict()).toBeNull();
    expect(await predict({ amount: 0 })).toBeNull();
    const hosted0341 = await inAccount(t, (account) => createCardPaymentMethod(account, { number: '4000000000000341' }));
    expect(await predict({ paymentMethod: hosted0341.id, customer: null })).toEqual({ code: 'card_declined', declineCode: 'generic_decline', message: 'Your card was declined.' });
    expect(await predict({ paymentMethod: 'pm_card_visa_chargeDeclinedInsufficientFunds', customer: null })).toMatchObject({ declineCode: 'insufficient_funds' });
    const hosted3184 = await inAccount(t, (account) => createCardPaymentMethod(account, { number: '4000002760003184' }));
    expect(await predict({ paymentMethod: hosted3184.id, customer: null })).toBeNull();
    expect(await predict({ paymentMethod: hosted3184.id, customer: null, offSession: true })).toMatchObject({ code: 'authentication_required' });

    await t.account().failNextCharge(customer.id, { declineCode: 'lost_card' });
    expect(await predict()).toMatchObject({ code: 'card_declined', declineCode: 'lost_card' });
    expect(await predict()).toMatchObject({ declineCode: 'lost_card' });
    expect(await predict({ consume: true })).toMatchObject({ declineCode: 'lost_card' });
    expect(await predict()).toBeNull();
    expect((await stripe.events.list()).data).toHaveLength(eventsBefore);
    expect((await stripe.paymentMethods.retrieve(hosted0341.id)).customer).toBeNull();
  });
});
