/**
 * API versions end to end, through the real SDK with `apiVersion` set per client or per request:
 * the documented field moves between the shape families (2024-06-20 and acacia = legacy shapes,
 * basil = item periods and invoice parents, clover and later = flexible billing by default), the
 * version-gated and unknown parameters, unknown Stripe-Version values and events rendered per
 * webhook endpoint version.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer, webhookReceiver } from './helpers.js';

const SDK_DEFAULT = '2026-08-26.dahlia';
/** The versions every rendering test walks; `null` = no override (the SDK's pinned version). */
const VERSIONS = ['2024-06-20', '2024-10-28.acacia', '2025-03-31.basil', '2025-09-30.clover', null];
const LEGACY = new Set(['2024-06-20', '2024-10-28.acacia']);
const at = (version) => (version ? { apiVersion: version } : {});
const label = (version) => version ?? `SDK default (${SDK_DEFAULT})`;
const DAY = 86400;
const CARD_OK = '4242424242424242';

/** A product, a $10 / month price and a customer with a default card. */
async function setup(t) {
  const stripe = t.stripe();
  const product = await stripe.products.create({ name: 'Pro' });
  const price = await stripe.prices.create({ product: product.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } });
  const customer = await stripe.customers.create({ email: 'jenny.rosen@example.com', name: 'Jenny Rosen' });
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  return { stripe, product, price, customer, pm };
}

/** Opens a session's hosted Checkout page and pays with `card`; returns the 303 Location. */
async function payOnHostedPage(session, card = CARD_OK) {
  const page = await fetch(session.url, { redirect: 'manual' });
  expect(page.status).toBe(200);
  const res = await fetch(session.url, {
    method: 'POST',
    body: new URLSearchParams({ card_number: card, exp_month: '12', exp_year: '34', cvc: '123', cardholder_name: 'Jenny Rosen' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  expect(res.status).toBe(303);
  return res.headers.get('location');
}

function sessionParams(price, extra = {}) {
  return {
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://example.com/cancel',
    customer_email: 'jenny.rosen@example.com',
    ...extra,
  };
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

describe('subscription shapes per version', () => {
  it('moves current_period_* from the subscription (legacy) to its items (basil and later)', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    const [item] = sub.items.data;

    for (const version of VERSIONS) {
      const got = await stripe.subscriptions.retrieve(sub.id, {}, at(version));
      const listed = (await stripe.subscriptions.list({ customer: customer.id }, at(version))).data;
      expect(got.lastResponse.apiVersion, label(version)).toBe(version ?? SDK_DEFAULT);
      for (const s of [got, listed[0]]) {
        const it0 = s.items.data[0];
        expect(it0.id, label(version)).toBe(item.id);
        if (LEGACY.has(version)) {
          expect([s.current_period_start, s.current_period_end], label(version)).toEqual([item.current_period_start, item.current_period_end]);
          expect(has(it0, 'current_period_start') || has(it0, 'current_period_end'), label(version)).toBe(false);
          // `discount` was removed at basil; `aggregate_usage` (legacy metering) too.
          expect(s.discount, label(version)).toBeNull();
          expect(it0.price.recurring.aggregate_usage, label(version)).toBeNull();
          expect(it0.plan.aggregate_usage, label(version)).toBeNull();
          expect(has(s, 'billing_mode'), label(version)).toBe(false);
        } else {
          expect(has(s, 'current_period_start') || has(s, 'current_period_end'), label(version)).toBe(false);
          expect([it0.current_period_start, it0.current_period_end], label(version)).toEqual([item.current_period_start, item.current_period_end]);
          expect(has(s, 'discount'), label(version)).toBe(false);
          expect(has(it0.price.recurring, 'aggregate_usage'), label(version)).toBe(false);
          expect(has(it0.plan, 'aggregate_usage'), label(version)).toBe(false);
        }
        // Items carry both the legacy plan and the price at every version; the price is embedded.
        expect(it0.plan).toMatchObject({ id: price.id, object: 'plan' });
        expect(it0.price).toMatchObject({ id: price.id, object: 'price', product: price.product });
      }
    }
    // billing_mode appears only from 2025-06-30.basil; billing_schedules only from 2026-05-27.dahlia.
    const basil = await stripe.subscriptions.retrieve(sub.id, {}, at('2025-03-31.basil'));
    expect(has(basil, 'billing_mode')).toBe(false);
    const lateBasil = await stripe.subscriptions.retrieve(sub.id, {}, at('2025-06-30.basil'));
    expect(lateBasil.billing_mode.type).toBe('flexible');
    const clover = await stripe.subscriptions.retrieve(sub.id, {}, at('2025-09-30.clover'));
    expect(clover.billing_mode.type).toBe('flexible');
    expect(has(clover, 'billing_schedules')).toBe(false);
    const latest = await stripe.subscriptions.retrieve(sub.id);
    expect(latest.billing_schedules).toEqual([]);
    expect(latest.customer_account).toBeNull();
    // billed_until is includable at dahlia: absent unless expanded.
    expect(has(latest.items.data[0], 'billed_until')).toBe(false);
  });

  it('keeps every period equal to trial_end while trialing, at the level each version shows', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }], trial_period_days: 14 });
    expect(sub.status).toBe('trialing');
    const legacy = await stripe.subscriptions.retrieve(sub.id, {}, at('2024-06-20'));
    expect([legacy.current_period_start, legacy.current_period_end]).toEqual([sub.trial_start, sub.trial_end]);
    const basil = await stripe.subscriptions.retrieve(sub.id, {}, at('2025-03-31.basil'));
    expect(basil.items.data[0].current_period_end).toBe(sub.trial_end);
    expect(sub.trial_end - sub.trial_start).toBe(14 * DAY);
  });
});

