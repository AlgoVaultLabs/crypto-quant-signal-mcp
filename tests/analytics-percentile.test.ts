/**
 * C1 (LATENCY-W1): unit tests for the application-layer percentile helper that
 * powers the new dashboard p50/p95 columns. App-layer because PERCENTILE_CONT
 * WITHIN GROUP is Postgres-only — these calculations must work under both
 * Postgres (prod) and SQLite (local/test) backends.
 */
import { describe, it, expect } from 'vitest';
import { percentile } from '../src/lib/analytics.js';

describe('percentile (linear interpolation, NumPy-default)', () => {
  it('returns null for empty input', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([], 0.95)).toBeNull();
  });

  it('returns the lone element for single-item input', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 1)).toBe(42);
  });

  it('handles q boundaries by clamping to first/last element', () => {
    const arr = [10, 20, 30];
    expect(percentile(arr, 0)).toBe(10);
    expect(percentile(arr, 1)).toBe(30);
    expect(percentile(arr, -0.1)).toBe(10);
    expect(percentile(arr, 1.1)).toBe(30);
  });

  it('AC1.3: arr=[100,200,…,1000] → p50≈550, p95≈955 (linear interp)', () => {
    const arr = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const p50 = percentile(arr, 0.5);
    const p95 = percentile(arr, 0.95);
    // Linear interp on n=10: pos=0.5*9=4.5 → arr[4] + 0.5*(arr[5]-arr[4]) = 500 + 0.5*100 = 550
    expect(p50).toBe(550);
    // Linear interp on n=10: pos=0.95*9=8.55 → arr[8] + 0.55*(arr[9]-arr[8]) = 900 + 0.55*100 = 955
    expect(p95).toBeCloseTo(955, 5);
  });

  it('handles already-sorted but not-uniform spacing', () => {
    const arr = [1, 2, 3, 4, 100];
    expect(percentile(arr, 0.5)).toBe(3);  // median
    // p95: pos=0.95*4=3.8 → arr[3] + 0.8*(arr[4]-arr[3]) = 4 + 0.8*96 = 80.8
    expect(percentile(arr, 0.95)).toBeCloseTo(80.8, 5);
  });

  it('integer position (q lands exactly on an index)', () => {
    const arr = [10, 20, 30, 40, 50];
    // pos=0.5*4=2.0 → arr[2] = 30
    expect(percentile(arr, 0.5)).toBe(30);
  });

  it('matches NumPy default for a known reference dataset', () => {
    // Reference values produced by `numpy.percentile([1,2,3,...,20], [25,50,75,90,95])`:
    //   25 → 5.75, 50 → 10.5, 75 → 15.25, 90 → 18.1, 95 → 19.05
    const arr = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(arr, 0.25)).toBeCloseTo(5.75, 5);
    expect(percentile(arr, 0.50)).toBeCloseTo(10.5, 5);
    expect(percentile(arr, 0.75)).toBeCloseTo(15.25, 5);
    expect(percentile(arr, 0.90)).toBeCloseTo(18.1, 5);
    expect(percentile(arr, 0.95)).toBeCloseTo(19.05, 5);
  });
});
