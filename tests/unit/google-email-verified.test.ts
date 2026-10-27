/**
 * GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 CH0 — Google sign-in accepts VERIFIED emails only.
 *
 * `GoogleProvider.exchange` read `email_verified` and never checked it, so `/auth/google/callback`
 * resolved an unverified address as an identity — and rendered the PAID key of any Stripe customer
 * who owns that address. These tests pin the three halves of the fix:
 *
 *  1. the provider refuses unless Google vouches for the address (a missing claim is unverified),
 *     with a TYPED error the route can tell apart from a fault; GitHub is unchanged;
 *  2. the refusal page is §Copy H0 and nothing else (no key, no account detail);
 *  3. the route answers that refusal with 403 BEFORE its generic 500, the provider runs before
 *     `resolveSigninIdentity` (so nothing is minted), and every other byte of the callback is
 *     identical to the pre-CH0 source — the snapshot R0.2 asks for. The callback lives inside
 *     `startHttp()`, which is not exported and cannot boot on SQLite, so the route's bytes are
 *     pinned at the source level, the precedent `tests/auth-refusal-mcp.test.ts` set for the
 *     `/mcp` gate's position.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAuthProvider,
  GoogleEmailUnverifiedError,
  GOOGLE_UNVERIFIED_COPY,
  signinRefusal,
} from '../../src/lib/auth-providers.js';

const GOOGLE_ENV = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' } as never;
const GITHUB_ENV = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'secret' } as never;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Stub the two Google hops; record every URL so a test can prove which hops ran. */
function stubGoogle(userinfo: Record<string, unknown>): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'access-token' });
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return json(userinfo);
    throw new Error(`unexpected fetch ${url}`);
  }));
  return seen;
}

function stubGitHub(emails: Array<{ email: string; primary: boolean; verified: boolean }>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) return json({ access_token: 'access-token' });
    if (url.startsWith('https://api.github.com/user/emails')) return json(emails);
    throw new Error(`unexpected fetch ${url}`);
  }));
}

const exchange = (env: never) =>
  getAuthProvider(env === GOOGLE_ENV ? 'google' : 'github', env).exchange({ code: 'c', redirectUri: 'https://api.algovault.com/auth/x/callback' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R0.1 — GoogleProvider.exchange refuses an address Google does not vouch for', () => {
  it('verified (boolean true) → the identity resolves exactly as before', async () => {
    const seen = stubGoogle({ sub: 'sub-1', email: 'Person@Example.com', email_verified: true });
    await expect(exchange(GOOGLE_ENV)).resolves.toEqual({
      provider: 'google',
      providerId: 'google:sub-1',
      email: 'person@example.com',
    });
    expect(seen).toHaveLength(2);
  });

  it('verified as the STRING "true" (Google documents this form) → resolves; the claim is typed tolerantly', async () => {
    stubGoogle({ sub: 'sub-2', email: 'a@example.com', email_verified: 'true' });
    await expect(exchange(GOOGLE_ENV)).resolves.toMatchObject({ email: 'a@example.com' });
  });

  it.each([
    ['false (boolean)', false],
    ['"false" (string)', 'false'],
    ['missing', undefined],
    ['null', null],
    ['1 (number)', 1],
    ['"yes"', 'yes'],
  ])('%s → GoogleEmailUnverifiedError, never an identity', async (_label, claim) => {
    const info: Record<string, unknown> = { sub: 'sub-3', email: 'victim@example.com' };
    if (claim !== undefined) info.email_verified = claim;
    stubGoogle(info);
    const p = exchange(GOOGLE_ENV);
    await expect(p).rejects.toBeInstanceOf(GoogleEmailUnverifiedError);
    await expect(p).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });
  });

  it('a profile with no email at all keeps its existing (non-refusal) error', async () => {
    stubGoogle({ sub: 'sub-4', email_verified: true });
    const err = await exchange(GOOGLE_ENV).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GoogleEmailUnverifiedError);
    expect((err as Error).message).toBe('google: no email on profile');
  });

  it.each([['TRUE'], [' True ']])('the claim %j (case / whitespace variants of "true") → resolves', async (claim) => {
    stubGoogle({ sub: 'sub-5', email: 'b@example.com', email_verified: claim });
    await expect(exchange(GOOGLE_ENV)).resolves.toMatchObject({ email: 'b@example.com' });
  });

  it.each([[0], [''], [{}], [[]]])('the claim %j → refused', async (claim) => {
    stubGoogle({ sub: 'sub-6', email: 'c@example.com', email_verified: claim });
    await expect(exchange(GOOGLE_ENV)).rejects.toBeInstanceOf(GoogleEmailUnverifiedError);
  });
});

describe('R0.3 — GitHub is unchanged', () => {
  it('a verified primary email resolves as before', async () => {
    stubGitHub([{ email: 'Dev@Example.com', primary: true, verified: true }]);
    await expect(exchange(GITHUB_ENV)).resolves.toEqual({
      provider: 'github',
      providerId: 'github:Dev@Example.com',
      email: 'dev@example.com',
    });
  });

  it('no verified email keeps GitHub\'s own error — not the Google refusal', async () => {
    stubGitHub([{ email: 'dev@example.com', primary: true, verified: false }]);
    const err = await exchange(GITHUB_ENV).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GoogleEmailUnverifiedError);
    expect((err as Error).message).toBe('github: no verified email');
    expect(signinRefusal(err)).toBeNull();
  });
});

