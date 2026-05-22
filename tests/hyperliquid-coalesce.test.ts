/**
 * tests/hyperliquid-coalesce.test.ts — OPS-HL-RATELIMIT-W1 regression suite
 * for the adapter-layer `metaAndAssetCtxs` coalescing cache.
 *
 * Coverage:
 *   1. N concurrent getAssetContext callers (same dex) share 1 backend fetch.
 *   2. Sequential getAssetContext callers within TTL share 1 backend fetch.
 *   3. Standard vs xyz dex are cached independently (2 fetches for 2 dexes).
 *   4. After TTL expiry, next call triggers a fresh backend fetch.
 *   5. _resetHyperliquidMetaCache() clears the cache.
 *   6. candleSnapshot (separate endpoint) is NOT coalesced — every call hits backend.
 *
 * Root cause + audit: audits/OPS-HL-RATELIMIT-W1-endpoint-truth.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  HyperliquidAdapter,
  _resetHyperliquidMetaCache,
} from '../src/lib/adapters/hyperliquid.js';

// Minimal HL metaAndAssetCtxs response: 1 asset (BTC) sufficient for getAssetContext.
function makeMetaResponse(coin = 'BTC') {
  return [
    { universe: [{ name: coin }] },
    [
      {
        funding: '0.0001',
        openInterest: '1000',
        prevDayPx: '100000',
        dayNtlVlm: '5000000000',
        oraclePx: '101000',
        markPx: '101000',
      },
    ],
  ];
}

// Minimal HL candleSnapshot response: 1 candle.
function makeCandleResponse() {
  return [{ t: 0, o: '100', h: '101', l: '99', c: '100', v: '10' }];
}

interface FetchSpy {
  metaCalls: () => number;
  candleCalls: () => number;
}

function installFetchSpy(): FetchSpy {
  let metaCalls = 0;
  let candleCalls = 0;
  const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
    if (body.type === 'metaAndAssetCtxs') {
      metaCalls++;
      return new Response(JSON.stringify(makeMetaResponse()), { status: 200 });
    }
    if (body.type === 'candleSnapshot') {
      candleCalls++;
      return new Response(JSON.stringify(makeCandleResponse()), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.spyOn(global, 'fetch').mockImplementation(fakeFetch as typeof fetch);
  return { metaCalls: () => metaCalls, candleCalls: () => candleCalls };
}

describe('hyperliquid adapter — metaAndAssetCtxs coalescing (OPS-HL-RATELIMIT-W1)', () => {
  let fetchSpy: FetchSpy;
  let adapter: HyperliquidAdapter;

  beforeEach(() => {
    _resetHyperliquidMetaCache();
    fetchSpy = installFetchSpy();
    adapter = new HyperliquidAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetHyperliquidMetaCache();
  });

  it('coalesces N concurrent getAssetContext callers to 1 backend fetch (same dex)', async () => {
    const N = 20;
    const calls = Array.from({ length: N }, () => adapter.getAssetContext('BTC', 'standard'));
    const results = await Promise.all(calls);
    expect(results).toHaveLength(N);
    expect(fetchSpy.metaCalls()).toBe(1);
    for (const r of results) {
      expect(r.coin).toBe('BTC');
      expect(r.markPx).toBe(101000);
    }
  });

  it('reuses cached result for sequential callers within 60s TTL', async () => {
    await adapter.getAssetContext('BTC', 'standard');
    await adapter.getAssetContext('BTC', 'standard');
    await adapter.getAssetContext('BTC', 'standard');
    expect(fetchSpy.metaCalls()).toBe(1);
  });

  it('caches standard and xyz dex independently (2 fetches for 2 dexes)', async () => {
    // xyz callers will throw because 'BTC' isn't in the xyz universe name 'xyz:BTC' —
    // the assertion is purely on fetch-call-count semantics (dex-keyed cache isolation).
    const stdCalls = Array.from({ length: 5 }, () => adapter.getAssetContext('BTC', 'standard'));
    const xyzCalls = Array.from({ length: 5 }, () =>
      adapter.getAssetContext('BTC', 'xyz').catch(() => null),
    );
    await Promise.all([...stdCalls, ...xyzCalls]);
    expect(fetchSpy.metaCalls()).toBe(2);
  });

  it('triggers fresh fetch after TTL expiry (Date.now shifted past 60s)', async () => {
    const baseTime = Date.now();
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime + offset);
    try {
      await adapter.getAssetContext('BTC', 'standard');
      expect(fetchSpy.metaCalls()).toBe(1);
      // Shift past 60s TTL — next call MUST refetch.
      offset = 61_000;
      await adapter.getAssetContext('BTC', 'standard');
      expect(fetchSpy.metaCalls()).toBe(2);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('_resetHyperliquidMetaCache clears the cache', async () => {
    await adapter.getAssetContext('BTC', 'standard');
    expect(fetchSpy.metaCalls()).toBe(1);
    _resetHyperliquidMetaCache();
    await adapter.getAssetContext('BTC', 'standard');
    expect(fetchSpy.metaCalls()).toBe(2);
  });

  it('does NOT coalesce candleSnapshot — every getCandles call hits backend', async () => {
    const t = Date.now() - 60_000;
    await adapter.getCandles('BTC', '3m', t);
    await adapter.getCandles('ETH', '3m', t);
    await adapter.getCandles('SOL', '3m', t);
    expect(fetchSpy.candleCalls()).toBe(3);
    expect(fetchSpy.metaCalls()).toBe(0);
  });
});
