/**
 * SR-ZONES-W3 AC2.1 — src/scripts/sr-zones-contiguity.ts: the judge, its two-way self-test (each leg proven able to
 * fail: a judge blind to holes fails the planted-hole leg, one blind to the head fails the planted-stale-head leg), the
 * aggregate's tokens, and readSrZonesWindow — the handler's own window read, uncached, in the batch class.
 */
import { describe, it, expect } from 'vitest';
import type { Candle } from '../../src/types.js';
import {
  judgePair, aggregate, runSelfTest, selfTestCases, WINDOW_BARS, YOUNG_LISTING, readPair, main, DEFAULT_CONTIGUITY_DEPS,
  type PairRead, type PairResult, type ContiguityDeps,
} from '../../src/scripts/sr-zones-contiguity.js';
import { readSrZonesWindow, srZonesPlan, type SrZonesDeps, type SrZonesVenue } from '../../src/tools/get-sr-zones.js';
import { SR_ZONES_TIMEFRAMES, SR_ZONES_VENUES } from '../../src/lib/tool-param-schema.js';
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

/**
 * SR-ZONES-W3 R9 #3 + #8 — readPair and main, with injected reads: an unreachable read is INDETERMINATE, never PASS; a
 * verified refusal is FAIL; the corpus is SR_ZONES_TIMEFRAMES × the four venues × three coins, with an unservable pair
 * a FAIL row, never skipped; INDETERMINATE exits 3; the self-test reports FAIL when its judge is blind.
 */
