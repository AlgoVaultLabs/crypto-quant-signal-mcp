/**
 * PRICING-FOLLOWUPS-GENERATOR-W1 CH1 — the refusal a caller RECEIVES at the daily wall.
 *
 * WHY THIS FILE EXISTS, stated plainly because it is the whole lesson.
 *
 * CH4 of the previous wave shipped `hoursUntilUtcDayReset()`: exported, unit-tested against four
 * boundary cases, deployed — and called by NOTHING. For a day and a half production answered a
 * caller walled for two hours with:
 *
 *     "Free monthly quota used: 100/200. Access returns 2026-09-08 (30 days)."
 *
 * Wrong noun, wrong pair, wrong horizon, and `limit: undefined` on the thrown error while the
 * PUBLISHED shape snapshot promised `limit: 'daily'|'monthly'`. Every test was green throughout,
 * because every assertion pointed at the PRIMITIVE rather than at the PATH — `expect(
 * hoursUntilUtcDayReset(22:00Z)).toBe(2)` passes whether or not a single caller ever invokes it.
 *
 * So the assertions here deliberately start from a real tool call and read what comes out. A test
 * that imports the helper and checks its arithmetic is not evidence about the product.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkQuota, trackCall, monthResetAtMs, periodStartMs,
  _resetCallTrackersForTest, resetLicenseCache,
} from '../../src/lib/license.js';
import { FREE_DAILY_CALLS, FREE_MONTHLY_CALLS } from '../../src/lib/plans.js';
import { TierLimitReachedError, buildTierLimitPayload } from '../../src/lib/errors.js';
import { buildQuotaNoticeMessage, quotaNoticeFacts, buildQuotaSuggestedAction } from '../../src/lib/quota-notice.js';
import { hoursUntilUtcDayReset } from '../../src/lib/utc-day.js';
import type { LicenseInfo } from '../../src/types.js';

const ROOT = join(__dirname, '..', '..');
const AT_22Z = Date.parse('2026-08-09T22:00:00.000Z'); // 2h before the daily reset

let caseNo = 0;
const freshFree = (): LicenseInfo => ({ tier: 'free', key: `av_ch1_daily_${++caseNo}` });

/** Build the refusal the tools build, from the ONE quota result — mirrors every throw site. */
function refusalFor(lic: LicenseInfo, nowMs: number): TierLimitReachedError {
  const q = checkQuota(lic);
  expect(q.allowed, 'fixture must actually be walled').toBe(false);
  return new TierLimitReachedError({
    currentUsage: q.used,
    monthlyLimit: q.total,
    tier: lic.tier,
    suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
    resetAtMs: monthResetAtMs(lic),
    periodStartMs: periodStartMs(lic),
    referralCode: null,
    wall: q.limit === 'daily' ? 'daily' : 'monthly',
    dailyUsed: q.daily_used,
    dailyLimit: q.daily_total,
    nowMs,
  });
}

describe('the DAILY wall states the daily meter — noun, pair and horizon together', () => {
  beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

  it('refuses with limit:"daily" carrying the DAILY pair, not the monthly one', () => {
    const lic = freshFree();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const q = checkQuota(lic);
    expect(q.allowed).toBe(false);
    expect(q.limit).toBe('daily');
    expect([q.daily_used, q.daily_total]).toEqual([FREE_DAILY_CALLS, FREE_DAILY_CALLS]);
    // ...and the MONTHLY pair is untouched and nowhere near its ceiling. That contrast is the
    // bug: the old message printed these two numbers under a daily wall.
    expect(q.used).toBe(FREE_DAILY_CALLS);
    expect(q.total).toBe(FREE_MONTHLY_CALLS);
    expect(q.used).toBeLessThan(q.total);
  });

  it('THE LOCK: the thrown error states hours, the daily pair, and never a day count', () => {
    const lic = freshFree();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const err = refusalFor(lic, AT_22Z);

    expect(err.code).toBe('TIER_LIMIT_REACHED');
    expect(err.limit).toBe('daily');
    expect(err.daily_used).toBe(FREE_DAILY_CALLS);
    expect(err.daily_limit).toBe(FREE_DAILY_CALLS);
    expect(err.retry_after_hours).toBe(2); // 22:00Z → 00:00Z

    const headline = err.message.split('\n')[0];
    expect(headline).toBe(`Free daily quota used: ${FREE_DAILY_CALLS}/${FREE_DAILY_CALLS}. Access returns at 00:00 UTC (2 hours).`);
    // The regression, named: a daily wall must never quote a DAY count. This single assertion is
    // what the previous wave lacked — everything else it had was green while this was false.
    expect(headline).not.toMatch(/\d+\s*days?\b/);
    expect(headline).not.toContain('monthly');
    // The do-nothing fallback is a second rendering of the same fact and must agree.
    expect(err.suggested_action).toContain('wait until 00:00 UTC for the daily allowance to reset');
  });

  it('the WIRE payload carries the discriminator the published snapshot promises', () => {
    const lic = freshFree();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const p = buildTierLimitPayload(refusalFor(lic, AT_22Z));
    expect(p.limit).toBe('daily');
    expect(p.daily_used).toBe(FREE_DAILY_CALLS);
    expect(p.daily_limit).toBe(FREE_DAILY_CALLS);
    expect(p.retry_after_hours).toBe(2);
    // `current_usage`/`monthly_limit` have always meant the MONTHLY meter; consumers read them
    // that way, so they keep meaning it. The daily numbers arrive as siblings, never in place.
    expect(p.monthly_limit).toBe(FREE_MONTHLY_CALLS);
  });

  it('singular hour is not rendered as "1 hours"', () => {
    const lic = freshFree();
    for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(lic);
    const err = refusalFor(lic, Date.parse('2026-08-09T23:30:00.000Z'));
    expect(err.retry_after_hours).toBe(1);
    expect(err.message.split('\n')[0]).toContain('(1 hour)');
  });
});

