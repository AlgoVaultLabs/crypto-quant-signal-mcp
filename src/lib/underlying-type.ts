/**
 * Underlying-type resolver (TRADIFI-SIGNAL-HARDENING-W1, R2).
 *
 * Maps a (coin, exchange) to its underlying AssetClass for session + funding
 * interpretation. PRIMARY path is live auto-detection from Binance
 * `exchangeInfo` (`underlyingType` on `contractType:"TRADIFI_PERPETUAL"`), so a
 * NEW Binance TradFi listing classifies itself with zero code change. Other
 * venues use the static class map.
 *
 * 3-TIER GRACEFUL DEGRADATION (per the external-API-classification skill):
 *   Tier 1: fresh in-memory exchangeInfo cache (24h TTL)
 *   Tier 2: stale cache (better than nothing on a transient fetch failure)
 *   Tier 3: STATIC_ASSET_CLASS_MAP (canonical coin → class)
 *   Floor : 'UNKNOWN' — renders NO caveat (fail-safe; never assert a class we
 *           cannot substantiate). Non-TradFi coins resolve to 'CRYPTO'.
 * `resolveAssetClass` NEVER throws.
 *
 * TEST SEAMS (cache-seam trio):
 *   _clearUnderlyingTypeCache()           — full reset (beforeEach isolation)
 *   _setUnderlyingTypeFetcherForTest(fn)  — inject the exchangeInfo fetcher
 *   _getUnderlyingTypeCacheState()        — read-only inspector (size + age)
 *
 * Real network is NEVER hit under vitest unless a fetcher is injected — the
 * `process.env.VITEST` guard keeps every test deterministic and offline.
 */
import { toBinanceSymbol } from './adapters/binance.js';
import { isKnownTradFi } from './asset-tiers.js';
import {
  STATIC_ASSET_CLASS_MAP,
  BINANCE_UNDERLYING_TO_ASSET_CLASS,
} from './market-sessions-constants.js';
import type { AssetClass } from './market-sessions-constants.js';
import type { ExchangeId } from '../types.js';

/** Resolver output: a concrete class, or 'UNKNOWN' when it cannot be substantiated. */
export type ResolvedAssetClass = AssetClass | 'UNKNOWN';

/** One Binance exchangeInfo symbol entry, narrowed to the fields we read. */
export interface UnderlyingTypeEntry {
  contractType: string;
  underlyingType: string | null;
}

/** Fetcher contract: returns symbol → {contractType, underlyingType}. */
export type ExchangeInfoFetcher = () => Promise<Map<string, UnderlyingTypeEntry>>;

const BINANCE_FAPI_BASE = 'https://fapi.binance.com';
const EXCHANGE_INFO_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 6_000;

interface ExchangeInfoCache {
  map: Map<string, UnderlyingTypeEntry>;
  fetchedAt: number;
}

// ── Module state ──
let cache: ExchangeInfoCache | null = null;
let inflight: Promise<Map<string, UnderlyingTypeEntry> | null> | null = null;
let fetcherOverride: ExchangeInfoFetcher | null = null;

