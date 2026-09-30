/**
 * The hosted Checkout page (docs.stripe.com/payments/checkout/how-checkout-works), a plain HTML
 * form that a browser or an HTTP client can drive.
 *
 *   GET  /c/pay/:id   line items, amount due today and the trial; contact, card and the fields the
 *                     session asks for; a cancel link to cancel_url.
 *   POST /c/pay/:id   form fields: card_number, exp_month, exp_year, cvc, cardholder_name, email,
 *                     phone, individual_name, business_name, address_* (billing), shipping_*,
 *                     custom_fields[key], consent_terms, consent_promotions, quantity[li_…],
 *                     optional[i] with optional_quantity[i].
 *                     Success → 303 to success_url with {CHECKOUT_SESSION_ID} replaced (return_url
 *                     for embedded sessions). A decline answers 402 with the page and the error; the
 *                     session stays open. Invalid input answers 400.
 */
import { h, html, redirect, notFoundPage } from '../core/html.js';
import { StripeError } from '../core/errors.js';
import { describeInterval, formatAmount } from '../core/currency.js';
import { createCardPaymentMethod } from '../payments/payment_methods.js';
import { amountDueToday, completeSession, finalLineItems } from './sessions.js';
import { isMetered, isRecurring, priceLabel } from './pricing.js';
import { PAGE_STYLE, cardFields, errorBox, formatDate, messageOf, readCardForm, statusOf, testCardHelp } from './page_kit.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBMIT_LABELS = { pay: 'Pay', book: 'Book', donate: 'Donate', subscribe: 'Subscribe', auto: 'Subscribe' };

const accountOf = (params, server) => server.accountForId(params.id);

function loadSession(p) {
  const session = p.account.store.get('checkout.session', p.pathParams.id);
  return session && session.object === 'checkout.session' ? session : null;
}

function substitute(url, session) {
  return url.split('{CHECKOUT_SESSION_ID}').join(session.id);
}

/** The value a text input shows after a failed POST. */
function kept(form, name) {
  const v = form?.[name];
  return typeof v === 'string' ? v : '';
}

function customerOf(account, session) {
  return session.customer ? account.store.get('customer', session.customer) : null;
}

function trialText(session, now) {
  const sd = session._subscription_data ?? {};
  if (sd.trial_period_days) return `${sd.trial_period_days} days free`;
  if (sd.trial_end) return `Free trial until ${formatDate(sd.trial_end)} (${Math.ceil((sd.trial_end - now) / 86400)} days)`;
  return null;
}

/** "$60.00 / month": what the recurring items cost per period (null when their intervals differ). */
function recurringTotal(account, session) {
  const entries = session._line_items.map((item) => ({ item, price: account.store.get('price', item.price) })).filter((e) => isRecurring(e.price) && !isMetered(e.price));
  if (!entries.length) return null;
  const { interval, interval_count: count = 1 } = entries[0].price.recurring;
  if (!entries.every((e) => e.price.recurring.interval === interval && (e.price.recurring.interval_count ?? 1) === count)) return null;
  return `${formatAmount(entries.reduce((sum, e) => sum + e.item.amount_total, 0), session.currency)} ${describeInterval(interval, count)}`;
}

// Rendering ----------------------------------------------------------------------------------

function lineItemRows(account, session) {
  return session._line_items.map((item) => {
    const price = account.store.get('price', item.price);
    const adj = item.adjustable_quantity;
    const qty = adj?.enabled
      ? h`<input class="qty" type="number" name="quantity[${item.id}]" min="${adj.minimum}" max="${adj.maximum}" value="${item.quantity}" form="checkout-form">`
      : h`${item.quantity ?? ''}`;
    return h`<tr class="line-item" data-item="${item.id}" data-price="${item.price}">
  <td>${item.description ?? item.price}</td><td>Qty ${qty}</td><td class="right">${priceLabel(price)}</td></tr>`;
  });
}

function optionalItemRows(account, session) {
  return session._optional_items.map((opt, i) => {
    const price = account.store.get('price', opt.price);
    const name = account.store.get('product', price?.product)?.name ?? opt.price;
    const adj = opt.adjustable_quantity;
    const qty = adj?.enabled
      ? h`<input class="qty" type="number" name="optional_quantity[${i}]" min="${Math.max(1, adj.minimum)}" max="${adj.maximum}" value="${opt.quantity}" form="checkout-form">`
      : h`${opt.quantity}<input type="hidden" name="optional_quantity[${i}]" value="${opt.quantity}" form="checkout-form">`;
    return h`<tr class="optional-item" data-price="${opt.price}">
  <td><label class="inline"><input type="checkbox" name="optional[${i}]" value="on" form="checkout-form"> Add ${name}</label></td><td>Qty ${qty}</td><td class="right">${priceLabel(price)}</td></tr>`;
  });
}

