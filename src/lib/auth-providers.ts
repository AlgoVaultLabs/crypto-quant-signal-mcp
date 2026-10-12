/**
 * FUNNEL-FIX-HUMAN-SIGNUP-W1 — pluggable sign-in providers (Google · GitHub), stub-first.
 *
 * The factory returns a StubProvider when a provider's OAuth creds are absent, so the whole
 * one-tap flow ships GREEN with ZERO manual prep; Google/GitHub flip live the moment their
 * `*_OAUTH_CLIENT_ID` / `*_OAUTH_CLIENT_SECRET` env vars exist. A provider ONLY yields a
 * verified `{email, providerId}` — it never touches entitlement; key issuance/merge stays in
 * free-keys-store (email = identity). Secrets are read from env only (never committed).
 *
 * Security: the route generates a CSRF `state` and verifies it on callback; the post-auth
 * redirect is validated to a same-origin relative path (no open redirect); the redirect_uri
 * sent to the IdP is our own fixed callback.
 */
import { randomBytes } from 'node:crypto';
import { renderThemeBlock } from './site-theme.js';

export type ProviderId = 'google' | 'github';

// ── GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 CH0 — a Google email counts only when Google says it is VERIFIED ──
//
// `GoogleProvider.exchange` read `email_verified` into its type and never checked it, so a Google
// profile carrying an UNVERIFIED address resolved as that address — and the callback then rendered
// the PAID key of any Stripe customer who owns it (`resolveSigninIdentity` maps a paying email to
// its live key). GitHub already required a verified address; this closes the same door on Google
// for every surface that signs in through the provider, the deferred OAuth wave included.
//
// The claim is read TOLERANTLY on its type and STRICTLY on its value. OpenID Connect Core §5.1 types
// `email_verified` as a JSON boolean, but Google's own OIDC page shows the ID-token example as the
// STRING "true" (fetched 2026-10-12). Accepting only the boolean would refuse every Google sign-in
// the day the userinfo endpoint answered with the string — an outage nothing would page on. So the
// boolean `true` and the string "true" (any case) are verified; `false`, "false", a missing field
// and anything else are not. A missing field is UNVERIFIED, never assumed verified.

/** Thrown by `GoogleProvider.exchange` when Google does not vouch for the address. A refusal, not a fault. */
export class GoogleEmailUnverifiedError extends Error {
  readonly code = 'GOOGLE_EMAIL_UNVERIFIED';
  constructor() {
    super('google: email not verified');
    this.name = 'GoogleEmailUnverifiedError';
  }
}

/** True only for a claim that says "verified": boolean `true` or the string "true" (any case). */
function isVerifiedEmailClaim(claim: unknown): boolean {
  return claim === true || (typeof claim === 'string' && claim.trim().toLowerCase() === 'true');
}

/** §Copy H0 (GROWTH-AGENT-SIGNIN-STEPUP-W1-V2), verbatim. The page links its last clause; the words stay this. */
export const GOOGLE_UNVERIFIED_COPY =
  "Your Google email isn't verified yet. Verify it in your Google account, or continue with GitHub or email.";

const H0_LINKED_CLAUSE = 'GitHub or email';

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The callback's answer to a sign-in REFUSAL, or `null` when `err` is not one (the caller then keeps
 * its existing 500). Pure — the route calls it from its catch, which is what makes the branch
 * testable without booting the HTTP server.
 *
 * The page carries §Copy H0 and nothing else: no key, no referral link, no account detail. Its
 * palette is the generated THEME region (Design.md §13) — no colour literal, and the token
 * fallbacks render it dark even if the design stylesheet never loads.
 */
export function signinRefusal(err: unknown): { status: 403; html: string } | null {
  if (!(err instanceof GoogleEmailUnverifiedError)) return null;
  const [head, tail] = GOOGLE_UNVERIFIED_COPY.split(H0_LINKED_CLAUSE);
  const body =
    `${escapeText(head)}<a class="text-mint-400 underline" href="/welcome">${escapeText(H0_LINKED_CLAUSE)}</a>${escapeText(tail)}`;
  return {
    status: 403,
    html:
      '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>AlgoVault</title>\n' +
      `${renderThemeBlock()}\n</head>\n<body class="bg-navy-900 text-gray-200">\n` +
      '<main style="max-width:560px;margin:60px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.5">\n' +
      `<p>${body}</p>\n</main>\n</body>\n</html>\n`,
  };
}

export interface AuthProfile {
  provider: ProviderId;
  providerId: string; // stable per-provider subject id
  email: string; // verified email (identity); stub yields a synthetic @oauth.stub address
}

export interface AuthProvider {
  id: ProviderId;
  /** false = StubProvider (no real creds) — flow still completes end-to-end. */
  live: boolean;
  /** IdP authorize URL to redirect the user to. */
  authorizeUrl(args: { state: string; redirectUri: string }): string;
  /** Exchange the callback `code` for a verified profile. */
  exchange(args: { code: string; redirectUri: string }): Promise<AuthProfile>;
}

/** CSRF state token. */
export function generateOAuthState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Validate a post-auth redirect target: only same-origin relative paths (start with a single
 * '/', no scheme, no protocol-relative '//', no backslashes). Anything else → the safe default.
 */
