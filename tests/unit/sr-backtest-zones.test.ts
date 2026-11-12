// EDGE-SR-LEVEL-BACKTEST-W1 CH1 — zone rule Z1 (src/scripts/sr-backtest/zones.ts): known answers, the mirror
// property, the as-of cut and the parity fixture. Synthetic candles only.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Bar } from '../../src/scripts/sr-probe/level-v0.js';
import { BT, M15, TIMEFRAMES, type BtParams } from '../../src/scripts/sr-backtest/spec.js';
import {
  holdsRound, labelOf, levelCheck, overlaps, roundStep, servedOf, superStrongOf, zoneSetAsOf, zoneSetOf,
  type ServedFrame, type ServedZone, type Zone,
} from '../../src/scripts/sr-backtest/zones.js';
import { FIXTURE, FIXTURE_PATH, fixtureText } from '../../src/scripts/sr-backtest/fixture.js';
import { aggregate, walk15 } from '../../src/scripts/sr-backtest/synth.js';

const H = 3_600_000;
/** One bar past the instant is read: the mutation that must turn the known answer and the mirror check red. */
const LOOKAHEAD: BtParams = { ...BT, v0: { ...BT.v0, lookaheadBars: 1 } };

/** A zigzag through `turns` (mid prices), `per` bars a leg; every bar is mid ± 20 and closes at its mid. With
 *  legs of at most 100, every true range is exactly 40, so ATR14 is exactly 40: merge gap 10, width floor 10. */
function zigzag(turns: readonly number[], stepMs: number, endMs: number, per = 5): Bar[] {
  const mids = [turns[0]];
  for (let k = 1; k < turns.length; k++) for (let j = 1; j <= per; j++) mids.push(turns[k - 1] + ((turns[k] - turns[k - 1]) * j) / per);
  return mids.map((mid, i) => ({ time: endMs - (mids.length - i) * stepMs, open: i ? mids[i - 1] : mid, high: mid + 20, low: mid - 20, close: mid }));
}

const T = Date.UTC(2026, 0, 10);
// Pivot lows 985, 990 | 1010 | 1040, 1050, 1060 · pivot highs 1100, 1100, 1105, 1105 | 1150, 1155.
const TURNS = [1045, 1005, 1080, 1010, 1080, 1030, 1130, 1060, 1135, 1070, 1085, 1080, 1085, 1075];
const BARS_15M = zigzag(TURNS, M15, T);
// 1h: two highs at 1105 and two lows at 1040 — zones [1100, 1110] and [1035, 1045].
const BARS_1H = zigzag([1000, 1085, 1060, 1085, 1060, 1085], H, T);
// 4h: two highs at 1100 — one zone, [1095, 1105].
const BARS_4H = zigzag([1000, 1080, 1040, 1080, 1040], 4 * H, T);

const zoneRow = (z: Zone): unknown[] => [z.lo, z.hi, z.level, z.touches, z.label, z.round];
const servedRow = (z: ServedZone): unknown[] => [z.lo, z.hi, z.touches, z.label, z.round, z.rank, z.superStrong, z.agree];
const frameRows = (f: ServedFrame): unknown => ({ key: f.key, atr: f.atr, supports: f.supports.map(servedRow), resistances: f.resistances.map(servedRow), at: f.at.map(servedRow) });

// The four zones of the 15m zigzag, by hand.
const D = [982.5, 992.5, 987.5, 2, 'WEAK', true];
const C = [1040, 1060, 1050, 3, 'MEDIUM', false];
const A = [1097.5, 1107.5, 1102.5, 4, 'STRONG', true];
const B = [1147.5, 1157.5, 1152.5, 2, 'WEAK', false];

const EXPECTED_FRAMES = [
  {
    key: '15m', atr: 40,
    supports: [[1040, 1060, 3, 'MEDIUM', false, 1, 'PAIR', ['1h']], [982.5, 992.5, 2, 'WEAK', true, 2, 'NONE', []]],
    resistances: [[1097.5, 1107.5, 4, 'STRONG', true, 1, 'TRIPLE', ['1h', '4h']], [1147.5, 1157.5, 2, 'WEAK', false, 2, 'NONE', []]],
    at: [],
  },
  {
    key: '1h', atr: 40,
    supports: [[1035, 1045, 2, 'WEAK', false, 1, 'PAIR', ['15m']]],
    resistances: [[1100, 1110, 2, 'WEAK', true, 1, 'TRIPLE', ['15m', '4h']]],
    at: [],
  },
  { key: '4h', atr: 40, supports: [], resistances: [[1095, 1105, 2, 'WEAK', true, 1, 'TRIPLE', ['15m', '1h']]], at: [] },
];