function addressFields(prefix, legend, { full, form, countries }) {
  const input = (name, label) =>
    h`<label for="${prefix}_${name}">${label}</label><input id="${prefix}_${name}" name="${prefix}_${name}" value="${kept(form, `${prefix}_${name}`)}">`;
  const country = countries
    ? h`<label for="${prefix}_country">Country</label><select id="${prefix}_country" name="${prefix}_country">${countries.map(
        (c) => h`<option value="${c}"${kept(form, `${prefix}_country`) === c ? ' selected' : ''}>${c}</option>`,
      )}</select>`
    : input('country', 'Country (two-letter code)');
  return h`<fieldset id="${prefix}">
  <legend>${legend}</legend>
  ${full ? input('line1', 'Address line 1') : h``}
  ${full ? input('line2', 'Address line 2 (optional)') : h``}
  ${full ? input('city', 'City') : h``}
  ${full ? input('state', 'State or province (optional)') : h``}
  ${input('postal_code', 'Postal code')}
  ${country}
</fieldset>`;
}

function customFieldInputs(session, form) {
  return session.custom_fields.map((f) => {
    const name = `custom_fields[${f.key}]`;
    const label = h`${f.label.custom}${f.optional ? ' (optional)' : ''}`;
    const value = form?.custom_fields?.[f.key] ?? f[f.type]?.default_value ?? '';
    if (f.type === 'dropdown') {
      return h`<label for="cf_${f.key}">${label}</label><select id="cf_${f.key}" name="${name}">${f.optional ? h`<option value=""></option>` : h``}${f.dropdown.options.map(
        (o) => h`<option value="${o.value}"${o.value === value ? ' selected' : ''}>${o.label}</option>`,
      )}</select>`;
    }
    return h`<label for="cf_${f.key}">${label}</label><input id="cf_${f.key}" name="${name}" value="${value}"${f.type === 'numeric' ? h` inputmode="numeric"` : h``}>`;
  });
}

function checkoutPage(p, session, { error, form, status = 200 } = {}) {
  const { account } = p;
  const customer = customerOf(account, session);
  const due = amountDueToday(account, session);
  const currency = session.currency;
  const trial = trialText(session, account.time.now(account.time.domainOf(session)));
  const collectCard = !(session.payment_method_collection === 'if_required' && due === 0);
  const then = recurringTotal(account, session);
  const firstName = session._line_items[0]?.description ?? 'your plan';
  const submit = SUBMIT_LABELS[session.submit_type ?? 'auto'] ?? 'Subscribe';
  const names = session._name_collection ?? {};
  const email = customer?.email
    ? h`<p id="email-display">Email: <strong>${customer.email}</strong></p>`
    : session.customer_email
      ? h`<p id="email-display">Email: <strong>${session.customer_email}</strong></p>`
      : h`<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" value="${kept(form, 'email')}">`;
  const body = h`
${PAGE_STYLE}
<p class="muted"><span class="badge">Test mode</span> Checkout</p>
<h1>Subscribe to ${firstName}</h1>
<p class="amount" id="amount-due" data-amount="${due}" data-currency="${currency}">${formatAmount(due, currency)} due today</p>
${trial ? h`<p id="trial">${trial}${then ? h`, then ${then}` : h``}</p>` : h``}
${errorBox(error)}
<table id="line-items">${lineItemRows(account, session)}</table>
${session._optional_items.length ? h`<h2>Add to your order</h2><table id="optional-items">${optionalItemRows(account, session)}</table>` : h``}
<form id="checkout-form" method="post" action="/c/pay/${session.id}">
  <h2>Contact information</h2>
  ${email}
  ${session.phone_number_collection.enabled ? h`<label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="${kept(form, 'phone')}">` : h``}
  ${names.individual?.enabled ? h`<label for="individual_name">Full name${names.individual.optional ? ' (optional)' : ''}</label><input id="individual_name" name="individual_name" value="${kept(form, 'individual_name')}">` : h``}
  ${names.business?.enabled ? h`<label for="business_name">Business name${names.business.optional ? ' (optional)' : ''}</label><input id="business_name" name="business_name" value="${kept(form, 'business_name')}">` : h``}
  ${customFieldInputs(session, form)}
  ${session.shipping_address_collection ? addressFields('shipping', 'Shipping address', { full: true, form, countries: session.shipping_address_collection.allowed_countries }) : h``}
  ${session.shipping_address_collection ? h`<label for="shipping_name">Shipping name</label><input id="shipping_name" name="shipping_name" value="${kept(form, 'shipping_name')}">` : h``}
  <h2>Payment</h2>
  ${collectCard ? cardFields() : h`<p id="no-payment-method">No payment method is needed today.</p>`}
  ${collectCard ? addressFields('address', 'Billing address', { full: session.billing_address_collection === 'required', form }) : h``}
  ${session.consent_collection?.terms_of_service === 'required' ? h`<label class="inline"><input type="checkbox" name="consent_terms" value="on"> ${session.custom_text.terms_of_service_acceptance?.message ?? 'I agree to the Terms of Service'}</label>` : h``}
  ${session.consent_collection?.promotions === 'auto' ? h`<label class="inline"><input type="checkbox" name="consent_promotions" value="on"> Send me promotional emails</label>` : h``}
  ${session.custom_text.submit ? h`<p class="muted">${session.custom_text.submit.message}</p>` : h``}
  <button type="submit" id="submit">${submit}</button>
  ${session.custom_text.after_submit ? h`<p class="muted">${session.custom_text.after_submit.message}</p>` : h``}
</form>
${session.cancel_url ? h`<p><a id="cancel" href="${session.cancel_url}">Cancel and go back</a></p>` : h``}
${collectCard ? testCardHelp() : h``}
<p class="muted">Session ${session.id} · expires ${formatDate(session.expires_at)}</p>`;
  return html('Checkout', body, { status });
}

