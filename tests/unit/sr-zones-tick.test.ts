/**
 * SR-ZONES-W2 CH1 AC1.4 — the venue tick behind the step.
 *
 * One Binance /fapi/v1/exchangeInfo read (PRICE_FILTER.tickSize per symbol) serves every coin for 24 h. A failed read
 * serves the call with the significant-figure step, otherwise unchanged, and is remembered for 60 s. The read runs in
 * the batch weight class under get_sr_zones's tag; the handler waits for it at most 2 s.
 *
 * EXCHANGE_INFO carries the live shape, measured 2026-11-16 (GET fapi.binance.com/fapi/v1/exchangeInfo, 946 symbols,
 * x-mbx-used-weight-1m 1): BTCUSDT "0.10", ETHUSDT "0.01", 1000PEPEUSDT "0.0000001" — decimal strings with trailing zeros.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { adapterRef } = vi.hoisted(() => ({ adapterRef: { current: {} as Record<string, unknown> } }));
vi.mock('../../src/lib/exchange-adapter.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
  getAdapter: () => adapterRef.current,
}));

import { BinanceAdapter, _resetBinanceAdapterCaches } from '../../src/lib/adapters/binance.js';
import { DEFAULT_SR_ZONES_DEPS, runGetSrZones, type SrZonesDeps, type GetSrZonesResponse } from '../../src/tools/get-sr-zones.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { currentCaller, currentWeightClass, runAsCaller } from '../../src/lib/upstream-weight-budget.js';
import { processScopedTag } from '../../src/lib/caller-tags.js';
import { btcFixtureWithForming } from './sr-zones-helpers.js';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const DAY = 86_400_000;

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      filters: [
        { minPrice: '556.80', filterType: 'PRICE_FILTER', maxPrice: '4529764', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001' },
      ],
    },
    { symbol: 'ETHUSDT', filters: [{ filterType: 'PRICE_FILTER', minPrice: '39.86', maxPrice: '306177', tickSize: '0.01' }] },
    { symbol: '1000PEPEUSDT', filters: [{ tickSize: '0.0000001', minPrice: '0.0000001', maxPrice: '200', filterType: 'PRICE_FILTER' }] },
    { symbol: 'ZEROUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0' }] },
    { symbol: 'NOFILTERUSDT', filters: [] },
  ],
};

/** fetch, answering exchangeInfo with `body()`; counts those reads. */
function stubExchangeInfo(body: () => unknown): { reads: () => number } {
  let reads = 0;
  vi.spyOn(global, 'fetch').mockImplementation((async (url: string | URL | Request) => {
    if (String(url).includes('/fapi/v1/exchangeInfo')) {
      reads++;
      return new Response(JSON.stringify(body()), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch);
  return { reads: () => reads };
}

beforeEach(() => {
  _resetBinanceAdapterCaches();
  _resetCallTrackersForTest();
  resetLicenseCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetBinanceAdapterCaches();
});

describe('SR-ZONES-W2 AC1.4 — Binance getPriceTick: one exchangeInfo read, every coin, 24 h', () => {
  it('one read answers every coin, through the same symbol mapping as the candles', async () => {
    const f = stubExchangeInfo(() => EXCHANGE_INFO);
    const a = new BinanceAdapter();
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(await a.getPriceTick('ETH')).toBe(0.01);
    expect(await a.getPriceTick('PEPE')).toBe(1e-7);
    expect(await a.getPriceTick('NOPE')).toBeNull();
    expect(f.reads()).toBe(1);
  });

  it('concurrent cold reads share one request', async () => {
    const f = stubExchangeInfo(() => EXCHANGE_INFO);
    const a = new BinanceAdapter();
    const got = await Promise.all(['BTC', 'ETH', 'BTC', 'PEPE', 'ETH'].map((c) => a.getPriceTick(c)));
    expect(got).toEqual([0.1, 0.01, 0.1, 1e-7, 0.01]);
    expect(f.reads()).toBe(1);
  });

  it('the read is reused for 24 h, then read again', async () => {
    const f = stubExchangeInfo(() => EXCHANGE_INFO);
    const a = new BinanceAdapter();
    await a.getPriceTick('BTC');
    vi.setSystemTime(new Date(NOW + DAY - 1));
    expect(await a.getPriceTick('ETH')).toBe(0.01);
    expect(f.reads()).toBe(1);
    vi.setSystemTime(new Date(NOW + DAY));
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(f.reads()).toBe(2);
  });

  it('a zero or missing PRICE_FILTER tick is unknown, never a step of 0', async () => {
    stubExchangeInfo(() => EXCHANGE_INFO);
    const a = new BinanceAdapter();
    expect(await a.getPriceTick('ZERO')).toBeNull();
    expect(await a.getPriceTick('NOFILTER')).toBeNull();
  });

  it('a failed read answers null, is remembered for 60 s, and is read again after', async () => {
    let body: unknown = { code: -1, msg: 'not the exchangeInfo shape' };
    const f = stubExchangeInfo(() => body);
    const a = new BinanceAdapter();
    expect(await a.getPriceTick('BTC')).toBeNull();
    expect(f.reads()).toBe(1);
    vi.setSystemTime(new Date(NOW + 59_999));
    expect(await a.getPriceTick('ETH')).toBeNull();
    expect(f.reads()).toBe(1);
    body = EXCHANGE_INFO;
    vi.setSystemTime(new Date(NOW + 60_000));
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(f.reads()).toBe(2);
  });

  it('a read with no usable tick at all is a failed read (60 s), not an empty answer kept for 24 h', async () => {
    let body: unknown = { symbols: [EXCHANGE_INFO.symbols[4]] };
    const f = stubExchangeInfo(() => body);
    const a = new BinanceAdapter();
    expect(await a.getPriceTick('BTC')).toBeNull();
    body = EXCHANGE_INFO;
    vi.setSystemTime(new Date(NOW + 60_000));
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(f.reads()).toBe(2);
  });

  // R7 #4: a failed read is visible in the log — once per 60 s memo window, quiet while the memo answers.
  it.each([
    ['not the exchangeInfo shape', { code: -1, msg: 'not the exchangeInfo shape' }],
    ['no usable tick on any symbol', { symbols: [EXCHANGE_INFO.symbols[4]] }],
  ])('a failed read (%s) logs once per 60 s memo window and stays quiet while the memo answers', async (_label, failed) => {
    let body: unknown = failed;
    const f = stubExchangeInfo(() => body);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = new BinanceAdapter();
    expect(await Promise.all(['BTC', 'ETH', 'PEPE'].map((c) => a.getPriceTick(c)))).toEqual([null, null, null]);
    expect(f.reads()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/exchangeInfo/);
    vi.setSystemTime(new Date(NOW + 59_999));
    expect(await a.getPriceTick('BTC')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(NOW + 60_000));
    expect(await a.getPriceTick('BTC')).toBeNull();
    expect(f.reads()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    body = EXCHANGE_INFO;
    vi.setSystemTime(new Date(NOW + 120_000));
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(f.reads()).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a good read logs nothing', async () => {
    stubExchangeInfo(() => EXCHANGE_INFO);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = new BinanceAdapter();
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('SR-ZONES-W2 AC1.4 — the handler: a failed tick read serves the call with sig, otherwise unchanged', () => {
  const series = btcFixtureWithForming(67_585.6);
  const deps = (getPriceTick: SrZonesDeps['getPriceTick']): SrZonesDeps => ({
    nowMs: () => NOW,
    cache: new Map(),
    failures: new Map(),
    getCandles: async (_coin, _tf, startTime) => series.filter((c) => c.time >= startTime).slice(0, 200),
    getPriceTick,
  });
  const serve = async (getPriceTick: SrZonesDeps['getPriceTick']): Promise<GetSrZonesResponse> => {
    _resetCallTrackersForTest();
    resetLicenseCache();
    const o = await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, { tier: 'free', key: 'av_srz_tick' }, deps(getPriceTick));
    if (o.kind !== 'ok') throw new Error(JSON.stringify(o.payload));
    return o.response;
  };
  /** The response with what a different step moves masked: the edges and what reads them (R7 #3), and the summary's. */
  const masked = (r: GetSrZonesResponse): string =>
    JSON.stringify(r, (k, v) =>
      k === 'low' || k === 'high' || k === 'distance_pct'
        ? 0
        : k === 'summary'
          ? String(v).replace(/zone 1 at [0-9.]+–[0-9.]+(, [0-9.]+% (?:below|above))?/g, '')
          : v,
    );

  it('tick 0.3 → step 10.2; a rejected, null or throwing read → sig 10; nothing but the edges and what reads them moves', async () => {
    const withTick = await serve(async () => 0.3);
    expect(withTick.results[0].support[0]).toMatchObject({ low: 62_475, high: 63_240 });
    for (const failing of [
      async () => { throw new Error('Binance API 503'); },
      async () => null,
      (() => { throw new Error('synchronous'); }) as SrZonesDeps['getPriceTick'],
    ]) {
      const r = await serve(failing);
      expect(r.results[0].support[0]).toMatchObject({ low: 62_480, high: 63_240 });
      expect(r.results[0].summary).toContain('support zone 1 at 62480–63240');
      expect(masked(r)).toBe(masked(withTick));
    }
  });

  // CH4 audit #2: the 60 s failure memo was pinned, but not a failure that follows an EXPIRED good read. That read must
  // never answer from the expired tick (a stale-OK cache would): the call is served with sig.
  it('a read that fails after the 24 h read expired answers null, so the call is served with sig, never the expired tick', async () => {
    let body: unknown = { symbols: [{ symbol: 'BTCUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.3' }] }] };
    const f = stubExchangeInfo(() => body);
    const a = new BinanceAdapter();
    const viaAdapter: SrZonesDeps['getPriceTick'] = (coin) => a.getPriceTick(coin);
    expect((await serve(viaAdapter)).results[0].support[0]).toMatchObject({ low: 62_475, high: 63_240 });
    expect(f.reads()).toBe(1);
    body = { code: -1, msg: 'not the exchangeInfo shape' };
    vi.setSystemTime(new Date(NOW + DAY));
    expect(await a.getPriceTick('BTC')).toBeNull();
    expect(f.reads()).toBe(2);
    const r = await serve(viaAdapter);
    expect(r.results[0].support[0]).toMatchObject({ low: 62_480, high: 63_240 });
    expect(r.results[0].summary).toContain('support zone 1 at 62480–63240');
    expect(f.reads()).toBe(2);
  });

  it('a tick read still running after 2 s: the call is served with sig and does not wait on', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    let done = false;
    const pending = serve(() => new Promise<number | null>(() => {})).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    const r = await pending;
    expect(r.results[0].support[0]).toMatchObject({ low: 62_480, high: 63_240 });
  });
});

describe('SR-ZONES-W2 — the default tick read: the Binance adapter, batch class, tagged get_sr_zones', () => {
  it('reads through getAdapter(BINANCE).getPriceTick in the batch class under get_sr_zones', async () => {
    const seen: unknown[] = [];
    adapterRef.current = {
      getPriceTick: async (coin: string) => {
        seen.push([coin, currentWeightClass(), currentCaller()]);
        return 0.1;
      },
    };
    expect(await runAsCaller('mcp-caller', () => DEFAULT_SR_ZONES_DEPS.getPriceTick('BTC'))).toBe(0.1);
    expect(seen).toEqual([['BTC', 'batch', processScopedTag('get_sr_zones')]]);
  });

  it('an adapter without getPriceTick reads as no tick', async () => {
    adapterRef.current = { getCandles: async () => [] };
    expect(await DEFAULT_SR_ZONES_DEPS.getPriceTick('BTC')).toBeNull();
  });
});
