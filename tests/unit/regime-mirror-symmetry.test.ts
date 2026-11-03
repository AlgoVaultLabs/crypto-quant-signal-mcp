/**
 * regime-mirror-symmetry.test.ts — MARKET-REGIME-DIRECTION-SYMMETRY-W1 CH1
 *
 * The gate for every directional output of the market regime classifier. Mirror a price window
 * (p → K − p, `tests/fixtures/mirror-candles.ts`) and its regime must mirror with it:
 *   TRENDING_UP ↔ TRENDING_DOWN with equal confidence and trend_strength;
 *   HIGHER_HIGHS ↔ LOWER_LOWS, MIXED ↔ MIXED;
 *   equal adx, adx_slope and pivot_quality;
 *   a non-trending label stays non-trending (VOLATILE reads the price LEVEL, which a mirror moves).
 *
 * The reported defect (vault audits/REGIME-DIRECTION-CRWV-2026-11-03): CRWV · BINANCE · 1h read
 * TRENDING_UP 86 while −DI 27.2 ≫ +DI 9.8. `detectPriceStructure` resolved a swing set making both
 * higher highs AND lower lows (hh 0.75, ll 0.75) as HIGHER_HIGHS by code order — and so did its
 * mirror, which is exactly the bias this suite exposes.
 *
 * (a) `classifyRegime` over an input grid · (b) `computeMarketRegimeCore` over the CRWV window, the 21
 * parity windows and seeded random walks · (c) the CRWV verdict under rule v2 · (d) both paths of
 * `detectPriceStructure`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyRegime,
  computeMarketRegimeCore,
  computeRegimeIndicators,
  regimeFetchWindow,
} from '../../src/lib/market-regime-core.js';
import type { MarketRegimeCore, RegimeClassifierInputs, RegimeIndicators } from '../../src/lib/market-regime-core.js';
import { detectPriceStructure } from '../../src/lib/indicators.js';
import { splitCandleWindow } from '../../src/lib/candle-window.js';
import { mirrorCandles, mirrorRegime, mirrorStructure, randomWalkCandles } from '../fixtures/mirror-candles.js';
import type { AdxSlopeCategory, Candle, PriceStructure, RegimeType } from '../../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const EPS = 1e-9;
const TRENDING = new Set<RegimeType>(['TRENDING_UP', 'TRENDING_DOWN']);

const toCandles = (bars: number[][]): Candle[] =>
  bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

interface MirrorWindow { label: string; timeframe: string; nowMs: number; candles: Candle[] }

const CRWV = JSON.parse(readFileSync(join(FIXTURES, 'regime-crwv-binance-1h-2026-11-03.json'), 'utf8')) as {
  nowMs: number;
  timeframe: string;
  served: { regime: string; confidence: number; adx: number; adx_slope: number; price_structure: string;
    pivot_quality: number; volatility_ratio: number; trend_strength: string };
  bars: number[][];
};
const PARITY = JSON.parse(readFileSync(join(FIXTURES, 'regime-core-parity-inputs.json'), 'utf8')) as {
  nowMs: number;
  windows: { coin: string; timeframe: string; bars: number[][] }[];
};

const CRWV_WINDOW: MirrorWindow = { label: 'CRWV|1h', timeframe: CRWV.timeframe, nowMs: CRWV.nowMs, candles: toCandles(CRWV.bars) };
const PARITY_WINDOWS: MirrorWindow[] = PARITY.windows.map((w) => ({
  label: `${w.coin}|${w.timeframe}`, timeframe: w.timeframe, nowMs: PARITY.nowMs, candles: toCandles(w.bars),
}));

// The random-walk corpus. Change the seed and every walk changes; the count is the suite's floor.
const WALK_SEED = 20261103;
const WALK_COUNT = 400;
const HOUR = 3_600_000;
const WALK_START_MS = 1_790_000_000_000 - (1_790_000_000_000 % HOUR);
const WALKS: MirrorWindow[] = Array.from({ length: WALK_COUNT }, (_, w) => ({
  label: `walk#${w}`,
  timeframe: '1h',
  // Mid-way through the 168th bar, so the closed basis drops one partial bar exactly as it does live.
  nowMs: WALK_START_MS + 167 * HOUR + HOUR / 2,
  candles: randomWalkCandles(WALK_SEED + w, 168, WALK_START_MS, w % 2 === 0 ? 1 : -1),
}));

/** The core on the CLOSED basis (prod's `CANDLE_BASIS`), on a copy — the core sorts in place. */
function core(w: MirrorWindow, candles: Candle[]): MarketRegimeCore {
  const win = regimeFetchWindow(w.timeframe, w.nowMs);
  return computeMarketRegimeCore({
    coin: w.label, exchange: 'BINANCE', timeframe: w.timeframe, candles: candles.map((c) => ({ ...c })),
    intervalMs: win.intervalMs, startTime: win.startTime, nowMs: w.nowMs, candleBasis: 'closed',
  });
}

