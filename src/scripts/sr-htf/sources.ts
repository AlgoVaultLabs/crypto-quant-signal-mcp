// sr-htf/sources.ts — EDGE-SR-HTF-LEVELS-W1: the two new level sources, pure.
//
//   htf    zone rule Z1 (sr-backtest/zones.ts `zoneSetOf`, level v0 unchanged) on the 1d bars and on 1w bars, both as
//          of the instant. A 1w bar is a complete UTC-Monday week aggregated from the venue's 1d bars (open first,
//          high max, low min, close last, volume sum); Z1 reads the last `weekMaxBars` complete weeks and the source
//          is undefined below `weekMinBars`. The source's zones are the union: every 1w zone, and every 1d zone that
//          overlaps no 1w zone — a 1d zone overlapping a 1w zone is served once, as the 1w zone.
//   vpoc   the point of control of each of the last `pocDays` complete UTC days: each of the day's 24 1h bars has its
//          volume spread evenly over [low, high] into bins `pocBinAtr` x ATR14(1d, as of that day's close) wide; the
//          bins are centred on the day's range midpoint (a mirror-symmetric grid), and the POC is the centre of the
//          fullest bin (a tie goes to the lower price). The lines become zones through `linesToSet`, the line
//          sources' helper (engine.ts): each 0.25 ATR14 of the cell's timeframe wide, overlapping ones merged.
//
// Both are read in a cell (1h, 4h) whose own ATR14 is the distance and label unit, as the line sources are. Only
// bars closed by the instant are read: a week still open and the day in progress are not seen.
import { asOfBars, wilderAtr, type Bar } from '../sr-probe/level-v0.js';
import { BT, DAY, type BtParams, type Timeframe } from '../sr-backtest/spec.js';
import { linesToSet } from '../sr-backtest/engine.js';
import { overlaps, zoneSetAsOf, zoneSetOf, type Zone, type ZoneSet } from '../sr-backtest/zones.js';
import { HP, WEEK, type HtfParams } from './config.js';
import type { Provider, SourceCtx } from './registry.js';

/** A bar with the venue's volume (store version 2); absent in a version-1 store. */
export interface VBar extends Bar {
  volume?: number;
}

const HOUR = 3_600_000;

/** Monday 00:00 UTC of the week holding `t` (1970-01-01, day 0, was a Thursday). */
export const weekStartOf = (t: number): number => {
  const d = Math.floor(t / DAY);
  return (d - ((d + 3) % 7)) * DAY;
};

/** One bar from consecutive bars: open first, high max, low min, close last, volume summed (absent if any is). */
function combine(time: number, bars: readonly VBar[]): VBar {
  let high = -Infinity;
  let low = Infinity;
  let volume: number | undefined = 0;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume = volume !== undefined && Number.isFinite(b.volume) ? volume + (b.volume as number) : undefined;
  }
  const out: VBar = { time, open: bars[0].open, high, low, close: bars[bars.length - 1].close };
  if (volume !== undefined) out.volume = volume;
  return out;
}

/** Every complete UTC-Monday week of an ascending daily series, in order. A week with any of its seven days
 *  missing is no week. */
export function weeklyBars(daily: readonly VBar[]): VBar[] {
  const out: VBar[] = [];
  let i = 0;
  while (i < daily.length) {
    const ws = weekStartOf(daily[i].time);
    let j = i;
    while (j < daily.length && weekStartOf(daily[j].time) === ws) j++;
    const days = daily.slice(i, j);
    if (days.length === 7 && days.every((b, k) => b.time === ws + k * DAY)) out.push(combine(ws, days));
    i = j;
  }
  return out;
}

