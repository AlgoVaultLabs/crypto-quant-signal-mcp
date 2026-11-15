/**
 * SR-ZONES-W1 AC1.2 — no look-ahead. At 200 random cuts t, the zones computed from candles[0..t] alone equal the
 * zones computed as of t on the full series. A formula that read any candle after t would differ (or throw on the
 * truncated series).
 */
import { describe, it, expect } from 'vitest';
import { computeSrZones } from '../../src/lib/sr-zones/zones.js';
import { SR_ZONES_PARAMS } from '../../src/lib/sr-zones/params.js';
import { loadBtcFixture } from './sr-zones-helpers.js';

const candles = loadBtcFixture();

/** mulberry32 — a seeded PRNG, so the 200 cuts are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SR-ZONES-W1 AC1.2 — no look-ahead at 200 random cuts', () => {
  const rand = prng(20261115);
  const lo = SR_ZONES_PARAMS.minClosedBars - 1;
  const cuts = Array.from({ length: 200 }, () => lo + Math.floor(rand() * (candles.length - 1 - lo)));

  it('draws 200 cuts across the fixture', () => {
    expect(cuts).toHaveLength(200);
    expect(new Set(cuts).size).toBeGreaterThan(150);
    expect(Math.min(...cuts)).toBeGreaterThanOrEqual(lo);
    expect(Math.max(...cuts)).toBeLessThan(candles.length - 1);
  });

  it('zones from candles[0..t] equal zones as of t on the full series', () => {
    let withZones = 0;
    for (const t of cuts) {
      const price = candles[t].close;
      const truncated = computeSrZones(candles.slice(0, t + 1), t, price);
      const full = computeSrZones(candles, t, price);
      expect(truncated, `cut t=${t}`).toEqual(full);
      if (full.ok && full.frame.support.length + full.frame.resistance.length > 0) withZones++;
    }
    // Non-vacuity: the comparison ran on real ladders, not on empty frames.
    expect(withZones).toBeGreaterThanOrEqual(190);
  });
});
