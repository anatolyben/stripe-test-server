# Architecture

How stripe-test-server is put together: the modules, the path a request takes, and the internal
interfaces a change has to respect. Read it before adding a resource or changing a flow. The
behaviour itself (what each endpoint answers) is described in the [README](README.md); where
Stripe's documentation leaves a choice open, the README's "Uncertain behaviour" section records
the one made here.

**Conventions.** ESM, Node.js 20 or newer, no runtime dependencies. Short doc comments; comments
that need a source cite a docs.stripe.com page. Everything lives in memory, per API key.

**Reading and changing other modules' objects.** When all you need is a lookup, read another
module's objects through `account.store`, using the shapes in [Internal objects](#internal-objects),
instead of calling its functions. Change them only through the owning module's exported
functions. In unit-style tests, fixture objects of other types can be inserted directly with
`account.store.insert(...)` in the documented shape (`test/core.test.js` does this for a test
clock).

---

## Module map

| Path | Contents |
|---|---|
| `src/index.js`, `src/index.d.ts` | Public entry point (`createStripeTestServer`, `LATEST_VERSION`, defaults) and its TypeScript types |
| `bin/stripe-test-server.js` | The CLI |
| `src/app.js` | Builds the registry from every module's `install(app)` |
| `src/core/server.js` | HTTP server, request pipeline, `ServerContext` |
| `src/core/registry.js` | Routes, hosted pages, controls, serializers, job kinds, hooks |
| `src/core/account.js`, `store.js`, `ids.js` | Per-key accounts, the object store, deterministic IDs |
| `src/core/form.js`, `validate.js`, `versions.js` | Form parsing (bracket notation), parameter validation, API versions |
| `src/core/render.js`, `expand_schema.js`, `list.js` | Serializers, `expand`, lists and pagination |
| `src/core/errors.js` | `StripeError` and the error helpers |
| `src/core/idempotency.js`, `ledger.js`, `faults.js` | Idempotency keys, the request ledger, fault injection |
| `src/core/time.js`, `periods.js` | Time engine (clocks and jobs), billing-period arithmetic |
| `src/core/events.js` | Event bus, `/v1/events` |
| `src/core/controls.js` | Every control (`/_test/…` and `server.account(key)`) |
| `src/core/html.js` | Hosted-page helpers |
| `src/core/currency.js`, `util.js`, `options.js` | Currencies, small shared helpers, option validation |
| `src/customers/` | Customers: the reference resource (see [Adding a resource](#adding-a-resource)) |
| `src/catalog/` | Products and prices |
| `src/payments/` | Test cards, PaymentMethods, PaymentIntents, Charges, `failNextCharge` |
| `src/checkout/` | Checkout Sessions API and the hosted Checkout page; `page_kit.js` (card form, page styles) and `pricing.js` (price labels, amounts) serve every hosted page |
| `src/billing/` | The billing engine (`engine.js`: every subscription and invoice state change, billing jobs, dunning, prorations), the invoice lifecycle (`invoicing.js`), money and period helpers (`util.js`), the subscriptions and subscription items API with the legacy `plan` rendering (`subscriptions.js`), invoices, invoice payments and invoice items (`invoices.js`), the hosted invoice page (`invoice_page.js`) |
| `src/schedules/` | Subscription schedules: API and phase transitions |
| `src/portal/` | Portal configurations, portal sessions, the hosted portal |
| `src/webhooks/` | Delivery (signing, retries, hold/release, duplicates, settle), the webhook controls, `/v1/webhook_endpoints` |
| `src/test_clocks/` | Test clocks API and advance orchestration |
| `src/schemas/params.js` | Generated request-parameter trees (see [Versions and parameter validation](#versions-and-parameter-validation)) |
| `scripts/` | Generators of `src/schemas/params.js` and `test/fixtures/spec-keys.json` |
| `test/` | Tests per area, plus `flows.test.js` for end-to-end flows |

---

## The registry

Every module exports `install(app)`. `src/app.js` builds one process-wide `Registry`
(`src/core/registry.js`) by calling each module's `install(app)` once. The registry holds code,
not state, so one registry serves every server and account in the process.

```js
app.route(method, path, handler, { op?, validate?, returns? })   // API route
app.page(method, path, handler, { account })                     // hosted page
app.control(def)                                                 // control (all defined in core/controls.js)
app.object(type, { render, expandable, includable, links? })     // serializer
app.job(kind, handler)                                           // time-engine job kind
app.hook(name, fn)                                               // lifecycle hook
```

- `route`: `path` uses `:param` segments (`/v1/customers/:id`). `op` is the key into
  `src/schemas/params.js` (`'GET /v1/subscriptions/{subscription_exposed_id}'`); when omitted it
  is derived from the path shape. Registration throws if no schema exists, unless
  `validate: false` (no route uses that today). When several routes match, the one with more
  literal segments wins. `returns` is the response type (`'customer'`, `'list<customer>'`) that
  `expand` paths are checked against; it defaults to `RESPONSE_TYPES[op]` from
  `src/core/expand_schema.js`, and registration throws when neither gives one.
- `object`: `links` overrides, for this type, the expand links of `expand_schema.js` `LINKS`
  (rel path → target type, or `{ to?, since?, until?, embedded? }`; see [Expand](#expand)).
- Never call an imported function at module top level: modules import each other in cycles
  (billing ↔ schedules, engine ↔ invoicing, core controls → every module), so call them only at
  run time.

### Install order

`src/app.js` installs, in this order: `core/events`, `core/controls`, `customers/customers`,
`catalog/products`, `catalog/prices`, `payments/payment_methods`, `payments/payment_intents`,
`checkout/sessions`, `checkout/checkout_page`, `billing/engine`, `billing/subscriptions`,
`billing/invoices`, `billing/invoice_page`, `schedules/schedules`, `portal/configurations`,
`portal/sessions`, `portal/portal_page`, `webhooks/delivery`, `webhooks/endpoints`,
`test_clocks/test_clocks`. A new module with its own `install()` must be added there (or be
installed from one of the listed modules' `install`). Order matters only for hooks, which run in
registration order.

### Lifecycle hooks

All run synchronously, in registration order, and must not await anything.

| Hook | Arguments | Runs | Used by |
|---|---|---|---|
| `event.emitted` | `(account, event)` | inside `emitEvent`, after the event is stored and pre-rendered | webhooks: queue deliveries, set `event.pendingWebhooks` |
| `account.created` | `(account)` | first request or control for a new key | — |
| `account.beforeRequest` | `(account)` | before every API request, hosted page and locked control, after due jobs ran | test clocks: flip advanced clocks to `ready` |
| `account.reset` | `(account)` | at the start of `account.reset()` | webhooks: drop queued deliveries and timers |
| `customer.deleting` | `(account, customer, { request })` | in `deleteCustomer`, before `customer.deleted` is emitted | payments: detach the customer's cards silently (installed first); billing: cancel the customer's live subscriptions |
| `payment_method.detached` | `(account, pm, { customer, request })` | in `detachPaymentMethod`, after `payment_method.detached` (and the customer's `customer.updated` when the card was its default) | billing: clear `default_payment_method` on the customer's subscriptions that used the card |
| `server.close` | `(server)` | at the start of `server.close()` | webhooks: clear timers |

---

## Accounts and state

### `Account` (`src/core/account.js`)

One per API key (`sk_test_…` / `rk_test_…`), created on first use. Everything is per account;
server-wide webhook endpoints from the options are the only shared state.

| Member | Meaning |
|---|---|
| `key`, `id` | the API key; `acct_` + 16 base62, derived from the key (used in hosted invoice URLs) |
| `server` | the `ServerContext` (see [ServerContext](#servercontext)) |
| `store` | objects (see [Store](#store)) |
| `time` | clocks and jobs (see [Time](#time)) |
| `events` | `EventStore`: `add`, `get(id)`, `all()` (oldest first) |
| `idempotency`, `ledger`, `faults` | see [Request pipeline](#request-pipeline) |
| `settings` | `{ apiVersion, billing: { retrySchedule: number[], afterFinalRetry: 'cancel'\|'unpaid'\|'past_due', markUncollectible: boolean } }` |
| `webhookEndpoints` | endpoints added for this account (see [Webhook endpoint records](#webhook-endpoint-records)) |
| `state` | private module state; use `account.moduleState('payments', () => ({ ... }))` |
| `currentRequest` | `{ id, idempotency_key }` while an API request executes, else `null` |
| `mintId(prefix, length = 24)` | deterministic `prefix_…` ID, registered so `server.accountForId(id)` finds the account |
| `now(domain?)` | `time.now(domain)` |
| `run(fn)` | run `fn` after the account's queued work (the account lock) |
| `reset()` | clear everything (runs the `account.reset` hooks first) |

**Concurrency.** Every API request, hosted-page request and control (unless `lock: false`) of an
account runs inside `account.run`, one at a time. Handlers may be async, but must never await
something that needs another request of the same account (a webhook receiver calling back the
API would deadlock): webhook sends happen outside the lock. Everything else is synchronous.
Code that changes account state from a timer or another async callback (flipping an advanced
test clock to `ready`, recording a delivery result) must do it inside `account.run(() => …)`.

**IDs.** `account.mintId('cus')` → `cus_` + 24 base62 characters derived from (key, prefix,
counter): deterministic per account, reset by `reset()`. Prefixes in use: `cus`, `prod`, `price`,
`pm`, `pi`, `ch`, `seti`, `cs_test`, `li` (Checkout line item), `sub`, `si`, `sub_sched`, `in`,
`il`, `ii` (invoice item), `inpay`, `bpc`, `bps`, `clock`, `evt`, `we`. Hosted-page tokens come
from `account.mintId('test')` (also registered, so a page resolves the account from its token).
Request IDs are `req_` + 14 (minted by the core).

### Store

`src/core/store.js`:

```js
store.insert(obj)                       // needs obj.id and obj.object; sets obj._seq; returns obj
store.get(type, id)                     // object or null (soft-deleted included)
store.find(id)                          // any type, or null
store.require(type, id, { param = 'id', noun = type })
                                        // live object, else resource_missing: 404 when param is
                                        // 'id' (a path ID), else 400 on that param; `_deleted`
                                        // counts as missing
store.list(type, filter?)               // insertion order
store.remove(type, id)                  // hard delete (deleted products, clocks, ...)
store.types(), store.clear()
```

Collections are keyed by the Stripe `object` value: `customer`, `product`, `price`,
`payment_method`, `payment_intent`, `charge`, `checkout.session`, `subscription`,
`subscription_item`, `subscription_schedule`, `invoice`, `invoiceitem`, `invoice_payment`,
`billing_portal.configuration`, `billing_portal.session`, `test_helpers.test_clock`,
`webhook_endpoint`. Events live in `account.events`, not in the store.

### Internal objects

Every module follows these rules:

1. An internal object is the **2026-08-26.dahlia wire shape** (the API reference object for the
   current version), with `id`, `object`, `created` (from `account.time.now(domain)`, see
   [Time](#time)) and `livemode: false`.
2. **Every reference to another top-level object is stored as its ID**, even where the wire
   format embeds the object (e.g. `subscription_item.price`,
   `line_item.pricing.price_details.price`). Serializers embed or expand when rendering.
3. Private fields start with `_` and are never rendered (`_deleted`, `_card`, `_version`, …).
4. Objects are plain, `structuredClone`-able data (no functions, class instances or Maps).
5. Other modules may **read** an object through the store using its public field names, but
   change it only through the owning module's exported functions.
6. Embedded lists keep their wire form internally (`subscription.items` =
   `{ object: 'list', data: [subscription_item…], has_more, total_count, url }`); a module may
   also keep the elements in their own collection (e.g. `subscription_item` for
   `GET /v1/subscription_items/:id`) as long as both stay in sync. Readers use `sub.items.data`.
7. Shapes other modules read: subscription (`customer`, `status`, `items.data[]` with `id`,
   `price` (ID), `quantity`, `current_period_start`, `current_period_end`, `billing_mode.type`,
   `cancel_at`, `cancel_at_period_end`, `trial_end`, `schedule`, `latest_invoice`,
   `default_payment_method`, `currency`), invoice (`customer`, `status`, `amount_due`,
   `parent.subscription_details.subscription`, `hosted_invoice_url`, `number`, `created`), price
   (`product`, `unit_amount`, `currency`, `recurring`, `active`, `type`), product (`name`,
   `active`), payment method (`customer`, `card.brand`, `card.last4`), schedule (`subscription`,
   `status`, `phases`), portal configuration (`features`, `is_default`, `active`).

---

## Request pipeline

`src/core/server.js`:

```
/v1/…    auth (401) → Stripe-Account/Context rejected (400) → faults → version (400)
         → [account lock: due jobs + beforeRequest hooks → route (404) → parse → idempotency
            lookup (replay / 400) → validate (400) → expand check (400) → handler → render +
            expand] → ledger → response
/_test/… control (see Controls)
other    hosted pages (see Hosted pages), else 404 JSON
```

Every response carries a `Request-Id` (`req_` + 14): API requests, controls, hosted pages and
errors alike.

### Handler context

```js
app.route('POST', '/v1/customers/:id', (ctx) => { ... });
ctx = {
  server, account, method, path,
  pathParams,            // { id: 'cus_…' }, percent-decoded
  params,                // validated and converted (integers, booleans, arrays; '' kept as the
                         // "unset" marker; absent params are absent); body for POST (plus any
                         // query string), query for GET/DELETE
  raw: { body, query },  // raw strings
  version,               // resolved API version string
  family,                // 'F1' | 'F2' | 'F3' (see Versions and parameter validation)
  atLeast(gate),         // ctx.atLeast('2025-09-30.clover')
  request,               // { id: 'req_…', idempotency_key } for events
  now(domain = null),    // account.time.now(domain)
}
```

Return one of: an internal object (rendered by its serializer, then `params.expand` applied), a
`ListResult` (from `paginate`, see [Lists](#lists)), or `raw(json)` (sent as-is, e.g. deleted
stubs). Throw a `StripeError` (see [Errors](#errors)) for errors. Validate everything before
mutating: a thrown error does not roll back state.

### Idempotency

`src/core/idempotency.js`. A POST with `Idempotency-Key`: the key (≤ 255 characters, else 400
`idempotency_error`) maps to the first request's method, path and canonical params (sorted keys,
`expand[]` equal to `expand[0]`), status and body, for 24 hours of the account clock. Same key and
same request → the saved status and body with `Idempotent-Replayed: true` (and a new
`Request-Id`). Same key with other params or another endpoint → 400 `idempotency_error`.

Every result is saved once the handler has started, except errors whose `validation` flag is set
(all `parameter_*` / `parameters_exclusive` codes, 401, 429, idempotency errors), so a corrected
retry goes through. Throw validation-type errors (`parameterMissing`, `parametersExclusive`,
`invalidParam`) for request problems and `invalidRequest(message, { param })` for business rules.

### Responses

Pretty-printed JSON with `Content-Type: application/json`, `Request-Id`, `Stripe-Version` (the
resolved version) and, on POST, the echoed `Idempotency-Key`. Errors: `{ error: { … } }` with keys
sorted and null fields omitted, `doc_url` for coded errors, and `request_log_url`.

### ServerContext

Members modules may use: `server.url` (`http://127.0.0.1:PORT`, for hosted URLs),
`server.options` (normalized: `webhookRetry: { delaysMs, timeoutMs }`, `billing`, `apiVersion`,
…), `server.webhookEndpoints` (see [Webhook endpoint records](#webhook-endpoint-records)),
`server.accounts` (Map key → Account), `server.accountForId(idOrToken)`, `server.registry`,
`server.log(level, message)`, `server.endpointVersions(account)`.

### Faults and the ledger

Faults (`account.faults`, `src/core/faults.js`) answer matching `/v1` requests before idempotency
and validation, so they never change state: `500` (`api_error`; the SDK retries 5xx), `429`
(`rate_limit` + `Stripe-Rate-Limited-Reason`), `timeout` (no answer: the connection is held until
the client gives up, or dropped after `timeoutMs` when set). The ledger (`src/core/ledger.js`)
records every `/v1` request with its query and body parsed and secrets redacted.

---

## Time

`src/core/time.js`, `src/core/periods.js`.

### Domains and `now`

- Domain `null`: the account clock = real time + an offset (the `advanceTime` control adds to
  the offset).
- Domain `'clock_…'`: a Stripe test clock; its time is the clock's frozen time.
- `account.time.now(domain)`: during a job run, the job's time; otherwise the domain's time.
- `account.time.domainOf(objOrId)`: `obj.test_clock`, else the test clock of `obj.customer`,
  else `null` (only registered clocks count). **Every object and event of a customer on a test
  clock uses that clock's time**: use `account.time.now(account.time.domainOf(customer))`.
- Webhook signature timestamps always use real wall time (`constructEvent` rejects signatures
  more than 300 seconds old).

### Jobs

```js
app.job('subscription.renewal', (account, job) => { ... });     // at install
account.time.schedule({ kind, at, domain = null, key?, data = {}, priority = JOB_PRIORITY.default })
account.time.cancel(key); account.time.cancelWhere((job) => ...); account.time.list({ domain?, kind? })
```

- A job with the same `key` replaces the old one: use keys such as `` `${sub.id}:renewal` ``.
- Jobs of a domain run in order of `at`, then `priority`, then scheduling order, when the
  domain's time moves: `account.time.catchUp()` (before every request, up to the account clock's
  now), `account.time.advanceAccountClock({ seconds } | { to })` (the `advanceTime` control),
  `account.time.advance(clockId, target)` (test clock advance). Jobs scheduled while running run
  too when due before the target; a job scheduled in the past runs at the current run time.
- In a handler: `account.time.now(job.domain) === job.at` (never earlier than the previous job),
  and `account.currentRequest === null` (events are automatic:
  `request: { id: null, idempotency_key: null }`). A handler that throws is logged and skipped.
- Put IDs in `data`, never object references; re-read objects from the store and check they are
  still in the expected state (a job may be stale).
- `JOB_PRIORITY` (same second, lower first): `schedulePhase 10, trialWillEnd 15, trialEnd 20,
  cancelAt 25, renewal 30, invoiceFinalize 40, paymentRetry 50, incompleteExpire 60,
  checkoutExpire 70, default 100`. A schedule phase change therefore applies before the renewal
  invoice of the same instant.

Job kinds registered today: billing `subscription.renewal`, `.trial_end`, `.trial_will_end`,
`.cancel_at`, `.incomplete_expire`, `.pause_collection_resume`, `.pending_update_expire`,
`.resume_expire`, `invoice.finalize`, `.payment_retry`, `.payment_attempt`, `.due`; schedules
`subscription_schedule.start`, `.phase_end`, `.expiring`; Checkout `checkout.session.expire`.

### Test clocks

`account.time.registerClock(id, frozenTime)` on create, `account.time.advance(id, target)` on
advance, `account.time.removeClock(id)` on delete (drops its jobs). Clock objects live in the
store as `test_helpers.test_clock`; customers check existence there (`test_clock` param, at most
3 customers per clock).

### Period arithmetic

`src/core/periods.js`: `addIntervals(anchor, interval, count, k)`,
`nextBoundaryAfter(anchor, interval, count, t)`,
`periodContaining(anchor, interval, count, t) → { start, end }`,
`periodLength(start, interval, count)`, `isIntervalWithinLimit(interval, count)`. UTC, the
anchor's time of day kept, month ends clamped from the anchor's day (Jan 31 → Feb 28 → Mar 31),
as in docs.stripe.com/billing/subscriptions/billing-cycle.

---

## Rendering

`src/core/render.js`, `src/core/expand_schema.js`, `src/core/list.js`.

### Serializers

```js
app.object('subscription', {
  render(sub, ctx) { ... return json; },       // minimal (unexpanded) wire form for ctx.version
  expandable: ['customer', 'latest_invoice', 'default_payment_method', 'schedule', 'test_clock'],
  includable: { 'features.subscription_update.products': (hash, ctx, resource) => ... },
});
ctx = { account, version, family, atLeast(gate), forEvent, lookup(id), render(obj) }
```

An includable resolver receives the hash that gets the key, the serializer context and the
rendered resource that owns the path (the same object as `hash` for a top-level key), so a nested
resolver can find its object with `ctx.lookup(resource.id)`.

- `render` returns a **new** object tree (no references into the internal object): expansion
  mutates the rendered JSON in place.
- Shape per version: F1 renders the 2024-06-20 shape; F2 and F3 render the current shape minus
  fields added in later versions (checked with `ctx.atLeast`). Always emit the keys the OpenAPI
  spec lists as required (null when empty), plus the optional keys the API reference example
  shows; includable keys only through `includable`; decimal fields as strings.
  `test/shapes.test.js` checks rendered objects against the spec's key sets in
  `test/fixtures/spec-keys.json`.
- Embedded objects: `ctx.render(internalObj)` renders another object in the same version (e.g.
  the price inside a subscription item); `ctx.lookup(id)` reads the store.
- `ctx.forEvent` is true for event payloads (minimal form, never expanded).
- Types without a serializer render as a deep copy without `_` keys.

### Expand

`params.expand` is checked statically before the handler runs (`checkExpand` in
`src/core/render.js`, called right after parameter validation). Each path is resolved against the
route's `returns` type and the per-type links of `src/core/expand_schema.js` (built from the
OpenAPI spec's `x-expansionResources` and response schemas, with `since` / `until` version gates).
So whether a path is accepted never depends on the data, a rejected request runs nothing and
stores nothing under its idempotency key, and a field absent in the request's version is refused.
Event payloads are minimal form, so `data.object.*` is refused on events.

After rendering, the paths are applied (this walk only fills in values). A path walks the JSON:
`data` steps into a list; a string at a declared `expandable` path is replaced by the rendered
object (`ctx.lookup`); an array of IDs at a declared path is expanded element-wise; a declared
`includable` key is added by calling its function; embedded resources switch to their own
declarations; plain hashes keep the owner's (declare `'invoice_settings.default_payment_method'`,
`'parent.subscription_details.subscription'`, `'pricing.price_details.price'` as dotted paths).
Arrays of hashes are walked element-wise (`phases.items.price`).

At most 4 expansions per path, counting only expanding hops (Stripe documents a four-level limit
and also five-segment invoice paths). An unknown, non-expandable or over-deep path → 400
`invalid_request_error`, `param: 'expand'`; `total_count` on F2/F3 → 400 with
`property_forbidden` in the message.

### Lists

```js
paginate(items, params, { url, noun, find? })   // → ListResult; newest first (created, then _seq);
                                                // limit 1–100 (400 param limit), both cursors →
                                                // parameters_exclusive, unknown cursor →
                                                // 400 resource_missing (param = cursor name)
matchesRange(value, filter)                     // created-style filters: int or {gt,gte,lt,lte}
embeddedList(data, url, limit = 10)             // {object:'list', data, has_more, total_count, url}
raw(json)                                       // response body sent as-is
```

Top-level lists never carry `total_count` (F1 allows `expand[]=total_count`); embedded lists
(`subscription.items`, `invoice.lines`) always do.

---

## Hosted pages

`src/core/html.js`:

```js
app.page('GET', '/c/pay/:id', (p) => html('Checkout', h`<h1>…</h1>`), {
  account: (pathParams, server) => server.accountForId(pathParams.id),
});
p = { server, account, method, path, pathParams, query, form /* parsed POST body */, headers, rawBody }
```

Pages need no API key. Handlers run inside the account lock after due jobs (like API requests),
emit events with `request: null` (the default there), render objects (when they need wire JSON)
at `account.settings.apiVersion`, and return a page result: `html(title, body, { status })`,
`redirect(location, status = 303)`, `text(body)`, `notFoundPage()`. Build HTML with the escaping
tagged template `` h`…` `` (interpolations are escaped unless wrapped in `safe()`). Forms post
`application/x-www-form-urlencoded` to the same path, so tests can drive them with plain POSTs
(`test/helpers.js` `request()` with `form`, `redirect: 'manual'` so the 303 `Location` is
visible). Absolute URLs: `` `${server.url}${path}` ``.

Every hosted page uses the same card fields (`checkout/page_kit.js`: `cardFields`,
`readCardForm`): `card_number`, optional `exp_month`, `exp_year`, `cvc`, `cardholder_name`.

### Checkout page: `/c/pay/:id`

`src/checkout/checkout_page.js`. GET shows the line items, the amount due today, the trial, an
email field when the session has no customer, the card fields and a cancel link to `cancel_url`.
4242424242424242 succeeds; 4000000000000002 cannot be attached (402 page, the session stays
open); 4000000000000341 attaches but later charges fail; the other test cards behave as listed
in `payments/test_cards.js`. Form fields: the card fields, and `email` when the session has
neither a customer nor `customer_email` (plus the fields the session asks for: phone, names,
addresses, custom fields, consent). POST completes via `checkout.completeSession` and answers 303
to `success_url` with `{CHECKOUT_SESSION_ID}` replaced; a decline answers 402 with the page and
the error.

Completion sequence:

1. The session must be `open`. Resolve the card (`payments/test_cards.js`); an unattachable card
   → decline.
2. Amount due today: recurring items (0 during a trial) + one-time items. If > 0 and the family
   is F2/F3, `payments.predictChargeFailure` → decline before anything is created.
3. `customers.createCustomer(account, { email, name }, { request: null })` when the session has
   no customer.
4. `payments.createCardPaymentMethod` + `payments.attachPaymentMethod` (→ `payment_method.attached`).
5. `billing.createSubscription(account, spec, { source: 'checkout', version: session._version, request: null })`
   with `paymentBehavior: 'error_if_incomplete'` on F2/F3 and `'allow_incomplete'` on F1
   (`session._version` = the version of the request that created the session). The subscription
   gets `default_payment_method` = the card; the customer's default stays unchanged.
6. Session → `complete`, `payment_status: 'paid'`, `customer`, `subscription`, `invoice`,
   `payment_intent` (F2/F3 when money was taken), `url: null`, `customer_details`; emit
   `checkout.session.completed`.

F1 decline: step 5 returns an `incomplete` subscription with an open invoice and a
`paymentError`; the session stays open, and a later successful card on the same session pays that
invoice with `billing.payInvoice` before step 6. `payment_method_collection=if_required` with
nothing due today: no card field, no PaymentMethod.

### Portal: `/p/session/:token`

`src/portal/portal_page.js`. Shows only the configuration's enabled features: current plan,
invoice history (links to hosted invoice URLs), update payment method, cancel (`at_period_end` or
`immediately` per configuration; cancellation reasons) and "don't cancel", and plan switching
when `subscription_update` is enabled with the configured products and prices. Actions (POST,
then 303):

| Action | Call |
|---|---|
| immediate plan change | `billing.changeSubscriptionItems(account, sub, { items: [{ id, price, quantity }], prorationBehavior: config value (default 'none'), billingCycleAnchor: config value ?? 'unchanged', trialUpdateBehavior, paymentBehavior: 'error_if_incomplete' }, { source: 'portal', request: null })`: a declined payment changes nothing and shows the card error (402) on the confirm screen |
| downgrade matching `schedule_at_period_end.conditions` | `schedules.scheduleChangeAtPeriodEnd(account, sub, [{ price, quantity }])` |
| cancel at period end / renew | `billing.setCancelAtPeriodEnd(account, sub, true / false, { source: 'portal', cancellationDetails })` |
| cancel immediately | `billing.cancelSubscription(account, sub, { prorate: config.proration_behavior === 'create_prorations', cancellationDetails, source: 'portal' })` |
| update payment method | `payments.createCardPaymentMethod` + `attachPaymentMethod`, then `customers.changeCustomer(account, customer, (c) => { c.invoice_settings.default_payment_method = pm.id })`, and `billing.updateSubscription(account, sub, { defaultPaymentMethod: pm.id }, { source: 'portal' })` for subscriptions that had their own card |

`flow_data` deep links open the matching screen; after completion the page redirects per
`after_completion` (redirect / hosted_confirmation / portal_homepage) and always offers a link to
`return_url`. While a flow is open, only its action on its subscription is allowed (anything else
is 403); after it completes every action is refused (403) unless `after_completion` is
`portal_homepage`. The configuration's login page is served at `/p/login/:token`.

### Invoice page: `/i/:acct/:token`

`src/billing/invoice_page.js`. `hosted_invoice_url = ${server.url}/i/${account.id}/${token}`,
`invoice_pdf = …/pdf` (a plain-text rendering). GET shows the invoice; while it is open, the
shared card form pays it via `billing.payInvoice` (the card is attached to the customer, not made
a default).

---

## Events and webhooks

`src/core/events.js`, `src/webhooks/`.

```js
emitEvent(account, type, object, { previous?, previousAttributes?, request?, domain? }) → event
updateWithEvent(account, obj, eventType, (obj) => { ...mutate... }, { request?, domain? }) → changed?
renderEvent(account, event, version = event.apiVersion) → wire JSON
renderEventData(account, event, version) → { object, previous_attributes? }   (cached per version)
```

- `object` is the internal object **after** the change; it is deep-copied at emission. Payloads
  are rendered per API version from that copy (minimal form) and cached; the core pre-renders the
  account default and every endpoint version at emission.
- For `*.updated` events pass `previous` = `structuredClone(obj)` taken **before** the change:
  `previous_attributes` is then the per-version diff (old values; nested hashes recurse; arrays
  whole; embedded lists as `{ data }`). Or use `updateWithEvent`, which snapshots, mutates and
  emits only when the rendered object changed. Do not pass `previous` for other event types.
- `request` defaults to the executing API request (`{ id, idempotency_key }`) and is null during
  job runs, hosted pages and controls. `created` = `account.time.now(domain)` with
  `domain = account.time.domainOf(object)` unless given.
- Event record: `{ id, object: 'event', type, created, livemode, request, apiVersion (account
  default at emission), pendingWebhooks (maintained by webhooks/delivery.js), data: { object,
  previous, previousAttributes }, _renders, _seq }`. `GET /v1/events` (`type` with `*`,
  `types[]` ≤ 20, `created`, `delivery_success` = `pendingWebhooks === 0`) and
  `GET /v1/events/:id` are served by `core/events.js`.

### Webhook endpoint records

`server.webhookEndpoints` (from the options) and `account.webhookEndpoints` (controls and
`/v1/webhook_endpoints`) hold records of this shape; the core reads only `status` and
`apiVersion`:

```js
{ id: 'we_…', object: 'webhook_endpoint', scope: 'server' | 'account', url, secret,
  apiVersion: string | null, enabledEvents: ['*'] | string[], status: 'enabled' | 'disabled',
  description: null, metadata: {}, created,
  source: 'control' | 'api' }   // account records only: setWebhookEndpoints or /v1/webhook_endpoints
```

`setWebhookEndpoints` replaces only the `control` records; `/v1/webhook_endpoints` lists and
changes only the `api` ones.

### Delivery

`src/webhooks/delivery.js`. On `event.emitted`, queue one delivery per enabled endpoint
subscribed to the type and set `event.pendingWebhooks`; send later (`setImmediate`), never inside
the account lock. Body:
`JSON.stringify(renderEvent(account, event, endpoint.apiVersion || account.settings.apiVersion))`
(pretty-printed); `Stripe-Signature: t=<real unix now>,v1=<hex HMAC-SHA256("t.body", secret)>`,
re-signed per attempt. A 2xx is a success (decrement `pendingWebhooks`); anything else, timeouts
(`webhookRetry.timeoutMs`) and connection errors retry after `webhookRetry.delaysMs`. Each
(account, endpoint) pair has one FIFO queue sent one request at a time, so first attempts reach
an endpoint in event order; a retry rejoins the back of its queue. `settle` resolves when nothing
is queued, in flight or waiting to retry (held deliveries excepted).

Delivery records (the `webhooks.deliveries` control, oldest first):

```js
{ id: 'delivery_…', eventId, eventType, endpointId, url, apiVersion,
  kind: 'automatic' | 'resend' | 'duplicate' | 'bad_signature',   // only automatic ones retry
  status: 'queued' | 'held' | 'in_flight' | 'retrying' | 'succeeded' | 'failed' | 'canceled',
  attempts, responseStatus, error, createdAt, nextAttemptAt, completedAt,   // ISO strings
  history: [{ attempt, url, signatureTimestamp, startedAt, finishedAt, durationMs,
              responseStatus, error, responseBody /* first 2000 chars */ }] }
```

Manual kinds are single attempts and never change `pending_webhooks`.

---

## Controls

`src/core/controls.js`. Every control is defined there, so the public test surface is fixed in
one place; some delegate to feature modules. HTTP: `METHOD /_test/…` with
`Authorization: Bearer <key>` (acts on that key's account), JSON body in (query string for GET),
JSON out; errors use the Stripe error envelope. JS: `server.account(key).<name>(…)` returns a
Promise of the same JSON. A control definition is
`{ name, method, path, handler(account, input, cctx), args?, lock? }`; controls run inside the
account lock unless `lock: false`.

| JS | HTTP | Input → output | Implemented by |
|---|---|---|---|
| `reset()` | `POST /_test/reset` | — → `{ reset: true }` | core |
| `advanceTime({ seconds } \| { to })` | `POST /_test/advance_time` | `{ seconds }` or `{ to }` → `{ now }` | core |
| `now()` | `GET /_test/now` | → `{ now }` | core |
| `state({ type?, raw? })` | `GET /_test/state` | → `{ now, clocks, objects: {type: [...]}, jobs, events }` | core |
| `requests({ limit?, method?, path? })` | `GET /_test/requests` | → ledger entries, oldest first | core |
| `faults.add(spec)` / `faults.clear()` / `faults.list()` | `POST` / `DELETE` / `GET /_test/faults` | `{ method?, path, times?, kind, timeoutMs? }` → fault / `{ cleared }` / faults | core |
| `billingSettings()` / `updateBillingSettings(patch)` | `GET` / `POST /_test/billing_settings` | `{ retrySchedule?, afterFinalRetry?, markUncollectible? }` → settings | core |
| `deleteCustomer(id)` | `POST /_test/delete_customer` | `{ customer }` → deleted stub | `customers.deleteCustomer` |
| `failNextCharge(customerId, { times = 1, declineCode = 'generic_decline' })` | `POST /_test/fail_next_charge` | `{ customer, times, declineCode }` → `{ customer, remaining, declineCode }` | `payments.failNextCharge` |
| `createSubscription(customerId, { price, quantity?, trialDays?, paymentMethod? })` | `POST /_test/create_subscription` | `{ customer, price, … }` → rendered subscription | `billing.createSubscriptionForTest` |
| `setWebhookEndpoints([{ url, secret, apiVersion? }])` | `PUT /_test/webhook_endpoints` | `{ endpoints }` → endpoint records | webhooks |
| `webhooks.deliveries(filter?)` | `GET /_test/webhooks/deliveries` | `{ eventId?, eventType?, endpointId?, status?, kind?, limit? }` → delivery records | webhooks |
| `webhooks.resend(eventId)` | `POST /_test/webhooks/resend` | `{ eventId }` → `{ eventId, deliveries }` | webhooks |
| `webhooks.deliverDuplicate(eventId)` | `POST /_test/webhooks/deliver_duplicate` | `{ eventId }` → `{ eventId, deliveries }` | webhooks |
| `webhooks.hold()` | `POST /_test/webhooks/hold` | → `{ held: true, deliveries: <number held> }` | webhooks |
| `webhooks.release({ order })` | `POST /_test/webhooks/release` | `{ order: 'fifo' \| 'reverse' \| [eventIds] }` → `{ released, deliveries }` | webhooks |
| `webhooks.sendWithBadSignature(eventId)` | `POST /_test/webhooks/send_with_bad_signature` | `{ eventId }` → `{ eventId, deliveries }` | webhooks |
| `webhooks.settle()` | `POST /_test/webhooks/settle` | runs without the lock → `{ settled: true }` | `webhooks.settleAccount` |

Server-wide (JS only): `url`, `port`, `account(key)`, `accounts()`, `reset()`, `settle()`
(`webhooks.settleServer`), `close()`.

---

## Errors

`src/core/errors.js`: `StripeError(status, fields, { headers, validation })`;
`err.toBody(requestId)`. Helpers:

| Helper | Result |
|---|---|
| `invalidRequest(message, { param, code, status = 400, validation })` | `invalid_request_error` (`validation` defaults to true for `parameter_*` codes) |
| `resourceMissing(noun, id, { param = 'id' })` | `No such <noun>: '<id>'`, 404 for `'id'` (a path ID), else 400 on that param; noun = the `object` value |
| `parameterMissing(param)`, `parameterUnknown(param)`, `parametersExclusive([a, b], { param })`, `invalidEmpty(param)`, `invalidInteger(param, value)`, `invalidParam(param, message)` | validation errors |
| `cardError({ code = 'card_declined', declineCode, message = 'Your card was declined.', param, charge, paymentIntent, paymentMethod })` | 402 `card_error` |
| `idempotencyError`, `apiError`, `rateLimitError`, `authenticationError`, `unrecognizedUrl` | as named |

Params in errors use bracket form (`items[0][price]`,
`flow_data[subscription_update_confirm][items][0][price]`). Message texts are Stripe-like but not
a contract: tests assert `type`, `code` and `param`, never message text.

---

## Versions and parameter validation

- `src/core/versions.js`: accepted versions are stripe-node 22.6.2's `ApiVersion` union (127
  values) plus `YYYY-MM-DD.preview` for the SDK's release dates from 2025-04-30; anything else →
  400. Family by
  date: **F1** before 2025-03-31.basil (rendered with 2024-06-20 shapes), **F2** from
  2025-03-31.basil to before 2025-09-30.clover, **F3** from 2025-09-30.clover. Events render in
  the endpoint's version, else the account default. `billing_mode` defaults to `flexible` when
  the creating request's version is 2025-09-30.clover or later; objects created later on behalf
  of an earlier request (Checkout) record that request's version.
- `src/schemas/params.js` is generated by `scripts/build-param-schemas.mjs` from Stripe's OpenAPI
  specs (github.com/stripe/openapi) and committed; the script only needs to run when moving to a
  newer API version, and its header lists the inputs. It holds 68 operations, body and query
  merged; every registered route has one. The base is the 2026-08-26.dahlia spec (tag v2442)
  plus the parameters only the SDK's spec has. Parameters removed in later versions carry
  `until` (`coupon` / `promotion_code`, `aggregate_usage`, `phases.coupon` → basil;
  `phases.iterations` → clover; `line_items.dynamic_tax_rates` → 2026-07-29.dahlia). Documented
  `since` gates: `billing_schedules` ≥ 2026-05-27.dahlia, `billing_mode` ≥ 2025-06-30.basil,
  portal `schedule_at_period_end` ≥ 2024-10-28.acacia and `trial_update_behavior` ≥
  2025-09-30.clover; Checkout `ui_mode` values are gated per version; `requiredUntil` marks
  requirements that were relaxed; parameters the API reference marks required are overlaid
  (`mode`, subscription `items` and `customer`, portal session and PaymentMethod attach
  `customer`). A parameter the version lacks is rejected exactly like an unknown one.
- Enums are closed (the spec's `x-stripeBypassValidation` only concerns SDK typing), except
  webhook endpoint `api_version`, which the endpoint module validates itself (`.preview` values).
- Conditional rules the tree cannot express (either-or params, "required if", value ranges,
  cross-field rules) belong in handlers; throw validation-type errors for them.

---

## Module interfaces

Exact signatures and JSDoc are in the modules; this is the map. "→" = returns.

### Core

| Module | Exports |
|---|---|
| `customers/customers.js` | `requireCustomer(account, id, { param = 'customer' })`, `createCustomer(account, params, { request })`, `updateCustomer(account, customer, params, { request })`, `changeCustomer(account, customer, mutate, { request, silent })` (emits `customer.updated` when visible fields change, unless `silent`), `deleteCustomer(account, customer, { request })`, `renderCustomer`, `MAX_CUSTOMERS_PER_CLOCK` |
| `core/events.js` | `emitEvent`, `updateWithEvent`, `renderEvent`, `renderEventData`, `diffPrevious`, `holdEvents(account, fn)` / `emitHeld(account, held)` (snapshot the events `fn` emits and emit them later, e.g. a payment made before an update applies) |
| `core/render.js` | `raw`, `render`, `renderObject`, `renderContext`, `stripPrivate`, `checkExpand` |
| `core/list.js` | `paginate`, `ListResult`, `matchesRange`, `embeddedList`, `newestFirst` |
| `core/errors.js` | see [Errors](#errors) |
| `core/time.js` | `JOB_PRIORITY` (the engine is reached through `account.time`) |
| `core/periods.js` | see [Period arithmetic](#period-arithmetic) |
| `core/currency.js` | `formatAmount(amount, currency)` ("$10.00"), `describeInterval(interval, count)` ("/ month", "every 3 months"), `isZeroDecimal`, `minimumCharge`, `isSupportedCurrency` |
| `core/util.js` | `applyMetadata(existing, sent)`, `mergeHash(existing, sent)`, `normalizeAddress`, `unsetToNull`, `assignDefined`, `isHttpUrl`, `checkUrl(value, param)` (400 `url_invalid`) |
| `core/validate.js` | `validateParams(opKey, raw, version)`, `validateTree(props, raw, version)` (same node format, for page forms) |
| `core/versions.js` | `LATEST_VERSION`, `familyOf`, `atLeast`, `compareVersions`, `isAcceptedVersion` |
| `core/html.js` | see [Hosted pages](#hosted-pages) |

### Catalog, payments and Checkout

- `catalog/products.js`: `requireProduct(account, id, { param })`, `createProduct(account, params, { request, version, paramPrefix })`, `updateProduct`, `deleteProduct`, `validateProductParams`, `renderProduct`.
- `catalog/prices.js`: `requirePrice(account, id, { param, active })` (`active: true` rejects archived prices and prices of archived products), `createPrice(account, params, { request, inline, version, paramPrefix })` (inline prices are never listed and send no `price.created`; `paramPrefix` nests error params, e.g. `line_items[0][price_data]`), `preparePrice(account, params, opts)` (validates without changing anything → `{ productId, productData, transferFrom, aggregateUsage, fields }`), `insertPrice(account, prepared, opts)` (stores without events), `updatePrice`, `renderPrice`. Internal fields other modules may read: `tiers`, `currency_options`, `_inline`, `_aggregateUsage` (the 2024-06-20 `aggregate_usage`).
- `payments/test_cards.js`: `TEST_CARDS` (entry shape in the file), `findTestCard(numberOrAlias)`, `findTestCardAlias`, `normalizeCardNumber`, `cardChargeOutcome`, `CARD_ERROR_MESSAGES`, `CARD_ERROR_PARAMS`, `DECLINE_CODES`.
- `payments/payment_methods.js`: `attachPaymentMethod(account, ref, customer, { param, request })` (an alias mints a new PaymentMethod on every attach), `detachPaymentMethod(account, pm, { request })` (then runs the `payment_method.detached` hook), `requireAttachedPaymentMethod(account, id, customer, { param })`, `createCardPaymentMethod(account, card, { request, allowRedisplay = 'limited' })` (hosted-page cards count as set up for off-session use), `testCardOf(pm)`, `renderPaymentMethod`. Internal fields: `_card { number, setUp }`, `_detached`.
- `payments/payment_intents.js`: `createPaymentIntent(account, spec, { request })`; `confirmPaymentIntent(account, pi, { paymentMethod, offSession = true }, { request, version })` → `{ ok, paymentIntent, charge, error }` (an unusable PaymentMethod gives `ok: false` with a 400 and leaves the PaymentIntent unchanged; only a PaymentIntent that is not open throws; pass `offSession: false` for on-session payments such as hosted pages); `cancelPaymentIntent`; `predictChargeFailure(account, { paymentMethod, customer, amount, currency, offSession = false, consume = false })` → null or `{ code, declineCode, message }` (`consume: true` uses up a queued `failNextCharge` failure it reports); `cardDeclineError(failure, { charge, paymentIntent, paymentMethod })` → the 402; `failNextCharge(account, customerId, { times, declineCode })`.
- `checkout/sessions.js`: `completeSession(account, session, { paymentMethod, card?, email, name, phone, address, shipping, businessName, individualName, customFields, consent, quantities, optionalItems })`, `createSession`, `expireSession`, `amountDueToday`, `finalLineItems`, `hasTrial`, `renderSession`, `renderItem`.
- `checkout/pricing.js` (amounts through the billing engine's `amountFor`, labels, yearly cost) and `checkout/page_kit.js` (card fields, `readCardForm`, notices, styles) serve every hosted page.

### Billing engine (`billing/engine.js`)

All synchronous; `opts.request` is `{ id, idempotency_key }` or null (default: the current API
request).

- `createSubscription(account, spec, { source: 'api'|'checkout'|'schedule'|'control', version, request, beforeApply })` → `{ subscription, invoice, paymentError }` (spec keys are camelCase and take internal price objects; `beforeApply` runs once every check has passed, right before the first change)
- `updateSubscription(account, sub, update, { source: 'api'|'portal'|'schedule', request, beforeApply })` → `{ subscription, invoice, paymentError }` (the one code path of every subscription change)
- `changeSubscriptionItems(account, sub, { items, prorationBehavior, prorationDate, billingCycleAnchor, paymentBehavior, trialEnd, trialUpdateBehavior }, { source, request })`
- `setCancelAtPeriodEnd(account, sub, value, { source, cancellationDetails, request })`
- `setCancelAt(account, sub, cancelAt, { source, request })`
- `cancelSubscription(account, sub, { invoiceNow, prorate, reason, cancellationDetails, source, request })`
- `resumeSubscription(account, sub, params, opts)`; `setSubscriptionSchedule(account, sub, scheduleId, { request })`
- `payInvoice(account, invoice, { paymentMethod, offSession, source, request, paidOutOfBand })` → `{ invoice, ok, error }`
- `currentPeriod(sub)` → `{ start, end }`; `subscriptionsForCustomer(account, customerId, { includeEnded })`; `defaultBillingMode(version)`; `createSubscriptionForTest(account, customerId, opts)`

The invoice lifecycle (drafts, totals, finalization, payment attempts, void, uncollectible) is
`billing/invoicing.js`, which calls the engine back through `onInvoiceSettled` /
`onPaymentFailure`; money and period helpers are `billing/util.js`. The legacy `plan` object
embedded in subscription items (and 2024-06-20 invoice lines) is rendered by
`billing/subscriptions.js` from the price. Billing registers the `customer.deleting` and
`payment_method.detached` hooks and calls `schedules.onSubscriptionCanceled` /
`schedules.onSubscriptionUpdated` for subscriptions that have a schedule.

### Schedules and the customer portal

- `schedules/schedules.js`: `scheduleChangeAtPeriodEnd(account, sub, items, { request })`, `releaseSchedule(account, schedule, { preserveCancelDate, request })`, `cancelSchedule(account, schedule, { invoiceNow, prorate, request })`, `onSubscriptionCanceled(account, sub, { reason, request })`, `onSubscriptionUpdated(account, sub, { request })`, `renderSchedule`.
- `portal/configurations.js`: `defaultConfiguration(account)`, `requireConfiguration`, `createConfiguration`, `updateConfiguration`, `renderConfiguration`.
- `portal/sessions.js`: `createPortalSession(account, params, { version, request })`, `sessionForToken`, `isExpired`, `touch`, `updateBlocker`, `configuredProductFor`.

### Webhooks and test clocks

- `webhooks/delivery.js`: `signatureHeader(payload, secret, timestamp)`, `setWebhookEndpoints`, `listDeliveries`, `resendEvent`, `deliverDuplicate`, `holdDeliveries`, `releaseDeliveries`, `sendWithBadSignature`, `settleAccount(account)`, `settleServer(server)`, `dropEndpointDeliveries`, `USER_AGENT`, `DELIVERY_STATUSES`, `DELIVERY_KINDS`.
- `webhooks/endpoints.js`: `endpointsFor(account)`, `findEndpoint`, `receivesEvent(endpoint, type)`, `publicEndpoint`, `replaceControlEndpoints`, `createEndpoint`, `updateEndpoint`, `deleteEndpoint`, `MAX_API_ENDPOINTS`.
- `test_clocks/test_clocks.js`: `createClock`, `advanceClock`, `deleteClock`, `advanceLimit`, `renderClock`.

### Who calls whom

| Caller | Calls |
|---|---|
| customers | payments `attachPaymentMethod`, `requireAttachedPaymentMethod`; hook `customer.deleting` (payments detaches cards, billing cancels subscriptions) |
| core controls | payments `failNextCharge`; billing `createSubscriptionForTest`; webhook delivery functions |
| Checkout | customers; catalog (`preparePrice`, `createPrice`, `requirePrice`) and payments (`attachPaymentMethod`, `testCardOf`, `predictChargeFailure`, `cardDeclineError`); billing `createSubscription`, `payInvoice` and `updateSubscription` (2024-06-20 retry), `billing/util` amounts |
| billing engine and routes | customers (`changeCustomer` for currency / delinquent / balance / invoice numbering); catalog `requirePrice`, `preparePrice`, `insertPrice`; payments `createPaymentIntent`, `confirmPaymentIntent`, `cancelPaymentIntent`, `attachPaymentMethod`; schedules `onSubscriptionCanceled`, `onSubscriptionUpdated`; prices and products read through the store |
| hosted invoice page | payments `createCardPaymentMethod`, `attachPaymentMethod`; `checkout/page_kit`; billing `payInvoice` |
| schedules | billing `createSubscription`, `updateSubscription`, `cancelSubscription`, `setSubscriptionSchedule`, `currentPeriod`, `defaultBillingMode`, `billing/subscriptions` item parsing, `billing/invoicing` `emitUpdated` |
| portal | customers; payments `createCardPaymentMethod`, `attachPaymentMethod`, `detachPaymentMethod`; catalog `requirePrice`; `checkout/page_kit`, `checkout/pricing`; billing `changeSubscriptionItems`, `setCancelAtPeriodEnd`, `cancelSubscription`, `updateSubscription`; schedules `scheduleChangeAtPeriodEnd` |
| test clocks | customers `deleteCustomer`, `changeCustomer`; `account.time`; schedules `cancelSchedule`; subscriptions, schedules and prices read through the store (advance limit) |

---

## Tests

`test/helpers.js`: `startServer(options)` (closed after the test) → `{ server, url, port, key,
stripe(apiKey?, opts?), account(apiKey?), request(method, path, { key, form, json, headers }) }`;
`webhookReceiver({ status, delayMs })` → `{ url, deliveries[{ headers, rawBody, json }],
respondWith, waitFor(countOrPredicate), close }`; `rejection(promise)`; `testKey(label)`.
Drive everything through the real SDK (`stripe()` has `maxNetworkRetries: 0` unless overridden).
Tests live in `test/<area>*.test.js`; run one area with `pnpm vitest run test/<area>` and
everything with `pnpm vitest run`. `test/flows.test.js` drives whole Billing flows through the
SDK, the hosted pages (a small form-following browser) and a webhook receiver that verifies every
delivery with `stripe.webhooks.constructEvent`. `test/shapes.test.js` compares rendered objects
with the spec key sets in `test/fixtures/spec-keys.json`.

---

## Adding a resource

Customers (`src/customers/customers.js`) are the reference resource. Copy their pattern:

1. `install(app)` registers the serializer (`app.object('customer', { render, expandable,
   includable })`) and the routes; handlers are one-liners that find the object
   (`account.store.require(type, ctx.pathParams.id)` → 404 `resource_missing`) and call an
   exported domain function with `ctx.params`.
2. Domain functions (`createCustomer`, `updateCustomer`, `deleteCustomer`, `changeCustomer`) take
   `(account, object?, params, { request })`, so API routes, hosted pages, controls and other
   modules share one code path. They validate everything first (update applies the params to a
   `structuredClone` draft and only then copies it over), then mutate, then emit events.
3. IDs from `account.mintId(prefix)`, `created` from `account.time.now(domain)` (the customer's
   test clock when it has one), `livemode: false`, references stored as IDs, private fields
   prefixed `_`.
4. Events: `emitEvent(account, 'customer.created', customer)` after the object is complete;
   `updateWithEvent(account, customer, 'customer.updated', mutate)` for updates (an event only
   when something visible changed); deletions run a hook first so dependent modules act before
   `customer.deleted`.
5. The serializer builds a fresh object in the order of the API reference example, adds
   version-dependent keys with `ctx.family` / `ctx.atLeast`, and returns the deleted stub for a
   soft-deleted object; lists use `paginate` with the list's own default filters (customers on a
   test clock are hidden unless `test_clock` is given).
6. Tests drive it through the real SDK (`test/core.test.js`).

A new route also needs its operation in `src/schemas/params.js` (regenerate with
`scripts/build-param-schemas.mjs` after adding it to the script's operation list) and a response
type in `src/core/expand_schema.js` `RESPONSE_TYPES` (or `returns` on the route). A new module
with its own `install()` goes into `src/app.js`.
