/**
 * End-to-end Billing flows, driven the way an application and its customers drive Stripe: the
 * real stripe SDK for API calls, the hosted Checkout, portal and invoice pages through plain HTTP
 * (GET a page, follow its links, submit its forms), and a webhook endpoint that verifies every
 * delivery with stripe.webhooks.constructEvent. Each flow asserts the objects and the exact events
 * it produces, in order.
 */
import { describe, expect, it } from 'vitest';
import { startServer, webhookReceiver } from './helpers.js';
import { addIntervals } from '../src/core/periods.js';

const DAY = 86400;
const HOUR = 3600;
const SECRET = 'whsec_flows_endpoint_secret';
const APP = 'https://app.example.com';
const CARD_OK = '4242424242424242';
/** Attaches, then every charge fails (Stripe's recipe for failed renewals). */
const CARD_FAILS_LATER = '4000000000000341';

// Harness --------------------------------------------------------------------------------------

/**
 * A server with one webhook endpoint (a local receiver), an SDK client and the verified events.
 * `events()` waits until nothing is pending, verifies every new delivery with constructEvent and
 * returns the new events in delivery order.
 */
async function flowServer(options = {}) {
  const hooks = await webhookReceiver();
  const t = await startServer({ webhooks: [{ url: hooks.url, secret: SECRET }], ...options });
  const stripe = t.stripe();
  let seen = 0;
  const all = [];
  async function events() {
    await t.server.settle();
    const fresh = hooks.deliveries.slice(seen).map((d) => {
      const header = d.headers['stripe-signature'];
      expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      // Signatures carry real time even when the account or a test clock is far ahead.
      expect(Math.abs(Number(/^t=(\d+)/.exec(header)[1]) - Date.now() / 1000)).toBeLessThan(60);
      return stripe.webhooks.constructEvent(d.rawBody, header, SECRET);
    });
    seen = hooks.deliveries.length;
    all.push(...fresh);
    return fresh;
  }
  const types = async () => (await events()).map((e) => e.type);
  /** Every event of the account was delivered exactly once, in the order the events API gives. */
  async function expectAllDelivered() {
    await events();
    const listed = [];
    for await (const e of stripe.events.list({ limit: 100 })) listed.push(e.id);
    expect(all.map((e) => e.id)).toEqual(listed.reverse());
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect((await stripe.events.list({ delivery_success: false })).data).toEqual([]);
  }
  return { t, stripe, account: t.account(), events, types, expectAllDelivered };
}

/** Pro ($30 / month) and Basic ($10 / month), announced by their events. */
async function catalog(f) {
  const pro = await f.stripe.products.create({ name: 'Pro' });
  const basic = await f.stripe.products.create({ name: 'Basic' });
  const proMonthly = await f.stripe.prices.create({ product: pro.id, unit_amount: 3000, currency: 'usd', recurring: { interval: 'month' }, lookup_key: 'pro_monthly' });
  const basicMonthly = await f.stripe.prices.create({ product: basic.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
  const created = await f.events();
  expect(created.map((e) => e.type)).toEqual(['product.created', 'product.created', 'price.created', 'price.created']);
  expect(created.map((e) => e.request.id)).toEqual([pro, basic, proMonthly, basicMonthly].map((o) => o.lastResponse.requestId));
  return { pro, basic, proMonthly, basicMonthly };
}

// A small browser for the hosted pages --------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);

function attributes(source) {
  const out = {};
  for (const m of source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] === undefined ? '' : decode(m[2]);
  return out;
}

/** The forms of a page: action, method and the values a browser would submit as they stand. */
function formsOf(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attrs, inner]) => {
    const a = attributes(attrs);
    const fields = {};
    const radios = new Map();
    for (const [, source] of inner.matchAll(/<input\b([^>]*)>/g)) {
      const input = attributes(source);
      if (!input.name) continue;
      if (input.type === 'radio') {
        if (!radios.has(input.name)) radios.set(input.name, []);
        radios.get(input.name).push(input.value);
        if ('checked' in input) fields[input.name] = input.value;
      } else if (input.type === 'checkbox') {
        if ('checked' in input) fields[input.name] = input.value || 'on';
      } else {
        fields[input.name] = input.value ?? '';
      }
    }
    for (const [, source] of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const { name } = attributes(source);
      if (name) fields[name] = '';
    }
    return { action: a.action ?? '', method: (a.method ?? 'get').toLowerCase(), id: a.id ?? null, fields, radios, html: inner };
  });
}

/** A fetched page with helpers to find links and forms and to submit them. */
class Page {
  constructor(url, res, html) {
    this.url = url;
    this.status = res.status;
    this.location = res.headers.get('location');
    this.html = html;
  }

  /** The absolute href of the first <a> whose tag matches `pattern` (e.g. /class="update"/). */
  link(pattern) {
    const tag = [...this.html.matchAll(/<a\b([^>]*)>/g)].find(([source]) => pattern.test(source));
    if (!tag) throw new Error(`No link matching ${pattern} on ${this.url}:\n${this.html}`);
    return new URL(attributes(tag[1]).href, this.url).href;
  }

  /** The first form whose markup matches `pattern`. */
  form(pattern) {
    const form = formsOf(this.html).find((f) => pattern.test(`<form id="${f.id}" action="${f.action}">${f.html}`));
    if (!form) throw new Error(`No form matching ${pattern} on ${this.url}:\n${this.html}`);
    return form;
  }

