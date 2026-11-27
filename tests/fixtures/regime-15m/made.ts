// tests/fixtures/regime-15m/made.ts — EDGE-REGIME-15M-BACKTEST-W1: hand-made measures for Bar A's tests. Every number
// is chosen by the test that uses it; nothing here is read from data.
import type { Measures, Pre, TfMeasures } from '../../../src/scripts/regime-15m/r15-stats.js';

export interface Made {
  /** 1h's A4 excess over the coin flip and over always-up (pp); δ_A4 is half the smaller. */
  a4Coin1h: number; a4Up1h: number;
  /** 1h's Δ1 (pp); δ_Δ1 is half of it. */
  d1_1h: number;
  /** The paired differences (15m − 1h): point and lower bound. */
  a4Theta: { point: number; lb: number }; d1Theta: { point: number; lb: number };
  /** Flip-flops per 1,000 bars, by timeframe. */
  ff: Record<'15m' | '1h' | '4h' | '1d', number>;
}
export const BASE: Made = { a4Coin1h: 20, a4Up1h: 10, d1_1h: 8, a4Theta: { point: 0, lb: -1 }, d1Theta: { point: 0, lb: -1 }, ff: { '15m': 20, '1h': 12, '4h': 30, '1d': 10 } };

const iv = (point: number, lb = point, ub = point) => ({ point, lb, ub });
/** Measures with only what Bar A reads filled in; the rest are NaN-free placeholders. */
export function madeMeasures(o: Made = BASE): Measures {
  const tf = (key: '15m' | '1h' | '4h' | '1d'): TfMeasures => ({
    tf: key,
    a4: { rows: 100, clusters: 100, eff: 100, agreement: iv(60), baselines: { always_up: 50, always_down: 50, coin: 50 }, excess: { always_up: iv(key === '1h' ? o.a4Up1h : 10), always_down: iv(10), coin: iv(key === '1h' ? o.a4Coin1h : 10) } },
    d1: { rows: 100, clusters: 100, eff: 100, delta1: iv(key === '1h' ? o.d1_1h : 5), U: iv(2), D: iv(3), baselines: { always_up: -1, always_down: 1, coin: 0 }, excess: { always_up: iv(6), always_down: iv(4), coin: iv(5) }, by_hold: [5, 5, 5, 5, 5] },
    flip_flops: { bars: 1000, changes: 100, flipflops: o.ff[key], per_1000: o.ff[key], baselines: { always_up: 0, always_down: 0, coin: 250 } },
    lag: { turns: 10, censored: 1, median_bars: 2, median_hours: 2 },
    runs: { runs: 10, meanLen: 5, medianLen: 4, signed: 1 },
  });
  const pair = (t: { point: number; lb: number }) => ({ theta: { point: t.point, lb: t.lb, ub: t.point + (t.point - t.lb) }, arm15: iv(1), arm1h: iv(1), rows: 100, clusters: 100, eff: 100 });
  return { tfs: (['15m', '1h', '4h', '1d'] as const).map(tf), a4_pair: pair(o.a4Theta), d1_pair: pair(o.d1Theta), keys: [], diagnosis: 'none' };
}
/** The floors written before the outcomes: every timeframe at `eff` effective coin-days against the floor `F`. */
export function madePre(eff = 100, F = 50, overrides: Partial<Record<'15m' | '1h' | '4h' | '1d', Partial<Pre['tfs'][number]>>> = {}): Pre {
  const tfs = (['15m', '1h', '4h', '1d'] as const).map((tf) => ({ tf, a4_rows: 100, a4_eff: eff, d1_rows: 100, d1_eff: eff, ff_coin_days: eff, served_minority: 0.4, phase_minority: 0.4, ...overrides[tf] }));
  const failures = tfs.flatMap((t) => (['a4_eff', 'd1_eff', 'ff_coin_days'] as const).filter((k) => !(Number.isFinite(t[k]) && t[k] >= F)).map((k) => `${t.tf} ${k}`));
  return { entries: 1000, comparison_entries: 900, coins: 2, F, tfs, floor_ok: failures.length === 0, floor_failures: failures };
}
