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
import { InsufficientCandlesError } from '../lib/errors.js';
import { hasRecentSignalAsync, closeDb, bulkWarmFundingCache } from '../lib/performance-db.js';
import { runScript } from '../lib/script-lifecycle.js';
import { classifyAsset, warmTierCaches, isKnownTradFi } from '../lib/asset-tiers.js';
import { getTicker24hrFullCoalesced } from '../lib/adapters/binance.js';
import { hlInfoPost } from '../lib/adapters/hyperliquid.js';
import { runAsBatch, WeightBudgetSkipError } from '../lib/upstream-weight-budget.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from '../lib/adapters/_upstream-fetch.js';
import type { LicenseInfo, ExchangeId, VenueStatus } from '../types.js';
import { listVenues, stampSeedingStarted } from '../lib/venue-store.js';
import { recordSeedHeartbeat } from '../lib/seed-heartbeats.js';
import { isTimeframeFaithful, servedTimeframeLabel } from '../lib/tf-support.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';
import { BINANCE_OVERRIDES } from '../lib/coin-overrides.js';

// Internal license bypasses free-tier gating
const INTERNAL_LICENSE: LicenseInfo = { tier: 'pro', key: 'internal-seed' };

// Per-exchange delay between API calls (ms).
// OPS-SHADOW-PIPELINE-W1 V2 (2026-06-05): the 12 shadow-venue values are now
// derived from the deep-research per-IP budget table (≤50% of each documented
// limit; gentler on the ban-escalators BITMART/XT/PHEMEX; EDGEX 750ms since its
// limit is unpublished). SoT: research/shadow-venues-api-limits-2026-06-05.md.
// Promoted-venue values are the house calibration reference (unchanged).
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
  'ASTER':   250,
  // PILOT-ADAPTERS-W1 / C2 (2026-05-16): EDGEX shadow venue. Same scope
  // deferral as ASTER — Record<ExchangeId, number> key required for type-
  // system compat; seed-loop branch is OUT of C2 scope (PILOT-ADAPTERS-
  // SEED-LOOP-W2 follow-up). Slightly higher delay (400ms) because edgeX
  // has no published rate-limit budget; conservative throttle for unknown.
  'EDGEX':   750,
  // PILOT-ADAPTERS-W2 / C1 (2026-05-19): GATE shadow venue. Same scope
  // deferral as ASTER/EDGEX — Record<ExchangeId, number> key required for
  // type-system compat; seed-loop branch is OUT of C1 scope per Scope Rule
  // (deferred to PILOT-ADAPTERS-SEED-LOOP-W2). Conservative 300ms delay.
  'GATE':    250,
  // PILOT-ADAPTERS-W2 / C2 (2026-05-19): MEXC shadow venue. Same deferral
  // as ASTER/EDGEX/GATE — Record<ExchangeId, number> key required for
  // type-system compat; seed-loop branch deferred to PILOT-ADAPTERS-SEED-
  // LOOP-W2. MEXC has aggressive listing cadence (881 perps), conservative
  // 350ms delay.
  'MEXC':    300,
  // PILOT-ADAPTERS-W2 / C3 (2026-05-19): KUCOIN shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  'KUCOIN':  250,
  // PILOT-ADAPTERS-W3A / C1 (2026-05-20): PHEMEX shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  // Phemex hedged USDT-M perpetual (perpProductsV2, 538 USDT-listed). Per-
  // endpoint rate limit not documented in primary docs; conservative 300ms.
  'PHEMEX':  300,
  // PILOT-ADAPTERS-W3A / C2 (2026-05-20): BINGX shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  // BingX Swap V2 USDT-M perpetual (638 USDT-listed). Rate-limit upgrade
  // 2025-10-16 (per primary docs); conservative 300ms.
  'BINGX':   250,
  // PILOT-ADAPTERS-W3A / C3 (2026-05-20): HTX shadow venue. Type-system
  // cascade only; seed-loop branch deferred to PILOT-ADAPTERS-SEED-LOOP-W2.
  // HTX (formerly Huobi) Linear USDT-Margined Swap (233 USDT-listed). Most-
  // generous rate limit of W3A batch (800req/s per-IP market data); 200ms.
  'HTX':     150,
  // PILOT-ADAPTERS-W3B / C1 (2026-05-20): WEEX shadow venue. cmt_ prefix + 4h funding.
  'WEEX':    300,
  // PILOT-ADAPTERS-W3B / C2 (2026-05-20): BITMART shadow venue. Binance-style symbol BTCUSDT; 8h cadence.
  'BITMART': 500,
  // PILOT-ADAPTERS-W3B / C3 (2026-05-20): XT shadow venue. Lowercase btc_usdt; 8h cadence.
  'XT':      400,
  // PILOT-ADAPTERS-W3B / C4 (2026-05-20): WHITEBIT shadow venue. _PERP suffix + 8h cadence; EU-regulated.
  'WHITEBIT':200,
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
export function parseArgs(argv: string[] = process.argv.slice(2)): { timeframe: string; top: number; exchanges: ExchangeId[]; restrictedUniverse: number; statusFilter: VenueStatus | 'all' | null; explicitExchanges: boolean; concurrency: number; exclude: ExchangeId[] } {
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
  // Used by 1m + 3m shadow-mode crons to keep host load bounded (CPX42).
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

  // OPS-SEED-ORCHESTRATOR-W1/CH1 R1.1: --concurrency N (integer 1..8, default 1).
  // Default 1 keeps the per-venue loop strictly serial (byte-equivalent to the
  // pre-wave behavior); the per-TF orchestrator cron lines pass --concurrency 2
  // to bound in-flight venues without spawning one process per venue.
  let concurrency = 1;
  const concIdx = args.indexOf('--concurrency');
  if (concIdx !== -1 && args[concIdx + 1]) {
    const n = parseInt(args[concIdx + 1]);
    if (isNaN(n) || n < 1 || n > 8) {
      console.error(`Invalid --concurrency value: ${args[concIdx + 1]}. Must be an integer 1-8.`);
      process.exit(1);
    }
    concurrency = n;
  }

  // OPS-SEED-PROMOTED-RAMP-W1 (2026-07-07): --exclude <csv> removes venues from
  // the resolved seed set (applied AFTER --status/--exchange selection in main()).
  // Enables the ramp-proof "--status promoted --exclude HL" orchestrator line — HL
  // is by-design ~48min/fire and MUST stay on its own legacy line, so it is
  // excluded from the consolidated promoted fan-out while every OTHER promoted
  // venue (incl. future promotions) auto-enrolls. Validated vs ALL_EXCHANGE_IDS;
  // orthogonal to (composes with) --exchange/--exchange-list/--status.
  let exclude: ExchangeId[] = [];
  const exclIdx = args.indexOf('--exclude');
  if (exclIdx !== -1 && args[exclIdx + 1]) {
    const raw = args[exclIdx + 1];
    const list = raw.split(',').map((s) => s.trim().toUpperCase());
    if (list.length === 0 || list.some((s) => s.length === 0)) {
      console.error(`Invalid --exclude value: "${raw}". Expected comma-separated ExchangeId values (e.g. HL).`);
      process.exit(1);
    }
    const validSet = new Set<string>(ALL_EXCHANGE_IDS);
    for (const ex of list) {
      if (!validSet.has(ex)) {
        console.error(`Invalid exchange in --exclude: ${ex}. Valid values: ${ALL_EXCHANGE_IDS.join(', ')}.`);
        process.exit(1);
      }
    }
    exclude = list as ExchangeId[];
  }

  return { timeframe, top, exchanges, restrictedUniverse, statusFilter, explicitExchanges, concurrency, exclude };
}

