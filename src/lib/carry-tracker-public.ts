/**
 * EDGE-CARRY-SCOREBOARD-W1 — public-safe aggregates for the /carry-tracker page.
 *
 * THIS MODULE COMPUTES NO STATISTICS, AND THAT IS ITS ENTIRE CONTRACT. Every number it serves
 * is precomputed by `src/research/carry/tracker_publish.py` in the autonomous-optimizer repo,
 * which imports the canonical readiness derivation (`dedupe_paired` + `assess` +
 * `stats.block_bootstrap_ci`) verbatim. There is no in-process import path between Python and
 * TypeScript, so "the endpoint projects from the readiness derivation, never re-derives it" is
 * realised by precomputing there and SELECTing here. No bootstrap, no confidence interval, no
 * mean, no dedupe belongs in this file — if any appears, the single-derivation property is gone
 * and the page and the flip bar can disagree about the same window.
 *
 * WHAT THE NUMBERS ARE. A paired DIFFERENCE — the ranker portfolio's net carry minus the naive
 * portfolio's, on the same interval, on a x2-hedged-cost basis — measured live-forward since the
 * HL flip on 2026-07-21. This is PAPER lift: the naive counterfactual lives in a paper portfolio
 * scored on the same intervals, because served traffic has no counterfactual. It is not
 * served-traffic P&L and must never be described as such.
 *
 * DATA INTEGRITY. Aggregates only. `portfolio_net_carry_x2` is a portfolio SCALAR and is
 * INTERNAL; nothing absolute leaves here. Differences and interval counts are what make this
 * surface publishable at all. `status` (the flip bar's READY/WAIT verdict) is deliberately NOT
 * exposed: it is an internal gate token whose vocabulary reads as a recommendation.
 */
import { dbQuery } from './performance-db.js';

export interface CarryTrackerWeek {
  iso_week: string;
  lift_mean: number;
  n: number;
  n_deviating: number;
  /** The ISO week is not fully covered by the measured window. Two are structurally partial:
   *  the first (the flip landed Tuesday 2026-07-21, so W30 is measured from the 21st) and the
   *  one still in progress. Rendering a 144-interval mean beside a 168-interval one without
   *  this flag would misstate the very trend the page exists to show honestly. */
  partial: boolean;
}

export interface CarryTrackerPooled {
  lift_mean: number;
  /** Block-bootstrap 95% CI over ISO-WEEK clusters. Pooled only — a per-week interval would be
   *  a single cluster and therefore degenerate, which is why no week carries one. */
  ci_lb: number;
  ci_ub: number;
  n: number;
  n_deviating: number;
  blocks: number;
}

export interface CarryTrackerPublic {
  scope: string;
  since: string;
  weeks: CarryTrackerWeek[];
  pooled: CarryTrackerPooled | null;
  updated_at: string | null;
  /** True when the publisher has not run recently enough to trust. Keyed on the PRODUCER's own
   *  `computed_at` stamp, never on when this response was rendered. */
  stale: boolean;
}

export const TRACKER_SCOPE = 'HL';
const CACHE_TTL_MS = 300_000; // 5 min
/** Publisher cadence is daily 01:43 UTC; 26h allows a full missed slot plus grace before the
 *  page starts telling readers the number is old. */
const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
/** Matches the precision the 2026-08-12 census reported; more digits would imply a resolution
 *  the block bootstrap does not have. */
const DP = 8;

interface WeeklyRow {
  iso_week: string; lift_mean: number; n: number; n_deviating: number;
  partial: boolean; window_start: string; computed_at: string;
}
interface PooledRow {
  lift_mean: number; ci_lb: number; ci_ub: number; n: number;
  n_deviating: number; blocks: number; window_start: string; computed_at: string;
}

const round = (x: number, dp = DP): number => Number(Number(x).toFixed(dp));

/**
 * The ALLOW-LIST. Pure, exported and unit-tested: the response is BUILT from named fields, so a
 * column added to either table can never reach the public body by default. A deny-list would
 * invert that and make every future schema change a potential leak.
 */