/** The level check at T on the three zigzags, each followed by one wild bar that opens AT the instant. */
function knownAnswer(p: BtParams): unknown {
  const wild = (bars: Bar[]): Bar[] => [...bars, { time: T, open: 1075, high: 1475, low: 1075, close: 1400 }];
  return levelCheck({
    price: 1075, instantMs: T,
    frames: [{ key: '15m', stepMs: M15, bars: wild(BARS_15M) }, { key: '1h', stepMs: H, bars: wild(BARS_1H) }, { key: '4h', stepMs: 4 * H, bars: wild(BARS_4H) }],
  }, p).map(frameRows);
}

describe('Z1 known answers', () => {
  it('builds the zones of a hand-made zigzag: extent, width floor, touches, label and round flag', () => {
    const set = zoneSetAsOf(BARS_15M, M15, T);
    expect(set.atr).toBe(40);
    // The lone pivot at 1010 is no zone; 1040-1050-1060 merges on a gap of exactly 0.25 ATR.
    expect(set.zones.map(zoneRow)).toEqual([D, C, A, B]);
    expect(set.zones.map((z) => [z.rawLo, z.rawHi])).toEqual([[985, 990], [1040, 1060], [1100, 1105], [1150, 1155]]);
  });

  it('serves the nearest zones each side of the price, nearest first, with distances in ATR', () => {
    const [f] = levelCheck({ price: 1075, instantMs: T, frames: [{ key: '15m', stepMs: M15, bars: BARS_15M }] });
    expect(f.supports.map((z) => [z.lo, z.hi, z.rank, z.side, z.distanceAtr, z.widthAtr])).toEqual([[1040, 1060, 1, 'support', 0.375, 0.5], [982.5, 992.5, 2, 'support', 2.0625, 0.25]]);
    expect(f.resistances.map((z) => [z.lo, z.hi, z.rank, z.side, z.distanceAtr, z.widthAtr])).toEqual([[1097.5, 1107.5, 1, 'resistance', 0.5625, 0.25], [1147.5, 1157.5, 2, 'resistance', 1.8125, 0.25]]);
    expect(f.supports[0].distancePct).toBeCloseTo((15 / 1075) * 100, 12);
    expect(f.at).toEqual([]);
    expect(f.supports.every((z) => z.superStrong === 'NONE' && z.agree.length === 0)).toBe(true);
  });

  it('reports a zone holding the price as `at`, on neither side', () => {
    const [f] = levelCheck({ price: 1050, instantMs: T, frames: [{ key: '15m', stepMs: M15, bars: BARS_15M }] });
    expect(f.at.map((z) => [z.lo, z.hi, z.side, z.distanceAtr])).toEqual([[1040, 1060, 'at', 0]]);
    expect(f.supports.map((z) => z.lo)).toEqual([982.5]);
    expect(f.resistances.map((z) => z.lo)).toEqual([1097.5, 1147.5]);
    // An edge is inside the zone.
    const edge = servedOf(zoneSetAsOf(BARS_15M, M15, T), 1060);
    expect(edge.at.map((z) => z.lo)).toEqual([1040]);
  });

  it('caps the served set at three a side', () => {
    const z = (lo: number): Zone => ({ lo, hi: lo + 1, level: lo + 0.5, touches: 2, label: 'WEAK', round: false, rawLo: lo, rawHi: lo + 1 });
    const s = servedOf({ atr: 1, zones: [10, 20, 30, 40, 50, 60, 70, 80, 90].map(z) }, 55);
    expect(s.supports.map((x) => x.lo)).toEqual([50, 40, 30]);
    expect(s.resistances.map((x) => x.lo)).toEqual([60, 70, 80]);
    expect(servedOf({ atr: 1, zones: [10, 20].map(z) }, 55, { ...BT, maxServed: 1 }).supports.map((x) => x.lo)).toEqual([20]);
  });

  it('marks Super Strong from the other chosen timeframes at the same instant: pair, triple, none', () => {
    expect(knownAnswer(BT)).toEqual(EXPECTED_FRAMES);
    expect(superStrongOf([])).toBe('NONE');
    expect(superStrongOf(['1h'])).toBe('PAIR');
    expect(superStrongOf(['1h', '4h'])).toBe('TRIPLE');
    expect(superStrongOf(['1h', '4h', '1d'])).toBe('TRIPLE');
  });

  it('labels by the as-of touch count alone', () => {
    expect([1, 2, 3, 4, 5, 9].map((n) => labelOf(n))).toEqual(['WEAK', 'WEAK', 'MEDIUM', 'STRONG', 'STRONG', 'STRONG']);
  });

  it('flags round numbers on the two-significant-digit grid', () => {
    expect([1234, 1000, 999, 100, 99.99, 0.0123, 5_000_000, 64_250].map(roundStep)).toEqual([100, 100, 10, 10, 1, 0.001, 100_000, 1000]);
    expect(Number.isNaN(roundStep(0))).toBe(true);
    expect(holdsRound(982.5, 992.5, 987.5)).toBe(true); // 990
    expect(holdsRound(1147.5, 1157.5, 1152.5)).toBe(false); // nearest are 1100 and 1200
    expect(holdsRound(1100, 1100, 1100)).toBe(true);
    expect(holdsRound(1100.5, 1199.5, 1150)).toBe(false);
    expect(holdsRound(1, 2, 0)).toBe(false);
  });

  it('treats a shared edge as an overlap', () => {
    expect(overlaps({ lo: 1, hi: 2 }, { lo: 2, hi: 3 })).toBe(true);
    expect(overlaps({ lo: 1, hi: 2 }, { lo: 2.001, hi: 3 })).toBe(false);
    expect(overlaps({ lo: 1, hi: 5 }, { lo: 2, hi: 3 })).toBe(true);
  });

  it('has no zones below fifteen bars, and none without a pivot pair', () => {
    expect(zoneSetOf(BARS_15M.slice(0, 14))).toEqual({ atr: null, zones: [] });
    const flatRise = Array.from({ length: 40 }, (_, i): Bar => ({ time: i * M15, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i }));
    expect(zoneSetOf(flatRise).zones).toEqual([]);
  });
});

