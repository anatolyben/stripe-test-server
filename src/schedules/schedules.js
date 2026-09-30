/**
 * Subscription schedules (docs.stripe.com/api/subscription_schedules): phases that change a
 * subscription when they start, completion or release at the end, and the helpers the customer
 * portal (scheduled downgrades) and the billing engine (cancellations, direct updates) call.
 *
 * Routes: POST /v1/subscription_schedules (phases or from_subscription), GET
 * /v1/subscription_schedules, GET /v1/subscription_schedules/:id, POST
 * /v1/subscription_schedules/:id, POST /v1/subscription_schedules/:id/release, POST
 * /v1/subscription_schedules/:id/cancel.
 * Internal object: the 2026-08-26.dahlia wire shape; phase items keep `price` / `plan` as IDs; private
 * `_phase` (index of the current phase), `_version` (creating request's version).
 * Jobs: the start of a not_started schedule, every phase end (next phase, or completion at the
 * last one, before a renewal due at the same second), and subscription_schedule.expiring 7 days
 * before the end. Events: subscription_schedule.created / .updated / .released / .canceled /
 * .completed / .aborted / .expiring.
 */
import { emitEvent } from '../core/events.js';
import { invalidRequest, parameterMissing, parametersExclusive, resourceMissing } from '../core/errors.js';
import { matchesRange, paginate } from '../core/list.js';
import { addIntervals } from '../core/periods.js';
import { JOB_PRIORITY } from '../core/time.js';
import { applyMetadata } from '../core/util.js';
import { requireCustomer } from '../customers/customers.js';
import * as engine from '../billing/engine.js';
import { emitUpdated } from '../billing/invoicing.js';
import { checkQuantity, materialize, rejectDiscounts, resolveItemPrice } from '../billing/subscriptions.js';
import { DAY, ENDED_STATUSES, attachedPaymentMethod, intervalOf, nowOf } from '../billing/util.js';

const LIVE = new Set(['not_started', 'active']);
const EXPIRING_NOTICE_SECONDS = 7 * DAY;
const MAX_PHASES = 10;

export const JOB = Object.freeze({
  start: 'subscription_schedule.start',
  phaseEnd: 'subscription_schedule.phase_end',
  expiring: 'subscription_schedule.expiring',
});

// Construction ----------------------------------------------------------------------------------

function newScheduleItem({ price, quantity, metadata }) {
  const item = { billing_thresholds: null, discounts: [], metadata: { ...(metadata ?? {}) }, plan: price.id, price: price.id };
  if (price.recurring?.usage_type !== 'metered') item.quantity = quantity ?? 1;
  item.tax_rates = [];
  return item;
}

/** A phase in the wire shape; `items` are {price (internal), quantity, metadata}. */
function newPhase(p) {
  return {
    add_invoice_items: (p.addInvoiceItems ?? []).map((a) => ({
      discountable: true,
      discounts: [],
      metadata: { ...(a.metadata ?? {}) },
      period: { end: { type: 'phase_end' }, start: { type: 'phase_start' } },
      price: a.price.id,
      quantity: a.quantity ?? 1,
      tax_rates: [],
    })),
    application_fee_percent: null,
    billing_cycle_anchor: p.billingCycleAnchor ?? null,
    billing_thresholds: null,
    collection_method: p.collectionMethod ?? null,
    currency: p.currency,
    default_payment_method: p.defaultPaymentMethod ?? null,
    description: p.description ?? null,
    discounts: [],
    end_date: p.end,
    invoice_settings: p.invoiceSettings ?? null,
    items: p.items.map(newScheduleItem),
    metadata: { ...(p.metadata ?? {}) },
    on_behalf_of: null,
    proration_behavior: p.prorationBehavior ?? 'create_prorations',
    start_date: p.start,
    transfer_data: null,
    trial: p.trial ?? null,
    trial_end: p.trialEnd ?? null,
  };
}

function defaultSettings(ds = {}, previous = null) {
  const base = previous ?? {
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null },
    billing_cycle_anchor: 'automatic',
    billing_thresholds: null,
    collection_method: 'charge_automatically',
    default_payment_method: null,
    description: null,
    invoice_settings: { account_tax_ids: null, custom_fields: null, days_until_due: null, description: null, footer: null, issuer: { type: 'self' } },
    on_behalf_of: null,
    transfer_data: null,
  };
  const out = structuredClone(base);
  if (ds.billing_cycle_anchor !== undefined) out.billing_cycle_anchor = ds.billing_cycle_anchor;
  if (ds.collection_method !== undefined) out.collection_method = ds.collection_method;
  if (ds.default_payment_method !== undefined) out.default_payment_method = ds.default_payment_method || null;
  if (ds.description !== undefined) out.description = ds.description === '' ? null : ds.description;
  if (ds.automatic_tax !== undefined) out.automatic_tax = { disabled_reason: null, enabled: Boolean(ds.automatic_tax.enabled), liability: ds.automatic_tax.liability ?? null };
  if (ds.invoice_settings !== undefined) {
    const s = ds.invoice_settings;
    const cur = out.invoice_settings;
    if (s.days_until_due !== undefined) cur.days_until_due = s.days_until_due;
    if (s.account_tax_ids !== undefined) cur.account_tax_ids = s.account_tax_ids === '' ? null : s.account_tax_ids;
    if (s.custom_fields !== undefined) cur.custom_fields = s.custom_fields === '' ? null : s.custom_fields;
    if (s.description !== undefined) cur.description = s.description === '' ? null : s.description;
    if (s.footer !== undefined) cur.footer = s.footer === '' ? null : s.footer;
    if (s.issuer !== undefined) cur.issuer = s.issuer;
  }
  return out;
}

