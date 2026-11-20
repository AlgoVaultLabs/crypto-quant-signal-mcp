/**
 * SR-ZONES-W3 AC1.7 (R6) — the UTC-bars read option on the adapters. OKX and Bitget open `12H` and `1D` on Hong Kong
 * time (04:00/16:00 and 16:00 UTC, measured live 2026-11-20) and serve UTC-anchored twins (`12Hutc`, `1Dutc`). A read
 * passing `{ utcBars: true }` — get_support_resistance_zones only — asks for the twin on every request the read makes
 * (recent page, history page, history fallback); every other read, and the shared INTERVAL_MAP behind servedIntervalMs,
 * is byte-identical. Binance and Bybit bars open on UTC already: the option changes none of their requests.
 * R7 (Q1 A): the getAdapter seam's two getCandles wrappers forward the option; a 5-argument read through the seam asks
 * exactly what the bare adapter asks.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Candle } from '../../src/types.js';
import { runGetSrZones, type SrZonesDeps, type GetSrZonesOutcome } from '../../src/tools/get-sr-zones.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';

const NOW = Date.parse('2026-11-20T04:30:00.000Z');
const D = 86_400_000;

type Adapter = { getCandles(coin: string, tf: string, start: number, dex?: unknown, end?: number, opts?: { utcBars?: boolean }): Promise<unknown[]> };

/** Every request URL the adapter makes, answered with an empty success envelope. */
function stubEmpty(envelope: unknown): URL[] {
  const urls: URL[] = [];
  vi.spyOn(global, 'fetch').mockImplementation((async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify(envelope), { status: 200 });
  }) as typeof fetch);
  return urls;
}

async function fresh(module: string, className: string): Promise<Adapter> {
  vi.resetModules();
  const mod = (await import(module)) as Record<string, new () => Adapter>;
  return new mod[className]();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CASES = [
  { venue: 'OKX', module: '../../src/lib/adapters/okx.js', className: 'OKXAdapter', param: 'bar', envelope: { code: '0', msg: '', data: [] }, native: { '12h': '12H', '1d': '1D', '4h': '4H', '1h': '1H' } },
  { venue: 'BITGET', module: '../../src/lib/adapters/bitget.js', className: 'BitgetAdapter', param: 'granularity', envelope: { code: '00000', msg: 'success', data: [] }, native: { '12h': '12H', '1d': '1D', '4h': '4H', '1h': '1H' } },
] as const;

describe.each(CASES)('SR-ZONES-W3 AC1.7 — $venue: the UTC twin on every request of a utcBars read, nothing else changed', (c) => {
  it.each(['12h', '1d'] as const)('%s: a serving read and a history read ask the UTC twin on every request; without the option, the Hong Kong bar', async (tf) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const urls = stubEmpty(c.envelope);
    const a = await fresh(c.module, c.className);
    /** The `c.param` value of every request one read makes. */
    const ask = async (start: number, end?: number, opts?: { utcBars?: boolean }) => {
      const from = urls.length;
      await a.getCandles('BTC', tf, start, undefined, end, opts);
      return urls.slice(from).map((u) => u.searchParams.get(c.param));
    };
    const servingUtc = await ask(NOW - 100 * D, undefined, { utcBars: true });
    const historyUtc = await ask(NOW - 400 * D, NOW - 300 * D, { utcBars: true });
    expect(servingUtc.length).toBeGreaterThanOrEqual(1);
    expect(historyUtc.length).toBeGreaterThanOrEqual(1);
    expect(new Set([...servingUtc, ...historyUtc])).toEqual(new Set([`${c.native[tf]}utc`]));
    const serving = await ask(NOW - 100 * D);
    const history = await ask(NOW - 400 * D, NOW - 300 * D);
    const historyFalse = await ask(NOW - 400 * D, NOW - 300 * D, { utcBars: false });
    // The same requests, read for read; only the bar token differs.
    expect([serving.length, history.length, historyFalse.length]).toEqual([servingUtc.length, historyUtc.length, historyUtc.length]);
    expect(new Set([...serving, ...history, ...historyFalse])).toEqual(new Set([c.native[tf]]));
  });

  it.each(['4h', '1h'] as const)('%s opens on UTC already: the option changes no request', async (tf) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const urls = stubEmpty(c.envelope);
    const a = await fresh(c.module, c.className);
    await a.getCandles('BTC', tf, NOW - 50 * D, undefined, NOW - 40 * D, { utcBars: true });
    const opt = urls.splice(0).map(String);
    await a.getCandles('BTC', tf, NOW - 50 * D, undefined, NOW - 40 * D);
    expect(urls.map(String)).toEqual(opt);
    expect(opt.every((u) => new URL(u).searchParams.get(c.param) === c.native[tf])).toBe(true);
  });

  it('the shared map is untouched: servedIntervalMs is the same step for 12h and 1d', async () => {
    vi.resetModules();
    const m = (await import(c.module)) as { servedIntervalMs: (tf: string) => number | null };
    expect([m.servedIntervalMs('12h'), m.servedIntervalMs('1d')]).toEqual([12 * 3_600_000, D]);
  });
});

