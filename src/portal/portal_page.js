/**
 * The hosted customer portal (docs.stripe.com/customer-management) and its login page.
 *
 *   GET  /p/session/:token   the homepage, or a screen (?screen=update|confirm_update|cancel|
 *                            payment_method|billing|done&subscription=sub_…); a flow_data deep link
 *                            lands on its screen with the rest of the portal hidden.
 *   POST /p/session/:token   action=update_subscription (subscription, price, quantity) |
 *                            cancel_subscription (subscription, reason, comment) |
 *                            renew_subscription (subscription) | update_payment_method (card fields) |
 *                            set_default_payment_method / detach_payment_method (payment_method) |
 *                            update_customer (email, name, phone, address_*, shipping_*).
 *                            Answers 303: to after_completion for flows, else back to the homepage.
 *                            A deep-link session accepts only its flow's action on its subscription,
 *                            and nothing after the flow completes (unless after_completion is
 *                            portal_homepage); anything else answers 403.
 *   GET/POST /p/login/:token the configuration's login page (login_page.enabled): an email address
 *                            opens a session for the most recent customer with that email.
 *
 * Only the configuration's enabled features are shown, and a hidden action is refused on POST too.
 * Every effect goes through the owning module: plan changes through billing.changeSubscriptionItems
 * (the configured proration_behavior, billing_cycle_anchor and trial_update_behavior, with
 * error_if_incomplete so a declined payment changes nothing) or, for downgrades that
 * match schedule_at_period_end, schedules.scheduleChangeAtPeriodEnd; cancels and renewals through
 * billing.cancelSubscription / setCancelAtPeriodEnd; cards through payments; the customer through
 * customers. Events carry request: null.
 */
import { h, html, notFoundPage, redirect } from '../core/html.js';
import { StripeError } from '../core/errors.js';
import { formatAmount } from '../core/currency.js';
import { changeCustomer, updateCustomer } from '../customers/customers.js';
import { attachPaymentMethod, createCardPaymentMethod, detachPaymentMethod } from '../payments/payment_methods.js';
import * as billing from '../billing/engine.js';
import * as schedules from '../schedules/schedules.js';
import { intervalDaysOf, isRecurring, priceLabel, yearlyCost } from '../checkout/pricing.js';
import { PAGE_STYLE, cardFields, errorBox, formatDate, messageOf, noticeBox, readCardForm, statusOf, testCardHelp } from '../checkout/page_kit.js';
import { configuredProductFor, createPortalSession, isExpired, sessionForToken, touch, updateBlocker } from './sessions.js';

const LIVE = (s) => !['canceled', 'incomplete_expired'].includes(s.status);
const STATUS_LABELS = { trialing: 'Trial', active: 'Active', past_due: 'Past due', unpaid: 'Unpaid', paused: 'Paused', incomplete: 'Incomplete' };
const REASON_LABELS = {
  too_expensive: "It's too expensive",
  missing_features: 'I need more features',
  switched_service: 'I found an alternative',
  unused: 'I no longer need it',
  customer_service: 'Customer service was less than expected',
  too_complex: 'Ease of use was less than expected',
  low_quality: 'Quality was less than expected',
  other: 'Other reason',
};
const NOTICES = {
  updated: 'Your plan has been updated.',
  scheduled: 'Your plan change is scheduled for the end of the current period.',
  canceled: 'Your subscription has been canceled.',
  canceling: 'Your subscription will be canceled at the end of the current period.',
  renewed: 'Your subscription will continue.',
  payment_method: 'Your payment method has been updated.',
  removed: 'The payment method has been removed.',
  billing: 'Your billing information has been updated.',
};

/** What the configured proration_behavior means for the customer, shown before a plan change. */
const PRORATION_NOTES = {
  always_invoice: 'You are charged the prorated difference now.',
  create_prorations: 'The prorated difference is added to your next invoice.',
  none: 'Your next invoice uses the new price.',
};

const sessionAccount = (params, server) => server.accountForId(params.token);

/** An error shown on the page (400 unless given). */
class PageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Context ------------------------------------------------------------------------------------

function load(p) {
  const session = sessionForToken(p.account, p.pathParams.token);
  if (!session) return null;
  const { store } = p.account;
  const customer = store.get('customer', session.customer);
  if (!customer || customer._deleted) return null;
  return {
    p,
    account: p.account,
    session,
    config: store.get('billing_portal.configuration', session.configuration),
    customer,
    base: `/p/session/${p.pathParams.token}`,
  };
}

function price(ctx, id) {
  return ctx.account.store.get('price', id);
}

function productName(ctx, priceObj) {
  return ctx.account.store.get('product', priceObj?.product)?.name ?? priceObj?.id ?? '';
}

function periodEnd(sub) {
  const ends = (sub.items?.data ?? []).map((i) => i.current_period_end).filter((t) => typeof t === 'number');
  return ends.length ? Math.min(...ends) : sub.current_period_end ?? null;
}

function liveSubscriptions(ctx) {
  return ctx.account.store
    .list('subscription', (s) => s.customer === ctx.customer.id && LIVE(s))
    .sort((a, b) => b.created - a.created || b._seq - a._seq);
}