/**
 * SHADOW-SEED-W1: Returns the top-N coins by historical call-count from
 * `byAsset` aggregation in performance-db. Used by 1m + 3m shadow-mode
 * crons to bound host load (CPX42) — instead of seeding the full per-exchange
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
  // OPS-HL-RATELIMITER-W2: route universe discovery through the shared HL weight
  // budget (was 2 direct fetches that bypassed the adapter chokepoint). Runs in
  // batch class — seed main() wraps the whole run in runAsBatch. The std meta is
  // required; if the budget skips it under saturation, abort the fire gracefully
  // (empty universe → seeds nothing → next idempotent fire retries). xyz is best-effort.
  type HLMetaTuple = [{ universe: { name: string }[] }, { openInterest: string; markPx: string }[]];
  let stdData: HLMetaTuple;
  try {
    stdData = await hlInfoPost<HLMetaTuple>({ type: 'metaAndAssetCtxs' });
  } catch (err) {
    if (err instanceof WeightBudgetSkipError) {
      console.log(`[${ts()}] [HL] universe discovery skipped — HL weight budget saturated; will retry next fire.`);
      return [];
    }
    throw err;
  }
  const xyzData = await hlInfoPost<HLMetaTuple>({ type: 'metaAndAssetCtxs', dex: 'xyz' }).catch(() => null);

  const assets: HLAssetInfo[] = stdData[0].universe.map((u, i) => ({
    name: u.name,
    notionalOI: parseFloat(stdData[1][i]?.openInterest || '0') * parseFloat(stdData[1][i]?.markPx || '0'),
  }));

  if (xyzData) {
    try {
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

// BINANCE_OVERRIDES moved to src/lib/coin-overrides.ts (OPS-SCAN-UNIVERSE-EXPAND-W1) — shared by the
// seed loop (fetchBinanceCoins, below) AND the scan universe fetchers (exchange-universe.ts fetchAster),
// so the 1000× meme canonicalization is single-sourced (no parallel copy).

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
  const data = await upstreamFetch<{ result: { list: Array<{ symbol: string; openInterest: string; lastPrice: string }> } }>(
    VENUE_FETCH_CONFIGS.BYBIT,
    { url: 'https://api.bybit.com/v5/market/tickers?category=linear' },
  );

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
  const data = await upstreamFetch<{ data: Array<{ instId: string; oiUsd: string }> }>(
    VENUE_FETCH_CONFIGS.OKX,
    { url: 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP' },
  );

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
  const data = await upstreamFetch<{ data: Array<{ symbol: string; holdingAmount: string; lastPr: string }> }>(
    VENUE_FETCH_CONFIGS.BITGET,
    { url: 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES' },
  );

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
    // OPS-SEED-UNIVERSE-FETCH-BUDGET-W1: route through the shared transport (typed
    // 418/429/403 ban handling). Shadow venues have no budget (getVenueBudget → null
    // → no throttle). upstreamFetch parses the JSON and throws on !ok / ban; the catch
    // keeps the fail-soft contract (null → the venue self-skips this cycle), so the
    // prior !res.ok branch is folded into the catch (HTTP status surfaced via the
    // thrown Error message).
    //
    // transientRetries:0 (follow-up fix): these universe pulls are already FAIL-SOFT
    // (skip on error + retry next cron cycle), so the transport's default 500ms
    // transient retry only adds latency on the failure path for zero benefit — and 12
    // sequential shadow fetchers × 500ms blew the seed-signals-registry "fail-soft"
    // test's 5s timeout (the W1 wave ran seed-signals-fetchers.test.ts, not -registry).
    // Typed-ban handling is no-retry by design, so it is unaffected. (The 3 PROMOTED
    // single-shot fetchers keep transientRetries:1 — no 12-sequential compounding, and
    // a single retry on a higher-stakes promoted universe is worth one 500ms.)
    return await upstreamFetch<unknown>({ ...VENUE_FETCH_CONFIGS[venue], transientRetries: 0 }, { url });
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

// ── OPS-SCAN-UNIVERSE-EXPAND-W1 (S2): the 7 newly-promoted venues' seed universe now projects
//    `.coin` off the unified scan SoT (exchange-universe `fetchVenueUniverse`) — ONE venue→universe
//    registry, not two. OI-ranked for the real-OI venues / volume-proxy for Aster+BingX. The
//    established 5 (HL / BINANCE / BYBIT / OKX / BITGET) keep their OWN fetchers (below) pending
//    OPS-SEED-SCAN-UNIVERSE-DEDUP-W1 — re-ranking the LIVE public flywheel needs a coin-parity +
//    WR-stability audit first (prove the OI universe ⊇ the current track-record coin set). ──
async function scanUniverseCoins(venue: ExchangeId, topN: number): Promise<string[]> {
  try {
    const coins = (await fetchVenueUniverse(venue)).map((a) => a.coin);
    return topN > 0 ? coins.slice(0, topN) : coins;
  } catch (e) {
    console.warn(`[${ts()}] [${venue}] scan-universe delegate error: ${e instanceof Error ? e.message : e} — skipping venue this cycle`);
    return [];
  }
}

// ASTER — delegates to the rich SoT (proxy: volume-ranked; 1000× meme overrides applied in fetchAster).
export async function fetchAsterCoins(topN: number): Promise<string[]> { return scanUniverseCoins('ASTER', topN); }

// GATE — delegates to the rich SoT (real OI: total_size × quanto_multiplier × mark_price).
export async function fetchGateCoins(topN: number): Promise<string[]> { return scanUniverseCoins('GATE', topN); }

// MEXC — delegates to the rich SoT (real OI: holdVol × contractSize × lastPrice).
export async function fetchMexcCoins(topN: number): Promise<string[]> { return scanUniverseCoins('MEXC', topN); }

// KUCOIN — delegates to the rich SoT (real OI: openInterest × multiplier × markPrice).
export async function fetchKucoinCoins(topN: number): Promise<string[]> { return scanUniverseCoins('KUCOIN', topN); }

// BINGX — delegates to the rich SoT (proxy: volume-ranked, no bulk OI endpoint).
export async function fetchBingxCoins(topN: number): Promise<string[]> { return scanUniverseCoins('BINGX', topN); }

// HTX — delegates to the rich SoT (real OI: swap_open_interest.value, joined to batch_merged price/vol).
export async function fetchHtxCoins(topN: number): Promise<string[]> { return scanUniverseCoins('HTX', topN); }

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

// PHEMEX — delegates to the rich SoT (real OI: openInterestRv × markPriceRp; v2 ticker now OI-ranked,
// upgraded from the old unranked /public/products list).
export async function fetchPhemexCoins(topN: number): Promise<string[]> { return scanUniverseCoins('PHEMEX', topN); }

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
      // TRADIFI-SIGNAL-HARDENING-W1: the new-listing guard now throws the
      // structured InsufficientCandlesError (message no longer contains the
      // legacy "Insufficient candle" substring) — recognize it explicitly so
      // unsupported/young coins keep self-skipping instead of counting as errors.
      if (err instanceof WeightBudgetSkipError) {
        // OPS-HL-RATELIMITER-W2: budget saturation is the arbiter working as
        // designed — count as a skip (NOT a fire error, per AC3); the budget's
        // own batch_skip telemetry records it. The next idempotent fire retries.
        skipped++;
      } else if (err instanceof InsufficientCandlesError || msg.includes('Insufficient candle') || msg.includes('insufficient liquidity') || msg.includes('not found')) {
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

// ════════════════════════════════════════════════════════════════════════
// OPS-SEED-ORCHESTRATOR-W1 / CH1 — bounded per-timeframe seed orchestration.
// The durable generator fix for the per-venue×TF process explosion: ONE process
// per timeframe runs N venues through a p-limit(concurrency) fan-out over a
// single 2-conn pool, so seed-process count and the Postgres connection ceiling
// become invariant to venue count (6→17 promotion = a `venues.status` flip,
// zero cron edits, zero connection growth). Default concurrency 1 keeps the
// loop byte-equivalent to the prior serial main().
// ════════════════════════════════════════════════════════════════════════

/** Per-venue seed outcome (reduced after fan-out; powers the R1.6 summary line). */
export interface VenueSeedResult {
  venueId: ExchangeId;
  seeded: number;
  skipped: number;
  errors: number;
  durationMs: number;
  /** true ⇔ a throw was caught inside runVenueSeed (NOT an empty universe). */
  failed: boolean;
}

