/**
 * 4-tier asset classification for dashboard display hierarchy.
 * API/MCP always returns all assets — tiers are a display decision only.
 *
 * Tier 1: Blue Chip (BTC, ETH)
 * Tier 2: Major Alts (dynamic top 20 by OI, standard perps)
 * Tier 3: TradFi (tokenized stocks across CEXes + HL builder-dex perps — stocks,
 *         indices, commodities, FX; detected per-venue via asset-class-detection.ts)
 * Tier 4: Meme & Micro (liquidity-filtered — top 50 OI or >$10M vol)
 */

import type { DexType, ExchangeId } from '../types.js';
import { getExchangeTopAssetsWithVolume } from './exchange-universe.js';
import { coalescedCache } from './coalesced-cache.js';
import { isShortLivedScript } from './runtime.js';
import { getTradFiClass, warmAssetClasses } from './asset-class-detection.js';

export type AssetTier = 1 | 2 | 3 | 4;

export interface TierDefinition {
  tier: AssetTier;
  name: string;
  label: string;
  color: string;
  description: string;
}

export const TIER_DEFINITIONS: TierDefinition[] = [
  { tier: 1, name: 'Blue Chip',    label: 'Tier 1', color: '#58a6ff', description: 'BTC & ETH — highest liquidity, institutional benchmark' },
  { tier: 2, name: 'Major Alts',   label: 'Tier 2', color: '#3fb950', description: 'Top alts by open interest — liquid, tradeable, TA-responsive' },
  { tier: 3, name: 'TradFi',       label: 'Tier 3', color: '#bc8cff', description: 'TradFi perps — stocks, indices, commodities, FX' },
  { tier: 4, name: 'Meme & Micro', label: 'Tier 4', color: '#d29922', description: 'Meme perps & micro-caps — liquidity-filtered, top 50 OI or >$10M vol' },
];

const TIER_1: Set<string> = new Set(['BTC', 'ETH']);

// Known meme/micro symbols (for deterministic classification even without OI data)
const MEME_KNOWN: Set<string> = new Set([
  'WIF', 'DOGE', 'MEME', 'MYRO', 'BRETT', 'POPCAT',
  'GOAT', 'PNUT', 'HMSTR', 'TURBO', 'MOODENG',
  'FARTCOIN', 'AI16Z', 'VIRTUAL', 'GRIFFAIN', 'ZEREBRO',
]);

// ── xyz (TradFi) symbol management ──

// Hardcoded fallback set of known TradFi xyz symbols (used before API fetch completes).
// Also includes SPX which exists on both standard and xyz dex.
const TRADFI_FALLBACK: Set<string> = new Set([
  'SPX', 'SP500', 'XYZ100', 'GOLD', 'SILVER', 'CL', 'BRENTOIL',
  'COPPER', 'NATGAS', 'PLATINUM', 'PALLADIUM', 'URANIUM', 'ALUMINIUM', 'TTF',
  'TSLA', 'NVDA', 'AAPL', 'AMZN', 'GOOGL', 'META', 'MSFT', 'AMD',
  'ORCL', 'NFLX', 'PLTR', 'COIN', 'HOOD', 'INTC', 'MU', 'MSTR',
  'BABA', 'LLY', 'COST', 'RIVN', 'TSM', 'CRCL', 'SNDK', 'CRWV',
  'HIMS', 'DKNG', 'BX', 'GME', 'SMSN', 'SOFTBANK', 'HYUNDAI', 'KIOXIA',
  'JP225', 'KR200', 'DXY', 'VIX', 'USAR', 'URNM', 'XLE', 'EWY', 'EWJ',
  'CORN', 'WHEAT', 'LITE', 'PURRDAT', 'SKHX',
  'JPY', 'EUR',
]);

// Dynamically populated from xyz API (more accurate than fallback)
let dynamicXyzSymbols: { coins: Set<string>; fetchedAt: number } | null = null;
const XYZ_CACHE_TTL = 3_600_000; // 1 hour

async function getXyzSymbols(): Promise<Set<string>> {
  if (dynamicXyzSymbols && Date.now() - dynamicXyzSymbols.fetchedAt < XYZ_CACHE_TTL) {
    return dynamicXyzSymbols.coins;
  }
  try {
    const { getXyzSymbolSet } = await import('./oi-ranking.js');
    const symbols = await getXyzSymbolSet();
    if (symbols.size > 0) {
      // Merge with SPX from standard perps
      symbols.add('SPX');
      dynamicXyzSymbols = { coins: symbols, fetchedAt: Date.now() };
      return symbols;
    }
  } catch { /* fall through */ }
  return TRADFI_FALLBACK;
}

