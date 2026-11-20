/**
 * SR-ZONES-W3 CH1 AC1.1 — getPriceTick on Bybit, OKX and Bitget, with Binance's contract (SR-ZONES-W2, binance.ts):
 * one instrument-list read answers every coin for 24 h; a failed read, or one where no symbol carries a usable tick, is
 * "no tick" (null) for exactly 60 s and is then read again, with one warn per failed read; an unknown coin is null.
 *
 * The bodies are the live shapes, trimmed (tests/fixtures/sr-zones/w3-ticks-<venue>-20261120.json, R0 P2): Bybit
 * `result.list[].priceFilter.tickSize` (with `nextPageCursor`), OKX `data[].tickSz` keyed by instId, Bitget
 * `data[].pricePlace` + `priceEndStep` (tick = priceEndStep × 10^−pricePlace). Field names differ per venue; each
 * adapter decodes its own.
 *
 * Each test imports the adapter module fresh (vi.resetModules), so its 24 h cache starts empty.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIX = join(__dirname, '..', 'fixtures', 'sr-zones');
const body = (venue: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIX, `w3-ticks-${venue}-20261120.json`), 'utf8'));
const NOW = Date.parse('2026-11-20T04:30:00.000Z');

interface VenueCase {
  venue: 'BYBIT' | 'OKX' | 'BITGET';
  module: string;
  className: 'BybitAdapter' | 'OKXAdapter' | 'BitgetAdapter';
  /** The instrument-list path the read must ask, and the query it must carry. */
  path: string;
  query: Record<string, string>;
  good: () => Record<string, unknown>;
  /** A read with no usable tick on any row (rows present). */
  noTick: () => Record<string, unknown>;
  /** A body that is not the list shape (the venue envelope still says success, so only the decode can refuse it). */
  notTheShape: () => Record<string, unknown>;
  ticks: Record<string, number | null>;
}

const CASES: VenueCase[] = [
  {
    venue: 'BYBIT',
    module: '../../src/lib/adapters/bybit.js',
    className: 'BybitAdapter',
    path: '/v5/market/instruments-info',
    query: { category: 'linear', limit: '1000' },
    good: () => body('bybit'),
    noTick: () => {
      const b = body('bybit') as { result: { list: Array<Record<string, unknown>> } };
      b.result.list = b.result.list.map((r) => ({ ...r, priceFilter: { tickSize: '0' } }));
      return b;
    },
    notTheShape: () => ({ retCode: 0, retMsg: 'OK', result: { category: 'linear' } }),
    // Bybit lists PEPE as 1000PEPEUSDT; the adapter names PEPE PEPEUSDT (as its candles do), so PEPE has no tick there.
    ticks: { BTC: 0.1, ETH: 0.01, ASTER: 0.0001, DOGE: 0.00001, CT: 0.0001, PEPE: null, NOPE: null },
  },
  {
    venue: 'OKX',
    module: '../../src/lib/adapters/okx.js',
    className: 'OKXAdapter',
    path: '/api/v5/public/instruments',
    query: { instType: 'SWAP' },
    good: () => body('okx'),
    noTick: () => {
      const b = body('okx') as { data: Array<Record<string, unknown>> };
      b.data = b.data.map((r) => ({ ...r, tickSz: '' }));
      return b;
    },
    notTheShape: () => ({ code: '0', msg: '', data: { instType: 'SWAP' } }),
    ticks: { BTC: 0.1, ETH: 0.01, ASTER: 0.0001, DOGE: 0.00001, CT: 0.00001, PEPE: 1e-10, NOPE: null },
  },
  {
    venue: 'BITGET',
    module: '../../src/lib/adapters/bitget.js',
    className: 'BitgetAdapter',
    path: '/api/v2/mix/market/contracts',
    query: { productType: 'USDT-FUTURES' },
    good: () => body('bitget'),
    noTick: () => {
      const b = body('bitget') as { data: Array<Record<string, unknown>> };
      b.data = b.data.map((r) => ({ ...r, pricePlace: 'x' }));
      return b;
    },
    notTheShape: () => ({ code: '00000', msg: 'success', data: { productType: 'USDT-FUTURES' } }),
    ticks: { BTC: 0.1, ETH: 0.01, ASTER: 0.0001, DOGE: 0.00001, CT: 0.00001, PEPE: 1e-10, NOPE: null },
  },
];

