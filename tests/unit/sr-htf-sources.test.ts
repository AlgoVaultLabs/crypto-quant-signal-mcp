// EDGE-SR-HTF-LEVELS-W1 CH1 — the two new level sources (src/scripts/sr-htf/sources.ts): known answers for the
// weekly aggregation, the union / dedupe rule, the POC (a tie included) and lines -> zones (AC1.1); the mirror
// p -> K - p on fixtures and on 200 seeded walks, zones and outcomes (AC1.2); and the mutations that must turn red:
// a weekly bar that includes the unfinished week, a POC that reads the current day, a control that ignores
// disjointness (AC1.3).
import { describe, expect, it } from 'vitest';
import { BT, DAY, M15, controlWindow, tfOf, type BtParams, type Timeframe } from '../../src/scripts/sr-backtest/spec.js';
import { Tally, idxAt, linesToSet, placeControl, priceAt, resolveZone, type CoinData } from '../../src/scripts/sr-backtest/engine.js';
import { overlaps, servedOf, type Side, type Zone } from '../../src/scripts/sr-backtest/zones.js';
import { HP, type HtfParams } from '../../src/scripts/sr-htf/config.js';
import { runRegistry, sourceCtx, type Provider, type SourceCtx, type SourceEvent } from '../../src/scripts/sr-htf/registry.js';
import {
  HTF_SOURCES, dayPoc, htfProvider, htfZones, pocLines, pocOf, unionZones, vpocProvider, weekStartOf, weeklyBars, weeksAsOf, type VBar,
} from '../../src/scripts/sr-htf/sources.js';
import { synthVCoin } from '../../src/scripts/sr-htf/synthv.js';

const H = 3_600_000;
const z = (lo: number, hi: number, touches = 2): Zone => ({ lo, hi, level: (lo + hi) / 2, touches, label: 'WEAK', round: false, rawLo: lo, rawHi: hi });
const span = (zs: readonly Zone[] | null): number[][] | null => (zs === null ? null : zs.map((x) => [x.lo, x.hi]));
const mirrorBars = (bars: readonly VBar[], k: number): VBar[] => bars.map((b) => ({ ...b, open: k - b.open, high: k - b.low, low: k - b.high, close: k - b.close }));
const mirrorCoin = (c: CoinData, k: number): CoinData => ({ coin: c.coin, frames: Object.fromEntries(Object.entries(c.frames).map(([key, bars]) => [key, mirrorBars(bars, k)])) });
/** The bars of every frame closed by `t`: what a reader at `t` may see. */
const cutAt = (c: CoinData, t: number): CoinData => ({
  coin: c.coin, frames: Object.fromEntries(Object.entries(c.frames).map(([key, bars]) => [key, bars.filter((b) => b.time + tfOf(key).stepMs <= t)])),
});

/** Daily bars from 2021-01-01 (a Friday): bar i opens 100 + i, closes 101 + i, high 110 + i + 5 (i mod 3), low
 *  90 + i − 3 (i mod 4), volume 10 + i. */
function dailyFixture(days: number, skip: number[] = []): VBar[] {
  const out: VBar[] = [];
  for (let i = 0; i < days; i++) {
    if (skip.includes(i)) continue;
    out.push({ time: Date.UTC(2021, 0, 1) + i * DAY, open: 100 + i, high: 110 + i + (i % 3) * 5, low: 90 + i - (i % 4) * 3, close: 101 + i, volume: 10 + i });
  }
  return out;
}

