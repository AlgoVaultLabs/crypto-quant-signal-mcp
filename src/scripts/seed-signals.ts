#!/usr/bin/env tsx
/**
 * seed-signals.ts — Emit trade signals for Hyperliquid + Binance perps.
 *
 * Dynamically fetches the full HL universe and Binance top-50 USDT-M pairs,
 * skips mixed-case symbols that break uppercase coin lookup.
 *
 * Supports --timeframe, --top, and --exchange flags:
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
 *   --exchange HL       (Hyperliquid only)
 *   --exchange BINANCE  (Binance only)
 *   --exchange BYBIT    (Bybit only)
 *   --exchange OKX      (OKX only)
 *   --exchange BITGET   (Bitget only)
 *   --exchange ALL      (all 5 exchanges, default)
 *
 * Usage:
 *   npx tsx src/scripts/seed-signals.ts                         (15m default, all exchanges)
 *   npx tsx src/scripts/seed-signals.ts --timeframe 4h
 *   npx tsx src/scripts/seed-signals.ts --exchange BINANCE --timeframe 1h
 *   npx tsx src/scripts/seed-signals.ts --timeframe 5m --top 20
 *   node dist/scripts/seed-signals.js --timeframe 1d
 */

import { getTradeSignal } from '../tools/get-trade-signal.js';
import { hasRecentSignalAsync, closeDb, getTradFiPfeWinRate } from '../lib/performance-db.js';
import { classifyAsset, warmTierCaches, isKnownTradFi } from '../lib/asset-tiers.js';
import type { LicenseInfo, ExchangeId } from '../types.js';

// Internal license bypasses free-tier gating
const INTERNAL_LICENSE: LicenseInfo = { tier: 'pro', key: 'internal-seed' };

const DELAY_BETWEEN_CALLS_MS = 500; // polite to public APIs

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

function parseArgs(): { timeframe: string; top: number; exchanges: ExchangeId[] } {
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

  let exchanges: ExchangeId[] = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];
  const exIdx = args.indexOf('--exchange');
  if (exIdx !== -1 && args[exIdx + 1]) {
    const ex = args[exIdx + 1].toUpperCase();
    const validSingle: Record<string, ExchangeId> = {
      'HL': 'HL', 'BINANCE': 'BINANCE', 'BYBIT': 'BYBIT', 'OKX': 'OKX', 'BITGET': 'BITGET',
    };
    if (ex === 'ALL') {
      exchanges = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];
    } else if (validSingle[ex]) {
      exchanges = [validSingle[ex]];
    } else {
      console.error(`Invalid exchange: ${ex}. Use HL, BINANCE, BYBIT, OKX, BITGET, or ALL.`);
      process.exit(1);
    }
  }

  return { timeframe, top, exchanges };
}

interface HLAssetInfo {
  name: string;
  notionalOI: number; // OI in USD (openInterest * markPx)
}

/**
 * Fetch all uppercase coin symbols from Hyperliquid (standard + xyz TradFi perps),
 * sorted by notional OI descending.
 */
async function fetchHLCoins(topN: number): Promise<string[]> {
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
    }).catch(() => null),
  ]);

  const stdData = await stdRes.json() as [{ universe: { name: string }[] }, { openInterest: string; markPx: string }[]];

  const assets: HLAssetInfo[] = stdData[0].universe.map((u, i) => ({
    name: u.name,
    notionalOI: parseFloat(stdData[1][i]?.openInterest || '0') * parseFloat(stdData[1][i]?.markPx || '0'),
  }));

  if (xyzRes && xyzRes.ok) {
    try {
      const xyzData = await xyzRes.json() as [{ universe: { name: string }[] }, { openInterest: string; markPx: string }[]];
      const xyzAssets: HLAssetInfo[] = xyzData[0].universe
        .map((u, i) => ({
          name: u.name.replace(/^xyz:/i, ''),
          notionalOI: parseFloat(xyzData[1][i]?.openInterest || '0') * parseFloat(xyzData[1][i]?.markPx || '0'),
        }))
        .filter(a => a.notionalOI > 0);
      assets.push(...xyzAssets);
    } catch { /* ignore xyz parse errors */ }
  }

  const filtered = assets.filter(a => a.name === a.name.toUpperCase());
  filtered.sort((a, b) => b.notionalOI - a.notionalOI);

  let limited = topN > 0 ? filtered.slice(0, topN) : filtered;

  // Always include TradFi assets regardless of top-N cutoff
  if (topN > 0) {
    const limitedNames = new Set(limited.map(a => a.name));
    const tradfiMissed = filtered.filter(a =>
      !limitedNames.has(a.name) && isKnownTradFi(a.name)
    );
    if (tradfiMissed.length > 0) {
      limited = [...limited, ...tradfiMissed];
    }
  }

  return limited.map(a => a.name);
}