describe('SR-ZONES-W3 R7 (Q1 A) — the getAdapter seam forwards the option; a 5-argument read is byte-identical', () => {
  const CANDLE_PATHS = /\/market\/(history-)?candles$/;
  it.each(CASES)('$venue through getAdapter: utcBars asks 1Dutc on every candle request; 5 arguments ask exactly what the adapter asks', async (c) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const urls = stubEmpty(c.envelope);
    vi.resetModules();
    const { getAdapter } = (await import('../../src/lib/exchange-adapter.js')) as { getAdapter: (v: string) => Adapter };
    const seam = getAdapter(c.venue);
    const candles = () => urls.splice(0).filter((u) => CANDLE_PATHS.test(u.pathname)).map(String);
    // A serving read and a history read, each through both seam wrappers.
    await seam.getCandles('BTC', '1d', NOW - 100 * D, undefined, undefined, { utcBars: true }).catch(() => []);
    await seam.getCandles('BTC', '1d', NOW - 400 * D, undefined, NOW - 300 * D, { utcBars: true });
    const forwarded = candles();
    expect(forwarded.length).toBeGreaterThanOrEqual(2);
    expect(new Set(forwarded.map((u) => new URL(u).searchParams.get(c.param)))).toEqual(new Set(['1Dutc']));
    // Every existing caller passes 5 arguments: through the seam it asks exactly what the bare adapter asks.
    await seam.getCandles('BTC', '1d', NOW - 400 * D, undefined, NOW - 300 * D);
    await seam.getCandles('BTC', '12h', NOW - 400 * D, undefined, NOW - 300 * D);
    const throughSeam = candles();
    const bare = await fresh(c.module, c.className);
    await bare.getCandles('BTC', '1d', NOW - 400 * D, undefined, NOW - 300 * D);
    await bare.getCandles('BTC', '12h', NOW - 400 * D, undefined, NOW - 300 * D);
    expect(throughSeam).toEqual(candles());
    expect(throughSeam.every((u) => !/utc/.test(new URL(u).searchParams.get(c.param) ?? ''))).toBe(true);
  });
});

describe('SR-ZONES-W3 AC1.7 — BINANCE and BYBIT open on UTC already: the option changes none of their requests', () => {
  it.each([
    ['../../src/lib/adapters/binance.js', 'BinanceAdapter', []],
    ['../../src/lib/adapters/bybit.js', 'BybitAdapter', { retCode: 0, retMsg: 'OK', result: { list: [] } }],
  ] as const)('%s', async (module, className, envelope) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const urls = stubEmpty(envelope);
    const a = await fresh(module, className);
    for (const tf of ['12h', '1d']) {
      await a.getCandles('BTC', tf, NOW - 100 * D, undefined, undefined, { utcBars: true }).catch(() => []);
      const opt = urls.splice(0).map(String);
      await a.getCandles('BTC', tf, NOW - 100 * D).catch(() => []);
      expect(urls.splice(0).map(String)).toEqual(opt);
      expect(opt.length).toBeGreaterThan(0);
    }
  });
});

/**
 * SR-ZONES-W3 R9 #4 — the UTC guard (onUtcGrid) at each of its three call sites, alone: one off-UTC bar planted in the
 * head page, in one backward page, or in the head refresh. The first two refuse the timeframe ("{venue} does not serve
 * this timeframe"); a refused head refresh is a failed re-read, so the cached window stands unmerged (by design, R7).
 */