export function isKnownTradFi(symbol: string): boolean {
  if (TRADFI_FALLBACK.has(symbol)) return true;
  if (dynamicXyzSymbols) return dynamicXyzSymbols.coins.has(symbol);
  return false;
}

// ── Classification ──

/**
 * Classify a coin into a display tier. Optional trailing `venue` (TS bivariance →
 * no caller cascade) lets the cross-venue asset-class engine resolve TradFi on the
 * venue that actually lists it (OPS-TIER-CLASSIFIER-XVENUE-W1). Stays SYNCHRONOUS:
 * `getTradFiClass` reads the PRE-WARMED snapshot (warmed in `warmTierCaches`), so the
 * 11 performance-db rollup call-sites + get-trade-call never go async (Q8 ratified).
 */
export function classifyAsset(coin: string, top20ByOI: Set<string> | null, venue?: ExchangeId): AssetTier {
  const symbol = coin.toUpperCase();
  if (TIER_1.has(symbol)) return 1;
  if (isKnownTradFi(symbol)) return 3;                     // HL xyz + TRADFI_FALLBACK seed (incl. SPX)
  if (getTradFiClass(symbol, venue) !== null) return 3;    // cross-venue field/union detection (any non-CRYPTO class)
  if (top20ByOI && top20ByOI.has(symbol)) return 2;
  if (MEME_KNOWN.has(symbol)) return 4;
  // Default: anything not classified lands in Tier 4 (Meme & Micro)
  return 4;
}

export function getTierDef(tier: AssetTier): TierDefinition {
  return TIER_DEFINITIONS.find(t => t.tier === tier)!;
}

/**
 * Determine which HL dex to query for a given coin.
 * SPX exists on standard perps — all other TradFi symbols are xyz only.
 */
export function getDexForCoin(coin: string): DexType {
  const symbol = coin.toUpperCase();
  if (symbol === 'SPX') return 'standard'; // SPX is on standard perps
  if (isKnownTradFi(symbol)) return 'xyz';
  return 'standard';
}

// ── Top 20 OI (for Tier 2 classification) ──

const CACHE_TTL_MS = 3_600_000;
const TOP20_NEGATIVE_TTL_MS = 45_000; // negative-cache window on an HL throttle (jittered)

/**
 * DASH-W1-FIX-2 (2026-05-03): static fallback for the cold-start-during-HL-429
 * case. Hyperliquid per-IP-rate-limits the Hetzner box during heavy windows;
 * a container restart that lands inside such a window starts with an empty
 * in-memory OI cache + a 429-blocked HL fetch, leaving `getTop20ByOI` with
 * no data to return. Pre-fix the catch block returned `new Set()` (empty),
 * which silently misclassified ALL non-BTC/ETH non-TradFi non-meme alts as
 * Tier 4 — hiding the Major Alts panel from the dashboard.
 *
 * This static set is the canonical top-20 by HL OI minus TIER_1 minus
 * MEME_KNOWN minus TradFi as of 2026-05-03 (verified via direct HL `/info`
 * probe). It's "good enough" for the cold-start window — the in-memory
 * cache repopulates on the next successful HL fetch, replacing this
 * fallback with live data.
 *
 * Maintenance: re-verify quarterly via `curl -X POST
 * https://api.hyperliquid.xyz/info -d '{"type":"metaAndAssetCtxs"}'` and
 * sort by notionalOI = openInterest * markPx. Coins listed below are
 * conservatively the union of past 6 months of top-20 — drift in either
 * direction has only a small dashboard-tier effect (a coin that moves out
 * stays Tier 2 in the fallback; a coin that moves in is Tier 4 until next
 * successful fetch). Acceptable degradation.
 */
const FALLBACK_TOP20: Set<string> = new Set([
  'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOT', 'LINK', 'ATOM', 'LTC', 'NEAR',
  'INJ', 'SUI', 'APT', 'AAVE', 'UNI', 'TRX', 'BCH', 'XLM', 'HBAR',
  'TAO', 'HYPE', 'ZEC', 'XMR', 'ENA', 'PAXG', 'ARB', 'OP', 'FIL', 'ICP',
]);

