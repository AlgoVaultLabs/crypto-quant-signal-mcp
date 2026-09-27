// ads1/layers.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R1: L2 (calibration), L3 (emitted-arm coverage),
// L4 (payoff & cost), and the cell verdict. PURE — rows in, numbers out.
//
// L3 IS THE EMITTED ARM ONLY (ruling Q3 = A). The withheld arm is quarantined and is not read: the
// census gives coverage / HOLD share as CARDINALITIES, and only when its units are commensurate with
// the emitted record — measured 2026-09-27 they are NOT (seed-signals skips re-evaluating a pair that
// just EMITTED, but re-evaluates a HOLD on every fire, so `hold_counts` counts evaluations while
// `signals` counts idempotent emissions), so the ratio is `n/a: COVERAGE_UNITS_INCOMMENSURATE` and only
// the raw counts print. What L3 CAN say is what abstaining harder inside the emitted book would buy:
// the edge of the top 100 / 75 / 50 % by conviction.

import { spearman } from './rank.js';
import { edge, engineOutcome, isScored, mixMatchedNull, type Ads1Row, type Edge } from './core.js';
import {
  BANDS,
  CALIB_BIN_EDGES,
  COST_TIERS_PCT,
  EXCEPTIONAL_MIN_LIVE_DAYS,
  EXCEPTIONAL_MIN_REGIMES,
  EXCEPTIONAL_MIN_T,
  N_EFF_FLOOR,
} from './spec.js';

// ── L2 — calibration ─────────────────────────────────────────────────────────────────────────────

export interface CalibrationBin {
  lo: number; // inclusive confidence
  hi: number; // exclusive confidence
  n: number;
  pImplMean: number; // mean confidence/100 in the bin
  realized: number; // complete-label hit rate in the bin
}

export interface Calibration {
  bins: CalibrationBin[];
  outOfSupport: number; // scored rows whose confidence is outside [52, 101)
  spearman: number | null; // bin midpoint vs realized, over non-empty bins
  brierImpl: number;
  brierBase: number; // p0 (the mix-matched null) as the forecast
  brierHalf: number; // 0.5 as the forecast
  bss: number | null; // 1 − brierImpl / brierBase
  ece: number; // Σ (n_b / N) · |pImplMean_b − realized_b|, same bins
}

export function binIndex(confidence: number): number {
  for (let i = 0; i < CALIB_BIN_EDGES.length - 1; i++) {
    if (confidence >= CALIB_BIN_EDGES[i] && confidence < CALIB_BIN_EDGES[i + 1]) return i;
  }
  return -1;
}

export function calibration(rows: Ads1Row[]): Calibration {
  const p0 = mixMatchedNull(rows).p0;
  const nb = CALIB_BIN_EDGES.length - 1;
  const cnt = new Array(nb).fill(0);
  const sumP = new Array(nb).fill(0);
  const hits = new Array(nb).fill(0);
  let N = 0, outOfSupport = 0, bImpl = 0, bBase = 0, bHalf = 0;
  for (const r of rows) {
    const o = engineOutcome(r);
    if (!isScored(o)) continue;
    const y = o === 'WIN' ? 1 : 0;
    const p = r.confidence / 100;
    N++;
    bImpl += (p - y) ** 2;
    bBase += (p0 - y) ** 2;
    bHalf += (0.5 - y) ** 2;
    const i = binIndex(r.confidence);
    if (i < 0) { outOfSupport++; continue; }
    cnt[i]++;
    sumP[i] += p;
    hits[i] += y;
  }
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < nb; i++) {
    bins.push({
      lo: CALIB_BIN_EDGES[i], hi: CALIB_BIN_EDGES[i + 1], n: cnt[i],
      pImplMean: cnt[i] ? sumP[i] / cnt[i] : NaN, realized: cnt[i] ? hits[i] / cnt[i] : NaN,
    });
  }
  const live = bins.filter((b) => b.n > 0);
  const inSupport = live.reduce((a, b) => a + b.n, 0);
  const ece = inSupport ? live.reduce((a, b) => a + (b.n / inSupport) * Math.abs(b.pImplMean - b.realized), 0) : NaN;
  const brierImpl = N ? bImpl / N : NaN;
  const brierBase = N ? bBase / N : NaN;
  return {
    bins,
    outOfSupport,
    spearman: live.length >= 2 ? spearman(live.map((b) => (b.lo + b.hi) / 2), live.map((b) => b.realized)) : null,
    brierImpl,
    brierBase,
    brierHalf: N ? bHalf / N : NaN,
    bss: N && brierBase > 0 ? 1 - brierImpl / brierBase : null,
    ece,
  };
}

