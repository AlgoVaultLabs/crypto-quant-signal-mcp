#!/usr/bin/env tsx
/**
 * backfill-outcomes.ts — v1.3: Fill unified outcome for each signal at its own timeframe.
 *
 * Each signal is evaluated ONCE, at the interval matching its timeframe:
 *   - A 5m signal gets evaluated 5 minutes after creation
 *   - A 1h signal gets evaluated 1 hour after creation
 *   - A 4h signal gets evaluated 4 hours after creation
 *   - etc.
 *
 * Return % = (outcome_price - signal_price) / signal_price * 100
 * Note: raw return is stored (not inverted for SELL). The stats engine
 * handles SELL inversion when computing win rate and P&L.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-outcomes.ts       (local dev)
 *   node dist/scripts/backfill-outcomes.js          (production)
 */

import { getSignalsNeedingUnifiedBackfillAsync, updateUnifiedOutcome, closeDb } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';

const DELAY_BETWEEN_FETCHES_MS = 200; // polite to HL API

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`[${ts()}] Starting unified outcome backfill...`);

  const adapter = getAdapter();
  let filled = 0;
  let errors = 0;

  const signals = await getSignalsNeedingUnifiedBackfillAsync();
  if (signals.length === 0) {
    console.log(`[${ts()}] No signals need backfill.`);
    closeDb();
    return;
  }

  console.log(`[${ts()}] ${signals.length} signals need outcome backfill`);

  // Batch price fetches — deduplicate coins to minimize API calls
  const coinSet = [...new Set(signals.map(s => s.coin))];
  const priceMap = new Map<string, number>();

  for (const coin of coinSet) {
    try {
      const price = await adapter.getCurrentPrice(coin);
      if (price !== null) priceMap.set(coin, price);
      await sleep(DELAY_BETWEEN_FETCHES_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] Failed to fetch price for ${coin}: ${msg}`);
    }
  }

  for (const sig of signals) {
    try {
      const price = priceMap.get(sig.coin);
      if (price === undefined) continue;

      // Raw return (not inverted for SELL — stats engine handles that)
      const returnPct = ((price - sig.price_at_signal) / sig.price_at_signal) * 100;
      updateUnifiedOutcome(sig.id!, price, parseFloat(returnPct.toFixed(4)));

      // Log with P&L perspective (invert for SELL so humans read it right)
      const pnlReturn = sig.signal === 'SELL' ? -returnPct : returnPct;
      const direction = pnlReturn >= 0 ? '+' : '';
      const sigTime = new Date(sig.created_at * 1000).toISOString().slice(11, 16);
      console.log(
        `[${ts()}] ${sig.coin} ${sig.signal} [${sig.timeframe}] from ${sigTime} -> outcome: $${price.toLocaleString()} (${direction}${pnlReturn.toFixed(2)}%)`
      );
      filled++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ${sig.coin} [${sig.timeframe}] backfill error: ${msg}`);
      errors++;
    }
  }

  closeDb();
  console.log(`[${ts()}] Backfill complete: ${filled} outcomes filled, ${errors} errors.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
