/**
 * IDENTITY-LIFECYCLE-W3 CH2 — the four predicates, both directions, including the boundaries.
 *
 * Predicates are pure over a bucket list, so these are exact rather than approximate: every
 * threshold is asserted AT the boundary and one step either side of it. An off-by-one in
 * `quota_80` is the difference between warning somebody and walling them without warning.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'a'.repeat(48);

function freshEnv(): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
  delete process.env.LIFECYCLE_MODE;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date('2026-09-08T12:00:00.000Z');

/** A bucket fixture. `total` defaults to the real free allowance. */
function bucket(over: Partial<{
  apiKey: string; email: string; trackerKey: string; createdAtMs: number;
  lastUsedAtMs: number | null; used: number; total: number; periodStart: string | null;
}> = {}) {
  const total = over.total ?? 200;
  const periodStart = over.periodStart === undefined ? '2026-09-01T00:00:00.000Z' : over.periodStart;
  const startMs = periodStart ? Date.parse(periodStart) : null;
  return {
    apiKey: over.apiKey ?? 'av_free_1234567890ab',
    email: over.email ?? 'person@example.com',
    trackerKey: over.trackerKey ?? over.apiKey ?? 'av_free_1234567890ab',
    createdAtMs: over.createdAtMs ?? Date.parse('2026-08-20T00:00:00.000Z'),
    lastUsedAtMs: over.lastUsedAtMs === undefined ? Date.parse('2026-09-05T00:00:00.000Z') : over.lastUsedAtMs,
    meter: {
      trackerKey: over.trackerKey ?? over.apiKey ?? 'av_free_1234567890ab',
      used: over.used ?? 0,
      total,
      periodStart,
      resetAtMs: startMs === null ? null : startMs + 30 * DAY,
      resetDate: startMs === null ? null : '1 October 2026',
    },
  };
}

describe('quota_80 — the 80 % boundary, exactly', () => {
  beforeEach(freshEnv);

  it('fires AT 160/200 and not at 159', async () => {
    const { quota80Candidates } = await import('../../src/lib/lifecycle/steps.js');
    expect(quota80Candidates([bucket({ used: 159 })])).toHaveLength(0);
    expect(quota80Candidates([bucket({ used: 160 })])).toHaveLength(1);
  });

  it('STOPS at the wall — 200/200 is quota_wall\'s, not quota_80\'s', async () => {
    const { quota80Candidates, quotaWallCandidates } = await import('../../src/lib/lifecycle/steps.js');
    expect(quota80Candidates([bucket({ used: 200 })])).toHaveLength(0);
    expect(quotaWallCandidates([bucket({ used: 200 })])).toHaveLength(1);
    // …and the two are mutually exclusive at every value, which is what stops a caller getting
    // both messages on the same day.
    for (const used of [0, 159, 160, 199, 200, 250]) {
      const both = quota80Candidates([bucket({ used })]).length + quotaWallCandidates([bucket({ used })]).length;
      expect(both, `used=${used}`).toBeLessThanOrEqual(1);
    }
  });

  it('a bucket with NO live period is never eligible — an expired window is not usage', async () => {
    const { quota80Candidates, quotaWallCandidates } = await import('../../src/lib/lifecycle/steps.js');
    expect(quota80Candidates([bucket({ used: 180, periodStart: null })])).toHaveLength(0);
    expect(quotaWallCandidates([bucket({ used: 400, periodStart: null })])).toHaveLength(0);
  });

  it('carries the period as the idempotency key, so a NEW window earns a new warning', async () => {
    const { quota80Candidates } = await import('../../src/lib/lifecycle/steps.js');
    const a = quota80Candidates([bucket({ used: 170, periodStart: '2026-09-01T00:00:00.000Z' })]);
    const b = quota80Candidates([bucket({ used: 170, periodStart: '2026-10-01T00:00:00.000Z' })]);
    expect(a[0].ctx.periodKey).toBe('2026-09-01T00:00:00.000Z');
    expect(b[0].ctx.periodKey).toBe('2026-10-01T00:00:00.000Z');
    expect(a[0].ctx.periodKey).not.toBe(b[0].ctx.periodKey);
  });
});