export function formatCarryTrackerPublic(
  weekly: WeeklyRow[],
  pooled: PooledRow | null,
  now: number = Date.now(),
): CarryTrackerPublic {
  const weeks: CarryTrackerWeek[] = weekly
    .slice()
    .sort((a, b) => a.iso_week.localeCompare(b.iso_week))
    .map((r) => ({
      iso_week: String(r.iso_week),
      lift_mean: round(r.lift_mean),
      n: Number(r.n),
      n_deviating: Number(r.n_deviating),
      partial: Boolean(r.partial),
    }));

  const since = pooled?.window_start ?? weekly[0]?.window_start ?? '';
  const computedAt = pooled?.computed_at ?? weekly[0]?.computed_at ?? null;
  const updated = computedAt ? new Date(computedAt) : null;
  const updatedMs = updated && !Number.isNaN(updated.getTime()) ? updated.getTime() : null;

  return {
    scope: TRACKER_SCOPE,
    // `since` comes from the PUBLISHER's stamped window, never from a constant here. The Python
    // side's own LIVE_FORWARD_START is 2026-07-05 (the ranker go-live) — 16 days before the HL
    // flip this page reports on — so a hardcoded or echoed date is exactly the bug to avoid.
    since: String(since).slice(0, 10),
    weeks,
    pooled: pooled
      ? {
        lift_mean: round(pooled.lift_mean),
        ci_lb: round(pooled.ci_lb),
        ci_ub: round(pooled.ci_ub),
        n: Number(pooled.n),
        n_deviating: Number(pooled.n_deviating),
        blocks: Number(pooled.blocks),
      }
      : null,
    updated_at: updatedMs ? new Date(updatedMs).toISOString() : null,
    stale: updatedMs === null ? true : now - updatedMs > STALE_AFTER_MS,
  };
}

let cache: { at: number; value: CarryTrackerPublic } | null = null;

// Test seam (project convention — matches _setCarryScoresForTest): undefined restores live reads.
let _override: CarryTrackerPublic | undefined;
export function _setCarryTrackerForTest(v: CarryTrackerPublic | undefined): void {
  _override = v;
  cache = null;
}

/**
 * FAIL-OPEN. A read error yields an empty, `stale: true` payload rather than a throw — the page
 * then renders its labelled stale banner instead of a broken surface. This is a read-only public
 * trust page: a database blip must never present as an outage of the thing being reported on.
 */
export async function getCarryTrackerPublic(): Promise<CarryTrackerPublic> {
  if (_override !== undefined) return _override;
  const now = Date.now();
  if (cache && now - cache.at <= CACHE_TTL_MS) return cache.value;
  let value: CarryTrackerPublic;
  try {
    const [weekly, pooled] = await Promise.all([
      dbQuery<WeeklyRow>(
        `SELECT iso_week, lift_mean::float8 AS lift_mean, n, n_deviating, partial,
                window_start::text AS window_start, computed_at::text AS computed_at
         FROM carry_tracker_weekly WHERE scope = $1 ORDER BY iso_week`,
        [TRACKER_SCOPE],
      ),
      dbQuery<PooledRow>(
        `SELECT lift_mean::float8 AS lift_mean, ci_lb::float8 AS ci_lb, ci_ub::float8 AS ci_ub,
                n, n_deviating, blocks,
                window_start::text AS window_start, computed_at::text AS computed_at
         FROM carry_tracker_pooled WHERE scope = $1`,
        [TRACKER_SCOPE],
      ),
    ]);
    value = formatCarryTrackerPublic(weekly, pooled[0] ?? null, now);
  } catch (e) {
    console.warn(
      `[carry-tracker-public] read failed (serving stale banner): ${String((e as Error)?.message ?? e).slice(0, 160)}`,
    );
    value = formatCarryTrackerPublic([], null, now);
  }
  cache = { at: now, value };
  return value;
}