/** The 1w bars Z1 reads as of `t`: the complete weeks closed by then, the last `weekMaxBars` of them. */
export function weeksAsOf(daily: readonly VBar[], weekly: readonly VBar[], t: number, p: BtParams = BT, hp: HtfParams = HP): VBar[] {
  const weeks: VBar[] = asOfBars(weekly, WEEK, t, { ...p.v0, lookbackBars: hp.weekMaxBars });
  if (hp.openWeek) {
    // Test-only: the week in progress, from the days closed so far — the rule this source must never follow.
    const ws = weekStartOf(t);
    const open = asOfBars(daily, DAY, t, p.v0).filter((b) => b.time >= ws);
    if (open.length > 0) weeks.push(combine(ws, open));
  }
  return weeks;
}

/** The htf source's zones as of `t`, or null when it is undefined there (no ATR on either layer, or fewer than
 *  `weekMinBars` complete weeks). Ascending and pairwise disjoint. */
export function htfZones(daily: readonly VBar[], weekly: readonly VBar[], t: number, p: BtParams = BT, hp: HtfParams = HP): Zone[] | null {
  const d = zoneSetAsOf(daily, DAY, t, p);
  const weeks = weeksAsOf(daily, weekly, t, p, hp);
  if (d.atr === null || weeks.length < hp.weekMinBars) return null;
  const w = zoneSetOf(weeks, p);
  if (w.atr === null) return null;
  return unionZones(d.zones, w.zones);
}

/** Every 1w zone, and every 1d zone that overlaps none of them; ascending. */
export function unionZones(daily: readonly Zone[], weekly: readonly Zone[]): Zone[] {
  const kept = daily.filter((z) => !weekly.some((w) => overlaps(z, w)));
  return [...weekly, ...kept].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
}

/** The point of control of one day's bars, bins `w` wide centred on the range midpoint; null for no bar, no
 *  positive width, a volume that is not a finite non-negative number, or no volume at all. A tie: the lower price. */
export function pocOf(bars: readonly VBar[], w: number): number | null {
  if (bars.length === 0 || !(w > 0) || !Number.isFinite(w)) return null;
  let lo = Infinity;
  let hi = -Infinity;
  let total = 0;
  for (const b of bars) {
    const v = b.volume;
    if (v === undefined || !Number.isFinite(v) || v < 0) return null;
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
    total += v;
  }
  if (!(total > 0)) return null;
  const mid = (lo + hi) / 2;
  const binOf = (x: number): number => Math.floor((x - mid) / w + 0.5);
  const j0 = binOf(lo);
  const vol = new Array<number>(binOf(hi) - j0 + 1).fill(0);
  for (const b of bars) {
    const v = b.volume as number;
    if (b.high > b.low) {
      for (let j = binOf(b.low); j <= binOf(b.high); j++) {
        const overlap = Math.min(b.high, mid + (j + 0.5) * w) - Math.max(b.low, mid + (j - 0.5) * w);
        if (overlap > 0) vol[j - j0] += (v * overlap) / (b.high - b.low);
      }
    } else vol[binOf(b.low) - j0] += v;
  }
  let best = 0;
  for (let k = 1; k < vol.length; k++) if (vol[k] > vol[best]) best = k; // strictly fuller: a tie keeps the lower bin
  return mid + (best + j0) * w;
}

/** The POC of UTC day `day` (an index: ms / DAY) from its 24 1h bars, bins `pocBinAtr` x ATR14 of the daily bars
 *  closed at the day's end; null when a bar of the day or the ATR is missing. */
export function dayPoc(h1: readonly VBar[], daily: readonly VBar[], day: number, p: BtParams = BT, hp: HtfParams = HP): number | null {
  if (h1.length === 0) return null;
  const t0 = day * DAY;
  const i0 = (t0 - h1[0].time) / HOUR;
  if (!Number.isInteger(i0) || i0 < 0 || i0 + 24 > h1.length) return null;
  const bars = h1.slice(i0, i0 + 24);
  if (!bars.every((b, k) => b.time === t0 + k * HOUR)) return null;
  const atr = wilderAtr(asOfBars(daily, DAY, t0 + DAY, p.v0), p.v0.atrPeriod);
  if (atr === null || !(atr > 0)) return null;
  return pocOf(bars, hp.pocBinAtr * atr);
}

