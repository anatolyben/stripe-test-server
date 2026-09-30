/**
 * Gap tests: endpoint behaviours from the definition of done that the area test files do not
 * cover yet. List filters (subscriptions, invoices, portal configurations, Checkout Sessions),
 * Checkout Session retrieve fields, idempotent subscription creation, schedule release
 * semantics, portal flow_data rules, hosted invoice URLs, test clock CRUD, a deleted customer
 * used afterwards, version shapes and gates at their exact boundary versions, and the control
 * API over HTTP. Everything goes through the real stripe SDK; plain HTTP only for hosted pages
 * and /_test/ controls.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer, testKey, webhookReceiver } from './helpers.js';

const DAY = 86400;
const HOUR = 3600;
const SECRET = 'whsec_endpoints_tests';
const RETURN_URL = 'https://example.com/account';
const T0 = Math.floor(Date.UTC(2031, 0, 15) / 1000);

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

/** Every event of the account, oldest first. */
async function allEvents(stripe) {
  const out = [];
  for await (const e of stripe.events.list({ limit: 100 })) out.push(e);
  return out.reverse();
}

/** Products Basic ($10 / month) and Pro ($20 / month, $200 / year). */
async function catalog(stripe) {
  const basic = await stripe.products.create({ name: 'Basic' });
  const pro = await stripe.products.create({ name: 'Pro' });
  const basicMonthly = await stripe.prices.create({ product: basic.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
  const proMonthly = await stripe.prices.create({ product: pro.id, unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } });
  const proYearly = await stripe.prices.create({ product: pro.id, unit_amount: 20000, currency: 'usd', recurring: { interval: 'year' } });
  return { basic, pro, basicMonthly, proMonthly, proYearly };
}

/** A customer whose default card is `card` (none when card is null). */
async function customerWithCard(stripe, email, card = 'pm_card_visa') {
  const customer = await stripe.customers.create({ email });
  if (card) {
    const pm = await stripe.paymentMethods.attach(card, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  }
  return customer;
}

const ids = (list) => list.data.map((x) => x.id);

describe('list filters', () => {
  it('lists subscriptions by customer and status with limit and cursors, keeping incomplete_expired in the default list', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const a = await customerWithCard(stripe, 'a@example.com');
    const b = await customerWithCard(stripe, 'b@example.com');
    const noCard = await customerWithCard(stripe, 'c@example.com', null);
    const active = await stripe.subscriptions.create({ customer: a.id, items: [{ price: c.basicMonthly.id }] });
    const trialing = await stripe.subscriptions.create({ customer: b.id, items: [{ price: c.basicMonthly.id }], trial_period_days: 14 });
    const second = await stripe.subscriptions.create({ customer: a.id, items: [{ price: c.proMonthly.id }] });
    const incomplete = await stripe.subscriptions.create({ customer: noCard.id, items: [{ price: c.basicMonthly.id }] });
    expect([active.status, trialing.status, second.status, incomplete.status]).toEqual(['active', 'trialing', 'active', 'incomplete']);

    expect(ids(await stripe.subscriptions.list({ customer: a.id }))).toEqual([second.id, active.id]);
    expect(ids(await stripe.subscriptions.list({ status: 'active' }))).toEqual([second.id, active.id]);
    expect(ids(await stripe.subscriptions.list({ status: 'trialing' }))).toEqual([trialing.id]);
    expect(ids(await stripe.subscriptions.list({ status: 'incomplete' }))).toEqual([incomplete.id]);
    expect(ids(await stripe.subscriptions.list({ customer: a.id, status: 'trialing' }))).toEqual([]);

    const page1 = await stripe.subscriptions.list({ limit: 2 });
    expect([ids(page1), page1.has_more, page1.url]).toEqual([[incomplete.id, second.id], true, '/v1/subscriptions']);
    const page2 = await stripe.subscriptions.list({ limit: 2, starting_after: second.id });
    expect([ids(page2), page2.has_more]).toEqual([[trialing.id, active.id], false]);
    const back = await stripe.subscriptions.list({ limit: 2, ending_before: trialing.id });
    expect(ids(back)).toEqual([incomplete.id, second.id]);

    await t.account().advanceTime({ seconds: 23 * HOUR + 60 });
    expect((await stripe.subscriptions.retrieve(incomplete.id)).status).toBe('incomplete_expired');
    // Only canceled subscriptions leave the default list ("subscriptions that have not been
    // canceled"); incomplete_expired stays.
    expect(ids(await stripe.subscriptions.list())).toEqual([incomplete.id, second.id, trialing.id, active.id]);
    expect(ids(await stripe.subscriptions.list({ status: 'incomplete_expired' }))).toEqual([incomplete.id]);
    expect(ids(await stripe.subscriptions.list({ status: 'ended' }))).toEqual([incomplete.id]);
    expect(ids(await stripe.subscriptions.list({ customer: noCard.id, status: 'all' }))).toEqual([incomplete.id]);

    const badStatus = await rejection(stripe.subscriptions.list({ status: 'sleeping' }));
    expect([badStatus.statusCode, badStatus.rawType, badStatus.param]).toEqual([400, 'invalid_request_error', 'status']);
    const badLimit = await rejection(stripe.subscriptions.list({ limit: 101 }));
    expect([badLimit.statusCode, badLimit.param]).toEqual([400, 'limit']);
  });

  it('lists invoices by customer, subscription and status with limit, in both version shapes', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const a = await customerWithCard(stripe, 'a@example.com');
    const b = await customerWithCard(stripe, 'b@example.com');
    const subA1 = await stripe.subscriptions.create({ customer: a.id, items: [{ price: c.basicMonthly.id }] });
    const subA2 = await stripe.subscriptions.create({ customer: a.id, items: [{ price: c.proMonthly.id }] });
    const subB = await stripe.subscriptions.create({ customer: b.id, items: [{ price: c.proMonthly.id }] });
    const lastEnd = Math.max(...[subA1, subA2, subB].map((s) => s.items.data[0].current_period_end));
    await t.account().advanceTime({ to: lastEnd });
    const draftA1 = (await stripe.subscriptions.retrieve(subA1.id)).latest_invoice;
    const draftA2 = (await stripe.subscriptions.retrieve(subA2.id)).latest_invoice;
    const draftB = (await stripe.subscriptions.retrieve(subB.id)).latest_invoice;

    const forA = await stripe.invoices.list({ customer: a.id });
    expect(forA.data).toHaveLength(4);
    expect(forA.data.every((i) => i.customer === a.id)).toBe(true);
    const forA1 = await stripe.invoices.list({ subscription: subA1.id });
    expect(ids(forA1)).toEqual([draftA1, subA1.latest_invoice]);
    expect(forA1.data.map((i) => i.parent.subscription_details.subscription)).toEqual([subA1.id, subA1.id]);
    expect(forA1.data.map((i) => i.status)).toEqual(['draft', 'paid']);
    expect(ids(await stripe.invoices.list({ status: 'draft' })).sort()).toEqual([draftA1, draftA2, draftB].sort());
    expect(ids(await stripe.invoices.list({ status: 'paid' })).sort()).toEqual([subA1.latest_invoice, subA2.latest_invoice, subB.latest_invoice].sort());
    expect(ids(await stripe.invoices.list({ customer: b.id, status: 'draft' }))).toEqual([draftB]);
    expect(ids(await stripe.invoices.list({ subscription: subA2.id, status: 'open' }))).toEqual([]);

    const page = await stripe.invoices.list({ limit: 2 });
    expect([page.data.length, page.has_more, page.url]).toEqual([2, true, '/v1/invoices']);
    const every = [];
    for await (const invoice of stripe.invoices.list({ limit: 2 })) every.push(invoice.id);
    expect(new Set(every).size).toBe(6);

    const legacy = await stripe.invoices.list({ subscription: subA1.id }, { apiVersion: '2024-06-20' });
    expect(legacy.data.map((i) => i.subscription)).toEqual([subA1.id, subA1.id]);
    expect(legacy.data[0].parent).toBeUndefined();

    const badStatus = await rejection(stripe.invoices.list({ status: 'late' }));
    expect([badStatus.statusCode, badStatus.param]).toEqual([400, 'status']);
    const missing = await rejection(stripe.invoices.retrieve('in_missing'));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([404, 'resource_missing', 'id']);
  });

  it('lists portal configurations by combined active and is_default filters with limit, and retrieves one by ID', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const first = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const second = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } }, name: 'Second' });
    const third = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: false } } });
    await stripe.billingPortal.configurations.update(third.id, { active: false });

    const list = (params) => stripe.billingPortal.configurations.list(params).then(ids);
    expect(await list()).toEqual([third.id, second.id, first.id]);
    expect(await list({ active: true })).toEqual([second.id, first.id]);
    expect(await list({ is_default: false })).toEqual([third.id, second.id]);
    expect(await list({ is_default: false, active: true })).toEqual([second.id]);
    expect(await list({ is_default: true, active: false })).toEqual([]);
    const page = await stripe.billingPortal.configurations.list({ limit: 1 });
    expect([ids(page), page.has_more, page.url]).toEqual([[third.id], true, '/v1/billing_portal/configurations']);

    expect(await stripe.billingPortal.configurations.retrieve(second.id)).toMatchObject({ id: second.id, name: 'Second', is_default: false, active: true });
    const missing = await rejection(stripe.billingPortal.configurations.retrieve('bpc_missing'));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([404, 'resource_missing', 'id']);
  });
});

