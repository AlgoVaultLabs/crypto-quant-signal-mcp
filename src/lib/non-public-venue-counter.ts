/**
 * non-public-venue-counter.ts — measure who is still asking for a venue we stopped publishing.
 *
 * DOCS-SUPPORT-ANSWERS-AND-PUBLIC-VENUE-SCOPE-W1 CH1.
 *
 * WHY. That wave narrowed the public `exchange` enum from 17 to 15, removing EDGEX (`retired`,
 * klines ~200×timeframe stale, WR 25.2%) and WEEX (`shadow`). That is a BREAKING change for any
 * caller passing either — and `request_log` (`analytics.ts:28-46`) records `tool_name`, `asset`,
 * `timeframe` and `license_tier` but **no `exchange` column**, so we could not count who that was.
 * The change shipped on the merits (serving a stale verdict from a retired venue is the larger
 * risk) but it shipped BLIND, and "we cannot measure it" is not a reason to leave it unmeasured.
 *
 * Deliberately NOT a `request_log` migration: that is a schema change for a question which expires
 * once this counter reports. Deliberately NOT an alert: it is telemetry, not an operator action.
 *
 * ── WHY NOT `recordIndeterminate` ─────────────────────────────────────────────
 * `indeterminate-counter.ts` is the same SHAPE — in-process counters, never throws, one structured
 * line with a stable greppable prefix — and reusing it was the first instinct. It is the wrong
 * home: that counter means "a load-bearing path could NOT determine its answer", and a host-side
 * canary alerts on the `[indeterminate]` series. This event is the opposite — a fully DETERMINED
 * refusal, working exactly as designed. Filing it there would inject routine traffic into an
 * alerting signal and teach the operator to ignore it. Same pattern, separate series.
 *
 * ── WHAT IT COUNTS, PRECISELY ─────────────────────────────────────────────────
 * Only a venue that is in `VENUE_IDS_ALL` but not in `PUBLIC_VENUE_IDS` — i.e. exactly the venues
 * this wave removed. A typo like `BINANCEE` is also rejected, but it is a different (pre-existing)
 * class and counting it here would bury the signal we actually want under noise we already had.
 */

import { PUBLIC_VENUE_IDS, VENUE_IDS_ALL } from './tool-param-schema.js';

export interface NonPublicVenueSnapshot {
  /** Attempts since process start, keyed `<venue>:<tool>`. */
  counts: Record<string, number>;
  /** Epoch ms of the most recent attempt per key. */
  lastAt: Record<string, number>;
  /** Epoch ms this counter began observing (process start). Windows are computed from it. */
  since: number;
}

const counts = new Map<string, number>();
const lastAt = new Map<string, number>();
const since = Date.now();

/** Declared but not public — computed once. Exactly the set CH1 removed from the public enums. */
const NON_PUBLIC: ReadonlySet<string> = new Set(
  (VENUE_IDS_ALL as readonly string[]).filter((v) => !(PUBLIC_VENUE_IDS as readonly string[]).includes(v)),
);

/** True when `venue` is a venue we declare and seed but no longer accept on the public API. */
export function isNonPublicVenue(venue: unknown): boolean {
  return typeof venue === 'string' && NON_PUBLIC.has(venue);
}

/**
 * Record that a caller asked for a non-public venue. The MCP SDK rejects the call downstream with
 * `-32602`, so an attempt IS a rejection for these values.
 *
 * NEVER THROWS and never blocks: this sits on the live serving path, and an instrument that can
 * break the thing it measures is worse than no instrument.
 */
export function recordNonPublicVenue(venue: string, tool: string, licenseTier: string): void {
  try {
    if (!isNonPublicVenue(venue)) return;
    const key = `${venue}:${tool}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    lastAt.set(key, Date.now());
    // One line, stable prefix, machine-greppable. `console.log`, not `console.error`: nothing is
    // broken — this is the measurement that makes the NEXT scope change evidence-led.
    console.log(
      `[non_public_venue_rejected] venue=${venue} tool=${tool} tier=${licenseTier} total=${counts.get(key)}`,
    );
  } catch {
    // An instrument must never break the path it instruments.
  }
}

/** Read the counters. Used by tests and by any future metrics surface. */
export function getNonPublicVenueSnapshot(): NonPublicVenueSnapshot {
  return { counts: Object.fromEntries(counts), lastAt: Object.fromEntries(lastAt), since };
}

/** Tests only — module-level state needs an explicit reset seam (CLAUDE.md cache-seam rule). */
export function _resetNonPublicVenueCounters(): void {
  counts.clear();
  lastAt.clear();
}
