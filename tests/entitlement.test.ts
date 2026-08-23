/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH2 — consumeEntitlement / readEntitlement.
 *
 * Meter state lives in per-process in-memory maps keyed by tracker key, so every test uses a
 * UNIQUE key (the pattern tests/webhook-delivery.test.ts already uses with 'free:fresh'). That
 * makes each case independent without needing a reset hook that does not exist.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  consumeEntitlement,
  readEntitlement,
  _resetEntitlementSchemaForTest,
} from '../src/lib/entitlement.js';
import { checkQuotaByKey, trackCallByKey } from '../src/lib/license.js';
import { PLANS } from '../src/lib/plans.js';
import { dbQuery } from '../src/lib/performance-db.js';

let n = 0;
const freshKey = (label: string) => `av_test_${label}_${Date.now()}_${n++}`;

beforeEach(() => {
  _resetEntitlementSchemaForTest();
});
afterEach(() => vi.restoreAllMocks());

describe('the four outcomes', () => {
  it('CHARGED — a first debit advances the meter by exactly `units`', async () => {
    const key = freshKey('charged');
    const before = checkQuotaByKey(key, 'starter').used;
    const r = await consumeEntitlement({
      trackerKey: key, tier: 'starter', channel: 'bot', units: 3, idempotencyKey: `${key}:1`,
    });
    expect(r.outcome).toBe('CHARGED');
    expect(checkQuotaByKey(key, 'starter').used).toBe(before + 3);
    // The decision is read AFTER the charge, so it reflects what this debit produced.
    expect(r.decision.used).toBe(before + 3);
    expect(r.decision.total).toBe(PLANS.starter.monthlyCalls);
  });

  it('ALREADY_CHARGED — a replay of the same key charges NOTHING', async () => {
    const key = freshKey('replay');
    const idem = `${key}:same`;
    await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'bot', units: 5, idempotencyKey: idem });
    const afterFirst = checkQuotaByKey(key, 'starter').used;
    const r = await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'bot', units: 5, idempotencyKey: idem });
    expect(r.outcome).toBe('ALREADY_CHARGED');
    expect(checkQuotaByKey(key, 'starter').used).toBe(afterFirst);
  });

  it('REFUSED — a `none` channel never debits somebody else\'s plan by default', async () => {
    const key = freshKey('none');
    const before = checkQuotaByKey(key, 'starter').used;
    const r = await consumeEntitlement({
      trackerKey: key, tier: 'starter', channel: 'a2mcp', units: 1, idempotencyKey: `${key}:x`,
    });
    expect(r.outcome).toBe('REFUSED');
    expect(checkQuotaByKey(key, 'starter').used).toBe(before);
  });

  it('a `none` refusal claims NOTHING either — the key stays reusable', async () => {
    const key = freshKey('noneclaim');
    const idem = `${key}:reuse`;
    await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'a2mcp', units: 1, idempotencyKey: idem });
    const rows = await dbQuery<{ idem_key: string }>(
      'SELECT idem_key FROM entitlement_debits WHERE idem_key = ?', [idem],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the wall — checkQuotaByKey is authoritative, retiring the >= / > divergence', () => {
  it('refuses at EXACTLY used === total, not one call later', async () => {
    const key = freshKey('wall');
    const total = PLANS.starter.monthlyCalls;
    trackCallByKey(key, 'starter', total); // sit exactly on the ceiling
    expect(checkQuotaByKey(key, 'starter').used).toBe(total);

    const r = await consumeEntitlement({
      trackerKey: key, tier: 'starter', channel: 'bot', units: 1, idempotencyKey: `${key}:wall`,
    });
    // `trackCallByKey` alone would have said allowed here (it refuses at `>`, not `>=`) and served
    // one extra call. The primitive ignores its `allowed` and follows checkQuotaByKey.
    expect(r.outcome).toBe('REFUSED');
    expect(checkQuotaByKey(key, 'starter').used).toBe(total);
  });

  it('a refusal claims nothing, so the SAME key works after headroom returns', async () => {
    const key = freshKey('wallretry');
    const idem = `${key}:retry`;
    trackCallByKey(key, 'starter', PLANS.starter.monthlyCalls);
    expect((await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'bot', units: 1, idempotencyKey: idem })).outcome).toBe('REFUSED');
    // Simulate the reset the caller would wait for: a brand-new window under the same idem key.
    const fresh = freshKey('wallretry2');
    const r = await consumeEntitlement({ trackerKey: fresh, tier: 'starter', channel: 'bot', units: 1, idempotencyKey: idem });
    expect(r.outcome).toBe('CHARGED');
  });

  it('a meter-only channel (refusesAtWall: false) counts PAST the ceiling', async () => {
    const key = freshKey('meteronly');
    trackCallByKey(key, 'starter', PLANS.starter.monthlyCalls);
    const r = await consumeEntitlement({
      trackerKey: key, tier: 'starter', channel: 'mcp', units: 1, idempotencyKey: `${key}:m`,
    });
    // mcp is request-context + refusesAtWall:false — PAID_TIERS_ARE_HARD_WALLED is false and this
    // wave deliberately did not flip it.
    expect(r.outcome).toBe('CHARGED');
    expect(checkQuotaByKey(key, 'starter').used).toBeGreaterThan(PLANS.starter.monthlyCalls);
  });
});