describe('checkout sessions', () => {
  it('retrieves a session before and after completion with status, payment_status, customer, subscription and metadata, and lists it by those filters', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await stripe.customers.create({ email: 'jenny@example.com' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: c.proMonthly.id, quantity: 1 }],
      success_url: 'https://example.com/ok?session_id={CHECKOUT_SESSION_ID}',
      metadata: { order: '7' },
    });

    const open = await stripe.checkout.sessions.retrieve(session.id);
    expect(open).toMatchObject({
      id: session.id,
      status: 'open',
      payment_status: 'unpaid',
      customer: customer.id,
      subscription: null,
      invoice: null,
      metadata: { order: '7' },
      url: session.url,
    });

    const done = await postForm(session.url, { card_number: '4242424242424242' });
    expect([done.status, done.location]).toEqual([303, `https://example.com/ok?session_id=${session.id}`]);

    const complete = await stripe.checkout.sessions.retrieve(session.id);
    expect(complete).toMatchObject({ status: 'complete', payment_status: 'paid', customer: customer.id, metadata: { order: '7' }, url: null });
    expect(complete.subscription).toMatch(/^sub_/);
    expect(complete.invoice).toMatch(/^in_/);
    const expanded = await stripe.checkout.sessions.retrieve(session.id, { expand: ['customer', 'subscription.latest_invoice'] });
    expect(expanded.customer).toMatchObject({ id: customer.id, object: 'customer' });
    expect(expanded.subscription).toMatchObject({ id: complete.subscription, status: 'active', customer: customer.id });
    expect(expanded.subscription.latest_invoice).toMatchObject({ id: complete.invoice, object: 'invoice', status: 'paid', amount_paid: 2000 });

    const other = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: 'other@example.com',
      line_items: [{ price: c.basicMonthly.id, quantity: 1 }],
      success_url: 'https://example.com/ok',
    });
    expect(ids(await stripe.checkout.sessions.list({ customer: customer.id }))).toEqual([session.id]);
    expect(ids(await stripe.checkout.sessions.list({ subscription: complete.subscription }))).toEqual([session.id]);
    expect(ids(await stripe.checkout.sessions.list({ status: 'complete' }))).toEqual([session.id]);
    expect(ids(await stripe.checkout.sessions.list({ status: 'open' }))).toEqual([other.id]);

    const missing = await rejection(stripe.checkout.sessions.retrieve('cs_test_missing'));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([404, 'resource_missing', 'id']);
    // Only an open session can be expired.
    const expireComplete = await rejection(stripe.checkout.sessions.expire(session.id));
    expect([expireComplete.statusCode, expireComplete.rawType]).toEqual([400, 'invalid_request_error']);
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe('complete');
  });
});

