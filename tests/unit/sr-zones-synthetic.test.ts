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

/** The summary of a computed frame served unrounded (SR-ZONES-W2 rounds in the handler; these tests pin the wording). */
const summaryOf = (coin: string, timeframe: string, price: number, f: SrZonesFrame): string =>
  buildSrZonesSummary(coin, timeframe, price, f, f);
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
    const text = summaryOf('SYN', '1d', 132, f);
    expect(text.startsWith('SYN 1d at 132: 3 support and 2 resistance zones; support zone 1 at 111–113, 14.39% below; resistance zone 1 at 156–')).toBe(true);
    expect(text.endsWith('; last closed candle volume 1× its 20-candle average.')).toBe(true);
    expect(text.match(/\.\s/g)).toBeNull();
  });

  it('the summary names a flip and an empty side', () => {
    const b = new SeriesBuilder(150).trendTo(108).base(99, 6);
    b.trendTo(60);
    const text = summaryOf('SYN', '1d', 60, frameOf(b.candles, 60));
    expect(text).toContain('no support zone below in the loaded history');
    expect(text).toMatch(/resistance zone 1 at 102–[\d.]+, [\d.]+% above \(support until \d{4}-\d{2}-\d{2}\)/);
  });
});

/**
 * SR-ZONES-W1 R6 (CH3 audit) — the formula rules the audit found unpinned or wrong, each on a series whose answer is
 * known by construction. Every case below ends with its decisive candles inside the last 3, where no swing point is
 * confirmed yet, so the zone under test stays the one the formula lists.
 */
describe('SR-ZONES-W1 R6 #1 — a break is judged from the zone\'s oldest candle', () => {
  it('a two-close break, then an in-band retest that becomes the newest member → broke_at is the breakout\'s second close', () => {
    const b = new SeriesBuilder(60).trendTo(96);
    const first = b.candles.length;
    for (let i = 0; i < 6; i++) b.push(102, 103, 99, 101); // red base: support edges [99, 101.5] with the retest
    const breakout = b.candles.length; // closes 102.5 and 102.6, above the zone, without a new swing high
    b.push(101, 102.6, 100.9, 102.5).push(102.5, 102.7, 101.8, 102.6).push(102.6, 102.8, 101.9, 102.7).push(102.7, 102.9, 102, 102.8);
    const retest = b.candles.length; // dips back into the zone from above and closes above it
    b.push(102.8, 102.85, 100.5, 102);
    b.trendTo(132);
    const z = frameOf(b.candles, 133).support[0];
    expect(z.formed_from).toBe(iso(b.candles[first].time));
    expect(z.formed_to).toBe(iso(b.candles[retest].time)); // the retest is the newest member
    expect(z.state).toBe('former_resistance');
    expect(z.broke_at).toBe(iso(b.candles[breakout + 1].time));
  });
});

describe('SR-ZONES-W1 R6 #6 — the state rule: 2 consecutive closes beyond, with price now on the other side', () => {
  it('two closes beyond, then back on the original side → intact, broke_at null', () => {
    const b = new SeriesBuilder(210).trendTo(108);
    const first = b.candles.length;
    b.base(99, 6); // support edges [99, 101]; price came from above
    b.push(102, 102.4, 97.4, 97.5).push(97.5, 98, 96.5, 97); // two closes below
    b.push(97, 103.5, 96.9, 103); // back above, where the zone formed from
    const f = frameOf(b.candles, 103.5);
    const z = f.support[0];
    expect(z.formed_from).toBe(iso(b.candles[first].time));
    expect(edges(z)).toEqual([99, 101]);
    expect(z.state).toBe('intact');
    expect(z.broke_at).toBeNull();
  });

  it('beyond, inside, beyond → intact (a close inside the zone resets the run)', () => {
    const b = new SeriesBuilder(210).trendTo(108);
    const first = b.candles.length;
    b.base(99, 6); // listed above price, as resistance: edges [102, 102 + 0.25 × ATR]
    b.push(102, 102.4, 100.6, 101); // below
    b.push(101, 102.8, 100.8, 102.5); // inside
    b.push(102.5, 102.6, 100.7, 101); // below
    const f = frameOf(b.candles, 100.9);
    const z = f.resistance[0];
    expect(z.formed_from).toBe(iso(b.candles[first].time));
    expect(z.low).toBe(102);
    expect(z.state).toBe('intact');
    expect(z.broke_at).toBeNull();
  });
});

describe('SR-ZONES-W1 R6 #7 — the tests_30 and volume_vs_20 windows', () => {
  it('a test 31 to 90 candles back is not in tests_30', () => {
    const b = new SeriesBuilder(210).trendTo(108);
    const first = b.candles.length;
    b.base(99, 6).trendTo(306); // the six base tests end 34 candles before the last closed one
    const z = frameOf(b.candles, 307).support[0];
    expect(z.formed_from).toBe(iso(b.candles[first].time));
    expect(z.touch_bars_90).toBe(6);
    expect(z.tests_30).toBe(0);
  });

  it('an entry from above that closes inside the zone is not a test', () => {
    const b = new SeriesBuilder(210).trendTo(108);
    b.base(99, 6).trendTo(108);
    b.push(108, 108.5, 99.8, 100.5); // enters [99, 101] from above and closes inside it
    b.push(100.5, 106.9, 100.4, 106.5);
    const z = frameOf(b.candles, 107).support[0];
    expect(edges(z)).toEqual([99, 101]);
    expect(z.tests_30).toBe(6); // the six base candles only
  });

  it('mirror: a resistance zone tested from below counts each test', () => {
    const b = new SeriesBuilder(6).trendTo(102);
    const first = b.candles.length;
    for (let i = 0; i < 6; i++) b.push(109, 111, 107, 108); // top base: resistance edges [109, 111]
    b.trendTo(90);
    const z = frameOf(b.candles, 89.5).resistance[0];
    expect(z.formed_from).toBe(iso(b.candles[first].time));
    expect(edges(z)).toEqual([109, 111]);
    expect(z.tests_30).toBe(6); // each top-base candle came from a close below 109, traded up to it and closed back below
  });

  it('volume_vs_20 averages exactly the 20 candles before the last closed one', () => {
    const b = new SeriesBuilder(210).trendTo(108).base(99, 6).trendTo(132);
    const t = b.candles.length - 1;
    for (let j = t - 20; j <= t - 11; j++) b.candles[j].volume = 300;
    for (let j = t - 10; j <= t - 1; j++) b.candles[j].volume = 100;
    b.candles[t].volume = 200;
    expect(frameOf(b.candles, 133).volume_vs_20).toBe(1); // 200 ÷ mean(10 × 300, 10 × 100)
  });
});

