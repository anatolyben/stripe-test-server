/**
 * Customer portal configurations, sessions and the hosted portal (with its links to hosted invoices),
 * driven through the real stripe SDK and plain HTTP (GET the page, POST its forms).
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';

const DAY = 86400;
const RETURN_URL = 'https://example.com/account';

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
  return (await stripe.events.list({ limit: 100 })).data.map((e) => e.type).reverse();
}

/** Products Basic ($10/month) and Pro ($30/month, $300/year) and a customer. */
async function catalog(stripe) {
  const basic = await stripe.products.create({ name: 'Basic' });
  const pro = await stripe.products.create({ name: 'Pro' });
  const basicMonthly = await stripe.prices.create({ product: basic.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
  const proMonthly = await stripe.prices.create({ product: pro.id, unit_amount: 3000, currency: 'usd', recurring: { interval: 'month' } });
  const proYearly = await stripe.prices.create({ product: pro.id, unit_amount: 30000, currency: 'usd', recurring: { interval: 'year' } });
  return { basic, pro, basicMonthly, proMonthly, proYearly };
}

function updateFeature(c, extra = {}) {
  return {
    enabled: true,
    default_allowed_updates: ['price'],
    products: [
      { product: c.basic.id, prices: [c.basicMonthly.id] },
      { product: c.pro.id, prices: [c.proMonthly.id, c.proYearly.id] },
    ],
    ...extra,
  };
}

/** A customer with an active subscription to `price`, paid with the test card `card`. */
async function subscriber(t, stripe, price, { card = 'pm_card_visa', trialDays } = {}) {
  const customer = await stripe.customers.create({ email: 'jenny@example.com', name: 'Jenny Rosen' });
  const created = await t.account().createSubscription(customer.id, { price: price.id, paymentMethod: card, trialDays });
  return { customer, subscription: await stripe.subscriptions.retrieve(created.id) };
}

async function portal(stripe, customer, params = {}) {
  return stripe.billingPortal.sessions.create({ customer: customer.id, return_url: RETURN_URL, ...params });
}

describe('portal configurations', () => {
  it('creates the first configuration as the default, with the full current shape', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const first = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    expect(first).toMatchObject({
      object: 'billing_portal.configuration',
      active: true,
      is_default: true,
      application: null,
      default_return_url: null,
      name: null,
      metadata: {},
      login_page: { enabled: false, url: null },
      business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
      features: {
        customer_update: { allowed_updates: [], enabled: false },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: false, payment_method_configuration: null },
        subscription_cancel: {
          cancellation_reason: { enabled: false, feedback_options: null, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] },
          enabled: false,
          mode: 'at_period_end',
          proration_behavior: 'none',
        },
        subscription_update: {
          billing_cycle_anchor: null,
          default_allowed_updates: [],
          enabled: false,
          proration_behavior: 'none',
          schedule_at_period_end: { conditions: [] },
          trial_update_behavior: 'end_trial',
        },
      },
    });
    expect(first.id).toMatch(/^bpc_/);
    expect(first.features.subscription_update).not.toHaveProperty('products');
    const second = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: false } } });
    expect(second.is_default).toBe(false);
    expect((await stripe.billingPortal.configurations.list({ is_default: true })).data.map((c) => c.id)).toEqual([first.id]);
    expect((await eventTypes(stripe)).filter((type) => type.startsWith('billing_portal'))).toEqual([
      'billing_portal.configuration.created',
      'billing_portal.configuration.created',
    ]);
  });

  it('returns subscription_update.products only when expanded, and merges nested objects on update', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const config = await stripe.billingPortal.configurations.create({
      features: { subscription_update: updateFeature(c, { proration_behavior: 'always_invoice' }) },
      default_return_url: RETURN_URL,
    });
    const expanded = await stripe.billingPortal.configurations.retrieve(config.id, { expand: ['features.subscription_update.products'] });
    expect(expanded.features.subscription_update.products).toEqual([
      { adjustable_quantity: { enabled: false, maximum: null, minimum: 1 }, prices: [c.basicMonthly.id], product: c.basic.id },
      { adjustable_quantity: { enabled: false, maximum: null, minimum: 1 }, prices: [c.proMonthly.id, c.proYearly.id], product: c.pro.id },
    ]);
    const listed = await stripe.billingPortal.configurations.list({ expand: ['data.features.subscription_update.products'] });
    expect(listed.data[0].features.subscription_update.products).toHaveLength(2);

    const updated = await stripe.billingPortal.configurations.update(config.id, {
      features: { subscription_update: { proration_behavior: 'create_prorations' }, subscription_cancel: { enabled: true, mode: 'immediately' } },
      active: false,
      metadata: { team: 'billing' },
    });
    expect(updated.features.subscription_update).toMatchObject({ enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations' });
    expect(updated.features.subscription_cancel).toMatchObject({ enabled: true, mode: 'immediately', proration_behavior: 'none' });
    expect(updated).toMatchObject({ active: false, metadata: { team: 'billing' }, default_return_url: RETURN_URL });
    expect((await stripe.billingPortal.configurations.list({ active: false })).data.map((x) => x.id)).toEqual([config.id]);
    const [event] = (await stripe.events.list({ type: 'billing_portal.configuration.updated' })).data;
    expect(event.data.previous_attributes).toMatchObject({ active: true, features: { subscription_update: { proration_behavior: 'always_invoice' } } });
  });

  it('rejects invalid features with the offending bracketed param', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const cases = [
      [{}, 'parameter_missing', 'features'],
      [{ features: { subscription_cancel: { enabled: true, proration_behavior: 'always_invoice' } } }, undefined, 'features[subscription_cancel][proration_behavior]'],
      [{ features: { subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'create_prorations' } } }, undefined, 'features[subscription_cancel][proration_behavior]'],
      [{ features: { subscription_update: { enabled: true, products: [{ product: 'prod_missing', prices: [c.proMonthly.id] }] } } }, 'resource_missing', 'features[subscription_update][products][0][product]'],
      [{ features: { subscription_update: { enabled: true, products: [{ product: c.basic.id, prices: [c.proMonthly.id] }] } } }, undefined, 'features[subscription_update][products][0][prices][0]'],
      [{ features: { customer_update: { allowed_updates: ['email'] } } }, 'parameter_missing', 'features[customer_update][enabled]'],
      [{ features: { invoice_history: { enabled: true } }, default_return_url: 'not a url' }, 'url_invalid', 'default_return_url'],
    ];
    for (const [params, code, param] of cases) {
      const err = await rejection(stripe.billingPortal.configurations.create(params));
      expect([err.statusCode, err.code, err.param], JSON.stringify(params)).toEqual([400, code, param]);
    }
    const sameInterval = await stripe.prices.create({ product: c.pro.id, unit_amount: 2500, currency: 'usd', recurring: { interval: 'month' } });
    const dup = await rejection(
      stripe.billingPortal.configurations.create({ features: { subscription_update: { enabled: true, products: [{ product: c.pro.id, prices: [c.proMonthly.id, sameInterval.id] }] } } }),
    );
    expect(dup.param).toBe('features[subscription_update][products][0][prices]');
    const tooMany = await rejection(
      stripe.billingPortal.configurations.create({
        features: { subscription_update: { enabled: true, products: Array.from({ length: 11 }, () => ({ product: c.basic.id, prices: [c.basicMonthly.id] })) } },
      }),
    );
    expect(tooMany.param).toBe('features[subscription_update][products]');
  });

  it('rejects parameters the request version does not have, like unknown parameters', async () => {
    const t = await startServer();
    const acacia = t.stripe(t.key, { apiVersion: '2024-09-30.acacia' });
    const basil = t.stripe(t.key, { apiVersion: '2025-08-27.basil' });
    const schedule = await rejection(
      acacia.billingPortal.configurations.create({
        business_profile: { headline: 'Acme' },
        features: { subscription_update: { enabled: false, schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] } } },
      }),
    );
    expect([schedule.code, schedule.param]).toEqual(['parameter_unknown', 'features[subscription_update][schedule_at_period_end]']);
    const trial = await rejection(basil.billingPortal.configurations.create({ features: { subscription_update: { enabled: false, trial_update_behavior: 'continue_trial' } } }));
    expect([trial.code, trial.param]).toEqual(['parameter_unknown', 'features[subscription_update][trial_update_behavior]']);
    const ok = await t.stripe().billingPortal.configurations.create({ features: { subscription_update: { enabled: false, trial_update_behavior: 'continue_trial' } } });
    expect(ok.features.subscription_update.trial_update_behavior).toBe('continue_trial');
  });
});

