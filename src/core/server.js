/**
 * The HTTP server and request pipeline (ARCHITECTURE.md).
 *
 *   /v1/…      API: auth → faults → version → [account lock: catch up time → route → parse →
 *              idempotency → validate → handler → render] → ledger → response
 *   /_test/…   control API (JSON), authenticated with the same Bearer key
 *   other      hosted pages registered by modules (Checkout, portal, invoices), else 404
 */
import http from 'node:http';
import { Account } from './account.js';
import { IdMinter, hashToken } from './ids.js';
import { parseForm } from './form.js';
import { validateParams } from './validate.js';
import { checkExpand, render } from './render.js';
import { resolveVersion, versionInfo } from './versions.js';
import { IdempotencyStore, canonicalParams } from './idempotency.js';
import { redactKey } from './ledger.js';
import {
  StripeError,
  apiError,
  authenticationError,
  invalidRequest,
  rateLimitError,
  toStripeError,
  unrecognizedUrl,
} from './errors.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

const NO_KEY_MESSAGE =
  "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. 'Authorization: Bearer YOUR_SECRET_KEY'). See https://stripe.com/docs/api#authentication for details, or we can help at https://support.stripe.com/.";

/** Returns { key } or { error } for an Authorization header (Bearer or Basic). */
export function authenticate(header) {
  if (!header) return { error: authenticationError(NO_KEY_MESSAGE) };
  let key = null;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const basic = /^Basic\s+(\S+)\s*$/i.exec(header);
  if (bearer) key = bearer[1];
  else if (basic) {
    try {
      key = Buffer.from(basic[1], 'base64').toString('utf8').split(':')[0];
    } catch {
      key = null;
    }
  }
  if (!key) return { error: authenticationError(NO_KEY_MESSAGE) };
  if (/^(sk|rk)_test_\S+$/.test(key)) return { key };
  if (/^pk_(test|live)_/.test(key)) {
    return {
      error: authenticationError(
        'This API call cannot be made with a publishable API key. Please use a secret API key. You can find a list of your API keys at https://dashboard.stripe.com/account/apikeys.',
        'secret_key_required',
      ),
    };
  }
  return { error: authenticationError(`Invalid API Key provided: ${redactKey(key)}`) };
}

class BodyTooLargeError extends Error {}