/** Nominal cadence per timeframe (seconds) — pure map; powers overrun detection. */
export const TF_CADENCE_S: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800, '12h': 43200, '1d': 86400,
};

/** R1.6 — a fire "overruns" when it eats >0.8× of its cadence (strictly greater). */
export function computeOverrun(timeframe: string, durationS: number): boolean {
  const cadenceS = TF_CADENCE_S[timeframe] ?? 0;
  return cadenceS > 0 && durationS > 0.8 * cadenceS;
}

/** R1.6 — the greppable [seed-orchestrator] summary line (monitor + 48h-gate contract). */
export function formatOrchestratorSummary(s: {
  timeframe: string;
  venues: number;
  concurrency: number;
  seeded: number;
  skipped: number;
  errors: number;
  failedVenues: string[];
  durationS: number;
  overrun: boolean;
}): string {
  return (
    `[seed-orchestrator] tf=${s.timeframe} venues=${s.venues} concurrency=${s.concurrency} ` +
    `seeded=${s.seeded} skipped=${s.skipped} errors=${s.errors} ` +
    `failed_venues=${s.failedVenues.length ? s.failedVenues.join(',') : 'none'} ` +
    `duration_s=${s.durationS.toFixed(1)} overrun=${s.overrun}`
  );
}

/**
 * R1.4 — deterministic venue rotation keyed by timeframe index. Overlapping TF
 * processes start on different venues so they don't all hit the same venue at
 * second 0 (cross-process burst spread). Pure + order-only: the result is a
 * permutation of the input (coverage identical), so a single-venue list rotates
 * to itself and a serial run stays byte-equivalent.
 */