function newSchedule(account, { customer, now, billingMode, endBehavior, metadata, settings, phases, version }) {
  return {
    id: account.mintId('sub_sched'),
    object: 'subscription_schedule',
    application: null,
    billing_mode: { flexible: billingMode === 'flexible' ? { proration_discounts: 'included' } : null, type: billingMode, updated_at: now },
    canceled_at: null,
    completed_at: null,
    created: now,
    current_phase: null,
    customer: customer.id,
    customer_account: null,
    default_settings: settings,
    end_behavior: endBehavior,
    livemode: false,
    metadata: { ...(metadata ?? {}) },
    phases,
    released_at: null,
    released_subscription: null,
    status: 'not_started',
    subscription: null,
    test_clock: customer.test_clock ?? null,
    _phase: -1,
    _version: version,
  };
}

/** A phase's settings with the schedule's default_settings filled in. */
function effectiveSettings(schedule, phase) {
  const ds = schedule.default_settings;
  return {
    collectionMethod: phase.collection_method ?? ds.collection_method ?? 'charge_automatically',
    defaultPaymentMethod: phase.default_payment_method ?? ds.default_payment_method ?? null,
    daysUntilDue: phase.invoice_settings?.days_until_due ?? ds.invoice_settings?.days_until_due ?? null,
    billingCycleAnchor: phase.billing_cycle_anchor ?? ds.billing_cycle_anchor ?? 'automatic',
    description: phase.description ?? ds.description ?? null,
  };
}

// Jobs ------------------------------------------------------------------------------------------

function scheduleJobs(account, schedule) {
  account.time.cancelWhere((job) => job.key !== undefined && job.key.startsWith(`${schedule.id}:`));
  if (!LIVE.has(schedule.status)) return;
  const domain = account.time.domainOf(schedule);
  const now = nowOf(account, schedule);
  if (schedule.status === 'not_started') {
    account.time.schedule({ kind: JOB.start, at: schedule.phases[0].start_date, domain, key: `${schedule.id}:start`, data: { schedule: schedule.id }, priority: JOB_PRIORITY.schedulePhase });
  } else {
    const phase = schedule.phases[schedule._phase];
    account.time.schedule({ kind: JOB.phaseEnd, at: phase.end_date, domain, key: `${schedule.id}:phase_end`, data: { schedule: schedule.id, phase: schedule._phase }, priority: JOB_PRIORITY.schedulePhase });
  }
  const end = schedule.phases.at(-1).end_date;
  if (end - EXPIRING_NOTICE_SECONDS > now) {
    account.time.schedule({ kind: JOB.expiring, at: end - EXPIRING_NOTICE_SECONDS, domain, key: `${schedule.id}:expiring`, data: { schedule: schedule.id, end } });
  }
}

// Phases → subscription ---------------------------------------------------------------------------

/** Items changes that turn the subscription's items into the phase's (same price → same item). */
function itemChanges(account, sub, phaseItems) {
  const current = sub.items.data.map((item) => ({ item, used: false }));
  const next = phaseItems.map((pi) => ({ pi, match: null }));
  for (const n of next) {
    const c = current.find((x) => !x.used && x.item.price === n.pi.price);
    if (c) {
      c.used = true;
      n.match = c.item;
    }
  }
  for (const n of next) {
    if (n.match) continue;
    const c = current.find((x) => !x.used);
    if (c) {
      c.used = true;
      n.match = c.item;
    }
  }
  const entries = next.map((n) => {
    const entry = { price: account.store.get('price', n.pi.price), quantity: n.pi.quantity, metadata: n.pi.metadata };
    if (n.match) entry.id = n.match.id;
    return entry;
  });
  for (const c of current) if (!c.used) entries.push({ id: c.item.id, deleted: true });
  return entries;
}

