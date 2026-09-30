/**
 * Webhook endpoints (docs.stripe.com/api/webhook_endpoints).
 *
 * Three sources feed deliveries, all as records of one shape (ARCHITECTURE.md):
 *   options   server-wide endpoints from createStripeTestServer({ webhooks }) (server.webhookEndpoints)
 *   control   setWebhookEndpoints() — replaced as a set, per account
 *   api       POST /v1/webhook_endpoints — the only ones the /v1/webhook_endpoints routes see
 *
 * Record: { id, object: 'webhook_endpoint', scope, source, url, secret, apiVersion, enabledEvents,
 * status, description, metadata, created, _seq }. The secret appears in the API only in the
 * create response; `api_version` cannot be changed after creation; delete returns a stub.
 */
import { hashToken } from '../core/ids.js';
import { invalidParam, invalidRequest, resourceMissing } from '../core/errors.js';
import { paginate } from '../core/list.js';
import { raw, stripPrivate } from '../core/render.js';
import { applyMetadata, isHttpUrl, unsetToNull } from '../core/util.js';
import { isAcceptedVersion } from '../core/versions.js';
import { dropEndpointDeliveries } from './delivery.js';

/** Most endpoints an account can register through the API (docs.stripe.com/webhooks). */
export const MAX_API_ENDPOINTS = 16;

const CONTROL_FIELDS = ['url', 'secret', 'apiVersion'];

/** Every endpoint that receives this account's events: server-wide ones first. */
export function endpointsFor(account) {
  return [...account.server.webhookEndpoints, ...account.webhookEndpoints];
}

/** The endpoint record with `id` (any source), or null. */
export function findEndpoint(account, id) {
  return endpointsFor(account).find((e) => e.id === id) || null;
}

/** True when an enabled endpoint is subscribed to events of `type` ('*' = every event). */
export function receivesEvent(endpoint, type) {
  if (endpoint.status !== 'enabled') return false;
  return endpoint.enabledEvents.includes('*') || endpoint.enabledEvents.includes(type);
}

/** A copy of a record without private fields (control results). */
export function publicEndpoint(record) {
  return stripPrivate(record);
}

function newRecord(account, fields, source) {
  const seq = account.moduleState('webhookEndpoints', () => ({ seq: 0 }));
  return {
    id: account.mintId('we'),
    object: 'webhook_endpoint',
    scope: 'account',
    source,
    url: fields.url,
    secret: fields.secret,
    apiVersion: fields.apiVersion ?? null,
    enabledEvents: fields.enabledEvents ?? ['*'],
    status: 'enabled',
    description: fields.description ?? null,
    metadata: fields.metadata ?? {},
    created: account.time.now(),
    _seq: ++seq.seq,
  };
}

