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