describe('invoice shapes per version', () => {
  it('moves invoice.subscription to parent.subscription_details.subscription and line price/type to pricing/parent', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }], metadata: { plan: 'pro' } });
    const itemId = sub.items.data[0].id;

    for (const version of VERSIONS) {
      const retrieved = await stripe.invoices.retrieve(sub.latest_invoice, {}, at(version));
      const listed = await stripe.invoices.list({ customer: customer.id }, at(version));
      expect(listed.data.map((i) => i.id), label(version)).toEqual([sub.latest_invoice]);
      // `subscription` stays a list filter at every version.
      expect((await stripe.invoices.list({ subscription: sub.id }, at(version))).data.map((i) => i.id), label(version)).toEqual([sub.latest_invoice]);
      for (const invoice of [retrieved, listed.data[0]]) {
        const [line] = invoice.lines.data;
        expect(invoice.status, label(version)).toBe('paid');
        if (LEGACY.has(version)) {
          expect(invoice, label(version)).toMatchObject({ subscription: sub.id, paid: true, paid_out_of_band: false, subscription_details: { metadata: { plan: 'pro' } } });
          expect(invoice.discount, label(version)).toBeNull();
          expect(invoice.charge, label(version)).toMatch(/^ch_/);
          expect(invoice.payment_intent, label(version)).toMatch(/^pi_/);
          expect(invoice.total_tax_amounts, label(version)).toEqual([]);
          for (const key of ['parent', 'total_taxes', 'amount_overpaid', 'total_pretax_credit_amounts', 'payments', 'confirmation_secret']) {
            expect(has(invoice, key), `${label(version)} invoice.${key}`).toBe(false);
          }
          expect(line, label(version)).toMatchObject({
            type: 'subscription',
            proration: false,
            subscription: sub.id,
            subscription_item: itemId,
            price: { id: price.id, object: 'price' },
            plan: { id: price.id, object: 'plan' },
            tax_amounts: [],
          });
          for (const key of ['pricing', 'parent', 'taxes', 'pretax_credit_amounts', 'subtotal', 'quantity_decimal']) {
            expect(has(line, key), `${label(version)} line.${key}`).toBe(false);
          }
        } else {
          expect(invoice.parent, label(version)).toEqual({
            type: 'subscription_details',
            quote_details: null,
            subscription_details: expect.objectContaining({ subscription: sub.id, metadata: { plan: 'pro' } }),
          });
          expect(invoice.total_taxes, label(version)).toEqual([]);
          for (const key of ['subscription', 'subscription_details', 'subscription_proration_date', 'paid', 'paid_out_of_band', 'charge', 'payment_intent', 'discount', 'tax', 'total_tax_amounts', 'quote']) {
            expect(has(invoice, key), `${label(version)} invoice.${key}`).toBe(false);
          }
          // Includable: absent unless expanded.
          expect(has(invoice, 'payments') || has(invoice, 'confirmation_secret'), label(version)).toBe(false);
          // The SDK coerces pricing.unit_amount_decimal into a Decimal on this resource.
          expect(line.pricing, label(version)).toMatchObject({ type: 'price_details', price_details: { price: price.id, product: price.product } });
          expect(String(line.pricing.unit_amount_decimal), label(version)).toBe('1000');
          expect(line.parent, label(version)).toMatchObject({
            type: 'subscription_item_details',
            invoice_item_details: null,
            subscription_item_details: { subscription: sub.id, subscription_item: itemId, proration: false },
          });
          expect(line.taxes, label(version)).toEqual([]);
          // The spec still lists a nullable top-level line `subscription` at every version.
          expect(line.subscription, label(version)).toBe(sub.id);
          for (const key of ['price', 'plan', 'type', 'proration', 'proration_details', 'subscription_item', 'invoice_item', 'tax_amounts', 'tax_rates', 'amount_excluding_tax', 'unit_amount_excluding_tax']) {
            expect(has(line, key), `${label(version)} line.${key}`).toBe(false);
          }
        }
      }
    }

    // Additions after basil: amount_overpaid and total_pretax_credit_amounts (clover render),
    // line subtotal (2025-12-15.clover), line quantity_decimal (2026-03-25.dahlia).
    const clover = await stripe.invoices.retrieve(sub.latest_invoice, {}, at('2025-09-30.clover'));
    expect([clover.amount_overpaid, clover.total_pretax_credit_amounts]).toEqual([0, []]);
    expect(has(clover.lines.data[0], 'subtotal') || has(clover.lines.data[0], 'quantity_decimal')).toBe(false);
    const lateClover = await stripe.invoices.retrieve(sub.latest_invoice, {}, at('2025-12-15.clover'));
    expect(lateClover.lines.data[0].subtotal).toBe(1000);
    expect(has(lateClover.lines.data[0], 'quantity_decimal')).toBe(false);
    const latest = await stripe.invoices.retrieve(sub.latest_invoice);
    expect(latest.lines.data[0].subtotal).toBe(1000);
    expect(String(latest.lines.data[0].quantity_decimal)).toBe('1');
    // amount_paid_off_stripe (2026-05-27.dahlia) is includable only.
    expect(has(latest, 'amount_paid_off_stripe')).toBe(false);
  });

  it('expands the subscription reference only where the version has it', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });

    const legacy = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['subscription'] }, at('2024-06-20'));
    expect(legacy.subscription).toMatchObject({ id: sub.id, object: 'subscription', current_period_end: sub.items.data[0].current_period_end });
    const legacyNew = await rejection(stripe.invoices.retrieve(sub.latest_invoice, { expand: ['parent.subscription_details.subscription'] }, at('2024-06-20')));
    expect([legacyNew.statusCode, legacyNew.type, legacyNew.param]).toEqual([400, 'StripeInvalidRequestError', 'expand']);

    const latest = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['parent.subscription_details.subscription'] });
    expect(latest.parent.subscription_details.subscription).toMatchObject({ id: sub.id, object: 'subscription' });
    expect(has(latest.parent.subscription_details.subscription, 'current_period_end')).toBe(false);
    const latestOld = await rejection(stripe.invoices.retrieve(sub.latest_invoice, { expand: ['subscription'] }));
    expect([latestOld.statusCode, latestOld.param]).toEqual([400, 'expand']);

    // lines.data.pricing.price_details.price is expandable (changelog 2025-12-15.clover).
    const expanded = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['lines.data.pricing.price_details.price'] });
    expect(expanded.lines.data[0].pricing.price_details.price).toMatchObject({ id: price.id, object: 'price' });
    // Whether versions before 2025-12-15.clover refuse this expansion is open: the change is listed
    // as non-breaking, and only the documented hard gates are enforced. Not asserted.
    // Legacy lines embed the price; there is no pricing hash to expand.
    const legacyLines = await rejection(stripe.invoices.retrieve(sub.latest_invoice, { expand: ['lines.data.pricing.price_details.price'] }, at('2024-06-20')));
    expect([legacyLines.statusCode, legacyLines.param]).toEqual([400, 'expand']);
  });
});