describe('the as-of cut', () => {
  it('ignores a bar that opens at the instant — and the known answer turns red when one bar past it is read', () => {
    expect(knownAnswer(BT)).toEqual(EXPECTED_FRAMES);
    expect(knownAnswer(LOOKAHEAD)).not.toEqual(EXPECTED_FRAMES);
  });

  it('uses only the last 300 closed bars', () => {
    const long = walk15({ seed: 5, key: 'asof', firstMs: Date.UTC(2024, 0, 1), bars: 900 });
    const t = long[700].time;
    expect(zoneSetAsOf(long, M15, t)).toEqual(zoneSetOf(long.slice(400, 700)));
    expect(zoneSetAsOf(long, M15, t)).not.toEqual(zoneSetOf(long.slice(399, 700)));
  });
});

// ── AC1.2: the mirror p -> K - p ────────────────────────────────────────────────────────────────────────────────
const K = 10_000_000;
const mirrorBars = (bars: readonly Bar[], k: number): Bar[] => bars.map((b) => ({ time: b.time, open: k - b.open, high: k - b.low, low: k - b.high, close: k - b.close }));
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6;

/** True when `m` is `o` seen in the mirror: supports and resistances swapped, every zone reflected. */
function isMirror(o: ServedFrame[], m: ServedFrame[], k: number): boolean {
  const same = (x: ServedZone[], y: ServedZone[]): boolean =>
    x.length === y.length && x.every((z, i) => {
      const w = y[i];
      return near(w.lo, k - z.hi) && near(w.hi, k - z.lo) && near(w.level, k - z.level) && w.touches === z.touches && w.label === z.label && w.round === z.round
        && w.rank === z.rank && w.superStrong === z.superStrong && w.agree.join() === z.agree.join() && near(w.distanceAtr, z.distanceAtr) && near(w.widthAtr, z.widthAtr);
    });
  return o.length === m.length && o.every((f, i) => f.key === m[i].key && f.atr === m[i].atr && same(f.supports, m[i].resistances) && same(f.resistances, m[i].supports)
    && same([...f.at].reverse(), m[i].at));
}

/** The level check on the FULL series against the level check on the mirrored series cut at the instant. */
function mirrorHolds(frames: Array<{ key: string; stepMs: number; bars: Bar[] }>, instantMs: number, price: number, k: number, p: BtParams): boolean {
  const full = levelCheck({ price, instantMs, frames }, p);
  const cut = frames.map((f) => ({ ...f, bars: mirrorBars(f.bars.filter((b) => b.time + f.stepMs <= instantMs), k) }));
  return isMirror(full, levelCheck({ price: k - price, instantMs, frames: cut }, p), k);
}

/** 200 seeded walks, one to three timeframes each; false as soon as one walk breaks the property. */
function mirrorHoldsOnWalks(p: BtParams): boolean {
  const first = Date.UTC(2023, 0, 1);
  for (let i = 0; i < 200; i++) {
    const base = walk15({ seed: 20261112, key: `mirror|${i}`, firstMs: first, bars: 96 * 60, startPrice: K / 2 });
    const instantMs = first + (96 * 55 + ((i * 37) % 96)) * M15;
    const frames = TIMEFRAMES.slice(0, 3).slice(0, 1 + (i % 3)).map((tf) => ({ key: tf.key, stepMs: tf.stepMs, bars: tf.key === '15m' ? base : aggregate(base, tf.stepMs) }));
    const price = base[(instantMs - first) / M15 - 1].close;
    if (!mirrorHolds(frames, instantMs, price, K, p)) return false;
  }
  return true;
}

