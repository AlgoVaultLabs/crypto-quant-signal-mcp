#!/usr/bin/env tsx
/**
 * seed-signals.ts — Emit trade signals across 5 exchanges.
 *
 * Dynamically fetches tradeable universe per exchange (sorted by OI),
 * seeds signals via getTradeSignal(), and stores results in performance DB.
 *
 * Supports --timeframe, --top, --exchange, and --exchange-list flags:
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
 *   --exchange HL       (Hyperliquid only — single-venue shorthand for 5 PROMOTED venues)
 *   --exchange BINANCE  (Binance only)
 *   --exchange BYBIT    (Bybit only)
 *   --exchange OKX      (OKX only)
 *   --exchange BITGET   (Bitget only)
 *   --exchange ALL      (all 5 PROMOTED venues, default)
 *   --exchange-list <EX1,EX2,...> (OPS-3M-EXPAND-W2-PART-A 2026-05-22):
 *                       comma-separated subset of the 17-value ExchangeId
 *                       union. Mutually exclusive with --exchange. Accepts
 *                       both PROMOTED (HL/BINANCE/BYBIT/OKX/BITGET) and
 *                       SHADOW (ASTER/EDGEX/GATE/MEXC/KUCOIN/PHEMEX/BINGX/
 *                       HTX/WEEX/BITMART/XT/WHITEBIT) venues — the
 *                       meme-liquidity gate handles shadow venues via
 *                       SHADOW_VENUE_PERMISSIVE_PASS short-circuit. Designed
 *                       for staggered cron entries that scope to a venue
 *                       subset (e.g. CEX-only top-50 line alongside an HL-
 *                       only line on a different schedule).
 *
 * Usage:
 *   npx tsx src/scripts/seed-signals.ts                         (15m default, all exchanges)
 *   npx tsx src/scripts/seed-signals.ts --timeframe 4h
 *   npx tsx src/scripts/seed-signals.ts --exchange BINANCE --timeframe 1h
 *   npx tsx src/scripts/seed-signals.ts --timeframe 5m --top 20
 *   npx tsx src/scripts/seed-signals.ts --exchange-list BINANCE,BYBIT,OKX,BITGET --timeframe 3m --top 50
 *   node dist/scripts/seed-signals.js --timeframe 1d
 */

import { getTradeSignal } from '../tools/get-trade-call.js';
import { hasRecentSignalAsync, closeDb, bulkWarmFundingCache } from '../lib/performance-db.js';
import { classifyAsset, warmTierCaches, isKnownTradFi } from '../lib/asset-tiers.js';
import { getTicker24hrFullCoalesced } from '../lib/adapters/binance.js';
import type { LicenseInfo, ExchangeId, VenueStatus } from '../types.js';
import { listVenues, stampSeedingStarted } from '../lib/venue-store.js';

// Internal license bypasses free-tier gating
const INTERNAL_LICENSE: LicenseInfo = { tier: 'pro', key: 'internal-seed' };