// ── L3 — emitted-arm coverage ────────────────────────────────────────────────────────────────────

export interface Census {
  signals: number; // emitted + recorded (conf ≥ 52), label-free count
  bandSignals: number; // emitted below the record gate, unlabelled
  holdCounts: number; // Σ hold_counts — HOLD evaluations
  emitSuppressions: number; // Σ emit_suppressions
  /** Whether `signals` and `hold_counts` count the same unit. Measured 2026-09-27: false. */
  unitsCommensurate: boolean;
}

export interface TrimmedEdge {
  keep: number; // requested share of the emitted arm
  achievedShare: number; // ties at the cut-off confidence are kept whole
  minConfidence: number;
  n: number;
  edgePp: number | null;
  edgePpPooled: number;
  ciLbPp: number | null;
}

export interface CoverageEmitted {
  edgeAt: TrimmedEdge[];
  coverage: number | null;
  holdShare: number | null;
  coverageReason: string | null;
  census: Census | null;
  /** Mean direction reversals per (exchange, coin, timeframe, UTC day) among emitted calls. */
  flipsPerGroupDay: number;
  /** Reversals over consecutive same-group same-day pairs. */
  reversalShare: number;
}

/** Keep the top `keep` share of the rows by conviction; ties at the cut-off stay whole (deterministic). */
export function trimByConviction(rows: Ads1Row[], keep: number): { kept: Ads1Row[]; minConfidence: number } {
  if (rows.length === 0) return { kept: [], minConfidence: NaN };
  const desc = [...rows].sort((a, b) => b.confidence - a.confidence);
  const idx = Math.min(desc.length - 1, Math.max(0, Math.ceil(keep * desc.length) - 1));
  const cut = desc[idx].confidence;
  return { kept: rows.filter((r) => r.confidence >= cut), minConfidence: cut };
}

