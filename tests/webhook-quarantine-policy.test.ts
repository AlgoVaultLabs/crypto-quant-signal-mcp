/**
 * OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH3 (R3.5) — tier-differentiated quarantine policy.
 *
 * D2: a paying `starter` customer's webhook expired on the same 7-day clock as an
 * anonymous free one. The load-bearing property here is NOT "paid gets 30d" — it is
 * that an UNRECOGNISED tier can never buy a longer window than the incumbent 7d.
 * A silent widening would hand any garbage or unknown tier string a month of retries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  quarantineMaxSecFor,
  quarantineExpiresAt,
  isPaidTier,
  QUARANTINE_MAX_SEC_FREE,
  QUARANTINE_MAX_SEC_PAID,
} from '../src/lib/webhook-quarantine-policy.js';

const ENVKEY = 'WEBHOOK_QUARANTINE_MAX_SEC';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENVKEY];
  delete process.env[ENVKEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENVKEY];
  else process.env[ENVKEY] = saved;
});

describe('constants', () => {
  it('free window is the incumbent 7d, paid is 30d', () => {
    expect(QUARANTINE_MAX_SEC_FREE).toBe(604800);
    expect(QUARANTINE_MAX_SEC_PAID).toBe(2592000);
    expect(QUARANTINE_MAX_SEC_PAID).toBeGreaterThan(QUARANTINE_MAX_SEC_FREE);
  });
});

describe('paid tiers → 30d', () => {
  // x402 is a LIVE revenue rail (USDC on Base). Omitting it would put a paying
  // customer back on the free clock — reintroducing the exact defect D2 names.
  for (const tier of ['starter', 'pro', 'enterprise', 'x402']) {
    it(`${tier} → 30d`, () => {
      expect(isPaidTier(tier)).toBe(true);
      expect(quarantineMaxSecFor(tier)).toBe(QUARANTINE_MAX_SEC_PAID);
    });
  }
});

describe('everything else → 7d (incumbent), never a silent widening', () => {
  const nonPaid: Array<string | null | undefined> = [
    'free',
    'internal',   // our own operator key, not a customer whose retention we protect
    null,
    undefined,
    '',
    '   ',
    'GARBAGE',
    'Starter',    // case-sensitive: near-miss must NOT buy 30d
    'STARTER',
    ' starter',   // whitespace-padded near-miss
    'starter ',
    'pro;drop',
    '0',
  ];
  for (const tier of nonPaid) {
    it(`${JSON.stringify(tier)} → 7d`, () => {
      expect(isPaidTier(tier)).toBe(false);
      expect(quarantineMaxSecFor(tier)).toBe(QUARANTINE_MAX_SEC_FREE);
    });
  }

  it('NO input can exceed 7d without being an explicitly listed paid tier', () => {
    // The invariant stated as a property rather than by example.
    const probes = ['free', 'internal', '', 'x', 'Pro', 'enterprise_', 'x4020', '../starter'];
    for (const t of probes) {
      expect(quarantineMaxSecFor(t)).toBeLessThanOrEqual(QUARANTINE_MAX_SEC_FREE);
    }
  });
});

describe('WEBHOOK_QUARANTINE_MAX_SEC override — the rollback lever', () => {
  it('a valid positive integer wins for EVERY tier (restores uniform pre-wave behaviour)', () => {
    process.env[ENVKEY] = '604800';
    for (const tier of ['starter', 'pro', 'enterprise', 'x402', 'free', 'internal', null, undefined, 'GARBAGE']) {
      expect(quarantineMaxSecFor(tier)).toBe(604800);
    }
  });

  it('an arbitrary positive value wins for a paid tier too', () => {
    process.env[ENVKEY] = '10';
    expect(quarantineMaxSecFor('starter')).toBe(10);
    expect(quarantineMaxSecFor('free')).toBe(10);
  });

  it('floors a fractional value', () => {
    process.env[ENVKEY] = '99.9';
    expect(quarantineMaxSecFor('free')).toBe(99);
  });

  for (const bad of ['abc', '-1', '0', '', '   ', 'NaN', 'Infinity', '1e999']) {
    it(`garbage ${JSON.stringify(bad)} is IGNORED → tier policy applies (never NaN, never 0)`, () => {
      process.env[ENVKEY] = bad;
      const paid = quarantineMaxSecFor('starter');
      const free = quarantineMaxSecFor('free');
      expect(paid).toBe(QUARANTINE_MAX_SEC_PAID);
      expect(free).toBe(QUARANTINE_MAX_SEC_FREE);
      expect(Number.isFinite(paid)).toBe(true);
      expect(paid).toBeGreaterThan(0);
    });
  }

  // CLAUDE.md: `Number('0x10')` is 16 and passes isFinite. Honouring it would
  // install a SIXTEEN-SECOND window and expire every quarantined sub on the next
  // sweep. The strict decimal gate must reject these outright.
  for (const [bad, wouldCoerceTo] of [['0x10', 16], ['0b11', 3], ['0o17', 15], ['1_000', NaN]] as const) {
    it(`non-decimal ${JSON.stringify(bad)} is REJECTED, not coerced to ${String(wouldCoerceTo)}`, () => {
      process.env[ENVKEY] = bad;
      expect(quarantineMaxSecFor('free')).toBe(QUARANTINE_MAX_SEC_FREE);
      expect(quarantineMaxSecFor('starter')).toBe(QUARANTINE_MAX_SEC_PAID);
    });
  }

  it('a padded decimal is still honoured (operators paste whitespace)', () => {
    process.env[ENVKEY] = '  86400 ';
    expect(quarantineMaxSecFor('starter')).toBe(86400);
  });
});

describe('quarantineExpiresAt', () => {
  it('paid: quarantined_at + 30d', () => {
    expect(quarantineExpiresAt(1_000_000, 'starter')).toBe(1_000_000 + QUARANTINE_MAX_SEC_PAID);
  });

  it('free: quarantined_at + 7d', () => {
    expect(quarantineExpiresAt(1_000_000, 'free')).toBe(1_000_000 + QUARANTINE_MAX_SEC_FREE);
  });

  it('two different tiers render two DIFFERENT deadlines from the same anchor', () => {
    const anchor = 1_000_000;
    expect(quarantineExpiresAt(anchor, 'starter')).not.toBe(quarantineExpiresAt(anchor, 'free'));
  });

  it('reproduces sub 6 — the live row this wave exists for', () => {
    // Live: quarantined_at = 2026-07-24T15:34:36Z, tier `starter`.
    const quarantinedAt = Math.floor(Date.parse('2026-07-24T15:34:36Z') / 1000);
    const under7d = quarantinedAt + QUARANTINE_MAX_SEC_FREE;
    const under30d = quarantineExpiresAt(quarantinedAt, 'starter');
    // The old uniform policy expired it on 2026-07-31 — which is what happened.
    expect(new Date(under7d * 1000).toISOString()).toBe('2026-07-31T15:34:36.000Z');
    // The new policy gives it 2026-08-23 instead. Derived, never a pasted literal.
    expect(new Date(under30d * 1000).toISOString()).toBe('2026-08-23T15:34:36.000Z');
    expect(under30d).toBeGreaterThan(under7d);
  });

  it('the override changes the deadline for a paid sub (rollback is observable)', () => {
    const anchor = 1_000_000;
    const before = quarantineExpiresAt(anchor, 'starter');
    process.env[ENVKEY] = String(QUARANTINE_MAX_SEC_FREE);
    expect(quarantineExpiresAt(anchor, 'starter')).toBe(anchor + QUARANTINE_MAX_SEC_FREE);
    expect(quarantineExpiresAt(anchor, 'starter')).not.toBe(before);
  });
});
