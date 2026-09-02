// dwr-cluster-edge.ts — OPS-AOE-MONITORING-DWR-REFOCUS-W1 R1.
//
// THE PER-CLUSTER, MIX-MATCHED DIRECTIONAL EDGE. One derivation, one home, zero gates.
//
// ── WHY THIS EXISTS, MEASURED ────────────────────────────────────────────────────────────────
// The published DWR headline is `aggregate.edge` — POOLED over every labeled row, against
// `max(alwaysBUY, alwaysSELL)`. Both halves are wrong, and they are wrong by very different
// amounts. Measured 2026-09-02 on the live corpus (`tau1.0-floor0.30-v1`, `low_vol_history =
// FALSE`, 282,071 non-timeout rows, q(BUY) = .9417):
//
//     pooled, max(alwaysBUY, alwaysSELL)   −1.79 pp   ← what the digest publishes today
//     pooled, mix-matched null             −1.75 pp   ← comparator repair alone: Δ +0.04 pp
//     PER-UTC-DAY, mix-matched null        −0.05 pp   ← sd 0.95, 143 clusters
//
// **AGGREGATION IS THE DOMINANT TERM, NOT THE COMPARATOR.** The comparator moves the figure by
// 0.04 pp; the aggregation moves it by ~1.7 pp, and the corrected value is indistinguishable
// from zero rather than a 1.9 pp deficit. That is the pooling hazard CLAUDE.md records — the
// day is the independence unit, not the row, and pooling weights the busiest day. (For contrast
// and as a warning: the SAME per-day aggregation applied to `max()` gives −5.92 pp with 9.2 pp
// of spread, because a per-day maximum silently re-selects which side it names. Two defects that
// partially cancel when pooled do not cancel per cluster.)
//
// ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────────────────────
// It computes a number the DIGEST publishes. It does NOT feed `computeCellStats`, the validity
// predicate, `edge_gate`, or any promotion decision — those keep `max(alwaysBUY, alwaysSELL)`
// until `EDGE-DWR-MIX-MATCHED-NULL-W{NEXT}` migrates them behind the shadow period that
// `ops/monitoring/population-comparison.registry.json` already ratified. So for now the digest
// figure and the gate figure are DIFFERENT QUANTITIES; the digest LABELS that divergence and
// names the reconciling wave. A labelled divergence is honest; an unlabelled one is two
// instruments pretending to be one.
//
// ── IDENTIFIABILITY IS DELIBERATELY ABSENT ───────────────────────────────────────────────────
// `population-comparison.schema.json`'s identifiability refusal is a CROSS-ARM construct: it
// bounds an arm's deviation by its own marginals and refuses when a DECLARED FLOOR exceeds that
// bound. DWR against its own null is a SINGLE population with no declared floor, and the
// measured attainable width here is 11.66 pp against an effect near 0.05 pp — so it is not the
// binding constraint, and inventing a floor to make the clause fit would be worse than omitting
// it. It applies again the day a CROSS-ARM DWR comparison is made; build it then, from a floor
// that wave derives rather than one this one guessed.

import type { LabelRow } from './dwr-baseline.js';
import { deriveRaceOutcome } from './dwr-baseline.js';

/** Projection of `ops/monitoring/population-comparison.schema.json`, pinned field-for-field by
 *  `tests/unit/dwr-cluster-edge.test.ts`. EMBEDDED rather than read at runtime for the same
 *  reason `detector-envelope.ts` embeds its schema: the Dockerfile COPYs no `ops/` path, so a
 *  runtime read would ENOENT in the container while every local gate stayed green. */
export const CLUSTER_EDGE_CONTRACT = {
  basis: 'MIX_MATCHED_NULL',
  aggregation: 'PER_CLUSTER',
  clusterUnit: 'calendar_day',
  denominatorConvention: 'ALL_SCORED',
  /** Below this many clusters the verdict is INDETERMINATE, never a point estimate. */
  minClusters: 20,
} as const;

/** A cluster too small to carry a rate contributes noise, not signal, to an UNWEIGHTED mean.
 *  30 is the same floor the DWR corpus already uses for a "powered" judgement elsewhere; it is
 *  applied here to CLUSTER membership, never to the rows inside a kept cluster. */
export const MIN_ROWS_PER_CLUSTER = 30;

export interface ClusterEdge {
  /** `YYYY-MM-DD`, UTC. The independence unit. */
  day: string;
  /** Non-timeout rows in the cluster (the ALL_SCORED denominator). */
  n: number;
  /** Engine directional win rate on this cluster. */
  dwr: number;
  /** Empirical always-BUY rate on the SAME rows. */
  pLong: number;
  /** Empirical always-SELL rate on the SAME rows. */
  pShort: number;
  /** Emitted BUY share on the SAME rows. */
  q: number;
  /** `q·pLong + (1−q)·pShort` — the mix-matched null. */
  pStar: number;
  /** `dwr − pStar`, in PERCENTAGE POINTS. */
  excessPp: number;
}

