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
import { getDexForCoin } from '../lib/asset-tiers.js';
import { runAsBatch, runAsCaller, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import type { ExchangeId, SignalRecord } from '../types.js';
import { computePFEMAE, toSignalOutcomeUpdate, EVAL_CANDLES, TF_MS } from '../lib/pfe-mae.js';

const DELAY_BETWEEN_FETCHES_MS = 300; // polite to HL API

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // OPS-HL-RATELIMITER-W2: backfill is bulk → run in `batch` weight class so its
  // HL candle fetches wait behind the shared budget and yield the interactive reserve.
  return runAsBatch(async () => {
  console.log(`[${ts()}] Starting v1.4 PFE/MAE outcome backfill (looping until queue empty)...`);

  let totalFilled = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let batchNum = 0;

  // Track symbols that consistently fail — skip them after 3 errors to avoid queue clogging
  const failCounts = new Map<string, number>();
  const MAX_FAIL_PER_SYMBOL = 3;

  // Loop until no more signals need backfill
  while (true) {
    batchNum++;
    let filled = 0;
    let skipped = 0;
    let errors = 0;

    const signals = await getSignalsNeedingUnifiedBackfillAsync();
    if (signals.length === 0) {
      console.log(`[${ts()}] No more signals need backfill.`);
      break;
    }

    // Filter out signals for symbols that have failed too many times
    const viable = signals.filter(s => {
      const failKey = `${s.exchange || 'HL'}:${s.coin}`;
      return (failCounts.get(failKey) || 0) < MAX_FAIL_PER_SYMBOL;
    });

    if (viable.length === 0) {
      const blockedCount = signals.length;
      console.log(`[${ts()}] ${blockedCount} signals remain but all from permanently-failing symbols. Stopping.`);
      break;
    }

    console.log(`[${ts()}] Batch ${batchNum}: ${viable.length} viable of ${signals.length} pending signals`);

    // Group signals by coin+timeframe to batch candle fetches
    const groups = new Map<string, SignalRecord[]>();
    for (const sig of viable) {
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
        // Re-check fail count (may have been incremented within this batch)
        const failKey = `${sig.exchange || 'HL'}:${coin}`;
        if ((failCounts.get(failKey) || 0) >= MAX_FAIL_PER_SYMBOL) {
          skipped++;
          continue;
        }

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

          // Fetch candles from signal's own exchange
          const exchangeId = (sig.exchange as ExchangeId) || 'HL';
          const adapter = getAdapter(exchangeId);
          const dex = exchangeId === 'HL' ? getDexForCoin(coin) : undefined;
          // OPS-HL-SEED-LOAD-W1: bound the fetch to the eval window (+2 buffer).
          // We only consume evalCount candles after signalTime (computePFEMAE
          // filters time>=signalTime then slices evalCount) — fetching to-now
          // pulled ~5000 candles (HL weight ~104) for ~8 needed. Outcome unchanged.
          const fetchEndTime = signalTimeMs + (evalCount + 2) * candleMs;
          const candles = await adapter.getCandles(coin, timeframe, signalTimeMs, dex, fetchEndTime);

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

          await updateSignalOutcomes(sig.id!, toSignalOutcomeUpdate(result));

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
          if (err instanceof WeightBudgetSkipError) {
            // OPS-HL-RATELIMITER-W2: transient budget saturation — count as a
            // skip, NOT a symbol failure (do not touch failCounts or errors).
            // The next loop / 3-min cron fire retries this signal.
            skipped++;
            await sleep(DELAY_BETWEEN_FETCHES_MS);
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const fc = (failCounts.get(failKey) || 0) + 1;
          failCounts.set(failKey, fc);
          if (fc <= MAX_FAIL_PER_SYMBOL) {
            console.error(`[${ts()}] ${coin} ${sig.signal} [${timeframe}] backfill error (${fc}/${MAX_FAIL_PER_SYMBOL}): ${msg}`);
          }
          if (fc === MAX_FAIL_PER_SYMBOL) {
            console.log(`[${ts()}] Blocking ${failKey} — failed ${MAX_FAIL_PER_SYMBOL} times, skipping remaining signals`);
          }
          errors++;
          await sleep(DELAY_BETWEEN_FETCHES_MS);
        }
      }
    }

    totalFilled += filled;
    totalSkipped += skipped;
    totalErrors += errors;
    console.log(`[${ts()}] Batch ${batchNum} done: ${filled} filled, ${skipped} skipped, ${errors} errors. Checking for more...`);

    // If everything in this batch was skipped (not ready yet), stop looping
    if (filled === 0 && errors === 0) {
      console.log(`[${ts()}] All remaining signals are not ready yet. Stopping.`);
      break;
    }

    // Pause between batches to avoid hammering the DB
    await sleep(2000);
  }

  closeDb();
  console.log(`[${ts()}] Backfill complete: ${totalFilled} filled, ${totalSkipped} skipped (not ready), ${totalErrors} errors across ${batchNum} batch(es).`);
  });
}

runAsCaller('backfill', main).catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
