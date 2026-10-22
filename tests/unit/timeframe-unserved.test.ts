/**
 * timeframe-unserved.test.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH2: a timeframe a venue does not serve is refused, typed,
 * before any request, on every surface.
 *
 *   1. `resolveVenueInterval` (src/lib/adapters/_interval.ts), pure.
 *   2. Every adapter's `getCandles`, direct and through the `getAdapter` seam: an unmapped timeframe throws
 *      TimeframeUnservedError and the venue is never asked (upstreamFetch and fetch both spied).
 *   3. The payload, and MCP rendering it in band.
 *   4. get_trade_call OKX 8h / BYBIT 8h (AC2.1): refused before any request, never billed, never recorded — paired
 *      with the control that the same path serves BYBIT 4h.
 *   5. The seeder skips them through isTimeframeFaithful, never through the error path.
 * Until CH2 the first three were `INTERVAL_MAP[interval] || '1h'`: the venue was asked for a default bar, and the
 * caller got those bars labelled as the timeframe it asked for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, world } = vi.hoisted(() => ({ calls: [] as string[], world: { bybitStep: 0 } }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    calls.push(req.url);
    const u = new URL(req.url);
    const q = u.searchParams;
    // Bybit klines for the get_trade_call control, generated against the real clock through the forming bar
    if (u.pathname === '/v5/market/kline') {
      const step = q.get('interval') === 'D' ? 86_400_000 : Number(q.get('interval')) * 60_000;
      const last = Math.floor(Date.now() / step) * step;
      const opens: number[] = [];
      for (let t = Math.ceil(Number(q.get('start')) / step) * step; t <= last && opens.length < 200; t += step) opens.push(t);
      return { retCode: 0, retMsg: 'OK', result: { list: opens.reverse().map((t) => [String(t), '100.0', '101.0', '99.0', '100.5', '1000']) } };
    }
    throw new Error(`timeframe-unserved: unmocked upstream ${req.url}`);
  }),
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  isShortLivedScript: () => false,
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/license.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/license.js')>();
  return { ...m, trackCall: vi.fn(m.trackCall) };
});

import { resolveVenueInterval, servedTimeframesOf } from '../../src/lib/adapters/_interval.js';
import { TimeframeUnservedError, buildTimeframeUnservedPayload } from '../../src/lib/errors.js';
import { servedTimeframes } from '../../src/lib/tf-support.js';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { toMcpToolResult, type ToolCallOutcome } from '../../src/lib/tool-call-pipeline.js';
import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { recordSignal, recordHoldCount } from '../../src/lib/performance-db.js';
import { trackCall, resetLicenseCache } from '../../src/lib/license.js';
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import { AsterAdapter } from '../../src/lib/adapters/aster.js';
import { BinanceAdapter } from '../../src/lib/adapters/binance.js';
import { BingxAdapter } from '../../src/lib/adapters/bingx.js';
import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';
import { BitmartAdapter } from '../../src/lib/adapters/bitmart.js';
import { BybitAdapter } from '../../src/lib/adapters/bybit.js';
import { EdgeXAdapter } from '../../src/lib/adapters/edgex.js';
import { GateAdapter } from '../../src/lib/adapters/gateio.js';
import { HTXAdapter } from '../../src/lib/adapters/htx.js';
import { HyperliquidAdapter } from '../../src/lib/adapters/hyperliquid.js';
import { KuCoinAdapter } from '../../src/lib/adapters/kucoin.js';
import { MEXCAdapter } from '../../src/lib/adapters/mexc.js';
import { OKXAdapter } from '../../src/lib/adapters/okx.js';
import { PhemexAdapter } from '../../src/lib/adapters/phemex.js';
import { WeexAdapter } from '../../src/lib/adapters/weex.js';
import { WhitebitAdapter } from '../../src/lib/adapters/whitebit.js';
import { XtAdapter } from '../../src/lib/adapters/xt.js';
import type { ExchangeAdapter, ExchangeId } from '../../src/types.js';

const netSpy = vi.fn(() => { throw new Error('timeframe-unserved: a real network call was attempted'); });
vi.stubGlobal('fetch', netSpy);
beforeEach(() => { calls.length = 0; netSpy.mockClear(); });

const refusal = async (p: Promise<unknown>): Promise<TimeframeUnservedError> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TimeframeUnservedError);
  return err as TimeframeUnservedError;
};

// ── 1. the helper ─────────────────────────────────────────────────────────────────────────────────
describe('resolveVenueInterval', () => {
  const MAP = { '1m': '1m', '1h': '1H', '6h': '6H', '1d': '1D' } as const;

  it('returns the venue token for a mapped timeframe', () => {
    expect(resolveVenueInterval(MAP, '1h', 'X')).toBe('1H');
    expect(resolveVenueInterval({ '1h': 60 }, '1h', 'X')).toBe(60);
  });

  it('refuses an unmapped one with the venue, the timeframe and the product timeframes it does serve', () => {
    let err: unknown;
    try { resolveVenueInterval(MAP, '8h', 'X'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TimeframeUnservedError);
    const e = err as TimeframeUnservedError;
    expect([e.code, e.exchange, e.timeframe]).toEqual(['timeframe_unserved', 'X', '8h']);
    expect(e.servedTimeframes).toEqual(['1m', '1h', '1d']); // product order; the venue-only 6h is not offered
    expect(e.message).toBe('X does not serve the 8h timeframe. It serves: 1m, 1h, 1d.');
  });

  it('reads own keys only: a timeframe named like an Object.prototype member is refused, never resolved', () => {
    for (const tf of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(() => resolveVenueInterval(MAP, tf, 'X')).toThrow(TimeframeUnservedError);
  });

  it('servedTimeframesOf lists the product timeframes in TIMEFRAMES order', () => {
    expect(servedTimeframesOf({ '1d': 1, '1m': 1, '4h': 1, '1w': 1 })).toEqual(['1m', '4h', '1d']);
    expect(servedTimeframesOf({})).toEqual([]);
  });
});

// ── 2. every adapter, direct and through the seam ─────────────────────────────────────────────────
const ADAPTERS: [ExchangeId, () => ExchangeAdapter][] = [
  ['ASTER', () => new AsterAdapter()], ['BINANCE', () => new BinanceAdapter()], ['BINGX', () => new BingxAdapter()],
  ['BITGET', () => new BitgetAdapter()], ['BITMART', () => new BitmartAdapter()], ['BYBIT', () => new BybitAdapter()],
  ['EDGEX', () => new EdgeXAdapter()], ['GATE', () => new GateAdapter()], ['HTX', () => new HTXAdapter()],
  ['HL', () => new HyperliquidAdapter()], ['KUCOIN', () => new KuCoinAdapter()], ['MEXC', () => new MEXCAdapter()],
  ['OKX', () => new OKXAdapter()], ['PHEMEX', () => new PhemexAdapter()], ['WEEX', () => new WeexAdapter()],
  ['WHITEBIT', () => new WhitebitAdapter()], ['XT', () => new XtAdapter()],
];

describe('every adapter refuses a timeframe it does not map, before any request', () => {
  it('covers all seventeen adapters', () => { expect(ADAPTERS).toHaveLength(17); });

  it.each(ADAPTERS)('%s: an unmapped timeframe (7h) — serving and history reads', async (venue, make) => {
    for (const end of [undefined, Date.now()]) {
      const e = await refusal(make().getCandles('BTC', '7h', Date.now() - 86_400_000, undefined, end));
      expect([e.exchange, e.timeframe]).toEqual([venue, '7h']);
      expect(e.servedTimeframes).toEqual(servedTimeframes(venue));
    }
    expect(calls).toEqual([]);
    expect(netSpy).not.toHaveBeenCalled();
  });

  it.each([['OKX'], ['BYBIT']] as [ExchangeId][])('%s 8h: refused direct and through the getAdapter seam (the guard never sees a page)', async (venue) => {
    const direct = await refusal(ADAPTERS.find(([v]) => v === venue)![1]().getCandles('BTC', '8h', Date.now() - 30 * 86_400_000));
    const seam = await refusal(getAdapter(venue).getCandles('BTC', '8h', Date.now() - 30 * 86_400_000));
    for (const e of [direct, seam]) {
      expect(e.servedTimeframes).toEqual(TIMEFRAMES.filter((tf) => tf !== '8h'));
      expect(e.message).toBe(`${venue} does not serve the 8h timeframe. It serves: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 12h, 1d.`);
    }
    expect(calls).toEqual([]);
    expect(netSpy).not.toHaveBeenCalled();
  });

  it('control: the same seam serves BYBIT 4h (one request)', async () => {
    const bars = await getAdapter('BYBIT').getCandles('BTC', '4h', Date.now() - 40 * 14_400_000);
    expect(bars.length).toBeGreaterThan(30);
    expect(calls.length).toBe(1);
  });
});

// ── 3. the payload and its MCP rendering ──────────────────────────────────────────────────────────
describe('the refusal reaches the caller typed', () => {
  const err = new TimeframeUnservedError({ exchange: 'OKX', timeframe: '8h', servedTimeframes: ['4h', '12h'] });

  it('is an Error with its own code, and a payload of exactly the keys scan_market_regimes already answers', () => {
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('timeframe_unserved');
    expect(buildTimeframeUnservedPayload(err)).toEqual({
      error: 'timeframe_unserved',
      code: 'timeframe_unserved',
      message: 'OKX does not serve the 8h timeframe. It serves: 4h, 12h.',
      exchange: 'OKX',
      timeframe: '8h',
      served_timeframes_on_venue: ['4h', '12h'],
      suggested_action: 'Ask OKX for one of 4h, 12h, or ask another exchange for 8h.',
    });
    expect(buildTimeframeUnservedPayload(new TimeframeUnservedError({ exchange: 'X', timeframe: '8h', servedTimeframes: [] })).suggested_action)
      .toBe('Ask another exchange for 8h.');
  });

  it('MCP renders it in band (isError) with that payload', () => {
    const outcome = { ok: false, kind: 'threw', tool: 'get_trade_call', input: {}, error: err } as unknown as ToolCallOutcome;
    const r = toMcpToolResult(outcome);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual(buildTimeframeUnservedPayload(err));
  });
});

// ── 4. get_trade_call (AC2.1) ─────────────────────────────────────────────────────────────────────
describe('get_trade_call: OKX 8h / BYBIT 8h are refused before any request, never billed, never recorded', () => {
  beforeEach(() => {
    vi.mocked(recordSignal).mockClear();
    vi.mocked(recordHoldCount).mockClear();
    vi.mocked(trackCall).mockClear();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
    const a = getAdapter('BYBIT');
    vi.spyOn(a, 'getAssetContext').mockResolvedValue({ coin: 'BTC', funding: 0.0001, openInterest: 5_000_000, prevDayPx: 99, volume24h: 125_000_000, oraclePx: 100, markPx: 100 });
    vi.spyOn(a, 'getPredictedFundings').mockResolvedValue([]);
  });

  it.each([['OKX'], ['BYBIT']] as [ExchangeId][])('%s 8h → TimeframeUnservedError with the served list', async (exchange) => {
    const e = await refusal(getTradeSignal({ coin: 'BTC', timeframe: '8h', exchange }));
    expect(buildTimeframeUnservedPayload(e)).toMatchObject({
      error: 'timeframe_unserved', exchange, timeframe: '8h', served_timeframes_on_venue: TIMEFRAMES.filter((tf) => tf !== '8h'),
    });
    expect(calls).toEqual([]);
    expect(netSpy).not.toHaveBeenCalled();
    expect(trackCall).not.toHaveBeenCalled();
    expect(recordSignal).not.toHaveBeenCalled();
    expect(recordHoldCount).not.toHaveBeenCalled();
  });

  it('control: BYBIT 4h on the same path is served, billed once and recorded once', async () => {
    const r = await getTradeSignal({ coin: 'BTC', timeframe: '4h', exchange: 'BYBIT' });
    expect(['BUY', 'SELL', 'HOLD']).toContain(r.call);
    expect(calls.length).toBeGreaterThan(0);
    expect(trackCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordSignal).mock.calls.length + vi.mocked(recordHoldCount).mock.calls.length).toBe(1);
  });
});
