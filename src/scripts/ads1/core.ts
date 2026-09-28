// ads1/core.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R1: L0 (complete label), L1 (edge), nEff, identifiability.
//
// PURE. Every function takes rows it is handed and returns numbers; no env, no DB, no I/O, no feature
// column (a row carries the label, the side, the conviction and the stored price-path facts — never a
// scorer input).
//
// DEFINITIONS THAT ARE EASY TO GET WRONG, stated once:
//   * The COMPLETE label resolves a timeout by its expiry return in the called direction: ≥ +0.30 % WIN,
//     ≤ −0.30 % LOSS, else FLAT. A timeout has, by construction, |expiry| < barrier_pct — so a
//     floor-bound barrier (0.30 %) can only ever resolve FLAT. That is a property of the label, not a
//     defect. A timeout whose stored expiry is OUTSIDE its barrier is INCONSISTENT (the race was written
//     before its window closed, or a candle was revised): counted and excluded, never coerced.
//   * The NULL is mix-matched on the SAME rows (CLAUDE.md law): p0 = share_BUY·q_BUY + share_SELL·q_SELL,
//     q_side = what an always-side caller scores on those rows under the complete label. An ambiguous
//     same-candle race is a LOSS for BOTH sides (dwr-baseline.ts deriveRaceOutcome — D10); plain mirroring
//     would hand the opposite side a win the market never gave.
//   * The HEADLINE edge is the per-UTC-day unweighted cluster mean (CLAUDE.md: aggregate per cluster,
//     never pooled — D9), computed in dwr-cluster-edge.ts `clusterEdgeCompleteWithCi` together with its
//     day-cluster bootstrap lower bound. The pooled edge is printed beside it and is the quantity the
//     identity self-check pins.

import { deriveRaceOutcome, type Side } from '../dwr-baseline.js';
import { dwrFromLabels, pesaranTimmermann, wilsonInterval, type PtResult } from '../edge-stats.js';
import {
  clusterEdgeCompleteWithCi,
  type ClusterEdgeCompleteSummary,
  type CompleteOutcome,
  type CompleteRaceRow,
} from '../dwr-cluster-edge.js';
import {
  ALPHA_ONE_SIDED,
  BOOTSTRAP_B,
  BOOTSTRAP_SEED,
  FLAT_FLOOR_PCT,
  FRECHET_MIN_RANGE_PP,
  MINORITY_SIDE_FLOOR,
  Z_ONE_SIDED,
} from './spec.js';

export type { CompleteOutcome, Side };

/** One labelled emitted call, as the scorecard's allow-listed extract carries it. */
export interface Ads1Row {
  createdAt: number; // epoch seconds
  exchange: string;
  coin: string;
  timeframe: string;
  side: Side;
  confidence: number; // 52..100 on the emitted record
  label: number; // +1 / -1 / 0, side-relative (directional_labels.label)
  ambiguous: boolean;
  barrierPct: number; // PERCENT
  expiryRetPct: number | null; // PERCENT, price-perspective; null = unresolved
}

export const isScored = (o: CompleteOutcome): boolean => o === 'WIN' || o === 'LOSS';

/** L0 — the complete label of ONE call from its side's point of view. */
export function completeLabel(label: number, expiryRetPct: number | null, side: Side, barrierPct: number): CompleteOutcome {
  if (label === 1) return 'WIN';
  if (label === -1) return 'LOSS';
  if (label !== 0) return 'INCONSISTENT'; // not a ternary label — never coerced
  if (expiryRetPct === null || !Number.isFinite(expiryRetPct)) return 'UNRESOLVED';
  if (Math.abs(expiryRetPct) >= barrierPct) return 'INCONSISTENT';
  const directional = side === 'BUY' ? expiryRetPct : -expiryRetPct;
  if (directional >= FLAT_FLOOR_PCT) return 'WIN';
  if (directional <= -FLAT_FLOOR_PCT) return 'LOSS';
  return 'FLAT';
}

