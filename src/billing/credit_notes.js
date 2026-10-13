/** Credit notes: validate an adjustment first, then apply it through invoice and payment owners. */
import { emitEvent, updateWithEvent } from '../core/events.js';
import { invalidParam, invalidRequest, parameterMissing, parametersExclusive, resourceMissing } from '../core/errors.js';
import { ListResult, matchesRange, paginate } from '../core/list.js';
import { applyMetadata } from '../core/util.js';
import { atLeast } from '../core/versions.js';
import { notFoundPage, text } from '../core/html.js';
import { changeCustomer } from '../customers/customers.js';
import { createRefund, prepareRefund } from '../payments/refunds.js';
import { adjustInvoiceCreditNotes } from './invoicing.js';
import { decimalString, extendedDecimalAmount, nowOf } from './util.js';

function positive(n, param) {
  if (!Number.isSafeInteger(n) || n <= 0) throw invalidParam(param, 'Amount or quantity must be a positive integer.');
  return n;
}

function nonnegative(n, param) {
  if (!Number.isSafeInteger(n) || n < 0) throw invalidParam(param, 'Amount must be a nonnegative integer.');
  return n;
}

function creditedLines(account, invoice) {
  return account.store.list('credit_note', (n) => n.invoice === invoice.id && n.status === 'issued').flatMap((n) => n.lines.data);
}

/** Construct line specifications without IDs or side effects; quantity/amount modes cannot mix. */
function prepareLines(account, invoice, p) {
  if (p.amount !== undefined && p.lines !== undefined) throw parametersExclusive(['amount', 'lines'], { param: 'lines' });
  const credited = creditedLines(account, invoice);
  let sent = p.lines;
  if (p.amount !== undefined) {
    let left = positive(p.amount, 'amount');
    sent = [];
    // The API does not document how amount-only credits are distributed; see README.
    for (const line of invoice.lines.data) {
      const used = credited.filter((l) => l.invoice_line_item === line.id).reduce((sum, l) => sum + l.amount, 0);
      const amount = Math.min(left, Math.max(0, line.amount - used));
      if (amount) sent.push({ type: 'invoice_line_item', invoice_line_item: line.id, amount });
      left -= amount;
      if (!left) break;
    }
    if (left) throw invalidParam('amount', 'Credit exceeds the remaining line amounts.');
  }
  if (!Array.isArray(sent) || !sent.length) throw parameterMissing('lines');
  const result = [];
  for (const [i, line] of sent.entries()) {
    const prefix = `lines[${i}]`;
    const param = (k) => `${prefix}[${k}]`;
    for (const key of ['tax_rates', 'tax_amounts']) if (line[key]?.length) throw invalidRequest('Credit-note taxes are not modelled.', { param: param(key) });
    let amount, quantity, unit, original = null, mode = null;
    if (line.type === 'invoice_line_item') {
      if (!line.invoice_line_item) throw parameterMissing(param('invoice_line_item'));
      original = invoice.lines.data.find((l) => l.id === line.invoice_line_item);
      if (!original) throw resourceMissing('line_item', line.invoice_line_item, { param: param('invoice_line_item') });
      if (line.unit_amount !== undefined || line.unit_amount_decimal !== undefined) throw invalidParam(param('unit_amount'), 'An invoice line credit uses amount or quantity.');
      if (line.amount !== undefined && line.quantity !== undefined) throw parametersExclusive([param('amount'), param('quantity')], { param: param('quantity') });
      mode = line.quantity !== undefined ? 'quantity' : 'amount';
      const used = [...credited, ...result].filter((l) => l.invoice_line_item === original.id);
      if (used.some((l) => l._creditMode !== mode)) throw invalidParam(prefix, 'Cannot mix amount and quantity credits for an invoice line.');
      quantity = mode === 'quantity' ? positive(line.quantity, param('quantity')) : null;
      unit = original.pricing?.unit_amount_decimal ?? decimalString(original.quantity ? original.amount / original.quantity : original.amount);
      amount = mode === 'quantity' ? extendedDecimalAmount(unit, quantity) : (line.amount ?? original.amount);
      if (!Number.isSafeInteger(amount) || !amount || Math.sign(amount) !== Math.sign(original.amount)) throw invalidParam(param('amount'), 'Credit must have the same sign as the invoice line.');
      const remaining = original.amount - used.reduce((sum, l) => sum + l.amount, 0);
      if (Math.abs(amount) > Math.abs(remaining)) throw invalidParam(param('amount'), 'Credit exceeds the uncredited invoice line amount.');
      if (mode === 'quantity' && quantity + used.reduce((sum, l) => sum + (l.quantity ?? 0), 0) > original.quantity) throw invalidParam(param('quantity'), 'Credit exceeds the invoice line quantity.');
    } else {
      if (line.invoice_line_item !== undefined || line.amount !== undefined) throw invalidParam(prefix, 'A custom line needs unit_amount and quantity.');
      if (line.unit_amount !== undefined && line.unit_amount_decimal !== undefined) throw parametersExclusive([param('unit_amount'), param('unit_amount_decimal')], { param: param('unit_amount_decimal') });
      if (line.unit_amount === undefined && line.unit_amount_decimal === undefined) throw parameterMissing(param('unit_amount'));
      quantity = positive(line.quantity ?? 1, param('quantity'));
      unit = line.unit_amount_decimal ?? String(line.unit_amount);
      if (Number(unit) < 0) throw invalidParam(param('unit_amount'), 'Custom credits cannot be negative.');
      amount = extendedDecimalAmount(unit, quantity);
      positive(amount, param('unit_amount'));
    }
    result.push({
      object: 'credit_note_line_item', amount,
      description: line.description ?? original?.description ?? null,
      discount_amount: 0, discount_amounts: [], invoice_line_item: original?.id ?? null,
      livemode: false, quantity, type: line.type,
      unit_amount: Number.isInteger(Number(unit)) ? Number(unit) : null,
      unit_amount_decimal: String(unit).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''), metadata: applyMetadata({}, line.metadata),
      _creditMode: mode,
    });
  }
  return result;
}

