/**
 * Catalog through the real stripe SDK: products and prices (create, retrieve, update, list,
 * delete), lookup keys, parameter rules, version shapes, expand and events.
 */
import { describe, expect, it } from 'vitest';
import { rejection, startServer } from './helpers.js';
import { createPrice, requirePrice } from '../src/catalog/prices.js';

/** Events of the account, oldest first, as [type, object id]. */
async function eventLog(stripe) {
  const events = await stripe.events.list({ limit: 100 });
  return events.data.reverse().map((e) => [e.type, e.data.object.id]);
}

const accountOf = (t) => t.server.context.account(t.key);

describe('products', () => {
  it('creates a product with the documented defaults, retrieves it and rejects a taken custom ID', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const product = await stripe.products.create({ name: 'Pro', metadata: { tier: 'pro' }, images: ['https://example.com/a.png'] });
    expect(product.id).toMatch(/^prod_[A-Za-z0-9]{24}$/);
    expect(product).toEqual({
      id: product.id,
      object: 'product',
      active: true,
      created: product.created,
      default_price: null,
      description: null,
      images: ['https://example.com/a.png'],
      marketing_features: [],
      livemode: false,
      metadata: { tier: 'pro' },
      name: 'Pro',
      package_dimensions: null,
      shippable: null,
      statement_descriptor: null,
      tax_code: null,
      type: 'service',
      unit_label: null,
      updated: product.created,
      url: null,
    });
    expect(await stripe.products.retrieve(product.id)).toMatchObject({ id: product.id, name: 'Pro' });

    const custom = await stripe.products.create({ id: 'gold', name: 'Gold' });
    expect(custom.id).toBe('gold');
    const taken = await rejection(stripe.products.create({ id: 'gold', name: 'Gold again' }));
    expect([taken.statusCode, taken.code, taken.param]).toEqual([400, 'resource_already_exists', 'id']);
    const missing = await rejection(stripe.products.retrieve('prod_missing'));
    expect([missing.statusCode, missing.code, missing.param]).toEqual([404, 'resource_missing', 'id']);
  });

  it('validates what the schema cannot: name, counts, statement descriptor letters', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const noName = await rejection(stripe.products.create({}));
    expect([noName.code, noName.param]).toEqual(['parameter_missing', 'name']);
    const images = await rejection(stripe.products.create({ name: 'x', images: Array.from({ length: 9 }, (_, i) => `https://e.com/${i}.png`) }));
    expect([images.statusCode, images.param]).toEqual([400, 'images']);
    const descriptor = await rejection(stripe.products.create({ name: 'x', statement_descriptor: '123 456' }));
    expect(descriptor.param).toBe('statement_descriptor');
    expect((await stripe.products.list()).data).toEqual([]);
  });

  it('updates only what was sent, clears with "", and announces only visible changes', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const product = await stripe.products.create({ name: 'Pro', description: 'Old', url: 'https://example.com', metadata: { a: '1', b: '2' } });
    await t.account().advanceTime({ seconds: 60 });
    const updated = await stripe.products.update(product.id, { name: 'Pro+', description: '', metadata: { a: '' } });
    expect(updated).toMatchObject({ name: 'Pro+', description: null, url: 'https://example.com', metadata: { b: '2' } });
    expect(updated.updated).toBeGreaterThanOrEqual(product.updated + 60);
    const again = await stripe.products.update(product.id, { name: 'Pro+' });
    expect(again.updated).toBe(updated.updated);
    const events = (await stripe.events.list({ type: 'product.updated' })).data;
    expect(events).toHaveLength(1);
    expect(events[0].data.previous_attributes).toEqual({
      description: 'Old',
      metadata: { a: '1' },
      name: 'Pro',
      updated: product.updated,
    });
    const emptyName = await rejection(stripe.products.update(product.id, { name: '' }));
    expect([emptyName.code, emptyName.param]).toEqual(['parameter_invalid_empty', 'name']);
  });

  it('creates the default price from default_price_data and only accepts own prices as default_price', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const product = await stripe.products.create({ name: 'Pro', default_price_data: { currency: 'usd', unit_amount: 1500, recurring: { interval: 'month' } } });
    expect(product.default_price).toMatch(/^price_/);
    const price = await stripe.prices.retrieve(product.default_price);
    expect(price).toMatchObject({ product: product.id, unit_amount: 1500, type: 'recurring', recurring: { interval: 'month', interval_count: 1 } });
    expect(await eventLog(stripe)).toEqual([
      ['product.created', product.id],
      ['price.created', price.id],
    ]);
    const [created] = (await stripe.events.list({ type: 'product.created' })).data;
    expect(created.data.object.default_price).toBe(price.id);

    const badData = await rejection(stripe.products.create({ name: 'x', default_price_data: { currency: 'usd' } }));
    expect([badData.code, badData.param]).toEqual(['parameter_missing', 'default_price_data[unit_amount]']);

    const other = await stripe.products.create({ name: 'Other' });
    const otherPrice = await stripe.prices.create({ product: other.id, currency: 'usd', unit_amount: 100 });
    const foreign = await rejection(stripe.products.update(product.id, { default_price: otherPrice.id }));
    expect([foreign.statusCode, foreign.param]).toEqual([400, 'default_price']);
    const unknown = await rejection(stripe.products.update(product.id, { default_price: 'price_missing' }));
    expect([unknown.code, unknown.param]).toEqual(['resource_missing', 'default_price']);
    const second = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 3000 });
    expect((await stripe.products.update(product.id, { default_price: second.id })).default_price).toBe(second.id);
  });

  it('deletes only products without prices, emitting product.deleted, then answers 404', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const withPrice = await stripe.products.create({ name: 'Priced' });
    await stripe.prices.create({ product: withPrice.id, currency: 'usd', unit_amount: 100, active: false });
    const blocked = await rejection(stripe.products.del(withPrice.id));
    expect([blocked.statusCode, blocked.type]).toEqual([400, 'StripeInvalidRequestError']);
    expect((await stripe.products.retrieve(withPrice.id)).id).toBe(withPrice.id);

    const bare = await stripe.products.create({ name: 'Bare' });
    const deleted = await stripe.products.del(bare.id);
    expect(deleted).toEqual({ id: bare.id, object: 'product', deleted: true });
    const [event] = (await stripe.events.list({ type: 'product.deleted' })).data;
    expect(event.data.object).toMatchObject({ id: bare.id, object: 'product', name: 'Bare' });
    expect('deleted' in event.data.object).toBe(false);
    expect((await rejection(stripe.products.retrieve(bare.id))).statusCode).toBe(404);
    expect((await rejection(stripe.products.del(bare.id))).statusCode).toBe(404);
  });

  it('lists newest first with active, ids and created filters', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const a = await stripe.products.create({ name: 'A' });
    const b = await stripe.products.create({ name: 'B', active: false });
    const c = await stripe.products.create({ name: 'C' });
    expect((await stripe.products.list()).data.map((p) => p.id)).toEqual([c.id, b.id, a.id]);
    expect((await stripe.products.list({ active: true })).data.map((p) => p.id)).toEqual([c.id, a.id]);
    expect((await stripe.products.list({ ids: [a.id, b.id] })).data.map((p) => p.id)).toEqual([b.id, a.id]);
    expect((await stripe.products.list({ created: { gt: a.created + 3600 } })).data).toEqual([]);
    const exclusive = await rejection(stripe.products.list({ ids: [a.id], starting_after: c.id }));
    expect(exclusive.code).toBe('parameters_exclusive');
  });
});

