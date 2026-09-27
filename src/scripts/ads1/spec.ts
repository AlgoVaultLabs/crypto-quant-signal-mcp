// ads1/spec.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R1.
//
// THE ONE SOURCE of every ADS-1 constant. The AlgoVault Directional Standard, draft 1.0.0
// (research/directional-edge-standard-deep-research-2026-09-27.md §4, §6), as ruled on 2026-09-27
// (the wave spec's corrections D1–D34 and rulings Q1–Q7).
//
// PURE: no env, no DB, no I/O. Everything it can derive from an existing estate constant it IMPORTS
// rather than retypes (the barrier specs, the 0.30 % floor, the taker cost, the cluster floors, the
// label window), so a change there moves ADS-1 with it instead of drifting from it.
//
// `serializeAds1Spec()` is the cross-repo contract: `scripts/emit-ads1-spec.mjs` writes it to the
// committed `ops/ads1-spec.json`, `tests/unit/ads1-spec-lock.test.ts` locks TS == JSON, and the AOE
// adapter vendors those bytes with a pinned sha256 — so the two repos cannot drift silently.
//
// NON-PROMOTABLE. Nothing here feeds a gate, a threshold, a weight or a public figure.

import { FRESHNESS_BARRIER_SPEC } from '../../lib/venue-slo-tiers.js';
import { BARRIER_SPECS, EVAL_CANDLES, FLOOR_PCT, ROUND_TRIP_COST_PCT, TF_MS } from '../directional-labeler.js';
import { CLUSTER_EDGE_CONTRACT, MIN_ROWS_PER_CLUSTER as ESTATE_MIN_ROWS_PER_CLUSTER } from '../dwr-cluster-edge.js';

export const ADS1_SPEC_VERSION = '1.0.0-draft';

/** A timeout resolves to WIN / LOSS only when its expiry return, in the called direction, clears this
 *  floor (PERCENT) — the label's own fee floor, imported (0.30). Below it the call is FLAT. */
export const FLAT_FLOOR_PCT = FLOOR_PCT;

/** NOT_IDENTIFIABLE when the minority side's share of the scored rows is below this (the 10 % ratified
 *  by AOE-CELL-DEFINITION-W1 Q2) ... */
export const MINORITY_SIDE_FLOOR = 0.1;
/** ... or when the Fréchet attainable excess range (the CLAUDE.md identifiability law) is narrower than
 *  the smallest claim the standard can make (the no-claim band, 1.0 pp). */
export const FRECHET_MIN_RANGE_PP = 1.0;

/** Effective trials to see 52 % vs 50 % at one-sided α = .05, power .8: 3862.005 → ceiling (D12). */
export const N_EFF_FLOOR = 3863;

export const BANDS = {
  noClaimBelowPp: 1.0,
  credible: [1.0, 3.0] as const, // [lo, hi)
  exceptional: [3.0, 5.0] as const, // [lo, hi)
  auditAbovePp: 5.0,
  auditAboveHitRate: 0.6,
  /** Effective trials to see 55 % vs 50 % (memo §4.2): 616.16 → ceiling (D12). */
  auditMinNeff: 617,
} as const;

export const EXCEPTIONAL_MIN_T = 3; // D28 (memo §4.4)
export const EXCEPTIONAL_MIN_LIVE_DAYS = 365;
export const EXCEPTIONAL_MIN_REGIMES = 2;

/** Round-trip cost, PERCENT of price (D11 — the unit barrier_pct is stored in). Taker IS the estate's
 *  `ROUND_TRIP_COST_PCT` (2 × 0.05 %); maker is 2 × 0.02 % (memo §4.3). Venue overrides are a v1.1 item. */
export const COST_TIERS_PCT = { taker: ROUND_TRIP_COST_PCT, maker: 0.04 } as const;

/**
 * THE calibration binning (D29), over the emitted support [52, 100] — the record gate is 52
 * (`MIN_TRACKABLE_CONFIDENCE`), so 0–100 deciles would leave the bottom half empty. Lower-inclusive,
 * upper-exclusive edges; the last bin closes at 100. Shared by the reliability table AND the ECE, so
 * the two can never be computed on different binnings. Narrower at the dense low end, where 80 % of the
 * emitted mass sits (50s ≈ 406 k, 60s ≈ 292 k rows, measured 2026-09-27).
 */
export const CALIB_BIN_EDGES = [52, 55, 58, 61, 64, 67, 70, 75, 80, 90, 101] as const;