export function safeRedirectPath(raw: unknown, fallback = '/welcome'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (raw.includes('\\') || /^\/*[a-z][a-z0-9+.-]*:/i.test(raw)) return fallback; // no embedded scheme
  return raw;
}

// ── Stub (default when creds absent) ────────────────────────────────────────────
class StubProvider implements AuthProvider {
  readonly live = false;
  constructor(readonly id: ProviderId) {}
  authorizeUrl(args: { state: string; redirectUri: string }): string {
    // Loop straight back to our own callback with a synthetic code so the flow completes
    // locally (no external IdP). The route treats a `stub` code as the Stub path.
    const u = new URL(args.redirectUri);
    u.searchParams.set('code', `stub_${randomBytes(6).toString('hex')}`);
    u.searchParams.set('state', args.state);
    return u.toString();
  }
  async exchange(args: { code: string }): Promise<AuthProfile> {
    // Deterministic-shaped synthetic identity: a stable email per code so tests + a manual
    // click both yield a coherent account. Marked @oauth.stub so it's obviously non-production.
    const sub = args.code.replace(/^stub_/, '') || randomBytes(6).toString('hex');
    return { provider: this.id, providerId: `stub:${sub}`, email: `stub_${sub}@oauth.stub` };
  }
}

// ── Google ──────────────────────────────────────────────────────────────────────
class GoogleProvider implements AuthProvider {
  readonly id = 'google' as const;
  readonly live = true;
  constructor(private clientId: string, private clientSecret: string) {}
  authorizeUrl(args: { state: string; redirectUri: string }): string {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', args.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email');
    u.searchParams.set('state', args.state);
    return u.toString();
  }
  async exchange(args: { code: string; redirectUri: string }): Promise<AuthProfile> {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: args.code, client_id: this.clientId, client_secret: this.clientSecret,
        redirect_uri: args.redirectUri, grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error(`google token exchange failed: ${tokenRes.status}`);
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) throw new Error('google: no access_token');
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!infoRes.ok) throw new Error(`google userinfo failed: ${infoRes.status}`);
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean | string };
    if (!info.email) throw new Error('google: no email on profile');
    // CH0: an address Google does not vouch for is not an identity — see the block at the top.
    if (!isVerifiedEmailClaim(info.email_verified)) throw new GoogleEmailUnverifiedError();
    return { provider: 'google', providerId: `google:${info.sub ?? info.email}`, email: info.email.toLowerCase() };
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────────
class GitHubProvider implements AuthProvider {
  readonly id = 'github' as const;
  readonly live = true;
  constructor(private clientId: string, private clientSecret: string) {}
  authorizeUrl(args: { state: string; redirectUri: string }): string {
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', args.redirectUri);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', args.state);
    return u.toString();
  }
  async exchange(args: { code: string; redirectUri: string }): Promise<AuthProfile> {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code: args.code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: args.redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`github token exchange failed: ${tokenRes.status}`);
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) throw new Error('github: no access_token');
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'AlgoVault', Accept: 'application/vnd.github+json' },
    });
    if (!emailsRes.ok) throw new Error(`github emails failed: ${emailsRes.status}`);
    const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find(e => e.primary && e.verified) ?? emails.find(e => e.verified);
    if (!primary) throw new Error('github: no verified email');
    return { provider: 'github', providerId: `github:${primary.email}`, email: primary.email.toLowerCase() };
  }
}

/**
 * Resolve a provider. Returns the LIVE provider when both `<P>_OAUTH_CLIENT_ID` and
 * `<P>_OAUTH_CLIENT_SECRET` are present; otherwise a StubProvider (so the wave ships GREEN).
 * `env` injectable for tests.
 */
export function getAuthProvider(id: ProviderId, env: NodeJS.ProcessEnv = process.env): AuthProvider {
  const prefix = id.toUpperCase();
  const cid = env[`${prefix}_OAUTH_CLIENT_ID`];
  const secret = env[`${prefix}_OAUTH_CLIENT_SECRET`];
  if (cid && secret) {
    return id === 'google' ? new GoogleProvider(cid, secret) : new GitHubProvider(cid, secret);
  }
  return new StubProvider(id);
}

/**
 * Is the deferred-identity signup flow (start-free + OAuth routes) enabled?
 * This is the INNER firewall — the /api/start-free + /auth/* routes 404 when off.
 * (Currently flipped LIVE via NEW_SIGNUP_ENABLED=1.)
 */
export function isNewSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEW_SIGNUP_ENABLED === '1' || env.NEW_SIGNUP_ENABLED === 'true';
}

/**
 * FUNNEL-FIX-AUTH-UNIFY-W1 — OUTER firewall for the unified sign-in LAYOUT.
 * When off (default), /welcome · /account · /referral render their LEGACY layouts
 * byte-identically; when on, each renders the ONE shared `renderSigninComponent`.
 * Composes over `isNewSignupEnabled` (the inner flag still gates start-free + OAuth).
 * Ship DARK; Mr.1 owns the flip; instant rollback = unset.
 */
export function isUnifiedSigninEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.UNIFIED_SIGNIN_ENABLED === '1' || env.UNIFIED_SIGNIN_ENABLED === 'true';
}