/** What an always-BUY and an always-SELL caller score on this row's race, under the complete label. */
export function sideOutcomes(r: Ads1Row): { BUY: CompleteOutcome; SELL: CompleteOutcome } {
  if (r.label === 0) {
    return {
      BUY: completeLabel(0, r.expiryRetPct, 'BUY', r.barrierPct),
      SELL: completeLabel(0, r.expiryRetPct, 'SELL', r.barrierPct),
    };
  }
  if (r.label !== 1 && r.label !== -1) return { BUY: 'INCONSISTENT', SELL: 'INCONSISTENT' };
  const o = deriveRaceOutcome(r.side, r.label, r.ambiguous);
  if (o === 'ambiguous') return { BUY: 'LOSS', SELL: 'LOSS' };
  if (o === 'upper') return { BUY: 'WIN', SELL: 'LOSS' };
  return { BUY: 'LOSS', SELL: 'WIN' };
}

/** The engine's own complete outcome — always equal to `completeLabel(label, expiry, side, barrier)`. */
export function engineOutcome(r: Ads1Row): CompleteOutcome {
  return sideOutcomes(r)[r.side];
}

export function toRaceRows(rows: Ads1Row[]): CompleteRaceRow[] {
  return rows.map((r) => {
    const o = sideOutcomes(r);
    return { createdAt: r.createdAt, side: r.side, buy: o.BUY, sell: o.SELL };
  });
}

export interface DwrDecided {
  wins: number;
  losses: number;
  timeouts: number;
  nDecided: number;
  dwr: number;
}

/** Today's decided DWR — `dwrFromLabels` semantics, reused unchanged (timeouts out of the denominator). */
export function dwrDecided(rows: Ads1Row[]): DwrDecided {
  return dwrFromLabels(rows.map((r) => r.label));
}

export interface DwrComplete {
  n: number;
  wins: number; // W′ — decided wins + timeouts resolved WIN
  losses: number; // L′
  flat: number;
  unresolved: number;
  inconsistent: number;
  timeouts: number;
  /** W′/(W′+L′); NaN when nothing is scored. */
  dwr: number;
  /** FLAT share of the rows that resolved (W′+L′+FLAT). */
  flatRate: number;
  /** Label-0 share of every row. */
  timeoutRate: number;
}

export function dwrComplete(rows: Ads1Row[]): DwrComplete {
  let wins = 0, losses = 0, flat = 0, unresolved = 0, inconsistent = 0, timeouts = 0;
  for (const r of rows) {
    if (r.label === 0) timeouts++;
    const o = engineOutcome(r);
    if (o === 'WIN') wins++;
    else if (o === 'LOSS') losses++;
    else if (o === 'FLAT') flat++;
    else if (o === 'UNRESOLVED') unresolved++;
    else inconsistent++;
  }
  const scored = wins + losses;
  const resolved = scored + flat;
  return {
    n: rows.length, wins, losses, flat, unresolved, inconsistent, timeouts,
    dwr: scored > 0 ? wins / scored : NaN,
    flatRate: resolved > 0 ? flat / resolved : NaN,
    timeoutRate: rows.length > 0 ? timeouts / rows.length : NaN,
  };
}

export interface MixMatchedNull {
  /** Scored rows (engine WIN or LOSS) — the only rows every term below is computed on. */
  n: number;
  /** Scored BUY rows (the integer the minority share is taken from). */
  buys: number;
  shareBuy: number;
  qBuy: number; // always-BUY complete hit rate on the scored rows
  qSell: number;
  p0: number;
}

