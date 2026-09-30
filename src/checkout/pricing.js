/**
 * Money helpers shared by Checkout, the customer portal and the hosted pages: the amount of a
 * price for a quantity, labels such as "$20.00 / month", and the yearly cost used to compare plans.
 *
 * Amounts come from the billing engine's own arithmetic (billing/util.js amountFor), so what a page
 * shows is what the invoice charges.
 */
import { describeInterval, formatAmount } from '../core/currency.js';
import { amountFor, roundAmount } from '../billing/util.js';

/** The unit amount of a per-unit price in the minor unit (may be fractional), or null (tiered). */
export function unitAmountOf(price) {
  if (!price) return null;
  if (price.unit_amount_decimal !== null && price.unit_amount_decimal !== undefined) return Number(price.unit_amount_decimal);
  if (price.unit_amount !== null && price.unit_amount !== undefined) return price.unit_amount;
  return null;
}

/**
 * The amount of `quantity` units of `price` for one period (docs.stripe.com/products-prices/pricing-models):
 * per-unit prices multiply (after transform_quantity), tiered prices apply their volume or
 * graduated tiers; metered prices are billed in arrears (0).
 */
export function priceAmount(price, quantity) {
  return price ? amountFor(price, quantity ?? 1) : 0;
}

/** True for a recurring price. */
export function isRecurring(price) {
  return Boolean(price && (price.type === 'recurring' || price.recurring));
}

/** True for a metered (usage-based) recurring price. */
export function isMetered(price) {
  return Boolean(price?.recurring && price.recurring.usage_type === 'metered');
}

/** "$20.00 / month", "$100.00 every 3 months" or "$5.00" (one-time); "Usage-based" for metered prices. */
export function priceLabel(price) {
  if (!price) return '';
  if (isMetered(price)) return `Usage-based, billed ${describeInterval(price.recurring.interval, price.recurring.interval_count ?? 1)}`;
  let amount;
  if (price.billing_scheme === 'tiered') amount = 'Tiered pricing';
  else {
    const unit = unitAmountOf(price);
    amount = unit === null ? '' : formatAmount(roundAmount(unit), price.currency);
  }
  if (!isRecurring(price)) return amount;
  return `${amount} ${describeInterval(price.recurring.interval, price.recurring.interval_count ?? 1)}`;
}

const DAYS_PER_INTERVAL = { day: 1, week: 7, month: 365 / 12, year: 365 };

/** Length of one billing period in days (approximate for months, used only to compare plans). */
export function intervalDaysOf(recurring) {
  if (!recurring) return Infinity;
  return (DAYS_PER_INTERVAL[recurring.interval] ?? 30) * (recurring.interval_count ?? 1);
}

/**
 * The cost of `quantity` units per year, so plans with different intervals compare "in the long
 * term" (docs.stripe.com/api/customer_portal/configurations/object, decreasing_item_amount).
 */
export function yearlyCost(price, quantity) {
  if (!isRecurring(price)) return priceAmount(price, quantity);
  return (priceAmount(price, quantity) * 365) / intervalDaysOf(price.recurring);
}
