/**
 * stripe-test-server: a local test server for Stripe Billing, driven by the official `stripe` SDK
 * through `new Stripe(key, { host: '127.0.0.1', port, protocol: 'http' })`.
 *
 * Everything (objects, time, events, idempotency keys, the request ledger, faults, settings and
 * webhook endpoints added per account) is kept separately per secret key: each `sk_test_…` or
 * `rk_test_…` key is its own account. `server.account(key)` returns the controls of one account;
 * every control is also an HTTP route under `/_test/`, authenticated with the same Bearer key.
 */

// Options -----------------------------------------------------------------------------------------

/** An API version string such as "2026-08-26.dahlia", "2025-03-31.basil" or "2024-06-20". */
export type ApiVersion = string;

/** A webhook endpoint that receives events (signed with `secret`). */
export interface WebhookEndpointOption {
  /** Absolute http(s) URL the events are POSTed to. */
  url: string;
  /** Signing secret, e.g. "whsec_…": Stripe-Signature is an HMAC-SHA256 keyed with it. */
  secret: string;
  /** API version the events are rendered in (default: the account's default version). */
  apiVersion?: ApiVersion;
}

/** What happens after failed subscription payments (Stripe's Billing "retry" settings). */
export interface BillingSettings {
  /**
   * Days between payment attempts after the first failed one; its length is the number of
   * retries (default seven 2-day steps: 8 attempts within 14 days).
   */
  retrySchedule: number[];
  /** What happens to the subscription after the last retry fails (default "cancel"). */
  afterFinalRetry: 'cancel' | 'unpaid' | 'past_due';
  /** Mark the invoice uncollectible after the last retry (default false: it stays open). */
  markUncollectible: boolean;
}

/** Webhook delivery timing. */
export interface WebhookRetryOptions {
  /** Delays before each retry of a failed automatic delivery (default [500, 2000, 5000]). */
  delaysMs?: number[];
  /** How long to wait for a receiver's response (default 10000). */
  timeoutMs?: number;
}

/** One log line (the `log` option). */
export interface LogEntry {
  level: 'info' | 'error';
  message: string;
}

export interface StripeTestServerOptions {
  /** Port to listen on (default 0: a free port). */
  port?: number;
  /** Interface to bind (default "127.0.0.1"). */
  host?: string;
  /** Endpoints that receive the events of every account. */
  webhooks?: WebhookEndpointOption[];
  /** Default API version of accounts (default "2026-08-26.dahlia", the version stripe-node 22 sends). */
  apiVersion?: ApiVersion;
  /** Billing settings every account starts with (each can change its own copy). */
  billing?: Partial<BillingSettings>;
  webhookRetry?: WebhookRetryOptions;
  /** true prints one line per request and delivery to the console; a function receives each line. */
  log?: boolean | ((entry: LogEntry) => void);
  /**
   * true gives every customer created without `test_clock` (by the API or Checkout) a
   * test clock of its own at the account time, which `advanceTime` advances to the new account
   * time. Its objects then report that `test_clock`, as they would at Stripe. Default false.
   */
  testClockPerCustomer?: boolean;
}

// Controls ------------------------------------------------------------------------------------------

/** A fault to inject into matching /v1 requests of one account. */
export interface FaultSpec {
  /** HTTP method to match (default: any). */
  method?: 'GET' | 'POST' | 'DELETE' | (string & {});
  /** Request path to match exactly, or a prefix ending in "*" (e.g. "/v1/customers*"). */
  path: string;
  /** How many matching requests fail (default 1). */
  times?: number;
  /**
   * "500": a 500 api_error (the SDK retries it); "429": a rate_limit error; "timeout": no answer,
   * the connection is held until the client gives up (the SDK's `timeout` gives
   * StripeConnectionError), or dropped after `timeoutMs` when set. The request is never executed.
   */
  kind: '500' | '429' | 'timeout';
  /**
   * For "timeout": drop the connection after this many ms (0 to 2147483647) instead of holding it.
   * The SDK takes a dropped connection as a reset and sends the request again once, even with
   * maxNetworkRetries 0, so `times` must cover that attempt too. Default: held (null).
   */
  timeoutMs?: number | null;
}

/** A registered fault. */
export interface Fault {
  id: string;
  method: string | null;
  path: string;
  kind: '500' | '429' | 'timeout';
  times: number;
  /** Matching requests that will still fail. */
  remaining: number;
  timeoutMs: number | null;
}

/** One /v1 request of the ledger (secret keys and card data redacted). */
export interface LedgerEntry {
  /** The Request-Id sent back. */
  id: string;
  method: string;
  path: string;
  /** Parsed query string. */
  query: Record<string, unknown>;
  /** Parsed form body (POST). */
  body: Record<string, unknown>;
  /** Response status (null for a "timeout" fault). */
  status: number | null;
  /** Resolved API version (null when the request failed before resolving it). */
  version: ApiVersion | null;
  idempotencyKey: string | null;
  /** True when the response was replayed for a reused idempotency key. */
  replayed: boolean;
  fault: '500' | '429' | 'timeout' | null;
  /** Account clock time of the request (unix seconds). */
  time: number;
  /** Real time the request arrived (ISO 8601). */
  realTime: string;
  durationMs: number;
}

