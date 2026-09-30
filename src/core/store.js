/**
 * The per-account object store: one collection per Stripe object type ('customer', 'price',
 * 'checkout.session', ...) plus an index of every ID, so any ID can be resolved (expand, hosted
 * pages, cross-references). Objects are plain, structured-clone-able data (see ARCHITECTURE.md).
 */
import { resourceMissing } from './errors.js';

export class Store {
  constructor() {
    this.collections = new Map();
    this.ids = new Map();
    this.seq = 0;
  }

  /** Adds an object. It must have `id` and `object`; `_seq` records insertion order. */
  insert(obj) {
    if (!obj || !obj.id || !obj.object) throw new Error('store.insert needs an object with id and object');
    if (this.ids.has(obj.id)) throw new Error(`duplicate id ${obj.id}`);
    obj._seq = ++this.seq;
    this.collection(obj.object).set(obj.id, obj);
    this.ids.set(obj.id, obj);
    return obj;
  }

  collection(type) {
    let c = this.collections.get(type);
    if (!c) {
      c = new Map();
      this.collections.set(type, c);
    }
    return c;
  }

  /** The object of `type` with `id`, or null (soft-deleted objects included). */
  get(type, id) {
    return (typeof id === 'string' && this.collections.get(type)?.get(id)) || null;
  }

  /** Any object by ID, or null. */
  find(id) {
    return (typeof id === 'string' && this.ids.get(id)) || null;
  }

  /**
   * The live object of `type` with `id`, or a resource_missing error: 404 when `param` is 'id'
   * (a path ID), else 400 with that param. Soft-deleted objects count as missing.
   */
  require(type, id, { param = 'id', noun = type } = {}) {
    const obj = this.get(type, id);
    if (!obj || obj._deleted) throw resourceMissing(noun, id, { param });
    return obj;
  }

  /** All objects of `type` in insertion order, optionally filtered. */
  list(type, filter) {
    const all = [...(this.collections.get(type)?.values() ?? [])];
    return filter ? all.filter(filter) : all;
  }

  /** Removes an object for good (deleted products, test clocks, ...). */
  remove(type, id) {
    const obj = this.get(type, id);
    if (!obj) return false;
    this.collections.get(type).delete(id);
    this.ids.delete(id);
    return true;
  }

  types() {
    return [...this.collections.keys()];
  }

  clear() {
    this.collections.clear();
    this.ids.clear();
    this.seq = 0;
  }
}