/** The raw indicators the closed-basis core classified, for the precision-skip judgement. */
function closedIndicators(w: MirrorWindow): RegimeIndicators {
  const win = regimeFetchWindow(w.timeframe, w.nowMs);
  const sorted = [...w.candles].sort((a, b) => a.time - b.time);
  return computeRegimeIndicators(splitCandleWindow(sorted, win.intervalMs, w.nowMs).closed);
}

const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= EPS);

/** Every way the mirrored verdict `m` fails to mirror `a`. Empty = symmetric. */
function asymmetry(a: MarketRegimeCore, m: MarketRegimeCore): string[] {
  const bad: string[] = [];
  if (m.metrics.price_structure !== mirrorStructure(a.metrics.price_structure)) {
    bad.push(`structure ${a.metrics.price_structure} → ${m.metrics.price_structure}`);
  }
  if (TRENDING.has(a.regime)) {
    if (m.regime !== mirrorRegime(a.regime) || m.confidence !== a.confidence || m.trendStrength !== a.trendStrength) {
      bad.push(`regime ${a.regime} ${a.confidence} ${a.trendStrength} → ${m.regime} ${m.confidence} ${m.trendStrength}`);
    }
  } else if (TRENDING.has(m.regime)) {
    bad.push(`regime ${a.regime} → ${m.regime}`);
  }
  for (const k of ['adx', 'adx_slope', 'pivot_quality'] as const) {
    if (!near(a.metrics[k], m.metrics[k])) bad.push(`${k} ${a.metrics[k]} → ${m.metrics[k]}`);
  }
  return bad;
}

/**
 * A window whose DI pair, or a value the classifier thresholds or rounds, sits within EPS of a decision
 * boundary: the mirror's floating-point error alone could move it, so a random walk there is skipped and
 * logged rather than judged. The CRWV and parity windows never skip.
 */
function precisionBoundary(ind: RegimeIndicators): string | null {
  const halfway = (x: number) => Math.abs(Math.abs(x - Math.trunc(x)) - 0.5) <= EPS;
  const at = (x: number, edges: number[]) => edges.some((e) => Math.abs(x - e) <= EPS);
  const { adxVal, adxSlope, plusDI, minusDI } = ind;
  if (plusDI !== null && minusDI !== null && Math.abs(plusDI - minusDI) <= EPS) return 'DI pair';
  if (adxVal !== null && (at(adxVal, [18, 25, 30, 40]) || halfway(adxVal * 2) || halfway(adxVal * 1.5)
    || halfway((25 - adxVal) * 4) || halfway(adxVal * 10))) return `adx ${adxVal}`;
  if (adxSlope !== null && (at(adxSlope, [-1, -0.5, 0.5, 0.8]) || halfway(adxSlope * 5) || halfway(adxSlope * 100))) {
    return `adx_slope ${adxSlope}`;
  }
  return null;
}

