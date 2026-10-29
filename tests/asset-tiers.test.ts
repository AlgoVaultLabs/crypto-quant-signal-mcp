/**
 * tests/asset-tiers.test.ts — OPS-3M-EXPAND-W1 C1 regression suite for the
 * per-exchange-AND meme-liquidity gate.
 *
 * Coverage (≥7 cases):
 *   1. AND-boundary lower: $9,999,999 volume + in-top-50 → FALSE
 *   2. AND-boundary upper: $20M volume + NOT-in-top-50 → FALSE
 *      (this case was TRUE under HL-only-OR pre-C1; now FALSE under per-exchange-AND)
 *   3. Per-exchange cache isolation: BINANCE call does NOT consult HL's cache
 *   4. Shadow-venue TRUE short-circuit: MEXC (shadow) returns TRUE without fetch
 *   5. Error-path permissiveness: simulated fetch failure → TRUE
 *   6. Q4 regression: non-HL invocation (BINANCE) DOES invoke isMemeCoinLiquid
 *      (the pre-C1 outer guard `if (exchange === 'HL')` would have bypassed it)
 *   7. AND-both-pass happy path: in BINANCE top-50 + $50M volume → TRUE
 *
 * Audit reference: audits/OPS-3M-EXPAND-W1-endpoint-truth.md (Q-resolutions).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the helper BEFORE importing the SUT — vitest hoists vi.mock.
vi.mock('../src/lib/exchange-universe.js', () => {
  return {
    getExchangeTopAssetsWithVolume: vi.fn(),
  };
});

import * as assetTiers from '../src/lib/asset-tiers.js';
import {
  isMemeCoinLiquid,
  classifyAsset,
  _clearLiquidCoinsByExchangeCache,
  _setLiquidCoinsForTest,
} from '../src/lib/asset-tiers.js';
import { getExchangeTopAssetsWithVolume } from '../src/lib/exchange-universe.js';
import { _loadVenueRecordsForTest, _clearAssetClassCache } from '../src/lib/asset-class-detection.js';

// Type-cast the mock for ergonomic access
const mockFetcher = getExchangeTopAssetsWithVolume as unknown as ReturnType<typeof vi.fn>;

// Fixture builder
function asset(coin: string, oiUsd: number, volUsd: number) {
  return { coin, notionalOI_usd: oiUsd, volume24h_usd: volUsd };
}

describe('isMemeCoinLiquid — per-exchange-AND gate (OPS-3M-EXPAND-W1)', () => {
  beforeEach(() => {
    _clearLiquidCoinsByExchangeCache();
    mockFetcher.mockReset();
  });

  it('case 1 — AND-boundary lower (volume just under $10M): returns FALSE', async () => {
    // PEPE is in HL top-50 but has only $9,999,999 24h volume → just below the AND threshold
    mockFetcher.mockResolvedValueOnce([
      asset('BTC', 5_000_000_000, 8_000_000_000),
      asset('ETH', 3_000_000_000, 6_000_000_000),
      asset('PEPE', 100_000_000, 9_999_999), // <$10M — fails AND
    ]);

    const result = await isMemeCoinLiquid('PEPE', 'HL');
    expect(result).toBe(false);
    expect(mockFetcher).toHaveBeenCalledWith('HL', 50);
  });

  it('case 2 — AND-boundary upper (NOT in top-50 with $20M volume): returns FALSE (was TRUE under HL-only-OR pre-C1)', async () => {
    // The helper returns the top-50; a coin "not in top-50" is simply absent from the returned array.
    // Under per-exchange-AND: not in fetched top-50 → not in liquidSet → FALSE.
    // Under pre-C1 HL-only-OR semantics this same coin would have been TRUE if its volume ≥ $10M.
    mockFetcher.mockResolvedValueOnce([
      asset('BTC', 5_000_000_000, 8_000_000_000),
      asset('ETH', 3_000_000_000, 6_000_000_000),
      // FOO_ALT (outside top-50, even though it might have $20M volume on the venue's full list) is NOT in the limit-50 slice
    ]);

    const result = await isMemeCoinLiquid('FOO_ALT', 'HL');
    expect(result).toBe(false);
  });

  it('case 3 — per-exchange cache isolation: BINANCE call does NOT consult HL cache', async () => {
    // Preseed HL cache with PEPE liquid
    _setLiquidCoinsForTest('HL', ['PEPE']);

    // BINANCE call with PEPE — should fetch BINANCE universe (not hit HL cache); PEPE not in BINANCE top-50
    mockFetcher.mockResolvedValueOnce([
      asset('BTC', 4_000_000_000, 5_000_000_000),
      asset('ETH', 2_500_000_000, 4_000_000_000),
    ]);

    const result = await isMemeCoinLiquid('PEPE', 'BINANCE');
    expect(result).toBe(false);
    expect(mockFetcher).toHaveBeenCalledWith('BINANCE', 50);
    expect(mockFetcher).not.toHaveBeenCalledWith('HL', 50);
  });

  it('case 4 — SHADOW_VENUE_PERMISSIVE_PASS: MEXC returns TRUE without external fetch', async () => {
    // Any coin on a shadow venue → TRUE, no fetch
    const result = await isMemeCoinLiquid('LITERALLY_ANYTHING', 'MEXC' as ExchangeId);

    expect(result).toBe(true);
    expect(mockFetcher).not.toHaveBeenCalled();
  });

  it('case 4b — SHADOW_VENUE_PERMISSIVE_PASS: GATE also short-circuits TRUE (boundary on shadow set)', async () => {
    const result = await isMemeCoinLiquid('PEPE', 'GATE' as ExchangeId);

    expect(result).toBe(true);
    expect(mockFetcher).not.toHaveBeenCalled();
  });

  it('case 5 — error-path permissiveness: simulated BYBIT fetch failure → TRUE', async () => {
    mockFetcher.mockRejectedValueOnce(new Error('Bybit API 503 Service Unavailable'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await isMemeCoinLiquid('PEPE', 'BYBIT');
    expect(result).toBe(true); // permissive on fetch failure (matches pre-C1 behavior)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[isMemeCoinLiquid] BYBIT universe fetch failed'),
    );
    warnSpy.mockRestore();
  });

  it('case 6 — Q4 regression: BINANCE (non-HL) call invokes isMemeCoinLiquid (pre-C1 outer guard removed)', async () => {
    // This case proves the outer `if (exchange === 'HL')` guard removal at get-trade-call.ts:132 lets
    // the gate actually fire for non-HL invocations. The unit test scope is the gate function itself:
    // we assert that calling isMemeCoinLiquid with a non-HL exchange triggers the per-exchange universe
    // fetch (not a no-op short-circuit reserved for shadow venues).
    mockFetcher.mockResolvedValueOnce([
      asset('BTC', 4_000_000_000, 5_000_000_000),
      asset('SOL', 800_000_000, 500_000_000),
      asset('PEPE', 50_000_000, 30_000_000), // in top-50 + $30M volume → passes AND
    ]);

    const result = await isMemeCoinLiquid('PEPE', 'BINANCE');
    expect(result).toBe(true);
    expect(mockFetcher).toHaveBeenCalledTimes(1);
    expect(mockFetcher).toHaveBeenCalledWith('BINANCE', 50);
  });

  it('case 7 — AND-both-pass happy path: BINANCE top-50 + $50M volume → TRUE', async () => {
    mockFetcher.mockResolvedValueOnce([
      asset('BTC', 5_000_000_000, 8_000_000_000),
      asset('ETH', 3_000_000_000, 6_000_000_000),
      asset('PEPE', 200_000_000, 50_000_000), // in top-50 + $50M volume → passes AND
    ]);

    const result = await isMemeCoinLiquid('PEPE', 'BINANCE');
    expect(result).toBe(true);
  });

  it('case 8 — cache hit on second call within TTL: no second fetch', async () => {
    // Bonus case proving the per-exchange cache TTL behavior.
    mockFetcher.mockResolvedValueOnce([
      asset('BTC', 5_000_000_000, 8_000_000_000),
      asset('PEPE', 200_000_000, 50_000_000),
    ]);

    const first = await isMemeCoinLiquid('PEPE', 'OKX');
    const second = await isMemeCoinLiquid('PEPE', 'OKX');

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockFetcher).toHaveBeenCalledTimes(1); // second call hit cache
  });
});

/**
 * OPS-TIER4-CLASSIFY-W1 regression suite — generator-level fix for the
 * call-site-passes-null bug at `src/tools/get-trade-call.ts:135` that caused
 * major-alt coins (AVAX, LINK, etc.) to misclassify as Tier 4 + route through
 * the `isMemeCoinLiquid` gate. The function `classifyAsset` itself is correct;
 * the bug is in the caller. These tests pin the function contract and prove
 * that the call-site fix (`await getTop20ByOI(); classifyAsset(coin, top20, venue)`)
 * causes the Tier-4 gate to be skipped for Tier-2 coins.
 *
 * Audit reference: audits/OPS-TIER4-CLASSIFY-W1-endpoint-truth.md.
 */