describe('Checkout Sessions per version, completed on the hosted page', () => {
  it('renders the session shape of each version, before and after completion with a trial', async () => {
    const t = await startServer();
    const { stripe, price } = await setup(t);
    const session = await stripe.checkout.sessions.create(sessionParams(price, { subscription_data: { trial_period_days: 7 } }));

    for (const version of VERSIONS) {
      const open = await stripe.checkout.sessions.retrieve(session.id, {}, at(version));
      expect(open.status, label(version)).toBe('open');
      expect(open.currency_conversion, label(version)).toBeNull();
      if (LEGACY.has(version)) {
        expect(open.ui_mode, label(version)).toBe('hosted');
        expect(open.shipping_details, label(version)).toBeNull();
        expect(has(open, 'collected_information') || has(open, 'adaptive_pricing'), label(version)).toBe(false);
      } else {
        expect(has(open, 'shipping_details'), label(version)).toBe(false);
        expect(has(open, 'collected_information'), label(version)).toBe(true);
        // The dahlia ui_mode values exist only from 2026-03-25.dahlia.
        expect(open.ui_mode, label(version)).toBe(version ? 'hosted' : 'hosted_page');
      }
    }

    expect(await payOnHostedPage(session)).toBe(`https://example.com/success?session_id=${session.id}`);
    const done = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription'] });
    expect(done).toMatchObject({ status: 'complete', payment_status: 'paid', url: null, amount_total: 0, payment_intent: null });
    expect(done.invoice).toMatch(/^in_/);
    const sub = done.subscription;
    expect(sub.status).toBe('trialing');
    // Created from a dahlia request: flexible billing mode.
    expect(sub.billing_mode.type).toBe('flexible');
    expect(sub.items.data[0].current_period_end).toBe(sub.trial_end);

    const legacySub = await stripe.subscriptions.retrieve(sub.id, {}, at('2024-06-20'));
    expect(legacySub.current_period_end).toBe(sub.trial_end);
    const legacyInvoice = await stripe.invoices.retrieve(done.invoice, {}, at('2024-06-20'));
    expect(legacyInvoice).toMatchObject({ subscription: sub.id, amount_due: 0, paid: true, billing_reason: 'subscription_create' });
    const basilInvoice = await stripe.invoices.retrieve(done.invoice, {}, at('2025-03-31.basil'));
    expect(basilInvoice.parent.subscription_details.subscription).toBe(sub.id);
    expect(has(basilInvoice, 'paid')).toBe(false);
  });

  it('records the version of the creating request: billing mode by version, payment_intent only from basil', async () => {
    const t = await startServer();
    const { stripe, price } = await setup(t);
    const results = {};
    for (const version of ['2024-06-20', '2025-03-31.basil', '2025-09-30.clover']) {
      const client = t.stripe(t.key, { apiVersion: version });
      const session = await client.checkout.sessions.create(sessionParams(price));
      await payOnHostedPage(session);
      const done = await client.checkout.sessions.retrieve(session.id);
      expect(done.lastResponse.apiVersion).toBe(version);
      const sub = await stripe.subscriptions.retrieve(done.subscription);
      results[version] = { status: done.status, mode: sub.billing_mode.type, subStatus: sub.status, pi: done.payment_intent === null ? null : done.payment_intent.slice(0, 3) };
    }
    expect(results).toEqual({
      // The legacy flow puts the PaymentIntent on the invoice only (inferred: the basil changelog
      // introduces reading it from the completed session).
      '2024-06-20': { status: 'complete', mode: 'classic', subStatus: 'active', pi: null },
      '2025-03-31.basil': { status: 'complete', mode: 'classic', subStatus: 'active', pi: 'pi_' },
      '2025-09-30.clover': { status: 'complete', mode: 'flexible', subStatus: 'active', pi: 'pi_' },
    });
  });

  it('gates ui_mode values by version', async () => {
    const t = await startServer();
    const { stripe, price } = await setup(t);
    const legacy = await stripe.checkout.sessions.create(sessionParams(price, { ui_mode: 'hosted' }), at('2025-09-30.clover'));
    expect(legacy.ui_mode).toBe('hosted');
    const tooNew = await rejection(stripe.checkout.sessions.create(sessionParams(price, { ui_mode: 'hosted_page' }), at('2025-09-30.clover')));
    expect([tooNew.statusCode, tooNew.rawType, tooNew.param]).toEqual([400, 'invalid_request_error', 'ui_mode']);
    const removed = await rejection(stripe.checkout.sessions.create(sessionParams(price, { ui_mode: 'hosted' })));
    expect([removed.statusCode, removed.rawType, removed.param]).toEqual([400, 'invalid_request_error', 'ui_mode']);
    const current = await stripe.checkout.sessions.create(sessionParams(price, { ui_mode: 'hosted_page' }));
    expect(current.ui_mode).toBe('hosted_page');
  });
});

