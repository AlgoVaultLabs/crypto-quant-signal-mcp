// sr-backtest/engine.ts — EDGE-SR-LEVEL-BACKTEST-W1: the whole outcome harness, pure.
//
// One 15-minute series per coin is the clock and the path for every timeframe: an instant is a 15-minute boundary,
// the price at an instant is the close of the bar that ends there, and every outcome is a hit-first label read
// off the 15-minute bars that follow. A timeframe's zones come from that timeframe's own closed bars as of the
// instant (zones.ts). Nothing here is a PnL.
//
//   served zone   a Z1 zone in the served set at a grid instant
//   control       the same coin, timeframe and side; the same distance and width in ATR, re-laid from the price
//                 and ATR of a LATER instant at the same position inside the timeframe's bar; disjoint from every
//                 qualifying zone of the timeframe at that instant. Every served zone has one (see `runCoin`).
//   entered       the first 15m bar, within N timeframe bars of the instant, that reaches the zone's near edge
//   bounce        the entry bar closes k ATR back out of the zone, or a later bar trades there
//   break         `breakCloses` consecutive timeframe closes beyond the zone's far edge
//   timeout       neither within M timeframe bars after the entry bar
//
// A bar's high and low are unordered, its close is last: a bar that both bounces and closes the break is a bounce,
// and on the entry bar only the close can bounce (its high may have come before the entry).
import type { Bar } from '../sr-probe/level-v0.js';
import { BT, DAY, M15, TIMEFRAMES, controlWindow, strideUnits, type BtParams, type Timeframe } from './spec.js';
import { agreeing, overlaps, roundStep, servedOf, zoneSetAsOf, type Side, type Zone, type ZoneSet } from './zones.js';

export interface CoinData {
  coin: string;
  /** Contiguous bars per timeframe key; '15m' is the base series. */
  frames: Record<string, readonly Bar[]>;
}

export type SourceKey = 'z1' | 'floor' | 'pdhl' | 'rnd';
export const SOURCES: readonly SourceKey[] = Object.freeze(['z1', 'floor', 'pdhl', 'rnd']);
export type Outcome = 'bounce' | 'break' | 'timeout';

export interface Resolution {
  entered: boolean;
  outcome: Outcome | null;
  /** Index of the first timeframe close beyond the far edge while the event was open (V5's 1-close break). */
  b1Idx: number | null;
  /** Index of the close that completed the break (V5's 2-close break). */
  b2Idx: number | null;
}

/** Longest forward reach of any label, in bars of the timeframe: entry + resolve + V5's follow-through window. */
export const labelBars = (p: BtParams = BT): number => Math.max(p.entryBars + 2 * p.resolveBars, p.raceBars + p.resolveBars);

/** Bars of the timeframe an instant needs after it: the control's lag and window, then the longest label. */
export const maxHorizonBars = (tf: Timeframe, p: BtParams = BT): number => p.controlLagBars + controlWindow(tf, p) + labelBars(p);

const barAt = (base: readonly Bar[], i: number): Bar => {
  const b = base[i];
  if (b === undefined) throw new Error(`sr-backtest engine: the path ends before bar ${i}`);
  return b;
};

/** Index of the 15m bar that OPENS at `t`. */
export const idxAt = (base: readonly Bar[], t: number): number => {
  const i = (t - base[0].time) / M15;
  if (!Number.isInteger(i) || i < 1 || i > base.length) throw new Error(`sr-backtest engine: ${t} is not an instant of this series`);
  return i;
};

/** The price at an instant: the close of the 15m bar ending there. */
export const priceAt = (base: readonly Bar[], t: number): number => base[idxAt(base, t) - 1].close;

const closesTf = (bar: Bar, tf: Timeframe): boolean => (bar.time + M15) % tf.stepMs === 0;

