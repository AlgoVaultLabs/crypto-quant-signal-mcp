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
  dailyUsedFor,
  utcDayKey,
  hoursUntilUtcDayReset,
  _resetCallTrackersForTest,
} from '../../src/lib/license.js';
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
    expect(dailyUsedFor(lic)).toBe(FREE_DAILY_CALLS);
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
    expect(dailyUsedFor(lic)).toBe(0);           // daily reset
    expect(after.used).toBe(FREE_DAILY_CALLS);   // monthly carried over
  });

  it('exhausting MONTHLY refuses with limit:"monthly" even on a fresh day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-08-08T00:00:00.000Z'));
    const lic = free('monthly-wall');
    // Spend the whole month without ever tripping the daily cap: one full day per day.
    let day = 8;
    while (dailyUsedFor(lic) >= 0 && checkQuota(lic).used < FREE_MONTHLY_CALLS) {
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
    expect(dailyUsedFor(lic)).toBe(5);
    expect(checkQuota(lic).used).toBe(5);
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
    expect(dailyUsedFor(bot)).toBe(0); // internal short-circuits before any meter
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
    expect(dailyUsedFor(lic)).toBe(3);
  });
});
