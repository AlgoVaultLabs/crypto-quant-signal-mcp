#!/usr/bin/env tsx
/**
 * seed-signals.ts — Emit trade signals for Hyperliquid perps.
 *
 * Dynamically fetches the full HL universe, skips mixed-case symbols
 * (e.g. kPEPE) that break the uppercase coin lookup.
 *
 * Supports --timeframe and --top flags for multi-timeframe seeding:
 *   --timeframe 5m   (idempotency window: 4 min)
 *   --timeframe 15m  (default, idempotency window: 14 min)
 *   --timeframe 30m  (idempotency window: 28 min)
 *   --timeframe 1h   (idempotency window: 50 min)
 *   --timeframe 2h   (idempotency window: 1h 50min)
 *   --timeframe 4h   (idempotency window: 3h 50min)
 *   --timeframe 8h   (idempotency window: 7h 50min)
 *   --timeframe 12h  (idempotency window: 11h 50min)
 *   --timeframe 1d   (idempotency window: 23h)
 *   --top 50         (limit to top N by open interest, default: all)
 *
 * Cron schedule (recommended):
 *   * /15 * * * *          5m  --top 20
 *   * /15 * * * *          15m --top 50
 *   * /30 * * * *          30m --top 50
 *   0 * * * *              1h  (all)
 *   30 0,2,...,22 * * *    2h  --top 50
 *   10 0,4,8,12,16,20      4h  (all)
 *   40 0,8,16              8h  --top 50
 *   50 0,12                12h --top 50
 *   20 0 * * *             1d  (all)
 *
 * Usage:
 *   npx tsx src/scripts/seed-signals.ts                         (15m default, all)
 *   npx tsx src/scripts/seed-signals.ts --timeframe 4h
 *   npx tsx src/scripts/seed-signals.ts --timeframe 5m --top 20
 *   node dist/scripts/seed-signals.js --timeframe 1d
 */

import { getTradeSignal } from '../tools/get-trade-signal.js';
import { hasRecentSignalAsync, closeDb } from '../lib/performance-db.js';
import { classifyAsset, warmTierCaches } from '../lib/asset-tiers.js';
import type { LicenseInfo } from '../types.js';

// Internal license bypasses free-tier gating
const INTERNAL_LICENSE: LicenseInfo = { tier: 'pro', key: 'internal-seed' };

const DELAY_BETWEEN_CALLS_MS = 500; // polite to HL public API

// Idempotency windows per timeframe (slightly less than the interval)
const IDEMPOTENCY_WINDOWS: Record<string, number> = {
  '5m':  4 * 60,            // 4 minutes
  '15m': 14 * 60,           // 14 minutes
  '30m': 28 * 60,           // 28 minutes
  '1h':  50 * 60,           // 50 minutes
  '2h':  110 * 60,          // 1h 50min
  '4h':  3 * 3600 + 50 * 60, // 3h 50min
  '8h':  7 * 3600 + 50 * 60, // 7h 50min
  '12h': 11 * 3600 + 50 * 60, // 11h 50min
  '1d':  23 * 3600,         // 23 hours
};

const VALID_TIMEFRAMES = Object.keys(IDEMPOTENCY_WINDOWS);

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function parseArgs(): { timeframe: string; top: number } {
  const args = process.argv.slice(2);

  let timeframe = '15m';
  const tfIdx = args.indexOf('--timeframe');
  if (tfIdx !== -1 && args[tfIdx + 1]) {
    const tf = args[tfIdx + 1];
    if (VALID_TIMEFRAMES.includes(tf)) {
      timeframe = tf;
    } else {
      console.error(`Invalid timeframe: ${tf}. Use one of: ${VALID_TIMEFRAMES.join(', ')}`);
      process.exit(1);
    }
  }

  let top = 0; // 0 = all
  const topIdx = args.indexOf('--top');
  if (topIdx !== -1 && args[topIdx + 1]) {
    const n = parseInt(args[topIdx + 1]);
    if (isNaN(n) || n <= 0) {
      console.error(`Invalid --top value: ${args[topIdx + 1]}. Must be a positive integer.`);
      process.exit(1);
    }
    top = n;
  }

  return { timeframe, top };
}

interface HLAssetInfo {
  name: string;
  notionalOI: number; // OI in USD (openInterest * markPx)
}

/**
 * Fetch all uppercase coin symbols from Hyperliquid (standard + xyz TradFi perps),
 * sorted by notional OI descending.
 * Uses markPx × openInterest for proper USD ranking (raw OI is in coins, not dollars).
 * Excludes mixed-case symbols (kPEPE, kBONK, etc.) that break the uppercase coin lookup.
 */
async function fetchAllCoins(topN: number): Promise<string[]> {
  // Fetch standard perps and xyz (TradFi) perps in parallel
  const [stdRes, xyzRes] = await Promise.all([
    fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    }),
    fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }),
    }).catch(() => null), // xyz fetch is best-effort
  ]);

  const stdData = await stdRes.json() as [{ universe: { name: string }[] }, { openInterest: string; markPx: string }[]];

  // Build standard perp assets
  const assets: HLAssetInfo[] = stdData[0].universe.map((u, i) => ({
    name: u.name,
    notionalOI: parseFloat(stdData[1][i]?.openInterest || '0') * parseFloat(stdData[1][i]?.markPx || '0'),
  }));

  // Add xyz (TradFi) perps if available
  if (xyzRes && xyzRes.ok) {
    try {
      const xyzData = await xyzRes.json() as [{ universe: { name: string }[] }, { openInterest: string; markPx: string }[]];
      const xyzAssets: HLAssetInfo[] = xyzData[0].universe
        .map((u, i) => ({
          name: u.name,
          notionalOI: parseFloat(xyzData[1][i]?.openInterest || '0') * parseFloat(xyzData[1][i]?.markPx || '0'),
        }))
        .filter(a => a.notionalOI > 0); // skip unlisted/zero-OI xyz assets
      assets.push(...xyzAssets);
    } catch { /* ignore xyz parse errors */ }
  }

  // Filter: only uppercase symbols (skip kPEPE, kBONK, kSHIB, etc.)
  const filtered = assets.filter(a => a.name === a.name.toUpperCase());

  // Sort by notional OI descending (USD value)
  filtered.sort((a, b) => b.notionalOI - a.notionalOI);

  // Apply top N limit if specified
  const limited = topN > 0 ? filtered.slice(0, topN) : filtered;

  return limited.map(a => a.name);
}

async function main() {
  const { timeframe, top } = parseArgs();
  const idempotencyWindow = IDEMPOTENCY_WINDOWS[timeframe] || 50 * 60;

  console.log(`[${ts()}] Warming tier caches (xyz symbols, OI rankings)...`);
  await warmTierCaches();

  console.log(`[${ts()}] Fetching Hyperliquid universe (standard + TradFi)...`);
  const coins = await fetchAllCoins(top);
  console.log(`[${ts()}] Starting ${timeframe} signal seed for ${coins.length} assets${top ? ` (top ${top} by OI)` : ''}...`);

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
      // Only log real errors, not "insufficient data" or liquidity gates which are expected
      if (msg.includes('Insufficient candle') || msg.includes('insufficient liquidity')) {
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
