/**
 * serving-window-guard.test.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1: the universal serving post-condition at the
 * `getAdapter` seam (src/lib/exchange-adapter.ts).
 *
 *   1. `servingWindowVerdict`, pure: the ceiling boundary, the page that ended before its window began, the two R0
 *      defects reproduced bar for bar, a young listing, UTC+8 phases, and every input it must never judge.
 *   2. The seam itself, on real adapters over a mocked transport: a stale serving read throws, the same bars on a
 *      history read pass, a fresh read returns the adapter's own array (its `meta` intact), and the guard costs no
 *      request.
 *   3. The refusal on every surface it reaches: the MCP payload, get_trade_call (never billed, never recorded), and the
 *      Bybit OI backfill (skips the coin).
 * Each refusal is paired with the fresh control that proves the same path accepts a current window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyntheticVenue } from '../harness/adapter-history-synthetic.js';

const H = 3_600_000;
const DAY = 24 * H;

// ── the mocked transport: Binance + Bybit klines generated against the real clock, OKX from the synthetic venue ──
const { world, calls } = vi.hoisted(() => ({
  world: { staleBars: 0, failKlines: false, okx: null as null | { answer(url: string): unknown } },
  calls: [] as string[],
}));
const STEP: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => {
  /** Bars opening at or after startTime on the epoch grid, through the forming bar, minus `world.staleBars` at the head. */
  const opens = (startTime: number, step: number): number[] => {
    const now = Date.now();
    const out: number[] = [];
    const last = Math.floor(now / step) * step - world.staleBars * step;
    for (let t = Math.ceil(startTime / step) * step; t <= last && out.length < 200; t += step) out.push(t);
    return out;
  };
  return {
    ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
    upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
      calls.push(req.url);
      const u = new URL(req.url);
      const q = u.searchParams;
      if (u.pathname === '/fapi/v1/klines') {
        if (world.failKlines) throw new Error('binance 503');
        return opens(Number(q.get('startTime')), { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }[q.get('interval')!]!)
          .map((t) => [t, '100.0', '101.0', '99.0', '100.5', '1000']);
      }
      if (u.pathname === '/v5/market/kline') {
        if (world.failKlines) throw new Error('bybit 503');
        const step = q.get('interval') === '60' ? 3_600_000 : Number(q.get('interval')) * 60_000;
        return { retCode: 0, retMsg: 'OK', result: { list: opens(Number(q.get('start')), step).reverse().map((t) => [String(t), '100.0', '101.0', '99.0', '100.5', '1000']) } };
      }
      if (u.pathname === '/v5/market/open-interest') {
        const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        return { retCode: 0, result: { list: Array.from({ length: Number(q.get('limit')) }, (_, k) => ({ openInterest: '1000', timestamp: String(now - k * 3_600_000) })) } };
      }
      if (u.pathname.startsWith('/api/v5/') && world.okx) return world.okx.answer(req.url);
      throw new Error(`unmocked upstream ${req.url}`);
    }),
  };
});

// get_trade_call's store, as tests/get-trade-signal.test.ts mocks it (no SQLite).
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  isShortLivedScript: () => false,
  // venue-shadow reads these; without them it takes its catch block (as tests/unit/candle-basis-golden.test.ts notes).
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));
// The billing meter, spied through to the real one.
vi.mock('../../src/lib/license.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/license.js')>();
  return { ...m, trackCall: vi.fn(m.trackCall) };
});

import { getAdapter, servingWindowVerdict } from '../../src/lib/exchange-adapter.js';
import { StaleUpstreamWindowError, buildStaleUpstreamWindowPayload } from '../../src/lib/errors.js';
import { HEAD_STALE_BARS } from '../../src/lib/serving-windows.js';
import { historyMetaOf } from '../../src/lib/adapters/_history-plan.js';
import { toMcpToolResult, type ToolCallOutcome } from '../../src/lib/tool-call-pipeline.js';
import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { fetchOiHistoryUsd } from '../../src/lib/oi-sources.js';
import { recordSignal, recordHoldCount } from '../../src/lib/performance-db.js';
import { trackCall, resetLicenseCache } from '../../src/lib/license.js';
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';

// ── 1. the pure verdict ────────────────────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 22, 9, 30); // mid-slot: the forming 1h bar opened 09:00Z, the forming 16:00Z-phase 1D bar yesterday
const grid = (first: number, last: number, step: number) => Array.from({ length: Math.floor((last - first) / step) + 1 }, (_, i) => ({ time: first + i * step }));
const verdict = (bars: { time: number }[], tf: string, startTime: number, servedStepMs: number | null = STEP[tf] ?? null, nowMs = NOW) =>
  servingWindowVerdict({ bars, servedStepMs, timeframe: tf, startTime, nowMs });