describe('portal sessions', () => {
  it('uses the default configuration and answers with the hosted URL', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'a@example.com' });
    const none = await rejection(portal(stripe, customer));
    expect([none.type, none.statusCode]).toEqual(['StripeInvalidRequestError', 400]);
    const config = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const session = await portal(stripe, customer);
    expect(session).toMatchObject({
      object: 'billing_portal.session',
      configuration: config.id,
      customer: customer.id,
      customer_account: null,
      flow: null,
      locale: null,
      on_behalf_of: null,
      return_url: RETURN_URL,
      livemode: false,
    });
    expect(session.id).toMatch(/^bps_/);
    expect(session.url).toMatch(new RegExp(`^${t.url}/p/session/test_`));
    expect(session).not.toHaveProperty('expires_at');
    const withConfig = await portal(stripe, customer, { expand: ['configuration'] });
    expect(withConfig.configuration.id).toBe(config.id);
    expect((await stripe.events.list({ type: 'billing_portal.session.created' })).data).toHaveLength(2);
  });

  it('requires an active configuration and a return URL', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'a@example.com' });
    const config = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const noReturn = await rejection(stripe.billingPortal.sessions.create({ customer: customer.id }));
    expect(noReturn.param).toBe('return_url');
    await stripe.billingPortal.configurations.update(config.id, { default_return_url: RETURN_URL });
    expect((await stripe.billingPortal.sessions.create({ customer: customer.id })).return_url).toBe(RETURN_URL);
    await stripe.billingPortal.configurations.update(config.id, { active: false });
    const inactive = await rejection(portal(stripe, customer, { configuration: config.id }));
    expect(inactive.param).toBe('configuration');
    const unknown = await rejection(portal(stripe, { id: 'cus_missing' }));
    expect([unknown.code, unknown.param]).toEqual(['resource_missing', 'customer']);
    const missingConfig = await rejection(portal(stripe, customer, { configuration: 'bpc_missing' }));
    expect([missingConfig.code, missingConfig.param]).toEqual(['resource_missing', 'configuration']);
  });

  it('validates flow_data against the configuration and the subscription', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    const other = await stripe.customers.create({ email: 'other@example.com' });
    const plain = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const confirm = (items, extra = {}) => ({ type: 'subscription_update_confirm', subscription_update_confirm: { subscription: subscription.id, items }, ...extra });

    const disabled = await rejection(portal(stripe, customer, { flow_data: confirm([{ id: subscription.items.data[0].id, price: c.proMonthly.id }]) }));
    expect(disabled.param).toBe('flow_data[type]');

    const config = await stripe.billingPortal.configurations.create({
      features: { subscription_update: { enabled: true, default_allowed_updates: ['price'], products: [{ product: c.basic.id, prices: [c.basicMonthly.id] }] }, subscription_cancel: { enabled: true } },
    });
    const notConfigured = await rejection(
      portal(stripe, customer, { configuration: config.id, flow_data: confirm([{ id: subscription.items.data[0].id, price: c.proMonthly.id }]) }),
    );
    expect([notConfigured.type, notConfigured.statusCode, notConfigured.param]).toEqual([
      'StripeInvalidRequestError',
      400,
      'flow_data[subscription_update_confirm][items][0][price]',
    ]);
    const missingBranch = await rejection(portal(stripe, customer, { configuration: config.id, flow_data: { type: 'subscription_cancel' } }));
    expect([missingBranch.code, missingBranch.param]).toEqual(['parameter_missing', 'flow_data[subscription_cancel]']);
    const foreign = await rejection(
      portal(stripe, other, { configuration: config.id, flow_data: { type: 'subscription_cancel', subscription_cancel: { subscription: subscription.id } } }),
    );
    expect(foreign.param).toBe('flow_data[subscription_cancel][subscription]');
    const noRedirect = await rejection(
      portal(stripe, customer, {
        configuration: config.id,
        flow_data: { type: 'subscription_cancel', subscription_cancel: { subscription: subscription.id }, after_completion: { type: 'redirect' } },
      }),
    );
    expect([noRedirect.code, noRedirect.param]).toEqual(['parameter_missing', 'flow_data[after_completion][redirect]']);
    const older = await rejection(
      t.stripe(t.key, { apiVersion: '2026-07-29.dahlia' }).billingPortal.sessions.create({ customer: customer.id, return_url: RETURN_URL, configuration: plain.id, flow_data: { type: 'customer_update' } }),
    );
    expect(older.param).toBe('flow_data[type]');

    const flow = await portal(stripe, customer, {
      configuration: config.id,
      flow_data: confirm([{ id: subscription.items.data[0].id, price: c.basicMonthly.id, quantity: 2 }], {
        after_completion: { type: 'redirect', redirect: { return_url: 'https://example.com/done' } },
      }),
    });
    expect(flow.flow).toEqual({
      after_completion: { hosted_confirmation: null, redirect: { return_url: 'https://example.com/done' }, type: 'redirect' },
      customer_update: null,
      subscription_cancel: null,
      subscription_update: null,
      subscription_update_confirm: { discounts: null, items: [{ id: subscription.items.data[0].id, price: c.basicMonthly.id, quantity: 2 }], subscription: subscription.id },
      type: 'subscription_update_confirm',
    });
    const cancelFlow = await portal(stripe, customer, { configuration: config.id, flow_data: { type: 'subscription_cancel', subscription_cancel: { subscription: subscription.id } } });
    expect(cancelFlow.flow.after_completion).toEqual({ hosted_confirmation: { custom_message: null }, redirect: null, type: 'hosted_confirmation' });
  });
});

