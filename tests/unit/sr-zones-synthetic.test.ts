/**
 * SR-ZONES-W1 AC1.3 — the formula on synthetic series whose answer is known by construction:
 *  - planted clusters → the expected ladder, order and edges;
 *  - a series at a new high → no_zone_above (and the mirror, no_zone_below);
 *  - a flip series → former_support with the right broke_at (and the mirror, former_resistance);
 * plus the per-zone facts (distance, touches, tests, last touch), flags, volume_vs_20, overlaps and the summary.
 *
 * Series shape (SeriesBuilder): trend candles move 6 with 0.5 wicks; a base at level L is candles
 * (open L+2, high L+4, low L, close L+3) opened with a gap, so its support edges are [L, L+2] by construction.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSrZones,
  wilderAtr,
  attachSrZoneOverlaps,
  type SrZone,
  type SrZonesFrame,
} from '../../src/lib/sr-zones/zones.js';
import { buildSrZonesSummary } from '../../src/lib/sr-zones/summary.js';
import { SeriesBuilder } from './sr-zones-helpers.js';

function frameOf(candles: SeriesBuilder['candles'], price: number): SrZonesFrame {
  const r = computeSrZones(candles, candles.length - 1, price);
  if (!r.ok) throw new Error(r.reason);
  return r.frame;
}
const iso = (ms: number): string => new Date(ms).toISOString();
const edges = (z: SrZone): [number, number] => [z.low, z.high];

/** Three bases, each older and lower than the next; two tops above the final price. */
function ladderSeries() {
  const A = { first: 0 };
  const B = { first: 0 };
  const C = { first: 0 };
  const tops: number[] = [];
  const b = new SeriesBuilder(150);
  b.trendTo(96).base(87, 6, A).trendTo(162);
  tops.push(b.candles.length - 1);
  b.trendTo(108).base(99, 6, B).trendTo(156);
  tops.push(b.candles.length - 1);
  b.trendTo(120).base(111, 6, C).trendTo(132);
  const t = b.candles.length - 1;
  const atr = wilderAtr(b.candles, t)[t] as number;
  return { candles: b.candles, A, B, C, tops, t, atr };
}

describe('SR-ZONES-W1 AC1.3 — planted clusters', () => {
  const s = ladderSeries();
  const price = 132;
  const f = frameOf(s.candles, price);

  it('precondition: ATR sits where the bands separate a base low from its high (4 < ATR < 8)', () => {
    expect(s.atr).toBeGreaterThan(4);
    expect(s.atr).toBeLessThan(8);
  });

  it('support ladder: newest base first, each next one older and lower, edges [L, L+2]', () => {
    expect(f.support.map((z) => z.rank)).toEqual([1, 2, 3]);
    expect(f.support.map(edges)).toEqual([
      [111, 113],
      [99, 101],
      [87, 89],
    ]);
    const firsts = [s.C.first, s.B.first, s.A.first].map((i) => iso(s.candles[i].time));
    expect(f.support.map((z) => z.formed_from)).toEqual(firsts);
    expect(f.support.map((z) => z.formed_to)).toEqual(firsts);
    // band 0.5 × ATR < 4 keeps base C's low out of zone 1; bands 1 and 1.5 × ATR take each base's low and swing low.
    expect(f.support.map((z) => z.members)).toEqual([1, 3, 3]);
  });

  it('resistance ladder: the newer top first, then the older and higher one; narrow zones widened to 0.25 × ATR', () => {
    const w = 0.25 * s.atr;
    expect(f.resistance.map((z) => z.rank)).toEqual([1, 2]);
    expect(f.resistance[0].low).toBe(156);
    expect(f.resistance[0].high).toBeCloseTo(156 + w, 4);
    expect(f.resistance[1].low).toBe(162);
    expect(f.resistance[1].high).toBeCloseTo(162 + w, 4);
    expect(f.resistance.map((z) => z.formed_from)).toEqual([s.tops[1], s.tops[0]].map((i) => iso(s.candles[i].time)));
  });

  it('per-zone facts on support 1: distance, touches, tests, last touch, state', () => {
    const z = f.support[0];
    expect(z.distance_pct).toBe(Math.round(((price - 113) / price) * 100 * 100) / 100);
    // 6 base-C candles + 4 trend candles (114 ↔ 108) crossing 111–113 earlier in the series.
    expect(z.touch_bars_90).toBe(10);
    // Each base-C candle came from a close above 113, traded to 111 and closed back above.
    expect(z.tests_30).toBe(6);
    expect(z.last_touch).toBe(iso(s.candles[s.C.first + 5].time));
    expect(z.state).toBe('intact');
    expect(z.broke_at).toBeNull();
    expect(z.overlaps).toEqual([]);
  });

  it('flags and volume on a clean ladder', () => {
    expect(f.flags).toEqual([]);
    expect(f.volume_vs_20).toBe(1);
  });

  it('price inside a zone: distance 0 and the price_inside_zone flag', () => {
    const inside = frameOf(s.candles, 112);
    expect(edges(inside.support[0])).toEqual([111, 113]);
    expect(inside.support[0].distance_pct).toBe(0);
    expect(inside.resistance[0].low).toBe(114);
    expect(inside.flags).toEqual(['price_inside_zone']);
  });
});

describe('SR-ZONES-W1 AC1.3 — a series at a new high or low', () => {
  it('new high: nothing above price → no_zone_above', () => {
    const b = new SeriesBuilder(60).trendTo(120).trendTo(102).trendTo(180);
    const f = frameOf(b.candles, 181);
    expect(f.resistance).toEqual([]);
    expect(f.support.length).toBeGreaterThan(0);
    expect(f.flags).toEqual(['no_zone_above']);
  });

  it('new low: nothing below price → no_zone_below', () => {
    const b = new SeriesBuilder(180).trendTo(120).trendTo(138).trendTo(60);
    const f = frameOf(b.candles, 59);
    expect(f.support).toEqual([]);
    expect(f.resistance.length).toBeGreaterThan(0);
    expect(f.flags).toEqual(['no_zone_below']);
  });
});