/** The subscription update that enters `phase` (prorations per the phase unless overridden). */
function phaseUpdate(account, schedule, index, sub, { prorationBehavior } = {}) {
  const phase = schedule.phases[index];
  const s = effectiveSettings(schedule, phase);
  const now = nowOf(account, sub);
  const u = {
    items: itemChanges(account, sub, phase.items),
    prorationBehavior: prorationBehavior ?? phase.proration_behavior,
    billingCycleAnchor: s.billingCycleAnchor === 'phase_start' && index > 0 ? 'now' : undefined,
  };
  if (s.defaultPaymentMethod !== sub.default_payment_method && attachedPaymentMethod(account, s.defaultPaymentMethod, sub.customer)) u.defaultPaymentMethod = s.defaultPaymentMethod;
  if (s.collectionMethod !== sub.collection_method) {
    u.collectionMethod = s.collectionMethod;
    if (s.collectionMethod === 'send_invoice') u.daysUntilDue = s.daysUntilDue ?? 30;
  }
  if (Object.keys(phase.metadata).length) u.metadata = phase.metadata;
  if (phase.description !== null && phase.description !== sub.description) u.description = phase.description;
  const trialEnd = phase.trial ? phase.end_date : phase.trial_end;
  if (trialEnd && trialEnd > now && trialEnd !== sub.trial_end) u.trialEnd = trialEnd;
  const last = index === schedule.phases.length - 1;
  if (last && ['cancel', 'none'].includes(schedule.end_behavior) && sub.cancel_at !== phase.end_date && phase.end_date > now) u.cancelAt = phase.end_date;
  return u;
}

/** A not_started schedule starts: its subscription is created with the first phase. */
function startSchedule(account, schedule, { request } = {}) {
  const customer = account.store.get('customer', schedule.customer);
  const phase = schedule.phases[0];
  const s = effectiveSettings(schedule, phase);
  const now = nowOf(account, schedule);
  const last = schedule.phases.length === 1;
  const { subscription } = engine.createSubscription(
    account,
    {
      customer,
      items: phase.items.map((i) => ({ price: account.store.get('price', i.price), quantity: i.quantity, metadata: i.metadata })),
      addInvoiceItems: phase.add_invoice_items.map((a) => ({ price: account.store.get('price', a.price), quantity: a.quantity })),
      metadata: phase.metadata,
      description: s.description,
      defaultPaymentMethod: attachedPaymentMethod(account, s.defaultPaymentMethod, customer.id) ? s.defaultPaymentMethod : null,
      collectionMethod: s.collectionMethod,
      daysUntilDue: s.collectionMethod === 'send_invoice' ? s.daysUntilDue ?? 30 : undefined,
      trialEnd: phase.trial ? phase.end_date : phase.trial_end ?? undefined,
      billingMode: schedule.billing_mode.type,
      backdateStartDate: phase.start_date < now ? phase.start_date : undefined,
      cancelAt: last && ['cancel', 'none'].includes(schedule.end_behavior) ? phase.end_date : undefined,
      prorationBehavior: phase.proration_behavior === 'none' ? 'none' : undefined,
      schedule: schedule.id,
    },
    { source: 'schedule', version: schedule._version, request },
  );
  schedule.status = 'active';
  schedule.subscription = subscription.id;
  schedule._phase = 0;
  schedule.current_phase = { end_date: phase.end_date, start_date: phase.start_date };
  return subscription;
}

/** The current phase ended: enter the next one, or complete the schedule after the last. */
function advance(account, schedule, { request } = {}) {
  const sub = account.store.get('subscription', schedule.subscription);
  if (!sub || ENDED_STATUSES.has(sub.status)) return;
  const index = schedule._phase + 1;
  const next = schedule.phases[index];
  if (!next) return complete(account, schedule, sub, { request });
  const previous = structuredClone(schedule);
  schedule._phase = index;
  schedule.current_phase = { end_date: next.end_date, start_date: next.start_date };
  emitUpdated(account, schedule, 'subscription_schedule.updated', previous, { request });
  engine.updateSubscription(account, sub, phaseUpdate(account, schedule, index, sub), { source: 'schedule', request });
  scheduleJobs(account, schedule);
}

/**
 * The last phase ended (the schedule's status becomes completed): end_behavior release leaves the
 * subscription running without a schedule; cancel cancels it.
 */
function complete(account, schedule, sub, { request } = {}) {
  const now = nowOf(account, schedule);
  if (['cancel', 'none'].includes(schedule.end_behavior) && !ENDED_STATUSES.has(sub.status)) {
    // The last phase set the subscription's cancel_at to its end, so this is a period-end cancel:
    // pending prorations go on a final invoice ("pending invoice items are always charged when the
    // billing period ends for any canceled subscription", docs.stripe.com/billing/invoices/subscription).
    const at = schedule.current_phase?.end_date ?? now;
    engine.cancelSubscription(account, sub, { source: 'schedule', reason: 'cancellation_requested', periodEnd: true, at, request });
  }
  schedule.status = 'completed';
  schedule.completed_at = now;
  schedule.current_phase = null;
  scheduleJobs(account, schedule);
  emitEvent(account, 'subscription_schedule.completed', schedule, { request });
  if (!ENDED_STATUSES.has(sub.status) && sub.schedule === schedule.id) engine.setSubscriptionSchedule(account, sub, null, { request });
}

// Params ----------------------------------------------------------------------------------------

/**
 * Validates phases params into phase specs (prices may be price_data drafts, created by the
 * caller's `resolved` once everything is valid). `start` is the first given phase's start.
 */