describe('servingWindowVerdict', () => {
  const forming1h = Date.UTC(2026, 9, 22, 9);
  const start1h = NOW - 168 * H;

  it('a window through the forming bar is not stale', () => {
    expect(verdict(grid(Math.ceil(start1h / H) * H, forming1h, H), '1h', start1h)).toEqual({ stale: false });
  });

  it('the boundary: a head gap AT the ceiling is served, one bar more is refused', () => {
    const ceiling = HEAD_STALE_BARS['1h'];
    const lastClosed = forming1h - H;
    const atCeiling = grid(Math.ceil(start1h / H) * H, lastClosed - ceiling * H, H);
    expect(verdict(atCeiling, '1h', start1h)).toEqual({ stale: false });
    const over = grid(Math.ceil(start1h / H) * H, lastClosed - (ceiling + 1) * H, H);
    expect(verdict(over, '1h', start1h)).toEqual({ stale: true, headGapBars: ceiling + 1, headStaleBars: ceiling, newestBarAt: lastClosed - (ceiling + 1) * H });
  });

  it('reproduces R0\'s OKX 1h@168 defect: the 100-bar history page anchored on startTime ends 67 bars back', () => {
    const first = Math.ceil(start1h / H) * H;
    const v = verdict(grid(first, first + 99 * H, H), '1h', start1h);
    expect(v).toMatchObject({ stale: true, headGapBars: 67, headStaleBars: 17 });
  });

  it('reproduces R0\'s BITGET 1d@100 defect: the 90-day recent page ends 9 bars back (16:00Z phase)', () => {
    const start = NOW - 100 * DAY;
    const first = Date.UTC(2026, 6, 14, 16); // the first 16:00Z open at or after startTime
    expect(first).toBeGreaterThanOrEqual(start);
    expect(first - start).toBeLessThan(DAY);
    expect(verdict(grid(first, first + 89 * DAY, DAY), '1d', start)).toMatchObject({ stale: true, headGapBars: 9, headStaleBars: 1 });
    // …and assembled through the forming bar it is served
    expect(verdict(grid(first, Date.UTC(2026, 9, 21, 16), DAY), '1d', start)).toEqual({ stale: false });
  });

  it('a UTC+8-phase 1D window one closed bar short is served; two short is refused', () => {
    const start = NOW - 100 * DAY;
    const first = Date.UTC(2026, 6, 14, 16);
    expect(verdict(grid(first, Date.UTC(2026, 9, 19, 16), DAY), '1d', start)).toEqual({ stale: false }); // gap 1
    expect(verdict(grid(first, Date.UTC(2026, 9, 18, 16), DAY), '1d', start)).toMatchObject({ stale: true, headGapBars: 2 });
  });

  it('a page that ended before its window began is the stalest case, never "no bar in the window"', () => {
    const v = verdict(grid(start1h - 50 * H, start1h - 10 * H, H), '1h', start1h);
    expect(v.stale).toBe(true);
    expect(v.stale && v.headGapBars).toBeGreaterThan(168);
  });

  it('a young listing (its gap at the FRONT) is not stale', () => {
    expect(verdict(grid(forming1h - 20 * H, forming1h, H), '1h', start1h)).toEqual({ stale: false });
  });

  it('never judges: no bar, only future bars, an unknown or prototype timeframe, a missing or non-positive step', () => {
    expect(verdict([], '1h', start1h)).toEqual({ stale: false });
    expect(verdict([{ time: NOW + H }], '1h', start1h)).toEqual({ stale: false });
    const stale = grid(start1h, start1h + 10 * H, H);
    expect(verdict(stale, '7m', start1h, H)).toEqual({ stale: false });
    expect(verdict(stale, 'constructor', start1h, H)).toEqual({ stale: false });
    expect(verdict(stale, '1h', start1h, null)).toEqual({ stale: false });
    expect(verdict(stale, '1h', start1h, 0)).toEqual({ stale: false });
    expect(verdict(stale, '1h', start1h).stale).toBe(true); // the same bars, judged
  });

  it('a future bar is ignored, never counted as the newest', () => {
    const bars = [...grid(Math.ceil(start1h / H) * H, forming1h - 40 * H, H), { time: NOW + 3 * H }];
    expect(verdict(bars, '1h', start1h)).toMatchObject({ stale: true, newestBarAt: forming1h - 40 * H });
  });
});

// ── 2. the seam ────────────────────────────────────────────────────────────────────────────────
beforeEach(() => {
  world.staleBars = 0;
  world.failKlines = false;
  world.okx = null;
  calls.length = 0;
});

