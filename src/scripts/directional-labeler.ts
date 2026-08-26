// directional-labeler.ts — EDGE-DWR-METRIC-SOT-W1
// PURE, unit-testable core of the symmetric triple-barrier labeler. No I/O, no network,
// no DB — the backfill orchestrator (backfill-directional-labels.ts) feeds it candles and
// persists the result. INTERNAL: labels are the same data class as outcome_return_pct.

import type { Candle } from '../types.js';

/** Vertical-barrier horizon (candles) per timeframe — the signal's PUBLISHED eval window,
 *  identical to backfill-outcomes.ts EVAL_CANDLES. 1m is intentionally ABSENT: the 1m lane
 *  was retired (OPS-1M-SEED-DECOM-W1) and the 3m floor is permanent, so 1m is never labeled. */
export const EVAL_CANDLES: Record<string, number> = {
  '3m': 12, '5m': 12, '15m': 12,
  '30m': 8, '1h': 8, '2h': 6, '4h': 6,
  '8h': 4, '12h': 4, '1d': 3,
};

/** Timeframe → milliseconds per candle (3m..1d; 1m excluded — retired lane). */
export const TF_MS: Record<string, number> = {
  '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

export const FLOOR_PCT = 0.3; // 0.30% ≈ 3× round-trip taker (2 × 0.05%); expressed in PERCENT

/**
 * Round-trip execution cost, PERCENT of price. DERIVED IN-ESTATE from `FLOOR_PCT`'s own stated
 * relationship above (0.30% ≈ 3× round-trip taker) rather than from training knowledge:
 * 0.30 / 3 = 0.10, i.e. 2 × 0.05% taker.
 *
 * CORROBORATED against the estate's MEASURED per-venue fee table — `backfill-funding-episodes.ts`
 * `META`, which the carry lane transcribes verbatim into `src/research/carry/costs.py:TAKER`:
 * BINANCE 0.0005, OKX 0.0005, GATE 0.0005, BYBIT 0.00055, HL 0.00045, ASTER 0.00035,
 * KUCOIN 0.0006. Binance taker is exactly 0.05%, so 2 × taker = 0.10%.
 *
 * ⚠️ DISCLOSED LIMIT, stated rather than hidden: this is FEES ONLY. The estate's own fuller
 * model is `rtCost = 2·taker + 2·halfSpread` (`funding-episode-builder.ts:77`), with
 * `halfSpread` measured at 0.5 bp for majors and 2 bp for alts
 * (`backfill-funding-episodes.ts:58`). That puts the true Binance round trip at 0.11% (majors)
 * to 0.14% (alts) — so 0.10 is a FLOOR, and any bar built on it is mildly PERMISSIVE on this
 * axis. A cell that fails against 0.10 fails against the truth a fortiori; a cell that passes
 * has not been shown to survive spread.
 *
 * WHY A SCALAR AND NOT THAT PER-VENUE MODEL: the DWR family's cell key is
 * `timeframe|tier|conf_bin|regime` — it carries neither venue nor coin, and pools all 17
 * venues — so a per-(venue, coin) cost is not expressible at the predicate site without
 * redefining the cell, which this wave's Must-NOT forbids. Named follow-up if ever wanted:
 * EDGE-DWR-VENUE-COST-CELL-W{NEXT}.
 *
 * Consumed by `dwr-baseline-report.ts` and handed to `validityVerdict()` in `edge-stats.ts`,
 * which stays dependency-free and therefore never imports this file.
 *
 * The `toFixed` is cosmetic and load-bearing only for the ARTIFACT: `0.3 / 3` is
 * 0.09999999999999999 in IEEE-754, which a reader of the emitted JSON reasonably reads as a bug.
 * It stays a DERIVATION rather than a second literal `0.10`, because the whole point is that
 * this number moves if `FLOOR_PCT` ever does. The rounding is ~1.4e-17 and cannot change any
 * comparison at this magnitude — `tests/unit/dwr-validity-predicate.test.ts` pins it to
 * `FLOOR_PCT / 3` to 12 decimal places so the derivation cannot silently drift into a literal.
 */
export const ROUND_TRIP_COST_PCT = Number((FLOOR_PCT / 3).toFixed(4));
export const SIGMA_TARGET_WINDOWS = 60; // trailing non-overlapping W-candle windows
export const SIGMA_MIN_WINDOWS = 30; // < this ⇒ low_vol_history (excluded from cell stats)

export type Ternary = -1 | 0 | 1;

export interface SigmaResult {
  sigma: number | null; // stdev of ln(close[t]/close[t−W]) as a FRACTION; null if < SIGMA_MIN_WINDOWS
  nWindows: number;
}

/**
 * σ_w = sample stdev of the log return over non-overlapping W-candle windows, taken from the
 * trailing end of `closesAsc` (oldest→newest, ending at/just before entry). Up to
 * SIGMA_TARGET_WINDOWS windows; null when fewer than SIGMA_MIN_WINDOWS are available.
 */
export function computeSigmaW(closesAsc: number[], W: number): SigmaResult {
  if (W <= 0 || closesAsc.length < W + 1) return { sigma: null, nWindows: 0 };
  const e = closesAsc.length - 1;
  const rets: number[] = [];
  for (let j = 0; j < SIGMA_TARGET_WINDOWS; j++) {
    const hi = e - j * W;
    const lo = e - (j + 1) * W;
    if (lo < 0) break;
    const a = closesAsc[hi];
    const b = closesAsc[lo];
    if (a > 0 && b > 0) rets.push(Math.log(a / b));
  }
  const n = rets.length;
  if (n < SIGMA_MIN_WINDOWS) return { sigma: null, nWindows: n };
  const mean = rets.reduce((s, x) => s + x, 0) / n;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1); // sample stdev
  return { sigma: Math.sqrt(variance), nWindows: n };
}