function parsePhases(ctx, phases, { start, customer, firstParamStart, update }) {
  const now = ctx.account.time.now(ctx.account.time.domainOf(customer));
  const resolved = [];
  const out = [];
  let cursor = start;
  phases.forEach((p, i) => {
    const param = `phases[${i}]`;
    rejectDiscounts(p.discounts, `${param}[discounts]`);
    if (p.coupon !== undefined && p.coupon !== '') throw resourceMissing('coupon', p.coupon, { param: `${param}[coupon]` });
    for (const key of ['on_behalf_of', 'transfer_data', 'application_fee_percent']) {
      if (p[key] !== undefined) throw invalidRequest(`The ${key} parameter (Connect) is not supported by this test server.`, { param: `${param}[${key}]` });
    }
    if (p.start_date !== undefined) {
      const given = p.start_date === 'now' ? now : p.start_date;
      if (i === 0 && firstParamStart) cursor = given;
      else if (given !== cursor) {
        throw invalidRequest('Phases must be contiguous: a phase starts when the previous one ends.', { param: `${param}[start_date]` });
      }
    }
    if (!p.items || !p.items.length) throw parameterMissing(`${param}[items]`);
    const items = p.items.map((e, j) => {
      const r = resolveItemPrice(ctx, e, `${param}[items][${j}]`, { recurring: true, required: true });
      checkQuantity(r.price, e.quantity, `${param}[items][${j}][quantity]`);
      resolved.push(r);
      return { price: r.price, quantity: e.quantity, metadata: e.metadata };
    });
    const adds = (p.add_invoice_items ?? []).map((e, j) => {
      const r = resolveItemPrice(ctx, e, `${param}[add_invoice_items][${j}]`, { recurring: false, required: true });
      resolved.push(r);
      return { price: r.price, quantity: e.quantity ?? 1, metadata: e.metadata };
    });
    const currency = items[0].price.currency;
    if (items.some((it) => it.price.currency !== currency) || (p.currency !== undefined && p.currency !== currency)) {
      throw invalidRequest('All prices of a phase must share one currency.', { param: `${param}[items]` });
    }
    const lengths = ['end_date', 'duration', 'iterations'].filter((k) => p[k] !== undefined);
    if (lengths.length > 1) throw parametersExclusive(lengths.map((k) => `${param}[${k}]`));
    const { interval, count } = intervalOf(items[0].price);
    let end;
    if (p.end_date !== undefined) end = p.end_date === 'now' ? now : p.end_date;
    else if (p.duration !== undefined) end = addIntervals(cursor, p.duration.interval, p.duration.interval_count ?? 1, 1);
    else if (p.iterations !== undefined) end = addIntervals(cursor, interval, count * p.iterations, 1);
    else if (i === phases.length - 1) end = addIntervals(cursor, interval, count, 1);
    else throw parameterMissing(`${param}[end_date]`);
    if (end <= cursor) throw invalidRequest('A phase must end after it starts.', { param: `${param}[end_date]` });
    if (!update && end <= now) throw invalidRequest('A phase must end in the future.', { param: `${param}[end_date]` });
    let trialEnd = null;
    if (p.trial_end !== undefined) {
      trialEnd = p.trial_end === 'now' ? now : p.trial_end;
      if (trialEnd < cursor || trialEnd > end) throw invalidRequest('trial_end must fall within the phase.', { param: `${param}[trial_end]` });
      if (p.trial === true && trialEnd !== end) {
        throw invalidRequest('trial_end must equal the phase end_date when trial is true.', { param: `${param}[trial_end]` });
      }
    }
    out.push({
      start: cursor,
      end,
      items,
      addInvoiceItems: adds,
      currency,
      metadata: p.metadata,
      description: p.description === '' ? null : p.description,
      defaultPaymentMethod: p.default_payment_method,
      collectionMethod: p.collection_method,
      billingCycleAnchor: p.billing_cycle_anchor,
      invoiceSettings: p.invoice_settings ? { account_tax_ids: null, custom_fields: null, days_until_due: p.invoice_settings.days_until_due ?? null, description: null, footer: null, issuer: null } : null,
      prorationBehavior: p.proration_behavior,
      trial: p.trial ?? null,
      trialEnd,
    });
    cursor = end;
  });
  if (out.filter((ph) => ph.end > now).length > MAX_PHASES) {
    throw invalidRequest(`A subscription schedule can have at most ${MAX_PHASES} current or future phases.`, { param: 'phases' });
  }
  const currencies = new Set(out.map((ph) => ph.currency));
  if (currencies.size > 1) throw invalidRequest('All phases of a schedule must share one currency.', { param: 'phases' });
  for (const ph of out) {
    if (ph.defaultPaymentMethod && !attachedPaymentMethod(ctx.account, ph.defaultPaymentMethod, customer.id)) {
      throw invalidRequest(`The customer does not have a payment method with the ID ${ph.defaultPaymentMethod}.`, { param: 'phases' });
    }
  }
  return { phases: out, resolved };
}

function endBehaviorOf(value) {
  if (value === 'renew') throw invalidRequest('end_behavior=renew can no longer be set; use release or cancel.', { param: 'end_behavior' });
  return value === 'none' ? 'cancel' : value ?? 'release';
}

