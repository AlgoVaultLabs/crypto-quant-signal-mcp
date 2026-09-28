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
/**
 * The three barrier specifications, primary first. ONE literal set for every writer and reader that
 * lives in this repo — `backfill-directional-labels.ts` writes them, `src/scripts/ads1/spec.ts` reads
 * them (EDGE-ADS1-SCORECARD-W1-V2 CH2, D1: "import, never retype"). The primary string is also
 * `FRESHNESS_BARRIER_SPEC` in `src/lib/venue-slo-tiers.ts`; a test pins the two equal.
 */
export const BARRIER_SPECS = [
  { tau: 1.0, spec: 'tau1.0-floor0.30-v1' },
  { tau: 0.5, spec: 'tau0.5-floor0.30-v1' },
  { tau: 2.0, spec: 'tau2.0-floor0.30-v1' },
] as const;

/**
 * The Postgres DDL of `directional_labels`, the copy the labeler applies idempotently before it writes
 * (`ensureTable`). `migrations/019_directional_labels.sql` + `migrations/043_directional_labels_expiry.sql`
 * are the schema-as-code SoT; `tests/unit/directional-labels-ddl-parity.test.ts` and
 * `dist/scripts/ads1/ddl-parity-check.js` assert both copies name the same columns, so they cannot drift.
 *
 * `ret_at_expiry_pct` (EDGE-ADS1-SCORECARD-W1-V2 CH2, ruling Q2 = A): the return at the vertical
 * barrier — close of the W-th forward candle over the entry price, PERCENT, PRICE-perspective (not
 * side-signed; the same convention as `signals.outcome_return_pct`). Additive and NULLABLE: NULL means
 * "not resolved", never zero. A fact about the price path, not a label; no existing column changes.
 */
export const DIRECTIONAL_LABELS_DDL_PG = `
    CREATE TABLE IF NOT EXISTS directional_labels (
      signal_id        INTEGER NOT NULL,
      barrier_spec     TEXT NOT NULL,
      label            SMALLINT NOT NULL,
      ambiguous_candle BOOLEAN NOT NULL DEFAULT FALSE,
      low_vol_history  BOOLEAN NOT NULL DEFAULT FALSE,
      t_hit_candles    INT,
      mfe_return_pct   DOUBLE PRECISION,
      mae_return_pct   DOUBLE PRECISION,
      barrier_pct      DOUBLE PRECISION NOT NULL,
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (signal_id, barrier_spec)
    );
    CREATE INDEX IF NOT EXISTS idx_dirlabels_spec_signal ON directional_labels (barrier_spec, signal_id);
    ALTER TABLE directional_labels ADD COLUMN IF NOT EXISTS ret_at_expiry_pct DOUBLE PRECISION;
  `;

/**
 * The return at the vertical barrier, or `null` when it cannot be known from what is in hand.
 *
 * `forwardAsc` holds the candles whose OPEN time is at/after the entry, ascending (the labeler's own
 * window). The vertical-barrier candle is the W-th forward candle BY TIME: the first one must open within
 * one period of the entry, and the W-th must open exactly (W−1) periods after it. Its close over
 * `entryPrice` is the expiry return, in PERCENT, price-perspective. The position in the array is never
 * trusted on its own — a cache with a missing candle (measured 2026-09-28: the group cache's extension
 * start `coveredUntil + tf` is off the candle grid, so the one candle opening inside that step is never
 * fetched) would otherwise hand back a LATER candle's close, sometimes one that closes after the seal
 * or was still forming at fetch time. A window that is not contiguous is `null`, not a guess.
 *
 * `fetchedNotBeforeMs` is an instant no later than the moment the candles were fetched (the labeler
 * passes the time it STARTED the group, before any fetch). The W-th forward candle closes no later than
 * `entryMs + (W+1)·tf`; if that instant is after the fetch, the candle may still have been forming and
 * its close would be a live price — so the answer is `null`, not a guess. The same `(W+1)·tf` bound is
 * `T_CAP`'s race-end embargo and `pfe-mae.ts` `maturityHorizonMs`.
 */
export function expiryReturnPct(
  forwardAsc: Candle[],
  W: number,
  entryPrice: number,
  entryMs: number,
  tfMs: number,
  fetchedNotBeforeMs: number,
): number | null {
  if (!(W > 0) || !(tfMs > 0) || !(entryPrice > 0)) return null;
  if (forwardAsc.length < W) return null;
  if (entryMs + (W + 1) * tfMs > fetchedNotBeforeMs) return null;
  const first = forwardAsc[0].time;
  if (!(first >= entryMs && first < entryMs + tfMs)) return null; // not the first candle after the entry
  if (forwardAsc[W - 1].time - first !== (W - 1) * tfMs) return null; // a missing candle inside the window
  const close = forwardAsc[W - 1].close;
  if (!Number.isFinite(close) || close <= 0) return null;
  return (close / entryPrice - 1) * 100;
}

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
