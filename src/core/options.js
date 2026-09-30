/**
 * createStripeTestServer options: validation and defaults (the public option types are in
 * src/index.d.ts).
 */
import { LATEST_VERSION, isAcceptedVersion } from './versions.js';
import { normalizeBillingSettings } from './controls.js';
import { isHttpUrl } from './util.js';

/** Default Billing settings: 8 payment attempts over 14 days, then cancel (see README, "Uncertain behaviour"). */
export const DEFAULT_BILLING_SETTINGS = Object.freeze({
  retrySchedule: [2, 2, 2, 2, 2, 2, 2],
  afterFinalRetry: 'cancel',
  markUncollectible: false,
});

/** Default webhook retries: three, compressed for tests (Stripe retries sandbox deliveries three times). */
export const DEFAULT_WEBHOOK_RETRY = Object.freeze({ delaysMs: [500, 2000, 5000], timeoutMs: 10000 });

const OPTION_KEYS = ['port', 'host', 'webhooks', 'apiVersion', 'billing', 'webhookRetry', 'log'];

function fail(message) {
  throw new TypeError(`createStripeTestServer: ${message}`);
}

/** Validates options and fills in defaults. */
export function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object') fail('options must be an object');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.includes(key)) fail(`unknown option "${key}"`);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('port must be an integer between 0 and 65535');
  const host = options.host ?? '127.0.0.1';
  if (typeof host !== 'string' || !host) fail('host must be a non-empty string');
  const apiVersion = options.apiVersion ?? LATEST_VERSION;
  if (!isAcceptedVersion(apiVersion)) fail(`apiVersion "${apiVersion}" is not a Stripe API version`);
  const webhooks = (options.webhooks ?? []).map((w, i) => {
    if (!w || !isHttpUrl(w.url)) fail(`webhooks[${i}].url must be an absolute http(s) URL`);
    if (typeof w.secret !== 'string' || !w.secret) fail(`webhooks[${i}].secret must be a non-empty string`);
    if (w.apiVersion !== undefined && !isAcceptedVersion(w.apiVersion)) fail(`webhooks[${i}].apiVersion is not a Stripe API version`);
    return { url: w.url, secret: w.secret, apiVersion: w.apiVersion ?? null };
  });
  let billing;
  try {
    billing = { ...DEFAULT_BILLING_SETTINGS, retrySchedule: [...DEFAULT_BILLING_SETTINGS.retrySchedule], ...normalizeBillingSettings(options.billing ?? {}) };
  } catch (err) {
    fail(`billing: ${err.message}`);
  }
  const retry = options.webhookRetry ?? {};
  const delaysMs = retry.delaysMs ?? [...DEFAULT_WEBHOOK_RETRY.delaysMs];
  if (!Array.isArray(delaysMs) || !delaysMs.every((d) => Number.isFinite(d) && d >= 0)) fail('webhookRetry.delaysMs must be an array of numbers >= 0');
  const timeoutMs = retry.timeoutMs ?? DEFAULT_WEBHOOK_RETRY.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('webhookRetry.timeoutMs must be a number > 0');
  const log = options.log ?? false;
  if (typeof log !== 'boolean' && typeof log !== 'function') fail('log must be a boolean or a function');
  return { port, host, webhooks, apiVersion, billing, webhookRetry: { delaysMs, timeoutMs }, log };
}