describe('idempotency', () => {
  it('rejects a reused Checkout Session key with other parameters as idempotency_error', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const params = { mode: 'subscription', line_items: [{ price: c.proMonthly.id, quantity: 1 }], success_url: 'https://example.com/ok' };
    const first = await stripe.checkout.sessions.create(params, { idempotencyKey: 'cs-key' });
    const other = await rejection(stripe.checkout.sessions.create({ ...params, line_items: [{ price: c.basicMonthly.id, quantity: 1 }] }, { idempotencyKey: 'cs-key' }));
    expect([other.type, other.statusCode, other.rawType]).toEqual(['StripeIdempotencyError', 400, 'idempotency_error']);
    const elsewhere = await rejection(stripe.customers.create({}, { idempotencyKey: 'cs-key' }));
    expect(elsewhere.type).toBe('StripeIdempotencyError');
    expect(ids(await stripe.checkout.sessions.list())).toEqual([first.id]);
  });

  it('replays a subscription creation without charging again, until 24 hours of account time have passed', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const params = { customer: customer.id, items: [{ price: c.proMonthly.id }] };
    const first = await stripe.subscriptions.create(params, { idempotencyKey: 'sub-key' });
    const replay = await stripe.subscriptions.create(params, { idempotencyKey: 'sub-key' });
    expect(replay.id).toBe(first.id);
    expect(replay.lastResponse.headers['idempotent-replayed']).toBe('true');
    expect((await stripe.subscriptions.list({ customer: customer.id })).data).toHaveLength(1);
    expect((await stripe.invoices.list({ customer: customer.id })).data).toHaveLength(1);
    expect((await stripe.events.list({ type: 'invoice.paid' })).data).toHaveLength(1);

    await t.account().advanceTime({ seconds: 24 * HOUR - 120 });
    const stillSaved = await stripe.subscriptions.create(params, { idempotencyKey: 'sub-key' });
    expect([stillSaved.id, stillSaved.lastResponse.headers['idempotent-replayed']]).toEqual([first.id, 'true']);
    const [created] = (await stripe.events.list({ type: 'customer.subscription.created' })).data;
    expect(created.request).toEqual({ id: first.lastResponse.requestId, idempotency_key: 'sub-key' });

    await t.account().advanceTime({ seconds: 240 });
    const fresh = await stripe.subscriptions.create(params, { idempotencyKey: 'sub-key' });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.lastResponse.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('idempotent card errors', () => {
  it('replays a 402 from subscription creation without attempting the charge again', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    await t.account().failNextCharge(customer.id);
    const params = { customer: customer.id, items: [{ price: c.proMonthly.id }], payment_behavior: 'error_if_incomplete' };
    const first = await rejection(stripe.subscriptions.create(params, { idempotencyKey: 'declined' }));
    expect([first.statusCode, first.type, first.code]).toEqual([402, 'StripeCardError', 'card_declined']);
    // A.7: errors raised while executing are saved, so the replay answers the same 402 even though
    // the queued failure is used up and a fresh attempt would now succeed.
    const replay = await rejection(stripe.subscriptions.create(params, { idempotencyKey: 'declined' }));
    expect([replay.statusCode, replay.code, replay.headers['idempotent-replayed']]).toEqual([402, 'card_declined', 'true']);
    expect((await stripe.subscriptions.list({ customer: customer.id, status: 'all' })).data).toEqual([]);
    const fresh = await stripe.subscriptions.create(params, { idempotencyKey: 'declined-2' });
    expect(fresh.status).toBe('active');
  });
});

describe('subscription schedules', () => {
  it('clears the cancel_at a schedule set when released, keeps it with preserve_cancel_date, and releases not_started schedules', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const pm = (await stripe.customers.retrieve(customer.id)).invoice_settings.default_payment_method;
    const create = () =>
      stripe.subscriptionSchedules.create({
        customer: customer.id,
        end_behavior: 'cancel',
        default_settings: { default_payment_method: pm },
        phases: [{ items: [{ price: c.basicMonthly.id }], duration: { interval: 'month', interval_count: 2 } }],
      });

    const cleared = await create();
    const phaseEnd = cleared.phases[0].end_date;
    expect(cleared).toMatchObject({ status: 'active', current_phase: { start_date: cleared.phases[0].start_date, end_date: phaseEnd } });
    expect((await stripe.subscriptions.retrieve(cleared.subscription)).cancel_at).toBe(phaseEnd);
    const released = await stripe.subscriptionSchedules.release(cleared.id);
    expect(released).toMatchObject({ status: 'released', subscription: null, released_subscription: cleared.subscription, current_phase: null });
    expect(released.released_at).toEqual(expect.any(Number));
    expect(await stripe.subscriptionSchedules.retrieve(cleared.id)).toMatchObject({ status: 'released', released_subscription: cleared.subscription });
    expect(await stripe.subscriptions.retrieve(cleared.subscription)).toMatchObject({ status: 'active', schedule: null, cancel_at: null });

    const kept = await create();
    await stripe.subscriptionSchedules.release(kept.id, { preserve_cancel_date: true });
    expect(await stripe.subscriptions.retrieve(kept.subscription)).toMatchObject({ status: 'active', schedule: null, cancel_at: kept.phases[0].end_date });

    const later = await stripe.subscriptionSchedules.create({
      customer: customer.id,
      start_date: (await t.account().now()).now + 5 * DAY,
      phases: [{ items: [{ price: c.basicMonthly.id }] }],
    });
    expect(later.status).toBe('not_started');
    expect(await stripe.subscriptionSchedules.release(later.id)).toMatchObject({ status: 'released', subscription: null });
    await t.account().advanceTime({ seconds: 6 * DAY });
    expect((await stripe.subscriptions.list({ customer: customer.id, status: 'all' })).data).toHaveLength(2);

    expect((await stripe.events.list({ type: 'subscription_schedule.released' })).data).toHaveLength(3);
    const missing = await rejection(stripe.subscriptionSchedules.retrieve('sub_sched_missing'));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([404, 'resource_missing', 'id']);
  });
});