// Per-exchange delay between API calls (ms)
const DELAY_PER_EXCHANGE: Record<ExchangeId, number> = {
  // OPS-HL-RATELIMIT-W1 (2026-05-22): bumped 500 → 750ms as safety margin
  // alongside adapter-layer metaAndAssetCtxs coalescing (hyperliquid.ts).
  // Coalescing collapses redundant per-coin universe fetches (~50% load cut);
  // 750ms cushions against residual burst stacking when 1m/3m/5m/15m HL crons
  // overlap at 15-min boundaries. 750ms × 20 coins = 15s/fire (well within
  // 3m cadence); 750ms × ~230-coin 15m HL top-100 fire = ~173s (acceptable).
  'HL':      750,  // polite to public API — 60s/min budget cushion
  // OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): bumped 200 → 400ms as defense-in-
  // depth alongside adapter-layer bulk-coalescing (binance.ts ticker24hr +
  // premiumIndex). Coalescing cuts per-fire weight 290 → 200 (top-50); polite-
  // delay bump doubles burst spread (10s → 20s for top-50) so minute-boundary
  // overlap windows have less concentrated weight rate. 400ms × 50 = 20s
  // (well within 5m cadence); 400ms × 100 = 40s for top-100 (within 15m).
  // Pre-fix observed burst: 1835-1846 weight (76-77% cap) in 1.7s at
  // 2026-05-22T13:13:58. Post-fix target: <50% sustained, <90% projected top-50.
  'BINANCE': 400,
  'BYBIT':   200,  // 50 req/sec
  'OKX':     150,  // 10 req/sec — keep margin
  'BITGET':  200,  // 20-50 req/sec
  // PILOT-ADAPTERS-W1 / C1 (2026-05-16): ASTER added to ExchangeId union →
  // Record<ExchangeId, number> requires the key. Conservative default 300ms.
  // The seed loop below does NOT yet have an `if (exchanges.includes('ASTER'))`
  // branch — ASTER is callable via explicit `get_trade_call({exchange:'ASTER'})`
  // but won't auto-accumulate from this cron until follow-up wave extends
  // the seed-loop branches. Tracked as PILOT-ADAPTERS-SEED-LOOP-W2 (deferred).
  'ASTER':   300,
  // PILOT-ADAPTERS-W1 / C2 (2026-05-16): EDGEX shadow venue. Same scope
  // deferral as ASTER — Record<ExchangeId, number> key required for type-
  // system compat; seed-loop branch is OUT of C2 scope (PILOT-ADAPTERS-
  // SEED-LOOP-W2 follow-up). Slightly higher delay (400ms) because edgeX
  // has no published rate-limit budget; conservative throttle for unknown.
  'EDGEX':   400,
  // PILOT-ADAPTERS-W2 / C1 (2026-05-19): GATE shadow venue. Same scope
  // deferral as ASTER/EDGEX — Record<ExchangeId, number> key required for
  // type-system compat; seed-loop branch is OUT of C1 scope per Scope Rule
  // (deferred to PILOT-ADAPTERS-SEED-LOOP-W2). Conservative 300ms delay.
  'GATE':    300,
  // PILOT-ADAPTERS-W2 / C2 (2026-05-19): MEXC shadow venue. Same deferral
  // as ASTER/EDGEX/GATE — Record<ExchangeId, number> key required for
  // type-system compat; seed-loop branch deferred to PILOT-ADAPTERS-SEED-
  // LOOP-W2. MEXC has aggressive listing cadence (881 perps), conservative
  // 350ms delay.
  'MEXC':    350,
  // PILOT-ADAPTERS-W2 / C3 (2026-05-19): KUCOIN shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  'KUCOIN':  300,
  // PILOT-ADAPTERS-W3A / C1 (2026-05-20): PHEMEX shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  // Phemex hedged USDT-M perpetual (perpProductsV2, 538 USDT-listed). Per-
  // endpoint rate limit not documented in primary docs; conservative 300ms.
  'PHEMEX':  300,
  // PILOT-ADAPTERS-W3A / C2 (2026-05-20): BINGX shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  // BingX Swap V2 USDT-M perpetual (638 USDT-listed). Rate-limit upgrade
  // 2025-10-16 (per primary docs); conservative 300ms.
  'BINGX':   300,
  // PILOT-ADAPTERS-W3A / C3 (2026-05-20): HTX shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  // HTX (formerly Huobi) Linear USDT-Margined Swap (233 USDT-listed). Most-
  // generous rate limit of W3A batch (800req/s per-IP market data); 200ms.
  'HTX':     200,
  // PILOT-ADAPTERS-W3B / C1 (2026-05-20): WEEX shadow venue. cmt_ prefix + 4h funding.
  'WEEX':    300,
  // PILOT-ADAPTERS-W3B / C2 (2026-05-20): BITMART shadow venue. Binance-style symbol BTCUSDT; 8h cadence.
  'BITMART': 300,
  // PILOT-ADAPTERS-W3B / C3 (2026-05-20): XT shadow venue. Lowercase btc_usdt; 8h cadence.
  'XT':      300,
  // PILOT-ADAPTERS-W3B / C4 (2026-05-20): WHITEBIT shadow venue. _PERP suffix + 8h cadence; EU-regulated.
  'WHITEBIT':300,
};

