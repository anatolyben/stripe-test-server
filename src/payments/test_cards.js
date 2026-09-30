/**
 * Stripe's test cards and PaymentMethod aliases (docs.stripe.com/testing), the only cards this
 * server accepts. Hosted pages take the card number; API calls take the `pm_card_*` alias, and
 * every attach of an alias mints a new PaymentMethod.
 *
 * Entry shape (the contract other modules rely on, e.g. the Checkout and portal card selectors):
 * {
 *   number: '4242424242424242',        // what a hosted page accepts
 *   alias: 'pm_card_visa' | null,       // the documented PaymentMethod alias
 *   aliases: ['pm_card_visa', ...],     // every alias that resolves to this card
 *   label: 'Visa 4242 — succeeds',      // human text for selectors
 *   brand: 'visa', last4: '4242', funding: 'credit', country: 'US' | null,
 *   attachable: true,                   // false: "You can't attach cards that simulate issuer declines"
 *   charge: 'succeeds' | 'declines' | 'requires_action',   // outcome of an off-session charge
 *   code: 'card_declined' | 'expired_card' | ... | null,  // error code of a decline
 *   declineCode: 'generic_decline' | null,                // decline code of a card_declined decline
 *   authentication: 'none' | 'always' | 'unless_set_up' | 'on_session',
 *   threeDSecureSupported: boolean,
 * }
 *
 * `authentication` (docs.stripe.com/testing#authentication-and-setup):
 *   always         every payment needs 3D Secure: off-session charges stop at requires_action
 *   unless_set_up  off-session charges need 3D Secure until the card was set up on a hosted page
 *   on_session     only on-session payments authenticate; off-session charges proceed
 * Hosted pages are on-session: the customer is present and completes any authentication there.
 */

/** Stripe's documented messages, else the first sentence of the error code's description (docs.stripe.com/error-codes). */
export const CARD_ERROR_MESSAGES = Object.freeze({
  card_declined: 'Your card was declined.',
  incorrect_cvc: "Your card's security code is incorrect.",
  expired_card: 'The card has expired.',
  processing_error: 'An error occurred while processing the card.',
  incorrect_number: 'The card number is incorrect.',
  invalid_number: 'The card number is invalid.',
  invalid_expiry_month: "The card's expiration month is incorrect.",
  invalid_expiry_year: "The card's expiration year is incorrect.",
  invalid_cvc: "The card's security code is invalid.",
  authentication_required: 'The payment requires authentication to proceed.',
});

/** The `param` Stripe names for card errors about one card field (docs.stripe.com/declines). */
export const CARD_ERROR_PARAMS = Object.freeze({
  incorrect_cvc: 'cvc',
  invalid_cvc: 'cvc',
  incorrect_number: 'number',
  invalid_number: 'number',
  invalid_expiry_month: 'exp_month',
  invalid_expiry_year: 'exp_year',
});

/** Card decline codes (docs.stripe.com/declines/codes), accepted by the failNextCharge control. */
export const DECLINE_CODES = Object.freeze([
  'authentication_required', 'approve_with_id', 'call_issuer', 'card_not_supported', 'card_velocity_exceeded',
  'currency_not_supported', 'do_not_honor', 'duplicate_transaction', 'expired_card', 'fraudulent', 'generic_decline',
  'incorrect_address', 'incorrect_cvc', 'incorrect_number', 'incorrect_pin', 'incorrect_zip', 'insufficient_funds',
  'invalid_account', 'invalid_amount', 'invalid_cvc', 'invalid_expiry_month', 'invalid_expiry_year', 'invalid_number',
  'invalid_pin', 'issuer_not_available', 'lost_card', 'merchant_blacklist', 'new_account_information_available',
  'no_action_taken', 'not_permitted', 'offline_pin_required', 'online_or_offline_pin_required', 'pickup_card',
  'pin_try_exceeded', 'processing_error', 'reenter_transaction', 'restricted_card', 'revocation_of_all_authorizations',
  'revocation_of_authorization', 'security_violation', 'service_not_allowed', 'stolen_card', 'stop_payment_order',
  'testmode_decline', 'transaction_not_allowed', 'withdrawal_count_limit_exceeded',
]);

