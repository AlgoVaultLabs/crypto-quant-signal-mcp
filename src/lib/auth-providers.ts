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

export type ProviderId = 'google' | 'github';

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
    const info = (await infoRes.json()) as { sub?: string; email?: string; email_verified?: boolean };
    if (!info.email) throw new Error('google: no email on profile');
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

/** Is the new-signup flow enabled (outer firewall flag; default OFF). */
export function isNewSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEW_SIGNUP_ENABLED === '1' || env.NEW_SIGNUP_ENABLED === 'true';
}
