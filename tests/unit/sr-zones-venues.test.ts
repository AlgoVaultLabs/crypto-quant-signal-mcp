/**
 * SR-ZONES-W3 CH1 — get_support_resistance_zones on BINANCE (default), BYBIT, OKX and BITGET, one frozen formula.
 *
 *   AC1.2  `venue` per §0.1: an omitted venue is byte-identical to BASE (87c3c335) on the golden cases; the cache, the
 *          failed-read memo, the unserved reasons and the `venue` field follow the requested venue.
 *   AC1.3  §0.2 + R5: an SR timeframe is native where the venue's adapter serves it at exactly the requested step, else
 *          built from the venue's largest native divisor — both derived from the served-interval registry (no list in
 *          the handler). Mutating a venue's map moves the split; a substituted interval is never read (a planted read
 *          of one is caught); a timeframe with no native divisor is refused as unserved `timeframe` with no request.
 *          The build oracle (Binance built 8h/2h = Binance native 8h/2h) is in sr-zones-build-bars.test.ts.
 *   AC1.4  §0.3: on the R0 walks (tests/fixtures/sr-zones/w3-walk-btc-<venue>-20261120.json, and the R5/R6 addendum's
 *          w3-walk-btc-<venue>-r5r6-20261120.json for the built pairs and the UTC variants), every venue × SR timeframe
 *          assembles 1001 bars with zero holes, asking exactly the recorded pages; a planted wrong page span (one the
 *          venue does not return in one call) is proven to fail that zero-hole check.
 *   AC1.7  R6: every bar SR reads or builds opens on a UTC multiple of its step (asserted on every replayed pair); a
 *          Hong Kong-anchored read (the adapters' default OKX/BITGET 12H and 1D, recorded at CH0) and constituents off
 *          their UTC grid are each refused, never served; the default deps ask the adapter for UTC bars.
 *   R2     one formula: the same candles give the same zones on every venue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { fakeAdapters, over } = vi.hoisted(() => ({
  fakeAdapters: new Map<string, Record<string, unknown>>(),
  over: {
    bybit8h: false,
    /** BYBIT maps only these timeframes (a venue with no native divisor for some SR timeframes). */
    bybitOnly: undefined as string[] | undefined,
    /** A planted defect: the exact-step predicate replaced by the looser isTimeframeFaithful (reads substitutes). */
    loose: false,
    span: {} as Record<string, number | undefined>,
  },
}));
vi.mock('../../src/lib/exchange-adapter.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
  getAdapter: (id: string) => fakeAdapters.get(id) ?? {},
}));
// AC1.3: a test can give BYBIT an 8h bar or take timeframes away; AC1.4: a test can plant a wrong page span on any venue.
// All read at call time.
vi.mock('../../src/lib/adapters/bybit.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/adapters/bybit.js')>();
  return {
    ...m,
    servedIntervalMs: (tf: string) => {
      if (over.bybitOnly && !over.bybitOnly.includes(tf)) return null;
      return over.bybit8h && tf === '8h' ? 28_800_000 : m.servedIntervalMs(tf);
    },
    historyPageBars: (tf: string) => over.span.BYBIT ?? m.historyPageBars(tf),
  };
});
vi.mock('../../src/lib/tf-support.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/tf-support.js')>();
  return {
    ...m,
    isTimeframeServedExactly: (v: Parameters<typeof m.isTimeframeServedExactly>[0], tf: string) =>
      (over.loose ? m.isTimeframeFaithful(v, tf) : m.isTimeframeServedExactly(v, tf)),
  };
});
vi.mock('../../src/lib/adapters/binance.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/adapters/binance.js')>();
  return { ...m, historyPageBars: (tf: string) => over.span.BINANCE ?? m.historyPageBars(tf) };
});
vi.mock('../../src/lib/adapters/okx.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/adapters/okx.js')>();
  return { ...m, historyPageBars: (tf: string) => over.span.OKX ?? m.historyPageBars(tf) };
});
vi.mock('../../src/lib/adapters/bitget.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/adapters/bitget.js')>();
  return { ...m, historyPageBars: (tf: string) => over.span.BITGET ?? m.historyPageBars(tf) };
});