describe('per-request versions on writes', () => {
  it('a client pinned to 2024-06-20 writes at 2025-09-30.clover per request, and the other way round', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const legacyClient = t.stripe(t.key, { apiVersion: '2024-06-20' });
    const cloverClient = t.stripe(t.key, { apiVersion: '2025-09-30.clover' });

    // Pinned 2024-06-20, clover for this request: clover shape, flexible billing by the request version.
    const upgraded = await legacyClient.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }, { apiVersion: '2025-09-30.clover' });
    expect(upgraded.lastResponse.apiVersion).toBe('2025-09-30.clover');
    expect(upgraded.billing_mode.type).toBe('flexible');
    expect(has(upgraded, 'current_period_end')).toBe(false);
    expect(upgraded.items.data[0].current_period_end).toEqual(expect.any(Number));
    // The pinned version applies again on the next request.
    const again = await legacyClient.subscriptions.retrieve(upgraded.id);
    expect(again.lastResponse.apiVersion).toBe('2024-06-20');
    expect(again.current_period_end).toBe(upgraded.items.data[0].current_period_end);
    expect(has(again, 'billing_mode')).toBe(false);

    // Pinned clover, 2024-06-20 for this request: legacy shape, classic billing by the request version.
    const downgraded = await cloverClient.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }, { apiVersion: '2024-06-20' });
    expect(downgraded.lastResponse.apiVersion).toBe('2024-06-20');
    expect(downgraded.current_period_end).toEqual(expect.any(Number));
    expect(has(downgraded, 'billing_mode')).toBe(false);
    expect(has(downgraded.items.data[0], 'current_period_end')).toBe(false);
    expect((await cloverClient.subscriptions.retrieve(downgraded.id)).billing_mode.type).toBe('classic');
    expect((await stripe.subscriptions.retrieve(upgraded.id)).billing_mode.type).toBe('flexible');

    // An update answers in the request's version too, in both directions.
    const updatedNew = await legacyClient.subscriptions.update(downgraded.id, { metadata: { a: '1' } }, { apiVersion: '2025-09-30.clover' });
    expect([updatedNew.lastResponse.apiVersion, has(updatedNew, 'current_period_end'), updatedNew.billing_mode.type]).toEqual(['2025-09-30.clover', false, 'classic']);
    const updatedOld = await cloverClient.subscriptions.update(upgraded.id, { metadata: { a: '2' } }, { apiVersion: '2024-06-20' });
    expect([updatedOld.lastResponse.apiVersion, typeof updatedOld.current_period_end, has(updatedOld, 'billing_mode')]).toEqual(['2024-06-20', 'number', false]);
    const invoice = await cloverClient.invoices.retrieve(updatedOld.latest_invoice, {}, { apiVersion: '2024-06-20' });
    expect(invoice.subscription).toBe(upgraded.id);
  });
});

