/**
 * PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH4) — the DAILY meter (R-B/R-D).
 *
 * TWO METERS, REFUSING INDEPENDENTLY. Monthly caps the budget; daily shapes the pacing. The
 * property under test is INDEPENDENCE in both directions: exhausting one must not move the
 * other, and a refusal must say WHICH one fired, because their retry horizons differ by orders
 * of magnitude (hours to 00:00 UTC vs days to a rolling reset). A daily wall that renders
 * "come back in 27 days" is the specific failure this discriminator exists to prevent.
 *
 * THE PERIOD IS A UTC CALENDAR DAY, deliberately unlike the monthly meter's rolling window
 * (R-D). The rolling window is anchored on each caller's own first call, so its reset lands on
 * a date that cannot be stated in copy; 00:00 UTC is the same instant for everyone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkQuota,
  trackCall,
  trackCallByKey,
  checkQuotaByKey,
  getMonthlyQuota,
  getDailyCap,
  utcDayKey,
  utcDayResetAtMs,
  hoursUntilUtcDayReset,
  _resetCallTrackersForTest,
} from '../../src/lib/license.js';
import { withQuotaState } from '../../src/lib/tier-warning.js';
import { FREE_MONTHLY_CALLS, FREE_DAILY_CALLS, PLANS } from '../../src/lib/plans.js';
import type { LicenseInfo } from '../../src/types.js';

const free = (key: string): LicenseInfo => ({ tier: 'free', key });
const starter = (key: string): LicenseInfo => ({ tier: 'starter', key, customerId: 'cus_t' });

beforeEach(() => {
  _resetCallTrackersForTest();
});
afterEach(() => {
  vi.useRealTimers();
  _resetCallTrackersForTest();
});

describe('vacuity guards — the caps under test are real and reachable', () => {
  it('the free daily cap is finite and strictly below the monthly one', () => {
    expect(FREE_DAILY_CALLS).toBeGreaterThan(0);
    expect(FREE_DAILY_CALLS).toBeLessThan(FREE_MONTHLY_CALLS);
    expect(getDailyCap('free')).toBe(FREE_DAILY_CALLS);
  });
});

describe('AC4.1 — the daily wall refuses with limit:"daily" and an HOURS retry', () => {
  it(`the ${FREE_DAILY_CALLS + 1}th free call in one UTC day is refused, monthly UNTOUCHED`, () => {
    const lic = free('daily-wall');
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);

    const r = checkQuota(lic);
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe('daily');

    // The monthly meter is nowhere near its own ceiling — that is the whole point.
    expect(r.used).toBe(FREE_DAILY_CALLS);
    expect(r.total).toBe(FREE_MONTHLY_CALLS);
    expect(r.used).toBeLessThan(r.total);
    // CH1: read the DAILY pair off the production result, not a bypass inspector.
    expect(r.daily_used).toBe(FREE_DAILY_CALLS);
    expect(r.daily_total).toBe(FREE_DAILY_CALLS);
  });

  it('an allowed call reports limit:null rather than omitting the field', () => {
    expect(checkQuota(free('fresh')).limit).toBeNull();
  });

  it('the retry hint is HOURS to the next 00:00 UTC, never a day count', () => {
    // 22:00 UTC → 2h. A caller walled at 22:00 must not be told to wait ~27 days.
    expect(hoursUntilUtcDayReset(Date.parse('2026-08-08T22:00:00.000Z'))).toBe(2);
    expect(hoursUntilUtcDayReset(Date.parse('2026-08-08T00:00:00.000Z'))).toBe(24);
    // Never renders "0 hours" — a wall that says come back immediately is a lie.
    expect(hoursUntilUtcDayReset(Date.parse('2026-08-08T23:59:59.000Z'))).toBeGreaterThanOrEqual(1);
    expect(hoursUntilUtcDayReset(Date.parse('2026-08-08T23:00:00.001Z'))).toBeGreaterThanOrEqual(1);
  });
});

describe('AC4.2 — the meters are independent in BOTH directions', () => {
  it('exhausting DAILY leaves the monthly meter spendable on the next UTC day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-08T12:00:00.000Z'));
    const lic = free('rollover');
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    expect(checkQuota(lic).limit).toBe('daily');

    // Cross midnight UTC: the daily meter resets, the monthly one does NOT.
    vi.setSystemTime(Date.parse('2026-08-09T00:00:01.000Z'));
    const after = checkQuota(lic);
    expect(after.allowed).toBe(true);
    expect(after.limit).toBeNull();
    expect(after.daily_used).toBe(0);            // daily reset
    expect(after.used).toBe(FREE_DAILY_CALLS);   // monthly carried over
  });

  it('exhausting MONTHLY refuses with limit:"monthly" even on a fresh day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-08T00:00:00.000Z'));
    const lic = free('monthly-wall');
    // Spend the whole month without ever tripping the daily cap: one full day per day.
    let day = 8;
    while (checkQuota(lic).used < FREE_MONTHLY_CALLS) {
      vi.setSystemTime(Date.parse(`2026-08-${String(day).padStart(2, '0')}T06:00:00.000Z`));
      for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
      day += 1;
      if (day > 28) break;
    }
    const r = checkQuota(lic);
    expect(r.used).toBeGreaterThanOrEqual(FREE_MONTHLY_CALLS);
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe('monthly'); // the binding wall, with the LONGER retry, wins
  });

  it('the daily meter is not a slice of the monthly one', () => {
    // If daily were a sub-limit, dailyCalls * 31 would be <= monthlyCalls. It is not (R-B):
    // a Starter may legitimately spend its whole month in ten days.
    expect(FREE_DAILY_CALLS * 31).toBeGreaterThan(FREE_MONTHLY_CALLS);
    expect((PLANS.starter.dailyCalls as number) * 31).toBeGreaterThan(PLANS.starter.monthlyCalls);
  });

  it('one charging rule: a single call advances BOTH meters by the same units', () => {
    const lic = free('both');
    trackCall(lic, 5);
    const r = checkQuota(lic);
    expect(r.daily_used).toBe(5);
    expect(r.used).toBe(5);
  });
});

describe('AC4.3 — the exempt tiers are untouched (the biggest regression risk)', () => {
  it('internal is exempt on BOTH meters — the TG bot runs ~6,200 calls/day', () => {
    // CH1 measured internal at 5,404–7,795 calls/day over the last 7 UTC days, every row
    // license_tier='internal'. A daily cap that caught them breaks the bot on day one.
    expect(getDailyCap('internal')).toBe(Infinity);
    expect(getMonthlyQuota('internal')).toBe(Infinity);

    const bot: LicenseInfo = { tier: 'internal', key: 'bot' };
    for (let i = 0; i < 7_000; i++) trackCall(bot);
    const r = checkQuota(bot);
    expect(r.allowed).toBe(true);
    expect(r.limit).toBeNull();
    // internal short-circuits before ANY metering — so it reports no daily pair at all,
    // which is a sharper statement of the same fact than a zero count was.
    expect(r.daily_used).toBeUndefined();
  });

  it('x402 is exempt on both meters — it pays per call, not per period', () => {
    expect(getDailyCap('x402')).toBe(Infinity);
    const pay: LicenseInfo = { tier: 'x402', key: null };
    for (let i = 0; i < 500; i++) trackCall(pay);
    expect(checkQuota(pay).allowed).toBe(true);
  });

  it('enterprise has NO daily ceiling — null means unbounded, never zero', () => {
    expect(PLANS.enterprise.dailyCalls).toBeNull();
    expect(getDailyCap('enterprise')).toBe(Infinity);
    const ent: LicenseInfo = { tier: 'enterprise', key: 'k', customerId: 'c' };
    for (let i = 0; i < 50; i++) trackCall(ent);
    expect(checkQuota(ent).allowed).toBe(true);
  });
});

describe('the by-key rail (webhook delivery) meters daily too', () => {
  it('trackCallByKey advances the daily meter and checkQuotaByKey reads it', () => {
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCallByKey('wh-owner', 'free');
    const r = checkQuotaByKey('wh-owner', 'free');
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe('daily');
  });

  it('internal is exempt on the by-key rail as well', () => {
    for (let i = 0; i < 5_000; i++) trackCallByKey('bot-key', 'internal');
    expect(checkQuotaByKey('bot-key', 'internal').allowed).toBe(true);
  });
});

describe('R-D — the period key is a UTC calendar day', () => {
  it('is the ISO date, so the reset instant is stateable in copy', () => {
    expect(utcDayKey(Date.parse('2026-08-08T23:59:59.999Z'))).toBe('2026-08-08');
    expect(utcDayKey(Date.parse('2026-08-09T00:00:00.000Z'))).toBe('2026-08-09');
  });

  it('does not follow the host timezone', () => {
    // A local-midnight boundary would give every caller a different reset, which is exactly the
    // property R-D rejected in the rolling monthly window.
    const lateUtc = Date.parse('2026-08-08T23:30:00.000Z');
    expect(utcDayKey(lateUtc)).toBe('2026-08-08');
    expect(utcDayKey(lateUtc)).toBe(new Date(lateUtc).toISOString().slice(0, 10));
  });

  it('starter and pro carry their own daily ceilings from the SoT', () => {
    expect(getDailyCap('starter')).toBe(PLANS.starter.dailyCalls);
    expect(getDailyCap('pro')).toBe(PLANS.pro.dailyCalls);
    const lic = starter('s1');
    trackCall(lic, 3);
    expect(checkQuota(lic).daily_used).toBe(3);
  });
});

/**
 * OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2 — WIRING, not formatting.
 *
 * CH2 reached production INERT. `_algovault.quota` carried no `daily` and no `binding` for ANY
 * caller, keyed or keyless, because every tool builds its envelope from `trackCall()`'s result and
 * `trackCall` did not return the daily pair it had just charged — so `withQuotaState` received
 * `dailyUsed: undefined` and correctly omitted both fields.
 *
 * Every CH2 unit test passed throughout, and that is the lesson worth keeping: they call
 * `withQuotaState` DIRECTLY with a pair, and `tests/unit/tier-warning.test.ts` additionally MOCKS
 * `../../src/lib/license.js` — so its seam replaced the exact producer that was broken. A test
 * asserting a formatter can never prove a caller feeds it. These assertions therefore run against
 * the REAL license module and compose the two functions the way the tool call sites compose them.
 */