/** Default fetcher: live Binance exchangeInfo, parsed to the narrow map. Fail-open (null). */
async function defaultFetcher(): Promise<Map<string, UnderlyingTypeEntry>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BINANCE_FAPI_BASE}/fapi/v1/exchangeInfo`, { signal: controller.signal });
    if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
    const json = (await res.json()) as { symbols?: Array<{ symbol: string; contractType?: string; underlyingType?: string }> };
    const map = new Map<string, UnderlyingTypeEntry>();
    for (const s of json.symbols ?? []) {
      if (!s.symbol) continue;
      map.set(s.symbol, {
        contractType: s.contractType ?? '',
        underlyingType: s.underlyingType ?? null,
      });
    }
    return map;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load the exchangeInfo map honoring the cache + degradation contract.
 * Returns the freshest map available, or null only when there is no cache AND
 * the fetch fails (Tier-3 static fallback then applies).
 */
async function loadExchangeInfoMap(): Promise<Map<string, UnderlyingTypeEntry> | null> {
  // Tier 1: fresh cache.
  if (cache && Date.now() - cache.fetchedAt < EXCHANGE_INFO_TTL_MS) {
    return cache.map;
  }

  // Never hit the real network under vitest unless a fetcher is injected — keeps
  // the existing tool tests (which default exchange to BINANCE) offline.
  if (!fetcherOverride && process.env.VITEST) {
    return cache ? cache.map : null;
  }

  if (inflight) return inflight;

  const fetcher = fetcherOverride ?? defaultFetcher;
  inflight = fetcher()
    .then((map) => {
      cache = { map, fetchedAt: Date.now() };
      inflight = null;
      return map;
    })
    .catch((err) => {
      inflight = null;
      // Tier 2: stale cache beats nothing.
      if (cache) {
        console.warn(`[underlying-type] exchangeInfo fetch failed (${err instanceof Error ? err.message : err}) — serving stale cache`);
        return cache.map;
      }
      console.warn(`[underlying-type] exchangeInfo fetch failed AND no cache — falling back to STATIC_ASSET_CLASS_MAP (${err instanceof Error ? err.message : err})`);
      return null;
    });
  return inflight;
}

/** Tier-3 static fallback: canonical coin → class, else UNKNOWN (known TradFi) / CRYPTO. */
function staticFallback(coin: string): ResolvedAssetClass {
  const cls = STATIC_ASSET_CLASS_MAP[coin];
  if (cls) return cls;
  // A known TradFi symbol we couldn't class → UNKNOWN (no caveat). Otherwise crypto.
  if (isKnownTradFi(coin)) return 'UNKNOWN';
  return 'CRYPTO';
}

/**
 * Resolve the underlying AssetClass for a coin on a venue. Never throws.
 *
 * BINANCE → live exchangeInfo auto-detection (with 3-tier fallback).
 * Other venues → static class map (live underlyingType is Binance-only in v1).
 */
export async function resolveAssetClass(coin: string, exchange: ExchangeId): Promise<ResolvedAssetClass> {
  const symbol = coin.toUpperCase();

  if (exchange === 'BINANCE') {
    let map: Map<string, UnderlyingTypeEntry> | null = null;
    try {
      map = await loadExchangeInfoMap();
    } catch {
      map = null; // defensive — loader is already fail-open, but never throw upward.
    }
    if (map) {
      const entry = map.get(toBinanceSymbol(symbol));
      if (entry) {
        if (entry.contractType === 'TRADIFI_PERPETUAL') {
          return (entry.underlyingType && BINANCE_UNDERLYING_TO_ASSET_CLASS[entry.underlyingType]) || 'UNKNOWN';
        }
        // A normal PERPETUAL on Binance (BTCUSDT, etc.) → crypto, 24/7.
        return 'CRYPTO';
      }
      // Symbol absent from exchangeInfo (e.g. an alias mismatch) → static fallback.
    }
    return staticFallback(symbol);
  }

  // Non-Binance venues: static class map only in v1.
  return staticFallback(symbol);
}

// ── Test seams (cache-seam trio) — never call in production ──

/** Test-only: full cache + inflight + override reset. */
export function _clearUnderlyingTypeCache(): void {
  cache = null;
  inflight = null;
  fetcherOverride = null;
}

/** Test-only: inject the exchangeInfo fetcher (or null to restore the live default). */
export function _setUnderlyingTypeFetcherForTest(fn: ExchangeInfoFetcher | null): void {
  fetcherOverride = fn;
}

/** Test-only read-only inspector: current cache size + age (ms), or null when cold. */
export function _getUnderlyingTypeCacheState(): { size: number; ageMs: number } | null {
  if (!cache) return null;
  return { size: cache.map.size, ageMs: Date.now() - cache.fetchedAt };
}