/**
 * FULL-window calibration floor (D29): the first signal written under the April recalibration — both
 * `e95aadab` (2026-04-14, confidence divisor 74 → 89) and `6359e10a` (2026-04-15, record gate 60 → 52)
 * live. Data-derived 2026-09-27: `min(created_at)` over signals with confidence < 60 = 1776219824
 * (2026-04-15T02:23:44Z, 2 min after 6359e10a's commit). Earlier rows mean a different thing by
 * "confidence" and are reported separately, never pooled into L2.
 */
export const CALIB_FLOOR_TS = 1776219824;

/** TREND_MODE flip #2, final (D2): every signal after it carries verdict_rule_version = 2. */
export const T_FLIP = 1788169595;
/** The B-DIR v3 sealed-holdout floor (ratified 2026-09-26). */
export const T_DIAG_END = 1790402400;

/** Cluster floors — the estate's, imported (dwr-cluster-edge.ts). */
export const MIN_CLUSTERS = CLUSTER_EDGE_CONTRACT.minClusters;
export const MIN_ROWS_PER_CLUSTER = ESTATE_MIN_ROWS_PER_CLUSTER;

/** One-sided α for every lower bound this standard reports (Wilson, bootstrap). */
export const ALPHA_ONE_SIDED = 0.05;
/** z for the one-sided α above (Φ⁻¹(0.95)). */
export const Z_ONE_SIDED = 1.6448536269514722;
/** Day-cluster bootstrap: replicates and a FIXED seed, so a re-run reproduces the interval exactly. */
export const BOOTSTRAP_B = 2000;
export const BOOTSTRAP_SEED = 20260927;

export const PRIMARY_BARRIER_SPEC = FRESHNESS_BARRIER_SPEC;
export { BARRIER_SPECS };

/** The race-end embargo T_CAP (ruling Q1 = A): true iff the row's whole price path is at/before T_DIAG_END. */
export function withinTCap(createdAtS: number, timeframe: string): boolean {
  const W = EVAL_CANDLES[timeframe];
  const tf = TF_MS[timeframe];
  if (!W || !tf) return false;
  return createdAtS <= T_DIAG_END && createdAtS + ((W + 1) * tf) / 1000 <= T_DIAG_END;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** The cross-repo contract, byte-stable: sorted keys, 2-space indent, trailing newline. Key names avoid
 *  `name` / `version` on purpose (the system-map pre-commit gate reads those as manifest edits). */
export function serializeAds1Spec(): string {
  const spec = {
    spec_version: ADS1_SPEC_VERSION,
    flat_floor_pct: FLAT_FLOOR_PCT,
    minority_side_floor: MINORITY_SIDE_FLOOR,
    frechet_min_range_pp: FRECHET_MIN_RANGE_PP,
    n_eff_floor: N_EFF_FLOOR,
    bands: {
      no_claim_below_pp: BANDS.noClaimBelowPp,
      credible: [...BANDS.credible],
      exceptional: [...BANDS.exceptional],
      audit_above_pp: BANDS.auditAbovePp,
      audit_above_hit_rate: BANDS.auditAboveHitRate,
      audit_min_neff: BANDS.auditMinNeff,
    },
    exceptional_min_t: EXCEPTIONAL_MIN_T,
    exceptional_min_live_days: EXCEPTIONAL_MIN_LIVE_DAYS,
    exceptional_min_regimes: EXCEPTIONAL_MIN_REGIMES,
    cost_tiers_pct: { taker: COST_TIERS_PCT.taker, maker: COST_TIERS_PCT.maker },
    calib_bin_edges: [...CALIB_BIN_EDGES],
    calib_floor_ts: CALIB_FLOOR_TS,
    t_flip: T_FLIP,
    t_diag_end: T_DIAG_END,
    min_clusters: MIN_CLUSTERS,
    min_rows_per_cluster: MIN_ROWS_PER_CLUSTER,
    alpha_one_sided: ALPHA_ONE_SIDED,
    bootstrap_b: BOOTSTRAP_B,
    bootstrap_seed: BOOTSTRAP_SEED,
    primary_barrier_spec: PRIMARY_BARRIER_SPEC,
    barrier_specs: BARRIER_SPECS.map((b) => ({ spec: b.spec, tau: b.tau })),
    eval_candles: { ...EVAL_CANDLES },
    tf_seconds: Object.fromEntries(Object.entries(TF_MS).map(([k, ms]) => [k, ms / 1000])),
  };
  return JSON.stringify(sortKeys(spec), null, 2) + '\n';
}
