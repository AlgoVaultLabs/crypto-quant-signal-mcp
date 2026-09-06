/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 R3 — the Stripe-side attribution copy.
 *
 * Tests the PURE builder rather than `createCheckoutSession`, which needs a live Stripe client
 * and would mint real objects. `buildCheckoutMetadata` is exported for exactly this reason
 * (CLAUDE.md's test-importable rule); the caller wiring is asserted by the "one metadata object,
 * two places" test at the bottom, which reads the source rather than guessing.
 *
 * The ABSENT keys matter as much as the present ones: four fields were specified for this wave
 * and then measured to be duplicates or to have no producer at all, and a test that only checks
 * what IS there would let a future wave "restore" them without noticing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCheckoutMetadata } from '../../src/lib/stripe.js';

const REPO = join(__dirname, '..', '..');

describe('buildCheckoutMetadata — the key set', () => {
  it('always carries tier + billing_interval, even with no options at all', () => {
    // These two are the incumbents `handleCheckoutCompleted` reads, so they can never be
    // conditional — and their presence is what makes `subscription_data.metadata`
    // unconditional too.
    expect(buildCheckoutMetadata('starter', 'month')).toEqual({
      tier: 'starter',
      billing_interval: 'month',
    });
  });

  it('carries the full widened set when every input is present', () => {
    const m = buildCheckoutMetadata('pro', '6month', {
      utmSource: 'landing',
      utmMedium: 'pricing-pro',
      utmCampaign: 'launch',
      refCode: 'ABC123',
      upgradeFrom: 'landing_hero',
      classification: 'browser',
      landingPath: 'https://algovault.com/',
    });
    expect(m).toEqual({
      tier: 'pro',
      billing_interval: '6month',
      utm_source: 'landing',
      utm_medium: 'pricing-pro',
      utm_campaign: 'launch',
      ref_code: 'ABC123',
      upgrade_from: 'landing_hero',
      classification: 'browser',
      landing_path: 'https://algovault.com/',
    });
  });

  it('OMITS an absent key rather than writing an empty string', () => {
    // Stripe metadata is a 50-key / 500-char budget, and downstream an empty string is
    // indistinguishable from a real empty answer. Absence must stay absence.
    const m = buildCheckoutMetadata('starter', 'month', { utmSource: 'landing' });
    expect(Object.keys(m).sort()).toEqual(['billing_interval', 'tier', 'utm_source']);
    expect('utm_medium' in m).toBe(false);
    expect('classification' in m).toBe(false);
  });

  it('treats an empty-string input as absent', () => {
    const m = buildCheckoutMetadata('starter', 'month', { utmSource: '', upgradeFrom: '' });
    expect('utm_source' in m).toBe(false);
    expect('upgrade_from' in m).toBe(false);
  });

  it('truncates hostile values so a long query string cannot bloat a Session', () => {
    const m = buildCheckoutMetadata('starter', 'month', {
      utmSource: 'x'.repeat(500),
      refCode: 'y'.repeat(100),
      landingPath: 'z'.repeat(900),
    });
    expect(m.utm_source).toHaveLength(64);
    expect(m.ref_code).toHaveLength(16);
    expect(m.landing_path).toHaveLength(200);
    // Stripe's own hard limit is 500 chars per value — nothing may exceed it.
    for (const v of Object.values(m)) expect(v.length).toBeLessThanOrEqual(500);
  });

  it('stays inside Stripe’s 50-key metadata budget', () => {
    const m = buildCheckoutMetadata('pro', '6month', {
      utmSource: 'a', utmMedium: 'b', utmCampaign: 'c', refCode: 'd',
      upgradeFrom: 'e', classification: 'f', landingPath: 'g',
    });
    expect(Object.keys(m).length).toBeLessThanOrEqual(50);
  });
});

describe('buildCheckoutMetadata — the keys that must STAY absent (architect ruling Q5)', () => {
  // Each of these was in the dispatched spec and was measured to be a duplicate, or to have no
  // producer on `/signup` at all. Re-adding one is a regression, not a feature, so the test names
  // carry the reason.
  const forbidden: Array<[string, string]> = [
    ['plan', 'duplicates the incumbent `tier`'],
    ['interval', 'duplicates the incumbent `billing_interval`'],
    ['first_touch_source', 'exists only on agent_sessions — no producer on /signup'],
    ['attribution_id', 'client_reference_id already is the attribution id'],
    ['src', '?src= is the MCP-connection carrier; the signup carrier is utm_*'],
    ['customer_email', 'GET /signup has no authenticated account session — unreachable'],
  ];

  const everything = buildCheckoutMetadata('pro', '6month', {
    utmSource: 'a', utmMedium: 'b', utmCampaign: 'c', refCode: 'd',
    upgradeFrom: 'e', classification: 'f', landingPath: 'g',
  });

  for (const [key, why] of forbidden) {
    it(`never emits \`${key}\` — ${why}`, () => {
      expect(key in everything).toBe(false);
    });
  }
});

describe('createCheckoutSession — the wiring the pure builder cannot prove', () => {
  const src = readFileSync(join(REPO, 'src', 'lib', 'stripe.ts'), 'utf8');

  it('sends ONE metadata object to BOTH the Session and the Subscription', () => {
    // A unit test on the builder cannot show that its output reaches both places, and the whole
    // point of R3 is that a subscription carries its own provenance for life. Two separately
    // constructed objects would drift; assert the single-derivation shape in source.
    expect(src).toContain('const metadata = buildCheckoutMetadata(plan, interval, opts);');
    expect(src).toContain('subscription_data: { metadata },');
  });

  it('enables promotion codes on the Session', () => {
    expect(src).toContain('allow_promotion_codes: true,');
  });

  it('does not reintroduce a conditional subscription_data with only ref_code', () => {
    // The pre-wave shape. `metadata` always has at least two keys now, so there is no case in
    // which omitting `subscription_data` is correct.
    expect(src).not.toContain('subscription_data: { metadata: { ref_code');
  });

  it('leaves client_reference_id semantics untouched', () => {
    expect(src).toContain("client_reference_id: opts.clientReferenceId.replace(/[^a-zA-Z0-9_:\\-.]/g, '_').slice(0, 128)");
  });
});
