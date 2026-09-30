/**
 * Builds the registry from every module's install(app) (ARCHITECTURE.md). The registry holds code
 * only, so it is built once per process and shared by every server.
 */
import { Registry } from './core/registry.js';
import * as events from './core/events.js';
import * as controls from './core/controls.js';
import * as customers from './customers/customers.js';
import * as products from './catalog/products.js';
import * as prices from './catalog/prices.js';
import * as paymentMethods from './payments/payment_methods.js';
import * as paymentIntents from './payments/payment_intents.js';
import * as checkoutSessions from './checkout/sessions.js';
import * as checkoutPage from './checkout/checkout_page.js';
import * as billingEngine from './billing/engine.js';
import * as subscriptions from './billing/subscriptions.js';
import * as invoices from './billing/invoices.js';
import * as invoicePage from './billing/invoice_page.js';
import * as schedules from './schedules/schedules.js';
import * as portalConfigurations from './portal/configurations.js';
import * as portalSessions from './portal/sessions.js';
import * as portalPage from './portal/portal_page.js';
import * as webhookDelivery from './webhooks/delivery.js';
import * as webhookEndpoints from './webhooks/endpoints.js';
import * as testClocks from './test_clocks/test_clocks.js';

/** Install order: core first; the rest only register things, so their order does not matter. */
export const MODULES = [
  events,
  controls,
  customers,
  products,
  prices,
  paymentMethods,
  paymentIntents,
  checkoutSessions,
  checkoutPage,
  billingEngine,
  subscriptions,
  invoices,
  invoicePage,
  schedules,
  portalConfigurations,
  portalSessions,
  portalPage,
  webhookDelivery,
  webhookEndpoints,
  testClocks,
];

let shared = null;

/** The process-wide registry (built on first use). */
export function registry() {
  if (!shared) {
    const r = new Registry();
    for (const mod of MODULES) mod.install(r);
    shared = r;
  }
  return shared;
}
