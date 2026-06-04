/**
 * Unit tests for the underlying-type resolver
 * (TRADIFI-SIGNAL-HARDENING-W1, R2/R7).
 *
 * Exercises the 3-tier graceful-degradation contract (live exchangeInfo →
 * stale cache → static map → UNKNOWN/CRYPTO) and the cache-seam trio via an
 * INJECTED fetcher, so the suite stays fully offline + deterministic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAssetClass,
  _clearUnderlyingTypeCache,
  _setUnderlyingTypeFetcherForTest,
  _getUnderlyingTypeCacheState,
  type UnderlyingTypeEntry,
} from '../../src/lib/underlying-type.js';

function tradfi(underlyingType: string): UnderlyingTypeEntry {
  return { contractType: 'TRADIFI_PERPETUAL', underlyingType };
}
const PERP: UnderlyingTypeEntry = { contractType: 'PERPETUAL', underlyingType: null };

function liveMap(): Map<string, UnderlyingTypeEntry> {
  return new Map<string, UnderlyingTypeEntry>([
    ['BTCUSDT', PERP],
    ['ETHUSDT', PERP],
    ['TSLAUSDT', tradfi('EQUITY')],
    ['ANTHROPICUSDT', tradfi('PREMARKET')],
    ['XAUUSDT', tradfi('COMMODITY')], // GOLD → XAUUSDT via TRADFI_ALIASES
    ['SAMSUNGUSDT', tradfi('KR_EQUITY')],
  ]);
}

describe('resolveAssetClass — Tier 1 (live exchangeInfo auto-detection)', () => {
  beforeEach(() => _clearUnderlyingTypeCache());
  afterEach(() => _clearUnderlyingTypeCache());

  it('classifies a Binance symbol by its underlyingType; normal perp → CRYPTO', async () => {
    const fetcher = vi.fn(async () => liveMap());
    _setUnderlyingTypeFetcherForTest(fetcher);

    expect(await resolveAssetClass('BTC', 'BINANCE')).toBe('CRYPTO');
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY');
    expect(await resolveAssetClass('ANTHROPIC', 'BINANCE')).toBe('PREMARKET');
    expect(await resolveAssetClass('GOLD', 'BINANCE')).toBe('COMMODITY'); // alias GOLD→XAUUSDT

    // 24h TTL: all four resolves served from one fetch.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const state = _getUnderlyingTypeCacheState();
    expect(state?.size).toBe(6);
  });

  it('symbol absent from exchangeInfo → static fallback', async () => {
    _setUnderlyingTypeFetcherForTest(async () => new Map()); // empty live map
    // NVDA is in the static map but not in this (empty) live map → static EQUITY.
    expect(await resolveAssetClass('NVDA', 'BINANCE')).toBe('EQUITY');
  });
});

describe('resolveAssetClass — Tier 2 (stale cache on fetch failure)', () => {
  beforeEach(() => _clearUnderlyingTypeCache());
  afterEach(() => {
    _clearUnderlyingTypeCache();
    vi.restoreAllMocks();
  });

  it('serves stale cache (not static) when a refresh fails', async () => {
    // Populate the cache with a healthy fetch.
    _setUnderlyingTypeFetcherForTest(async () => liveMap());
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY');

    // Advance past the 24h TTL.
    const base = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => base + 25 * 60 * 60 * 1000);

    // Refresh now fails → must fall back to STALE cache, still EQUITY.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _setUnderlyingTypeFetcherForTest(async () => { throw new Error('exchangeInfo 503'); });
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY');
  });
});

describe('resolveAssetClass — Tier 3 (static map) + UNKNOWN floor', () => {
  beforeEach(() => {
    _clearUnderlyingTypeCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    _clearUnderlyingTypeCache();
    vi.restoreAllMocks();
  });

  it('cold-start + fetch failure → static class map, with an operator warn', async () => {
    _setUnderlyingTypeFetcherForTest(async () => { throw new Error('exchangeInfo down'); });
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY');
    expect(await resolveAssetClass('ANTHROPIC', 'BINANCE')).toBe('PREMARKET');
    expect(console.warn).toHaveBeenCalled();
  });

  it('non-TradFi coin with no live map → CRYPTO (never UNKNOWN)', async () => {
    _setUnderlyingTypeFetcherForTest(async () => { throw new Error('down'); });
    expect(await resolveAssetClass('BTC', 'BINANCE')).toBe('CRYPTO');
  });

  it('known TradFi symbol absent from the static class map → UNKNOWN (no caveat)', async () => {
    _setUnderlyingTypeFetcherForTest(async () => { throw new Error('down'); });
    // DXY is in asset-tiers TRADFI_FALLBACK (isKnownTradFi) but intentionally
    // NOT in STATIC_ASSET_CLASS_MAP (FX, no confident session) → UNKNOWN.
    expect(await resolveAssetClass('DXY', 'BINANCE')).toBe('UNKNOWN');
  });
});

describe('resolveAssetClass — non-Binance venues + offline guard', () => {
  beforeEach(() => _clearUnderlyingTypeCache());
  afterEach(() => _clearUnderlyingTypeCache());

  it('non-Binance venue resolves via the static class map (no fetch)', async () => {
    const fetcher = vi.fn(async () => liveMap());
    _setUnderlyingTypeFetcherForTest(fetcher);
    expect(await resolveAssetClass('TSLA', 'OKX')).toBe('EQUITY');
    expect(await resolveAssetClass('BTC', 'HL')).toBe('CRYPTO');
    expect(fetcher).not.toHaveBeenCalled(); // Binance-only live path
  });

  it('under VITEST with NO injected fetcher: never hits the network → static fallback', async () => {
    _clearUnderlyingTypeCache(); // also clears the override
    // No fetcher injected; the process.env.VITEST guard prevents any real fetch.
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY'); // from static map
    expect(await resolveAssetClass('BTC', 'BINANCE')).toBe('CRYPTO');
    expect(_getUnderlyingTypeCacheState()).toBeNull(); // nothing cached, no network
  });
});
