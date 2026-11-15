/**
 * SR-ZONES-W1 AC1.5 — stability, RECORDED, not gated. On each of the last 365 fixture candles, does zone 1 change
 * identity (the candles that formed it) from the candle before while price did not reach the old zone 1? Price
 * reaching it (closing at or through its near edge) explains a change; anything else — a newer cluster forming, ATR
 * moving a band — is a change without a break. The share is printed for the CH1 status entry.
 */
import { describe, it, expect } from 'vitest';
import { computeSrZones, type SrZone } from '../../src/lib/sr-zones/zones.js';
import { loadBtcFixture } from './sr-zones-helpers.js';

const candles = loadBtcFixture();
const DAYS = 365;

function zone1(t: number, side: 'support' | 'resistance'): SrZone | undefined {
  const r = computeSrZones(candles, t, candles[t].close);
  return r.ok ? r.frame[side][0] : undefined;
}

const identity = (z: SrZone | undefined): string => (z ? `${z.formed_from}|${z.formed_to}` : 'none');

function changesWithoutBreak(side: 'support' | 'resistance'): { changed: number; unexplained: number; days: boolean[] } {
  const days: boolean[] = [];
  let changed = 0;
  let unexplained = 0;
  for (let t = candles.length - DAYS; t < candles.length; t++) {
    const before = zone1(t - 1, side);
    const now = zone1(t, side);
    const isChange = identity(before) !== identity(now);
    const reached =
      before !== undefined && (side === 'support' ? candles[t].close <= before.high : candles[t].close >= before.low);
    if (isChange) changed++;
    const flag = isChange && !reached;
    if (flag) unexplained++;
    days.push(flag);
  }
  return { changed, unexplained, days };
}

describe('SR-ZONES-W1 AC1.5 — zone-1 stability over the last 365 fixture candles (recorded)', () => {
  it('computes and records the share of candles on which zone 1 changes without a break', () => {
    const s = changesWithoutBreak('support');
    const r = changesWithoutBreak('resistance');
    const either = s.days.filter((d, i) => d || r.days[i]).length;
    const share = (n: number): string => (n / DAYS).toFixed(3);
    // eslint-disable-next-line no-console
    console.log(
      `SR_ZONES_STABILITY days=${DAYS} support_changed=${s.changed} support_unexplained=${s.unexplained} (${share(s.unexplained)}) ` +
        `resistance_changed=${r.changed} resistance_unexplained=${r.unexplained} (${share(r.unexplained)}) ` +
        `either_unexplained=${either} (${share(either)})`,
    );
    expect(s.days).toHaveLength(DAYS);
    expect(r.days).toHaveLength(DAYS);
    expect(either).toBeGreaterThanOrEqual(0);
    expect(either).toBeLessThanOrEqual(DAYS);
  });
});