/** A pending time-driven transition (renewal, trial end, finalization, retry, …). */
export interface ScheduledJob {
  id: string;
  /** e.g. "subscription.renewal", "invoice.finalize", "invoice.payment_retry". */
  kind: string;
  /** Unix seconds on its time domain. */
  at: number;
  /** null for the account clock, else the test clock ID ("clock_…"). */
  domain: string | null;
  key?: string;
  data: Record<string, unknown>;
  priority: number;
  seq: number;
}

/** The result of the `state` control. */
export interface AccountState {
  /** Account clock time (unix seconds). */
  now: number;
  /** Frozen time of each test clock. */
  clocks: Record<string, number>;
  /** Objects by type ("customer", "subscription", …): rendered at the account's default version, or internal copies with `raw`. */
  objects: Record<string, Record<string, unknown>[]>;
  /** Pending transitions, soonest first. */
  jobs: ScheduledJob[];
  /** Number of events. */
  events: number;
}

/** A customer deleted through the `deleteCustomer` control. */
export interface DeletedCustomer {
  id: string;
  object: 'customer';
  deleted: true;
}

/** The result of `failNextCharge`. */
export interface FailNextChargeResult {
  customer: string;
  /** Forced failures still queued for the customer. */
  remaining: number;
  declineCode: string;
}

/** A subscription as the API renders it at the account's default version. */
export interface SubscriptionJson {
  id: string;
  object: 'subscription';
  customer: string;
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  [key: string]: unknown;
}

/** A webhook endpoint as the server keeps it. */
export interface WebhookEndpointRecord {
  id: string;
  object: 'webhook_endpoint';
  /** "server" for endpoints from the options, "account" for the account's own. */
  scope: 'server' | 'account';
  /** Account endpoints: added by `setWebhookEndpoints` ("control") or POST /v1/webhook_endpoints ("api"). */
  source?: 'control' | 'api';
  url: string;
  secret: string;
  apiVersion: ApiVersion | null;
  /** "*" for every event. */
  enabledEvents: string[];
  status: 'enabled' | 'disabled';
  description: string | null;
  metadata: Record<string, string>;
  created: number;
}

/** queued, held, in_flight and retrying are open; the others are final. */
export type WebhookDeliveryStatus = 'queued' | 'held' | 'in_flight' | 'retrying' | 'succeeded' | 'failed' | 'canceled';

/** Automatic deliveries retry and count in the event's pending_webhooks; the manual kinds are one attempt each. */
export type WebhookDeliveryKind = 'automatic' | 'resend' | 'duplicate' | 'bad_signature';

/** One HTTP attempt of a delivery. */
export interface WebhookDeliveryAttempt {
  /** 1 for the first attempt. */
  attempt: number;
  url: string;
  /** The `t` of Stripe-Signature (real unix seconds). */
  signatureTimestamp: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  responseStatus: number | null;
  /** Timeout or connection error. */
  error: string | null;
  /** The first 2000 characters of the response body. */
  responseBody: string | null;
}

/** A delivery of one event to one endpoint. */
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  endpointId: string;
  url: string;
  /** Version the event is rendered in for this endpoint. */
  apiVersion: ApiVersion;
  kind: WebhookDeliveryKind;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  /** ISO 8601 timestamps (real time). */
  createdAt: string;
  nextAttemptAt: string | null;
  completedAt: string | null;
  history: WebhookDeliveryAttempt[];
}

/** Filters of `webhooks.deliveries()`; `limit` keeps the last `limit` records. */
export interface WebhookDeliveryFilter {
  eventId?: string;
  eventType?: string;
  endpointId?: string;
  status?: WebhookDeliveryStatus;
  kind?: WebhookDeliveryKind;
  limit?: number;
}

/** The deliveries a manual control queued (one per subscribed endpoint, two for duplicates). */
export interface ManualDeliveryResult {
  eventId: string;
  deliveries: WebhookDelivery[];
}

/**
 * What a control rejects with for invalid input (the HTTP route answers the same status with
 * these fields in a Stripe error envelope).
 */
export interface ControlError extends Error {
  name: 'StripeError';
  /** HTTP status of the equivalent /_test/ request (400, 404, …). */
  status: number;
  /** "invalid_request_error". */
  type: string;
  code?: string;
  /** The offending input field, e.g. "customer" or "endpoints[0][url]". */
  param?: string;
}

/**
 * Controls for one account (one API key); every method mirrors an HTTP route under /_test/ and
 * rejects with a ControlError for invalid input.
 */