/** V1's label for one zone from the bar that opens at the instant (index `iStart`). */
export function resolveZone(base: readonly Bar[], iStart: number, zone: { lo: number; hi: number }, side: Side, atr: number, tf: Timeframe, p: BtParams = BT): Resolution {
  const sup = side === 'support';
  let entry = -1;
  for (let i = iStart; i < iStart + p.entryBars * tf.units; i++) {
    const b = barAt(base, i);
    if (sup ? b.low <= zone.hi : b.high >= zone.lo) {
      entry = i;
      break;
    }
  }
  if (entry < 0) return { entered: false, outcome: null, b1Idx: null, b2Idx: null };
  const target = sup ? zone.hi + p.bounceAtr * atr : zone.lo - p.bounceAtr * atr;
  let beyond = 0;
  let b1Idx: number | null = null;
  for (let i = entry; i <= entry + p.resolveBars * tf.units; i++) {
    const b = barAt(base, i);
    const back = i === entry ? (sup ? b.close >= target : b.close <= target) : sup ? b.high >= target : b.low <= target;
    if (back) return { entered: true, outcome: 'bounce', b1Idx, b2Idx: null };
    if (closesTf(b, tf)) {
      beyond = (sup ? b.close < zone.lo : b.close > zone.hi) ? beyond + 1 : 0;
      if (beyond === 1 && b1Idx === null) b1Idx = i;
      if (beyond >= p.breakCloses) return { entered: true, outcome: 'break', b1Idx, b2Idx: i };
    }
  }
  return { entered: true, outcome: 'timeout', b1Idx, b2Idx: null };
}

/** V5: after a break at bar `iB`, is the next zone beyond reached before a timeframe close back on the original
 *  side, within M timeframe bars? */
export function followThrough(base: readonly Bar[], iB: number, zone: { lo: number; hi: number }, next: { lo: number; hi: number }, side: Side, tf: Timeframe, p: BtParams = BT): boolean {
  const sup = side === 'support';
  for (let i = iB + 1; i <= iB + p.resolveBars * tf.units; i++) {
    const b = barAt(base, i);
    if (sup ? b.low <= next.hi : b.high >= next.lo) return true;
    if (closesTf(b, tf) && (sup ? b.close > zone.hi : b.close < zone.lo)) return false;
  }
  return false;
}

/** V4 (a): which is touched first within `bars15` 15m bars. A bar touching both is the stop. */
export function raceTpSl(base: readonly Bar[], iStart: number, tp: number, sl: number, long: boolean, bars15: number): 'tp' | 'sl' | 'none' {
  for (let i = iStart; i < iStart + bars15; i++) {
    const b = barAt(base, i);
    if (long ? b.low <= sl : b.high >= sl) return 'sl';
    if (long ? b.high >= tp : b.low <= tp) return 'tp';
  }
  return 'none';
}

/** V4 (b): the stop is hit within `race15` bars and price is back at the entry within `recover15` bars after —
 *  the stop bar's own close, or any later bar's range. */
export function stopRecover(base: readonly Bar[], iStart: number, entry: number, sl: number, long: boolean, race15: number, recover15: number): 'recovered' | 'stopped' | 'none' {
  for (let i = iStart; i < iStart + race15; i++) {
    const b = barAt(base, i);
    if (!(long ? b.low <= sl : b.high >= sl)) continue;
    if (long ? b.close >= entry : b.close <= entry) return 'recovered';
    for (let j = i + 1; j <= i + recover15; j++) {
      const c = barAt(base, j);
      if (long ? c.high >= entry : c.low <= entry) return 'recovered';
    }
    return 'stopped';
  }
  return 'none';
}

/** The control's zone: the served zone's distance and width in ATR, re-laid from another price and ATR. */
export function placeControl(zone: { lo: number; hi: number }, side: Side, price: number, atr: number, price2: number, atr2: number, widthMult = 1): { lo: number; hi: number } {
  const w = ((zone.hi - zone.lo) / atr) * widthMult * atr2;
  if (side === 'support') {
    const hi = price2 - ((price - zone.hi) / atr) * atr2;
    return { lo: hi - w, hi };
  }
  const lo = price2 + ((zone.lo - price) / atr) * atr2;
  return { lo, hi: lo + w };
}

/** Lines -> zones of the floor width, overlapping ones merged. The free versions' counterpart of a Z1 zone. */
export function linesToSet(lines: readonly number[], atr: number | null, p: BtParams = BT): ZoneSet {
  if (atr === null) return { atr, zones: [] };
  const half = (p.minWidthAtr * atr) / 2;
  const zones: Zone[] = [];
  for (const l of [...lines].filter((x) => x > 0).sort((a, b) => a - b)) {
    const last = zones[zones.length - 1];
    if (last && l - half <= last.hi) {
      last.hi = l + half;
      last.rawHi = l;
      last.touches++;
      last.level = (last.rawLo + last.rawHi) / 2;
    } else zones.push({ lo: l - half, hi: l + half, level: l, touches: 1, label: 'WEAK', round: false, rawLo: l, rawHi: l });
  }
  return { atr, zones };
}