describe('portal sessions', () => {
  it('rejects flow_data that the configuration or the subscription cannot satisfy', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const single = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }] });
    const multi = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }, { price: c.proMonthly.id }] });
    const canceled = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }] });
    await stripe.subscriptions.cancel(canceled.id);
    const updates = await stripe.billingPortal.configurations.create({
      features: {
        subscription_update: { enabled: true, default_allowed_updates: ['price'], products: [{ product: c.basic.id, prices: [c.basicMonthly.id] }, { product: c.pro.id, prices: [c.proMonthly.id] }] },
        subscription_cancel: { enabled: true },
      },
    });
    const cancelOnly = await stripe.billingPortal.configurations.create({ features: { subscription_cancel: { enabled: true } } });
    const session = (configuration, flow_data) => stripe.billingPortal.sessions.create({ customer: customer.id, return_url: RETURN_URL, configuration: configuration.id, flow_data });
    const confirm = (subscription, items) => ({ type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscription.id, items } });

    const twoItems = await rejection(
      session(updates, confirm(single, [{ id: single.items.data[0].id, price: c.proMonthly.id }, { id: single.items.data[0].id, price: c.basicMonthly.id }])),
    );
    expect([twoItems.statusCode, twoItems.rawType]).toEqual([400, 'invalid_request_error']);
    expect(twoItems.param).toMatch(/^flow_data\[subscription_update_confirm\]\[items\]/);
    const multiItemSub = await rejection(session(updates, confirm(multi, [{ id: multi.items.data[0].id, price: c.proMonthly.id }])));
    expect([multiItemSub.statusCode, multiItemSub.rawType]).toEqual([400, 'invalid_request_error']);
    expect(multiItemSub.param).toMatch(/^flow_data\[subscription_update_confirm\]/);
    const updateDisabled = await rejection(session(cancelOnly, { type: 'subscription_update', subscription_update: { subscription: single.id } }));
    expect([updateDisabled.statusCode, updateDisabled.rawType]).toEqual([400, 'invalid_request_error']);
    expect(updateDisabled.param).toMatch(/^flow_data\[/);
    const cancelCanceled = await rejection(session(updates, { type: 'subscription_cancel', subscription_cancel: { subscription: canceled.id } }));
    expect([cancelCanceled.statusCode, cancelCanceled.param]).toEqual([400, 'flow_data[subscription_cancel][subscription]']);
    const unknownSub = await rejection(session(updates, { type: 'subscription_cancel', subscription_cancel: { subscription: 'sub_missing' } }));
    expect([unknownSub.statusCode, unknownSub.code, unknownSub.param]).toEqual([400, 'resource_missing', 'flow_data[subscription_cancel][subscription]']);

    const ok = await session(updates, confirm(single, [{ id: single.items.data[0].id, price: c.proMonthly.id }]));
    expect(ok.flow.type).toBe('subscription_update_confirm');
    expect((await stripe.events.list({ type: 'billing_portal.session.created' })).data).toHaveLength(1);
  });

  it('cancels through a subscription_cancel deep link and redirects to after_completion.redirect.return_url', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }] });
    await stripe.billingPortal.configurations.create({ features: { subscription_cancel: { enabled: true, mode: 'at_period_end' } } });
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: RETURN_URL,
      flow_data: {
        type: 'subscription_cancel',
        subscription_cancel: { subscription: sub.id },
        after_completion: { type: 'redirect', redirect: { return_url: 'https://example.com/canceled' } },
      },
    });
    expect(session.flow).toEqual({
      after_completion: { hosted_confirmation: null, redirect: { return_url: 'https://example.com/canceled' }, type: 'redirect' },
      customer_update: null,
      subscription_cancel: { retention: null, subscription: sub.id },
      subscription_update: null,
      subscription_update_confirm: null,
      type: 'subscription_cancel',
    });
    const landing = await getPage(session.url);
    expect(landing.status).toBe(200);
    expect(landing.text).toContain(`href="${RETURN_URL}"`);
    const done = await postForm(session.url, { action: 'cancel_subscription', subscription: sub.id });
    expect([done.status, done.location]).toEqual([303, 'https://example.com/canceled']);
    const canceling = await stripe.subscriptions.retrieve(sub.id);
    expect(canceling).toMatchObject({ status: 'active', cancel_at: sub.items.data[0].current_period_end, cancellation_details: { reason: 'cancellation_requested' } });
  });
});

