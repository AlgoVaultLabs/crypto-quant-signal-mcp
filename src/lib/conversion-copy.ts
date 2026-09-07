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