describe('the getAdapter seam', () => {
  const startOf = (bars: number, tf: string) => Date.now() - bars * STEP[tf];

  it('refuses a stale SERVING read with StaleUpstreamWindowError, naming the coin, venue, timeframe and gap', async () => {
    world.staleBars = 30;
    const err = await getAdapter('BINANCE').getCandles('BTC', '1h', startOf(100, '1h')).catch((e) => e);
    expect(err).toBeInstanceOf(StaleUpstreamWindowError);
    expect(err).toMatchObject({ code: 'STALE_UPSTREAM_WINDOW', coin: 'BTC', exchange: 'BINANCE', timeframe: '1h', headGapBars: 29, headStaleBars: 17 });
    expect(err.newestBarAt).toBe(Math.floor(Date.now() / H) * H - 30 * H);
    expect(err.message).toContain('refused as stale');
  });

  it('passes the same bars on a HISTORY read (endTime given): history consumers judge their own windows', async () => {
    world.staleBars = 30;
    const out = await getAdapter('BINANCE').getCandles('BTC', '1h', startOf(100, '1h'), undefined, Date.now());
    expect(out.length).toBeGreaterThan(60);
  });

  it('a fresh serving read is returned as is, in one request: the guard is arithmetic, never a fetch', async () => {
    const out = await getAdapter('BINANCE').getCandles('BTC', '1h', startOf(100, '1h'));
    expect(out).toHaveLength(100);
    expect(calls).toHaveLength(1);
  });

  it('returns the adapter\'s OWN array: the non-enumerable meta survives the guard (a copy would drop it)', async () => {
    world.okx = new SyntheticVenue('OKX', () => Date.now(), () => ({ listingMs: Date.UTC(2019, 0, 1) }));
    const out = await getAdapter('OKX').getCandles('BTC', '1h', startOf(168, '1h'));
    expect(historyMetaOf(out)?.branch).toBe('R');
    expect(out).toHaveLength(168);
  });

  it('a non-stale upstream failure is the venue\'s own error, untouched', async () => {
    world.failKlines = true;
    await expect(getAdapter('BINANCE').getCandles('BTC', '1h', startOf(100, '1h'))).rejects.toThrow('binance 503');
  });
});

// ── 3. the refusal on every surface it reaches ─────────────────────────────────────────────────
describe('the refusal reaches the caller typed', () => {
  const err = new StaleUpstreamWindowError({ coin: 'ETH', exchange: 'BITGET', timeframe: '1d', newestBarAt: Date.UTC(2026, 9, 12, 16), headGapBars: 9, headStaleBars: 1 });

  it('is an Error with its own code and a payload of exactly these keys', () => {
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('STALE_UPSTREAM_WINDOW');
    expect(buildStaleUpstreamWindowPayload(err)).toEqual({
      error: 'STALE_UPSTREAM_WINDOW',
      error_code: 'STALE_UPSTREAM_WINDOW',
      message: err.message,
      coin: 'ETH',
      exchange: 'BITGET',
      timeframe: '1d',
      newest_bar_at: '2026-10-12T16:00:00.000Z',
      head_gap_bars: 9,
      suggested_action: 'Retry later, or ask another exchange for ETH 1d: BITGET is not serving a current window.',
    });
  });

  it('MCP renders it in band (isError) with that payload', () => {
    const outcome = { ok: false, kind: 'threw', tool: 'get_trade_call', input: {}, error: err } as unknown as ToolCallOutcome;
    const r = toMcpToolResult(outcome);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual(buildStaleUpstreamWindowPayload(err));
  });
});

describe('get_trade_call: a refused window is never billed and never recorded', () => {
  beforeEach(() => {
    vi.mocked(recordSignal).mockClear();
    vi.mocked(recordHoldCount).mockClear();
    vi.mocked(trackCall).mockClear();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
    const a = getAdapter('BINANCE');
    vi.spyOn(a, 'getAssetContext').mockResolvedValue({ coin: 'BTC', funding: 0.0001, openInterest: 5_000_000, prevDayPx: 99, volume24h: 125_000_000, oraclePx: 100, markPx: 100 });
    vi.spyOn(a, 'getPredictedFundings').mockResolvedValue([]);
  });

  it('stale: throws StaleUpstreamWindowError before trackCall, recordSignal or recordHoldCount', async () => {
    world.staleBars = 30;
    await expect(getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' })).rejects.toBeInstanceOf(StaleUpstreamWindowError);
    expect(trackCall).not.toHaveBeenCalled();
    expect(recordSignal).not.toHaveBeenCalled();
    expect(recordHoldCount).not.toHaveBeenCalled();
  });

  it('control: the same call on a current window is billed once and recorded once', async () => {
    const r = await getTradeSignal({ coin: 'BTC', timeframe: '1h', exchange: 'BINANCE' });
    expect(['BUY', 'SELL', 'HOLD']).toContain(r.call);
    expect(trackCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordSignal).mock.calls.length + vi.mocked(recordHoldCount).mock.calls.length).toBe(1);
  });
});

describe('the Bybit OI backfill skips a coin whose price window is refused', () => {
  // 72 h of OI against a price window ending 30 h back: without the seam, the 42 older hours would be priced and
  // returned as a series. With it, the coin is skipped.
  it('stale: null (warm forward), never an OI series priced from a stale close', async () => {
    world.staleBars = 30;
    expect(await fetchOiHistoryUsd('BYBIT', 'BTC', 72)).toBeNull();
  });

  it('control: a current window prices the series; any other failure still throws', async () => {
    const out = await fetchOiHistoryUsd('BYBIT', 'BTC', 72);
    expect(out!.length).toBeGreaterThan(70);
    expect(out!.every((x) => x.oi === 1000 * 100.5)).toBe(true);
    world.failKlines = true;
    await expect(fetchOiHistoryUsd('BYBIT', 'BTC', 72)).rejects.toThrow('bybit 503');
  });
});