describe('hosted invoice URL', () => {
  it('has no hosted URL while a draft, and shows a paid invoice without a card form', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.proMonthly.id }] });
    const paid = await stripe.invoices.retrieve(sub.latest_invoice);
    expect(paid.status).toBe('paid');
    expect(paid.hosted_invoice_url).toMatch(new RegExp(`^${t.url}/i/acct_\\w+/test_\\w+$`));
    expect(paid.invoice_pdf).toBe(`${paid.hosted_invoice_url}/pdf`);
    const page = await getPage(paid.hosted_invoice_url);
    expect(page.status).toBe(200);
    expect(page.text).toContain(paid.number);
    expect(page.text).not.toContain('name="card_number"');

    await t.account().advanceTime({ to: sub.items.data[0].current_period_end });
    const draft = await stripe.invoices.retrieve((await stripe.subscriptions.retrieve(sub.id)).latest_invoice);
    expect([draft.status, draft.hosted_invoice_url, draft.invoice_pdf, draft.number]).toEqual(['draft', null, null, null]);
    await t.account().advanceTime({ seconds: 2 * HOUR });
    const finalized = await stripe.invoices.retrieve(draft.id);
    expect(finalized.status).toBe('paid');
    expect(finalized.hosted_invoice_url).toMatch(/\/i\/acct_/);
    expect(finalized.hosted_invoice_url).not.toBe(paid.hosted_invoice_url);
  });
});