describe('(a) classifyRegime — swapping DI and mirroring the structure mirrors the verdict', () => {
  // Every slope category against every slope, consistent or not: the symmetry must hold for any input the
  // classifier accepts, so the superset is the stronger gate.
  const GRID = {
    adx: [10, 20, 26, 29, 35, 45],
    adxSlope: [-2, -0.7, 0, 0.7, 1.2],
    slopeCategory: ['RISING', 'FLAT', 'FALLING'] as AdxSlopeCategory[],
    di: [[30, 10], [10, 30], [20, 20]] as Array<[number, number]>,
    structure: ['HIGHER_HIGHS', 'LOWER_LOWS', 'MIXED'] as PriceStructure[],
    volatilityRatio: [0.005, 0.04],
  };
  const inputs: RegimeClassifierInputs[] = [];
  for (const adxVal of GRID.adx) for (const adxSlope of GRID.adxSlope) for (const slopeCategory of GRID.slopeCategory)
    for (const [plusDI, minusDI] of GRID.di) for (const priceStructure of GRID.structure) for (const volatilityRatio of GRID.volatilityRatio)
      inputs.push({ adxVal, adxSlope, plusDI, minusDI, slopeCategory, priceStructure, volatilityRatio });

  it('mirrors every trending output and leaves every non-trending one equal', () => {
    const failures: string[] = [];
    let trending = 0;
    for (const x of inputs) {
      const a = classifyRegime(x);
      const m = classifyRegime({ ...x, plusDI: x.minusDI, minusDI: x.plusDI, priceStructure: mirrorStructure(x.priceStructure) });
      if (TRENDING.has(a.regime)) {
        trending++;
        if (m.regime !== mirrorRegime(a.regime) || m.confidence !== a.confidence || m.trendStrength !== a.trendStrength) {
          failures.push(`${JSON.stringify(x)}: ${JSON.stringify(a)} → ${JSON.stringify(m)}`);
        }
      } else if (JSON.stringify(m) !== JSON.stringify(a)) {
        failures.push(`${JSON.stringify(x)}: ${JSON.stringify(a)} → ${JSON.stringify(m)}`);
      }
    }
    expect(inputs.length).toBe(1620);
    expect(trending).toBeGreaterThan(0);
    expect(inputs.length - trending).toBeGreaterThan(0);
    expect(failures, `${failures.length} of ${inputs.length} grid inputs asymmetric`).toEqual([]);
  });

  it('a DI-led direction is strict on both sides, and an exact DI tie names no direction', () => {
    const failures: string[] = [];
    for (const x of inputs) {
      const { regime } = classifyRegime(x);
      if (!TRENDING.has(regime)) continue;
      const tie = x.plusDI === x.minusDI;
      // MIXED structure: the direction can only come from DI, and must agree with it strictly.
      if (x.priceStructure === 'MIXED' && (tie || regime !== (x.plusDI! > x.minusDI! ? 'TRENDING_UP' : 'TRENDING_DOWN'))) {
        failures.push(`MIXED ${JSON.stringify(x)} → ${regime}`);
      }
      // A DI tie: a trending label can only come from a clean structure, and must follow it.
      if (tie && regime !== (x.priceStructure === 'HIGHER_HIGHS' ? 'TRENDING_UP' : 'TRENDING_DOWN')) {
        failures.push(`tie ${JSON.stringify(x)} → ${regime}`);
      }
    }
    expect(failures, `${failures.length} DI-led outputs not strict`).toEqual([]);
  });
});

describe('(b) computeMarketRegimeCore — the regime mirrors with its price window (closed basis)', () => {
  it('the mirror is a valid price window: every bar keeps its range and stays positive', () => {
    for (const w of [CRWV_WINDOW, ...PARITY_WINDOWS, ...WALKS.slice(0, 20)]) {
      const mirrored = mirrorCandles(w.candles);
      mirrored.forEach((b, i) => {
        const o = w.candles[i];
        expect(b.low, w.label).toBeGreaterThan(0);
        expect(b.high, w.label).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low, w.label).toBeLessThanOrEqual(Math.min(b.open, b.close));
        expect(Math.abs((b.high - b.low) - (o.high - o.low)), w.label).toBeLessThanOrEqual(EPS);
        expect([b.time, b.volume]).toEqual([o.time, o.volume]);
      });
    }
  });

  it.each([CRWV_WINDOW, ...PARITY_WINDOWS].map((w) => [w.label, w] as const))('%s mirrors', (_label, w) => {
    expect(PARITY_WINDOWS.length).toBe(21);
    expect(asymmetry(core(w, w.candles), core(w, mirrorCandles(w.candles)))).toEqual([]);
  });

  it(`${WALK_COUNT} seeded random walks mirror, bar a logged precision skip`, () => {
    const asymmetric: string[] = [];
    const skips: string[] = [];
    const seen = { up: 0, down: 0, mixed: 0 };
    for (const w of WALKS) {
      const boundary = precisionBoundary(closedIndicators(w));
      if (boundary) { skips.push(`${w.label} (${boundary})`); continue; }
      const a = core(w, w.candles);
      if (a.regime === 'TRENDING_UP') seen.up++;
      if (a.regime === 'TRENDING_DOWN') seen.down++;
      if (a.metrics.price_structure === 'MIXED') seen.mixed++;
      const bad = asymmetry(a, core(w, mirrorCandles(w.candles)));
      if (bad.length) asymmetric.push(`${w.label}: ${bad.join('; ')}`);
    }
    console.log(`[mirror] random walks: ${WALK_COUNT - skips.length} judged, ${skips.length} precision skips${skips.length ? ` (${skips.join(', ')})` : ''}, ` +
      `${seen.up} up / ${seen.down} down / ${seen.mixed} MIXED`);
    expect(skips.length, 'precision skips must stay rare, or the corpus is not what it claims').toBeLessThanOrEqual(WALK_COUNT / 100);
    expect(seen.up).toBeGreaterThan(0);
    expect(seen.down).toBeGreaterThan(0);
    expect(asymmetric, `${asymmetric.length} of ${WALK_COUNT - skips.length} walks asymmetric`).toEqual([]);
  });
});