describe('version-gated and unknown parameters', () => {
  const sape = { conditions: [{ type: 'decreasing_item_amount' }] };
  const profile = { headline: 'Acme' };

  it('accepts portal schedule_at_period_end from 2024-10-28.acacia and trial_update_behavior from 2025-09-30.clover', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const before = (await stripe.billingPortal.configurations.list()).data.length;
    const cases = [
      ['2024-06-20', { schedule_at_period_end: sape }, 'features[subscription_update][schedule_at_period_end]'],
      ['2024-09-30.acacia', { schedule_at_period_end: sape }, 'features[subscription_update][schedule_at_period_end]'],
      ['2024-06-20', { trial_update_behavior: 'continue_trial' }, 'features[subscription_update][trial_update_behavior]'],
      ['2024-10-28.acacia', { trial_update_behavior: 'continue_trial' }, 'features[subscription_update][trial_update_behavior]'],
      ['2025-03-31.basil', { trial_update_behavior: 'continue_trial' }, 'features[subscription_update][trial_update_behavior]'],
      ['2025-08-27.basil', { trial_update_behavior: 'end_trial' }, 'features[subscription_update][trial_update_behavior]'],
    ];
    for (const [version, update, param] of cases) {
      const err = await rejection(
        stripe.billingPortal.configurations.create({ business_profile: profile, features: { subscription_update: { enabled: false, ...update } } }, at(version)),
      );
      expect([err.statusCode, err.rawType, err.code, err.param], `${version} ${param}`).toEqual([400, 'invalid_request_error', 'parameter_unknown', param]);
    }
    expect((await stripe.billingPortal.configurations.list()).data).toHaveLength(before);

    const acacia = await stripe.billingPortal.configurations.create(
      { features: { subscription_update: { enabled: false, schedule_at_period_end: sape } } },
      at('2024-10-28.acacia'),
    );
    expect(acacia.features.subscription_update.schedule_at_period_end).toEqual(sape);
    const clover = await stripe.billingPortal.configurations.create(
      { features: { subscription_update: { enabled: false, schedule_at_period_end: sape, trial_update_behavior: 'continue_trial' } } },
      at('2025-09-30.clover'),
    );
    expect(clover.features.subscription_update).toMatchObject({ schedule_at_period_end: sape, trial_update_behavior: 'continue_trial' });
    const latest = await stripe.billingPortal.configurations.create({ features: { subscription_update: { enabled: false, trial_update_behavior: 'continue_trial' } } });
    expect(latest.features.subscription_update.trial_update_behavior).toBe('continue_trial');

    // The same gates apply on update.
    const old = await rejection(stripe.billingPortal.configurations.update(acacia.id, { features: { subscription_update: { trial_update_behavior: 'continue_trial' } } }, at('2025-08-27.basil')));
    expect([old.code, old.param]).toEqual(['parameter_unknown', 'features[subscription_update][trial_update_behavior]']);
    const oldSape = await rejection(stripe.billingPortal.configurations.update(acacia.id, { features: { subscription_update: { schedule_at_period_end: { conditions: '' } } } }, at('2024-06-20')));
    expect([oldSape.code, oldSape.param]).toEqual(['parameter_unknown', 'features[subscription_update][schedule_at_period_end]']);
    const updated = await stripe.billingPortal.configurations.update(acacia.id, { features: { subscription_update: { trial_update_behavior: 'continue_trial' } } }, at('2025-09-30.clover'));
    expect(updated.features.subscription_update.trial_update_behavior).toBe('continue_trial');
  });

  it('requires business_profile on portal configurations before 2024-10-28.acacia', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const err = await rejection(stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } }, at('2024-06-20')));
    expect([err.statusCode, err.code, err.param]).toEqual([400, 'parameter_missing', 'business_profile']);
    const ok = await stripe.billingPortal.configurations.create({ business_profile: profile, features: { invoice_history: { enabled: true } } }, at('2024-06-20'));
    expect(ok.business_profile.headline).toBe('Acme');
    expect((await stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true } } }, at('2024-10-28.acacia'))).object).toBe(
      'billing_portal.configuration',
    );
  });

  it('renders portal configurations in the full current shape at every version', async () => {
    // Every portal change in range is non-breaking, so the configuration keeps its full current
    // shape at every version (inferred; see README "Uncertain behaviour").
    const t = await startServer();
    const stripe = t.stripe();
    const config = await stripe.billingPortal.configurations.create({ features: { subscription_update: { enabled: false, schedule_at_period_end: sape } } });
    for (const version of VERSIONS) {
      const got = await stripe.billingPortal.configurations.retrieve(config.id, {}, at(version));
      const listed = (await stripe.billingPortal.configurations.list({}, at(version))).data.find((c) => c.id === config.id);
      for (const c of [got, listed]) {
        expect(c.features.subscription_update, label(version)).toMatchObject({
          enabled: false,
          proration_behavior: 'none',
          schedule_at_period_end: sape,
          trial_update_behavior: 'end_trial',
          billing_cycle_anchor: null,
        });
        expect(c.name, label(version)).toBeNull();
        expect(has(c.features.subscription_update, 'products'), label(version)).toBe(false);
      }
    }
  });

  it('rejects unknown parameters with parameter_unknown and the bracketed param on every resource', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    const cases = [
      ['subscriptions.update', () => stripe.subscriptions.update(sub.id, { foo: 'bar' }), 'foo'],
      ['subscriptions.update nested', () => stripe.subscriptions.update(sub.id, { items: [{ id: sub.items.data[0].id, bogus: '1' }] }), 'items[0][bogus]'],
      ['subscriptions.retrieve', () => stripe.subscriptions.retrieve(sub.id, { bogus: '1' }), 'bogus'],
      ['subscriptions.list', () => stripe.subscriptions.list({ bogus: '1' }), 'bogus'],
      ['invoices.list', () => stripe.invoices.list({ bogus: '1' }), 'bogus'],
      ['invoices.retrieve', () => stripe.invoices.retrieve(sub.latest_invoice, { bogus: '1' }), 'bogus'],
      ['checkout.sessions.create', () => stripe.checkout.sessions.create(sessionParams(price, { subscription_data: { bogus: '1' } })), 'subscription_data[bogus]'],
      ['checkout.sessions.create top', () => stripe.checkout.sessions.create(sessionParams(price, { bogus: '1' })), 'bogus'],
      ['billingPortal.configurations.create', () => stripe.billingPortal.configurations.create({ features: { invoice_history: { enabled: true, bogus: '1' } } }), 'features[invoice_history][bogus]'],
      // Removed at 2025-03-31.basil (singular coupon).
      ['subscriptions.update coupon at basil', () => stripe.subscriptions.update(sub.id, { coupon: 'co_x' }, at('2025-03-31.basil')), 'coupon'],
      // Removed at 2025-09-30.clover (phases.iterations).
      [
        'subscriptionSchedules.create iterations at clover',
        () => stripe.subscriptionSchedules.create({ customer: customer.id, start_date: 'now', phases: [{ items: [{ price: price.id }], iterations: 1 }] }, at('2025-09-30.clover')),
        'phases[0][iterations]',
      ],
    ];
    for (const [name, call, param] of cases) {
      const err = await rejection(call());
      expect([err.statusCode, err.type, err.rawType, err.code, err.param], name).toEqual([400, 'StripeInvalidRequestError', 'invalid_request_error', 'parameter_unknown', param]);
    }
    // Nothing changed.
    const now = await stripe.subscriptions.retrieve(sub.id);
    expect(now.metadata).toEqual({});
    expect((await stripe.subscriptionSchedules.list()).data).toEqual([]);
    // On the versions that still have it, `coupon` is a known param (an unknown coupon is a different error).
    const legacyCoupon = await rejection(stripe.subscriptions.update(sub.id, { coupon: 'co_x' }, at('2025-02-24.acacia')));
    expect(legacyCoupon.code).not.toBe('parameter_unknown');
    expect(legacyCoupon.param).toBe('coupon');
  });
});

