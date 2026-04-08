import { getPerformanceStatsAsync, getSignalsNeedingUnifiedBackfillAsync, updateSignalOutcomes } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { Candle, PerformanceStats, SignalRecord } from '../types.js';

/** Timeframe → milliseconds per candle */
const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

/** Number of candles to evaluate per timeframe */
const EVAL_CANDLES: Record<string, number> = {
  '1m': 12, '3m': 12, '5m': 12, '15m': 12,
  '30m': 8, '1h': 8, '2h': 6, '4h': 6,
  '8h': 4, '12h': 4, '1d': 3,
};

/**
 * Run a lightweight backfill pass with PFE/MAE multi-candle tracking.
 * v1.4: fetches candle data for each pending signal and computes
 * outcome, PFE, and MAE across the evaluation window.
 * Called lazily on resource access — processes max 10 signals per call.
 */
export async function runBackfill(): Promise<void> {
  const adapter = getAdapter();

  try {
    const signals = await getSignalsNeedingUnifiedBackfillAsync();
    // Process max 10 per resource access to keep it lightweight
    const batch = signals.slice(0, 10);

    for (const sig of batch) {
      try {
        const candleMs = TF_MS[sig.timeframe];
        const evalCount = EVAL_CANDLES[sig.timeframe];
        if (!candleMs || !evalCount) continue;

        const signalTimeMs = sig.created_at * 1000;
        const endTimeNeeded = signalTimeMs + (evalCount + 1) * candleMs;
        if (Date.now() < endTimeNeeded) continue; // not ready yet

        const candles = await adapter.getCandles(sig.coin, sig.timeframe, signalTimeMs);
        const relevant = candles.filter(c => c.time >= signalTimeMs);
        if (relevant.length < 1) continue;

        const result = computePFEMAE(sig, relevant, evalCount);
        if (!result) continue;

        await updateSignalOutcomes(sig.id!, result);
      } catch {
        // Skip failed fetches silently — cron will pick them up
      }
    }
  } catch {
    // Skip backfill errors silently
  }
}

function computePFEMAE(
  signal: SignalRecord,
  candles: Candle[],
  evalCount: number
): { outcome_price: number; outcome_return_pct: number; pfe_price: number; pfe_return_pct: number; mae_price: number; mae_return_pct: number; pfe_candles: number } | null {
  const window = candles.slice(0, evalCount);
  if (window.length === 0) return null;

  const entry = signal.price_at_signal;
  const isBuy = signal.signal === 'BUY';

  const outcomePrice = window[window.length - 1].close;
  const outcomeReturnPct = ((outcomePrice - entry) / entry) * 100;

  let pfePrice = entry;
  let maePrice = entry;
  let pfeCandles = 0;

  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (isBuy) {
      if (c.high > pfePrice) { pfePrice = c.high; pfeCandles = i + 1; }
      if (c.low < maePrice) { maePrice = c.low; }
    } else {
      if (c.low < pfePrice) { pfePrice = c.low; pfeCandles = i + 1; }
      if (c.high > maePrice) { maePrice = c.high; }
    }
  }

  return {
    outcome_price: parseFloat(outcomePrice.toFixed(6)),
    outcome_return_pct: parseFloat(outcomeReturnPct.toFixed(4)),
    pfe_price: parseFloat(pfePrice.toFixed(6)),
    pfe_return_pct: parseFloat(((pfePrice - entry) / entry * 100).toFixed(4)),
    mae_price: parseFloat(maePrice.toFixed(6)),
    mae_return_pct: parseFloat(((maePrice - entry) / entry * 100).toFixed(4)),
    pfe_candles: pfeCandles,
  };
}

/**
 * Get signal performance stats (the MCP resource handler).
 * Backfill runs in the background — never blocks the response.
 */
export async function getSignalPerformance(): Promise<PerformanceStats> {
  // Fire-and-forget backfill — don't block the resource response
  runBackfill().catch(() => {});
  return getPerformanceStatsAsync();
}
