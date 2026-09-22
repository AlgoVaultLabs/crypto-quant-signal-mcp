/**
 * off-origin-redirect.ts — hand a browser to ANOTHER origin at the end of a same-origin form POST.
 *
 * CANCEL-PATH-CSP-FORM-ACTION-W1 CH1. The served CSP carries `form-action 'self'` (src/index.ts,
 * SEC-38), and Chrome and Safari apply `form-action` to the WHOLE redirect chain that follows a form
 * submission, not only to the `action=` URL. So `POST /account/portal` → `303 billing.stripe.com`
 * was refused by the browser with no error page and no navigation: the customer clicked "Open
 * Billing Portal" and nothing happened, for eight weeks, while the server answered correctly.
 * Measured in Chromium against the exact live policy: the POST is served, the target origin receives
 * ZERO requests. Firefox does not enforce this (Bugzilla 1417822), which is why it was never universal.
 *
 * The fix is the RESPONSE CLASS, not the policy: answer 200 same-origin HTML that navigates onward.
 * None of the three mechanisms below is a form submission, and no shipping browser implements a CSP
 * directive governing them (`navigate-to` was removed from CSP3 — w3c/webappsec-csp PR #564):
 *   1. `<meta http-equiv="refresh" content="0;url=…">` — works with JavaScript off, and still fires
 *      if inline script is ever blocked (e.g. a nonce added to `script-src`) — measured.
 *   2. inline `location.replace(…)` — allowed while `script-src` keeps `'unsafe-inline'`.
 *   3. a VISIBLE `<a href>` — the one that retires the failure MODE: if 1 and 2 are ever both blocked,
 *      the customer sees a working link instead of nothing.
 * Measured: 1 + 2 together produce exactly ONE request to the target (no double navigation).
 *
 * The target URL is a single-use credential (a Stripe portal session). It is never logged, the
 * response is `no-store`, and it is escaped separately for its two sinks: HTML (attribute + meta)
 * and JavaScript string. A non-https target is REFUSED with a generic 502 — this sits on a live
 * serving path, so it refuses rather than throws.
 *
 * GENERIC by design: nothing here knows about Stripe, billing or /account. Any future hand-off from
 * a form POST to a third-party origin (OAuth, SSO, payment provider) uses this instead of
 * `res.redirect` — a cross-origin 3xx behind a form reproduces this outage exactly.
 */
import type { Response } from 'express';

export interface OffOriginRedirectCopy {
  /** Page heading + <title>. Plain text — escaped here. */
  title: string;
  /** One explanatory sentence. Plain text — escaped here. */
  body: string;
  /** Link label for the visible fallback. Plain text — escaped here. */
  cta: string;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML text AND double-quoted attribute sink. */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * JavaScript string-literal sink inside a <script> element. JSON.stringify yields a valid JS
 * string; `<` and `>` are \u-escaped so `</script>` or `<!--` can never end the element early, and
 * U+2028 / U+2029 are escaped because older engines treat them as line terminators inside strings.
 */
function escapeJsString(s: string): string {
  return JSON.stringify(String(s))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * A target is accepted only when it parses as an absolute `https:` URL and carries no
 * whitespace/control characters and no userinfo. The ORIGINAL string is then rendered (never a
 * re-serialised one), so the credential the browser receives is byte-identical to what the caller
 * was handed. Returns why a target is refused — never the target itself, which may be a
 * credential — or `null` to accept.
 */
function offOriginRefusalReason(targetUrl: unknown): string | null {
  if (typeof targetUrl !== 'string') return 'not-a-string';
  if (targetUrl.length === 0) return 'empty';
  if (targetUrl.length > 4096) return 'too-long';
  if (/[\u0000-\u0020\u007f]/.test(targetUrl)) return 'whitespace-or-control-character';
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return 'not-an-absolute-url';
  }
  if (u.protocol !== 'https:') return `scheme=${u.protocol}`;
  if (u.username || u.password) return 'userinfo-present';
  return null;
}

/** Pure renderer. The `<a href>` carries href FIRST and double-quoted, so a live probe can key on it. */
export function renderOffOriginRedirectHtml(targetUrl: string, copy: OffOriginRedirectCopy): string {
  const attr = escapeHtml(targetUrl);
  const title = escapeHtml(copy.title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${attr}">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0a0e1a; color: #e6e9f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 120px 24px 64px; }
  h1 { font-size: 28px; line-height: 1.2; font-weight: 600; margin: 0 0 14px; }
  p { color: #b3bccb; font-size: 15px; line-height: 1.55; margin: 0 0 28px; }
  a.cta { display: inline-block; background: #3ee6a8; color: #0a0e1a; font-weight: 600; font-size: 15px; text-decoration: none; padding: 12px 20px; border-radius: 8px; }
  .fallback { color: #7b8ca0; font-size: 13px; margin-top: 20px; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${escapeHtml(copy.body)}</p>
  <a href="${attr}" class="cta" rel="noreferrer">${escapeHtml(copy.cta)}</a>
  <p class="fallback">If nothing happens in a few seconds, use the button above.</p>
</main>
<script>location.replace(${escapeJsString(targetUrl)});</script>
</body>
</html>`;
}

const REFUSED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>We couldn't open that page</title>
<style>
  body { margin: 0; background: #0a0e1a; color: #e6e9f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 120px 24px 64px; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 14px; }
  p { color: #b3bccb; font-size: 15px; line-height: 1.55; }
</style>
</head>
<body>
<main>
  <h1>We couldn't open that page</h1>
  <p>Please go back and try again in a moment.</p>
</main>
</body>
</html>`;

/** Per-process refusal count, carried on every CRITICAL line so a refusal is never a silent no-op. */
let refusals = 0;

/**
 * Answer the current request with a 200 same-origin interstitial that navigates to `targetUrl`.
 * Never emits a `Location` header. A target that is not an absolute https URL is refused with a
 * generic 502 and one CRITICAL log line naming only the refusal reason — never the URL itself.
 */
export function sendOffOriginRedirect(res: Response, targetUrl: string, opts: OffOriginRedirectCopy): void {
  const reason = offOriginRefusalReason(targetUrl);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (reason !== null) {
    refusals++;
    console.error(`[off-origin-redirect] CRITICAL refused off-origin hand-off: ${reason} (refusal #${refusals})`);
    res.status(502);
    res.send(REFUSED_HTML);
    return;
  }
  // Overrides the global strict-origin-when-cross-origin for THIS response only (src/index.ts
  // security middleware runs first). Hygiene: the session secret lives in the URL, not the referrer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200);
  res.send(renderOffOriginRedirectHtml(targetUrl, opts));
}
