/**
 * The baked-venue-count predicate — ONE derivation, shared by every gate that reads public copy.
 *
 * WHY IT MOVED HERE. This regex was first authored and exported inside a gate that calls `main()`
 * at module scope, so importing it RAN the live gate and `process.exit`ed the caller. A second consumer therefore had exactly two options: re-declare the regex, or move it.
 * Re-declaring is the drift generator this estate keeps retiring (CLAUDE.md § Build rules,
 * single-derivation), and the drift would be invisible: two regexes that agree on every string
 * anyone happens to test still diverge on the one that matters. So the predicate moved to a leaf
 * module with no side effects and every gate projects from it.
 *
 * WHAT IT ASSERTS. The public-copy HELD list forbids a hardcoded venue count on every surface —
 * the forward-stability canary rejects one in the published manifest descriptions, and this
 * rejects one in a catalogue listing or a plugin manifest. Word-boundaried on both ends so
 * `cross-venue` (no count) and `4h timeframes` (a timeframe token, not a count) stay clean.
 * Verified against the incumbent strings before shipping; both directions are asserted in the
 * self-test of every consumer.
 *
 * Consumers (keep this list honest — a shared primitive needs an enumeration, not a detector):
 *   - scripts/check-plugin-manifests.mjs (PLUGIN_MANIFESTS_VERDICT)
 */

export const BAKED_VENUE_COUNT = /\b\d+\s*(perp|perpetual|derivatives?)?\s*venues?\b/i;

export function hasBakedVenueCount(description) {
  return BAKED_VENUE_COUNT.test(String(description ?? ''));
}