export interface AccountControls {
  readonly key: string;
  /** The account's acct_… ID (used in hosted invoice URLs). */
  readonly id: string;
  /** Clears all objects, time, events, idempotency keys, ledger, faults, settings and endpoints. */
  reset(): Promise<{ reset: true }>;
  /** Moves the account clock forward, running every due billing transition in order. */
  advanceTime(by: { seconds: number } | { to: number }): Promise<{ now: number }>;
  /** Account clock time (unix seconds). */
  now(): Promise<{ now: number }>;
  /** Objects by type, pending transitions and test clocks. */
  state(filter?: { type?: string; raw?: boolean }): Promise<AccountState>;
  /** The request ledger, oldest first (`path` may end in "*" to match a prefix). */
  requests(filter?: { limit?: number; method?: string; path?: string }): Promise<LedgerEntry[]>;
  faults: {
    add(spec: FaultSpec): Promise<Fault>;
    clear(): Promise<{ cleared: number }>;
    list(): Promise<Fault[]>;
  };
  billingSettings(): Promise<BillingSettings>;
  updateBillingSettings(patch: Partial<BillingSettings>): Promise<BillingSettings>;
  /** Deletes a customer as the Dashboard would (its subscriptions end; events carry request: null). */
  deleteCustomer(customerId: string): Promise<DeletedCustomer>;
  /**
   * The next `times` payment attempts for the customer fail with card_declined and
   * `declineCode` (default "generic_decline"), whatever the card.
   */
  failNextCharge(customerId: string, opts?: { times?: number; declineCode?: string }): Promise<FailNextChargeResult>;
  /** The next card refunds return pending and fail after delaySeconds (default 60) on the customer clock, emitting refund.failed. */
  failNextRefund(customerId: string, opts?: { times?: number; delaySeconds?: number; failureReason?: 'declined' | 'expired_or_canceled_card' | 'insufficient_funds' | 'lost_or_stolen_card' | 'unknown' }): Promise<{ customer: string; remaining: number; failureReason: string; delaySeconds: number }>;
  /**
   * Creates a live subscription directly (e.g. a second one), bypassing Checkout. Without
   * `paymentMethod` it charges the customer's default card, else the card of their newest
   * subscription, else their newest attached card.
   */
  createSubscription(
    customerId: string,
    opts: { price: string; quantity?: number; trialDays?: number; paymentMethod?: string },
  ): Promise<SubscriptionJson>;
  /** Replaces this account's control-added webhook endpoints (API-created and server-wide ones stay). */
  setWebhookEndpoints(endpoints: WebhookEndpointOption[]): Promise<WebhookEndpointRecord[]>;
  webhooks: {
    /** Delivery records, oldest first. */
    deliveries(filter?: WebhookDeliveryFilter): Promise<WebhookDelivery[]>;
    /** Sends the event once more to every subscribed endpoint. */
    resend(eventId: string): Promise<ManualDeliveryResult>;
    /** Sends the event twice more to every subscribed endpoint (same ID and body, new signatures). */
    deliverDuplicate(eventId: string): Promise<ManualDeliveryResult>;
    /** Holds every delivery until release(); returns how many are held. */
    hold(): Promise<{ held: true; deliveries: number }>;
    /** Sends the held deliveries: in order, reversed, or the listed events first. */
    release(opts?: { order?: 'fifo' | 'reverse' | string[] }): Promise<{ released: number; deliveries: WebhookDelivery[] }>;
    /** Sends the event with a Stripe-Signature that does not verify. */
    sendWithBadSignature(eventId: string): Promise<ManualDeliveryResult>;
    /** Resolves when no delivery is queued, in flight or waiting to retry (held ones excepted). */
    settle(): Promise<{ settled: true }>;
  };
}

// Server ----------------------------------------------------------------------------------------------

export interface StripeTestServer {
  /** e.g. "http://127.0.0.1:53211"; hosted pages (Checkout, portal, invoices) live under it too. */
  readonly url: string;
  readonly port: number;
  /** Controls for the account of a sk_test_… / rk_test_… key (created on first use). */
  account(apiKey: string): AccountControls;
  /** API keys seen so far. */
  accounts(): string[];
  /** Resets every account. */
  reset(): Promise<void>;
  /** Resolves when no webhook delivery is pending on any account. */
  settle(): Promise<void>;
  /** Stops the server: closes connections and drops timers. */
  close(): Promise<void>;
  /** Internals for advanced use; not a stable API. */
  readonly context: unknown;
}

/** The API version stripe-node 22.6.2 sends, and the default account version. */
export declare const LATEST_VERSION: '2026-08-26.dahlia';
export declare const DEFAULT_BILLING_SETTINGS: Readonly<BillingSettings>;
export declare const DEFAULT_WEBHOOK_RETRY: Readonly<Required<WebhookRetryOptions>>;

/** Starts a server; resolves once it listens. */
export declare function createStripeTestServer(options?: StripeTestServerOptions): Promise<StripeTestServer>;
export default createStripeTestServer;