/** Validate all accounting and refund inputs before mutating an invoice, balance, or ID counter. */
function prepareNote(account, p, version) {
  for (const key of Object.keys(p)) if (!['invoice', 'amount', 'lines', 'credit_amount', 'refund_amount', 'out_of_band_amount', 'refund', 'refunds', 'memo', 'metadata', 'reason', 'effective_at', 'email_type', 'expand', 'limit', 'starting_after', 'ending_before'].includes(key)) throw invalidRequest(`Credit note parameter ${key} is not modelled.`, { param: key });
  if (!p.invoice) throw parameterMissing('invoice');
  const invoice = account.store.require('invoice', p.invoice, { param: 'invoice' });
  if (!['open', 'paid'].includes(invoice.status)) throw invalidRequest('Credit notes require an open or paid invoice.', { param: 'invoice' });
  const pi = invoice._paymentIntent ? account.store.get('payment_intent', invoice._paymentIntent) : null;
  if (invoice.status === 'open' && pi && ['processing', 'requires_action', 'requires_capture'].includes(pi.status)) throw invalidRequest('Invoice has a pending payment.', { param: 'invoice' });
  const lines = prepareLines(account, invoice, p);
  const amount = positive(lines.reduce((sum, l) => sum + l.amount, 0), 'amount');
  const available = invoice.total - invoice.pre_payment_credit_notes_amount - invoice.post_payment_credit_notes_amount;
  if (amount > available) throw invalidParam('amount', 'Credit notes cannot exceed the invoice total.');
  const pre = invoice.status === 'open' ? Math.min(amount, invoice.amount_remaining) : 0;
  const post = amount - pre;
  if (pre && post && !atLeast(version, '2025-09-30.clover')) throw invalidParam('amount', 'Mixed pre-payment and post-payment credits need clover or later.');
  const credit = nonnegative(p.credit_amount ?? 0, 'credit_amount');
  const outOfBand = nonnegative(p.out_of_band_amount ?? 0, 'out_of_band_amount');
  const refundAmount = nonnegative(p.refund_amount ?? 0, 'refund_amount');
  if (p.refund_amount !== undefined && (p.refund !== undefined || p.refunds !== undefined)) throw parametersExclusive(['refund_amount', p.refund ? 'refund' : 'refunds']);
  const linked = p.refund ? [{ refund: p.refund }] : (p.refunds ?? []);
  const refunds = linked.map((link, i) => {
    if (link.payment_record_refund || (link.type && link.type !== 'refund')) throw invalidParam(`refunds[${i}]`, 'Only card refunds are modelled.');
    const r = account.store.require('refund', link.refund, { param: p.refund ? 'refund' : `refunds[${i}][refund]` });
    if (r.status !== 'succeeded' || r.charge !== invoice._charge) throw invalidParam('refund', 'Refund must be successful and belong to this invoice.');
    const used = account.store.list('credit_note', (n) => n.status === 'issued').flatMap((n) => n.refunds).filter((x) => x.refund === r.id).reduce((sum, x) => sum + x.amount_refunded, 0);
    const amountRefunded = positive(link.amount_refunded ?? r.amount, `refunds[${i}][amount_refunded]`);
    if (used + amountRefunded > r.amount) throw invalidParam('refund', 'Refund is already allocated to a credit note.');
    return { refund: r.id, amount_refunded: amountRefunded };
  });
  if (new Set(refunds.map((r) => r.refund)).size !== refunds.length) throw invalidParam('refunds', 'Refund IDs must be unique.');
  const allocated = refunds.reduce((sum, r) => sum + r.amount_refunded, 0) + refundAmount + credit + outOfBand;
  if (allocated !== post) throw invalidParam('refund_amount', 'Refund, credit and out-of-band amounts must equal the post-payment credit.');
  if (refundAmount) prepareRefund(account, { charge: invoice._charge, amount: refundAmount });
  return { invoice, lines, amount, pre, post, credit, outOfBand, refundAmount, refunds, metadata: applyMetadata({}, p.metadata) };
}

