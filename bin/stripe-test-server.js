#!/usr/bin/env node
/**
 * stripe-test-server CLI.
 *
 *   stripe-test-server [--port N] [--host H] [--api-version V]
 *                      [--webhook-url U --webhook-secret S]...   (repeatable pairs)
 *                      [--log] [--test-clock-per-customer]
 */
import { createStripeTestServer } from '../src/index.js';

const USAGE = `Usage: stripe-test-server [options]

Options:
  --port <n>             port to listen on (default 4242; 0 picks a free port)
  --host <host>          interface to bind (default 127.0.0.1)
  --api-version <v>      default API version of new accounts (default 2026-08-26.dahlia)
  --webhook-url <url>    webhook endpoint for every account (repeatable)
  --webhook-secret <s>   signing secret (whsec_…) of the preceding --webhook-url
  --log                  print one line per request
  --test-clock-per-customer
                         put each customer created without test_clock on its own
                         test clock, advanced by advance_time
  -h, --help             show this help
`;

function parse(argv) {
  const opts = { port: 4242, webhooks: [] };
  let pendingUrl = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`);
      return v;
    };
    const noValue = () => {
      if (inline !== undefined) throw new Error(`${flag} takes no value`);
    };
    switch (flag) {
      case '-h':
      case '--help':
        noValue();
        return { help: true };
      case '--port': {
        const v = value();
        if (!/^\d+$/.test(v) || Number(v) > 65535) throw new Error(`--port must be an integer between 0 and 65535, got ${v}`);
        opts.port = Number(v);
        break;
      }
      case '--host':
        opts.host = value();
        break;
      case '--api-version':
        opts.apiVersion = value();
        break;
      case '--webhook-url':
        if (pendingUrl) throw new Error(`--webhook-url ${pendingUrl} has no --webhook-secret`);
        pendingUrl = value();
        break;
      case '--webhook-secret':
        if (!pendingUrl) throw new Error('--webhook-secret must follow a --webhook-url');
        opts.webhooks.push({ url: pendingUrl, secret: value() });
        pendingUrl = null;
        break;
      case '--log':
        noValue();
        opts.log = true;
        break;
      case '--test-clock-per-customer':
        noValue();
        opts.testClockPerCustomer = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (pendingUrl) throw new Error(`--webhook-url ${pendingUrl} has no --webhook-secret`);
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  const server = await createStripeTestServer(opts);
  process.stdout.write(`stripe-test-server listening on ${server.url}\n`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
