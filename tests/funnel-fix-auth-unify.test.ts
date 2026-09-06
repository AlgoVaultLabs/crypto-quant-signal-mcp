/**
 * FUNNEL-FIX-AUTH-UNIFY-W1 — the ONE shared sign-in component + its 3 integrations.
 *
 * Proves: AC1 (unified card renders on /welcome · /account · /referral, each own
 * post-auth context via its page), AC3 (paste-key + recover-key secondary present),
 * AC4 (?src threaded through the sign-in + OAuth href; referral reachable via a
 * non-email identity), the outer-flag byte-parity (legacy layout intact when off),
 * and Q5 (a returning email returns its EXISTING key — no duplicate).
 *
 * SNAPSHOT MAINTENANCE — FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 (CH2, 2026-09-07): regenerated for
 * the analytics region. All three pages this file snapshots — `/welcome`, `/account`, `/referral`
 * — carried NO Plausible tag at all, so the entire account and referral path was invisible;
 * `/welcome` is where the goal `Form: Submission` fires, and it read 0 across 28 days. The diff
 * was verified BEFORE regenerating and is EXACTLY the eight-line `<!-- ANALYTICS:START -->`
 * region in `<head>`: measured 0 lines removed and 0 added lines that are not part of that
 * region, across every snapshot in this file. Nothing in any body moved, which is the property
 * this guard actually protects — the OFF path's LAYOUT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderSigninComponent } from '../src/lib/signin-component.js';
import { isUnifiedSigninEnabled, isNewSignupEnabled } from '../src/lib/auth-providers.js';
import { getWelcomePageHtml } from '../src/lib/welcome-page.js';
import { getAccountPageHtml } from '../src/lib/account-handlers.js';
import { renderReferralLandingPage } from '../src/lib/referral-pages.js';

const OAUTH_BOTH = { google: true, github: true };

describe('renderSigninComponent — the shared card', () => {
  it('renders all primary methods + secondary when newSignup on + both providers live', () => {
    const html = renderSigninComponent({ page: 'welcome', oauthProviders: OAUTH_BOTH, newSignupEnabled: true });
    expect(html).toContain('avsi-card');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('Continue with email');
    expect(html).toContain('Get started free — no card, no email');   // instant path, labeled distinct (Q2 rider)
    expect(html).toContain('Already have an API key?');                 // secondary — paste key
    expect(html).toContain('Recover a lost key');                       // secondary — recover
    expect(html).toContain('/api/signup-email');                        // email → existing endpoint
    expect(html).toContain('/api/start-free');                          // start-free → existing endpoint
  });

  it('OAuth + start-free are gated by newSignupEnabled (inner firewall)', () => {
    const off = renderSigninComponent({ page: 'welcome', oauthProviders: OAUTH_BOTH, newSignupEnabled: false });
    expect(off).not.toContain('/auth/google');
    expect(off).not.toContain('/auth/github');
    expect(off).not.toContain('avsi-btn avsi-startfree');   // the start-free BUTTON element is gated (its inert JS handler may name it)
    // email + paste-key still available when the inner flag is off
    expect(off).toContain('Continue with email');
    expect(off).toContain('Already have an API key?');
  });

  it('each OAuth button renders ONLY when its provider is live', () => {
    const ggOnly = renderSigninComponent({ page: 'welcome', oauthProviders: { google: true, github: false }, newSignupEnabled: true });
    expect(ggOnly).toContain('Continue with Google');
    expect(ggOnly).not.toContain('Continue with GitHub');
  });

  it('threads ?src + per-page next into the OAuth href (AC4 attribution + routing)', () => {
    const html = renderSigninComponent({ page: 'referral', oauthProviders: OAUTH_BOTH, newSignupEnabled: true, src: 'reddit' });
    expect(html).toContain('/auth/google?next=%2Freferral&src=reddit');
    expect(html).toContain('/auth/github?next=%2Freferral&src=reddit');
    expect(html).toContain("source:'signin-referral'");                 // email path tags the page
  });

  it('sanitizes a hostile next/src (no open-redirect / injection)', () => {
    const html = renderSigninComponent({ page: 'welcome', oauthProviders: OAUTH_BOTH, newSignupEnabled: true, next: 'https://evil.example/x', src: '"><script>' });
    expect(html).not.toContain('evil.example');
    expect(html).toContain('next=%2Fwelcome');                          // falls back to the internal default
    expect(html).not.toContain('<script>"');                            // src stripped of injection chars
  });
});

describe('outer-flag integration on the 3 pages', () => {
  it('/welcome ON (organic) renders the shared card; OFF keeps the legacy start-free block', () => {
    const on = getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: OAUTH_BOTH, unifiedSignin: true });
    expect(on).toContain('avsi-card');
    const off = getWelcomePageHtml(null, null, null, { newSignupEnabled: true, oauthProviders: OAUTH_BOTH });
    expect(off).not.toContain('avsi-card');
    expect(off).toContain('startfree-block');                           // legacy widget intact
  });

  it('/account ON shows the shared card above the paste-key tabs; OFF is legacy', () => {
    const on = getAccountPageHtml({ unifiedSignin: true, newSignupEnabled: true, oauthProviders: OAUTH_BOTH });
    expect(on).toContain('avsi-card');
    expect(on).toContain('id="panel-key"');                             // paste-key secondary PRESERVED (AC3)
    expect(on).toContain('id="panel-referral"');                        // referrals secondary PRESERVED
    const off = getAccountPageHtml();
    expect(off).not.toContain('avsi-card');
    expect(off).toContain('id="panel-key"');
  });

  it('/referral ON is one-tap reachable (shared card); OFF is email-only (byte-parity)', () => {
    const on = renderReferralLandingPage({ unifiedSignin: true, newSignupEnabled: true, oauthProviders: OAUTH_BOTH });
    expect(on).toContain('avsi-card');
    expect(on).toContain('Continue with Google');                       // no longer email-only (AC1)
    const off = renderReferralLandingPage();
    expect(off).not.toContain('avsi-card');
    expect(off).toContain('signup-email');                              // legacy email form intact
  });

  it('/account + /referral OFF snapshots (legacy layout regression guard)', () => {
    expect(getAccountPageHtml()).toMatchSnapshot();
    expect(renderReferralLandingPage()).toMatchSnapshot();
  });
});

describe('flag accessors (two-flag firewall)', () => {
  it('isUnifiedSigninEnabled reads UNIFIED_SIGNIN_ENABLED (default OFF)', () => {
    expect(isUnifiedSigninEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isUnifiedSigninEnabled({ UNIFIED_SIGNIN_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isUnifiedSigninEnabled({ UNIFIED_SIGNIN_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
  it('inner NEW_SIGNUP_ENABLED still gates independently', () => {
    expect(isNewSignupEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isNewSignupEnabled({ NEW_SIGNUP_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

// Q5 — returning email returns the EXISTING key (idempotent; no duplicate). DB-backed.
const SKIP = process.env.DATABASE_URL ? 'DATABASE_URL set — skip local SQLite test' : '';
const dd = SKIP ? describe.skip : describe;
dd('Q5 — email = identity, idempotent key issuance', () => {
  let mintFreeKey: (email: string, refCode?: string | null) => Promise<string>;
  let ensureFreeKeysSchema: () => void;
  let _resetFreeKeyCacheForTest: () => void;
  let dbRun: (sql: string, ...args: unknown[]) => void;
  const EMAIL = 'unify-idem-test@auth-unify-test.local';

  beforeAll(async () => {
    ({ mintFreeKey, ensureFreeKeysSchema, _resetFreeKeyCacheForTest } = await import('../src/lib/free-keys-store.js'));
    ({ dbRun } = await import('../src/lib/performance-db.js'));
    ensureFreeKeysSchema();
    _resetFreeKeyCacheForTest();
  });
  afterAll(() => { try { dbRun('DELETE FROM free_keys WHERE email = ?', EMAIL); } catch { /* ignore */ } });

  it('a returning email gets the SAME key (never a duplicate)', async () => {
    const k1 = await mintFreeKey(EMAIL);
    const k2 = await mintFreeKey(EMAIL);       // "Continue with email" again
    expect(k1).toBe(k2);
    expect(k1.startsWith('av_free_')).toBe(true);
  });
});