  /** Submits `form` with `values` filled in; redirects are not followed (see follow()). */
  submit(form, values = {}) {
    const fields = { ...form.fields, ...values };
    const target = new URL(form.action || this.url, this.url);
    if (form.method === 'get') {
      for (const [k, v] of Object.entries(fields)) target.searchParams.set(k, v);
      return open(target.href);
    }
    return open(target.href, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  }

  /** GETs the Location of a redirect. */
  follow() {
    expect(this.status, `expected a redirect from ${this.url}`).toBe(303);
    return open(new URL(this.location, this.url).href);
  }

  /** The text of the element with `id` (tags removed). */
  text(id) {
    const m = new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(this.html);
    return m ? decode(m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()) : null;
  }
}

async function open(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init });
  return new Page(url, res, await res.text());
}

// Steps shared by the flows ---------------------------------------------------------------------

/**
 * Creates a subscription-mode Checkout Session, opens its hosted page, pays with `card` and
 * follows the flow to success_url. Returns the completed session with subscription and invoice
 * expanded.
 */
async function checkout(f, { price, quantity = 1, trialDays, customer, card = CARD_OK, check } = {}) {
  const session = await f.stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.id, quantity }],
    success_url: `${APP}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP}/pricing`,
    client_reference_id: 'user_42',
    ...(customer ? { customer: customer.id } : { customer_email: 'jenny.rosen@example.com' }),
    subscription_data: { metadata: { plan: 'pro' }, ...(trialDays ? { trial_period_days: trialDays } : {}) },
  });
  expect(session).toMatchObject({ status: 'open', payment_status: 'unpaid', url: expect.stringMatching(/\/c\/pay\/cs_test_/) });
  const page = await open(session.url);
  expect(page.status).toBe(200);
  expect(page.link(/id="cancel"/)).toBe(`${APP}/pricing`);
  if (check) check(page);
  const paid = await page.submit(page.form(/id="checkout-form"/), { card_number: card, exp_month: '12', exp_year: '34', cvc: '123', cardholder_name: 'Jenny Rosen' });
  expect(paid.status).toBe(303);
  expect(paid.location).toBe(`${APP}/welcome?session_id=${session.id}`);
  return f.stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription', 'invoice', 'line_items'] });
}

/** A portal session for `customer` and its homepage. */
async function portal(f, customer, params = {}) {
  const session = await f.stripe.billingPortal.sessions.create({ customer, return_url: `${APP}/account`, ...params });
  const home = await open(session.url);
  expect(home.status).toBe(200);
  expect(home.link(/id="return"/)).toBe(`${APP}/account`);
  return { session, home };
}

/** Moves the account clock to `to` (unix seconds). */
async function advanceTo(f, to) {
  expect((await f.account.advanceTime({ to })).now).toBe(to);
}

/** A test clock advance, polled until the clock is ready again. */
async function advanceClock(f, clock, to) {
  const advancing = await f.stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: to });
  expect(advancing.status).toBe('advancing');
  expect(advancing.status_details.advancing.target_frozen_time).toBe(to);
  const ready = await f.stripe.testHelpers.testClocks.retrieve(clock.id);
  expect([ready.status, ready.frozen_time]).toEqual(['ready', to]);
}

const byType = (events, type) => events.filter((e) => e.type === type);
const one = (events, type) => {
  const found = byType(events, type);
  expect(found, type).toHaveLength(1);
  return found[0];
};
const automatic = { id: null, idempotency_key: null };

/** Events of a paid renewal: finalization after the draft hour, then the successful charge. */
const PAID_AFTER_DRAFT_HOUR = [
  'payment_intent.created',
  'invoice.finalized',
  'charge.succeeded',
  'payment_intent.succeeded',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice_payment.paid',
  'invoice.updated',
];

/** Events of a hosted Checkout that charges the first period now. */
const CHECKOUT_PAID = [
  'customer.created',
  'payment_method.attached',
  'payment_intent.created',
  'charge.succeeded',
  'payment_intent.succeeded',
  'customer.updated',
  'customer.subscription.created',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice_payment.paid',
  'invoice.updated',
  'checkout.session.completed',
];

/** Events of a hosted Checkout that starts a free trial ($0 first invoice, nothing charged). */
const CHECKOUT_TRIAL = [
  'customer.created',
  'payment_method.attached',
  'customer.updated',
  'customer.subscription.created',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'checkout.session.completed',
];

// Flows -------------------------------------------------------------------------------------------

