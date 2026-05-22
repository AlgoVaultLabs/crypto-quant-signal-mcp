/**
 * tests/binance-coalesce.test.ts — OPS-BINANCE-POLITE-DELAY-W1 regression suite
 * for the adapter-layer bulk-coalescing caches on `/fapi/v1/ticker/24hr` (full
 * universe) and `/fapi/v1/premiumIndex` (full universe).
 *
 * Coverage:
 *   1. N concurrent getAssetContext callers share 1 ticker24hr + 1 premiumIndex
 *      backend fetch (still N openInterest fetches — no bulk endpoint).
 *   2. Sequential getAssetContext callers within 60s TTL reuse both caches.
 *   3. After 60s TTL expiry, next call triggers fresh ticker24hr + premiumIndex
 *      backend fetches.
 *   4. _resetBinanceAdapterCaches() clears both caches.
 *   5. openInterest is NOT coalesced — every getAssetContext call hits backend
 *      for openInterest (no bulk endpoint exists in Binance).
 *   6. getCandles (klines) is NOT coalesced — every call hits backend
 *      regardless of cache state.
 *   7. getAssetContext math equivalence — values returned match what per-symbol
 *      endpoints would have returned (pre-fix behavior preserved).
 *   8. getPredictedFundings reads from the same coalesced premiumIndex cache.
 *
 * Root cause + audit: audits/OPS-BINANCE-POLITE-DELAY-W1-endpoint-truth.md.
 * Pattern mirrors tests/hyperliquid-coalesce.test.ts (OPS-HL-RATELIMIT-W1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  BinanceAdapter,
  getTicker24hrFullCoalesced,
  getPremiumIndexBulkCoalesced,
  _resetBinanceAdapterCaches,
} from '../src/lib/adapters/binance.js';

// Minimal bulk ticker/24hr response: BTC + ETH + SOL.
function makeTicker24hrBulkResponse() {
  return [
    { symbol: 'BTCUSDT', volume: '1000', quoteVolume: '100000000', lastPrice: '100000', prevClosePrice: '99000' },
    { symbol: 'ETHUSDT', volume: '5000', quoteVolume: '20000000', lastPrice: '4000', prevClosePrice: '3950' },
    { symbol: 'SOLUSDT', volume: '8000', quoteVolume: '8000000', lastPrice: '200', prevClosePrice: '198' },
  ];
}

// Minimal bulk premiumIndex response.
function makePremiumIndexBulkResponse() {
  return [
    { symbol: 'BTCUSDT', markPrice: '100500', lastFundingRate: '0.0001', nextFundingTime: 1700000000000 },
    { symbol: 'ETHUSDT', markPrice: '4010', lastFundingRate: '0.00005', nextFundingTime: 1700000000000 },
    { symbol: 'SOLUSDT', markPrice: '201', lastFundingRate: '0.00008', nextFundingTime: 1700000000000 },
  ];
}

// Minimal openInterest per-symbol response.
function makeOpenInterestResponse(symbol: string) {
  // BTC OI in coins (1000), ETH (5000), SOL (10000) — values arbitrary
  const map: Record<string, string> = { BTCUSDT: '1000', ETHUSDT: '5000', SOLUSDT: '10000' };
  return { openInterest: map[symbol] ?? '0', symbol };
}

// Minimal klines response: 1 candle.
function makeKlinesResponse() {
  return [[1700000000000, '100', '101', '99', '100', '50']];
}

interface FetchSpy {
  ticker24hrBulkCalls: () => number;
  ticker24hrSymbolCalls: () => number;
  premiumIndexBulkCalls: () => number;
  premiumIndexSymbolCalls: () => number;
  openInterestCalls: () => number;
  klinesCalls: () => number;
}

function installFetchSpy(): FetchSpy {
  let ticker24hrBulk = 0;
  let ticker24hrSymbol = 0;
  let premiumIndexBulk = 0;
  let premiumIndexSymbol = 0;
  let openInterest = 0;
  let klines = 0;
  const fakeFetch = vi.fn(async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes('/fapi/v1/ticker/24hr')) {
      if (urlStr.includes('symbol=')) {
        ticker24hrSymbol++;
        // Per-symbol response shape — not used by post-fix code, but kept for
        // defense-in-depth if some caller still hits it.
        return new Response(JSON.stringify(makeTicker24hrBulkResponse()[0]), { status: 200 });
      }
      ticker24hrBulk++;
      return new Response(JSON.stringify(makeTicker24hrBulkResponse()), { status: 200 });
    }
    if (urlStr.includes('/fapi/v1/premiumIndex')) {
      if (urlStr.includes('symbol=')) {
        premiumIndexSymbol++;
        return new Response(JSON.stringify(makePremiumIndexBulkResponse()[0]), { status: 200 });
      }
      premiumIndexBulk++;
      return new Response(JSON.stringify(makePremiumIndexBulkResponse()), { status: 200 });
    }
    if (urlStr.includes('/fapi/v1/openInterest')) {
      openInterest++;
      const symbolMatch = urlStr.match(/symbol=([A-Z0-9]+)/);
      const sym = symbolMatch ? symbolMatch[1] : 'BTCUSDT';
      return new Response(JSON.stringify(makeOpenInterestResponse(sym)), { status: 200 });
    }
    if (urlStr.includes('/fapi/v1/klines')) {
      klines++;
      return new Response(JSON.stringify(makeKlinesResponse()), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.spyOn(global, 'fetch').mockImplementation(fakeFetch as typeof fetch);
  return {
    ticker24hrBulkCalls: () => ticker24hrBulk,
    ticker24hrSymbolCalls: () => ticker24hrSymbol,
    premiumIndexBulkCalls: () => premiumIndexBulk,
    premiumIndexSymbolCalls: () => premiumIndexSymbol,
    openInterestCalls: () => openInterest,
    klinesCalls: () => klines,
  };
}

describe('binance adapter — bulk coalescing (OPS-BINANCE-POLITE-DELAY-W1)', () => {
  let fetchSpy: FetchSpy;
  let adapter: BinanceAdapter;

  beforeEach(() => {
    _resetBinanceAdapterCaches();
    fetchSpy = installFetchSpy();
    adapter = new BinanceAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetBinanceAdapterCaches();
  });

  it('coalesces N concurrent getAssetContext callers — 1 ticker24hr + 1 premiumIndex backend fetch, N openInterest fetches', async () => {
    const N = 20;
    const calls = Array.from({ length: N }, (_, i) => {
      const coin = ['BTC', 'ETH', 'SOL'][i % 3];
      return adapter.getAssetContext(coin);
    });
    const results = await Promise.all(calls);
    expect(results).toHaveLength(N);
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(1);
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
    // Each getAssetContext fires its own per-symbol openInterest (no bulk endpoint).
    expect(fetchSpy.openInterestCalls()).toBe(N);
    // No per-symbol ticker24hr or premiumIndex calls — all served from bulk caches.
    expect(fetchSpy.ticker24hrSymbolCalls()).toBe(0);
    expect(fetchSpy.premiumIndexSymbolCalls()).toBe(0);
  });

  it('reuses cached results for sequential callers within 60s TTL', async () => {
    await adapter.getAssetContext('BTC');
    await adapter.getAssetContext('ETH');
    await adapter.getAssetContext('SOL');
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(1);
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
    expect(fetchSpy.openInterestCalls()).toBe(3);
  });

  it('triggers fresh ticker24hr + premiumIndex bulk fetches after 60s TTL expiry', async () => {
    const baseTime = Date.now();
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime + offset);
    try {
      await adapter.getAssetContext('BTC');
      expect(fetchSpy.ticker24hrBulkCalls()).toBe(1);
      expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
      // Shift past 60s TTL — next call MUST refetch both.
      offset = 61_000;
      await adapter.getAssetContext('BTC');
      expect(fetchSpy.ticker24hrBulkCalls()).toBe(2);
      expect(fetchSpy.premiumIndexBulkCalls()).toBe(2);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('_resetBinanceAdapterCaches clears both caches', async () => {
    await adapter.getAssetContext('BTC');
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(1);
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
    _resetBinanceAdapterCaches();
    await adapter.getAssetContext('BTC');
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(2);
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(2);
  });

  it('does NOT coalesce openInterest — Binance has no bulk OI endpoint', async () => {
    await adapter.getAssetContext('BTC');
    await adapter.getAssetContext('ETH');
    await adapter.getAssetContext('SOL');
    // 3 distinct per-symbol openInterest fetches.
    expect(fetchSpy.openInterestCalls()).toBe(3);
  });

  it('does NOT coalesce getCandles — every klines call hits backend', async () => {
    const t = Date.now() - 60_000;
    await adapter.getCandles('BTC', '3m', t);
    await adapter.getCandles('ETH', '3m', t);
    await adapter.getCandles('SOL', '3m', t);
    expect(fetchSpy.klinesCalls()).toBe(3);
    // Klines path doesn't touch ticker24hr or premiumIndex caches.
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(0);
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(0);
  });

  it('getAssetContext returns equivalent values — math preserved pre/post coalescing', async () => {
    const result = await adapter.getAssetContext('BTC');
    // Values are derived from the bulk-response BTC entries:
    //   premiumIndex.lastFundingRate = '0.0001' → funding = 0.0001
    //   funding × 1095 = 0.1095 (annualized)
    //   premiumIndex.markPrice = '100500' → markPx + oraclePx = 100500
    //   ticker24hr.prevClosePrice = '99000' → prevDayPx = 99000
    //   ticker24hr.quoteVolume = '100000000' → volume24h = 100_000_000
    //   openInterest BTC = '1000' → openInterest = 1000
    expect(result.coin).toBe('BTC');
    expect(result.funding).toBeCloseTo(0.0001, 8);
    expect(result.fundingAnnualized).toBeCloseTo(0.1095, 6);
    expect(result.markPx).toBe(100500);
    expect(result.oraclePx).toBe(100500);
    expect(result.prevDayPx).toBe(99000);
    expect(result.volume24h).toBe(100_000_000);
    expect(result.openInterest).toBe(1000);
  });

  it('getPredictedFundings reads from coalesced premiumIndex cache — shares with getAssetContext', async () => {
    // Warm the cache via getAssetContext first.
    await adapter.getAssetContext('BTC');
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
    // getPredictedFundings should NOT trigger a fresh bulk fetch within TTL.
    const fundings = await adapter.getPredictedFundings();
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
    // Verify return shape: 3 entries (BTC, ETH, SOL all USDT-suffixed).
    expect(fundings).toHaveLength(3);
    const btc = fundings.find((f) => f.coin === 'BTC');
    expect(btc).toBeDefined();
    expect(btc?.venues[0].venue).toBe('BinPerp');
    expect(btc?.venues[0].fundingRate).toBeCloseTo(0.0001, 8);
  });

  it('exported getTicker24hrFullCoalesced returns the bulk response array directly', async () => {
    const data = await getTicker24hrFullCoalesced();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(3);
    expect(data[0].symbol).toBe('BTCUSDT');
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(1);
  });

  it('exported getPremiumIndexBulkCoalesced returns the bulk response array directly', async () => {
    const data = await getPremiumIndexBulkCoalesced();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(3);
    expect(data[0].symbol).toBe('BTCUSDT');
    expect(fetchSpy.premiumIndexBulkCalls()).toBe(1);
  });

  it('inflight-promise dedup — concurrent first-time callers share one in-flight fetch', async () => {
    // 10 concurrent first-time callers on a cold cache: only 1 backend fetch fires.
    const calls = Array.from({ length: 10 }, () => getTicker24hrFullCoalesced());
    const results = await Promise.all(calls);
    expect(results).toHaveLength(10);
    expect(fetchSpy.ticker24hrBulkCalls()).toBe(1);
    // All results reference the same cached array (reference equality after first resolution).
    for (const r of results) {
      expect(r).toBe(results[0]);
    }
  });
});
