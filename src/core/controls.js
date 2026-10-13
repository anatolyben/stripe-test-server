/**
 * Every control. Each is an HTTP route under /_test/ (JSON in and out, same
 * Bearer key → same account) and a method of AccountControls in JS with the same result.
 * Generic controls are implemented here; the others delegate to the owning module.
 */
import { invalidRequest } from './errors.js';
import { render } from './render.js';
import { deleteCustomer, requireCustomer } from '../customers/customers.js';
import { failNextCharge } from '../payments/payment_intents.js';
import { failNextRefund } from '../payments/refunds.js';
import { createSubscriptionForTest } from '../billing/engine.js';
import {
  deliverDuplicate,
  holdDeliveries,
  listDeliveries,
  releaseDeliveries,
  resendEvent,
  sendWithBadSignature,
  setWebhookEndpoints,
  settleAccount,
} from '../webhooks/delivery.js';

function requireString(input, name) {
  if (typeof input[name] !== 'string' || !input[name]) throw invalidRequest(`${name} is required`, { param: name });
  return input[name];
}

const RETRY_ACTIONS = ['cancel', 'unpaid', 'past_due'];

/** Validates a Billing settings patch; returns the normalized patch. */
export function normalizeBillingSettings(patch = {}) {
  const out = {};
  if (patch.retrySchedule !== undefined) {
    const s = patch.retrySchedule;
    if (!Array.isArray(s) || !s.every((d) => Number.isFinite(Number(d)) && Number(d) >= 0)) {
      throw invalidRequest('retrySchedule must be an array of day counts (numbers >= 0)', { param: 'retrySchedule' });
    }
    out.retrySchedule = s.map(Number);
  }
  if (patch.afterFinalRetry !== undefined) {
    if (!RETRY_ACTIONS.includes(patch.afterFinalRetry)) {
      throw invalidRequest(`afterFinalRetry must be one of ${RETRY_ACTIONS.join(', ')}`, { param: 'afterFinalRetry' });
    }
    out.afterFinalRetry = patch.afterFinalRetry;
  }
  if (patch.markUncollectible !== undefined) {
    if (typeof patch.markUncollectible !== 'boolean') {
      throw invalidRequest('markUncollectible must be a boolean', { param: 'markUncollectible' });
    }
    out.markUncollectible = patch.markUncollectible;
  }
  const unknown = Object.keys(patch).filter((k) => !['retrySchedule', 'afterFinalRetry', 'markUncollectible'].includes(k));
  if (unknown.length) throw invalidRequest(`Unknown billing setting: ${unknown[0]}`, { param: unknown[0] });
  return out;
}

function toNumber(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw invalidRequest(`${name} must be a number`, { param: name });
  return n;
}

