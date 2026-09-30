/**
 * Helpers for hosted pages (Checkout, customer portal, invoices): plain server-rendered HTML
 * with forms, drivable by a browser or by HTTP POSTs.
 *
 * A page handler returns a page result: { status, headers, body }. Use html(), redirect(), text().
 */

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tagged template that escapes every interpolated value unless it is wrapped in safe(). */
export function h(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    const rendered = Array.isArray(v) ? v.map((x) => (x instanceof SafeHtml ? x.html : escapeHtml(x))).join('') : v instanceof SafeHtml ? v.html : escapeHtml(v);
    out += rendered + strings[i + 1];
  });
  return new SafeHtml(out);
}

export class SafeHtml {
  constructor(html) {
    this.html = html;
  }
  toString() {
    return this.html;
  }
}

/** Marks a string as already-safe HTML. */
export const safe = (html) => new SafeHtml(String(html));

const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f6f8fa; color: #1a1f36; }
  main { max-width: 560px; margin: 40px auto; padding: 24px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 22px; margin-top: 0; }
  h2 { font-size: 17px; margin-top: 24px; }
  label { display: block; margin: 12px 0 4px; font-size: 14px; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px; font-size: 15px; }
  button { margin-top: 16px; padding: 10px 16px; font-size: 15px; cursor: pointer; }
  .error { color: #c0123c; background: #fff0f3; padding: 8px 12px; border-radius: 4px; }
  .muted { color: #697386; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 4px; border-bottom: 1px solid #e3e8ee; font-size: 14px; }
`;

/** A complete HTML document. `body` must be SafeHtml (build it with h``). */
export function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body instanceof SafeHtml ? body.html : escapeHtml(body)}
</main>
</body>
</html>
`;
}

/** A 200 (or `status`) HTML page result. */
export function html(title, body, { status = 200, headers = {} } = {}) {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers }, body: layout(title, body) };
}

/** A redirect page result (303 by default, so a POSTed form lands on a GET). */
export function redirect(location, status = 303) {
  return { status, headers: { Location: location, 'Content-Type': 'text/plain; charset=utf-8' }, body: `Redirecting to ${location}\n` };
}

/** A plain-text page result. */
export function text(body, { status = 200, headers = {} } = {}) {
  return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers }, body };
}

/** A 404 page result. */
export function notFoundPage(what = 'This page') {
  return html('Not found', new SafeHtml(`<h1>Not found</h1><p>${escapeHtml(what)} does not exist or has expired.</p>`), { status: 404 });
}

/** Absolute URL of a path on this server ("http://127.0.0.1:PORT/c/pay/cs_test_…"). */
export function pageUrl(server, path) {
  return `${server.url}${path}`;
}
