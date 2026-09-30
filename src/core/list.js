/**
 * List objects and cursor pagination (docs.stripe.com/api/pagination).
 * Newest first by `created`, ties broken by insertion order (`_seq`), newest first.
 */
import { invalidRequest, parametersExclusive, resourceMissing } from './errors.js';

/**
 * A top-level list response; `data` holds internal objects that are rendered later. `total` is
 * the number of matching objects, sent as total_count only when a 2024-06-20-family request
 * expands it.
 */
export class ListResult {
  constructor({ data, hasMore, url, total }) {
    this.object = 'list';
    this.data = data;
    this.hasMore = hasMore;
    this.url = url;
    this.total = total ?? data.length;
  }
}

/** Sort key comparator: newest first. */
export function newestFirst(a, b) {
  return (b.created ?? 0) - (a.created ?? 0) || (b._seq ?? 0) - (a._seq ?? 0);
}

/**
 * Paginates `items` (already filtered) per `params` (limit, starting_after, ending_before).
 * @param {object[]} items internal objects with id, created and _seq
 * @param {object} params validated list params
 * @param {object} options { url: '/v1/customers', noun: 'customer', find?: (id) => object|null }
 *   `find` resolves a cursor that the filters excluded (defaults to searching `items` only).
 */
export function paginate(items, params = {}, { url, noun = 'object', find } = {}) {
  const limit = params.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalidRequest(`Invalid limit: must be between 1 and 100`, { param: 'limit', validation: true });
  }
  if (params.starting_after && params.ending_before) {
    throw parametersExclusive(['starting_after', 'ending_before'], { param: 'ending_before' });
  }
  const sorted = [...items].sort(newestFirst);
  const cursorOf = (param) => {
    const id = params[param];
    const obj = sorted.find((o) => o.id === id) ?? (find ? find(id) : null);
    if (!obj) throw resourceMissing(noun, id, { param });
    return obj;
  };

  const total = sorted.length;
  if (params.starting_after) {
    const cursor = cursorOf('starting_after');
    const older = sorted.filter((o) => newestFirst(cursor, o) < 0);
    return new ListResult({ data: older.slice(0, limit), hasMore: older.length > limit, url, total });
  }
  if (params.ending_before) {
    const cursor = cursorOf('ending_before');
    const newer = sorted.filter((o) => newestFirst(o, cursor) < 0);
    const page = newer.slice(Math.max(0, newer.length - limit));
    return new ListResult({ data: page, hasMore: newer.length > limit, url, total });
  }
  return new ListResult({ data: sorted.slice(0, limit), hasMore: sorted.length > limit, url, total });
}

/**
 * True when `value` (unix seconds) matches a `created`-style filter: an integer (exact) or
 * { gt, gte, lt, lte }. An absent filter matches everything.
 */
export function matchesRange(value, filter) {
  if (filter === undefined || filter === null || filter === '') return true;
  if (typeof filter === 'number') return value === filter;
  if (filter.gt !== undefined && !(value > filter.gt)) return false;
  if (filter.gte !== undefined && !(value >= filter.gte)) return false;
  if (filter.lt !== undefined && !(value < filter.lt)) return false;
  if (filter.lte !== undefined && !(value <= filter.lte)) return false;
  return true;
}

/**
 * An embedded list as objects carry it (subscription.items, invoice.lines): the first `limit`
 * entries with has_more and total_count.
 */
export function embeddedList(data, url, limit = 10) {
  return { object: 'list', data: data.slice(0, limit), has_more: data.length > limit, total_count: data.length, url };
}