describe('Stripe-Version values', () => {
  it('rejects versions that do not exist, before anything runs, and accepts preview and dashboard versions', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    for (const bad of ['2024-06-21', '2026-08-26.basil', 'latest', '2025-13-01.clover']) {
      const err = await rejection(stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }, at(bad)));
      // 400 invalid_request_error, no code, no param (no documented response).
      expect([err.statusCode, err.rawType, err.code, err.param], bad).toEqual([400, 'invalid_request_error', undefined, undefined]);
    }
    expect((await stripe.subscriptions.list({ status: 'all' })).data).toEqual([]);

    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    // `.preview` from 2025-04-30 and 2025-03-01.dashboard are mapped by their date.
    const preview = await stripe.subscriptions.retrieve(sub.id, {}, at('2025-04-30.preview'));
    expect(preview.lastResponse.apiVersion).toBe('2025-04-30.preview');
    expect(has(preview, 'current_period_end')).toBe(false);
    const dashboard = await stripe.subscriptions.retrieve(sub.id, {}, at('2025-03-01.dashboard'));
    expect(dashboard.lastResponse.apiVersion).toBe('2025-03-01.dashboard');
    expect(dashboard.current_period_end).toBe(sub.items.data[0].current_period_end);
    // A preview string before previews existed is not a version.
    const earlyPreview = await rejection(stripe.subscriptions.retrieve(sub.id, {}, at('2025-03-31.preview')));
    expect([earlyPreview.statusCode, earlyPreview.rawType]).toEqual([400, 'invalid_request_error']);
  });
});

