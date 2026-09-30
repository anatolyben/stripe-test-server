/**
 * The registry every module installs into (ARCHITECTURE.md): API routes, hosted pages, controls,
 * object serializers, job kinds and lifecycle hooks. It holds code, not state, so one registry
 * serves every server and account in the process.
 */
import { findOperationKey, operationParams } from './validate.js';
import { LINKS, RESPONSE_TYPES } from './expand_schema.js';

/** Normalizes expand links (see expand_schema.js) into a Map: rel path → { to, since, until, embedded }. */
function normalizeLinks(links) {
  const out = new Map();
  for (const [rel, link] of Object.entries(links)) {
    out.set(rel, typeof link === 'string' ? { to: link, embedded: false } : { embedded: false, ...link });
  }
  return out;
}

function compilePath(path) {
  const keys = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  const literals = path.split('/').filter((s) => s && !s.startsWith(':')).length;
  return { regex: new RegExp(`^${source}$`), keys, literals };
}

function matchCompiled(entries, method, path) {
  let best = null;
  let pathMatched = false;
  for (const entry of entries) {
    const m = entry.compiled.regex.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (entry.method !== method) continue;
    if (best && best.entry.compiled.literals >= entry.compiled.literals) continue;
    const params = {};
    entry.compiled.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    best = { entry, params };
  }
  return best ? { ...best, pathMatched } : { entry: null, params: {}, pathMatched };
}

export class Registry {
  constructor() {
    this.routes = [];
    this.pages = [];
    this.controls = [];
    this.objects = new Map();
    this.jobs = new Map();
    this.hooks = new Map();
  }

  /**
   * Registers an API route.
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} path e.g. '/v1/customers/:id'
   * @param {(ctx) => any} handler returns an internal object, a ListResult or raw(json)
   * @param {{op?: string, validate?: boolean, returns?: string}} [opts] op = key in
   *   src/schemas/params.js; derived from the path shape when omitted. validate: false skips schema
   *   validation. returns = the response type ('customer', 'list<customer>') that `expand` paths
   *   are checked against; taken from expand_schema.js RESPONSE_TYPES when omitted.
   */
  route(method, path, handler, opts = {}) {
    const validate = opts.validate !== false;
    const op = opts.op ?? findOperationKey(method, path);
    if (validate && (!op || !operationParams(op))) {
      throw new Error(`No parameter schema for ${method} ${path}; pass {op} or {validate: false}`);
    }
    const returns = opts.returns ?? (op ? RESPONSE_TYPES[op] : undefined);
    if (!returns) throw new Error(`No response type for ${method} ${path}; pass {returns}`);
    this.routes.push({ method, path, handler, op, validate, returns, compiled: compilePath(path) });
  }

  /**
   * Registers a hosted page route (HTML, forms, redirects).
   * @param {(pathParams, server) => Account|null} opts.account resolves the owning account
   */
  page(method, path, handler, { account }) {
    if (typeof account !== 'function') throw new Error(`page ${path} needs an account resolver`);
    this.pages.push({ method, path, handler, account, compiled: compilePath(path) });
  }

  /**
   * Registers a control: HTTP route under /_test/ and a method on AccountControls.
   * @param {object} def { name: 'faults.add', method, path, handler(account, input, cctx),
   *   args?: (...jsArgs) => input, lock?: boolean (default true) }
   */
  control(def) {
    if (!def.name || !def.method || !def.path || typeof def.handler !== 'function') {
      throw new Error('control needs name, method, path and handler');
    }
    if (!def.path.startsWith('/_test/')) throw new Error(`control path must start with /_test/: ${def.path}`);
    this.controls.push({ lock: true, ...def });
  }

  /**
   * Registers the serializer of an object type. `links` (optional) overrides the
   * expand links of expand_schema.js LINKS for this type.
   */
  object(type, def) {
    this.objects.set(type, {
      expandable: new Set(def.expandable || []),
      includable: def.includable || {},
      links: normalizeLinks({ ...(LINKS[type] || {}), ...(def.links || {}) }),
      render: def.render,
    });
  }

  /** Registers the handler of a job kind: handler(account, job). */
  job(kind, handler) {
    if (this.jobs.has(kind)) throw new Error(`job kind ${kind} registered twice`);
    this.jobs.set(kind, handler);
  }

  /** Adds a listener to a lifecycle hook (see ARCHITECTURE.md for the hooks). */
  hook(name, fn) {
    if (!this.hooks.has(name)) this.hooks.set(name, []);
    this.hooks.get(name).push(fn);
  }

  /** Runs a hook's listeners synchronously, in registration order. */
  runHooks(name, ...args) {
    for (const fn of this.hooks.get(name) || []) fn(...args);
  }

  matchRoute(method, path) {
    return matchCompiled(this.routes, method, path);
  }

  matchPage(method, path) {
    return matchCompiled(this.pages, method, path);
  }

  findControl(method, path) {
    return this.controls.find((c) => c.method === method && c.path === path) || null;
  }
}