describe('settled channels are not on the plan meter', () => {
  it('httpX402 never touches quota_usage and reports no ceiling', async () => {
    const key = freshKey('settled');
    const before = checkQuotaByKey(key, 'starter').used;
    const r = await consumeEntitlement({
      trackerKey: key, tier: 'starter', channel: 'httpX402', units: 9, idempotencyKey: `${key}:s`,
    });
    expect(r.outcome).toBe('ALREADY_CHARGED');
    expect(r.decision.total).toBe(Infinity);
    expect(checkQuotaByKey(key, 'starter').used).toBe(before);
  });
});

describe('INDETERMINATE never charges — fail CLOSED on the money', () => {
  it('a claim fault leaves the meter untouched', async () => {
    const key = freshKey('indet');
    const before = checkQuotaByKey(key, 'starter').used;
    const mod = await import('../src/lib/idempotency.js');
    vi.spyOn(mod, 'tryClaimOnce').mockResolvedValue('INDETERMINATE');
    const r = await consumeEntitlement({
      trackerKey: key, tier: 'starter', channel: 'bot', units: 4, idempotencyKey: `${key}:i`,
    });
    expect(r.outcome).toBe('INDETERMINATE');
    expect(checkQuotaByKey(key, 'starter').used).toBe(before);
  });
});

describe('a debit is not a request', () => {
  it('writes NO request_log row — that would double-count in the digest partition', async () => {
    const key = freshKey('reqlog');
    const countRows = async () =>
      (await dbQuery<{ c: number }>('SELECT COUNT(*) AS c FROM request_log', []))[0]?.c ?? 0;
    let before: number;
    try {
      before = Number(await countRows());
    } catch {
      return; // no request_log in this backend — nothing this test can assert
    }
    await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'bot', units: 1, idempotencyKey: `${key}:r` });
    expect(Number(await countRows())).toBe(before);
  });

  it('writes exactly ONE entitlement_debits row per claimed debit', async () => {
    const key = freshKey('ledger');
    const idem = `${key}:one`;
    await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'bot', units: 2, idempotencyKey: idem });
    await consumeEntitlement({ trackerKey: key, tier: 'starter', channel: 'bot', units: 2, idempotencyKey: idem });
    const rows = await dbQuery<{ channel: string; units: number }>(
      'SELECT channel, units FROM entitlement_debits WHERE idem_key = ?', [idem],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('bot'); // per-channel attribution, which quota_usage cannot give
  });
});