function isCanceling(sub) {
  return Boolean(sub.cancel_at_period_end || sub.cancel_at);
}

/** Why the portal does not offer canceling `sub`, or null when it does (the page and the POST share it). */
function cancelBlocker(ctx, sub) {
  if (!ctx.config.features.subscription_cancel.enabled) return 'Canceling is not available.';
  if (sub.status === 'incomplete') return 'This subscription is not active yet, so it cannot be canceled here.';
  return null;
}

/** The customer's subscription `id` for an action, checked for the portal's rules. */
function subscriptionFor(ctx, id, { update = false, cancel = false } = {}) {
  const sub = typeof id === 'string' ? ctx.account.store.get('subscription', id) : null;
  if (!sub || sub.customer !== ctx.customer.id) throw new PageError('That subscription was not found.', 404);
  if (!LIVE(sub)) throw new PageError('This subscription has ended and can no longer be changed.');
  if ((update || cancel) && sub.schedule) {
    throw new PageError('This subscription has an update scheduled, so it cannot be updated or canceled here.');
  }
  if (update) {
    if (!ctx.config.features.subscription_update.enabled) throw new PageError('Plan changes are not available.');
    const blocker = updateBlocker(ctx.account, sub);
    if (blocker) throw new PageError(blocker);
  }
  if (cancel) {
    const blocker = cancelBlocker(ctx, sub);
    if (blocker) throw new PageError(blocker);
  }
  return sub;
}

/** Prices the customer can switch `sub` to: the configured prices, active, in the subscription's currency. */
function planChoices(ctx, sub) {
  const choices = [];
  for (const entry of ctx.config.features.subscription_update.products) {
    const product = ctx.account.store.get('product', entry.product);
    if (!product || product._deleted || product.active === false) continue;
    for (const id of entry.prices) {
      const pr = price(ctx, id);
      if (!pr || pr.active === false || !isRecurring(pr) || pr.currency !== sub.currency) continue;
      choices.push({ price: pr, product, entry });
    }
  }
  return choices;
}

function canUpdate(ctx, sub) {
  const su = ctx.config.features.subscription_update;
  return su.enabled && su.default_allowed_updates.some((u) => u === 'price' || u === 'quantity') && !sub.schedule && !updateBlocker(ctx.account, sub) && planChoices(ctx, sub).length > 0;
}

function quantityRules(ctx, priceId) {
  const su = ctx.config.features.subscription_update;
  const entry = configuredProductFor(ctx.config, priceId);
  const aq = entry?.adjustable_quantity;
  const adjustable = Boolean(aq?.enabled || su.default_allowed_updates.includes('quantity'));
  return { adjustable, min: aq?.enabled ? Math.max(1, aq.minimum) : 1, max: aq?.enabled && aq.maximum !== null ? aq.maximum : null };
}

// Rendering ----------------------------------------------------------------------------------

function page(ctx, title, content, { status = 200, error, notice } = {}) {
  const { config, customer, session } = ctx;
  const inFlow = session.flow && !session._flow_done;
  const bp = config.business_profile;
  const body = h`
${PAGE_STYLE}
<p class="muted"><span class="badge">Test mode</span> ${bp.headline ?? 'Customer portal'}</p>
${inFlow ? h`` : h`<p class="muted" id="customer">${customer.name ?? ''} ${customer.email ?? ''}</p>`}
${noticeBox(notice)}
${errorBox(error)}
${content}
<hr>
${session.return_url ? h`<p><a id="return" href="${session.return_url}">Return to the website</a></p>` : h``}
${bp.privacy_policy_url ? h`<p class="muted"><a href="${bp.privacy_policy_url}">Privacy policy</a></p>` : h``}
${bp.terms_of_service_url ? h`<p class="muted"><a href="${bp.terms_of_service_url}">Terms of service</a></p>` : h``}`;
  return html(title, body, { status });
}

function subscriptionSummary(ctx, sub) {
  const items = sub.items?.data ?? [];
  const lines = items.map((item) => {
    const pr = price(ctx, item.price);
    return h`<li data-price="${item.price}">${productName(ctx, pr)} — ${priceLabel(pr)}${item.quantity && item.quantity > 1 ? h` × ${item.quantity}` : h``}</li>`;
  });
  const end = periodEnd(sub);
  let when;
  if (sub.status === 'trialing' && sub.trial_end) when = h`Trial ends ${formatDate(sub.trial_end)}`;
  else if (sub.cancel_at) when = h`Cancels ${formatDate(sub.cancel_at)}`;
  else if (sub.cancel_at_period_end && end) when = h`Cancels ${formatDate(end)}`;
  else if (end) when = h`Renews ${formatDate(end)}`;
  else when = h``;
  const scheduled = scheduledChange(ctx, sub);
  return h`<ul class="items">${lines}</ul>
<p><span class="badge" data-status="${sub.status}">${isCanceling(sub) ? 'Canceling' : STATUS_LABELS[sub.status] ?? sub.status}</span> ${when}</p>
${scheduled ? h`<p class="scheduled" data-schedule="${sub.schedule}">${scheduled}</p>` : h``}`;
}