describe('the MONTHLY wall is byte-identical — this wave moved nothing on that path', () => {
  beforeEach(() => { _resetCallTrackersForTest(); resetLicenseCache(); });

  it('renders the pre-wave sentence exactly, and carries limit:"monthly"', () => {
    const lic = freshFree();
    // Drive the MONTHLY meter without the daily one refusing: trackCall advances both, so charge
    // in one multi-unit call rather than a loop the daily cap would wall first.
    trackCall(lic, FREE_MONTHLY_CALLS);
    const q = checkQuota(lic);
    expect(q.allowed).toBe(false);
    expect(q.limit).toBe('monthly');

    const err = refusalFor(lic, AT_22Z);
    expect(err.limit).toBe('monthly');
    expect(err.retry_after_hours).toBeUndefined();
    expect(err.daily_used).toBeUndefined();

    const headline = err.message.split('\n')[0];
    // The FIXTURE: the exact shape that shipped before this wave. Any drift here is a regression
    // on the path CH8 measured as correct, not an improvement.
    expect(headline).toMatch(
      new RegExp(`^Free monthly quota used: ${FREE_MONTHLY_CALLS}/${FREE_MONTHLY_CALLS}\\. Access returns \\d{4}-\\d{2}-\\d{2} \\(\\d+ days\\)\\.$`),
    );
    expect(err.suggested_action).toMatch(/wait until \d{4}-\d{2}-\d{2} for the free quota to reset/);
  });

  it('the wire payload omits every daily field on a monthly refusal (key set unchanged)', () => {
    const lic = freshFree();
    trackCall(lic, FREE_MONTHLY_CALLS);
    const p = buildTierLimitPayload(refusalFor(lic, AT_22Z)) as Record<string, unknown>;
    expect(p.limit).toBe('monthly');
    for (const k of ['retry_after_hours', 'daily_used', 'daily_limit']) {
      expect(Object.prototype.hasOwnProperty.call(p, k), `${k} must be ABSENT, not undefined`).toBe(false);
    }
  });
});

describe('SINGLE DERIVATION — noun, pair and horizon all project from one discriminator', () => {
  // The defect was three facts disagreeing in one sentence. A property over BOTH wall values is
  // what makes "assembled from parts that each assume a meter" unwritable.
  const cases = [
    { wall: 'daily' as const, used: 100, limit: 100, noun: 'Free daily quota', horizon: /00:00 UTC \(\d+ hours?\)/ },
    { wall: 'monthly' as const, used: 200, limit: 200, noun: 'Free monthly quota', horizon: /\d{4}-\d{2}-\d{2} \(\d+ days\)/ },
  ];

  it.each(cases)('$wall: the noun, the pair and the horizon all agree', ({ wall, used, limit, noun, horizon }) => {
    const ctx = { meter: 'calls' as const, wall, used, limit, resetAtMs: AT_22Z + 30 * 86_400_000, nowMs: AT_22Z, referralCode: null };
    const line = buildQuotaNoticeMessage(ctx).split('\n')[0];
    const f = quotaNoticeFacts(ctx);
    expect(f.limit).toBe(wall);
    expect(line.startsWith(noun), `${wall} noun`).toBe(true);
    expect(line).toContain(`${used}/${limit}`);
    expect(line).toMatch(horizon);
    // The other meter's vocabulary must not appear at all — that is what "one projection" buys.
    const otherNoun = wall === 'daily' ? 'Free monthly quota' : 'Free daily quota';
    expect(line).not.toContain(otherNoun);
    expect(buildQuotaSuggestedAction(ctx)).toContain(wall === 'daily' ? '00:00 UTC' : 'for the free quota to reset');
  });

  it('an omitted wall defaults to monthly — every pre-R-B caller keeps its meaning', () => {
    const ctx = { meter: 'calls' as const, used: 200, limit: 200, resetAtMs: AT_22Z + 30 * 86_400_000, nowMs: AT_22Z, referralCode: null };
    expect(quotaNoticeFacts(ctx).limit).toBe('monthly');
    expect(buildQuotaNoticeMessage(ctx).split('\n')[0]).toContain('Free monthly quota');
  });
});

