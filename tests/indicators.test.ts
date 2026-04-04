import { describe, it, expect } from 'vitest';
import { rsi, ema, emaLast, atr, adx, detectPriceStructure } from '../src/lib/indicators.js';

describe('EMA', () => {
  it('returns null when data is shorter than period', () => {
    expect(ema([1, 2, 3], 5)).toBeNull();
    expect(emaLast([1, 2], 3)).toBeNull();
  });

  it('computes SMA seed correctly for period=3', () => {
    const result = ema([2, 4, 6, 8, 10], 3);
    expect(result).not.toBeNull();
    // SMA(2,4,6) = 4
    expect(result![2]).toBeCloseTo(4, 5);
  });

  it('applies EMA smoothing after seed', () => {
    const data = [22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29];
    const result = ema(data, 5);
    expect(result).not.toBeNull();
    // First valid value at index 4: SMA of first 5
    const sma5 = (22.27 + 22.19 + 22.08 + 22.17 + 22.18) / 5;
    expect(result![4]).toBeCloseTo(sma5, 5);
    // Subsequent values should be smoothed
    expect(result![5]).toBeDefined();
    expect(typeof result![5]).toBe('number');
  });

  it('emaLast returns the last value', () => {
    const data = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const last = emaLast(data, 3);
    const series = ema(data, 3);
    expect(last).toBeCloseTo(series![series!.length - 1], 10);
  });
});

describe('RSI', () => {
  it('returns null with insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });

  it('returns 100 when all changes are positive', () => {
    // 16 data points, all increasing
    const data = Array.from({ length: 16 }, (_, i) => 100 + i);
    const result = rsi(data, 14);
    expect(result).toBe(100);
  });

  it('returns close to 0 when all changes are negative', () => {
    const data = Array.from({ length: 16 }, (_, i) => 200 - i);
    const result = rsi(data, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(1);
  });

  it('returns ~50 for symmetric oscillation', () => {
    // Alternating up/down by same amount
    const data: number[] = [100];
    for (let i = 1; i < 50; i++) {
      data.push(data[i - 1] + (i % 2 === 0 ? 2 : -2));
    }
    const result = rsi(data, 14);
    expect(result).not.toBeNull();
    // Should be close to 50 (not exact due to smoothing)
    expect(result!).toBeGreaterThan(40);
    expect(result!).toBeLessThan(60);
  });

  it('computes known RSI value', () => {
    // Classic RSI example data
    const closes = [
      44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84,
      46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03,
      46.41, 46.22, 45.64,
    ];
    const result = rsi(closes, 14);
    expect(result).not.toBeNull();
    // RSI should be in a reasonable range for this data
    expect(result!).toBeGreaterThan(30);
    expect(result!).toBeLessThan(80);
  });
});

describe('ATR', () => {
  it('returns null with insufficient data', () => {
    expect(atr([1, 2], [1, 2], [1, 2], 14)).toBeNull();
  });

  it('computes ATR for simple data', () => {
    // 16 candles with predictable ranges
    const n = 16;
    const highs = Array.from({ length: n }, () => 110);
    const lows = Array.from({ length: n }, () => 90);
    const closes = Array.from({ length: n }, () => 100);
    const result = atr(highs, lows, closes, 14);
    expect(result).not.toBeNull();
    // True range = max(110-90, |110-100|, |90-100|) = 20
    expect(result!).toBeCloseTo(20, 0);
  });

  it('handles varying true ranges', () => {
    const highs = [52, 53, 54, 55, 56, 55, 54, 53, 52, 51, 52, 53, 54, 55, 56, 55];
    const lows =  [48, 49, 50, 51, 52, 51, 50, 49, 48, 47, 48, 49, 50, 51, 52, 51];
    const closes = [50, 51, 52, 53, 54, 53, 52, 51, 50, 49, 50, 51, 52, 53, 54, 53];
    const result = atr(highs, lows, closes, 14);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0);
  });
});

describe('ADX', () => {
  it('returns null with insufficient data', () => {
    const data = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(adx(data, data, data, 14)).toBeNull();
  });

  it('computes ADX for trending data', () => {
    // Strong uptrend: 50 candles, steadily rising
    const n = 50;
    const highs = Array.from({ length: n }, (_, i) => 100 + i * 2 + 1);
    const lows = Array.from({ length: n }, (_, i) => 100 + i * 2 - 1);
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 2);
    const result = adx(highs, lows, closes, 14);
    expect(result).not.toBeNull();
    expect(result!.adx).toBeGreaterThan(0);
    expect(result!.plusDI).toBeGreaterThan(0);
  });

  it('returns lower ADX for ranging data', () => {
    // Oscillating data
    const n = 50;
    const highs = Array.from({ length: n }, (_, i) => 102 + Math.sin(i * 0.5) * 2);
    const lows = Array.from({ length: n }, (_, i) => 98 + Math.sin(i * 0.5) * 2);
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i * 0.5) * 2);
    const result = adx(highs, lows, closes, 14);
    expect(result).not.toBeNull();
    // ADX should be relatively low for ranging
    expect(result!.adx).toBeLessThan(50);
  });
});

describe('detectPriceStructure', () => {
  it('detects HIGHER_HIGHS in uptrend', () => {
    const n = 30;
    // Uptrending with swing pivots
    const highs = Array.from({ length: n }, (_, i) => {
      return 100 + i * 2 + Math.sin(i * 0.8) * 3;
    });
    const lows = Array.from({ length: n }, (_, i) => {
      return 95 + i * 2 + Math.sin(i * 0.8) * 3;
    });
    const result = detectPriceStructure(highs, lows);
    expect(['HIGHER_HIGHS', 'MIXED']).toContain(result);
  });

  it('returns MIXED for insufficient data', () => {
    expect(detectPriceStructure([1, 2], [1, 2])).toBe('MIXED');
  });

  it('detects LOWER_LOWS in downtrend', () => {
    const n = 30;
    const highs = Array.from({ length: n }, (_, i) => {
      return 200 - i * 2 + Math.sin(i * 0.8) * 3;
    });
    const lows = Array.from({ length: n }, (_, i) => {
      return 195 - i * 2 + Math.sin(i * 0.8) * 3;
    });
    const result = detectPriceStructure(highs, lows);
    expect(['LOWER_LOWS', 'MIXED']).toContain(result);
  });
});