/** L1's comparator. FLAT is side-invariant, so a FLAT row is out of every term, engine and null alike. */
export function mixMatchedNull(rows: Ads1Row[]): MixMatchedNull {
  let n = 0, buys = 0, buyWins = 0, sellWins = 0;
  for (const r of rows) {
    const o = sideOutcomes(r);
    if (!isScored(o[r.side])) continue;
    n++;
    if (r.side === 'BUY') buys++;
    if (o.BUY === 'WIN') buyWins++;
    if (o.SELL === 'WIN') sellWins++;
  }
  if (n === 0) return { n: 0, buys: 0, shareBuy: NaN, qBuy: NaN, qSell: NaN, p0: NaN };
  const shareBuy = buys / n;
  const qBuy = buyWins / n;
  const qSell = sellWins / n;
  return { n, buys, shareBuy, qBuy, qSell, p0: shareBuy * qBuy + (1 - shareBuy) * qSell };
}

export interface Edge {
  /** Headline: per-UTC-day unweighted cluster mean, pp; null when under-clustered. */
  edgePp: number | null;
  /** Pooled over every scored row, pp — the identity the self-check pins: (dwrComplete − p0)·100. */
  edgePpPooled: number;
  dwrComplete: number;
  p0: number;
  /** One-sided Wilson lower bound on dwrComplete (α = ALPHA_ONE_SIDED). */
  wilsonLb: number;
  cluster: ClusterEdgeCompleteSummary;
}

export function edge(rows: Ads1Row[]): Edge {
  const c = dwrComplete(rows);
  const nul = mixMatchedNull(rows);
  const scored = c.wins + c.losses;
  const w = wilsonInterval(c.wins, scored, Z_ONE_SIDED);
  const cluster = clusterEdgeCompleteWithCi(toRaceRows(rows), { alpha: ALPHA_ONE_SIDED, B: BOOTSTRAP_B, seed: BOOTSTRAP_SEED });
  return {
    edgePp: cluster.meanPp,
    edgePpPooled: (c.dwr - nul.p0) * 100,
    dwrComplete: c.dwr,
    p0: nul.p0,
    wilsonLb: scored > 0 ? w.lo : NaN,
    cluster,
  };
}

// ── nEff (D26: the estate's Kish convention, ported from cluster-perm-stats.py) ──────────────────

/** Σm² / Σm — the size-weighted mean cluster size (cluster-perm-stats.py `m_star`). */
export function mStar(sizes: number[]): number {
  const s = sizes.reduce((a, m) => a + m, 0);
  const ss = sizes.reduce((a, m) => a + m * m, 0);
  return s > 0 ? ss / s : 0;
}

/** (Σm)² / Σm² — Kish effective number of clusters (cluster-perm-stats.py `kish_eff`). */
export function kishEffClusters(sizes: number[]): number {
  const s = sizes.reduce((a, m) => a + m, 0);
  const ss = sizes.reduce((a, m) => a + m * m, 0);
  return ss > 0 ? (s * s) / ss : 0;
}

/** One-way ANOVA ICC(1), unequal sizes (cluster-perm-stats.py `icc_anova`), RAW (may be negative);
 *  null when undefined (< 2 clusters, no within-cluster df, or a non-positive denominator). */
export function iccAnova(values: number[], clusters: string[]): number | null {
  if (values.length !== clusters.length) throw new Error('iccAnova: values and clusters differ in length');
  const groups = new Map<string, number[]>();
  values.forEach((x, i) => {
    const g = groups.get(clusters[i]);
    if (g) g.push(x); else groups.set(clusters[i], [x]);
  });
  const k = groups.size;
  const N = values.length;
  if (k < 2 || N - k <= 0) return null;
  const grand = values.reduce((a, x) => a + x, 0) / N;
  let ssb = 0, ssw = 0, sq = 0;
  for (const g of groups.values()) {
    const ng = g.length;
    const mg = g.reduce((a, x) => a + x, 0) / ng;
    ssb += ng * (mg - grand) ** 2;
    ssw += g.reduce((a, x) => a + (x - mg) ** 2, 0);
    sq += ng * ng;
  }
  const msb = ssb / (k - 1);
  const msw = ssw / (N - k);
  const n0 = (N - sq / N) / (k - 1);
  const den = msb + (n0 - 1) * msw;
  if (den <= 0) return null;
  return (msb - msw) / den;
}