// OPS-HL-CACHE-STAMPEDE-GENERATOR-W1 C3: getTop20ByOI is the call EVERY getTradeSignal
// makes (incl. the server warmer's 42 grid scorers every ~50s) — its cache-on-success-
// only shape (no single-flight, no negative cache) was the storm's entry point: a
// throttled cold cache never filled, so every call re-hit HL. Now routed through the
// shared coalescedCache: single-flight collapses concurrent cold-fills to ONE fetch, a
// throttle is negative-cached (~45s jittered) not re-stormed, stale-or-FALLBACK_TOP20 is
// served on failure (values unchanged), and a PROCESS-BOUNDARY GATE makes short-lived
// seed crons serve cache/FALLBACK_TOP20 + NEVER cold-fill HL (closes class B). The
// returned Set + fallback values are byte-identical to before.
const top20Cache = coalescedCache<Set<string>>({
  load: async () => {
    const { getTopAssetsByOI } = await import('./oi-ranking.js');
    const assets = await getTopAssetsByOI(20);
    return new Set(
      assets
        .map((a: { coin: string }) => a.coin.toUpperCase())
        .filter((c: string) => !TIER_1.has(c) && !MEME_KNOWN.has(c) && !isKnownTradFi(c))
    );
  },
  ttlMs: CACHE_TTL_MS,
  staleOk: true,
  fallback: () => FALLBACK_TOP20,
  negativeTtlMs: TOP20_NEGATIVE_TTL_MS,
  processGate: () => isShortLivedScript(process.argv[1]),
  // OPS-COALESCED-CACHE-LOAD-TIMEOUT-W1: bound a COLD OI fill so /api/performance-public +
  // every getTradeSignal (the 42 grid scorers) + getHoldStats never block on an HL batch-yield
  // (~58s WAIT, not a throw → the fallback catch alone can't help). Healthy cold fill (<2.5s)
  // returns the real top20; a saturated fill (≥2.5s) degrades to FALLBACK_TOP20 and warms in
  // the background — the SAME degradation as the existing throw-fallback (values byte-identical).
  loadTimeoutMs: 2500,
});

export function getTop20ByOI(): Promise<Set<string>> {
  return top20Cache.get('top20');
}

/**
 * Test seam — clears the in-memory `cachedTop20` between tests so each
 * runs in isolation. Underscore-prefixed; non-public.
 */
export function _clearTop20Cache(): void {
  top20Cache._clear();
}

/**
 * Test seam — exposes the static fallback Set so tests can assert which
 * coins are returned in the cold-start-during-error path.
 */
export function _getFallbackTop20(): Set<string> {
  return FALLBACK_TOP20;
}

// ── Meme coin liquidity filter (per-exchange-AND, OPS-3M-EXPAND-W1) ──

const MIN_VOLUME_24H = 10_000_000; // $10M

/**
 * The 5 PROMOTED venues — full per-exchange-AND gate logic runs against
 * each exchange's own top-50 + 24h USD volume.
 */