describe('events per webhook endpoint version', () => {
  it('renders one event per endpoint api_version, never in the request version', async () => {
    const legacyHooks = await webhookReceiver();
    const basilHooks = await webhookReceiver();
    const defaultHooks = await webhookReceiver();
    const t = await startServer({
      webhooks: [
        { url: legacyHooks.url, secret: 'whsec_legacy', apiVersion: '2024-06-20' },
        { url: defaultHooks.url, secret: 'whsec_default' },
      ],
    });
    const { stripe, price, customer } = await setup(t);
    const endpoint = await stripe.webhookEndpoints.create({ url: basilHooks.url, enabled_events: ['*'], api_version: '2025-03-31.basil' });
    // The write itself is sent at 2025-09-30.clover: it must not matter.
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }, at('2025-09-30.clover'));
    await t.server.settle();

    const verify = (hooks, secret) =>
      hooks.deliveries.map((d) => stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], secret));
    const legacy = verify(legacyHooks, 'whsec_legacy');
    const basil = verify(basilHooks, endpoint.secret);
    const dflt = verify(defaultHooks, 'whsec_default');
    const pick = (events, type) => events.find((e) => e.type === type);

    expect(new Set(legacy.map((e) => e.api_version))).toEqual(new Set(['2024-06-20']));
    expect(new Set(basil.map((e) => e.api_version))).toEqual(new Set(['2025-03-31.basil']));
    expect(new Set(dflt.map((e) => e.api_version))).toEqual(new Set([SDK_DEFAULT]));

    // One event ID, rendered per endpoint.
    const paid = ['invoice.paid', legacy, basil, dflt].slice(1).map((events) => pick(events, 'invoice.paid'));
    expect(new Set(paid.map((e) => e.id)).size).toBe(1);
    const [paidLegacy, paidBasil, paidDefault] = paid.map((e) => e.data.object);
    expect(paidLegacy).toMatchObject({ subscription: sub.id, paid: true });
    expect(has(paidLegacy, 'parent')).toBe(false);
    expect(paidLegacy.lines.data[0]).toMatchObject({ type: 'subscription', price: { id: price.id } });
    for (const inv of [paidBasil, paidDefault]) {
      expect(inv.parent.subscription_details.subscription).toBe(sub.id);
      expect(has(inv, 'subscription') || has(inv, 'paid')).toBe(false);
      expect(inv.lines.data[0].pricing.price_details.price).toBe(price.id);
      expect(has(inv.lines.data[0], 'price')).toBe(false);
    }
    expect(has(paidBasil.lines.data[0], 'subtotal')).toBe(false);
    expect(paidDefault.lines.data[0].subtotal).toBe(1000);

    const created = ['customer.subscription.created', legacy, basil, dflt].slice(1).map((events) => pick(events, 'customer.subscription.created').data.object);
    expect(created[0].current_period_end).toBe(sub.items.data[0].current_period_end);
    expect(has(created[0].items.data[0], 'current_period_end')).toBe(false);
    for (const s of created.slice(1)) {
      expect(has(s, 'current_period_end')).toBe(false);
      expect(s.items.data[0].current_period_end).toBe(sub.items.data[0].current_period_end);
    }
    // Created at a clover request: flexible, visible on the dahlia endpoint; basil (< 2025-06-30) has no billing_mode.
    expect(created[2].billing_mode.type).toBe('flexible');
    expect(has(created[1], 'billing_mode')).toBe(false);

    // The Events API renders in the account default, whatever the request version.
    const fetched = await stripe.events.retrieve(paid[0].id, {}, at('2024-06-20'));
    expect(fetched.api_version).toBe(SDK_DEFAULT);
    expect(fetched.data.object.parent.subscription_details.subscription).toBe(sub.id);
    expect(has(fetched.data.object, 'subscription')).toBe(false);
    const listed = (await stripe.events.list({ type: 'invoice.paid' }, at('2024-06-20'))).data[0];
    expect(listed.data.object.parent.subscription_details.subscription).toBe(sub.id);
  });

  it('renders events for endpoints without a version in the account default version', async () => {
    const hooks = await webhookReceiver();
    const t = await startServer({ apiVersion: '2024-06-20', webhooks: [{ url: hooks.url, secret: 'whsec_x' }] });
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    // The request was the SDK default (dahlia): the response is dahlia, the events are 2024-06-20.
    expect(has(sub, 'current_period_end')).toBe(false);
    await t.server.settle();
    const events = hooks.deliveries.map((d) => stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], 'whsec_x'));
    const paid = events.find((e) => e.type === 'invoice.paid');
    expect(paid.api_version).toBe('2024-06-20');
    expect(paid.data.object.subscription).toBe(sub.id);
    const created = events.find((e) => e.type === 'customer.subscription.created');
    expect(created.data.object.current_period_end).toBe(sub.items.data[0].current_period_end);
    expect((await stripe.events.retrieve(paid.id)).data.object.subscription).toBe(sub.id);
  });
});

