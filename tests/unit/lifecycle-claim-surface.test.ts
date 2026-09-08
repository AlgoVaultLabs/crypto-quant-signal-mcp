/**
 * IDENTITY-LIFECYCLE-W3 CH3 — the claim envelope, the /welcome line, and the /account preference.
 *
 * The envelope assertions are the load-bearing ones. Ruling Q3(A) moved `claim_url` from
 * `_algovault.quota` to the generic `_algovault.auth` stamper precisely because the quota helper
 * reaches only 4 of 7 tools — so "does every tool carry it?" is the question this file exists to
 * answer, and CH3's live gate was widened to all 7 for the same reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'a'.repeat(48);

function freshEnv(): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
}

describe('C2 — the claim strings ride the 7/7 auth stamper', () => {
  beforeEach(freshEnv);

  it('an ABSENT (anonymous) session gets claim_url + claim_hint', async () => {
    const { withAuthState } = await import('../../src/lib/tier-warning.js');
    const { CLAIM_URL, CLAIM_HINT } = await import('../../src/lib/lifecycle-copy.js');
    const meta = withAuthState({ tool: 'get_trade_call' }, { key: null, tier: 'free', outcome: 'ABSENT' }) as Record<string, unknown>;
    expect(meta.claim_url).toBe(CLAIM_URL);
    expect(meta.claim_hint).toBe(CLAIM_HINT);
  });

  it('a RESOLVED session is byte-identical to pre-wave — no claim keys at all', async () => {
    const { withAuthState } = await import('../../src/lib/tier-warning.js');
    const meta = withAuthState({ tool: 'get_trade_call' }, { key: 'av_live_x', tier: 'starter', outcome: 'RESOLVED' }) as Record<string, unknown>;
    expect('claim_url' in meta).toBe(false);
    expect('claim_hint' in meta).toBe(false);
    expect(Object.keys(meta).sort()).toEqual(['auth', 'tool']);
  });

  it('a PRESENTED-BUT-FAILED credential gets NO claim — the enum has five values, not two', async () => {
    const { withAuthState } = await import('../../src/lib/tier-warning.js');
    // MALFORMED / UNKNOWN / INDETERMINATE all mean a key WAS presented and could not be
    // resolved. That is a caller with a broken key, and "sign in to keep this key" would be
    // advice to preserve the thing that is failing.
    for (const outcome of ['MALFORMED', 'UNKNOWN', 'INDETERMINATE'] as const) {
      const meta = withAuthState({ t: 1 }, { key: 'av_free_bad', tier: 'free', outcome }) as Record<string, unknown>;
      expect('claim_url' in meta, outcome).toBe(false);
    }
  });

  it('the claim URL carries its own campaign tag and no PII', async () => {
    const { CLAIM_URL } = await import('../../src/lib/lifecycle-copy.js');
    expect(CLAIM_URL).toContain('utm_source=mcp');
    expect(CLAIM_URL).toContain('utm_medium=envelope');
    expect(CLAIM_URL).toContain('utm_campaign=claim');
    expect(CLAIM_URL).not.toContain('@');
  });

  it('the stamper is GENERIC, so a hand-built envelope shape keeps the claim too', async () => {
    const { withAuthState } = await import('../../src/lib/tier-warning.js');
    // `scan_trade_calls`, `chat_knowledge` and `search_knowledge` build `_algovault` by hand with
    // a different shape. This is the property that makes 7/7 coverage possible at all — and the
    // exact property `withQuotaState` does NOT have, which is why C2 moved.
    const knowledgeShape = { bundle_version: '1', bundle_generated_at: 'x' };
    const meta = withAuthState(knowledgeShape, { key: null, tier: 'free', outcome: 'ABSENT' }) as Record<string, unknown>;
    expect(meta.claim_url).toBeTruthy();
    expect(meta.bundle_version).toBe('1');
  });
});

describe('C1 — the /welcome benefit line', () => {
  beforeEach(freshEnv);

  it('renders on an organic visit and NOT after sign-up', async () => {
    const { getWelcomePageHtml } = await import('../../src/lib/welcome-page.js');
    const { WELCOME_BENEFIT_LINE } = await import('../../src/lib/lifecycle-copy.js');
    const organic = getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: {} });
    const afterSignup = getWelcomePageHtml('av_free_abc123def456', 'free', 'x@y.com', { newSignupEnabled: true, oauthProviders: {} });
    expect(organic).toContain(WELCOME_BENEFIT_LINE);
    // Somebody who just signed in does not need to be told to sign in.
    expect(afterSignup).not.toContain(WELCOME_BENEFIT_LINE);
  });

  it('the /welcome snippet keeps chan-welcome — channels must not merge', async () => {
    const { getWelcomePageHtml } = await import('../../src/lib/welcome-page.js');
    const html = getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: {} });
    // One SHAPE, per-channel token. Collapsing these two onto one value would merge two
    // acquisition channels into one bucket and make both unmeasurable.
    expect(html).toContain('chan-welcome');
    expect(html).not.toContain('chan-email');
  });

  it('the snippet builder is the ONE shape both channels render', async () => {
    const { mcpConfigSnippet, EMAIL_TRACK_TOKEN, WELCOME_TRACK_TOKEN } = await import('../../src/lib/lifecycle-copy.js');
    const a = mcpConfigSnippet('av_free_k', EMAIL_TRACK_TOKEN);
    const b = mcpConfigSnippet('av_free_k', WELCOME_TRACK_TOKEN);
    expect(a.replace(EMAIL_TRACK_TOKEN, 'X')).toBe(b.replace(WELCOME_TRACK_TOKEN, 'X'));
    expect(EMAIL_TRACK_TOKEN).not.toBe(WELCOME_TRACK_TOKEN);
  });
});

describe('C3 — the /account preference toggle', () => {
  beforeEach(freshEnv);

  async function seedKey(email: string) {
    const { dbRun, dbExec } = await import('../../src/lib/performance-db.js');
    dbExec(`CREATE TABLE IF NOT EXISTS free_keys (api_key TEXT PRIMARY KEY, email TEXT, ref_code TEXT, created_at TEXT, last_used_at TEXT, bucket_key TEXT)`);
    dbRun('INSERT INTO free_keys (api_key, email) VALUES (?, ?)', 'av_free_toggle123456', email);
  }

  it('OFF suppresses the usage steps; ON restores them', async () => {
    const au = await import('../../src/lib/lifecycle/account-usage.js');
    const { isSuppressed } = await import('../../src/lib/lifecycle/suppression.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    await seedKey('toggle@example.com');
    const h = hashEmail('toggle@example.com');

    await au.setUsagePreference('av_free_toggle123456', false);
    expect(await isSuppressed(h, 'quota_80')).toBe(true);
    expect(await au.usagePreferenceEnabled('toggle@example.com')).toBe(false);

    await au.setUsagePreference('av_free_toggle123456', true);
    expect(await isSuppressed(h, 'quota_80')).toBe(false);
    expect(await au.usagePreferenceEnabled('toggle@example.com')).toBe(true);
  });

  it('the digest is NOT governed by this toggle — different consent, different scope', async () => {
    const au = await import('../../src/lib/lifecycle/account-usage.js');
    const { isSuppressed } = await import('../../src/lib/lifecycle/suppression.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    await seedKey('scoped@example.com');
    await au.setUsagePreference('av_free_toggle123456', false);
    // They opted IN to product updates explicitly; a usage-cap toggle must not revoke that.
    expect(await isSuppressed(hashEmail('scoped@example.com'), 'product_updates')).toBe(false);
  });

  it('turning the toggle ON can NEVER clear a complaint', async () => {
    const au = await import('../../src/lib/lifecycle/account-usage.js');
    const { addSuppression, listSuppressions } = await import('../../src/lib/lifecycle/suppression.js');
    const { hashEmail } = await import('../../src/lib/lifecycle/identity.js');
    await seedKey('angry@example.com');
    const h = hashEmail('angry@example.com');
    await addSuppression({ emailHash: h, reason: 'complaint', scope: 'all' });
    await au.setUsagePreference('av_free_toggle123456', true);
    // A UI click must not be able to clear a deliverability signal we are obliged to honour.
    expect((await listSuppressions(h)).map((r) => r.reason)).toContain('complaint');
    expect(await au.usagePreferenceEnabled('angry@example.com')).toBe(true); // the TOGGLE is on…
    const { isSuppressed } = await import('../../src/lib/lifecycle/suppression.js');
    expect(await isSuppressed(h, 'quota_80')).toBe(true); // …and they are STILL not mailed.
  });

  it('renders the usage page for an unknown key WITHOUT leaking that it is unknown', async () => {
    const { renderUsagePage } = await import('../../src/lib/lifecycle/account-usage.js');
    const { ACCOUNT_USAGE_HEADING, ACCOUNT_PREFERENCE_LABEL } = await import('../../src/lib/lifecycle-copy.js');
    const html = await renderUsagePage('av_free_doesnotexist99');
    expect(html).toContain(ACCOUNT_USAGE_HEADING);
    expect(html).toContain(ACCOUNT_PREFERENCE_LABEL);
    // Same shaped page as a real key with no usage — the response cannot be used as an oracle.
    expect(html).toContain('no calls yet');
  });

  it('never renders the raw key — only the mask', async () => {
    const { renderUsagePage } = await import('../../src/lib/lifecycle/account-usage.js');
    const html = await renderUsagePage('av_free_supersecretvalue');
    expect(html).not.toContain('av_free_supersecretvalue');
    expect(html).toContain('av_free_…alue');
  });
});
