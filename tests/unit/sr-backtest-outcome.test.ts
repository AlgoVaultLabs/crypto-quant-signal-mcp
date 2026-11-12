// EDGE-SR-LEVEL-BACKTEST-W1 CH1 — the outcome harness (src/scripts/sr-backtest/engine.ts): known answers for the
// path labels, the control's placement, V4 (a) and (b) on both sides, the mirror property on whole runs, and the
// two mutations that must turn them red. Synthetic candles only.
import { describe, it, expect } from 'vitest';
import type { Bar } from '../../src/scripts/sr-probe/level-v0.js';
import { BT, DAY, M15, TIMEFRAMES, controlWindow, strideUnits, tfOf, type BtParams, type Timeframe } from '../../src/scripts/sr-backtest/spec.js';
import {
  COLS, Tally, floorPivots, followThrough, idxAt, labelBars, linesToSet, maxHorizonBars, placeControl, priceAt, raceTpSl, resolveZone, roundLines, runCoin,
  stopRecover, type CoinData, type PairEvent, type Resolution, type RunConfig,
} from '../../src/scripts/sr-backtest/engine.js';
import { overlaps, servedOf, zoneSetOf, type Side, type Zone, type ZoneSet } from '../../src/scripts/sr-backtest/zones.js';
import { synthCoin, walk15 } from '../../src/scripts/sr-backtest/synth.js';

const H1 = tfOf('1h');
const M = tfOf('15m');
const T0 = Date.UTC(2026, 0, 5); // an hour boundary: bars 3, 7, 11 … close an hour
const mirrorBars = (bars: readonly Bar[], k: number): Bar[] => bars.map((b) => ({ time: b.time, open: k - b.open, high: k - b.low, low: k - b.high, close: k - b.close }));

/** `n` quiet 15m bars at `at` ± 1, some of them replaced. */
function path(over: Record<number, Partial<Bar>> = {}, at = 115, n = 130): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ time: T0 + i * M15, open: at, high: at + 1, low: at - 1, close: at, ...over[i] }));
}

const res = (entered: boolean, outcome: Resolution['outcome'], b1Idx: number | null = null, b2Idx: number | null = null): Resolution => ({ entered, outcome, b1Idx, b2Idx });

