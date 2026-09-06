/**
 * FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1 R4 — the `checkout.session.expired` consumer.
 *
 * Two halves, tested two ways for a reason. The PARSING lives in `summarizeCheckoutExpired`
 * (stripe.ts) and is unit-tested directly. The HANDLER lives inside `startHttp()`'s webhook
 * switch and cannot be imported — so its two load-bearing ORDERING properties (claim before
 * side-effect; never read an email) are asserted against the source, which is weaker than
 * execution but strictly better than asserting nothing about the thing that actually runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeCheckoutExpired } from '../../src/lib/stripe.js';

const REPO = join(__dirname, '..', '..');

/** A minimal expired-session event, shaped like Stripe's real payload. */
function expiredEvent(session: Record<string, unknown>): unknown {
  return { id: 'evt_test_1', type: 'checkout.session.expired', data: { object: session } };
}

describe('summarizeCheckoutExpired — parsing', () => {
  it('reads the session id, tier and classification from metadata', () => {
    const s = summarizeCheckoutExpired(
      expiredEvent({
        id: 'cs_live_abc',
        metadata: { tier: 'pro', billing_interval: 'month', classification: 'browser', utm_source: 'landing' },
      }),
    );
    expect(s).not.toBeNull();
    expect(s!.sessionId).toBe('cs_live_abc');
    expect(s!.tier).toBe('pro');
    expect(s!.classification).toBe('browser');
    // The whole bag is carried into funnel_events.meta, so attribution survives to the row.
    expect(s!.metadata.utm_source).toBe('landing');
  });

  it('a PRE-WAVE session (no classification) reads `unknown`, never `bot`', () => {
    // Day one is a burst: every crawler-minted Session created before CH1 R3 expires within 24h
    // and carries no `classification`. Most of them WERE bots — writing that down anyway would be
    // a fabrication, and `unknown` is the honest label for "not measured".
    const s = summarizeCheckoutExpired(expiredEvent({ id: 'cs_live_old', metadata: { tier: 'starter' } }));
    expect(s!.classification).toBe('unknown');
  });

  it('an empty-string classification also reads `unknown`', () => {
    const s = summarizeCheckoutExpired(expiredEvent({ id: 'cs_1', metadata: { classification: '' } }));
    expect(s!.classification).toBe('unknown');
  });

  it('a session with no metadata at all is handled, not thrown on', () => {
    const s = summarizeCheckoutExpired(expiredEvent({ id: 'cs_2' }));
    expect(s!.classification).toBe('unknown');
    expect(s!.tier).toBeNull();
    expect(s!.metadata).toEqual({});
  });

  it('returns null when there is no session id — the caller must not write an unkeyable row', () => {
    expect(summarizeCheckoutExpired(expiredEvent({ metadata: { tier: 'pro' } }))).toBeNull();
    expect(summarizeCheckoutExpired({ data: { object: null } })).toBeNull();
    expect(summarizeCheckoutExpired(undefined)).toBeNull();
  });

  it('COPIES metadata rather than aliasing the Stripe payload', () => {
    // The handler spreads extra keys into `meta`; mutating Stripe's own object would be a
    // surprising side effect on a shared event body.
    const session = { id: 'cs_3', metadata: { tier: 'pro' } };
    const s = summarizeCheckoutExpired(expiredEvent(session))!;
    s.metadata.injected = true;
    expect((session.metadata as Record<string, unknown>).injected).toBeUndefined();
  });

  it('never surfaces an email, even when Stripe sends one', () => {
    // The Stripe account is Malaysian, so `consent_collection.promotions` (US-only) is
    // unavailable: there is no consent path for an abandoned-cart email. An address we can never
    // contact must not be stored, so the reducer has no field for it at all.
    const s = summarizeCheckoutExpired(
      expiredEvent({
        id: 'cs_4',
        customer_email: 'someone@example.com',
        customer_details: { email: 'someone@example.com', name: 'Someone' },
        metadata: {},
      }),
    )!;
    expect(JSON.stringify(s)).not.toContain('example.com');
    expect(Object.keys(s).sort()).toEqual(['classification', 'metadata', 'sessionId', 'tier']);
  });
});

describe('the webhook case — ordering properties the source must keep', () => {
  const src = readFileSync(join(REPO, 'src', 'index.ts'), 'utf8');
  const caseStart = src.indexOf("case 'checkout.session.expired': {");
  const caseBody = src.slice(caseStart, src.indexOf("case 'invoice.paid': {", caseStart));

  /**
   * CODE only — comments stripped.
   *
   * A ban-grep over raw source false-positives on the explanatory prose that EXPLAINS the ban,
   * and that prose is the most valuable text in the block: this file's own comments say
   * "never reads `customer_details.email`" and "Don't rethrow", so the naive assertions demanded
   * their deletion. `scripts/check-canaries-wired.mjs` strips comments for exactly this reason
   * ("a mention in a comment is not an invocation"); do the same before asserting an absence.
   * Both of these DID fire here before the strip — it is not a hypothetical.
   */
  const caseCode = caseBody
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

  it('the case exists in the switch (not a second endpoint or a second signing secret)', () => {
    expect(caseStart).toBeGreaterThan(0);
    // It must ride the EXISTING destination + STRIPE_WEBHOOK_SECRET. A second Stripe destination
    // would carry its own secret and could never verify here — that exact misconfiguration
    // existed and was deleted before this wave.
    expect(src.match(/app\.post\('\/webhooks\/stripe'/g)?.length).toBe(1);
  });

  it('claims the event id BEFORE the side effect (Stripe delivers at-least-once)', () => {
    const claim = caseBody.indexOf('tryClaimEvent');
    const write = caseBody.indexOf('recordFunnelEvent');
    expect(claim).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(0);
    // A redelivery after the write but before the claim would double-count one abandonment into
    // a published stage.
    expect(claim).toBeLessThan(write);
  });

  it('answers a duplicate with 200, never a non-2xx', () => {
    // A non-2xx makes Stripe retry harder against an event already fully processed.
    expect(caseBody).toContain("return res.json({ received: true, status: 'duplicate' });");
  });

  it('writes the `checkout_abandoned` stage', () => {
    expect(caseBody).toContain("eventType: 'checkout_abandoned'");
  });

  it('never reads customer_details.email or customer_email in this case', () => {
    expect(caseCode).not.toContain('customer_details');
    // `customer_email: null` on the idempotency claim is the claim table's own column being
    // written empty, not a read of the session. That is the ONLY permitted mention — asserted as
    // an exact-form allow-list rather than a `(?!null)` lookahead, which is quietly wrong: with
    // `\s*` the engine matches zero whitespace and then reads " null" as non-null, so the
    // negative pattern fires on the very line it is meant to permit.
    const mentions = caseCode.match(/customer_email:[^,\n]*/g) ?? [];
    expect(mentions).toEqual(['customer_email: null']);
  });

  it('does not rethrow on a write failure (the event id is already claimed)', () => {
    // A rethrow here would make Stripe retry an event we have already claimed and will never
    // re-record, so the retry can only ever fail again.
    expect(caseCode).toMatch(/catch \(expErr\)/);
    expect(caseCode).not.toMatch(/\bthrow\b/);
  });
});