describe('hosted portal', () => {
  it('shows only the features the configuration enables', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const page = await getPage((await portal(stripe, customer)).url);
    expect(page.status).toBe(200);
    expect(page.text).toContain('id="invoice-history"');
    expect(page.text).toContain('Basic');
    expect(page.text).toContain(`href="${RETURN_URL}"`);
    for (const hidden of ['id="payment-method"', 'id="billing-information"', 'class="update"', 'class="cancel"']) expect(page.text).not.toContain(hidden);
  });

  it('upgrades now with always_invoice, paying a subscription_update invoice', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({ features: { subscription_update: updateFeature(c, { proration_behavior: 'always_invoice' }) } });
    const session = await portal(stripe, customer);
    const home = await getPage(session.url);
    expect(home.text).toContain('class="update"');
    const screen = await getPage(`${session.url}?screen=update&subscription=${subscription.id}`);
    expect(screen.text).toContain(`value="${c.proMonthly.id}"`);
    const review = await getPage(`${session.url}?screen=confirm_update&subscription=${subscription.id}&price=${c.proMonthly.id}`);
    expect(review.text).toContain('The change takes effect now.');

    const done = await postForm(session.url, { action: 'update_subscription', subscription: subscription.id, price: c.proMonthly.id });
    expect(done.status).toBe(303);
    expect(done.location).toBe(`${new URL(session.url).pathname}?notice=updated`);
    const updated = await stripe.subscriptions.retrieve(subscription.id);
    expect(updated.items.data[0].price.id).toBe(c.proMonthly.id);
    const invoices = (await stripe.invoices.list({ customer: customer.id })).data;
    expect(invoices[0]).toMatchObject({ billing_reason: 'subscription_update', status: 'paid' });
    expect(invoices[0].amount_paid).toBeGreaterThan(0);
    const [event] = (await stripe.events.list({ type: 'customer.subscription.updated' })).data;
    expect(event.request).toEqual({ id: null, idempotency_key: null });
  });

  it('schedules a downgrade at the period end when a schedule_at_period_end condition matches', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.proMonthly);
    await stripe.billingPortal.configurations.create({
      features: { subscription_update: updateFeature(c, { schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] } }) },
    });
    const session = await portal(stripe, customer);
    const review = await getPage(`${session.url}?screen=confirm_update&subscription=${subscription.id}&price=${c.proYearly.id}`);
    expect(review.text).toContain('data-scheduled="true"');
    const done = await postForm(session.url, { action: 'update_subscription', subscription: subscription.id, price: c.proYearly.id });
    expect(done.status).toBe(303);

    const updated = await stripe.subscriptions.retrieve(subscription.id);
    expect(updated.items.data[0].price.id).toBe(c.proMonthly.id);
    expect(updated.schedule).toMatch(/^sub_sched_/);
    const schedule = await stripe.subscriptionSchedules.retrieve(updated.schedule);
    expect(schedule.end_behavior).toBe('release');
    expect(schedule.phases).toHaveLength(2);
    expect(schedule.phases[0].items[0].price).toBe(c.proMonthly.id);
    expect(schedule.phases[0].end_date).toBe(updated.items.data[0].current_period_end);
    expect(schedule.phases[1].items[0].price).toBe(c.proYearly.id);
    expect(await eventTypes(stripe)).toContain('subscription_schedule.created');

    const home = await getPage(session.url);
    expect(home.text).toContain('Changes to Pro');
    expect(home.text).not.toContain('class="update"');
    expect(home.text).not.toContain('class="cancel"');

    const switchBack = await postForm(session.url, { action: 'update_subscription', subscription: subscription.id, price: c.basicMonthly.id });
    expect(switchBack.status).toBe(400);
  });

  it('cancels at the period end (flexible: cancel_at) with the reason, then renews', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({
      features: { subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'other'] } } },
    });
    const session = await portal(stripe, customer);
    const screen = await getPage(`${session.url}?screen=cancel&subscription=${subscription.id}`);
    expect(screen.text).toContain('value="too_expensive"');
    const done = await postForm(session.url, { action: 'cancel_subscription', subscription: subscription.id, reason: 'too_expensive', comment: 'Cheaper elsewhere' });
    expect(done.status).toBe(303);
    const canceling = await stripe.subscriptions.retrieve(subscription.id);
    expect(canceling).toMatchObject({ status: 'active', cancel_at_period_end: false, cancel_at: canceling.items.data[0].current_period_end });
    expect(canceling.cancellation_details).toMatchObject({ feedback: 'too_expensive', comment: 'Cheaper elsewhere', reason: 'cancellation_requested' });
    expect((await getPage(session.url)).text).toContain('class="renew"');

    expect((await postForm(session.url, { action: 'renew_subscription', subscription: subscription.id })).status).toBe(303);
    const renewed = await stripe.subscriptions.retrieve(subscription.id);
    expect(renewed.cancel_at).toBeNull();
    expect(renewed.cancel_at_period_end).toBe(false);
  });

  it('cancels a classic subscription at the period end with cancel_at_period_end', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await stripe.customers.create({ email: 'classic@example.com' });
    const checkout = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      line_items: [{ price: c.basicMonthly.id, quantity: 1 }],
      success_url: 'https://example.com/ok',
      subscription_data: { billing_mode: { type: 'classic' } },
    });
    expect((await postForm(checkout.url, { card_number: '4242424242424242' })).status).toBe(303);
    const { subscription: subId } = await stripe.checkout.sessions.retrieve(checkout.id);
    await stripe.billingPortal.configurations.create({ features: { subscription_cancel: { enabled: true } } });
    const session = await portal(stripe, customer);
    expect((await postForm(session.url, { action: 'cancel_subscription', subscription: subId })).status).toBe(303);
    const sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.billing_mode.type).toBe('classic');
    expect(sub).toMatchObject({ cancel_at_period_end: true, cancel_at: sub.items.data[0].current_period_end });
  });

  it('cancels immediately when the configuration says so', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({ features: { subscription_cancel: { enabled: true, mode: 'immediately' } } });
    const session = await portal(stripe, customer, {
      flow_data: { type: 'subscription_cancel', subscription_cancel: { subscription: subscription.id }, after_completion: { type: 'hosted_confirmation', hosted_confirmation: { custom_message: 'Sorry to see you go.' } } },
    });
    const landing = await getPage(session.url);
    expect(landing.text).toContain('Cancel your plan');
    expect(landing.text).not.toContain('id="invoice-history"');
    const done = await postForm(session.url, { action: 'cancel_subscription', subscription: subscription.id });
    expect(done.status).toBe(303);
    expect(done.location).toContain('screen=done');
    const confirmation = await getPage(new URL(done.location, t.url).href);
    expect(confirmation.text).toContain('Sorry to see you go.');
    expect((await stripe.subscriptions.retrieve(subscription.id)).status).toBe('canceled');
    expect(await eventTypes(stripe)).toContain('customer.subscription.deleted');
  });

  it('switches the default card between test cards', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({ features: { payment_method_update: { enabled: true } } });
    const session = await portal(stripe, customer);
    const screen = await getPage(`${session.url}?screen=payment_method`);
    expect(screen.text).toContain('4000000000000341');
    const declined = await postForm(session.url, { action: 'update_payment_method', card_number: '4000000000000002' });
    expect(declined.status).toBe(402);
    expect(pageError(declined.text)).toBe('Your card was declined.');
    expect((await postForm(session.url, { action: 'update_payment_method', card_number: '4000000000000341' })).status).toBe(303);

    const updated = await stripe.customers.retrieve(customer.id);
    const pm = await stripe.paymentMethods.retrieve(updated.invoice_settings.default_payment_method);
    expect(pm).toMatchObject({ customer: customer.id, card: { last4: '0341' } });
    const sub = await stripe.subscriptions.retrieve(subscription.id);
    expect(sub.default_payment_method).toBe(pm.id);
    expect(await eventTypes(stripe)).toEqual(expect.arrayContaining(['payment_method.attached', 'customer.updated']));
  });

  it('continues or ends a trial on a plan change per trial_update_behavior', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const keep = await subscriber(t, stripe, c.basicMonthly, { trialDays: 14 });
    const end = await subscriber(t, stripe, c.basicMonthly, { trialDays: 14 });
    const continueConfig = await stripe.billingPortal.configurations.create({ features: { subscription_update: updateFeature(c, { trial_update_behavior: 'continue_trial' }) } });
    const endConfig = await stripe.billingPortal.configurations.create({ features: { subscription_update: updateFeature(c) } });

    const s1 = await portal(stripe, keep.customer, { configuration: continueConfig.id });
    expect((await postForm(s1.url, { action: 'update_subscription', subscription: keep.subscription.id, price: c.proMonthly.id })).status).toBe(303);
    const kept = await stripe.subscriptions.retrieve(keep.subscription.id);
    expect(kept).toMatchObject({ status: 'trialing', trial_end: keep.subscription.trial_end });
    expect(kept.items.data[0].price.id).toBe(c.proMonthly.id);

    const s2 = await portal(stripe, end.customer, { configuration: endConfig.id });
    expect((await postForm(s2.url, { action: 'update_subscription', subscription: end.subscription.id, price: c.proMonthly.id })).status).toBe(303);
    const ended = await stripe.subscriptions.retrieve(end.subscription.id);
    expect(ended.status).toBe('active');
    expect(ended.trial_end).toBeLessThan(end.subscription.trial_end);
    expect((await stripe.events.list({ type: 'customer.subscription.trial_will_end' })).data.map((e) => e.data.object.id)).toContain(end.subscription.id);
  });

  it('lands subscription_update_confirm on its confirmation and redirects per after_completion', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({ features: { subscription_update: updateFeature(c) } });
    const session = await portal(stripe, customer, {
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: { subscription: subscription.id, items: [{ id: subscription.items.data[0].id, price: c.proMonthly.id }] },
        after_completion: { type: 'redirect', redirect: { return_url: 'https://example.com/upgraded' } },
      },
    });
    const landing = await getPage(session.url);
    expect(landing.text).toContain('Confirm your update');
    expect(landing.text).toContain(`data-price="${c.proMonthly.id}"`);
    const done = await postForm(session.url, { action: 'update_subscription', subscription: subscription.id });
    expect([done.status, done.location]).toEqual([303, 'https://example.com/upgraded']);
    expect((await stripe.subscriptions.retrieve(subscription.id)).items.data[0].price.id).toBe(c.proMonthly.id);
  });

  it('lands subscription_update and payment_method_update deep links on their screens', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({
      features: { subscription_update: updateFeature(c), payment_method_update: { enabled: true }, invoice_history: { enabled: true } },
    });
    const update = await portal(stripe, customer, { flow_data: { type: 'subscription_update', subscription_update: { subscription: subscription.id } } });
    const screen = await getPage(update.url);
    expect(screen.text).toContain('Update plan');
    expect(screen.text).not.toContain('id="invoice-history"');
    const review = await getPage(`${update.url}?screen=confirm_update&subscription=${subscription.id}&price=${c.proMonthly.id}`);
    expect(review.text).toContain('Confirm your update');
    expect((await postForm(update.url, { action: 'update_subscription', subscription: subscription.id, price: c.proMonthly.id })).location).toContain('screen=done');

    const card = await portal(stripe, customer, { flow_data: { type: 'payment_method_update', after_completion: { type: 'portal_homepage' } } });
    const cardScreen = await getPage(card.url);
    expect(cardScreen.text).toContain('Add a payment method');
    const saved = await postForm(card.url, { action: 'update_payment_method', card_number: '5555555555554444' });
    expect(saved.location).toBe(`${new URL(card.url).pathname}?screen=home&notice=payment_method`);
    const home = await getPage(new URL(saved.location, t.url).href);
    expect(home.text).toContain('id="invoice-history"');
    expect(home.text).toContain('Mastercard •••• 4444');
  });

  it('refuses actions outside a deep link\'s flow, and every action once the flow is done', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    const other = await stripe.subscriptions.retrieve((await t.account().createSubscription(customer.id, { price: c.proMonthly.id, paymentMethod: 'pm_card_visa' })).id);
    await stripe.billingPortal.configurations.create({
      features: { subscription_update: updateFeature(c), payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'immediately' } },
    });
    const card = await portal(stripe, customer, { flow_data: { type: 'payment_method_update', after_completion: { type: 'hosted_confirmation' } } });
    const outside = await postForm(card.url, { action: 'cancel_subscription', subscription: subscription.id });
    expect([outside.status, pageError(outside.text)]).toEqual([403, 'That action is not available here.']);
    expect((await postForm(card.url, { action: 'update_payment_method', card_number: '4242424242424242' })).location).toContain('screen=done');
    const after = await postForm(card.url, { action: 'cancel_subscription', subscription: other.id });
    expect(after.status).toBe(403);

    const update = await portal(stripe, customer, { flow_data: { type: 'subscription_update', subscription_update: { subscription: subscription.id } } });
    const wrongSub = await postForm(update.url, { action: 'update_subscription', subscription: other.id, price: c.basicMonthly.id });
    expect(wrongSub.status).toBe(403);
    const subs = await Promise.all([subscription, other].map((s) => stripe.subscriptions.retrieve(s.id)));
    expect(subs.map((s) => [s.status, s.items.data[0].price.id])).toEqual([
      ['active', c.basicMonthly.id],
      ['active', c.proMonthly.id],
    ]);
  });

  it('leaves the plan unchanged when the payment for an upgrade is declined, keeping the flow open', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly);
    await stripe.billingPortal.configurations.create({ features: { subscription_update: updateFeature(c, { proration_behavior: 'always_invoice' }) } });
    await t.account().advanceTime({ seconds: 5 * DAY });
    await t.account().failNextCharge(customer.id);
    const session = await portal(stripe, customer, {
      flow_data: {
        type: 'subscription_update_confirm',
        subscription_update_confirm: { subscription: subscription.id, items: [{ id: subscription.items.data[0].id, price: c.proMonthly.id }] },
        after_completion: { type: 'redirect', redirect: { return_url: 'https://example.com/upgraded' } },
      },
    });
    const declined = await postForm(session.url, { action: 'update_subscription', subscription: subscription.id });
    expect(declined.status).toBe(402);
    expect(declined.text).toContain('Confirm your update');
    expect(pageError(declined.text)).toBeTruthy();
    const unchanged = await stripe.subscriptions.retrieve(subscription.id);
    expect([unchanged.status, unchanged.items.data[0].price.id, unchanged.latest_invoice, unchanged.pending_update]).toEqual(['active', c.basicMonthly.id, subscription.latest_invoice, null]);

    const retried = await postForm(session.url, { action: 'update_subscription', subscription: subscription.id });
    expect([retried.status, retried.location]).toEqual([303, 'https://example.com/upgraded']);
    expect((await stripe.subscriptions.retrieve(subscription.id)).items.data[0].price.id).toBe(c.proMonthly.id);
  });

  it('does not cancel an incomplete subscription, which the page offers no cancel for', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const customer = await stripe.customers.create({ email: 'jenny@example.com' });
    const incomplete = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: c.basicMonthly.id }], payment_behavior: 'default_incomplete' });
    expect(incomplete.status).toBe('incomplete');
    await stripe.billingPortal.configurations.create({ features: { subscription_cancel: { enabled: true, mode: 'immediately' } } });
    const session = await portal(stripe, customer);
    expect((await getPage(session.url)).text).not.toContain('class="cancel"');
    const refused = await postForm(session.url, { action: 'cancel_subscription', subscription: incomplete.id });
    expect(refused.status).toBe(400);
    expect((await stripe.subscriptions.retrieve(incomplete.id)).status).toBe('incomplete');
  });

  it('updates billing information within allowed_updates', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'old@example.com', name: 'Old Name', phone: '+15550000000' });
    await stripe.billingPortal.configurations.create({ features: { customer_update: { enabled: true, allowed_updates: ['email', 'name'] } } });
    const session = await portal(stripe, customer);
    const screen = await getPage(`${session.url}?screen=billing`);
    expect(screen.text).toContain('name="email"');
    expect(screen.text).not.toContain('name="phone"');
    const done = await postForm(session.url, { action: 'update_customer', email: 'new@example.com', name: 'New Name', phone: '+15551111111' });
    expect(done.status).toBe(303);
    expect(await stripe.customers.retrieve(customer.id)).toMatchObject({ email: 'new@example.com', name: 'New Name', phone: '+15550000000' });
    const [event] = (await stripe.events.list({ type: 'customer.updated' })).data;
    expect(event.data.previous_attributes).toMatchObject({ email: 'old@example.com', name: 'Old Name' });

    const flow = await portal(stripe, customer, { flow_data: { type: 'customer_update', after_completion: { type: 'redirect', redirect: { return_url: 'https://example.com/saved' } } } });
    expect(flow.flow.customer_update).toEqual({});
    const landing = await getPage(flow.url);
    expect(landing.text).toContain('Billing information');
    expect(landing.text).toContain('value="new@example.com"');
    const saved = await postForm(flow.url, { action: 'update_customer', email: 'newest@example.com' });
    expect([saved.status, saved.location]).toEqual([303, 'https://example.com/saved']);
    expect((await stripe.customers.retrieve(customer.id)).email).toBe('newest@example.com');
  });

  it('expires sessions five minutes after creation unless used, then an hour after the last use', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'a@example.com' });
    await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const unused = await portal(stripe, customer);
    const used = await portal(stripe, customer);
    expect((await getPage(used.url)).status).toBe(200);
    await t.account().advanceTime({ seconds: 6 * 60 });
    expect((await getPage(unused.url)).status).toBe(410);
    expect((await getPage(used.url)).status).toBe(200);
    await t.account().advanceTime({ seconds: 61 * 60 });
    expect((await getPage(used.url)).status).toBe(410);
  });

  it('opens a session from the login page for the customer with that email', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const customer = await stripe.customers.create({ email: 'login@example.com' });
    const config = await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } }, login_page: { enabled: true } });
    expect(config.login_page.url).toMatch(new RegExp(`^${t.url}/p/login/test_`));
    expect((await getPage(config.login_page.url)).status).toBe(200);
    expect((await postForm(config.login_page.url, { email: 'nobody@example.com' })).status).toBe(404);
    const signIn = await postForm(config.login_page.url, { email: 'login@example.com' });
    expect(signIn.status).toBe(303);
    expect(signIn.location).toMatch(new RegExp(`^${t.url}/p/session/test_`));
    expect((await getPage(signIn.location)).text).toContain('login@example.com');
    const [event] = (await stripe.events.list({ type: 'billing_portal.session.created' })).data;
    expect(event.data.object.customer).toBe(customer.id);
    await stripe.billingPortal.configurations.update(config.id, { login_page: { enabled: false } });
    expect((await getPage(config.login_page.url)).status).toBe(404);
  });
});