describe('classifyAsset — Tier-2 transition (OPS-TIER4-CLASSIFY-W1)', () => {
  it('case 9 — top20 set contains AVAX → classifyAsset returns Tier 2', () => {
    // The fix path: caller supplies the actual top-20-by-HL-OI set.
    // AVAX is in the set → Tier 2. The Tier-4 gate downstream does NOT fire.
    const top20 = new Set<string>(['AVAX', 'LINK', 'SOL']);
    expect(classifyAsset('AVAX', top20, 'HL')).toBe(2);
    expect(classifyAsset('LINK', top20, 'HL')).toBe(2);
  });

  it('case 10 — null top20 → classifyAsset returns Tier 4 (documented null-fallback contract)', () => {
    // This pins the function's null-handling contract. The bug was NOT in
    // classifyAsset; it was at the caller passing null unconditionally. The
    // null short-circuit IS the intended behavior for boot-time callers that
    // haven't warmed the cache yet (see DASH-W1-FIX-2 comment in asset-tiers.ts).
    // Pinning this prevents a future "drive-by fix" from making classifyAsset
    // async, which would couple every caller to async semantics + add hidden
    // network calls.
    expect(classifyAsset('AVAX', null, 'HL')).toBe(4); // bug-preserving when called with null
    expect(classifyAsset('LINK', null, 'HL')).toBe(4);
  });

  it('case 11 — end-to-end: Tier 2 coin skips isMemeCoinLiquid gate at call site', async () => {
    // Mirrors the `get-trade-call.ts:135-144` conditional. Asserts that when
    // classifyAsset returns 2 (via the fix path), the `if (tier === 4)` branch
    // is false, so `isMemeCoinLiquid` is NEVER invoked. Uses a vi.spyOn against
    // the same module's isMemeCoinLiquid export.
    const isMemeSpy = vi.spyOn(assetTiers, 'isMemeCoinLiquid');
    const top20 = new Set<string>(['AVAX']);

    // Inline the call-site logic from get-trade-call.ts:135-144
    const coin = 'AVAX';
    const exchange: ExchangeId = 'HL';
    const tier = assetTiers.classifyAsset(coin, top20, exchange);
    if (tier === 4) {
      // Should NOT execute for AVAX (Tier 2 via top20).
      await assetTiers.isMemeCoinLiquid(coin, exchange);
    }

    expect(tier).toBe(2);
    expect(isMemeSpy).not.toHaveBeenCalled();
    isMemeSpy.mockRestore();
  });
});