describe('R0.2 — the refusal page is §Copy H0 and nothing else', () => {
  const refusal = signinRefusal(new GoogleEmailUnverifiedError());

  it('answers 403', () => {
    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(403);
  });

  it('carries §Copy H0 verbatim, its last clause linked to the sign-in page', () => {
    expect(GOOGLE_UNVERIFIED_COPY).toBe(
      "Your Google email isn't verified yet. Verify it in your Google account, or continue with GitHub or email.",
    );
    const text = refusal!.html.replace(/<[^>]+>/g, '');
    expect(text).toContain(GOOGLE_UNVERIFIED_COPY);
    expect(refusal!.html).toContain('<a class="text-mint-400 underline" href="/welcome">GitHub or email</a>.');
  });

  it('renders nothing about any account — no key, no referral link, no plan', () => {
    for (const leak of ['av_live_', 'av_free_', 'API key', 'Referral', 'referral', 'subscription', '/account']) {
      expect(refusal!.html).not.toContain(leak);
    }
  });

  it('paints through the generated THEME region and carries no colour literal of its own', () => {
    expect(refusal!.html).toContain('<!-- THEME:START -->');
    expect(refusal!.html).toContain('<!-- THEME:END -->');
    const own = refusal!.html.replace(/<!-- THEME:START -->[\s\S]*<!-- THEME:END -->/, '');
    expect(own).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(own).not.toMatch(/rgba?\(/);
  });

  it.each([
    ['a provider fault', new Error('google token exchange failed: 500')],
    ['a GitHub error', new Error('github: no verified email')],
    ['a string', 'boom'],
    ['undefined', undefined],
  ])('%s is not a refusal → null (the route keeps its 500)', (_label, err) => {
    expect(signinRefusal(err)).toBeNull();
  });
});

describe('R0.2 — the route: refusal first, nothing minted, every other byte unchanged', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
  const fixture = readFileSync(resolve(root, 'tests/fixtures/auth-callback-span-pre-ch0.txt'), 'utf8');
  const start = src.indexOf("app.get('/auth/:provider/callback'");
  const end = src.indexOf('// ── AV-CHAT-MCP-W1', start);
  const raw = src.slice(start, end);
  // GROWTH-AGENT-SIGNIN-OAUTH-W1 R2.7 is the ONE other sanctioned insertion: the MCP-client branch
  // right after `resolveSigninIdentity`. It is cut out by its own markers and asserted on its own,
  // so every byte the two waves did not declare stays pinned to the pre-CH0 fixture.
  const OAUTH_OPEN = '      // GROWTH-AGENT-SIGNIN-OAUTH-W1 R2.7:';
  const OAUTH_CLOSE = '        if (handled) return;\n      }\n\n';
  const oauthStart = raw.indexOf(OAUTH_OPEN);
  const oauthEnd = raw.indexOf(OAUTH_CLOSE, oauthStart) + OAUTH_CLOSE.length;
  const oauthBlock = raw.slice(oauthStart, oauthEnd);
  const span = raw.slice(0, oauthStart) + raw.slice(oauthEnd);
  const CATCH = '    } catch (err) {\n';

  it('the R2.7 OAuth branch is present once, gated on MCP_OAUTH, and returns only when it answered', () => {
    expect(oauthStart).toBeGreaterThan(0);
    expect(raw.indexOf(OAUTH_OPEN, oauthStart + 1)).toBe(-1);
    expect(oauthBlock).toContain("if (resolveOAuthMode() !== 'off') {");
    expect(oauthBlock).toContain('await oauthCallbackBranch(req, res, {');
    expect(oauthBlock).toContain('if (handled) return;');
    expect(raw.indexOf('await resolveSigninIdentity(')).toBeLessThan(oauthStart);
  });

  it('the span and the fixture are both found, and the catch is unique in each', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(fixture.length).toBeGreaterThan(1000);
    expect(fixture.indexOf(CATCH)).toBe(fixture.lastIndexOf(CATCH));
    expect(span.indexOf(CATCH)).toBe(span.lastIndexOf(CATCH));
  });

  it('every byte outside the inserted refusal branch is identical to the pre-CH0 callback', () => {
    const cut = fixture.indexOf(CATCH) + CATCH.length;
    const before = fixture.slice(0, cut);
    const after = fixture.slice(cut);
    expect(span.startsWith(before)).toBe(true);
    expect(span.endsWith(after)).toBe(true);
    const inserted = span.slice(before.length, span.length - after.length);
    expect(inserted).toContain('signinRefusal(err)');
    expect(inserted).toContain("res.setHeader('Content-Type', 'text/html; charset=utf-8');");
    expect(inserted).toContain('return res.status(refusal.status).send(refusal.html);');
  });

  it('the refusal is answered before the generic 500', () => {
    const iRefusal = span.indexOf('signinRefusal(err)');
    const i500 = span.indexOf("res.status(500).send('Sign-in error. Please try again.')");
    expect(iRefusal).toBeGreaterThan(0);
    expect(i500).toBeGreaterThan(iRefusal);
  });

  it('the provider runs before the identity resolver, so a refused exchange mints nothing', () => {
    const iExchange = span.indexOf('await provider.exchange(');
    const iResolve = span.indexOf('await resolveSigninIdentity(');
    expect(iExchange).toBeGreaterThan(0);
    expect(iResolve).toBeGreaterThan(iExchange);
  });
});
