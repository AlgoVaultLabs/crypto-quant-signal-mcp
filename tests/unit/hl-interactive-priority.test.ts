/**
 * tests/unit/hl-interactive-priority.test.ts — OPS-HL-INTERACTIVE-PRIORITY-W1
 *
 * Two coupled fixes for the same root cause: the weekly digest's "HL: N interactive
 * throws/7d" alert was firing on a once-weekly cron burst, not sustained pressure.
 *
 *  F1 — the trigger now tests the SHAPE of the throws, not just a 7-day sum.
 *  F2 — a background-priority caller runs in the batch lane, so the burst stops
 *       consuming HL's interactive reserve in the first place.
 *
 * The live incident these encode: 171 HL interactive throws in a week, of which 161
 * (94%) landed in ONE minute — Monday 13:17 UTC, the bot's scan-showcase cron.
 */
import { describe, it, expect } from 'vitest';
import { summarizeThrowShape, isSustained, evaluateRateLimitTriggers } from '../../src/lib/rate-limit-digest.js';
import { resolveBackgroundPriority } from '../../src/lib/license.js';

const venue = (v: string, o: Partial<{ throws: number; iThrows: number; bThrows: number; waits: number; skips: number }> = {}) =>
  ({ venue: v, throws: 0, iThrows: 0, bThrows: 0, waits: 0, skips: 0, ...o });

describe('summarizeThrowShape', () => {
  it('summarizes total, distinct days, and the peak hour', () => {
    const s = summarizeThrowShape([
      { hour: '2026-07-13 13:00', n: 161 },
      { hour: '2026-07-16 12:00', n: 5 },
      { hour: '2026-07-18 23:00', n: 5 },
    ]);
    expect(s.total).toBe(171);
    expect(s.days).toBe(3);
    expect(s.peakHour).toBe(161);
    expect(s.peakHourLabel).toBe('2026-07-13 13:00');
    expect(s.peakShare).toBeCloseTo(0.942, 2);
  });

  it('is safe on an empty window (no divide-by-zero)', () => {
    const s = summarizeThrowShape([]);
    expect(s).toMatchObject({ total: 0, days: 0, peakHour: 0, peakHourLabel: null, peakShare: 0 });
  });

  it('counts distinct DAYS, not distinct hours', () => {
    const s = summarizeThrowShape([
      { hour: '2026-07-13 01:00', n: 3 },
      { hour: '2026-07-13 02:00', n: 3 },
      { hour: '2026-07-13 03:00', n: 3 },
    ]);
    expect(s.days).toBe(1);
  });
});

describe('isSustained — burst vs chronic', () => {
  it('THE LIVE INCIDENT: 171 throws over 3 days but 94% in one hour = BURST', () => {
    const s = summarizeThrowShape([
      { hour: '2026-07-13 13:00', n: 161 },
      { hour: '2026-07-16 12:00', n: 5 },
      { hour: '2026-07-18 23:00', n: 5 },
    ]);
    expect(isSustained(s)).toBe(false);
  });

  it('genuinely chronic pressure (spread across days, no dominant hour) = SUSTAINED', () => {
    const s = summarizeThrowShape([
      { hour: '2026-07-13 01:00', n: 25 },
      { hour: '2026-07-14 05:00', n: 25 },
      { hour: '2026-07-15 09:00', n: 25 },
      { hour: '2026-07-16 14:00', n: 25 },
    ]);
    expect(isSustained(s)).toBe(true);
  });

  it('boundary — peak share exactly 50% is still sustained; just over is a burst', () => {
    const at50 = summarizeThrowShape([{ hour: '2026-07-13 01:00', n: 50 }, { hour: '2026-07-14 01:00', n: 50 }]);
    expect(at50.peakShare).toBe(0.5);
    expect(isSustained(at50)).toBe(true);

    const over50 = summarizeThrowShape([{ hour: '2026-07-13 01:00', n: 51 }, { hour: '2026-07-14 01:00', n: 49 }]);
    expect(isSustained(over50)).toBe(false);
  });

  it('boundary — a single day never counts as sustained, however evenly spread', () => {
    const oneDay = summarizeThrowShape([
      { hour: '2026-07-13 01:00', n: 20 },
      { hour: '2026-07-13 05:00', n: 20 },
      { hour: '2026-07-13 09:00', n: 20 },
    ]);
    expect(oneDay.peakShare).toBeLessThanOrEqual(0.5);
    expect(isSustained(oneDay)).toBe(false); // days=1
  });

  it('MAY ONLY SUPPRESS: absent/empty shape data is treated as sustained', () => {
    // We must never invent silence where we cannot see. No data → do not suppress.
    expect(isSustained(undefined)).toBe(true);
    expect(isSustained(null)).toBe(true);
    expect(isSustained(summarizeThrowShape([]))).toBe(true);
  });
});