describe('the mirror property', () => {
  // The hand-made zigzags lifted by 4000 and each followed by one wild bar that opens at the instant. Every price
  // then sits in one decade, so the round grid (step 100) maps onto itself under p -> 10200 - p.
  const lift = (bars: readonly Bar[]): Bar[] =>
    [...bars, { time: T, open: 1075, high: 1475, low: 1075, close: 1400 }].map((b) => ({ time: b.time, open: b.open + 4000, high: b.high + 4000, low: b.low + 4000, close: b.close + 4000 }));
  const zig = [{ key: '15m', stepMs: M15, bars: lift(BARS_15M) }, { key: '1h', stepMs: H, bars: lift(BARS_1H) }, { key: '4h', stepMs: 4 * H, bars: lift(BARS_4H) }];
  const KZ = 10_200;

  it('holds on the hand-made fixture: supports become resistances, labels and flags unchanged', () => {
    expect(mirrorHolds(zig, T, 5075, KZ, BT)).toBe(true);
    const [m] = levelCheck({ price: KZ - 5075, instantMs: T, frames: [{ key: '15m', stepMs: M15, bars: mirrorBars(zig[0].bars, KZ) }] });
    expect(m.supports.map((z) => [z.lo, z.hi, z.label, z.round])).toEqual([[5092.5, 5102.5, 'STRONG', true], [5042.5, 5052.5, 'WEAK', false]]);
    expect(m.resistances.map((z) => [z.lo, z.hi, z.label, z.round])).toEqual([[5140, 5160, 'MEDIUM', false], [5207.5, 5217.5, 'WEAK', false]]);
  });

  it('holds on 200 seeded random walks', { timeout: 120_000 }, () => {
    expect(mirrorHoldsOnWalks(BT)).toBe(true);
  });

  it('turns red when one bar past the instant is read', { timeout: 120_000 }, () => {
    expect(mirrorHolds(zig, T, 5075, KZ, LOOKAHEAD)).toBe(false);
    expect(mirrorHoldsOnWalks(LOOKAHEAD)).toBe(false);
  });
});

// ── AC1.5: the parity fixture ───────────────────────────────────────────────────────────────────────────────────
describe('the parity fixture', () => {
  const text = readFileSync(FIXTURE_PATH, 'utf8');
  const doc = JSON.parse(text) as { header: { rule: string; module: string; windowsPerTimeframe: number; zone: string[]; params: Record<string, number> }; windows: Array<{ id: string; frames: string[]; out: Array<{ key: string; supports: unknown[][]; resistances: unknown[][] }> }> };

  it('regenerates byte-identical from the seeded generator', { timeout: 300_000 }, () => {
    expect(fixtureText() === text).toBe(true);
  });

  it('holds at least 200 windows for each timeframe, with one to three chosen timeframes', () => {
    expect(FIXTURE.windowsPerTimeframe).toBeGreaterThanOrEqual(200);
    for (const tf of TIMEFRAMES) {
      const own = doc.windows.filter((w) => w.frames[0] === tf.key);
      expect(own.length, tf.key).toBe(FIXTURE.windowsPerTimeframe);
      expect(new Set(own.map((w) => w.frames.length)), tf.key).toEqual(new Set([1, 2, 3]));
    }
    expect(new Set(doc.windows.map((w) => w.id)).size).toBe(4 * FIXTURE.windowsPerTimeframe);
  });

  it('states the rule it serves and exercises every label and flag', () => {
    expect(doc.header.rule).toBe('Z1');
    expect(doc.header.module).toBe('src/scripts/sr-backtest/zones.ts#levelCheck');
    expect(doc.header.zone).toEqual(['lo', 'hi', 'touches', 'label', 'round', 'rank', 'superStrong', 'agree']);
    expect(doc.header.params).toEqual({ lookbackBars: 300, pivotK: 3, atrPeriod: 14, mergeAtrMult: 0.25, minTouches: 2, minWidthAtr: 0.25, maxServed: 3, mediumTouches: 3, strongTouches: 4 });
    const zones = doc.windows.flatMap((w) => w.out.flatMap((f) => [...f.supports, ...f.resistances]));
    expect(new Set(zones.map((z) => z[3]))).toEqual(new Set(['W', 'M', 'S']));
    expect(new Set(zones.map((z) => z[4]))).toEqual(new Set([0, 1]));
    expect(new Set(zones.map((z) => z[5]))).toEqual(new Set([1, 2, 3]));
    expect(new Set(zones.map((z) => z[6]))).toEqual(new Set(['NONE', 'PAIR', 'TRIPLE']));
  });
});