function controlInput(input, i) {
  const param = (key) => `endpoints[${i}][${key}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidRequest('Each endpoint must be an object { url, secret, apiVersion? }.', { param: `endpoints[${i}]` });
  }
  const unknown = Object.keys(input).find((key) => !CONTROL_FIELDS.includes(key));
  if (unknown) throw invalidRequest(`Unknown endpoint field: ${unknown} (use url, secret, apiVersion).`, { param: param(unknown) });
  if (!isHttpUrl(input.url)) throw invalidRequest('url must be an absolute http(s) URL.', { param: param('url') });
  if (typeof input.secret !== 'string' || !input.secret) throw invalidRequest('secret must be a non-empty string.', { param: param('secret') });
  if (input.apiVersion != null && !isAcceptedVersion(input.apiVersion)) {
    throw invalidRequest(`apiVersion "${input.apiVersion}" is not a Stripe API version.`, { param: param('apiVersion') });
  }
  return { url: input.url, secret: input.secret, apiVersion: input.apiVersion ?? null };
}

/**
 * The setWebhookEndpoints control: replaces the control-added endpoints of the account (API and
 * server-wide endpoints stay). Queued deliveries to the replaced endpoints are dropped.
 * @returns the new records
 */
export function replaceControlEndpoints(account, inputs) {
  const fields = inputs.map(controlInput);
  const removed = account.webhookEndpoints.filter((e) => e.source === 'control').map((e) => e.id);
  const records = fields.map((f) => newRecord(account, f, 'control'));
  account.webhookEndpoints = [...account.webhookEndpoints.filter((e) => e.source !== 'control'), ...records];
  dropEndpointDeliveries(account, removed, 'Endpoint replaced');
  return records.map(publicEndpoint);
}

// API ------------------------------------------------------------------------------------------

function apiEndpoints(account) {
  return account.webhookEndpoints.filter((e) => e.source === 'api');
}

function requireApiEndpoint(account, id) {
  const record = apiEndpoints(account).find((e) => e.id === id);
  if (!record) throw resourceMissing('webhook_endpoint', id);
  return record;
}

function checkUrl(url) {
  if (!isHttpUrl(url)) {
    throw invalidRequest(`Invalid URL: ${url}. The URL must be an absolute http or https URL.`, { param: 'url', code: 'url_invalid', validation: true });
  }
}

/** Creates an endpoint from validated POST /v1/webhook_endpoints params. */
export function createEndpoint(account, params) {
  checkUrl(params.url);
  if (params.api_version !== undefined && !isAcceptedVersion(params.api_version)) {
    throw invalidParam('api_version', `Invalid api_version: ${params.api_version}`);
  }
  if (params.connect === true) {
    throw invalidParam('connect', 'Connect webhook endpoints are not supported by this test server (it has no connected accounts).');
  }
  if (apiEndpoints(account).length >= MAX_API_ENDPOINTS) {
    throw invalidRequest(`You have reached the maximum of ${MAX_API_ENDPOINTS} webhook endpoints for this account.`);
  }
  const metadata = applyMetadata({}, params.metadata);
  const record = newRecord(
    account,
    {
      url: params.url,
      secret: null,
      apiVersion: params.api_version ?? null,
      enabledEvents: [...params.enabled_events],
      description: unsetToNull(params.description) ?? null,
      metadata,
    },
    'api',
  );
  record.secret = `whsec_${hashToken(`webhook-secret|${account.key}|${record.id}`, 32)}`;
  account.webhookEndpoints = [...account.webhookEndpoints, record];
  return record;
}

/** Applies validated POST /v1/webhook_endpoints/:id params (validates everything first). */
export function updateEndpoint(account, record, params) {
  if (params.url !== undefined) checkUrl(params.url);
  const metadata = applyMetadata(record.metadata, params.metadata);
  if (params.url !== undefined) record.url = params.url;
  if (params.enabled_events !== undefined) record.enabledEvents = [...params.enabled_events];
  if (params.description !== undefined) record.description = unsetToNull(params.description);
  if (params.disabled !== undefined) record.status = params.disabled ? 'disabled' : 'enabled';
  record.metadata = metadata;
  return record;
}

/** Deletes an API endpoint; its queued deliveries and retries are dropped. */
export function deleteEndpoint(account, record) {
  account.webhookEndpoints = account.webhookEndpoints.filter((e) => e !== record);
  dropEndpointDeliveries(account, [record.id], 'Endpoint deleted');
  return raw({ id: record.id, object: 'webhook_endpoint', deleted: true });
}

/** Wire form (docs.stripe.com/api/webhook_endpoints/object); `secret` only in the create response. */
function renderEndpoint(record) {
  const out = {
    id: record.id,
    object: 'webhook_endpoint',
    api_version: record.apiVersion,
    application: null,
    created: record.created,
    description: record.description,
    enabled_events: [...record.enabledEvents],
    livemode: false,
    metadata: { ...record.metadata },
  };
  if (record._withSecret) out.secret = record.secret;
  out.status = record.status;
  out.url = record.url;
  return out;
}

export function install(app) {
  app.object('webhook_endpoint', { render: renderEndpoint });

  app.route('POST', '/v1/webhook_endpoints', (ctx) => ({ ...createEndpoint(ctx.account, ctx.params), _withSecret: true }));
  app.route('GET', '/v1/webhook_endpoints', (ctx) =>
    paginate(apiEndpoints(ctx.account), ctx.params, { url: '/v1/webhook_endpoints', noun: 'webhook_endpoint' }),
  );
  app.route('GET', '/v1/webhook_endpoints/:id', (ctx) => requireApiEndpoint(ctx.account, ctx.pathParams.id));
  app.route('POST', '/v1/webhook_endpoints/:id', (ctx) =>
    updateEndpoint(ctx.account, requireApiEndpoint(ctx.account, ctx.pathParams.id), ctx.params),
  );
  app.route('DELETE', '/v1/webhook_endpoints/:id', (ctx) => deleteEndpoint(ctx.account, requireApiEndpoint(ctx.account, ctx.pathParams.id)));
}
