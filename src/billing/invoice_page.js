/**
 * The hosted invoice page: plain HTML at the invoice's hosted_invoice_url, drivable by a browser
 * or by form POSTs.
 *
 *   GET  /i/:acct/:token        the invoice (number, status, lines, amounts) and, while it can be
 *                               paid, the card form shared by the hosted pages
 *   POST /i/:acct/:token        pays with the posted test card (card_number, exp_month?, exp_year?,
 *                               cvc?, cardholder_name?); 303 back to the page, or 402 with the decline
 *   GET  /i/:acct/:token/pdf    a plain-text rendering of the invoice ("PDF-ish")
 *
 * The card is created as a PaymentMethod, attached to the invoice's customer (payment_method.attached)
 * and charged through billing.payInvoice; it does not become a default payment method.
 */
import { StripeError } from '../core/errors.js';
import { formatAmount } from '../core/currency.js';
import { h, html, notFoundPage, redirect, text } from '../core/html.js';
import { attachPaymentMethod, createCardPaymentMethod } from '../payments/payment_methods.js';
import { PAGE_STYLE, cardFields, errorBox, messageOf, readCardForm, statusOf, testCardHelp } from '../checkout/page_kit.js';
import { payInvoice } from './engine.js';

const accountOf = (pathParams, server) => server.accountForId(pathParams.token);

/** The finalized invoice behind a hosted token, or null. */
function invoiceOf(p) {
  if (p.pathParams.acct !== p.account.id) return null;
  return p.account.store.list('invoice', (i) => i._token === p.pathParams.token && i.status !== 'draft')[0] ?? null;
}

function day(t) {
  return t ? new Date(t * 1000).toISOString().slice(0, 10) : '—';
}

function payable(invoice) {
  return ['open', 'uncollectible'].includes(invoice.status) && invoice.amount_remaining > 0;
}

function page(p, invoice, { error = null, status = 200 } = {}) {
  const money = (amount) => formatAmount(amount, invoice.currency);
  const lines = invoice.lines.data.map(
    (l) => h`<tr><td>${l.description ?? ''}</td><td>${day(l.period.start)} – ${day(l.period.end)}</td><td style="text-align:right">${money(l.amount)}</td></tr>`,
  );
  const base = p.path.replace(/\/$/, '');
  const form = payable(invoice)
    ? h`<h2>Pay ${money(invoice.amount_remaining)}</h2>
<form id="pay-form" method="post" action="${base}">
  ${cardFields()}
  <button type="submit" id="pay">Pay ${money(invoice.amount_remaining)}</button>
</form>
${testCardHelp()}`
    : '';
  const body = h`${PAGE_STYLE}
<p class="muted"><span class="badge">Test mode</span> Invoice</p>
<h1>Invoice ${invoice.number ?? ''}</h1>
<p class="muted">Status: <strong data-status="${invoice.status}">${invoice.status}</strong>${invoice.status === 'paid' ? ` · paid ${day(invoice.status_transitions.paid_at)}` : ''}</p>
${errorBox(error)}
<p>Billed to ${invoice.customer_name ?? invoice.customer_email ?? invoice.customer}${invoice.customer_email && invoice.customer_name ? h` &lt;${invoice.customer_email}&gt;` : ''}<br>
Issued ${day(invoice.status_transitions.finalized_at ?? invoice.created)}${invoice.due_date ? ` · due ${day(invoice.due_date)}` : ''}</p>
<table>
<thead><tr><th>Description</th><th>Period</th><th style="text-align:right">Amount</th></tr></thead>
<tbody>${lines}</tbody>
</table>
<p>Total: <strong>${money(invoice.total)}</strong><br>
Amount due: ${money(invoice.amount_due)} · Paid: ${money(invoice.amount_paid)} · Remaining: <span data-amount-remaining="${invoice.amount_remaining}">${money(invoice.amount_remaining)}</span></p>
${form}
<p><a href="${base}/pdf">Download invoice (text)</a></p>`;
  return html(`Invoice ${invoice.number ?? ''}`.trim(), body, { status });
}

function pdf(invoice) {
  const money = (amount) => formatAmount(amount, invoice.currency);
  const rows = invoice.lines.data.map((l) => `${(l.description ?? '').padEnd(60)} ${money(l.amount).padStart(14)}`);
  return [
    `INVOICE ${invoice.number ?? ''}`.trim(),
    `Status: ${invoice.status}`,
    `Issued: ${day(invoice.status_transitions.finalized_at ?? invoice.created)}${invoice.due_date ? `   Due: ${day(invoice.due_date)}` : ''}`,
    `Bill to: ${[invoice.customer_name, invoice.customer_email].filter(Boolean).join(' ') || invoice.customer}`,
    '',
    ...rows,
    '',
    `${'Subtotal'.padEnd(60)} ${money(invoice.subtotal).padStart(14)}`,
    `${'Total'.padEnd(60)} ${money(invoice.total).padStart(14)}`,
    `${'Amount due'.padEnd(60)} ${money(invoice.amount_due).padStart(14)}`,
    `${'Amount paid'.padEnd(60)} ${money(invoice.amount_paid).padStart(14)}`,
    `${'Amount remaining'.padEnd(60)} ${money(invoice.amount_remaining).padStart(14)}`,
    '',
  ].join('\n');
}

function pay(p) {
  const invoice = invoiceOf(p);
  if (!invoice) return notFoundPage('This invoice');
  if (!payable(invoice)) return redirect(p.path);
  const card = readCardForm(p.form);
  if (!card) return page(p, invoice, { error: 'Enter a card number.', status: 400 });
  const customer = p.account.store.get('customer', invoice.customer);
  try {
    const pm = createCardPaymentMethod(p.account, { ...card, email: customer?.email ?? undefined }, { request: null });
    attachPaymentMethod(p.account, pm.id, customer, { param: 'card_number', request: null });
    const res = payInvoice(p.account, invoice, { paymentMethod: pm.id, offSession: false, source: 'hosted_page', request: null });
    if (!res.ok) return page(p, invoice, { error: messageOf(res.error), status: res.error ? statusOf(res.error) : 402 });
  } catch (err) {
    if (err instanceof StripeError) return page(p, invoice, { error: messageOf(err), status: statusOf(err) });
    throw err;
  }
  return redirect(p.path);
}

export function install(app) {
  app.page('GET', '/i/:acct/:token', (p) => {
    const invoice = invoiceOf(p);
    return invoice ? page(p, invoice) : notFoundPage('This invoice');
  }, { account: accountOf });

  app.page('POST', '/i/:acct/:token', pay, { account: accountOf });

  app.page('GET', '/i/:acct/:token/pdf', (p) => {
    const invoice = invoiceOf(p);
    return invoice ? text(pdf(invoice)) : notFoundPage('This invoice');
  }, { account: accountOf });
}