function buildNote(account, prepared, p, { preview = false } = {}) {
  const { invoice, lines, amount, pre, post, outOfBand, refunds, metadata } = prepared;
  const id = preview ? 'cn_preview' : account.mintId('cn');
  const now = nowOf(account, invoice);
  const sequence = account.store.list('credit_note', (n) => n.invoice === invoice.id).length + 1;
  return {
    id, object: 'credit_note', amount, amount_shipping: 0, created: now, currency: invoice.currency,
    customer: invoice.customer, customer_balance_transaction: null, discount_amount: 0, discount_amounts: [],
    effective_at: p.effective_at ?? now, invoice: invoice.id,
    lines: { object: 'list', data: lines.map((l, i) => ({ ...l, id: preview ? `cnli_preview_${i}` : account.mintId('cnli') })), has_more: false, url: `/v1/credit_notes/${preview ? 'preview' : id}/lines` },
    livemode: false, memo: p.memo || null, metadata, number: `${invoice.number}-CN-${String(sequence).padStart(2, '0')}`,
    out_of_band_amount: outOfBand || null, pdf: `${account.server.url}/credit_notes/${id}/pdf`,
    pre_payment_amount: pre, post_payment_amount: post, pretax_credit_amounts: [], reason: p.reason ?? null,
    refunds: structuredClone(refunds), shipping_cost: null, status: 'issued', subtotal: amount, subtotal_excluding_tax: amount,
    total: amount, total_excluding_tax: amount, total_taxes: [], type: pre && post ? 'mixed' : post ? 'post_payment' : 'pre_payment', voided_at: null,
  };
}