/** "Changes to Basic — $5.00 / month on 2026-11-01" for a subscription with a scheduled change. */
function scheduledChange(ctx, sub) {
  if (!sub.schedule) return null;
  const schedule = ctx.account.store.get('subscription_schedule', sub.schedule);
  const now = ctx.account.time.now(ctx.account.time.domainOf(sub));
  const next = (schedule?.phases ?? []).find((ph) => ph.start_date > now);
  const item = next?.items?.[0];
  if (!item) return 'A change to this subscription is scheduled.';
  const pr = price(ctx, typeof item.price === 'string' ? item.price : item.price?.id);
  return `Changes to ${productName(ctx, pr)} — ${priceLabel(pr)}${item.quantity > 1 ? ` × ${item.quantity}` : ''} on ${formatDate(next.start_date)}`;
}

function subscriptionActions(ctx, sub) {
  const q = (screen) => `${ctx.base}?screen=${screen}&subscription=${sub.id}`;
  return h`<p class="actions">
  ${canUpdate(ctx, sub) ? h`<a class="update" href="${q('update')}">Update plan</a>` : h``}
  ${!cancelBlocker(ctx, sub) && !isCanceling(sub) && !sub.schedule ? h`<a class="cancel" href="${q('cancel')}">Cancel plan</a>` : h``}
</p>
${isCanceling(sub) && !sub.schedule
    ? h`<form method="post" action="${ctx.base}"><input type="hidden" name="action" value="renew_subscription"><input type="hidden" name="subscription" value="${sub.id}"><button type="submit" class="renew">Renew plan</button></form>`
    : h``}`;
}

function cardLabel(pm) {
  if (!pm) return 'None';
  const c = pm.card ?? {};
  const brand = c.brand ? c.brand[0].toUpperCase() + c.brand.slice(1) : 'Card';
  return `${brand} •••• ${c.last4 ?? '????'}${c.exp_month ? `, expires ${String(c.exp_month).padStart(2, '0')}/${c.exp_year}` : ''}`;
}

function paymentMethodSection(ctx) {
  const { account, customer } = ctx;
  const defaultId = customer.invoice_settings?.default_payment_method ?? null;
  const subscriptionCards = new Set(liveSubscriptions(ctx).map((s) => s.default_payment_method).filter(Boolean));
  // The card that pays: the customer's default, else the card a subscription uses.
  const primaryId = defaultId ?? [...subscriptionCards][0] ?? null;
  const cards = account.store.list('payment_method', (pm) => pm.customer === customer.id && pm.id !== primaryId);
  return h`<section id="payment-method"><h2>Payment method</h2>
<p id="default-payment-method" data-payment-method="${primaryId ?? ''}">${cardLabel(primaryId ? account.store.get('payment_method', primaryId) : null)}</p>
${cards.map(
  (pm) => h`<div class="saved-card" data-payment-method="${pm.id}">${cardLabel(pm)}
  <form method="post" action="${ctx.base}"><input type="hidden" name="action" value="set_default_payment_method"><input type="hidden" name="payment_method" value="${pm.id}"><button type="submit">Make default</button></form>
  ${subscriptionCards.has(pm.id) ? h`` : h`<form method="post" action="${ctx.base}"><input type="hidden" name="action" value="detach_payment_method"><input type="hidden" name="payment_method" value="${pm.id}"><button type="submit">Remove</button></form>`}</div>`,
)}
<p><a id="add-payment-method" href="${ctx.base}?screen=payment_method">Add payment method</a></p></section>`;
}

