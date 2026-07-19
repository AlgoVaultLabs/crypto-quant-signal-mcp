/**
 * OPS-DIGEST-PAID-RAIL-SPLIT-W1 (2026-07-19): the digest's 💳 Paid bucket was labelled
 * "Paid (x402 / a2mcp)" but is computed purely as `license_tier NOT IN ('free','internal')`
 * — a TIER test, not a payment-RAIL test. On 2026-07-19 it read 162 while the x402 rail had
 * settled ZERO payments since 2026-06-30 (and those 7 were the operator's own self-settle
 * harness): 100% of it was a Stripe `starter` subscription. The label named two rails that
 * contributed nothing, so the operator could not tell subscription revenue from x402.
 *
 * These are pure-fn tests (no DB) — the DB-level split math lives in
 * tests/analytics-external-only.test.ts, the repo's SINGLE external-row-writing file, so it
 * never races the shared SQLite DB.
 */
import { describe, expect, it } from 'vitest';
import { formatAgentActivity } from '../src/lib/agent-activity-format.js';
import { PAYMENT_RAIL_BY_TIER, SUBSCRIPTION_TIERS, X402_TIERS, paymentRailForTier } from '../src/lib/payment-rail.js';

describe('payment-rail — single canonical tier→rail derivation', () => {
  it('maps every subscription tier to the subscription rail', () => {
    expect(paymentRailForTier('starter')).toBe('subscription');
    expect(paymentRailForTier('pro')).toBe('subscription');
    expect(paymentRailForTier('enterprise')).toBe('subscription');
  });

  it('maps the x402 tier to the x402 rail (Base x402 + OKX a2mcp both resolve tier=x402)', () => {
    expect(paymentRailForTier('x402')).toBe('x402');
  });

  it('maps non-paying tiers to no rail', () => {
    expect(paymentRailForTier('free')).toBe('none');
    expect(paymentRailForTier('internal')).toBe('none');
  });

  it('classifies EVERY LicenseTier — a new tier must be classified, never silently dropped', () => {
    // Compile-time: Record<LicenseTier, PaymentRail> forces classification of a new tier.
    // Runtime canary: pins the known tier set so widening the union surfaces here too.
    expect(Object.keys(PAYMENT_RAIL_BY_TIER).sort()).toEqual(
      ['enterprise', 'free', 'internal', 'pro', 'starter', 'x402'],
    );
  });

  it('derives the tier arrays FROM the map (one source of truth, no parallel hardcoded list)', () => {
    expect([...SUBSCRIPTION_TIERS].sort()).toEqual(['enterprise', 'pro', 'starter']);
    expect([...X402_TIERS]).toEqual(['x402']);
  });
});

describe('formatAgentActivity — 💳 Paid line splits by payment rail', () => {
  const base = {
    externalGenuine: { total: 502, free: 340, paid: 162, freeSessions: 43, paidSessions: 47 },
    externalAutomated: { total: 395, sessions: 41 },
    rawConcentration: { top1_pct: 18.7 },
    topAssetsGenuine: [{ asset: 'ETH' }, { asset: 'BTC' }],
  };

  it('renders the per-rail breakdown on the calls line', () => {
    const out = formatAgentActivity({
      ...base,
      externalGenuine: { ...base.externalGenuine, paidSubscription: 162, paidX402: 0 },
    });
    expect(out).toContain('• 💳 Paid: 162   (subscription 162 · x402/a2mcp 0)');
  });

  it('renders the per-rail breakdown on the sessions line', () => {
    const out = formatAgentActivity({
      ...base,
      externalGenuine: {
        ...base.externalGenuine,
        paidSubscription: 162,
        paidX402: 0,
        paidSubscriptionSessions: 47,
        paidX402Sessions: 0,
      },
    });
    expect(out).toContain('• 💳 Paid: 47   (subscription 47 · x402/a2mcp 0)');
  });

  it('no longer claims x402/a2mcp as the bucket label', () => {
    const out = formatAgentActivity({
      ...base,
      externalGenuine: { ...base.externalGenuine, paidSubscription: 162, paidX402: 0 },
    });
    expect(out).not.toContain('Paid (x402 / a2mcp)');
    expect(out).not.toContain('Paid (x402/a2mcp)');
  });

  it('surfaces an unclassified remainder as "other" rather than silently dropping it', () => {
    const out = formatAgentActivity({
      ...base,
      externalGenuine: { ...base.externalGenuine, paid: 10, paidSubscription: 6, paidX402: 2 },
    });
    expect(out).toContain('• 💳 Paid: 10   (subscription 6 · x402/a2mcp 2 · other 2)');
  });

  it('omits the "other" segment when the rails reconcile exactly', () => {
    const out = formatAgentActivity({
      ...base,
      externalGenuine: { ...base.externalGenuine, paid: 8, paidSubscription: 6, paidX402: 2 },
    });
    expect(out).toContain('• 💳 Paid: 8   (subscription 6 · x402/a2mcp 2)');
    expect(out).not.toContain('other');
  });

  it('graceful-degrades to the bare total during the rollout window (split fields absent)', () => {
    // A digest fired before the /analytics deploy lands has no paidSubscription/paidX402.
    const out = formatAgentActivity(base);
    expect(out).toContain('• 💳 Paid: 162');
    expect(out).not.toContain('(subscription');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('NaN');
  });

  it('graceful-degrades to em-dash when the whole payload is legacy', () => {
    const out = formatAgentActivity({ totalCallsInternal: { last24h: 5 } });
    expect(out).toContain('• 💳 Paid: —');
    expect(out).not.toContain('(subscription');
  });

  it('renders 0 (not em-dash) for a zero paid bucket with a live split', () => {
    const out = formatAgentActivity({
      externalGenuine: { total: 0, free: 0, paid: 0, freeSessions: 0, paidSessions: 0, paidSubscription: 0, paidX402: 0 },
      externalAutomated: { total: 0, sessions: 0 },
      rawConcentration: { top1_pct: 0 },
      topAssetsGenuine: [],
    });
    expect(out).toContain('• 💳 Paid: 0   (subscription 0 · x402/a2mcp 0)');
  });

  it('stays inside the Telegram 4096-char message budget', () => {
    const out = formatAgentActivity({
      ...base,
      externalGenuine: { ...base.externalGenuine, paidSubscription: 162, paidX402: 0 },
    });
    expect(out.length).toBeLessThanOrEqual(4096);
  });
});