describe('Checkout with a free trial', () => {
  it('starts trialing with a paid $0 invoice, warns three days ahead, then charges the first period at trial end', async () => {
    const f = await flowServer();
    const c = await catalog(f);

    const session = await checkout(f, {
      price: c.proMonthly,
      trialDays: 7,
      check: (page) => {
        expect(page.text('amount-due')).toBe('$0.00 due today');
        expect(page.text('trial')).toBe('7 days free, then $30.00 / month');
        expect(page.text('email-display')).toBe('Email: jenny.rosen@example.com');
      },
    });
    const signup = await f.events();
    expect(signup.map((e) => e.type)).toEqual(CHECKOUT_TRIAL);
    for (const e of signup) expect(e.request).toEqual(automatic);

    const sub = session.subscription;
    const invoice = session.invoice;
    expect(session).toMatchObject({
      status: 'complete',
      payment_status: 'paid',
      amount_subtotal: 0,
      amount_total: 0,
      payment_intent: null,
      url: null,
      client_reference_id: 'user_42',
      customer_details: { email: 'jenny.rosen@example.com', name: 'Jenny Rosen' },
    });
    expect(session.line_items.data).toMatchObject([{ price: { id: c.proMonthly.id }, quantity: 1, description: 'Pro' }]);
    expect(sub).toMatchObject({ status: 'trialing', customer: session.customer, metadata: { plan: 'pro' }, billing_mode: { type: 'flexible' }, latest_invoice: invoice.id });
    expect(sub.trial_end - sub.trial_start).toBe(7 * DAY);
    expect(sub.billing_cycle_anchor).toBe(sub.trial_end);
    expect(sub.items.data[0]).toMatchObject({ price: { id: c.proMonthly.id }, quantity: 1, current_period_start: sub.trial_start, current_period_end: sub.trial_end });
    const card = await f.stripe.paymentMethods.retrieve(sub.default_payment_method);
    expect(card).toMatchObject({ customer: session.customer, card: { brand: 'visa', last4: '4242' }, allow_redisplay: 'limited' });
    const customer = await f.stripe.customers.retrieve(session.customer);
    expect(customer).toMatchObject({ email: 'jenny.rosen@example.com', name: 'Jenny Rosen', currency: 'usd', invoice_settings: { default_payment_method: null } });
    expect(invoice).toMatchObject({ status: 'paid', billing_reason: 'subscription_create', amount_due: 0, amount_paid: 0, total: 0, customer: customer.id });
    expect(invoice.parent.subscription_details.subscription).toBe(sub.id);
    expect(invoice.lines.data.map((l) => [l.description, l.amount])).toEqual([['Free trial for 1 × Pro', 0]]);
    expect(one(signup, 'customer.subscription.created').data.object).toMatchObject({ id: sub.id, status: 'trialing' });
    expect(one(signup, 'invoice.created').data.object).toMatchObject({ id: invoice.id, status: 'draft', amount_due: 0 });
    expect(one(signup, 'checkout.session.completed').data.object).toMatchObject({ id: session.id, status: 'complete', payment_status: 'paid', subscription: sub.id, invoice: invoice.id });

    await advanceTo(f, sub.trial_end - 3 * DAY);
    const warning = await f.events();
    expect(warning.map((e) => e.type)).toEqual(['customer.subscription.trial_will_end']);
    expect(warning[0]).toMatchObject({ created: sub.trial_end - 3 * DAY, request: automatic, data: { object: { id: sub.id, status: 'trialing' } } });

    await advanceTo(f, sub.trial_end);
    const trialEnd = await f.events();
    expect(trialEnd.map((e) => e.type)).toEqual(['customer.subscription.updated', 'invoice.created']);
    const activated = trialEnd[0];
    expect(activated.data.object).toMatchObject({ status: 'active', trial_end: sub.trial_end });
    expect(activated.data.previous_attributes.status).toBe('trialing');
    const draft = trialEnd[1].data.object;
    expect(draft).toMatchObject({ status: 'draft', billing_reason: 'subscription_cycle', amount_due: 3000, auto_advance: true, automatically_finalizes_at: sub.trial_end + HOUR });
    expect(draft.lines.data.map((l) => [l.description, l.amount])).toEqual([['1 × Pro (at $30.00 / month)', 3000]]);

    await advanceTo(f, sub.trial_end + HOUR);
    const charged = await f.events();
    expect(charged.map((e) => e.type)).toEqual(PAID_AFTER_DRAFT_HOUR);
    expect(one(charged, 'invoice.paid').data.object).toMatchObject({ id: draft.id, status: 'paid', amount_paid: 3000, attempt_count: 1 });
    const charge = one(charged, 'charge.succeeded').data.object;
    expect(charge).toMatchObject({ amount: 3000, payment_method: card.id, customer: customer.id });

    const active = await f.stripe.subscriptions.retrieve(sub.id);
    expect(active).toMatchObject({ status: 'active', latest_invoice: draft.id });
    expect(active.items.data[0]).toMatchObject({ current_period_start: sub.trial_end, current_period_end: addIntervals(sub.trial_end, 'month', 1, 1) });
    await f.expectAllDelivered();
  });

  it('runs the same trial on a test clock: every object and event lives on the clock time', async () => {
    const f = await flowServer();
    const c = await catalog(f);
    const T0 = Math.floor(Date.UTC(2030, 0, 15) / 1000);
    const clock = await f.stripe.testHelpers.testClocks.create({ frozen_time: T0, name: 'Trial signup' });
    const customer = await f.stripe.customers.create({ email: 'jenny.rosen@example.com', test_clock: clock.id });
    await f.events();

    const session = await checkout(f, { price: c.proMonthly, trialDays: 7, customer });
    const signup = await f.events();
    expect(signup.map((e) => e.type)).toEqual(CHECKOUT_TRIAL.filter((type) => type !== 'customer.created'));
    for (const e of signup) expect(e.created).toBe(T0);
    const sub = session.subscription;
    expect(session).toMatchObject({ status: 'complete', payment_status: 'paid', amount_total: 0, customer: customer.id, created: T0 });
    expect(sub).toMatchObject({ status: 'trialing', test_clock: clock.id, created: T0, trial_start: T0, trial_end: T0 + 7 * DAY });
    expect(session.invoice).toMatchObject({ status: 'paid', amount_due: 0, created: T0, test_clock: clock.id });

    // Objects on a clock stay out of unfiltered lists.
    expect((await f.stripe.subscriptions.list()).data).toEqual([]);
    expect((await f.stripe.subscriptions.list({ customer: customer.id })).data.map((s) => s.id)).toEqual([sub.id]);

    await advanceClock(f, clock, T0 + 4 * DAY);
    const warning = await f.events();
    expect(warning.map((e) => e.type)).toEqual(['test_helpers.test_clock.advancing', 'customer.subscription.trial_will_end', 'test_helpers.test_clock.ready']);
    expect(warning.map((e) => e.created)).toEqual([T0, T0 + 4 * DAY, T0 + 4 * DAY]);
    expect(warning[0].request.id).toMatch(/^req_/);
    expect(warning[2].request).toEqual(automatic);

    await advanceClock(f, clock, T0 + 7 * DAY + HOUR);
    const charged = await f.events();
    expect(charged.map((e) => e.type)).toEqual([
      'test_helpers.test_clock.advancing',
      'customer.subscription.updated',
      'invoice.created',
      ...PAID_AFTER_DRAFT_HOUR,
      'test_helpers.test_clock.ready',
    ]);
    expect(one(charged, 'invoice.created')).toMatchObject({ created: T0 + 7 * DAY, data: { object: { billing_reason: 'subscription_cycle', amount_due: 3000 } } });
    expect(one(charged, 'invoice.paid')).toMatchObject({ created: T0 + 7 * DAY + HOUR, data: { object: { status: 'paid', amount_paid: 3000 } } });

    const active = await f.stripe.subscriptions.retrieve(sub.id);
    expect(active.status).toBe('active');
    expect(active.items.data[0]).toMatchObject({ current_period_start: T0 + 7 * DAY, current_period_end: addIntervals(T0 + 7 * DAY, 'month', 1, 1) });
    // The account clock did not move.
    expect((await f.account.now()).now).toBeLessThan(T0);
    await f.expectAllDelivered();
  });
});