/** Classic floor pivots of one closed day: P, R1–R3, S1–S3. */
export function floorPivots(d: { high: number; low: number; close: number }): number[] {
  const P = (d.high + d.low + d.close) / 3;
  const range = d.high - d.low;
  return [P, 2 * P - d.low, 2 * P - d.high, P + range, P - range, d.high + 2 * (P - d.low), d.low - 2 * (d.high - P)];
}

/** Round-number lines around a price: the multiples of `roundStep(price)` within four steps. */
export function roundLines(price: number): number[] {
  const step = roundStep(price);
  const m = Math.round(price / step);
  const out: number[] = [];
  for (let k = m - 4; k <= m + 4; k++) if (k > 0) out.push(k * step);
  return out;
}

export interface PairEvent {
  coin: string;
  tf: string;
  t: number;
  t2: number;
  side: Side;
  rank: number;
  touches: number;
  agree: number;
  round: boolean;
  distanceAtr: number;
  widthAtr: number;
  price: number;
  atr: number;
  price2: number;
  atr2: number;
  /** The control overlaps a qualifying zone: no candidate instant gave a disjoint placement. */
  forced: boolean;
  s: Resolution;
  c: Resolution;
}

/** Columns of one tally row. */
export const COLS = Object.freeze(['served', 'matched', 'sN', 'sHit', 'sBreak', 'cN', 'cHit', 'cBreak', 'forced']);

export class Tally {
  readonly rows = new Map<string, number[]>();
  /** Matched rows per arm by side (support / resistance; long / short for V4) — label-free. */
  readonly sides = new Map<string, [number, number]>();
  instants = 0;

  /** The live row of one (arm, timeframe, UTC day, coin): callers add to its columns. */
  row(key: string, tf: string, day: number, coin: string): number[] {
    const id = `${key}|${tf}|${day}|${coin}`;
    let r = this.rows.get(id);
    if (!r) {
      r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      this.rows.set(id, r);
    }
    return r;
  }

  side(key: string, first: boolean): void {
    let s = this.sides.get(key);
    if (!s) {
      s = [0, 0];
      this.sides.set(key, s);
    }
    s[first ? 0 : 1]++;
  }

  csv(): string {
    const lines = [`key,tf,day,coin,${COLS.join(',')}`];
    for (const id of [...this.rows.keys()].sort()) lines.push(`${id.split('|').join(',')},${this.rows.get(id)!.join(',')}`);
    return `${lines.join('\n')}\n`;
  }
}

export interface RunConfig {
  params: BtParams;
  /** First evaluation instant, a UTC midnight. */
  startMs: number;
  /** End of the data: the last 15m bar closes here. */
  endMs: number;
  /** Evaluation days per timeframe key, from `startMs` (absent = every day that leaves the horizon free). */
  evalDays?: Readonly<Record<string, number>>;
  timeframes?: readonly Timeframe[];
  sources?: readonly SourceKey[];
  /** Cross-timeframe agreement (needs every frame). */
  crossTf?: boolean;
  /** False = the label-free skeleton: no outcome is resolved (later bars are read only to place the controls). */
  outcomes: boolean;
  onPair?: (e: PairEvent) => void;
}

interface Placed {
  t2: number;
  price2: number;
  atr2: number;
  zone: { lo: number; hi: number };
  /** No candidate instant gave a disjoint placement: the control sits at the last one all the same. */
  forced: boolean;
}

/** Every grid instant of one coin, every timeframe and source: tallies into `tally`.
 *
 *  THE CONTROL, and why it is laid this way. A served zone at instant t is compared with the same ATR distance and
 *  width re-laid at t + j bars of its timeframe, j = lag + 1 … lag + window, where no qualifying zone sits. Three
 *  rules keep the comparison about the zone and nothing else — each one measured on driftless random walks, where
 *  the difference must be zero (audits: the registration's control section):
 *    1. LATER, never earlier. A control before t has its outcome read on the very path that went on to form the
 *       served zone; and the lag is the entry window, so the control's clock starts after the served zone's own
 *       entry window has closed.
 *    2. IN TIME ORDER, the first disjoint candidate. Whether a candidate is disjoint is known at that candidate;
 *       picking by any other order would let a later candidate's state choose an earlier one.
 *    3. NEVER DROPPED. A served zone with no disjoint candidate keeps the last candidate, flagged `forced`. Dropping
 *       it would select the served arm on the path after t (price that runs away leaves room for a control).
 *  The candidates sit a whole number of timeframe bars after t, so both arms read zones of the same age and face
 *  the same sequence of timeframe closes. */
