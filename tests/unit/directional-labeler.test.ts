import { describe, it, expect } from 'vitest';
import type { Candle } from '../../src/types.js';
import {
  computeSigmaW,
  barrierPct,
  runTripleBarrier,
  computeLabel,
  FLOOR_PCT,
} from '../../src/scripts/directional-labeler.js';

// Candle helper — only high/low/close matter to the labeler.
function candle(high: number, low: number, close = (high + low) / 2, time = 0): Candle {
  return { open: close, high, low, close, volume: 0, time };
}

describe('computeSigmaW', () => {
  it('returns a positive sigma when ≥30 non-overlapping W-windows exist', () => {
    // W=2, need ≥30 windows → ≥61 closes. Build a gently oscillating series.
    const closes = Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)));
    const r = computeSigmaW(closes, 2);
    expect(r.nWindows).toBeGreaterThanOrEqual(30);
    expect(r.sigma).not.toBeNull();
    expect(r.sigma as number).toBeGreaterThan(0);
  });

  it('caps at 60 windows even with abundant history', () => {
    const closes = Array.from({ length: 5000 }, (_, i) => 100 + Math.sin(i / 3));
    const r = computeSigmaW(closes, 12);
    expect(r.nWindows).toBe(60);
  });

  it('< 30 windows available → sigma null (low_vol_history)', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i); // W=12 → only 3 windows
    const r = computeSigmaW(closes, 12);
    expect(r.sigma).toBeNull();
    expect(r.nWindows).toBeLessThan(30);
  });
});

describe('barrierPct', () => {
  it('τ·σ_w in percent when above the floor', () => {
    // σ_w = 0.02 (2%), τ=1.0 → 2.0% > 0.30% floor
    expect(barrierPct(0.02, 1.0)).toBeCloseTo(2.0, 12);
  });
  it('clamps to the 0.30% floor when τ·σ_w is smaller', () => {
    expect(barrierPct(0.001, 1.0)).toBeCloseTo(FLOOR_PCT, 12); // 0.1% → floor 0.30%
  });
  it('null σ_w → floor', () => {
    expect(barrierPct(null, 2.0)).toBeCloseTo(FLOOR_PCT, 12);
  });
  it('τ scales σ_w (τ=2.0)', () => {
    expect(barrierPct(0.02, 2.0)).toBeCloseTo(4.0, 12);
  });
});

describe('runTripleBarrier — BUY', () => {
  const entry = 100;
  const W = 12;
  const bp = 1.0; // 1% → upper 101, lower 99

  it('target-first → +1', () => {
    const fwd = [candle(100.5, 99.8), candle(101.2, 100.1), candle(100.9, 100.0)];
    const r = runTripleBarrier('BUY', entry, fwd, bp, W);
    expect(r.label).toBe(1);
    expect(r.tHitCandles).toBe(2);
    expect(r.ambiguousCandle).toBe(false);
  });

  it('adverse-first → -1', () => {
    const fwd = [candle(100.4, 99.9), candle(100.6, 98.7), candle(101.5, 100.0)];
    const r = runTripleBarrier('BUY', entry, fwd, bp, W);
    expect(r.label).toBe(-1);
    expect(r.tHitCandles).toBe(2);
    expect(r.ambiguousCandle).toBe(false);
  });

  it('neither barrier touched → 0 timeout, tHit null', () => {
    const fwd = [candle(100.4, 99.7), candle(100.8, 99.5), candle(100.9, 99.6)];
    const r = runTripleBarrier('BUY', entry, fwd, bp, W);
    expect(r.label).toBe(0);
    expect(r.tHitCandles).toBeNull();
  });

  it('same-candle both barriers → -1 conservative + ambiguous flag', () => {
    const fwd = [candle(100.3, 99.9), candle(101.4, 98.6)]; // 2nd breaches both
    const r = runTripleBarrier('BUY', entry, fwd, bp, W);
    expect(r.label).toBe(-1);
    expect(r.ambiguousCandle).toBe(true);
    expect(r.tHitCandles).toBe(2);
  });

  it('mfe/mae signed price-perspective over full window', () => {
    const fwd = [candle(100.4, 99.7), candle(100.8, 99.5)];
    const r = runTripleBarrier('BUY', entry, fwd, bp, W);
    expect(r.mfeReturnPct).toBeCloseTo(0.8, 6); // high 100.8 → +0.8%
    expect(r.maeReturnPct).toBeCloseTo(-0.5, 6); // low 99.5 → -0.5%
  });
});

describe('runTripleBarrier — SELL mirror', () => {
  const entry = 100;
  const W = 12;
  const bp = 1.0; // target = lower 99, adverse = upper 101

  it('target-first (down) → +1', () => {
    const fwd = [candle(100.3, 99.6), candle(100.2, 98.9)]; // 2nd hits lower first
    const r = runTripleBarrier('SELL', entry, fwd, bp, W);
    expect(r.label).toBe(1);
    expect(r.tHitCandles).toBe(2);
  });

  it('adverse-first (up) → -1', () => {
    const fwd = [candle(100.4, 99.7), candle(101.3, 100.1)]; // 2nd hits upper first
    const r = runTripleBarrier('SELL', entry, fwd, bp, W);
    expect(r.label).toBe(-1);
    expect(r.tHitCandles).toBe(2);
  });

  it('SELL mfe is signed toward the favorable (down) direction convention', () => {
    // SELL: pfe tracks lowest low (favorable=down) → negative price return; mae tracks highest high.
    const fwd = [candle(100.6, 99.2), candle(100.9, 99.8)];
    const r = runTripleBarrier('SELL', entry, fwd, bp, W);
    expect(r.mfeReturnPct).toBeCloseTo(-0.8, 6); // lowest low 99.2 → -0.8%
    expect(r.maeReturnPct).toBeCloseTo(0.9, 6); // highest high 100.9 → +0.9%
  });
});

describe('computeLabel — integration', () => {
  it('flags low_vol_history and uses the floor when σ_w history is insufficient', () => {
    const r = computeLabel({
      side: 'BUY',
      entryPrice: 100,
      timeframe: '1h', // W=8
      trailingClosesAsc: [99, 100, 101], // far fewer than 30 windows
      forwardAsc: [candle(100.5, 99.9), candle(101.5, 100.1)],
      tau: 1.0,
    });
    expect(r.lowVolHistory).toBe(true);
    expect(r.barrierPct).toBeCloseTo(FLOOR_PCT, 12); // floor used
    expect(r.label).toBe(1); // high 101.5 ≥ upper 100.3 → target-first
  });
});