function checkUnsupported(p) {
  const ds = p.default_settings;
  for (const key of ['on_behalf_of', 'transfer_data', 'application_fee_percent']) {
    if (ds?.[key] !== undefined && ds[key] !== '') throw invalidRequest(`The ${key} parameter (Connect) is not supported by this test server.`, { param: `default_settings[${key}]` });
  }
  if (p.customer_account !== undefined) throw invalidRequest('The customer_account parameter (Accounts v2) is not supported by this test server.', { param: 'customer_account' });
}

// Operations ------------------------------------------------------------------------------------

/** POST /v1/subscription_schedules. */
function createSchedule(ctx) {
  const { account, params: p } = ctx;
  checkUnsupported(p);
  if (p.from_subscription !== undefined) {
    const others = ['customer', 'phases', 'start_date', 'end_behavior', 'default_settings', 'billing_mode', 'metadata'].filter((k) => p[k] !== undefined);
    if (others.length) throw invalidRequest(`You cannot set ${others[0]} when creating a schedule from_subscription.`, { param: others[0] });
    const sub = account.store.get('subscription', p.from_subscription);
    if (!sub) throw resourceMissing('subscription', p.from_subscription, { param: 'from_subscription' });
    return createFromSubscription(account, sub, { version: ctx.version });
  }
  if (p.customer === undefined) throw parameterMissing('customer');
  const customer = requireCustomer(account, p.customer, { param: 'customer' });
  if (!p.phases || !p.phases.length) throw parameterMissing('phases');
  const now = account.time.now(account.time.domainOf(customer));
  const start = p.start_date === undefined || p.start_date === 'now' ? now : p.start_date;
  const { phases, resolved } = parsePhases(ctx, p.phases, { start, customer, firstParamStart: false, update: false });
  if (p.default_settings?.default_payment_method && !attachedPaymentMethod(account, p.default_settings.default_payment_method, customer.id)) {
    throw invalidRequest(`The customer does not have a payment method with the ID ${p.default_settings.default_payment_method}.`, { param: 'default_settings[default_payment_method]' });
  }
  const endBehavior = endBehaviorOf(p.end_behavior);
  materialize(account, resolved);
  const schedule = newSchedule(account, {
    customer,
    now,
    billingMode: p.billing_mode?.type ?? engine.defaultBillingMode(ctx.version),
    endBehavior,
    metadata: p.metadata === '' ? {} : p.metadata,
    settings: defaultSettings(p.default_settings ?? {}),
    phases: phases.map(newPhase),
    version: ctx.version,
  });
  account.store.insert(schedule);
  if (start <= now) startSchedule(account, schedule);
  emitEvent(account, 'subscription_schedule.created', schedule);
  scheduleJobs(account, schedule);
  return schedule;
}

/**
 * from_subscription: one phase for the subscription's current period with its items, released at
 * the end ("set to auto-renew using the subscription's interval"); no prorations.
 */
function createFromSubscription(account, sub, { version, request } = {}) {
  if (ENDED_STATUSES.has(sub.status)) throw invalidRequest(`The subscription ${sub.id} has ended and cannot be scheduled.`, { param: 'from_subscription' });
  if (sub.schedule) throw invalidRequest(`The subscription ${sub.id} already has a schedule (${sub.schedule}).`, { param: 'from_subscription' });
  const customer = account.store.get('customer', sub.customer);
  const now = nowOf(account, sub);
  const period = engine.currentPeriod(sub);
  const phase = newPhase({
    start: sub.status === 'trialing' ? sub.trial_start ?? period.start : period.start,
    end: period.end,
    items: sub.items.data.map((i) => ({ price: account.store.get('price', i.price), quantity: i.quantity, metadata: i.metadata })),
    currency: sub.currency,
    prorationBehavior: 'create_prorations',
    trialEnd: sub.status === 'trialing' ? sub.trial_end : null,
  });
  const schedule = newSchedule(account, {
    customer,
    now,
    billingMode: sub.billing_mode.type,
    endBehavior: 'release',
    metadata: {},
    settings: defaultSettings({ collection_method: sub.collection_method, default_payment_method: sub.default_payment_method ?? undefined, invoice_settings: { days_until_due: sub.days_until_due } }),
    phases: [phase],
    version: version ?? account.settings.apiVersion,
  });
  schedule.status = 'active';
  schedule.subscription = sub.id;
  schedule._phase = 0;
  schedule.current_phase = { end_date: phase.end_date, start_date: phase.start_date };
  account.store.insert(schedule);
  emitEvent(account, 'subscription_schedule.created', schedule, { request });
  engine.setSubscriptionSchedule(account, sub, schedule.id, { request });
  scheduleJobs(account, schedule);
  return schedule;
}

