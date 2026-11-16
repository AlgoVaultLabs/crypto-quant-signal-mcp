/**
 * SR-ZONES-W1 CH2 — the get_sr_zones handler over a counted fake of Binance's klines (AC2.1 billing, AC2.2 cache), the
 * §0 response shape, the quota wall, and the pipeline row end to end.
 *
 * The fake answers like Binance's /fapi/v1/klines through the adapter: up to 200 candles from `startTime` on, `endTime`
 * ignored. Billing is measured on the REAL quota meter: a refusal leaves `checkQuota().used` unchanged and a served
 * call moves it by the number of served timeframes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { fakeAdapterCandles } = vi.hoisted(() => ({ fakeAdapterCandles: vi.fn() }));
vi.mock('../../src/lib/exchange-adapter.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
  getAdapter: () => ({ getCandles: fakeAdapterCandles }),
}));

import type { Candle, LicenseInfo } from '../../src/types.js';
import { runGetSrZones, DEFAULT_SR_ZONES_DEPS, type SrZonesDeps, type GetSrZonesOutcome, type GetSrZonesResponse } from '../../src/tools/get-sr-zones.js';
import { checkQuota, trackCall, _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import { StaleUpstreamWindowError, UpstreamRateLimitError } from '../../src/lib/errors.js';
import { SR_ZONES_NOTE } from '../../src/lib/sr-zones/summary.js';
import { computeSrZones, type SrZone } from '../../src/lib/sr-zones/zones.js';
import { priceLevelStep } from '../../src/lib/sr-zones/rounding.js';
import { serveSrZonesFrame } from '../../src/lib/sr-zones/served.js';
import { callTool, toMcpToolResult, type ValidatedToolInput } from '../../src/lib/tool-call-pipeline.js';
import { currentCaller, currentWeightClass, runAsCaller, WeightBudgetSkipError } from '../../src/lib/upstream-weight-budget.js';
import { processScopedTag } from '../../src/lib/caller-tags.js';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');

/** The §0 contract's key lists, in served order (frozen; R7: `order`, `formed_from` and `formed_to` are not served). */
const TOP_KEYS = ['coin', 'venue', 'price', 'note', 'results', 'unserved', 'timestamp', '_algovault'];
const RESULT_KEYS = ['timeframe', 'summary', 'volume_vs_20', 'flags', 'support', 'resistance'];
const ZONE_KEYS = [
  'rank', 'low', 'high', 'distance_pct', 'members',
  'touch_bars_90', 'tests_30', 'last_touch', 'state', 'broke_at', 'overlaps',
];
/** The keys Mr.1 took out of the response (R7, 2026-11-16): never served at any level. */
const REMOVED_KEYS = ['order', 'formed_from', 'formed_to'];
const UNSERVED_KEYS = ['timeframe', 'reason'];
const OVERLAP_KEYS = ['timeframe', 'side', 'rank'];
const STATE_VALUES = ['intact', 'former_support', 'former_resistance'];
const FLAG_VALUES = ['no_zone_above', 'no_zone_below', 'price_inside_zone'];

/** A seeded random-walk series for `tf`: `bars` candles ending with the one forming at NOW. */
function walk(tf: string, bars: number, seed: number): Candle[] {
  const step = intervalMsFor(tf)!;
  const formingOpen = Math.floor(NOW / step) * step;
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let close = 60_000;
  for (let i = bars - 1; i >= 0; i--) {
    const open = close;
    close = open * (1 + 0.02 * (rand() - 0.5));
    out.push({
      time: formingOpen - i * step,
      open,
      high: Math.max(open, close) * (1 + 0.004 * rand()),
      low: Math.min(open, close) * (1 - 0.004 * rand()),
      close,
      volume: 100 + 50 * rand(),
    });
  }
  return out;
}

const DATA: Record<string, Record<string, Candle[]>> = {
  BTC: { '1d': walk('1d', 1500, 1), '4h': walk('4h', 1500, 2), '1h': walk('1h', 1500, 3) },
  YOUNG: { '1d': walk('1d', 46, 4) },
  NEWBORN: { '1d': walk('1d', 15, 5) },
  // The same price path on two timeframes (same seed), so every zone of one has a twin on the other.
  TWIN: { '1d': walk('1d', 1500, 7), '4h': walk('4h', 1500, 7) },
};

/** Binance-shaped klines: up to 200 candles from startTime on; endTime ignored. */
function binanceLike(coin: string, tf: string, startTime: number): Candle[] {
  const series = DATA[coin]?.[tf];
  if (!series) throw new Error('Binance API 400: Bad Request');
  return series.filter((c) => c.time >= startTime).slice(0, 200);
}

type CallLog = Array<[coin: string, tf: string, startTime: number, endTime: number | undefined]>;

/** A counted fake: every getCandles call is logged (an override still answers it). */
function deps(over: Partial<SrZonesDeps> = {}): SrZonesDeps & { calls: CallLog } {
  const calls: CallLog = [];
  const answer = over.getCandles ?? (async (coin: string, tf: string, startTime: number) => binanceLike(coin, tf, startTime));
  return {
    nowMs: over.nowMs ?? (() => NOW),
    cache: over.cache ?? new Map(),
    failures: over.failures ?? new Map(),
    getCandles: async (coin, tf, startTime, endTime) => {
      calls.push([coin, tf, startTime, endTime]);
      return answer(coin, tf, startTime, endTime);
    },
    // SR-ZONES-W2: no venue tick unless a test sets one — the step is then four significant figures of the price.
    getPriceTick: over.getPriceTick ?? (async () => null),
    calls,
  };
}

/** SR-ZONES-W2: what the handler computes for one window before it rounds the edges (§0.2: everything but low/high). */
function computedFrame(series: Candle[], price: number) {
  const closed = series.slice(-1001, -1); // the window's 1000 closed candles, the forming one excluded
  const r = computeSrZones(closed, closed.length - 1, price);
  if (!r.ok) throw new Error(r.reason);
  return r.frame;
}

