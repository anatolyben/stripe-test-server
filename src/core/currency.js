/**
 * Currencies (docs.stripe.com/currencies): supported codes, zero-decimal currencies, minimum charge
 * amounts and display formatting for hosted pages and line-item descriptions.
 */

/** Zero-decimal currencies. */
export const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

/** Zero-decimal currencies that the API still takes with two decimals. */
export const TWO_DECIMAL_REPRESENTATION = new Set(['isk', 'ugx']);

/** Presentment currencies across account countries. */
export const SUPPORTED_CURRENCIES = new Set(
  (
    'aed afn all amd ang aoa ars aud awg azn bam bbd bdt bhd bif bmd bnd bob brl bsd bwp byn bzd cad cdf chf clp cny cop crc ' +
    'cve czk djf dkk dop dzd egp etb eur fjd fkp gbp gel gip gmd gnf gtq gyd hkd hnl htg huf idr ils inr isk jmd jod jpy kes ' +
    'kgs khr kmf krw kwd kyd kzt lak lbp lkr lrd lsl mad mdl mga mkd mmk mnt mop mur mvr mwk mxn myr mzn nad ngn nio nok npr ' +
    'nzd omr pab pen pgk php pkr pln pyg qar ron rsd rub rwf sar sbd scr sek sgd shp sle sos srd std szl thb tjs tnd top try ' +
    'ttd twd tzs uah ugx usd uyu uzs vnd vuv wst xaf xcd xcg xof xpf yer zar zmw'
  ).split(' '),
);

/** Minimum charge amounts in minor units (docs.stripe.com/currencies#minimum-and-maximum-charge-amounts). */
export const MINIMUM_CHARGE = {
  usd: 50, eur: 50, gbp: 30, aud: 50, cad: 50, chf: 50, jpy: 50, krw: 50, mxn: 1000, inr: 50, brl: 50, sgd: 50,
  hkd: 400, nok: 300, sek: 300, dkk: 250, pln: 200, czk: 1500, huf: 17500, aed: 200, myr: 200, ron: 200, thb: 1000,
  nzd: 50, zar: 50, ars: 50, cop: 50, idr: 50, ils: 50, php: 50, rub: 50,
};

const SYMBOLS = { usd: '$', eur: '€', gbp: '£', jpy: '¥', aud: 'A$', cad: 'CA$', chf: 'CHF ', inr: '₹', krw: '₩', brl: 'R$', mxn: 'MX$', nzd: 'NZ$', sgd: 'SGD ', hkd: 'HK$' };

export function isSupportedCurrency(code) {
  return SUPPORTED_CURRENCIES.has(String(code).toLowerCase());
}

export function isZeroDecimal(currency) {
  return ZERO_DECIMAL.has(String(currency).toLowerCase());
}

/** Minimum chargeable amount in minor units (defaults to 50 when the currency is not listed). */
export function minimumCharge(currency) {
  return MINIMUM_CHARGE[String(currency).toLowerCase()] ?? 50;
}

/** "$10.00", "¥500", "€9.50"; negative amounts get a leading minus. */
export function formatAmount(amount, currency) {
  const cur = String(currency).toLowerCase();
  const zero = ZERO_DECIMAL.has(cur) && !TWO_DECIMAL_REPRESENTATION.has(cur);
  const abs = Math.abs(amount);
  const major = zero ? String(abs) : (abs / 100).toFixed(2);
  const symbol = SYMBOLS[cur] ?? `${cur.toUpperCase()} `;
  return `${amount < 0 ? '-' : ''}${symbol}${major}`;
}

/**
 * The recurring suffix used in line descriptions: "month", "3 months", "year" (as in
 * "1 × Pro (at $10.00 / month)" and "(at $100.00 every 3 months)").
 */
export function describeInterval(interval, count = 1) {
  return count === 1 ? `/ ${interval}` : `every ${count} ${interval}s`;
}
