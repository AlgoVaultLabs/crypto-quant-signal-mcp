/** Unit tests — EQUITIES-ENGINE-W1 C2 Databento provider (CSV parse + retry + auth). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseOhlcvCsv,
  DatabentoEquityBarsProvider,
  type EquityProviderError,
} from '../../src/lib/equities/equity-bars-provider.js';

const HEADER = 'ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol';

function fakeRes(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('parseOhlcvCsv', () => {
  it('parses canonical EQUS.MINI ohlcv-1d csv rows', () => {
    const csv = [
      HEADER,
      '2026-06-03T00:00:00.000000000Z,35,95,38,313.080000000,316.920000000,308.860000000,313.900000000,2087399,AAPL',
      '2026-06-03T00:00:00.000000000Z,35,95,15144,759.010000000,759.230000000,750.000000000,750.210000000,2124029,SPY',
    ].join('\n');
    const bars = parseOhlcvCsv(csv);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      symbol: 'AAPL', session_date: '2026-06-03',
      open: 313.08, high: 316.92, low: 308.86, close: 313.9, volume: 2087399,
    });
    expect(bars[1].symbol).toBe('SPY');
    expect(bars[1].close).toBe(750.21);
  });

  it('is robust to column re-ordering (header-indexed)', () => {
    const csv = ['symbol,close,open,high,low,volume,ts_event',
      'AAPL,313.9,313.08,316.92,308.86,2087399,2026-06-03T00:00:00Z'].join('\n');
    const bars = parseOhlcvCsv(csv);
    expect(bars[0].close).toBe(313.9);
    expect(bars[0].session_date).toBe('2026-06-03');
  });

  it('skips malformed/blank rows and returns [] for header-only', () => {
    expect(parseOhlcvCsv(HEADER)).toEqual([]);
    expect(parseOhlcvCsv('')).toEqual([]);
    const csv = [HEADER, 'bad,row', ',,,,,,,,,'].join('\n');
    expect(parseOhlcvCsv(csv)).toEqual([]);
  });

  it('throws DATABENTO_PARSE when required columns are missing', () => {
    expect(() => parseOhlcvCsv('foo,bar\n1,2')).toThrowError(/missing columns/);
  });
});

describe('DatabentoEquityBarsProvider auth/retry', () => {
  it('rejects an empty key at construction', () => {
    expect(() => new DatabentoEquityBarsProvider('')).toThrowError(/empty/);
  });

  it('sends HTTP Basic with key as username and blank password', async () => {
    const spy = vi.fn(async () => fakeRes(200, HEADER));
    vi.stubGlobal('fetch', spy);
    const p = new DatabentoEquityBarsProvider('db-XYZ', { baseDelayMs: 1, logger: () => {} });
    await p.getDailyBars(['AAPL'], '2026-06-01', '2026-06-04');
    const [, init] = spy.mock.calls[0];
    const expected = 'Basic ' + Buffer.from('db-XYZ:').toString('base64');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: expected });
  });

  it('retries on 429 then succeeds', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(fakeRes(429, 'slow down'))
      .mockResolvedValueOnce(fakeRes(200, HEADER + '\n2026-06-03T00:00:00Z,35,95,38,1,2,0.5,1.5,10,AAPL'));
    vi.stubGlobal('fetch', spy);
    const p = new DatabentoEquityBarsProvider('db-XYZ', { baseDelayMs: 1, logger: () => {} });
    const bars = await p.getDailyBars(['AAPL'], '2026-06-01', '2026-06-04');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bars[0].close).toBe(1.5);
  });

  it('does NOT retry on 403 and surfaces a structured auth error', async () => {
    const spy = vi.fn(async () => fakeRes(403, 'no subscription'));
    vi.stubGlobal('fetch', spy);
    const p = new DatabentoEquityBarsProvider('db-XYZ', { baseDelayMs: 1, logger: () => {} });
    await expect(p.getDailyBars(['AAPL'], '2026-06-01', '2026-06-04')).rejects.toMatchObject({
      code: 'DATABENTO_AUTH',
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('getLatestAvailableSession returns the last complete session (end-1)', async () => {
    const json = JSON.stringify({ end: '2026-06-04T00:00:00Z', schema: { 'ohlcv-1d': { end: '2026-06-04T00:00:00Z' } } });
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(200, json)));
    const p = new DatabentoEquityBarsProvider('db-XYZ', { baseDelayMs: 1, logger: () => {} });
    expect(await p.getLatestAvailableSession()).toBe('2026-06-03');
  });

  it('parses a numeric cost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(200, '7.280450239778')));
    const p = new DatabentoEquityBarsProvider('db-XYZ', { baseDelayMs: 1, logger: () => {} });
    expect(await p.getCostUsd('ALL_SYMBOLS', '2024-06-04', '2026-06-04')).toBeCloseTo(7.2804, 3);
  });
});

// Keep the type import referenced (avoids unused-import error under isolatedModules).
const _t: EquityProviderError | null = null;
void _t;
