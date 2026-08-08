/**
 * SCAN-TRADE-CALLS-W1 C1 — multi-unit quota seam (`units`) on trackCall /
 * trackCallByKey.
 *
 * Asserts:
 *   - default-1 back-compat: calling without `units` charges exactly 1 (existing
 *     call sites are byte-untouched — the C1 gate also greps `! trackCall(license, `)
 *   - units=5 increments the meter by exactly 5 in a single atomic charge
 *   - free-tier crossing the quota mid-batch returns allowed:false + correct overage
 *   - default-deny: NaN / 0 / negative / Infinity units → 1; fractional floors to int≥1
 *   - x402 / internal tiers short-circuit to Infinity, units ignored, counter untouched
 *
 * Determinism: every assertion uses a UNIQUE tracker key so the module-level
 * in-memory `callTrackers` map never bleeds across tests. Paid tiers key on
 * `license.key`; free-tier crossing uses trackCallByKey with an explicit key
 * (avoids the request-context IP hash, which is `free:anon` under test).
 */
import { describe, it, expect } from 'vitest';
import {
  trackCall,
  trackCallByKey,
  getMonthlyQuota,
} from '../../src/lib/license.js';
import type { LicenseInfo } from '../../src/types.js';

const starter = (key: string): LicenseInfo => ({ tier: 'starter', key, customerId: 'cus_test' });

describe('trackCall(license, units) — default-1 back-compat', () => {
  it('no units arg charges exactly 1 (byte-identical to pre-seam behavior)', () => {
    const r = trackCall(starter('u-default-1'));
    expect(r.used).toBe(1);
    expect(r.allowed).toBe(true);
    expect(r.total).toBe(getMonthlyQuota('starter'));
    // Derived, not re-pinned: `remaining` is a PROPERTY of the charge (quota − used), so it must
    // follow the ladder. PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 moved Starter 3,000 → 10,000 and
    // hardcoding 9,999 here would just queue the same breakage for the next ladder move.
    expect(r.remaining).toBe(getMonthlyQuota('starter') - 1);
  });

  it('two default calls accumulate to 2', () => {
    trackCall(starter('u-default-2'));
    const r = trackCall(starter('u-default-2'));
    expect(r.used).toBe(2);
    expect(r.remaining).toBe(getMonthlyQuota('starter') - 2);
  });
});

describe('trackCall(license, units) — batch charge', () => {
  it('units=5 increments by exactly 5 in one atomic charge', () => {
    const r = trackCall(starter('u-batch-5'), 5);
    expect(r.used).toBe(5);
    expect(r.remaining).toBe(getMonthlyQuota('starter') - 5);
  });

  it('a 5-unit batch then a default-1 call accumulates to 6', () => {
    trackCall(starter('u-batch-6'), 5);
    const r = trackCall(starter('u-batch-6'));
    expect(r.used).toBe(6);
  });
});

describe('trackCallByKey(key, tier, units)', () => {
  it('default-1 back-compat: no units arg charges 1', () => {
    const r = trackCallByKey('u-bk-default', 'pro');
    expect(r.used).toBe(1);
    expect(r.total).toBe(getMonthlyQuota('pro'));
  });

  it('units=5 increments by exactly 5', () => {
    const r = trackCallByKey('u-bk-batch5', 'pro', 5);
    expect(r.used).toBe(5);
    expect(r.remaining).toBe(getMonthlyQuota('pro') - 5);
  });
});

describe('free-tier crossing the quota mid-batch', () => {
  const FREE_QUOTA = getMonthlyQuota('free'); // 100

  it('a batch that pushes count over the free quota returns allowed:false with correct overage', () => {
    // Charge up to just under the cap, then a batch that crosses it.
    const before = trackCallByKey('u-free-cross', 'free', FREE_QUOTA - 2); // count = 98
    expect(before.allowed).toBe(true);
    expect(before.remaining).toBe(2);

    const crossed = trackCallByKey('u-free-cross', 'free', 5); // count = 103
    expect(crossed.allowed).toBe(false);
    expect(crossed.used).toBe(FREE_QUOTA + 3); // 103
    expect(crossed.overage).toBe(3);
    expect(crossed.remaining).toBe(0);
    expect(crossed.total).toBe(FREE_QUOTA);
  });

  it('a single oversized batch from zero blocks and reports the full overage', () => {
    const r = trackCallByKey('u-free-oversize', 'free', FREE_QUOTA + 5); // count = 105
    expect(r.allowed).toBe(false);
    expect(r.overage).toBe(5);
    expect(r.used).toBe(FREE_QUOTA + 5);
  });
});

describe('default-deny: invalid units collapse to 1', () => {
  it.each([
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -5],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('trackCall units=%s charges exactly 1', (_label, units) => {
    const r = trackCall(starter(`u-deny-call-${_label}`), units as number);
    expect(r.used).toBe(1);
  });

  it.each([
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -3],
    ['Infinity', Infinity],
  ])('trackCallByKey units=%s charges exactly 1', (_label, units) => {
    const r = trackCallByKey(`u-deny-key-${_label}`, 'starter', units as number);
    expect(r.used).toBe(1);
  });

  it('fractional units floor to an integer ≥1 (2.9 → 2)', () => {
    const r = trackCall(starter('u-frac'), 2.9);
    expect(r.used).toBe(2);
  });

  it('fractional units below 1 collapse to 1 (0.4 → 1)', () => {
    const r = trackCall(starter('u-frac-low'), 0.4);
    expect(r.used).toBe(1);
  });
});

describe('x402 / internal short-circuit — units ignored, counter untouched', () => {
  it('trackCall x402 returns Infinity regardless of units', () => {
    const r = trackCall({ tier: 'x402', key: 'u-x402' }, 5);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(Infinity);
    expect(r.total).toBe(Infinity);
    expect(r.used).toBe(0);
  });

  it('trackCall internal returns Infinity regardless of units', () => {
    const r = trackCall({ tier: 'internal', key: 'u-internal' }, 99);
    expect(r.allowed).toBe(true);
    expect(r.used).toBe(0);
    expect(r.total).toBe(Infinity);
  });

  it('trackCallByKey x402 / internal return Infinity, used 0', () => {
    expect(trackCallByKey('u-bk-x402', 'x402', 5).remaining).toBe(Infinity);
    expect(trackCallByKey('u-bk-internal', 'internal', 5).used).toBe(0);
  });
});
