/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 — "is this a real browser NAVIGATION?"
 *
 * `GET /signup?plan=…` is a public URL that mints a LIVE Stripe Checkout Session and writes a
 * `signup_attribution` row on every request. So any crawler, prefetch or script that fetches it
 * mints a billable object and inflates the funnel's top stage — measured over the 28d window to
 * 2026-09-05: **268 rows**, of which `isbot@5.1.44` flags **113 (42.2 %)** (`curl` 37,
 * `aiohttp` 20, Baiduspider 12, bingbot 6, GPTBot 4, SemrushBot 4, DataForSeoBot 3, a copyright
 * prober 5) while Plausible counted **3** human pricing-CTA clicks in the same window. The
 * remaining 150 rows carry browser-shaped UAs and are what the `Sec-Fetch-*` / `Accept`
 * navigation evidence below exists to separate.
 *
 * ── This is NOT a second bot classifier ──────────────────────────────────────────────────────
 * `classifyTraffic()` (`./traffic-classifier.js`) is THE canonical "is this automated?"
 * derivation — `x402-http-routes.ts` states the invariant as "the ONE canonical classifier — no
 * second isbot impl". This module NEVER imports `isbot` and never re-derives a UA verdict; it
 * PROJECTS from `classifyTraffic()` and adds only the evidence that classifier has no input for:
 * the fetch-metadata headers a real navigation carries and a script does not.
 *
 * ── Evaluation order is SEMANTIC (architect ruling Q2, 2026-09-06) ───────────────────────────
 *   1. `Sec-Purpose` / `Purpose` = prefetch|prerender      → bot   ← BEFORE the navigate rule
 *   2. `classifyTraffic({ua}).is_automated`                → bot
 *   3. `Sec-Fetch-Mode` present and ≠ navigate             → bot
 *      `Sec-Fetch-Dest` present and ≠ document             → bot
 *   4. `Accept` present and lacking `text/html`            → bot   (STRICT — see below)
 *   5. `Sec-Fetch-Mode: navigate` ∧ `Sec-Fetch-Dest: document` → browser
 *   6. otherwise                                           → unknown
 *
 * Step 1 MUST precede step 5: a Chrome prerender sends `Sec-Fetch-Mode: navigate` +
 * `Sec-Fetch-Dest: document` and would otherwise read as a human navigation.
 *
 * The `Accept` rule is deliberately STRICT: a real navigation always carries `text/html` (the
 * Fetch spec's navigation Accept is `text/html,application/xhtml+xml,application/xml;q=0.9`
 * followed by a wildcard at q=0.8), whereas a BARE wildcard with no `text/html` is what curl,
 * axios and every scripted fetch send. Relaxing the rule to also accept a bare wildcard was
 * considered and REJECTED: that is exactly what the 150 browser-shaped-UA rows send, so the
 * relaxation would leave the whole population minting Sessions.
 * (The wildcard is spelled out rather than written literally — a literal one closes this
 * comment block; `tsc` reported it as four bare `TS1109 Expression expected` errors.)
 *
 * ── `unknown` is FAIL-OPEN, and that is the point ────────────────────────────────────────────
 * Only a POSITIVE bot signal withholds a Checkout Session. An old or unusual client that sends
 * no fetch-metadata and a browser-ish `Accept` resolves to `unknown` and still gets the 303 — a
 * human is never blocked from paying. `unknown` is counted separately and reported, never hidden.
 *
 * ── Reusability ──────────────────────────────────────────────────────────────────────────────
 * This is the generator for the class "a public URL fetch is trusted into a metric / mints a
 * billable object": the Baidu `tg_bot` channel rows, the phantom-x402 unauthenticated inputs,
 * and any future public CTA route inherit it by calling this one function.
 *
 * PURE — no I/O, no clock, no DB. Same headers in → same verdict out.
 */
import { classifyTraffic } from './traffic-classifier.js';
import { classifyClient } from './client-registry.js';

/** Header bag as Express exposes it (`req.headers`): lowercase keys, possibly array-valued. */
export type IntentHeaders = Record<string, string | string[] | undefined>;

export type BrowserIntentClass = 'browser' | 'bot' | 'unknown';

export interface BrowserIntentVerdict {
  cls: BrowserIntentClass;
  /** Short machine-readable reason. Non-null for `bot` and `unknown`; null for `browser`. */
  reason: string | null;
  /**
   * The client slug from the ONE UA→identity map (`classifyClient().name`) — `unknown` for an
   * absent UA, `other` for an unmatched one. Persisted as `signup_attribution.ua_class`.
   */
  uaClass: string;
}

/** First value of a possibly-array header, trimmed. `''` when absent. */
function h(headers: IntentHeaders, name: string): string {
  const v = headers[name];
  if (Array.isArray(v)) return (v[0] ?? '').trim();
  return (v ?? '').trim();
}

/**
 * Classify the intent behind a navigation-shaped GET on a public CTA route.
 *
 * @param headers `req.headers` (lowercase keys — Node normalizes them).
 * @param deps injectable classifier seam so the ORDERING can be unit-tested without isbot's
 *        full pattern list. Defaults to the canonical `classifyTraffic`.
 */
export function classifyBrowserIntent(
  headers: IntentHeaders,
  deps: { isAutomatedUa?: (ua: string) => boolean } = {},
): BrowserIntentVerdict {
  const ua = h(headers, 'user-agent');
  const uaClass = classifyClient(ua).name;
  const isAutomatedUa =
    deps.isAutomatedUa ?? ((u: string) => classifyTraffic({ ua: u }).is_automated);

  const bot = (reason: string): BrowserIntentVerdict => ({ cls: 'bot', reason, uaClass });

  // 1 — prefetch / prerender. FIRST, because Chrome's prerender also sends
  // `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document` and would pass step 5.
  // `Sec-Purpose: prefetch;prerender` is the modern spelling; `Purpose: prefetch` the legacy one.
  const purpose = `${h(headers, 'sec-purpose')} ${h(headers, 'purpose')}`.toLowerCase();
  if (purpose.includes('prefetch') || purpose.includes('prerender')) return bot('prefetch');

  // 2 — the canonical UA verdict. Projected, never re-derived.
  if (ua && isAutomatedUa(ua)) return bot('ua_automated');

  // 3 — fetch metadata that contradicts a navigation. Absent headers prove nothing (old
  // clients omit them entirely) — only a PRESENT, contradicting value is a positive signal.
  const mode = h(headers, 'sec-fetch-mode').toLowerCase();
  const dest = h(headers, 'sec-fetch-dest').toLowerCase();
  if (mode && mode !== 'navigate') return bot('non_navigate_mode');
  if (dest && dest !== 'document') return bot('non_document_dest');

  // 4 — a real navigation always asks for HTML. STRICT: `*/*` alone is programmatic.
  const accept = h(headers, 'accept').toLowerCase();
  if (accept && !accept.includes('text/html')) return bot('non_html_accept');

  // 5 — positive navigation evidence.
  if (mode === 'navigate' && dest === 'document') return { cls: 'browser', reason: null, uaClass };

  // 6 — no positive bot signal and no positive navigation signal. Fail open.
  return { cls: 'unknown', reason: 'no_fetch_metadata', uaClass };
}