// Idempotency windows per timeframe (slightly less than the interval)
const IDEMPOTENCY_WINDOWS: Record<string, number> = {
  '1m':  50,                // 50 seconds (SHADOW-SEED-W1: shadow-mode TF)
  '3m':  2 * 60,            // 2 minutes (SHADOW-SEED-W1: shadow-mode TF)
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

/**
 * SHADOW-SEED-W1 (2026-04-30): shadow-mode timeframes whose signals are
 * collected into the DB but stripped from `byTimeframe` aggregation in the
 * public `/api/performance-public` response unless the env flag
 * `SHADOW_REVEAL_TIMEFRAMES` includes them. The 2-week digest decides
 * whether to flip the public filter.
 */
export const SHADOW_TIMEFRAMES = ['1m', '3m'] as const;

const VALID_TIMEFRAMES = Object.keys(IDEMPOTENCY_WINDOWS);

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Canonical list of all 17 ExchangeId values for `--exchange-list` validation.
 * Mirrors `src/types.ts:95`. Updated when ExchangeId widens (e.g. when a new
 * SHADOW venue is added via a PILOT-ADAPTERS wave).
 *
 * Includes both PROMOTED (5) and SHADOW (12) venues — the meme-liquidity gate
 * in `asset-tiers.ts::isMemeCoinLiquid` short-circuits TRUE for shadow venues
 * via SHADOW_VENUE_PERMISSIVE_PASS, so `--exchange-list ASTER,EDGEX` is valid
 * input from the parseArgs perspective.
 */
export const ALL_EXCHANGE_IDS: ExchangeId[] = [
  'HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET',
  'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX',
  'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT',
];

/**
 * Parse seed-signals CLI args.
 *
 * @param argv  Optional argv slice (defaults to `process.argv.slice(2)`).
 *              Exposed for testability (vitest passes synthetic argv to
 *              `tests/seed-signals-parse-args.test.ts`).
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): { timeframe: string; top: number; exchanges: ExchangeId[]; restrictedUniverse: number; statusFilter: VenueStatus | 'all' | null; explicitExchanges: boolean } {
  const args = argv;

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

  // SHADOW-SEED-W1: --restricted-universe N replaces the per-exchange
  // OI-ranked universe with the top-N coins by historical call-count from
  // /api/performance-public.byAsset (proxy for adoption / liquidity rank).
  // Used by 1m + 3m shadow-mode crons to keep CPX22 load bounded.
  let restrictedUniverse = 0; // 0 = use per-exchange OI (default)
  const ruIdx = args.indexOf('--restricted-universe');
  if (ruIdx !== -1 && args[ruIdx + 1]) {
    const n = parseInt(args[ruIdx + 1]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`Invalid --restricted-universe value: ${args[ruIdx + 1]}. Must be a positive integer.`);
      process.exit(1);
    }
    restrictedUniverse = n;
  }

  let exchanges: ExchangeId[] = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'];
  const exIdx = args.indexOf('--exchange');
  const exListIdx = args.indexOf('--exchange-list');

  // OPS-3M-EXPAND-W2-PART-A (2026-05-22): mutual-exclusion guard between
  // --exchange (single-venue or ALL shorthand) and --exchange-list (subset
  // of the 17-value ExchangeId union). Mixing both is operator error;
  // surface immediately with an explicit message.
  if (exIdx !== -1 && exListIdx !== -1) {
    console.error('Error: --exchange and --exchange-list are mutually exclusive. Use one or the other.');
    process.exit(1);
  }

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
  } else if (exListIdx !== -1 && args[exListIdx + 1]) {
    // OPS-3M-EXPAND-W2-PART-A (2026-05-22): --exchange-list <CSV> — accepts a
    // comma-separated subset of the 17-value ExchangeId union. Designed for
    // staggered cron entries that scope to a venue subset (e.g. CEX-only
    // top-50 line alongside an HL-only line on a different schedule).
    //
    // Validates each entry against ALL_EXCHANGE_IDS. HALTs on any unknown
    // value with the full valid set printed for operator clarity. Note that
    // 'ALL' is NOT a valid --exchange-list entry (it's --exchange shorthand);
    // operators wanting all 5 promoted venues should use --exchange ALL.
    const raw = args[exListIdx + 1];
    const list = raw.split(',').map((s) => s.trim().toUpperCase());
    if (list.length === 0 || list.some((s) => s.length === 0)) {
      console.error(`Invalid --exchange-list value: "${raw}". Expected comma-separated ExchangeId values (e.g. BINANCE,BYBIT,OKX,BITGET).`);
      process.exit(1);
    }
    const validSet = new Set<string>(ALL_EXCHANGE_IDS);
    for (const ex of list) {
      if (!validSet.has(ex)) {
        console.error(`Invalid exchange in --exchange-list: ${ex}. Valid values: ${ALL_EXCHANGE_IDS.join(', ')}.`);
        process.exit(1);
      }
    }
    exchanges = list as ExchangeId[];
  }

  // OPS-SHADOW-PIPELINE-W1/C1: --status <shadow|promoted|all> selects venues
  // from the `venues` table when NO explicit --exchange/--exchange-list override
  // is given. `explicitExchanges` records whether an override was passed, so
  // main() can choose: override → the (byte-equivalent) venue list; else →
  // table-driven selection (the generator fix). An explicit override always
  // wins over --status.
  let statusFilter: VenueStatus | 'all' | null = null;
  const statusIdx = args.indexOf('--status');
  if (statusIdx !== -1 && args[statusIdx + 1]) {
    const s = args[statusIdx + 1].toLowerCase();
    if (s === 'shadow' || s === 'promoted' || s === 'all') {
      statusFilter = s as VenueStatus | 'all';
    } else {
      console.error(`Invalid --status: ${args[statusIdx + 1]}. Use shadow, promoted, or all.`);
      process.exit(1);
    }
  }
  const explicitExchanges = exIdx !== -1 || exListIdx !== -1;

  return { timeframe, top, exchanges, restrictedUniverse, statusFilter, explicitExchanges };
}

/**
 * SHADOW-SEED-W1: Returns the top-N coins by historical call-count from
 * `byAsset` aggregation in performance-db. Used by 1m + 3m shadow-mode
 * crons to bound CPX22 load — instead of seeding the full per-exchange
 * universe (300+ symbols), we seed only the assets users actually call.
 *
 * 5-min in-process cache. Falls back to a hardcoded majors set if the
 * performance store is empty (fresh deploy).
 */
let _restrictedUniverseCache: { value: string[]; topN: number; fetchedAt: number } | null = null;
const RESTRICTED_UNIVERSE_TTL_MS = 5 * 60 * 1000;
const RESTRICTED_UNIVERSE_FALLBACK = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'AVAX', 'LINK', 'TON', 'ADA', 'TRX', 'DOT', 'NEAR', 'ARB', 'OP', 'SUI', 'APT', 'ATOM', 'AAVE', 'INJ'];