/** n / (1 + (m* − 1)·max(ρ, 0)) — ρ floored at 0 HERE ONLY, so nEff ≤ n always (D26). */
export function kishNEff(n: number, sizes: number[], rho: number): number {
  const deff = 1 + (mStar(sizes) - 1) * Math.max(rho, 0);
  return n / deff;
}

export interface NEff {
  n: number;
  nDays: number;
  rho: number | null; // raw
  mStar: number;
  /** Kish effective number of day-clusters, (Σm)²/Σm². */
  kishDays: number;
  nEff: number | null; // null when ρ is undefined
}

/** Effective trials of the scored rows, clustered by UTC day (the estate's independence unit). */
export function nEff(rows: Ads1Row[]): NEff {
  const hits: number[] = [];
  const days: string[] = [];
  for (const r of rows) {
    const o = engineOutcome(r);
    if (!isScored(o)) continue;
    hits.push(o === 'WIN' ? 1 : 0);
    days.push(new Date(r.createdAt * 1000).toISOString().slice(0, 10));
  }
  const sizes = [...days.reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map<string, number>()).values()];
  const rho = iccAnova(hits, days);
  return {
    n: hits.length,
    nDays: sizes.length,
    rho,
    mStar: mStar(sizes),
    kishDays: kishEffClusters(sizes),
    nEff: rho === null ? null : kishNEff(hits.length, sizes, rho),
  };
}

// ── identifiability (D27) ────────────────────────────────────────────────────────────────────────

/** Fréchet attainable width of the excess over the mix-matched null, pp — the binarised {up, not-up}
 *  bound of ops/monitoring/population_comparison.py `attainable_pp`, ported. */
export function frechetAttainablePp(shareBuy: number, pLong: number): number {
  const q = shareBuy;
  const dMax = Math.min(q * (1 - pLong), (1 - q) * pLong);
  const dMin = Math.max(-q * pLong, -(1 - q) * (1 - pLong));
  return 100 * 2 * (dMax - dMin);
}

export interface Identifiability {
  status: 'OK' | 'NOT_IDENTIFIABLE';
  reason: 'minority' | 'frechet' | 'no-scored-rows' | null;
  minorityShare: number;
  attainablePp: number;
  pt: PtResult;
}

export function identifiability(rows: Ads1Row[]): Identifiability {
  const nul = mixMatchedNull(rows);
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const r of rows) {
    const o = sideOutcomes(r);
    if (!isScored(o[r.side])) continue;
    // realized direction: up iff always-BUY won; down iff always-SELL won; both lost (ambiguous) = none
    const dir = o.BUY === 'WIN' ? 1 : o.SELL === 'WIN' ? -1 : 0;
    if (dir === 0) continue;
    predicted.push(r.side === 'BUY' ? 1 : -1);
    actual.push(dir);
  }
  const pt = pesaranTimmermann(predicted, actual);
  if (nul.n === 0) {
    return { status: 'NOT_IDENTIFIABLE', reason: 'no-scored-rows', minorityShare: NaN, attainablePp: NaN, pt };
  }
  // From the integer counts, never `1 − shareBuy`: in floating point 1 − 0.9 is 0.0999…98, which would
  // read an exact 10 % SELL minority as below the floor while the mirror 10 % BUY minority passes.
  const minorityShare = Math.min(nul.buys, nul.n - nul.buys) / nul.n;
  const attainablePp = frechetAttainablePp(nul.shareBuy, nul.qBuy);
  if (minorityShare < MINORITY_SIDE_FLOOR) return { status: 'NOT_IDENTIFIABLE', reason: 'minority', minorityShare, attainablePp, pt };
  if (attainablePp < FRECHET_MIN_RANGE_PP) return { status: 'NOT_IDENTIFIABLE', reason: 'frechet', minorityShare, attainablePp, pt };
  return { status: 'OK', reason: null, minorityShare, attainablePp, pt };
}
