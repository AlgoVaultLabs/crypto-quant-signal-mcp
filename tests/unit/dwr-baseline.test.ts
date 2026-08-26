import { describe, it, expect } from 'vitest';
import {
  deriveRaceOutcome,
  benchmarks,
  computeCellStats,
  firstPerCoin,
  medianOf,
  type LabelRow,
} from '../../src/scripts/dwr-baseline.js';

describe('deriveRaceOutcome', () => {
  it('BUY: +1→upper, -1→lower', () => {
    expect(deriveRaceOutcome('BUY', 1, false)).toBe('upper');
    expect(deriveRaceOutcome('BUY', -1, false)).toBe('lower');
  });
  it('SELL mirror: +1→lower, -1→upper', () => {
    expect(deriveRaceOutcome('SELL', 1, false)).toBe('lower');
    expect(deriveRaceOutcome('SELL', -1, false)).toBe('upper');
  });
  it('timeout and ambiguous take precedence', () => {
    expect(deriveRaceOutcome('BUY', 0, false)).toBe('timeout');
    expect(deriveRaceOutcome('SELL', -1, true)).toBe('ambiguous');
  });
});

describe('benchmarks — computed, not complements', () => {
  it('ambiguous is a loss for BOTH sides → alwaysBuy + alwaysSell < 1', () => {
    const rows: LabelRow[] = [
      { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 1, barrierPct: 0.3 }, // upper
      { side: 'BUY', label: 1, ambiguous: false, coin: 'ETH', createdAt: 2, barrierPct: 0.3 }, // upper
      { side: 'BUY', label: 1, ambiguous: false, coin: 'SOL', createdAt: 3, barrierPct: 0.3 }, // upper
      { side: 'BUY', label: -1, ambiguous: false, coin: 'XRP', createdAt: 4, barrierPct: 0.3 }, // lower
      { side: 'BUY', label: -1, ambiguous: true, coin: 'ADA', createdAt: 5, barrierPct: 0.3 }, // ambiguous
      { side: 'BUY', label: 0, ambiguous: false, coin: 'DOT', createdAt: 6, barrierPct: 0.3 }, // timeout (excluded)
    ];
    const b = benchmarks(rows);
    expect(b.uppers).toBe(3);
    expect(b.lowers).toBe(1);
    expect(b.ambiguous).toBe(1);
    expect(b.alwaysBuyDwr).toBeCloseTo(3 / 5, 12); // 0.6
    expect(b.alwaysSellDwr).toBeCloseTo(1 / 5, 12); // 0.2
    expect(b.alwaysBuyDwr + b.alwaysSellDwr).toBeLessThan(1); // not complements (ambiguous)
  });
});

