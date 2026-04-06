#!/usr/bin/env tsx
/**
 * seed-signals.ts — Emit trade signals for ALL Hyperliquid perps.
 *
 * Dynamically fetches the full HL universe, skips mixed-case symbols
 * (e.g. kPEPE) that break the uppercase coin lookup.
 *
 * Supports --timeframe flag for multi-timeframe seeding:
 *   --timeframe 1h   (default, idempotency window: 50 min)
 *   --timeframe 4h   (idempotency window: 3h 50min)
 *   --timeframe 1d   (idempotency window: 23h)
 *
 * Cron schedule:
 *   0 * * * *           1h (every hour)
 *   10 0,4,8,12,16,20 * * *  4h (every 4 hours, offset 10 min)
 *   20 0 * * *          1d (daily at 00:20)
 *
 * Usage:
 *   npx tsx src/scripts/seed-signals.ts                   (1h default)
 *   npx tsx src/scripts/seed-signals.ts --timeframe 4h
 *   node dist/scripts/seed-signals.js --timeframe 1d
 */

import { getTradeSignal } from '../tools/get-trade-signal.js';
import { hasRecentSignalAsync, closeDb } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { LicenseInfo } from '../types.js';

// Internal license bypasses free-tier gating
const INTERNAL_LICENSE: LicenseInfo = { tier: 'pro', key: 'internal-seed' };

const DELAY_BETWEEN_CALLS_MS = 500; // polite to HL public API

// Idempotency windows per timeframe (slightly less than the interval)
const IDEMPOTENCY_WINDOWS: Record<string, number> = {
  '1h': 50 * 60,         // 50 minutes
  '4h': 3 * 3600 + 50 * 60, // 3h 50min
  '1d': 23 * 3600,       // 23 hours
};

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs(): string {
  const idx = process.argv.indexOf('--timeframe');
  if (idx !== -1 && process.argv[idx + 1]) {
    const tf = process.argv[idx + 1];
    if (['1h', '4h', '1d'].includes(tf)) return tf;
    console.error(`Invalid timeframe: ${tf}. Use 1h, 4h, or 1d.`);
    process.exit(1);
  }
  return '1h';
}

/**
 * Fetch all uppercase coin symbols from Hyperliquid.
 * Excludes mixed-case symbols (kPEPE, kBONK, etc.) that break the
 * uppercase coin lookup in getTradeSignal.
 */
async function fetchAllCoins(): Promise<string[]> {
  const adapter = getAdapter();
  // getPredictedFundings returns all coins — but metaAndAssetCtxs is better
  // Use a direct HL API call to get the universe
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  const data = await res.json() as [{ universe: { name: string }[] }, unknown[]];
  const names = data[0].universe.map(a => a.name);

  // Filter: only uppercase symbols (skip kPEPE, kBONK, kSHIB, etc.)
  return names.filter(name => name === name.toUpperCase());
}

async function main() {
  const timeframe = parseArgs();
  const idempotencyWindow = IDEMPOTENCY_WINDOWS[timeframe] || 50 * 60;

  console.log(`[${ts()}] Fetching Hyperliquid universe...`);
  const coins = await fetchAllCoins();
  console.log(`[${ts()}] Starting ${timeframe} signal seed for ${coins.length} assets...`);

  let seeded = 0;
  let skipped = 0;
  let errors = 0;

  for (const coin of coins) {
    try {
      // Idempotency: skip if signal exists within the window
      const exists = await hasRecentSignalAsync(coin, timeframe, idempotencyWindow);
      if (exists) {
        skipped++;
        continue;
      }

      // Call the same scoring pipeline as the MCP tool (records to DB internally)
      const result = await getTradeSignal({
        coin,
        timeframe,
        includeReasoning: false,
        license: INTERNAL_LICENSE,
      });

      console.log(
        `[${ts()}] ${coin} -> ${result.signal} (${result.confidence}%) @ $${result.price.toLocaleString()} recorded`
      );
      seeded++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only log real errors, not "insufficient data" which is expected for illiquid coins
      if (msg.includes('Insufficient candle')) {
        skipped++;
      } else {
        console.error(`[${ts()}] ${coin} -> ERROR: ${msg}`);
        errors++;
      }
    }

    // Be polite to HL's public API
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  closeDb();
  console.log(`[${ts()}] Seed complete [${timeframe}]: ${seeded} seeded, ${skipped} skipped, ${errors} errors.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
