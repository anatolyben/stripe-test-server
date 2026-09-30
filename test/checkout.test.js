/**
 * Checkout Sessions and the hosted Checkout page, driven through the real stripe SDK and plain
 * HTTP form posts: session shape and validation, completion (customer, card, subscription, first
 * invoice, events, redirect), declines, trials, the 2024-06-20 flow, expiry and page details.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer, webhookReceiver } from './helpers.js';

const SECRET = 'whsec_checkout_tests';
const DAY = 86400;

async function catalog(stripe, { amount = 2000, interval = 'month', name = 'Pro', currency = 'usd' } = {}) {
  const product = await stripe.products.create({ name });
  const price = await stripe.prices.create({ product: product.id, unit_amount: amount, currency, recurring: { interval } });
  return { product, price };
}

function sessionParams(price, extra = {}) {
  return {
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://example.com/cancel',
    ...extra,
  };
}

async function getPage(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

const pageError = (html) => /<p class="error"[^>]*>([^<]*)</.exec(html)?.[1];

async function eventTypes(stripe) {
  const events = await stripe.events.list({ limit: 100 });
  return events.data.map((e) => e.type).reverse();
}

/** Asserts that `expected` appears in `types` in this order (other events may come between). */
function expectInOrder(types, expected) {
  let from = 0;
  for (const type of expected) {
    const at = types.indexOf(type, from);
    expect(at, `${type} after position ${from} in ${types.join(', ')}`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

describe('creating sessions', () => {
  it('creates an open hosted session with its page URL, amounts and a 24-hour expiry', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(
      sessionParams(price, { customer_email: 'jenny@example.com', client_reference_id: 'order-7', metadata: { cart: '42' } }),
    );
    expect(session).toMatchObject({
      object: 'checkout.session',
      mode: 'subscription',
      status: 'open',
      payment_status: 'unpaid',
      customer: null,
      customer_email: 'jenny@example.com',
      subscription: null,
      invoice: null,
      payment_intent: null,
      amount_subtotal: 2000,
      amount_total: 2000,
      currency: 'usd',
      client_reference_id: 'order-7',
      metadata: { cart: '42' },
      ui_mode: 'hosted_page',
      payment_method_types: ['card'],
      payment_method_collection: 'always',
      livemode: false,
    });
    expect(session.id).toMatch(/^cs_test_/);
    expect(session.url).toBe(`${t.url}/c/pay/${session.id}`);
    expect(session.expires_at - session.created).toBe(DAY);
    expect(session.line_items).toBeUndefined();

    const fetched = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items.data.price.product'] });
    expect(fetched.line_items.data).toHaveLength(1);
    expect(fetched.line_items.data[0]).toMatchObject({ object: 'item', amount_total: 2000, quantity: 1, description: 'Pro' });
    expect(fetched.line_items.data[0].price.product.name).toBe('Pro');

    const items = await stripe.checkout.sessions.listLineItems(session.id);
    expect(items.url).toBe(`/v1/checkout/sessions/${session.id}/line_items`);
    expect(items.data[0].id).toMatch(/^li_/);
    const listed = await stripe.checkout.sessions.list({ status: 'open' });
    expect(listed.data.map((s) => s.id)).toEqual([session.id]);
  });

  it('replays the same session for the same Idempotency-Key', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const first = await stripe.checkout.sessions.create(sessionParams(price), { idempotencyKey: 'checkout-1' });
    const again = await stripe.checkout.sessions.create(sessionParams(price), { idempotencyKey: 'checkout-1' });
    expect(again.id).toBe(first.id);
    expect(again.lastResponse.headers['idempotent-replayed']).toBe('true');
    expect((await stripe.checkout.sessions.list()).data).toHaveLength(1);
  });

  it('rejects invalid sessions with the documented error types and bracketed params', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const oneTime = await stripe.prices.create({ product: price.product, unit_amount: 500, currency: 'usd' });
    const euro = await stripe.prices.create({ product: price.product, unit_amount: 500, currency: 'eur', recurring: { interval: 'month' } });
    const customer = await stripe.customers.create({ email: 'a@example.com' });
    const cases = [
      [{ ...sessionParams(price), mode: undefined }, 'parameter_missing', 'mode'],
      [sessionParams(price, { success_url: undefined }), 'parameter_missing', 'success_url'],
      [sessionParams(price, { line_items: [{ price: oneTime.id, quantity: 1 }] }), undefined, 'line_items'],
      [sessionParams(price, { line_items: [{ price: 'price_missing', quantity: 1 }] }), 'resource_missing', 'line_items[0][price]'],
      [sessionParams(price, { line_items: [{ price: price.id, quantity: 1 }, { price: euro.id, quantity: 1 }] }), undefined, 'line_items[1][price]'],
      [sessionParams(price, { customer: customer.id, customer_email: 'b@example.com' }), 'parameters_exclusive', 'customer_email'],
      [sessionParams(price, { customer: 'cus_missing' }), 'resource_missing', 'customer'],
      [sessionParams(price, { subscription_data: { trial_period_days: 0 } }), undefined, 'subscription_data[trial_period_days]'],
      [sessionParams(price, { subscription_data: { trial_end: Math.floor(Date.now() / 1000) + 3600 } }), undefined, 'subscription_data[trial_end]'],
      [sessionParams(price, { expires_at: Math.floor(Date.now() / 1000) + 600 }), undefined, 'expires_at'],
      [sessionParams(price, { customer_creation: 'always' }), undefined, 'customer_creation'],
      [sessionParams(price, { ui_mode: 'hosted' }), undefined, 'ui_mode'],
      [sessionParams(price, { success_url: 'javascript:alert(1)//{CHECKOUT_SESSION_ID}' }), 'url_invalid', 'success_url'],
      [sessionParams(price, { cancel_url: '/cancel' }), 'url_invalid', 'cancel_url'],
      [sessionParams(price, { line_items: [{ price_data: { currency: 'usd', unit_amount: 100, recurring: { interval: 'month' } }, quantity: 1 }] }), 'parameter_missing', 'line_items[0][price_data][product]'],
    ];
    for (const [params, code, param] of cases) {
      const err = await rejection(stripe.checkout.sessions.create(params));
      expect([err.type, err.statusCode, err.code, err.param], JSON.stringify(params)).toEqual(['StripeInvalidRequestError', 400, code, param]);
    }
    await stripe.prices.update(price.id, { active: false });
    const archived = await rejection(stripe.checkout.sessions.create(sessionParams(price)));
    expect(archived.param).toBe('line_items[0][price]');
    expect((await stripe.checkout.sessions.list()).data).toHaveLength(0);
  });

  it('creates an inline price for price_data that the price list does not show', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const session = await stripe.checkout.sessions.create({
      ...sessionParams({ id: 'unused' }),
      line_items: [{ price_data: { currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' }, product_data: { name: 'Starter' } }, quantity: 2 }],
    });
    expect(session.amount_total).toBe(3000);
    const [item] = (await stripe.checkout.sessions.listLineItems(session.id)).data;
    expect(item).toMatchObject({ description: 'Starter', quantity: 2, amount_subtotal: 3000, price: { unit_amount: 1500, type: 'recurring' } });
    expect((await stripe.prices.list()).data.map((p) => p.id)).not.toContain(item.price.id);
  });

  it('renders the 2024-06-20 shape for older API versions', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const legacy = t.stripe(t.key, { apiVersion: '2024-06-20' });
    const session = await legacy.checkout.sessions.create(sessionParams(price));
    expect(session.ui_mode).toBe('hosted');
    expect(session).toHaveProperty('shipping_details', null);
    expect(session).not.toHaveProperty('adaptive_pricing');
    expect(session).not.toHaveProperty('collected_information');
    const current = await stripe.checkout.sessions.retrieve(session.id);
    expect(current.ui_mode).toBe('hosted_page');
    expect(current).not.toHaveProperty('shipping_details');
  });
});

describe('completing sessions on the hosted page', () => {
  it('creates the customer, attaches the card, starts an active subscription with a paid first invoice and redirects to success_url', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }] });
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(
      sessionParams(price, { customer_email: 'jenny@example.com', subscription_data: { metadata: { plan: 'pro' } } }),
    );

    const page = await getPage(session.url);
    expect(page.status).toBe(200);
    expect(page.text).toContain('$20.00 due today');
    expect(page.text).toContain('href="https://example.com/cancel"');
    expect(page.text).toContain('jenny@example.com');

    const done = await postForm(session.url, { card_number: '4242 4242 4242 4242', exp_month: '12', exp_year: '34', cvc: '123', cardholder_name: 'Jenny Rosen' });
    expect(done.status).toBe(303);
    expect(done.location).toBe(`https://example.com/success?session_id=${session.id}`);

    const completed = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription', 'invoice'] });
    expect(completed).toMatchObject({ status: 'complete', payment_status: 'paid', url: null, amount_total: 2000 });
    expect(completed.customer).toMatch(/^cus_/);
    expect(completed.payment_intent).toMatch(/^pi_/);
    expect(completed.customer_details).toMatchObject({ email: 'jenny@example.com', name: 'Jenny Rosen', tax_exempt: 'none' });
    const sub = completed.subscription;
    expect(sub).toMatchObject({ status: 'active', customer: completed.customer, metadata: { plan: 'pro' } });
    expect(sub.items.data[0].price.id).toBe(price.id);
    expect(sub.billing_mode.type).toBe('flexible');
    expect(completed.invoice).toMatchObject({ status: 'paid', billing_reason: 'subscription_create', amount_paid: 2000 });

    const pm = await stripe.paymentMethods.retrieve(sub.default_payment_method);
    expect(pm).toMatchObject({ customer: completed.customer, card: { last4: '4242', brand: 'visa' } });
    const customer = await stripe.customers.retrieve(completed.customer);
    expect(customer.email).toBe('jenny@example.com');
    expect(customer.invoice_settings.default_payment_method).toBeNull();

    expectInOrder(await eventTypes(stripe), [
      'customer.created',
      'payment_method.attached',
      'customer.subscription.created',
      'invoice.created',
      'invoice.finalized',
      'invoice.paid',
      'invoice.payment_succeeded',
      'checkout.session.completed',
    ]);
    const created = (await stripe.events.list({ type: 'customer.subscription.created' })).data[0];
    expect(created.data.object.status).toBe('active');
    expect(created.request).toEqual({ id: null, idempotency_key: null });

    await t.server.settle();
    const delivery = hooks.deliveries.find((d) => d.json.type === 'checkout.session.completed');
    const event = stripe.webhooks.constructEvent(delivery.rawBody, delivery.headers['stripe-signature'], SECRET);
    expect(event.data.object).toMatchObject({ id: session.id, status: 'complete', subscription: sub.id, invoice: completed.invoice.id });
    expect(event.data.object.line_items).toBeUndefined();
  });

  it('declines 4000000000000002 with 402, keeps the session open and creates nothing', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(sessionParams(price, { customer_email: 'jenny@example.com' }));
    const declined = await postForm(session.url, { card_number: '4000000000000002' });
    expect(declined.status).toBe(402);
    expect(pageError(declined.text)).toBe('Your card was declined.');
    expect(declined.text).toContain('id="checkout-form"');
    const failing = await postForm(session.url, { card_number: '4000000000000341' });
    expect(failing.status).toBe(402);
    const unknown = await postForm(session.url, { card_number: '1234123412341234' });
    expect(unknown.status).toBe(402);
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe('open');
    expect((await stripe.customers.list()).data).toHaveLength(0);
    expect((await stripe.subscriptions.list({ status: 'all' })).data).toHaveLength(0);
    expect(await eventTypes(stripe)).not.toContain('customer.created');

    const ok = await postForm(session.url, { card_number: '4242424242424242' });
    expect(ok.status).toBe(303);
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe('complete');
  });

  it('starts a free trial: nothing due, a trialing subscription with trial_end and a paid $0 invoice', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(sessionParams(price, { customer_email: 'trial@example.com', subscription_data: { trial_period_days: 14 } }));
    expect([session.amount_total, session.amount_subtotal]).toEqual([0, 0]);
    const page = await getPage(session.url);
    expect(page.text).toContain('$0.00 due today');
    expect(page.text).toContain('14 days free');
    expect((await postForm(session.url, { card_number: '4242424242424242' })).status).toBe(303);
    const completed = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription', 'invoice'] });
    expect(completed).toMatchObject({ status: 'complete', payment_status: 'paid', payment_intent: null });
    expect(completed.subscription.status).toBe('trialing');
    expect(completed.subscription.trial_end - completed.subscription.trial_start).toBe(14 * DAY);
    expect(completed.invoice).toMatchObject({ status: 'paid', amount_due: 0 });
    expect(await eventTypes(stripe)).not.toContain('invoice.payment_succeeded');
  });

  it('attaches 4000000000000341 during a trial; the first charge after the trial fails', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(sessionParams(price, { customer_email: 'fail@example.com', subscription_data: { trial_period_days: 1 } }));
    expect((await postForm(session.url, { card_number: '4000000000000341' })).status).toBe(303);
    const { subscription } = await stripe.checkout.sessions.retrieve(session.id);
    expect((await stripe.subscriptions.retrieve(subscription)).status).toBe('trialing');
    await t.account().advanceTime({ seconds: DAY + 2 * 3600 });
    const sub = await stripe.subscriptions.retrieve(subscription);
    expect(sub.status).toBe('past_due');
    expect(await eventTypes(stripe)).toContain('invoice.payment_failed');
  });

  it('collects no card with payment_method_collection=if_required when nothing is due', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(
      sessionParams(price, { customer_email: 'nocard@example.com', payment_method_collection: 'if_required', subscription_data: { trial_period_days: 7 } }),
    );
    const page = await getPage(session.url);
    expect(page.text).not.toContain('id="card_number"');
    expect(page.text).toContain('No payment method is needed today.');
    expect((await postForm(session.url, {})).status).toBe(303);
    const completed = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription'] });
    expect(completed.subscription).toMatchObject({ status: 'trialing', default_payment_method: null });
    expect((await stripe.paymentMethods.list({ customer: completed.customer })).data).toHaveLength(0);
  });

  it('keeps the 2024-06-20 flow: a decline leaves an incomplete subscription, a later card on the same session pays it', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const legacy = t.stripe(t.key, { apiVersion: '2024-06-20' });
    const session = await legacy.checkout.sessions.create(sessionParams(price, { customer_email: 'legacy@example.com' }));
    const declined = await postForm(session.url, { card_number: '4000000000000341' });
    expect(declined.status).toBe(402);
    const [incomplete] = (await stripe.subscriptions.list({ status: 'all' })).data;
    expect(incomplete.status).toBe('incomplete');
    expect((await legacy.checkout.sessions.retrieve(session.id)).status).toBe('open');

    expect((await postForm(session.url, { card_number: '4242424242424242' })).status).toBe(303);
    const completed = await legacy.checkout.sessions.retrieve(session.id);
    expect(completed).toMatchObject({ status: 'complete', subscription: incomplete.id, payment_intent: null });
    expect((await stripe.subscriptions.retrieve(incomplete.id)).status).toBe('active');
    expect((await stripe.customers.list()).data).toHaveLength(1);
  });

  it('on 2024-06-20 creates the subscription incomplete and activates it when the first invoice is paid', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const legacy = t.stripe(t.key, { apiVersion: '2024-06-20' });
    const session = await legacy.checkout.sessions.create(sessionParams(price, { customer_email: 'legacy@example.com' }));
    expect((await postForm(session.url, { card_number: '4242424242424242' })).status).toBe(303);
    const completed = await legacy.checkout.sessions.retrieve(session.id);
    expect(completed).toMatchObject({ status: 'complete', payment_status: 'paid', payment_intent: null });
    expect(completed.customer_details).not.toHaveProperty('individual_name');
    const types = await eventTypes(stripe);
    expectInOrder(types, [
      'customer.created',
      'payment_method.attached',
      'customer.subscription.created',
      'invoice.created',
      'invoice.finalized',
      'invoice.paid',
      'customer.subscription.updated',
      'checkout.session.completed',
    ]);
    const created = (await stripe.events.list({ type: 'customer.subscription.created' })).data[0];
    expect(created.data.object.status).toBe('incomplete');
    const updated = (await stripe.events.list({ type: 'customer.subscription.updated' })).data.at(-1);
    expect(updated.data.previous_attributes.status).toBe('incomplete');
  });

  it('uses an existing customer, shows its email and does not create another', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const customer = await stripe.customers.create({ email: 'known@example.com' });
    const session = await stripe.checkout.sessions.create(sessionParams(price, { customer: customer.id, customer_update: { name: 'auto' } }));
    const page = await getPage(session.url);
    expect(page.text).toContain('known@example.com');
    expect(page.text).not.toContain('name="email"');
    expect((await postForm(session.url, { card_number: '4242424242424242', cardholder_name: 'Known Person' })).status).toBe(303);
    expect((await stripe.customers.list()).data.map((c) => c.id)).toEqual([customer.id]);
    expect((await stripe.customers.retrieve(customer.id)).name).toBe('Known Person');
    expect((await stripe.checkout.sessions.retrieve(session.id)).customer).toBe(customer.id);
  });

  it('applies adjusted quantities, custom fields, phone numbers and consent from the page', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe, { amount: 1000 });
    const session = await stripe.checkout.sessions.create(
      sessionParams(price, {
        customer_email: 'team@example.com',
        line_items: [{ price: price.id, quantity: 2, adjustable_quantity: { enabled: true, minimum: 1, maximum: 10 } }],
        custom_fields: [{ key: 'company', label: { type: 'custom', custom: 'Company' }, type: 'text' }],
        phone_number_collection: { enabled: true },
        consent_collection: { terms_of_service: 'required' },
      }),
    );
    expect(session.amount_total).toBe(2000);
    const [item] = (await stripe.checkout.sessions.listLineItems(session.id)).data;
    const base = { card_number: '4242424242424242', phone: '+15555550100', 'custom_fields[company]': 'Acme' };
    const noConsent = await postForm(session.url, base);
    expect(noConsent.status).toBe(400);
    const tooMany = await postForm(session.url, { ...base, consent_terms: 'on', [`quantity[${item.id}]`]: '11' });
    expect(tooMany.status).toBe(400);
    const done = await postForm(session.url, { ...base, consent_terms: 'on', [`quantity[${item.id}]`]: '5' });
    expect(done.status).toBe(303);
    const completed = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items', 'subscription'] });
    expect(completed.amount_total).toBe(5000);
    expect(completed.line_items.data[0].quantity).toBe(5);
    expect(completed.subscription.items.data[0].quantity).toBe(5);
    expect(completed.custom_fields[0].text.value).toBe('Acme');
    expect(completed.customer_details.phone).toBe('+15555550100');
    expect(completed.consent).toEqual({ promotions: null, terms_of_service: 'accepted' });
  });
});