describe('plan changes in the customer portal', () => {
  it('upgrades now with always_invoice: prorations are invoiced and charged in the same request', async () => {
    const f = await flowServer();
    const c = await catalog(f);
    const session = await checkout(f, { price: c.basicMonthly });
    const sub = session.subscription;
    await f.stripe.billingPortal.configurations.create({
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price'],
          proration_behavior: 'always_invoice',
          products: [
            { product: c.basic.id, prices: [c.basicMonthly.id] },
            { product: c.pro.id, prices: [c.proMonthly.id] },
          ],
        },
      },
    });
    expect(await f.types()).toEqual([...CHECKOUT_PAID, 'billing_portal.configuration.created']);

    const { start, end } = { start: sub.items.data[0].current_period_start, end: sub.items.data[0].current_period_end };
    const changeAt = start + 10 * DAY;
    await advanceTo(f, changeAt);
    const { home } = await portal(f, session.customer);
    expect(home.text('subscriptions')).toContain('Basic');
    const update = await open(home.link(/class="update"/));
    expect(update.status).toBe(200);
    const choose = update.form(/id="update-form"/);
    expect(choose.radios.get('price')).toEqual([c.basicMonthly.id, c.proMonthly.id]);
    const review = await update.submit(choose, { price: c.proMonthly.id });
    expect(review.text('when')).toBe('The change takes effect now.');
    expect(review.text('billing-note')).toBe('You are charged the prorated difference now.');
    const done = await review.submit(review.form(/id="confirm"/));
    expect(done.status).toBe(303);
    expect((await done.follow()).text('notice')).toBe('Your plan has been updated.');

    const upgrade = await f.events();
    expect(upgrade.map((e) => e.type)).toEqual([
      'billing_portal.session.created',
      'invoiceitem.created',
      'invoiceitem.created',
      'customer.subscription.updated',
      'invoice.created',
      'payment_intent.created',
      'invoice.finalized',
      'charge.succeeded',
      'payment_intent.succeeded',
      'invoice.paid',
      'invoice.payment_succeeded',
      'invoice_payment.paid',
      'invoice.updated',
    ]);
    const credit = -Math.round((1000 * (end - changeAt)) / (end - start));
    const debit = Math.round((3000 * (end - changeAt)) / (end - start));
    const updated = one(upgrade, 'customer.subscription.updated');
    expect(updated.data.object.items.data[0].price.id).toBe(c.proMonthly.id);
    expect(updated.data.previous_attributes.items.data[0].price.id).toBe(c.basicMonthly.id);
    expect(updated.data.previous_attributes.latest_invoice).toBe(sub.latest_invoice);
    const invoice = await f.stripe.invoices.retrieve(updated.data.object.latest_invoice);
    expect(invoice).toMatchObject({ status: 'paid', billing_reason: 'subscription_update', amount_paid: credit + debit, auto_advance: false });
    expect(invoice.lines.data.map((l) => [l.description, l.amount, l.parent.subscription_item_details.proration])).toEqual([
      [`Unused time on Basic after ${dayLabel(changeAt)}`, credit, true],
      [`Remaining time on Pro after ${dayLabel(changeAt)}`, debit, true],
    ]);
    const after = await f.stripe.subscriptions.retrieve(sub.id);
    expect(after.items.data[0]).toMatchObject({ price: { id: c.proMonthly.id }, current_period_start: start, current_period_end: end });

    // The next period is billed at the new price.
    await advanceTo(f, end + HOUR);
    const renewal = await f.events();
    expect(renewal.map((e) => e.type)).toEqual(['customer.subscription.updated', 'invoice.created', ...PAID_AFTER_DRAFT_HOUR]);
    expect(one(renewal, 'invoice.paid').data.object).toMatchObject({ billing_reason: 'subscription_cycle', amount_paid: 3000 });
    await f.expectAllDelivered();
  });

  /** A $90 subscription (3 seats of Pro) and a portal that schedules seat reductions for the period end. */
  async function seatsWithScheduledDowngrade(f) {
    const c = await catalog(f);
    const session = await checkout(f, { price: c.proMonthly, quantity: 3 });
    await f.stripe.billingPortal.configurations.create({
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['quantity'],
          proration_behavior: 'create_prorations',
          products: [{ product: c.pro.id, prices: [c.proMonthly.id] }],
          schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] },
        },
      },
    });
    const sub = session.subscription;
    expect(sub.items.data[0].quantity).toBe(3);
    expect(session.invoice.amount_paid).toBe(9000);
    expect(await f.types()).toEqual([...CHECKOUT_PAID, 'billing_portal.configuration.created']);

    const { session: portalSession, home } = await portal(f, session.customer);
    const update = await open(home.link(/class="update"/));
    const review = await update.submit(update.form(/id="update-form"/), { quantity: '1' });
    const end = sub.items.data[0].current_period_end;
    expect(review.text('when')).toBe(`The change takes effect at the end of the current period (${isoDay(end)}).`);
    const done = await review.submit(review.form(/id="confirm"/));
    expect(done.status).toBe(303);
    const back = await done.follow();
    expect(back.text('notice')).toBe('Your plan change is scheduled for the end of the current period.');
    // Nothing else can be changed while the change is scheduled.
    expect(back.html).not.toContain('class="update"');
    expect(back.html).not.toContain('class="cancel"');

    const scheduled = await f.events();
    expect(scheduled.map((e) => e.type)).toEqual(['billing_portal.session.created', 'subscription_schedule.created', 'customer.subscription.updated']);
    const schedule = one(scheduled, 'subscription_schedule.created').data.object;
    expect(schedule).toMatchObject({ status: 'active', subscription: sub.id, end_behavior: 'release', current_phase: { start_date: sub.items.data[0].current_period_start, end_date: end } });
    expect(schedule.phases.map((p) => [p.start_date, p.end_date, p.items[0].price, p.items[0].quantity])).toEqual([
      [sub.items.data[0].current_period_start, end, c.proMonthly.id, 3],
      [end, addIntervals(end, 'month', 1, 1), c.proMonthly.id, 1],
    ]);
    const attached = one(scheduled, 'customer.subscription.updated');
    expect(attached.data.object.schedule).toBe(schedule.id);
    expect(attached.data.previous_attributes).toEqual({ schedule: null });
    expect(back.html).toContain(`data-schedule="${schedule.id}"`);
    // No proration and no quantity change now.
    const now = await f.stripe.subscriptions.retrieve(sub.id);
    expect(now.items.data[0].quantity).toBe(3);
    expect((await f.stripe.invoices.list({ customer: session.customer })).data).toHaveLength(1);
    return { c, sub, schedule, end, portalSession };
  }

  it('schedules a downgrade at the period end, and releasing the schedule keeps the current plan', async () => {
    const f = await flowServer();
    const { sub, schedule, end } = await seatsWithScheduledDowngrade(f);

    const released = await f.stripe.subscriptionSchedules.release(schedule.id);
    expect(released).toMatchObject({ status: 'released', subscription: null, released_subscription: sub.id, current_phase: null });
    const releaseEvents = await f.events();
    expect(releaseEvents.map((e) => e.type)).toEqual(['subscription_schedule.released', 'customer.subscription.updated']);
    for (const e of releaseEvents) expect(e.request.id).toBe(released.lastResponse.requestId);
    expect(releaseEvents[1].data).toMatchObject({ object: { schedule: null }, previous_attributes: { schedule: schedule.id } });

    await advanceTo(f, end + HOUR);
    const renewal = await f.events();
    expect(renewal.map((e) => e.type)).toEqual(['customer.subscription.updated', 'invoice.created', ...PAID_AFTER_DRAFT_HOUR]);
    expect(one(renewal, 'invoice.paid').data.object).toMatchObject({ amount_paid: 9000, billing_reason: 'subscription_cycle' });
    const kept = await f.stripe.subscriptions.retrieve(sub.id);
    expect(kept).toMatchObject({ status: 'active', schedule: null });
    expect(kept.items.data[0].quantity).toBe(3);
    await f.expectAllDelivered();
  });

  it('applies a scheduled downgrade at renewal, then completes the schedule after its last phase', async () => {
    const f = await flowServer();
    const { sub, schedule, end } = await seatsWithScheduledDowngrade(f);

    await advanceTo(f, end);
    const phaseChange = await f.events();
    expect(phaseChange.map((e) => e.type)).toEqual(['subscription_schedule.updated', 'customer.subscription.updated', 'customer.subscription.updated', 'invoice.created']);
    expect(phaseChange[0].data).toMatchObject({ object: { current_phase: { start_date: end } }, previous_attributes: { current_phase: { start_date: schedule.current_phase.start_date } } });
    expect(phaseChange[1].data.object.items.data[0].quantity).toBe(1);
    expect(phaseChange[1].data.previous_attributes.items.data[0].quantity).toBe(3);
    expect(phaseChange[3].data.object).toMatchObject({ status: 'draft', billing_reason: 'subscription_cycle', amount_due: 3000 });

    await advanceTo(f, end + HOUR);
    expect(await f.types()).toEqual(PAID_AFTER_DRAFT_HOUR);
    const downgraded = await f.stripe.subscriptions.retrieve(sub.id);
    expect(downgraded).toMatchObject({ status: 'active', schedule: schedule.id });
    expect(downgraded.items.data[0]).toMatchObject({ quantity: 1, current_period_start: end });

    const lastEnd = addIntervals(end, 'month', 1, 1);
    await advanceTo(f, lastEnd - 7 * DAY);
    expect(await f.types()).toEqual(['subscription_schedule.expiring']);
    await advanceTo(f, lastEnd);
    const completion = await f.events();
    expect(completion.map((e) => e.type)).toEqual(['subscription_schedule.completed', 'customer.subscription.updated', 'customer.subscription.updated', 'invoice.created']);
    expect(completion[0].data.object).toMatchObject({ status: 'completed', completed_at: lastEnd, current_phase: null, released_subscription: null });
    expect(completion[1].data).toMatchObject({ object: { schedule: null }, previous_attributes: { schedule: schedule.id } });
    expect(completion[3].data.object.amount_due).toBe(3000);
    expect(await f.stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'active', schedule: null });
    await f.expectAllDelivered();
  });
});

