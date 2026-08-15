/**
 * Unit test for src/lib/tier-warning.ts under the BINDING METER
 * (OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 / CH2).
 *
 * `tests/unit/algovault-meta-tier-warning.test.ts` still pins the pre-wave monthly semantics and is
 * deliberately left untouched — if this wave broke them, that suite fails, which is the point.
 * This file pins what CH2 ADDS:
 *
 *   - the warning fires on the BINDING meter, so a 100/day caller is reachable on DAY 1
 *   - it names the wall (`meter`) and THAT wall's own reset horizon (`resets_at`)
 *   - `quota_hit_soft` / `quota_hit_hard` carry `meta.limit`, spelled exactly as
 *     `quota_hit_block` already spells it (CH5 joins across all three)
 *   - `_algovault.quota` carries the daily pair + `binding`
 *   - a caller with NO daily meter gets BYTE-IDENTICAL output — asserted as an exact key set and
 *     an exact object, not as "looks the same"
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const funnelEvents: Array<Record<string, unknown>> = [];
vi.mock('../../src/lib/performance-db.js', () => ({
  recordFunnelEvent: (e: Record<string, unknown>) => { funnelEvents.push(e); },
}));
vi.mock('../../src/lib/license.js', () => ({
  getRequestSessionId: () => 'sess_ch2_test',
}));

const { withTierWarning, computeTierWarning, withQuotaState } = await import('../../src/lib/tier-warning.js');
type Meta = Parameters<typeof withQuotaState>[0];

const BASE_META = {
  version: '1.27.0',
  tool: 'get_trade_call',
  compatible_with: ['claude-opus-5'],
  session_id: 'sess_ch2_test',
  exchange: 'BINANCE',
  venue_status: 'promoted',
} as unknown as Meta;

const MONTH_RESET = Date.UTC(2026, 8, 12, 11, 28, 58);
const DAY_RESET = Date.UTC(2026, 7, 16, 0, 0, 0);

/** A free caller with BOTH meters — the live production shape since PRICING-FLAT-...-W1. */
const twoMeter = (monthlyUsed: number, dailyUsed: number) => ({
  tier: 'free' as const,
  currentUsage: monthlyUsed,
  monthlyLimit: 200,
  dailyUsage: dailyUsed,
  dailyLimit: 100,
  monthlyResetAtMs: MONTH_RESET,
  dailyResetAtMs: DAY_RESET,
});

/** A caller with NO daily meter — the pre-wave shape, and the byte-identity fixture. */
const monthlyOnly = (monthlyUsed: number) => ({
  tier: 'free' as const,
  currentUsage: monthlyUsed,
  monthlyLimit: 200,
});

beforeEach(() => { funnelEvents.length = 0; });