/** One catalogue entry with defaults filled in. */
function card(number, aliases, label, fields) {
  const list = aliases ? [].concat(aliases) : [];
  return Object.freeze({
    number,
    alias: list[0] ?? null,
    aliases: Object.freeze(list),
    label,
    brand: 'visa',
    last4: number.slice(-4),
    funding: 'credit',
    country: 'US',
    attachable: true,
    charge: 'succeeds',
    code: null,
    declineCode: null,
    authentication: 'none',
    threeDSecureSupported: true,
    ...fields,
  });
}

/** An issuer decline: the card cannot be attached and every charge fails the same way. */
const issuerDecline = (code, declineCode = null) => ({ attachable: false, charge: 'declines', code, declineCode });

/**
 * The catalogue. Country and funding follow the docs where they state them; otherwise US and
 * credit, and the issuing country encoded in the number for the 4000 00XX X… authentication
 * cards (the docs' country cards use the ISO numeric code: 250 France, 276 Germany, ...).
 */
export const TEST_CARDS = Object.freeze([
  // Successful payments by brand (docs.stripe.com/testing#cards).
  card('4242424242424242', ['pm_card_visa', 'pm_card_us'], 'Visa 4242 — succeeds', {}),
  card('4000056655665556', 'pm_card_visa_debit', 'Visa debit 5556 — succeeds', { funding: 'debit' }),
  card('5555555555554444', 'pm_card_mastercard', 'Mastercard 4444 — succeeds', { brand: 'mastercard' }),
  card('2223003122003222', null, 'Mastercard 2-series 3222 — succeeds', { brand: 'mastercard' }),
  card('5200828282828210', 'pm_card_mastercard_debit', 'Mastercard debit 8210 — succeeds', { brand: 'mastercard', funding: 'debit' }),
  card('5105105105105100', 'pm_card_mastercard_prepaid', 'Mastercard prepaid 5100 — succeeds', { brand: 'mastercard', funding: 'prepaid' }),
  card('378282246310005', ['pm_card_amex', 'pm_card_amex_threeDSecureNotSupported'], 'American Express 0005 — succeeds', {
    brand: 'amex',
    threeDSecureSupported: false,
  }),
  card('371449635398431', null, 'American Express 8431 — succeeds', { brand: 'amex' }),
  card('6011111111111117', 'pm_card_discover', 'Discover 1117 — succeeds', { brand: 'discover' }),
  card('6011000990139424', null, 'Discover 9424 — succeeds', { brand: 'discover' }),
  card('6011981111111113', null, 'Discover debit 1113 — succeeds', { brand: 'discover', funding: 'debit' }),
  card('3056930009020004', 'pm_card_diners', 'Diners Club 0004 — succeeds', { brand: 'diners' }),
  card('36227206271667', null, 'Diners Club 14-digit 1667 — succeeds', { brand: 'diners' }),
  card('3566002020360505', 'pm_card_jcb', 'JCB 0505 — succeeds', { brand: 'jcb', country: 'JP' }),
  card('6200000000000005', 'pm_card_unionpay', 'UnionPay 0005 — succeeds', { brand: 'unionpay', country: null }),
  card('6200000000000047', null, 'UnionPay debit 0047 — succeeds', { brand: 'unionpay', funding: 'debit', country: null }),
  card('6205500000000000004', null, 'UnionPay 19-digit 0004 — succeeds', { brand: 'unionpay', country: null }),

  // Issuer declines (docs.stripe.com/testing#declined-payments): cannot be attached to a customer.
  card('4000000000000002', 'pm_card_visa_chargeDeclined', 'Visa 0002 — declined (generic_decline)', issuerDecline('card_declined', 'generic_decline')),
  card('4000000000009995', 'pm_card_visa_chargeDeclinedInsufficientFunds', 'Visa 9995 — declined (insufficient_funds)', issuerDecline('card_declined', 'insufficient_funds')),
  card('4000000000009987', 'pm_card_visa_chargeDeclinedLostCard', 'Visa 9987 — declined (lost_card)', issuerDecline('card_declined', 'lost_card')),
  card('4000000000009979', 'pm_card_visa_chargeDeclinedStolenCard', 'Visa 9979 — declined (stolen_card)', issuerDecline('card_declined', 'stolen_card')),
  card('4000000000000069', 'pm_card_chargeDeclinedExpiredCard', 'Visa 0069 — declined (expired_card)', issuerDecline('expired_card')),
  card('4000000000000127', 'pm_card_chargeDeclinedIncorrectCvc', 'Visa 0127 — declined (incorrect_cvc)', issuerDecline('incorrect_cvc')),
  card('4000000000000119', 'pm_card_chargeDeclinedProcessingError', 'Visa 0119 — declined (processing_error)', issuerDecline('processing_error')),
  card('4000000000006975', 'pm_card_visa_chargeDeclinedVelocityLimitExceeded', 'Visa 6975 — declined (card_velocity_exceeded)', issuerDecline('card_declined', 'card_velocity_exceeded')),

  // Decline after attaching: attaching succeeds, charging the customer fails.
  card('4000000000000341', 'pm_card_chargeCustomerFail', 'Visa 0341 — attaches, then charges fail', {
    charge: 'declines',
    code: 'card_declined',
    declineCode: 'generic_decline',
  }),

  // Authentication and setup (docs.stripe.com/testing#authentication-and-setup).
  card('4000002500003155', 'pm_card_authenticationRequiredOnSetup', 'Visa 3155 — 3D Secure unless set up', {
    country: 'FR',
    charge: 'requires_action',
    authentication: 'unless_set_up',
  }),
  card('4000002760003184', 'pm_card_authenticationRequired', 'Visa 3184 — always 3D Secure', {
    country: 'DE',
    charge: 'requires_action',
    authentication: 'always',
  }),
  card('4000003800000446', 'pm_card_authenticationRequiredSetupForOffSession', 'Visa 0446 — set up for off-session use', {
    country: 'IT',
    authentication: 'on_session',
  }),
  card('4000008260003178', 'pm_card_authenticationRequiredChargeDeclinedInsufficientFunds', 'Visa 3178 — 3D Secure, then declined (insufficient_funds)', {
    country: 'GB',
    charge: 'declines',
    code: 'card_declined',
    declineCode: 'insufficient_funds',
    authentication: 'on_session',
  }),
]);