describe('cancellation', () => {
  async function cancelingPortal(f) {
    const c = await catalog(f);
    const session = await checkout(f, { price: c.proMonthly });
    await f.stripe.billingPortal.configurations.create({
      features: {
        subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'other'] } },
      },
    });
    expect(await f.types()).toEqual([...CHECKOUT_PAID, 'billing_portal.configuration.created']);
    const sub = session.subscription;
    const end = sub.items.data[0].current_period_end;
    const { session: portalSession, home } = await portal(f, session.customer);
    const screen = await open(home.link(/class="cancel"/));
    expect(screen.text('cancel-mode')).toBe(`Your subscription will be canceled at the end of the current period (${isoDay(end)}).`);
    const form = screen.form(/id="confirm-cancel"/);
    expect(form.radios.get('reason')).toEqual(['too_expensive', 'missing_features', 'other']);
    const before = (await f.account.now()).now;
    const done = await screen.submit(form, { reason: 'too_expensive', comment: 'Too pricey for us' });
    const after = (await f.account.now()).now;
    expect(done.status).toBe(303);
    const back = await done.follow();
    expect(back.text('notice')).toBe('Your subscription will be canceled at the end of the current period.');

    const canceled = await f.events();
    expect(canceled.map((e) => e.type)).toEqual(['billing_portal.session.created', 'customer.subscription.updated']);
    // Flexible billing mode (the default from 2025-09-30.clover): the portal sets cancel_at.
    expect(canceled[1].data.object).toMatchObject({
      status: 'active',
      cancel_at: end,
      cancel_at_period_end: false,
      cancellation_details: { reason: 'cancellation_requested', feedback: 'too_expensive', comment: 'Too pricey for us' },
    });
    const canceledAt = canceled[1].data.object.canceled_at;
    expect(canceledAt).toBeGreaterThanOrEqual(before);
    expect(canceledAt).toBeLessThanOrEqual(after);
    expect(canceled[1].data.previous_attributes).toMatchObject({ cancel_at: null, canceled_at: null, cancellation_details: { reason: null, feedback: null, comment: null } });
    expect(back.html).toContain('data-status="active"');
    expect(back.text('subscriptions')).toContain(`Cancels ${isoDay(end)}`);
    return { sub, end, back, portalSession, canceledAt };
  }

  it('cancels at the period end in the portal, then renews, and the subscription keeps billing', async () => {
    const f = await flowServer();
    const { sub, end, back } = await cancelingPortal(f);

    const renew = await back.submit(back.form(/class="renew"/));
    expect(renew.status).toBe(303);
    expect((await renew.follow()).text('notice')).toBe('Your subscription will continue.');
    const renewed = await f.events();
    expect(renewed.map((e) => e.type)).toEqual(['customer.subscription.updated']);
    expect(renewed[0].data.object).toMatchObject({ cancel_at: null, cancel_at_period_end: false, canceled_at: null, cancellation_details: { reason: null, feedback: null, comment: null } });
    expect(renewed[0].data.previous_attributes).toMatchObject({ cancel_at: end, cancellation_details: { reason: 'cancellation_requested' } });

    await advanceTo(f, end + HOUR);
    const renewal = await f.events();
    expect(renewal.map((e) => e.type)).toEqual(['customer.subscription.updated', 'invoice.created', ...PAID_AFTER_DRAFT_HOUR]);
    expect(await f.stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'active', cancel_at: null });
    await f.expectAllDelivered();
  });

  it('ends the subscription when the period end is reached, without another invoice', async () => {
    const f = await flowServer();
    const { sub, end, portalSession, canceledAt } = await cancelingPortal(f);

    await advanceTo(f, end - 1);
    expect(await f.types()).toEqual([]);
    await advanceTo(f, end + HOUR);
    const ended = await f.events();
    expect(ended.map((e) => e.type)).toEqual(['customer.subscription.deleted']);
    expect(ended[0]).toMatchObject({ created: end, request: automatic });
    expect(ended[0].data.object).toMatchObject({ status: 'canceled', ended_at: end, canceled_at: canceledAt, cancel_at: end, cancellation_details: { reason: 'cancellation_requested', feedback: 'too_expensive' } });

    expect(await f.stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'canceled', ended_at: end });
    expect((await f.stripe.subscriptions.list({ customer: sub.customer })).data).toEqual([]);
    expect((await f.stripe.subscriptions.list({ customer: sub.customer, status: 'canceled' })).data.map((s) => s.id)).toEqual([sub.id]);
    expect((await f.stripe.invoices.list({ customer: sub.customer })).data).toHaveLength(1);
    // The first portal session expired an hour after its last use; a new one shows no plan.
    expect((await open(portalSession.url)).status).toBe(410);
    const { home } = await portal(f, sub.customer);
    expect(home.text('subscriptions')).toContain('No active subscriptions.');
    await f.expectAllDelivered();
  });

  it('cancels a classic subscription at the period end through the API: cancel_at_period_end stays true to the end', async () => {
    const f = await flowServer();
    const c = await catalog(f);
    const basil = f.t.stripe(undefined, { apiVersion: '2025-03-31.basil' });
    const customer = await f.stripe.customers.create({ email: 'jenny.rosen@example.com' });
    const pm = await f.stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    const sub = await basil.subscriptions.create({ customer: customer.id, items: [{ price: c.proMonthly.id }], default_payment_method: pm.id });
    expect(sub.status).toBe('active');
    // billing_mode appears from 2025-06-30.basil; the subscription was created classic by its version.
    expect(sub).not.toHaveProperty('billing_mode');
    expect((await f.stripe.subscriptions.retrieve(sub.id)).billing_mode.type).toBe('classic');
    await f.events();
    const end = sub.items.data[0].current_period_end;

    const canceling = await basil.subscriptions.update(sub.id, { cancel_at_period_end: true });
    expect(canceling).toMatchObject({ status: 'active', cancel_at_period_end: true, cancel_at: end });
    const flagged = await f.events();
    expect(flagged.map((e) => e.type)).toEqual(['customer.subscription.updated']);
    expect(flagged[0].request.id).toBe(canceling.lastResponse.requestId);
    expect(flagged[0].data.previous_attributes).toMatchObject({ cancel_at_period_end: false, cancel_at: null, canceled_at: null });

    await advanceTo(f, end);
    const ended = await f.events();
    expect(ended.map((e) => e.type)).toEqual(['customer.subscription.deleted']);
    expect(ended[0].data.object).toMatchObject({ status: 'canceled', ended_at: end, cancel_at_period_end: true, canceled_at: canceling.canceled_at });
    await f.expectAllDelivered();
  });
});

