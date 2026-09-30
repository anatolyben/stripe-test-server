/**
 * Response rendering: internal objects → wire JSON for a request's API version, plus the expand
 * engine (docs.stripe.com/expand).
 *
 * Serializers are registered per object type (registry.object). An object without a serializer is
 * rendered as a deep copy with every `_`-prefixed key removed.
 */
import { invalidRequest } from './errors.js';
import { versionInfo } from './versions.js';
import { ListResult } from './list.js';

const MAX_EXPAND_HOPS = 4;

/** A response body sent as-is (deleted stubs, control results): `return raw({...})`. */
export class RawResponse {
  constructor(body) {
    this.body = body;
  }
}
export const raw = (body) => new RawResponse(body);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isList = (v) => isPlainObject(v) && (v.object === 'list' || v.object === 'search_result') && Array.isArray(v.data);

/** Deep copy without private (`_`-prefixed) keys. */
export function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!k.startsWith('_')) out[k] = stripPrivate(v);
  return out;
}

/**
 * The serializer context passed to render functions and includable resolvers.
 * { account, version, family, atLeast(gate), forEvent, lookup(id), render(obj) }
 */
export function renderContext(account, version, { forEvent = false } = {}) {
  const ctx = {
    account,
    ...versionInfo(version),
    forEvent,
    lookup: (id) => account.store.find(id),
    render: (obj) => renderObject(obj, ctx),
  };
  return ctx;
}

/** Renders one internal object in minimal (unexpanded) form. */
export function renderObject(obj, ctx) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  const def = ctx.account.server.registry.objects.get(obj.object);
  return def?.render ? def.render(obj, ctx) : stripPrivate(obj);
}

/**
 * Renders a handler result (internal object, ListResult or raw()) for `version`, then applies
 * `expand` paths. forEvent renders the minimal form used in event payloads (no expansion).
 */
export function render(account, value, { version, expand = [], forEvent = false } = {}) {
  if (value instanceof RawResponse) return structuredClone(value.body);
  const ctx = renderContext(account, version, { forEvent });
  let json;
  if (value instanceof ListResult) {
    json = { object: 'list', data: value.data.map((o) => renderObject(o, ctx)), has_more: value.hasMore, url: value.url };
  } else {
    json = renderObject(value, ctx);
  }
  if (expand && expand.length && !forEvent) {
    applyExpand(json, expand, ctx, { listTotal: value instanceof ListResult ? value.total : undefined });
  }
  return json;
}

// Expand ------------------------------------------------------------------------------------------

/** 400 for a bad expand path: a validation error, raised before the handler runs and never saved. */
function cannotExpand(path, detail = '') {
  return invalidRequest(`This property cannot be expanded (${path})${detail}.`, { param: 'expand', validation: true });
}

/** 'list<customer>' → { list: true, item: 'customer' }; 'customer' → { type: 'customer', rel: '' }. */
function parseType(type) {
  const m = /^(?:list|search_result)<(.+)>$/.exec(type);
  return m ? { list: true, item: m[1] } : { type, rel: '' };
}

function linkAvailable(link, info) {
  if (!link) return true;
  if (link.since && !info.atLeast(link.since)) return false;
  if (link.until && info.atLeast(link.until)) return false;
  return true;
}

/** True when some expandable, includable or embedded path of `def` continues below `rel`. */
function hasDeclaredPrefix(def, rel, info) {
  const prefix = `${rel}.`;
  const ok = (p) => p.startsWith(prefix) && linkAvailable(def.links.get(p), info);
  for (const p of def.expandable) if (ok(p)) return true;
  for (const p of Object.keys(def.includable)) if (ok(p)) return true;
  for (const [p, link] of def.links) if (link.embedded && ok(p)) return true;
  return false;
}

/**
 * Checks `expand` paths against the response type of an endpoint (the route's `returns`) and the
 * object declarations, for `version`. Throws a validation 400 (param expand) for an unknown,
 * non-expandable or version-absent path, a path over four expandable hops (only expandable and
 * includable fields count, so Stripe's five-segment invoice paths fit), or total_count on a F2/F3
 * list. Never looks at data.
 */
export function checkExpand(registry, returns, paths, version) {
  if (!paths || !paths.length) return;
  const info = versionInfo(version);
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    if (typeof path !== 'string' || !path) throw cannotExpand(String(path));
    const segs = path.split('.');
    if (segs.some((s) => !s)) throw cannotExpand(path);
    checkPath(registry, parseType(returns), segs, 0, 0, path, info);
  }
}