/** POST /v1/subscription_schedules/:id: resend current and future phases; the active phase updates the subscription. */
function updateSchedule(ctx, schedule) {
  const { account, params: p } = ctx;
  checkUnsupported(p);
  if (!LIVE.has(schedule.status)) {
    throw invalidRequest(`You cannot update a subscription schedule that is ${schedule.status}.`);
  }
  const customer = account.store.get('customer', schedule.customer);
  const now = nowOf(account, schedule);
  const active = schedule.status === 'active';
  let parsed = null;
  if (p.phases !== undefined) {
    if (!p.phases.length) throw parameterMissing('phases');
    const current = active ? schedule.phases[schedule._phase] : null;
    const start = active ? current.start_date : schedule.phases[0].start_date;
    if (active && p.phases[0].start_date !== undefined && p.phases[0].start_date !== 'now' && p.phases[0].start_date !== current.start_date) {
      throw invalidRequest('The first phase must be the current phase: its start_date cannot change.', { param: 'phases[0][start_date]' });
    }
    parsed = parsePhases(ctx, p.phases, { start, customer, firstParamStart: !active, update: true });
  }
  if (p.default_settings?.default_payment_method && !attachedPaymentMethod(account, p.default_settings.default_payment_method, customer.id)) {
    throw invalidRequest(`The customer does not have a payment method with the ID ${p.default_settings.default_payment_method}.`, { param: 'default_settings[default_payment_method]' });
  }
  const endBehavior = p.end_behavior !== undefined ? endBehaviorOf(p.end_behavior) : schedule.end_behavior;
  if (parsed) materialize(account, parsed.resolved);

  const previous = structuredClone(schedule);
  if (parsed) {
    const past = active ? schedule.phases.slice(0, schedule._phase) : [];
    schedule.phases = [...past, ...parsed.phases.map(newPhase)];
    if (active) {
      const cur = schedule.phases[schedule._phase];
      schedule.current_phase = { end_date: cur.end_date, start_date: cur.start_date };
    }
  }
  schedule.end_behavior = endBehavior;
  if (p.metadata !== undefined) schedule.metadata = applyMetadata(schedule.metadata, p.metadata);
  if (p.default_settings !== undefined) schedule.default_settings = defaultSettings(p.default_settings, schedule.default_settings);
  emitUpdated(account, schedule, 'subscription_schedule.updated', previous);

  if (active && (parsed || p.end_behavior !== undefined || p.default_settings !== undefined)) {
    const sub = account.store.get('subscription', schedule.subscription);
    if (sub && !ENDED_STATUSES.has(sub.status)) {
      const u = phaseUpdate(account, schedule, schedule._phase, sub, { prorationBehavior: p.proration_behavior ?? 'create_prorations' });
      if (!['cancel', 'none'].includes(schedule.end_behavior) && sub.cancel_at !== null && !sub.cancel_at_period_end && previous.end_behavior !== schedule.end_behavior) u.cancelAt = null;
      engine.updateSubscription(account, sub, u, { source: 'schedule' });
    }
    if (schedule.current_phase && schedule.current_phase.end_date <= now) advance(account, schedule);
  } else if (!active && schedule.phases[0].start_date <= now) {
    startSchedule(account, schedule);
    emitUpdated(account, schedule, 'subscription_schedule.updated', previous);
  }
  scheduleJobs(account, schedule);
  return schedule;
}

/**
 * Releases a schedule (docs.stripe.com/api/subscription_schedules/release): the subscription stays
 * without its schedule; `preserveCancelDate` keeps a cancel_at the schedule set.
 */
export function releaseSchedule(account, schedule, { preserveCancelDate = false, request } = {}) {
  if (!LIVE.has(schedule.status)) {
    throw invalidRequest(`A schedule can only be released if its status is not_started or active (this one is ${schedule.status}).`);
  }
  const sub = schedule.subscription ? account.store.get('subscription', schedule.subscription) : null;
  schedule.status = 'released';
  schedule.released_at = nowOf(account, schedule);
  schedule.released_subscription = schedule.subscription;
  schedule.subscription = null;
  schedule.current_phase = null;
  scheduleJobs(account, schedule);
  emitEvent(account, 'subscription_schedule.released', schedule, { request });
  if (sub && !ENDED_STATUSES.has(sub.status)) {
    const scheduledCancel = ['cancel', 'none'].includes(schedule.end_behavior) && sub.cancel_at !== null && !sub.cancel_at_period_end;
    engine.setSubscriptionSchedule(account, sub, null, { request });
    // Without preserve_cancel_date, the cancellation the schedule set goes with it.
    if (scheduledCancel && !preserveCancelDate) engine.updateSubscription(account, sub, { cancelAt: null }, { source: 'schedule', request });
  }
  return schedule;
}

/**
 * Cancels a schedule and its subscription now (docs.stripe.com/api/subscription_schedules/cancel;
 * invoice_now and prorate default to true, unlike DELETE /v1/subscriptions).
 */
export function cancelSchedule(account, schedule, { invoiceNow = true, prorate = true, request } = {}) {
  if (!LIVE.has(schedule.status)) {
    throw invalidRequest(`A schedule can only be canceled if its status is not_started or active (this one is ${schedule.status}).`);
  }
  const sub = schedule.subscription ? account.store.get('subscription', schedule.subscription) : null;
  schedule.status = 'canceled';
  schedule.canceled_at = nowOf(account, schedule);
  schedule.subscription = null;
  schedule.current_phase = null;
  scheduleJobs(account, schedule);
  emitEvent(account, 'subscription_schedule.canceled', schedule, { request });
  if (sub && !ENDED_STATUSES.has(sub.status)) engine.cancelSubscription(account, sub, { invoiceNow, prorate, source: 'schedule', request });
  return schedule;
}

