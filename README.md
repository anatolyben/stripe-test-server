# stripe-test-server

`stripe-test-server` is a local test server for Stripe Billing. It keeps everything in memory, is
deterministic (the same steps give the same IDs) and is driven by the official
[`stripe`](https://www.npmjs.com/package/stripe) SDK: point the client at it with
`new Stripe(key, { host: '127.0.0.1', port, protocol: 'http' })` and your code runs unchanged.

It covers the subscription lifecycle end to end: customers, products and prices, Checkout in
subscription mode, subscriptions and their invoices, schedules, the customer portal, test clocks,
the events API and signed webhooks. The Checkout, portal and invoice pages are plain HTML forms your
test can submit. Time is yours to move: trials end, renewals charge, failed payments retry and
subscriptions cancel when the clock passes. Your test also plays everything else: declined cards,
API faults, and webhooks that arrive late, twice, out of order or badly signed.

Nothing here talks to Stripe, so tests need no Stripe account, API keys or network. Any
`sk_test_…` key works, and each key is its own account.

Not affiliated with, endorsed by, or sponsored by Stripe, Inc. Stripe is a trademark of Stripe, Inc.

## Install

```sh
npm install --save-dev stripe-test-server stripe
```

Requires Node.js 20 or newer. No runtime dependencies; bring your own `stripe` client (tested with
stripe-node 22.6.2).

## Quick start

```js
import Stripe from 'stripe';
import { createStripeTestServer } from 'stripe-test-server';

const server = await createStripeTestServer({
  // Your application's webhook endpoint and its signing secret.
  webhooks: [{ url: 'http://127.0.0.1:4000/stripe/webhook', secret: 'whsec_test_secret' }],
});
const stripe = new Stripe('sk_test_123', { host: '127.0.0.1', port: server.port, protocol: 'http' });
const account = server.account('sk_test_123'); // test actions for that key

const product = await stripe.products.create({ name: 'Pro' });
const price = await stripe.prices.create({
  product: product.id, unit_amount: 3000, currency: 'usd', recurring: { interval: 'month' },
});
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: price.id, quantity: 1 }],
  customer_email: 'jenny.rosen@example.com',
  subscription_data: { trial_period_days: 14 },
  success_url: 'https://app.example.com/welcome?session_id={CHECKOUT_SESSION_ID}',
});

// The customer pays on the hosted page: a plain form at session.url.
await fetch(session.url, {
  method: 'POST',
  redirect: 'manual', // 303 to success_url
  body: new URLSearchParams({ card_number: '4242424242424242' }),
});

// Your endpoint verifies each delivery as usual:
//   stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], 'whsec_test_secret')

// Fifteen days later the trial is over and the first $30 invoice is paid.
await account.advanceTime({ seconds: 15 * 86400 });
await server.settle(); // every webhook delivered

await server.close();
```

[`examples/checkout-trial.js`](examples/checkout-trial.js) runs this flow with a webhook receiver
that verifies every event with `constructEvent`, and prints a transcript:
`node examples/checkout-trial.js`.

## CLI

For tests written in another language, run the server on its own and drive it over HTTP:

```sh
npx stripe-test-server --port 4242 \
  --webhook-url http://localhost:4000/stripe/webhook --webhook-secret whsec_test_secret
```

| Flag                                    | Meaning                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `--port <n>`                            | Default `4242`. `--port 0` picks a free port.                                    |
| `--host <host>`                         | Default `127.0.0.1`.                                                             |
| `--api-version <v>`                     | Default API version of new accounts. Default `2026-08-26.dahlia`.                |
| `--webhook-url <url>`, `--webhook-secret <s>` | A webhook endpoint for every account; the secret must follow its URL. Repeat the pair for more endpoints. |
| `--log`                                 | One line per request, page and delivery; errors on stderr.                            |
| `-h`, `--help`                          | Usage.                                                                           |

Flags that take a value also take the `--flag=value` form. It prints `stripe-test-server listening on <url>` and exits
0 on `SIGINT` or `SIGTERM`. An unknown flag, a missing value, a value on `--log` or `--help`, a port
that is not an integer from 0 to 65535, or an unpaired webhook flag exits 2 with the usage text. The [Control API](#control-api) plays everyone else.

## Options

`createStripeTestServer(options)` (also the default export) returns a promise of the running server.

| Option                                  | Meaning                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `port`, `host`                          | Default `0` (any free port) and `127.0.0.1`.                                                                                         |
| `webhooks: [{ url, secret, apiVersion? }]` | Endpoints that receive the events of **every** account, signed with `secret`. `apiVersion` renders their events in that version (default: the account's). |
| `apiVersion`                            | Default API version of every account. Default `2026-08-26.dahlia`, the version stripe-node 22 sends.                                  |
| `billing: { retrySchedule?, afterFinalRetry?, markUncollectible? }` | What happens after a failed renewal. `retrySchedule`: days between retries (default `[2, 2, 2, 2, 2, 2, 2]`: 8 attempts within 14 days). `afterFinalRetry`: `"cancel"` (default), `"unpaid"` or `"past_due"`. `markUncollectible`: default `false`. Each account starts with a copy it can change. |
| `webhookRetry: { delaysMs?, timeoutMs? }` | Delays before each retry of a failed delivery (default `[500, 2000, 5000]`) and how long to wait for an answer (default `10000`). |
| `log`                                   | `true` prints one line per request, page and delivery attempt (method, path, status and request ID; event type, ID, URL and result); a function receives `{ level: 'info' \| 'error', message }` instead. |

An unknown option or a bad value throws a `TypeError`.

The server:

| Member              | Meaning                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `url`, `port`       | e.g. `http://127.0.0.1:53211`. Hosted pages live under the same origin.                                  |
| `account(key)`      | The [test actions](#test-actions) of the account of a `sk_test_…` or `rk_test_…` key (created on first use). Any other key throws a `TypeError`. |
| `accounts()`        | The keys seen so far.                                                                                    |
| `reset()`           | Resets every account.                                                                                    |
| `settle()`          | Resolves when no webhook delivery is queued, in flight or waiting to retry on any account (held ones excepted). |
| `close()`           | Closes the port and connections and clears every timer.                                                 |
| `context`           | Internals, not a stable API.                                                                             |

The module also exports `LATEST_VERSION` (`"2026-08-26.dahlia"`), `DEFAULT_BILLING_SETTINGS` and
`DEFAULT_WEBHOOK_RETRY`. TypeScript types are in `src/index.d.ts`.

## API

Every `/v1` call needs `Authorization: Bearer sk_test_…` (or `rk_test_…`; Basic auth works too).
Bodies are form-encoded, as the SDK sends them. Responses carry `Request-Id`, `Stripe-Version`
(the version used) and, on POST, the echoed `Idempotency-Key`.

| Resource                  | Calls                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Customers                 | create, retrieve, update, delete, list; `GET /v1/customers/:id/payment_methods` and `…/:pm`             |
| Products                  | create, retrieve, update, delete (only without prices), list                                           |
| Prices                    | create, retrieve, update, list (flat, tiered, metered, `currency_options`, `lookup_keys`)             |
| PaymentMethods            | retrieve, list, attach, detach. Cards come from `pm_card_*` aliases or the hosted pages (see [Test cards](#test-cards)). |
| PaymentIntents, Charges   | retrieve                                                                                               |
| Checkout Sessions         | create (`mode=subscription`), retrieve, update (`metadata`), list, expire, list line items             |
| Subscriptions             | create, retrieve, update, cancel (`DELETE`), resume, list                                              |
| Subscription items        | retrieve, list                                                                                         |
| Subscription schedules    | create (with `phases` or `from_subscription`), retrieve, update, cancel, release, list                 |
| Invoices                  | retrieve, list, list lines, finalize, pay, void, mark uncollectible                                    |
| Invoice payments          | retrieve, list                                                                                         |
| Billing portal            | configurations create, retrieve, update, list; sessions create (with `flow_data`)                       |
| Test clocks               | create, retrieve, list, delete, advance                                                                |
| Webhook endpoints         | create, retrieve, update, delete, list                                                                 |
| Events                    | retrieve, list (`type` with `*`, `types`, `created`, `delivery_success`)                               |

Lists paginate with `limit`, `starting_after` and `ending_before`, so the SDK's auto-pagination
works; `expand` works on every documented expandable field, up to four levels. Every request
parameter is checked against Stripe's OpenAPI spec for the request's API version: an unknown or
removed parameter answers 400 `invalid_request_error` with `code: parameter_unknown` and the
bracketed `param` (`items[0][foo]`), a missing one `parameter_missing`, a bad value names its
`param`. Errors use Stripe's envelope, so the SDK raises its usual error classes.

**Idempotency.** A POST with an `Idempotency-Key` saves its status and body for 24 hours of the
account clock. The same key with the same request replays them with `Idempotent-Replayed: true`;
with other parameters or another endpoint it answers 400 `idempotency_error`. Validation errors,
401s, 429s and faults are not saved, so a corrected retry goes through. Keys longer than 255
characters answer 400.

**Time.** Each account has a clock: real time plus an offset that `advanceTime` moves forward.
Everything due (trial ends, renewals, invoice finalization, payment retries, schedule phases,
Checkout and portal session expiry) runs in order before each request and during
`advanceTime`. Customers on a test clock live on that clock's frozen time instead, and move when
the clock is advanced through the API.

**Billing.** Subscriptions follow Stripe's status machine (`incomplete`, `trialing`, `active`,
`past_due`, `unpaid`, `canceled`, `incomplete_expired`, `paused`): upgrades and downgrades with
prorations, `cancel_at_period_end`, `cancel_at`, pausing collection, pending updates, trials and
both billing modes (`classic`, and `flexible`, the default from 2025-09-30.clover). Renewal
invoices stay drafts for an hour, then finalize and charge the default card; failures retry on the
account's `retrySchedule`, then cancel, go `unpaid` or stay `past_due`.

### Hosted pages

The pages need no API key; their URLs are the ones the API returns. Each is a plain HTML form that
posts `application/x-www-form-urlencoded` back to itself, so a browser or `fetch` can drive it.
Card fields on every page: `card_number` (required), `exp_month`, `exp_year`, `cvc`,
`cardholder_name`; the number must be one of the [test cards](#test-cards).

| Page                              | What it does                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout, `/c/pay/cs_test_…` (`session.url`) | GET shows the items, the amount due today, the trial and the fields the session asks for. POST completes the session: 303 to `success_url` with `{CHECKOUT_SESSION_ID}` filled in (`return_url` for embedded sessions), 402 with the page on a decline (the session stays open), 400 for missing fields, 409 once complete, 410 once expired. Other fields: `email` (when the session has no customer or `customer_email`), `phone`, `individual_name`, `business_name`, `address_*`, `shipping_*`, `custom_fields[key]`, `consent_terms`, `consent_promotions`, `quantity[li_…]` (adjustable quantities), `optional[i]` with `optional_quantity[i]`. |
| Portal, `/p/session/test_…` (`session.url`) | The configuration's enabled features: plan switch (`action=update_subscription` with `subscription`, `price`, `quantity`), cancel (`cancel_subscription` with `reason`, `comment`), renew (`renew_subscription`), new card (`update_payment_method` with the card fields), `set_default_payment_method` / `detach_payment_method` (`payment_method`), billing details (`update_customer`), invoice history. `flow_data` deep links open their screen. Actions answer 303 to the homepage or the flow's `after_completion`; an expired session answers 410. |
| Portal login, `/p/login/test_…` (`configuration.login_page.url`) | With `login_page.enabled`: an `email` opens a portal session for the most recent customer with that email.                                  |
| Invoice, `/i/acct_…/test_…` (`invoice.hosted_invoice_url`) | The invoice; while open, the card form pays it (303 back, 402 on a decline). `…/pdf` (`invoice.invoice_pdf`) is a plain-text rendering. |

### Test cards

Hosted pages take the number; API calls take the alias (`payment_method: 'pm_card_visa'`), and
every use of an alias mints a new PaymentMethod. Numbers may contain spaces or dashes. Any other
number is refused with `incorrect_number`.

| Number                | Alias                                    | Outcome                                                                  |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `4242424242424242`    | `pm_card_visa`, `pm_card_us`             | Visa, succeeds                                                           |
| `4000056655665556`    | `pm_card_visa_debit`                     | Visa debit, succeeds                                                     |
| `5555555555554444`    | `pm_card_mastercard`                     | Mastercard, succeeds                                                     |
| `2223003122003222`    |                                          | Mastercard 2-series, succeeds                                            |
| `5200828282828210`    | `pm_card_mastercard_debit`               | Mastercard debit, succeeds                                               |
| `5105105105105100`    | `pm_card_mastercard_prepaid`             | Mastercard prepaid, succeeds                                             |
| `378282246310005`     | `pm_card_amex`, `pm_card_amex_threeDSecureNotSupported` | American Express, succeeds                                |
| `371449635398431`     |                                          | American Express, succeeds                                               |
| `6011111111111117`    | `pm_card_discover`                       | Discover, succeeds                                                       |
| `6011000990139424`    |                                          | Discover, succeeds                                                       |
| `6011981111111113`    |                                          | Discover debit, succeeds                                                 |
| `3056930009020004`    | `pm_card_diners`                         | Diners Club, succeeds                                                    |
| `36227206271667`      |                                          | Diners Club (14 digits), succeeds                                        |
| `3566002020360505`    | `pm_card_jcb`                            | JCB, succeeds                                                            |
| `6200000000000005`    | `pm_card_unionpay`                       | UnionPay, succeeds                                                       |
| `6200000000000047`    |                                          | UnionPay debit, succeeds                                                 |
| `6205500000000000004` |                                          | UnionPay (19 digits), succeeds                                           |
| `4000000000000002`    | `pm_card_visa_chargeDeclined`            | Declined, `generic_decline`; cannot be attached                          |
| `4000000000009995`    | `pm_card_visa_chargeDeclinedInsufficientFunds` | Declined, `insufficient_funds`; cannot be attached                 |
| `4000000000009987`    | `pm_card_visa_chargeDeclinedLostCard`    | Declined, `lost_card`; cannot be attached                                |
| `4000000000009979`    | `pm_card_visa_chargeDeclinedStolenCard`  | Declined, `stolen_card`; cannot be attached                              |
| `4000000000000069`    | `pm_card_chargeDeclinedExpiredCard`      | `expired_card`; cannot be attached                                       |
| `4000000000000127`    | `pm_card_chargeDeclinedIncorrectCvc`     | `incorrect_cvc`; cannot be attached                                      |
| `4000000000000119`    | `pm_card_chargeDeclinedProcessingError`  | `processing_error`; cannot be attached                                   |
| `4000000000006975`    | `pm_card_visa_chargeDeclinedVelocityLimitExceeded` | Declined, `card_velocity_exceeded`; cannot be attached         |
| `4000000000000341`    | `pm_card_chargeCustomerFail`             | Attaches, then every charge is declined (`generic_decline`): failed renewals |
| `4000002500003155`    | `pm_card_authenticationRequiredOnSetup`  | 3D Secure unless set up on a hosted page: off-session charges stop at `requires_action` |
| `4000002760003184`    | `pm_card_authenticationRequired`         | Always 3D Secure: off-session charges stop at `requires_action`          |
| `4000003800000446`    | `pm_card_authenticationRequiredSetupForOffSession` | Authenticates on session only; off-session charges succeed     |
| `4000008260003178`    | `pm_card_authenticationRequiredChargeDeclinedInsufficientFunds` | Declined, `insufficient_funds`                    |

On the hosted pages the customer is present, so 3D Secure counts as completed there. Hosted pages
also check the typed expiry and CVC (`invalid_expiry_month`, `invalid_expiry_year`, `invalid_cvc`).

## Webhooks

Every event is delivered to each enabled endpoint that subscribes to its type: the server-wide
endpoints from the `webhooks` option, the account's endpoints from `setWebhookEndpoints`, and those
created with `POST /v1/webhook_endpoints` (up to 16, with `enabled_events`, `api_version`, and
`disabled` status).

- **Signed as Stripe signs.** `Stripe-Signature: t=<real unix time>,v1=<HMAC-SHA256 of "t.body">`,
  so `stripe.webhooks.constructEvent(rawBody, header, secret)` verifies it. The timestamp is real
  wall time even when the account clock or a test clock is far ahead. Verify the raw bytes: bodies
  are pretty-printed JSON, so a re-serialized body fails here as it does with Stripe.
- **Rendered per endpoint.** Each endpoint gets the event in its own `api_version`, else the
  account's default, never in the version of the request that caused it. The event ID is the same
  for every endpoint.
- **Retried.** A 2xx is a success. Anything else, a timeout (`webhookRetry.timeoutMs`) or a
  connection error is retried after `webhookRetry.delaysMs`, re-signed each time. The event's
  `pending_webhooks` counts automatic deliveries not yet answered with a 2xx, and
  `GET /v1/events?delivery_success=false` finds them.
- **In order per endpoint.** Each endpoint receives one request at a time, first attempts in the
  order the events happened. Stripe guarantees no order; use `webhooks.hold()` and `release()` to
  test reordering.
- **Outside the request.** Deliveries start after the response is sent, so a receiver may call the
  API back. `server.settle()` or `webhooks.settle()` waits for them.

Events carry `request: { id, idempotency_key }` for API calls and `request.id: null` for work done
by time, hosted pages and test actions. `*.updated` events carry `previous_attributes`.

## Test actions

`server.account(key)` returns the actions for one account. Each returns a promise of JSON and is
also an HTTP route under `/_test/` (next sections). Invalid input rejects with an `Error` named
`StripeError` that has `status`, `type`, `param` and sometimes `code`.

| Action                                                                                 | What happens                                                                                                                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `key`, `id`                                                                            | The API key and the account's `acct_…` ID (it appears in hosted invoice URLs).                                                     |
| `reset()`                                                                              | Clears the account: objects, clock, events, idempotency keys, requests, faults, Billing settings and its own webhook endpoints. `{ reset: true }` |
| `advanceTime({ seconds })` or `advanceTime({ to })`                                    | Moves the account clock forward and runs everything due on the way, in order. `{ now }`                                            |
| `now()`                                                                                | `{ now }`: the account clock, unix seconds.                                                                                        |
| `state({ type?, raw? })`                                                               | `{ now, clocks, objects, jobs, events }`: every object by type (rendered at the account's version, or internal copies with `raw: true`), the pending time-driven transitions soonest first, the test clocks and the number of events. |
| `requests({ limit?, method?, path? })`                                                 | The `/v1` request ledger, oldest first: method, path, parsed query and body, status, version, idempotency key, `replayed`, `fault`, account time, real time and duration. Keys, webhook secrets and card numbers are redacted. `path` may end in `*`. |
| `faults.add(spec)`, `faults.list()`, `faults.clear()`                                  | See [Faults](#faults).                                                                                                             |
| `billingSettings()`, `updateBillingSettings(patch)`                                    | The account's `{ retrySchedule, afterFinalRetry, markUncollectible }`.                                                             |
| `deleteCustomer(customerId)`                                                           | Deletes a customer as the Dashboard would: its cards are detached, its subscriptions end, events carry `request: null`. Returns the deleted stub. |
| `failNextCharge(customerId, { times?, declineCode? })`                                  | The next `times` (default 1) payment attempts for the customer are declined with `card_declined` and `declineCode` (default `generic_decline`; any Stripe decline code), whatever the card. `{ customer, remaining, declineCode }` |
| `createSubscription(customerId, { price, quantity?, trialDays?, paymentMethod? })`     | Creates a live subscription directly, e.g. a second one next to a Checkout signup. Without `paymentMethod` (an ID or `pm_card_*` alias) it charges the customer's default card, else the card of their newest subscription, else their newest card. Returns the subscription. |
| `setWebhookEndpoints([{ url, secret, apiVersion? }])`                                   | Replaces this account's control-added endpoints; server-wide and API-created ones stay. Returns the endpoint records.             |
| `webhooks.deliveries({ eventId?, eventType?, endpointId?, status?, kind?, limit? })`    | Delivery records, oldest first, each with every attempt: time, URL, signature timestamp, response status and the first 2000 characters of the response. |
| `webhooks.resend(eventId)`                                                             | Sends the event once more to every subscribed endpoint.                                                                            |
| `webhooks.deliverDuplicate(eventId)`                                                   | Sends it twice more (same ID and body, new signatures).                                                                            |
| `webhooks.sendWithBadSignature(eventId)`                                               | Sends it with a `v1` signature made with another secret: `constructEvent` must reject it.                                          |
| `webhooks.hold()`, `webhooks.release({ order? })`                                       | Keep every delivery (retries too) back, then send them in the order made (`"fifo"`, the default), `"reverse"`, or with the listed event IDs first. |
| `webhooks.settle()`                                                                    | Resolves with `{ settled: true }` when nothing is queued, in flight or waiting to retry (held deliveries excepted).                |

Manual deliveries (resend, duplicate, bad signature) are one attempt each, never retried, and do
not change `pending_webhooks`. Delivery `kind` is `automatic`, `resend`, `duplicate` or
`bad_signature`; `status` is `queued`, `held`, `in_flight`, `retrying`, `succeeded`, `failed` or
`canceled`.

The flows a Billing integration has to handle, and how to play them:

| Flow                                   | How                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Checkout with or without a trial       | `checkout.sessions.create`, then POST the hosted page with a card.                                   |
| Upgrade, or downgrade now              | `subscriptions.update` with new `items`, or the portal's plan switch.                                |
| Downgrade at period end                | A portal configuration with `subscription_update.schedule_at_period_end`, then the portal's plan switch; release the schedule with `subscriptionSchedules.release`, or let `advanceTime` apply it at renewal. |
| Cancel at period end, then renew       | `cancel_at_period_end: true` (or the portal's cancel), then `false` (or the portal's renew).         |
| Cancellation taking effect             | `advanceTime` past the period end: `customer.subscription.deleted`.                                  |
| Failed renewal, recovery or cancel     | Card `4000000000000341` or `failNextCharge`, `advanceTime` to the renewal: `past_due`; pay the invoice (`invoices.pay`, hosted invoice page, new card in the portal) to recover, or advance through the retries to cancel. |
| Customer deleted elsewhere             | `deleteCustomer`.                                                                                    |

## Faults

`faults.add({ path, method?, times?, kind, timeoutMs? })` makes the next `times` (default 1) `/v1`
requests of the account that match `method` (default any) and `path` (exact, or a prefix ending in
`*`, e.g. `/v1/subscriptions*`) fail. Faults act before idempotency and validation, so the request
is never executed.

| `kind`      | Answer                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `"500"`     | 500 `api_error`. The SDK retries 5xx when `maxNetworkRetries` allows, so `times` decides how many attempts fail. |
| `"429"`     | 429 `code: rate_limit` with `Stripe-Rate-Limited-Reason: global-rate`.                                  |
| `"timeout"` | No answer; the connection is held until the client gives up (with the SDK's `timeout` you get `StripeConnectionError`). With `timeoutMs` (0 to 2147483647) it is dropped after that many ms instead; the SDK retries a dropped connection once even with `maxNetworkRetries: 0`, so `times` must cover it. |

`faults.list()` shows each fault with `remaining`; `faults.clear()` returns `{ cleared }`.

## Control API

The test actions over HTTP. Every route lives under `${url}/_test/`, needs the same
`Authorization: Bearer <key>` as the API (it acts on that key's account), takes a JSON body (GET:
query string) and returns JSON. Refusals use Stripe's error envelope: 401 for a missing or invalid key,
404 for an unknown route, 400 for invalid input or an unknown customer, price or event
(`resource_missing` on that field).

| Route                                        | Action                                                  |
| -------------------------------------------- | ------------------------------------------------------- |
| `POST reset`                                 | `reset`                                                 |
| `POST advance_time`                          | `advanceTime` `{ seconds }` or `{ to }`                 |
| `GET now`                                    | `now`                                                   |
| `GET state`                                  | `state` `?type=&raw=true`                               |
| `GET requests`                               | `requests` `?limit=&method=&path=`                      |
| `POST faults`, `GET faults`, `DELETE faults` | `faults.add`, `faults.list`, `faults.clear`             |
| `GET billing_settings`, `POST billing_settings` | `billingSettings`, `updateBillingSettings`           |
| `POST delete_customer`                       | `deleteCustomer` `{ customer }`                         |
| `POST fail_next_charge`                      | `failNextCharge` `{ customer, times?, declineCode? }`   |
| `POST create_subscription`                   | `createSubscription` `{ customer, price, quantity?, trialDays?, paymentMethod? }` |
| `PUT webhook_endpoints`                      | `setWebhookEndpoints` `{ endpoints: [...] }`            |
| `GET webhooks/deliveries`                    | `webhooks.deliveries` `?eventId=&eventType=&endpointId=&status=&kind=&limit=` |
| `POST webhooks/resend`                       | `webhooks.resend` `{ eventId }`                         |
| `POST webhooks/deliver_duplicate`            | `webhooks.deliverDuplicate` `{ eventId }`               |
| `POST webhooks/send_with_bad_signature`      | `webhooks.sendWithBadSignature` `{ eventId }`           |
| `POST webhooks/hold`, `POST webhooks/release`| `webhooks.hold`, `webhooks.release` `{ order? }`        |
| `POST webhooks/settle`                       | `webhooks.settle`                                       |

```sh
curl -X POST http://127.0.0.1:4242/_test/advance_time \
  -H 'Authorization: Bearer sk_test_123' -H 'Content-Type: application/json' -d '{"seconds": 2678400}'
```

## Isolation

Each secret key is its own account: `sk_test_a`, `sk_test_b` and `rk_test_a` share nothing. Objects,
IDs, the clock, events, idempotency keys, the request ledger, faults, Billing settings and
account-level webhook endpoints are kept apart, and one account's IDs answer `resource_missing` in
another. Hosted page URLs carry a token that belongs to one account. IDs are derived from the key
and a counter, so a fresh account (or one after `reset()`) gives the same IDs for the same steps.

The endpoints from the `webhooks` option receive the events of every account. For one receiver per
account, give each account its own with `setWebhookEndpoints` or `POST /v1/webhook_endpoints`.

Requests of one account run one at a time, so concurrent calls give deterministic results; accounts
do not wait for each other.

## API version

The default is **2026-08-26.dahlia**, the version stripe-node 22 sends. A request's
`Stripe-Version` (the SDK's `apiVersion` option, or per request) picks another; the account default
comes from the `apiVersion` option. Accepted: every version in stripe-node 22.6.2's `ApiVersion`
list, plus `YYYY-MM-DD.preview` for monthly releases from 2025-04-30. Anything else answers 400
before the request runs.

Responses and events take the shape of their version, in three families:

| Versions                             | Shape                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Before 2025-03-31.basil (2024-06-20 shapes) | `subscription.current_period_start` / `current_period_end`; `invoice.subscription`, `invoice.paid`, `invoice.charge`, `invoice.payment_intent`; invoice lines with `price`, `plan`, `proration`; items with a legacy `plan`. Checkout declines leave an `incomplete` subscription. |
| 2025-03-31.basil to 2025-09-30.clover | Periods on each subscription item (`items.data[].current_period_*`); `invoice.parent.subscription_details.subscription`; line `pricing` and `parent`; invoice `payments` on expand. A declined Checkout creates nothing. |
| 2025-09-30.clover and later          | As basil; new subscriptions default to `billing_mode: flexible`, and later additions (such as line `subtotal`, `quantity_decimal`) appear from their version. |

Parameters are gated the same way: a parameter the version does not have is refused like an
unknown one (`parameter_unknown`). Examples: `features[subscription_update][schedule_at_period_end]`
on portal configurations needs 2024-10-28.acacia or later, `trial_update_behavior` needs
2025-09-30.clover, `billing_mode` needs 2025-06-30.basil, `billing_schedules` 2026-05-27.dahlia;
singular `coupon` / `promotion_code` and `recurring[aggregate_usage]` end at basil and schedule
`phases[][iterations]` at clover; Checkout's `ui_mode` values changed at 2026-03-25.dahlia
(`hosted`/`embedded` before, `hosted_page`/`embedded_page`/`elements`/`form` from then). Before
2024-10-28.acacia portal configurations need `business_profile`. `expand[]=total_count` works on
lists only before basil.

Behaviour was built from Stripe's API reference, changelog and OpenAPI spec, reviewed 2026-09-30.
2026-09-30.endive is not accepted yet.

## Uncertain behaviour

Where Stripe's documentation, OpenAPI spec and SDK leave a behaviour open, this server makes the
choice below. A test that depends on one of these checks this server, not Stripe; confirm it
against Stripe before relying on it. Error message texts are Stripe-like but not Stripe's: assert
on `type`, `code` and `param`.

### Wire, errors and versions

- **401 bodies**: `invalid_request_error` with no code ("You did not provide an API key…" or
  "Invalid API Key provided: sk_test_****1234"). A publishable key answers 401 with
  `code: secret_key_required`; live keys are refused like invalid ones.
- **`Stripe-Account` and `Stripe-Context` headers**: 400, since Connect is not modelled and ignoring
  them would act on the wrong account.
- **Unknown `Stripe-Version`**: 400 `invalid_request_error` without code or param. Accepted are
  stripe-node 22.6.2's `ApiVersion` list and the `.preview` versions of its release dates from
  2025-04-30; 2026-09-30.endive is refused while Stripe's docs do not publish it. Versions older
  than 2024-06-20 get the 2024-06-20 shapes.
- **Unknown URLs**: 404 `invalid_request_error`, "Unrecognized request URL (GET: /v1/foo). …";
  only that prefix is documented.
- **Newer optional parameters on older versions**: accepted, except the documented gates and removed
  parameters; Stripe treats new optional parameters as backward-compatible.
- **`""` on a parameter the spec does not mark as clearable**: 400 `parameter_invalid_empty`.
- **Bad enum values, booleans, decimals, over-long strings, metadata over its limits** (50 keys,
  40-character keys, 500-character values): 400 with `param` and no code. Enums the spec lets SDKs extend are still checked as closed lists (except
  webhook endpoint `api_version`).
- **An unknown ID in the body or query**: 400 `resource_missing` with that `param`; an unknown ID in
  the URL gives 404 with `param: id`.
- **Idempotency**: "the same request" means the same method, path and parameters (key order
  ignored, `expand[]` equal to `expand[0]`). A mismatch is 400 `idempotency_error` without code.
  A replay has the saved status and body with a new `Request-Id`. Concurrent requests with one key
  never see 409, because an account's requests run one at a time. A key over 255 characters is
  400 `idempotency_error` and is not saved.
- **Error bodies**: keys sorted and null fields left out; coded errors carry
  `doc_url` = `https://docs.stripe.com/error-codes#<code-with-hyphens>` and API errors
  `request_log_url`, as in Stripe's error examples.
- **Lists**: `limit` outside 1–100 is 400 on `limit`; both cursors `parameters_exclusive`; an unknown
  cursor `resource_missing` on the cursor. Objects created in the same second are listed newest
  first in creation order. An `ending_before` page holds the `limit` items just newer than the
  cursor, newest first, and `has_more` tells whether newer ones remain, as the SDK's reverse
  auto-pagination expects. Embedded lists (`subscription.items`, `invoice.lines`) hold up to 10
  items and always carry `total_count`; top-level lists never do.
- **Expand**: only expanding hops count toward the limit of four, so Stripe's five-segment invoice
  paths work. Paths are checked before the request runs, so a bad one (unknown, not expandable,
  or a field the request's version lacks) is 400 on `expand` and changes nothing;
  `expand[]=total_count` from basil is 400 with `property_forbidden` in the message. Event payloads
  stay minimal, so `data.object.*` cannot be expanded on events. Expanding a null reference leaves
  it null.
- **IDs**: prefix plus 24 letters and digits (`cus_…`, `cs_test_…`); request IDs `req_` plus 14.
- **Unexpected server errors**: 500 `api_error` with `Stripe-Should-Retry: false`.

### Customers, catalog and payments

- **Deleted customers**: GET returns `{ id, object: 'customer', deleted: true }`; a second DELETE
  or an update is 404; using the customer elsewhere is 400 `resource_missing`. Its cards are
  detached silently. `customer.deleted` carries the customer as it was.
- **`customer.updated`, `product.updated`**: sent only when something visible changed.
- **Nested hashes on update** (e.g. only `address[city]`): merged; `""` clears one key.
- **Generated `invoice_prefix`**: 8 uppercase hex characters; a sent one must be 3–12 uppercase
  letters or digits and unique in the account. Invoice numbers are `PREFIX-0001`, counted per
  customer; the counter moves without `customer.updated`.
- **Creating a customer with `payment_method`**: `payment_method.attached` comes before
  `customer.created`, which already shows the default. `invoice_settings[default_payment_method]`
  naming the same `pm_card_*` alias resolves to that one new PaymentMethod.
- **`business_name`, `individual_name`**: returned from 2025-09-30.clover, and only when set.
- **Includable customer fields**: `tax` is `{ automatic_tax: 'unrecognized_location',
  ip_address: null, location: null }` (plus `provider: 'stripe'` from clover); `cash_balance` is
  null, `invoice_credit_balance` `{}`, `sources` and `tax_ids` empty lists. Tax and balances are
  not modelled.
- **Legacy sources** (`source`, `card`, `default_source`): refused with 400.
- **Products**: a taken custom `id` is 400 `resource_already_exists`; deleting a product with prices
  (archived and inline ones too) is 400. `default_price` must be a price of the same product. With
  `default_price_data`, `product.created` (already showing `default_price`) comes before
  `price.created`.
- **Lookup keys**: unique among all prices of the account, archived ones included; a taken key
  without `transfer_lookup_key` is 400 on `lookup_key`. A transfer sends `price.updated` for the
  price that loses the key before the new price's event.
- **`GET /v1/prices` without `active`**: active prices only. Inline prices (`price_data`) are
  retrievable but never listed and send no `price.created`.
- **Price amounts**: `unit_amount_decimal` is normalized, and `unit_amount` is set only when it is
  a whole number; negative amounts are 400 (`parameter_invalid_integer` for integer ones); a
  metered price needs `recurring[meter]` from basil, while 2024-06-20 creates a legacy metered
  price (`aggregate_usage: sum`).
- **Tiered prices**: `tiers` and `tiers_mode` are required with `billing_scheme=tiered` and refused
  without it; the last tier must be `up_to=inf` and the bounds must increase.
- **Expanding prices**: `currency_options` lists the price's own currency first, and an option
  cannot redefine it; `tiers` is null on a per-unit price.
- **Archived prices** (or prices of archived products) where something new is bought: 400 on that
  param.
- **Card details the docs do not state**: decline cards are US Visa credit cards; the 3D Secure
  cards take the country in their number (FR, DE, IT, GB); JCB is JP; UnionPay has no country;
  other cards are US credit cards unless labelled debit or prepaid.
  Alias cards and typed cards without a date expire 12/2034. `fingerprint` is derived from the
  number.
- **Attaching**: a card that simulates an issuer decline answers 402 with its code and stays
  unattached; a card held by another customer, or detached, answers 400; attaching it again to its
  own customer is a no-op. Detaching a card that is not attached is 400. Detaching the default
  card clears `invoice_settings.default_payment_method` with `customer.updated`.
- **`GET /v1/payment_methods` without `customer`**: every PaymentMethod of the account.
- **`allow_redisplay`**: `limited` for cards typed on hosted pages, `unspecified` for API attaches.
- **Off-session 3D Secure**: "always authenticate" cards, and "unless set up" cards attached through
  the API, stop at `requires_action` (`next_action.type: use_stripe_sdk`, error
  `authentication_required`, no Charge).
- **Invoice PaymentIntents**: `capture_method: automatic`, `payment_method_types: ['card']`; after a
  decline `payment_method` is null and the card stays in `last_payment_error.payment_method`;
  `last_payment_error` is null while `requires_action`.
- **Charges**: `balance_transaction`, `receipt_url` and `calculated_statement_descriptor` are null,
  and `refunds` is an empty list when expanded. A declined charge's `outcome` is
  `issuer_declined`, `network_status: declined_by_network`, the decline code as `reason` and
  "The bank returned the decline code `<reason>`." as `seller_message`. `charge.*` events come
  before `payment_intent.*` events.
- **Card error messages**: "Your card was declined." for every `card_declined`, "Your card's
  security code is incorrect." for `incorrect_cvc`; others use the first sentence of the code's
  description.
- **Typed cards on hosted pages**: an unknown number is 402 `incorrect_number`; a month outside
  1–12 or earlier this year is `invalid_expiry_month`; a past year (two-digit years read within
  50 years of now) is `invalid_expiry_year`; a CVC that is not 3–4 digits is `invalid_cvc`.

### Checkout

- **Modes**: only `subscription`; `payment` and `setup` answer 400 on `mode`.
- **Completing**: only through the hosted page; Stripe has no completion API either.
- **Required and refused parameters**: `success_url` is required for hosted sessions; embedded and
  form sessions need `return_url` (unless `redirect_on_completion` is `never` or `if_required`) and
  refuse `success_url` / `cancel_url`; `permissions` and `redirect_on_completion` are refused on
  hosted sessions; `customer` with `customer_email` is `parameters_exclusive` on
  `customer_email`, as are `trial_end` with `trial_period_days`; `customer_creation` is refused in
  subscription mode (the object shows `always`), and so is
  `subscription_data[pending_invoice_item_interval]`. `success_url`, `cancel_url` and `return_url`
  must be absolute http(s) URLs (400 `url_invalid` on that field).
- **Limits**: `trial_period_days` 1–730; `trial_end` 48 hours to 730 days ahead;
  `billing_cycle_anchor` in the future and at most one period ahead; `expires_at` 30 minutes to
  24 hours ahead (default 24 hours).
- **Line items**: quantity defaults to 1; metered prices take none. `adjustable_quantity` defaults to
  0–99 and the page lets the customer change it (0 removes the item; one recurring item must
  stay). Mixed currencies are 400; recurring items with different intervals are refused in classic
  billing mode.
- **Unmodelled IDs**: coupons, promotion codes, tax rates, shipping rates and payment method
  configurations answer 400 `resource_missing`; `allow_promotion_codes` is echoed, but no code can
  be entered. `automatic_tax[enabled]` is echoed with no tax. `payment_method_types` must include
  `card`, and `excluded_payment_method_types` must not.
- **Amounts**: `amount_subtotal` / `amount_total` are the amount due today: 0 during a free trial
  (one-time items still count), prorated up to a future anchor (recurring items count 0 with
  `proration_behavior=none`). Line items keep price × quantity. A customer credit balance reduces
  the first charge but not the session's amounts.
- **`payment_status`**: `paid` after completion, also for a $0 trial invoice;
  `no_payment_required` when payment waits for a future anchor without proration.
- **Declines**: from basil nothing is created and the session stays open (402 page). On 2024-06-20
  versions the customer and an `incomplete` subscription with an open invoice are created, and a
  later card on the same session pays it.
- **The customer and the card**: the customer is created at completion from the page's email, name,
  phone and addresses. The card becomes the subscription's `default_payment_method`; the customer's
  default is left unchanged. `customer_update: auto` copies name and addresses to an existing
  customer; an existing customer without an email gets the entered one.
- **After completion**: `payment_intent` is the first invoice's PaymentIntent from basil (null
  before, and when nothing was charged). `customer_details` is filled from the page, with empty
  `tax_ids`; `collected_information` only when shipping or names were collected;
  `currency_conversion` is null.
- **Event order at completion**: `customer.created`, `payment_method.attached`, the subscription,
  invoice and payment events, then `checkout.session.completed`.
- **Updates and expiry**: `POST /v1/checkout/sessions/:id` changes `metadata` only (`line_items`,
  `shipping_options` and `collected_information` are 400); expiring a session that is not open is
  400; `after_expiration[recovery]` is echoed but no recovery URL is made. Sessions of a customer
  on a test clock take `created` and `expires_at` from the clock and expire on its time.
- **`{CHECKOUT_SESSION_ID}`**: replaced only when written exactly like that.

### Customer portal

- **The default configuration**: the first configuration an account creates is its default; no
  parameter changes that. A session without `configuration` and no default is 400; an inactive
  configuration is 400 on `configuration`; a session needs `return_url` unless the configuration
  has `default_return_url`.
- **Configuration shape**: the full current shape at every version.
  `subscription_update.billing_cycle_anchor` is null when unset and applied as `unchanged`;
  `products` is `[]` and returned only when expanded; a product entry without
  `adjustable_quantity` shows `{ enabled: false, minimum: 1, maximum: null }`.
- **Configuration updates**: nested objects merge, arrays are replaced, only sent keys change;
  `updated` moves only when something changed.
- **Unmodelled IDs and URLs**: payment method configurations, feedback options and coupons are 400
  `resource_missing`. `default_return_url`, `return_url`, business profile and redirect URLs must
  be absolute http(s) URLs (400 `url_invalid`).
- **Refused settings**: `subscription_cancel[proration_behavior]=always_invoice`, or
  `create_prorations` with `mode=at_period_end`; more than 10 products; prices that are not active
  recurring prices of their product, or two with the same interval.
- **Flows**: the flow's feature must be enabled; the subscription must belong to the customer, be
  live and have no schedule; update flows need one licensed, automatically charged item; each
  failure is 400 with a `param` inside `flow_data`; a branch or `after_completion` object of
  another type is 400 on that object. `customer_update` flows need 2026-08-26.dahlia. A flow
  without `after_completion` gets `hosted_confirmation` with `custom_message: null`. While a flow is open its page
  allows only the flow's action on the flow's subscription (anything else is 403); once it
  completes every action is 403 unless `after_completion` is `portal_homepage`.
- **Session expiry**: 5 minutes after creation unless used, then 1 hour after the last page view,
  on the account clock (`advanceTime` counts, test clocks do not); an expired page answers 410.
- **Plan changes**: applied at once with the configuration's `proration_behavior` (default `none`),
  `billing_cycle_anchor` and `trial_update_behavior` (default `end_trial`). A declined payment
  changes nothing (as `payment_behavior=error_if_incomplete`): the card error shows on the confirm
  screen with status 402. An `incomplete` subscription offers no cancel.
- **Scheduled downgrades**: only between prices of the same product and not during a trial.
  `decreasing_item_amount` compares yearly cost, `shortening_interval` a shorter interval at the
  same quantity. The schedule keeps the current items to the period end, then bills the new item
  for one interval, then releases. A subscription with a schedule offers no plan change or cancel.
- **Cancel and renew**: the chosen reason becomes `cancellation_details.feedback`, the free text
  `comment`. Renewing clears the period-end cancellation.
- **Cards**: a new card is attached, becomes the customer's default, and replaces the card on
  subscriptions that had their own. Cards that are neither the default nor a subscription's card
  can be removed.
- **Billing information**: only the `allowed_updates` fields can change; tax IDs are not offered.
- **Login page**: opens a session for the most recent customer with that email and a live
  subscription (else the most recent with that email); no email is sent.

### Subscriptions and invoices

- **Event order of a direct create that charges**: `customer.subscription.created` (`incomplete`),
  the invoice events, then `customer.subscription.updated` to `active`.
- **`error_if_incomplete`**: the payment is tried before anything changes; a decline answers 402 and
  leaves only a canceled PaymentIntent.
- **No usable card** (create with `error_if_incomplete`, `invoices.pay`): 400.
- **`invoice.updated`**: after every payment attempt, following `invoice.paid` or
  `invoice.payment_failed`. A $0 invoice is finalized as `open` and paid at once, with no
  `invoice.payment_succeeded`. `invoice_payment.paid` is sent only when the account's version is
  2025-05-28.basil or later.
- **Draft window**: renewal, trial-end and schedule invoices finalize exactly one hour after
  creation, whatever happened to the webhooks (`webhooks_delivered_at` equals `created` on every
  invoice). `POST /v1/invoices/:id/finalize` with `auto_advance` collects at the later of now and
  that hour.
- **Retries**: on the account's `retrySchedule`. `attempt_count` counts the first attempt and then
  automatic ones; later manual `pay` calls do not count. Hard declines (`lost_card`,
  `stolen_card`, …) keep counting retries but charge nothing until the payment method changes. A
  direct create's first invoice and failed `always_invoice` or anchor-reset invoices are not
  retried; an update's failure moves the subscription to `past_due`.
- **After the final retry**: `cancel` (reason `payment_failed`), `unpaid` or stay `past_due`. With
  `markUncollectible` the invoice becomes `uncollectible` but still counts as outstanding.
- **`customer.delinquent`**: true after a failed automatic attempt or a passed `send_invoice` due
  date; false after any successful payment or an API `mark_uncollectible`.
- **Back to `active`**: paying, voiding or marking uncollectible the most recent invoice of a
  `past_due` or `unpaid` subscription. Voiding the first invoice of an `incomplete` one expires it.
- **`incomplete_expired`**: sets `ended_at`; when the 23 hours run out,
  `customer.subscription.updated` comes before `invoice.voided`.
- **`unpaid` and `pause_collection[behavior]=keep_as_draft`**: later renewal invoices stay drafts
  with `auto_advance` false; `void` and `mark_uncollectible` finalize the invoice first.
- **`customer.subscription.trial_will_end`**: three days before `trial_end`, or at once when a trial
  ends within three days or is ended early.
- **`billing_reason`**: `subscription_cycle` for renewals and trial ends; `subscription_update` for
  `always_invoice`, anchor resets, `trial_end=now`, resumes and `invoice_now` cancellations.
- **Prorations**: per line, to the second, rounded half away from zero; descriptions like "Unused
  time on Pro after 01 Sep 2020" and "Remaining time on 2 × Pro after …" (the quantity shown above
  1). Flexible mode credits what was last billed; classic the current price.
- **Interval changes, or free to paid, in classic mode**: the anchor resets to now and a full period
  is charged at once (the credit for unused time is skipped with `proration_behavior=none`).
  Flexible mode keeps the anchor and gives the new item the anchor-aligned period of its interval.
  `billing_cycle_anchor=now` in flexible mode works like classic.
- **`trial_end` on an `active` subscription**: it becomes `trialing` until then; unused time is
  credited per `proration_behavior`. No $0 trial invoice is created (with `always_invoice` the
  credit is invoiced at once).
- **Cancellation**: `cancel_at_period_end=true` sets `cancel_at` to the period end; in flexible mode
  the portal instead sets `cancel_at` to the latest item period end. `cancel_at` in the past is
  400. `canceled_at` and `cancellation_details.reason` (`cancellation_requested`) are set at the
  request and cleared on renew.
  A `cancel_at` before the period end credits the rest, and moving it withdraws the credit. A
  `cancel_at` in a later period shortens that period: its renewal bills a proration up to
  `cancel_at`, and the item period ends there. Pending
  invoice items are charged on a final invoice at a period-end cancel, and
  `customer.subscription.deleted` shows that invoice as `latest_invoice`. An immediate cancel with
  `invoice_now` makes a final invoice only when there are pending items (such as `prorate`
  credits), and `customer.subscription.deleted` shows it too.
- **Updates of ended subscriptions** (other than `metadata`, `cancellation_details`), of `incomplete`
  ones (other than `metadata`, `default_payment_method`), and DELETE of a canceled one: 400 on the
  first refused parameter.
- **Default list**: leaves out `canceled` only (includes `incomplete_expired`).
- **Trial end without a card** and `missing_payment_method=cancel`: canceled with reason
  `cancellation_requested`.
- **Resume**: the invoice is finalized without a payment attempt; the subscription stays `paused`
  with a `pending_update` until it is paid (then `customer.subscription.resumed` and `.updated`),
  and the invoice is voided after 23 hours.
- **`pending_if_incomplete`**: a failed payment keeps the old items with `pending_update`, applied
  (`customer.subscription.pending_update_applied`) when the invoice is paid, or expired
  (`customer.subscription.pending_update_expired`, invoice voided) after 23 hours or at the period
  or trial end, whichever comes first.
- **Customer balance**: applied at finalization (a credit up to the total, a debit in full) with
  `customer.updated`; an amount below the currency minimum is marked paid with `amount_due` 0 and
  carried to the balance. `customer.currency` is set by the first subscription.
- **Hosted invoice page**: paying there attaches the card to the customer without making it a
  default.
- **`billing_schedules`**: a non-empty value is 400; billing schedules are not modelled.
- **`account_country` / `account_name`**: `"US"` / null.
- **`invoiceitem.created`**: for proration items and `add_invoice_items`, not for one-time items on a
  new subscription's first invoice.
- **`backdate_start_date`**: the first invoice bills every period from the backdated start, the
  first one prorated.
- **`billing_cycle_anchor`**: in the future, not before `trial_end`, at most one interval ahead.
- **Invoice lines from basil**: still carry the nullable top-level `subscription`, as the spec lists
  it.

### Schedules and test clocks

- **A schedule that starts at creation**: the subscription and its first invoice come first, then
  `subscription_schedule.created`.
- **End of the last phase**: status `completed` with `subscription_schedule.completed` for either end
  behaviour; `release` leaves the subscription running, `cancel` cancels it (reason
  `cancellation_requested`) at the phase end like a period-end cancel (pending prorations go on a
  final invoice). `released` only comes from the
  release endpoint.
- **`subscription_schedule.expiring`**: seven days before the last phase ends, unless the schedule
  was created or changed later than that.
- **Entering a phase**: `subscription_schedule.updated`, then `customer.subscription.updated`, then
  any invoice. With `end_behavior=cancel` the last phase sets `cancel_at`.
- **Direct updates of a scheduled subscription**: allowed; new items and the trial end are copied
  into the current phase.
- **Releasing**: a `cancel_at` the schedule set is cleared unless `preserve_cancel_date`, in a
  second `customer.subscription.updated` after the one that clears `schedule`.
- **Canceling**: `subscription_schedule.canceled`, then the subscription's events; dunning
  cancellation gives `subscription_schedule.aborted`.
- **`from_subscription`**: one phase for the current period (from the trial start while trialing)
  with the subscription's items, `end_behavior=release`; its collection method and default payment
  method go into `default_settings`.
- **Advancing a test clock**: everything due runs inside the advance request; the response shows
  `advancing`, and the clock turns `ready` (with `test_helpers.test_clock.ready`) on the next tick
  or before the account's next request. Advancing while `advancing`, backwards or past the limit is
  400 on `frozen_time`. The limit is two intervals of the shortest price on the clock (intervals
  compared by average length), else two years.
- **Test clock events**: stamped with the clock's time (`created` at the initial `frozen_time`,
  `advancing` at the old time, `ready` at the target, `deleted` at the time it was deleted on), and
  listed by `GET /v1/events`.
- **`customer` on clock create**: only a customer with at most three live subscriptions plus
  not-started schedules, and only when `frozen_time` is not in the past; the customer gets
  `customer.updated`, and its subscriptions, schedules and invoices move onto the clock.
- **`deletes_after`**: 30 days after creation, but clocks are never deleted automatically.
- **Deleting a clock**: its not-started schedules are canceled, its customers deleted (their
  subscriptions end at once with reason `cancellation_requested` and no final invoice), then
  `test_helpers.test_clock.deleted`.

### Events and webhooks

- **`request`**: null for events caused by time, hosted pages and test actions. Events of objects
  on a test clock carry the clock's time in `created`.
- **Transitions due in the same second**: run in time order, then schedule phase,
  `trial_will_end`, trial end, `cancel_at`, renewal, finalization, retry, incomplete expiry,
  Checkout expiry, then the order they were scheduled in.
- **`previous_attributes`**: computed per version from the object before and after; left out of
  events that are not `*.updated`.
- **Automatic work** (renewals, retries) renders objects in the account's default version.
- **`invoice.upcoming`**: never sent.
- **`/v1/events`**: `type` with `types` is `parameters_exclusive`; more than 20 `types` is 400;
  `delivery_success=true` matches events with no endpoint.
- **Headers**: `Content-Type: application/json; charset=utf-8`,
  `User-Agent: Stripe/1.0 (+https://stripe.com/docs/webhooks)`; `Stripe-Signature` has no `v0`.
- **Retries**: 10 seconds per attempt, then 3 retries after 0.5, 2 and 5 seconds. Stripe retries a
  sandbox delivery three times over a few hours; the delays are compressed for tests.
- **Delivery order**: a retry goes to the back of its endpoint's queue; nothing is ordered across
  endpoints or accounts.
- **Disabled or removed endpoints**: get no new deliveries. A disabled endpoint's queued deliveries
  and retries are canceled when they come due, a removed endpoint's at once; a request already in
  flight finishes but is not retried.
- **`pending_webhooks`**: stays above 0 after the last retry fails; a delivery dropped because its
  endpoint was disabled or removed no longer counts.
- **`deliverDuplicate`**: two more deliveries, back to back.
- **Bad signature**: a well-formed `v1` made with another secret, the usual real-world failure.
- **`GET /v1/webhook_endpoints`**: lists only endpoints created through the API. Their secrets are
  `whsec_` plus 32 characters, returned only on create. A bad `url` is 400 `url_invalid`; an
  unknown `api_version` is 400 on `api_version`; `connect=true` and a 17th endpoint are 400.

## What it does not do

- **Discounts and tax**: coupons, promotion codes, discounts, tax rates, Stripe Tax, tax IDs. Any
  such ID answers 400 `resource_missing`; there are no `/v1/coupons` or `/v1/promotion_codes`
  endpoints.
- **Checkout in `payment` or `setup` mode**, shipping rates, and any payment method but cards.
- **Completing 3D Secure.** There is no confirm endpoint, so a PaymentIntent in `requires_action`
  stays there; pay the invoice with another card instead.
- **Endpoints outside the list in [API](#api)**, among them: search (`/search` on any resource),
  creating PaymentMethods (use the aliases), PaymentIntents and SetupIntents beyond retrieve,
  refunds, disputes, balance and balance transactions, creating or updating subscription items
  (`/v1/subscription_items` is retrieve and list only; change items through the subscription),
  usage records and billing meters, creating, updating, deleting, sending or previewing invoices
  (`/v1/invoices/create_preview`), invoice items, credit notes, quotes, customer sessions,
  customer balance transactions and cash balances, entitlements.
- **Connect and Accounts v2**: `Stripe-Account`, `on_behalf_of`, `transfer_data`,
  application fees, `customer_account`: all refused with 400.
- **Portal features**: pausing, retention coupons, tax IDs.
- **Embedded Checkout UI**: embedded and form sessions get a `client_secret`, but no Stripe.js;
  complete them on the hosted page at `/c/pay/{id}`.
- **Live mode**, restricted-key permissions (an `rk_test_` key can do everything), rate limits
  other than injected faults, and anything security-related. Bind it to localhost and never expose
  it to a network you do not control.

## Fidelity gaps

- The hosted pages are plain HTML forms, not Stripe's pages; they post the fields listed above and
  run no JavaScript.
- Smart Retries are replaced by a fixed schedule, and draft invoices finalize after exactly one
  hour instead of waiting for webhook deliveries (up to 72 hours at Stripe).
- Test clock advances finish inside the request; Stripe advances asynchronously.
- Webhooks go one at a time per endpoint, in order, one event per request, with retries within
  seconds. Stripe delivers concurrently, in no guaranteed order, and retries over hours.
- Validation runs in a fixed order and each refusal has one `code` and `param`; Stripe may answer a
  different one for the same request. Message texts differ from Stripe's.
- Charges have no balance transactions, receipts or statement descriptors, and nothing settles.
- Only versions from 2024-06-20 are modelled; older ones use 2024-06-20 shapes. 2026-09-30.endive
  is refused.
- Everything is in memory; the request ledger keeps the last 10000 requests of an account.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
node examples/checkout-trial.js
```

The tests drive the server through the real `stripe` SDK, the hosted pages through HTTP, and
verify every webhook with `constructEvent`. [ARCHITECTURE.md](ARCHITECTURE.md) describes how the
code is organized and how to add a resource.

Two files are generated from Stripe's public OpenAPI specs
([github.com/stripe/openapi](https://github.com/stripe/openapi)) and committed, so the scripts only
need to run when the server moves to a newer API version:

- `src/schemas/params.js`, the request parameters of every operation with their version gates, by
  `scripts/build-param-schemas.mjs`: from `openapi/spec3.json` at nine tags from v1267
  (2024-06-20) to v2442 (2026-08-26.dahlia, the spec stripe-node 22.6.2 is built from),
  `spec3.sdk.json` at v2442, and parameter trees taken from `spec3.json` at v2526.
- `test/fixtures/spec-keys.json`, the top-level keys of each rendered object at 2024-06-20 and
  2026-08-26.dahlia that `test/shapes.test.js` checks responses against, by
  `scripts/build-spec-keys.mjs`: from a summary of the object schemas in `spec3.json` and
  `spec3.sdk.json` at tags v1267 and v2442, plus the API reference's includable fields.

The spec files are not in this repository; each script's header lists the inputs it expects and
their format.

## Status

Prior art: [stripe-mock](https://github.com/stripe/stripe-mock) is Stripe's official mock; it is
stateless and answers with canned fixture responses from the OpenAPI spec, with no webhooks or
hosted pages. [localstripe](https://github.com/adrienverge/localstripe) is a stateful Python server
that sends webhooks, but it has no Checkout, customer portal, subscription schedules, test clocks,
idempotency or API versions.

This package exists because testing a Billing integration needs the parts between the API calls:
hosted pages a test can complete, time that renews, retries and cancels, and signed webhooks.
It keeps them stateful, per API version, and driven by the same SDK your application uses.

Behaviour was built from Stripe's API reference, changelog and OpenAPI spec, reviewed 2026-09-30.
This is an early-stage project and its API may still change. MIT license.
