/**
 * Billing-period arithmetic (docs.stripe.com/billing/subscriptions/billing-cycle), shared by
 * subscriptions and schedules.
 *
 * Periods step from the billing cycle anchor in UTC, keeping the anchor's time of day. Month and
 * year steps clamp to the end of the month *from the anchor's day* (Jan 31 → Feb 28 → Mar 31).
 * `interval` is 'day' | 'week' | 'month' | 'year'; `count` is interval_count.
 */

const DAY = 86400;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The anchor advanced by k × count intervals (k may be negative). */
export function addIntervals(anchor, interval, count, k) {
  const n = count * k;
  if (interval === 'day') return anchor + n * DAY;
  if (interval === 'week') return anchor + n * 7 * DAY;
  const d = new Date(anchor * 1000);
  const months = interval === 'month' ? n : interval === 'year' ? n * 12 : NaN;
  if (Number.isNaN(months)) throw new Error(`Unknown interval: ${interval}`);
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  return Date.UTC(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

/** Approximate length of one step in seconds (only used to seed searches). */
function approxStep(interval, count) {
  const days = { day: 1, week: 7, month: 30.44, year: 365.25 }[interval];
  return days * DAY * count;
}

/** The first period boundary strictly after `t` (a boundary is anchor + k intervals). */
export function nextBoundaryAfter(anchor, interval, count, t) {
  let k = Math.floor((t - anchor) / approxStep(interval, count));
  while (addIntervals(anchor, interval, count, k) <= t) k++;
  while (addIntervals(anchor, interval, count, k - 1) > t) k--;
  return addIntervals(anchor, interval, count, k);
}

/** The period [start, end) that contains `t`, aligned to `anchor`. */
export function periodContaining(anchor, interval, count, t) {
  const end = nextBoundaryAfter(anchor, interval, count, t);
  let k = Math.round((end - anchor) / approxStep(interval, count));
  while (addIntervals(anchor, interval, count, k) < end) k++;
  while (addIntervals(anchor, interval, count, k) > end) k--;
  return { start: addIntervals(anchor, interval, count, k - 1), end };
}

/** Length in seconds of the period of `interval` × `count` starting at `start`. */
export function periodLength(start, interval, count) {
  return addIntervals(start, interval, count, 1) - start;
}

/** Longest allowed interval: 3 years, 36 months, 156 weeks or 1095 days (docs.stripe.com/api/prices/create). */
export function isIntervalWithinLimit(interval, count) {
  const max = { day: 1095, week: 156, month: 36, year: 3 }[interval];
  return Number.isInteger(count) && count >= 1 && count <= max;
}