/**
 * The portal's scheduled downgrade: a schedule with phase 0 = the current items until the current
 * period end and phase 1 = `items` for one interval of the new price, released at the end.
 * @param {{price: object, quantity?: number}[]} items internal prices
 * @returns {object} the internal schedule
 */
export function scheduleChangeAtPeriodEnd(account, subscription, items, { request } = {}) {
  const sub = subscription;
  if (sub.schedule) throw invalidRequest(`The subscription ${sub.id} already has a schedule.`);
  const customer = account.store.get('customer', sub.customer);
  const now = nowOf(account, sub);
  const period = engine.currentPeriod(sub);
  const current = newPhase({
    start: period.start,
    end: period.end,
    items: sub.items.data.map((i) => ({ price: account.store.get('price', i.price), quantity: i.quantity, metadata: i.metadata })),
    currency: sub.currency,
    prorationBehavior: 'create_prorations',
  });
  const { interval, count } = intervalOf(items[0].price);
  const next = newPhase({
    start: period.end,
    end: addIntervals(period.end, interval, count, 1),
    items: items.map((i) => ({ price: i.price, quantity: i.quantity ?? 1 })),
    currency: sub.currency,
    prorationBehavior: 'create_prorations',
  });
  const schedule = newSchedule(account, {
    customer,
    now,
    billingMode: sub.billing_mode.type,
    endBehavior: 'release',
    metadata: {},
    settings: defaultSettings({ collection_method: sub.collection_method, default_payment_method: sub.default_payment_method ?? undefined }),
    phases: [current, next],
    version: sub._version ?? account.settings.apiVersion,
  });
  schedule.status = 'active';
  schedule.subscription = sub.id;
  schedule._phase = 0;
  schedule.current_phase = { end_date: current.end_date, start_date: current.start_date };
  account.store.insert(schedule);
  emitEvent(account, 'subscription_schedule.created', schedule, { request });
  engine.setSubscriptionSchedule(account, sub, schedule.id, { request });
  scheduleJobs(account, schedule);
  return schedule;
}

/**
 * Called by billing when a subscription that has a schedule is canceled: dunning →
 * subscription_schedule.aborted; other cancellations → subscription_schedule.canceled.
 */
export function onSubscriptionCanceled(account, subscription, { reason, request } = {}) {
  const schedule = subscription.schedule ? account.store.get('subscription_schedule', subscription.schedule) : null;
  if (!schedule || !LIVE.has(schedule.status)) return;
  schedule.status = 'canceled';
  schedule.canceled_at = nowOf(account, schedule);
  schedule.subscription = null;
  schedule.current_phase = null;
  scheduleJobs(account, schedule);
  emitEvent(account, reason === 'payment_failed' ? 'subscription_schedule.aborted' : 'subscription_schedule.canceled', schedule, { request });
}

/**
 * Called by billing after a direct API update of a subscription that has a schedule: the change is
 * copied into the current phase (items, trial end).
 */
export function onSubscriptionUpdated(account, subscription, { request } = {}) {
  const schedule = subscription.schedule ? account.store.get('subscription_schedule', subscription.schedule) : null;
  if (!schedule || schedule.status !== 'active') return;
  const phase = schedule.phases[schedule._phase];
  const previous = structuredClone(schedule);
  phase.items = subscription.items.data.map((i) => newScheduleItem({ price: account.store.get('price', i.price), quantity: i.quantity, metadata: i.metadata }));
  if (subscription.status === 'trialing') phase.trial_end = subscription.trial_end;
  emitUpdated(account, schedule, 'subscription_schedule.updated', previous, { request });
}

// Serializer ------------------------------------------------------------------------------------

function renderPhase(phase, ctx) {
  const f1 = ctx.family === 'F1';
  const out = {
    add_invoice_items: phase.add_invoice_items.map((a) => {
      const item = {};
      if (!f1) item.discountable = a.discountable;
      item.discounts = [];
      if (!f1) {
        item.metadata = { ...a.metadata };
        item.period = structuredClone(a.period);
      }
      Object.assign(item, { price: a.price, quantity: a.quantity, tax_rates: [] });
      return item;
    }),
    application_fee_percent: phase.application_fee_percent,
    billing_cycle_anchor: phase.billing_cycle_anchor,
    billing_thresholds: structuredClone(phase.billing_thresholds),
    collection_method: phase.collection_method,
  };
  if (f1) out.coupon = null;
  Object.assign(out, {
    currency: phase.currency,
    default_payment_method: phase.default_payment_method,
    description: phase.description,
    discounts: [],
    end_date: phase.end_date,
    invoice_settings: phase.invoice_settings
      ? f1
        ? { account_tax_ids: phase.invoice_settings.account_tax_ids, days_until_due: phase.invoice_settings.days_until_due, issuer: phase.invoice_settings.issuer }
        : structuredClone(phase.invoice_settings)
      : null,
    items: phase.items.map((i) => structuredClone(i)),
    metadata: { ...phase.metadata },
    on_behalf_of: null,
    proration_behavior: phase.proration_behavior,
    start_date: phase.start_date,
    transfer_data: null,
  });
  if (phase.trial !== null && ctx.atLeast('2026-07-29.dahlia')) out.trial = phase.trial;
  out.trial_end = phase.trial_end;
  return out;
}