describe('SR-ZONES-W3 R9 #3 + #8 — readPair and main with injected reads', () => {
  const H = 3_600_000;
  const NOW = Date.parse('2026-11-20T05:30:00.000Z');
  const series = (n: number, stepMs: number): Candle[] => {
    const forming = Math.floor(NOW / stepMs) * stepMs;
    return Array.from({ length: n }, (_, i) => ({ time: forming - (n - 1 - i) * stepMs, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 1 }));
  };
  /** The handler's real window read over a scripted venue (getCandles), as the script's default read is over the live one. */
  const handlerRead = (getCandles: SrZonesDeps['getCandles']): ContiguityDeps['readWindow'] => async (venue, coin, tf) =>
    (await readSrZonesWindow(venue, coin, tf, { nowMs: () => NOW, cache: new Map(), failures: new Map(), getCandles, getPriceTick: async () => null })).window.candles;
  const fullFor = (venue: SrZonesVenue, tf: string): Candle[] => {
    const plan = srZonesPlan(venue, tf)!;
    return series(WINDOW_BARS, plan.readStepMs * plan.k);
  };
  const deps = (over: Partial<ContiguityDeps>): ContiguityDeps & { lines: string[] } => {
    const lines: string[] = [];
    return {
      ...DEFAULT_CONTIGUITY_DEPS,
      nowMs: () => NOW,
      readWindow: async (venue, _coin, tf) => fullFor(venue, tf),
      readBelow: async () => [],
      argv: [],
      log: (line) => { lines.push(line); },
      ...over,
      lines,
    };
  };
  const verdictLine = (lines: string[]) => lines.filter((l) => l.startsWith('SR_ZONES_CONTIGUITY_VERDICT='));

  it('a window read that throws (the venue unreachable) is INDETERMINATE, never PASS or FAIL', async () => {
    const d = deps({ readWindow: handlerRead(async () => { throw new Error('fetch failed'); }) });
    const r = judgePair(await readPair('BYBIT', 'BTC', '4h', d));
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reasons.join()).toMatch(/fetch failed/);
  });

  it('a below-read that throws leaves the listing start unproven: a short clean window is INDETERMINATE', async () => {
    const below: Array<[string, string, number, number]> = [];
    const d = deps({
      readWindow: async () => series(428, 24 * H),
      readBelow: async (_v, _c, readTf, start, end) => { below.push([readTf, '1d', start, end]); throw new Error('socket hang up'); },
    });
    const read = await readPair('BITGET', 'ASTER', '1d', d);
    expect(below).toHaveLength(1);
    expect(read.olderBelow).toBeNull();
    expect(judgePair(read).verdict).toBe('INDETERMINATE');
  });

  it('the below-read runs, below the floor, and older bars there make a short window FAIL (truncated)', async () => {
    const short = series(428, 24 * H);
    const asked: Array<[number, number]> = [];
    const d = deps({
      readWindow: async () => short,
      readBelow: async (_v, _c, _tf, start, end) => { asked.push([start, end]); return series(500, 24 * H).filter((c) => c.time >= start && c.time <= end); },
    });
    const read = await readPair('OKX', 'ASTER', '1d', d);
    expect(asked).toEqual([[short[0].time - 5 * 24 * H, short[0].time - 1]]);
    expect(read.olderBelow).toBe(5);
    expect(judgePair(read).verdict).toBe('FAIL');
  });

  it('a verified refusal is FAIL: an off-UTC window (OffUtcCandleError) and an empty one (EmptyCandleWindowError)', async () => {
    const offUtc = series(1200, 24 * H).map((c) => ({ ...c, time: c.time - 8 * H }));
    const r1 = judgePair(await readPair('OKX', 'BTC', '1d', deps({ readWindow: handlerRead(async (_c, _tf, start) => offUtc.filter((c) => c.time >= start).slice(0, 100)) })));
    expect([r1.verdict, r1.reasons.join()]).toEqual(['FAIL', expect.stringMatching(/^OffUtcCandleError: /)]);
    const r2 = judgePair(await readPair('BYBIT', 'BTC', '4h', deps({ readWindow: handlerRead(async () => []) })));
    expect([r2.verdict, r2.reasons.join()]).toEqual(['FAIL', expect.stringMatching(/^EmptyCandleWindowError: /)]);
    const r3 = judgePair(await readPair('BYBIT', 'BTC', '4h', deps({ readWindow: async () => [] })));
    expect(r3.verdict).toBe('FAIL'); // a window read that returns nothing is never PASS
  });

  it('the corpus is SR_ZONES_TIMEFRAMES × the four venues × BTC, ETH and the young listing: 96 pairs, PASS exits 0', async () => {
    const read: string[] = [];
    const d = deps({ readWindow: async (venue, coin, tf) => { read.push(`${venue}/${coin}/${tf}`); return fullFor(venue, tf); } });
    expect(await main(d)).toBe(0);
    const want = SR_ZONES_VENUES.flatMap((v) => ['BTC', 'ETH', YOUNG_LISTING[v]].flatMap((c) => SR_ZONES_TIMEFRAMES.map((tf) => `${v}/${c}/${tf}`)));
    expect(want).toHaveLength(96);
    expect([...read].sort()).toEqual([...want].sort());
    expect(verdictLine(d.lines)).toEqual(['SR_ZONES_CONTIGUITY_VERDICT=PASS pairs=96 pass=96 fail=0 indeterminate=0']);
  });

  it('#8: an unservable venue × timeframe is a FAIL row for each coin, never skipped; the pair count stays 96', async () => {
    const d = deps({ plan: (venue, tf) => (venue === 'BITGET' && tf === '2h' ? null : srZonesPlan(venue, tf)) });
    expect(await main(d)).toBe(1);
    const rows = d.lines.filter((l) => l.includes(' PAIR ')).map((l) => JSON.parse(l.slice(l.indexOf(' PAIR ') + 6)) as PairResult);
    expect(rows).toHaveLength(96);
    expect(rows.filter((r) => r.verdict === 'FAIL').map((r) => `${r.venue}/${r.coin}/${r.tf}`)).toEqual(['BITGET/BTC/2h', 'BITGET/ETH/2h', 'BITGET/ASTER/2h']);
    expect(verdictLine(d.lines)).toEqual(['SR_ZONES_CONTIGUITY_VERDICT=FAIL pairs=96 pass=93 fail=3 indeterminate=0']);
  });

  it('INDETERMINATE exits 3 (an unreachable venue), never 0', async () => {
    const d = deps({ readWindow: async (venue, _coin, tf) => { if (venue === 'OKX') throw new Error('fetch failed'); return fullFor(venue, tf); } });
    expect(await main(d)).toBe(3);
    expect(verdictLine(d.lines)).toEqual(['SR_ZONES_CONTIGUITY_VERDICT=INDETERMINATE pairs=96 pass=72 fail=0 indeterminate=24']);
  });

  it('--self-test prints FAIL and exits 1 with a blind judge; PASS and 0 with the real one', async () => {
    const blind = deps({ argv: ['--self-test'], judge: (r) => ({ venue: r.venue, coin: r.coin, tf: r.tf, verdict: 'PASS', bars: 0, gapSlots: 0, headGapBars: 0, reasons: [] }) });
    expect(await main(blind)).toBe(1);
    expect(blind.lines.at(-1)).toBe('SR_ZONES_CONTIGUITY_SELFTEST=FAIL');
    const real = deps({ argv: ['--self-test'] });
    expect(await main(real)).toBe(0);
    expect(real.lines.at(-1)).toBe('SR_ZONES_CONTIGUITY_SELFTEST=PASS');
  });
});