/**
 * Fetch top-50 Binance USDT-M pairs by 24h quote volume.
 */
async function fetchBinanceTopCoins(limit: number = 50): Promise<string[]> {
  const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const data = await res.json() as Array<{ symbol: string; quoteVolume: string }>;

  const usdtPairs = data
    .filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit);

  const knownOverrides: Record<string, string> = {
    '1000PEPE': 'PEPE', '1000SHIB': 'SHIB', '1000FLOKI': 'FLOKI',
    '1000BONK': 'BONK', '1000LUNC': 'LUNC', '1000XEC': 'XEC',
    '1000SATS': 'SATS', '1000RATS': 'RATS', '1000CAT': 'CAT',
    '1000CHEEMS': 'CHEEMS', '1000WHINE': 'WHINE', '1000APU': 'APU',
    '1000X': 'X', '1000MOGCOIN': 'MOGCOIN',
  };

  return usdtPairs.map(t => {
    const coin = t.symbol.replace(/USDT$/, '');
    return knownOverrides[coin] || coin;
  });
}

/**
 * Fetch top-50 Bybit USDT linear pairs by 24h turnover.
 */
async function fetchBybitTopCoins(limit: number = 50): Promise<string[]> {
  const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const data = await res.json() as { result: { list: Array<{ symbol: string; turnover24h: string }> } };
  return (data.result?.list || [])
    .filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
    .slice(0, limit)
    .map(t => t.symbol.replace(/USDT$/, ''));
}

/**
 * Fetch top-50 OKX USDT-SWAP pairs by 24h volume.
 */
async function fetchOKXTopCoins(limit: number = 50): Promise<string[]> {
  const res = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
  const data = await res.json() as { data: Array<{ instId: string; volCcy24h: string }> };
  return (data.data || [])
    .filter(t => t.instId.endsWith('-USDT-SWAP'))
    .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
    .slice(0, limit)
    .map(t => t.instId.replace(/-USDT-SWAP$/, ''));
}

/**
 * Fetch top-50 Bitget USDT-FUTURES pairs by 24h quote volume.
 */
async function fetchBitgetTopCoins(limit: number = 50): Promise<string[]> {
  const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  const data = await res.json() as { data: Array<{ symbol: string; quoteVolume: string }> };
  return (data.data || [])
    .filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map(t => t.symbol.replace(/USDT$/, ''));
}

async function seedExchange(
  exchangeId: ExchangeId,
  coins: string[],
  timeframe: string,
  idempotencyWindow: number
): Promise<{ seeded: number; skipped: number; errors: number }> {
  let seeded = 0;
  let skipped = 0;
  let errors = 0;

  for (const coin of coins) {
    try {
      const exists = await hasRecentSignalAsync(coin, timeframe, idempotencyWindow, exchangeId);
      if (exists) {
        skipped++;
        continue;
      }

      const result = await getTradeSignal({
        coin,
        timeframe,
        includeReasoning: false,
        exchange: exchangeId,
        license: INTERNAL_LICENSE,
      });

      console.log(
        `[${ts()}] [${exchangeId}] ${coin} -> ${result.signal} (${result.confidence}%) @ $${result.price.toLocaleString()} recorded`
      );
      seeded++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Insufficient candle') || msg.includes('insufficient liquidity') || msg.includes('not found')) {
        skipped++;
      } else {
        console.error(`[${ts()}] [${exchangeId}] ${coin} -> ERROR: ${msg}`);
        errors++;
      }
    }

    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  return { seeded, skipped, errors };
}