/** The wire form of a schedule for the context's version family. */
export function renderSchedule(s, ctx) {
  const f1 = ctx.family === 'F1';
  const out = { id: s.id, object: 'subscription_schedule', application: null };
  if (!f1 && ctx.atLeast('2025-06-30.basil')) out.billing_mode = structuredClone(s.billing_mode);
  Object.assign(out, {
    canceled_at: s.canceled_at,
    completed_at: s.completed_at,
    created: s.created,
    current_phase: s.current_phase ? { ...s.current_phase } : null,
    customer: s.customer,
  });
  if (ctx.family === 'F3') out.customer_account = null;
  const ds = structuredClone(s.default_settings);
  if (f1) {
    delete ds.automatic_tax.disabled_reason;
    ds.invoice_settings = { account_tax_ids: ds.invoice_settings.account_tax_ids, days_until_due: ds.invoice_settings.days_until_due, issuer: ds.invoice_settings.issuer };
  }
  Object.assign(out, {
    default_settings: ds,
    end_behavior: s.end_behavior,
    livemode: false,
    metadata: { ...s.metadata },
    phases: s.phases.map((p) => renderPhase(p, ctx)),
    released_at: s.released_at,
    released_subscription: s.released_subscription,
    status: s.status,
    subscription: s.subscription,
    test_clock: s.test_clock,
  });
  return out;
}

function listSchedules(ctx) {
  const { account, params: p } = ctx;
  const schedules = account.store.list('subscription_schedule', (s) => {
    if (p.customer !== undefined ? s.customer !== p.customer : s.test_clock) return false;
    if (p.scheduled === true && s.status !== 'not_started') return false;
    if (p.scheduled === false && s.status === 'not_started') return false;
    if (p.canceled_at !== undefined && (s.canceled_at === null || !matchesRange(s.canceled_at, p.canceled_at))) return false;
    if (p.completed_at !== undefined && (s.completed_at === null || !matchesRange(s.completed_at, p.completed_at))) return false;
    if (p.released_at !== undefined && (s.released_at === null || !matchesRange(s.released_at, p.released_at))) return false;
    return matchesRange(s.created, p.created);
  });
  return paginate(schedules, p, { url: '/v1/subscription_schedules', noun: 'subscription_schedule', find: (id) => account.store.get('subscription_schedule', id) });
}

// Install ---------------------------------------------------------------------------------------

/** Routes, serializer and jobs. */
export function install(app) {
  app.object('subscription_schedule', {
    render: renderSchedule,
    expandable: [
      'customer',
      'subscription',
      'test_clock',
      'application',
      'phases.items.price',
      'phases.default_payment_method',
      'phases.add_invoice_items.price',
      'default_settings.default_payment_method',
    ],
  });

  app.job(JOB.start, (account, job) => {
    const schedule = account.store.get('subscription_schedule', job.data.schedule);
    if (!schedule || schedule.status !== 'not_started') return;
    const previous = structuredClone(schedule);
    startSchedule(account, schedule, { request: null });
    emitUpdated(account, schedule, 'subscription_schedule.updated', previous);
    scheduleJobs(account, schedule);
  });
  app.job(JOB.phaseEnd, (account, job) => {
    const schedule = account.store.get('subscription_schedule', job.data.schedule);
    if (!schedule || schedule.status !== 'active' || schedule._phase !== job.data.phase) return;
    advance(account, schedule, { request: null });
  });
  app.job(JOB.expiring, (account, job) => {
    const schedule = account.store.get('subscription_schedule', job.data.schedule);
    if (!schedule || !LIVE.has(schedule.status) || schedule.phases.at(-1).end_date !== job.data.end) return;
    emitEvent(account, 'subscription_schedule.expiring', schedule);
  });

  app.route('POST', '/v1/subscription_schedules', createSchedule);
  app.route('GET', '/v1/subscription_schedules', listSchedules);
  app.route('GET', '/v1/subscription_schedules/:id', (ctx) => ctx.account.store.require('subscription_schedule', ctx.pathParams.id));
  app.route('POST', '/v1/subscription_schedules/:id', (ctx) => updateSchedule(ctx, ctx.account.store.require('subscription_schedule', ctx.pathParams.id)));
  app.route('POST', '/v1/subscription_schedules/:id/release', (ctx) =>
    releaseSchedule(ctx.account, ctx.account.store.require('subscription_schedule', ctx.pathParams.id), { preserveCancelDate: ctx.params.preserve_cancel_date ?? false }),
  );
  app.route('POST', '/v1/subscription_schedules/:id/cancel', (ctx) =>
    cancelSchedule(ctx.account, ctx.account.store.require('subscription_schedule', ctx.pathParams.id), {
      invoiceNow: ctx.params.invoice_now ?? true,
      prorate: ctx.params.prorate ?? true,
    }),
  );
}
