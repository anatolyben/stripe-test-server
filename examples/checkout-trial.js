// A 14-day trial through Checkout, end to end: a product and price, a portal configuration,
// a Checkout Session opened with the stripe SDK, the hosted page completed with a test card,
// every webhook verified with constructEvent, and the account clock moved past the trial so
// the first real invoice is charged.
//
//   node examples/checkout-trial.js
import http from 'node:http';
import Stripe from 'stripe';

import { createStripeTestServer } from '../src/index.js';

const API_KEY = 'sk_test_example';
const WEBHOOK_SECRET = 'whsec_example_secret';
const APP = 'https://app.example.com';
const DAY = 86400;

const verifier = new Stripe(API_KEY);
const events = [];
const rejected = [];

// Your application's webhook endpoint: verify the raw body, then record the event.
const receiver = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const event = verifier.webhooks.constructEvent(Buffer.concat(chunks), request.headers['stripe-signature'], WEBHOOK_SECRET);
      events.push(event);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"received":true}');
    } catch (err) {
      rejected.push(err.message);
      response.writeHead(400).end();
    }
  });
});
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));

const server = await createStripeTestServer({
  webhooks: [{ url: `http://127.0.0.1:${receiver.address().port}/stripe/webhook`, secret: WEBHOOK_SECRET }],
});
const stripe = new Stripe(API_KEY, { host: '127.0.0.1', port: server.port, protocol: 'http' });
const account = server.account(API_KEY);

const lines = [];
const say = (line) => lines.push(line);
const date = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
let seen = 0;
/** Waits for every delivery, then lists the events that arrived since the last call. */
async function newEvents() {
  await server.settle();
  const fresh = events.slice(seen);
  seen = events.length;
  return fresh.map((e) => e.type).join(', ');
}

try {
  // The catalog and the customer portal.
  const product = await stripe.products.create({ name: 'Pro' });
  const price = await stripe.prices.create({ product: product.id, unit_amount: 3000, currency: 'usd', recurring: { interval: 'month' } });
  const portalConfig = await stripe.billingPortal.configurations.create({
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
    default_return_url: `${APP}/account`,
  });
  say(`catalog: ${product.id} ${money(price.unit_amount)}/month, portal ${portalConfig.id}`);
  say(`  events: ${await newEvents()}`);

  // The customer starts a trial through Checkout.
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    customer_email: 'jenny.rosen@example.com',
    subscription_data: { trial_period_days: 14 },
    success_url: `${APP}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP}/pricing`,
  });
  say(`checkout: ${session.id} ${session.status}, due today ${money(session.amount_total)}`);

  // The hosted page is a plain HTML form: GET shows it, POST pays with a test card.
  const page = await fetch(session.url);
  if (page.status !== 200) throw new Error(`Checkout page answered ${page.status}`);
  const paid = await fetch(session.url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ card_number: '4242424242424242', exp_month: '12', exp_year: '34', cvc: '123', cardholder_name: 'Jenny Rosen' }),
  });
  if (paid.status !== 303) throw new Error(`Checkout page answered ${paid.status}: ${await paid.text()}`);
  say(`  hosted page: ${paid.status} -> ${paid.headers.get('location')}`);
  say(`  events: ${await newEvents()}`);

  const done = await stripe.checkout.sessions.retrieve(session.id, { expand: ['subscription'] });
  const sub = done.subscription;
  say(`session ${done.status} (${done.payment_status}); ${sub.id} ${sub.status} until ${date(sub.trial_end)}`);

  // The customer can manage the subscription in the portal.
  const portal = await stripe.billingPortal.sessions.create({ customer: done.customer });
  say(`portal: ${(await fetch(portal.url)).status} at ${portal.url.replace(server.url, '')}`);
  await newEvents();

  // Move past the trial: the renewal invoice is created, finalized an hour later and charged.
  const { now } = await account.advanceTime({ to: sub.trial_end + DAY });
  say(`advanced to ${date(now)}`);
  say(`  events: ${await newEvents()}`);

  const after = await stripe.subscriptions.retrieve(sub.id, { expand: ['latest_invoice'] });
  const item = after.items.data[0];
  say(`subscription ${after.status}, period ${date(item.current_period_start)} to ${date(item.current_period_end)}`);
  say(`invoice ${after.latest_invoice.number} ${after.latest_invoice.status}, paid ${money(after.latest_invoice.amount_paid)}`);

  if (after.status !== 'active' || after.latest_invoice.status !== 'paid') throw new Error('The subscription did not renew');
  if (rejected.length) throw new Error(`Webhooks failed verification: ${rejected.join('; ')}`);
  say(`${events.length} webhooks, all verified with constructEvent`);
  console.log(lines.join('\n'));
} finally {
  await server.close();
  receiver.close();
}
