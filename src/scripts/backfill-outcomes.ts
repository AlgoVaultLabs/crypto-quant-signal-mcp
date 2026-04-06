#!/usr/bin/env tsx
/**
 * backfill-outcomes.ts — Fill in 1h/4h/24h outcome prices for recorded signals.
 *
 * For each signal missing an outcome:
 *   - If emitted >= 1h ago and missing 1h outcome -> fill with current price
 *   - If emitted >= 4h ago and missing 4h outcome -> fill with current price
 *   - If emitted >= 24h ago and missing 24h outcome -> fill with current price
 *
 * Return % = (outcome_price - signal_price) / signal_price * 100
 * Note: raw return is stored (not inverted for SELL). The stats engine
 * handles SELL inversion when computing win rate and P&L.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-outcomes.ts       (local dev)
 *   node dist/scripts/backfill-outcomes.js          (production)
 */

import { getSignalsNeedingBackfillAsync, updateOutcome, closeDb } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';

const DELAY_BETWEEN_FETCHES_MS = 200; // polite to HL API

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`[${ts()}] Starting outcome backfill...`);

  const adapter = getAdapter();
  const horizons = [1, 4, 24] as const;
  let filled = 0;
  let errors = 0;

  for (const h of horizons) {
    const signals = await getSignalsNeedingBackfillAsync(h);
    if (signals.length === 0) {
      console.log(`[${ts()}] ${h}h horizon: 0 signals need backfill`);
      continue;
    }

    console.log(`[${ts()}] ${h}h horizon: ${signals.length} signals need backfill`);

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

        const field = `price_after_${h}h` as const;
        const retField = `return_pct_${h}h` as const;
        updateOutcome(sig.id!, field, price, retField, parseFloat(returnPct.toFixed(4)));

        // Log with P&L perspective (invert for SELL so humans read it right)
        const pnlReturn = sig.signal === 'SELL' ? -returnPct : returnPct;
        const direction = pnlReturn >= 0 ? '+' : '';
        const sigTime = new Date(sig.created_at * 1000).toISOString().slice(11, 16);
        console.log(
          `[${ts()}] ${sig.coin} ${sig.signal} from ${sigTime} -> ${h}h outcome: $${price.toLocaleString()} (${direction}${pnlReturn.toFixed(2)}%)`
        );
        filled++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${ts()}] ${sig.coin} ${h}h backfill error: ${msg}`);
        errors++;
      }
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