export function createCreditNote(account, p, { request, version = account.settings.apiVersion } = {}) {
  const prepared = prepareNote(account, p, version);
  const note = buildNote(account, prepared, p);
  if (prepared.refundAmount) {
    const refund = createRefund(account, { charge: prepared.invoice._charge, amount: prepared.refundAmount }, { request });
    note.refunds.push({ refund: refund.id, amount_refunded: refund.amount });
  }
  if (prepared.credit) {
    const customer = account.store.get('customer', note.customer);
    changeCustomer(account, customer, (c) => { c.balance -= prepared.credit; }, { request });
    const transaction = account.store.insert({ id: account.mintId('cbtxn'), object: 'customer_balance_transaction',
      amount: -prepared.credit, created: note.created, credit_note: note.id, currency: note.currency,
      customer: customer.id, description: note.memo, ending_balance: customer.balance, invoice: note.invoice,
      livemode: false, metadata: {}, type: 'credit_note' });
    note.customer_balance_transaction = transaction.id;
  }
  account.store.insert(note);
  adjustInvoiceCreditNotes(account, prepared.invoice, { pre: prepared.pre, post: prepared.post }, { request });
  emitEvent(account, 'credit_note.created', note, { request });
  return note;
}

export function previewCreditNote(account, p, { version = account.settings.apiVersion } = {}) {
  return buildNote(account, prepareNote(account, p, version), p, { preview: true });
}

export function updateCreditNote(account, note, p, { request } = {}) {
  const metadata = applyMetadata(note.metadata, p.metadata);
  updateWithEvent(account, note, 'credit_note.updated', () => {
    if (p.memo !== undefined) note.memo = p.memo || null;
    note.metadata = metadata;
  }, { request });
  return note;
}

export function voidCreditNote(account, note, { request } = {}) {
  const invoice = account.store.require('invoice', note.invoice);
  if (note.status !== 'issued' || invoice.status !== 'open' || note.post_payment_amount) throw invalidRequest('Only issued credit notes on open invoices can be voided.');
  note.status = 'void';
  note.voided_at = nowOf(account, invoice);
  adjustInvoiceCreditNotes(account, invoice, { pre: -note.pre_payment_amount, post: 0 }, { request });
  emitEvent(account, 'credit_note.voided', note, { request });
  return note;
}

export function renderCreditLine(line, ctx) {
  const out = { id: line.id, object: line.object, amount: line.amount, description: line.description,
    discount_amount: 0, discount_amounts: [], invoice_line_item: line.invoice_line_item, livemode: false,
    quantity: line.quantity, tax_rates: [], type: line.type, unit_amount: line.unit_amount, unit_amount_decimal: line.unit_amount_decimal };
  if (ctx.family === 'F1') Object.assign(out, { amount_excluding_tax: line.amount, unit_amount_excluding_tax: line.unit_amount_decimal, tax_amounts: [] });
  else Object.assign(out, { pretax_credit_amounts: [], taxes: [] });
  if (ctx.atLeast('2026-08-26.dahlia')) out.metadata = { ...line.metadata };
  return out;
}

export function renderCreditNote(note, ctx) {
  const out = { id: note.id, object: note.object, amount: note.amount, amount_shipping: 0,
    created: note.created, currency: note.currency, customer: note.customer,
    customer_balance_transaction: note.customer_balance_transaction, discount_amount: 0, discount_amounts: [],
    effective_at: note.effective_at, invoice: note.invoice,
    lines: { object: 'list', data: note.lines.data.slice(0, 10).map((l) => ctx.render(l)), has_more: note.lines.data.length > 10, url: note.lines.url },
    livemode: false, memo: note.memo, metadata: { ...note.metadata }, number: note.number,
    out_of_band_amount: note.out_of_band_amount, pdf: note.pdf, reason: note.reason,
    shipping_cost: null, status: note.status, subtotal: note.subtotal, subtotal_excluding_tax: note.subtotal,
    total: note.total, total_excluding_tax: note.total, type: note.type, voided_at: note.voided_at };
  if (ctx.family === 'F1') Object.assign(out, { refund: note.refunds[0]?.refund ?? null, tax_amounts: [] });
  else Object.assign(out, { refunds: note.refunds.map((r) => ({ ...r })), pretax_credit_amounts: [], total_taxes: [] });
  if (ctx.atLeast('2025-09-30.clover')) Object.assign(out, { pre_payment_amount: note.pre_payment_amount, post_payment_amount: note.post_payment_amount, customer_account: null });
  return out;
}