function checkPath(registry, node, segs, i, hops, path, info) {
  if (i === segs.length) return;
  const seg = segs[i];
  const last = i === segs.length - 1;
  if (node.list) {
    if (seg === 'data' && !last) return checkPath(registry, parseType(node.item), segs, i + 1, hops, path, info);
    if (seg === 'total_count' && last) {
      if (info.family !== 'F1') throw cannotExpand(path, ': property_forbidden. total_count can no longer be expanded on lists');
      return undefined;
    }
    throw cannotExpand(path);
  }
  const def = registry.objects.get(node.type);
  if (!def) throw cannotExpand(path);
  const rel = node.rel ? `${node.rel}.${seg}` : seg;
  const link = def.links.get(rel);
  const available = linkAvailable(link, info);
  if (available && !link?.embedded && (def.expandable.has(rel) || Object.hasOwn(def.includable, rel))) {
    if (hops + 1 > MAX_EXPAND_HOPS) throw cannotExpand(path);
    if (last) return undefined;
    if (!link?.to) throw cannotExpand(path);
    return checkPath(registry, parseType(link.to), segs, i + 1, hops + 1, path, info);
  }
  if (available && link?.embedded && link.to && !last) {
    return checkPath(registry, parseType(link.to), segs, i + 1, hops, path, info);
  }
  if (!last && hasDeclaredPrefix(def, rel, info)) {
    return checkPath(registry, { type: node.type, rel }, segs, i + 1, hops, path, info);
  }
  throw cannotExpand(path);
}

function buildTrie(paths) {
  const root = new Map();
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    let node = root;
    for (const seg of p.split('.')) {
      if (!node.has(seg)) node.set(seg, new Map());
      node = node.get(seg);
    }
  }
  return root;
}

/**
 * Applies expand paths to rendered JSON in place. The paths were already accepted by checkExpand
 * (request validation), so this only fills in values: an ID becomes its object, an includable key
 * is added, and a path whose value is absent or null is skipped. `listTotal` is the number of
 * matching objects of a top-level list (expand[]=total_count on 2024-06-20-family requests). An
 * includable resolver is called as `(hash, ctx, resource)`: the hash that receives the key and the
 * rendered resource that owns the path (the same object for a top-level key).
 */
export function applyExpand(json, paths, ctx, { listTotal } = {}) {
  const trie = buildTrie(paths);
  const owner = isPlainObject(json) && json.object ? { type: json.object, rel: '', root: json } : { type: null, rel: '', root: json };
  walk(json, trie, ctx, owner, listTotal);
}

function defOf(ctx, type) {
  return type ? ctx.account.server.registry.objects.get(type) : undefined;
}

function isRegisteredResource(ctx, value) {
  return isPlainObject(value) && typeof value.object === 'string' && ctx.account.server.registry.objects.has(value.object);
}

function expandId(ctx, id) {
  if (typeof id !== 'string') return id;
  const target = ctx.lookup(id);
  return target ? renderObject(target, ctx) : id;
}

function walk(value, trie, ctx, owner, listTotal) {
  if (isList(value)) {
    for (const [seg, sub] of trie) {
      if (seg === 'data') {
        for (const item of value.data) {
          if (isPlainObject(item)) walk(item, sub, ctx, { type: item.object ?? null, rel: '', root: item }, undefined);
        }
      } else if (seg === 'total_count' && ctx.family === 'F1' && value.total_count === undefined) {
        value.total_count = listTotal ?? value.data.length;
      }
    }
    return;
  }
  for (const [seg, sub] of trie) {
    const rel = owner.rel ? `${owner.rel}.${seg}` : seg;
    const def = defOf(ctx, owner.type);
    const expandable = Boolean(def?.expandable.has(rel));
    const includable = def?.includable && Object.hasOwn(def.includable, rel) ? def.includable[rel] : null;
    let v = value[seg];
    if (includable && v === undefined) {
      v = includable(value, ctx, owner.root);
      value[seg] = v;
    } else if (expandable && typeof v === 'string') {
      v = expandId(ctx, v);
      value[seg] = v;
    } else if (expandable && Array.isArray(v)) {
      v = v.map((x) => expandId(ctx, x));
      value[seg] = v;
    }
    if (!sub.size || v === null || v === undefined) continue;
    for (const child of Array.isArray(v) ? v : [v]) {
      if (!isPlainObject(child)) continue;
      // An embedded resource switches to its own declarations; hashes and lists keep the owner's.
      const childOwner = isRegisteredResource(ctx, child) ? { type: child.object, rel: '', root: child } : { type: owner.type, rel, root: owner.root };
      walk(child, sub, ctx, childOwner, undefined);
    }
  }
}
