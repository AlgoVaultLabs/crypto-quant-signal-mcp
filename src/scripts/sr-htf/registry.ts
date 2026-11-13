// sr-htf/registry.ts — EDGE-SR-HTF-LEVELS-W1: the sr-backtest harness with a SOURCE REGISTRY, pure.
//
// EDGE-SR-LEVEL-BACKTEST-W1's engine (src/scripts/sr-backtest/engine.ts, `runCoin`) hard-codes its four sources.
// That file is pinned byte for byte by the closed study three times over — its registration's §10 (enforced by its
// own outcome guard), its test suite and the sha256 its calibration artifact records — so a registry written into
// it would make the closed study's own guard refuse a re-run. The registry therefore lives here, beside it:
//
//   a SOURCE is a provider (coin data, timeframe, instant, price) -> ZoneSet, registered under a key;
//   `runRegistry` walks the registered grid, serves each source's zones and lays each one's control by the
//   registered rule, and tallies one row per (source, timeframe, UTC day, coin).
//
// The four registered sources (`REGISTERED`) are engine.ts's own code paths, provider for provider; on a synthetic
// store this loop reproduces engine.ts's rows for those four keys byte for byte (tests/unit/sr-htf-harness.test.ts,
// AC1.4). Z1's sub-arms, V4 and V5 stay in engine.ts: they are that study's tests, not a source's. Any later level
// idea plugs in as one more provider and gets the same matched-random verdict.
//
// Every rule here is engine.ts's and is not restated in prose; see its header and the note above `runCoin`.
import type { Bar } from '../sr-probe/level-v0.js';
import { DAY, M15, controlWindow, strideUnits, type BtParams, type Timeframe } from '../sr-backtest/spec.js';
import { floorPivots, idxAt, linesToSet, maxHorizonBars, placeControl, priceAt, resolveZone, roundLines, type CoinData, type Resolution, type Tally } from '../sr-backtest/engine.js';
import { overlaps, servedOf, zoneSetAsOf, type Side, type Zone, type ZoneSet } from '../sr-backtest/zones.js';

/** What a provider may read: the coin's bars, the registered parameters, and the two cached helpers engine.ts's
 *  sources share — a timeframe's own Z1 set as of an instant (and with it the timeframe's ATR14), and the last
 *  closed day. */
export interface SourceCtx {
  readonly data: CoinData;
  readonly p: BtParams;
  z1(tf: Timeframe, t: number): ZoneSet;
  lastDay(t: number): Bar | null;
}

/** A level source. The returned set's `atr` is the ATR14 of the CELL's timeframe at the instant (the distance and
 *  label unit); `atr: null` means the source is undefined at that instant. Zones ascending, pairwise disjoint. */
export type Provider = (ctx: SourceCtx, tf: Timeframe, t: number, price: number) => ZoneSet;

/** The helpers of engine.ts's `runCoin`, line for line (the z1 cache and `lastDay`). */
export function sourceCtx(data: CoinData, p: BtParams): SourceCtx {
  const z1Cache = new Map<string, ZoneSet>();
  return {
    data,
    p,
    z1(tf: Timeframe, t: number): ZoneSet {
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
    },
    lastDay(t: number): Bar | null {
      const d = data.frames['1d'];
      if (!d) return null;
      const n = Math.floor((t - d[0].time) / DAY);
      return n >= 1 && n <= d.length ? d[n - 1] : null;
    },
  };
}

export type RegisteredKey = 'z1' | 'floor' | 'pdhl' | 'rnd';

/** EDGE-SR-LEVEL-BACKTEST-W1's four sources, exactly as engine.ts's `provide` builds them. */
export const REGISTERED: Readonly<Record<RegisteredKey, Provider>> = Object.freeze({
  z1: (ctx: SourceCtx, tf: Timeframe, t: number): ZoneSet => ctx.z1(tf, t),
  floor: (ctx: SourceCtx, tf: Timeframe, t: number): ZoneSet => {
    const own = ctx.z1(tf, t);
    const d = ctx.lastDay(t);
    return d ? linesToSet(floorPivots(d), own.atr, ctx.p) : { atr: own.atr, zones: [] };
  },
  pdhl: (ctx: SourceCtx, tf: Timeframe, t: number): ZoneSet => {
    const own = ctx.z1(tf, t);
    const d = ctx.lastDay(t);
    return d ? linesToSet([d.high, d.low], own.atr, ctx.p) : { atr: own.atr, zones: [] };
  },
  rnd: (ctx: SourceCtx, tf: Timeframe, t: number, price: number): ZoneSet => linesToSet(roundLines(price), ctx.z1(tf, t).atr, ctx.p),
});