function closedPage(session, status) {
  if (session.status === 'complete') {
    return html(
      'Checkout complete',
      h`<h1>You're all set</h1><p id="status" data-status="complete">This Checkout Session is complete.</p>${
        session.success_url ? h`<p><a href="${substitute(session.success_url, session)}">Continue</a></p>` : h``
      }`,
      { status: status ?? 200 },
    );
  }
  return html('Checkout expired', h`<h1>This page has expired</h1><p id="status" data-status="expired">This Checkout Session has expired.</p>`, {
    status: 410,
  });
}

/**
 * After completion: success_url, else return_url unless redirect_on_completion keeps the customer
 * on the page (never, or if_required: cards are not a redirect-based payment method).
 */
function completionPage(session) {
  const redirects = !['never', 'if_required'].includes(session._redirect_on_completion);
  const target = session.success_url ?? (redirects ? session._return_url : null);
  if (target) return redirect(substitute(target, session));
  return html('Checkout complete', h`<h1>Thanks!</h1><p id="status" data-status="complete">Your subscription has started.</p>`);
}

// Reading the form ---------------------------------------------------------------------------

class FormError extends Error {}

function required(value, message) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new FormError(message);
  return v;
}

function readAddress(form, prefix, { full, countries }) {
  const get = (k) => (typeof form[`${prefix}_${k}`] === 'string' ? form[`${prefix}_${k}`].trim() : '');
  const address = { city: get('city'), country: get('country').toUpperCase(), line1: get('line1'), line2: get('line2'), postal_code: get('postal_code'), state: get('state') };
  if (full) {
    required(address.line1, 'Enter the address.');
    required(address.city, 'Enter the city.');
    required(address.postal_code, 'Enter the postal code.');
    required(address.country, 'Choose the country.');
  }
  if (address.country && !/^[A-Z]{2}$/.test(address.country)) throw new FormError('Use a two-letter country code, such as US.');
  if (countries && !countries.includes(address.country)) throw new FormError(`Shipping to ${address.country || 'that country'} is not available.`);
  if (!Object.values(address).some(Boolean)) return null;
  for (const k of Object.keys(address)) if (!address[k]) address[k] = null;
  return address;
}

function toQuantity(value) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