// ── AC1.1: known answers ────────────────────────────────────────────────────────────────────────────────────────
describe('the weekly aggregation', () => {
  it('starts every week on the Monday 00:00 UTC that holds the instant', () => {
    expect(weekStartOf(Date.UTC(2021, 0, 4))).toBe(Date.UTC(2021, 0, 4));
    expect(weekStartOf(Date.UTC(2021, 0, 10, 23, 59))).toBe(Date.UTC(2021, 0, 4));
    expect(weekStartOf(Date.UTC(2020, 11, 31, 12))).toBe(Date.UTC(2020, 11, 28));
    expect(weekStartOf(0)).toBe(-3 * DAY);
  });

  it('aggregates complete UTC-Monday weeks only: open first, high max, low min, close last, volume summed', () => {
    // 2021-01-01 … 01-24 without 01-13: the partial first week and the week missing a day are no weeks.
    expect(weeklyBars(dailyFixture(24, [12]))).toEqual([
      { time: Date.UTC(2021, 0, 4), open: 103, high: 128, low: 84, close: 110, volume: 112 },
      { time: Date.UTC(2021, 0, 18), open: 117, high: 143, low: 100, close: 124, volume: 210 },
    ]);
    // A day without volume leaves its week without volume (a version-1 store has none).
    const noVol = dailyFixture(24).map((b, i) => (i === 5 ? { ...b, volume: undefined } : b));
    expect(weeklyBars(noVol)[0]).toEqual({ time: Date.UTC(2021, 0, 4), open: 103, high: 128, low: 84, close: 110 });
    expect(weeklyBars(noVol)[1].volume).toBe(161);
  });

  it('reads the complete weeks closed by the instant, never the week in progress', () => {
    const daily = dailyFixture(90);
    const weekly = weeklyBars(daily);
    const thursday = Date.UTC(2021, 1, 11, 12);
    const weeks = [Date.UTC(2021, 0, 4), Date.UTC(2021, 0, 11), Date.UTC(2021, 0, 18), Date.UTC(2021, 0, 25), Date.UTC(2021, 1, 1)];
    expect(weeksAsOf(daily, weekly, thursday).map((w) => w.time)).toEqual(weeks);
    // On the Monday it closes, the week of 02-08 is complete and read.
    expect(weeksAsOf(daily, weekly, Date.UTC(2021, 1, 15)).map((w) => w.time)).toEqual([...weeks, Date.UTC(2021, 1, 8)]);
    expect(weeksAsOf(daily, weekly, Date.UTC(2021, 1, 15) - 1).map((w) => w.time)).toEqual(weeks);
    // The last `weekMaxBars` only.
    expect(weeksAsOf(daily, weekly, thursday, BT, { ...HP, weekMaxBars: 2 }).map((w) => w.time)).toEqual(weeks.slice(-2));
  });
});

describe('the union of the 1d and 1w zones', () => {
  it('serves every 1w zone, and a 1d zone only when it overlaps no 1w zone (edge on edge overlaps)', () => {
    const daily = [z(100, 104), z(108, 109), z(110, 112), z(130, 131)];
    const weekly = [z(103, 108), z(120, 125)];
    expect(span(unionZones(daily, weekly))).toEqual([[103, 108], [110, 112], [120, 125], [130, 131]]);
    expect(unionZones(daily, weekly)[0]).toBe(weekly[0]);
    expect(span(unionZones(daily, []))).toEqual(span(daily));
    expect(span(unionZones([], weekly))).toEqual(span(weekly));
  });

  it('is the 1d set and the 1w set of zone rule Z1, each as of the instant', () => {
    const daily = dailyFixture(400);
    const weekly = weeklyBars(daily);
    const t = Date.UTC(2021, 11, 9, 7);
    const zones = htfZones(daily, weekly, t);
    expect(zones).not.toBeNull();
    for (let i = 1; i < zones!.length; i++) expect(zones![i].lo > zones![i - 1].hi, 'ascending and disjoint').toBe(true);
    // Fewer than 30 complete weeks: the source is undefined.
    expect(htfZones(daily, weekly, Date.UTC(2021, 6, 26))).toBeNull();
    expect(htfZones(daily, weekly, Date.UTC(2021, 7, 2))).not.toBeNull();
  });
});

