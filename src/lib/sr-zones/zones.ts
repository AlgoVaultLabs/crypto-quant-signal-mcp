/**
 * zones.ts — SR-ZONES-W1 §1. The support/resistance zone formula: closed candles in, zones out.
 *
 * Pure: no network, no DB, no clock. `computeSrZones(candles, t, price)` reads candles[0..t] and nothing after, so the
 * zones as of candle t are identical whether or not later candles exist (AC1.2, tests/unit/sr-zones-lookahead).
 *
 * The formula (knobs in params.ts; every ATR is ATR14 at candle t unless said otherwise):
 *  1. Turning points. A swing low/high is the extreme of the k candles on each side (strict on the left, so a run of
 *     equal lows yields its first candle), confirmed k closed candles later. A trading range is the longest run of at
 *     least m candles whose closes stay within w × ATR (ATR at the run's last candle) that cannot be extended by the
 *     next candle; it adds two turning points, its low and its high, dated at its last candle. Each turning point
 *     keeps the ONE candle that printed its price (the swing candle; the range candle with the lowest low or the
 *     highest high) — the zone edges are read from these candles.
 *  2. Ladder. Turning points are walked newest → oldest: by the date they are dated at, then by the date of the
 *     candle that printed them, then nearest to price first. Per side, the first point beyond price seeds zone 1.
 *     Each next seed is dated before the previous zone's oldest candle and sits beyond its far edge by at least
 *     seedSpacingAtr × ATR, and the zone it builds must sit strictly further from price at its near edge than the
 *     previous zone, as distance_pct states it (R6 #2: "each next zone ... sits further from price"); a seed
 *     whose zone does not is skipped and the walk goes on older. At most maxZonesPerSide zones per side.
 *  3. Members. A zone's members are the seed, the points dated with it that sit within g_r × ATR of the seed price,
 *     then the points of each older date in turn while that date has at least one point within the band: the walk
 *     stops at the first older date that has turning points but none in the band. (A cluster is a run of nearby
 *     turning points in time; with no stop, zone 1 of BTC took members from 2024 and no knob set matched the chart.)
 *  4. Edges. Over the members' candles: support = [lowest low, median body bottom]; resistance = [median body top,
 *     highest high]. A zone narrower than minWidthAtr × ATR is widened away from price.
 *  5. Facts per zone: distance from price to the near edge, the candles that formed it, touches, tests, last touch,
 *     and the flip state — see `zoneFacts` and `zoneState`.
 */
import type { Candle } from '../../types.js';
import { SR_ZONES_PARAMS } from './params.js';

const P = SR_ZONES_PARAMS;

export type SrSide = 'support' | 'resistance';
export type SrZoneState = 'intact' | 'former_support' | 'former_resistance';
export type SrZoneFlag = 'no_zone_above' | 'no_zone_below' | 'price_inside_zone';

/** One zone of ANOTHER requested timeframe whose price range intersects this zone. */
export interface SrZoneOverlap {
  timeframe: string;
  side: SrSide;
  rank: number;
}

export interface SrZone {
  rank: number;
  low: number;
  high: number;
  /** Distance from price to the zone's near edge, in percent of price (2 decimals); 0 when price is inside the zone. */
  distance_pct: number;
  /** Open time (ISO 8601, UTC) of the oldest candle that formed the zone. */
  formed_from: string;
  /** Open time (ISO 8601, UTC) of the newest candle that formed the zone. */
  formed_to: string;
  /** Turning points in the zone. */
  members: number;
  /** Closed candles among the last 90 whose range meets the zone. */
  touch_bars_90: number;
  /** Closed candles among the last 30 that entered the zone and closed back on the side the previous close was on. */
  tests_30: number;
  /** Open time of the newest closed candle whose range meets the zone. */
  last_touch: string | null;
  state: SrZoneState;
  /** Open time of the candle whose close was the second consecutive close through the zone, when state is former_*. */
  broke_at: string | null;
  overlaps: SrZoneOverlap[];
}

export interface SrZonesFrame {
  support: SrZone[];
  resistance: SrZone[];
  flags: SrZoneFlag[];
  /** The last closed candle's volume ÷ the mean volume of the 20 candles before it. */
  volume_vs_20: number | null;
}

export type SrZonesComputation = { ok: true; frame: SrZonesFrame } | { ok: false; reason: string };

interface TurningPoint {
  /** The candle the point is dated at: a swing's own candle, a range's last candle. */
  date: number;
  /** The candle whose low or high is the point's price. */
  bar: number;
  price: number;
}