describe('V1 path labels: entered, bounce, break, timeout', () => {
  // A support zone [100, 110] under a price of 115, ATR 10: the bounce target is 120, the far edge 100.
  // 1h timeframe: the entry window is 48 15m bars, the event resolves within 48 more after the entry bar.
  const ZONE = { lo: 100, hi: 110 };
  const KM = 230; // the mirror: a resistance zone [120, 130] over a price of 115
  const cases: Array<[string, Record<number, Partial<Bar>>, Resolution, number?]> = [
    ['never reaches the zone', {}, res(false, null)],
    ['reaches it one bar after the entry window', { 48: { low: 109 } }, res(false, null)],
    ['a touch before the instant is not an entry', { 3: { low: 100 } }, res(false, null), 20],
    ['touching the near edge is an entry; nothing after is a timeout', { 5: { low: 110 } }, res(true, 'timeout')],
    ['bounces on the entry bar\'s close', { 5: { low: 109, high: 122, close: 121 } }, res(true, 'bounce')],
    ['enters in the last bar of the entry window and bounces at once', { 47: { low: 109, high: 121, close: 120 } }, res(true, 'bounce')],
    ['the entry bar\'s high alone is no bounce', { 5: { low: 109, high: 125, close: 112 } }, res(true, 'timeout')],
    ['a later bar trading at the target is a bounce', { 5: { low: 109, high: 125, close: 112 }, 9: { high: 120 } }, res(true, 'bounce')],
    ['the last bar of the resolve window still counts', { 5: { low: 109 }, 53: { high: 120 } }, res(true, 'bounce')],
    ['one bar later is a timeout', { 5: { low: 109 }, 54: { high: 120 } }, res(true, 'timeout')],
    ['two consecutive timeframe closes beyond the far edge are a break', { 5: { low: 105 }, 7: { low: 98, close: 99 }, 11: { low: 97, close: 98 } }, res(true, 'break', 7, 11)],
    ['the entry bar\'s own close can start the break', { 7: { low: 98, close: 99 }, 11: { low: 97, close: 98 } }, res(true, 'break', 7, 11)],
    ['closes beyond that are not timeframe closes do not count', { 5: { low: 105 }, 6: { low: 90, close: 91 }, 10: { low: 90, close: 91 } }, res(true, 'timeout')],
    ['a close exactly on the far edge is not beyond it', { 5: { low: 105 }, 7: { low: 99, close: 100 }, 11: { low: 99, close: 100 } }, res(true, 'timeout')],
    ['a close back inside resets the count', { 5: { low: 105 }, 7: { low: 98, close: 99 }, 11: { low: 99, close: 101 }, 15: { low: 98, close: 99 }, 19: { low: 98, close: 99 } }, res(true, 'break', 7, 19)],
    ['one close beyond, then time runs out', { 5: { low: 105 }, 7: { low: 98, close: 99 } }, res(true, 'timeout', 7)],
    ['a bar that trades at the target and closes the break is a bounce', { 5: { low: 105 }, 7: { low: 98, close: 99 }, 11: { high: 120, low: 97, close: 98 } }, res(true, 'bounce', 7)],
    ['the second close beyond in the last bar of the resolve window', { 7: { low: 105 }, 51: { low: 98, close: 99 }, 55: { low: 98, close: 99 } }, res(true, 'break', 51, 55)],
    ['the second close beyond one bar after the window', { 6: { low: 105 }, 51: { low: 98, close: 99 }, 55: { low: 98, close: 99 } }, res(true, 'timeout', 51)],
  ];

  it.each(cases)('support: %s', (_name, over, want, iStart) => {
    expect(resolveZone(path(over), iStart ?? 0, ZONE, 'support', 10, H1)).toEqual(want);
  });

  it.each(cases)('resistance, the same path mirrored: %s', (_name, over, want, iStart) => {
    expect(resolveZone(mirrorBars(path(over), KM), iStart ?? 0, { lo: KM - ZONE.hi, hi: KM - ZONE.lo }, 'resistance', 10, H1)).toEqual(want);
  });

  it('counts closes of the zone\'s own timeframe: every 15m bar, every sixteenth for 4h', () => {
    const over = { 5: { low: 105 }, 6: { low: 98, close: 99 }, 7: { low: 98, close: 99 } };
    expect(resolveZone(path(over), 0, ZONE, 'support', 10, M)).toEqual(res(true, 'break', 6, 7));
    expect(resolveZone(path({ 12: { low: 105 } }), 0, ZONE, 'support', 10, M)).toEqual(res(false, null));
    const h4 = { 5: { low: 105 }, 15: { low: 98, close: 99 }, 19: { low: 98, close: 99 }, 31: { low: 98, close: 99 } };
    expect(resolveZone(path(h4, 115, 400), 0, ZONE, 'support', 10, tfOf('4h'))).toEqual(res(true, 'break', 15, 31));
  });

  it('scales the bounce target with k and the break with the number of closes', () => {
    // A path resting at 113: the registered target is 120, the half-ATR one 115.
    const over = { 5: { low: 105 }, 7: { low: 98, close: 99 }, 9: { high: 116 } };
    expect(resolveZone(path(over, 113), 0, ZONE, 'support', 10, H1)).toEqual(res(true, 'timeout', 7));
    expect(resolveZone(path(over, 113), 0, ZONE, 'support', 10, H1, { ...BT, bounceAtr: 0.5 })).toEqual(res(true, 'bounce', 7));
    expect(resolveZone(path(over, 113), 0, ZONE, 'support', 10, H1, { ...BT, breakCloses: 1 })).toEqual(res(true, 'break', 7, 7));
  });

  it('refuses to label a path that ends before the label does', () => {
    expect(() => resolveZone(path({}, 115, 30), 0, ZONE, 'support', 10, H1)).toThrow(/path ends before bar 30/);
  });
});

describe('V5 follow-through after a break', () => {
  const ZONE = { lo: 100, hi: 110 };
  const NEXT = { lo: 80, hi: 90 };
  const cases: Array<[string, Record<number, Partial<Bar>>, boolean]> = [
    ['never reaches the next zone', {}, false],
    ['reaches it', { 12: { low: 90 } }, true],
    ['a timeframe close back above the zone comes first', { 11: { high: 112, close: 111 }, 12: { low: 90 } }, false],
    ['a close back that is not a timeframe close does not end it', { 10: { high: 112, close: 111 }, 12: { low: 90 } }, true],
    ['a bar that reaches the next zone and closes back counts as reached', { 11: { low: 90, high: 112, close: 111 } }, true],
    ['the last bar of the window still counts', { 55: { low: 90 } }, true],
    ['one bar later does not', { 56: { low: 90 } }, false],
    ['the break bar itself is not read', { 7: { low: 90 } }, false],
  ];
  it.each(cases)('support: %s', (_name, over, want) => {
    expect(followThrough(path(over, 95), 7, ZONE, NEXT, 'support', H1)).toBe(want);
    expect(followThrough(mirrorBars(path(over, 95), 230), 7, { lo: 120, hi: 130 }, { lo: 140, hi: 150 }, 'resistance', H1)).toBe(want);
  });
});