describe('the point of control', () => {
  it('spreads each bar evenly over its range into bins centred on the range midpoint', () => {
    // mid 105, bins 2 wide: A gives every bin it covers 2; B puts all 30 in the bin [104, 106].
    expect(pocOf([{ time: 0, open: 100, high: 110, low: 100, close: 110, volume: 10 }, { time: H, open: 104, high: 106, low: 104, close: 106, volume: 30 }], 2)).toBe(105);
    // A bar with no range puts its volume in its own bin.
    expect(pocOf([{ time: 0, open: 100, high: 110, low: 100, close: 110, volume: 10 }, { time: H, open: 103, high: 103, low: 103, close: 103, volume: 50 }], 2)).toBe(103);
    expect(pocOf([{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 5 }], 2)).toBe(100);
  });

  it('breaks a tie toward the lower price — the one place the mirror does not hold', () => {
    const bars: VBar[] = [{ time: 0, open: 100, high: 102, low: 100, close: 102, volume: 10 }, { time: H, open: 104, high: 106, low: 104, close: 106, volume: 10 }];
    expect(pocOf(bars, 2)).toBe(101);
    expect(pocOf(mirrorBars(bars, 300), 2)).toBe(195);
    expect(300 - pocOf(bars, 2)!).toBe(199);
  });

  it('has no POC without bars, without a positive width, or without a finite non-negative volume', () => {
    const b: VBar = { time: 0, open: 100, high: 110, low: 100, close: 110, volume: 10 };
    expect(pocOf([], 2)).toBeNull();
    expect(pocOf([b], 0)).toBeNull();
    expect(pocOf([b], Number.NaN)).toBeNull();
    expect(pocOf([{ ...b, volume: undefined }], 2)).toBeNull();
    expect(pocOf([{ ...b, volume: 0 }], 2)).toBeNull();
    expect(pocOf([b, { ...b, volume: -1 }], 2)).toBeNull();
  });

  it('builds one day from its 24 hourly bars, bins a quarter of the daily ATR14 as of that day\'s close', () => {
    // Sixteen daily bars [980, 1020] closing at 1000: ATR14 40, bins 10 wide.
    const day = Date.UTC(2021, 2, 1) / DAY;
    const daily: VBar[] = Array.from({ length: 16 }, (_, k) => ({ time: (day - 15 + k) * DAY, open: 1000, high: 1020, low: 980, close: 1000 }));
    const h1: VBar[] = Array.from({ length: 48 }, (_, k) => ({ time: (day - 1) * DAY + k * H, open: 1000, high: 1005, low: 995, close: 1000, volume: 1 }));
    h1[24 + 7] = { ...h1[24 + 7], high: 1040, low: 1030, volume: 100 };
    // mid 1017.5: the 23 quiet bars put 0.75 each in the bin at 997.5; the loud one puts 75 in the bin at 1037.5.
    expect(dayPoc(h1, daily, day)).toBe(1037.5);
    expect(dayPoc(h1, daily, day - 1)).toBe(1000);
    expect(dayPoc(h1.filter((_, k) => k !== 30), daily, day)).toBeNull(); // a missing hour
    expect(dayPoc(h1, daily, day + 1)).toBeNull(); // no bar of that day
    expect(dayPoc(h1, daily.slice(0, 14), day)).toBeNull(); // no ATR14 by that day's close
  });

  it('serves the POCs of the last 20 complete UTC days, never the day in progress', () => {
    const d = 18_700;
    const t = d * DAY + 5 * H;
    expect(pocLines(t, (x) => x)).toEqual(Array.from({ length: 20 }, (_, i) => d - 20 + i));
    expect(pocLines(d * DAY, (x) => x)).toEqual(Array.from({ length: 20 }, (_, i) => d - 20 + i));
    expect(pocLines(t, (x) => (x === d - 3 ? null : x))).toBeNull();
    expect(pocLines(t, (x) => x, { ...HP, pocCurrentDay: true })).not.toEqual(pocLines(t, (x) => x));
  });
});