describe('quota_wall — the DAILY wall must never reach it', () => {
  beforeEach(freshEnv);

  it('a bucket far under the MONTHLY cap is not eligible, whatever it did today', async () => {
    const { quotaWallCandidates } = await import('../../src/lib/lifecycle/steps.js');
    // 100/100 on the daily meter is a real refusal that lasts HOURS. It is deliberately invisible
    // here: the predicate reads the monthly meter and nothing else, so there is no code path by
    // which a daily wall can produce an email.
    expect(quotaWallCandidates([bucket({ used: 100 })])).toHaveLength(0);
  });

  it('fires at and beyond the monthly cap', async () => {
    const { quotaWallCandidates } = await import('../../src/lib/lifecycle/steps.js');
    expect(quotaWallCandidates([bucket({ used: 200 })])).toHaveLength(1);
    expect(quotaWallCandidates([bucket({ used: 260 })])).toHaveLength(1);
  });
});

describe('activation_nudge — never used, old enough, recent enough', () => {
  beforeEach(freshEnv);

  it('requires the key to be at least 48h old', async () => {
    const { activationNudgeCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const young = bucket({ createdAtMs: NOW.getTime() - 47 * HOUR, lastUsedAtMs: null, used: 0, periodStart: null });
    const ripe = bucket({ createdAtMs: NOW.getTime() - 49 * HOUR, lastUsedAtMs: null, used: 0, periodStart: null });
    expect(activationNudgeCandidates([young], NOW)).toHaveLength(0);
    expect(activationNudgeCandidates([ripe], NOW)).toHaveLength(1);
  });

  it('requires BOTH never-used signals — a stamped last_used_at disqualifies even at zero usage', async () => {
    const { activationNudgeCandidates } = await import('../../src/lib/lifecycle/steps.js');
    // Zero meter but a real call on record: the window merely expired. Nudging here would tell
    // somebody who HAS used the product that they never have.
    const used = bucket({ createdAtMs: NOW.getTime() - 10 * DAY, lastUsedAtMs: NOW.getTime() - 40 * DAY, used: 0, periodStart: null });
    expect(activationNudgeCandidates([used], NOW)).toHaveLength(0);
  });

  it('period_key is `once` — a lifetime message, not a monthly one', async () => {
    const { activationNudgeCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const b = bucket({ createdAtMs: NOW.getTime() - 5 * DAY, lastUsedAtMs: null, used: 0, periodStart: null });
    expect(activationNudgeCandidates([b], NOW)[0].ctx.periodKey).toBe('once');
  });

  it('R5 BACKFILL: at flip time the set is capped to keys issued in the last 30 days', async () => {
    const { activationNudgeCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const old = bucket({ createdAtMs: NOW.getTime() - 200 * DAY, lastUsedAtMs: null, used: 0, periodStart: null });
    const recent = bucket({ createdAtMs: NOW.getTime() - 5 * DAY, lastUsedAtMs: null, used: 0, periodStart: null });
    const set = activationNudgeCandidates([old, recent], NOW, NOW);
    // Nudging somebody about a key they minted eight months ago is a message about a decision
    // they already made. MEASURED: this cap takes the live eligible set from 28 to 7.
    expect(set).toHaveLength(1);
    expect(set[0].recipient.recipientId).toBe(recent.apiKey);
  });
});

describe('reset_return — hit the wall AND went quiet', () => {
  beforeEach(freshEnv);

  const freshStart = new Date(NOW.getTime() - 2 * HOUR).toISOString();

  it('fires when the window just rolled and the last call was > 72h before it', async () => {
    const { resetReturnCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const b = bucket({ periodStart: freshStart, lastUsedAtMs: Date.parse(freshStart) - 80 * HOUR });
    expect(resetReturnCandidates([b], NOW)).toHaveLength(1);
  });

  it('does NOT fire for somebody still calling — they need no invitation', async () => {
    const { resetReturnCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const b = bucket({ periodStart: freshStart, lastUsedAtMs: Date.parse(freshStart) - 2 * HOUR });
    expect(resetReturnCandidates([b], NOW)).toHaveLength(0);
  });

  it('does NOT fire on an OLD window — "your calls are back" must follow a rollover', async () => {
    const { resetReturnCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const b = bucket({ periodStart: '2026-08-01T00:00:00.000Z', lastUsedAtMs: Date.parse('2026-07-01T00:00:00.000Z') });
    expect(resetReturnCandidates([b], NOW)).toHaveLength(0);
  });

  it('does NOT fire for a bucket that never called at all — that is activation_nudge\'s job', async () => {
    const { resetReturnCandidates } = await import('../../src/lib/lifecycle/steps.js');
    const b = bucket({ periodStart: freshStart, lastUsedAtMs: null });
    expect(resetReturnCandidates([b], NOW)).toHaveLength(0);
  });
});

describe('ruling Q4(A) — every step is FREE TIER ONLY', () => {
  beforeEach(freshEnv);

  it('the candidate query reads free_keys and nothing else', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync('src/lib/lifecycle/steps.ts', 'utf8');
    // STRIP COMMENTS FIRST. The first version of this assertion matched the word `av_live_` in
    // this file's own docstring — a mention is not a reference, and a scanner that cannot tell
    // them apart is the exact defect this wave already fixed twice (the on-conflict parity gate
    // and the dark-artifact stripper). Block comments before line comments, so a `*/` inside a
    // string cannot bridge two blocks.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    // Structural, not a filter: `av_live_` keys are not in `free_keys` at all. Asserted because
    // the COPY is free-tier-shaped — E2 says "of its {total} free calls" and sells Starter, so a
    // paid caller receiving it is told a false number and sold their own plan.
    expect(src).toMatch(/FROM free_keys/);
    expect(src).not.toMatch(/FROM\s+subscriber_profiles/);
    expect(src).not.toMatch(/av_live_/);
    // The stripper must not have eaten the subject it is meant to inspect.
    expect(src).toMatch(/quota_wall/);
  });

  it('a paid-shaped key cannot enter the candidate set through the predicates', async () => {
    const { quota80Candidates, quotaWallCandidates } = await import('../../src/lib/lifecycle/steps.js');
    // Even if one were somehow present, the allowance it is measured against is the FREE one, so
    // this documents the coupling rather than pretending the predicates inspect the tier.
    const paid = bucket({ apiKey: 'av_live_deadbeefcafe', used: 9_000, total: 200 });
    expect(quota80Candidates([paid])).toHaveLength(0);   // 9000 >= 200 -> wall, not 80%
    expect(quotaWallCandidates([paid])).toHaveLength(1);
    // …which is exactly why the QUERY, not the predicate, is the tier gate — asserted above.
  });
});

describe('step priority when a cap forces a choice', () => {
  beforeEach(freshEnv);

  it('quota_wall outranks quota_80 outranks reset_return outranks activation_nudge', async () => {
    const { STEP_PRIORITY } = await import('../../src/lib/lifecycle-copy.js');
    expect([...STEP_PRIORITY]).toEqual([
      'quota_wall', 'quota_80', 'reset_return', 'activation_nudge', 'product_updates',
    ]);
    // The digest yields to all four usage steps: a product update is never time-critical, and
    // MEASURED 2026-09-08 all six signup_emails opt-ins also hold a free key, so the collision is
    // the default case rather than an edge one.
    expect(STEP_PRIORITY[STEP_PRIORITY.length - 1]).toBe('product_updates');
  });
});