describe('computeCellStats', () => {
  it('all-BUY cell: engine DWR == alwaysBUY, edge 0, constant-side (PT undefined)', () => {
    const rows: LabelRow[] = [
      { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 1, barrierPct: 0.3 },
      { side: 'BUY', label: 1, ambiguous: false, coin: 'ETH', createdAt: 2, barrierPct: 0.3 },
      { side: 'BUY', label: 1, ambiguous: false, coin: 'SOL', createdAt: 3, barrierPct: 0.3 },
      { side: 'BUY', label: -1, ambiguous: false, coin: 'XRP', createdAt: 4, barrierPct: 0.3 },
      { side: 'BUY', label: -1, ambiguous: true, coin: 'ADA', createdAt: 5, barrierPct: 0.3 },
      { side: 'BUY', label: 0, ambiguous: false, coin: 'DOT', createdAt: 6, barrierPct: 0.3 },
    ];
    const s = computeCellStats(rows);
    expect(s.wins).toBe(3);
    expect(s.losses).toBe(2);
    expect(s.timeouts).toBe(1);
    expect(s.dwr).toBeCloseTo(0.6, 12);
    expect(s.dwr).toBeCloseTo(s.alwaysBuyDwr, 12); // an all-BUY cell can't beat always-BUY
    expect(s.edge).toBeCloseTo(0, 12);
    expect(s.constantSide).toBe(true);
    expect(s.ptAll.na).toBe('CONSTANT_SIDE');
  });

  it('mixed cell: benchmarks 0.5/0.5, edge 0, PT defined', () => {
    const rows: LabelRow[] = [
      { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 1, barrierPct: 0.3 }, // upper, correct
      { side: 'SELL', label: 1, ambiguous: false, coin: 'ETH', createdAt: 2, barrierPct: 0.3 }, // lower, correct
      { side: 'BUY', label: -1, ambiguous: false, coin: 'SOL', createdAt: 3, barrierPct: 0.3 }, // lower, wrong
      { side: 'SELL', label: -1, ambiguous: false, coin: 'XRP', createdAt: 4, barrierPct: 0.3 }, // upper, wrong
    ];
    const s = computeCellStats(rows);
    expect(s.dwr).toBeCloseTo(0.5, 12);
    expect(s.alwaysBuyDwr).toBeCloseTo(0.5, 12);
    expect(s.alwaysSellDwr).toBeCloseTo(0.5, 12);
    expect(s.edge).toBeCloseTo(0, 12);
    expect(s.constantSide).toBe(false);
    expect(s.ptAll.na).toBeNull();
    expect(Math.abs(s.ptAll.z as number)).toBeLessThan(1); // independent → ~0
  });
});

describe('firstPerCoin', () => {
  it('keeps the earliest call per symbol', () => {
    const rows: LabelRow[] = [
      { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 30, barrierPct: 0.3 },
      { side: 'SELL', label: -1, ambiguous: false, coin: 'BTC', createdAt: 10, barrierPct: 0.3 }, // earliest BTC
      { side: 'BUY', label: 1, ambiguous: false, coin: 'ETH', createdAt: 20, barrierPct: 0.3 },
    ];
    const out = firstPerCoin(rows).sort((a, b) => a.coin.localeCompare(b.coin));
    expect(out).toHaveLength(2);
    expect(out[0].coin).toBe('BTC');
    expect(out[0].createdAt).toBe(10);
    expect(out[1].coin).toBe('ETH');
  });
});


// ── EDGE-DWR-VALIDATED-PREDICATE-W1 ────────────────────────────────────────────────────────

describe('medianOf — a selection, not an estimator', () => {
  it('odd length takes the middle element', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
  });
  it('even length averages the two middles', () => {
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });
  it('does not mutate its argument (the caller may still need row order)', () => {
    const xs = [3, 1, 2];
    medianOf(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
  it('drops non-finite values rather than propagating NaN through the sort', () => {
    expect(medianOf([1, NaN, 3, Infinity, 2])).toBe(2);
  });
  it('an empty sample is NaN, never a plausible zero', () => {
    expect(medianOf([])).toBeNaN();
    expect(medianOf([NaN])).toBeNaN();
  });
});

describe('computeCellStats: barrierPctMedian', () => {
  const at = (barrierPct: number, coin: string, createdAt: number): LabelRow =>
    ({ side: 'BUY', label: 1, ambiguous: false, coin, createdAt, barrierPct });

  it('is the MEDIAN, so a single very wide race cannot carry the magnitude test', () => {
    // Right-skewed exactly like the live cells: 35%+ of rows pinned at the 0.30 floor, one
    // outlier two orders of magnitude wider. Mean would be ~4.1; median is 0.30.
    const rows = [at(0.3, 'A', 1), at(0.3, 'B', 2), at(0.3, 'C', 3), at(0.3, 'D', 4), at(19.75, 'E', 5)];
    expect(computeCellStats(rows).barrierPctMedian).toBe(0.3);
    const mean = rows.reduce((t, r) => t + r.barrierPct, 0) / rows.length;
    expect(mean).toBeGreaterThan(4);
  });

  it('an empty cell reports NaN — the predicate reads that as INPUT_NOT_MEASURABLE', () => {
    expect(computeCellStats([]).barrierPctMedian).toBeNaN();
  });
});