describe('invoice history', () => {
  it('links open invoices to their hosted invoice page, where the customer can pay them', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const c = await catalog(stripe);
    const { customer, subscription } = await subscriber(t, stripe, c.basicMonthly, { card: 'pm_card_chargeCustomerFail', trialDays: 1 });
    await t.account().advanceTime({ seconds: DAY + 2 * 3600 });
    const [open] = (await stripe.invoices.list({ customer: customer.id, status: 'open' })).data;
    expect(open.hosted_invoice_url).toMatch(new RegExp(`^${t.url}/i/acct_\\w+/test_`));

    await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } });
    const home = await getPage((await portal(stripe, customer)).url);
    expect(home.text).toContain(`href="${open.hosted_invoice_url}"`);
    expect(home.text).toContain(`data-invoice="${open.id}"`);

    const page = await getPage(open.hosted_invoice_url);
    expect(page.status).toBe(200);
    expect(page.text).toContain(open.number);
    expect((await postForm(open.hosted_invoice_url, { card_number: '4000000000009995' })).status).toBe(402);
    expect((await postForm(open.hosted_invoice_url, { card_number: '4242424242424242' })).status).toBe(303);
    expect((await stripe.invoices.retrieve(open.id)).status).toBe('paid');
    expect((await stripe.subscriptions.retrieve(subscription.id)).status).toBe('active');
    const pdf = await fetch(open.invoice_pdf);
    expect(pdf.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await pdf.text()).toContain(open.number);
  });
});
