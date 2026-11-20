/**
 * SR-ZONES-W2 R7 #2 — the handler's unserved reasons, one table: unservedReason formats from it, and the post-deploy
 * docs-samples gate (scripts/check-docs-samples-live.mjs, P10) reads the same table to tell a transient refusal from a
 * real one. These tests hold the table to what the handler does: for every reason it gives, the predicate says
 * "transient" exactly when the handler refuses that call with a 503 (a retry can change the answer), and every row of
 * the table is a reason the handler really gives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Candle } from '../../src/types.js';
import {
  runGetSrZones,
  SR_UNSERVED_REASONS,
  isTransientSrUnservedReason,
  type SrZonesDeps,
  type GetSrZonesOutcome,
} from '../../src/tools/get-sr-zones.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import {
  StaleUpstreamWindowError,
  TimeframeUnservedError,
  UpstreamRateLimitError,
  VenueMarketClosedError,
  VenueSymbolRefusedError,
} from '../../src/lib/errors.js';
import { WeightBudgetSkipError } from '../../src/lib/upstream-weight-budget.js';
import { btcFixtureWithForming, DAY_MS } from './sr-zones-helpers.js';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const DAY0 = Date.parse('2026-11-14T00:00:00.000Z');

type Kind = keyof typeof SR_UNSERVED_REASONS;

function deps(getCandles: SrZonesDeps['getCandles']): SrZonesDeps {
  return { nowMs: () => NOW, cache: new Map(), failures: new Map(), getCandles, getPriceTick: async () => null };
}

const call = (d: SrZonesDeps, timeframes: string[] = ['1d'], venue?: 'BYBIT' | 'OKX'): Promise<GetSrZonesOutcome> =>
  runGetSrZones({ coin: 'BTC', timeframes, ...(venue ? { venue } : {}) }, { tier: 'free', key: 'av_srz_unserved' }, d);

function refused(o: GetSrZonesOutcome): { status: number; reasons: string[] } {
  if (o.kind !== 'refused') throw new Error(`expected a refusal, got ${o.kind}`);
  const unserved = (o.payload as { unserved?: Array<{ reason: string }> }).unserved ?? [];
  return { status: o.status, reasons: unserved.map((u) => u.reason) };
}

/** `n` flat daily candles ending with the one forming at NOW: no price movement at all. */
function flat(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: DAY0 - (n - 1 - i) * DAY_MS, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
}

const throwing = (err: unknown): SrZonesDeps['getCandles'] => async () => { throw err; };

/** Each row of the table, reached through the handler: one timeframe, so the refusal's status is that reason's. */
const CASES: Array<[Kind, () => Promise<GetSrZonesOutcome>]> = [
  ['timeframe', () => call(deps(throwing(new TimeframeUnservedError({ exchange: 'BINANCE', timeframe: '1d', servedTimeframes: [] }))))],
  ['marketClosed', () => call(deps(throwing(new VenueMarketClosedError({ venue: 'BINANCE', coin: 'BTC', symbol: 'BTCUSDT', source: 'status', venueCode: 'SETTLING', venueMessage: null }))))],
  ['staleWindow', () => call(deps(throwing(new StaleUpstreamWindowError({ coin: 'BTC', exchange: 'BINANCE', timeframe: '1d', newestBarAt: NOW - 6 * DAY_MS, headGapBars: 5, headStaleBars: 2 }))))],
  ['rateLimited', () => call(deps(throwing(new UpstreamRateLimitError('BINANCE'))))],
  ['budgetSkipped', () => call(deps(throwing(new WeightBudgetSkipError('BINANCE', 5))))],
  ['emptyWindow', () => call(deps(async () => []))],
  ['refused400', () => call(deps(throwing(new Error('Binance API 400: {"code":-1121,"msg":"Invalid symbol."}'))))],
  // SR-ZONES-W3 R9 #2: the adapter's typed in-band refusal (recorded texts: sr-zones-symbol-refusal.test.ts).
  ['refusedCode', () => call(deps(throwing(new VenueSymbolRefusedError('BYBIT', 10001, 'Bybit API error 10001: params error: Symbol Is Invalid'))), ['1d'], 'BYBIT')],
  ['requestFailed', () => call(deps(throwing(new Error('socket hang up'))))],
];

beforeEach(() => {
  _resetCallTrackersForTest();
  resetLicenseCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SR-ZONES-W2 R7 #2 — a reason is transient exactly when the handler refuses with a 503', () => {
  it.each(CASES)('%s', async (kind, run) => {
    const { status, reasons } = refused(await run());
    expect(reasons).toHaveLength(1);
    expect([status, isTransientSrUnservedReason(reasons[0])]).toEqual(SR_UNSERVED_REASONS[kind].transient ? [503, true] : [422, false]);
  });

  it('loadTimeout: a full read still running at 10 s', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
    const pending = call(deps(() => new Promise<Candle[]>(() => {})));
    await vi.advanceTimersByTimeAsync(10_000);
    const { status, reasons } = refused(await pending);
    expect(reasons).toEqual(['BINANCE candle history did not load within 10 s; the read continues in the background']);
    expect([status, isTransientSrUnservedReason(reasons[0])]).toEqual([503, true]);
    expect(SR_UNSERVED_REASONS.loadTimeout.transient).toBe(true);
  });

  it('a reason from the zone formula is not transient, and its refusal is a 422', async () => {
    const young = btcFixtureWithForming(67_585.6).slice(-11);
    for (const [candles, reason] of [
      [young, 'fewer than 21 closed candles'],
      [flat(40), 'no price movement in the loaded candles'],
    ] as const) {
      _resetCallTrackersForTest();
      const { status, reasons } = refused(await call(deps(async (_c, _tf, startTime) => candles.filter((c) => c.time >= startTime))));
      expect(reasons).toEqual([reason]);
      expect([status, isTransientSrUnservedReason(reason)]).toEqual([422, false]);
    }
  });

  it('every row of the table is reached above (no row the handler never gives), and both classes exist', () => {
    const reached = new Set<string>([...CASES.map(([k]) => k), 'loadTimeout']);
    expect(Object.keys(SR_UNSERVED_REASONS).sort()).toEqual([...reached].sort());
    const flags = Object.values(SR_UNSERVED_REASONS).map((r) => r.transient);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  it('the predicate reads whole reasons only: a near miss or a reason with words added is not transient', () => {
    expect(isTransientSrUnservedReason('BINANCE is rate-limiting requests')).toBe(true);
    expect(isTransientSrUnservedReason('BINANCE is rate-limiting requests today')).toBe(false);
    expect(isTransientSrUnservedReason('the venue said: BINANCE is rate-limiting requests')).toBe(false);
    expect(isTransientSrUnservedReason('is rate-limiting requests')).toBe(false);
    expect(isTransientSrUnservedReason('BINANCE candle history did not load within s; the read continues in the background')).toBe(false);
    expect(isTransientSrUnservedReason('')).toBe(false);
  });
});