/** Reads and checks the posted form; returns completeSession options (without the card). */
function readCheckoutForm(account, session, form) {
  const customer = customerOf(account, session);
  const out = {};
  if (customer?.email) out.email = customer.email;
  else if (session.customer_email) out.email = session.customer_email;
  else {
    out.email = required(form.email, 'Enter your email address.');
    if (!EMAIL.test(out.email)) throw new FormError('Enter a valid email address.');
  }
  if (session.phone_number_collection.enabled) out.phone = required(form.phone, 'Enter your phone number.');
  const names = session._name_collection ?? {};
  for (const [kind, key] of [['individual', 'individualName'], ['business', 'businessName']]) {
    if (!names[kind]?.enabled) continue;
    const value = typeof form[`${kind}_name`] === 'string' ? form[`${kind}_name`].trim() : '';
    if (!value && !names[kind].optional) throw new FormError(`Enter your ${kind === 'business' ? 'business name' : 'full name'}.`);
    if (value) out[key] = value;
  }
  if (typeof form.cardholder_name === 'string' && form.cardholder_name.trim()) out.name = form.cardholder_name.trim();
  const customFields = {};
  for (const f of session.custom_fields) {
    const value = typeof form.custom_fields?.[f.key] === 'string' ? form.custom_fields[f.key].trim() : '';
    if (!value) {
      if (!f.optional) throw new FormError(`Fill in "${f.label.custom}".`);
      continue;
    }
    if (f.type === 'dropdown' && !f.dropdown.options.some((o) => o.value === value)) throw new FormError(`Choose a value for "${f.label.custom}".`);
    if (f.type === 'numeric' && !/^\d+$/.test(value)) throw new FormError(`"${f.label.custom}" takes digits only.`);
    const cfg = f[f.type];
    if (cfg.minimum_length !== null && cfg.minimum_length !== undefined && value.length < cfg.minimum_length) {
      throw new FormError(`"${f.label.custom}" needs at least ${cfg.minimum_length} characters.`);
    }
    if (cfg.maximum_length !== null && cfg.maximum_length !== undefined && value.length > cfg.maximum_length) {
      throw new FormError(`"${f.label.custom}" takes at most ${cfg.maximum_length} characters.`);
    }
    customFields[f.key] = value;
  }
  out.customFields = customFields;
  if (session.shipping_address_collection) {
    const address = readAddress(form, 'shipping', { full: true, countries: session.shipping_address_collection.allowed_countries });
    out.shipping = { name: required(form.shipping_name, 'Enter the name for shipping.'), address };
  }
  if (session.consent_collection?.terms_of_service === 'required' && form.consent_terms !== 'on') {
    throw new FormError('Agree to the Terms of Service to continue.');
  }
  out.consent = { promotions: form.consent_promotions === 'on' };
  const quantities = {};
  for (const [id, value] of Object.entries(form.quantity ?? {})) quantities[id] = toQuantity(value);
  const optionalItems = {};
  for (const [index, on] of Object.entries(form.optional ?? {})) {
    if (on) optionalItems[index] = toQuantity(form.optional_quantity?.[index] ?? session._optional_items[Number(index)]?.quantity);
  }
  out.quantities = quantities;
  out.optionalItems = optionalItems;
  const items = finalLineItems(account, session, { quantities, optionalItems, mint: false });
  const due = amountDueToday(account, session, items);
  out.collectCard = !(session.payment_method_collection === 'if_required' && due === 0);
  if (out.collectCard) out.address = readAddress(form, 'address', { full: session.billing_address_collection === 'required' });
  return out;
}

// Handlers -----------------------------------------------------------------------------------

function show(p) {
  const session = loadSession(p);
  if (!session) return notFoundPage('This Checkout Session');
  if (session.status !== 'open') return closedPage(session);
  return checkoutPage(p, session);
}

function submit(p) {
  const { account, form } = p;
  const session = loadSession(p);
  if (!session) return notFoundPage('This Checkout Session');
  if (session.status !== 'open') return closedPage(session, 409);
  const fail = (err) => {
    if (!(err instanceof FormError) && !(err instanceof StripeError)) throw err;
    return checkoutPage(p, session, { error: err instanceof FormError ? err.message : messageOf(err), form, status: err instanceof FormError ? 400 : statusOf(err) });
  };
  let input;
  try {
    input = readCheckoutForm(account, session, form);
  } catch (err) {
    return fail(err);
  }
  const { collectCard, ...options } = input;
  let paymentMethod = null;
  if (collectCard) {
    const typed = readCardForm(form);
    if (!typed) return fail(new FormError('Enter your card number.'));
    try {
      paymentMethod = createCardPaymentMethod(account, { ...typed, name: typed.name ?? options.name, email: options.email }, { request: null });
    } catch (err) {
      return fail(err);
    }
  }
  try {
    completeSession(account, session, { ...options, paymentMethod });
  } catch (err) {
    return fail(err);
  }
  return completionPage(session);
}

export function install(app) {
  app.page('GET', '/c/pay/:id', show, { account: accountOf });
  app.page('POST', '/c/pay/:id', submit, { account: accountOf });
}