describe('SR-ZONES-W1 AC1.3 — flips', () => {
  it('a base price came down into, then closed below twice → former_support, broke_at = the second close', () => {
    const base = { first: 0 };
    const b = new SeriesBuilder(150).trendTo(108).base(99, 6, base);
    const firstBreak = b.candles.length; // close 96, below the zone
    b.trendTo(60);
    const f = frameOf(b.candles, 60);
    expect(f.resistance).toHaveLength(1);
    const z = f.resistance[0];
    expect(z.formed_from).toBe(iso(b.candles[base.first].time));
    expect(z.low).toBe(102);
    expect(z.state).toBe('former_support');
    expect(z.broke_at).toBe(iso(b.candles[firstBreak + 1].time));
    expect(f.flags).toEqual(['no_zone_below']);
  });

  it('one close below, then a close back inside, is not a flip', () => {
    const base = { first: 0 };
    const b = new SeriesBuilder(186).trendTo(108).base(99, 6, base);
    b.push(102, 102.5, 95.5, 96); // one close below the zone [102, 102 + 0.25 × ATR]
    b.push(96, 103, 95.8, 102.8); // back inside
    const f = frameOf(b.candles, 102.8);
    const z = f.resistance[0];
    expect(z.formed_from).toBe(iso(b.candles[base.first].time));
    expect(z.low).toBe(102);
    expect(z.state).toBe('intact');
    expect(z.broke_at).toBeNull();
    expect(f.flags).toContain('price_inside_zone');
  });

  it('mirror: a base price came up into, then closed above twice → former_resistance', () => {
    const b = new SeriesBuilder(60).trendTo(96);
    const first = b.candles.length;
    for (let i = 0; i < 6; i++) b.push(102, 103, 99, 101); // red base: support edges [99, 101], closes at 101
    const firstBreak = b.candles.length; // close 107
    b.trendTo(149);
    const f = frameOf(b.candles, 150);
    const z = f.support[0];
    expect(z.formed_from).toBe(iso(b.candles[first].time));
    expect(edges(z)).toEqual([99, 101]);
    expect(z.state).toBe('former_resistance');
    expect(z.broke_at).toBe(iso(b.candles[firstBreak + 1].time));
  });
});

describe('SR-ZONES-W1 — volume, short history, overlaps, summary', () => {
  it('volume_vs_20 = last closed volume ÷ the mean of the 20 before it', () => {
    const b = new SeriesBuilder(60).trendTo(120).trendTo(102).trendTo(180);
    b.candles[b.candles.length - 1].volume = 300;
    expect(frameOf(b.candles, 181).volume_vs_20).toBe(3);
  });

  it('fewer than 21 closed candles is unservable, with a reason', () => {
    const b = new SeriesBuilder(60).trendTo(150); // 16 candles
    const r = computeSrZones(b.candles, b.candles.length - 1, 151);
    expect(r).toEqual({ ok: false, reason: 'fewer than 21 closed candles' });
  });

  it('overlaps list every intersecting zone of the other timeframes, edges included', () => {
    const z = (low: number, high: number, rank: number): SrZone => ({
      rank, low, high, distance_pct: 0, formed_from: '', formed_to: '', members: 1, touch_bars_90: 0,
      tests_30: 0, last_touch: null, state: 'intact', broke_at: null, overlaps: [],
    });
    const frames = attachSrZoneOverlaps([
      { timeframe: '1d', support: [z(100, 110, 1)], resistance: [z(120, 130, 1)] },
      { timeframe: '4h', support: [z(105, 108, 1), z(90, 95, 2)], resistance: [z(130, 140, 1)] },
    ]);
    expect(frames[0].support[0].overlaps).toEqual([{ timeframe: '4h', side: 'support', rank: 1 }]);
    expect(frames[0].resistance[0].overlaps).toEqual([{ timeframe: '4h', side: 'resistance', rank: 1 }]);
    expect(frames[1].support[0].overlaps).toEqual([{ timeframe: '1d', side: 'support', rank: 1 }]);
    expect(frames[1].support[1].overlaps).toEqual([]);
    expect(frames[1].resistance[0].overlaps).toEqual([{ timeframe: '1d', side: 'resistance', rank: 1 }]);
  });

  it('the summary is one factual sentence naming both nearest zones', () => {
    const s = ladderSeries();
    const f = frameOf(s.candles, 132);
    const text = buildSrZonesSummary('SYN', '1d', 132, f);
    expect(text.startsWith('SYN 1d at 132: 3 support and 2 resistance zones; support zone 1 at 111–113, 14.39% below; resistance zone 1 at 156–')).toBe(true);
    expect(text.endsWith('; last closed candle volume 1× its 20-candle average.')).toBe(true);
    expect(text.match(/\.\s/g)).toBeNull();
  });

  it('the summary names a flip and an empty side', () => {
    const b = new SeriesBuilder(150).trendTo(108).base(99, 6);
    b.trendTo(60);
    const text = buildSrZonesSummary('SYN', '1d', 60, frameOf(b.candles, 60));
    expect(text).toContain('no support zone below in the loaded history');
    expect(text).toMatch(/resistance zone 1 at 102–[\d.]+, [\d.]+% above \(support until \d{4}-\d{2}-\d{2}\)/);
  });
});