describe('V4 known answers, long and short', () => {
  // (a) an entry at 115 with the take-profit at 125 and the stop at 105; short is the same path mirrored about 115.
  const race: Array<[string, Record<number, Partial<Bar>>, 'tp' | 'sl' | 'none']> = [
    ['neither is touched', {}, 'none'],
    ['the take-profit first', { 3: { high: 125 } }, 'tp'],
    ['the stop first', { 3: { low: 105 } }, 'sl'],
    ['a bar touching both is the stop', { 3: { high: 126, low: 104 } }, 'sl'],
    ['the stop, then the take-profit', { 2: { low: 105 }, 3: { high: 125 } }, 'sl'],
    ['the take-profit, then the stop', { 2: { high: 125 }, 3: { low: 105 } }, 'tp'],
    ['the last bar of the race still counts', { 23: { high: 125 } }, 'tp'],
    ['one bar later does not', { 24: { high: 125 } }, 'none'],
  ];
  it.each(race)('(a) %s', (_name, over, want) => {
    expect(raceTpSl(path(over), 0, 125, 105, true, 24)).toBe(want);
    expect(raceTpSl(mirrorBars(path(over), 230), 0, 105, 125, false, 24)).toBe(want);
  });

  // (b) an entry at 115 with the stop at 105 on a path resting at 112: stopped out, then back at the entry?
  const stop: Array<[string, Record<number, Partial<Bar>>, 'recovered' | 'stopped' | 'none']> = [
    ['the stop is never hit', {}, 'none'],
    ['hit one bar after the race', { 24: { low: 104, close: 106 } }, 'none'],
    ['hit, and the stop bar closes back at the entry', { 4: { low: 104, high: 117, close: 116 } }, 'recovered'],
    ['hit, and a later bar trades back at the entry', { 4: { low: 104, close: 106 }, 8: { high: 115 } }, 'recovered'],
    ['hit, and price never comes back', { 4: { low: 104, close: 106 } }, 'stopped'],
    ['the stop bar\'s high alone is no recovery', { 4: { low: 104, high: 116, close: 106 } }, 'stopped'],
    ['back in the last bar of the recovery window', { 4: { low: 104, close: 106 }, 16: { high: 115 } }, 'recovered'],
    ['back one bar later', { 4: { low: 104, close: 106 }, 17: { high: 115 } }, 'stopped'],
    ['only the first stop is read', { 4: { low: 104, close: 106 }, 20: { low: 104, high: 117, close: 116 } }, 'stopped'],
  ];
  it.each(stop)('(b) %s', (_name, over, want) => {
    expect(stopRecover(path(over, 112), 0, 115, 105, true, 24, 12)).toBe(want);
    expect(stopRecover(mirrorBars(path(over, 112), 230), 0, 115, 125, false, 24, 12)).toBe(want);
  });
});

describe('the control\'s zone and the free versions', () => {
  it('re-lays the served zone\'s distance and width, in ATR, from another price and ATR', () => {
    expect(placeControl({ lo: 100, hi: 110 }, 'support', 120, 10, 200, 20)).toEqual({ lo: 160, hi: 180 });
    expect(placeControl({ lo: 130, hi: 140 }, 'resistance', 120, 10, 200, 20)).toEqual({ lo: 220, hi: 240 });
    expect(placeControl({ lo: 100, hi: 110 }, 'support', 120, 10, 120, 10)).toEqual({ lo: 100, hi: 110 });
    // The test-only half-width control keeps the near edge.
    expect(placeControl({ lo: 100, hi: 110 }, 'support', 120, 10, 200, 20, 0.5)).toEqual({ lo: 170, hi: 180 });
    expect(placeControl({ lo: 130, hi: 140 }, 'resistance', 120, 10, 200, 20, 0.5)).toEqual({ lo: 220, hi: 230 });
  });

  it('turns lines into zones of the floor width, merging the ones that overlap', () => {
    const set = linesToSet([200, 100, 103, -5], 40);
    expect(set.zones.map((z) => [z.lo, z.hi, z.level, z.touches, z.rawLo, z.rawHi])).toEqual([[95, 108, 101.5, 2, 100, 103], [195, 205, 200, 1, 200, 200]]);
    expect(linesToSet([100], null)).toEqual({ atr: null, zones: [] });
  });

  it('computes the classic floor pivots and the round-number lines', () => {
    expect(floorPivots({ high: 110, low: 90, close: 100 })).toEqual([100, 110, 90, 120, 80, 130, 70]);
    expect(roundLines(1234)).toEqual([800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600]);
    expect(roundLines(120)).toEqual([80, 90, 100, 110, 120, 130, 140, 150, 160]);
  });
});