describe('CH2 — the day-1 daily caller becomes reachable', () => {
  it('SOFT-warns at 80/100 daily while the monthly meter reads only 0.40', () => {
    // This is the whole wave in one assertion. Pre-wave the ratio was 80/200 = 0.40, below every
    // threshold in the file, so this caller received NOTHING on any call and then hit a wall.
    const w = computeTierWarning(twoMeter(80, 80));
    expect(w).toBeDefined();
    expect(w!.level).toBe('soft');
    expect(w!.meter).toBe('daily');
  });

  it('HARD-warns at 90/100 daily', () => {
    const w = computeTierWarning(twoMeter(90, 90));
    expect(w!.level).toBe('hard');
    expect(w!.meter).toBe('daily');
  });

  it('names the DAILY reset horizon, not the monthly one', () => {
    // A warning that names the wrong horizon is the defect quota-notice.ts records running in
    // production for a day and a half. Re-creating it one field over is the failure mode here.
    const w = computeTierWarning(twoMeter(80, 80));
    expect(w!.resets_at).toBe(new Date(DAY_RESET).toISOString());
    expect(w!.resets_at).not.toBe(new Date(MONTH_RESET).toISOString());
  });

  it('names the MONTHLY horizon when the monthly meter is the one that binds', () => {
    const w = computeTierWarning(twoMeter(170, 10)); // 0.85 monthly vs 0.10 daily
    expect(w!.meter).toBe('monthly');
    expect(w!.resets_at).toBe(new Date(MONTH_RESET).toISOString());
  });

  it('keeps current_usage / monthly_limit meaning the MONTHLY pair even on a daily warning', () => {
    // Every existing consumer reads those two as the monthly meter. This wave adds a field rather
    // than moving them under those consumers' feet.
    const w = computeTierWarning(twoMeter(80, 80));
    expect(w!.current_usage).toBe(80);
    expect(w!.monthly_limit).toBe(200);
  });

  it('emits NOTHING once the binding meter is at 100% — the refusal envelope owns that', () => {
    expect(computeTierWarning(twoMeter(120, 100))).toBeUndefined();
  });

  it('is telemetry, not a gate: a caller with remaining > 0 on the binding meter still gets a warning object', () => {
    const w = computeTierWarning(twoMeter(80, 85));
    expect(w).toBeDefined();
    expect(w!.level).toBe('soft');
  });
});

describe('CH2 — funnel meta.limit (CH5 joins on this key)', () => {
  it('tags quota_hit_soft with the DAILY wall, spelled as quota_hit_block spells it', () => {
    withTierWarning(BASE_META, twoMeter(80, 80));
    expect(funnelEvents).toHaveLength(1);
    expect(funnelEvents[0].eventType).toBe('quota_hit_soft');
    expect((funnelEvents[0].meta as Record<string, unknown>).limit).toBe('daily');
  });

  it('tags quota_hit_hard with the MONTHLY wall when monthly binds', () => {
    withTierWarning(BASE_META, twoMeter(185, 10));
    expect(funnelEvents[0].eventType).toBe('quota_hit_hard');
    expect((funnelEvents[0].meta as Record<string, unknown>).limit).toBe('monthly');
  });

  it('records the ratio that actually FIRED, not a second monthly re-derivation', () => {
    // Pre-wave the funnel recomputed `currentUsage / monthlyLimit` inline. For exactly the callers
    // this wave makes visible, that number and the one that fired disagree.
    withTierWarning(BASE_META, twoMeter(80, 80));
    expect((funnelEvents[0].meta as Record<string, unknown>).ratio).toBeCloseTo(0.8, 10);
  });

  it('still tags a monthly-only caller `monthly` (the vocabulary has no third value)', () => {
    withTierWarning(BASE_META, monthlyOnly(170));
    expect((funnelEvents[0].meta as Record<string, unknown>).limit).toBe('monthly');
  });
});

