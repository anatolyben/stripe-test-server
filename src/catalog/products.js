/**
 * Products (docs.stripe.com/api/products).
 *
 * Routes: POST/GET /v1/products, GET/POST/DELETE /v1/products/:id.
 * Internal object: the 2026-08-26.dahlia wire shape (the same in every supported version) with
 * `default_price` as an ID. `type` is always present ('service' unless the legacy `type=good` was
 * sent) because the SDK types it.
 * Events: product.created, product.updated (previous_attributes), product.deleted (the product as
 * it was). Only products without prices can be deleted, so a deleted product leaves the store.
 */
import { emitEvent } from '../core/events.js';
import { invalidParam, invalidRequest, parametersExclusive, resourceMissing } from '../core/errors.js';
import { paginate, matchesRange } from '../core/list.js';
import { raw, render } from '../core/render.js';
import { applyMetadata, unsetToNull } from '../core/util.js';
import { insertPrice, preparePrice } from './prices.js';
import { nestParam } from './shared.js';

/** Documented limits (docs.stripe.com/api/products/create). */
const MAX_IMAGES = 8;
const MAX_MARKETING_FEATURES = 15;
const MAX_FEATURE_NAME_LENGTH = 80;

/**
 * The live product `id`, or resource_missing (404 for param 'id', else 400 with `param`).
 * @returns {object} internal product
 */
export function requireProduct(account, id, { param = 'product' } = {}) {
  return account.store.require('product', id, { param });
}

/**
 * Checks the rules of product fields that the parameter schema cannot express (counts, the letter
 * in a statement descriptor, fields reserved for `type=service`). Changes nothing.
 * `prefix` nests error params, e.g. 'product_data'.
 */
export function validateProductParams(params, { prefix, type = 'service' } = {}) {
  const p = (name) => nestParam(prefix, name);
  if (Array.isArray(params.images) && params.images.length > MAX_IMAGES) {
    throw invalidParam(p('images'), `Invalid array: images can have at most ${MAX_IMAGES} elements.`);
  }
  if (Array.isArray(params.marketing_features)) {
    if (params.marketing_features.length > MAX_MARKETING_FEATURES) {
      throw invalidParam(p('marketing_features'), `Invalid array: marketing_features can have at most ${MAX_MARKETING_FEATURES} elements.`);
    }
    params.marketing_features.forEach((feature, i) => {
      if (feature.name.length > MAX_FEATURE_NAME_LENGTH) {
        throw invalidParam(p(`marketing_features[${i}][name]`), `A marketing feature name can be up to ${MAX_FEATURE_NAME_LENGTH} characters long.`);
      }
    });
  }
  if (params.statement_descriptor !== undefined) {
    if (!/[A-Za-z]/.test(params.statement_descriptor)) {
      throw invalidParam(p('statement_descriptor'), 'The statement descriptor must contain at least one letter.');
    }
    if (type !== 'service') throw invalidParam(p('statement_descriptor'), 'statement_descriptor may only be set if type=service.');
  }
  if (params.unit_label !== undefined && params.unit_label !== '' && type !== 'service') {
    throw invalidParam(p('unit_label'), 'unit_label may only be set if type=service.');
  }
}

function normalizeDimensions(sent) {
  if (sent === undefined || sent === '' || sent === null) return null;
  return { height: sent.height, length: sent.length, weight: sent.weight, width: sent.width };
}

function checkCustomId(account, id, param) {
  if (account.store.find(id)) {
    throw invalidRequest(`A product with the ID '${id}' already exists.`, { param, code: 'resource_already_exists' });
  }
}

/**
 * Creates a product from validated POST /v1/products params (also used for `product_data` in
 * prices and Checkout `price_data`). Emits product.created, then price.created for
 * `default_price_data`. `version` is the causing request's API version (price rules depend on
 * it); `paramPrefix` nests error params ('line_items[0][price_data][product_data]').
 * @returns {object} internal product
 */
export function createProduct(account, params = {}, { request, version, paramPrefix } = {}) {
  const type = params.type ?? 'service';
  validateProductParams(params, { prefix: paramPrefix, type });
  if (params.id !== undefined) checkCustomId(account, params.id, nestParam(paramPrefix, 'id'));
  const priceSpec =
    params.default_price_data === undefined
      ? null
      : preparePrice(account, params.default_price_data, {
          version,
          paramPrefix: nestParam(paramPrefix, 'default_price_data'),
          productPending: true,
        });
  const now = account.time.now();
  const product = {
    id: params.id ?? account.mintId('prod'),
    object: 'product',
    active: params.active ?? true,
    created: now,
    default_price: null,
    description: params.description ?? null,
    images: params.images ? [...params.images] : [],
    livemode: false,
    marketing_features: (params.marketing_features ?? []).map((f) => ({ name: f.name })),
    metadata: applyMetadata({}, params.metadata),
    name: params.name,
    package_dimensions: normalizeDimensions(params.package_dimensions),
    shippable: params.shippable ?? null,
    statement_descriptor: params.statement_descriptor ?? null,
    tax_code: params.tax_code ?? null,
    type,
    unit_label: params.unit_label ?? null,
    updated: now,
    url: params.url ?? null,
  };
  account.store.insert(product);
  const price = priceSpec ? insertPrice(account, priceSpec, { product: product.id }) : null;
  if (price) product.default_price = price.id;
  emitEvent(account, 'product.created', product, { request });
  if (price) emitEvent(account, 'price.created', price, { request });
  return product;
}