describe('lines -> zones', () => {
  it('makes each line a zone a quarter of the cell\'s ATR14 wide and merges the ones that overlap', () => {
    const set = linesToSet([200, 101, 100], 8);
    expect(set.zones.map((x) => [x.lo, x.hi, x.touches, x.level])).toEqual([[99, 102, 2, 100.5], [199, 201, 1, 200]]);
    expect(linesToSet([100], null)).toEqual({ atr: null, zones: [] });
  });
});

// ── seeded walks with volume ────────────────────────────────────────────────────────────────────────────────────
const K = 10_000_000;
const F0 = Date.UTC(2021, 0, 4); // a Monday
const WARM_DAYS = 230;
const START = F0 + WARM_DAYS * DAY;
const EVAL = { '1h': 10, '4h': 15 };
const WALK_DAYS = WARM_DAYS + EVAL['4h'] + 1 + 24;
const CELLS: Timeframe[] = [tfOf('1h'), tfOf('4h')];
const walkOf = (i: number, days = WALK_DAYS): CoinData =>
  synthVCoin(`M${i}`, { seed: 20261113, key: `mirror|${i}`, firstMs: F0, bars: days * 96, startPrice: K / 2 });
/** An instant late in walk i, at a seeded position of its day. */
const instantOf = (i: number): number => START + (i % 7) * DAY + ((i * 37) % 96) * M15;

function reflected(a: readonly Zone[] | null, b: readonly Zone[] | null, k: number): boolean {
  if (a === null || b === null) return a === b;
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-6;
  return a.length === b.length && a.every((x, i) => {
    const y = b[b.length - 1 - i];
    return near(y.lo, k - x.hi) && near(y.hi, k - x.lo) && y.touches === x.touches && y.label === x.label;
  });
}

describe('the mirror p -> K - p (AC1.2)', () => {
  it('holds on the fixtures: weekly bars, the union and the POC reflect', () => {
    const daily = dailyFixture(24, [12]);
    expect(weeklyBars(mirrorBars(daily, 1000))).toEqual(mirrorBars(weeklyBars(daily), 1000));
    const bars: VBar[] = [{ time: 0, open: 100, high: 110, low: 100, close: 110, volume: 10 }, { time: H, open: 104, high: 106, low: 104, close: 106, volume: 30 }];
    expect(pocOf(mirrorBars(bars, 300), 2)).toBe(300 - 105);
    const mz = (zs: Zone[]): Zone[] => zs.map((x) => z(1000 - x.hi, 1000 - x.lo, x.touches)).reverse();
    const daily2 = [z(100, 104), z(110, 112), z(130, 131)];
    const weekly2 = [z(103, 108), z(120, 125)];
    expect(span(unionZones(mz(daily2), mz(weekly2)))).toEqual(span(mz(unionZones(daily2, weekly2))));
  });

  it('holds on 200 seeded walks: htf zones and vpoc lines reflect, supports become resistances', { timeout: 300_000 }, () => {
    let served = 0;
    for (let i = 0; i < 200; i++) {
      const a = walkOf(i, WARM_DAYS + 8);
      const b = mirrorCoin(a, K);
      const t = instantOf(i);
      const za = htfZones(a.frames['1d'], weeklyBars(a.frames['1d']), t);
      const zb = htfZones(b.frames['1d'], weeklyBars(b.frames['1d']), t);
      expect(za, `walk ${i}`).not.toBeNull();
      expect(reflected(za, zb, K), `walk ${i}: htf`).toBe(true);
      const la = pocLines(t, (d) => dayPoc(a.frames['1h'], a.frames['1d'], d));
      const lb = pocLines(t, (d) => dayPoc(b.frames['1h'], b.frames['1d'], d));
      expect(la, `walk ${i}`).not.toBeNull();
      expect(la!.every((x, j) => Math.abs(lb![j] - (K - x)) <= 1e-6), `walk ${i}: vpoc`).toBe(true);
      for (const [src, provide] of HTF_SOURCES) {
        for (const tf of CELLS) {
          const pa = priceAt(a.frames['15m'], t);
          const sa = servedOf(provide(sourceCtx(a, BT), tf, t, pa), pa);
          const sb = servedOf(provide(sourceCtx(b, BT), tf, t, K - pa), K - pa);
          expect(reflected(sa.supports, [...sb.resistances].reverse(), K) && reflected(sa.resistances, [...sb.supports].reverse(), K), `walk ${i} ${src} ${tf.key}`).toBe(true);
          served += sa.supports.length + sa.resistances.length;
        }
      }
    }
    expect(served).toBeGreaterThan(2000);
  });

  it('holds on whole runs of 200 seeded walks: every count unchanged, the sides swapped', { timeout: 600_000 }, () => {
    let asymmetric = 0;
    let entered = 0;
    for (let i = 0; i < 200; i++) {
      const data = walkOf(i);
      const run = (c: CoinData): Tally => {
        const tally = new Tally();
        runRegistry(c, { params: BT, startMs: START, endMs: F0 + WALK_DAYS * DAY, evalDays: EVAL, timeframes: CELLS, sources: HTF_SOURCES, outcomes: true }, tally);
        return tally;
      };
      const a = run(data);
      const b = run(mirrorCoin(data, K));
      expect(b.csv() === a.csv(), `walk ${i}: the mirror's counts are the walk's`).toBe(true);
      expect(b.instants).toBe(a.instants);
      for (const src of ['htf', 'vpoc']) {
        const [s, r] = a.sides.get(src) ?? [0, 0];
        expect(b.sides.get(src) ?? [0, 0], `walk ${i} ${src}`).toEqual([r, s]);
        if (s !== r) asymmetric++;
      }
      for (const [id, row] of a.rows) if (id.startsWith('htf|') || id.startsWith('vpoc|')) entered += row[2] + row[5];
    }
    // Two-way: the side swap is seen, not vacuous; and outcomes were labelled, not only zones.
    expect(asymmetric).toBeGreaterThan(100);
    expect(entered).toBeGreaterThan(10_000);
  });
});

