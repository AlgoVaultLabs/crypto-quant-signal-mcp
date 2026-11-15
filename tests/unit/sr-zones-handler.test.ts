/**
 * SR-ZONES-W1 CH2 — the get_sr_zones handler over a counted fake of Binance's klines (AC2.1 billing, AC2.2 cache), the
 * §0 response shape, the quota wall, and the pipeline row end to end.
 *
 * The fake answers like Binance's /fapi/v1/klines through the adapter: up to 200 candles from `startTime` on, `endTime`
 * ignored. Billing is measured on the REAL quota meter: a refusal leaves `checkQuota().used` unchanged and a served
 * call moves it by the number of served timeframes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { fakeAdapterCandles } = vi.hoisted(() => ({ fakeAdapterCandles: vi.fn() }));
vi.mock('../../src/lib/exchange-adapter.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
  getAdapter: () => ({ getCandles: fakeAdapterCandles }),
}));

import type { Candle, LicenseInfo } from '../../src/types.js';
import { runGetSrZones, DEFAULT_SR_ZONES_DEPS, type SrZonesDeps, type GetSrZonesOutcome } from '../../src/tools/get-sr-zones.js';
import { checkQuota, trackCall, _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { FREE_DAILY_CALLS } from '../../src/lib/plans.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import { StaleUpstreamWindowError, UpstreamRateLimitError } from '../../src/lib/errors.js';
import { SR_ZONES_NOTE, SR_ZONES_ORDER } from '../../src/lib/sr-zones/summary.js';
import { computeSrZones, type SrZone } from '../../src/lib/sr-zones/zones.js';
import { callTool, toMcpToolResult, type ValidatedToolInput } from '../../src/lib/tool-call-pipeline.js';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');

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
    getCandles: async (coin, tf, startTime, endTime) => {
      calls.push([coin, tf, startTime, endTime]);
      return answer(coin, tf, startTime, endTime);
    },
    calls,
  };
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
    expect(o.payload._algovault).toMatchObject({ tool: 'get_sr_zones' });
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
    const closed = series.slice(-1001, -1); // the window's 1000 closed candles, the forming one excluded
    const expected = computeSrZones(closed, closed.length - 1, forming.close);
    if (!expected.ok) throw new Error(expected.reason);
    expect(r.price).toBe(forming.close);
    const [res] = r.results;
    expect(res.support).toEqual(expected.frame.support);
    expect(res.resistance).toEqual(expected.frame.resistance);
    expect(res.flags).toEqual(expected.frame.flags);
    expect(res.volume_vs_20).toBe(expected.frame.volume_vs_20);
  });
});

describe('SR-ZONES-W1 R6 #5 — overlaps reach the response', () => {
  it('every zone lists exactly the intersecting zones of the other requested timeframe, both ways', async () => {
    const r = okOf(await runGetSrZones({ coin: 'TWIN', timeframes: ['1d', '4h'] }, keyed(), deps()));
    type Res = (typeof r.results)[number];
    const zonesOf = (res: Res) => (['support', 'resistance'] as const).flatMap((side) => res[side].map((zone: SrZone) => ({ side, zone })));
    const meets = (x: SrZone, y: SrZone): boolean => x.low <= y.high && y.low <= x.high;
    const [a, b] = r.results;
    let pairs = 0;
    for (const [self, other] of [[a, b], [b, a]] as const) {
      for (const { zone } of zonesOf(self)) {
        const expected = zonesOf(other)
          .filter((o) => meets(zone, o.zone))
          .map((o) => ({ timeframe: other.timeframe, side: o.side, rank: o.zone.rank }));
        expect(zone.overlaps).toEqual(expected);
        pairs += expected.length;
      }
    }
    expect(pairs).toBeGreaterThan(0); // the twin series share zones, so the check is not vacuous
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

describe('SR-ZONES-W1 — the §0 response shape', () => {
  it('carries exactly the §0 fields, the frozen strings and at most 3 zones a side', async () => {
    const r = okOf(await runGetSrZones({ coin: 'btc', timeframes: ['1d', '4h'] }, keyed(), deps()));
    expect(Object.keys(r)).toEqual(['coin', 'venue', 'price', 'order', 'note', 'results', 'unserved', 'timestamp', '_algovault']);
    expect(r.coin).toBe('BTC');
    expect(r.venue).toBe('BINANCE');
    expect(r.order).toBe(SR_ZONES_ORDER);
    expect(r.note).toBe(SR_ZONES_NOTE);
    for (const res of r.results) {
      expect(Object.keys(res)).toEqual(['timeframe', 'summary', 'volume_vs_20', 'flags', 'support', 'resistance']);
      expect(res.support.length).toBeLessThanOrEqual(3);
      expect(res.resistance.length).toBeLessThanOrEqual(3);
      for (const z of [...res.support, ...res.resistance]) {
        expect(Object.keys(z)).toEqual([
          'rank', 'low', 'high', 'distance_pct', 'formed_from', 'formed_to', 'members',
          'touch_bars_90', 'tests_30', 'last_touch', 'state', 'broke_at', 'overlaps',
        ]);
        for (const o of z.overlaps) expect(o.timeframe).not.toBe(res.timeframe);
      }
    }
    expect(r._algovault).toMatchObject({ tool: 'get_sr_zones', quota: { used: 2 } });
    expect(r._algovault).toHaveProperty('auth');
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

describe('SR-ZONES-W1 — the pipeline row (MCP)', () => {
  beforeEach(() => {
    DEFAULT_SR_ZONES_DEPS.cache.clear();
    fakeAdapterCandles.mockReset();
    fakeAdapterCandles.mockImplementation(async (coin: string, tf: string, startTime: number) => binanceLike(coin, tf, startTime));
  });

  it('serves get_sr_zones through callTool with the default deps', async () => {
    const outcome = await callTool({
      tool: 'get_sr_zones',
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

  it('R6 #10: 2 timeframes through the pipeline row → 2 results and exactly 2 units', async () => {
    const lic = keyed();
    const outcome = await callTool({
      tool: 'get_sr_zones',
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
      tool: 'get_sr_zones',
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