/** Credit note lines use invoice order, rather than creation order. */
function listLines(note, p) {
  const limit = p.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalidParam('limit', 'Limit must be between 1 and 100.');
  if (p.starting_after && p.ending_before) throw parametersExclusive(['starting_after', 'ending_before']);
  const all = note.lines.data;
  const index = (key) => {
    const i = all.findIndex((l) => l.id === p[key]);
    if (i < 0) throw resourceMissing('credit_note_line_item', p[key], { param: key });
    return i;
  };
  const data = p.starting_after ? all.slice(index('starting_after') + 1) : p.ending_before ? all.slice(0, index('ending_before')) : all;
  const page = p.ending_before ? data.slice(-limit) : data.slice(0, limit);
  return new ListResult({ data: page, hasMore: data.length > limit, url: note.lines.url, total: all.length });
}

export function install(app) {
  app.object('credit_note', { render: renderCreditNote, expandable: ['customer', 'invoice', 'refund', 'refunds.refund', 'customer_balance_transaction'],
    links: { customer: 'customer', invoice: 'invoice', refund: { to: 'refund', until: '2025-03-31.basil' }, 'refunds.refund': { to: 'refund', since: '2025-03-31.basil' },
      customer_balance_transaction: 'customer_balance_transaction', lines: { to: 'list<credit_note_line_item>', embedded: true } } });
  app.object('credit_note_line_item', { render: renderCreditLine });
  app.route('POST', '/v1/credit_notes', (c) => createCreditNote(c.account, c.params, { version: c.version }), { returns: 'credit_note' });
  app.route('GET', '/v1/credit_notes/preview', (c) => previewCreditNote(c.account, c.params, { version: c.version }), { returns: 'credit_note' });
  app.route('GET', '/v1/credit_notes/preview/lines', (c) => listLines(previewCreditNote(c.account, c.params, { version: c.version }), c.params), { returns: 'list<credit_note_line_item>' });
  app.route('GET', '/v1/credit_notes/:id', (c) => c.account.store.require('credit_note', c.pathParams.id), { returns: 'credit_note' });
  app.route('POST', '/v1/credit_notes/:id', (c) => updateCreditNote(c.account, c.account.store.require('credit_note', c.pathParams.id), c.params), { returns: 'credit_note' });
  app.route('POST', '/v1/credit_notes/:id/void', (c) => voidCreditNote(c.account, c.account.store.require('credit_note', c.pathParams.id)), { returns: 'credit_note' });
  app.route('GET', '/v1/credit_notes/:id/lines', (c) => listLines(c.account.store.require('credit_note', c.pathParams.id), c.params), { returns: 'list<credit_note_line_item>' });
  app.route('GET', '/v1/credit_notes', (c) => {
    const p = c.params;
    return paginate(c.account.store.list('credit_note', (n) => (p.invoice === undefined || n.invoice === p.invoice) && (p.customer === undefined || n.customer === p.customer) && matchesRange(n.created, p.created)), p,
      { url: '/v1/credit_notes', noun: 'credit_note', find: (id) => c.account.store.get('credit_note', id) });
  }, { returns: 'list<credit_note>' });
  app.page('GET', '/credit_notes/:id/pdf', (p) => {
    const note = p.account.store.get('credit_note', p.pathParams.id);
    return note ? text(`CREDIT NOTE ${note.number}\n${note.memo ?? ''}\n${note.lines.data.map((l) => `${l.description ?? ''}: ${l.amount} ${note.currency}`).join('\n')}\nTotal: ${note.total} ${note.currency}\n`) : notFoundPage('This credit note');
  }, { account: (p, server) => server.accountForId(p.id) });
}