/** The POC lines in force at `t`: the last `pocDays` complete UTC days before the day holding `t`. Null when any
 *  of them has no POC. */
export function pocLines(t: number, pocAt: (day: number) => number | null, hp: HtfParams = HP): number[] | null {
  const today = Math.floor(t / DAY);
  const last = hp.pocCurrentDay ? today : today - 1; // test-only: `pocCurrentDay` reads the day in progress
  const lines: number[] = [];
  for (let d = last - hp.pocDays + 1; d <= last; d++) {
    const x = pocAt(d);
    if (x === null) return null;
    lines.push(x);
  }
  return lines;
}

/** One cache per (provider, coin context): two providers with different parameters never share a cell. */
function cacheOf<T>(store: WeakMap<SourceCtx, Map<string, T>>, ctx: SourceCtx): Map<string, T> {
  let m = store.get(ctx);
  if (!m) {
    m = new Map();
    store.set(ctx, m);
  }
  return m;
}

/** The htf source as a registry provider. Its zones change only when a daily bar closes, so they are cached per
 *  number of closed daily bars; the cell's ATR comes from the cell's own Z1 set (cached by the context). */
export function htfProvider(hp: HtfParams = HP): Provider {
  const zonesBy = new WeakMap<SourceCtx, Map<string, Zone[] | null>>();
  const weeklyBy = new WeakMap<SourceCtx, Map<string, VBar[]>>();
  return (ctx: SourceCtx, tf: Timeframe, t: number): ZoneSet => {
    const daily = ctx.data.frames['1d'] as readonly VBar[];
    const own = ctx.z1(tf, t);
    const closed = Math.floor((t - daily[0].time) / DAY);
    const zones = cacheOf(zonesBy, ctx);
    let z = zones.get(String(closed));
    if (z === undefined) {
      const weeks = cacheOf(weeklyBy, ctx);
      let weekly = weeks.get('all');
      if (!weekly) {
        weekly = weeklyBars(daily);
        weeks.set('all', weekly);
      }
      z = htfZones(daily, weekly, t, ctx.p, hp);
      zones.set(String(closed), z);
    }
    return z === null ? { atr: null, zones: [] } : { atr: own.atr, zones: z };
  };
}

/** The vpoc source as a registry provider: POCs cached per day, the lines per instant's day. */
export function vpocProvider(hp: HtfParams = HP): Provider {
  const pocBy = new WeakMap<SourceCtx, Map<string, number | null>>();
  const linesBy = new WeakMap<SourceCtx, Map<string, number[] | null>>();
  return (ctx: SourceCtx, tf: Timeframe, t: number): ZoneSet => {
    const h1 = ctx.data.frames['1h'] as readonly VBar[];
    const daily = ctx.data.frames['1d'] as readonly VBar[];
    const own = ctx.z1(tf, t);
    const lines = cacheOf(linesBy, ctx);
    const key = String(Math.floor(t / DAY));
    let l = lines.get(key);
    if (l === undefined) {
      const pocs = cacheOf(pocBy, ctx);
      l = pocLines(t, (d) => {
        let x = pocs.get(String(d));
        if (x === undefined) {
          x = dayPoc(h1, daily, d, ctx.p, hp);
          pocs.set(String(d), x);
        }
        return x;
      }, hp);
      lines.set(key, l);
    }
    return l === null ? { atr: null, zones: [] } : linesToSet(l, own.atr, ctx.p);
  };
}

/** The two sources of this study, under their keys. */
export const HTF_SOURCES: ReadonlyArray<readonly [string, Provider]> = Object.freeze([
  ['htf', htfProvider()] as const,
  ['vpoc', vpocProvider()] as const,
]);