describe('CH2 wiring — the envelope is built from a producer that reports BOTH meters', () => {
  it('trackCall REPORTS the daily meter it just charged', () => {
    const r = trackCall(free('av_free_wire_1'));
    expect(r.daily_used).toBe(1);
    expect(r.daily_total).toBe(FREE_DAILY_CALLS);
  });

  it('the tool-shaped composition emits daily + binding — the exact live defect', () => {
    const license = free('av_free_wire_2');
    const q = trackCall(license); // precisely what every tool call site binds
    const meta = withQuotaState({} as Parameters<typeof withQuotaState>[0], {
      tier: 'free',
      used: q.used,
      total: q.total,
      resetAtMs: Date.now() + 30 * 86_400_000,
      dailyUsed: q.daily_used, // ← `undefined` before the fix ⇒ both fields silently dropped
      dailyTotal: q.daily_total,
      dailyResetAtMs: utcDayResetAtMs(),
      isBotInternal: false,
    });
    expect(meta.quota?.daily).toBeDefined();
    expect(meta.quota?.daily?.total).toBe(FREE_DAILY_CALLS);
    // 1/100 daily beats 1/200 monthly, so the day-1 caller's binding meter is the daily one —
    // which is the whole point of the chapter.
    expect(meta.quota?.binding).toBe('daily');
  });

  it('an UNMETERED tier still gets no daily pair — the guard is the finite cap, not the tier', () => {
    const r = trackCall({ tier: 'x402', key: 'x402_wire' } as LicenseInfo);
    expect(r.daily_used).toBeUndefined();
    expect(r.daily_total).toBeUndefined();
  });
});
