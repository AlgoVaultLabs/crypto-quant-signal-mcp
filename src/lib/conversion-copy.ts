import { landingCopy } from './landing-content.js';

/**
 * CONVERSION-SURFACES-W2 — the ONE module for every string this wave puts in front of a visitor.
 *
 * The wave's §Copy block is the complete visitor-facing delta and dispatch was its sign-off, so
 * every new string is rendered from a constant here and never typed at a call site. Copy that
 * ALREADY exists keeps its existing SoT and is re-exported rather than re-typed — see
 * `bandSubLine()` below, which projects `landingCopy('hero.free_tier_note', 'desktop')` so the
 * band's sub-line cannot drift from the hero line it is copy-locked to.
 *
 * `audits/CONVERSION-SURFACES-W2-copy-locked-source.txt` carries these strings verbatim and
 * `tests/unit/conversion-copy-locked.test.ts` asserts this module against it, so a paraphrase,
 * a synonym swap or punctuation drift fails the build rather than shipping.
 */

// ── C1 · the conversion band ────────────────────────────────────────────
//
// The band is the door on every content page that ends with nothing to do — 63% of visitors
// enter on one. T1 (agent builders) get "Connect your agent", T2 (humans) get Telegram, and
// the pricing link points where the nav's Pricing link points.

export const BAND_EYEBROW = '\u00b7 next step';
export const BAND_HEADING = 'Get the next verdict in your agent.';

export const BAND_CTA_PRIMARY_LABEL = 'Connect your agent \u2192';
export const BAND_CTA_PRIMARY_HREF = 'https://algovault.com/#quickstart';

export const BAND_CTA_SECONDARY_LABEL = 'Try free in Telegram';
export const BAND_CTA_SECONDARY_HREF = 'https://t.me/algovaultofficialbot';

export const BAND_LINK_LABEL = 'See pricing \u2192';
/** Deliberately the SAME target as the nav's Pricing link. `algovault.com/pricing` 404s and is
 *  never cited (brand-facts.md); `api.algovault.com/signup` is the pricing SURFACE, and the
 *  landing's #pricing section is what both the nav and this link point at. */
export const BAND_LINK_HREF = 'https://algovault.com/#pricing';

/**
 * The band's sub-line is NOT a new string — it is the live hero line, projected.
 *
 * Typing it here would create a second copy of a sentence that already has a source of truth,
 * and the two would drift the first time the free tier moves. `landingCopy` interpolates the
 * allowances from `plans.ts`, so `200` and `100` are never literal anywhere on the path. The
 * `11` inside that SoT string is an inherited literal: substituting TIMEFRAME_COUNT would FORK
 * the string this line is copy-locked to, which is a worse defect than the literal.
 */
export function bandSubLine(): string {
  return landingCopy('hero.free_tier_note', 'desktop');
}

/**
 * C4 — the quickstart COPY button's transient, JS-only confirmation label.
 *
 * NEVER present in static HTML. The served markup keeps `COPY`; the appended controller swaps
 * the label for ~1.5s after a successful clipboard write and restores it. That distinction is
 * load-bearing: CH2's gate asserts the rendered text of `/` is byte-unchanged, and a label the
 * static document carried would break it.
 */
export const COPY_BUTTON_IDLE_LABEL = 'COPY';
export const COPY_BUTTON_COPIED_LABEL = 'COPIED';

/** How long the transient label stays before restoring `COPY`. */
export const COPY_BUTTON_COPIED_MS = 1500;