function billingSection(ctx) {
  const c = ctx.customer;
  const a = c.address;
  return h`<section id="billing-information"><h2>Billing information</h2>
<p>${c.name ?? ''}<br>${c.email ?? ''}${c.phone ? h`<br>${c.phone}` : h``}${a ? h`<br>${[a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ')}` : h``}</p>
<p><a id="update-billing" href="${ctx.base}?screen=billing">Update information</a></p></section>`;
}

function invoiceSection(ctx) {
  const invoices = ctx.account.store
    .list('invoice', (inv) => inv.customer === ctx.customer.id && inv.status !== 'draft')
    .sort((a, b) => b.created - a.created || b._seq - a._seq);
  return h`<section id="invoice-history"><h2>Invoice history</h2>
${invoices.length
    ? h`<table>${invoices.map(
        (inv) => h`<tr class="invoice" data-invoice="${inv.id}"><td>${formatDate(inv.created)}</td><td>${inv.number ?? ''}</td><td class="right">${formatAmount(inv.total ?? inv.amount_due ?? 0, inv.currency)}</td><td><span class="badge">${inv.status}</span></td><td>${
          inv.hosted_invoice_url ? h`<a href="${inv.hosted_invoice_url}">View</a>` : h``
        }</td></tr>`,
      )}</table>`
    : h`<p class="muted">No invoices yet.</p>`}</section>`;
}

function homeScreen(ctx, extra = {}) {
  const { features } = ctx.config;
  const subs = liveSubscriptions(ctx);
  const content = h`<h1>Customer portal</h1>
<section id="subscriptions"><h2>Current plan</h2>
${subs.length
    ? subs.map((sub) => h`<div class="subscription" data-subscription="${sub.id}">${subscriptionSummary(ctx, sub)}${subscriptionActions(ctx, sub)}</div>`)
    : h`<p class="muted">No active subscriptions.</p>`}
</section>
${features.payment_method_update.enabled ? paymentMethodSection(ctx) : h``}
${features.customer_update.enabled ? billingSection(ctx) : h``}
${features.invoice_history.enabled ? invoiceSection(ctx) : h``}`;
  return page(ctx, 'Customer portal', content, extra);
}

function backLink(ctx) {
  return ctx.session.flow && !ctx.session._flow_done ? h`` : h`<p><a href="${ctx.base}">Back</a></p>`;
}

function updateScreen(ctx, subId, extra = {}) {
  const sub = subscriptionFor(ctx, subId, { update: true });
  const item = sub.items.data[0];
  const su = ctx.config.features.subscription_update;
  const allowPrice = su.default_allowed_updates.includes('price') || Boolean(ctx.session.flow?.subscription_update);
  const choices = planChoices(ctx, sub).filter((c) => allowPrice || c.price.id === item.price);
  const q = quantityRules(ctx, item.price);
  const content = h`<h1>Update plan</h1>
${subscriptionSummary(ctx, sub)}
<form id="update-form" method="get" action="${ctx.base}">
  <input type="hidden" name="screen" value="confirm_update"><input type="hidden" name="subscription" value="${sub.id}">
  ${choices.map(
    (c) => h`<label class="inline plan" data-price="${c.price.id}"><input type="radio" name="price" value="${c.price.id}"${c.price.id === item.price ? h` checked` : h``}> ${c.product.name} — ${priceLabel(c.price)}${
      c.price.id === item.price ? h` <span class="badge">Current</span>` : h``
    }</label>`,
  )}
  ${q.adjustable ? h`<label for="quantity">Quantity</label><input id="quantity" name="quantity" type="number" min="${q.min}"${q.max !== null ? h` max="${q.max}"` : h``} value="${item.quantity}">` : h``}
  <button type="submit">Continue</button>
</form>
${backLink(ctx)}`;
  return page(ctx, 'Update plan', content, extra);
}

/** The price and quantity a confirm screen or update action targets. */
function targetOf(ctx, sub, form) {
  const item = sub.items.data[0];
  const confirm = ctx.session.flow?.subscription_update_confirm;
  if (confirm && !ctx.session._flow_done) {
    const wanted = confirm.items[0];
    return { priceId: wanted.price ?? item.price, quantity: wanted.quantity ?? item.quantity };
  }
  const quantity = form.quantity === undefined || form.quantity === '' ? item.quantity : /^\d+$/.test(String(form.quantity)) ? Number(form.quantity) : NaN;
  return { priceId: form.price || item.price, quantity };
}

/** Validates a plan change; returns { sub, item, current, next, quantity, scheduled }. */
function planChange(ctx, subId, form) {
  const sub = subscriptionFor(ctx, subId, { update: true });
  const item = sub.items.data[0];
  const current = price(ctx, item.price);
  const { priceId, quantity } = targetOf(ctx, sub, form);
  const next = price(ctx, priceId);
  const su = ctx.config.features.subscription_update;
  const viaFlow = Boolean(ctx.session.flow && !ctx.session._flow_done && (ctx.session.flow.subscription_update || ctx.session.flow.subscription_update_confirm));
  if (!next || !planChoices(ctx, sub).some((c) => c.price.id === next.id)) throw new PageError('That plan is not available.');
  if (next.id !== current?.id && !su.default_allowed_updates.includes('price') && !viaFlow) throw new PageError('Changing the plan is not available.');
  const q = quantityRules(ctx, next.id);
  if (!Number.isInteger(quantity) || quantity < q.min || (q.max !== null && quantity > q.max)) {
    throw new PageError(`Choose a quantity between ${q.min} and ${q.max ?? 'any higher number'}.`);
  }
  if (quantity !== item.quantity && !q.adjustable && !ctx.session.flow?.subscription_update_confirm) throw new PageError('Changing the quantity is not available.');
  if (next.id === current?.id && quantity === item.quantity) throw new PageError('Choose a different plan or quantity.');
  return { sub, item, current, next, quantity, scheduled: shouldSchedule(ctx, sub, { price: current, quantity: item.quantity }, { price: next, quantity }) };
}

/**
 * True when schedule_at_period_end applies (docs.stripe.com/api/customer_portal/configurations/object):
 * decreasing_item_amount (cheaper in the long term) or shortening_interval (shorter interval, same
 * quantity), and only between prices of the same product.
 */
function shouldSchedule(ctx, sub, current, next) {
  const conditions = ctx.config.features.subscription_update.schedule_at_period_end.conditions.map((c) => c.type);
  if (!conditions.length || sub.status === 'trialing' || !current.price) return false;
  if (next.price.product !== current.price.product) return false;
  const decreasing = conditions.includes('decreasing_item_amount') && yearlyCost(next.price, next.quantity) < yearlyCost(current.price, current.quantity);
  const shortening =
    conditions.includes('shortening_interval') && intervalDaysOf(next.price.recurring) < intervalDaysOf(current.price.recurring) && next.quantity === current.quantity;
  return decreasing || shortening;
}

function confirmScreen(ctx, subId, form, extra = {}) {
  const change = planChange(ctx, subId, form);
  const { sub, item, current, next, quantity, scheduled } = change;
  const su = ctx.config.features.subscription_update;
  const end = periodEnd(sub);
  const trialNote =
    sub.status === 'trialing'
      ? su.trial_update_behavior === 'continue_trial'
        ? h`<p id="trial-note">Your trial continues until ${formatDate(sub.trial_end)}.</p>`
        : h`<p id="trial-note">Changing your plan ends your free trial now.</p>`
      : h``;
  const content = h`<h1>Confirm your update</h1>
<table id="change">
  <tr><td>Current plan</td><td>${productName(ctx, current)} — ${priceLabel(current)}${item.quantity > 1 ? ` × ${item.quantity}` : ''}</td></tr>
  <tr><td>New plan</td><td data-price="${next.id}">${productName(ctx, next)} — ${priceLabel(next)}${quantity > 1 ? ` × ${quantity}` : ''}</td></tr>
</table>
<p id="when" data-scheduled="${scheduled ? 'true' : 'false'}">${scheduled ? `The change takes effect at the end of the current period (${formatDate(end)}).` : 'The change takes effect now.'}</p>
${scheduled || sub.status === 'trialing' ? h`` : h`<p id="billing-note">${PRORATION_NOTES[su.proration_behavior] ?? ''}</p>`}
${trialNote}
<form method="post" action="${ctx.base}">
  <input type="hidden" name="action" value="update_subscription"><input type="hidden" name="subscription" value="${sub.id}">
  <input type="hidden" name="price" value="${next.id}"><input type="hidden" name="quantity" value="${quantity}">
  <button type="submit" id="confirm">Confirm</button>
</form>
${backLink(ctx)}`;
  return page(ctx, 'Confirm update', content, extra);
}

function cancelScreen(ctx, subId, extra = {}) {
  const sub = subscriptionFor(ctx, subId, { cancel: true });
  const sc = ctx.config.features.subscription_cancel;
  const end = periodEnd(sub);
  const reasons = sc.cancellation_reason.enabled ? sc.cancellation_reason.options : [];
  const content = h`<h1>Cancel your plan</h1>
${subscriptionSummary(ctx, sub)}
<p id="cancel-mode" data-mode="${sc.mode}">${
    sc.mode === 'immediately' ? 'Your subscription will be canceled immediately.' : `Your subscription will be canceled at the end of the current period (${formatDate(sub.trial_end && sub.status === 'trialing' ? sub.trial_end : end)}).`
  }</p>
<form method="post" action="${ctx.base}">
  <input type="hidden" name="action" value="cancel_subscription"><input type="hidden" name="subscription" value="${sub.id}">
  ${reasons.length
    ? h`<fieldset id="reasons"><legend>Tell us why you're canceling</legend>${reasons.map(
        (r) => h`<label class="inline"><input type="radio" name="reason" value="${r}"> ${REASON_LABELS[r] ?? r}</label>`,
      )}<label for="comment">Anything else? (optional)</label><textarea id="comment" name="comment"></textarea></fieldset>`
    : h``}
  <button type="submit" id="confirm-cancel">Cancel plan</button>
</form>
${backLink(ctx)}`;
  return page(ctx, 'Cancel plan', content, extra);
}

function paymentMethodScreen(ctx, extra = {}) {
  if (!ctx.config.features.payment_method_update.enabled) throw new PageError('Updating the payment method is not available.');
  const content = h`<h1>Add a payment method</h1>
<form method="post" action="${ctx.base}">
  <input type="hidden" name="action" value="update_payment_method">
  ${cardFields()}
  <button type="submit" id="save-card">Save as default</button>
</form>
${testCardHelp()}
${backLink(ctx)}`;
  return page(ctx, 'Payment method', content, extra);
}

function billingScreen(ctx, extra = {}) {
  const cu = ctx.config.features.customer_update;
  if (!cu.enabled) throw new PageError('Updating billing information is not available.');
  const c = ctx.customer;
  const allowed = new Set(cu.allowed_updates);
  const field = (name, label, value) => h`<label for="${name}">${label}</label><input id="${name}" name="${name}" value="${value ?? ''}">`;
  const address = (prefix, current) =>
    h`${field(`${prefix}_line1`, 'Address line 1', current?.line1)}${field(`${prefix}_line2`, 'Address line 2', current?.line2)}${field(`${prefix}_city`, 'City', current?.city)}${field(
      `${prefix}_state`,
      'State',
      current?.state,
    )}${field(`${prefix}_postal_code`, 'Postal code', current?.postal_code)}${field(`${prefix}_country`, 'Country', current?.country)}`;
  const content = h`<h1>Billing information</h1>
<form method="post" action="${ctx.base}">
  <input type="hidden" name="action" value="update_customer">
  ${allowed.has('name') ? field('name', 'Name', c.name) : h``}
  ${allowed.has('email') ? field('email', 'Email', c.email) : h``}
  ${allowed.has('phone') ? field('phone', 'Phone', c.phone) : h``}
  ${allowed.has('address') ? h`<fieldset><legend>Billing address</legend>${address('address', c.address)}</fieldset>` : h``}
  ${allowed.has('shipping') ? h`<fieldset><legend>Shipping</legend>${field('shipping_name', 'Name', c.shipping?.name)}${address('shipping', c.shipping?.address)}</fieldset>` : h``}
  <button type="submit" id="save-billing">Save</button>
</form>
${backLink(ctx)}`;
  return page(ctx, 'Billing information', content, extra);
}

function doneScreen(ctx, notice, extra = {}) {
  const hc = ctx.session.flow?.after_completion?.hosted_confirmation;
  const content = h`<h1>Done</h1>
<p id="confirmation">${NOTICES[notice] ?? 'Your changes have been saved.'}</p>
${hc?.custom_message ? h`<p id="custom-message">${hc.custom_message}</p>` : h``}`;
  return page(ctx, 'Done', content, extra);
}

function expiredPage(ctx) {
  const content = h`<h1>This session has expired</h1><p id="status" data-status="expired">Portal sessions expire after a period of inactivity. Return to the website to open a new one.</p>`;
  return page(ctx, 'Session expired', content, { status: 410 });
}

// Screens for GET ----------------------------------------------------------------------------

/**
 * What a flow_data deep link opens: its screens (the first is the landing screen) and the one
 * action it performs. The rest of the portal is hidden, so GET and POST are both limited to these
 * (docs.stripe.com/customer-management/portal-deep-links).
 */
const FLOWS = {
  subscription_update: { screens: ['update', 'confirm_update'], action: 'update_subscription' },
  subscription_update_confirm: { screens: ['confirm_update'], action: 'update_subscription' },
  subscription_cancel: { screens: ['cancel'], action: 'cancel_subscription' },
  payment_method_update: { screens: ['payment_method'], action: 'update_payment_method' },
  customer_update: { screens: ['billing'], action: 'update_customer' },
};

/** The subscription a flow is about, or undefined. */
function flowSubscription(flow) {
  return flow[flow.type]?.subscription;
}

/** True while a deep-link session only allows its flow; after it completes, only portal_homepage opens the portal. */
function flowRestricted(session) {
  return Boolean(session.flow) && (!session._flow_done || session.flow.after_completion.type !== 'portal_homepage');
}

/** Refuses a POST the flow does not offer; returns the form with the flow's subscription filled in. */
function flowForm(ctx, form) {
  const { session } = ctx;
  if (!flowRestricted(session)) return form;
  if (session._flow_done) throw new PageError('This portal session is complete. Return to the website to make other changes.', 403);
  const def = FLOWS[session.flow.type];
  if (!def || form.action !== def.action) throw new PageError('That action is not available here.', 403);
  const subscription = flowSubscription(session.flow);
  if (subscription === undefined) return form;
  if (form.subscription !== undefined && form.subscription !== subscription) throw new PageError('That action is not available here.', 403);
  return { ...form, subscription };
}

function render(ctx, query, extra = {}) {
  let screen = query.screen ?? 'home';
  let subscription = query.subscription;
  const { session } = ctx;
  if (flowRestricted(session)) {
    if (session._flow_done) return doneScreen(ctx, query.notice, extra);
    const def = FLOWS[session.flow.type];
    if (!def?.screens.includes(screen)) screen = def?.screens[0] ?? 'home';
    subscription = flowSubscription(session.flow) ?? subscription;
  }
  switch (screen) {
    case 'update':
      return updateScreen(ctx, subscription, extra);
    case 'confirm_update':
      return confirmScreen(ctx, subscription, query, extra);
    case 'cancel':
      return cancelScreen(ctx, subscription, extra);
    case 'payment_method':
      return paymentMethodScreen(ctx, extra);
    case 'billing':
      return billingScreen(ctx, extra);
    case 'done':
      return doneScreen(ctx, query.notice);
    default:
      return homeScreen(ctx, { ...extra, notice: extra.notice ?? NOTICES[query.notice] });
  }
}

// Actions ------------------------------------------------------------------------------------

function cancellationDetails(ctx, form) {
  const reason = ctx.config.features.subscription_cancel.cancellation_reason;
  const details = { comment: null, feedback: null };
  if (reason.enabled && form.reason) {
    if (!reason.options.includes(form.reason)) throw new PageError('Choose one of the listed reasons.');
    details.feedback = form.reason;
  }
  if (typeof form.comment === 'string' && form.comment.trim()) details.comment = form.comment.trim();
  return details;
}

/** Points subscriptions that override the customer's default card at `paymentMethodId`. */
function syncSubscriptionCards(ctx, paymentMethodId) {
  for (const sub of liveSubscriptions(ctx)) {
    if (sub.default_payment_method && sub.default_payment_method !== paymentMethodId) {
      billing.updateSubscription(ctx.account, sub, { defaultPaymentMethod: paymentMethodId }, { source: 'portal', request: null });
    }
  }
}

function setDefaultCard(ctx, paymentMethodId) {
  changeCustomer(ctx.account, ctx.customer, (c) => {
    c.invoice_settings.default_payment_method = paymentMethodId;
  }, { request: null });
  syncSubscriptionCards(ctx, paymentMethodId);
}

function readAddressFields(form, prefix) {
  const keys = ['line1', 'line2', 'city', 'state', 'postal_code', 'country'];
  if (!keys.some((k) => form[`${prefix}_${k}`] !== undefined)) return undefined;
  const out = {};
  for (const k of keys) out[k] = typeof form[`${prefix}_${k}`] === 'string' ? form[`${prefix}_${k}`].trim() : '';
  if (out.country) out.country = out.country.toUpperCase();
  return out;
}

const ACTIONS = {
  update_subscription(ctx, form) {
    const { sub, item, next, quantity, scheduled } = planChange(ctx, form.subscription, form);
    if (scheduled) {
      schedules.scheduleChangeAtPeriodEnd(ctx.account, sub, [{ price: next, quantity }], { request: null });
      return 'scheduled';
    }
    const su = ctx.config.features.subscription_update;
    // A declined payment makes the price change fail (docs.stripe.com/billing/subscriptions/coupons):
    // nothing changes and the card error is shown on the confirm screen, keeping a flow open.
    billing.changeSubscriptionItems(
      ctx.account,
      sub,
      {
        items: [{ id: item.id, price: next, quantity }],
        prorationBehavior: su.proration_behavior ?? 'none',
        billingCycleAnchor: su.billing_cycle_anchor ?? 'unchanged',
        trialUpdateBehavior: su.trial_update_behavior ?? 'end_trial',
        paymentBehavior: 'error_if_incomplete',
      },
      { source: 'portal', request: null },
    );
    return 'updated';
  },
  cancel_subscription(ctx, form) {
    const sub = subscriptionFor(ctx, form.subscription, { cancel: true });
    if (isCanceling(sub)) throw new PageError('This subscription is already set to cancel.');
    const sc = ctx.config.features.subscription_cancel;
    const details = cancellationDetails(ctx, form);
    if (sc.mode === 'immediately') {
      billing.cancelSubscription(ctx.account, sub, {
        prorate: sc.proration_behavior === 'create_prorations',
        cancellationDetails: details,
        source: 'portal',
        request: null,
      });
      return 'canceled';
    }
    billing.setCancelAtPeriodEnd(ctx.account, sub, true, { source: 'portal', cancellationDetails: details, request: null });
    return 'canceling';
  },
  renew_subscription(ctx, form) {
    const sub = subscriptionFor(ctx, form.subscription);
    if (sub.schedule) throw new PageError('This subscription has an update scheduled, so it cannot be changed here.');
    if (!isCanceling(sub)) throw new PageError('This subscription is not set to cancel.');
    billing.setCancelAtPeriodEnd(ctx.account, sub, false, { source: 'portal', request: null });
    return 'renewed';
  },
  update_payment_method(ctx, form) {
    if (!ctx.config.features.payment_method_update.enabled) throw new PageError('Updating the payment method is not available.');
    const card = readCardForm(form);
    if (!card) throw new PageError('Enter a card number.');
    const pm = createCardPaymentMethod(ctx.account, { ...card, email: ctx.customer.email ?? undefined }, { request: null });
    attachPaymentMethod(ctx.account, pm.id, ctx.customer, { param: 'payment_method', request: null });
    setDefaultCard(ctx, pm.id);
    return 'payment_method';
  },
  set_default_payment_method(ctx, form) {
    if (!ctx.config.features.payment_method_update.enabled) throw new PageError('Updating the payment method is not available.');
    const pm = ctx.account.store.get('payment_method', form.payment_method);
    if (!pm || pm.customer !== ctx.customer.id) throw new PageError('That payment method was not found.', 404);
    setDefaultCard(ctx, pm.id);
    return 'payment_method';
  },
  detach_payment_method(ctx, form) {
    if (!ctx.config.features.payment_method_update.enabled) throw new PageError('Updating the payment method is not available.');
    const pm = ctx.account.store.get('payment_method', form.payment_method);
    if (!pm || pm.customer !== ctx.customer.id) throw new PageError('That payment method was not found.', 404);
    if (ctx.customer.invoice_settings?.default_payment_method === pm.id) throw new PageError('Choose another default payment method before removing this one.');
    if (liveSubscriptions(ctx).some((s) => s.default_payment_method === pm.id)) throw new PageError('This payment method pays a subscription, so it cannot be removed.');
    detachPaymentMethod(ctx.account, pm, { request: null });
    return 'removed';
  },
  update_customer(ctx, form) {
    const cu = ctx.config.features.customer_update;
    if (!cu.enabled) throw new PageError('Updating billing information is not available.');
    const allowed = new Set(cu.allowed_updates);
    const params = {};
    const text = (name) => (typeof form[name] === 'string' ? form[name].trim() : undefined);
    if (allowed.has('name') && text('name') !== undefined) params.name = text('name');
    if (allowed.has('email') && text('email') !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text('email'))) throw new PageError('Enter a valid email address.');
      params.email = text('email');
    }
    if (allowed.has('phone') && text('phone') !== undefined) params.phone = text('phone');
    if (allowed.has('address')) {
      const address = readAddressFields(form, 'address');
      if (address) params.address = address;
    }
    if (allowed.has('shipping')) {
      const address = readAddressFields(form, 'shipping');
      if (address) params.shipping = { name: text('shipping_name') || ctx.customer.name || '', address };
    }
    updateCustomer(ctx.account, ctx.customer, params, { request: null });
    return 'billing';
  },
};

/** Where to go after an action: after_completion for a flow, else the homepage. */
function finish(ctx, notice) {
  const { session, base } = ctx;
  if (session.flow && !session._flow_done) {
    session._flow_done = true;
    const ac = session.flow.after_completion;
    if (ac.type === 'redirect') return redirect(ac.redirect.return_url);
    if (ac.type === 'portal_homepage') return redirect(`${base}?screen=home&notice=${notice}`);
    return redirect(`${base}?screen=done&notice=${notice}`);
  }
  return redirect(`${base}?notice=${notice}`);
}

// Handlers -----------------------------------------------------------------------------------

function show(p) {
  const ctx = load(p);
  if (!ctx) return notFoundPage('This portal session');
  if (isExpired(ctx.account, ctx.session)) return expiredPage(ctx);
  touch(ctx.account, ctx.session);
  try {
    return render(ctx, p.query);
  } catch (err) {
    if (err instanceof PageError) return homeScreen(ctx, { error: err.message, status: err.status });
    throw err;
  }
}

function act(p) {
  const ctx = load(p);
  if (!ctx) return notFoundPage('This portal session');
  if (isExpired(ctx.account, ctx.session)) return expiredPage(ctx);
  touch(ctx.account, ctx.session);
  let form = p.form;
  const action = ACTIONS[form.action];
  const fail = (err) => {
    if (!(err instanceof PageError) && !(err instanceof StripeError)) throw err;
    const message = err instanceof PageError ? err.message : messageOf(err);
    const status = err instanceof PageError ? err.status : statusOf(err);
    const query = { screen: form.screen ?? screenOfAction(form.action), subscription: form.subscription, price: form.price, quantity: form.quantity };
    try {
      return render(ctx, query, { error: message, status });
    } catch (again) {
      if (again instanceof PageError) return homeScreen(ctx, { error: message, status });
      throw again;
    }
  };
  if (!action) return fail(new PageError('Unknown action.'));
  try {
    form = flowForm(ctx, form);
    return finish(ctx, action(ctx, form));
  } catch (err) {
    return fail(err);
  }
}

function screenOfAction(action) {
  return { update_subscription: 'confirm_update', cancel_subscription: 'cancel', update_payment_method: 'payment_method', update_customer: 'billing' }[action] ?? 'home';
}

// Login page ---------------------------------------------------------------------------------

function loginConfig(p) {
  return p.account.store.list('billing_portal.configuration', (c) => c._login_token === p.pathParams.token && c.login_page.enabled)[0] ?? null;
}

function loginPage(config, { error, status = 200 } = {}) {
  const body = h`${PAGE_STYLE}
<p class="muted"><span class="badge">Test mode</span> ${config.business_profile.headline ?? 'Customer portal'}</p>
<h1>Sign in to manage your subscription</h1>
${errorBox(error)}
<form method="post"><label for="email">Email</label><input id="email" name="email" type="email"><button type="submit">Continue</button></form>`;
  return html('Sign in', body, { status });
}

/** The most recently created customer with `email` that has an active subscription (else the most recent with that email). */
function customerForEmail(account, email) {
  const matches = account.store
    .list('customer', (c) => !c._deleted && typeof c.email === 'string' && c.email.toLowerCase() === email.toLowerCase())
    .sort((a, b) => b.created - a.created || b._seq - a._seq);
  const active = matches.find((c) => account.store.list('subscription', (s) => s.customer === c.id && ['active', 'trialing', 'past_due'].includes(s.status)).length);
  return active ?? matches[0] ?? null;
}

function showLogin(p) {
  const config = loginConfig(p);
  return config ? loginPage(config) : notFoundPage('This login page');
}

function submitLogin(p) {
  const config = loginConfig(p);
  if (!config) return notFoundPage('This login page');
  const email = typeof p.form.email === 'string' ? p.form.email.trim() : '';
  if (!email) return loginPage(config, { error: 'Enter your email address.', status: 400 });
  const customer = customerForEmail(p.account, email);
  if (!customer) return loginPage(config, { error: 'No account was found for that email address.', status: 404 });
  const params = { customer: customer.id, configuration: config.id };
  if (config.default_return_url) params.return_url = config.default_return_url;
  try {
    const session = createPortalSession(p.account, params, { version: p.account.settings.apiVersion, request: null, allowNoReturnUrl: true });
    return redirect(session.url);
  } catch (err) {
    return loginPage(config, { error: messageOf(err), status: statusOf(err) });
  }
}

export function install(app) {
  app.page('GET', '/p/session/:token', show, { account: sessionAccount });
  app.page('POST', '/p/session/:token', act, { account: sessionAccount });
  app.page('GET', '/p/login/:token', showLogin, { account: sessionAccount });
  app.page('POST', '/p/login/:token', submitLogin, { account: sessionAccount });
}