/** One served zone and its control, labelled (outcome runs only). */
export interface SourceEvent {
  src: string;
  coin: string;
  tf: string;
  t: number;
  t2: number;
  side: Side;
  rank: number;
  distanceAtr: number;
  widthAtr: number;
  forced: boolean;
  s: Resolution;
  c: Resolution;
}

export interface RegistryRun {
  params: BtParams;
  /** Origin of the grid, a UTC midnight: instants are startMs + n x stride. */
  startMs: number;
  /** No instant before this one (a coin's own first evaluable instant); default startMs. */
  firstMs?: number;
  /** End of the data: the last 15m bar closes here; no instant whose horizon passes it. */
  endMs: number;
  /** Evaluation days per timeframe key, from `startMs` (absent = every day that leaves the horizon free). */
  evalDays?: Readonly<Record<string, number>>;
  timeframes: readonly Timeframe[];
  /** The sources run, in order, each under its key. */
  sources: ReadonlyArray<readonly [string, Provider]>;
  /** False = the label-free skeleton: no outcome is resolved (later bars are read only to place the controls). */
  outcomes: boolean;
  onEvent?: (e: SourceEvent) => void;
}

/** The first grid instant at or after `firstMs` on the lattice startMs + n x stride. */
export const firstInstant = (startMs: number, firstMs: number | undefined, strideMs: number): number =>
  firstMs === undefined || firstMs <= startMs ? startMs : startMs + Math.ceil((firstMs - startMs) / strideMs) * strideMs;

interface Placed {
  t2: number;
  price2: number;
  atr2: number;
  zone: { lo: number; hi: number };
  forced: boolean;
}

/** Every grid instant of one coin, every timeframe and source: tallies into `tally` (engine.ts's Tally). The grid,
 *  the served set, the control (later, in time order, first disjoint, never dropped) and the labels are engine.ts's
 *  `runCoin` for a source that is not z1, with the source read from the registry. */
export function runRegistry(data: CoinData, cfg: RegistryRun, tally: Tally, ctx: SourceCtx = sourceCtx(data, cfg.params)): void {
  const p = cfg.params;
  const base = data.frames['15m'];
  for (const tf of cfg.timeframes) {
    const stride = strideUnits(tf, p) * M15;
    const horizon = maxHorizonBars(tf, p) * tf.stepMs;
    const window = controlWindow(tf, p);
    const capMs = cfg.evalDays?.[tf.key] !== undefined ? cfg.startMs + cfg.evalDays[tf.key] * DAY : Infinity;
    for (let t = firstInstant(cfg.startMs, cfg.firstMs, stride); ; t += stride) {
      const dayStart = Math.floor(t / DAY) * DAY;
      if (t + horizon > cfg.endMs || dayStart >= capMs) break;
      const day = dayStart / DAY;
      const price = priceAt(base, t);
      const iStart = idxAt(base, t);
      tally.instants++;
      const candidates: number[] = [];
      for (let j = p.controlLagBars + 1; j <= p.controlLagBars + window; j++) candidates.push(t + j * tf.stepMs);
      for (const [src, provide] of cfg.sources) {
        const set = provide(ctx, tf, t, price);
        const atr = set.atr;
        if (atr === null || !(atr > 0)) continue;
        const served = servedOf(set, price, p);
        const control = (zone: Zone, side: Side): Placed | null => {
          let last: Placed | null = null;
          for (const t2 of candidates) {
            const price2 = priceAt(base, t2);
            const set2 = provide(ctx, tf, t2, price2);
            if (set2.atr === null || !(set2.atr > 0)) continue;
            const atr2 = set2.atr;
            const placed = placeControl(zone, side, price, atr, price2, atr2, p.controlWidthMult);
            const free = !set2.zones.some((z) => overlaps(placed, z));
            last = { t2, price2, atr2, zone: placed, forced: !free };
            if (free || !p.controlDisjoint) return { ...last, forced: false };
          }
          return last;
        };
        for (const side of ['support', 'resistance'] as const) {
          const list = side === 'support' ? served.supports : served.resistances;
          list.forEach((zone, r) => {
            const row = tally.row(src, tf.key, day, data.coin);
            row[0]++;
            const c = control(zone, side);
            if (!c) return;
            row[1]++;
            if (c.forced) row[8]++;
            tally.side(src, side === 'support');
            if (!cfg.outcomes) return;
            const s = resolveZone(base, iStart, zone, side, atr, tf, p);
            const cr = resolveZone(base, idxAt(base, c.t2), c.zone, side, c.atr2, tf, p);
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
            cfg.onEvent?.({
              src, coin: data.coin, tf: tf.key, t, t2: c.t2, side, rank: r + 1,
              distanceAtr: (side === 'support' ? price - zone.hi : zone.lo - price) / atr, widthAtr: (zone.hi - zone.lo) / atr,
              forced: c.forced, s, c: cr,
            });
          });
        }
      }
    }
  }
}
