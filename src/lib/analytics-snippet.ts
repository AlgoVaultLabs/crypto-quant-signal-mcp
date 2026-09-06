/**
 * OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 CH1 — the ONE analytics-snippet SoT.
 *
 * The Plausible (self-hosted CE, first-party proxy) tracking tag was hand-
 * duplicated across ~26 landing surfaces + missing from 4 hub pages. This module
 * is the single source: `scripts/build_analytics.mjs` injects
 * `renderAnalyticsSnippet()` into a `<!-- ANALYTICS:START/END -->` region in the
 * `<head>` of every landing surface (mirrors `build_nav.mjs`). A future tag change
 * = edit THIS file; the injector + `--check` canary keep every page in sync.
 *
 * Seeded byte-exact from the LIVE first-party tag on origin/main (proxy-wave form,
 * OPS-PLAUSIBLE-FIRSTPARTY-PROXY-W1) — NOT from a spec snippet. There is NO
 * `data-domain` attribute (the site domain is baked into the served
 * `pa-<hash>.js`); the endpoint is set via `plausible.init({endpoint})`.
 *
 * Contract frozen by `tests/analytics-snippet.test.ts` (byte-exact + the live
 * page anchor). Pure — no DOM, no file I/O, no `import.meta.url`.
 */

/** First-party script path (Caddy rewrites `/js/insights.js` → CE `pa-<hash>.js`). */
export const ANALYTICS_SCRIPT_SRC = '/js/insights.js';

/** First-party event endpoint (Caddy rewrites `/pa/event` → CE `/api/event`). */
export const ANALYTICS_EVENT_ENDPOINT = '/pa/event';

/**
 * The canonical analytics tag block, byte-identical to what is live today.
 * Every landing surface's `<!-- ANALYTICS -->` region projects from this ONE
 * value (single-derivation). Deterministic — no per-call variance.
 */
export function renderAnalyticsSnippet(): string {
  return [
    '<!-- Privacy-friendly analytics by Plausible -->',
    `<script async src="${ANALYTICS_SCRIPT_SRC}"></script>`,
    '<script>',
    '  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};',
    `  plausible.init({endpoint:"${ANALYTICS_EVENT_ENDPOINT}"})`,
    '</script>',
  ].join('\n');
}

/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH2 — the region markers, and the whole marked region.
 *
 * WHY THE MARKERS ARE ALSO DECLARED HERE. `scripts/build_analytics.mjs` owns them for the ~54
 * STATIC landing pages it injects into. This wave adds seven FUNCTION-RENDERED surfaces —
 * `/track-record`, `/referral`, `/referral-terms`, `/join` on the apex and `/welcome`,
 * `/account`, bare `/signup` on the api origin — which no injector can touch: they are built in
 * TypeScript at request time. They must carry the SAME markers, because
 * `ops/monitoring/served-region-check.mjs` finds the region by those exact strings, and a page
 * whose region it cannot find is a page whose traffic nothing verifies.
 *
 * A `.mjs` build script and the compiled TS runtime cannot share one static constant without
 * making `build_analytics.mjs` `require()` `dist/` at module load — which would break its own
 * `--check` on a cold checkout, and that file's header explicitly asks not to be restructured. So
 * this is the SANCTIONED two-constants-one-fact exception, and it is paired with a reciprocal
 * gate: `tests/unit/analytics-snippet-parity.test.ts` asserts these strings are byte-identical to
 * `build_analytics.mjs`'s. Without that test this would just be a duplicated fact going stale.
 *
 * The endpoint stays RELATIVE on every surface, including the api-origin ones. There is no
 * absolute variant, deliberately — a second form of a frozen SoT is a second thing to keep true.
 * What makes the relative form correct on `api.algovault.com` is that the ORIGIN now serves it:
 * the `api.` vhost gained the same two Caddy handle blocks the apex has. Measured before that
 * change, `api.algovault.com/js/insights.js` → 404 and `POST /pa/event` → 404, so injecting the
 * snippet alone would have shipped a DEAD tag that a `grep -c insights.js` check still passes.
 */
export const ANALYTICS_START = '<!-- ANALYTICS:START -->';
export const ANALYTICS_END = '<!-- ANALYTICS:END -->';

/**
 * The complete marked region, byte-identical to what `build_analytics.mjs`'s `applyRegion()`
 * writes into a static page: `START + "\n" + snippet + "\n" + END`. Function-rendered pages
 * interpolate THIS into their `<head>`, so the served bytes match a static page's exactly and one
 * served-region checker can verify both families with one comparison.
 */
export function renderAnalyticsRegion(): string {
  return `${ANALYTICS_START}\n${renderAnalyticsSnippet()}\n${ANALYTICS_END}`;
}
