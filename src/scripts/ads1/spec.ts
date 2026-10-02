// ads1/spec.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R1; the `-v2` family, the max-form T_CAP and the coarser-served table
// since EDGE-ADS1-SCORECARD-W1-V3 CH3-A (registration §10).
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

import { SERVED_VENUES, servedCandleStepMs } from '../../lib/tf-support.js';
import { BARRIER_SPECS, BARRIER_SPECS_V2, EVAL_CANDLES, FLOOR_PCT, ROUND_TRIP_COST_PCT, TF_MS } from '../directional-labeler.js';
import { CLUSTER_EDGE_CONTRACT, MIN_ROWS_PER_CLUSTER as ESTATE_MIN_ROWS_PER_CLUSTER } from '../dwr-cluster-edge.js';
import { T_CUT_EPOCH } from '../lrw/registered.js';

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

/**
 * THE barrier family this study reads (registration §10.1, EDGE-ADS1-SCORECARD-W1-V3; rulings Q8 = A, LRW-Q12 = A):
 * the `-v2` family, IMPORTED from the labeler's one constants module (`BARRIER_SPECS_V2`), primary first. A `-v3`
 * family is a one-line change here and every ADS-1 artifact follows (the extract generator, `ops/ads1-spec.json`,
 * the AOE vendored copy, the registration's pinned SQL via its pin test). No family literal lives in this module.
 * The `-v1` family (`FRESHNESS_BARRIER_SPEC`, ruling Q9) is NOT read by ADS-1 — not its label, not its gap.
 */
export const ADS1_BARRIER_SPECS = BARRIER_SPECS_V2;
export const PRIMARY_SPEC = ADS1_BARRIER_SPECS[0];
export const SENSITIVITY_SPECS = ADS1_BARRIER_SPECS.slice(1);
export const PRIMARY_BARRIER_SPEC: string = PRIMARY_SPEC.spec;
/** The `-v1` twin of the primary spec (same τ) — used for PRESENCE only (the coverage chain's "`-v1` present" step,
 *  label-free, an EXISTS), never for a value. Derived by τ from the labeler's `-v1` set, never typed. */
export const PRIMARY_V1_TWIN_SPEC: string = (() => {
  const twin = BARRIER_SPECS.find((b) => b.tau === PRIMARY_SPEC.tau);
  if (!twin) throw new Error(`ads1/spec: no -v1 spec with tau ${PRIMARY_SPEC.tau}`);
  return twin.spec;
})();

/**
 * The coarser-served pairs — (exchange, timeframe) where the venue SERVES a candle coarser than the timeframe —
 * DERIVED from `servedCandleStepMs` (the one served-step lookup, src/lib/tf-support.ts) over every venue it knows ×
 * the label window. `tests/unit/ads1-spec-lock.test.ts` asserts this set equals the nine-row literal of
 * `audits/labeler-race-window-v2-preregistration-2026-09-28.md` §3.1 (parsed from that file), so the two
 * registrations cannot disagree (as a SET — row order is the derivation's: `SERVED_VENUES` declaration order × the
 * label window's order, the order LRW's own derived `coarserV1LagTable` prints).
 */
export interface CoarserServed {
  exchange: string;
  timeframe: string;
  servedSeconds: number;
}
export const COARSER_SERVED: readonly CoarserServed[] = SERVED_VENUES.flatMap((exchange) =>
  Object.keys(EVAL_CANDLES).flatMap((timeframe) => {
    const served = servedCandleStepMs(exchange, timeframe);
    return served !== null && served > TF_MS[timeframe] ? [{ exchange, timeframe, servedSeconds: served / 1000 }] : [];
  }),
);

/** `max(requested, served)` in seconds for one (exchange, timeframe); null for a timeframe outside the label window. */
export function raceStepSeconds(exchange: string, timeframe: string): number | null {
  const tf = TF_MS[timeframe];
  if (!EVAL_CANDLES[timeframe] || !tf) return null;
  const c = COARSER_SERVED.find((p) => p.exchange === exchange && p.timeframe === timeframe);
  return Math.max(tf / 1000, c ? c.servedSeconds : 0);
}