export function runCoin(data: CoinData, cfg: RunConfig, tally: Tally): void {
  const p = cfg.params;
  const base = data.frames['15m'];
  const z1Cache = new Map<string, ZoneSet>();
  const z1 = (tf: Timeframe, t: number): ZoneSet => {
    const bars = data.frames[tf.key];
    const n = Math.max(0, Math.min(bars.length, Math.floor((t - bars[0].time) / tf.stepMs)));
    const id = `${tf.key}:${n}`;
    let set = z1Cache.get(id);
    if (!set) {
      // A window that holds the as-of bars and one past them; the as-of cut itself is level v0's.
      const from = Math.max(0, n - p.v0.lookbackBars - 1);
      set = zoneSetAsOf(bars.slice(from, Math.min(bars.length, n + p.v0.lookaheadBars + 1)), tf.stepMs, t, p);
      z1Cache.set(id, set);
    }
    return set;
  };
  const lastDay = (t: number): Bar | null => {
    const d = data.frames['1d'];
    if (!d) return null;
    const n = Math.floor((t - d[0].time) / DAY);
    return n >= 1 && n <= d.length ? d[n - 1] : null;
  };
  const provide = (src: SourceKey, tf: Timeframe, t: number, price: number): ZoneSet => {
    const own = z1(tf, t);
    if (src === 'z1') return own;
    if (src === 'rnd') return linesToSet(roundLines(price), own.atr, p);
    const d = lastDay(t);
    if (!d) return { atr: own.atr, zones: [] };
    return linesToSet(src === 'floor' ? floorPivots(d) : [d.high, d.low], own.atr, p);
  };

  for (const tf of cfg.timeframes ?? TIMEFRAMES) {
    const stride = strideUnits(tf, p) * M15;
    const horizon = maxHorizonBars(tf, p) * tf.stepMs;
    const window = controlWindow(tf, p);
    const capMs = cfg.evalDays?.[tf.key] !== undefined ? cfg.startMs + cfg.evalDays[tf.key] * DAY : Infinity;
    const others = cfg.crossTf ? TIMEFRAMES.filter((o) => o.key !== tf.key && data.frames[o.key]) : [];
    for (let t = cfg.startMs; ; t += stride) {
      const dayStart = Math.floor(t / DAY) * DAY;
      if (t + horizon > cfg.endMs || dayStart >= capMs) break;
      const day = dayStart / DAY;
      const price = priceAt(base, t);
      const iStart = idxAt(base, t);
      tally.instants++;
      // The control's candidate instants, in time order — see the note above `runCoin`.
      const candidates: number[] = [];
      for (let j = p.controlLagBars + 1; j <= p.controlLagBars + window; j++) candidates.push(t + j * tf.stepMs);
      for (const src of cfg.sources ?? SOURCES) {
        const set = provide(src, tf, t, price);
        const atr = set.atr;
        if (atr === null || !(atr > 0)) continue;
        const served = servedOf(set, price, p);
        const control = (zone: Zone, side: Side): Placed | null => {
          let last: Placed | null = null;
          for (const t2 of candidates) {
            const price2 = priceAt(base, t2);
            const set2 = provide(src, tf, t2, price2);
            if (set2.atr === null || !(set2.atr > 0)) continue;
            const atr2 = set2.atr;
            const placed = placeControl(zone, side, price, atr, price2, atr2, p.controlWidthMult);
            const free = !set2.zones.some((z) => overlaps(placed, z));
            last = { t2, price2, atr2, zone: placed, forced: !free };
            if (free || !p.controlDisjoint) return { ...last, forced: false };
          }
          return last;
        };
        const firstControl: Partial<Record<Side, Placed | null>> = {};
        for (const side of ['support', 'resistance'] as const) {
          const list = side === 'support' ? served.supports : served.resistances;
          list.forEach((zone, r) => {
            const agree = src === 'z1' ? agreeing(zone, others.map((o) => ({ key: o.key, set: z1(o, t) }))).length : 0;
            const keys = src !== 'z1' ? [src] : [
              'z1', `z1.${zone.label[0]}`, side === 'support' ? 'z1.sup' : 'z1.res', `z1.r${r + 1}`, zone.round ? 'z1.rnd1' : 'z1.rnd0',
              ...(agree >= 1 ? ['z1.SS'] : []), ...(agree >= 2 ? ['z1.SSS'] : []), ...(zone.label === 'STRONG' && agree === 0 ? ['z1.S0'] : []),
            ];
            const rows = keys.map((k) => tally.row(k, tf.key, day, data.coin));
            for (const row of rows) row[0]++;
            const c = control(zone, side);
            if (r === 0) firstControl[side] = c;
            if (!c) return;
            for (const row of rows) {
              row[1]++;
              if (c.forced) row[8]++;
            }
            for (const k of keys) tally.side(k, side === 'support');
            if (!cfg.outcomes) return;
            const s = resolveZone(base, iStart, zone, side, atr, tf, p);
            const cr = resolveZone(base, idxAt(base, c.t2), c.zone, side, c.atr2, tf, p);
            for (const row of rows) {
              if (s.entered) {
                row[2]++;
                if (s.outcome === 'bounce') row[3]++;
                if (s.outcome === 'break') row[4]++;
              }
              if (cr.entered) {
                row[5]++;
                if (cr.outcome === 'bounce') row[6]++;
                if (cr.outcome === 'break') row[7]++;
              }
            }
            if (src !== 'z1') return;
            cfg.onPair?.({
              coin: data.coin, tf: tf.key, t, t2: c.t2, side, rank: r + 1, touches: zone.touches, agree, round: zone.round,
              distanceAtr: (side === 'support' ? price - zone.hi : zone.lo - price) / atr, widthAtr: (zone.hi - zone.lo) / atr,
              price, atr, price2: c.price2, atr2: c.atr2, forced: c.forced, s, c: cr,
            });
            // V5: follow-through after a 1-close and after a 2-close break, to the next qualifying zone beyond.
            const next = side === 'support'
              ? [...set.zones].reverse().find((z) => z.hi < zone.lo)
              : set.zones.find((z) => z.lo > zone.hi);
            if (!next) return;
            for (const [k, iB] of [['v5.b1', s.b1Idx], ['v5.b2', s.b2Idx]] as const) {
              if (iB === null) continue;
              const row = tally.row(k, tf.key, day, data.coin);
              row[2]++;
              if (followThrough(base, iB, zone, next, side, tf, p)) row[3]++;
            }
          });
        }
        if (src !== 'z1') continue;
        // V4: an entry at the instant's price on both sides, read against the nearest zone each way.
        const sup = served.supports[0];
        const res = served.resistances[0];
        const race = p.raceBars * tf.units;
        const recover = p.resolveBars * tf.units;
        for (const long of [true, false]) {
          const ahead = long ? res : sup;
          const behind = long ? sup : res;
          const cAhead = firstControl[long ? 'resistance' : 'support'];
          const cBehind = firstControl[long ? 'support' : 'resistance'];
          const sign = long ? 1 : -1;
          const put = (name: string, c: Placed | null | undefined, sHit: () => boolean, cHit: (c: Placed) => boolean): void => {
            const keys = [name, `${name}.${long ? 'long' : 'short'}`];
            const rows = keys.map((k) => tally.row(k, tf.key, day, data.coin));
            for (const row of rows) row[0]++;
            if (!c) return;
            for (const row of rows) {
              row[1]++;
              if (c.forced) row[8]++;
            }
            for (const k of keys) tally.side(k, long);
            if (!cfg.outcomes) return;
            const sh = sHit();
            const ch = cHit(c);
            for (const row of rows) {
              row[2]++;
              row[5]++;
              if (sh) row[3]++;
              if (ch) row[6]++;
            }
          };
          if (ahead) {
            // (a) take-profit `bufferAtr` before the opposing zone, the stop the same distance the other way.
            const tpD = (long ? ahead.lo - price : price - ahead.hi) / atr - p.bufferAtr;
            if (tpD > 0) {
              put('v4a', cAhead,
                () => raceTpSl(base, iStart, price + sign * tpD * atr, price - sign * tpD * atr, long, race) === 'tp',
                (c) => raceTpSl(base, idxAt(base, c.t2), c.price2 + sign * tpD * c.atr2, c.price2 - sign * tpD * c.atr2, long, race) === 'tp');
            }
          }
          if (behind) {
            // (b) the stop `bufferAtr` beyond the protecting zone: knocked out, then back at the entry.
            const slD = (long ? price - behind.lo : behind.hi - price) / atr + p.bufferAtr;
            put('v4b', cBehind,
              () => stopRecover(base, iStart, price, price - sign * slD * atr, long, race, recover) === 'recovered',
              (c) => stopRecover(base, idxAt(base, c.t2), c.price2, c.price2 - sign * slD * c.atr2, long, race, recover) === 'recovered');
          }
        }
      }
    }
  }
}