describe('the grid and the horizon', () => {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

  it('strides one entry window plus an offset, coprime with the day and with the timeframe\'s bar', () => {
    expect(TIMEFRAMES.map((t) => strideUnits(t))).toEqual([13, 49, 221, 1181]);
    for (const t of TIMEFRAMES) {
      expect(strideUnits(t)).toBeGreaterThanOrEqual(BT.entryBars * t.units);
      expect(gcd(strideUnits(t), 96), t.key).toBe(1);
      expect(gcd(strideUnits(t), t.units), t.key).toBe(1);
    }
  });

  it('keeps the control window and every label inside the horizon', () => {
    expect(TIMEFRAMES.map((t) => controlWindow(t))).toEqual([96, 96, 96, 24]);
    expect(labelBars()).toBe(36);
    expect(TIMEFRAMES.map((t) => maxHorizonBars(t))).toEqual([144, 144, 144, 72]);
  });

  it('reads the price at an instant as the close of the bar ending there', () => {
    const base = path({ 4: { close: 117, high: 118 } });
    expect(idxAt(base, T0 + 5 * M15)).toBe(5);
    expect(priceAt(base, T0 + 5 * M15)).toBe(117);
    expect(() => idxAt(base, T0)).toThrow(/not an instant/);
    expect(() => idxAt(base, T0 + 5 * M15 + 1)).toThrow(/not an instant/);
  });
});

// ── The reference: the registered rule, written a second time with the as-of cut done by arithmetic ──────────────
function asOfSet(data: CoinData, tf: Timeframe, t: number): ZoneSet {
  const bars = data.frames[tf.key];
  const n = Math.floor((t - bars[0].time) / tf.stepMs); // bars closed by t
  return zoneSetOf(bars.slice(Math.max(0, n - 300), n));
}

interface RefControl { t2: number; price2: number; atr2: number; zone: { lo: number; hi: number }; forced: boolean }

/** The first instant, t + 13 … t + 12 + window bars of the timeframe, where the re-laid zone touches no qualifying
 *  zone; the last one, forced, when there is none. */