/**
 * T_ADAPTER (registration §10.5, ruling OAH-Q8): the `StartedAt` of the first `mcp-server` container on the
 * `OPS-ADAPTER-HISTORY-ANCHOR-W1` CH2 commit — 2026-10-01T14:27:16.460Z, recorded in `status.md`
 * (`T_ADAPTER = 1790864836 (2026-10-01T14:27:16.460Z)`). Pinned ONCE here (no other module carries it). On the
 * adapter-pending cells a `-v2` row computed at or after it was raced on a σ history the shipped adapter could reach.
 */
export const T_ADAPTER = 1790864836;
/** The LRW cut (registration §10.4's `nightly` class starts here) — imported, never retyped. */
export const T_CUT = T_CUT_EPOCH;
/** The cells printed split at T_ADAPTER (registration §10.5: BITGET 2h / 8h). THIS STUDY'S registered set — a
 *  sanctioned same-shape exception to single derivation: LRW's `ADAPTER_PENDING_CELLS` (src/scripts/lrw/registered.ts)
 *  starts with the same two cells but means "not yet reachable by the relabel" and SHRINKS when the relabel reaches
 *  them; this one means "printed split at T_ADAPTER" and is fixed by the registration. Pinned to §10.5 by
 *  tests/unit/ads1-spec-lock.test.ts. Do not merge the two. */
export const ADAPTER_SPLIT_CELLS: ReadonlySet<string> = new Set(['BITGET:2h', 'BITGET:8h']);

/**
 * The race-end embargo T_CAP in its REQUESTED-interval form (ruling Q1 = A, as first registered): true iff
 * `created_at ≤ T_DIAG_END ∧ created_at + (W+1)·requested ≤ T_DIAG_END`. KEPT BYTE-IDENTICAL ON PURPOSE: the nightly
 * labeller's seal edge (`sealEdgeRow`, src/scripts/backfill-directional-labels.ts) is defined against this form, so
 * changing it would change what the labeller writes. ADS-1's population predicate is `withinTCapMax` below.
 */
export function withinTCap(createdAtS: number, timeframe: string): boolean {
  const W = EVAL_CANDLES[timeframe];
  const tf = TF_MS[timeframe];
  if (!W || !tf) return false;
  return createdAtS <= T_DIAG_END && createdAtS + ((W + 1) * tf) / 1000 <= T_DIAG_END;
}

/**
 * T_CAP in the ruled MAX form (registration §10.2; ruling Q11, LRW-Q8): true iff
 * `created_at ≤ T_DIAG_END ∧ created_at + (W+1)·max(requested, served) ≤ T_DIAG_END`. The extract's SQL predicate
 * (`GREATEST(tf.sec, COALESCE(coarser.sec, tf.sec))`) is generated from the same `COARSER_SERVED`; the max form admits a
 * SUBSET of the requested form (they differ only on the coarser-served pairs).
 */
export function withinTCapMax(createdAtS: number, exchange: string, timeframe: string): boolean {
  const W = EVAL_CANDLES[timeframe];
  const step = raceStepSeconds(exchange, timeframe);
  if (!W || step === null) return false;
  return createdAtS <= T_DIAG_END && createdAtS + (W + 1) * step <= T_DIAG_END;
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
    barrier_specs: ADS1_BARRIER_SPECS.map((b) => ({ spec: b.spec, tau: b.tau })),
    coarser_served: COARSER_SERVED.map((c) => ({ exchange: c.exchange, timeframe: c.timeframe, served_seconds: c.servedSeconds })),
    t_adapter: T_ADAPTER,
    eval_candles: { ...EVAL_CANDLES },
    tf_seconds: Object.fromEntries(Object.entries(TF_MS).map(([k, ms]) => [k, ms / 1000])),
  };
  return JSON.stringify(sortKeys(spec), null, 2) + '\n';
}