describe('SR-ZONES-W1 R6 #8 — each next seed is older than the previous zone\'s oldest candle', () => {
  it('a turning point beyond zone 1\'s far edge but newer than its oldest candle does not seed zone 2', () => {
    const b = new SeriesBuilder(210).trendTo(108);
    const first = b.candles.length;
    b.base(99, 6);
    const wick = b.candles.length; // two deep lower wicks: the range low (60) is dated at the last candle
    b.push(101, 103, 60, 101.5).push(101.5, 103, 60, 102.6).push(102.5, 103.2, 102, 103);
    const t = b.candles.length - 1;
    const atr = wilderAtr(b.candles, t)[t] as number;
    const f = frameOf(b.candles, 104);
    const z1 = f.support[0];
    expect(z1.formed_from).toBe(iso(b.candles[first].time)); // zone 1 spans the base and the last candle
    expect(z1.formed_to).toBe(iso(b.candles[t].time));
    expect(b.candles[wick].low).toBe(60);
    expect(60).toBeLessThanOrEqual(z1.low - 0.5 * atr); // the wick low sits beyond zone 1's far edge by >= 0.5 × ATR
    // The zone it would seed ([60, 101], the wick candle's low and body bottom) is further from price than zone 1 at
    // its near edge too, so only the age clause keeps it out.
    expect(((104 - 101) / 104) * 100).toBeGreaterThan(z1.distance_pct);
    expect(f.support).toHaveLength(1); // nothing older than the base lies below it
  });
});

describe('SR-ZONES-W1 R6 #3 — "price inside" in the summary is the flag\'s predicate, low <= price <= high', () => {
  const zone = (low: number, high: number, distance_pct: number): SrZone => ({
    rank: 1, low, high, distance_pct, formed_from: '2026-08-13T00:00:00.000Z', formed_to: '2026-08-13T00:00:00.000Z',
    members: 1, touch_bars_90: 1, tests_30: 0, last_touch: null, state: 'intact', broke_at: null, overlaps: [],
  });
  const frame = (support: SrZone[], resistance: SrZone[]): SrZonesFrame => ({ support, resistance, flags: [], volume_vs_20: null });

  it('a gap under 0.005% rounds distance_pct to 0, and the summary still says below, not inside', () => {
    const text = summaryOf('BTC', '1d', 63_456.7, frame([zone(62_800, 63_454.6, 0)], []));
    expect(text).toContain('support zone 1 at 62800–63454.6, 0% below');
    expect(text).not.toContain('price inside');
  });

  it('price on an edge or between the edges is inside', () => {
    expect(summaryOf('BTC', '1d', 63_454.6, frame([zone(62_800, 63_454.6, 0)], []))).toContain('price inside support zone 1 at 62800–63454.6');
    expect(summaryOf('BTC', '1d', 70_000, frame([], [zone(69_900, 70_100, 0)]))).toContain('price inside resistance zone 1 at 69900–70100');
  });

  it('mirror: a resistance zone a hair above price is above, not inside', () => {
    const text = summaryOf('BTC', '1d', 69_899, frame([], [zone(69_900, 70_100, 0)]));
    expect(text).toContain('resistance zone 1 at 69900–70100, 0% above');
    expect(text).not.toContain('price inside');
  });
});

describe('SR-ZONES-W1 R6 #5 — overlaps list only the OTHER timeframes', () => {
  it('two intersecting zones of the same timeframe never list each other', () => {
    const z = (low: number, high: number, rank: number): SrZone => ({
      rank, low, high, distance_pct: 0, formed_from: '', formed_to: '', members: 1, touch_bars_90: 0,
      tests_30: 0, last_touch: null, state: 'intact', broke_at: null, overlaps: [],
    });
    const frames = attachSrZoneOverlaps([
      { timeframe: '1d', support: [z(100, 110, 1)], resistance: [z(108, 115, 1)] }, // intersect each other
      { timeframe: '4h', support: [z(109, 109.5, 1)], resistance: [z(200, 210, 1)] },
    ]);
    expect(frames[0].support[0].overlaps).toEqual([{ timeframe: '4h', side: 'support', rank: 1 }]);
    expect(frames[0].resistance[0].overlaps).toEqual([{ timeframe: '4h', side: 'support', rank: 1 }]);
    expect(frames[1].support[0].overlaps).toEqual([
      { timeframe: '1d', side: 'support', rank: 1 },
      { timeframe: '1d', side: 'resistance', rank: 1 },
    ]);
    expect(frames[1].resistance[0].overlaps).toEqual([]);
  });
});
