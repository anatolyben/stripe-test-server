/**
 * Pieces shared by the hosted pages (Checkout, customer portal, hosted invoice): the test-card
 * form fields, reading a posted card, dates and small HTML fragments. Built with the escaping
 * h`` template from core/html.js.
 */
import { h } from '../core/html.js';
import { StripeError } from '../core/errors.js';
import { TEST_CARDS, normalizeCardNumber } from '../payments/test_cards.js';

/** "2026-10-30" (UTC) for a unix timestamp; '' for null. */
export function formatDate(ts) {
  if (ts === null || ts === undefined) return '';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** An error box, or nothing. */
export function errorBox(message) {
  return message ? h`<p class="error" role="alert" id="error">${message}</p>` : h``;
}

/** A notice box, or nothing. */
export function noticeBox(message) {
  return message ? h`<p class="notice" id="notice">${message}</p>` : h``;
}

/**
 * The card posted by a card form: { number, expMonth, expYear, cvc, name } (number normalized,
 * expiry as integers when given). Returns null when no card number was posted.
 */
export function readCardForm(form) {
  const number = normalizeCardNumber(form.card_number);
  if (!number) return null;
  const toInt = (v) => (v === undefined || v === '' || !/^\d+$/.test(String(v).trim()) ? undefined : Number(String(v).trim()));
  const card = { number };
  const expMonth = toInt(form.exp_month);
  let expYear = toInt(form.exp_year);
  if (expYear !== undefined && expYear < 100) expYear += 2000;
  if (expMonth !== undefined) card.expMonth = expMonth;
  if (expYear !== undefined) card.expYear = expYear;
  if (form.cvc !== undefined && form.cvc !== '') card.cvc = String(form.cvc);
  if (form.cardholder_name !== undefined && form.cardholder_name !== '') card.name = String(form.cardholder_name);
  return card;
}

/** The `<datalist>` of Stripe's test cards, for card number inputs. */
function testCardList() {
  return h`<datalist id="test-cards">${TEST_CARDS.map((c) => h`<option value="${c.number}">${c.label ?? c.number}</option>`)}</datalist>`;
}

/**
 * Card inputs: number (with test-card suggestions), expiry, CVC and optionally the cardholder
 * name. Form fields: card_number, exp_month, exp_year, cvc, cardholder_name.
 */
export function cardFields({ withName = true, number = '' } = {}) {
  return h`
<fieldset id="card">
  <legend>Card information</legend>
  <label for="card_number">Card number</label>
  <input id="card_number" name="card_number" list="test-cards" inputmode="numeric" autocomplete="off" placeholder="4242 4242 4242 4242" value="${number}">
  ${testCardList()}
  <div class="row">
    <span><label for="exp_month">Expiry month</label><input id="exp_month" name="exp_month" inputmode="numeric" placeholder="12"></span>
    <span><label for="exp_year">Expiry year</label><input id="exp_year" name="exp_year" inputmode="numeric" placeholder="2034"></span>
    <span><label for="cvc">CVC</label><input id="cvc" name="cvc" inputmode="numeric" placeholder="123"></span>
  </div>
  ${withName ? h`<label for="cardholder_name">Name on card</label><input id="cardholder_name" name="cardholder_name" autocomplete="cc-name">` : h``}
</fieldset>`;
}

/** A short reference of the test cards (number and outcome) shown under card forms. */
export function testCardHelp() {
  if (!TEST_CARDS.length) return h``;
  return h`
<details class="muted" id="test-card-help">
  <summary>Test cards</summary>
  <table>${TEST_CARDS.map((c) => h`<tr><td><code>${c.number}</code></td><td>${c.label ?? ''}</td></tr>`)}</table>
</details>`;
}

/** The message to show for an error thrown while acting on a page. */
export function messageOf(err) {
  if (err instanceof StripeError) return err.message;
  return 'Something went wrong. Please try again.';
}

/** Status for a page that failed with `err`: 402 for card errors, else the error's status (4xx). */
export function statusOf(err) {
  if (err instanceof StripeError) return err.status >= 400 && err.status < 500 ? err.status : 400;
  return 500;
}

/** Extra page styles (rows of inputs, badges, notices). */
export const PAGE_STYLE = h`<style>
  .row { display: flex; gap: 8px; } .row > span { flex: 1; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: #e3e8ee; font-size: 12px; }
  .notice { color: #0a5c36; background: #effaf3; padding: 8px 12px; border-radius: 4px; }
  .amount { font-size: 28px; font-weight: 600; margin: 8px 0; }
  .right { text-align: right; } fieldset { border: 1px solid #e3e8ee; border-radius: 6px; margin-top: 16px; }
  .inline input { width: auto; } .actions a { margin-right: 12px; }
  .saved-card form { display: inline-block; margin-left: 8px; } .saved-card button { margin-top: 4px; padding: 4px 10px; }
  input.qty { width: 5em; }
  code { font-size: 13px; }
</style>`;