export function rotateVenues(venueIds: ExchangeId[], timeframe: string): ExchangeId[] {
  const n = venueIds.length;
  if (n === 0) return [];
  const idx = VALID_TIMEFRAMES.indexOf(timeframe); // -1 for unknown TF → normalized below
  const offset = (((idx % n) + n) % n);
  return [...venueIds.slice(offset), ...venueIds.slice(0, offset)];
}

/**
 * R1.2 — seed ONE venue, fail-soft. Encapsulates the per-venue block of the
 * prior main() loop (universe resolve → empty-skip → bulk-warm funding →
 * seedExchange → totals). ANY throw is caught, logged, and returned as
 * {failed:true}; this function NEVER rejects, preserving the continue-on-
 * venue-failure semantics. Log lines are byte-identical to the prior loop.
 */
export async function runVenueSeed(
  venueId: ExchangeId,
  opts: { timeframe: string; top: number; idempotencyWindow: number; restrictedCoins: string[] | null },
): Promise<VenueSeedResult> {
  const { timeframe, top, idempotencyWindow, restrictedCoins } = opts;
  const startedAt = Date.now();
  // OPS-SEED-UNSUPPORTED-TF-SKIP-W1 — proactive skip of any (venue, tf) the adapter can only serve by
  // COARSER substitution (a `<tf>` WR built on `>tf` candles is resolution-inflated on the Merkle-anchored
  // byTimeframe surface — Factuality is THE LAW). Data-driven from each adapter's own interval map
  // (tf-support.isTimeframeFaithful), NOT a crontab --exclude. Placed BEFORE recordSeedHeartbeat so a skipped
  // unfaithful TF does not stamp a freshness heartbeat that would mask the 45-min SLA on the venue's real
  // (faithful) fast lines. seedExchange's InsufficientCandles/not-found catch stays as defence in depth.
  if (!isTimeframeFaithful(venueId, timeframe)) {
    console.log(`[${ts()}] [${venueId}] tf=${timeframe} SKIP — unfaithful (adapter would coarsen ${timeframe}→${servedTimeframeLabel(venueId, timeframe)}); not seeded.`);
    return { venueId, seeded: 0, skipped: 0, errors: 0, durationMs: Date.now() - startedAt, failed: false };
  }
  // OPS-SEED-ORCHESTRATOR-W1 V2-RESUME (CH3-PRE) — attempt-recency heartbeat: the
  // cron fired + reached this venue+TF (regardless of HOLD/seeded outcome). The
  // true seeding-health signal (immune to the HOLD filter); feeds the V5(ii)
  // coverage gate + the future heartbeat pager. Best-effort: never fails the seed.
  try { await recordSeedHeartbeat(venueId, timeframe); }
  catch (e) { console.debug(`[seed-heartbeat] stamp skipped ${venueId}/${timeframe}: ${e instanceof Error ? e.message : e}`); }
  try {
    let coins: string[];
    if (restrictedCoins) {
      coins = restrictedCoins;
    } else {
      try {
        coins = await UNIVERSE_FETCHERS[venueId](top);
      } catch (err) {
        console.error(`[${ts()}] [${venueId}] universe fetch failed: ${err instanceof Error ? err.message : err} — skipping venue.`);
        return { venueId, seeded: 0, skipped: 0, errors: 0, durationMs: Date.now() - startedAt, failed: true };
      }
    }
    if (!coins || coins.length === 0) {
      console.warn(`[${ts()}] [${venueId}] empty universe — skipping.`);
      return { venueId, seeded: 0, skipped: 0, errors: 0, durationMs: Date.now() - startedAt, failed: false };
    }

    console.log(`[${ts()}] Starting ${timeframe} ${venueId} signal seed for ${coins.length} assets${restrictedCoins ? ` (restricted)` : top ? ` (top ${top})` : ''} (delay: ${DELAY_PER_EXCHANGE[venueId]}ms)...`);
    // OPTIMIZE-FUNDING-CACHE-CRON-W1: bulk-warm cache before per-coin loop
    // (fail-soft → per-coin fallback inside seedExchange).
    try { await bulkWarmFundingCache(coins); }
    catch (e) { console.debug('[funding-cache] bulk-warm failed, falling back to per-coin:', e instanceof Error ? e.message : e); }
    const result = await seedExchange(venueId, coins, timeframe, idempotencyWindow);
    console.log(`[${ts()}] ${venueId} seed complete: ${result.seeded} seeded, ${result.skipped} skipped, ${result.errors} errors.`);
    return { venueId, seeded: result.seeded, skipped: result.skipped, errors: result.errors, durationMs: Date.now() - startedAt, failed: false };
  } catch (err) {
    // R1.2 fail-soft safety net: ANY unexpected throw → failed:true, never reject.
    console.error(`[${ts()}] [${venueId}] seed failed unexpectedly: ${err instanceof Error ? err.message : err}`);
    return { venueId, seeded: 0, skipped: 0, errors: 0, durationMs: Date.now() - startedAt, failed: true };
  }
}

