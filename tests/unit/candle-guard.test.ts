/**
 * Unit tests for the pure candle-sufficiency helpers
 * (TRADIFI-SIGNAL-HARDENING-W1, R5/R7 — suggested_timeframes derivation).
 */
import { describe, it, expect } from 'vitest';
import {
  computeSuggestedTimeframes,
  suggestedActionFor,
  intervalMsFor,
} from '../../src/lib/candle-guard.js';

const H = 3_600_000;

describe('intervalMsFor', () => {
  it('maps known timeframes and returns null for unknown', () => {
    expect(intervalMsFor('4h')).toBe(4 * H);
    expect(intervalMsFor('1h')).toBe(H);
    expect(intervalMsFor('1d')).toBe(24 * H);
    expect(intervalMsFor('bogus')).toBeNull();
  });
});

describe('computeSuggestedTimeframes', () => {
  const now = 1_800_000_000_000; // fixed reference instant

  it('ANTHROPIC-style: 12×4h candles, need 30 → ["1h","30m","15m"], largest-first', () => {
    const ageMs = 12 * 4 * H; // 48h listing age
    const out = computeSuggestedTimeframes({
      firstCandleTimeMs: now - ageMs,
      nowMs: now,
      requiredCandles: 30,
      requestedTimeframe: '4h',
    });
    expect(out).toEqual(['1h', '30m', '15m']); // 2h yields only 24 (<30) → excluded
  });

  it('excludes the requested timeframe and any coarser timeframe', () => {
    const ageMs = 30 * H; // 30h
    const out = computeSuggestedTimeframes({
      firstCandleTimeMs: now - ageMs,
      nowMs: now,
      requiredCandles: 30,
      requestedTimeframe: '1h',
    });
    // Only finer-than-1h qualify: 30m (60 candles) and 15m (120). 1h itself & 4h excluded.
    expect(out).toEqual(['30m', '15m']);
    expect(out).not.toContain('1h');
    expect(out).not.toContain('4h');
  });

  it('returns [] when the listing is too young for even 15m to qualify', () => {
    const ageMs = 5 * 15 * 60_000; // 75 min → 15m gives only 5 candles
    const out = computeSuggestedTimeframes({
      firstCandleTimeMs: now - ageMs,
      nowMs: now,
      requiredCandles: 30,
      requestedTimeframe: '4h',
    });
    expect(out).toEqual([]);
  });

  it('clamps negative age to zero (future-dated first candle) → []', () => {
    const out = computeSuggestedTimeframes({
      firstCandleTimeMs: now + H,
      nowMs: now,
      requiredCandles: 30,
      requestedTimeframe: '4h',
    });
    expect(out).toEqual([]);
  });
});

describe('suggestedActionFor', () => {
  it('points at the largest qualifying timeframe', () => {
    expect(suggestedActionFor(['1h', '30m', '15m'])).toBe('Retry with timeframe=1h');
  });

  it('advises waiting when nothing qualifies', () => {
    expect(suggestedActionFor([])).toMatch(/too new|retry once more candles/i);
  });
});