async function main() {
  const { timeframe, top, exchanges } = parseArgs();
  const idempotencyWindow = IDEMPOTENCY_WINDOWS[timeframe] || 50 * 60;

  const totals = { seeded: 0, skipped: 0, errors: 0 };

  // ── Seed Hyperliquid ──
  if (exchanges.includes('HL')) {
    console.log(`[${ts()}] Warming tier caches (xyz symbols, OI rankings)...`);
    await warmTierCaches();

    console.log(`[${ts()}] Fetching Hyperliquid universe (standard + TradFi)...`);
    let coins = await fetchHLCoins(top);

    // TradFi Conditional Gate
    const allTradFi = coins.filter(c => isKnownTradFi(c));
    if (allTradFi.length > 0) {
      const { winRate, evaluated } = await getTradFiPfeWinRate(allTradFi);
      if (evaluated === 0) {
        console.log(`[${ts()}] TradFi gate: no evaluated signals yet — seeding full universe (${allTradFi.length} TradFi assets)`);
      } else if (winRate >= 85) {
        console.log(`[${ts()}] TradFi PFE WR: ${winRate.toFixed(1)}% (${evaluated} evaluated) — seeding full universe`);
      } else {
        const topTradFi = new Set(allTradFi.slice(0, 20));
        const beforeCount = coins.length;
        coins = coins.filter(c => !isKnownTradFi(c) || topTradFi.has(c));
        console.log(`[${ts()}] TradFi PFE WR: ${winRate.toFixed(1)}% (below 85%) — limiting to Top ${topTradFi.size} TradFi (dropped ${beforeCount - coins.length} assets)`);
      }
    }

    console.log(`[${ts()}] Starting ${timeframe} HL signal seed for ${coins.length} assets${top ? ` (top ${top} by OI)` : ''}...`);
    const result = await seedExchange('HL', coins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] HL seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    totals.seeded += result.seeded;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  // ── Seed Binance ──
  if (exchanges.includes('BINANCE')) {
    console.log(`[${ts()}] Fetching Binance top-50 USDT-M pairs by volume...`);
    const binCoins = await fetchBinanceTopCoins(50);
    console.log(`[${ts()}] Starting ${timeframe} BINANCE signal seed for ${binCoins.length} assets...`);
    const result = await seedExchange('BINANCE', binCoins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] BINANCE seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    totals.seeded += result.seeded;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  // ── Seed Bybit ──
  if (exchanges.includes('BYBIT')) {
    console.log(`[${ts()}] Fetching Bybit top-50 USDT linear pairs by turnover...`);
    const bybitCoins = await fetchBybitTopCoins(50);
    console.log(`[${ts()}] Starting ${timeframe} BYBIT signal seed for ${bybitCoins.length} assets...`);
    const result = await seedExchange('BYBIT', bybitCoins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] BYBIT seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    totals.seeded += result.seeded;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  // ── Seed OKX ──
  if (exchanges.includes('OKX')) {
    console.log(`[${ts()}] Fetching OKX top-50 USDT-SWAP pairs by volume...`);
    const okxCoins = await fetchOKXTopCoins(50);
    console.log(`[${ts()}] Starting ${timeframe} OKX signal seed for ${okxCoins.length} assets...`);
    const result = await seedExchange('OKX', okxCoins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] OKX seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    totals.seeded += result.seeded;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  // ── Seed Bitget ──
  if (exchanges.includes('BITGET')) {
    console.log(`[${ts()}] Fetching Bitget top-50 USDT-FUTURES pairs by volume...`);
    const bitgetCoins = await fetchBitgetTopCoins(50);
    console.log(`[${ts()}] Starting ${timeframe} BITGET signal seed for ${bitgetCoins.length} assets...`);
    const result = await seedExchange('BITGET', bitgetCoins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] BITGET seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    totals.seeded += result.seeded;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  closeDb();
  console.log(`[${ts()}] All exchanges done [${timeframe}]: ${totals.seeded} seeded, ${totals.skipped} skipped, ${totals.errors} errors.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  closeDb();
  process.exit(1);
});