export interface ClusterEdgeSummary {
  /** Unweighted mean of `excessPp` across clusters, in pp. `null` when INDETERMINATE. */
  meanPp: number | null;
  /** Sample standard deviation of `excessPp` across clusters, in pp. `null` when < 2 clusters. */
  sdPp: number | null;
  /** Clusters that met `MIN_ROWS_PER_CLUSTER` and are IN the mean. */
  clusters: number;
  /** Clusters seen but dropped for being under `MIN_ROWS_PER_CLUSTER`. Reported, never hidden:
   *  a mean over 143 of 400 days is a different claim from a mean over 143 of 145. */
  clustersDropped: number;
  /** Rows inside the kept clusters. Never the corpus size — those differ, and conflating them
   *  is how a coverage claim gets overstated. */
  rowsInClusters: number;
  /** `PER_CLUSTER` when the mean stands, `INDETERMINATE` when it does not. Never a silent null:
   *  "measured and clean" may not share an output with "measured nothing". */
  verdict: 'PER_CLUSTER' | 'INDETERMINATE';
  /** Why, when `INDETERMINATE`. `null` on the happy path. */
  reason: string | null;
}

/** One cluster's mix-matched excess. Exported for the unit test — it is the whole statistic,
 *  and a test that can only see the mean cannot tell a wrong null from a wrong average. */
export function clusterEdgeOf(day: string, rows: LabelRow[]): ClusterEdge | null {
  let uppers = 0;
  let lowers = 0;
  let ambiguous = 0;
  let wins = 0;
  let buys = 0;
  for (const r of rows) {
    const o = deriveRaceOutcome(r.side, r.label, r.ambiguous);
    if (o === 'timeout') continue; // ALL_SCORED excludes timeouts on BOTH sides of the subtraction
    if (o === 'upper') uppers++;
    else if (o === 'lower') lowers++;
    else ambiguous++;
    if (r.label === 1) wins++;
    if (r.side === 'BUY') buys++;
  }
  const n = uppers + lowers + ambiguous;
  if (n === 0) return null;
  const dwr = wins / n;
  const pLong = uppers / n;
  const pShort = lowers / n;
  const q = buys / n;
  const pStar = q * pLong + (1 - q) * pShort;
  return { day, n, dwr, pLong, pShort, q, pStar, excessPp: 100 * (dwr - pStar) };
}

/** UTC calendar day of a unix-SECONDS stamp. `signals.created_at` is an `integer` column of
 *  epoch seconds (probed 2026-09-02), and the cluster unit is UTC because every other window in
 *  this estate is — a local-time day would make the unit a function of the reader's machine. */
export function utcDayOf(createdAtSeconds: number): string {
  return new Date(createdAtSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Per-cluster mix-matched directional edge over one row set.
 *
 * Unweighted across clusters BY DESIGN: weighting by cluster size reintroduces the pooling this
 * function exists to remove. The sd is reported beside the mean because a mean with no spread is
 * a point estimate wearing a conclusion's clothes — measured here, the spread (0.95 pp) is an
 * order of magnitude larger than the mean (0.05 pp), which is the actual finding.
 */
export function clusterEdge(rows: LabelRow[]): ClusterEdgeSummary {
  const byDay = new Map<string, LabelRow[]>();
  for (const r of rows) {
    const d = utcDayOf(r.createdAt);
    const g = byDay.get(d);
    if (g) g.push(r);
    else byDay.set(d, [r]);
  }

  const kept: ClusterEdge[] = [];
  let dropped = 0;
  for (const [day, group] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const c = clusterEdgeOf(day, group);
    if (c === null || c.n < MIN_ROWS_PER_CLUSTER) {
      dropped++;
      continue;
    }
    kept.push(c);
  }

  const rowsInClusters = kept.reduce((acc, c) => acc + c.n, 0);
  if (kept.length < CLUSTER_EDGE_CONTRACT.minClusters) {
    return {
      meanPp: null, sdPp: null, clusters: kept.length, clustersDropped: dropped,
      rowsInClusters, verdict: 'INDETERMINATE',
      reason: `under-clustered: ${kept.length} < ${CLUSTER_EDGE_CONTRACT.minClusters} required`,
    };
  }

  const mean = kept.reduce((acc, c) => acc + c.excessPp, 0) / kept.length;
  const variance = kept.reduce((acc, c) => acc + (c.excessPp - mean) ** 2, 0) / (kept.length - 1);
  return {
    meanPp: mean, sdPp: Math.sqrt(variance), clusters: kept.length, clustersDropped: dropped,
    rowsInClusters, verdict: 'PER_CLUSTER', reason: null,
  };
}
