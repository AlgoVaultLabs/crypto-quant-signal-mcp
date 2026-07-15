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
