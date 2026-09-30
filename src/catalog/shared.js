/**
 * Small helpers shared by products and prices.
 */

/**
 * A param name nested under a prefix, in Stripe's bracket form:
 * nestParam('default_price_data', 'recurring[interval]') → 'default_price_data[recurring][interval]'.
 */
export function nestParam(prefix, param) {
  if (!prefix) return param;
  const i = param.indexOf('[');
  return i === -1 ? `${prefix}[${param}]` : `${prefix}[${param.slice(0, i)}]${param.slice(i)}`;
}

/**
 * A decimal string (already format-checked by the validator) in canonical form, or null when it
 * is negative: leading zeros and trailing fractional zeros dropped ("0100.50" → "100.5").
 */
export function canonicalDecimal(value) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!m) return null;
  const whole = m[2].replace(/^0+(?=\d)/, '');
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  if (m[1] === '-' && (whole !== '0' || fraction)) return null;
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The integer value of a canonical decimal string, or null when it has a fractional part. */
export function decimalToInteger(decimal) {
  if (decimal === null || decimal.includes('.')) return null;
  const n = Number(decimal);
  return Number.isSafeInteger(n) ? n : null;
}