describe('WIRING — the primitive has a production consumer, and cannot lose one silently', () => {
  it('hoursUntilUtcDayReset is called from a non-test src/ path', () => {
    // The assertion the previous wave did not have. `hoursUntilUtcDayReset` was correct,
    // exported and tested for 1.5 days while NOTHING called it; only a live probe found that.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts')) files.push(rel);
      }
    };
    walk('src');
    const consumers = files.filter((f) => {
      if (f.endsWith('src/lib/utc-day.ts')) return false; // its own declaration
      const src = readFileSync(join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
      // A re-export is not a consumer — license.ts re-exports it for back-compat and would
      // otherwise satisfy this assertion while nothing actually invoked it.
      return /hoursUntilUtcDayReset\s*\(/.test(src);
    });
    expect(consumers, 'hoursUntilUtcDayReset has no production caller — it is dark again').not.toEqual([]);
    expect(consumers).toContain('src/lib/quota-notice.ts');
  });

  it('dailyUsedFor stays deleted — one production answer to "daily used", not two', () => {
    const lib = readFileSync(join(ROOT, 'src/lib/license.ts'), 'utf8');
    expect(/export\s+function\s+dailyUsedFor/.test(lib)).toBe(false);
  });

  it('every TierLimitReachedError construction site passes the wall discriminator', () => {
    // Four sites build this error today, each inline. A fifth added without `wall` would default
    // to 'monthly' and silently re-open the defect for that tool ONLY — the hardest variant to
    // notice, because the other three would still be right.
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts')) files.push(rel);
      }
    };
    walk('src');
    const sites = files.filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('new TierLimitReachedError('));
    expect(sites.length, 'vacuity guard — no construction sites found, the scan broke').toBeGreaterThanOrEqual(4);
    const missing = sites.filter((f) => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      // The error module itself DECLARES the arg; it does not construct one.
      if (f.endsWith('src/lib/errors.ts')) return false;
      return !/\bwall:\s*/.test(src);
    });
    expect(missing, 'these build a TierLimitReachedError without passing `wall`').toEqual([]);
  });
});

describe('FREE-HOLD COMMENT CLASS — a comment asserting the opposite of its code', () => {
  // The class CH7 fixed in four files and CH1 found twice more (x402-http-routes.ts module
  // header, equity-tool-formatters.ts gate docstring). A header claiming "HOLD stays free"
  // above code that charges HOLD is an invitation to "restore" the skip on the revenue rail.
  //
  // EXEMPT, declared here rather than by weakening the pattern — the same registry discipline
  // `no-free-hold-promise.test.ts` uses. Each entry says why it is NOT a live claim.
  const EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
    { file: 'src/lib/call-class.ts', reason: 'behaviour identifiers (`free_hold`, the legacy `per-non-hold` axis) + the historical forensics record; classification of PRE-cutover rows is still per-non-hold by design' },
    { file: 'src/lib/analytics.ts', reason: 'consumes the `free_hold` CallClass identifier for the operator funnel decomposition' },
    { file: 'src/lib/agent-activity-format.ts', reason: 'renders the `free_hold` bucket label in an INTERNAL ops digest' },
    { file: 'src/lib/funnel-scoreboard.ts', reason: 'internal scoreboard caveat describing the same historical bucket' },
    { file: 'src/lib/x402-http-routes.ts', reason: 'the CORRECTION record — it quotes the retired line to explain why it was wrong' },
    { file: 'src/lib/equities/equity-tool-formatters.ts', reason: 'two correction records quoting the retired clause + the wave-spec divergence note' },
  ];

  it('no NEW file joins the class, and every exemption carries a reason', () => {
    for (const e of EXEMPT) expect(e.reason.length, e.file).toBeGreaterThan(25);
    const files: string[] = [];
    const walk = (d: string) => {
      for (const x of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const rel = `${d}/${x.name}`;
        if (x.isDirectory()) walk(rel);
        else if (x.name.endsWith('.ts')) files.push(rel);
      }
    };
    walk('src');
    expect(files.length, 'vacuity guard').toBeGreaterThan(50);
    const RE = /HOLD[^.\n]{0,40}(?:stay|are|is)\s+free|HOLD[^.\n]{0,30}(?:unmetered|not charged|never charged)/i;
    const exempt = new Set(EXEMPT.map((e) => e.file));
    const offenders = files.filter((f) => !exempt.has(f) && RE.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders, 'new free-HOLD claim in src/ — flat billing charges every verdict (R-A)').toEqual([]);
  });
});

afterEach(() => { vi.useRealTimers(); });
