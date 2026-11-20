/**
 * SR-ZONES-W3 CH1 — get_support_resistance_zones on BINANCE (default), BYBIT, OKX and BITGET, one frozen formula.
 *
 *   AC1.2  `venue` per §0.1: an omitted venue is byte-identical to BASE (87c3c335) on the golden cases; the cache, the
 *          failed-read memo, the unserved reasons and the `venue` field follow the requested venue.
 *   AC1.3  §0.2: a venue's SR timeframes are the SR_ZONES_TIMEFRAMES its adapter serves at exactly the requested step,
 *          derived from the served-interval registry (no list in the handler); a substituted or unmapped timeframe is
 *          refused as unserved `timeframe` with no request made (R5).
 *   AC1.4  §0.3: on the R0 P1 walks (tests/fixtures/sr-zones/w3-walk-btc-<venue>-20261120.json, captured live through the
 *          BASE adapters) every venue × timeframe assembles 1001 bars with zero holes, asking exactly the recorded pages;
 *          a planted wrong page span (one the venue does not return in one call) is proven to fail that zero-hole check.
 *   R2     one formula: the same candles give the same zones on every venue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { fakeAdapters, over } = vi.hoisted(() => ({
  fakeAdapters: new Map<string, Record<string, unknown>>(),
  over: { bybit8h: false, span: {} as Record<string, number | undefined> },
}));
vi.mock('../../src/lib/exchange-adapter.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
  getAdapter: (id: string) => fakeAdapters.get(id) ?? {},
}));
// AC1.3: a test can give BYBIT an 8h bar; AC1.4: a test can plant a wrong page span on any venue. Both read at call time.
vi.mock('../../src/lib/adapters/bybit.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/adapters/bybit.js')>();
  return {
    ...m,
    servedIntervalMs: (tf: string) => (over.bybit8h && tf === '8h' ? 28_800_000 : m.servedIntervalMs(tf)),
    historyPageBars: (tf: string) => over.span.BYBIT ?? m.historyPageBars(tf),
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
  runGetSrZones, srZonesTimeframes, DEFAULT_SR_ZONES_DEPS,
  type SrZonesDeps, type GetSrZonesOutcome, type GetSrZonesResponse,
} from '../../src/tools/get-sr-zones.js';
import { SR_ZONES_TIMEFRAMES, SR_ZONES_VENUES } from '../../src/lib/tool-param-schema.js';
import { isTimeframeFaithful, isTimeframeServedExactly } from '../../src/lib/tf-support.js';
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
    expect(seen).toEqual(VENUES.flatMap((v) => [[v, 'ETH', '4h', 1, undefined, 2], [v, 'tick', 'ETH', 'batch', processScopedTag('get_sr_zones')]]));
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

// ── AC1.3 — the SR timeframes per venue, from the served-interval registry ────────────────────────────────────────────

describe('SR-ZONES-W3 AC1.3 — a venue serves the SR timeframes its adapter serves at exactly the requested step', () => {
  it('BINANCE 8, BYBIT 7 (no 8h), OKX 7 (no 8h), BITGET 6 (no 2h, no 8h)', () => {
    expect(srZonesTimeframes('BINANCE')).toEqual(['15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d']);
    expect(srZonesTimeframes('BYBIT')).toEqual(['15m', '30m', '1h', '2h', '4h', '12h', '1d']);
    expect(srZonesTimeframes('OKX')).toEqual(['15m', '30m', '1h', '2h', '4h', '12h', '1d']);
    expect(srZonesTimeframes('BITGET')).toEqual(['15m', '30m', '1h', '4h', '12h', '1d']);
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

  it('the set is derived from the adapter\'s served map: give BYBIT an 8h bar and BYBIT serves 8h', () => {
    expect(srZonesTimeframes('BYBIT')).not.toContain('8h');
    over.bybit8h = true;
    expect(srZonesTimeframes('BYBIT')).toEqual([...SR_ZONES_TIMEFRAMES]);
  });

  it.each([
    ['BITGET', '2h'], ['BITGET', '8h'], ['BYBIT', '8h'], ['OKX', '8h'],
  ] as const)('%s %s is refused as unserved timeframe, unbilled, with no request made (R5)', async (venue, tf) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { deps, calls } = venueDeps({ [venue]: { BTC: series1h(1500, 60_000) } });
    const r = refusalOf(await runGetSrZones({ coin: 'BTC', timeframes: [tf], venue }, keyed(), deps));
    expect(r.status).toBe(422);
    expect(r.payload).toMatchObject({ unserved: [{ timeframe: tf, reason: `${venue} does not serve this timeframe` }] });
    expect(calls).toEqual([]);
  });

  it('beside a served timeframe, the substituted one is listed unserved and the call is billed one unit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const { deps, calls } = venueDeps({ BITGET: { BTC: series1h(1500, 60_000) } });
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: ['2h', '1h'], venue: 'BITGET' }, keyed(), deps));
    expect(r.results.map((x) => x.timeframe)).toEqual(['1h']);
    expect(r.unserved).toEqual([{ timeframe: '2h', reason: 'BITGET does not serve this timeframe' }]);
    expect(calls.every((c) => c[2] === '1h')).toBe(true);
  });
});

// ── AC1.4 — the R0 P1 walks: 1001 bars, zero holes; a planted wrong span is never served ─────────────────────────────

interface WalkCall { start: number; end: number | null; n: number; from: number | null; to: number | null }
interface WalkPair {
  servedStepMs: number;
  spanBars: number;
  wrongSpanBars: number;
  nowMs: number;
  calls: WalkCall[];
  wrong: WalkCall;
  series: number[][];
}
const WALKS: Record<Venue, Record<string, WalkPair>> = Object.fromEntries(
  VENUES.map((v) => [v, (JSON.parse(readFileSync(join(FIX, `w3-walk-btc-${v.toLowerCase()}-20261120.json`), 'utf8')) as { pairs: Record<string, WalkPair> }).pairs]),
) as Record<Venue, Record<string, WalkPair>>;

const toCandle = ([time, open, high, low, close, volume]: number[]): Candle => ({ time, open, high, low, close, volume });

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
function replayDeps(venue: Venue, tf: string, p: WalkPair) {
  const asked: Array<{ start: number; end: number | null; recorded: boolean }> = [];
  const deps: SrZonesDeps = {
    nowMs: () => p.nowMs,
    cache: new Map(),
    failures: new Map(),
    getCandles: async (coin, t, startTime, endTime, v) => {
      if (coin !== 'BTC' || t !== tf || v !== venue) throw new Error(`unexpected request ${v} ${coin} ${t}`);
      const hit = [...p.calls, p.wrong].find((c) => c.start === startTime && c.end === (endTime ?? null));
      asked.push({ start: startTime, end: endTime ?? null, recorded: hit !== undefined });
      if (hit) return recorded(p, hit);
      if (endTime === undefined) throw new Error('unrecorded serving read');
      return modelPage(venue, tf, p, startTime);
    },
    getPriceTick: async () => 0.1,
  };
  return { deps, asked };
}

const PAIRS = VENUES.flatMap((v) => Object.keys(WALKS[v]).map((tf) => [v, tf] as const));

describe('SR-ZONES-W3 AC1.4 — the R0 P1 walks assemble 1001 bars with zero holes on every venue × timeframe', () => {
  it('the fixtures cover every exact SR timeframe of every venue', () => {
    for (const v of VENUES) expect(Object.keys(WALKS[v]).sort()).toEqual([...srZonesTimeframes(v)].sort());
    expect(PAIRS.length).toBe(28);
  });

  it.each(PAIRS)('the measured page rule reproduces every recorded backward page of %s %s (model fidelity)', (v, tf) => {
    const p = WALKS[v][tf];
    for (const c of [...p.calls.slice(1), p.wrong]) {
      expect(modelPage(v, tf, p, c.start).map((x) => x.time)).toEqual(recorded(p, c).map((x) => x.time));
    }
  });

  it.each(PAIRS)('%s %s: 1001 contiguous bars, the recorded requests and nothing else, served', async (v, tf) => {
    const p = WALKS[v][tf];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(p.nowMs));
    const { deps, asked } = replayDeps(v, tf, p);
    const r = okOf(await runGetSrZones({ coin: 'BTC', timeframes: [tf], venue: v }, keyed(), deps));
    expect(r.venue).toBe(v);
    expect(asked.map((a) => [a.start, a.end])).toEqual(p.calls.map((c) => [c.start, c.end]));
    expect(asked.every((a) => a.recorded)).toBe(true);
    const w = deps.cache.get(`${v}:BTC:${tf}`)!.candles;
    expect(w.length).toBe(1001);
    const facts = accountPage({ bars: w.map((c) => ({ ts: c.time })), servedStepMs: p.servedStepMs, from: w[0].time, to: null, nowMs: p.nowMs });
    expect([facts.gapSlots, facts.offGridBars]).toEqual([0, 0]);
    expect(w.slice(1).every((c, i) => c.time - w[i].time === p.servedStepMs)).toBe(true);
  });

  it.each(PAIRS)('%s %s: a planted wrong span (more than the venue returns in one call) fails the zero-hole check', async (v, tf) => {
    const p = WALKS[v][tf];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(p.nowMs));
    over.span[v] = p.wrongSpanBars;
    const { deps, asked } = replayDeps(v, tf, p);
    okOf(await runGetSrZones({ coin: 'BTC', timeframes: [tf], venue: v }, keyed(), deps));
    expect(asked[1]).toEqual({ start: p.wrong.start, end: p.wrong.end, recorded: true }); // the venue's real answer to that span
    const w = deps.cache.get(`${v}:BTC:${tf}`)!.candles;
    const facts = accountPage({ bars: w.map((c) => ({ ts: c.time })), servedStepMs: p.servedStepMs, from: w[0].time, to: null, nowMs: p.nowMs });
    expect(facts.gapSlots).toBeGreaterThan(0);
  });
});