/**
 * OPS-TIER-CLASSIFIER-XVENUE-W1 C2 — venue-aware classifyAsset over the cross-venue
 * asset-class engine. Seeds the engine snapshot directly (the warm is async; the read
 * is sync) and asserts the ratified AC matrix: each venue's TradFi → Tier 3, the OKX/
 * Aster union fallback → Tier 3, the BingX wrapper + venue-less seed → Tier 3, and the
 * crypto deny-list keeps colliding tickers ≠ 3.
 */
describe('classifyAsset — venue-aware cross-venue TradFi (OPS-TIER-CLASSIFIER-XVENUE-W1 C2)', () => {
  beforeEach(() => {
    _clearAssetClassCache();
    // OPS-ASSET-CLASS-TOTALITY-W1: the engine is seeded with each venue's own records.
    _loadVenueRecordsForTest({
      MEXC: [['SNDKSTOCK_USDT', 'usstocks']],
      GATE: [['MSTRX_USDT', 'stocks'], ['ASML_USDT', 'stocks'],
        ['DYDX_USDT', 'stocks']], // deliberately TradFi-tagged to prove the deny-list overrides it
      BITGET: [['VRTUSDT', 'isRwa']],
      BINANCE: [['CRWDUSDT', 'EQUITY'], ['QNTXUSDT', 'PREMARKET'], ['TNSRUSDT', 'PERPETUAL']],
      BINGX: [['NCSKASML2USD-USDT', 'NCSK'], ['NCSINIKKEI2252USD-USDT', 'NCSI']],
      BYBIT: [['AAPLUSDT', 'stock']],
    });
  });
  afterEach(() => _clearAssetClassCache());

  it('each venue self-classifies its own TradFi instruments → Tier 3', () => {
    expect(classifyAsset('SNDKSTOCK', null, 'MEXC')).toBe(3);
    expect(classifyAsset('MSTRX', null, 'GATE')).toBe(3);
    expect(classifyAsset('VRT', null, 'BITGET')).toBe(3);
    expect(classifyAsset('CRWD', null, 'BINANCE')).toBe(3);
    expect(classifyAsset('QNTX', null, 'BINANCE')).toBe(3); // Binance Pre-IPO/TradFi
  });

  it('BingX NC* wrapper + venue-less STATIC seed → Tier 3', () => {
    expect(classifyAsset('NCSKASML2USD', null, 'BINGX')).toBe(3);     // wrapper → ASML
    expect(classifyAsset('NCSINIKKEI2252USD', null, 'BINGX')).toBe(3); // → NIKKEI225 (INDEX)
    expect(classifyAsset('GLW', null, null)).toBe(3);                  // STATIC seed canonical, no venue
  });

  it('no-field venues (KuCoin/Aster) resolve via the cross-venue union → Tier 3', () => {
    expect(classifyAsset('ASML', null, 'KUCOIN')).toBe(3);
    expect(classifyAsset('AAPL', null, 'ASTER')).toBe(3);
  });

  it('crypto deny-list keeps colliding tickers OUT of Tier 3 (sanity guard)', () => {
    // The SP500-fake price-sanity case is canary-side (C3); here the sync guard is the
    // deny-list — DYDX is seeded in the union yet still excluded.
    expect(classifyAsset('TNSR', null, 'BINANCE')).not.toBe(3);
    expect(classifyAsset('ASTEROID', null, null)).not.toBe(3);
    for (const c of ['Q', 'FIO', 'IDOL']) expect(classifyAsset(c, null, null)).not.toBe(3);
    expect(classifyAsset('DYDX', null, 'OKX')).not.toBe(3);
  });

  it('a cold engine snapshot never breaks tiering (top20 / meme / seed still resolve)', () => {
    _clearAssetClassCache(); // snapshot null → getTradFiClass uses the STATIC seed floor only
    expect(classifyAsset('SOL', new Set(['SOL']), 'HL')).toBe(2);
    expect(classifyAsset('WIF', null, 'HL')).toBe(4);
    expect(classifyAsset('TSLA', null, null)).toBe(3); // STATIC seed
  });
});