describe('CH2 — _algovault.quota carries both meters', () => {
  it('adds `daily` + `binding` when the daily pair is present', () => {
    const meta = withQuotaState(BASE_META, {
      tier: 'free', used: 80, total: 200, resetAtMs: MONTH_RESET,
      dailyUsed: 80, dailyTotal: 100, dailyResetAtMs: DAY_RESET,
    });
    expect(meta.quota).toEqual({
      used: 80,
      total: 200,
      remaining: 120,
      resets_at: new Date(MONTH_RESET).toISOString(),
      daily: { used: 80, total: 100, remaining: 20, resets_at: new Date(DAY_RESET).toISOString() },
      binding: 'daily',
    });
  });

  it('🎯 no longer says "120 remaining" on the envelope that is about to refuse', () => {
    // The measured defect: at the daily wall the block reported the MONTHLY remainder.
    const meta = withQuotaState(BASE_META, {
      tier: 'free', used: 100, total: 200, resetAtMs: MONTH_RESET,
      dailyUsed: 100, dailyTotal: 100, dailyResetAtMs: DAY_RESET,
    });
    expect(meta.quota!.binding).toBe('daily');
    expect(meta.quota!.daily!.remaining).toBe(0);
  });

  it('omits the daily pair when its horizon is unknown rather than rendering an invalid date', () => {
    // `new Date(NaN).toISOString()` THROWS. A resets_at we cannot compute is withheld, never faked.
    const meta = withQuotaState(BASE_META, {
      tier: 'free', used: 80, total: 200, resetAtMs: MONTH_RESET,
      dailyUsed: 80, dailyTotal: 100, // no dailyResetAtMs
    });
    expect(Object.keys(meta.quota!)).toEqual(['used', 'total', 'remaining', 'resets_at']);
  });

  it('still skips bot-internal and unmetered tiers entirely', () => {
    expect(withQuotaState(BASE_META, {
      tier: 'internal', used: 1, total: 200, resetAtMs: MONTH_RESET,
      dailyUsed: 1, dailyTotal: 100, dailyResetAtMs: DAY_RESET, isBotInternal: true,
    }).quota).toBeUndefined();
    expect(withQuotaState(BASE_META, {
      tier: 'x402', used: 1, total: Infinity, resetAtMs: MONTH_RESET,
      dailyUsed: 1, dailyTotal: 100, dailyResetAtMs: DAY_RESET,
    }).quota).toBeUndefined();
  });
});

describe('CH2 — BYTE-IDENTITY for a caller with no daily meter (recorded snapshot pin)', () => {
  it('the quota block is EXACTLY the pre-wave four fields, in the pre-wave order', () => {
    const meta = withQuotaState(BASE_META, {
      tier: 'free', used: 42, total: 200, resetAtMs: MONTH_RESET,
    });
    // Key SET and ORDER, then the exact object. `toEqual` alone would pass if a fifth key were
    // added with an undefined value, which is precisely how an "additive" change stops being one.
    expect(Object.keys(meta.quota!)).toEqual(['used', 'total', 'remaining', 'resets_at']);
    expect(meta.quota).toEqual({
      used: 42,
      total: 200,
      remaining: 158,
      resets_at: new Date(MONTH_RESET).toISOString(),
    });
  });

  it('the warning is EXACTLY the pre-wave object — no meter, no resets_at', () => {
    const w = computeTierWarning({ ...monthlyOnly(170), upgradeUrl: 'https://example.test/u' });
    expect(Object.keys(w!).sort()).toEqual(
      ['current_usage', 'level', 'monthly_limit', 'suggested_upgrade_url', 'tier'],
    );
    expect(w).toEqual({
      level: 'soft',
      current_usage: 170,
      monthly_limit: 200,
      tier: 'free',
      suggested_upgrade_url: 'https://example.test/u',
    });
  });

  it('the pre-wave threshold boundaries are unmoved for a monthly-only caller', () => {
    expect(computeTierWarning(monthlyOnly(159))).toBeUndefined();      // 0.795
    expect(computeTierWarning(monthlyOnly(160))!.level).toBe('soft');  // 0.80
    expect(computeTierWarning(monthlyOnly(179))!.level).toBe('soft');  // 0.895
    expect(computeTierWarning(monthlyOnly(180))!.level).toBe('hard');  // 0.90
    expect(computeTierWarning(monthlyOnly(200))).toBeUndefined();      // 1.00
  });

  it('paid and bot-internal callers are still skipped outright', () => {
    expect(computeTierWarning({ ...twoMeter(80, 80), tier: 'starter' })).toBeUndefined();
    expect(computeTierWarning({ ...twoMeter(80, 80), isBotInternal: true })).toBeUndefined();
  });

  it('a non-finite or non-positive monthly limit is still skipped', () => {
    expect(computeTierWarning({ ...twoMeter(80, 80), monthlyLimit: 0 })).toBeUndefined();
    expect(computeTierWarning({ ...twoMeter(80, 80), monthlyLimit: Number.NaN })).toBeUndefined();
  });
});
