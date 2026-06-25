/**
 * LANDING-DUAL-RENDER-PARITY-W1 — single source of truth for drift-prone STATIC COPY
 * shared across a landing page's dual-render twins (`lp-<section>-desktop` / `-mobile`).
 *
 * Problem retired: `landing/index.html` renders each section twice (a desktop artboard +
 * a mobile artboard, swapped by an `@media` rule). The copy was hand-maintained in BOTH,
 * so an edit to one viewport silently drifted — live proof on origin/main: the mobile hero
 * eyebrow was stuck on `MCP server · v1.4` while desktop read `… · 5 venues monitored`.
 *
 * Mechanism (mirrors FOOTER-UNIFY-W1's `src/lib/footer-content.ts`):
 *   - Copy lives ONCE here, keyed `"<section>.<field>"` with explicit per-viewport variants.
 *     The deliberate desktop/mobile abbreviation (the eyebrow) lives in ONE entry, so
 *     "drift" means "a rendered node diverges from this SoT", never "desktop text ≠ mobile".
 *   - `scripts/inject-landing-copy.mjs` loads the COMPILED `dist/lib/landing-content.js` via
 *     `createRequire` and rewrites every `data-av-copy="<key>.<variant>"` node's inner
 *     content to match. Idempotent; `--check` is the CI / pre-push drift canary.
 *   - `tests/unit/landing-dual-render-parity.test.mjs` asserts marker parity + value match +
 *     "no bare `· vN.N` in any `lp-*` dual-render twin".
 *
 * SCOPE (architect Q1=A): index `lp-hero` shared STATIC copy only. Values are inner COPY
 * content — plain text, with soft `<br/>` line-breaks permitted as copy formatting — and
 * NEVER structural/styled markup. The hero `<h1>` is intentionally EXCLUDED: its accent
 * `<span>Agents.</span>` (inline-styled) + viewport-divergent `<br/>` structure is markup,
 * not copy (the "whole-section markup" this wave rejects), so it stays hand-maintained per
 * twin. `lp-rest` / `how-it-works` / `verify` twins DEFER to LANDING-DUAL-RENDER-PARITY-W2
 * (one SoT row + one marker pair each — no new code).
 *
 * FIREWALL: a `data-av-copy` marker is NEVER placed on a `data-tr-field` /
 * `data-w7-recent-call` / live-bound node, so live track-record data (PFE WR,
 * exchange_count, call counts) is structurally untouched (Data Integrity + live-data LAW).
 * Verified at authoring time: the hero `90.2%` is `<span data-tr-field="pfe_wr">`-bound
 * (already live, not a hardcoded literal) and is left unmarked.
 */

/** Greppable marker the injector + drift canary key on. */
export const LANDING_COPY_MARKER = 'data-av-copy';

export type CopyVariant = 'desktop' | 'mobile';
export interface CopyEntry {
  readonly desktop: string;
  readonly mobile: string;
}

/**
 * key = `"<section>.<field>"`. Each value is the canonical inner copy content for that
 * viewport. `desktop === mobile` is the common (drift-prevention) case; the eyebrow is the
 * one deliberate abbreviation divergence. Values are byte-exact to the rendered nodes so the
 * first injector run is a no-op everywhere EXCEPT the stale mobile eyebrow it repairs.
 */
export const LANDING_COPY: Readonly<Record<string, CopyEntry>> = {
  'hero.eyebrow': {
    desktop: 'Model Context Protocol server · 5 venues monitored',
    mobile: 'MCP server · 5 venues monitored',
  },
  'hero.subhead': {
    desktop: 'One MCP call returns a composite verdict — direction, confidence, regime.<br/>Built for autonomous AI agents.',
    mobile: 'One MCP call returns a composite verdict — direction, confidence, regime.<br/>Built for autonomous AI agents.',
  },
  'hero.cta_primary': {
    desktop: 'Try Free in Telegram',
    mobile: 'Try Free in Telegram',
  },
  'hero.cta_secondary': {
    desktop: 'View Track Record',
    mobile: 'View Track Record',
  },
  'hero.free_tier_note': {
    desktop: 'No signup required. Free tier: all assets, all 11 timeframes, 100 calls/month.',
    mobile: 'No signup required. Free tier: all assets, all 11 timeframes, 100 calls/month.',
  },
};

/** Resolve copy for a key+variant. Throws on an unknown key so a typo'd marker fails loud. */
export function landingCopy(key: string, variant: CopyVariant): string {
  const entry = LANDING_COPY[key];
  if (!entry) throw new Error(`[landing-content] unknown copy key: ${key}`);
  return entry[variant];
}
