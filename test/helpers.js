/**
 * Test helpers shared by every test file.
 *
 *   const t = await startServer();              // closed automatically when the test ends
 *   const stripe = t.stripe();                   // real SDK client for t.key
 *   const other = t.stripe('sk_test_other');     // another account
 *   const acct = t.account();                    // AccountControls for t.key
 *   const hooks = await webhookReceiver();       // collects deliveries with raw bodies
 */
import http from 'node:http';
import Stripe from 'stripe';
import { onTestFinished } from 'vitest';
import { createStripeTestServer } from '../src/index.js';

let keySeq = 0;

/** A fresh secret key, unique within the test run. */
export function testKey(label = 'test') {
  keySeq += 1;
  return `sk_test_${label}${process.pid}x${keySeq}`;
}

/**
 * Starts a server for the current test.
 * @param {object} [options] createStripeTestServer options (port defaults to 0)
 * @returns {Promise<{server, url: string, port: number, key: string,
 *   stripe: (apiKey?: string, opts?: object) => Stripe, account: (apiKey?: string) => object,
 *   request: (method: string, path: string, init?: object) => Promise<{status, headers, text, json}>}>}
 */
export async function startServer(options = {}) {
  const server = await createStripeTestServer({ port: 0, ...options });
  onTestFinished(() => server.close());
  const key = testKey();
  /** A real SDK client. Retries are off unless opts.maxNetworkRetries says otherwise. */
  const stripe = (apiKey = key, opts = {}) =>
    new Stripe(apiKey, { host: '127.0.0.1', port: server.port, protocol: 'http', maxNetworkRetries: 0, telemetry: false, ...opts });
  /**
   * A raw HTTP request for wire-level tests. `init.key` sets Bearer auth (null for none),
   * `init.form` a form body (string), `init.json` a JSON body, `init.headers` extra headers.
   */
  const request = async (method, path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    const auth = init.key === undefined ? key : init.key;
    if (auth) headers.Authorization = `Bearer ${auth}`;
    let body;
    if (init.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = init.form;
    } else if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${server.url}${path}`, { method, headers, body, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  return { server, url: server.url, port: server.port, key, stripe, account: (apiKey = key) => server.account(apiKey), request };
}

/**
 * A local webhook endpoint that records every delivery.
 * @param {{status?: number | ((delivery, index) => number), delayMs?: number}} [options]
 * @returns {Promise<{url: string, deliveries: object[], respondWith(status), waitFor(countOrPredicate, opts?), close()}>}
 *   Each delivery: { method, path, headers, rawBody (string), json, receivedAt (ms) }.
 */
export async function webhookReceiver(options = {}) {
  let respond = options.status ?? 200;
  const deliveries = [];
  const waiters = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(rawBody);
      } catch {
        json = null;
      }
      const delivery = { method: req.method, path: req.url, headers: req.headers, rawBody, json, receivedAt: Date.now() };
      const index = deliveries.push(delivery) - 1;
      const status = typeof respond === 'function' ? respond(delivery, index) : respond;
      const finish = () => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{"received":true}');
        for (const w of waiters) w();
      };
      if (options.delayMs) setTimeout(finish, options.delayMs);
      else finish();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${server.address().port}/webhooks`;
  return {
    url,
    deliveries,
    /** Changes the response status (or a (delivery, index) => status function). */
    respondWith(status) {
      respond = status;
    },
    /** Resolves when `count` deliveries arrived (or `predicate(deliveries)` is true). */
    waitFor(countOrPredicate, { timeoutMs = 5000 } = {}) {
      const done = () => (typeof countOrPredicate === 'function' ? countOrPredicate(deliveries) : deliveries.length >= countOrPredicate);
      if (done()) return Promise.resolve(deliveries);
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!done()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(deliveries);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`webhookReceiver: timed out after ${timeoutMs} ms with ${deliveries.length} deliveries`));
        }, timeoutMs);
        waiters.add(check);
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Awaits a promise expected to reject and returns the error (fails the test if it resolves). */
export async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('Expected the promise to reject');
}