interface Cluster {
  low: number;
  high: number;
  from: number;
  to: number;
  members: number;
}

/** Wilder's ATR over candles[0..t]: index i holds ATR at candle i, null until `period` candles exist. */
export function wilderAtr(candles: readonly Candle[], t: number, period: number = P.atrPeriod): Array<number | null> {
  const out: Array<number | null> = new Array(t + 1).fill(null);
  let atr = 0;
  let seedSum = 0;
  for (let i = 0; i <= t; i++) {
    const c = candles[i];
    const tr =
      i === 0
        ? c.high - c.low
        : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (i < period) {
      seedSum += tr;
      if (i === period - 1) {
        atr = seedSum / period;
        out[i] = atr;
      }
      continue;
    }
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

function swingPoints(candles: readonly Candle[], t: number): TurningPoint[] {
  const k = P.swingWindow;
  const pts: TurningPoint[] = [];
  for (let i = k; i + k <= t; i++) {
    const b = candles[i];
    let isLow = true;
    let isHigh = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const o = candles[j];
      if (j < i) {
        if (!(b.low < o.low)) isLow = false;
        if (!(b.high > o.high)) isHigh = false;
      } else {
        if (!(b.low <= o.low)) isLow = false;
        if (!(b.high >= o.high)) isHigh = false;
      }
    }
    if (isLow) pts.push({ date: i, bar: i, price: b.low });
    if (isHigh) pts.push({ date: i, bar: i, price: b.high });
  }
  return pts;
}

function rangePoints(candles: readonly Candle[], atr: ReadonlyArray<number | null>, t: number): TurningPoint[] {
  const m = P.rangeMinBars;
  const w = P.rangeCloseSpreadAtr;
  // starts[e]: the earliest start of a run ending at e whose closes stay within w × ATR[e].
  const starts: number[] = new Array(t + 1);
  for (let e = 0; e <= t; e++) {
    const a = atr[e];
    let s = e;
    if (a !== null) {
      let mx = candles[e].close;
      let mn = mx;
      while (s - 1 >= 0) {
        const c = candles[s - 1].close;
        const nmx = Math.max(mx, c);
        const nmn = Math.min(mn, c);
        if (nmx - nmn > w * a) break;
        mx = nmx;
        mn = nmn;
        s--;
      }
    }
    starts[e] = s;
  }
  const pts: TurningPoint[] = [];
  for (let e = 0; e <= t; e++) {
    const s = starts[e];
    if (e - s + 1 < m) continue;
    // Keep only a run the next closed candle cannot extend (the run ending at t is kept: nothing after t is read).
    const next = e < t ? atr[e + 1] : null;
    if (next !== null) {
      let mx = -Infinity;
      let mn = Infinity;
      for (let j = s; j <= e + 1; j++) {
        mx = Math.max(mx, candles[j].close);
        mn = Math.min(mn, candles[j].close);
      }
      if (mx - mn <= w * next) continue;
    }
    let lo = Infinity;
    let hi = -Infinity;
    let loAt = s;
    let hiAt = s;
    for (let j = s; j <= e; j++) {
      if (candles[j].low < lo) {
        lo = candles[j].low;
        loAt = j;
      }
      if (candles[j].high > hi) {
        hi = candles[j].high;
        hiAt = j;
      }
    }
    pts.push({ date: e, bar: loAt, price: lo });
    pts.push({ date: e, bar: hiAt, price: hi });
  }
  return pts;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const roundPrice = (x: number): number => Number(x.toPrecision(7));
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * distance_pct: price to the zone's near edge, in percent of price, 2 decimals; 0 when price is at or past that edge.
 * A response reads it on the served edges (served.ts, R7 #3).
 */
export function nearDistancePct(zone: { low: number; high: number }, side: SrSide, price: number): number {
  const gap = side === 'support' ? price - zone.high : zone.low - price;
  return gap > 0 ? round2((gap / price) * 100) : 0;
}

/**
 * Price is inside a zone when low <= price <= high, on the edges given (in a response, the served edges: served.ts,
 * R7 #3). The ONE predicate behind both the price_inside_zone flag and the summary's "price inside" (R6 #3): neither
 * re-derives it from a rounded distance.
 */
export function isPriceInsideZone(zone: { low: number; high: number }, price: number): boolean {
  return zone.low <= price && price <= zone.high;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function buildLadder(
  candles: readonly Candle[],
  ordered: readonly TurningPoint[],
  byDate: ReadonlyMap<number, readonly TurningPoint[]>,
  datesDesc: readonly number[],
  price: number,
  atr: number,
  side: SrSide,
): Cluster[] {
  const isSupport = side === 'support';
  const spacing = P.seedSpacingAtr * atr;
  const out: Cluster[] = [];
  let olderThan = Infinity;
  let farEdge: number | null = null;
  let nearDistance = -Infinity;
  // One pass newest → oldest: once a zone is taken, no earlier point can seed the next one (every earlier point is
  // dated at or after the seed, so not before the zone's oldest candle).
  for (const seed of ordered) {
    if (out.length >= P.maxZonesPerSide) break;
    if (!(isSupport ? seed.price < price : seed.price > price)) continue;
    if (!(seed.date < olderThan)) continue;
    if (farEdge !== null && !(isSupport ? seed.price <= farEdge - spacing : seed.price >= farEdge + spacing)) continue;
    const band = P.memberBandAtr[out.length] * atr;
    const inBand = (p: TurningPoint): boolean => Math.abs(p.price - seed.price) <= band;
    const members = (byDate.get(seed.date) ?? []).filter(inBand);
    for (let di = datesDesc.indexOf(seed.date) + 1; di < datesDesc.length; di++) {
      const ins = (byDate.get(datesDesc[di]) ?? []).filter(inBand);
      if (ins.length === 0) break;
      members.push(...ins);
    }
    const bars = [...new Set(members.map((p) => p.bar))];
    const cs = bars.map((i) => candles[i]);
    let low: number;
    let high: number;
    if (isSupport) {
      low = Math.min(...cs.map((c) => c.low));
      high = median(cs.map((c) => Math.min(c.open, c.close)));
    } else {
      low = median(cs.map((c) => Math.max(c.open, c.close)));
      high = Math.max(...cs.map((c) => c.high));
    }
    const minWidth = P.minWidthAtr * atr;
    if (high - low < minWidth) {
      if (isSupport) low = high - minWidth;
      else high = low + minWidth;
    }
    // R6 #2: a zone no further from price at its near edge than the previous one is skipped; the walk goes on older.
    const distance = nearDistancePct({ low, high }, side, price);
    if (out.length > 0 && !(distance > nearDistance)) continue;
    const from = Math.min(...bars);
    out.push({ low, high, from, to: Math.max(...bars), members: members.length });
    olderThan = from;
    farEdge = isSupport ? low : high;
    nearDistance = distance;
  }
  return out;
}

/**
 * The flip state of a zone. The side a zone formed on is the side of the last close outside it before its oldest
 * candle (where price came from). Every closed candle after its oldest candle counts (R6 #1 — members can straddle a
 * break): 2 consecutive closes beyond the zone on the other side flip it, and a close inside it resets the run. A zone
 * is former_support / former_resistance when it has flipped and price is now on the other side, i.e. it is listed on
 * the side opposite to the one it formed on; broke_at is the open time of the candle whose close was the second close
 * of that flip.
 */
function zoneState(
  candles: readonly Candle[],
  t: number,
  zone: Cluster,
  side: SrSide,
): { state: SrZoneState; broke_at: string | null } {
  const intact = { state: 'intact' as const, broke_at: null };
  const sideOf = (close: number): 'above' | 'below' | null =>
    close > zone.high ? 'above' : close < zone.low ? 'below' : null;
  let formedOn: 'above' | 'below' | null = null;
  for (let j = zone.from - 1; j >= 0 && formedOn === null; j--) formedOn = sideOf(candles[j].close);
  if (formedOn === null) return intact;
  let current = formedOn;
  let run = 0;
  let flipAt = -1;
  for (let j = zone.from + 1; j <= t; j++) {
    const s = sideOf(candles[j].close);
    if (s !== null && s !== current) {
      run++;
      if (run >= P.breakCloses) {
        current = s;
        flipAt = j;
        run = 0;
      }
    } else {
      run = 0;
    }
  }
  const listedOn = side === 'support' ? 'above' : 'below';
  if (current === formedOn || current !== listedOn || flipAt < 0) return intact;
  return {
    state: formedOn === 'above' ? 'former_support' : 'former_resistance',
    broke_at: iso(candles[flipAt].time),
  };
}

function zoneFacts(candles: readonly Candle[], t: number, price: number, zone: Cluster, side: SrSide, rank: number): SrZone {
  const meets = (c: Candle): boolean => c.high >= zone.low && c.low <= zone.high;
  let touches = 0;
  for (let j = Math.max(0, t - P.touchWindowBars + 1); j <= t; j++) if (meets(candles[j])) touches++;
  let tests = 0;
  for (let j = Math.max(1, t - P.testWindowBars + 1); j <= t; j++) {
    const prev = candles[j - 1].close;
    const c = candles[j];
    if (prev > zone.high && c.low <= zone.high && c.close > zone.high) tests++;
    else if (prev < zone.low && c.high >= zone.low && c.close < zone.low) tests++;
  }
  let lastTouch: string | null = null;
  for (let j = t; j >= 0; j--) {
    if (meets(candles[j])) {
      lastTouch = iso(candles[j].time);
      break;
    }
  }
  const { state, broke_at } = zoneState(candles, t, zone, side);
  return {
    rank,
    low: roundPrice(zone.low),
    high: roundPrice(zone.high),
    distance_pct: nearDistancePct(zone, side, price),
    formed_from: iso(candles[zone.from].time),
    formed_to: iso(candles[zone.to].time),
    members: zone.members,
    touch_bars_90: touches,
    tests_30: tests,
    last_touch: lastTouch,
    state,
    broke_at,
    overlaps: [],
  };
}

/**
 * Support and resistance zones as of closed candle t, for a price (the forming candle's latest price when served).
 * Reads candles[0..t] only.
 */
export function computeSrZones(candles: readonly Candle[], t: number, price: number): SrZonesComputation {
  if (t + 1 < P.minClosedBars) return { ok: false, reason: `fewer than ${P.minClosedBars} closed candles` };
  const atrSeries = wilderAtr(candles, t);
  const atr = atrSeries[t];
  if (atr === null || !(atr > 0)) return { ok: false, reason: 'no price movement in the loaded candles' };

  const seen = new Set<string>();
  const points = [...swingPoints(candles, t), ...rangePoints(candles, atrSeries, t)].filter((p) => {
    const key = `${p.date}:${p.bar}:${p.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ordered = [...points].sort(
    (a, b) => b.date - a.date || b.bar - a.bar || Math.abs(a.price - price) - Math.abs(b.price - price),
  );
  const byDate = new Map<number, TurningPoint[]>();
  for (const p of points) {
    const list = byDate.get(p.date);
    if (list) list.push(p);
    else byDate.set(p.date, [p]);
  }
  const datesDesc = [...byDate.keys()].sort((a, b) => b - a);

  const support = buildLadder(candles, ordered, byDate, datesDesc, price, atr, 'support').map((z, i) =>
    zoneFacts(candles, t, price, z, 'support', i + 1),
  );
  const resistance = buildLadder(candles, ordered, byDate, datesDesc, price, atr, 'resistance').map((z, i) =>
    zoneFacts(candles, t, price, z, 'resistance', i + 1),
  );

  const flags: SrZoneFlag[] = [];
  if (resistance.length === 0) flags.push('no_zone_above');
  if (support.length === 0) flags.push('no_zone_below');
  if ([...support, ...resistance].some((z) => isPriceInsideZone(z, price))) flags.push('price_inside_zone');

  let volumeVs20: number | null = null;
  if (t >= P.volumeWindowBars) {
    let sum = 0;
    for (let j = t - P.volumeWindowBars; j < t; j++) sum += candles[j].volume;
    const mean = sum / P.volumeWindowBars;
    if (mean > 0) volumeVs20 = round2(candles[t].volume / mean);
  }

  return { ok: true, frame: { support, resistance, flags, volume_vs_20: volumeVs20 } };
}

/** What overlap-matching reads and writes of a zone: a computed zone or a served one (served.ts). */
type OverlapZone = Pick<SrZone, 'rank' | 'low' | 'high' | 'overlaps'>;

/**
 * Fill each zone's `overlaps` with the zones of the OTHER timeframes whose price range intersects it. Mutates and
 * returns the frames. A response passes its SERVED frames (SR-ZONES-W3 §0.5), so the ranges compared are the edges
 * the response carries.
 */
export function attachSrZoneOverlaps<T extends { timeframe: string; support: OverlapZone[]; resistance: OverlapZone[] }>(
  frames: T[],
): T[] {
  const all = frames.flatMap((f) =>
    (['support', 'resistance'] as const).flatMap((side) => f[side].map((zone) => ({ timeframe: f.timeframe, side, zone }))),
  );
  for (const a of all) {
    a.zone.overlaps = all
      .filter((b) => b.timeframe !== a.timeframe && b.zone.low <= a.zone.high && a.zone.low <= b.zone.high)
      .map((b) => ({ timeframe: b.timeframe, side: b.side, rank: b.zone.rank }));
  }
  return frames;
}