function refControl(data: CoinData, tf: Timeframe, t: number, zone: Zone, side: Side, price: number, atr: number): RefControl | null {
  const window = tf.key === '1d' ? 24 : 96;
  let last: RefControl | null = null;
  for (let j = 13; j <= 12 + window; j++) {
    const t2 = t + j * tf.stepMs;
    const set2 = asOfSet(data, tf, t2);
    if (set2.atr === null) continue;
    const price2 = priceAt(data.frames['15m'], t2);
    const placed = placeControl(zone, side, price, atr, price2, set2.atr);
    const free = !set2.zones.some((z) => overlaps(placed, z));
    last = { t2, price2, atr2: set2.atr, zone: placed, forced: !free };
    if (free) return last;
  }
  return last;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** True when one event is what the reference derives for it: the served zone, its control, both labels. */
function eventMatches(data: CoinData, e: PairEvent): boolean {
  const tf = tfOf(e.tf);
  const base = data.frames['15m'];
  const set = asOfSet(data, tf, e.t);
  if (set.atr === null || set.atr !== e.atr || priceAt(base, e.t) !== e.price) return false;
  const served = servedOf(set, e.price);
  const zone = (e.side === 'support' ? served.supports : served.resistances)[e.rank - 1];
  if (!zone || zone.touches !== e.touches || zone.round !== e.round) return false;
  const c = refControl(data, tf, e.t, zone, e.side, e.price, e.atr);
  if (!c || c.t2 !== e.t2 || c.forced !== e.forced || c.price2 !== e.price2 || c.atr2 !== e.atr2) return false;
  return same(e.s, resolveZone(base, idxAt(base, e.t), zone, e.side, e.atr, tf)) && same(e.c, resolveZone(base, idxAt(base, c.t2), c.zone, e.side, c.atr2, tf));
}

function run(data: CoinData, cfg: Partial<RunConfig> & { startMs: number; endMs: number }, p: BtParams = BT): { tally: Tally; events: PairEvent[] } {
  const tally = new Tally();
  const events: PairEvent[] = [];
  runCoin(data, { params: p, crossTf: true, outcomes: true, onPair: (e) => events.push(e), ...cfg }, tally);
  return { tally, events };
}

// ── A hand-made coin: the zigzag of the zone test, then a scripted path ─────────────────────────────────────────
describe('one instant end to end, by hand', () => {
  const T = Date.UTC(2026, 0, 10);
  const TURNS = [1045, 1005, 1080, 1010, 1080, 1030, 1130, 1060, 1135, 1070, 1085, 1080, 1085, 1075];
  const mids = [TURNS[0]];
  for (let k = 1; k < TURNS.length; k++) for (let j = 1; j <= 5; j++) mids.push(TURNS[k - 1] + ((TURNS[k] - TURNS[k - 1]) * j) / 5);
  const before: Bar[] = mids.map((mid, i) => ({ time: T - (mids.length - i) * M15, open: i ? mids[i - 1] : mid, high: mid + 20, low: mid - 20, close: mid }));
  // Zones at T (ATR 40, price 1075): supports C [1040, 1060] MEDIUM and D [982.5, 992.5] WEAK round;
  // resistances A [1097.5, 1107.5] STRONG round and B [1147.5, 1157.5] WEAK.
  const script: Array<[number, number, number, number]> = [
    [1075, 1088, 1070, 1085], // 0  long take-profit 1087.5 touched; short stop 1080 touched
    [1085, 1086, 1055, 1058], // 1  C entered
    [1058, 1060, 1028, 1035], // 2  closes under C (1 close); the long stop at 1030 is hit
    [1035, 1078, 1034, 1076], // 3  closes back inside; back at the entry price
    [1076, 1101, 1075, 1099], // 4  C bounces (1100); A entered
    [1099, 1112, 1098, 1110], // 5  closes over A (1 close)
    [1110, 1115, 1108, 1112], // 6  closes over A again: A breaks
    [1112, 1113, 1090, 1092], // 7  closes back under A
  ];
  const after: Bar[] = script.map(([open, high, low, close], i) => ({ time: T + i * M15, open, high, low, close }));
  const tail = walk15({ seed: 1, key: 'tail', firstMs: T + script.length * M15, bars: 150 - script.length, startPrice: 1092, body: 1, wick: 1 });
  const data: CoinData = { coin: 'KA', frames: { '15m': [...before, ...after, ...tail] } };
  const base = data.frames['15m'];
  const i0 = before.length;
  const { tally, events } = run(data, { startMs: T, endMs: T + 150 * M15, timeframes: [M], sources: ['z1'], crossTf: false });
  const row = (key: string): number[] | undefined => tally.rows.get(`${key}|15m|${T / DAY}|KA`);
  const set = asOfSet(data, M, T);
  const [zD, zC, zA] = set.zones;
  const cC = refControl(data, M, T, zC, 'support', 1075, 40)!;
  const cA = refControl(data, M, T, zA, 'resistance', 1075, 40)!;
  const sum = (f: (e: PairEvent) => boolean): number => events.filter(f).length;

  it('evaluates exactly the one instant the horizon allows', () => {
    expect(tally.instants).toBe(1);
    expect(set.atr).toBe(40);
    expect(events.map((e) => [e.side, e.rank, e.touches, e.round, e.distanceAtr, e.widthAtr])).toEqual([
      ['support', 1, 3, false, 0.375, 0.5], ['support', 2, 2, true, 2.0625, 0.25], ['resistance', 1, 4, true, 0.5625, 0.25], ['resistance', 2, 2, false, 1.8125, 0.25],
    ]);
  });

  it('labels each served zone: C bounces, A breaks, D and B are never entered', () => {
    expect(events.map((e) => e.s)).toEqual([res(true, 'bounce', i0 + 2), res(false, null), res(true, 'break', i0 + 5, i0 + 6), res(false, null)]);
  });

  it('places each control by the registered rule and labels it on its own path', () => {
    expect(events.every((e) => eventMatches(data, e))).toBe(true);
    expect(events[0].t2).toBe(cC.t2);
    expect(events[2].t2).toBe(cA.t2);
    for (const e of events) expect((e.t2 - T) / M15).toBeGreaterThanOrEqual(13);
    for (const e of events) expect((e.t2 - T) / M15).toBeLessThanOrEqual(108);
  });

  it('tallies V1 and its descriptive cuts', () => {
    const control = [sum((e) => e.c.entered), sum((e) => e.c.outcome === 'bounce'), sum((e) => e.c.outcome === 'break'), sum((e) => e.forced)];
    expect(row('z1')).toEqual([4, 4, 2, 1, 1, ...control]);
    const served = (key: string): number[] => row(key)!.slice(0, 5);
    expect(served('z1.sup')).toEqual([2, 2, 1, 1, 0]);
    expect(served('z1.res')).toEqual([2, 2, 1, 0, 1]);
    expect(served('z1.M')).toEqual([1, 1, 1, 1, 0]);
    expect(served('z1.S')).toEqual([1, 1, 1, 0, 1]);
    expect(served('z1.W')).toEqual([2, 2, 0, 0, 0]);
    expect(served('z1.r1')).toEqual([2, 2, 2, 1, 1]);
    expect(served('z1.r2')).toEqual([2, 2, 0, 0, 0]);
    expect(row('z1.r3')).toBeUndefined();
    expect(served('z1.rnd1')).toEqual([2, 2, 1, 0, 1]);
    expect(served('z1.rnd0')).toEqual([2, 2, 1, 1, 0]);
    expect(served('z1.S0')).toEqual([1, 1, 1, 0, 1]);
    expect(row('z1.SS')).toBeUndefined();
    expect(Object.fromEntries(tally.sides)).toMatchObject({ z1: [2, 2], 'z1.sup': [2, 0], 'z1.res': [0, 2], v4a: [1, 1], 'v4a.long': [1, 0], 'v4a.short': [0, 1], v4b: [1, 1] });
  });

  it('tallies V4 (a): the take-profit before the opposing zone against the mirrored stop, each side', () => {
    // long: 0.5625 ATR to A less the 0.25 buffer = 0.3125 ATR -> 1087.5 / 1062.5: bar 0 trades 1088 first.
    // short: 0.375 ATR to C less the buffer = 0.125 ATR -> 1070 / 1080: bar 0 trades 1088, the stop.
    const cLong = raceTpSl(base, idxAt(base, cA.t2), cA.price2 + 0.3125 * cA.atr2, cA.price2 - 0.3125 * cA.atr2, true, 24) === 'tp' ? 1 : 0;
    const cShort = raceTpSl(base, idxAt(base, cC.t2), cC.price2 - 0.125 * cC.atr2, cC.price2 + 0.125 * cC.atr2, false, 24) === 'tp' ? 1 : 0;
    expect(row('v4a.long')).toEqual([1, 1, 1, 1, 0, 1, cLong, 0, cA.forced ? 1 : 0]);
    expect(row('v4a.short')).toEqual([1, 1, 1, 0, 0, 1, cShort, 0, cC.forced ? 1 : 0]);
    expect(row('v4a')).toEqual([2, 2, 2, 1, 0, 2, cLong + cShort, 0, (cA.forced ? 1 : 0) + (cC.forced ? 1 : 0)]);
  });

  it('tallies V4 (b): the stop beyond the protecting zone is hit and price recovers, each side', () => {
    // long: C's far edge is 0.875 ATR away, plus the buffer = 1.125 ATR -> stop 1030: hit at bar 2, back at 1075 at bar 3.
    // short: A's far edge is 0.8125 ATR away, plus the buffer = 1.0625 ATR -> stop 1117.5: never hit.
    const cLong = stopRecover(base, idxAt(base, cC.t2), cC.price2, cC.price2 - 1.125 * cC.atr2, true, 24, 12) === 'recovered' ? 1 : 0;
    const cShort = stopRecover(base, idxAt(base, cA.t2), cA.price2, cA.price2 + 1.0625 * cA.atr2, false, 24, 12) === 'recovered' ? 1 : 0;
    expect(row('v4b.long')).toEqual([1, 1, 1, 1, 0, 1, cLong, 0, cC.forced ? 1 : 0]);
    expect(row('v4b.short')).toEqual([1, 1, 1, 0, 0, 1, cShort, 0, cA.forced ? 1 : 0]);
    expect(row('v4b')).toEqual([2, 2, 2, 1, 0, 2, cLong + cShort, 0, (cA.forced ? 1 : 0) + (cC.forced ? 1 : 0)]);
  });

  it('tallies V5: follow-through to the next zone after one close and after two', () => {
    // C: one close under it, then a close back above before D is reached. A: one close and two closes over it,
    // then a close back under before B is reached.
    expect(zD.hi).toBe(992.5);
    expect(row('v5.b1')!.slice(2, 4)).toEqual([2, 0]);
    expect(row('v5.b2')!.slice(2, 4)).toEqual([1, 0]);
  });

  it('writes one csv line per arm, timeframe, day and coin', () => {
    const lines = tally.csv().trimEnd().split('\n');
    expect(lines[0]).toBe(`key,tf,day,coin,${COLS.join(',')}`);
    expect(COLS).toEqual(['served', 'matched', 'sN', 'sHit', 'sBreak', 'cN', 'cHit', 'cBreak', 'forced']);
    const ids = lines.slice(1).map((l) => l.split(',').slice(0, 4).join('|'));
    expect(ids).toEqual([...tally.rows.keys()].sort());
    expect(lines).toContain(`z1.sup,15m,${T / DAY},KA,${row('z1.sup')!.join(',')}`);
  });
});

// ── Seeded walks through the whole harness ───────────────────────────────────────────────────────────────────────
const F = Date.UTC(2022, 0, 1);
const K = 10_000_000;
const SEEDED = { startMs: F + 30 * DAY, endMs: F + 130 * DAY, evalDays: { '15m': 6, '1h': 12, '4h': 40, '1d': 28 } };
const seededCoin = (): CoinData => synthCoin('S1', { seed: 7, key: 'engine', firstMs: F, bars: 130 * 96, startPrice: K / 2 });
const mirrorCoin = (c: CoinData, k: number): CoinData => ({ coin: c.coin, frames: Object.fromEntries(Object.entries(c.frames).map(([key, bars]) => [key, mirrorBars(bars, k)])) });

/** Every event of a seeded run is what the reference derives. */
function controlsFollowTheRule(p: BtParams): { ok: boolean; events: number; forced: number } {
  const data = seededCoin();
  const { events } = run(data, { ...SEEDED, sources: ['z1'] }, p);
  return { ok: events.every((e) => eventMatches(data, e)), events: events.length, forced: events.filter((e) => e.forced).length };
}

describe('the control, on seeded walks', () => {
  it('is the first disjoint candidate in time order — or the last one, flagged, when there is none', { timeout: 120_000 }, () => {
    const r = controlsFollowTheRule(BT);
    expect(r.ok).toBe(true);
    expect(r.events).toBeGreaterThan(300);
    expect(r.forced).toBeGreaterThan(0);
  });

  it('turns red when the control ignores disjointness', { timeout: 120_000 }, () => {
    expect(controlsFollowTheRule({ ...BT, controlDisjoint: false }).ok).toBe(false);
  });

  it('turns red when one bar past the instant is read', { timeout: 120_000 }, () => {
    expect(controlsFollowTheRule({ ...BT, v0: { ...BT.v0, lookaheadBars: 1 } }).ok).toBe(false);
  });

  it('never drops a served zone, and the tally is the sum of its events', { timeout: 120_000 }, () => {
    const { tally, events } = run(seededCoin(), { ...SEEDED, sources: ['z1'] });
    const total = (key: string): number[] => {
      const out = new Array<number>(COLS.length).fill(0);
      for (const [id, r] of tally.rows) if (id.startsWith(`${key}|`)) r.forEach((v, i) => (out[i] += v));
      return out;
    };
    const of = (f: (e: PairEvent) => boolean): number[] => {
      const es = events.filter(f);
      const n = (g: (e: PairEvent) => boolean): number => es.filter(g).length;
      return [es.length, es.length, n((e) => e.s.entered), n((e) => e.s.outcome === 'bounce'), n((e) => e.s.outcome === 'break'),
        n((e) => e.c.entered), n((e) => e.c.outcome === 'bounce'), n((e) => e.c.outcome === 'break'), n((e) => e.forced)];
    };
    expect(total('z1')).toEqual(of(() => true));
    expect(total('z1')[0]).toBe(total('z1')[1]); // served === matched: no zone without a control
    expect(total('z1.sup')).toEqual(of((e) => e.side === 'support'));
    expect(total('z1.res')).toEqual(of((e) => e.side === 'resistance'));
    expect(total('z1.W')).toEqual(of((e) => e.touches === 2));
    expect(total('z1.M')).toEqual(of((e) => e.touches === 3));
    expect(total('z1.S')).toEqual(of((e) => e.touches >= 4));
    for (const r of [1, 2, 3]) expect(total(`z1.r${r}`)).toEqual(of((e) => e.rank === r));
    expect(total('z1.rnd1')).toEqual(of((e) => e.round));
    expect(total('z1.rnd0')).toEqual(of((e) => !e.round));
    expect(total('z1.SS')).toEqual(of((e) => e.agree >= 1));
    expect(total('z1.SSS')).toEqual(of((e) => e.agree >= 2));
    expect(total('z1.S0')).toEqual(of((e) => e.touches >= 4 && e.agree === 0));
    expect(total('z1.SS')[0]).toBeGreaterThan(0);
    for (const e of events) {
      const tf = tfOf(e.tf);
      const j = (e.t2 - e.t) / tf.stepMs;
      expect(Number.isInteger(j) && j >= 13 && j <= 12 + controlWindow(tf)).toBe(true);
    }
  });

  it('walks the registered grid: one stride apart, inside the evaluation days and the horizon', () => {
    const { tally, events } = run(seededCoin(), { ...SEEDED, sources: ['z1'] });
    let want = 0;
    for (const tf of TIMEFRAMES) {
      const ts = [...new Set(events.filter((e) => e.tf === tf.key).map((e) => e.t))].sort((a, b) => a - b);
      const cap = SEEDED.startMs + SEEDED.evalDays[tf.key as keyof typeof SEEDED.evalDays] * DAY;
      const stride = strideUnits(tf) * M15;
      let n = 0;
      for (let t = SEEDED.startMs; t + maxHorizonBars(tf) * tf.stepMs <= SEEDED.endMs && Math.floor(t / DAY) * DAY < cap; t += stride) n++;
      want += n;
      expect(ts.every((t) => (t - SEEDED.startMs) % stride === 0), tf.key).toBe(true);
      expect(ts.length, tf.key).toBeLessThanOrEqual(n);
      expect(ts.length, tf.key).toBeGreaterThan(0);
    }
    expect(tally.instants).toBe(want);
  });

  it('the label-free skeleton serves and matches the same zones and resolves nothing', { timeout: 120_000 }, () => {
    const data = seededCoin();
    const full = run(data, SEEDED).tally;
    const skeleton = new Tally();
    let called = 0;
    runCoin(data, { params: BT, crossTf: true, outcomes: false, onPair: () => called++, ...SEEDED }, skeleton);
    expect(called).toBe(0);
    expect([...skeleton.rows.keys()].sort()).toEqual([...full.rows.keys()].filter((id) => !id.startsWith('v5.')).sort());
    for (const [id, r] of skeleton.rows) {
      expect(r.slice(2, 8), id).toEqual([0, 0, 0, 0, 0, 0]);
      expect([r[0], r[1], r[8]], id).toEqual([full.rows.get(id)![0], full.rows.get(id)![1], full.rows.get(id)![8]]);
    }
    expect(Object.fromEntries(skeleton.sides)).toEqual(Object.fromEntries(full.sides));
  });
});

describe('the mirror property, on whole runs', () => {
  const swap = (key: string): string =>
    ({ 'z1.sup': 'z1.res', 'z1.res': 'z1.sup', 'v4a.long': 'v4a.short', 'v4a.short': 'v4a.long', 'v4b.long': 'v4b.short', 'v4b.short': 'v4b.long' } as Record<string, string>)[key] ?? key;

  it('every count of every arm is unchanged under p -> K - p, with the sides swapped', { timeout: 120_000 }, () => {
    const data = seededCoin();
    const a = run(data, SEEDED).tally;
    const b = run(mirrorCoin(data, K), SEEDED).tally;
    const mirrored = new Map<string, number[]>();
    for (const [id, r] of a.rows) {
      const [key, ...rest] = id.split('|');
      mirrored.set([swap(key), ...rest].join('|'), r);
    }
    expect(a.rows.size).toBeGreaterThan(500);
    expect(new Set([...a.rows.keys()].map((id) => id.split('|')[0]))).toEqual(new Set([
      'z1', 'z1.W', 'z1.M', 'z1.S', 'z1.sup', 'z1.res', 'z1.r1', 'z1.r2', 'z1.r3', 'z1.rnd0', 'z1.rnd1', 'z1.SS', 'z1.SSS', 'z1.S0',
      'floor', 'pdhl', 'rnd', 'v4a', 'v4a.long', 'v4a.short', 'v4b', 'v4b.long', 'v4b.short', 'v5.b1', 'v5.b2',
    ]));
    expect(Object.fromEntries([...b.rows].sort())).toEqual(Object.fromEntries([...mirrored].sort()));
    for (const [key, [first, second]] of a.sides) expect(b.sides.get(swap(key)), key).toEqual([second, first]);
    expect(b.instants).toBe(a.instants);
  });
});