export async function getRestrictedUniverse(topN: number): Promise<string[]> {
  if (
    _restrictedUniverseCache &&
    _restrictedUniverseCache.topN === topN &&
    Date.now() - _restrictedUniverseCache.fetchedAt < RESTRICTED_UNIVERSE_TTL_MS
  ) {
    return _restrictedUniverseCache.value;
  }
  try {
    const { getSignalPerformance } = await import('../resources/signal-performance.js');
    const stats = await getSignalPerformance();
    const ranked = Object.entries(stats?.byAsset || {})
      .map(([coin, data]) => ({ coin, count: (data as { count: number }).count || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN)
      .map((e) => e.coin);
    if (ranked.length === 0) {
      console.warn(`[${ts()}] getRestrictedUniverse: byAsset empty, falling back to hardcoded majors set`);
      return RESTRICTED_UNIVERSE_FALLBACK.slice(0, topN);
    }
    _restrictedUniverseCache = { value: ranked, topN, fetchedAt: Date.now() };
    return ranked;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${ts()}] getRestrictedUniverse: failed (${msg}), falling back to majors`);
    return RESTRICTED_UNIVERSE_FALLBACK.slice(0, topN);
  }
}

/** Test-only cache reset. */
export function _resetRestrictedUniverseCache(): void {
  _restrictedUniverseCache = null;
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

// Binance 1000-prefix overrides for low-price coins
const BINANCE_OVERRIDES: Record<string, string> = {
  '1000PEPE': 'PEPE', '1000SHIB': 'SHIB', '1000FLOKI': 'FLOKI',
  '1000BONK': 'BONK', '1000LUNC': 'LUNC', '1000XEC': 'XEC',
  '1000SATS': 'SATS', '1000RATS': 'RATS', '1000CAT': 'CAT',
  '1000CHEEMS': 'CHEEMS', '1000WHINE': 'WHINE', '1000APU': 'APU',
  '1000X': 'X', '1000MOGCOIN': 'MOGCOIN',
};

/**
 * Fetch Binance USDT-M pairs sorted by 24h quoteVolume (proxy for OI —
 * Binance has no bulk OI endpoint; quoteVolume is highly correlated).
 *
 * OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): served from adapter's coalesced
 * full-universe ticker/24hr cache (60s TTL). Within a fire window, the
 * per-coin `getAssetContext.ticker24hr@symbol` lookups read from the same
 * cache populated by this call — total ticker24hr weight per fire: 40
 * (one bulk fetch) instead of 40 + 50×1 (was 90).
 */
async function fetchBinanceCoins(topN: number): Promise<string[]> {
  const data = await getTicker24hrFullCoalesced();

  const usdtPairs = data
    .filter(t => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

  const limited = topN > 0 ? usdtPairs.slice(0, topN) : usdtPairs;

  return limited.map(t => {
    const coin = t.symbol.replace(/USDT$/, '');
    return BINANCE_OVERRIDES[coin] || coin;
  });
}

/**
 * Fetch Bybit USDT linear pairs sorted by notional OI (openInterest × lastPrice).
 */
async function fetchBybitCoins(topN: number): Promise<string[]> {
  const res = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
  const data = await res.json() as { result: { list: Array<{ symbol: string; openInterest: string; lastPrice: string }> } };

  const usdtPairs = (data.result?.list || [])
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      notionalOI: parseFloat(t.openInterest || '0') * parseFloat(t.lastPrice || '0'),
    }))
    .sort((a, b) => b.notionalOI - a.notionalOI);

  const limited = topN > 0 ? usdtPairs.slice(0, topN) : usdtPairs;
  return limited.map(t => t.symbol.replace(/USDT$/, ''));
}

/**
 * Fetch OKX USDT-margined swaps sorted by notional OI (oiUsd).
 * Uses /api/v5/public/open-interest?instType=SWAP for bulk OI data.
 */
async function fetchOKXCoins(topN: number): Promise<string[]> {
  const res = await fetch('https://www.okx.com/api/v5/public/open-interest?instType=SWAP');
  const data = await res.json() as { data: Array<{ instId: string; oiUsd: string }> };

  const usdtSwaps = (data.data || [])
    .filter(t => t.instId.endsWith('-USDT-SWAP'))
    .sort((a, b) => parseFloat(b.oiUsd || '0') - parseFloat(a.oiUsd || '0'));

  const limited = topN > 0 ? usdtSwaps.slice(0, topN) : usdtSwaps;
  return limited.map(t => t.instId.replace(/-USDT-SWAP$/, ''));
}

/**
 * Fetch Bitget USDT-M futures sorted by notional OI (holdingAmount × lastPr).
 */
async function fetchBitgetCoins(topN: number): Promise<string[]> {
  const res = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
  const data = await res.json() as { data: Array<{ symbol: string; holdingAmount: string; lastPr: string }> };

  const usdtPairs = (data.data || [])
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol: t.symbol,
      notionalOI: parseFloat(t.holdingAmount || '0') * parseFloat(t.lastPr || '0'),
    }))
    .sort((a, b) => b.notionalOI - a.notionalOI);

  const limited = topN > 0 ? usdtPairs.slice(0, topN) : usdtPairs;
  return limited.map(t => t.symbol.replace(/USDT$/, ''));
}

// ════════════════════════════════════════════════════════════════════════
// OPS-SHADOW-PIPELINE-W1 / C2 — 12 shadow-venue universe fetchers.
// Each returns the top-N canonical coin symbols (UPPERCASE base) ranked by 24h
// volume or open interest, using the venue's live instruments/ticker endpoint
// (all verified 200 from the prod host in Plan-Mode Step-0). FAIL-SOFT: any
// HTTP/parse error → [] + WARNING (the venue self-skips this cycle; never
// throws, never starves the other venues — mirrors seedExchange's skip path).
// The adapter's coin→venue-symbol mapper handles the reverse direction at seed
// time, so these return canonical coins (e.g. "BTC", "ETH").
// ════════════════════════════════════════════════════════════════════════

async function fetchUniverseJson(url: string, venue: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[${ts()}] [${venue}] universe HTTP ${res.status} — skipping venue this cycle`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[${ts()}] [${venue}] universe fetch error: ${e instanceof Error ? e.message : e} — skipping venue this cycle`);
    return null;
  }
}

/** Rank {coin, score}[] desc by score, dedupe by coin (keep highest), take topN (topN<=0 = all). */
function rankTopN(rows: { coin: string; score: number }[], topN: number): string[] {
  const best = new Map<string, number>();
  for (const r of rows) {
    if (!r.coin) continue;
    const prev = best.get(r.coin);
    if (prev === undefined || r.score > prev) best.set(r.coin, r.score);
  }
  const sorted = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return topN > 0 ? sorted.slice(0, topN) : sorted;
}

// ASTER — Binance-fork USDT-M; /fapi/v1/ticker/24hr (quoteVolume). 1000-prefix overrides.
export async function fetchAsterCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://fapi.asterdex.com/fapi/v1/ticker/24hr', 'ASTER');
  if (!Array.isArray(data)) return [];
  const rows = (data as Array<{ symbol?: string; quoteVolume?: string }>)
    .filter(t => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map(t => {
      const raw = (t.symbol as string).replace(/USDT$/, '');
      return { coin: BINANCE_OVERRIDES[raw] || raw, score: parseFloat(t.quoteVolume || '0') };
    });
  return rankTopN(rows, topN);
}

// GATE — /futures/usdt/tickers (volume_24h_quote); contract = "<COIN>_USDT".
export async function fetchGateCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://api.gateio.ws/api/v4/futures/usdt/tickers', 'GATE');
  if (!Array.isArray(data)) return [];
  const rows = (data as Array<{ contract?: string; volume_24h_quote?: string }>)
    .filter(t => typeof t.contract === 'string' && t.contract.endsWith('_USDT'))
    .map(t => ({ coin: (t.contract as string).replace(/_USDT$/, ''), score: parseFloat(t.volume_24h_quote || '0') }));
  return rankTopN(rows, topN);
}

// MEXC — /contract/ticker (amount24 = 24h quote vol); symbol = "<COIN>_USDT".
export async function fetchMexcCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://contract.mexc.com/api/v1/contract/ticker', 'MEXC');
  const arr = (data as { data?: Array<{ symbol?: string; amount24?: number }> })?.data;
  if (!Array.isArray(arr)) return [];
  const rows = arr
    .filter(t => typeof t.symbol === 'string' && t.symbol.endsWith('_USDT'))
    .map(t => ({ coin: (t.symbol as string).replace(/_USDT$/, ''), score: Number(t.amount24 || 0) }));
  return rankTopN(rows, topN);
}

// KUCOIN — /contracts/active (turnoverOf24h); baseCurrency XBT→BTC; type FFWCSX = USDT perp.
export async function fetchKucoinCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://api-futures.kucoin.com/api/v1/contracts/active', 'KUCOIN');
  const arr = (data as { data?: Array<{ baseCurrency?: string; quoteCurrency?: string; type?: string; turnoverOf24h?: number }> })?.data;
  if (!Array.isArray(arr)) return [];
  const rows = arr
    .filter(c => c.quoteCurrency === 'USDT' && c.type === 'FFWCSX' && typeof c.baseCurrency === 'string')
    .map(c => ({ coin: c.baseCurrency === 'XBT' ? 'BTC' : (c.baseCurrency as string), score: Number(c.turnoverOf24h || 0) }));
  return rankTopN(rows, topN);
}

// BINGX — /openApi/swap/v2/quote/ticker (quoteVolume); symbol = "<COIN>-USDT".
export async function fetchBingxCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://open-api.bingx.com/openApi/swap/v2/quote/ticker', 'BINGX');
  const arr = (data as { data?: Array<{ symbol?: string; quoteVolume?: string }> })?.data;
  if (!Array.isArray(arr)) return [];
  const rows = arr
    .filter(t => typeof t.symbol === 'string' && t.symbol.endsWith('-USDT'))
    .map(t => ({ coin: (t.symbol as string).replace(/-USDT$/, ''), score: parseFloat(t.quoteVolume || '0') }));
  return rankTopN(rows, topN);
}

// HTX — /linear-swap-ex/market/detail/batch_merged (trade_turnover); contract_code "<COIN>-USDT" swap.
export async function fetchHtxCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://api.hbdm.com/linear-swap-ex/market/detail/batch_merged', 'HTX');
  const arr = (data as { ticks?: Array<{ contract_code?: string; trade_turnover?: string }> })?.ticks;
  if (!Array.isArray(arr)) return [];
  const rows = arr
    .filter(t => typeof t.contract_code === 'string' && t.contract_code.endsWith('-USDT'))
    .map(t => ({ coin: (t.contract_code as string).replace(/-USDT$/, ''), score: parseFloat(t.trade_turnover || '0') }));
  return rankTopN(rows, topN);
}

// WEEX — /capi/v2/market/tickers (volume_24h); symbol = "cmt_<coin>usdt".
export async function fetchWeexCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://api-contract.weex.com/capi/v2/market/tickers', 'WEEX');
  if (!Array.isArray(data)) return [];
  const rows = (data as Array<{ symbol?: string; volume_24h?: string }>)
    .filter(t => typeof t.symbol === 'string' && /^cmt_.*usdt$/i.test(t.symbol))
    .map(t => ({ coin: (t.symbol as string).replace(/^cmt_/i, '').replace(/usdt$/i, '').toUpperCase(), score: parseFloat(t.volume_24h || '0') }));
  return rankTopN(rows, topN);
}

// BITMART — /contract/public/details (open_interest; vol_24h often null); product_type 1 = perp.
export async function fetchBitmartCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://api-cloud-v2.bitmart.com/contract/public/details', 'BITMART');
  const arr = (data as { data?: { symbols?: Array<{ base_currency?: string; quote_currency?: string; product_type?: number; open_interest?: string }> } })?.data?.symbols;
  if (!Array.isArray(arr)) return [];
  const rows = arr
    .filter(s => s.product_type === 1 && s.quote_currency === 'USDT' && typeof s.base_currency === 'string')
    .map(s => ({ coin: s.base_currency as string, score: parseFloat(s.open_interest || '0') }));
  return rankTopN(rows, topN);
}

// WHITEBIT — /api/v4/public/futures (stock_volume); money_currency USDT; stock_currency = coin.
export async function fetchWhitebitCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://whitebit.com/api/v4/public/futures', 'WHITEBIT');
  const arr = (data as { result?: Array<{ stock_currency?: string; money_currency?: string; stock_volume?: string }> })?.result;
  if (!Array.isArray(arr)) return [];
  const rows = arr
    .filter(m => m.money_currency === 'USDT' && typeof m.stock_currency === 'string')
    .map(m => ({ coin: m.stock_currency as string, score: parseFloat(m.stock_volume || '0') }));
  return rankTopN(rows, topN);
}

// XT — symbol/list (contractType PERPETUAL, state 0) ∩ agg-tickers (volume `a`).
// Excludes dated quarterly futures. Fail-soft: unranked perp coins if tickers fail.
export async function fetchXtCoins(topN: number): Promise<string[]> {
  const listData = await fetchUniverseJson('https://fapi.xt.com/future/market/v1/public/symbol/list', 'XT');
  const list = (listData as { result?: Array<{ symbol?: string; baseCoin?: string; contractType?: string; state?: number }> })?.result;
  if (!Array.isArray(list)) return [];
  const perp = new Map<string, string>(); // venue symbol -> canonical coin
  for (const s of list) {
    if (s.contractType === 'PERPETUAL' && s.state === 0 && typeof s.symbol === 'string') {
      perp.set(s.symbol, (s.baseCoin || s.symbol.split('_')[0] || '').toUpperCase());
    }
  }
  const tickData = await fetchUniverseJson('https://fapi.xt.com/future/market/v1/public/q/agg-tickers', 'XT');
  const ticks = (tickData as { result?: Array<{ s?: string; a?: string }> })?.result;
  if (Array.isArray(ticks)) {
    const rows = ticks
      .filter(t => typeof t.s === 'string' && perp.has(t.s))
      .map(t => ({ coin: perp.get(t.s as string) as string, score: parseFloat(t.a || '0') }));
    const ranked = rankTopN(rows, topN);
    if (ranked.length > 0) return ranked;
  }
  const coins = [...new Set([...perp.values()].filter(Boolean))];
  return topN > 0 ? coins.slice(0, topN) : coins;
}

// EDGEX — getMetaData.contractList; coin from contractName ("BTCUSD"→"BTC"). No bulk
// ticker → unranked top-N (seedExchange's liquidity filter drops illiquid). Fail-soft.
export async function fetchEdgexCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://pro.edgex.exchange/api/v1/public/meta/getMetaData', 'EDGEX');
  const arr = (data as { data?: { contractList?: Array<{ contractName?: string }> } })?.data?.contractList;
  if (!Array.isArray(arr)) return [];
  const coins = [...new Set(arr
    .map(c => (c.contractName || '').replace(/USDT$/, '').replace(/USD$/, '').toUpperCase())
    .filter(Boolean))];
  return topN > 0 ? coins.slice(0, topN) : coins;
}

// PHEMEX — products.perpProductsV2 filtered to USDT-quote Listed perps; coin=baseCurrency.
// (perpProductsV2 also lists USDC-quote — must filter.) No reliable bulk ticker →
// unranked top-N (liquidity filter handles the rest). Fail-soft.
export async function fetchPhemexCoins(topN: number): Promise<string[]> {
  const data = await fetchUniverseJson('https://api.phemex.com/public/products', 'PHEMEX');
  const arr = (data as { data?: { perpProductsV2?: Array<{ baseCurrency?: string; quoteCurrency?: string; status?: string }> } })?.data?.perpProductsV2;
  if (!Array.isArray(arr)) return [];
  const coins = [...new Set(arr
    .filter(p => p.quoteCurrency === 'USDT' && p.status === 'Listed' && typeof p.baseCurrency === 'string')
    .map(p => p.baseCurrency as string))];
  return topN > 0 ? coins.slice(0, topN) : coins;
}

/**
 * OPS-SHADOW-PIPELINE-W1 / C1 — venue-table-driven universe registry (the
 * generator fix). Maps each ExchangeId → a `(topN) => Promise<coin[]>` resolver.
 * `Record<ExchangeId, …>` is exhaustive: tsc fails if a venue is added without a
 * fetcher. The 5 promoted venues route through their EXISTING fetchers, so an
 * `--exchange <PROMOTED>` invocation is byte-equivalent to the prior hardcoded
 * main() block (HL keeps its warmTierCaches + Top-20-TradFi limiting, wrapped
 * here so the per-venue loop is uniform). The 12 shadow venues are stubs until
 * C2 — they return [] (the loop skips them cleanly), so C1 ships safely and a
 * table-driven run seeds only the 5 promoted venues until C2 lands.
 */
export const UNIVERSE_FETCHERS: Record<ExchangeId, (topN: number) => Promise<string[]>> = {
  HL: async (topN: number): Promise<string[]> => {
    // Byte-equivalent to the prior HL main() block: warm caches, fetch by OI,
    // then limit TradFi (xyz) perps to Top-20 by OI.
    await warmTierCaches();
    let coins = await fetchHLCoins(topN);
    const allTradFi = coins.filter(c => isKnownTradFi(c));
    if (allTradFi.length > 20) {
      const topTradFi = new Set(allTradFi.slice(0, 20));
      coins = coins.filter(c => !isKnownTradFi(c) || topTradFi.has(c));
    }
    return coins;
  },
  BINANCE: fetchBinanceCoins,
  BYBIT:   fetchBybitCoins,
  OKX:     fetchOKXCoins,
  BITGET:  fetchBitgetCoins,
  // ── 12 shadow venues (C2) — top-N by 24h volume / OI; fail-soft ([] on error) ──
  ASTER:    fetchAsterCoins,
  EDGEX:    fetchEdgexCoins,
  GATE:     fetchGateCoins,
  MEXC:     fetchMexcCoins,
  KUCOIN:   fetchKucoinCoins,
  PHEMEX:   fetchPhemexCoins,
  BINGX:    fetchBingxCoins,
  HTX:      fetchHtxCoins,
  WEEX:     fetchWeexCoins,
  BITMART:  fetchBitmartCoins,
  XT:       fetchXtCoins,
  WHITEBIT: fetchWhitebitCoins,
};

async function seedExchange(
  exchangeId: ExchangeId,
  coins: string[],
  timeframe: string,
  idempotencyWindow: number
): Promise<{ seeded: number; skipped: number; errors: number }> {
  const delayMs = DELAY_PER_EXCHANGE[exchangeId] || 500;
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
        `[${ts()}] [${exchangeId}] ${coin} -> ${result.call} (${result.confidence}%) @ $${result.price.toLocaleString()} recorded`
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

    await sleep(delayMs);
  }

  // OPS-SHADOW-PIPELINE-W1/C3: stamp the shadow-venue clock anchor on the first
  // run that produces signals (idempotent + shadow-only inside the helper).
  // Best-effort: a stamp failure never fails the seed run.
  if (seeded > 0) {
    try { await stampSeedingStarted(exchangeId); }
    catch (e) { console.debug(`[${ts()}] [${exchangeId}] seeding-stamp skipped: ${e instanceof Error ? e.message : e}`); }
  }

  return { seeded, skipped, errors };
}

async function main() {
  const { timeframe, top, exchanges, restrictedUniverse, statusFilter, explicitExchanges } = parseArgs();
  const idempotencyWindow = IDEMPOTENCY_WINDOWS[timeframe] || 50 * 60;

  const totals = { seeded: 0, skipped: 0, errors: 0 };

  // SHADOW-SEED-W1: when --restricted-universe N is set (used by 1m + 3m
  // shadow-mode crons), we bypass per-exchange OI-ranked universe fetches
  // and seed only the top-N coins by historical call-count. The same coin
  // list is passed to every exchange in the run; coins not supported on a
  // given venue self-skip via the existing "Insufficient candle data /
  // not found" error path inside seedExchange.
  let restrictedCoins: string[] | null = null;
  if (restrictedUniverse > 0) {
    restrictedCoins = await getRestrictedUniverse(restrictedUniverse);
    console.log(
      `[${ts()}] SHADOW-SEED restricted universe (${timeframe}, top ${restrictedUniverse} by call-count): ` +
      `[${restrictedCoins.join(', ')}]`,
    );
  }

  // OPS-SHADOW-PIPELINE-W1/C1 — venue selection is DATA-DRIVEN off the `venues`
  // table (the generator fix). An explicit --exchange/--exchange-list override
  // wins and routes through UNIVERSE_FETCHERS byte-equivalently to the prior
  // hardcoded blocks; otherwise the venue set is read from the table:
  // `--status shadow|promoted|all`, or (no flag) every non-retired venue
  // (promoted + shadow). "A venue in the table is seeded by construction" →
  // promotion becomes a single status flip.
  let venuesToSeed: ExchangeId[];
  if (explicitExchanges) {
    venuesToSeed = exchanges;
  } else {
    const wanted: VenueStatus | undefined = statusFilter && statusFilter !== 'all' ? statusFilter : undefined;
    const rows = await listVenues(wanted);
    venuesToSeed = rows
      .filter(v => v.status !== 'retired')
      .map(v => v.exchange_id as ExchangeId);
    console.log(`[${ts()}] Venue-table-driven selection (${statusFilter ?? 'promoted+shadow'}): [${venuesToSeed.join(', ')}]`);
  }

  // Uniform per-venue seed loop (replaces the 5 hardcoded blocks). ONE venue at
  // a time → peak CPU is bounded to a single venue's seedExchange (this serial
  // execution IS the staggering primitive for the 2-vCPU box). Fail-soft: a
  // venue whose universe fetch throws or returns [] is skipped without aborting
  // the run or starving the other venues. HL's warmTierCaches + Top-20-TradFi
  // limiting live inside UNIVERSE_FETCHERS.HL, so --exchange HL stays byte-
  // equivalent. The --restricted-universe path is preserved (shared coin list).
  for (const venueId of venuesToSeed) {
    let coins: string[];
    if (restrictedCoins) {
      coins = restrictedCoins;
    } else {
      try {
        coins = await UNIVERSE_FETCHERS[venueId](top);
      } catch (err) {
        console.error(`[${ts()}] [${venueId}] universe fetch failed: ${err instanceof Error ? err.message : err} — skipping venue.`);
        continue;
      }
    }
    if (!coins || coins.length === 0) {
      console.warn(`[${ts()}] [${venueId}] empty universe — skipping.`);
      continue;
    }

    console.log(`[${ts()}] Starting ${timeframe} ${venueId} signal seed for ${coins.length} assets${restrictedCoins ? ` (restricted)` : top ? ` (top ${top})` : ''} (delay: ${DELAY_PER_EXCHANGE[venueId]}ms)...`);
    // OPTIMIZE-FUNDING-CACHE-CRON-W1: bulk-warm cache before per-coin loop
    // (fail-soft → per-coin fallback inside seedExchange).
    try { await bulkWarmFundingCache(coins); }
    catch (e) { console.debug('[funding-cache] bulk-warm failed, falling back to per-coin:', e instanceof Error ? e.message : e); }
    const result = await seedExchange(venueId, coins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] ${venueId} seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    totals.seeded += result.seeded;
    totals.skipped += result.skipped;
    totals.errors += result.errors;
  }

  closeDb();
  console.log(`[${ts()}] All exchanges done [${timeframe}]: ${totals.seeded} seeded, ${totals.skipped} skipped, ${totals.errors} errors.`);
}

// Auto-run only when invoked as a script (`node dist/scripts/seed-signals.js`),
// NOT when imported by tests. CJS heuristic mirrors evaluate-venues.ts.
// OPS-SHADOW-PIPELINE-W1/C1: without this guard, importing the module (e.g. for
// parseArgs / UNIVERSE_FETCHERS unit tests) fires main() on load — and the new
// venue-table-driven selection would hit the DB at import time. Production cron
// invokes it directly, so require.main === module holds and behavior is
// unchanged.
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    closeDb();
    process.exit(1);
  });
}