export function flipRate(rows: Ads1Row[]): { flipsPerGroupDay: number; reversalShare: number } {
  const groups = new Map<string, Ads1Row[]>();
  for (const r of rows) {
    const k = `${r.exchange}|${r.coin}|${r.timeframe}|${new Date(r.createdAt * 1000).toISOString().slice(0, 10)}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  let reversals = 0, pairs = 0;
  for (const g of groups.values()) {
    g.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 1; i < g.length; i++) {
      pairs++;
      if (g[i].side !== g[i - 1].side) reversals++;
    }
  }
  return {
    flipsPerGroupDay: groups.size ? reversals / groups.size : NaN,
    reversalShare: pairs ? reversals / pairs : NaN,
  };
}

export function coverageEmitted(rows: Ads1Row[], census: Census | null): CoverageEmitted {
  const edgeAt: TrimmedEdge[] = [1, 0.75, 0.5].map((keep) => {
    const { kept, minConfidence } = trimByConviction(rows, keep);
    const e: Edge = edge(kept);
    return {
      keep, achievedShare: rows.length ? kept.length / rows.length : NaN, minConfidence, n: kept.length,
      edgePp: e.edgePp, edgePpPooled: e.edgePpPooled, ciLbPp: e.cluster.ciLbPp,
    };
  });
  let coverage: number | null = null;
  let holdShare: number | null = null;
  let coverageReason: string | null = null;
  if (!census) coverageReason = 'NO_CENSUS';
  else if (!census.unitsCommensurate) coverageReason = 'COVERAGE_UNITS_INCOMMENSURATE';
  else {
    const all = census.signals + census.bandSignals + census.holdCounts;
    coverage = all ? (census.signals + census.bandSignals) / all : null;
    holdShare = all ? census.holdCounts / all : null;
  }
  const f = flipRate(rows);
  return { edgeAt, coverage, holdShare, coverageReason, census, ...f };
}

// ── L4 — payoff & cost ───────────────────────────────────────────────────────────────────────────

/** Break-even hit rate at a symmetric barrier B with round-trip cost c, both PERCENT: p* = ½ + c/(2B). */
export function breakEven(barrierPct: number, costPct: number): number {
  return 0.5 + costPct / (2 * barrierPct);
}

export function median(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface Payoff {
  medianBarrierPct: number;
  breakEvenTaker: number;
  breakEvenMaker: number;
  /** Mean of side-signed expiry return / barrier_pct over rows with an expiry (the R-multiple). */
  meanSignedExpiryRetR: number;
  nWithExpiry: number;
}

export function payoff(rows: Ads1Row[]): Payoff {
  const B = median(rows.map((r) => r.barrierPct));
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r.expiryRetPct === null || !Number.isFinite(r.expiryRetPct) || !(r.barrierPct > 0)) continue;
    sum += ((r.side === 'BUY' ? 1 : -1) * r.expiryRetPct) / r.barrierPct;
    n++;
  }
  return {
    medianBarrierPct: B,
    breakEvenTaker: breakEven(B, COST_TIERS_PCT.taker),
    breakEvenMaker: breakEven(B, COST_TIERS_PCT.maker),
    meanSignedExpiryRetR: n ? sum / n : NaN,
    nWithExpiry: n,
  };
}

// ── the cell verdict ─────────────────────────────────────────────────────────────────────────────

export type VerdictToken = 'NOT_IDENTIFIABLE' | 'AUDIT' | 'PROVISIONAL' | 'EXCEPTIONAL' | 'CREDIBLE' | 'NO_CLAIM';

export interface VerdictInput {
  identifiable: boolean;
  edgePp: number | null; // headline (per-day); null when under-clustered
  edgePpPooled: number;
  ciLbPp: number | null;
  tStat: number | null;
  nEff: number | null;
  dwrComplete: number;
  wilsonLb: number;
  liveDays: number;
  regimesCiLbAbove0: number;
  medianBarrierPct: number;
}

export interface Verdict {
  token: VerdictToken;
  reason: string;
  tradeable: 'taker' | 'maker' | 'none';
}

/**
 * Precedence, first match wins: NOT_IDENTIFIABLE → AUDIT → PROVISIONAL → EXCEPTIONAL → CREDIBLE → NO_CLAIM.
 * AUDIT reads the headline edge, or the pooled one when the headline is under-clustered, because an
 * implausible figure must be caught whichever aggregation produced it. PROVISIONAL covers both floors:
 * too few effective trials, or too few day-clusters for the headline to exist at all.
 */
export function verdict(v: VerdictInput): Verdict {
  const pTaker = breakEven(v.medianBarrierPct, COST_TIERS_PCT.taker);
  const pMaker = breakEven(v.medianBarrierPct, COST_TIERS_PCT.maker);
  const tradeable: Verdict['tradeable'] =
    Number.isFinite(v.wilsonLb) && v.wilsonLb >= pTaker ? 'taker' : Number.isFinite(v.wilsonLb) && v.wilsonLb >= pMaker ? 'maker' : 'none';
  if (!v.identifiable) return { token: 'NOT_IDENTIFIABLE', reason: 'identifiability', tradeable };
  const auditEdge = v.edgePp ?? v.edgePpPooled;
  if ((auditEdge >= BANDS.auditAbovePp && (v.nEff ?? 0) >= BANDS.auditMinNeff) || v.dwrComplete > BANDS.auditAboveHitRate) {
    return { token: 'AUDIT', reason: auditEdge >= BANDS.auditAbovePp ? 'edge-above-audit' : 'hit-rate-above-audit', tradeable };
  }
  if (v.nEff === null || v.nEff < N_EFF_FLOOR) return { token: 'PROVISIONAL', reason: 'n_eff-below-floor', tradeable };
  if (v.edgePp === null || v.ciLbPp === null) return { token: 'PROVISIONAL', reason: 'under-clustered', tradeable };
  if (
    v.edgePp >= BANDS.exceptional[0] && v.ciLbPp > 0 && (v.tStat ?? -Infinity) >= EXCEPTIONAL_MIN_T &&
    v.liveDays >= EXCEPTIONAL_MIN_LIVE_DAYS && v.regimesCiLbAbove0 >= EXCEPTIONAL_MIN_REGIMES
  ) {
    return { token: 'EXCEPTIONAL', reason: 'exceptional-band', tradeable };
  }
  if (v.edgePp >= BANDS.credible[0] && v.edgePp < BANDS.credible[1] && v.ciLbPp > 0) {
    return { token: 'CREDIBLE', reason: 'credible-band', tradeable };
  }
  return { token: 'NO_CLAIM', reason: 'no-claim', tradeable };
}

export function renderVerdict(v: Verdict): string {
  return `verdict: ${v.token}`;
}