/** The price for `default_price`: it must exist and belong to this product. */
function requireDefaultPrice(account, product, id) {
  const price = account.store.get('price', id);
  if (!price) throw resourceMissing('price', id, { param: 'default_price' });
  if (price.product !== product.id) {
    throw invalidRequest(`The price ${id} belongs to another product; the default price must be a price of ${product.id}.`, {
      param: 'default_price',
    });
  }
  return price;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Updates a product from validated POST /v1/products/:id params. Parameters not sent stay
 * unchanged; `''` clears the clearable ones. When anything visible changed, `updated` moves to
 * now and product.updated is emitted with previous_attributes.
 */
export function updateProduct(account, product, params = {}, { request } = {}) {
  validateProductParams(params, { type: product.type });
  const draft = structuredClone(product);
  if (params.active !== undefined) draft.active = params.active;
  if (params.name !== undefined) draft.name = params.name;
  if (params.description !== undefined) draft.description = unsetToNull(params.description);
  if (params.images !== undefined) draft.images = params.images === '' ? [] : [...params.images];
  if (params.marketing_features !== undefined) {
    draft.marketing_features = params.marketing_features === '' ? [] : params.marketing_features.map((f) => ({ name: f.name }));
  }
  draft.metadata = applyMetadata(draft.metadata, params.metadata);
  if (params.package_dimensions !== undefined) draft.package_dimensions = normalizeDimensions(params.package_dimensions);
  if (params.shippable !== undefined) draft.shippable = params.shippable;
  if (params.statement_descriptor !== undefined) draft.statement_descriptor = params.statement_descriptor;
  if (params.tax_code !== undefined) draft.tax_code = unsetToNull(params.tax_code);
  if (params.unit_label !== undefined) draft.unit_label = unsetToNull(params.unit_label);
  if (params.url !== undefined) draft.url = unsetToNull(params.url);
  if (params.default_price !== undefined) draft.default_price = requireDefaultPrice(account, product, params.default_price).id;

  const version = account.settings.apiVersion;
  if (sameJson(render(account, product, { version, forEvent: true }), render(account, draft, { version, forEvent: true }))) {
    return product;
  }
  draft.updated = account.time.now();
  const previous = structuredClone(product);
  Object.assign(product, draft);
  emitEvent(account, 'product.updated', product, { previous, request });
  return product;
}

/**
 * Deletes a product that has no prices ("You can only delete products that have no prices
 * associated with them"): emits product.deleted and removes it. Returns the deleted stub.
 */
export function deleteProduct(account, product, { request } = {}) {
  if (account.store.list('price', (p) => p.product === product.id).length) {
    throw invalidRequest(
      `The product ${product.id} cannot be deleted because it has prices. Archive it instead by setting active to false.`,
    );
  }
  emitEvent(account, 'product.deleted', product, { request });
  account.store.remove('product', product.id);
  return { id: product.id, object: 'product', deleted: true };
}

/** The wire form of a product (the API reference example's order, plus `type`). */
export function renderProduct(p) {
  return {
    id: p.id,
    object: 'product',
    active: p.active,
    created: p.created,
    default_price: p.default_price,
    description: p.description,
    images: [...p.images],
    marketing_features: p.marketing_features.map((f) => ({ name: f.name })),
    livemode: false,
    metadata: { ...p.metadata },
    name: p.name,
    package_dimensions: p.package_dimensions ? { ...p.package_dimensions } : null,
    shippable: p.shippable,
    statement_descriptor: p.statement_descriptor,
    tax_code: p.tax_code,
    type: p.type,
    unit_label: p.unit_label,
    updated: p.updated,
    url: p.url,
  };
}

export function install(app) {
  app.object('product', { render: renderProduct, expandable: ['default_price', 'tax_code'] });

  app.route('POST', '/v1/products', (ctx) => createProduct(ctx.account, ctx.params, { version: ctx.version }));

  app.route('GET', '/v1/products/:id', (ctx) => requireProduct(ctx.account, ctx.pathParams.id, { param: 'id' }));

  app.route('POST', '/v1/products/:id', (ctx) =>
    updateProduct(ctx.account, requireProduct(ctx.account, ctx.pathParams.id, { param: 'id' }), ctx.params),
  );

  app.route('DELETE', '/v1/products/:id', (ctx) =>
    raw(deleteProduct(ctx.account, requireProduct(ctx.account, ctx.pathParams.id, { param: 'id' }))),
  );

  app.route('GET', '/v1/products', (ctx) => {
    const { params, account } = ctx;
    if (params.ids !== undefined) {
      for (const cursor of ['starting_after', 'ending_before']) {
        if (params[cursor] !== undefined) throw parametersExclusive(['ids', cursor], { param: 'ids' });
      }
    }
    const products = account.store.list('product', (p) => {
      if (params.active !== undefined && p.active !== params.active) return false;
      if (params.ids !== undefined && !params.ids.includes(p.id)) return false;
      if (params.shippable !== undefined && p.shippable !== params.shippable) return false;
      if (params.type !== undefined && p.type !== params.type) return false;
      if (params.url !== undefined && p.url !== params.url) return false;
      return matchesRange(p.created, params.created);
    });
    return paginate(products, params, { url: '/v1/products', noun: 'product', find: (id) => account.store.get('product', id) });
  });
}
