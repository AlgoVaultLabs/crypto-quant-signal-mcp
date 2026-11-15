/**
 * SR-ZONES-W1 AC1.1 — the BTC anchor. The frozen knobs (src/lib/sr-zones/params.ts) must reproduce Mr.1's BTCUSDT
 * 1d chart (Binance, price 67,585.6), pixel-read to ±1%:
 *
 *   Support 1     formed by candles dated 2026-08-13…08-18   meets 61,600–62,700   width ≤ 1 × ATR
 *   Support 2     formed by candles dated 2026-06-25…07-06   meets 57,300–58,400   width ≤ 1 × ATR
 *   Support 3     contains the 2024-08-05 or 2024-09-06 low  meets 48,600–53,000   width ≤ 2.5 × ATR
 *   Resistance 1  formed by candles dated 2026-11-08…11-12
 */
import { describe, it, expect } from 'vitest';
import { computeSrZones, wilderAtr, type SrZone } from '../../src/lib/sr-zones/zones.js';
import { loadBtcFixture, isoDay } from './sr-zones-helpers.js';

const CHART_PRICE = 67_585.6;
const candles = loadBtcFixture();
const t = candles.length - 1;
const atr = wilderAtr(candles, t)[t] as number;

const computed = computeSrZones(candles, t, CHART_PRICE);
if (!computed.ok) throw new Error(`fixture unservable: ${computed.reason}`);
const { support, resistance } = computed.frame;

/** The zone intersects the chart band widened by the ±1% pixel-read tolerance. */
const meets = (z: SrZone, lo: number, hi: number): boolean => z.low <= hi * 1.01 && z.high >= lo * 0.99;
const formedWithin = (z: SrZone, from: string, to: string): boolean =>
  isoDay(Date.parse(z.formed_from)) >= from && isoDay(Date.parse(z.formed_to)) <= to;
const width = (z: SrZone): number => z.high - z.low;

describe('SR-ZONES-W1 AC1.1 — BTC 1d anchor (Mr.1 chart, price 67,585.6)', () => {
  it('reads the fixture it was fitted on', () => {
    expect(isoDay(candles[t].time)).toBe('2026-11-13');
    expect(candles).toHaveLength(1000);
    expect(atr).toBeGreaterThan(2000);
  });

  it('support 1: the 2026-08-13…08-18 base, meets 61,600–62,700, at most 1 × ATR wide', () => {
    const z = support[0];
    expect(z.rank).toBe(1);
    expect(formedWithin(z, '2026-08-13', '2026-08-18')).toBe(true);
    expect(meets(z, 61_600, 62_700)).toBe(true);
    expect(width(z)).toBeLessThanOrEqual(1 * atr);
  });

  it('support 2: the 2026-06-25…07-06 bottom, meets 57,300–58,400, at most 1 × ATR wide', () => {
    const z = support[1];
    expect(z.rank).toBe(2);
    expect(formedWithin(z, '2026-06-25', '2026-07-06')).toBe(true);
    expect(meets(z, 57_300, 58_400)).toBe(true);
    expect(width(z)).toBeLessThanOrEqual(1 * atr);
  });

  it('support 3: contains the 2024-08-05 or 2024-09-06 low, meets 48,600–53,000, at most 2.5 × ATR wide', () => {
    const z = support[2];
    expect(z.rank).toBe(3);
    const holds = ['2024-08-05', '2024-09-06'].some((day) => {
      const c = candles.find((x) => isoDay(x.time) === day);
      return (
        !!c &&
        isoDay(Date.parse(z.formed_from)) <= day &&
        isoDay(Date.parse(z.formed_to)) >= day &&
        z.low <= c.low &&
        c.low <= z.high
      );
    });
    expect(holds).toBe(true);
    expect(meets(z, 48_600, 53_000)).toBe(true);
    expect(width(z)).toBeLessThanOrEqual(2.5 * atr);
  });

  it('resistance 1: formed by candles dated 2026-11-08…11-12', () => {
    const z = resistance[0];
    expect(z.rank).toBe(1);
    expect(formedWithin(z, '2026-11-08', '2026-11-12')).toBe(true);
  });

  it('locks the fitted ladder (any change to the formula or the knobs moves these numbers)', () => {
    const view = (z: SrZone) => [Math.round(z.low), Math.round(z.high), z.formed_from.slice(0, 10), z.formed_to.slice(0, 10)];
    expect(support.map(view)).toEqual([
      [62484, 63235, '2026-08-13', '2026-08-14'],
      [57759, 59189, '2026-06-25', '2026-07-01'],
      [52511, 54384, '2024-09-06', '2024-09-09'],
    ]);
    expect(resistance.map(view)).toEqual([
      [75836, 76449, '2026-11-08', '2026-11-08'],
      [80467, 81188, '2026-11-04', '2026-11-04'],
      [83588, 84875, '2026-10-14', '2026-10-21'],
    ]);
  });

  it('the anchor holds at the fixture close (68,279.8) too', () => {
    const atClose = computeSrZones(candles, t, candles[t].close);
    if (!atClose.ok) throw new Error(atClose.reason);
    expect(atClose.frame.support.map((z) => Math.round(z.low))).toEqual(support.map((z) => Math.round(z.low)));
    expect(atClose.frame.resistance[0].formed_from).toBe(resistance[0].formed_from);
  });
});