/** fetch, answering the venue's instrument list with `answer(url)`; counts those reads and keeps their URLs. */
function stubList(path: string, answer: (url: URL) => unknown): { reads: () => number; urls: URL[] } {
  const urls: URL[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === path) {
      urls.push(url);
      return new Response(JSON.stringify(answer(url)), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch);
  return { reads: () => urls.length, urls };
}

type TickAdapter = { getPriceTick(coin: string): Promise<number | null> };
async function freshAdapter(c: VenueCase): Promise<TickAdapter> {
  vi.resetModules();
  const mod = (await import(c.module)) as Record<string, new () => TickAdapter>;
  return new mod[c.className]();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(CASES)('SR-ZONES-W3 AC1.1 — $venue getPriceTick', (c) => {
  it('every coin from one instrument-list read, decoded from the venue\'s own fields; an unknown coin is null', async () => {
    const f = stubList(c.path, () => c.good());
    const a = await freshAdapter(c);
    for (const [coin, tick] of Object.entries(c.ticks)) expect([coin, await a.getPriceTick(coin)]).toEqual([coin, tick]);
    expect(f.reads()).toBe(1);
    for (const [k, v] of Object.entries(c.query)) expect(f.urls[0].searchParams.get(k)).toBe(v);
  });

  it('concurrent first reads share one request', async () => {
    const f = stubList(c.path, () => c.good());
    const a = await freshAdapter(c);
    const got = await Promise.all(['BTC', 'ETH', 'BTC', 'DOGE'].map((coin) => a.getPriceTick(coin)));
    expect(got).toEqual([c.ticks.BTC, c.ticks.ETH, c.ticks.BTC, c.ticks.DOGE]);
    expect(f.reads()).toBe(1);
  });

  it('the read is kept for 24 h, then read again', async () => {
    const f = stubList(c.path, () => c.good());
    const a = await freshAdapter(c);
    await a.getPriceTick('BTC');
    vi.setSystemTime(new Date(NOW + 24 * 3_600_000 - 1));
    expect(await a.getPriceTick('ETH')).toBe(c.ticks.ETH);
    expect(f.reads()).toBe(1);
    vi.setSystemTime(new Date(NOW + 24 * 3_600_000));
    expect(await a.getPriceTick('BTC')).toBe(c.ticks.BTC);
    expect(f.reads()).toBe(2);
  });

  it.each([
    ['not the list shape', 'notTheShape'],
    ['no usable tick on any row', 'noTick'],
  ] as const)('a failed read (%s) answers null for 60 s with one warn, then is read again', async (_label, kind) => {
    let answer: () => unknown = c[kind];
    const f = stubList(c.path, () => answer());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await freshAdapter(c);
    expect(await Promise.all(['BTC', 'ETH', 'DOGE'].map((coin) => a.getPriceTick(coin)))).toEqual([null, null, null]);
    expect(f.reads()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('price-tick read failed');
    vi.setSystemTime(new Date(NOW + 59_999));
    expect(await a.getPriceTick('BTC')).toBeNull();
    expect(f.reads()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    answer = c.good;
    vi.setSystemTime(new Date(NOW + 60_000));
    expect(await a.getPriceTick('BTC')).toBe(c.ticks.BTC);
    expect(f.reads()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a venue error (HTTP 500 every try) answers null, never throws', async () => {
    vi.spyOn(global, 'fetch').mockImplementation((async () => new Response('oops', { status: 500 })) as typeof fetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await freshAdapter(c);
    expect(await a.getPriceTick('BTC')).toBeNull();
  });

  it('a good read logs nothing', async () => {
    stubList(c.path, () => c.good());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await freshAdapter(c);
    expect(await a.getPriceTick('BTC')).toBe(c.ticks.BTC);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('SR-ZONES-W3 AC1.1 — Bybit follows nextPageCursor (the list is paginated at 1000 rows)', () => {
  it('a coin on the second page is found, and the cursor is sent back verbatim', async () => {
    const all = body('bybit') as { result: { list: Array<{ symbol: string }>; nextPageCursor: string } };
    const btc = all.result.list.filter((r) => r.symbol === 'BTCUSDT');
    const eth = all.result.list.filter((r) => r.symbol === 'ETHUSDT');
    const f = stubList('/v5/market/instruments-info', (url) =>
      url.searchParams.get('cursor') === 'next=ETH%2Fpage'
        ? { retCode: 0, retMsg: 'OK', result: { category: 'linear', list: eth, nextPageCursor: '' } }
        : { retCode: 0, retMsg: 'OK', result: { category: 'linear', list: btc, nextPageCursor: 'next=ETH%2Fpage' } },
    );
    const a = await freshAdapter(CASES[0]);
    expect(await a.getPriceTick('ETH')).toBe(0.01);
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(f.reads()).toBe(2);
    expect(f.urls[1].searchParams.get('cursor')).toBe('next=ETH%2Fpage');
  });

  it('a cursor that never ends stops at a bounded number of pages and keeps what it read', async () => {
    const all = body('bybit') as { result: { list: Array<{ symbol: string }> } };
    const btc = all.result.list.filter((r) => r.symbol === 'BTCUSDT');
    const f = stubList('/v5/market/instruments-info', () => ({ retCode: 0, retMsg: 'OK', result: { list: btc, nextPageCursor: 'again' } }));
    const a = await freshAdapter(CASES[0]);
    expect(await a.getPriceTick('BTC')).toBe(0.1);
    expect(f.reads()).toBeGreaterThan(1);
    expect(f.reads()).toBeLessThanOrEqual(10);
  });
});

/**
 * SR-ZONES-W3 R9 #6 — the Bitget tick is priceEndStep × 10^−pricePlace. Every live contract carried priceEndStep "1"
 * on 2026-11-20, so the recorded list alone could not tell a decode that ignores priceEndStep; this row can.
 */
describe('SR-ZONES-W3 R9 #6 — the Bitget tick carries priceEndStep', () => {
  it('pricePlace 1 with priceEndStep 5 is a tick of 0.5; the recorded rows keep theirs', async () => {
    const b = body('bitget') as { data: Array<Record<string, unknown>> };
    const btc = b.data.find((r) => r.symbol === 'BTCUSDT')!;
    b.data = [...b.data.filter((r) => r.symbol !== 'BTCUSDT'), { ...btc, pricePlace: '1', priceEndStep: '5' }];
    stubList('/api/v2/mix/market/contracts', () => b);
    const a = await freshAdapter(CASES[2]);
    expect(await a.getPriceTick('BTC')).toBe(0.5);
    expect(await a.getPriceTick('ETH')).toBe(0.01);
  });
});
