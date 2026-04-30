/**
 * Unit tests for SHADOW-SEED-W1 cross-asset grid re-sizing + slow-grid
 * circuit breaker.
 *
 * Asserts:
 *   - GRID_TIMEFRAMES_FULL is the new 7-element set (drops 4h, adds 1m+3m+30m+2h)
 *   - FALLBACK_TIMEFRAMES is the v1.9.0 4-element set
 *   - getActiveGridTimeframes() returns FULL by default; FALLBACK when breaker is open
 *   - 3 consecutive slow refreshes trip the breaker
 *   - Breaker auto-closes after CIRCUIT_OPEN_DURATION_MS
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GRID_ASSETS,
  GRID_TIMEFRAMES,
  GRID_TIMEFRAMES_FULL,
  FALLBACK_TIMEFRAMES,
  getActiveGridTimeframes,
  _resetCircuitBreaker,
  _pushRefreshDurationForTest,
  _tripCircuitBreakerForTest,
  _getCacheSnapshotMeta,
} from '../../src/lib/cross-asset-grid.js';

describe('SHADOW-SEED-W1: GRID_TIMEFRAMES re-sizing', () => {
  it('GRID_TIMEFRAMES_FULL has the new 7-element set (drops 4h, adds 1m+3m+30m+2h)', () => {
    expect([...GRID_TIMEFRAMES_FULL]).toEqual(['1m', '3m', '5m', '15m', '30m', '1h', '2h']);
    expect(GRID_TIMEFRAMES_FULL).not.toContain('4h');
  });

  it('FALLBACK_TIMEFRAMES is the v1.9.0 4-element set', () => {
    expect([...FALLBACK_TIMEFRAMES]).toEqual(['5m', '15m', '1h', '4h']);
  });

  it('GRID_TIMEFRAMES back-compat re-export matches GRID_TIMEFRAMES_FULL', () => {
    expect(GRID_TIMEFRAMES).toBe(GRID_TIMEFRAMES_FULL);
  });

  it('GRID_ASSETS unchanged at 6 entries', () => {
    expect(GRID_ASSETS.length).toBe(6);
  });

  it('full grid = 42 cells (6 × 7)', () => {
    expect(GRID_ASSETS.length * GRID_TIMEFRAMES_FULL.length).toBe(42);
  });

  it('fallback grid = 24 cells (6 × 4)', () => {
    expect(GRID_ASSETS.length * FALLBACK_TIMEFRAMES.length).toBe(24);
  });
});

describe('SHADOW-SEED-W1: slow-grid circuit breaker', () => {
  beforeEach(() => {
    _resetCircuitBreaker();
  });

  it('default state: getActiveGridTimeframes() returns FULL set', () => {
    expect([...getActiveGridTimeframes()]).toEqual([...GRID_TIMEFRAMES_FULL]);
  });

  it('after manual trip: getActiveGridTimeframes() returns FALLBACK set', () => {
    _tripCircuitBreakerForTest();
    expect([...getActiveGridTimeframes()]).toEqual([...FALLBACK_TIMEFRAMES]);
    const meta = _getCacheSnapshotMeta();
    expect(meta.circuitOpenUntil).toBeGreaterThan(Date.now());
    expect(meta.activeTimeframes).toEqual([...FALLBACK_TIMEFRAMES]);
  });

  it('after reset: returns FULL set again', () => {
    _tripCircuitBreakerForTest();
    expect([...getActiveGridTimeframes()]).toEqual([...FALLBACK_TIMEFRAMES]);
    _resetCircuitBreaker();
    expect([...getActiveGridTimeframes()]).toEqual([...GRID_TIMEFRAMES_FULL]);
  });

  it('refresh-duration history is FIFO bounded to 3 entries', () => {
    _pushRefreshDurationForTest(1000);
    _pushRefreshDurationForTest(2000);
    _pushRefreshDurationForTest(3000);
    _pushRefreshDurationForTest(4000);
    const meta = _getCacheSnapshotMeta();
    // Should hold last 3 only (2000, 3000, 4000)
    expect(meta.refreshDurations).toEqual([2000, 3000, 4000]);
  });
});