import type { Candle, LicenseInfo } from '../../src/types.js';
import {
  runGetSrZones, srZonesTimeframes, srZonesPlan, DEFAULT_SR_ZONES_DEPS,
  type SrZonesDeps, type GetSrZonesOutcome, type GetSrZonesResponse,
} from '../../src/tools/get-sr-zones.js';
import { SR_ZONES_TIMEFRAMES, SR_ZONES_VENUES } from '../../src/lib/tool-param-schema.js';
import { isTimeframeFaithful, isTimeframeServedExactly, servedCandleStepMs } from '../../src/lib/tf-support.js';
import { accountPage } from '../../src/lib/adapters/_history-plan.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { currentCaller, currentWeightClass, runAsCaller } from '../../src/lib/upstream-weight-budget.js';
import { processScopedTag } from '../../src/lib/caller-tags.js';
import { GOLDEN_CASES, GOLDEN_NOW, goldenDeps, goldenLicense } from './sr-zones-venue-cases.js';

const FIX = join(__dirname, '..', 'fixtures', 'sr-zones');
const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
type Venue = (typeof VENUES)[number];

beforeEach(() => {
  _resetCallTrackersForTest();
  resetLicenseCache();
  over.bybit8h = false;
  over.bybitOnly = undefined;
  over.loose = false;
  over.span = {};
  fakeAdapters.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let n = 0;
const keyed = (): LicenseInfo => ({ tier: 'free', key: `av_srz_w3_${++n}` });
const okOf = (o: GetSrZonesOutcome): GetSrZonesResponse => {
  if (o.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o.payload)}`);
  return o.response;
};
const refusalOf = (o: GetSrZonesOutcome) => {
  if (o.kind !== 'refused') throw new Error('expected a refusal');
  return o;
};

// ── AC1.2 — Binance byte-identity against BASE ────────────────────────────────────────────────────────────────────────

interface GoldenFile {
  baseSha: string;
  cases: Array<{ name: string; outcome: GetSrZonesOutcome; calls: unknown[] }>;
}
const GOLDEN = JSON.parse(readFileSync(join(FIX, 'w3-binance-base-golden.json'), 'utf8')) as GoldenFile;

type ZoneLike = { rank: number; low: number; high: number; overlaps: Array<{ timeframe: string; side: string; rank: number }> };
const SIDES = ['support', 'resistance'] as const;
function zonesOf(r: GetSrZonesResponse): Array<{ timeframe: string; side: string; zone: ZoneLike }> {
  return r.results.flatMap((res) => SIDES.flatMap((side) => (res[side] as ZoneLike[]).map((zone) => ({ timeframe: res.timeframe, side, zone }))));
}
/** The outcome with every `overlaps` array emptied — §0.5 moves the overlaps only, and only by widening them. */
const withoutOverlaps = (o: unknown): string => JSON.stringify(o, (k, v) => (k === 'overlaps' ? [] : v));

describe('SR-ZONES-W3 AC1.2 — an omitted venue serves exactly what BASE served (golden cases)', () => {
  it('the golden was written by BASE 87c3c335 and covers every case', () => {
    expect(GOLDEN.baseSha).toBe('87c3c335158428983102b3683a30b189661fe271');
    expect(GOLDEN.cases.map((c) => c.name)).toEqual(GOLDEN_CASES.map((c) => c.name));
  });

  it.each(GOLDEN_CASES.map((c, i) => [c.name, i] as const))('%s: same bytes (overlaps aside), same venue requests', async (_name, i) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(GOLDEN_NOW));
    const c = GOLDEN_CASES[i];
    const { deps, calls } = goldenDeps(c.tick);
    const outcome = await runGetSrZones(c.params, goldenLicense(i), deps as unknown as SrZonesDeps);
    const base = GOLDEN.cases[i];
    expect(calls).toEqual(base.calls);
    expect(withoutOverlaps(outcome)).toBe(withoutOverlaps(base.outcome));
    if (outcome.kind !== 'ok' || base.outcome.kind !== 'ok') return;
    // §0.5: every overlap BASE listed (computed edges) is still listed (served edges reach at least as far), and the
    // listed set is exactly the zones of the other timeframes that meet this one on the SERVED edges.
    const now = zonesOf(outcome.response);
    const was = zonesOf(base.outcome.response);
    now.forEach(({ timeframe, zone }, j) => {
      for (const o of was[j].zone.overlaps) expect(zone.overlaps).toContainEqual(o);
      const expected = now
        .filter((b) => b.timeframe !== timeframe && b.zone.low <= zone.high && zone.low <= b.zone.high)
        .map((b) => ({ timeframe: b.timeframe, side: b.side, rank: b.zone.rank }));
      expect(zone.overlaps).toEqual(expected);
    });
  });

  it('the golden is not vacuous: served outcomes, refusals, overlaps, and at least one case §0.5 widens', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(GOLDEN_NOW));
    expect(GOLDEN.cases.filter((c) => c.outcome.kind === 'ok').length).toBeGreaterThanOrEqual(6);
    expect(GOLDEN.cases.filter((c) => c.outcome.kind === 'refused').length).toBeGreaterThanOrEqual(2);
    let widened = 0;
    let listed = 0;
    for (const [i, c] of GOLDEN_CASES.entries()) {
      const outcome = await runGetSrZones(c.params, goldenLicense(100 + i), goldenDeps(c.tick).deps as unknown as SrZonesDeps);
      const base = GOLDEN.cases[i].outcome;
      if (outcome.kind !== 'ok' || base.kind !== 'ok') continue;
      const was = zonesOf(base.response);
      zonesOf(outcome.response).forEach(({ zone }, j) => {
        listed += zone.overlaps.length;
        widened += zone.overlaps.length - was[j].zone.overlaps.length;
      });
    }
    expect(listed).toBeGreaterThan(0);
    expect(widened).toBeGreaterThan(0);
  });
});

// ── AC1.2 — the venue follows the request ─────────────────────────────────────────────────────────────────────────────

const H1 = 3_600_000;
const NOW = Date.parse('2026-11-20T04:30:00.000Z');
/** A contiguous 1h series of `bars` candles ending with the one forming at NOW, price around `level`. */
function series1h(bars: number, level: number): Candle[] {
  const forming = Math.floor(NOW / H1) * H1;
  return Array.from({ length: bars }, (_, k) => {
    const i = bars - 1 - k;
    const close = level * (1 + 0.03 * Math.sin(i / 7) + 0.01 * Math.cos(i / 3));
    const open = level * (1 + 0.03 * Math.sin((i + 1) / 7) + 0.01 * Math.cos((i + 1) / 3));
    return { time: forming - i * H1, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, volume: 100 + (i % 9) };
  });
}

type Call = [venue: string, coin: string, tf: string, start: number, end: number | null];
/** A venue-aware fake: `series[venue][coin]` answered start-anchored, `pageBars` candles at most; anything else is HTTP 400. */
function venueDeps(series: Record<string, Record<string, Candle[]>>, over2: Partial<SrZonesDeps> = {}) {
  const calls: Call[] = [];
  const ticks: Array<[string, string]> = [];
  const deps: SrZonesDeps = {
    nowMs: () => NOW,
    cache: new Map(),
    failures: new Map(),
    getCandles: async (coin, tf, startTime, endTime, venue) => {
      calls.push([venue, coin, tf, startTime, endTime ?? null]);
      const s = series[venue]?.[coin];
      if (!s || tf !== '1h') throw new Error(`${venue} API 400: Bad Request`);
      return s.filter((c) => c.time >= startTime).slice(0, venue === 'OKX' ? 100 : 200);
    },
    getPriceTick: async (coin, venue) => {
      ticks.push([coin, venue]);
      return 0.1;
    },
    ...over2,
  };
  return { deps, calls, ticks };
}

describe('SR-ZONES-W3 AC1.2 — the cache, the memo, the reasons and the `venue` field follow the requested venue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  it('the schema enum carries the four venues, BINANCE first (the default)', () => {
    expect([...SR_ZONES_VENUES]).toEqual(['BINANCE', 'BYBIT', 'OKX', 'BITGET']);
  });

  it.each(VENUES)('%s: the response names it, every request and the tick read go to it', async (venue) => {
    const { deps, calls, ticks } = venueDeps({ [venue]: { BTC: series1h(1500, 60_000) } });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue }, keyed(), deps));
    expect(r.venue).toBe(venue);
    expect(new Set(calls.map((c) => c[0]))).toEqual(new Set([venue]));
    expect(ticks).toEqual([['BTC', venue]]);
    expect([...deps.cache.keys()]).toEqual([`${venue}:BTC:1h`]);
  });

  it('an omitted venue is BINANCE', async () => {
    const { deps, calls } = venueDeps({ BINANCE: { BTC: series1h(1500, 60_000) } });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'] }, keyed(), deps));
    expect(r.venue).toBe('BINANCE');
    expect(new Set(calls.map((c) => c[0]))).toEqual(new Set(['BINANCE']));
  });

  it('one coin on two venues is two cache entries and two reads, each priced from its own venue', async () => {
    const { deps, calls } = venueDeps({ BINANCE: { BTC: series1h(1500, 60_000) }, OKX: { BTC: series1h(1500, 61_000) } });
    const a = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue: 'BINANCE' }, keyed(), deps));
    const b = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue: 'OKX' }, keyed(), deps));
    expect(new Set(deps.cache.keys())).toEqual(new Set(['BINANCE:BTC:1h', 'OKX:BTC:1h']));
    expect(a.price).not.toBe(b.price);
    const before = calls.length;
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue: 'OKX' }, keyed(), deps));
    expect(calls.length).toBe(before); // served from the OKX entry
  });

  it('a failed read is remembered for its venue only, and the reason names that venue', async () => {
    const { deps, calls } = venueDeps({ BINANCE: { BTC: series1h(1500, 60_000) } });
    const r = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue: 'BYBIT' }, keyed(), deps));
    expect(r.status).toBe(422);
    expect(r.payload).toMatchObject({
      code: 'no_timeframe_served',
      venue: 'BYBIT',
      message: 'No requested timeframe could be served for BTC on BYBIT perpetuals.',
      unserved: [{ timeframe: '1h', reason: 'BYBIT refused the candle request for BTC (HTTP 400)' }],
    });
    expect([...deps.failures.keys()]).toEqual(['BYBIT:BTC:1h']);
    const bybitCalls = calls.length;
    refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue: 'BYBIT' }, keyed(), deps));
    expect(calls.length).toBe(bybitCalls); // the BYBIT memo answers
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue: 'BINANCE' }, keyed(), deps)); // BINANCE reads its own
    expect(calls.slice(bybitCalls).every((c) => c[0] === 'BINANCE')).toBe(true);
  });

  it('a venue the tool does not serve is refused with no request, never served from another venue', async () => {
    const { deps, calls } = venueDeps({ BINANCE: { BTC: series1h(1500, 60_000) }, HL: { BTC: series1h(1500, 60_000) } });
    for (const venue of ['HL', 'binance', 'NOPE']) {
      const r = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue }, keyed(), deps));
      expect(r.status).toBe(422);
      expect(r.payload).toMatchObject({ code: 'no_timeframe_served', unserved: [{ timeframe: '1h' }] });
    }
    expect(calls).toEqual([]);
  });

  it('the default deps read through getAdapter(<venue>): candles with endTime last, the tick in the batch class under get_sr_zones', async () => {
    const seen: unknown[] = [];
    for (const venue of VENUES) {
      fakeAdapters.set(venue, {
        getCandles: async (...args: unknown[]) => {
          seen.push([venue, ...args]);
          return [];
        },
        getPriceTick: async (coin: string) => {
          seen.push([venue, 'tick', coin, currentWeightClass(), currentCaller()]);
          return 0.5;
        },
      });
    }
    for (const venue of VENUES) {
      await DEFAULT_SR_ZONES_DEPS.getCandles('ETH', '4h', 1, 2, venue);
      expect(await runAsCaller('mcp-caller', () => DEFAULT_SR_ZONES_DEPS.getPriceTick('ETH', venue))).toBe(0.5);
    }
    // AC1.7 (R6): every candle read asks the adapter for UTC-anchored bars, the one option only this tool passes.
    expect(seen).toEqual(VENUES.flatMap((v) => [
      [v, 'ETH', '4h', 1, undefined, 2, { utcBars: true }],
      [v, 'tick', 'ETH', 'batch', processScopedTag('get_sr_zones')],
    ]));
  });
});

describe('SR-ZONES-W3 R2 — one formula on every venue', () => {
  it('the same candles give the same zones on all four venues; only `venue` differs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const s = series1h(1500, 60_000);
    const out: GetSrZonesResponse[] = [];
    for (const venue of VENUES) {
      const { deps } = venueDeps({ [venue]: { BTC: s } }, {
        getCandles: async (coin, tf, startTime) => s.filter((c) => c.time >= startTime).slice(0, 200),
      });
      _resetCallTrackersForTest();
      resetLicenseCache();
      out.push(okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['1h'], venue }, { tier: 'free', key: 'av_srz_w3_r2' }, deps)));
    }
    const strip = (r: GetSrZonesResponse) => JSON.stringify({ ...r, venue: undefined });
    expect(new Set(out.map(strip)).size).toBe(1);
    expect(out[0].results[0].support.length + out[0].results[0].resistance.length).toBeGreaterThan(0);
  });
});

// ── AC1.3 — the SR timeframes per venue: native, or built from the largest native divisor ────────────────────────────

/**
 * Requests for a timeframe the venue does not serve at its exact step: what SR must never read (R5). Judged from the
 * adapter's own served step (servedCandleStepMs), not the predicate a planted defect replaces; BINANCE serves every
 * product timeframe at its exact step.
 */
const substitutedReads = (calls: Call[]) => calls.filter(([v, , tf]) => servedCandleStepMs(v, tf) !== servedCandleStepMs('BINANCE', tf));

/** A fake that answers every timeframe from one 1h series, as BITGET's adapter answers `2h` with its 1H bars. */
function hourlyForAnyTf(venue: Venue, s: Candle[], now = () => NOW) {
  const calls: Call[] = [];
  const deps: SrZonesDeps = {
    nowMs: now,
    cache: new Map(),
    failures: new Map(),
    getCandles: async (coin, tf, startTime, endTime, v) => {
      calls.push([v, coin, tf, startTime, endTime ?? null]);
      return s.filter((c) => c.time >= startTime && c.time <= now()).slice(0, 200);
    },
    getPriceTick: async () => 0.1,
  };
  return { deps, calls };
}

describe('SR-ZONES-W3 AC1.3 — every venue serves all 8 SR timeframes: native, or built from its largest native divisor', () => {
  it('every venue serves all 8', () => {
    for (const v of VENUES) expect(srZonesTimeframes(v)).toEqual([...SR_ZONES_TIMEFRAMES]);
  });

  it('the split, derived from each adapter\'s map: built BYBIT 8h <- 4h, OKX 8h <- 4h, BITGET 2h <- 1h and 8h <- 4h', () => {
    const split = Object.fromEntries(VENUES.map((v) => [v, Object.fromEntries(SR_ZONES_TIMEFRAMES.map((tf) => {
      const plan = srZonesPlan(v, tf)!;
      return [tf, plan.k === 1 ? plan.readTf : `${plan.k}x${plan.readTf}`];
    }))]));
    const native = Object.fromEntries(SR_ZONES_TIMEFRAMES.map((tf) => [tf, tf]));
    expect(split).toEqual({
      BINANCE: native,
      BYBIT: { ...native, '8h': '2x4h' },
      OKX: { ...native, '8h': '2x4h' },
      BITGET: { ...native, '2h': '2x1h', '8h': '2x4h' },
    });
    for (const v of VENUES) for (const tf of SR_ZONES_TIMEFRAMES) {
      const plan = srZonesPlan(v, tf)!;
      expect(isTimeframeServedExactly(v, plan.readTf)).toBe(true); // SR reads only native bars
      expect(plan.readStepMs * plan.k).toBe(servedCandleStepMs('BINANCE', tf));
    }
  });

  it('the exact predicate is stricter than isTimeframeFaithful: BITGET 2h (1H) and 8h (6H) are faithful, not exact', () => {
    for (const tf of ['2h', '8h']) {
      expect(isTimeframeFaithful('BITGET', tf)).toBe(true);
      expect(isTimeframeServedExactly('BITGET', tf)).toBe(false);
    }
    expect(isTimeframeServedExactly('BITGET', '4h')).toBe(true);
    expect(isTimeframeServedExactly('BYBIT', '8h')).toBe(false); // unmapped
    expect(isTimeframeServedExactly('BINANCE', '7h')).toBe(false); // unknown timeframe
    expect(isTimeframeServedExactly('NOPE' as never, '1h')).toBe(false); // unknown venue
  });

  it('mutating the adapter\'s map moves the split: give BYBIT an 8h bar and BYBIT 8h is native', () => {
    expect(srZonesPlan('BYBIT', '8h')).toEqual({ readTf: '4h', readStepMs: 4 * H1, k: 2 });
    over.bybit8h = true;
    expect(srZonesPlan('BYBIT', '8h')).toEqual({ readTf: '8h', readStepMs: 8 * H1, k: 1 });
    over.bybit8h = false;
    over.bybitOnly = ['1m', '1h', '1d']; // 4h, 2h and 30m gone: 8h comes from 1h, four bars a bucket
    expect(srZonesPlan('BYBIT', '8h')).toEqual({ readTf: '1h', readStepMs: H1, k: 8 });
  });

  it('a timeframe with no native divisor is refused as unserved timeframe, unbilled, with no request made', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    over.bybitOnly = ['1d'];
    expect(srZonesTimeframes('BYBIT')).toEqual(['1d']);
    const { deps, calls } = venueDeps({ BYBIT: { BTC: series1h(1500, 60_000) } });
    const r = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['8h', '15m'], venue: 'BYBIT' }, keyed(), deps));
    expect(r.status).toBe(422);
    expect(r.payload).toMatchObject({
      unserved: [{ timeframe: '8h', reason: 'BYBIT does not serve this timeframe' }, { timeframe: '15m', reason: 'BYBIT does not serve this timeframe' }],
    });
    expect(calls).toEqual([]);
  });

  it('a built timeframe beside a native one: both served and billed, every request at a native step', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { deps, calls } = hourlyForAnyTf('BITGET', series1h(2600, 60_000));
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['2h', '1h'], venue: 'BITGET' }, keyed(), deps));
    expect(r.results.map((x) => x.timeframe)).toEqual(['2h', '1h']);
    expect(r.unserved).toEqual([]);
    expect(new Set(calls.map((c) => c[2]))).toEqual(new Set(['1h']));
    expect(substitutedReads(calls)).toEqual([]);
    const w = deps.cache.get('BITGET:BTC:2h')!.candles;
    expect(w).toHaveLength(1001);
    expect(w.every((c) => c.time % (2 * H1) === 0)).toBe(true);
  });

  it('a substituted interval is never read; the check is proven to catch a planted read of one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const clean = hourlyForAnyTf('BITGET', series1h(2600, 60_000));
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['2h'], venue: 'BITGET' }, keyed(), clean.deps));
    expect(substitutedReads(clean.calls)).toEqual([]);
    over.loose = true; // planted: BITGET's 1H-for-2h substitution passes as native
    const planted = hourlyForAnyTf('BITGET', series1h(2600, 60_000));
    await runGetSrZones({ coin: 'BTC', timeframes: ['2h'], venue: 'BITGET' }, keyed(), planted.deps);
    expect(substitutedReads(planted.calls).length).toBeGreaterThan(0);
    expect(planted.calls[0][2]).toBe('2h');
  });

  it('a built window older than 60 s re-reads one constituent head page and merges it', async () => {
    let now = NOW;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const s = series1h(2600, 60_000);
    const { deps, calls } = hourlyForAnyTf('BITGET', s, () => now);
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['2h'], venue: 'BITGET' }, keyed(), deps));
    const before = calls.length;
    const first = deps.cache.get('BITGET:BTC:2h')!;
    now = NOW + 61_000;
    vi.setSystemTime(new Date(now));
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['2h'], venue: 'BITGET' }, keyed(), deps));
    expect(calls.slice(before)).toEqual([['BITGET', 'BTC', '1h', now - 100 * H1, null]]);
    const w = deps.cache.get('BITGET:BTC:2h')!;
    expect(w.readAtMs).toBe(now);
    expect(w.candles.map((c) => c.time)).toEqual(first.candles.map((c) => c.time));
  });
});

// ── AC1.4 — the R0 walks: 1001 bars, zero holes; a planted wrong span is never served ────────────────────────────────

interface WalkCall { start: number; end: number | null; n: number; from: number | null; to: number | null }
interface WalkPair {
  /** The step of the bars READ (the native divisor's for a built pair). */
  servedStepMs: number;
  spanBars: number;
  wrongSpanBars?: number;
  nowMs: number;
  calls: WalkCall[];
  wrong?: WalkCall;
  series: number[][];
}
const load = (name: string): Record<Venue, Record<string, WalkPair>> => Object.fromEntries(
  VENUES.map((v) => [v, (JSON.parse(readFileSync(join(FIX, name.replace('<venue>', v.toLowerCase())), 'utf8')) as { pairs: Record<string, WalkPair> }).pairs]),
) as Record<Venue, Record<string, WalkPair>>;
/** CH0: one walk per venue × exact-step timeframe, the adapters' default tokens (OKX/BITGET 12H and 1D on Hong Kong time). */
const WALKS = load('w3-walk-btc-<venue>-20261120.json');
/** The R5/R6 addendum: `<tf><-<native>` built pairs' constituent walks and `<tf>@utc` UTC-variant walks. */
const R5R6 = load('w3-walk-btc-<venue>-r5r6-20261120.json');

const toCandle = ([time, open, high, low, close, volume]: number[]): Candle => ({ time, open, high, low, close, volume });

/** The recorded walk SR makes for one venue × SR timeframe: the built pair's, else the UTC variant's, else CH0's. */
function srWalk(v: Venue, tf: string): { p: WalkPair; readTf: string; key: string } {
  const plan = srZonesPlan(v, tf)!;
  const built = `${tf}<-${plan.readTf}`;
  if (plan.k > 1) return { p: R5R6[v][built], readTf: plan.readTf, key: built };
  if (R5R6[v][`${tf}@utc`]) return { p: R5R6[v][`${tf}@utc`], readTf: tf, key: `${tf}@utc` };
  return { p: WALKS[v][tf], readTf: tf, key: tf };
}
/** The span R0 planted as wrong: one more page than the venue returns in one call (the capture's rule when unrecorded). */
const wrongSpan = (v: Venue, p: WalkPair) => p.wrongSpanBars ?? p.spanBars + (v === 'BITGET' ? Math.max(0, 200 - p.spanBars) || 100 : 100);

/**
 * The venue's page rule as R0 P1 measured it (evidence §P1), for requests the capture did not make (a planted span's
 * later pages). The fidelity test below pins it to every recorded backward call.
 */
function modelPage(venue: Venue, tf: string, p: WalkPair, start: number): Candle[] {
  const s = p.servedStepMs;
  const bars = p.series.map(toCandle);
  if (venue === 'OKX') return bars.filter((c) => c.time >= start && c.time < start + 100 * s);
  if (venue === 'BITGET' && (tf === '12h' || tf === '1d')) {
    const reach = Math.floor((90 * 86_400_000) / s);
    return bars.filter((c) => c.time > start && c.time <= start + reach * s);
  }
  return bars.filter((c) => c.time >= start).slice(0, 200);
}

function recorded(p: WalkPair, c: WalkCall): Candle[] {
  if (c.n === 0) return [];
  return p.series.filter(([t]) => t >= c.from! && t <= c.to!).map(toCandle);
}

/** Deps that replay a recorded walk: a recorded request gets the venue's recorded answer, any other the measured rule. */
function replayDeps(venue: Venue, readTf: string, p: WalkPair) {
  const asked: Array<{ start: number; end: number | null; recorded: boolean }> = [];
  const read: Candle[] = [];
  const deps: SrZonesDeps = {
    nowMs: () => p.nowMs,
    cache: new Map(),
    failures: new Map(),
    getCandles: async (coin, t, startTime, endTime, v) => {
      if (coin !== 'BTC' || t !== readTf || v !== venue) throw new Error(`unexpected request ${v} ${coin} ${t}`);
      const hit = [...p.calls, ...(p.wrong ? [p.wrong] : [])].find((c) => c.start === startTime && c.end === (endTime ?? null));
      asked.push({ start: startTime, end: endTime ?? null, recorded: hit !== undefined });
      if (endTime === undefined && !hit) throw new Error('unrecorded serving read');
      const page = hit ? recorded(p, hit) : modelPage(venue, readTf, p, startTime);
      read.push(...page);
      return page;
    },
    getPriceTick: async () => 0.1,
  };
  return { deps, asked, read };
}

const PAIRS = VENUES.flatMap((v) => SR_ZONES_TIMEFRAMES.map((tf) => [v, tf] as const));

describe('SR-ZONES-W3 AC1.4 + AC1.7 — the R0 walks assemble 1001 bars with zero holes, all on UTC, on every venue × timeframe', () => {
  it('a recorded walk for every venue × SR timeframe: 24 CH0 walks, 4 UTC variants, 4 built pairs', () => {
    const keys = PAIRS.map(([v, tf]) => `${v} ${srWalk(v, tf).key}`);
    expect(PAIRS.length).toBe(32);
    expect(keys.filter((k) => k.includes('@utc')).sort()).toEqual(['BITGET 12h@utc', 'BITGET 1d@utc', 'OKX 12h@utc', 'OKX 1d@utc']);
    expect(keys.filter((k) => k.includes('<-')).sort()).toEqual(['BITGET 2h<-1h', 'BITGET 8h<-4h', 'BYBIT 8h<-4h', 'OKX 8h<-4h']);
    for (const [v, tf] of PAIRS) expect(srWalk(v, tf).p, `${v} ${tf}`).toBeDefined();
  });

  it.each(PAIRS)('the measured page rule reproduces every recorded backward page of %s %s (model fidelity)', (v, tf) => {
    const { p, readTf } = srWalk(v, tf);
    for (const c of [...p.calls.slice(1), ...(p.wrong ? [p.wrong] : [])]) {
      expect(modelPage(v, readTf, p, c.start).map((x) => x.time)).toEqual(recorded(p, c).map((x) => x.time));
    }
  });

  it.each(PAIRS)('%s %s: 1001 contiguous bars on UTC multiples, read on UTC multiples, the recorded requests only, served', async (v, tf) => {
    const { p, readTf } = srWalk(v, tf);
    const stepMs = servedCandleStepMs('BINANCE', tf)!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(p.nowMs));
    const { deps, asked, read } = replayDeps(v, readTf, p);
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: [tf], venue: v }, keyed(), deps));
    expect(r.venue).toBe(v);
    expect(asked.map((a) => [a.start, a.end])).toEqual(p.calls.map((c) => [c.start, c.end]));
    expect(asked.every((a) => a.recorded)).toBe(true);
    const w = deps.cache.get(`${v}:BTC:${tf}`)!.candles;
    expect(w.length).toBe(1001);
    const facts = accountPage({ bars: w.map((c) => ({ ts: c.time })), servedStepMs: stepMs, from: w[0].time, to: null, nowMs: p.nowMs });
    expect([facts.gapSlots, facts.offGridBars]).toEqual([0, 0]);
    expect(w.slice(1).every((c, i) => c.time - w[i].time === stepMs)).toBe(true);
    expect(w.filter((c) => c.time % stepMs !== 0)).toEqual([]); // AC1.7: every bar served (or built) opens on UTC
    expect(read.filter((c) => c.time % p.servedStepMs !== 0)).toEqual([]); // AC1.7: every bar read opens on UTC
  });

  it.each(PAIRS)('%s %s: a planted wrong span (more than the venue returns in one call) fails the zero-hole check', async (v, tf) => {
    const { p, readTf } = srWalk(v, tf);
    const stepMs = servedCandleStepMs('BINANCE', tf)!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(p.nowMs));
    over.span[v] = wrongSpan(v, p);
    const { deps, asked } = replayDeps(v, readTf, p);
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: [tf], venue: v }, keyed(), deps));
    if (p.wrong) expect(asked[1]).toEqual({ start: p.wrong.start, end: p.wrong.end, recorded: true }); // the venue's real answer
    const w = deps.cache.get(`${v}:BTC:${tf}`)!.candles;
    const facts = accountPage({ bars: w.map((c) => ({ ts: c.time })), servedStepMs: stepMs, from: w[0].time, to: null, nowMs: p.nowMs });
    expect(facts.gapSlots).toBeGreaterThan(0);
  });
});

// ── AC1.7 — R6: an off-UTC bar is never served ───────────────────────────────────────────────────────────────────────

describe('SR-ZONES-W3 AC1.7 — a bar off its UTC grid is refused, never served', () => {
  it.each([
    ['OKX', '12h'], ['OKX', '1d'], ['BITGET', '12h'], ['BITGET', '1d'],
  ] as const)('%s %s on the adapters\' default token (Hong Kong-anchored, recorded at CH0): refused as unserved timeframe', async (v, tf) => {
    const p = WALKS[v][tf];
    expect(p.series.every(([t]) => t % servedCandleStepMs('BINANCE', tf)! !== 0)).toBe(true); // the recording is off-UTC
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(p.nowMs));
    const { deps } = replayDeps(v, tf, p);
    const r = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: [tf], venue: v }, keyed(), deps));
    expect(r.status).toBe(422);
    expect(r.payload).toMatchObject({ unserved: [{ timeframe: tf, reason: `${v} does not serve this timeframe` }] });
    expect(deps.cache.size).toBe(0);
  });

  it('constituents off their UTC grid (BYBIT 4h shifted one hour) are refused; on the grid the same walk is served', async () => {
    const { p, readTf } = srWalk('BYBIT', '8h');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(p.nowMs));
    const on = replayDeps('BYBIT', readTf, p);
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['8h'], venue: 'BYBIT' }, keyed(), on.deps));
    const off = replayDeps('BYBIT', readTf, p);
    const read = off.deps.getCandles;
    off.deps.getCandles = async (...a) => (await read(...a)).map((c) => ({ ...c, time: c.time + H1 }));
    const r = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: ['8h'], venue: 'BYBIT' }, keyed(), off.deps));
    expect(r.payload).toMatchObject({ unserved: [{ timeframe: '8h', reason: 'BYBIT does not serve this timeframe' }] });
    expect(off.deps.cache.size).toBe(0);
  });
});
