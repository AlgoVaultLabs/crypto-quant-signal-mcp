#!/usr/bin/env tsx
/**
 * backfill-outcomes.ts — v1.4: Multi-candle PFE/MAE outcome tracking.
 *
 * For each signal that needs backfill:
 *   1. Fetch candles from signal creation time forward
 *   2. Scan the evaluation window to compute:
 *      - outcome_price / outcome_return_pct  (final candle close in window)
 *      - PFE (Peak Favorable Excursion)      — best price in signal direction
 *      - MAE (Maximum Adverse Excursion)      — worst price against signal direction
 *      - pfe_candles                          — how many candles to reach PFE
 *
 * Evaluation windows (candles per timeframe):
 *   5m→12, 15m→12, 30m→8, 1h→8, 2h→6, 4h→6, 8h→4, 12h→4, 1d→3
 *   1m→12, 3m→12 (ultra-low TFs — noisy but tracked)
 *
 * Return % = (price - signal_price) / signal_price * 100
 * PFE: For BUY signals, highest high in window → favorable = up
 *       For SELL signals, lowest low in window → favorable = down
 * MAE: For BUY signals, lowest low in window → adverse = down
 *       For SELL signals, highest high in window → adverse = up
 *
 * Usage:
 *   npx tsx src/scripts/backfill-outcomes.ts       (local dev)
 *   node dist/scripts/backfill-outcomes.js          (production)
 */

import { getSignalsNeedingUnifiedBackfillAsync, updateSignalOutcomes, closeDb } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { Candle, SignalRecord } from '../types.js';

const DELAY_BETWEEN_FETCHES_MS = 300; // polite to HL API

/** Number of candles to evaluate per timeframe */
const EVAL_CANDLES: Record<string, number> = {
  '1m': 12, '3m': 12, '5m': 12, '15m': 12,
  '30m': 8, '1h': 8, '2h': 6, '4h': 6,
  '8h': 4, '12h': 4, '1d': 3,
};

/** Timeframe → milliseconds per candle */
const TF_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface PFEMAEResult {
  outcomePrice: number;
  outcomeReturnPct: number;
  return1candle: number;
  pfePrice: number;
  pfeReturnPct: number;
  maePrice: number;
  maeReturnPct: number;
  pfeCandles: number;
}

/**
 * Analyze candles to compute PFE/MAE for a signal.
 */
function computePFEMAE(
  signal: SignalRecord,
  candles: Candle[],
  evalCount: number
): PFEMAEResult | null {
  if (candles.length === 0) return null;

  // Take only the evaluation window's worth of candles
  const window = candles.slice(0, evalCount);
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

async function main() {
  console.log(`[${ts()}] Starting v1.4 PFE/MAE outcome backfill...`);

  const adapter = getAdapter();
  let filled = 0;
  let skipped = 0;
  let errors = 0;

  const signals = await getSignalsNeedingUnifiedBackfillAsync();
  if (signals.length === 0) {
    console.log(`[${ts()}] No signals need backfill.`);
    closeDb();
    return;
  }

  console.log(`[${ts()}] ${signals.length} signals need outcome backfill`);

  // Group signals by coin+timeframe to batch candle fetches
  const groups = new Map<string, SignalRecord[]>();
  for (const sig of signals) {
    const key = `${sig.coin}:${sig.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(sig);
  }

  console.log(`[${ts()}] Grouped into ${groups.size} coin/timeframe batches`);

  for (const [key, sigs] of groups) {
    const [coin, timeframe] = key.split(':');
    const evalCount = EVAL_CANDLES[timeframe] || 8;
    const candleMs = TF_MS[timeframe];
    if (!candleMs) {
      console.log(`[${ts()}] Unknown timeframe ${timeframe}, skipping ${sigs.length} signals`);
      skipped += sigs.length;
      continue;
    }

    // For each signal, fetch candles starting from signal creation time
    for (const sig of sigs) {
      try {
        const signalTimeMs = sig.created_at * 1000;
        // Need evalCount candles after signal time + 1 buffer
        const endTimeNeeded = signalTimeMs + (evalCount + 1) * candleMs;
        const now = Date.now();

        // Double-check: enough time has passed for full evaluation window
        if (now < endTimeNeeded) {
          skipped++;
          continue;
        }

        // Fetch candles from signal time forward
        const candles = await adapter.getCandles(coin, timeframe, signalTimeMs);

        // Filter candles: only those AFTER signal creation
        const relevantCandles = candles.filter(c => c.time >= signalTimeMs);

        if (relevantCandles.length < 1) {
          console.log(`[${ts()}] ${coin} ${sig.signal} [${timeframe}] — no candles after signal time, skipping`);
          skipped++;
          await sleep(DELAY_BETWEEN_FETCHES_MS);
          continue;
        }

        const result = computePFEMAE(sig, relevantCandles, evalCount);
        if (!result) {
          skipped++;
          await sleep(DELAY_BETWEEN_FETCHES_MS);
          continue;
        }

        await updateSignalOutcomes(sig.id!, {
          outcome_price: result.outcomePrice,
          outcome_return_pct: result.outcomeReturnPct,
          return_1candle: result.return1candle,
          pfe_price: result.pfePrice,
          pfe_return_pct: result.pfeReturnPct,
          mae_price: result.maePrice,
          mae_return_pct: result.maeReturnPct,
          pfe_candles: result.pfeCandles,
        });

        // Log with P&L perspective
        const isBuy = sig.signal === 'BUY';
        const pnlReturn = isBuy ? result.outcomeReturnPct : -result.outcomeReturnPct;
        const pfeDirection = isBuy ? result.pfeReturnPct : -result.pfeReturnPct;
        const maeDirection = isBuy ? result.maeReturnPct : -result.maeReturnPct;
        const dir = pnlReturn >= 0 ? '+' : '';
        const sigTime = new Date(sig.created_at * 1000).toISOString().slice(11, 16);

        console.log(
          `[${ts()}] ${coin} ${sig.signal} [${timeframe}] from ${sigTime} → ` +
          `outcome: ${dir}${pnlReturn.toFixed(2)}% | ` +
          `PFE: +${pfeDirection.toFixed(2)}% (candle ${result.pfeCandles}) | ` +
          `MAE: ${maeDirection.toFixed(2)}%`
        );
        filled++;
        await sleep(DELAY_BETWEEN_FETCHES_MS);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${ts()}] ${coin} ${sig.signal} [${timeframe}] backfill error: ${msg}`);
        errors++;
        await sleep(DELAY_BETWEEN_FETCHES_MS);
      }
    }
  }

  closeDb();
  console.log(`[${ts()}] Backfill complete: ${filled} filled, ${skipped} skipped (not ready), ${errors} errors.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