describe('failed renewals and dunning', () => {
  /**
   * The failing-card recipe from Stripe's Billing testing guide: a trial started with
   * 4000000000000341, whose first charge at trial end fails.
   */
  async function failingAfterTrial(f) {
    const c = await catalog(f);
    const session = await checkout(f, { price: c.proMonthly, trialDays: 7, card: CARD_FAILS_LATER });
    await f.stripe.billingPortal.configurations.create({ features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true } } });
    expect(await f.types()).toEqual([...CHECKOUT_TRIAL, 'billing_portal.configuration.created']);
    const sub = session.subscription;

    await advanceTo(f, sub.trial_end + HOUR);
    const failed = await f.events();
    expect(failed.map((e) => e.type)).toEqual([
      'customer.subscription.trial_will_end',
      'customer.subscription.updated',
      'invoice.created',
      'payment_intent.created',
      'invoice.finalized',
      'charge.failed',
      'payment_intent.payment_failed',
      'invoice.payment_failed',
      'invoice.updated',
      'customer.updated',
      'customer.subscription.updated',
    ]);
    const invoice = one(failed, 'invoice.payment_failed').data.object;
    expect(invoice).toMatchObject({ status: 'open', billing_reason: 'subscription_cycle', attempt_count: 1, amount_due: 3000, next_payment_attempt: sub.trial_end + HOUR + 2 * DAY });
    expect(one(failed, 'charge.failed').data.object).toMatchObject({ status: 'failed', failure_code: 'card_declined', outcome: { type: 'issuer_declined' } });
    expect(one(failed, 'customer.updated').data).toMatchObject({ object: { delinquent: true }, previous_attributes: { delinquent: false } });
    const pastDue = failed.at(-1).data;
    expect(pastDue).toMatchObject({ object: { status: 'past_due' }, previous_attributes: { status: 'active' } });

    // The first retry, two days later (default schedule: 8 tries in 2 weeks), fails too.
    await advanceTo(f, invoice.next_payment_attempt);
    const retried = await f.events();
    expect(retried.map((e) => e.type)).toEqual(['charge.failed', 'payment_intent.payment_failed', 'invoice.payment_failed', 'invoice.updated']);
    expect(one(retried, 'invoice.payment_failed').data.object).toMatchObject({ attempt_count: 2, next_payment_attempt: invoice.next_payment_attempt + 2 * DAY });
    expect((await f.stripe.subscriptions.retrieve(sub.id)).status).toBe('past_due');
    return { sub, invoice, customer: session.customer, nextAttempt: invoice.next_payment_attempt + 2 * DAY };
  }

  it('recovers when the customer adds a working card in the portal: the next retry pays with it', async () => {
    const f = await flowServer();
    const { sub, invoice, customer, nextAttempt } = await failingAfterTrial(f);

    const { home } = await portal(f, customer);
    expect(home.html).toContain(`data-invoice="${invoice.id}"`);
    const cardPage = await open(home.link(/id="add-payment-method"/));
    const saved = await cardPage.submit(cardPage.form(/name="card_number"/), { card_number: CARD_OK, exp_month: '12', exp_year: '34', cvc: '123' });
    expect(saved.status).toBe(303);
    expect((await saved.follow()).text('default-payment-method')).toBe('Visa •••• 4242, expires 12/2034');
    const newCard = await f.events();
    expect(newCard.map((e) => e.type)).toEqual(['billing_portal.session.created', 'payment_method.attached', 'customer.updated', 'customer.subscription.updated']);
    const card = newCard[1].data.object;
    expect(card).toMatchObject({ customer, card: { last4: '4242' } });
    expect(newCard[2].data.object.invoice_settings.default_payment_method).toBe(card.id);
    expect(newCard[3].data.object.default_payment_method).toBe(card.id);

    await advanceTo(f, nextAttempt);
    const recovered = await f.events();
    expect(recovered.map((e) => e.type)).toEqual([
      'charge.succeeded',
      'payment_intent.succeeded',
      'invoice.paid',
      'invoice.payment_succeeded',
      'invoice_payment.paid',
      'invoice.updated',
      'customer.updated',
      'customer.subscription.updated',
    ]);
    expect(one(recovered, 'charge.succeeded').data.object).toMatchObject({ payment_method: card.id, amount: 3000 });
    expect(one(recovered, 'invoice.paid').data.object).toMatchObject({ id: invoice.id, status: 'paid', attempt_count: 3, amount_paid: 3000 });
    expect(recovered.at(-1).data).toMatchObject({ object: { status: 'active' }, previous_attributes: { status: 'past_due' } });
    expect(await f.stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'active', default_payment_method: card.id });
    expect(await f.stripe.customers.retrieve(customer)).toMatchObject({ delinquent: false });
    await f.expectAllDelivered();
  });

  it('recovers when the customer pays the open invoice from the portal invoice history', async () => {
    const f = await flowServer();
    const { sub, invoice, customer } = await failingAfterTrial(f);

    const { home } = await portal(f, customer);
    const invoicePage = await open(home.link(new RegExp(`href="${escapeRegExp(invoice.hosted_invoice_url)}"`)));
    expect(invoicePage.status).toBe(200);
    expect(invoicePage.html).toContain('data-status="open"');
    const paid = await invoicePage.submit(invoicePage.form(/name="card_number"/), { card_number: CARD_OK });
    expect(paid.status).toBe(303);
    expect((await paid.follow()).html).toContain('data-status="paid"');

    const recovered = await f.events();
    expect(recovered.map((e) => e.type)).toEqual([
      'billing_portal.session.created',
      'payment_method.attached',
      'charge.succeeded',
      'payment_intent.succeeded',
      'invoice.paid',
      'invoice.payment_succeeded',
      'invoice_payment.paid',
      'invoice.updated',
      'customer.updated',
      'customer.subscription.updated',
    ]);
    expect(one(recovered, 'invoice.paid').data.object).toMatchObject({ id: invoice.id, status: 'paid', amount_paid: 3000 });
    expect(recovered.at(-1).data.object.status).toBe('active');
    expect(await f.stripe.subscriptions.retrieve(sub.id)).toMatchObject({ status: 'active' });
    // No further retries of the paid invoice.
    await advanceTo(f, invoice.next_payment_attempt + 14 * DAY);
    const later = await f.types();
    expect(later.filter((type) => type.startsWith('invoice.payment_failed') || type === 'charge.failed')).toEqual([]);
    await f.expectAllDelivered();
  });

  it('cancels the subscription after the last retry fails (failNextCharge), leaving the invoice open', async () => {
    const f = await flowServer({ billing: { retrySchedule: [1, 2, 4], afterFinalRetry: 'cancel' } });
    const c = await catalog(f);
    const session = await checkout(f, { price: c.proMonthly });
    const sub = session.subscription;
    await f.events();
    await f.account.failNextCharge(session.customer, { times: 4, declineCode: 'insufficient_funds' });

    const end = sub.items.data[0].current_period_end;
    await advanceTo(f, end + HOUR);
    const first = await f.events();
    expect(first.map((e) => e.type)).toEqual([
      'customer.subscription.updated',
      'invoice.created',
      'payment_intent.created',
      'invoice.finalized',
      'charge.failed',
      'payment_intent.payment_failed',
      'invoice.payment_failed',
      'invoice.updated',
      'customer.updated',
      'customer.subscription.updated',
    ]);
    expect(one(first, 'charge.failed').data.object.outcome).toMatchObject({ type: 'issuer_declined', reason: 'insufficient_funds' });
    let invoice = one(first, 'invoice.payment_failed').data.object;
    expect(invoice).toMatchObject({ attempt_count: 1, next_payment_attempt: end + HOUR + DAY });
    expect(first.at(-1).data.object.status).toBe('past_due');

    const retryAt = [end + HOUR + DAY, end + HOUR + 3 * DAY];
    for (const [i, at] of retryAt.entries()) {
      await advanceTo(f, at);
      const retry = await f.events();
      expect(retry.map((e) => e.type)).toEqual(['charge.failed', 'payment_intent.payment_failed', 'invoice.payment_failed', 'invoice.updated']);
      invoice = one(retry, 'invoice.payment_failed').data.object;
      expect(invoice.attempt_count).toBe(i + 2);
    }
    expect(invoice.next_payment_attempt).toBe(end + HOUR + 7 * DAY);

    await advanceTo(f, end + HOUR + 7 * DAY);
    const last = await f.events();
    expect(last.map((e) => e.type)).toEqual(['charge.failed', 'payment_intent.payment_failed', 'invoice.payment_failed', 'invoice.updated', 'customer.subscription.deleted', 'invoice.updated']);
    expect(one(last, 'invoice.payment_failed').data.object).toMatchObject({ attempt_count: 4, next_payment_attempt: null });
    expect(one(last, 'customer.subscription.deleted').data.object).toMatchObject({ status: 'canceled', ended_at: end + HOUR + 7 * DAY, cancellation_details: { reason: 'payment_failed' } });
    expect(last.at(-1).data).toMatchObject({ object: { status: 'open', auto_advance: false }, previous_attributes: { auto_advance: true } });

    // Nothing is attempted any more.
    await advanceTo(f, end + HOUR + 30 * DAY);
    expect(await f.types()).toEqual([]);
    expect(await f.stripe.invoices.retrieve(invoice.id)).toMatchObject({ status: 'open', attempt_count: 4, auto_advance: false });
    await f.expectAllDelivered();
  });
});

// Formatting helpers used by the expectations -----------------------------------------------------

function isoDay(t) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function dayLabel(t) {
  const d = new Date(t * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