describe('test clocks', () => {
  it('creates, retrieves, lists and advances an empty clock, validating its parameters', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const missing = await rejection(stripe.testHelpers.testClocks.create({ name: 'no time' }));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([400, 'parameter_missing', 'frozen_time']);
    const longName = await rejection(stripe.testHelpers.testClocks.create({ frozen_time: T0, name: 'x'.repeat(301) }));
    expect([longName.statusCode, longName.param]).toEqual([400, 'name']);

    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: T0, name: 'Monthly' });
    expect(clock.id).toMatch(/^clock_/);
    expect(clock).toMatchObject({ object: 'test_helpers.test_clock', frozen_time: T0, name: 'Monthly', status: 'ready', livemode: false });
    // deletes_after = created + 30 days (the test clocks guide's prose; the API examples show 7 days).
    expect(clock.deletes_after - clock.created).toBe(30 * DAY);
    expect(await stripe.testHelpers.testClocks.retrieve(clock.id)).toMatchObject({ id: clock.id, frozen_time: T0, status: 'ready' });
    const other = await stripe.testHelpers.testClocks.create({ frozen_time: T0 });
    expect(other.name).toBeNull();
    const listed = await stripe.testHelpers.testClocks.list({ limit: 1 });
    expect([ids(listed), listed.has_more]).toEqual([[other.id], true]);

    const noTarget = await rejection(stripe.testHelpers.testClocks.advance(clock.id, {}));
    expect([noTarget.code, noTarget.param]).toEqual(['parameter_missing', 'frozen_time']);
    const advancing = await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: T0 + 40 * DAY });
    expect(advancing).toMatchObject({ status: 'advancing', frozen_time: T0, status_details: { advancing: { target_frozen_time: T0 + 40 * DAY } } });
    expect(await stripe.testHelpers.testClocks.retrieve(clock.id)).toMatchObject({ status: 'ready', frozen_time: T0 + 40 * DAY, status_details: {} });

    const types = (await allEvents(stripe)).map((e) => [e.type, e.data.object.id]);
    expect(types).toEqual([
      ['test_helpers.test_clock.created', clock.id],
      ['test_helpers.test_clock.created', other.id],
      ['test_helpers.test_clock.advancing', clock.id],
      ['test_helpers.test_clock.ready', clock.id],
    ]);
    const unknown = await rejection(stripe.testHelpers.testClocks.retrieve('clock_missing'));
    expect([unknown.statusCode, unknown.code, unknown.param]).toEqual([404, 'resource_missing', 'id']);
    const unknownAdvance = await rejection(stripe.testHelpers.testClocks.advance('clock_missing', { frozen_time: T0 + DAY }));
    expect([unknownAdvance.statusCode, unknownAdvance.code]).toEqual([404, 'resource_missing']);
  });

  it('attaches an existing customer at create, within the documented limits', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const now = (await t.account().now()).now;
    const plain = await stripe.customers.create({ email: 'plain@example.com' });
    const past = await rejection(stripe.testHelpers.testClocks.create({ frozen_time: now - DAY, customer: plain.id }));
    expect([past.statusCode, past.param]).toEqual([400, 'frozen_time']);
    const unknown = await rejection(stripe.testHelpers.testClocks.create({ frozen_time: now + DAY, customer: 'cus_missing' }));
    expect([unknown.statusCode, unknown.code, unknown.param]).toEqual([400, 'resource_missing', 'customer']);

    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now + DAY, customer: plain.id });
    expect((await stripe.customers.retrieve(plain.id)).test_clock).toBe(clock.id);
    expect(ids(await stripe.customers.list())).not.toContain(plain.id);
    expect(ids(await stripe.customers.list({ test_clock: clock.id }))).toEqual([plain.id]);
    const twice = await rejection(stripe.testHelpers.testClocks.create({ frozen_time: now + DAY, customer: plain.id }));
    expect([twice.statusCode, twice.param]).toEqual([400, 'customer']);

    // Only a customer that already exceeds the per-clock subscription limit (three)
    // is refused; one live subscription is within the limit.
    const subscribed = await customerWithCard(stripe, 'subscribed@example.com');
    await stripe.subscriptions.create({ customer: subscribed.id, items: [{ price: c.basicMonthly.id }] });
    const withSub = await stripe.testHelpers.testClocks.create({ frozen_time: now + DAY, customer: subscribed.id });
    expect((await stripe.customers.retrieve(subscribed.id)).test_clock).toBe(withSub.id);
  });
});

describe('deleted customers', () => {
  it('cancels the live subscriptions, then refuses the customer as resource_missing everywhere it is referenced', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }] });
    await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const before = (await allEvents(stripe)).length;
    expect(await stripe.customers.del(customer.id)).toEqual({ id: customer.id, object: 'customer', deleted: true });
    const types = (await allEvents(stripe)).slice(before).map((e) => e.type);
    expect(types.indexOf('customer.subscription.deleted')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('customer.subscription.deleted')).toBeLessThan(types.indexOf('customer.deleted'));
    expect(await stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'canceled', cancellation_details: { reason: 'cancellation_requested' } });

    // Using a deleted customer as a body param → 400 resource_missing with param customer.
    const uses = [
      ['subscriptions.create', stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }] })],
      [
        'checkout.sessions.create',
        stripe.checkout.sessions.create({ mode: 'subscription', customer: customer.id, line_items: [{ price: c.basicMonthly.id, quantity: 1 }], success_url: 'https://example.com/ok' }),
      ],
      ['billingPortal.sessions.create', stripe.billingPortal.sessions.create({ customer: customer.id, return_url: RETURN_URL })],
      ['paymentMethods.attach', stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })],
    ];
    for (const [name, call] of uses) {
      const err = await rejection(call);
      expect([err.statusCode, err.code, err.param], name).toEqual([400, 'resource_missing', 'customer']);
    }
    const update = await rejection(stripe.customers.update(customer.id, { name: 'x' }));
    expect([update.statusCode, update.code]).toEqual([404, 'resource_missing']);
    expect((await stripe.subscriptions.list({ customer: customer.id })).data).toEqual([]);
  });
});

