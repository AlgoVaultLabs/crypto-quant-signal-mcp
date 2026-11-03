/**
 * mirror-candles.ts — MARKET-REGIME-DIRECTION-SYMMETRY-W1 CH1
 *
 * The mirror harness. Mirroring a price window (p → K − p) turns every rally into a decline of the
 * same shape, so a directional classifier must answer with the mirror of what it said before:
 * TRENDING_UP ↔ TRENDING_DOWN, HIGHER_HIGHS ↔ LOWER_LOWS, MIXED ↔ MIXED. Anything else means the
 * classifier has a direction bias that does not come from the market.
 *
 * NOT a test file — vitest's `include` is anchored at `tests/**\/*.{test,spec}.…`, so this module is
 * imported, never collected. Reused by `tests/unit/regime-mirror-symmetry.test.ts`.
 */
import type { Candle, PriceStructure, RegimeType } from '../../src/types.js';

/**
 * p → K − p with K = 2·max(high) + 1, so every mirrored price stays positive. The extremes swap:
 * a bar's mirrored HIGH is K − its low. Time and volume are kept — a mirror changes direction,
 * never activity.
 */
export function mirrorCandles(candles: Candle[]): Candle[] {
  const k = 2 * Math.max(...candles.map((c) => c.high)) + 1;
  return candles.map((c) => ({
    time: c.time,
    open: k - c.open,
    high: k - c.low,
    low: k - c.high,
    close: k - c.close,
    volume: c.volume,
  }));
}

/** A trending label swaps side; RANGING and VOLATILE have no side. */
export function mirrorRegime(label: RegimeType): RegimeType {
  if (label === 'TRENDING_UP') return 'TRENDING_DOWN';
  if (label === 'TRENDING_DOWN') return 'TRENDING_UP';
  return label;
}

export function mirrorStructure(structure: PriceStructure): PriceStructure {
  if (structure === 'HIGHER_HIGHS') return 'LOWER_LOWS';
  if (structure === 'LOWER_LOWS') return 'HIGHER_HIGHS';
  return structure;
}

/** mulberry32 — a 32-bit seeded PRNG, so every random walk is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One seeded geometric random walk of `bars` hourly candles starting at `startMs`. `driftSign`
 * picks the side, so a set alternating it covers rallies and declines equally; drift size,
 * volatility and price level vary per seed.
 */
export function randomWalkCandles(seed: number, bars: number, startMs: number, driftSign: 1 | -1): Candle[] {
  const rand = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const drift = driftSign * rand() * 0.004;
  const sigma = 0.003 + rand() * 0.017;
  let open = 100 * (0.5 + rand() * 1.5);
  const out: Candle[] = [];
  for (let i = 0; i < bars; i++) {
    const close = open * Math.exp(drift + sigma * normal());
    out.push({
      time: startMs + i * 3_600_000,
      open,
      high: Math.max(open, close) * Math.exp(Math.abs(normal()) * sigma * 0.5),
      low: Math.min(open, close) * Math.exp(-Math.abs(normal()) * sigma * 0.5),
      close,
      volume: 1000 * Math.exp(0.5 * normal()),
    });
    open = close;
  }
  return out;
}