describe('evaluateRateLimitTriggers — count AND shape', () => {
  const burst = summarizeThrowShape([
    { hour: '2026-07-13 13:00', n: 161 },
    { hour: '2026-07-16 12:00', n: 5 },
    { hour: '2026-07-18 23:00', n: 5 },
  ]);
  const chronic = summarizeThrowShape([
    { hour: '2026-07-13 01:00', n: 30 },
    { hour: '2026-07-14 05:00', n: 30 },
    { hour: '2026-07-15 09:00', n: 30 },
  ]);

  it('REGRESSION: the live burst clears the count gate but is suppressed by shape', () => {
    const r = evaluateRateLimitTriggers([venue('Hyperliquid', { iThrows: 171, throws: 171 })], burst);
    expect(r.hlDenial).toBe(false);
    expect(r.lines.join('\n')).not.toContain('investigate the HL interactive driver');
  });

  it('chronic pressure at the same magnitude still fires', () => {
    const r = evaluateRateLimitTriggers([venue('Hyperliquid', { iThrows: 90, throws: 90 })], chronic);
    expect(r.hlDenial).toBe(true);
    expect(r.lines.join('\n')).toContain('investigate the HL interactive driver');
  });

  it('shape cannot RESCUE a below-count week — both gates must pass', () => {
    const r = evaluateRateLimitTriggers([venue('Hyperliquid', { iThrows: 24, throws: 24 })], chronic);
    expect(r.hlDenial).toBe(false);
  });

  it('omitting shape preserves the previous count-only behaviour', () => {
    const r = evaluateRateLimitTriggers([venue('Hyperliquid', { iThrows: 25, throws: 25 })]);
    expect(r.hlDenial).toBe(true);
  });

  it('the shadow trigger is unaffected by HL shape', () => {
    // edgeX (not Bitmart): Bitmart promoted by OPS-VENUE-GO-LIVE-15-W1 → no longer shadow.
    const r = evaluateRateLimitTriggers([venue('edgeX', { throws: 389 })], burst);
    expect(r.shadowBudget).toBe(true);
  });
});

describe('resolveBackgroundPriority — internal callers only', () => {
  it('honours the header for an internal caller', () => {
    expect(resolveBackgroundPriority({ 'x-algovault-priority': 'background' }, 'internal')).toBe(true);
  });

  it('is case- and whitespace-tolerant on the value', () => {
    expect(resolveBackgroundPriority({ 'x-algovault-priority': '  BackGround ' }, 'internal')).toBe(true);
  });

  it('REFUSES to park a non-internal caller in a lane that can wait ~5min', () => {
    for (const tier of ['free', 'starter', 'pro', 'enterprise', 'x402']) {
      expect(resolveBackgroundPriority({ 'x-algovault-priority': 'background' }, tier), tier).toBe(false);
    }
  });

  it('defaults FALSE with no header, an empty header, or an unrecognized value', () => {
    expect(resolveBackgroundPriority({}, 'internal')).toBe(false);
    expect(resolveBackgroundPriority({ 'x-algovault-priority': '' }, 'internal')).toBe(false);
    expect(resolveBackgroundPriority({ 'x-algovault-priority': 'urgent' }, 'internal')).toBe(false);
    expect(resolveBackgroundPriority({ 'x-algovault-priority': undefined }, 'internal')).toBe(false);
  });
});