describe('line item kinds and ui modes', () => {
  it('bills one-time items on the first invoice and adds optional items the customer picks', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price, product } = await catalog(stripe);
    const setup = await stripe.prices.create({ product: product.id, unit_amount: 500, currency: 'usd' });
    const addon = await catalog(stripe, { amount: 700, name: 'Add-on' });
    const session = await stripe.checkout.sessions.create(
      sessionParams(price, {
        customer_email: 'items@example.com',
        line_items: [{ price: price.id, quantity: 1 }, { price: setup.id, quantity: 1 }],
        optional_items: [{ price: addon.price.id, quantity: 1 }],
      }),
    );
    expect(session.amount_total).toBe(2500);
    const withOptional = await stripe.checkout.sessions.retrieve(session.id, { expand: ['optional_items'] });
    expect(withOptional.optional_items).toEqual([{ adjustable_quantity: null, price: addon.price.id, quantity: 1 }]);
    const page = await getPage(session.url);
    expect(page.text).toContain('Add Add-on');
    expect((await postForm(session.url, { card_number: '4242424242424242', 'optional[0]': 'on' })).status).toBe(303);
    const completed = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription', 'invoice', 'line_items'] });
    expect(completed.amount_total).toBe(3200);
    expect(completed.line_items.data.map((i) => i.price.id)).toEqual([price.id, setup.id, addon.price.id]);
    expect(completed.subscription.items.data.map((i) => i.price.id).sort()).toEqual([price.id, addon.price.id].sort());
    expect(completed.invoice.amount_paid).toBe(3200);
    expect(completed.invoice.lines.data).toHaveLength(3);
  });

  it('gives embedded sessions a client secret instead of a URL and returns to return_url', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const base = { mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }], ui_mode: 'embedded_page', customer_email: 'e@example.com' };
    const missing = await rejection(stripe.checkout.sessions.create(base));
    expect([missing.code, missing.param]).toEqual(['parameter_missing', 'return_url']);
    const withSuccess = await rejection(stripe.checkout.sessions.create({ ...base, return_url: 'https://example.com/r', success_url: 'https://example.com/s' }));
    expect(withSuccess.param).toBe('success_url');
    const session = await stripe.checkout.sessions.create({ ...base, return_url: 'https://example.com/return?session={CHECKOUT_SESSION_ID}' });
    expect(session).toMatchObject({ ui_mode: 'embedded_page', url: null, redirect_on_completion: 'always', return_url: 'https://example.com/return?session={CHECKOUT_SESSION_ID}' });
    expect(session.client_secret).toMatch(new RegExp(`^${session.id}_secret_`));
    const done = await postForm(`${t.url}/c/pay/${session.id}`, { card_number: '4242424242424242' });
    expect([done.status, done.location]).toEqual([303, `https://example.com/return?session=${session.id}`]);
  });
});

