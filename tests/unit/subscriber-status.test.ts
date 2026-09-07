import { describe, it, expect } from 'vitest';
import {
  STRIPE_SUBSCRIPTION_STATUSES, STORED_STATUS_CLASS, STORED_STATUS_RANK, classifyStoredStatus,
  countsInActiveCensus, decideStatusWrite, CHECKOUT_IMPLIED_STATUS,
} from '../../src/lib/subscriber-status.js';
import { SUBSCRIPTION_STATUS_CLASS } from '../../src/lib/stripe.js';

describe('subscriber-status — the owner of the stored column', () => {
  it('partitions Stripe’s documented enum exactly, with nothing spare', () => {
    expect([...STRIPE_SUBSCRIPTION_STATUSES].sort()).toEqual([
      'active', 'canceled', 'incomplete', 'incomplete_expired', 'past_due', 'paused', 'trialing', 'unpaid',
    ]);
    expect(Object.keys(STORED_STATUS_CLASS).sort()).toEqual([...STRIPE_SUBSCRIPTION_STATUSES].sort());
    expect(Object.values(STORED_STATUS_CLASS).every(
      (c) => ['HEALTHY', 'MONEY_STUCK', 'NOT_STARTED', 'ENDED'].includes(c))).toBe(true);
  });

  it('🛑 DIFFERS from SUBSCRIPTION_STATUS_CLASS on `unpaid`, and that divergence is the point', () => {
    // The entitlement map answers "may this caller use the API"; this one answers "is money
    // stuck". Stripe has stopped retrying an `unpaid` subscription while the debt stands, which
    // is maximally stuck rather than resolved. A future de-duplication must fail this test.
    expect(SUBSCRIPTION_STATUS_CLASS.unpaid).toBe('NOT_ENTITLED');
    expect(STORED_STATUS_CLASS.unpaid).toBe('MONEY_STUCK');
    const dunningOnly = Object.entries(SUBSCRIPTION_STATUS_CLASS)
      .filter(([, v]) => v === 'DUNNING').map(([k]) => k).sort();
    const stuck = Object.entries(STORED_STATUS_CLASS)
      .filter(([, v]) => v === 'MONEY_STUCK').map(([k]) => k).sort();
    expect(stuck).not.toEqual(dunningOnly);
  });

  it('is TOTAL — every input classifies, including the ones that are not statuses', () => {
    expect(classifyStoredStatus('active')).toBe('HEALTHY');
    expect(classifyStoredStatus('past_due')).toBe('MONEY_STUCK');
    expect(classifyStoredStatus('unpaid')).toBe('MONEY_STUCK');
    expect(classifyStoredStatus('incomplete')).toBe('NOT_STARTED');
    expect(classifyStoredStatus('canceled')).toBe('ENDED');
    expect(classifyStoredStatus('  Past_Due  ')).toBe('MONEY_STUCK'); // trimmed + case-folded
    expect(classifyStoredStatus('some_future_stripe_state')).toBe('UNKNOWN');
    expect(classifyStoredStatus(null)).toBe('ABSENT');
    expect(classifyStoredStatus(undefined)).toBe('ABSENT');
    expect(classifyStoredStatus('')).toBe('ABSENT');
    expect(classifyStoredStatus('   ')).toBe('ABSENT');
  });

  it('separates ABSENT from UNKNOWN — they call for different operator action', () => {
    expect(classifyStoredStatus(null)).not.toBe(classifyStoredStatus('zzz'));
  });

  it('ranks an UNREADABLE status ABOVE stuck money, so it can never resolve toward silence', () => {
    expect(STORED_STATUS_RANK.UNKNOWN).toBeGreaterThan(STORED_STATUS_RANK.MONEY_STUCK);
    expect(STORED_STATUS_RANK.MONEY_STUCK).toBeGreaterThan(STORED_STATUS_RANK.HEALTHY);
    expect(STORED_STATUS_RANK.ABSENT).toBe(0);
  });

  it('countsInActiveCensus is EXACTLY `active`, never the HEALTHY bucket', () => {
    // Widening this to `trialing` would compare the profile count against a Stripe census that
    // cannot see trialing rows, moving a published number. The narrowness is the contract.
    expect(countsInActiveCensus('active')).toBe(true);
    expect(countsInActiveCensus('trialing')).toBe(false);
    expect(classifyStoredStatus('trialing')).toBe('HEALTHY');
    expect(countsInActiveCensus(null)).toBe(false);
    expect(countsInActiveCensus('ACTIVE')).toBe(true);
  });

  it('MONEY_STUCK is exactly the two states where an established subscription is not paying', () => {
    const stuck = Object.entries(STORED_STATUS_CLASS)
      .filter(([, c]) => c === 'MONEY_STUCK').map(([k]) => k).sort();
    expect(stuck).toEqual(['past_due', 'unpaid']);
  });
});

