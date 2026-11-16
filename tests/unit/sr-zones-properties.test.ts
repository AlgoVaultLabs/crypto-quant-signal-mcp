/**
 * SR-ZONES-W1 R6 (CH3 audit) — properties the response must hold on EVERY fixture candle, not only at the anchor.
 *
 *  #2  ORDER and the description say "each next zone formed earlier and sits further from price". Per side, the
 *      response's own numbers must say so: distance_pct strictly increases with rank, and each next zone's newest
 *      candle is older than the previous zone's oldest candle (next.formed_to < prev.formed_from).
 *  #3  The summary says "price inside <side> zone 1" exactly when low <= price <= high for that zone — the predicate
 *      the price_inside_zone flag uses — and the flag is set exactly when some zone contains price.
 *
 * Every frame from the 21st closed candle on is computed at that candle's close.
 *
 * SR-ZONES-W2 §0.2: the summary prints the served (rounded) range, but "inside" stays the predicate on the computed
 * zone, so #3 holds on the served summary unchanged (BTCUSDT tick 0.1).
 */
import { describe, it, expect } from 'vitest';
import { computeSrZones, type SrZone, type SrZonesFrame } from '../../src/lib/sr-zones/zones.js';
import { buildSrZonesSummary } from '../../src/lib/sr-zones/summary.js';
import { priceLevelStep, roundFrameOutward } from '../../src/lib/sr-zones/rounding.js';
import { SR_ZONES_PARAMS } from '../../src/lib/sr-zones/params.js';
import { loadBtcFixture, isoDay } from './sr-zones-helpers.js';

const candles = loadBtcFixture();
const frames: Array<{ day: string; price: number; frame: SrZonesFrame }> = [];
for (let t = SR_ZONES_PARAMS.minClosedBars - 1; t < candles.length; t++) {
  const price = candles[t].close;
  const r = computeSrZones(candles, t, price);
  if (r.ok) frames.push({ day: isoDay(candles[t].time), price, frame: r.frame });
}
const SIDES = ['support', 'resistance'] as const;
const contains = (z: SrZone, price: number): boolean => z.low <= price && price <= z.high;

describe('SR-ZONES-W1 R6 — fixture-wide properties', () => {
  it('computes a frame on every fixture candle from the 21st on, many with a full ladder (non-vacuity)', () => {
    expect(frames).toHaveLength(candles.length - SR_ZONES_PARAMS.minClosedBars + 1);
    const withLadder = frames.filter(({ frame }) => SIDES.some((s) => frame[s].length >= 2)).length;
    expect(withLadder).toBeGreaterThan(500);
  });

  it('#2 per side, distance_pct strictly increases with rank', () => {
    const violations: string[] = [];
    for (const { day, frame } of frames) {
      for (const side of SIDES) {
        const zs = frame[side];
        for (let i = 1; i < zs.length; i++) {
          if (!(zs[i].distance_pct > zs[i - 1].distance_pct)) {
            violations.push(`${day} ${side} r${i}=${zs[i - 1].distance_pct} r${i + 1}=${zs[i].distance_pct}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('#2 per side, each next zone formed before the previous one', () => {
    const violations: string[] = [];
    for (const { day, frame } of frames) {
      for (const side of SIDES) {
        const zs = frame[side];
        for (let i = 1; i < zs.length; i++) {
          if (!(Date.parse(zs[i].formed_to) < Date.parse(zs[i - 1].formed_from))) {
            violations.push(`${day} ${side} r${i + 1}.formed_to=${zs[i].formed_to} r${i}.formed_from=${zs[i - 1].formed_from}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('#3 the summary says "price inside" exactly when zone 1 contains price, and the flag exactly when any zone does', () => {
    const violations: string[] = [];
    for (const { day, price, frame } of frames) {
      const text = buildSrZonesSummary('BTC', '1d', price, frame, roundFrameOutward(frame, priceLevelStep(price, 0.1)));
      for (const side of SIDES) {
        const z1 = frame[side][0];
        const says = text.includes(`price inside ${side} zone 1`);
        if (says !== (z1 !== undefined && contains(z1, price))) violations.push(`${day} ${side}: summary inside=${says}`);
      }
      const flagged = frame.flags.includes('price_inside_zone');
      if (flagged !== SIDES.some((s) => frame[s].some((z) => contains(z, price)))) violations.push(`${day}: flag=${flagged}`);
    }
    expect(violations).toEqual([]);
  });
});
