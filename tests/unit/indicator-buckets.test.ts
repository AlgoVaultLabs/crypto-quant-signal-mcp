/**
 * Unit tests for v1.10.0 indicator-bucketing helpers.
 *
 * Boundary semantics covered (per spec OUTPUT-SANITIZE-W1 C1):
 *   bucketTrendPersistence:
 *     - hurst < 0.45 → LOW
 *     - 0.45 ≤ hurst ≤ 0.55 → MEDIUM (BOTH boundaries inclusive)
 *     - hurst > 0.55 → HIGH
 *     - null → MEDIUM
 *   bucketFundingState:
 *     - |z| ≤ 1.5 → NORMAL (1.5 inclusive)
 *     - 1.5 < |z| ≤ 2.5 → ELEVATED (2.5 inclusive)
 *     - |z| > 2.5 → EXTREME
 *     - null → NORMAL
 *   bucketBreakoutPending:
 *     - false → INACTIVE
 *     - true → IMMINENT
 */
import { describe, it, expect } from 'vitest';
import {
  bucketTrendPersistence,
  bucketFundingState,
  bucketBreakoutPending,
} from '../../src/lib/indicator-buckets.js';

describe('bucketTrendPersistence (Hurst → LOW/MEDIUM/HIGH)', () => {
  it('hurst=0.3 → LOW (mean-reverting)', () => {
    expect(bucketTrendPersistence(0.3)).toBe('LOW');
  });
  it('hurst=0.5 → MEDIUM (random walk)', () => {
    expect(bucketTrendPersistence(0.5)).toBe('MEDIUM');
  });
  it('hurst=0.6 → HIGH (trending)', () => {
    expect(bucketTrendPersistence(0.6)).toBe('HIGH');
  });
  it('hurst=null → MEDIUM (insufficient-data default)', () => {
    expect(bucketTrendPersistence(null)).toBe('MEDIUM');
  });
  it('hurst=0.45 (lower boundary) → MEDIUM', () => {
    expect(bucketTrendPersistence(0.45)).toBe('MEDIUM');
  });
  it('hurst=0.55 (upper boundary) → MEDIUM', () => {
    expect(bucketTrendPersistence(0.55)).toBe('MEDIUM');
  });
  it('hurst=0.0 (extreme low) → LOW', () => {
    expect(bucketTrendPersistence(0.0)).toBe('LOW');
  });
  it('hurst=1.0 (extreme high) → HIGH', () => {
    expect(bucketTrendPersistence(1.0)).toBe('HIGH');
  });
  it('hurst=0.4499... (just-below 0.45) → LOW', () => {
    expect(bucketTrendPersistence(0.4499)).toBe('LOW');
  });
  it('hurst=0.5501 (just-above 0.55) → HIGH', () => {
    expect(bucketTrendPersistence(0.5501)).toBe('HIGH');
  });
});

describe('bucketFundingState (|z| → NORMAL/ELEVATED/EXTREME)', () => {
  it('z=0 → NORMAL', () => {
    expect(bucketFundingState(0)).toBe('NORMAL');
  });
  it('z=1.6 → ELEVATED', () => {
    expect(bucketFundingState(1.6)).toBe('ELEVATED');
  });
  it('z=-2.6 → EXTREME (sign-symmetric: |z|=2.6)', () => {
    expect(bucketFundingState(-2.6)).toBe('EXTREME');
  });
  it('z=null → NORMAL (insufficient-data default)', () => {
    expect(bucketFundingState(null)).toBe('NORMAL');
  });
  it('z=1.5 (boundary) → NORMAL (inclusive lower)', () => {
    expect(bucketFundingState(1.5)).toBe('NORMAL');
  });
  it('z=-1.5 (boundary, negative side) → NORMAL', () => {
    expect(bucketFundingState(-1.5)).toBe('NORMAL');
  });
  it('z=2.5 (boundary) → ELEVATED (inclusive lower of ELEVATED)', () => {
    expect(bucketFundingState(2.5)).toBe('ELEVATED');
  });
  it('z=-2.5 (boundary, negative side) → ELEVATED', () => {
    expect(bucketFundingState(-2.5)).toBe('ELEVATED');
  });
  it('z=1.50001 (just-above 1.5) → ELEVATED', () => {
    expect(bucketFundingState(1.50001)).toBe('ELEVATED');
  });
  it('z=2.5001 (just-above 2.5) → EXTREME', () => {
    expect(bucketFundingState(2.5001)).toBe('EXTREME');
  });
});

describe('bucketBreakoutPending (squeeze → INACTIVE/IMMINENT)', () => {
  it('false → INACTIVE', () => {
    expect(bucketBreakoutPending(false)).toBe('INACTIVE');
  });
  it('true → IMMINENT', () => {
    expect(bucketBreakoutPending(true)).toBe('IMMINENT');
  });
});