/**
 * R1.3 — run venues through a bounded p-limit(limit) fan-out. Pure: no shared
 * mutable counters (callers reduce the returned array after all settle). A
 * rogue runner that rejects is contained so it never loses the other venues
 * (the production runner, runVenueSeed, already never rejects). The caller
 * invokes closeDb() only AFTER this resolves (single-pool drain-on-close).
 */
export async function runVenuesWithConcurrency(
  venueIds: ExchangeId[],
  limit: number,
  runner: (venueId: ExchangeId) => Promise<VenueSeedResult>,
): Promise<VenueSeedResult[]> {
  // p-limit@3.1.0 is CommonJS (deliberate, load-bearing pin — package.json).
  // `require` matches the require.main guard at the bottom of this file and
  // sidesteps ESM-default-interop ambiguity in the CJS (module=Node16) compile.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pLimit = require('p-limit') as (concurrency: number) => <T>(fn: () => Promise<T>) => Promise<T>;
  const lim = pLimit(limit);
  return Promise.all(
    venueIds.map((venueId) =>
      lim(async (): Promise<VenueSeedResult> => {
        const startedAt = Date.now();
        try {
          return await runner(venueId);
        } catch (err) {
          console.error(`[${ts()}] [${venueId}] runner rejected unexpectedly: ${err instanceof Error ? err.message : err}`);
          return { venueId, seeded: 0, skipped: 0, errors: 0, durationMs: Date.now() - startedAt, failed: true };
        }
      }),
    ),
  );
}