describe('prices', () => {
  it('creates recurring and one-time prices in the documented shape (decimal strings, recurring keys)', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const product = await stripe.products.create({ name: 'Pro' });
    const monthly = await stripe.prices.create({
      product: product.id,
      currency: 'USD',
      unit_amount: 2000,
      recurring: { interval: 'month' },
      lookup_key: 'pro_monthly',
      nickname: 'Monthly',
      metadata: { plan: 'pro' },
    });
    expect(monthly.id).toMatch(/^price_[A-Za-z0-9]{24}$/);
    expect(String(monthly.unit_amount_decimal)).toBe('2000');
    const raw = await t.request('GET', `/v1/prices/${monthly.id}`);
    expect(raw.json).toEqual({
      id: monthly.id,
      object: 'price',
      active: true,
      billing_scheme: 'per_unit',
      created: monthly.created,
      currency: 'usd',
      custom_unit_amount: null,
      livemode: false,
      lookup_key: 'pro_monthly',
      metadata: { plan: 'pro' },
      nickname: 'Monthly',
      product: product.id,
      recurring: { interval: 'month', interval_count: 1, meter: null, trial_period_days: null, usage_type: 'licensed' },
      tax_behavior: 'unspecified',
      tiers_mode: null,
      transform_quantity: null,
      type: 'recurring',
      unit_amount: 2000,
      unit_amount_decimal: '2000',
    });
    const once = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 500 });
    expect([once.type, once.recurring]).toEqual(['one_time', null]);
    expect(await eventLog(stripe)).toEqual([
      ['product.created', product.id],
      ['price.created', monthly.id],
      ['price.created', once.id],
    ]);
  });

  it('creates the product from product_data and normalizes decimal amounts', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const fractional = await stripe.prices.create({ currency: 'eur', unit_amount_decimal: '01050.500', product_data: { name: 'Seats', unit_label: 'seat' } });
    expect([fractional.unit_amount, String(fractional.unit_amount_decimal)]).toEqual([null, '1050.5']);
    const product = await stripe.products.retrieve(fractional.product);
    expect(product).toMatchObject({ name: 'Seats', unit_label: 'seat', default_price: null });
    const whole = await stripe.prices.create({ currency: 'eur', unit_amount_decimal: '1200.00', product: product.id });
    expect([whole.unit_amount, String(whole.unit_amount_decimal)]).toEqual([1200, '1200']);
    expect((await eventLog(stripe)).map(([type]) => type)).toEqual(['product.created', 'price.created', 'price.created']);
  });

  it('enforces the documented either-or and amount rules', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { id: product } = await stripe.products.create({ name: 'Pro' });
    const cases = [
      [{ currency: 'usd', unit_amount: 100 }, 'parameter_missing', 'product'],
      [{ currency: 'usd', unit_amount: 100, product, product_data: { name: 'x' } }, 'parameters_exclusive', 'product_data'],
      [{ currency: 'usd', product }, 'parameter_missing', 'unit_amount'],
      [{ currency: 'usd', product, unit_amount: 100, unit_amount_decimal: '100' }, 'parameters_exclusive', 'unit_amount_decimal'],
      [{ currency: 'usd', product, unit_amount: -5 }, 'parameter_invalid_integer', 'unit_amount'],
      [{ unit_amount: 100, product }, 'parameter_missing', 'currency'],
      [{ currency: 'usd', product, unit_amount: 100, recurring: { interval: 'month', interval_count: 37 } }, undefined, 'recurring[interval_count]'],
      [{ currency: 'usd', product, unit_amount: 100, recurring: { interval: 'month', usage_type: 'metered' } }, 'parameter_missing', 'recurring[meter]'],
      [{ currency: 'usd', product, billing_scheme: 'tiered', tiers_mode: 'graduated' }, 'parameter_missing', 'tiers'],
      [{ currency: 'usd', product, unit_amount: 100, tiers_mode: 'volume' }, undefined, 'tiers_mode'],
      [{ currency: 'xyz', product, unit_amount: 100 }, undefined, 'currency'],
    ];
    for (const [params, code, param] of cases) {
      const err = await rejection(stripe.prices.create(params));
      expect([err.statusCode, err.code, err.param], JSON.stringify(params)).toEqual([400, code, param]);
    }
    const unknownProduct = await rejection(stripe.prices.create({ currency: 'usd', unit_amount: 100, product: 'prod_missing' }));
    expect([unknownProduct.statusCode, unknownProduct.code, unknownProduct.param]).toEqual([400, 'resource_missing', 'product']);
    expect((await stripe.prices.list({ active: true })).data).toEqual([]);
    expect((await stripe.prices.list({ active: false })).data).toEqual([]);
  });

  it('creates tiered prices whose tiers are returned only when expanded', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { id: product } = await stripe.products.create({ name: 'Seats' });
    const params = {
      product,
      currency: 'usd',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      recurring: { interval: 'month' },
      tiers: [
        { up_to: 5, unit_amount: 1000 },
        { up_to: 'inf', unit_amount_decimal: '750.5', flat_amount: 100 },
      ],
    };
    const price = await stripe.prices.create(params);
    expect([price.unit_amount, price.unit_amount_decimal, price.tiers_mode, 'tiers' in price]).toEqual([null, null, 'graduated', false]);
    const expanded = await t.request('GET', `/v1/prices/${price.id}?expand[]=tiers`);
    expect(expanded.json.tiers).toEqual([
      { flat_amount: null, flat_amount_decimal: null, unit_amount: 1000, unit_amount_decimal: '1000', up_to: 5 },
      { flat_amount: 100, flat_amount_decimal: '100', unit_amount: null, unit_amount_decimal: '750.5', up_to: null },
    ]);
    const openEnded = await rejection(stripe.prices.create({ ...params, tiers: [{ up_to: 5, unit_amount: 1000 }] }));
    expect(openEnded.param).toBe('tiers[0][up_to]');
  });

  it('keeps lookup keys unique and moves them with transfer_lookup_key', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { id: product } = await stripe.products.create({ name: 'Pro' });
    const first = await stripe.prices.create({ product, currency: 'usd', unit_amount: 1000, lookup_key: 'pro' });
    const taken = await rejection(stripe.prices.create({ product, currency: 'usd', unit_amount: 1200, lookup_key: 'pro' }));
    expect([taken.statusCode, taken.param]).toEqual([400, 'lookup_key']);
    const second = await stripe.prices.create({ product, currency: 'usd', unit_amount: 1200, lookup_key: 'pro', transfer_lookup_key: true });
    expect(second.lookup_key).toBe('pro');
    expect((await stripe.prices.retrieve(first.id)).lookup_key).toBeNull();
    const log = await eventLog(stripe);
    expect(log.slice(-2)).toEqual([
      ['price.updated', first.id],
      ['price.created', second.id],
    ]);
    const [moved] = (await stripe.events.list({ type: 'price.updated' })).data;
    expect(moved.data.previous_attributes).toEqual({ lookup_key: 'pro' });
    expect((await stripe.prices.list({ lookup_keys: ['pro'] })).data.map((p) => p.id)).toEqual([second.id]);

    const back = await rejection(stripe.prices.update(first.id, { lookup_key: 'pro' }));
    expect(back.param).toBe('lookup_key');
    await stripe.prices.update(first.id, { lookup_key: 'pro', transfer_lookup_key: true });
    expect([(await stripe.prices.retrieve(first.id)).lookup_key, (await stripe.prices.retrieve(second.id)).lookup_key]).toEqual(['pro', null]);
  });

  it('updates only the mutable fields and keeps tax_behavior once it is set', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { id: product } = await stripe.products.create({ name: 'Pro' });
    const price = await stripe.prices.create({ product, currency: 'usd', unit_amount: 1000, metadata: { a: '1' } });
    const updated = await stripe.prices.update(price.id, { nickname: 'Basic', metadata: { b: '2' }, tax_behavior: 'exclusive' });
    expect(updated).toMatchObject({ nickname: 'Basic', metadata: { a: '1', b: '2' }, tax_behavior: 'exclusive' });
    const [event] = (await stripe.events.list({ type: 'price.updated' })).data;
    expect(event.data.previous_attributes).toEqual({ metadata: { b: null }, nickname: null, tax_behavior: 'unspecified' });
    const amount = await rejection(stripe.prices.update(price.id, { unit_amount: 2000 }));
    expect([amount.code, amount.param]).toEqual(['parameter_unknown', 'unit_amount']);
    const tax = await rejection(stripe.prices.update(price.id, { tax_behavior: 'inclusive' }));
    expect([tax.statusCode, tax.param]).toEqual([400, 'tax_behavior']);
    expect((await stripe.prices.update(price.id, { tax_behavior: 'exclusive' })).tax_behavior).toBe('exclusive');
  });

  it('lists active prices by default, archived ones with active=false, never inline prices', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const pro = await stripe.products.create({ name: 'Pro' });
    const other = await stripe.products.create({ name: 'Other' });
    const monthly = await stripe.prices.create({ product: pro.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' }, lookup_key: 'm' });
    const yearly = await stripe.prices.create({ product: pro.id, currency: 'usd', unit_amount: 10000, recurring: { interval: 'year' }, lookup_key: 'y' });
    const once = await stripe.prices.create({ product: other.id, currency: 'eur', unit_amount: 500 });
    await stripe.prices.update(yearly.id, { active: false });
    const account = accountOf(t);
    await account.run(() => createPrice(account, { product: pro.id, currency: 'usd', unit_amount: 42, recurring: { interval: 'month' } }, { inline: true }));

    const ids = async (params) => (await stripe.prices.list(params)).data.map((p) => p.id);
    expect(await ids()).toEqual([once.id, monthly.id]);
    expect(await ids({ active: false })).toEqual([yearly.id]);
    expect(await ids({ product: pro.id })).toEqual([monthly.id]);
    expect(await ids({ type: 'one_time' })).toEqual([once.id]);
    expect(await ids({ currency: 'usd' })).toEqual([monthly.id]);
    expect(await ids({ recurring: { interval: 'month' } })).toEqual([monthly.id]);
    expect(await ids({ lookup_keys: ['m', 'y'] })).toEqual([monthly.id]);
    const tooMany = await rejection(stripe.prices.list({ lookup_keys: Array.from({ length: 11 }, (_, i) => `k${i}`) }));
    expect([tooMany.statusCode, tooMany.param]).toEqual([400, 'lookup_keys']);
    const expanded = await stripe.prices.list({ lookup_keys: ['m'], expand: ['data.product'] });
    expect(expanded.data[0].product).toMatchObject({ id: pro.id, object: 'product', name: 'Pro' });
    expect((await stripe.events.list({ type: 'price.created' })).data).toHaveLength(3);
  });

  it('expands currency_options with the own currency first', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const price = await stripe.prices.create({
      product_data: { name: 'Global' },
      currency: 'usd',
      unit_amount: 1000,
      currency_options: { eur: { unit_amount: 900 }, gbp: { unit_amount_decimal: '800.5', tax_behavior: 'inclusive' } },
    });
    expect(price.currency_options).toBeUndefined();
    const { json } = await t.request('GET', `/v1/prices/${price.id}?expand[0]=currency_options`);
    expect(json.currency_options).toEqual({
      usd: { custom_unit_amount: null, tax_behavior: 'unspecified', unit_amount: 1000, unit_amount_decimal: '1000' },
      eur: { custom_unit_amount: null, tax_behavior: 'unspecified', unit_amount: 900, unit_amount_decimal: '900' },
      gbp: { custom_unit_amount: null, tax_behavior: 'inclusive', unit_amount: null, unit_amount_decimal: '800.5' },
    });
    const own = await rejection(stripe.prices.create({ product_data: { name: 'x' }, currency: 'usd', unit_amount: 1, currency_options: { usd: { unit_amount: 2 } } }));
    expect(own.param).toBe('currency_options[usd]');
  });

  it('renders the 2024-06-20 shape and accepts legacy metered prices on that version', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const { id: product } = await stripe.products.create({ name: 'Pro' });
    const licensed = await stripe.prices.create({ product, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } }, { apiVersion: '2024-06-20' });
    expect(licensed.recurring).toEqual({ aggregate_usage: null, interval: 'month', interval_count: 1, meter: null, trial_period_days: null, usage_type: 'licensed' });
    const metered = await stripe.prices.create(
      { product, currency: 'usd', unit_amount: 5, recurring: { interval: 'month', usage_type: 'metered' } },
      { apiVersion: '2024-06-20' },
    );
    expect(metered.recurring.aggregate_usage).toBe('sum');
    expect('aggregate_usage' in (await stripe.prices.retrieve(metered.id)).recurring).toBe(false);
    const legacyParam = await rejection(
      stripe.prices.create({ product, currency: 'usd', unit_amount: 5, recurring: { interval: 'month', usage_type: 'metered', meter: 'mtr_1', aggregate_usage: 'max' } }),
    );
    expect([legacyParam.code, legacyParam.param]).toEqual(['parameter_unknown', 'recurring[aggregate_usage]']);
  });

  it('replays price creation for a reused idempotency key', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const params = { product_data: { name: 'Once' }, currency: 'usd', unit_amount: 700 };
    const a = await stripe.prices.create(params, { idempotencyKey: 'price-1' });
    const b = await stripe.prices.create(params, { idempotencyKey: 'price-1' });
    expect(b.id).toBe(a.id);
    expect(b.lastResponse.headers['idempotent-replayed']).toBe('true');
    expect((await stripe.products.list()).data).toHaveLength(1);
  });
});

describe('requirePrice', () => {
  it('rejects archived prices and prices of archived products when an active price is needed', async () => {
    const t = await startServer();
    const stripe = t.stripe();
    const product = await stripe.products.create({ name: 'Pro' });
    const price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } });
    const account = accountOf(t);
    const check = (opts) =>
      account.run(() => {
        try {
          return requirePrice(account, price.id, opts).id;
        } catch (err) {
          return [err.status, err.param];
        }
      });
    expect(await check({ param: 'items[0][price]', active: true })).toBe(price.id);
    await stripe.products.update(product.id, { active: false });
    expect(await check({ param: 'items[0][price]', active: true })).toEqual([400, 'items[0][price]']);
    await stripe.products.update(product.id, { active: true });
    await stripe.prices.update(price.id, { active: false });
    expect(await check({ param: 'items[0][price]', active: true })).toEqual([400, 'items[0][price]']);
    expect(await check({ param: 'items[0][price]' })).toBe(price.id);
    const missing = await account.run(() => {
      try {
        return requirePrice(account, 'price_missing', { param: 'line_items[0][price]' });
      } catch (err) {
        return [err.status, err.code, err.param];
      }
    });
    expect(missing).toEqual([400, 'resource_missing', 'line_items[0][price]']);
  });
});