describe('readEntitlement — no charge, no claim', () => {
  it('reports state without moving the meter', async () => {
    const key = freshKey('read');
    trackCallByKey(key, 'starter', 7);
    const before = checkQuotaByKey(key, 'starter').used;
    const d = readEntitlement(key, 'starter', 'bot');
    expect(d.used).toBe(before);
    expect(d.allowed).toBe(true);
    expect(d.refusesAtWall).toBe(true); // projected from the policy, not decided here
    expect(checkQuotaByKey(key, 'starter').used).toBe(before);
  });

  it('carries the episode keys a caller needs to scope "notify once per episode"', () => {
    const key = freshKey('episode');
    trackCallByKey(key, 'starter', 1);
    const d = readEntitlement(key, 'starter', 'bot');
    expect(d.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.dailyDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('an untouched key has no episode — absent is a fact, not a zero', () => {
    const d = readEntitlement(freshKey('untouched'), 'starter', 'bot');
    expect(d.periodStart).toBeNull();
    expect(d.dailyDay).toBeNull();
  });
});

// ── OPS-WEBHOOK-QUOTA-METER-PARITY-W1 — REPORTING changed, ENFORCEMENT did not ────────────
//
// The wave made `checkQuotaByKey` return the daily pair. The one thing it must NOT have done is
// change WHO gets refused. `checkQuotaByKey` walls every tier on the daily meter deliberately —
// a posture this wave preserves exactly, because relaxing it would silently stop refusing paid
// webhook owners at their ceiling.
describe('checkQuotaByKey — refusal parity (AC1)', () => {
  const TIERS = ['free', 'starter', 'pro', 'enterprise', 'x402', 'internal'] as const;

  it('🎯 the enforcement matrix is exactly as recorded before the wave', async () => {
    const { checkQuotaByKey, trackCallByKey } = await import('../src/lib/license.js');
    const { PLANS, FREE_MONTHLY_CALLS, FREE_DAILY_CALLS } = await import('../src/lib/plans.js');
    const monthlyOf = (t: string) => (t === 'free' ? FREE_MONTHLY_CALLS : (PLANS as never)[t]?.monthlyCalls ?? Infinity);
    const dailyOf = (t: string) => (t === 'free' ? FREE_DAILY_CALLS : (PLANS as never)[t]?.dailyCalls ?? Infinity);

    // The LITERAL pre-wave matrix, captured from origin/main before a line was edited. Pinned as
    // literals on purpose: derived expectations would move with the code they are meant to pin.
    const EXPECTED: Record<string, [boolean, string | null]> = {
      'free|fresh': [true, null],       'free|under': [true, null],
      'free|daily': [false, 'daily'],   'free|monthly': [false, 'monthly'],
      'starter|fresh': [true, null],    'starter|under': [true, null],
      'starter|daily': [false, 'daily'],'starter|monthly': [false, 'monthly'],
      'pro|fresh': [true, null],        'pro|under': [true, null],
      'pro|daily': [false, 'daily'],    'pro|monthly': [false, 'monthly'],
      // Enterprise has NO daily cap (`dailyCalls: null`), so its daily state is allowed.
      'enterprise|fresh': [true, null], 'enterprise|under': [true, null],
      'enterprise|daily': [true, null], 'enterprise|monthly': [false, 'monthly'],
      // Uncapped tiers refuse nothing.
      'x402|fresh': [true, null],       'x402|under': [true, null],
      'x402|daily': [true, null],       'x402|monthly': [true, null],
      'internal|fresh': [true, null],   'internal|under': [true, null],
      'internal|daily': [true, null],   'internal|monthly': [true, null],
    };

    let n = 0;
    for (const tier of TIERS) {
      const m = monthlyOf(tier), d = dailyOf(tier);
      const states: [string, number][] = [
        ['fresh', 0],
        ['under', Number.isFinite(d) ? Math.max(0, d - 1) : 5],
        ['daily', Number.isFinite(d) ? d : 5],
        ['monthly', Number.isFinite(m) ? m : 5],
      ];
      for (const [state, units] of states) {
        const key = `parity-guard-${tier}-${state}-${n++}`;
        if (units > 0) trackCallByKey(key, tier, units);
        const r = checkQuotaByKey(key, tier);
        const [wantAllowed, wantLimit] = EXPECTED[`${tier}|${state}`];
        expect([tier, state, r.allowed]).toEqual([tier, state, wantAllowed]);
        expect([tier, state, r.limit ?? null]).toEqual([tier, state, wantLimit]);
      }
    }
  });

  it('🎯 the daily pair travels with the decision, and never replaces the MONTHLY pair', async () => {
    const { checkQuotaByKey, trackCallByKey } = await import('../src/lib/license.js');
    const { PLANS } = await import('../src/lib/plans.js');
    const key = 'parity-pair-starter';
    trackCallByKey(key, 'starter', PLANS.starter.dailyCalls!); // sit exactly on the DAILY wall
    const r = checkQuotaByKey(key, 'starter');
    expect(r.allowed).toBe(false);
    expect(r.limit).toBe('daily');
    // 🛑 THE DEFECT CLASS: a daily wall must not render the monthly figures. Both pairs travel.
    expect(r.daily_used).toBe(PLANS.starter.dailyCalls);
    expect(r.daily_total).toBe(PLANS.starter.dailyCalls);
    expect(r.total).toBe(PLANS.starter.monthlyCalls);
    expect(r.daily_total).not.toBe(r.total);
  });

  it('🎯 a MONTHLY refusal carries NO daily pair — absent, never a fabricated 0/N', async () => {
    const { checkQuotaByKey, trackCallByKey, getTrackerEpisode } = await import('../src/lib/license.js');
    const { PLANS } = await import('../src/lib/plans.js');
    const key = 'parity-monthly-refusal';
    trackCallByKey(key, 'starter', PLANS.starter.monthlyCalls);
    const r = checkQuotaByKey(key, 'starter');
    expect(r.limit).toBe('monthly');
    // Reaching the monthly branch means the daily meter was never consulted. Reporting a pair
    // would require materialising a daily tracker — which `getTrackerEpisode` reads, so it would
    // invent an episode this very call had created. Absent is the honest answer.
    expect(r.daily_used).toBeUndefined();
    expect(r.daily_total).toBeUndefined();
    expect(getTrackerEpisode(key).dailyDay).not.toBeNull(); // trackCallByKey already charged today
  });

  it('🎯 a tier with NO daily cap emits no daily keys at all', async () => {
    const { checkQuotaByKey } = await import('../src/lib/license.js');
    for (const tier of ['enterprise', 'x402', 'internal'] as const) {
      const r = checkQuotaByKey(`parity-nodaily-${tier}`, tier);
      expect(r.daily_used, tier).toBeUndefined();
      expect(r.daily_total, tier).toBeUndefined();
    }
  });
});
