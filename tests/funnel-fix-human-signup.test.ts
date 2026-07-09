/**
 * FUNNEL-FIX-HUMAN-SIGNUP-W1 — deferred-identity + stub-first OAuth (pure / DI; no DB).
 * Proves: AC1 value-before-email, AC2 one-tap stub round-trip + factory, AC4 attribution
 * survives, AC5 OAuth security (state + redirect allowlist). The DB-backed merge (no double
 * key) is in free-keys-ephemeral.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getAuthProvider, generateOAuthState, safeRedirectPath, isNewSignupEnabled,
} from '../src/lib/auth-providers.js';
import { startFree, captureEmail, type DeferredSignupDeps } from '../src/lib/deferred-signup.js';

describe('auth-providers — stub-first factory', () => {
  it('returns a Stub when creds absent, live when present', () => {
    expect(getAuthProvider('github', {}).live).toBe(false);
    expect(getAuthProvider('google', {}).live).toBe(false);
    expect(getAuthProvider('github', { GITHUB_OAUTH_CLIENT_ID: 'x', GITHUB_OAUTH_CLIENT_SECRET: 'y' } as never).live).toBe(true);
    expect(getAuthProvider('google', { GOOGLE_OAUTH_CLIENT_ID: 'x', GOOGLE_OAUTH_CLIENT_SECRET: 'y' } as never).live).toBe(true);
  });
  it('StubProvider round-trips end-to-end (authorizeUrl loops back, exchange yields a synthetic email)', async () => {
    const p = getAuthProvider('github', {});
    const url = p.authorizeUrl({ state: 'STATE123', redirectUri: 'https://api.algovault.com/auth/github/callback' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.algovault.com/auth/github/callback');
    expect(u.searchParams.get('state')).toBe('STATE123');
    const code = u.searchParams.get('code')!;
    expect(code.startsWith('stub_')).toBe(true);
    const profile = await p.exchange({ code, redirectUri: '' });
    expect(profile.provider).toBe('github');
    expect(profile.email).toMatch(/@oauth\.stub$/);
    expect(profile.providerId.startsWith('stub:')).toBe(true);
  });
  it('live GoogleProvider builds the accounts.google.com authorize URL with openid email scope', () => {
    const p = getAuthProvider('google', { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 's' } as never);
    const u = new URL(p.authorizeUrl({ state: 'S', redirectUri: 'https://api.algovault.com/auth/google/callback' }));
    expect(u.host).toBe('accounts.google.com');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('scope')).toContain('email');
    expect(u.searchParams.get('response_type')).toBe('code');
  });
});

describe('auth-providers — security (AC5)', () => {
  it('safeRedirectPath: same-origin relative only; blocks open-redirect vectors', () => {
    expect(safeRedirectPath('/welcome')).toBe('/welcome');
    expect(safeRedirectPath('/account?x=1')).toBe('/account?x=1');
    expect(safeRedirectPath('//evil.com')).toBe('/welcome');
    expect(safeRedirectPath('https://evil.com')).toBe('/welcome');
    expect(safeRedirectPath('/\\evil')).toBe('/welcome');
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/welcome');
    expect(safeRedirectPath('welcome')).toBe('/welcome'); // no leading slash
    expect(safeRedirectPath('')).toBe('/welcome');
    expect(safeRedirectPath(null)).toBe('/welcome');
  });
  it('generateOAuthState is random 32-hex', () => {
    const a = generateOAuthState(), b = generateOAuthState();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(a).not.toBe(b);
  });
  it('isNewSignupEnabled: default OFF (dark); on for 1/true', () => {
    expect(isNewSignupEnabled({} as never)).toBe(false);
    expect(isNewSignupEnabled({ NEW_SIGNUP_ENABLED: '1' } as never)).toBe(true);
    expect(isNewSignupEnabled({ NEW_SIGNUP_ENABLED: 'true' } as never)).toBe(true);
    expect(isNewSignupEnabled({ NEW_SIGNUP_ENABLED: '0' } as never)).toBe(false);
  });
});

describe('deferred-signup — value BEFORE email (AC1) + attribution survives (AC4)', () => {
  function deps(over: Partial<DeferredSignupDeps> = {}): DeferredSignupDeps {
    return {
      mintEphemeral: vi.fn(async () => 'av_free_ephemeral1'),
      recordAttribution: vi.fn(),
      getSignal: vi.fn(async () => ({ asset: 'BTC', timeframe: '1h', verdict: 'BUY', confidence: 72 })),
      merge: vi.fn(async (_k: string, _e: string) => 'av_free_merged'),
      ...over,
    };
  }
  it('startFree returns a key + a real signal with NO email involved', async () => {
    const d = deps();
    const r = await startFree({ src: 'producthunt', ref: 'REF9' }, d);
    expect(r.key).toBe('av_free_ephemeral1');
    expect(r.ephemeral).toBe(true);
    expect(r.signal).toEqual({ asset: 'BTC', timeframe: '1h', verdict: 'BUY', confidence: 72 });
    expect(d.mintEphemeral).toHaveBeenCalledWith('REF9'); // referral carried, no email
  });
  it('stamps attribution against the KEY with ?src as utmSource (closes the free-flow gap)', async () => {
    const rec = vi.fn();
    await startFree({ src: 'producthunt', ref: 'REF9', ip_hash: 'iphash1' }, deps({ recordAttribution: rec }));
    expect(rec).toHaveBeenCalledTimes(1);
    const arg = rec.mock.calls[0][0];
    expect(arg.clientReferenceId).toBe('av_free_ephemeral1');
    expect(arg.utmSource).toBe('producthunt');
    expect(arg.tierRequested).toBe('free');
    expect(arg.ipHash).toBe('iphash1');
  });
  it('startFree is resilient: a signal error still returns the key (value = the key)', async () => {
    const d = deps({ getSignal: vi.fn(async () => { throw new Error('grid warming'); }) });
    const r = await startFree({}, d);
    expect(r.key).toBe('av_free_ephemeral1');
    expect(r.signal).toBeNull();
    expect(r.signal_error).toContain('grid warming');
  });
  it('captureEmail delegates to the idempotent merge', async () => {
    const merge = vi.fn(async () => 'av_free_kept');
    const r = await captureEmail('av_free_ephemeral1', 'a@b.com', 'REF9', deps({ merge }));
    expect(r.key).toBe('av_free_kept');
    expect(merge).toHaveBeenCalledWith('av_free_ephemeral1', 'a@b.com', 'REF9');
  });
});