describe('SR-ZONES-W3 R9 #4 — the UTC guard holds at the head page, a backward page and the head refresh, each alone', () => {
  const series = (n: number): Candle[] => {
    const forming = Math.floor(NOW / D) * D;
    return Array.from({ length: n }, (_, i) => ({ time: forming - (n - 1 - i) * D, open: 100 + (i % 17), high: 103 + (i % 17), low: 97 + (i % 17), close: 101 + (i % 17), volume: 1 }));
  };
  const shift = (bars: Candle[], at: number): Candle[] => bars.map((c, i) => (i === at ? { ...c, time: c.time + 3_600_000 } : c));
  /** OKX 1d over a clean UTC series; `plant` rewrites one read's answer (by its kind and its index among that kind). */
  function deps(plant: (kind: 'serving' | 'backward', n: number, bars: Candle[]) => Candle[], now: { ms: number }): SrZonesDeps {
    const s = series(1200);
    const n = { serving: 0, backward: 0 };
    return {
      nowMs: () => now.ms,
      cache: new Map(),
      failures: new Map(),
      getCandles: async (_coin, _tf, start, end) => {
        const kind = end === undefined ? 'serving' : 'backward';
        const bars = s.filter((c) => c.time >= start && (end === undefined ? c.time <= now.ms : c.time <= end));
        return plant(kind, n[kind]++, bars);
      },
      getPriceTick: async () => null,
    };
  }
  const run = (d: SrZonesDeps) => runGetSrZones({ coin: 'BTC', timeframes: ['1d'], venue: 'OKX' }, { tier: 'free', key: 'av_srz_utc_guard' }, d);
  const refusedFor = (o: GetSrZonesOutcome) => (o.kind === 'refused' ? [o.status, (o.payload as { unserved?: unknown }).unserved] : [o.kind]);

  beforeEach(() => {
    _resetCallTrackersForTest();
    resetLicenseCache();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  it('a clean read is served (the control)', async () => {
    expect((await run(deps((_k, _n, b) => b, { ms: NOW }))).kind).toBe('ok');
  });

  it('an off-UTC bar in the head page only refuses the timeframe', async () => {
    const o = await run(deps((k, n, b) => (k === 'serving' && n === 0 ? shift(b, b.length - 2) : b), { ms: NOW }));
    expect(refusedFor(o)).toEqual([422, [{ timeframe: '1d', reason: 'OKX does not serve this timeframe' }]]);
  });

  it('an off-UTC bar in one backward page only refuses the timeframe', async () => {
    const o = await run(deps((k, n, b) => (k === 'backward' && n === 1 ? shift(b, Math.floor(b.length / 2)) : b), { ms: NOW }));
    expect(refusedFor(o)).toEqual([422, [{ timeframe: '1d', reason: 'OKX does not serve this timeframe' }]]);
  });

  it('an off-UTC bar in the head refresh only is refused: the cached window stands, nothing off-UTC is merged', async () => {
    const now = { ms: NOW };
    let refreshed = false;
    const d = deps((k, n, b) => {
      if (k !== 'serving' || n !== 1) return b;
      refreshed = true;
      return shift(b, b.length - 2);
    }, now);
    expect((await run(d)).kind).toBe('ok');
    const cached = d.cache.get('OKX:BTC:1d');
    expect(cached?.candles).toHaveLength(1001);
    now.ms = NOW + 61_000; // past the head-refresh interval, inside the window's validity
    vi.setSystemTime(new Date(now.ms));
    expect((await run(d)).kind).toBe('ok');
    expect(refreshed).toBe(true); // the second call re-read the head
    expect(d.cache.get('OKX:BTC:1d')).toBe(cached);
    expect(d.cache.get('OKX:BTC:1d')!.candles.every((c) => c.time % D === 0)).toBe(true);
  });
});

/**
 * SR-ZONES-W3 R9 #5 — R7: BOTH getAdapter seam wrappers forward the trailing option. guardClosedMarkets wraps BINGX only
 * (the one venue declaring readsRefusedWhileOff, with a venueSymbol), so the read goes through a stub BINGX adapter
 * that records what reaches it, in both admission modes.
 */
describe('SR-ZONES-W3 R9 #5 — guardClosedMarkets forwards the sixth argument', () => {
  afterEach(() => {
    vi.doUnmock('../../src/lib/adapters/bingx.js');
    vi.unstubAllEnvs();
  });

  it.each(['enforce', 'legacy'] as const)('UNIVERSE_ADMISSION_MODE=%s: the option reaches the BINGX adapter through both wrappers', async (mode) => {
    vi.stubEnv('UNIVERSE_ADMISSION_MODE', mode);
    vi.spyOn(global, 'fetch').mockImplementation((async () => new Response('{}', { status: 503 })) as typeof fetch);
    const seen: unknown[][] = [];
    vi.resetModules();
    vi.doMock('../../src/lib/adapters/bingx.js', async (orig) => {
      const real = await orig<typeof import('../../src/lib/adapters/bingx.js')>();
      class StubBingx extends real.BingxAdapter {
        override async getCandles(...args: Parameters<InstanceType<typeof real.BingxAdapter>['getCandles']>) {
          seen.push(args);
          return [];
        }
      }
      return { ...real, BingxAdapter: StubBingx };
    });
    const { getAdapter } = (await import('../../src/lib/exchange-adapter.js')) as { getAdapter: (v: string) => Adapter };
    const opts = { utcBars: true };
    await getAdapter('BINGX').getCandles('BTC', '1d', NOW - 400 * D, undefined, NOW - 300 * D, opts);
    expect(seen).toEqual([['BTC', '1d', NOW - 400 * D, undefined, NOW - 300 * D, opts]]);
    expect(seen[0][5]).toBe(opts);
  });
});