/** Binance-shaped klines whose forming candle has moved to `price` (a later read inside the same candle). */
function withFormingPrice(page: Candle[], price: number): Candle[] {
  return page.map((c, i) => (i === page.length - 1 ? { ...c, close: price, high: Math.max(c.high, price), low: Math.min(c.low, price) } : c));
}

let n = 0;
const keyed = (): LicenseInfo => ({ tier: 'free', key: `av_srz_${++n}` });
const used = (lic: LicenseInfo): number => checkQuota(lic).used;
const okOf = (o: GetSrZonesOutcome) => {
  if (o.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o.payload)}`);
  return o.response;
};
const refusalOf = (o: GetSrZonesOutcome) => {
  if (o.kind !== 'refused') throw new Error('expected a refusal');
  return o;
};

beforeEach(() => {
  _resetCallTrackersForTest();
  resetLicenseCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SR-ZONES-W1 AC2.1 — billing: one unit per served timeframe', () => {
  it('2 timeframes served → 2 units', async () => {
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, lic, deps()));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d', '4h']);
    expect(r.unserved).toEqual([]);
    expect(used(lic)).toBe(2);
  });

  it('1 of 2 unserved → 1 unit and an unserved row with its reason', async () => {
    const lic = keyed();
    const d = deps({
      getCandles: async (coin, tf, startTime) => {
        if (tf === '4h') throw new StaleUpstreamWindowError({ coin, exchange: 'BINANCE', timeframe: tf, newestBarAt: NOW - 86_400_000, headGapBars: 5, headStaleBars: 2 });
        return binanceLike(coin, tf, startTime);
      },
    });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, lic, d));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    expect(r.unserved).toEqual([{ timeframe: '4h', reason: 'BINANCE served a candle window that ends 5 closed candles before now' }]);
    expect(used(lic)).toBe(1);
  });

  it('0 served → refused, 0 units (a symbol Binance refuses)', async () => {
    const lic = keyed();
    const o = refusalOf(await runGetSrZones({ coin: 'nope', timeframes: ['1d', '4h'] }, lic, deps()));
    expect(o.status).toBe(422);
    expect(o.payload).toMatchObject({
      error: 'no_timeframe_served',
      code: 'no_timeframe_served',
      coin: 'NOPE',
      venue: 'BINANCE',
      unserved: [
        { timeframe: '1d', reason: 'BINANCE refused the candle request for NOPE (HTTP 400)' },
        { timeframe: '4h', reason: 'BINANCE refused the candle request for NOPE (HTTP 400)' },
      ],
    });
    expect(o.payload._algovault).toMatchObject({ tool: 'get_support_resistance_zones' });
    expect(used(lic)).toBe(0);
  });

  it('0 served → refused, 0 units (too few closed candles)', async () => {
    const lic = keyed();
    const o = refusalOf(await runGetSrZones({ coin: 'NEWBORN', timeframes: ['1d'] }, lic, deps()));
    expect(o.status).toBe(422);
    expect(o.payload).toMatchObject({ unserved: [{ timeframe: '1d', reason: 'fewer than 21 closed candles' }] });
    expect(used(lic)).toBe(0);
  });

  it('a duplicate timeframe is served and billed once', async () => {
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '1d'] }, lic, deps()));
    expect(r.results).toHaveLength(1);
    expect(used(lic)).toBe(1);
  });

  it('a young listing (46 daily candles) is served with flags, not refused', async () => {
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'YOUNG', timeframes: ['1d'] }, lic, deps()));
    expect(r.results).toHaveLength(1);
    expect(Array.isArray(r.results[0].flags)).toBe(true);
    expect(used(lic)).toBe(1);
  });
});

describe('SR-ZONES-W1 AC2.2 — the per-candle history cache and the 60 s head re-read (R5 Q3)', () => {
  const STEP_4H = 4 * 3_600_000;
  const formingClose = (tf: string): number => DATA.BTC[tf][DATA.BTC[tf].length - 1].close;

  it('a repeat call inside the same candle and within 60 s makes 0 getCandles calls', async () => {
    let now = NOW;
    const d = deps({ nowMs: () => now });
    await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, keyed(), d);
    const first = d.calls.length;
    expect(first).toBe(12); // per timeframe: the 100-candle head page + 5 history pages of 200
    now = NOW + 59_999;
    const again = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['4h', '1d'] }, keyed(), d));
    expect(d.calls.length).toBe(first);
    expect(again.results.map((x) => x.timeframe)).toEqual(['4h', '1d']);
    expect(again.timestamp).toBe(NOW / 1000);
  });

  it('after 60 s inside the same candle: 1 newest-page read per timeframe, never a history page, and the price is live', async () => {
    let now = NOW;
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime, endTime) => {
        const page = binanceLike(coin, tf, startTime);
        return now > NOW && endTime === undefined ? withFormingPrice(page, 61_234.5) : page;
      },
    });
    const before = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, keyed(), d));
    expect(before.price).toBe(formingClose('1d')); // both read at NOW: the first requested window prices the response
    const first = d.calls.length;
    now = NOW + 60_000;
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, lic, d));
    const reread = d.calls.slice(first);
    expect(reread.map(([, tf]) => tf)).toEqual(['1d', '4h']);
    for (const [, tf, startTime, endTime] of reread) {
      expect(endTime).toBeUndefined(); // the serving read of the newest page, never a history page
      expect(startTime).toBe(now - 100 * intervalMsFor(tf)!);
    }
    expect(r.price).toBe(61_234.5);
    expect(r.timestamp).toBe(now / 1000);
    expect(r.unserved).toEqual([]);
    expect(used(lic)).toBe(2);
    // The merged window keeps the full history: same length, same closed candles, a new forming close.
    const w = d.cache.get('BINANCE:BTC:1d')!;
    expect(w.candles).toHaveLength(1001);
    expect(w.candles.at(-2)).toEqual(DATA.BTC['1d'].at(-2));
    expect(w.candles.at(-1)!.close).toBe(61_234.5);
    // A further call inside 60 s of the re-read makes 0 calls again.
    now += 59_999;
    await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, keyed(), d);
    expect(d.calls.length).toBe(first + 2);
  });

  it.each([
    ['a venue error', new Error('Binance API 503: Service Unavailable')],
    ['a rate limit', new UpstreamRateLimitError('Binance', 1)],
    ['a stale head', new StaleUpstreamWindowError({ coin: 'BTC', exchange: 'BINANCE', timeframe: '4h', newestBarAt: NOW - 86_400_000, headGapBars: 5, headStaleBars: 2 })],
  ])('a failed head re-read (%s) serves the cached window with its older timestamp, never unserved', async (_label, failure) => {
    let now = NOW;
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime) => {
        if (now > NOW) throw failure;
        return binanceLike(coin, tf, startTime);
      },
    });
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    const first = d.calls.length;
    now = NOW + 120_000;
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, lic, d));
    expect(d.calls.length).toBe(first + 1); // one attempt
    expect(r.results.map((x) => x.timeframe)).toEqual(['4h']);
    expect(r.unserved).toEqual([]);
    expect(r.timestamp).toBe(NOW / 1000);
    expect(r.price).toBe(formingClose('4h'));
    expect(used(lic)).toBe(1);
  });

  it('the history lasts until the timeframe\'s next candle close, then the full window is read again', async () => {
    let now = NOW;
    const d = deps({ nowMs: () => now });
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    expect(d.calls).toHaveLength(6);
    now = Date.parse('2026-11-14T11:59:59.999Z'); // still inside the 08:00 4h candle, long past 60 s
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    expect(d.calls).toHaveLength(7); // the newest page only
    now = Date.parse('2026-11-14T12:00:00.000Z'); // the 08:00 candle closed
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    expect(d.calls).toHaveLength(13); // head page + 5 history pages
    expect(d.cache.get('BINANCE:BTC:4h')!.validUntilMs).toBe(Date.parse('2026-11-14T16:00:00.000Z'));
  });

  it('concurrent misses for one key share one read', async () => {
    const d = deps();
    await Promise.all([
      runGetSrZones({ coin: 'BTC', timeframes: ['1h'] }, keyed(), d),
      runGetSrZones({ coin: 'BTC', timeframes: ['1h'] }, keyed(), d),
    ]);
    expect(d.calls.length).toBe(6);
  });

  it('concurrent stale reads for one key share one head re-read', async () => {
    let now = NOW;
    const d = deps({ nowMs: () => now });
    await runGetSrZones({ coin: 'BTC', timeframes: ['1h'] }, keyed(), d);
    now = NOW + 61_000;
    await Promise.all([
      runGetSrZones({ coin: 'BTC', timeframes: ['1h'] }, keyed(), d),
      runGetSrZones({ coin: 'BTC', timeframes: ['1h'] }, keyed(), d),
    ]);
    expect(d.calls.length).toBe(7);
  });

  it('a head re-read that finishes after the candle closed never replaces the newer window', async () => {
    const STALE = Date.parse('2026-11-14T11:59:00.000Z');
    let now = NOW;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime, endTime) => {
        if (startTime === STALE - 100 * STEP_4H && endTime === undefined) await gate; // the 11:59 re-read hangs
        return binanceLike(coin, tf, startTime);
      },
    });
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    now = STALE;
    const late = runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d); // its re-read is in flight
    now = Date.parse('2026-11-14T12:00:00.000Z');
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d)); // the full re-read lands first
    const newer = d.cache.get('BINANCE:BTC:4h')!;
    expect(newer.validUntilMs).toBe(Date.parse('2026-11-14T16:00:00.000Z'));
    expect(d.calls.filter(([, , st, et]) => st === STALE - 100 * STEP_4H && et === undefined)).toHaveLength(1); // the re-read was issued
    release();
    okOf(await late);
    expect(d.cache.get('BINANCE:BTC:4h')).toBe(newer);
  });

  it('reads 1000 closed candles and prices from the forming one', async () => {
    const d = deps();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d));
    const w = [...d.cache.values()][0];
    expect(w.candles).toHaveLength(1001);
    expect(r.price).toBe(formingClose('1d'));
    expect(r.timestamp).toBe(NOW / 1000);
  });
});

describe('SR-ZONES-W1 R6 #4 — only closed candles reach the formula', () => {
  it('an extreme forming candle sets the price and changes no zone, flag or volume_vs_20', async () => {
    const series = DATA.BTC['1d'].map((c) => ({ ...c }));
    const forming = series[series.length - 1];
    forming.high = forming.close * 3;
    forming.low = forming.close * 0.3;
    forming.volume *= 1000;
    const d = deps({ getCandles: async (_coin, _tf, startTime) => series.filter((c) => c.time >= startTime).slice(0, 200) });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d));
    const expected = computedFrame(series, forming.close);
    // SR-ZONES-W2: the served frame is the computed one with its edges rounded outward to the call's step (no tick
    // here), and the distance and the inside flag read from those edges (R7 #3).
    const served = serveSrZonesFrame(expected, forming.close, priceLevelStep(forming.close, null));
    expect(r.price).toBe(forming.close);
    const [res] = r.results;
    expect(res.support).toEqual(served.support);
    expect(res.resistance).toEqual(served.resistance);
    expect(res.flags).toEqual(served.flags);
    expect(res.volume_vs_20).toBe(expected.volume_vs_20);
  });
});

describe('SR-ZONES-W1 R6 #5 — overlaps reach the response', () => {
  type Side = 'support' | 'resistance';
  const SIDES_ = ['support', 'resistance'] as const;
  const meets = (x: { low: number; high: number }, y: { low: number; high: number }): boolean => x.low <= y.high && y.low <= x.high;

  /**
   * SR-ZONES-W2 §0.2: overlaps are judged on the COMPUTED edges, exactly as T1 — never on the rounded ones served.
   * Returns how many overlap entries were checked, and how many cross-timeframe pairs meet ONLY on the served edges
   * (a pair a served-edge overlap would wrongly list).
   */
  function checkOverlaps(r: GetSrZonesResponse, series: Record<string, Candle[]>): { pairs: number; onlyServed: number } {
    const computed = Object.fromEntries(r.results.map((res) => [res.timeframe, computedFrame(series[res.timeframe], r.price)]));
    const zonesOf = (tf: string) => SIDES_.flatMap((side: Side) => computed[tf][side].map((zone: SrZone) => ({ side, zone })));
    const [a, b] = r.results;
    let pairs = 0;
    let onlyServed = 0;
    for (const [self, other] of [[a, b], [b, a]] as const) {
      for (const side of SIDES_) {
        self[side].forEach((zone, i) => {
          const raw = computed[self.timeframe][side][i];
          expect([zone.rank, zone.state]).toEqual([raw.rank, raw.state]);
          const expected = zonesOf(other.timeframe)
            .filter((o) => meets(raw, o.zone))
            .map((o) => ({ timeframe: other.timeframe, side: o.side, rank: o.zone.rank }));
          expect(zone.overlaps).toEqual(expected);
          pairs += expected.length;
          for (const os of SIDES_) {
            other[os].forEach((o, j) => {
              if (meets(zone, o) && !meets(raw, computed[other.timeframe][os][j])) onlyServed++;
            });
          }
        });
      }
    }
    return { pairs, onlyServed };
  }

  it('every zone lists exactly the intersecting zones of the other requested timeframe, both ways', async () => {
    const r = okOf(await runGetSrZones({ coin: 'TWIN', timeframes: ['1d', '4h'] }, keyed(), deps()));
    expect(checkOverlaps(r, DATA.TWIN).pairs).toBeGreaterThan(0); // the twin series share zones, so the check is not vacuous
  });

  it('SR-ZONES-W2 §0.2: with a coarse step, zones that meet only on their rounded edges are not listed', async () => {
    // A 1000 tick makes the step 1000 at price ~60,000, so rounded edges reach where computed ones do not.
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, keyed(), deps({ getPriceTick: async () => 1000 })));
    const { onlyServed } = checkOverlaps(r, DATA.BTC);
    expect(onlyServed).toBeGreaterThan(0); // non-vacuous: an overlap judged on served edges would differ here
  });
});

describe('SR-ZONES-W1 R6 #9 — price comes from the freshest read', () => {
  it('one window served from cache, the other re-read: price and timestamp are the re-read\'s', async () => {
    let now = NOW;
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime, endTime) => {
        const page = binanceLike(coin, tf, startTime);
        return tf === '1d' && now > NOW && endTime === undefined ? withFormingPrice(page, 61_111.1) : page;
      },
    });
    await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d); // 1d read at NOW
    now = NOW + 50_000;
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d); // 4h read at NOW + 50 s
    now = NOW + 70_000; // 1d is 70 s old (re-read), 4h 20 s old (cached)
    const before = d.calls.length;
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['4h', '1d'] }, keyed(), d));
    expect(d.calls.slice(before).map(([, tf]) => tf)).toEqual(['1d']);
    expect(r.price).toBe(61_111.1);
    expect(r.timestamp).toBe(now / 1000);
  });
});

describe('SR-ZONES-W1 R7 #2 — a failed full read is remembered for a short, jittered TTL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a repeat unknown-coin call inside the TTL makes 0 getCandles calls and refuses the same way, unbilled', async () => {
    let now = NOW;
    const d = deps({ nowMs: () => now });
    const lic = keyed();
    const first = refusalOf(await runGetSrZones({ coin: 'NOPE', timeframes: ['1d', '4h'] }, lic, d));
    expect(d.calls).toHaveLength(2); // one head page per timeframe, each refused with HTTP 400
    now = NOW + 1_000;
    const again = refusalOf(await runGetSrZones({ coin: 'NOPE', timeframes: ['1d', '4h'] }, lic, d));
    expect(d.calls).toHaveLength(2);
    expect(again.status).toBe(first.status);
    expect(again.payload).toEqual(first.payload);
    expect(used(lic)).toBe(0);
  });

  it.each([
    [0, 19_999, 20_000],
    [0.999_999, 29_999, 30_000],
  ])('the TTL is 20 s plus up to half again (Math.random() = %s): held at +%s ms, read again at +%s ms', async (rnd, held, again) => {
    vi.spyOn(Math, 'random').mockReturnValue(rnd);
    let now = NOW;
    const d = deps({ nowMs: () => now });
    await runGetSrZones({ coin: 'NOPE', timeframes: ['1d'] }, keyed(), d);
    expect(d.calls).toHaveLength(1);
    now = NOW + held;
    await runGetSrZones({ coin: 'NOPE', timeframes: ['1d'] }, keyed(), d);
    expect(d.calls).toHaveLength(1);
    now = NOW + again;
    await runGetSrZones({ coin: 'NOPE', timeframes: ['1d'] }, keyed(), d);
    expect(d.calls).toHaveLength(2);
  });

  it('a timeframe that failed does not hold back another timeframe of the same coin', async () => {
    let now = NOW;
    let fail4h = true;
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime) => {
        if (tf === '4h' && fail4h) throw new Error('Binance API 503: Service Unavailable');
        return binanceLike(coin, tf, startTime);
      },
    });
    await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    fail4h = false;
    now = NOW + 1_000;
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, keyed(), d));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    expect(r.unserved).toEqual([{ timeframe: '4h', reason: 'BINANCE candle request failed' }]);
    expect(d.calls.filter(([, tf]) => tf === '4h')).toHaveLength(1); // the held 4h failure made no request
  });

  it('remembers at most 1024 failed reads, and an expired one is swept by the next failure', async () => {
    let now = NOW;
    const d = deps({ nowMs: () => now });
    for (let i = 0; i < 1030; i++) await runGetSrZones({ coin: `NOPE${i}`, timeframes: ['1d'] }, keyed(), d);
    expect(d.failures.size).toBe(1024);
    expect(d.failures.has('BINANCE:NOPE0:1d')).toBe(false); // the oldest went first
    expect(d.failures.has('BINANCE:NOPE1029:1d')).toBe(true);
    now = NOW + 31_000; // every entry above has expired
    await runGetSrZones({ coin: 'NOPEX', timeframes: ['1d'] }, keyed(), d);
    expect([...d.failures.keys()]).toEqual(['BINANCE:NOPEX:1d']);
  });
});

describe('SR-ZONES-W1 R7 #2 — history pages read in the batch weight class; the newest page stays interactive', () => {
  type Seen = { endTime: number | undefined; cls: string; caller: string };
  const watch = (seen: Seen[]) => async (coin: string, tf: string, startTime: number, endTime?: number) => {
    seen.push({ endTime, cls: currentWeightClass(), caller: currentCaller() });
    return binanceLike(coin, tf, startTime);
  };

  it('a full read: the head page interactive under the caller\'s tag, every history page batch under get_sr_zones', async () => {
    const seen: Seen[] = [];
    let now = NOW;
    const d = deps({ nowMs: () => now, getCandles: watch(seen) });
    await runAsCaller('outer_scope', () => runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d));
    const head = seen.filter((s) => s.endTime === undefined);
    const history = seen.filter((s) => s.endTime !== undefined);
    expect(head).toEqual([{ endTime: undefined, cls: 'interactive', caller: 'outer_scope' }]);
    expect(history).toHaveLength(5);
    for (const h of history) expect([h.cls, h.caller]).toEqual(['batch', processScopedTag('get_sr_zones')]);
    // The 60 s re-read of the newest page is interactive too.
    now = NOW + 61_000;
    await runAsCaller('outer_scope', () => runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d));
    expect(seen.slice(6)).toEqual([{ endTime: undefined, cls: 'interactive', caller: 'outer_scope' }]);
  });

  it.each([
    ['the batch budget skipped it', new WeightBudgetSkipError('Binance', 2), 'BINANCE candle history was skipped: the shared request budget was full'],
    ['Binance rate-limited it', new UpstreamRateLimitError('Binance', 30), 'BINANCE is rate-limiting requests'],
  ])('a throttled history page (%s): that timeframe is unserved, unbilled, uncached, and held for the TTL', async (_label, failure, reason) => {
    let now = NOW;
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime, endTime) => {
        if (tf === '4h' && endTime !== undefined) throw failure;
        return binanceLike(coin, tf, startTime);
      },
    });
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, lic, d));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    expect(r.unserved).toEqual([{ timeframe: '4h', reason }]);
    expect(used(lic)).toBe(1);
    expect(d.cache.has('BINANCE:BTC:4h')).toBe(false);
    const before = d.calls.length;
    now = NOW + 1_000;
    const again = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, keyed(), d));
    expect(again.unserved).toEqual([{ timeframe: '4h', reason }]);
    expect(d.calls.length).toBe(before);
  });
});

describe('SR-ZONES-W1 R7 #4 — a window with no candles is never cached', () => {
  it('Binance answers [] and then the series: unserved and uncached at first, and the call after 60 s is served', async () => {
    let now = NOW;
    let empty = true;
    const d = deps({
      nowMs: () => now,
      getCandles: async (coin, tf, startTime) => (empty ? [] : binanceLike(coin, tf, startTime)),
    });
    const lic = keyed();
    const o = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, lic, d));
    expect(o.status).toBe(503);
    expect(o.payload).toMatchObject({ unserved: [{ timeframe: '1d', reason: 'BINANCE returned no candles for this timeframe' }] });
    expect(d.cache.size).toBe(0);
    expect(used(lic)).toBe(0);
    empty = false;
    now = NOW + 60_000;
    const before = d.calls.length;
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, lic, d));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    expect(r.unserved).toEqual([]);
    expect(d.calls.length - before).toBe(6); // a full read: the head page + 5 history pages
    expect(used(lic)).toBe(1);
  });

  it.each([
    ['fresh', 1_000],
    ['older than 60 s', 61_000],
  ])('a cached window with no candles (%s) goes to a full read', async (_label, age) => {
    const cache = new Map([['BINANCE:BTC:1d', { candles: [] as Candle[], readAtMs: NOW, validUntilMs: NOW + 86_400_000 }]]);
    const d = deps({ nowMs: () => NOW + age, cache });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    expect(d.calls).toHaveLength(6);
    expect(d.calls.slice(1).every(([, , , endTime]) => typeof endTime === 'number')).toBe(true);
    expect(d.cache.get('BINANCE:BTC:1d')!.candles).toHaveLength(1001);
  });
});

describe('SR-ZONES-W1 R9 #2 — a short history page is not the listing start', () => {
  const STEP_1D = 86_400_000;
  /** Binance-shaped klines over `series`: up to 200 candles from startTime on, endTime ignored. */
  const pagesOf = (series: Candle[]) => async (_coin: string, _tf: string, startTime: number) =>
    series.filter((c) => c.time >= startTime).slice(0, 200);

  it('one candle missing inside the second history page: the read keeps paging back to the window start', async () => {
    const full = DATA.BTC['1d'];
    // The head page holds D-99..D, history page 1 D-299..D-100, history page 2 D-499..D-300: drop D-350.
    const holed = full.filter((_, i) => i !== full.length - 351);
    const d = deps({ getCandles: pagesOf(holed) });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), d));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    const w = d.cache.get('BINANCE:BTC:1d')!;
    expect(w.candles).toHaveLength(1001);
    expect(w.candles[0].time).toBeLessThanOrEqual(NOW - 1001 * STEP_1D);
    expect(d.calls).toHaveLength(6); // the head page + 5 history pages, the same as with no gap
  });

  it('a young listing costs at most one extra request: the page that adds no older candle ends the walk', async () => {
    const listing = walk('1d', 250, 9);
    const d = deps({ getCandles: pagesOf(listing) });
    okOf(await runGetSrZones({ coin: 'MID', timeframes: ['1d'] }, keyed(), d));
    expect(d.cache.get('BINANCE:MID:1d')!.candles).toHaveLength(250);
    expect(d.calls).toHaveLength(3); // the head page, the page reaching the first candle, one that adds nothing
  });
});

describe('SR-ZONES-W1 R8 — a full read not finished within 10 s: unserved for that call, finished in the background', () => {
  const SLOW = 'BINANCE candle history did not load within 10 s; the read continues in the background';
  beforeEach(() => {
    // The file-level beforeEach fakes Date only, and vi.useFakeTimers is a no-op while time is already faked.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(NOW));
  });
  /** One real macrotask turn: every microtask (the background read's whole chain) has run by then. */
  const turn = () => new Promise<void>((r) => setImmediate(r));

  /** A counted fake whose `tf` reads hang until the gate opens (or fails); every other read answers at once. */
  function gated(tf: string) {
    let open: () => void = () => {};
    let fail: (e: unknown) => void = () => {};
    const gate = new Promise<void>((res, rej) => { open = res; fail = rej; });
    gate.catch(() => {}); // observed through the read that awaits it
    const d = deps({
      getCandles: async (coin, t, startTime) => {
        if (t === tf) await gate;
        return binanceLike(coin, t, startTime);
      },
    });
    return { d, open: () => open(), fail: (e: unknown) => fail(e) };
  }

  /** Collects unhandled rejections while `body` runs. */
  async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (e: unknown) => { seen.push(e); };
    process.on('unhandledRejection', listener);
    try {
      await body();
      await turn();
      await turn();
    } finally {
      process.off('unhandledRejection', listener);
    }
    return seen;
  }

  it('at 10 s the slow timeframe is unserved for this call (unbilled, not remembered as a failure); the other is served', async () => {
    const { d } = gated('4h');
    const lic = keyed();
    let settled = false;
    const call = runGetSrZones({ coin: 'BTC', timeframes: ['1d', '4h'] }, lic, d).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = okOf(await call);
    expect(r.results.map((x) => x.timeframe)).toEqual(['1d']);
    expect(r.unserved).toEqual([{ timeframe: '4h', reason: SLOW }]);
    expect(used(lic)).toBe(1);
    expect(d.failures.size).toBe(0);
    // R9 #3: the prod smoke retries on exactly this reason; its pattern must match what the handler serves.
    const smoke = readFileSync(join(__dirname, '..', '..', 'scripts', 'sr-zones-smoke.mjs'), 'utf8');
    const declared = smoke.match(/^const LOAD_TIMEOUT = \/(.+)\/;$/m);
    expect(declared, 'scripts/sr-zones-smoke.mjs declares LOAD_TIMEOUT').not.toBeNull();
    expect(new RegExp(declared![1]).test(r.unserved[0].reason)).toBe(true);
  });

  it('the read finishes in the background and caches its window: the next call is served from it, with no request', async () => {
    const { d, open } = gated('4h');
    const first = runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    await vi.advanceTimersByTimeAsync(10_000);
    const refused = refusalOf(await first);
    expect(refused.status).toBe(503);
    expect(refused.payload).toMatchObject({ unserved: [{ timeframe: '4h', reason: SLOW }] });
    open();
    await turn();
    expect(d.cache.get('BINANCE:BTC:4h')!.candles).toHaveLength(1001);
    const before = d.calls.length;
    const lic = keyed();
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, lic, d));
    expect(d.calls.length).toBe(before);
    expect(r.results.map((x) => x.timeframe)).toEqual(['4h']);
    expect(used(lic)).toBe(1);
  });

  it('stays single-flight: a call during the background read joins it, makes no request, and is served when it lands', async () => {
    const { d, open } = gated('4h');
    const first = runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
    await vi.advanceTimersByTimeAsync(10_000);
    refusalOf(await first);
    const lic = keyed();
    const second = runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, lic, d);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.calls).toHaveLength(1); // the one head page, still waiting on the gate
    open();
    const r = okOf(await second);
    expect(r.results.map((x) => x.timeframe)).toEqual(['4h']);
    expect(d.calls).toHaveLength(6); // one full read: the head page + 5 history pages
    expect(used(lic)).toBe(1);
  });

  it('a background failure is remembered per R7 #2, and no rejection goes unhandled', async () => {
    const { d, fail } = gated('4h');
    const seen = await unhandledDuring(async () => {
      const first = runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d);
      await vi.advanceTimersByTimeAsync(10_000);
      await first;
      expect(d.failures.size).toBe(0);
      fail(new Error('Binance API 503: Service Unavailable'));
      await turn();
      expect(d.failures.has('BINANCE:BTC:4h')).toBe(true);
      const before = d.calls.length;
      const again = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, keyed(), d));
      expect(d.calls.length).toBe(before);
      expect(again.payload).toMatchObject({ unserved: [{ timeframe: '4h', reason: 'BINANCE candle request failed' }] });
    });
    expect(seen).toEqual([]);
  });

  it('a read that lands inside 10 s is served, and nothing goes unhandled once 10 s pass', async () => {
    const { d, open } = gated('4h');
    const seen = await unhandledDuring(async () => {
      const lic = keyed();
      const call = runGetSrZones({ coin: 'BTC', timeframes: ['4h'] }, lic, d);
      await vi.advanceTimersByTimeAsync(9_000);
      open();
      const r = okOf(await call);
      expect(r.unserved).toEqual([]);
      expect(used(lic)).toBe(1);
      expect(vi.getTimerCount()).toBe(0); // the 10 s timer was cleared when the read won
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(seen).toEqual([]);
  });
});

describe('SR-ZONES-W1 — the §0 response shape', () => {
  it('carries exactly the §0 fields, the frozen strings and at most 3 zones a side', async () => {
    const r = okOf(await runGetSrZones({ coin: 'btc', timeframes: ['1d', '4h'] }, keyed(), deps()));
    expect(Object.keys(r)).toEqual(TOP_KEYS);
    expect(r.coin).toBe('BTC');
    expect(r.venue).toBe('BINANCE');
    expect(r.note).toBe(SR_ZONES_NOTE);
    for (const res of r.results) {
      expect(Object.keys(res)).toEqual(RESULT_KEYS);
      expect(res.support.length).toBeLessThanOrEqual(3);
      expect(res.resistance.length).toBeLessThanOrEqual(3);
      for (const z of [...res.support, ...res.resistance]) {
        expect(Object.keys(z)).toEqual(ZONE_KEYS);
        for (const o of z.overlaps) expect(o.timeframe).not.toBe(res.timeframe);
      }
    }
    expect(r._algovault).toMatchObject({ tool: 'get_support_resistance_zones', quota: { used: 2 } });
    expect(r._algovault).toHaveProperty('auth');
  });

  it('R7: `order`, `formed_from` and `formed_to` are served at no level (formation times stay internal)', async () => {
    const r = okOf(await runGetSrZones({ coin: 'TWIN', timeframes: ['1d', '4h', '1h'] }, keyed(), deps()));
    const text = JSON.stringify(r);
    for (const k of REMOVED_KEYS) expect(text, k).not.toContain(`"${k}":`);
    expect(r.results.flatMap((x) => [...x.support, ...x.resistance]).length, 'vacuity guard: zones must be checked').toBeGreaterThan(0);
  });

  it('the quota wall refuses with 429 before any candle read', async () => {
    const lic = keyed();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const before = used(lic);
    const d = deps();
    const o = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, lic, d));
    expect(o.status).toBe(429);
    expect(o.payload).toMatchObject({ error: 'quota_exhausted', code: 'TIER_LIMIT_REACHED' });
    expect(d.calls).toEqual([]);
    expect(used(lic)).toBe(before);
  });
});

// SR-ZONES-W2 CH3: the 2026-11-16 successor (listed in Beta, an x402 route, rounded edges) supersedes the W1 snapshot;
// R7: its key lists are W1's without `order`, `formed_from` and `formed_to`.
describe('SR-ZONES-W1 R7 #3 — the served shape is the one audits/get-sr-zones-shape-snapshot-2026-11-16.json declares', () => {
  const audit = (f: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'audits', f), 'utf8'));
  const snap = () => audit('get-sr-zones-shape-snapshot-2026-11-16.json');

  it('pins the §0 key lists, and carries every field the knowledge-bundle builder reads', () => {
    const s = snap();
    expect(s.endpoint).toBe('get_support_resistance_zones (MCP tool + POST /x402/get_support_resistance_zones)');
    expect(s.snapshot_date).toBe('2026-11-16');
    expect(s.superseded_by).toBeUndefined();
    const w1 = audit('get-sr-zones-shape-snapshot-2026-11-15.json');
    expect(w1.superseded_by).toBe('get-sr-zones-shape-snapshot-2026-11-16.json');
    for (const k of ['allowed_keys', 'results_row_keys', 'zone_keys', 'unserved_row_keys', 'overlaps_row_keys', 'state_values', 'flag_values', 'forbidden_keys']) {
      expect(s[k], k).toEqual((w1[k] as string[]).filter((x) => !REMOVED_KEYS.includes(x)));
    }
    expect(w1.allowed_keys).toContain('order');
    expect(w1.zone_keys).toEqual(expect.arrayContaining(['formed_from', 'formed_to']));
    expect(s.allowed_keys).toEqual(TOP_KEYS);
    expect(s.results_row_keys).toEqual(RESULT_KEYS);
    expect(s.zone_keys).toEqual(ZONE_KEYS);
    expect(s.unserved_row_keys).toEqual(UNSERVED_KEYS);
    expect(s.overlaps_row_keys).toEqual(OVERLAP_KEYS);
    expect(s.state_values).toEqual(STATE_VALUES);
    expect(s.flag_values).toEqual(FLAG_VALUES);
    expect(Array.isArray(s.consumers) && s.consumers.length > 0).toBe(true);
    expect(typeof s.cache_contract).toBe('object');
    expect(typeof s.error_contract).toBe('object');
    expect(s.drift_check_command).toContain('select(.name == "get_support_resistance_zones")');
    for (const f of ['outcome_return_pct', 'outcome_price', 'call', 'verdict', 'probability', 'target']) expect(s.forbidden_keys, f).toContain(f);
  });

  it('a response with overlaps and an unserved row matches every declared key list, and carries no forbidden key', async () => {
    const s = snap();
    const r = okOf(await runGetSrZones({ coin: 'TWIN', timeframes: ['1d', '4h', '1h'] }, keyed(), deps()));
    expect(r.unserved.length, 'vacuity guard: an unserved row must be checked').toBeGreaterThan(0);
    expect(Object.keys(r)).toEqual(s.allowed_keys);
    let zones = 0;
    let overlaps = 0;
    for (const res of r.results) {
      expect(Object.keys(res)).toEqual(s.results_row_keys);
      for (const f of res.flags) expect(s.flag_values).toContain(f);
      for (const z of [...res.support, ...res.resistance]) {
        zones++;
        expect(Object.keys(z)).toEqual(s.zone_keys);
        expect(s.state_values).toContain(z.state);
        for (const o of z.overlaps) {
          overlaps++;
          expect(Object.keys(o)).toEqual(s.overlaps_row_keys);
        }
      }
    }
    expect(zones, 'vacuity guard: zones must be checked').toBeGreaterThan(0);
    expect(overlaps, 'vacuity guard: overlap rows must be checked').toBeGreaterThan(0);
    for (const u of r.unserved) expect(Object.keys(u)).toEqual(s.unserved_row_keys);
    for (const k of Object.keys(r._algovault)) expect(s.algovault_keys, `_algovault.${k}`).toContain(k);
    for (const k of s.algovault_required_keys) expect(r._algovault, `_algovault.${k}`).toHaveProperty(k);
    const text = JSON.stringify(r);
    for (const f of s.forbidden_keys) expect(text, f).not.toContain(`"${f}":`);
  });

  it('every declared refusal is one the handler emits, with the declared status and fields', async () => {
    const s = snap();
    expect(s.refusal_errors).toEqual(['quota_exhausted', 'no_timeframe_served']);
    const none = s.error_contract.no_timeframe_served;
    const permanent = refusalOf(await runGetSrZones({ coin: 'NOPE', timeframes: ['1d'] }, keyed(), deps()));
    const transient = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, keyed(), deps({
      getCandles: async () => { throw new Error('Binance API 503: Service Unavailable'); },
    })));
    expect([permanent.status, transient.status]).toEqual(none.status);
    for (const o of [permanent, transient]) {
      expect(o.payload.error).toBe('no_timeframe_served');
      expect(Object.keys(o.payload)).toEqual(none.fields);
    }
    const lic = keyed();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const wall = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, lic, deps()));
    expect(wall.status).toBe(s.error_contract.quota_exhausted.status);
    expect(wall.payload.error).toBe('quota_exhausted');
    for (const f of s.error_contract.quota_exhausted.fields) expect(wall.payload, f).toHaveProperty(f);
  });
});

describe('SR-ZONES-W1 — the pipeline row (MCP)', () => {
  beforeEach(() => {
    DEFAULT_SR_ZONES_DEPS.cache.clear();
    DEFAULT_SR_ZONES_DEPS.failures.clear();
    fakeAdapterCandles.mockReset();
    fakeAdapterCandles.mockImplementation(async (coin: string, tf: string, startTime: number) => binanceLike(coin, tf, startTime));
  });

  it('serves get_support_resistance_zones through callTool with the default deps', async () => {
    const outcome = await callTool({
      tool: 'get_support_resistance_zones',
      input: { coin: 'BTC', timeframes: ['1d'] } as unknown as ValidatedToolInput,
      channel: 'mcp',
      license: keyed(),
    });
    expect(outcome.ok).toBe(true);
    const mcp = toMcpToolResult(outcome);
    expect(mcp.isError).toBeFalsy();
    const body = JSON.parse((mcp.content[0] as { text: string }).text);
    expect(body.results[0].timeframe).toBe('1d');
    expect(fakeAdapterCandles).toHaveBeenCalled();
    // The head page is a serving read (no endTime); every later page is a history read.
    expect(fakeAdapterCandles.mock.calls[0][4]).toBeUndefined();
    expect(fakeAdapterCandles.mock.calls.slice(1).every((c) => typeof c[4] === 'number')).toBe(true);
  });

  it('R7 #2: through the row, the head page reads interactive and every history page batch, all tagged get_sr_zones', async () => {
    const seen: Array<[number | undefined, string, string]> = [];
    fakeAdapterCandles.mockImplementation(async (coin: string, tf: string, startTime: number, _dex: unknown, endTime?: number) => {
      seen.push([endTime, currentWeightClass(), currentCaller()]);
      return binanceLike(coin, tf, startTime);
    });
    const outcome = await callTool({
      tool: 'get_support_resistance_zones',
      input: { coin: 'BTC', timeframes: ['1d'] } as unknown as ValidatedToolInput,
      channel: 'mcp',
      license: keyed(),
    });
    expect(outcome.ok).toBe(true);
    const tag = processScopedTag('get_sr_zones');
    expect(seen[0]).toEqual([undefined, 'interactive', tag]);
    expect(seen.slice(1)).toHaveLength(5);
    for (const [endTime, cls, caller] of seen.slice(1)) {
      expect(typeof endTime).toBe('number');
      expect([cls, caller]).toEqual(['batch', tag]);
    }
  });

  it('R6 #10: 2 timeframes through the pipeline row → 2 results and exactly 2 units', async () => {
    const lic = keyed();
    const outcome = await callTool({
      tool: 'get_support_resistance_zones',
      input: { coin: 'BTC', timeframes: ['1d', '4h'] } as unknown as ValidatedToolInput,
      channel: 'mcp',
      license: lic,
    });
    expect(outcome.ok).toBe(true);
    const body = JSON.parse((toMcpToolResult(outcome).content[0] as { text: string }).text);
    expect(body.results.map((x: { timeframe: string }) => x.timeframe)).toEqual(['1d', '4h']);
    expect(used(lic)).toBe(2);
  });

  it('a call with nothing served is an in-band MCP error', async () => {
    const outcome = await callTool({
      tool: 'get_support_resistance_zones',
      input: { coin: 'NOPE', timeframes: ['1d'] } as unknown as ValidatedToolInput,
      channel: 'mcp',
      license: keyed(),
    });
    expect(outcome.ok).toBe(false);
    const mcp = toMcpToolResult(outcome);
    expect(mcp.isError).toBe(true);
    expect(JSON.parse((mcp.content[0] as { text: string }).text)).toMatchObject({ code: 'no_timeframe_served' });
  });
});