describe('versions', () => {
  it('switches subscription and invoice shapes exactly at 2025-03-31.basil', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.proMonthly.id }] });
    const { current_period_start: start, current_period_end: end } = sub.items.data[0];

    const acacia = { apiVersion: '2025-02-24.acacia' };
    const oldSub = await stripe.subscriptions.retrieve(sub.id, {}, acacia);
    expect([oldSub.current_period_start, oldSub.current_period_end]).toEqual([start, end]);
    expect(oldSub.items.data[0].current_period_start).toBeUndefined();
    const oldInvoice = await stripe.invoices.retrieve(sub.latest_invoice, {}, acacia);
    expect(oldInvoice.subscription).toBe(sub.id);
    expect(oldInvoice.parent).toBeUndefined();
    expect(oldInvoice.lastResponse.headers['stripe-version']).toBe('2025-02-24.acacia');

    const basil = { apiVersion: '2025-03-31.basil' };
    const newSub = await stripe.subscriptions.retrieve(sub.id, {}, basil);
    expect(newSub.current_period_start).toBeUndefined();
    expect(newSub.current_period_end).toBeUndefined();
    expect([newSub.items.data[0].current_period_start, newSub.items.data[0].current_period_end]).toEqual([start, end]);
    const newInvoice = await stripe.invoices.retrieve(sub.latest_invoice, {}, basil);
    expect(newInvoice.subscription).toBeUndefined();
    expect(newInvoice.parent).toMatchObject({ type: 'subscription_details', quote_details: null, subscription_details: { subscription: sub.id } });
  });

  it('accepts the portal parameters from their first version and rejects them on the version before, on create and update', async () => {
    const t = await startServer();
    const at = (apiVersion) => t.stripe(t.key, { apiVersion });
    const scheduled = { enabled: false, schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] } };

    const acacia = await at('2024-10-28.acacia').billingPortal.configurations.create({ features: { subscription_update: scheduled } });
    expect(acacia.features.subscription_update.schedule_at_period_end).toEqual({ conditions: [{ type: 'decreasing_item_amount' }] });
    const tooEarly = await rejection(at('2024-09-30.acacia').billingPortal.configurations.update(acacia.id, { features: { subscription_update: scheduled } }));
    expect([tooEarly.statusCode, tooEarly.rawType, tooEarly.code, tooEarly.param]).toEqual([
      400,
      'invalid_request_error',
      'parameter_unknown',
      'features[subscription_update][schedule_at_period_end]',
    ]);

    const trial = { trial_update_behavior: 'continue_trial' };
    const clover = await at('2025-09-30.clover').billingPortal.configurations.update(acacia.id, { features: { subscription_update: trial } });
    expect(clover.features.subscription_update.trial_update_behavior).toBe('continue_trial');
    const basil = await rejection(at('2025-08-27.basil').billingPortal.configurations.update(acacia.id, { features: { subscription_update: trial } }));
    expect([basil.statusCode, basil.code, basil.param]).toEqual([400, 'parameter_unknown', 'features[subscription_update][trial_update_behavior]']);
    expect((await t.stripe().billingPortal.configurations.retrieve(acacia.id)).features.subscription_update.trial_update_behavior).toBe('continue_trial');
  });
});

