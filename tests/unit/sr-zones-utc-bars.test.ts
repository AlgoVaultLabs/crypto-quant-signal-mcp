/**
 * SR-ZONES-W3 AC1.7 (R6) — the UTC-bars read option on the adapters. OKX and Bitget open `12H` and `1D` on Hong Kong
 * time (04:00/16:00 and 16:00 UTC, measured live 2026-11-20) and serve UTC-anchored twins (`12Hutc`, `1Dutc`). A read
 * passing `{ utcBars: true }` — get_support_resistance_zones only — asks for the twin on every request the read makes
 * (recent page, history page, history fallback); every other read, and the shared INTERVAL_MAP behind servedIntervalMs,
 * is byte-identical. Binance and Bybit bars open on UTC already: the option changes none of their requests.
 * R7 (Q1 A): the getAdapter seam's two getCandles wrappers forward the option; a 5-argument read through the seam asks
 * exactly what the bare adapter asks.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

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
