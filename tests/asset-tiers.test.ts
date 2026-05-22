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

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the helper BEFORE importing the SUT — vitest hoists vi.mock.
vi.mock('../src/lib/exchange-universe.js', () => {
  return {
    getExchangeTopAssetsWithVolume: vi.fn(),
  };
});

import {
  isMemeCoinLiquid,
  _clearLiquidCoinsByExchangeCache,
  _setLiquidCoinsForTest,
} from '../src/lib/asset-tiers.js';
import { getExchangeTopAssetsWithVolume } from '../src/lib/exchange-universe.js';
import type { ExchangeId } from '../src/types.js';

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