const BY_NUMBER = new Map(TEST_CARDS.map((c) => [c.number, c]));
const BY_ALIAS = new Map(TEST_CARDS.flatMap((c) => c.aliases.map((a) => [a, c])));

/** Digits of a typed card number ("4242 4242-4242 4242" → "4242424242424242"). */
export function normalizeCardNumber(value) {
  return String(value ?? '').replace(/[\s-]/g, '');
}

/** The entry for a PaymentMethod alias, or null. */
export function findTestCardAlias(alias) {
  return (typeof alias === 'string' && BY_ALIAS.get(alias)) || null;
}

/** The entry for a card number (spaces and dashes ignored) or alias, or null. */
export function findTestCard(numberOrAlias) {
  if (typeof numberOrAlias !== 'string') return null;
  return BY_ALIAS.get(numberOrAlias) ?? BY_NUMBER.get(normalizeCardNumber(numberOrAlias)) ?? null;
}

/**
 * What charging this card does: { outcome: 'succeeds' | 'declines' | 'requires_action', code,
 * declineCode }. `offSession` is true for automatic charges (renewals, retries); `setUp` is true
 * for cards saved on a hosted page.
 */
export function cardChargeOutcome(entry, { offSession = true, setUp = false } = {}) {
  if (entry.charge === 'declines') return { outcome: 'declines', code: entry.code, declineCode: entry.declineCode };
  if (offSession && (entry.authentication === 'always' || (entry.authentication === 'unless_set_up' && !setUp))) {
    return { outcome: 'requires_action', code: 'authentication_required', declineCode: 'authentication_required' };
  }
  return { outcome: 'succeeds', code: null, declineCode: null };
}
