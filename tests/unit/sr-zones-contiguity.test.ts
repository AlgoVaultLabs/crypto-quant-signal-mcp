/**
 * SR-ZONES-W3 AC2.1 — src/scripts/sr-zones-contiguity.ts: the judge, its two-way self-test (each leg proven able to
 * fail: a judge blind to holes fails the planted-hole leg, one blind to the head fails the planted-stale-head leg), the
 * aggregate's tokens, and readSrZonesWindow — the handler's own window read, uncached, in the batch class.
 */
import { describe, it, expect } from 'vitest';
import type { Candle } from '../../src/types.js';
import {
  judgePair, aggregate, runSelfTest, selfTestCases, WINDOW_BARS, YOUNG_LISTING,
  type PairRead, type PairResult,
} from '../../src/scripts/sr-zones-contiguity.js';
import { readSrZonesWindow, type SrZonesDeps } from '../../src/tools/get-sr-zones.js';
import { currentCaller, currentWeightClass } from '../../src/lib/upstream-weight-budget.js';
import { processScopedTag } from '../../src/lib/caller-tags.js';

/** The real judge with the reasons matching `blind` ignored: a judge missing that one check. */
const blindTo = (blind: RegExp) => (r: PairRead): PairResult => {
  const res = judgePair(r);
  if (res.verdict !== 'FAIL' || r.error) return res;
  const reasons = res.reasons.filter((x) => !blind.test(x));
  return { ...res, reasons, verdict: reasons.length > 0 ? 'FAIL' : 'PASS' };
};

describe('SR-ZONES-W3 AC2.1 — the contiguity judge and its self-test', () => {
  it('the self-test passes with the real judge, every leg', () => {
    const st = runSelfTest();
    expect(st.legs.filter((l) => !l.ok)).toEqual([]);
    expect(st.pass).toBe(true);
    expect(st.legs.length).toBe(selfTestCases().length + 2);
  });

  it('the planted-hole leg can fail: a judge blind to holes fails it, and only the hole legs', () => {
    const st = runSelfTest(blindTo(/missing bars|not one step apart/));
    expect(st.pass).toBe(false);
    expect(st.legs.filter((l) => !l.ok).map((l) => l.name)).toEqual(['a planted hole fails']);
  });

  it('the planted-stale-head leg can fail: a judge blind to the head fails it', () => {
    const st = runSelfTest(blindTo(/behind now/));
    expect(st.pass).toBe(false);
    expect(st.legs.filter((l) => !l.ok).map((l) => l.name)).toEqual(['a planted stale head fails']);
  });

  it('the UTC and truncation legs can fail too', () => {
    expect(runSelfTest(blindTo(/UTC multiple|off the step grid/)).legs.filter((l) => !l.ok).map((l) => l.name)).toEqual(['a bar off its UTC multiple fails']);
    expect(runSelfTest(blindTo(/not the listing start/)).legs.filter((l) => !l.ok).map((l) => l.name))
      .toEqual(['a window short of 1001 with older bars below fails (truncated)']);
  });

  it('a judge that passes everything fails the self-test; one that throws fails every leg it is asked', () => {
    expect(runSelfTest((r) => ({ ...judgePair(r), verdict: 'PASS' })).pass).toBe(false);
    const st = runSelfTest(() => { throw new Error('broken'); });
    expect(st.legs.slice(0, -2).every((l) => !l.ok)).toBe(true);
  });

  it('the aggregate: FAIL over INDETERMINATE over PASS, an empty corpus INDETERMINATE', () => {
    const v = (verdict: PairResult['verdict']): PairResult => ({ venue: 'X', coin: 'X', tf: '1h', verdict, bars: 0, gapSlots: 0, headGapBars: 0, reasons: [] });
    expect(aggregate([])).toBe('INDETERMINATE');
    expect(aggregate([v('PASS'), v('PASS')])).toBe('PASS');
    expect(aggregate([v('PASS'), v('INDETERMINATE')])).toBe('INDETERMINATE');
    expect(aggregate([v('INDETERMINATE'), v('FAIL'), v('PASS')])).toBe('FAIL');
  });

  it('the young listing is R0 P6\'s on every venue, and a full window is 1001 bars', () => {
    expect(YOUNG_LISTING).toEqual({ BINANCE: 'ASTER', BYBIT: 'ASTER', OKX: 'ASTER', BITGET: 'ASTER' });
    expect(WINDOW_BARS).toBe(1001);
  });
});

describe('SR-ZONES-W3 AC2.1 — readSrZonesWindow: the handler\'s window read, uncached, unbilled, batch class', () => {
  const H = 3_600_000;
  const NOW = Date.parse('2026-11-20T05:30:00.000Z');
  const series = (n: number, stepMs: number): Candle[] => {
    const forming = Math.floor(NOW / stepMs) * stepMs;
    return Array.from({ length: n }, (_, i) => ({ time: forming - (n - 1 - i) * stepMs, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1 }));
  };

  it('a built pair (BYBIT 8h <- 4h): 1001 built bars the judge passes; every read 4h, batch class, under get_sr_zones; nothing cached', async () => {
    const s = series(2100, 4 * H);
    const seen: Array<[string, string, string]> = [];
    const deps: SrZonesDeps = {
      nowMs: () => NOW,
      cache: new Map(),
      failures: new Map(),
      getCandles: async (_coin, tf, startTime) => {
        seen.push([tf, currentWeightClass(), currentCaller()]);
        return s.filter((c) => c.time >= startTime).slice(0, 200);
      },
      getPriceTick: async () => null,
    };
    const { window, plan, stepMs } = await readSrZonesWindow('BYBIT', 'BTC', '8h', deps);
    expect(plan).toEqual({ readTf: '4h', readStepMs: 4 * H, k: 2 });
    expect(stepMs).toBe(8 * H);
    expect(window.candles).toHaveLength(1001);
    expect(new Set(seen.map((x) => x.join(' ')))).toEqual(new Set([`4h batch ${processScopedTag('get_sr_zones')}`]));
    expect(deps.cache.size + deps.failures.size).toBe(0);
    const r = judgePair({ venue: 'BYBIT', coin: 'BTC', tf: '8h', stepMs, readStepMs: plan.readStepMs, nowMs: NOW, window: window.candles, olderBelow: null });
    expect(r).toMatchObject({ verdict: 'PASS', bars: 1001, gapSlots: 0, headGapBars: 0 });
  });

  it('an off-UTC read throws OffUtcCandleError (the script judges it FAIL, a verified refusal)', async () => {
    const s = series(1200, 24 * H).map((c) => ({ ...c, time: c.time - 8 * H })); // 16:00 UTC opens
    const deps: SrZonesDeps = {
      nowMs: () => NOW, cache: new Map(), failures: new Map(),
      getCandles: async (_coin, _tf, startTime) => s.filter((c) => c.time >= startTime).slice(0, 100),
      getPriceTick: async () => null,
    };
    await expect(readSrZonesWindow('OKX', 'BTC', '1d', deps)).rejects.toMatchObject({ name: 'OffUtcCandleError' });
  });
});