/** barrier_pct (PERCENT) = max(τ · σ_w, floor). σ_w passed as a FRACTION; null σ_w ⇒ floor. */
export function barrierPct(sigmaFraction: number | null, tau: number, floorPct = FLOOR_PCT): number {
  if (sigmaFraction == null) return floorPct;
  return Math.max(tau * sigmaFraction * 100, floorPct);
}

export interface RaceResult {
  label: Ternary; // +1 target-first / -1 adverse-first (incl. same-candle) / 0 timeout
  tHitCandles: number | null; // 1-indexed candle of first touch; null on timeout
  ambiguousCandle: boolean; // both barriers inside one candle → -1 conservative
  mfeReturnPct: number; // signed, price-perspective (matches signals.pfe_return_pct)
  maeReturnPct: number; // signed, price-perspective (matches signals.mae_return_pct)
}

/**
 * Symmetric triple-barrier race over the forward window. `barrierPctPercent` is in PERCENT.
 * BUY: target = upper (+bp), adverse = lower (−bp). SELL mirrors (target = lower).
 * Touch test uses candle high/low; same-candle both-barrier ⇒ −1 conservative + flag.
 * mfe/mae are computed over the FULL vertical window (matching backfill-outcomes.ts).
 */
export function runTripleBarrier(
  side: 'BUY' | 'SELL',
  entryPrice: number,
  forwardAsc: Candle[],
  barrierPctPercent: number,
  W: number,
): RaceResult {
  const frac = barrierPctPercent / 100;
  const upper = entryPrice * (1 + frac);
  const lower = entryPrice * (1 - frac);
  const isBuy = side === 'BUY';
  const scan = forwardAsc.slice(0, W);

  // mfe/mae over the FULL vertical window (price-perspective, matching backfill-outcomes.ts).
  let pfePrice = entryPrice;
  let maePrice = entryPrice;
  for (const c of scan) {
    if (isBuy) {
      if (c.high > pfePrice) pfePrice = c.high;
      if (c.low < maePrice) maePrice = c.low;
    } else {
      if (c.low < pfePrice) pfePrice = c.low;
      if (c.high > maePrice) maePrice = c.high;
    }
  }

  // First-touch race.
  let label: Ternary = 0;
  let tHit: number | null = null;
  let ambiguous = false;
  for (let i = 0; i < scan.length; i++) {
    const c = scan[i];
    const hitUpper = c.high >= upper;
    const hitLower = c.low <= lower;
    const hitTarget = isBuy ? hitUpper : hitLower;
    const hitAdverse = isBuy ? hitLower : hitUpper;
    if (hitTarget && hitAdverse) {
      label = -1; // same-candle ambiguity → conservative loss
      tHit = i + 1;
      ambiguous = true;
      break;
    }
    if (hitTarget) {
      label = 1;
      tHit = i + 1;
      break;
    }
    if (hitAdverse) {
      label = -1;
      tHit = i + 1;
      break;
    }
  }

  return {
    label,
    tHitCandles: tHit,
    ambiguousCandle: ambiguous,
    mfeReturnPct: ((pfePrice - entryPrice) / entryPrice) * 100,
    maeReturnPct: ((maePrice - entryPrice) / entryPrice) * 100,
  };
}

export interface LabelInput {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  timeframe: string;
  trailingClosesAsc: number[]; // closes ending at/just before entry (for σ_w)
  forwardAsc: Candle[]; // candles at/after entry (chronological)
  tau: number;
}
export interface LabelResult extends RaceResult {
  barrierPct: number; // PERCENT, as stored
  lowVolHistory: boolean;
  nSigmaWindows: number;
}

/** Compose σ_w → barrier_pct → triple-barrier race into a full label record. */
export function computeLabel(input: LabelInput): LabelResult {
  const { side, entryPrice, timeframe, trailingClosesAsc, forwardAsc, tau } = input;
  const W = EVAL_CANDLES[timeframe];
  if (!W) throw new Error(`computeLabel: no vertical window for timeframe '${timeframe}' (retired/unknown)`);
  const { sigma, nWindows } = computeSigmaW(trailingClosesAsc, W);
  const lowVolHistory = sigma == null;
  const bp = barrierPct(sigma, tau);
  const race = runTripleBarrier(side, entryPrice, forwardAsc, bp, W);
  return { ...race, barrierPct: bp, lowVolHistory, nSigmaWindows: nWindows };
}
