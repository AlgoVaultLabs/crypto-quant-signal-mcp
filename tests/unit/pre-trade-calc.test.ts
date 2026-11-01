/**
 * DECISION-CALL-V2-W1 CH1 AC1.1 — `pre-trade-calc.ts`, the one calculator behind every v2 figure.
 *
 * Golden vectors from the wave's contract (`Prompt/DECISION-CALL-V2-W1.md` AC1.1), each pinned to the shown
 * rounding: price-scale and equity figures to 4 dp, the three accuracy / win-rate / random-entry figures to 2.
 * Every figure is null when an input it needs is absent — never a guessed 0.
 */
import { describe, it, expect } from 'vitest';
import {
  computePreTradeCalc,
  sigma1hFromVolatilityRatio,
  roundTripBps,
  feeBpsFromPct,
  liquidationDistance,
  type PreTradeCalcInput,
} from '../../src/lib/pre-trade-calc.js';
import { liquidationMaintenanceRate } from '../../src/lib/venue-margin-tiers.js';

const base: PreTradeCalcInput = {
  side: 'long', sizeUsd: 10_000, holdHours: 8, sigma1h: null, roundTripBps: null,
  leverage: null, maintenanceRate: null, stopPct: null, targetPct: null, equityUsd: null,
};
const calc = (over: Partial<PreTradeCalcInput>) => computePreTradeCalc({ ...base, ...over });

describe('AC1.1 golden vectors', () => {
  it('isolated liquidation: long 20x at m 0.4% → 4.6185%; short → 4.5817%', () => {
    expect(calc({ leverage: 20, maintenanceRate: 0.004 }).liq_distance_pct).toBe(4.6185);
    expect(calc({ side: 'short', leverage: 20, maintenanceRate: 0.004 }).liq_distance_pct).toBe(4.5817);
  });

  it('Bitget adds its taker fee to m (0.4% + 0.06%) → 4.5610%; the other venues use the tier rate as published', () => {
    const m = liquidationMaintenanceRate('BITGET', 0.004);
    expect(m).toBe(0.0046);
    expect(calc({ leverage: 20, maintenanceRate: m }).liq_distance_pct).toBe(4.561);
    for (const venue of ['BYBIT', 'OKX', 'BINANCE']) expect(liquidationMaintenanceRate(venue, 0.004), venue).toBe(0.004);
  });

  it('volatility_ratio 0.01 → sigma_1h 0.6267%', () => {
    expect(calc({ sigma1h: sigma1hFromVolatilityRatio(0.01) }).sigma_1h_pct).toBe(0.6267);
  });

  it('sigma_1h 0.43%, hold 0.5 h, round trip 11 bps → accuracy needed 72.67%', () => {
    expect(calc({ sigma1h: 0.0043, holdHours: 0.5, roundTripBps: 11 }).accuracy_needed_pct).toBe(72.67);
  });

  it('stop 0.5%, target 0.75%, round trip 13 bps → win rate needed 50.40%, random entry target-first 40.00%', () => {
    const c = calc({ stopPct: 0.5, targetPct: 0.75, roundTripBps: 13 });
    expect(c.win_rate_needed_pct).toBe(50.4);
    expect(c.random_entry_target_first_pct).toBe(40);
  });

  it('size 10k, equity 10k, sigma_1h 0.5% → one-sigma day 2.4495% of equity', () => {
    expect(calc({ equityUsd: 10_000, sigma1h: 0.005 }).one_sigma_day_pct_equity).toBe(2.4495);
  });

  it('size 10k, stop 2%, round trip 11 bps, equity 5k → loss at stop 4.22% of equity', () => {
    expect(calc({ stopPct: 2, roundTripBps: 11, equityUsd: 5_000 }).loss_at_stop_pct_equity).toBe(4.22);
  });
});

describe('the derived figures, and their absence', () => {
  it('sigma over the hold scales by sqrt(hold); the expected move is sigma_H * sqrt(2/pi)', () => {
    const c = calc({ sigma1h: 0.005, holdHours: 4 });
    expect(c.sigma_hold_pct).toBe(1);
    expect(c.expected_move_pct).toBe(0.7979);
  });

  it('liq_distance_sigma = d / sigma_H; liq_before_stop compares the shown distance with the stop (<=)', () => {
    const c = calc({ sigma1h: 0.005, holdHours: 4, leverage: 20, maintenanceRate: 0.004, stopPct: 4.6185 });
    expect(c.liq_distance_sigma).toBe(4.6185);
    expect(c.liq_before_stop).toBe(true);
    expect(calc({ leverage: 20, maintenanceRate: 0.004, stopPct: 4.6184 }).liq_before_stop).toBe(false);
  });

  it('accuracy needed is uncapped: a round trip the expected move cannot cover reads >= 100', () => {
    expect(calc({ sigma1h: 0.0001, holdHours: 1, roundTripBps: 11 }).accuracy_needed_pct as number).toBeGreaterThanOrEqual(100);
  });

  it('margin below the maintenance rate reads a non-positive distance: liquidation comes before any stop', () => {
    expect(liquidationDistance('long', 200, 0.005)).toBe(0);
    const c = calc({ leverage: 200, maintenanceRate: 0.006, stopPct: 0.5 });
    expect(c.liq_distance_pct).toBe(-0.1006);
    expect(c.liq_before_stop).toBe(true);
  });

  it('with no v2 input only the volatility figures can be set; everything else is null', () => {
    const c = calc({ sigma1h: 0.005 });
    expect([c.sigma_1h_pct, c.sigma_hold_pct, c.expected_move_pct].every((x) => typeof x === 'number')).toBe(true);
    expect([c.round_trip_bps, c.accuracy_needed_pct, c.win_rate_needed_pct, c.random_entry_target_first_pct, c.liq_distance_pct,
      c.liq_distance_sigma, c.liq_before_stop, c.loss_at_stop_pct_equity, c.one_sigma_day_pct_equity]).toEqual(Array(9).fill(null));
    expect(Object.values(calc({})).every((x) => x === null)).toBe(true);
  });

  it('round trip = entry + exit fee + the quoted spread (none quoted: + 0); a missing fee leaves it null', () => {
    expect(roundTripBps({ entryFeeBps: 5, exitFeeBps: 5, spreadBps: 1.2345 })).toBe(11.2345);
    expect(roundTripBps({ entryFeeBps: 2, exitFeeBps: 5, spreadBps: null })).toBe(7);
    expect(roundTripBps({ entryFeeBps: null, exitFeeBps: 5, spreadBps: 1 })).toBeNull();
  });

  it('fee percent to bps, as venue-fees.ts converts the taker fee', () => {
    expect([feeBpsFromPct(0.02), feeBpsFromPct(0.055), feeBpsFromPct(0.06)]).toEqual([2, 5.5, 6]);
  });

  it('a non-positive volatility ratio is no sigma', () => {
    expect([sigma1hFromVolatilityRatio(0), sigma1hFromVolatilityRatio(-1), sigma1hFromVolatilityRatio(null), sigma1hFromVolatilityRatio(Number.NaN)])
      .toEqual([null, null, null, null]);
  });
});