export function install(app) {
  app.control({
    name: 'reset',
    method: 'POST',
    path: '/_test/reset',
    handler: (account) => {
      account.reset();
      return { reset: true };
    },
  });

  app.control({
    name: 'advanceTime',
    method: 'POST',
    path: '/_test/advance_time',
    handler: (account, input) => {
      const seconds = toNumber(input.seconds, 'seconds');
      const to = toNumber(input.to, 'to');
      if ((seconds === undefined) === (to === undefined)) {
        throw invalidRequest('Pass exactly one of seconds or to', { param: 'seconds' });
      }
      if (seconds !== undefined && seconds < 0) throw invalidRequest('seconds must be >= 0', { param: 'seconds' });
      try {
        return { now: account.time.advanceAccountClock({ seconds, to }) };
      } catch (err) {
        if (err instanceof RangeError) throw invalidRequest(err.message, { param: 'to' });
        throw err;
      }
    },
  });

  app.control({
    name: 'now',
    method: 'GET',
    path: '/_test/now',
    handler: (account) => ({ now: account.time.now() }),
  });

  app.control({
    name: 'state',
    method: 'GET',
    path: '/_test/state',
    handler: (account, input) => {
      const version = account.settings.apiVersion;
      const types = input.type ? [input.type] : account.store.types().sort();
      const objects = {};
      for (const type of types) {
        objects[type] = account.store.list(type).map((obj) =>
          input.raw === true || input.raw === 'true' ? structuredClone(obj) : render(account, obj, { version }),
        );
      }
      return {
        now: account.time.now(),
        clocks: Object.fromEntries(account.time.clocks),
        objects,
        jobs: account.time.list(),
        events: account.events.all().length,
      };
    },
  });

  app.control({
    name: 'requests',
    method: 'GET',
    path: '/_test/requests',
    handler: (account, input) => account.ledger.list({ limit: input.limit, method: input.method, path: input.path }),
  });

  app.control({
    name: 'faults.add',
    method: 'POST',
    path: '/_test/faults',
    handler: (account, input) => account.faults.add(input),
  });

  app.control({
    name: 'faults.clear',
    method: 'DELETE',
    path: '/_test/faults',
    handler: (account) => ({ cleared: account.faults.clear() }),
  });

  app.control({
    name: 'faults.list',
    method: 'GET',
    path: '/_test/faults',
    handler: (account) => account.faults.list(),
  });

  app.control({
    name: 'billingSettings',
    method: 'GET',
    path: '/_test/billing_settings',
    handler: (account) => structuredClone(account.settings.billing),
  });

  app.control({
    name: 'updateBillingSettings',
    method: 'POST',
    path: '/_test/billing_settings',
    handler: (account, input) => {
      Object.assign(account.settings.billing, normalizeBillingSettings(input));
      return structuredClone(account.settings.billing);
    },
  });

  app.control({
    name: 'deleteCustomer',
    method: 'POST',
    path: '/_test/delete_customer',
    args: (customerId) => ({ customer: customerId }),
    handler: (account, input) => deleteCustomer(account, requireCustomer(account, requireString(input, 'customer')), { request: null }),
  });

  app.control({
    name: 'failNextCharge',
    method: 'POST',
    path: '/_test/fail_next_charge',
    args: (customerId, opts = {}) => ({ ...opts, customer: customerId }),
    handler: (account, input) => {
      const customer = requireString(input, 'customer');
      const times = input.times === undefined ? 1 : Number(input.times);
      if (!Number.isInteger(times) || times < 1) throw invalidRequest('times must be a positive integer', { param: 'times' });
      return failNextCharge(account, customer, { times, declineCode: input.declineCode ?? 'generic_decline' });
    },
  });

  app.control({
    name: 'failNextRefund', method: 'POST', path: '/_test/fail_next_refund',
    args: (customerId, opts = {}) => ({ ...opts, customer: customerId }),
    handler: (account, input) => failNextRefund(account, requireString(input, 'customer'), {
      times: input.times === undefined ? 1 : Number(input.times), failureReason: input.failureReason ?? 'declined',
      delaySeconds: input.delaySeconds === undefined ? 60 : Number(input.delaySeconds),
    }),
  });

  app.control({
    name: 'createSubscription',
    method: 'POST',
    path: '/_test/create_subscription',
    args: (customerId, opts = {}) => ({ ...opts, customer: customerId }),
    handler: (account, input, cctx) => {
      const customer = requireString(input, 'customer');
      requireString(input, 'price');
      const sub = createSubscriptionForTest(account, customer, {
        price: input.price,
        quantity: input.quantity === undefined ? 1 : Number(input.quantity),
        trialDays: input.trialDays === undefined ? undefined : Number(input.trialDays),
        paymentMethod: input.paymentMethod,
      });
      return cctx.render(sub);
    },
  });

  app.control({
    name: 'setWebhookEndpoints',
    method: 'PUT',
    path: '/_test/webhook_endpoints',
    args: (endpoints) => ({ endpoints }),
    handler: (account, input) => {
      if (!Array.isArray(input.endpoints)) throw invalidRequest('endpoints must be an array of {url, secret, apiVersion?}', { param: 'endpoints' });
      return setWebhookEndpoints(account, input.endpoints);
    },
  });

  app.control({
    name: 'webhooks.deliveries',
    method: 'GET',
    path: '/_test/webhooks/deliveries',
    handler: (account, input) => listDeliveries(account, input),
  });

  app.control({
    name: 'webhooks.resend',
    method: 'POST',
    path: '/_test/webhooks/resend',
    args: (eventId) => ({ eventId }),
    handler: (account, input) => resendEvent(account, requireString(input, 'eventId')),
  });

  app.control({
    name: 'webhooks.deliverDuplicate',
    method: 'POST',
    path: '/_test/webhooks/deliver_duplicate',
    args: (eventId) => ({ eventId }),
    handler: (account, input) => deliverDuplicate(account, requireString(input, 'eventId')),
  });

  app.control({
    name: 'webhooks.hold',
    method: 'POST',
    path: '/_test/webhooks/hold',
    handler: (account) => holdDeliveries(account),
  });

  app.control({
    name: 'webhooks.release',
    method: 'POST',
    path: '/_test/webhooks/release',
    args: (opts = {}) => opts,
    handler: (account, input) => releaseDeliveries(account, { order: input.order ?? 'fifo' }),
  });

  app.control({
    name: 'webhooks.sendWithBadSignature',
    method: 'POST',
    path: '/_test/webhooks/send_with_bad_signature',
    args: (eventId) => ({ eventId }),
    handler: (account, input) => sendWithBadSignature(account, requireString(input, 'eventId')),
  });

  app.control({
    name: 'webhooks.settle',
    method: 'POST',
    path: '/_test/webhooks/settle',
    lock: false,
    handler: async (account) => {
      await settleAccount(account);
      return { settled: true };
    },
  });
}
