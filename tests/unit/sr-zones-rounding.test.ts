/**
 * SR-ZONES-W2 CH1 — served zone edges rounded outward (§0.1) and nothing else moved (§0.2).
 *
 *   AC1.3  the step table, with and without a venue tick; no emitted value carries float noise
 *   AC1.1  BTC fixture at 67,585.6, tick 0.1: the whole served ladder, locked, through the handler
 *   AC1.5  that response is byte-identical to T1's apart from low, high and the summary range
 *   AC1.2  on each of the last 365 fixture candles every served zone contains its raw zone, each served edge is a
 *          multiple of the step, and |served − raw| < step
 *
 * T1's response is sr-zones-t1-golden-btc-1d.json (sha256 0ba13c9a…853fc3): runGetSrZones at 3935d83c, the commit
 * before this wave, over the setup in `run()` below — the BTC fixture, a forming candle closing at 67,585.6, NOW
 * 2026-11-14T10:00Z, license { tier: 'free', key: 'av_srz_golden' }, call trackers reset.
 *
 * The checks below that judge the helper use plain float arithmetic with a tolerance, never the helper's own decimal
 * arithmetic, so a defect in that arithmetic cannot pass its own test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGetSrZones, type SrZonesDeps, type GetSrZonesResponse } from '../../src/tools/get-sr-zones.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { PKG_VERSION } from '../../src/lib/pkg-version.js';
import { computeSrZones, type SrZone } from '../../src/lib/sr-zones/zones.js';
import { buildSrZonesSummary } from '../../src/lib/sr-zones/summary.js';
import {
  priceLevelStep,
  roundLevelDown,
  roundLevelUp,
  roundZoneOutward,
  roundFrameOutward,
  formatLevel,
} from '../../src/lib/sr-zones/rounding.js';
import { loadBtcFixture, btcFixtureWithForming } from './sr-zones-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(readFileSync(join(HERE, 'sr-zones-t1-golden-btc-1d.json'), 'utf8')) as GetSrZonesResponse;
const NOW = Date.parse('2026-11-14T10:00:00.000Z');
const PRICE = 67_585.6;
const SIDES = ['support', 'resistance'] as const;

/** Digits after the decimal point of a number as JSON prints it. */
const decimals = (x: number): number => (String(x).split('.')[1] ?? '').length;
/** x is a whole multiple of step, judged in floats with a tolerance far below one step. */
const isMultiple = (x: number, step: number): boolean => Math.abs(x / step - Math.round(x / step)) < 1e-6;

function fixtureDeps(tick: () => Promise<number | null>): SrZonesDeps {
  const series = btcFixtureWithForming(PRICE);
  return {
    nowMs: () => NOW,
    cache: new Map(),
    failures: new Map(),
    getCandles: async (_coin, _tf, startTime) => series.filter((c) => c.time >= startTime).slice(0, 200),
    getPriceTick: async () => tick(),
  };
}

async function run(tick: () => Promise<number | null> = async () => 0.1): Promise<GetSrZonesResponse> {
  const o = await runGetSrZones({ coin: 'BTC', timeframes: ['1d'] }, { tier: 'free', key: 'av_srz_golden' }, fixtureDeps(tick));
  if (o.kind !== 'ok') throw new Error(JSON.stringify(o.payload));
  return o.response;
}

/** Each "zone 1 at A–B" range in a summary, replaced: the one part of the summary §0.1 rounds. */
const RANGE = /zone 1 at [0-9.]+–[0-9.]+/g;
const withoutRanges = (s: string): string => s.replace(RANGE, 'zone 1 at <range>');

/** The served response with T1's edges put back and its summary ranges masked: what must equal T1's bytes. */
function backToT1(served: GetSrZonesResponse, golden: GetSrZonesResponse): GetSrZonesResponse {
  const back = structuredClone(served);
  back.results.forEach((r, ri) => {
    r.summary = withoutRanges(r.summary);
    for (const side of SIDES) {
      r[side].forEach((z, i) => {
        z.low = golden.results[ri][side][i].low;
        z.high = golden.results[ri][side][i].high;
      });
    }
  });
  return back;
}

function t1Masked(): GetSrZonesResponse {
  const g = structuredClone(GOLDEN);
  // The package version is the one field a release bump moves; the zones are what this test pins.
  g._algovault.version = PKG_VERSION;
  g.results.forEach((r) => (r.summary = withoutRanges(r.summary)));
  return g;
}