// ── AC1.3: what must turn red ───────────────────────────────────────────────────────────────────────────────────
describe('a weekly bar that includes the unfinished week', () => {
  it('turns the weeks read red', () => {
    const daily = dailyFixture(90);
    const weekly = weeklyBars(daily);
    const thursday = Date.UTC(2021, 1, 11, 12);
    const open = { ...HP, openWeek: true };
    expect(weeksAsOf(daily, weekly, thursday, BT, open).map((w) => w.time).at(-1)).toBe(Date.UTC(2021, 1, 8));
    expect(weeksAsOf(daily, weekly, thursday, BT, open).map((w) => w.time)).not.toEqual(weeksAsOf(daily, weekly, thursday).map((w) => w.time));
  });

  it('changes the served zones on seeded walks', { timeout: 120_000 }, () => {
    const open: HtfParams = { ...HP, openWeek: true };
    let changed = 0;
    for (let i = 0; i < 60; i++) {
      const a = walkOf(i, WARM_DAYS + 8);
      const weekly = weeklyBars(a.frames['1d']);
      const t = instantOf(i) + 3 * DAY; // mid-week for most walks
      if (JSON.stringify(span(htfZones(a.frames['1d'], weekly, t, BT, open))) !== JSON.stringify(span(htfZones(a.frames['1d'], weekly, t)))) changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('only bars closed by the instant are read', () => {
  /** Each source at `t` on the whole walk against the same source on the walk cut at `t`. */
  function asOfHolds(hp: HtfParams): boolean {
    for (let i = 0; i < 100; i++) {
      const a = walkOf(i, WARM_DAYS + 8);
      const t = instantOf(i);
      const c = cutAt(a, t);
      const full = [htfProvider(hp), vpocProvider(hp)].map((p) => p(sourceCtx(a, BT), tfOf('1h'), t, priceAt(a.frames['15m'], t)));
      const cut = [htfProvider(hp), vpocProvider(hp)].map((p) => p(sourceCtx(c, BT), tfOf('1h'), t, priceAt(a.frames['15m'], t)));
      if (JSON.stringify(full) !== JSON.stringify(cut)) return false;
    }
    return true;
  }

  it('holds for both sources on 100 seeded walks', { timeout: 120_000 }, () => {
    expect(asOfHolds(HP)).toBe(true);
  });

  it('turns red when the POC reads the current day', { timeout: 120_000 }, () => {
    expect(asOfHolds({ ...HP, pocCurrentDay: true })).toBe(false);
  });
});

describe('the control, on seeded walks', () => {
  /** The registered rule, derived again: the served zone at the instant, then the candidates j = 13 … 108 bars later
   *  in time order, the first whose re-laid zone overlaps none of the source's zones there, else the last, flagged. */
  function expected(ctx: SourceCtx, provide: Provider, e: SourceEvent): { t2: number; forced: boolean; s: unknown; c: unknown } | null {
    const tf = tfOf(e.tf);
    const base = ctx.data.frames['15m'];
    const price = priceAt(base, e.t);
    const set = provide(ctx, tf, e.t, price);
    const served = servedOf(set, price);
    const zone = (e.side === 'support' ? served.supports : served.resistances)[e.rank - 1];
    let last: { t2: number; forced: boolean; zone: { lo: number; hi: number }; atr2: number } | null = null;
    for (let j = BT.controlLagBars + 1; j <= BT.controlLagBars + controlWindow(tf); j++) {
      const t2 = e.t + j * tf.stepMs;
      const price2 = priceAt(base, t2);
      const set2 = provide(ctx, tf, t2, price2);
      if (!(set2.atr! > 0)) continue;
      const placed = placeControl(zone, e.side as Side, price, set.atr!, price2, set2.atr!);
      const free = !set2.zones.some((x) => overlaps(placed, x));
      last = { t2, forced: !free, zone: placed, atr2: set2.atr! };
      if (free) break;
    }
    if (!last) return null;
    return {
      t2: last.t2, forced: last.forced, s: resolveZone(base, idxAt(base, e.t), zone, e.side as Side, set.atr!, tf),
      c: resolveZone(base, idxAt(base, last.t2), last.zone, e.side as Side, last.atr2, tf),
    };
  }

  function controlsFollowTheRule(p: BtParams): { ok: boolean; events: number; forced: number } {
    let ok = true;
    let events = 0;
    let forced = 0;
    for (let i = 0; i < 6; i++) {
      const data = walkOf(100 + i, WARM_DAYS + 30 + 25);
      const ctx = sourceCtx(data, BT);
      const got: SourceEvent[] = [];
      runRegistry(data, { params: p, startMs: START, endMs: START + 55 * DAY, evalDays: { '1h': 30, '4h': 30 }, timeframes: CELLS, sources: HTF_SOURCES, outcomes: true, onEvent: (e) => got.push(e) }, new Tally());
      for (const e of got) {
        const provide = HTF_SOURCES.find(([k]) => k === e.src)![1];
        const want = expected(ctx, provide, e);
        events++;
        if (e.forced) forced++;
        if (!want || want.t2 !== e.t2 || want.forced !== e.forced || JSON.stringify(want.s) !== JSON.stringify(e.s) || JSON.stringify(want.c) !== JSON.stringify(e.c)) ok = false;
      }
    }
    return { ok, events, forced };
  }

  it('is the first disjoint candidate in time order — or the last one, flagged — with each arm labelled on its own path', { timeout: 300_000 }, () => {
    const r = controlsFollowTheRule(BT);
    expect(r.ok).toBe(true);
    expect(r.events).toBeGreaterThan(500);
    expect(r.forced).toBeGreaterThan(0);
  });

  it('turns red when the control ignores disjointness', { timeout: 300_000 }, () => {
    expect(controlsFollowTheRule({ ...BT, controlDisjoint: false }).ok).toBe(false);
  });
});