describe('decideStatusWrite — the ONE precedence rule', () => {
  const base = {
    storedStatus: 'active', storedSubscriptionId: 'sub_A', storedStatusAt: 1_000,
    incomingStatus: 'past_due', incomingSubscriptionId: 'sub_A', incomingAt: 2_000,
  };

  it('accepts a newer status for the SAME subscription', () => {
    expect(decideStatusWrite(base)).toEqual({ decision: 'accept', status: 'past_due' });
  });

  it('🛑 refuses an OLDER event for the same subscription — the out-of-order defect', () => {
    const r = decideStatusWrite({ ...base, incomingAt: 500 });
    expect(r.decision).toBe('reject-stale');
    expect(r.status).toBe('active');
  });

  it('🛑 refuses an INFERRED status that would downgrade measured stuck money', () => {
    // This is the live-reachable defect: a past_due customer completing any checkout was
    // rewritten to `active` by a literal invented from the event type, and the floor lost them.
    const r = decideStatusWrite({
      storedStatus: 'past_due', storedSubscriptionId: 'sub_A', storedStatusAt: 1_000,
      incomingStatus: 'active', incomingSubscriptionId: 'sub_A', incomingAt: 9_000, inferred: true,
    });
    expect(r.decision).toBe('reject-downgrade');
    expect(r.status).toBe('past_due');
  });

  it('…but a MEASURED recovery to active is accepted — the guard is not a one-way latch', () => {
    const r = decideStatusWrite({
      storedStatus: 'past_due', storedSubscriptionId: 'sub_A', storedStatusAt: 1_000,
      incomingStatus: 'active', incomingSubscriptionId: 'sub_A', incomingAt: 9_000, inferred: false,
    });
    expect(r).toEqual({ decision: 'accept', status: 'active' });
  });

  it('adopts a DIFFERENT subscription only when it is WORSE (worst-wins)', () => {
    const worse = decideStatusWrite({ ...base, storedStatus: 'active', incomingSubscriptionId: 'sub_B', incomingStatus: 'past_due' });
    expect(worse).toEqual({ decision: 'accept', status: 'past_due' });
    const better = decideStatusWrite({ ...base, storedStatus: 'past_due', incomingSubscriptionId: 'sub_B', incomingStatus: 'active' });
    expect(better.decision).toBe('reject-foreign-weaker');
    expect(better.status).toBe('past_due');
  });

  it('never lets an ABSENT incoming status erase a stored one', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(decideStatusWrite({ ...base, incomingStatus: v }).status).toBe('active');
    }
  });

  it('adopts any real observation over ABSENT', () => {
    const r = decideStatusWrite({ ...base, storedStatus: null, storedStatusAt: null, incomingStatus: 'canceled' });
    expect(r).toEqual({ decision: 'accept', status: 'canceled' });
  });

  it('🛑 IS ORDER-INDEPENDENT — the property CLAUDE.md forbids renting from Stripe delivery', () => {
    // Two events about two different subscriptions of one customer, delivered in both orders.
    // The converged row must be a function of OUR rule, not of which arrived first.
    const evA = { status: 'active', sub: 'sub_A', at: 1_000 };
    const evB = { status: 'past_due', sub: 'sub_B', at: 2_000 };
    const fold = (evs: typeof evA[]) => evs.reduce<{ status: string | null; sub: string | null; at: number | null }>(
      (acc, e) => {
        const d = decideStatusWrite({
          storedStatus: acc.status, storedSubscriptionId: acc.sub, storedStatusAt: acc.at,
          incomingStatus: e.status, incomingSubscriptionId: e.sub, incomingAt: e.at,
        });
        return d.decision === 'accept' ? { status: d.status, sub: e.sub, at: e.at } : acc;
      },
      { status: null, sub: null, at: null },
    );
    expect(fold([evA, evB]).status).toBe(fold([evB, evA]).status);
    expect(fold([evA, evB]).status).toBe('past_due'); // worst-wins, either way round

    // …and the same for two events on ONE subscription arriving out of order.
    const e1 = { status: 'past_due', sub: 'sub_A', at: 1_000 };
    const e2 = { status: 'active', sub: 'sub_A', at: 2_000 };
    expect(fold([e1, e2]).status).toBe(fold([e2, e1]).status);
    expect(fold([e1, e2]).status).toBe('active'); // newest-wins within one subscription
  });

  it('the checkout-implied status is a NAMED inference, not an inline literal', () => {
    expect(CHECKOUT_IMPLIED_STATUS).toBe('active');
    expect(classifyStoredStatus(CHECKOUT_IMPLIED_STATUS)).toBe('HEALTHY');
  });
});