beforeEach(() => {
  _resetCallTrackersForTest();
  resetLicenseCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SR-ZONES-W2 AC1.3 — the step: four significant figures of the price, then the venue tick', () => {
  const NO_TICK: Array<[number, string]> = [
    [67_585.6, '10'],
    [99_999, '10'],
    [100_000, '100'],
    [3_456.7, '1'],
    [145.67, '0.1'],
    [0.12345, '0.0001'],
  ];
  for (const [price, step] of NO_TICK) {
    it(`price ${price}, no tick → ${step}`, () => {
      expect(String(priceLevelStep(price, null)!.value)).toBe(step);
    });
  }

  const WITH_TICK: Array<[string, number, number, string]> = [
    ['price 5 (sig 0.001), tick 0.01', 5, 0.01, '0.01'],
    ['sig 0.01 (price 50), tick 0.05', 50, 0.05, '0.05'],
    ['sig 10 (price 67,585.6), tick 0.3', 67_585.6, 0.3, '10.2'],
    ['sig 10, tick 0.1 (BTC on Binance)', 67_585.6, 0.1, '10'],
    ['sig 0.0001, tick 0.00001 (a tick finer than sig)', 0.12345, 0.00001, '0.0001'],
  ];
  for (const [label, price, tick, step] of WITH_TICK) {
    it(`${label} → ${step}`, () => {
      expect(String(priceLevelStep(price, tick)!.value)).toBe(step);
    });
  }

  it('the exponent is exact at a power of ten (no log10 rounding): 1000 → 1, 999.9999 → 0.1, 1e-7 → 1e-10', () => {
    expect(priceLevelStep(1000, null)!.value).toBe(1);
    expect(priceLevelStep(999.9999, null)!.value).toBe(0.1);
    expect(priceLevelStep(1e-7, null)!.value).toBe(1e-10);
  });

  it('an unusable price gives no step, and an unusable tick falls back to sig', () => {
    for (const p of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(priceLevelStep(p, 0.1)).toBeNull();
    for (const t of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(priceLevelStep(67_585.6, t)!.value).toBe(10);
    }
  });

  it('edges round outward on exact decimals: no float noise, and an edge on a multiple stays', () => {
    const s = (p: number, t: number | null) => priceLevelStep(p, t)!;
    // 1.15 / 0.05 is 22.999999999999996 in floats: a float floor would drop a whole step.
    expect(roundLevelDown(1.15, s(50, 0.05))).toBe(1.15);
    // ceil(0.12345678 / 0.0001) × 0.0001 is 0.12350000000000001 in floats.
    expect(roundLevelUp(0.12345678, s(0.12345, null))).toBe(0.1235);
    expect(roundLevelDown(0.12345678, s(0.12345, null))).toBe(0.1234);
    expect(roundLevelDown(62_484.2, s(PRICE, 0.3))).toBe(62_475);
    expect(roundLevelUp(63_234.8, s(PRICE, 0.3))).toBe(63_240);
    expect(roundLevelUp(62_480, s(PRICE, 0.1))).toBe(62_480);
    expect(roundLevelDown(62_480, s(PRICE, 0.1))).toBe(62_480);
    expect(roundLevelDown(1.5e-7, s(1.5e-7, null))).toBe(1.5e-7);
    expect(roundLevelUp(1.23456e-7, s(1.5e-7, null))).toBe(1.235e-7);
  });

  it('a served level prints as plain decimal digits: no exponent, no float noise', () => {
    expect(formatLevel(62_480)).toBe('62480');
    expect(formatLevel(0.1235)).toBe('0.1235');
    expect(formatLevel(1.235e-7)).toBe('0.0000001235');
    expect(formatLevel(1_234_567.8)).toBe('1234567.8');
  });

  it('roundZoneOutward moves only low and high, keeps key order, and leaves the input as it was', () => {
    const z = { rank: 1, low: 62_484.2, high: 63_234.8, distance_pct: 6.44, overlaps: [] };
    const out = roundZoneOutward(z, priceLevelStep(PRICE, 0.1));
    expect(out).toEqual({ ...z, low: 62_480, high: 63_240 });
    expect(Object.keys(out)).toEqual(Object.keys(z));
    expect(z.low).toBe(62_484.2);
    expect(roundZoneOutward(z, null)).toBe(z);
  });
});

describe('SR-ZONES-W2 AC1.1 — the BTC ladder at 67,585.6, tick 0.1, through the handler', () => {
  it('serves S1 = 62,480–63,240 and the whole ladder, locked', async () => {
    const r = (await run()).results[0];
    expect(r.support.map((z) => [z.low, z.high])).toEqual([
      [62_480, 63_240],
      [57_750, 59_190],
      [52_510, 54_390],
    ]);
    expect(r.resistance.map((z) => [z.low, z.high])).toEqual([
      [75_830, 76_450],
      [80_460, 81_190],
      [83_580, 84_880],
    ]);
  });

  it('each served edge is the outward rounding of T1\'s edge to 10', async () => {
    const r = (await run()).results[0];
    let edges = 0;
    for (const side of SIDES) {
      r[side].forEach((z, i) => {
        const t1 = GOLDEN.results[0][side][i];
        expect(isMultiple(z.low, 10) && isMultiple(z.high, 10)).toBe(true);
        expect(z.low <= t1.low && t1.low - z.low < 10).toBe(true);
        expect(z.high >= t1.high && z.high - t1.high < 10).toBe(true);
        edges += 2;
      });
    }
    expect(edges).toBe(12);
  });

  it('the summary prints the served range of zone 1 on each side', async () => {
    expect((await run()).results[0].summary).toBe(
      'BTC 1d at 67585.6: 3 support and 3 resistance zones; support zone 1 at 62480–63240, 6.44% below; ' +
        'resistance zone 1 at 75830–76450, 12.21% above; last closed candle volume 2.04× its 20-candle average.',
    );
  });
});

describe('SR-ZONES-W2 AC1.5 — apart from low, high and the summary range, byte-identical to T1', () => {
  it('the fixture response, with T1\'s edges put back and the ranges masked, is T1\'s bytes', async () => {
    const served = await run();
    expect(JSON.stringify(backToT1(served, GOLDEN))).toBe(JSON.stringify(t1Masked()));
  });

  it('the golden is the response the T1 setup produced (not vacuous: 6 zones, 1 timeframe, both ranges)', () => {
    expect(GOLDEN.results).toHaveLength(1);
    expect(GOLDEN.results[0].support).toHaveLength(3);
    expect(GOLDEN.results[0].resistance).toHaveLength(3);
    expect(GOLDEN.results[0].summary.match(RANGE)).toHaveLength(2);
    expect(GOLDEN.price).toBe(PRICE);
  });

  it('a different tick moves only the edges and the range (tick 0.3 → step 10.2)', async () => {
    const at01 = await run(async () => 0.1);
    _resetCallTrackersForTest();
    resetLicenseCache();
    const at03 = await run(async () => 0.3);
    expect(at03.results[0].support[0]).toMatchObject({ low: 62_475, high: 63_240 });
    expect(at03.results[0].summary).toContain('support zone 1 at 62475–63240');
    expect(JSON.stringify(backToT1(at03, GOLDEN))).toBe(JSON.stringify(backToT1(at01, GOLDEN)));
  });
});

describe('SR-ZONES-W2 §0.2 — "inside" and the distance stay on the computed zone', () => {
  it('a served range that reaches past price still reads "below" when the computed zone ends under price', () => {
    const z: SrZone = {
      rank: 1, low: 62_800, high: 63_454.6, distance_pct: 0, formed_from: '2026-08-13T00:00:00.000Z', formed_to: '2026-08-13T00:00:00.000Z',
      members: 1, touch_bars_90: 1, tests_30: 0, last_touch: null, state: 'intact', broke_at: null, overlaps: [],
    };
    const frame = { support: [z], resistance: [], flags: [], volume_vs_20: null };
    const price = 63_456.7;
    const served = roundFrameOutward(frame, priceLevelStep(price, 0.1));
    expect(served.support[0]).toMatchObject({ low: 62_800, high: 63_460 });
    const text = buildSrZonesSummary('BTC', '1d', price, frame, served);
    expect(text).toContain('support zone 1 at 62800–63460, 0% below');
    expect(text).not.toContain('price inside');
  });
});

describe('SR-ZONES-W2 AC1.2 — the last 365 fixture candles', () => {
  const candles = loadBtcFixture();
  const rows: Array<{ day: number; price: number; zones: SrZone[] }> = [];
  for (let t = candles.length - 365; t < candles.length; t++) {
    const price = candles[t].close;
    const r = computeSrZones(candles, t, price);
    if (r.ok) rows.push({ day: candles[t].time, price, zones: [...r.frame.support, ...r.frame.resistance] });
  }

  for (const tick of [0.1, null]) {
    it(`tick ${tick}: every served zone contains its raw zone, sits on the step, and moves by less than one step`, () => {
      const bad: string[] = [];
      let checked = 0;
      const steps = new Set<number>();
      for (const { day, price, zones } of rows) {
        const step = priceLevelStep(price, tick)!;
        steps.add(step.value);
        for (const raw of zones) {
          const served = roundZoneOutward(raw, step);
          const where = `${new Date(day).toISOString().slice(0, 10)} rank ${raw.rank} [${raw.low}, ${raw.high}] → [${served.low}, ${served.high}] step ${step.value}`;
          if (!(served.low <= raw.low && raw.high <= served.high)) bad.push(`not contained: ${where}`);
          if (!isMultiple(served.low, step.value) || !isMultiple(served.high, step.value)) bad.push(`off the step: ${where}`);
          if (!(raw.low - served.low < step.value && served.high - raw.high < step.value)) bad.push(`moved a step or more: ${where}`);
          if (decimals(served.low) > decimals(step.value) || decimals(served.high) > decimals(step.value)) bad.push(`float noise: ${where}`);
          checked++;
        }
      }
      expect(bad).toEqual([]);
      expect(rows).toHaveLength(365);
      expect(checked).toBeGreaterThan(365);
      expect([...steps].every((s) => s === 10 || s === 100)).toBe(true);
    });
  }
});
