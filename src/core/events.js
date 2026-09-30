/**
 * The event bus (docs.stripe.com/api/events).
 *
 * emitEvent() stores an immutable event holding a deep copy of the internal object (and, for
 * *.updated events, of the object before the change). Payloads are rendered per API version on
 * demand and cached: at emission for the account default and every known endpoint version, later
 * for any other version. previous_attributes is the diff of the two renderings in that version.
 * Delivery is not done here: the 'event.emitted' hook hands each event to the webhook module.
 */
import { render, renderObject, renderContext } from './render.js';
import { paginate, matchesRange } from './list.js';
import { invalidRequest, parametersExclusive, resourceMissing } from './errors.js';

export class EventStore {
  constructor() {
    this.events = [];
    this.byId = new Map();
    this.seq = 0;
  }

  add(event) {
    event._seq = ++this.seq;
    this.events.push(event);
    this.byId.set(event.id, event);
    return event;
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  /** All events, oldest first. */
  all() {
    return [...this.events];
  }

  clear() {
    this.events = [];
    this.byId.clear();
    this.seq = 0;
  }
}

/**
 * Records an event.
 * @param {Account} account
 * @param {string} type e.g. 'customer.updated'
 * @param {object} object the internal object after the change (deep-copied now)
 * @param {object} [opts]
 * @param {object} [opts.previous] the internal object before the change (deep copy): for
 *   *.updated events; previous_attributes is computed from it per API version
 * @param {object} [opts.previousAttributes] explicit wire-level previous_attributes (overrides
 *   `previous`; used verbatim for every version)
 * @param {{id, idempotency_key}|null} [opts.request] defaults to the request being handled
 *   (null during time processing and on hosted pages: an automatic event)
 * @param {string|null} [opts.domain] time domain for `created` (defaults to the object's)
 * @returns the event record
 */
export function emitEvent(account, type, object, opts = {}) {
  const domain = opts.domain !== undefined ? opts.domain : account.time.domainOf(object);
  const req = opts.request !== undefined ? opts.request : account.currentRequest;
  if (account._heldEvents) {
    account._heldEvents.push({
      type,
      object: structuredClone(object),
      opts: { ...opts, domain, request: req, previous: opts.previous ? structuredClone(opts.previous) : undefined },
    });
    return null;
  }
  const event = {
    id: account.mintId('evt'),
    object: 'event',
    type,
    created: account.time.now(domain),
    livemode: false,
    request: { id: req?.id ?? null, idempotency_key: req?.idempotency_key ?? null },
    apiVersion: account.settings.apiVersion,
    pendingWebhooks: 0,
    data: {
      object: structuredClone(object),
      previous: opts.previous ? structuredClone(opts.previous) : null,
      previousAttributes: opts.previousAttributes ? structuredClone(opts.previousAttributes) : null,
    },
    _renders: new Map(),
  };
  account.events.add(event);
  for (const version of new Set([event.apiVersion, ...account.server.endpointVersions(account)])) {
    renderEventData(account, event, version);
  }
  account.server.registry.runHooks('event.emitted', account, event);
  return event;
}

/**
 * Runs `fn` with emission held: the events it emits are snapshotted (object, request, domain) but
 * not recorded or delivered, so the caller can emit them later at the point in its sequence where
 * Stripe sends them. If `fn` throws, the held events are emitted at once and the error rethrown.
 * @returns {{result: *, held: object[]}}  emit `held` (or a part of it) with emitHeld()
 */
export function holdEvents(account, fn) {
  const outer = account._heldEvents;
  const held = [];
  account._heldEvents = held;
  try {
    const result = fn();
    return { result, held };
  } catch (err) {
    account._heldEvents = outer;
    emitHeld(account, held);
    throw err;
  } finally {
    account._heldEvents = outer;
  }
}

/** Emits events captured by holdEvents(), in order. */
export function emitHeld(account, held) {
  for (const h of held) emitEvent(account, h.type, h.object, h.opts);
}

/** {object, previous_attributes?} of an event in `version` (cached). */
export function renderEventData(account, event, version) {
  let cached = event._renders.get(version);
  if (cached) return cached;
  const ctx = renderContext(account, version, { forEvent: true });
  const object = renderObject(event.data.object, ctx);
  cached = { object };
  if (event.data.previousAttributes) {
    cached.previous_attributes = structuredClone(event.data.previousAttributes);
  } else if (event.data.previous) {
    cached.previous_attributes = diffPrevious(renderObject(event.data.previous, ctx), object);
  }
  event._renders.set(version, cached);
  return cached;
}

/** The wire form of an event, with `data` rendered in `version` (default: the event's version). */
export function renderEvent(account, event, version = event.apiVersion) {
  const data = renderEventData(account, event, version);
  return {
    id: event.id,
    object: 'event',
    api_version: version,
    created: event.created,
    data: structuredClone(data),
    livemode: false,
    pending_webhooks: event.pendingWebhooks,
    request: { ...event.request },
    type: event.type,
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isList = (v) => isPlainObject(v) && v.object === 'list' && Array.isArray(v.data);

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * previous_attributes: for each changed key the old value; nested hashes recurse to the
 * changed sub-keys; arrays are given whole; embedded lists as { data: old data } (+ total_count
 * when it changed). A key that did not exist before is reported as null.
 */
export function diffPrevious(prev, cur) {
  const out = {};
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  for (const key of keys) {
    const a = prev?.[key];
    const b = cur?.[key];
    if (deepEqual(a, b)) continue;
    if (isList(a) && isList(b)) {
      out[key] = { data: structuredClone(a.data) };
      if (a.total_count !== b.total_count && a.total_count !== undefined) out[key].total_count = a.total_count;
    } else if (isPlainObject(a) && isPlainObject(b) && !(a.id && a.object)) {
      out[key] = diffPrevious(a, b);
    } else {
      out[key] = a === undefined ? null : structuredClone(a);
    }
  }
  return out;
}

/**
 * Applies `mutate(obj)` and emits `eventType` (usually '<type>.updated') with the previous
 * snapshot when the rendered object changed. Returns true when something changed.
 */
export function updateWithEvent(account, obj, eventType, mutate, { request, domain } = {}) {
  const previous = structuredClone(obj);
  mutate(obj);
  const version = account.settings.apiVersion;
  const before = render(account, previous, { version, forEvent: true });
  const after = render(account, obj, { version, forEvent: true });
  if (deepEqual(before, after)) return false;
  if (eventType) emitEvent(account, eventType, obj, { previous, request, domain });
  return true;
}

// Events API ----------------------------------------------------------------------------------

function typeMatcher(pattern) {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (type) => re.test(type);
}

export function install(app) {
  app.object('event', {
    render: (event, ctx) => renderEvent(ctx.account, event, event.apiVersion),
  });

  app.route('GET', '/v1/events', (ctx) => {
    const { params, account } = ctx;
    if (params.type !== undefined && params.types !== undefined) throw parametersExclusive(['type', 'types'], { param: 'types' });
    if (params.types && params.types.length > 20) {
      throw invalidRequest('You may pass at most 20 types.', { param: 'types', validation: true });
    }
    const matchers = params.type ? [typeMatcher(params.type)] : (params.types || []).map(typeMatcher);
    const events = account.events.all().filter((e) => {
      if (matchers.length && !matchers.some((m) => m(e.type))) return false;
      if (!matchesRange(e.created, params.created)) return false;
      if (params.delivery_success === true && e.pendingWebhooks > 0) return false;
      if (params.delivery_success === false && e.pendingWebhooks === 0) return false;
      return true;
    });
    return paginate(events, params, { url: '/v1/events', noun: 'event', find: (id) => account.events.get(id) });
  });

  app.route('GET', '/v1/events/:id', (ctx) => {
    const event = ctx.account.events.get(ctx.pathParams.id);
    if (!event) throw resourceMissing('event', ctx.pathParams.id);
    return event;
  });
}
