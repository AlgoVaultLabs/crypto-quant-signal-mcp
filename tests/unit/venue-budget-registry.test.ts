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
import { getVenueBudget, WEEX_REQ_CEILING, WEEX_INTERACTIVE_RESERVE, _shadowVenueBudgetSizeForTest } from '../../src/lib/venue-budget-registry.js';
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
  // WEEX left it in OPS-WEEX-PROMOTION-READINESS-W1 CH2: it is still SHADOW but now carries an
  // ad-hoc SHADOW_VENUE_BUDGETS row, which is exactly what that map's contract is for. EDGEX is
  // retired and needs none, so it remains the genuine null case alongside unknown ids.
  it('returns null for un-budgeted shadow venues + unknown ids (sparse shadow map)', () => {
    for (const id of ['EDGEX', 'NOPE', '']) {
      expect(getVenueBudget(id), id).toBeNull();
    }
  });

  // The gap this wave closed, asserted POSITIVELY — a flipped absence fixture that only
  // stops asserting absence proves nothing about what replaced it.
  //
  // WHY IT EXISTS, so a later wave does not "simplify" it away: WEEX had ZERO 418/429 in 89
  // days on /capi/v2 and took 83 within FOUR MINUTES of the V3 cutover, because V3 enforces
  // the 0.833 req/s it declares. Raising the per-process delay 300 -> 2400ms cut that to 8 —
  // and all 8 landed in ONE MINUTE from FOUR concurrent seed lanes, each honouring 2400ms and
  // jointly delivering ~1.67 req/s. Only a cross-process ledger serialises them.
  it('WEEX carries a shadow budget — the cross-process control a per-process delay cannot be', () => {
    const entry = getVenueBudget('WEEX');
    expect(entry, 'WEEX must resolve to a budget entry, not null').not.toBeNull();
    expect(entry!.budget).toBeInstanceOf(WeightBudget);
    // request-count venue: every call weighs 1 regardless of any weightHint
    expect(entry!.weightFor({})).toBe(1);
    expect(entry!.weightFor({ weightHint: 20 })).toBe(1);
  });

  it('the WEEX ceiling is 50% of the venue-DECLARED limit, not of the header value', () => {
    // /capi/v3/market/exchangeInfo rateLimits[] = 500 req / 10 min = 50/min (fetched
    // 2026-09-03). Headers advertise 50 req/s — a 60x spread. The architect's D4 ruling took
    // the DECLARED limit; 50% of 50/min = 25. Pinning the derivation, not just the digit:
    // reading the header value instead would give a ceiling of 1500/min.
    expect(WEEX_REQ_CEILING).toBe(25);
    expect(WEEX_REQ_CEILING).toBe(50 / 2);
    expect(WEEX_INTERACTIVE_RESERVE).toBeLessThan(WEEX_REQ_CEILING);
  });

  it('the promoted set and the shadow set are disjoint (no venue is both)', () => {
    for (const id of ['EDGEX', 'BITMART']) {
      expect(PROMOTED_VENUE_IDS as readonly string[], id).not.toContain(id);
    }
  });

  // OPS-WEEX-PROMOTE-W1 — THE assertion the promotion turns on, and the one the dispatched spec's
  // own gate could NOT make: it proposed `getVenueBudget('WEEX') != null`, which was already true
  // BEFORE the change (WEEX held a SHADOW_VENUE_BUDGETS row), so it could never have detected the
  // failure it existed for. What must be true is that the budget FOLLOWED the venue out of the
  // shadow map. tsc forces the promoted row to exist; NOTHING forces the shadow row to be removed,
  // and a duplicate would be dead code that reads as enforcement.
  it('WEEX is budgeted from the PROMOTED record and the shadow map is empty', () => {
    expect(PROMOTED_VENUE_IDS as readonly string[]).toContain('WEEX');
    const b = getVenueBudget('WEEX');
    expect(b, 'getVenueBudget(WEEX) is null — promotion deleted its rate-limit enforcement').not.toBeNull();
    expect(WEEX_REQ_CEILING).toBe(25);          // 50% of the venue-declared 500 req / 10 min
    expect(WEEX_INTERACTIVE_RESERVE).toBe(5);
    expect(_shadowVenueBudgetSizeForTest(), 'a leftover shadow row is dead code that reads as enforcement').toBe(0);
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
