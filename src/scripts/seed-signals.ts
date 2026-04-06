#!/usr/bin/env tsx
/**
 * seed-signals.ts — Emit trade signals for top 10 HL perps and record to performance DB.
 *
 * Runs hourly via cron. Calls the same scoring logic as get_trade_signal,
 * bypassing license gates (internal pro license).
 *
 * Idempotent: skips coins that already have a signal within the last 50 minutes.
 *
 * Usage:
 *   npx tsx src/scripts/seed-signals.ts          (local dev)
 *   node dist/scripts/seed-signals.js            (production)
 */

import { getTradeSignal } from '../tools/get-trade-signal.js';
import { hasRecentSignalAsync, closeDb } from '../lib/performance-db.js';
import type { LicenseInfo } from '../types.js';

// Top 10 Hyperliquid perps by OI (most liquid)
// Top 10 Hyperliquid perps by OI (most liquid)
// Note: PEPE is listed as kPEPE on Hyperliquid
const TOP_10 = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'WIF', 'kPEPE', 'SUI', 'AVAX', 'LINK'];

// Internal license bypasses free-tier gating
const INTERNAL_LICENSE: LicenseInfo = { tier: 'pro', key: 'internal-seed' };

const IDEMPOTENCY_WINDOW_SEC = 50 * 60; // 50 minutes
const DELAY_BETWEEN_CALLS_MS = 500;     // polite to HL public API

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`[${ts()}] Starting signal seed for ${TOP_10.length} assets...`);

  let seeded = 0;
  let skipped = 0;
  let errors = 0;

  for (const coin of TOP_10) {
    try {
      // Idempotency: skip if signal exists within last 50 min
      const exists = await hasRecentSignalAsync(coin, '1h', IDEMPOTENCY_WINDOW_SEC);
      if (exists) {
        console.log(`[${ts()}] ${coin} -> skipped (recent signal exists)`);
        skipped++;
        continue;
      }

      // Call the same scoring pipeline as the MCP tool (records to DB internally)
      const result = await getTradeSignal({
        coin,
        timeframe: '1h',
        includeReasoning: false,
        license: INTERNAL_LICENSE,
      });

      console.log(
        `[${ts()}] ${coin} -> ${result.signal} (${result.confidence}%) @ $${result.price.toLocaleString()} recorded`
      );
      seeded++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${ts()}] ${coin} -> ERROR: ${msg}`);
      errors++;
    }

    // Be polite to HL's public API
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  closeDb();
  console.log(`[${ts()}] Seed complete: ${seeded} seeded, ${skipped} skipped, ${errors} errors.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
