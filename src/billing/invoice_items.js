/** Invoice item API. Subscription-generated items use the same storage and attachment helpers. */
import { emitEvent, updateWithEvent } from '../core/events.js';
import { invalidParam, invalidRequest, parameterMissing, parametersExclusive } from '../core/errors.js';
import { matchesRange, paginate } from '../core/list.js';
import { raw } from '../core/render.js';
import { applyMetadata } from '../core/util.js';
import { requireCustomer } from '../customers/customers.js';
import { attachInvoiceItem, computeTotals, createInvoiceItem, emitUpdated, refreshInvoiceItem } from './invoicing.js';
import { extendedDecimalAmount, nowOf } from './util.js';

function money(p, current = null) {
  const choices = ['amount', 'unit_amount', 'unit_amount_decimal'].filter((k) => p[k] !== undefined);
  if (choices.length > 1) throw parametersExclusive(choices, { param: choices.at(-1) });
  const quantity = p.quantity ?? current?.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw invalidParam('quantity', 'Quantity must be a nonnegative integer.');
  if (p.amount !== undefined) {
    if (!Number.isSafeInteger(p.amount)) throw invalidParam('amount', 'Amount is outside the supported integer range.');
    if (p.quantity !== undefined) throw parametersExclusive(['amount', 'quantity'], { param: 'quantity' });
    return { amount: p.amount, quantity: 1, unit: String(p.amount) };
  }
  const unit = p.unit_amount_decimal ?? (p.unit_amount !== undefined ? String(p.unit_amount) : current?.pricing?.unit_amount_decimal);
  if (unit === undefined || unit === null) throw parameterMissing('amount');
  const amount = extendedDecimalAmount(unit, quantity);
  if (!Number.isSafeInteger(amount)) throw invalidParam('unit_amount_decimal', 'Amount is outside the supported integer range.');
  return { amount, quantity, unit: String(unit).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') };
}

function checkSupported(p) {
  const allowed = new Set(['customer', 'currency', 'amount', 'unit_amount', 'unit_amount_decimal', 'quantity', 'description', 'metadata', 'invoice', 'subscription', 'period', 'discountable', 'expand']);
  for (const key of Object.keys(p)) if (!allowed.has(key)) throw invalidRequest(`Invoice item parameter ${key} is not modelled.`, { param: key });
}

/** Validate every reference before inserting an item or changing a draft. */
export function createItem(account, p, { request } = {}) {
  checkSupported(p);
  if (!p.customer) throw parameterMissing('customer');
  const customer = requireCustomer(account, p.customer);
  const sub = p.subscription ? account.store.require('subscription', p.subscription, { param: 'subscription' }) : null;
  if (sub && sub.customer !== customer.id) throw invalidRequest('Subscription belongs to another customer.', { param: 'subscription' });
  const invoice = p.invoice ? account.store.require('invoice', p.invoice, { param: 'invoice' }) : null;
  if (invoice && (invoice.status !== 'draft' || invoice.customer !== customer.id)) throw invalidRequest('Invoice must be a draft for this customer.', { param: 'invoice' });
  if (!p.currency) throw parameterMissing('currency');
  if ((invoice && invoice.currency !== p.currency) || (sub && sub.currency !== p.currency) || (customer.currency && customer.currency !== p.currency)) {
    throw invalidRequest('The currency must match the customer, subscription and invoice.', { param: 'currency' });
  }
  const amounts = money(p);
  const now = nowOf(account, customer);
  const period = p.period ?? { start: now, end: now };
  if (period.end < period.start) throw invalidParam('period[end]', 'Period end must not precede start.');
  if (invoice && invoice.lines.data.length >= 250) throw invalidRequest('An invoice can contain at most 250 items.', { param: 'invoice' });
  const item = createInvoiceItem(account, {
    customer, subscription: sub, currency: p.currency, amount: amounts.amount,
    quantity: amounts.quantity, unitAmountDecimal: amounts.unit,
    description: p.description ?? null, metadata: applyMetadata({}, p.metadata),
    start: period.start, end: period.end, proration: false,
  });
  item.discountable = p.discountable ?? (item.amount >= 0);
  if (invoice) {
    const previous = structuredClone(invoice);
    attachInvoiceItem(account, invoice, item);
    computeTotals(account, invoice);
    emitEvent(account, 'invoiceitem.created', item, { request });
    emitUpdated(account, invoice, 'invoice.updated', previous, { request });
  } else emitEvent(account, 'invoiceitem.created', item, { request });
  return item;
}

export function updateItem(account, item, p, { request } = {}) {
  checkSupported(p);
  for (const key of ['customer', 'subscription', 'invoice']) if (p[key] !== undefined) throw invalidRequest(`${key} cannot be changed.`, { param: key });
  const invoice = item.invoice ? account.store.require('invoice', item.invoice) : null;
  if (invoice && invoice.status !== 'draft') throw invalidRequest('The invoice item belongs to a finalized invoice.');
  if (p.currency !== undefined && p.currency !== item.currency) throw invalidRequest('Currency cannot be changed.', { param: 'currency' });
  const next = structuredClone(item);
  if (['amount', 'unit_amount', 'unit_amount_decimal', 'quantity'].some((k) => p[k] !== undefined)) {
    const amounts = money(p, item);
    Object.assign(next, { amount: amounts.amount, quantity: amounts.quantity, quantity_decimal: String(amounts.quantity) });
    next.pricing.unit_amount_decimal = amounts.unit;
  }
  if (p.period) {
    if (p.period.end < p.period.start) throw invalidParam('period[end]', 'Period end must not precede start.');
    next.period = { ...p.period };
  }
  if (p.description !== undefined) next.description = p.description || null;
  if (p.discountable === true && item.proration) throw invalidParam('discountable', 'Proration items cannot be discountable.');
  if (p.discountable !== undefined) next.discountable = p.discountable;
  if (p.metadata !== undefined) next.metadata = applyMetadata(item.metadata, p.metadata);
  const previous = invoice ? structuredClone(invoice) : null;
  updateWithEvent(account, item, 'invoiceitem.updated', () => Object.assign(item, next), { request });
  if (invoice) {
    refreshInvoiceItem(account, invoice, item);
    emitUpdated(account, invoice, 'invoice.updated', previous, { request });
  }
  return item;
}

export function deleteItem(account, item, { request } = {}) {
  // This package exposes deletion of pending items only (see README's supported subset).
  if (item.invoice) throw invalidRequest('Only pending invoice items can be deleted.');
  emitEvent(account, 'invoiceitem.deleted', item, { request });
  item._deleted = true;
  return raw({ id: item.id, object: 'invoiceitem', deleted: true });
}

export function install(app) {
  app.route('POST', '/v1/invoiceitems', (c) => createItem(c.account, c.params), { returns: 'invoiceitem' });
  app.route('GET', '/v1/invoiceitems/:id', (c) => c.account.store.require('invoiceitem', c.pathParams.id), { returns: 'invoiceitem' });
  app.route('POST', '/v1/invoiceitems/:id', (c) => updateItem(c.account, c.account.store.require('invoiceitem', c.pathParams.id), c.params), { returns: 'invoiceitem' });
  app.route('DELETE', '/v1/invoiceitems/:id', (c) => deleteItem(c.account, c.account.store.require('invoiceitem', c.pathParams.id)), { returns: 'deleted_invoiceitem' });
  app.route('GET', '/v1/invoiceitems', (c) => {
    const p = c.params;
    const items = c.account.store.list('invoiceitem', (i) => !i._deleted &&
      (p.customer === undefined || i.customer === p.customer) &&
      (p.invoice === undefined || i.invoice === p.invoice) &&
      (p.pending === undefined || (i.invoice === null) === p.pending) && matchesRange(i.date, p.created));
    const dated = (item) => item ? { ...item, created: item.date } : null;
    return paginate(items.map(dated), p, { url: '/v1/invoiceitems', noun: 'invoiceitem', find: (id) => dated(c.account.store.get('invoiceitem', id)) });
  }, { returns: 'list<invoiceitem>' });
}