describe('more version deltas', () => {
  it('allows expand[]=total_count on lists only before basil', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    const subs = await stripe.subscriptions.list({ expand: ['total_count'] }, at('2024-06-20'));
    expect(subs.total_count).toBe(1);
    const invoices = await stripe.invoices.list({ expand: ['total_count'] }, at('2024-10-28.acacia'));
    expect(invoices.total_count).toBe(1);
    for (const version of ['2025-03-31.basil', '2025-09-30.clover', null]) {
      const err = await rejection(stripe.invoices.list({ expand: ['total_count'] }, at(version)));
      expect([err.statusCode, err.rawType, err.param], label(version)).toEqual([400, 'invalid_request_error', 'expand']);
      expect(err.message, label(version)).toContain('property_forbidden');
      const sErr = await rejection(stripe.subscriptions.list({ expand: ['total_count'] }, at(version)));
      expect([sErr.statusCode, sErr.param], label(version)).toEqual([400, 'expand']);
    }
    // Without the expansion, no top-level list carries total_count; embedded lists always do.
    const plain = await stripe.subscriptions.list({}, at('2024-06-20'));
    expect(has(plain, 'total_count')).toBe(false);
    expect(plain.data[0].items.total_count).toBe(1);
  });

  it('gates billing_mode on subscription create at 2025-06-30.basil and renders it from there', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const err = await rejection(stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }], billing_mode: { type: 'flexible' } }, at('2025-05-28.basil')));
    expect([err.statusCode, err.code, err.param]).toEqual([400, 'parameter_unknown', 'billing_mode']);
    expect((await stripe.subscriptions.list({ status: 'all' })).data).toEqual([]);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }], billing_mode: { type: 'flexible' } }, at('2025-06-30.basil'));
    expect(sub.billing_mode.type).toBe('flexible');
    // Without the param, a basil request creates a classic subscription.
    const classic = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }, at('2025-06-30.basil'));
    expect(classic.billing_mode.type).toBe('classic');
  });

  it('answers a DELETE in the request version too', async () => {
    const t = await startServer();
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    const canceled = await stripe.subscriptions.cancel(sub.id, {}, at('2024-06-20'));
    expect(canceled.lastResponse.apiVersion).toBe('2024-06-20');
    expect(canceled).toMatchObject({ status: 'canceled', current_period_end: sub.items.data[0].current_period_end });
    expect(has(canceled, 'billing_mode')).toBe(false);
  });

  it('renders Checkout line items per version', async () => {
    const t = await startServer();
    const { stripe, price } = await setup(t);
    const session = await stripe.checkout.sessions.create(sessionParams(price));
    const legacy = await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] }, at('2024-06-20'));
    const [oldItem] = legacy.line_items.data;
    expect(oldItem).toMatchObject({ object: 'item', price: { id: price.id, object: 'price' }, quantity: 1 });
    expect(oldItem.price.recurring.aggregate_usage).toBeNull();
    // Dahlia adds adjustable_quantity and metadata to the item.
    expect(has(oldItem, 'metadata') || has(oldItem, 'adjustable_quantity')).toBe(false);
    const [item] = (await stripe.checkout.sessions.retrieve(session.id, { expand: ['line_items'] })).line_items.data;
    // Both are always present and nullable; null when the session set none.
    expect([item.metadata, item.adjustable_quantity]).toEqual([null, null]);
    expect(has(item.price.recurring, 'aggregate_usage')).toBe(false);
    // line_items is includable at every version: absent unless expanded.
    expect(has(await stripe.checkout.sessions.retrieve(session.id, {}, at('2024-06-20')), 'line_items')).toBe(false);
  });

  it('renders renewal previous_attributes per endpoint version: top-level periods vs item periods', async () => {
    const legacyHooks = await webhookReceiver();
    const currentHooks = await webhookReceiver();
    const t = await startServer({
      webhooks: [
        { url: legacyHooks.url, secret: 'whsec_legacy', apiVersion: '2024-06-20' },
        { url: currentHooks.url, secret: 'whsec_current' },
      ],
    });
    const { stripe, price, customer } = await setup(t);
    const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] });
    const [item] = sub.items.data;
    await t.account().advanceTime({ to: item.current_period_end + 2 * 3600 });
    await t.server.settle();
    const renewal = (hooks, secret) =>
      hooks.deliveries
        .map((d) => stripe.webhooks.constructEvent(d.rawBody, d.headers['stripe-signature'], secret))
        .filter((e) => e.type === 'customer.subscription.updated' && e.data.previous_attributes.latest_invoice !== undefined)[0];
    const old = renewal(legacyHooks, 'whsec_legacy');
    const cur = renewal(currentHooks, 'whsec_current');
    expect(old.id).toBe(cur.id);
    expect(old.data.previous_attributes).toMatchObject({ current_period_start: item.current_period_start, current_period_end: item.current_period_end, latest_invoice: sub.latest_invoice });
    expect(has(old.data.previous_attributes, 'items')).toBe(false);
    expect(old.data.object.current_period_start).toBe(item.current_period_end);
    expect(has(cur.data.previous_attributes, 'current_period_start')).toBe(false);
    expect(cur.data.previous_attributes.latest_invoice).toBe(sub.latest_invoice);
    expect(cur.data.previous_attributes.items.data[0]).toMatchObject({ current_period_start: item.current_period_start, current_period_end: item.current_period_end });
    expect(cur.data.object.items.data[0].current_period_start).toBe(item.current_period_end);
  });
});
