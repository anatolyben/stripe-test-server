/**
 * stripe-test-server: a local test server for Stripe Billing, driven by the official `stripe`
 * SDK through new Stripe(key, { host, port, protocol: 'http' }).
 *
 *   const server = await createStripeTestServer({ webhooks: [{ url, secret }] });
 *   const stripe = new Stripe('sk_test_123', { host: '127.0.0.1', port: server.port, protocol: 'http' });
 *   const account = server.account('sk_test_123');   // controls for that key
 *   await account.advanceTime({ seconds: 86400 });
 */
import { registry } from './app.js';
import { ServerContext } from './core/server.js';
import { normalizeOptions } from './core/options.js';
import { settleServer } from './webhooks/delivery.js';

export { LATEST_VERSION } from './core/versions.js';
export { DEFAULT_BILLING_SETTINGS, DEFAULT_WEBHOOK_RETRY } from './core/options.js';

/**
 * Builds the AccountControls object for one account: one method per registered control, nested
 * by dotted name ('faults.add' → controls.faults.add(...)).
 */
function accountControls(server, account) {
  const controls = { key: account.key, id: account.id };
  for (const def of server.registry.controls) {
    const parts = def.name.split('.');
    let target = controls;
    for (const p of parts.slice(0, -1)) target = target[p] ??= {};
    target[parts[parts.length - 1]] = (...args) => {
      const input = def.args ? def.args(...args) : args[0] ?? {};
      return server.runControl(account, def, structuredClone(input));
    };
  }
  return controls;
}

/**
 * Starts a server.
 * @param {import('./index.d.ts').StripeTestServerOptions} [options]
 * @returns {Promise<import('./index.d.ts').StripeTestServer>}
 */
export async function createStripeTestServer(options = {}) {
  const server = new ServerContext(normalizeOptions(options), registry());
  await server.listen();
  const controlsCache = new Map();
  return {
    get url() {
      return server.url;
    },
    get port() {
      return server.port;
    },
    /** Controls for the account of `apiKey` (created on first use). */
    account(apiKey) {
      if (typeof apiKey !== 'string' || !/^(sk|rk)_test_\S+$/.test(apiKey)) {
        throw new TypeError('account(apiKey) needs a sk_test_… or rk_test_… key');
      }
      const account = server.account(apiKey);
      if (!controlsCache.has(account)) controlsCache.set(account, accountControls(server, account));
      return controlsCache.get(account);
    },
    /** API keys of the accounts seen so far. */
    accounts() {
      return [...server.accounts.keys()];
    },
    /** Resets every account. */
    async reset() {
      await Promise.all([...server.accounts.values()].map((a) => a.run(() => a.reset())));
    },
    /** Resolves when no webhook delivery is pending on any account. */
    settle() {
      return Promise.resolve().then(() => settleServer(server));
    },
    /** Stops the server: closes connections and drops timers. */
    close() {
      return server.close();
    },
    /** The internal server context (for advanced use and tests). */
    context: server,
  };
}

export default createStripeTestServer;