async function main() {
  // OPS-HL-RATELIMITER-W2: run the whole seed in `batch` weight class so every HL
  // call (universe discovery + per-coin candles/ctx) waits behind the shared
  // weight budget and yields the interactive reserve to live users.
  // OPS-RATELIMIT-TIDYUP-W1: tag the seed's batch rate_limit_events rows with the
  // per-timeframe caller `seed:<tf>` (closes the deferred attribution gap from
  // OPS-RATELIMIT-CALLER-ATTRIBUTION-W1). parseArgs is pure for valid args (exits
  // identically on invalid), so the second parse for the inner destructure is safe.
  const seedTf = parseArgs().timeframe;
  return runAsBatch(async () => {
  const fireStartedAt = Date.now();
  const { timeframe, top, exchanges, restrictedUniverse, statusFilter, explicitExchanges, concurrency, exclude } = parseArgs();
  const idempotencyWindow = IDEMPOTENCY_WINDOWS[timeframe] || 50 * 60;

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

  // OPS-SEED-PROMOTED-RAMP-W1 (2026-07-07): --exclude removes venues from the
  // resolved set regardless of selection path. Primary use: "--status promoted
  // --exclude HL" (HL stays on its own by-design-slow legacy line). Applied
  // post-selection so it composes with both --exchange-list and --status.
  if (exclude.length > 0) {
    const before = venuesToSeed.length;
    const excludeSet = new Set<ExchangeId>(exclude);
    venuesToSeed = venuesToSeed.filter((v) => !excludeSet.has(v));
    console.log(`[${ts()}] --exclude [${exclude.join(', ')}] removed ${before - venuesToSeed.length} venue(s) → seeding [${venuesToSeed.join(', ')}]`);
  }

  // OPS-SEED-ORCHESTRATOR-W1/CH1 — bounded-concurrency venue fan-out (the
  // generator fix replacing the 5 hardcoded blocks → uniform per-venue loop).
  // rotateVenues spreads each TF's start venue (cross-process burst spread);
  // runVenuesWithConcurrency caps in-flight venues at --concurrency (default
  // 1 = the prior serial loop, byte-equivalent — a single-venue legacy cron
  // rotates to itself and runs serially). HL's warmTierCaches + Top-20-TradFi
  // limiting live inside UNIVERSE_FETCHERS.HL and the --restricted-universe
  // shared-coin path is preserved inside runVenueSeed; fail-soft per venue.
  // Single pool: closeDb() runs only AFTER every venue settles (drain-on-close).
  const orderedVenues = rotateVenues(venuesToSeed, timeframe);
  const results = await runVenuesWithConcurrency(orderedVenues, concurrency, (venueId) =>
    runVenueSeed(venueId, { timeframe, top, idempotencyWindow, restrictedCoins }),
  );
  const totals = results.reduce(
    (acc, r) => ({ seeded: acc.seeded + r.seeded, skipped: acc.skipped + r.skipped, errors: acc.errors + r.errors }),
    { seeded: 0, skipped: 0, errors: 0 },
  );
  const failedVenues = results.filter((r) => r.failed).map((r) => r.venueId);

  closeDb();
  console.log(`[${ts()}] All exchanges done [${timeframe}]: ${totals.seeded} seeded, ${totals.skipped} skipped, ${totals.errors} errors.`);

  // OPS-SEED-ORCHESTRATOR-W1/CH1 R1.6 — structured summary line (greppable
  // contract for the monitor freshness check + 48h gate) + overrun WARN.
  // Log-only, silent-recovery: an overrun never alerts — the next idempotent
  // fire self-heals.
  const durationS = (Date.now() - fireStartedAt) / 1000;
  const overrun = computeOverrun(timeframe, durationS);
  console.log(formatOrchestratorSummary({
    timeframe, venues: orderedVenues.length, concurrency,
    seeded: totals.seeded, skipped: totals.skipped, errors: totals.errors,
    failedVenues, durationS, overrun,
  }));
  if (overrun) {
    const cadenceS = TF_CADENCE_S[timeframe] ?? 0;
    console.warn(`[seed-orchestrator] WARN overrun tf=${timeframe} duration_s=${durationS.toFixed(1)} cadence_s=${cadenceS} threshold_s=${(0.8 * cadenceS).toFixed(0)} — fire exceeded 0.8× cadence; next idempotent fire self-heals.`);
  }
  }, 'seed:' + seedTf);
}

// Auto-run only when invoked as a script (`node dist/scripts/seed-signals.js`),
// NOT when imported by tests. CJS heuristic mirrors evaluate-venues.ts.
// OPS-SHADOW-PIPELINE-W1/C1: without this guard, importing the module (e.g. for
// parseArgs / UNIVERSE_FETCHERS unit tests) fires main() on load — and the new
// venue-table-driven selection would hit the DB at import time. Production cron
// invokes it directly, so require.main === module holds and behavior is
// unchanged.
if (require.main === module) {
  // OPS-SCRIPT-EXIT-LIFECYCLE-W1: drain-then-exit on EVERY path (success, throw,
  // or a leaked handle) — the prior `.catch()`-only tail cleaned up solely on
  // failure, so successful runs never exited and pinned Postgres connections.
  void runScript('seed-signals', main);
}