describe('(c) the reported CRWV window (BINANCE · 1h · 2026-11-03T09:35:58Z) under rule v2', () => {
  const v2 = core(CRWV_WINDOW, CRWV_WINDOW.candles);

  it('is the served window: every field the rule change cannot move reproduces exactly', () => {
    expect(v2.emittedCount).toBe(167);
    expect(v2.metrics.adx).toBe(CRWV.served.adx);
    expect(v2.metrics.adx_slope).toBe(CRWV.served.adx_slope);
    expect(v2.metrics.pivot_quality).toBe(CRWV.served.pivot_quality);
    expect(v2.metrics.volatility_ratio).toBe(CRWV.served.volatility_ratio);
    expect(v2.confidence).toBe(CRWV.served.confidence);
    expect(v2.trendStrength).toBe(CRWV.served.trend_strength);
  });

  it('reads TRENDING_DOWN 86 STRONG with a MIXED structure — the side −DI 27.2 ≫ +DI 9.8 reports', () => {
    const ind = closedIndicators(CRWV_WINDOW);
    expect([ind.plusDI!.toFixed(1), ind.minusDI!.toFixed(1)]).toEqual(['9.8', '27.2']);
    expect({ regime: v2.regime, confidence: v2.confidence, trendStrength: v2.trendStrength, ...v2.metrics }).toMatchObject({
      regime: 'TRENDING_DOWN', confidence: 86, trendStrength: 'STRONG', price_structure: 'MIXED',
      pivot_quality: 0.613, adx: 40.9, adx_slope: 0.74, volatility_ratio: 0.0152,
    });
  });
});

describe('(d) detectPriceStructure — an hh/ll tie reads MIXED on both paths, and both paths mirror', () => {
  /**
   * A zig-zag whose last five swing highs make 3 of 4 higher highs and whose last five swing lows make
   * 3 of 4 lower lows: hh = ll = 0.75, the CRWV shape. Peaks and troughs alternate every two bars along
   * straight segments, so no other bar is a 3-bar pivot. Pivot bars carry 5× volume so the scored path
   * keeps every one of them.
   */
  const PEAKS = [10, 11, 12, 13, 9.5];
  const TROUGHS = [9, 8.5, 9.2, 8, 7];
  const points: Array<[number, number]> = [[0, 9.5]];
  PEAKS.forEach((p, k) => points.push([4 * k + 2, p], [4 * k + 4, TROUGHS[k]]));
  points.push([22, 7.5]);
  const center: number[] = [];
  for (let s = 0; s < points.length - 1; s++) {
    const [i0, p0] = points[s];
    const [i1, p1] = points[s + 1];
    for (let i = i0; i < i1; i++) center.push(p0 + ((p1 - p0) * (i - i0)) / (i1 - i0));
  }
  center.push(points[points.length - 1][1]);
  const pivotBars = new Set(points.slice(1, -1).map(([i]) => i));
  const highs = center.map((c) => c + 0.1);
  const lows = center.map((c) => c - 0.1);
  const volumes = center.map((_, i) => (pivotBars.has(i) ? 5000 : 1000));

  it('the scored path reads the tie as MIXED', () => {
    const r = detectPriceStructure(highs, lows, center, volumes);
    expect(r.avgPivotScore).toBeGreaterThan(0); // > 0 only on the scored path
    expect(r.pivotCount).toBe(10);
    expect(r.structure).toBe('MIXED');
  });

  it('the simple fallback reads the tie as MIXED', () => {
    const r = detectPriceStructure(highs, lows);
    expect(r).toEqual({ structure: 'MIXED', pivotCount: 10, avgPivotScore: 0 });
  });

  it('both paths mirror over the random walks', () => {
    const asymmetric: string[] = [];
    for (const w of WALKS) {
      const m = mirrorCandles(w.candles);
      const col = (cs: Candle[], k: keyof Candle) => cs.map((c) => c[k]);
      const simple = [detectPriceStructure(col(w.candles, 'high'), col(w.candles, 'low')), detectPriceStructure(col(m, 'high'), col(m, 'low'))];
      const scored = [
        detectPriceStructure(col(w.candles, 'high'), col(w.candles, 'low'), col(w.candles, 'close'), col(w.candles, 'volume')),
        detectPriceStructure(col(m, 'high'), col(m, 'low'), col(m, 'close'), col(m, 'volume')),
      ];
      for (const [name, [a, b]] of [['simple', simple], ['scored', scored]] as const) {
        if (b.structure !== mirrorStructure(a.structure) || b.pivotCount !== a.pivotCount || !near(a.avgPivotScore, b.avgPivotScore)) {
          asymmetric.push(`${w.label} ${name}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
        }
      }
    }
    expect(asymmetric, `${asymmetric.length} path-walks asymmetric`).toEqual([]);
  });
});
