/**
 * tests/unit/venue-budget-registry.test.ts — OPS-ADAPTER-RATELIMIT-UNIFY-W1 (C2/C3)
 *
 * The registry is the SoT for *which* venues are cross-process budgeted. C2 moved
 * the HL/Binance singletons in; C3 added the BYBIT/OKX/BITGET request-count rows.
 * Asserts: the 5 budgeted venues resolve, weight semantics (weightHint venues vs
 * request-count venues), sparse-null for delay-paced shadow venues, distinct
 * instances, and that a budgeted entry can actually `acquire` (smoke).
 */
import { describe, it, expect } from 'vitest';
import { getVenueBudget } from '../../src/lib/venue-budget-registry.js';
import { WeightBudget } from '../../src/lib/upstream-weight-budget.js';
import { PROMOTED_VENUE_IDS } from '../../src/lib/capabilities.js';

describe('venue-budget-registry', () => {
  // Iterates the SoT rather than a literal list, so this test cannot drift out of sync
  // with a future promotion the way the hardcoded 5-venue version did
  // (OPS-TELEMETRY-DIGEST-REFRAME-W1).
  it('resolves EVERY promoted venue to a WeightBudget', () => {
    expect(PROMOTED_VENUE_IDS.length).toBeGreaterThanOrEqual(12);
    for (const id of PROMOTED_VENUE_IDS) {
      const entry = getVenueBudget(id);
      expect(entry, id).not.toBeNull();
      expect(entry!.budget, id).toBeInstanceOf(WeightBudget);
    }
  });

  it('weight-metered venues (HL/Binance) read weightHint with a venue default', () => {
    const hl = getVenueBudget('HL')!;
    expect(hl.weightFor({ weightHint: 104 })).toBe(104);
    expect(hl.weightFor({})).toBe(20); // HL default

    const bin = getVenueBudget('BINANCE')!;
    expect(bin.weightFor({ weightHint: 40 })).toBe(40);
    expect(bin.weightFor({})).toBe(5); // Binance default
  });

  it('request-count venues (BYBIT/OKX/BITGET) always cost 1, ignoring weightHint', () => {
    for (const id of ['BYBIT', 'OKX', 'BITGET']) {
      const entry = getVenueBudget(id)!;
      expect(entry.weightFor({}), id).toBe(1);
      expect(entry.weightFor({ weightHint: 999 }), id).toBe(1); // request-count: hint ignored
    }
  });

  // ASTER/KUCOIN/MEXC/PHEMEX were in this list until OPS-TELEMETRY-DIGEST-REFRAME-W1; BITMART/
  // WHITEBIT/XT until OPS-VENUE-GO-LIVE-15-W1 — all PROMOTED now and correctly resolve non-null.
  // Only the genuinely-shadow set (EDGEX/WEEX) stays null.
  it('returns null for delay-paced shadow venues + unknown ids (sparse shadow map)', () => {
    for (const id of ['EDGEX', 'WEEX', 'NOPE', '']) {
      expect(getVenueBudget(id), id).toBeNull();
    }
  });

  it('the promoted set and the shadow set are disjoint (no venue is both)', () => {
    for (const id of ['EDGEX', 'WEEX']) {
      expect(PROMOTED_VENUE_IDS as readonly string[], id).not.toContain(id);
    }
  });

  it('each budgeted venue is a distinct WeightBudget instance', () => {
    const budgets = PROMOTED_VENUE_IDS.map((id) => getVenueBudget(id)!.budget);
    expect(new Set(budgets).size).toBe(PROMOTED_VENUE_IDS.length);
  });

  it('KuCoin costs its documented kline weight, not a flat 1', () => {
    // KuCoin klines draw 3 from the 2000/30s public pool; a flat 1 would under-model
    // our real draw by 3x and invite the exact bans the budget exists to prevent.
    expect(getVenueBudget('KUCOIN')!.weightFor({})).toBe(3);
  });

  it('Phemex is request-counted, NOT kline-weighted — a budget must not out-throttle the venue', () => {
    // Regression guard. Modelling Phemex on its "Others" group cap (ceiling 50 x weight 10
    // = ~5 calls/min) starved the seed lane with 55 batch skips in 35 minutes, against 11
    // raw 429s in the whole preceding UNBUDGETED week. Our dominant call is the 24hr
    // ticker, whose weight Phemex does not publish, so weight-10 was fabricated precision.
    expect(getVenueBudget('PHEMEX')!.weightFor({})).toBe(1);
    expect(getVenueBudget('PHEMEX')!.weightFor({ weightHint: 999 })).toBe(1);
  });

  it('a budgeted entry can acquire (vitest ledger is unbounded; never throttles)', async () => {
    const bybit = getVenueBudget('BYBIT')!;
    await expect(bybit.budget.acquire(bybit.weightFor({}), 'interactive')).resolves.toBeUndefined();
  });
});
