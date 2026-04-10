/**
 * 4-tier asset classification for dashboard display hierarchy.
 * API/MCP always returns all assets — tiers are a display decision only.
 *
 * Tier 1: Blue Chip (BTC, ETH)
 * Tier 2: Major Alts (dynamic top 20 by OI, standard perps)
 * Tier 3: TradFi (xyz dex perps — stocks, indices, commodities, FX)
 * Tier 4: Meme & Micro (liquidity-filtered — top 50 OI or >$10M vol)
 */

import type { DexType } from '../types.js';

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
  { tier: 3, name: 'TradFi',       label: 'Tier 3', color: '#bc8cff', description: 'TradFi perps — stocks, indices, commodities, FX via Hyperliquid' },
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

function isKnownTradFi(symbol: string): boolean {
  if (TRADFI_FALLBACK.has(symbol)) return true;
  if (dynamicXyzSymbols) return dynamicXyzSymbols.coins.has(symbol);
  return false;
}

// ── Classification ──

export function classifyAsset(coin: string, top20ByOI: Set<string> | null): AssetTier {
  const symbol = coin.toUpperCase();
  if (TIER_1.has(symbol)) return 1;
  if (isKnownTradFi(symbol)) return 3;
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

let cachedTop20: { coins: Set<string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 3_600_000;

export async function getTop20ByOI(): Promise<Set<string>> {
  if (cachedTop20 && Date.now() - cachedTop20.fetchedAt < CACHE_TTL_MS) {
    return cachedTop20.coins;
  }
  try {
    const { getTopAssetsByOI } = await import('./oi-ranking.js');
    const assets = await getTopAssetsByOI(20);
    const coinSet = new Set(
      assets
        .map((a: { coin: string }) => a.coin.toUpperCase())
        .filter((c: string) => !TIER_1.has(c) && !MEME_KNOWN.has(c) && !isKnownTradFi(c))
    );
    cachedTop20 = { coins: coinSet, fetchedAt: Date.now() };
    return coinSet;
  } catch {
    return new Set();
  }
}

// ── Meme coin liquidity filter ──

const MIN_VOLUME_24H = 10_000_000; // $10M
let liquidMemesCache: { coins: Set<string>; fetchedAt: number } | null = null;

/**
 * Check if a meme/micro coin has sufficient liquidity for reliable TA signals.
 * Must be in top 50 by OI OR have >$10M 24h volume.
 */
export async function isMemeCoinLiquid(coin: string): Promise<boolean> {
  // Refresh cache every hour
  if (liquidMemesCache && Date.now() - liquidMemesCache.fetchedAt < CACHE_TTL_MS) {
    return liquidMemesCache.coins.has(coin.toUpperCase());
  }

  try {
    const { getTopAssetsByOI } = await import('./oi-ranking.js');
    const top50 = await getTopAssetsByOI(50);
    const top50Set = new Set(top50.map(a => a.coin.toUpperCase()));

    // Also fetch all assets to check volume for those outside top 50
    const allAssets = await getTopAssetsByOI(500); // get all
    const liquidCoins = new Set<string>();

    for (const asset of allAssets) {
      const sym = asset.coin.toUpperCase();
      // Skip non-meme coins (they don't need this filter)
      if (TIER_1.has(sym) || isKnownTradFi(sym)) continue;
      // Include if top 50 by OI
      if (top50Set.has(sym)) {
        liquidCoins.add(sym);
        continue;
      }
      // For volume check, we need dayNtlVlm — approximate from OI data
      // The getTopAssetsByOI doesn't include volume, so use a conservative approach:
      // if it's in the full list (has any OI), we'll accept top-50 OR known-meme with OI
    }

    // Simpler approach: fetch metaAndAssetCtxs directly for volume data
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const data = await res.json() as [{ universe: { name: string }[] }, { dayNtlVlm?: string; openInterest?: string; markPx?: string }[]];
    const universe = data[0].universe;
    const ctxs = data[1];

    for (let i = 0; i < universe.length; i++) {
      const sym = universe[i].name.toUpperCase();
      if (TIER_1.has(sym) || isKnownTradFi(sym)) continue;

      const oi = parseFloat(ctxs[i].openInterest || '0');
      const px = parseFloat(ctxs[i].markPx || '0');
      const notionalOI = oi * px;
      const vol = parseFloat(ctxs[i].dayNtlVlm || '0');

      // Top 50 by OI check
      if (top50Set.has(sym)) {
        liquidCoins.add(sym);
      } else if (vol >= MIN_VOLUME_24H) {
        liquidCoins.add(sym);
      }
    }

    liquidMemesCache = { coins: liquidCoins, fetchedAt: Date.now() };
    return liquidCoins.has(coin.toUpperCase());
  } catch {
    // On error, be permissive — allow signal generation
    return true;
  }
}

/**
 * Pre-warm all caches (xyz symbols, top 20, liquid memes).
 * Called at server startup to avoid cold-start delays.
 */
export async function warmTierCaches(): Promise<void> {
  await Promise.allSettled([
    getXyzSymbols(),
    getTop20ByOI(),
    isMemeCoinLiquid('BTC'), // triggers liquid memes cache build
  ]);
}