/**
 * Reads the request body. A body over MAX_BODY_BYTES is drained without being kept, then rejected
 * with BodyTooLargeError, so the socket stays usable for the error response.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) reject(new BodyTooLargeError(`Request body too large: the limit is ${MAX_BODY_BYTES} bytes.`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export class ServerContext {
  /**
   * @param {object} options normalized options (see src/index.js)
   * @param {import('./registry.js').Registry} registry
   */
  constructor(options, registry) {
    this.options = options;
    this.registry = registry;
    this.accounts = new Map();
    this.idOwners = new Map();
    this.ids = new IdMinter('server');
    this.sockets = new Set();
    this.timers = new Set();
    this.url = null;
    this.port = null;
    this.httpServer = null;
    /** Server-wide webhook endpoints from options; they apply to every account. */
    this.webhookEndpoints = options.webhooks.map((w, i) => ({
      id: `we_${hashToken(`server-endpoint|${i}|${w.url}`, 24)}`,
      object: 'webhook_endpoint',
      scope: 'server',
      url: w.url,
      secret: w.secret,
      apiVersion: w.apiVersion ?? null,
      enabledEvents: w.enabledEvents ?? ['*'],
      status: 'enabled',
      description: null,
      metadata: {},
      created: Math.floor(Date.now() / 1000),
    }));
  }

  /** Logs through the `log` option. Never throws: a failing log sink must not break a request. */
  log(level, message) {
    const { log } = this.options;
    if (!log) return;
    try {
      if (typeof log === 'function') log({ level, message });
      else if (level === 'error') console.error(`[stripe-test-server] ${message}`);
      else console.log(`[stripe-test-server] ${message}`);
    } catch {
      // Ignored: logging is best effort.
    }
  }

  /** The account for an API key, created on first use. */
  account(key) {
    let account = this.accounts.get(key);
    if (!account) {
      account = new Account(this, key);
      this.accounts.set(key, account);
      this.registry.runHooks('account.created', account);
    }
    return account;
  }

  /** The account owning an ID or token minted by account.mintId (hosted pages), or null. */
  accountForId(id) {
    return this.idOwners.get(id) || null;
  }

  registerId(id, account) {
    this.idOwners.set(id, account);
  }

  unregisterIds(account) {
    for (const [id, owner] of this.idOwners) if (owner === account) this.idOwners.delete(id);
  }

  /** API versions of every enabled endpoint that receives this account's events. */
  endpointVersions(account) {
    return [...this.webhookEndpoints, ...account.webhookEndpoints]
      .filter((e) => e.status !== 'disabled')
      .map((e) => e.apiVersion || account.settings.apiVersion);
  }

  /** Runs due account-clock jobs and the 'account.beforeRequest' hooks. */
  beforeRequest(account) {
    account.time.catchUp();
    this.registry.runHooks('account.beforeRequest', account);
  }

  /** Runs a control for an account (serialized unless the control sets lock: false). */
  runControl(account, def, input) {
    const version = account.settings.apiVersion;
    const cctx = {
      server: this,
      account,
      version,
      render: (obj, options = {}) => render(account, obj, { version, ...options }),
    };
    if (def.lock === false) return Promise.resolve().then(() => def.handler(account, input ?? {}, cctx));
    return account.run(() => {
      this.beforeRequest(account);
      return def.handler(account, input ?? {}, cctx);
    });
  }

  // HTTP ---------------------------------------------------------------------------------------

  listen() {
    this.httpServer = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log('error', `unhandled: ${err && err.stack ? err.stack : err}`);
        if (!res.headersSent) this.sendJson(res, 500, apiError().toBody(), {});
        else res.destroy();
      });
    });
    this.httpServer.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    const { port, host } = this.options;
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(port, host, () => {
        this.httpServer.off('error', reject);
        this.port = this.httpServer.address().port;
        this.url = `http://${host.includes(':') ? `[${host}]` : host}:${this.port}`;
        resolve();
      });
    });
  }

  close() {
    this.registry.runHooks('server.close', this);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (!this.httpServer) return Promise.resolve();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
      for (const s of this.sockets) s.destroy();
    });
  }

  send(res, status, headers, body) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  sendJson(res, status, value, headers = {}) {
    this.send(res, status, { 'Content-Type': 'application/json', ...headers }, `${JSON.stringify(value, null, 2)}\n`);
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method.toUpperCase();
    const path = url.pathname;
    const rawQuery = url.search.slice(1);
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      if (!(err instanceof BodyTooLargeError)) return undefined; // the client went away mid-body
      const requestId = this.ids.next('req', 14);
      return this.sendJson(res, 400, invalidRequest(err.message).toBody(requestId), { 'Request-Id': requestId });
    }
    const request = { req, res, method, path, rawQuery, body };
    if (path.startsWith('/v1/') || path === '/v1') return this.handleApi(request);
    if (path.startsWith('/_test/')) return this.handleControl(request);
    const page = this.registry.matchPage(method, path);
    if (page.entry) return this.handlePage(page, request);
    const requestId = this.ids.next('req', 14);
    return this.sendJson(res, 404, unrecognizedUrl(method, path).toBody(requestId), { 'Request-Id': requestId });
  }

  async handleApi({ req, res, method, path, rawQuery, body }) {
    const started = Date.now();
    const auth = authenticate(header(req, 'authorization'));
    if (auth.error) {
      const requestId = this.ids.next('req', 14);
      return this.sendJson(res, auth.error.status, auth.error.toBody(requestId), { 'Request-Id': requestId });
    }
    const account = this.account(auth.key);
    const requestId = account.ids.next('req', 14);
    const idempotencyKey = method === 'POST' ? header(req, 'idempotency-key') : undefined;
    const headers = { 'Request-Id': requestId };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const safeParse = (s) => {
      try {
        return parseForm(s);
      } catch {
        return { _unparseable: s };
      }
    };
    const record = (status, extra = {}) =>
      account.ledger.add({
        id: requestId,
        method,
        path,
        query: safeParse(rawQuery),
        body: method === 'POST' ? safeParse(body) : {},
        status,
        version: extra.version ?? null,
        idempotencyKey: idempotencyKey ?? null,
        replayed: Boolean(extra.replayed),
        fault: extra.fault ?? null,
        time: account.time.now(),
        realTime: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      });

    if (header(req, 'stripe-account') || header(req, 'stripe-context')) {
      const err = invalidRequest('The Stripe-Account and Stripe-Context headers (Connect) are not supported by this test server.', { validation: true });
      record(err.status);
      return this.sendJson(res, err.status, err.toBody(requestId), headers);
    }

    const fault = account.faults.take(method, path);
    if (fault) return this.applyFault(fault, { req, res, requestId, headers, record });

    let version;
    try {
      version = resolveVersion(header(req, 'stripe-version'), account.settings.apiVersion);
    } catch (err) {
      record(err.status);
      return this.sendJson(res, err.status, err.toBody(requestId), headers);
    }
    headers['Stripe-Version'] = version;

    const outcome = await account.run(() => this.executeApi(account, { method, path, rawQuery, body, version, requestId, idempotencyKey }));
    record(outcome.status, { version, replayed: outcome.replayed });
    this.log('info', `${method} ${path} ${outcome.status} ${requestId}${outcome.replayed ? ' (replayed)' : ''}`);
    this.send(res, outcome.status, { 'Content-Type': 'application/json', ...headers, ...outcome.headers }, outcome.body);
  }

  /** Runs one API request under the account lock; returns { status, body, headers, replayed }. */
  async executeApi(account, { method, path, rawQuery, body, version, requestId, idempotencyKey }) {
    const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
    const fail = (err) => {
      const se = toStripeError(err);
      if (!(err instanceof StripeError)) this.log('error', `${method} ${path}: ${err && err.stack ? err.stack : err}`);
      return { status: se.status, body: json(se.toBody(requestId)), headers: { ...se.headers }, error: se };
    };
    let canonical;
    let match;
    let params;
    try {
      this.beforeRequest(account);
      match = this.registry.matchRoute(method, path);
      if (!match.entry) throw unrecognizedUrl(method, path);
      const parsed = method === 'POST' ? { ...parseForm(rawQuery), ...parseForm(body) } : parseForm(rawQuery);
      if (idempotencyKey !== undefined) {
        IdempotencyStore.checkKey(idempotencyKey);
        canonical = canonicalParams(parsed);
        const saved = account.idempotency.lookup(idempotencyKey, account.time.now());
        if (saved) {
          IdempotencyStore.assertSameRequest(saved, idempotencyKey, method, path, canonical);
          return { status: saved.status, body: saved.body, headers: { ...saved.headers, 'Idempotent-Replayed': 'true' }, replayed: true };
        }
      }
      params = match.entry.validate ? validateParams(match.entry.op, parsed, version) : parsed;
      checkExpand(this.registry, match.entry.returns, params.expand, version);
    } catch (err) {
      return fail(err);
    }

    // Execution begins: from here on, results are saved under the idempotency key.
    let outcome;
    account.currentRequest = { id: requestId, idempotency_key: idempotencyKey ?? null };
    try {
      const ctx = {
        server: this,
        account,
        method,
        path,
        pathParams: match.params,
        params,
        raw: { body, query: rawQuery },
        ...versionInfo(version),
        request: { id: requestId, idempotency_key: idempotencyKey ?? null },
        now: (domain = null) => account.time.now(domain),
      };
      const result = await match.entry.handler(ctx);
      if (result === undefined) throw new Error(`${method} ${path} handler returned nothing`);
      outcome = { status: 200, body: json(render(account, result, { version, expand: params.expand || [] })), headers: {} };
    } catch (err) {
      outcome = fail(err);
    } finally {
      account.currentRequest = null;
    }
    if (idempotencyKey !== undefined && !(outcome.error && outcome.error.validation)) {
      account.idempotency.save(idempotencyKey, {
        method,
        path,
        params: canonical,
        status: outcome.status,
        body: outcome.body,
        headers: outcome.headers,
        createdAt: account.time.now(),
        requestId,
      });
    }
    return outcome;
  }

  applyFault(fault, { req, res, requestId, headers, record }) {
    record(fault.kind === 'timeout' ? null : Number(fault.kind), { fault: fault.kind });
    if (fault.kind === '500') return this.sendJson(res, 500, apiError().toBody(requestId), headers);
    if (fault.kind === '429') {
      const err = rateLimitError();
      return this.sendJson(res, 429, err.toBody(requestId), { ...headers, ...err.headers });
    }
    // timeout: never answer. The connection is held until the client gives up (its own timeout
    // gives StripeConnectionError; a server-side reset would instead be retried once by the SDK,
    // even with maxNetworkRetries 0) or, when the fault sets timeoutMs, dropped after it.
    if (fault.timeoutMs === null) return undefined;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      req.socket.destroy();
    }, fault.timeoutMs);
    this.timers.add(timer);
    req.socket.once('close', () => {
      clearTimeout(timer);
      this.timers.delete(timer);
    });
    return undefined;
  }

  /** A control request: Request-Id header, error bodies without a dashboard log link. */
  async handleControl({ req, res, method, path, rawQuery, body }) {
    const auth = authenticate(header(req, 'authorization'));
    if (auth.error) {
      const requestId = this.ids.next('req', 14);
      return this.sendJson(res, 401, auth.error.toBody(), { 'Request-Id': requestId });
    }
    const account = this.account(auth.key);
    const requestId = account.ids.next('req', 14);
    const headers = { 'Request-Id': requestId };
    const def = this.registry.findControl(method, path);
    if (!def) return this.sendJson(res, 404, unrecognizedUrl(method, path).toBody(), headers);
    let input;
    try {
      input = body && body.trim() ? JSON.parse(body) : parseForm(rawQuery);
    } catch {
      return this.sendJson(res, 400, invalidRequest('Control requests take a JSON body.').toBody(), headers);
    }
    try {
      const result = await this.runControl(account, def, input);
      return this.sendJson(res, 200, result === undefined ? {} : result, headers);
    } catch (err) {
      const se = toStripeError(err);
      if (!(err instanceof StripeError)) this.log('error', `control ${def.name}: ${err && err.stack ? err.stack : err}`);
      return this.sendJson(res, se.status, se.toBody(), { ...se.headers, ...headers });
    }
  }

  async handlePage(match, { req, res, method, path, rawQuery, body }) {
    const account = match.entry.account(match.params, this);
    const requestId = (account ? account.ids : this.ids).next('req', 14);
    const notFound = () => this.send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Request-Id': requestId }, 'Not found\n');
    if (!account) return notFound();
    try {
      const result = await account.run(() => {
        this.beforeRequest(account);
        return match.entry.handler({
          server: this,
          account,
          method,
          path,
          pathParams: match.params,
          query: parseForm(rawQuery),
          form: method === 'POST' ? parseForm(body) : {},
          headers: req.headers,
          rawBody: body,
        });
      });
      if (!result) return notFound();
      this.log('info', `${method} ${path} ${result.status ?? 200} ${requestId}`);
      return this.send(res, result.status ?? 200, { ...(result.headers ?? {}), 'Request-Id': requestId }, result.body ?? '');
    } catch (err) {
      this.log('error', `page ${method} ${path}: ${err && err.stack ? err.stack : err}`);
      const message = err instanceof StripeError ? err.message : 'Internal error';
      return this.send(res, err instanceof StripeError ? err.status : 500, { 'Content-Type': 'text/plain; charset=utf-8', 'Request-Id': requestId }, `${message}\n`);
    }
  }
}
