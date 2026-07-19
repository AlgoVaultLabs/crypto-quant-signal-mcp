/**
 * PFE/MAE evaluator — THE canonical definition.
 *
 * OPS-PFE-MAE-EXTRACTION-W1. Extracted verbatim (behaviour-preserving) from the two
 * divergent module-private copies that previously lived at
 * `src/scripts/backfill-outcomes.ts:72` and `src/resources/signal-performance.ts:64`.
 * Both now delegate here, so the single-derivation LAW holds for the metric that
 * produces the PUBLIC PFE win rate.
 *
 * The two originals were arithmetically identical but textually divergent (one returned
 * camelCase via a named interface, the other snake_case via an inline type; one carried an
 * extra empty-input early return; local names and hoisting differed). This module keeps the
 * camelCase shape and exposes `toSignalOutcomeUpdate()` for the snake_case persistence
 * shape, so the mapping is single-derived too.
 *
 * ── SEMANTICS WORTH KNOWING BEFORE YOU CHANGE ANYTHING ──
 *
 * PFE is a peak *favourable* excursion: `pfePrice` is initialised to the entry price and
 * updated ONLY on improvement. It is therefore ONE-SIDED BY CONSTRUCTION — for a BUY,
 * `pfeReturnPct >= 0` always; for a SELL, `<= 0` always. There is no input for which PFE
 * moves adversely.
 *
 * The consequence, measured live 2026-07-19 over 343,478 evaluated rows: ZERO rows exist
 * where PFE moved against the signal, and so
 *
 *     PFE win rate  ===  1 - P(pfe_return_pct = 0)
 *
 * exactly, to 4 decimal places, in both directions. The "win rate" is really a favourable-
 * excursion / evaluation-coverage rate, NOT a measure of directional edge — it cannot
 * register a directional loss. Do not build a gate, CI, or A/B decision rule on it without
 * reading `audits/EDGE-SELL-GATE-REGIME-W1-endpoint-truth.md`, which closed a wave on
 * exactly that mistake.
 *
 * Related known issue (open, tracked by OPS-PFE-METRIC-INTEGRITY-W1): a `pfe_return_pct = 0`
 * row conflates a genuine no-favourable-move loss with a FROZEN MARKET — several venues emit
 * zero-volume synthetic flat bars (OHLC all equal, `volume = 0`) for non-trading books rather
 * than omitting the bar, and a window entirely inside such a stretch scores
 * `pfe = mae = 0`. `Candle.volume` is available on every input here and is currently NOT
 * consulted; that is the seam the fix lands in.
 */

import type { Candle, SignalRecord } from '../types.js';

/** Number of candles to evaluate per timeframe. */
export const EVAL_CANDLES: Record<string, number> = {
  '1m': 12, '3m': 12, '5m': 12, '15m': 12,
  '30m': 8, '1h': 8, '2h': 6, '4h': 6,
  '8h': 4, '12h': 4, '1d': 3,
};

/** Timeframe → milliseconds per candle. */
export const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

export interface PFEMAEResult {
  outcomePrice: number;
  outcomeReturnPct: number;
  return1candle: number;
  pfePrice: number;
  pfeReturnPct: number;
  maePrice: number;
  maeReturnPct: number;
  pfeCandles: number;
}

/** The snake_case shape `updateSignalOutcomes` persists. */
export interface SignalOutcomeUpdate {
  outcome_price: number;
  outcome_return_pct: number;
  return_1candle: number;
  pfe_price: number;
  pfe_return_pct: number;
  mae_price: number;
  mae_return_pct: number;
  pfe_candles: number;
}

/**
 * Analyze candles to compute PFE/MAE for a signal.
 *
 * Returns `null` when there is nothing to evaluate (no candles, or an empty window after
 * slicing) — callers treat that as "skip, leave the row NULL", which is why a failed or
 * empty fetch does NOT produce a zero-scored row.
 */
export function computePFEMAE(
  signal: SignalRecord,
  candles: Candle[],
  evalCount: number
): PFEMAEResult | null {
  if (candles.length === 0) return null;

  // Take only the evaluation window's worth of candles. Sort a copy
  // oldest-first before slicing — slice(0, N) on a newest-first venue payload
  // would evaluate the wrong end of the window (EdgeX kline-order class).
  const window = [...candles].sort((a, b) => a.time - b.time).slice(0, evalCount);
  if (window.length === 0) return null;

  const entryPrice = signal.price_at_signal;
  const isBuy = signal.signal === 'BUY';

  // Outcome = close of the last candle in the evaluation window
  const outcomePrice = window[window.length - 1].close;
  const outcomeReturnPct = ((outcomePrice - entryPrice) / entryPrice) * 100;

  // v1.4.1: 1-candle return — direction-adjusted (positive = correct direction)
  const firstClose = window[0].close;
  const raw1c = ((firstClose - entryPrice) / entryPrice) * 100;
  const return1candle = isBuy ? raw1c : -raw1c;

  // PFE: best price in signal direction
  // MAE: worst price against signal direction
  let pfePrice = entryPrice;
  let maePrice = entryPrice;
  let pfeCandles = 0;

  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (isBuy) {
      // BUY: favorable = up (high), adverse = down (low)
      if (c.high > pfePrice) {
        pfePrice = c.high;
        pfeCandles = i + 1;
      }
      if (c.low < maePrice) {
        maePrice = c.low;
      }
    } else {
      // SELL: favorable = down (low), adverse = up (high)
      if (c.low < pfePrice) {
        pfePrice = c.low;
        pfeCandles = i + 1;
      }
      if (c.high > maePrice) {
        maePrice = c.high;
      }
    }
  }

  // PFE/MAE return percentages — always from entry price perspective
  const pfeReturnPct = ((pfePrice - entryPrice) / entryPrice) * 100;
  const maeReturnPct = ((maePrice - entryPrice) / entryPrice) * 100;

  return {
    outcomePrice: parseFloat(outcomePrice.toFixed(6)),
    outcomeReturnPct: parseFloat(outcomeReturnPct.toFixed(4)),
    return1candle: parseFloat(return1candle.toFixed(4)),
    pfePrice: parseFloat(pfePrice.toFixed(6)),
    pfeReturnPct: parseFloat(pfeReturnPct.toFixed(4)),
    maePrice: parseFloat(maePrice.toFixed(6)),
    maeReturnPct: parseFloat(maeReturnPct.toFixed(4)),
    pfeCandles,
  };
}

/**
 * Project the canonical camelCase result onto the snake_case shape the DB writer takes.
 * Single-derived so the two persistence call sites cannot drift apart again.
 */
export function toSignalOutcomeUpdate(r: PFEMAEResult): SignalOutcomeUpdate {
  return {
    outcome_price: r.outcomePrice,
    outcome_return_pct: r.outcomeReturnPct,
    return_1candle: r.return1candle,
    pfe_price: r.pfePrice,
    pfe_return_pct: r.pfeReturnPct,
    mae_price: r.maePrice,
    mae_return_pct: r.maeReturnPct,
    pfe_candles: r.pfeCandles,
  };
}