describe('expiry and closed sessions', () => {
  it('expires through the API and at expires_at, with checkout.session.expired', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const first = await stripe.checkout.sessions.create(sessionParams(price));
    const expired = await stripe.checkout.sessions.expire(first.id);
    expect(expired).toMatchObject({ status: 'expired', url: null });
    const again = await rejection(stripe.checkout.sessions.expire(first.id));
    expect([again.type, again.statusCode]).toEqual(['StripeInvalidRequestError', 400]);
    expect((await getPage(first.url)).status).toBe(410);

    const second = await stripe.checkout.sessions.create(sessionParams(price, { expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    await t.account().advanceTime({ seconds: 3601 });
    expect((await stripe.checkout.sessions.retrieve(second.id)).status).toBe('expired');
    const events = (await stripe.events.list({ type: 'checkout.session.expired' })).data;
    expect(events.map((e) => e.data.object.id).sort()).toEqual([first.id, second.id].sort());
    expect((await postForm(second.url, { card_number: '4242424242424242' })).status).toBe(410);
  });

  it('uses the test clock of the session customer for created, expires_at and expiry', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const frozen = Math.floor(Date.UTC(2031, 0, 15) / 1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: frozen });
    const customer = await stripe.customers.create({ email: 'clock@example.com', test_clock: clock.id });
    const session = await stripe.checkout.sessions.create(sessionParams(price, { customer: customer.id }));
    expect([session.created, session.expires_at]).toEqual([frozen, frozen + DAY]);
    await t.account().advanceTime({ seconds: 2 * DAY });
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe('open');
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: frozen + DAY + 60 });
    const expired = await stripe.checkout.sessions.retrieve(session.id);
    expect(expired.status).toBe('expired');
    const [event] = (await stripe.events.list({ type: 'checkout.session.expired' })).data;
    expect(event.created).toBe(frozen + DAY);
  });

  it('shows a completed session as complete and refuses a second completion', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { price } = await catalog(stripe);
    const session = await stripe.checkout.sessions.create(sessionParams(price, { customer_email: 'x@example.com' }));
    expect((await postForm(session.url, { card_number: '4242424242424242' })).status).toBe(303);
    const page = await getPage(session.url);
    expect([page.status, page.text.includes('data-status="complete"')]).toEqual([200, true]);
    expect((await postForm(session.url, { card_number: '4242424242424242' })).status).toBe(409);
    expect((await stripe.subscriptions.list()).data).toHaveLength(1);
    expect((await getPage(`${t.url}/c/pay/cs_test_unknown`)).status).toBe(404);
  });
});