describe('controls over HTTP', () => {
  it('adds, lists and clears faults over HTTP, and the SDK sees them', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const added = await t.request('POST', '/_test/faults', { json: { method: 'POST', path: '/v1/customers', kind: '429', times: 2 } });
    expect(added.status).toBe(200);
    expect(added.json).toMatchObject({ method: 'POST', path: '/v1/customers', kind: '429', remaining: 2 });
    const listed = await t.request('GET', '/_test/faults');
    expect(listed.json).toHaveLength(1);
    const limited = await rejection(stripe.customers.create());
    expect([limited.type, limited.statusCode]).toEqual(['StripeRateLimitError', 429]);
    expect((await t.request('GET', '/_test/faults')).json[0].remaining).toBe(1);
    expect((await t.request('DELETE', '/_test/faults')).json).toEqual({ cleared: 1 });
    expect((await stripe.customers.create()).object).toBe('customer');
    const bad = await t.request('POST', '/_test/faults', { json: { path: '/v1/customers', kind: 'teapot' } });
    expect([bad.status, bad.json.error.type]).toEqual([400, 'invalid_request_error']);
  });

  it('creates a second live subscription, reads settings and state, and deletes a customer over HTTP', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await customerWithCard(stripe, 'jenny@example.com');
    const first = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }] });

    const second = await t.request('POST', '/_test/create_subscription', { json: { customer: customer.id, price: c.proMonthly.id, quantity: 2 } });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ object: 'subscription', customer: customer.id, status: 'active' });
    expect(second.json.items.data[0]).toMatchObject({ quantity: 2, price: { id: c.proMonthly.id } });
    const trial = await t.request('POST', '/_test/create_subscription', { json: { customer: customer.id, price: c.proYearly.id, trialDays: 7 } });
    expect(trial.json).toMatchObject({ status: 'trialing' });
    expect(trial.json.trial_end - trial.json.trial_start).toBe(7 * DAY);
    expect(ids(await stripe.subscriptions.list({ customer: customer.id }))).toEqual([trial.json.id, second.json.id, first.id]);
    const noPrice = await t.request('POST', '/_test/create_subscription', { json: { customer: customer.id } });
    expect([noPrice.status, noPrice.json.error.param]).toEqual([400, 'price']);

    const settings = await t.request('GET', '/_test/billing_settings');
    // Default Billing settings: seven retries two days apart, then cancel; invoices are not marked
    // uncollectible.
    expect(settings.json).toEqual({ retrySchedule: [2, 2, 2, 2, 2, 2, 2], afterFinalRetry: 'cancel', markUncollectible: false });
    const raw = await t.request('GET', '/_test/state?type=subscription&raw=true');
    expect(raw.json.objects.subscription).toHaveLength(3);
    expect(raw.json.objects.subscription[0]).toHaveProperty('_seq');
    expect(raw.json.jobs.length).toBeGreaterThan(0);
    const otherKey = testKey('other');
    const otherState = await t.request('GET', '/_test/state?type=subscription', { key: otherKey });
    expect(otherState.json.objects.subscription).toEqual([]);

    const deleted = await t.request('POST', '/_test/delete_customer', { json: { customer: customer.id } });
    expect(deleted.json).toEqual({ id: customer.id, object: 'customer', deleted: true });
    expect(await stripe.customers.retrieve(customer.id)).toEqual({ id: customer.id, object: 'customer', deleted: true });
    expect((await stripe.subscriptions.list({ status: 'canceled' })).data).toHaveLength(3);
    const again = await t.request('POST', '/_test/delete_customer', { json: { customer: customer.id } });
    expect([again.status, again.json.error.code, again.json.error.param]).toEqual([400, 'resource_missing', 'customer']);
    const [event] = (await stripe.events.list({ type: 'customer.deleted' })).data;
    expect(event.request).toEqual({ id: null, idempotency_key: null });
  });

  it('resends, duplicates, holds, releases and sends bad signatures through the webhook controls over HTTP', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer();
    const stripe = t.stripe();
    await t.request('PUT', '/_test/webhook_endpoints', { json: { endpoints: [{ url: hooks.url, secret: SECRET }] } });
    await stripe.customers.create({ name: 'one' });
    await t.request('POST', '/_test/webhooks/settle', { json: {} });
    const eventId = hooks.deliveries[0].json.id;

    const resent = await t.request('POST', '/_test/webhooks/resend', { json: { eventId } });
    expect(resent.json.deliveries.map((d) => d.kind)).toEqual(['resend']);
    const duplicates = await t.request('POST', '/_test/webhooks/deliver_duplicate', { json: { eventId } });
    expect(duplicates.json.deliveries.map((d) => d.kind)).toEqual(['duplicate', 'duplicate']);
    const bad = await t.request('POST', '/_test/webhooks/send_with_bad_signature', { json: { eventId } });
    expect(bad.json.deliveries.map((d) => d.kind)).toEqual(['bad_signature']);
    await t.request('POST', '/_test/webhooks/settle', { json: {} });
    expect(hooks.deliveries).toHaveLength(5);
    expect(hooks.deliveries.map((d) => d.json.id)).toEqual([eventId, eventId, eventId, eventId, eventId]);
    const verified = hooks.deliveries.map((d) => {
      try {
        return stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], SECRET).id;
      } catch {
        return 'rejected';
      }
    });
    expect(verified).toEqual([eventId, eventId, eventId, eventId, 'rejected']);

    const held = await t.request('POST', '/_test/webhooks/hold', { json: {} });
    expect(held.json).toMatchObject({ held: true });
    await stripe.customers.create({ name: 'two' });
    await stripe.customers.create({ name: 'three' });
    await t.request('POST', '/_test/webhooks/settle', { json: {} });
    expect(hooks.deliveries).toHaveLength(5);
    const heldList = await t.request('GET', '/_test/webhooks/deliveries?status=held');
    expect(heldList.json).toHaveLength(2);
    const released = await t.request('POST', '/_test/webhooks/release', { json: { order: 'reverse' } });
    expect(released.json.released).toBe(2);
    await t.request('POST', '/_test/webhooks/settle', { json: {} });
    expect(hooks.deliveries.slice(5).map((d) => d.json.data.object.name)).toEqual(['three', 'two']);
    // An unknown ID sent in the body is a 400 resource_missing with that param
    // (404 only for path IDs), as /_test/fail_next_charge and /_test/delete_customer answer.
    const unknown = await t.request('POST', '/_test/webhooks/resend', { json: { eventId: 'evt_missing' } });
    expect([unknown.status, unknown.json.error.code, unknown.json.error.param]).toEqual([400, 'resource_missing', 'eventId']);
  });
});