const PROMOTED_VENUES: ReadonlyArray<ExchangeId> = ['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;

/**
 * The 12 SHADOW venues — gate short-circuits TRUE pending per-venue
 * promotion to PUBLIC tier. Re-audit at each promotion wave.
 *
 * NOTE: hard-coded here because no canonical venue-tier classification module
 * exists yet (`venues` postgres table is the runtime SoT but not importable
 * client-side). See OPS-3M-EXPAND-W1 WIS for `OPS-VENUE-TIER-CANONICALIZATION-W1`
 * follow-up.
 */
const SHADOW_VENUES: ReadonlyArray<ExchangeId> = [
  'ASTER', 'EDGEX', 'GATE', 'MEXC', 'KUCOIN', 'PHEMEX',
  'BINGX', 'HTX', 'WEEX', 'BITMART', 'XT', 'WHITEBIT',
] as const;

/**
 * Per-exchange liquid-coin cache. Keyed by `ExchangeId`; entries hold the
 * set of coin symbols that passed the per-exchange-AND gate on the most
 * recent fetch, plus the fetch timestamp for TTL.
 */
const liquidCoinsByExchange: Map<ExchangeId, { coins: Set<string>; fetchedAt: number }> = new Map();

/**
 * Check if a meme/micro coin has sufficient liquidity on `exchange` for
 * reliable TA signals. Per-exchange-AND semantics (OPS-3M-EXPAND-W1):
 *
 * Returns TRUE iff:
 *   1. `exchange` is a SHADOW venue (12 of 17 ExchangeId values) — short-circuits
 *      TRUE without any external fetch (SHADOW_VENUE_PERMISSIVE_PASS).
 *   OR
 *   2. `exchange` is a PROMOTED venue AND `coin` is in that exchange's top-50
 *      by notional OI AND has ≥ $10M 24h USD-equivalent volume on that exchange.
 *
 * Cache: per-exchange Map with 1h TTL.
 *
 * Error path: permissive (returns TRUE) on fetch failure — matches pre-C1 behavior;
 * see `console.warn` log line for ops visibility.
 *
 * Callers: `src/tools/get-trade-call.ts` Tier-4 branch (OPS-3M-EXPAND-W1 removed
 * the outer `if (exchange === 'HL')` guard at that call site; gate now runs for
 * all 17 ExchangeId values uniformly).
 */
export async function isMemeCoinLiquid(coin: string, exchange: ExchangeId): Promise<boolean> {
  // SHADOW_VENUE_PERMISSIVE_PASS — tighten per-venue when promoted to PUBLIC tier (OPS-3M-EXPAND-W1 Q3)
  if (SHADOW_VENUES.includes(exchange)) {
    return true;
  }

  const upper = coin.toUpperCase();

  // Cache hit (per-exchange)
  const cached = liquidCoinsByExchange.get(exchange);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.coins.has(upper);
  }

  try {
    const universe = await getExchangeTopAssetsWithVolume(exchange, 50);
    const top50Set = new Set(universe.map((a) => a.coin.toUpperCase()));
    const liquidSet = new Set<string>();
    for (const asset of universe) {
      const sym = asset.coin.toUpperCase();
      // per-exchange-AND: in top-50 (by construction since universe is already top-50)
      // AND volume24h_usd >= $10M
      if (top50Set.has(sym) && asset.volume24h_usd >= MIN_VOLUME_24H) {
        liquidSet.add(sym);
      }
    }
    liquidCoinsByExchange.set(exchange, { coins: liquidSet, fetchedAt: Date.now() });
    return liquidSet.has(upper);
  } catch (err) {
    // On error, be permissive — allow signal generation (matches pre-C1 behavior).
    // Log for ops visibility.
    console.warn(`[isMemeCoinLiquid] ${exchange} universe fetch failed: ${(err as Error).message ?? err}`);
    return true;
  }
}

/**
 * Test seam — clears the per-exchange liquid-coin cache between tests so each
 * runs in isolation. Underscore-prefixed; non-public.
 */
export function _clearLiquidCoinsByExchangeCache(): void {
  liquidCoinsByExchange.clear();
}

/**
 * Test seam — preseeds the per-exchange cache for a specific exchange with a
 * known set of coins. Used to assert cache-hit behavior + isolation between
 * exchanges. Underscore-prefixed; non-public.
 */
export function _setLiquidCoinsForTest(exchange: ExchangeId, coins: Iterable<string>): void {
  liquidCoinsByExchange.set(exchange, {
    coins: new Set([...coins].map((c) => c.toUpperCase())),
    fetchedAt: Date.now(),
  });
}

/**
 * Pre-warm all caches at server startup to avoid cold-start delays on first
 * MCP-tool invocation. Iterates the 5 PROMOTED venues for the meme-liquidity
 * gate. Shadow venues are NOT pre-warmed — they short-circuit TRUE without
 * an external fetch (no work to warm).
 *
 * `Promise.allSettled` so any single failed exchange doesn't block boot —
 * runtime error path of `isMemeCoinLiquid` then handles individual failures
 * permissively.
 */
export async function warmTierCaches(): Promise<void> {
  await Promise.allSettled([
    getXyzSymbols(),
    getTop20ByOI(),
    warmAssetClasses(), // cross-venue TradFi snapshot → sync getTradFiClass in classifyAsset (OPS-TIER-CLASSIFIER-XVENUE-W1)
    ...PROMOTED_VENUES.map((venue) => isMemeCoinLiquid('BTC', venue)),
  ]);
}
