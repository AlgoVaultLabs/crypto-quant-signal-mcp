// dwr-baseline.ts — EDGE-DWR-METRIC-SOT-W1 (R5) pure core.
// Cell aggregation + benchmark derivation for the Directional Win Rate baseline report.
// Pure + unit-tested; the DB I/O + JSON emission live in dwr-baseline-report.ts.

import { dwrFromLabels, wilsonInterval, pesaranTimmermann, type PtResult } from './edge-stats.js';

export type Side = 'BUY' | 'SELL';
export type RaceOutcome = 'upper' | 'lower' | 'timeout' | 'ambiguous';

export interface LabelRow {
  side: Side;
  label: number; // +1 / -1 / 0 (side-adjusted)
  ambiguous: boolean;
  coin: string;
  createdAt: number; // unix seconds
  /** `directional_labels.barrier_pct` — the race's barrier half-width, PERCENT of price.
   *  REQUIRED, not optional: the validity predicate's magnitude conditions are expressed in
   *  return space, and an optional field would let a caller silently omit it and receive an
   *  INPUT_NOT_MEASURABLE rejection that looks like a market verdict. */
  barrierPct: number;
}

/** Side-independent race outcome, reconstructed from the side-adjusted label. */
export function deriveRaceOutcome(side: Side, label: number, ambiguous: boolean): RaceOutcome {
  if (label === 0) return 'timeout';
  if (ambiguous) return 'ambiguous';
  if (side === 'BUY') return label === 1 ? 'upper' : 'lower';
  return label === 1 ? 'lower' : 'upper'; // SELL mirror
}

export interface Benchmarks {
  alwaysBuyDwr: number; // uppers / (uppers + lowers + ambiguous)
  alwaysSellDwr: number; // lowers / (uppers + lowers + ambiguous)
  uppers: number;
  lowers: number;
  ambiguous: number;
}

/** Empirical always-BUY / always-SELL DWR from the SAME races (computed, not complements). */
export function benchmarks(rows: LabelRow[]): Benchmarks {
  let uppers = 0, lowers = 0, ambiguous = 0;
  for (const r of rows) {
    const o = deriveRaceOutcome(r.side, r.label, r.ambiguous);
    if (o === 'upper') uppers++;
    else if (o === 'lower') lowers++;
    else if (o === 'ambiguous') ambiguous++;
  }
  const denom = uppers + lowers + ambiguous;
  return {
    alwaysBuyDwr: denom > 0 ? uppers / denom : NaN,
    alwaysSellDwr: denom > 0 ? lowers / denom : NaN,
    uppers, lowers, ambiguous,
  };
}

/** PT (predicted side-sign vs actual race-direction) over CLEAN decided calls (excl. timeout + ambiguous). */
export function ptOverRows(rows: LabelRow[]): PtResult {
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const r of rows) {
    const o = deriveRaceOutcome(r.side, r.label, r.ambiguous);
    if (o !== 'upper' && o !== 'lower') continue; // exclude timeout + ambiguous (no clean direction)
    predicted.push(r.side === 'BUY' ? 1 : -1);
    actual.push(o === 'upper' ? 1 : -1);
  }
  return pesaranTimmermann(predicted, actual);
}

/** First (earliest) call per symbol — serial-dependence control (cell is already one timeframe). */
export function firstPerCoin(rows: LabelRow[]): LabelRow[] {
  const best = new Map<string, LabelRow>();
  for (const r of rows) {
    const cur = best.get(r.coin);
    if (!cur || r.createdAt < cur.createdAt) best.set(r.coin, r);
  }
  return [...best.values()];
}

/**
 * Median of a numeric sample; NaN for an empty one (matching every other statistic here, which
 * yields NaN rather than a plausible zero when there is nothing to measure).
 * EXPORTED for the unit test — it is the only new statistic-shaped helper in this wave, and it
 * is a SELECTION, not a derivation: no distributional assumption, no estimator choice.
 */
export function medianOf(xs: number[]): number {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface CellStats {
  n: number; // all labeled rows in the cell (excl. low_vol_history, applied upstream)
  decided: number; // wins + losses (timeouts excluded)
  wins: number;
  losses: number;
  timeouts: number;
  timeoutRate: number;
  dwr: number;
  ambiguousRate: number;
  alwaysBuyDwr: number;
  alwaysSellDwr: number;
  benchmark: number; // max(alwaysBuy, alwaysSell)
  edge: number; // dwr − benchmark
  wilsonLo: number;
  wilsonHi: number;
  ptAll: PtResult; // (a) all decided
  ptNonOverlap: PtResult; // (b) first-per-coin subsample
  constantSide: boolean; // all-BUY or all-SELL predictions → PT undefined
  /** MEDIAN barrier half-width over the cell's rows, PERCENT of price. Median rather than mean
   *  for ROBUSTNESS first: barrier width is strongly right-skewed within a cell (measured on
   *  `5m|rest|c60_74|RANGING` at τ=0.5 — median 0.3944, mean 1.0097, max 19.7528, with 35.6% of
   *  rows pinned at the 0.30 floor), so a mean would let a handful of unusually wide races carry
   *  the magnitude test. It is also the tighter bar; both arguments point the same way. */
  barrierPctMedian: number;
}

export function computeCellStats(rows: LabelRow[]): CellStats {
  const labels = rows.map((r) => r.label);
  const d = dwrFromLabels(labels);
  const bench = benchmarks(rows);
  const benchmark = Math.max(bench.alwaysBuyDwr, bench.alwaysSellDwr);
  const wi = wilsonInterval(d.wins, d.nDecided);
  const ambiguousCount = rows.filter((r) => r.ambiguous).length;
  const nBuy = rows.filter((r) => r.side === 'BUY').length;
  return {
    n: rows.length,
    decided: d.nDecided,
    wins: d.wins,
    losses: d.losses,
    timeouts: d.timeouts,
    timeoutRate: rows.length > 0 ? d.timeouts / rows.length : NaN,
    dwr: d.dwr,
    ambiguousRate: rows.length > 0 ? ambiguousCount / rows.length : NaN,
    alwaysBuyDwr: bench.alwaysBuyDwr,
    alwaysSellDwr: bench.alwaysSellDwr,
    benchmark,
    edge: d.dwr - benchmark,
    wilsonLo: wi.lo,
    wilsonHi: wi.hi,
    ptAll: ptOverRows(rows),
    ptNonOverlap: ptOverRows(firstPerCoin(rows)),
    constantSide: nBuy === 0 || nBuy === rows.length,
    barrierPctMedian: medianOf(rows.map((r) => r.barrierPct)),
  };
}
