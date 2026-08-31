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
  _resetHyperliquidPredictedFundingsCache,
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

// Minimal HL predictedFundings response: the wire shape is
// [coin, [[venue, {fundingRate, nextFundingTime}], ...]] — universe-wide, NO coin parameter.
function makeFundingResponse() {
  return [
    ['BTC', [['BinPerp', { fundingRate: '0.0001', nextFundingTime: 111 }],
             ['HlPerp',  { fundingRate: '0.00002', nextFundingTime: 222 }]]],
    ['ETH', [['BinPerp', { fundingRate: '-0.00005', nextFundingTime: 333 }]]],
  ];
}

interface FetchSpy {
  metaCalls: () => number;
  candleCalls: () => number;
  fundingCalls: () => number;
}

function installFetchSpy(): FetchSpy {
  let metaCalls = 0;
  let candleCalls = 0;
  let fundingCalls = 0;
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
    if (body.type === 'predictedFundings') {
      fundingCalls++;
      return new Response(JSON.stringify(makeFundingResponse()), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.spyOn(global, 'fetch').mockImplementation(fakeFetch as typeof fetch);
  return {
    metaCalls: () => metaCalls,
    candleCalls: () => candleCalls,
    fundingCalls: () => fundingCalls,
  };
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

/**
 * OPS-HL-INTERACTIVE-STARVATION-W1 CH2 — predictedFundings coalescing.
 *
 * `getPredictedFundings()` was the ONE HL call on the `get_market_regime` path still going direct
 * to `hlInfoPost` while its neighbour `metaAndAssetCtxs` had been coalesced since OPS-HL-RATELIMIT-W1.
 * At weight 20 it is ~half the ~41 weight a default 4h/HL regime call spends, on a payload that is
 * identical for every caller — which is what produced bursts of up to 106 interactive
 * BUDGET_CEILING throws in a SINGLE minute against a 450-weight reserve.
 *
 * The chapter's gate is OUTPUT IDENTITY, so the first assertions here are not about fetch counts
 * at all: they prove a cached caller receives byte-identical data to an uncached one.
 */
describe('hyperliquid adapter — predictedFundings coalescing (OPS-HL-INTERACTIVE-STARVATION-W1 CH2)', () => {
  let fetchSpy: FetchSpy;
  let adapter: HyperliquidAdapter;

  beforeEach(() => {
    _resetHyperliquidPredictedFundingsCache();
    fetchSpy = installFetchSpy();
    adapter = new HyperliquidAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetHyperliquidPredictedFundingsCache();
  });

  it('OUTPUT IDENTITY — a cache-served caller gets byte-identical JSON to the backend-served one', async () => {
    const first = await adapter.getPredictedFundings();
    const cached = await adapter.getPredictedFundings();
    expect(JSON.stringify(cached)).toBe(JSON.stringify(first));
    expect(fetchSpy.fundingCalls()).toBe(1);
  });

  it('OUTPUT IDENTITY — the coalesced result equals what an UNCACHED fetch returns', async () => {
    const cachedRun = await adapter.getPredictedFundings();
    // Drop the cache and fetch again from the backend: same bytes, so coalescing changed nothing
    // about WHAT is returned, only how often it is asked for.
    _resetHyperliquidPredictedFundingsCache();
    const freshRun = await adapter.getPredictedFundings();
    expect(JSON.stringify(freshRun)).toBe(JSON.stringify(cachedRun));
    expect(fetchSpy.fundingCalls()).toBe(2);
  });

  it('hands each caller its OWN array — a shared mutable result would leak across requests', async () => {
    const a = await adapter.getPredictedFundings();
    const b = await adapter.getPredictedFundings();
    expect(a).not.toBe(b);              // distinct array objects…
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));  // …with identical contents
    a.length = 0;                        // mutating one must not affect the next caller
    const c = await adapter.getPredictedFundings();
    expect(c.length).toBeGreaterThan(0);
  });

  it('collapses a CONCURRENT burst to ONE backend fetch — the starvation fix, in one assertion', async () => {
    // 30 concurrent callers is the measured burst shape. Uncoalesced that is 30 x 20 = 600 weight
    // against a 450 reserve; coalesced it is 20.
    const results = await Promise.all(Array.from({ length: 30 }, () => adapter.getPredictedFundings()));
    expect(fetchSpy.fundingCalls()).toBe(1);
    // Every one of the 30 still gets the full, correct payload.
    const expected = JSON.stringify(results[0]);
    for (const r of results) expect(JSON.stringify(r)).toBe(expected);
    expect(results[0].length).toBe(2);
  });

  it('reuses the cached payload for sequential callers within the 60s TTL', async () => {
    await adapter.getPredictedFundings();
    await adapter.getPredictedFundings();
    await adapter.getPredictedFundings();
    expect(fetchSpy.fundingCalls()).toBe(1);
  });

  it('refetches after the 60s TTL expires — this is a cache, not a freeze', async () => {
    const baseTime = Date.now();
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => baseTime + offset);
    try {
      await adapter.getPredictedFundings();
      expect(fetchSpy.fundingCalls()).toBe(1);
      offset = 61_000;
      await adapter.getPredictedFundings();
      expect(fetchSpy.fundingCalls()).toBe(2);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it('does NOT memoise a failure — a refusal must not poison the next 60s', async () => {
    // negativeTtlMs: 0 + staleOk: false. If a BUDGET_CEILING refusal were cached, one bad minute
    // would degrade every caller for the whole TTL — turning a burst problem into a sustained one.
    let attempt = 0;
    vi.spyOn(global, 'fetch').mockImplementation((async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { type?: string };
      if (body.type === 'predictedFundings') {
        attempt++;
        if (attempt === 1) return new Response('upstream refused', { status: 429 });
        return new Response(JSON.stringify(makeFundingResponse()), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch);

    await expect(adapter.getPredictedFundings()).rejects.toThrow();
    // The very next call retries rather than inheriting the failure.
    const recovered = await adapter.getPredictedFundings();
    expect(recovered.length).toBe(2);
    expect(attempt).toBe(2);
  });

  it('_resetHyperliquidPredictedFundingsCache clears the cache', async () => {
    await adapter.getPredictedFundings();
    expect(fetchSpy.fundingCalls()).toBe(1);
    _resetHyperliquidPredictedFundingsCache();
    await adapter.getPredictedFundings();
    expect(fetchSpy.fundingCalls()).toBe(2);
  });

  it('leaves the meta cache independent — two caches, two keys, no cross-talk', async () => {
    await adapter.getPredictedFundings();
    await adapter.getAssetContext('BTC');
    expect(fetchSpy.fundingCalls()).toBe(1);
    expect(fetchSpy.metaCalls()).toBe(1);
  });
});
