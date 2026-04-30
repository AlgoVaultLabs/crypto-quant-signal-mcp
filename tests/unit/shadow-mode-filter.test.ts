/**
 * Unit tests for SHADOW-SEED-W1 shadow-mode filter on /api/performance-public.
 *
 * The /api/performance-public endpoint strips `1m` and `3m` keys from the
 * `byTimeframe` aggregation by default. The env flag SHADOW_REVEAL_TIMEFRAMES
 * (comma-list) selectively unlocks them once Mr.1 has reviewed the digest.
 *
 * This test exercises the pure filter logic via a copy of the in-route
 * implementation. Live HTTP behavior is asserted via the live-API smoke at
 * tests/unit/api-performance-public.test.ts.
 */
import { describe, it, expect } from 'vitest';

const SHADOW_TIMEFRAMES = ['1m', '3m'] as const;

function applyShadowFilter(
  byTimeframe: Record<string, unknown>,
  envValue: string | undefined,
): Record<string, unknown> {
  const shadowReveal = new Set(
    (envValue ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return Object.fromEntries(
    Object.entries(byTimeframe).filter(
      ([tf]) => !SHADOW_TIMEFRAMES.includes(tf as '1m' | '3m') || shadowReveal.has(tf),
    ),
  );
}

const FIXTURE = {
  '1m':  { count: 100, pfeWinRate: 0.7 },
  '3m':  { count: 200, pfeWinRate: 0.8 },
  '5m':  { count: 1000, pfeWinRate: 0.85 },
  '15m': { count: 1500, pfeWinRate: 0.89 },
  '1h':  { count: 800, pfeWinRate: 0.91 },
  '4h':  { count: 200, pfeWinRate: 0.92 },
  '1d':  { count: 50, pfeWinRate: 0.88 },
};

describe('SHADOW-SEED-W1: shadow-mode filter', () => {
  it('default (env unset): both 1m and 3m stripped', () => {
    const out = applyShadowFilter(FIXTURE, undefined);
    expect(Object.keys(out)).not.toContain('1m');
    expect(Object.keys(out)).not.toContain('3m');
    expect(Object.keys(out)).toContain('5m');
    expect(Object.keys(out)).toContain('15m');
    expect(Object.keys(out)).toContain('1h');
  });

  it('default (empty env value): both stripped', () => {
    const out = applyShadowFilter(FIXTURE, '');
    expect(Object.keys(out)).not.toContain('1m');
    expect(Object.keys(out)).not.toContain('3m');
  });

  it('env=3m: 3m revealed, 1m still stripped', () => {
    const out = applyShadowFilter(FIXTURE, '3m');
    expect(Object.keys(out)).not.toContain('1m');
    expect(Object.keys(out)).toContain('3m');
  });

  it('env=1m,3m: both revealed', () => {
    const out = applyShadowFilter(FIXTURE, '1m,3m');
    expect(Object.keys(out)).toContain('1m');
    expect(Object.keys(out)).toContain('3m');
  });

  it('env with whitespace and trailing comma: parses correctly', () => {
    const out = applyShadowFilter(FIXTURE, ' 1m , 3m , ');
    expect(Object.keys(out)).toContain('1m');
    expect(Object.keys(out)).toContain('3m');
  });

  it('env with bogus values: ignored', () => {
    const out = applyShadowFilter(FIXTURE, 'xyz,5m,15m');
    // 5m / 15m are NOT in SHADOW_TIMEFRAMES so the env doesn't affect their visibility
    // (they're always visible). 1m and 3m stay stripped because env doesn't list them.
    expect(Object.keys(out)).not.toContain('1m');
    expect(Object.keys(out)).not.toContain('3m');
    expect(Object.keys(out)).toContain('5m');
  });

  it('non-shadow timeframes are never filtered regardless of env', () => {
    const out = applyShadowFilter(FIXTURE, '1m,3m');
    expect(Object.keys(out)).toContain('5m');
    expect(Object.keys(out)).toContain('1h');
    expect(Object.keys(out)).toContain('4h');
    expect(Object.keys(out)).toContain('1d');
  });
});
