/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — the OAuth authorization server, mounted only when
 * `resolveOAuthMode() !== 'off'` (R2.1). With the mode off nothing here is reachable: all nine
 * paths keep the app's own 404, byte-identical.
 *
 * The four protocol endpoints are the SDK 1.29.0 handlers (proposal (d)) with OUR provider, each
 * with `rateLimit: false`, preceded by OUR limiter (R2.14) and followed by a scoped error mapper so
 * a body-parser 413 / 415 / 400 answers OAuth `invalid_request` JSON, never the app's 500 (I-6).
 * Encoded bodies are already refused for every route by `refuse-encoded-bodies.ts`, mounted first.
 * The SDK's `cors()` `*` on token / register / revoke responses is accepted; preflight stays with
 * the global policy (its OPTIONS answers 204 before any route) — browser-based clients are out of
 * scope.
 *
 * The person-facing steps between authorize and consent — the IdP callback branch, the email code
 * and the key path — all end in `bindAndContinue`: identity on the pending row, then a same-origin
 * GET to `/oauth/consent`.
 *
 * GROWTH-AGENT-SIGNIN-OAUTH-W2 — two guards around the SDK handlers. `/token` and `/revoke` refuse
 * a client assertion as `invalid_client` before the SDK's `authenticateClient`, which reads
 * `client_secret` only and would ignore it. `/authorize` puts `iss` on the SDK's own redirects
 * (Phase-2 refusals, its `server_error` catch), so every authorization response carries it.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { InvalidClientError, OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { clientIp } from '../client-ip.js';
import { sendFreeKeyEmail, sendSigninCodeEmail } from '../email.js';
import { FREE_KEY_PREFIX, lookupFreeKey } from '../free-keys-store.js';
import { resolveSigninIdentity, type SigninIdentity } from '../signin-identity.js';
import { resolveCustomerByApiKey } from '../stripe.js';
import { recordSignupAttribution } from '../subscriber-attribution.js';
import { clientHost, clientLabel, isLoopbackRedirect, oauthClientsStore } from './clients.js';
import { browserLimiter, hit, perIpExemptLimiter, tokenLimiter } from './limits.js';
import {
  METADATA_CACHE_CONTROL,
  TOKEN_ENDPOINT_AUTH_METHODS,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from './metadata.js';
import { OAUTH_ISSUER, resolveOAuthMode, type OAuthMode } from './mode.js';
import { COPY_H, renderConsentPage, renderEmailCodePage, renderMessagePage } from './pages.js';
import { AUTHZ_COOKIE, handOffError, issueCodeAndHandOff, newId, oauthProvider } from './provider.js';
import {
  bindPendingIdentity,
  consumeOtp,
  consumePending,
  countOtpSendsSince,
  ensureOAuthSchema,
  getLiveOtp,
  getLivePending,
  insertOtp,
  isoAt,
  sha256Hex,
  spendOtpAttempt,
  type PendingRow,
} from './store.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SENDS_PER_EMAIL_HOUR = 3;
const OTP_SENDS_PER_IP_HOUR = 10;
const HOUR = 60 * 60 * 1000;
const PENDING_ID = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,63}$/;

/**
 * Body-parser failures on an OAuth route → OAuth JSON, never the app's 500 (I-6). An `OAuthError`
 * from our own guards answers the way the SDK's handlers answer one: 400, or 500 for `ServerError`.
 */
function oauthErrorMapper(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  res.setHeader('Cache-Control', 'no-store');
  if (err instanceof OAuthError) {
    res.status(err instanceof ServerError ? 500 : 400).json(err.toResponseObject());
    return;
  }
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 500;
  if (status >= 400 && status < 500) {
    res.status(400).json({ error: 'invalid_request', error_description: 'The request body could not be read.' });
    return;
  }
  res.status(500).json({ error: 'server_error', error_description: 'Internal Server Error' });
}

/**
 * W2 — an assertion (`private_key_jwt`) is a method outside `TOKEN_ENDPOINT_AUTH_METHODS`: refused
 * as `invalid_client`, never quietly served as a public client. Unconditional until an assertion
 * verifier exists — adding the method to the list alone must not start accepting unverified JWTs.
 */
function refuseClientAssertion(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (body?.client_assertion === undefined && body?.client_assertion_type === undefined) return next();
  const id = body?.client_id;
  console.log(`[oauth] token_refused reason=assertion_outside_intersection client_host=${typeof id === 'string' ? clientHost(id) : 'unknown'}`);
  next(new InvalidClientError(`Client authentication must use: ${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}.`));
}

/** `url` with `iss` set exactly once; a relative URL (never a client redirect_uri) unchanged. */
function withIss(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('iss', OAUTH_ISSUER);
    return u.href;
  } catch {
    return url;
  }
}

/**
 * W2 — on `/authorize` every `res.redirect` is the SDK's, to the client's `redirect_uri` (Phase-2
 * refusals, its `server_error` catch): our provider hands off through `sendOffOriginRedirect`,
 * never a 3xx. Wrapping it here is what puts `iss` on those (W1 R2.10).
 */
function issOnAuthorizeRedirects(_req: Request, res: Response, next: NextFunction): void {
  const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
  res.redirect = ((a: unknown, b?: unknown): void => {
    if (typeof a === 'number') return redirect(a, withIss(String(b)));
    return redirect(typeof b === 'number' ? b : 302, withIss(String(a)));
  }) as Response['redirect'];
  next();
}

function sendPage(res: Response, status: number, html: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(html);
}

const expired = (res: Response): void => sendPage(res, 400, renderMessagePage(COPY_H.expired));
const busy = (res: Response): void => sendPage(res, 503, renderMessagePage(COPY_H.busy));

function pendingIdFrom(req: Request): string | null {
  const raw = (req.method === 'POST' ? (req.body as Record<string, unknown> | undefined)?.r : req.query.r) as unknown;
  return typeof raw === 'string' && PENDING_ID.test(raw) ? raw : null;
}

async function livePendingFrom(req: Request): Promise<PendingRow | null> {
  const id = pendingIdFrom(req);
  return id ? getLivePending(id) : null;
}

function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** The `src` a client put on the resource (`…/mcp?src=docs`), for first-touch attribution. */
export function srcFromResource(resource: string): string | null {
  try {
    const src = new URL(resource).searchParams.get('src');
    return src && /^[A-Za-z0-9_-]{1,40}$/.test(src) ? src : null;
  } catch {
    return null;
  }
}

function planOf(identity: SigninIdentity): string {
  return identity.outcome === 'PAID' ? identity.tier ?? 'paid' : 'FREE';
}

/**
 * Bind a resolved identity to the pending row, then the same-origin consent GET. A FREE key this
 * flow CREATED gets its email once and its first-touch attribution (R2.7); a returning person or a
 * PAID one never.
 */
async function bindAndContinue(
  res: Response,
  pending: PendingRow,
  identity: SigninIdentity,
  email: string,
  via: string,
): Promise<void> {
  const bound = await bindPendingIdentity(pending.id, { kind: 'email', value: email, via, plan: planOf(identity) });
  if (!bound) return expired(res);
  if (identity.outcome === 'FREE' && identity.created && identity.key) {
    const key = identity.key;
    void sendFreeKeyEmail(email, key).catch(() => undefined);
    try {
      recordSignupAttribution({ clientReferenceId: key, utmSource: srcFromResource(pending.resource) ?? 'mcp_oauth', tierRequested: 'free' });
    } catch {
      /* best-effort */
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(303, `/oauth/consent?r=${encodeURIComponent(pending.id)}`);
}

/**
 * R2.7 — called by `/auth/:provider/callback` right after `resolveSigninIdentity`. Returns true
 * when it answered. A missing cookie, an expired or unknown row, a store fault, or mode `off` →
 * false, and the callback renders today's page byte-identical. `clearCookies` are the callback's
 * own three clears: `av_mcp_authz`'s clear joins them in ONE Set-Cookie array (C11).
 */
export async function oauthCallbackBranch(
  req: Request,
  res: Response,
  args: { identity: SigninIdentity; email: string; via: string; clearCookies: string[] },
): Promise<boolean> {
  if (resolveOAuthMode() === 'off') return false;
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${AUTHZ_COOKIE}=([A-Za-z0-9_-]+)`));
  if (!m || !PENDING_ID.test(m[1])) return false;
  let pending: PendingRow | null;
  try {
    pending = await getLivePending(m[1]);
  } catch {
    return false;
  }
  if (!pending) return false;
  res.setHeader('Set-Cookie', [...args.clearCookies, `${AUTHZ_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`]);
  try {
    if (args.identity.outcome === 'INDETERMINATE' || !args.identity.key) {
      await handOffError(res, pending, 'temporarily_unavailable');
      return true;
    }
    await bindAndContinue(res, pending, args.identity, args.email.trim().toLowerCase(), args.via);
  } catch (err) {
    console.error(`[oauth] callback branch failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) await handOffError(res, pending, 'temporarily_unavailable');
  }
  return true;
}

// ── email code (R2.8) ──────────────────────────────────────────────────────

function otpHash(otpId: string, code: string): string {
  return sha256Hex(`${otpId}:${code}`);
}

async function emailStart(req: Request, res: Response): Promise<void> {
  const pending = await livePendingFrom(req);
  if (!pending) return expired(res);
  const email = normaliseEmail((req.body as Record<string, unknown>)?.email);
  if (!email) return sendPage(res, 200, renderEmailCodePage({ email: '', pendingId: pending.id, message: COPY_H.codeWrong }));
  const now = Date.now();
  // One generic response whatever the address and whatever the limits decided.
  const ipOk = hit(`otp|ip|${clientIp(req)}`, OTP_SENDS_PER_IP_HOUR, HOUR, now);
  const emailOk = ipOk && (await countOtpSendsSince(email, now - HOUR)) < OTP_SENDS_PER_EMAIL_HOUR;
  if (emailOk) {
    const id = newId();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await insertOtp({ id, pending_id: pending.id, email, code_hash: otpHash(id, code), attempts: 0, created_at: isoAt(now), expires_at: isoAt(now + OTP_TTL_MS) });
    await sendSigninCodeEmail(email, code).catch(() => null);
  }
  sendPage(res, 200, renderEmailCodePage({ email, pendingId: pending.id }));
}

async function emailVerify(req: Request, res: Response): Promise<void> {
  const pending = await livePendingFrom(req);
  if (!pending) return expired(res);
  const otp = await getLiveOtp(pending.id);
  const code = String((req.body as Record<string, unknown>)?.code ?? '').trim();
  if (!otp) return sendPage(res, 200, renderEmailCodePage({ email: '', pendingId: pending.id, message: COPY_H.codeWrong }));
  const wrong = (): void => sendPage(res, 200, renderEmailCodePage({ email: otp.email, pendingId: pending.id, message: COPY_H.codeWrong }));
  if ((await spendOtpAttempt(otp.id, OTP_MAX_ATTEMPTS)) === null) return wrong();
  const want = Buffer.from(otp.code_hash, 'hex');
  const got = Buffer.from(otpHash(otp.id, /^[0-9]{6}$/.test(code) ? code : '------'), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return wrong();
  if (!(await consumeOtp(otp.id))) return wrong();
  const identity = await resolveSigninIdentity(otp.email);
  if (identity.outcome === 'INDETERMINATE' || !identity.key) return handOffError(res, pending, 'temporarily_unavailable');
  await bindAndContinue(res, pending, identity, otp.email, 'email');
}

// ── key possession (R2.9) ──────────────────────────────────────────────────

async function keyPath(req: Request, res: Response): Promise<void> {
  const pending = await livePendingFrom(req);
  if (!pending) return expired(res);
  const raw = (req.body as Record<string, unknown>)?.api_key;
  const key = typeof raw === 'string' ? raw.trim() : '';
  const back = async (message: string): Promise<void> => {
    const client = await oauthClientsStore.getClient(pending.client_id);
    const { renderConnectPage } = await import('./pages.js');
    const { getAuthProvider, isNewSignupEnabled } = await import('../auth-providers.js');
    const live = (id: 'google' | 'github'): boolean => {
      try {
        return isNewSignupEnabled() && getAuthProvider(id).live;
      } catch {
        return false;
      }
    };
    sendPage(res, 200, renderConnectPage({
      clientLabel: client ? clientLabel(client) : 'the app',
      pendingId: pending.id,
      providers: { google: live('google'), github: live('github') },
      message,
    }));
  };
  if (!/^[A-Za-z0-9_]{8,128}$/.test(key)) return back(COPY_H.keyNotRecognised);
  // The existing entitlement resolver decides whether the key is a credential at all.
  const { resolveLicense } = await import('../license.js');
  const { license } = await resolveLicense({ authorization: `Bearer ${key}` });
  if (license.outcome === 'INDETERMINATE') return back(COPY_H.busy);
  if (license.outcome !== 'RESOLVED') return back(COPY_H.keyNotRecognised);

  if (key.startsWith(FREE_KEY_PREFIX)) {
    const row = await lookupFreeKey(key);
    if (!row) return back(COPY_H.keyNotRecognised);
    if (!row.email) return back(COPY_H.keyEphemeral);
    const identity = await resolveSigninIdentity(row.email);
    if (identity.outcome === 'INDETERMINATE' || !identity.key) return back(COPY_H.busy);
    return bindAndContinue(res, pending, identity, row.email.trim().toLowerCase(), 'key');
  }
  // A paid key: the identity is its Stripe customer's email. A null customer for a key that just
  // resolved PAID is INDETERMINATE (I-10) — never a bare-key identity; no email on file → the key.
  const customer = await resolveCustomerByApiKey(key);
  if (!customer) return back(COPY_H.busy);
  const plan = license.tier;
  if (customer.email) {
    const email = customer.email.trim().toLowerCase();
    const bound = await bindPendingIdentity(pending.id, { kind: 'email', value: email, via: 'key', plan });
    if (!bound) return expired(res);
  } else {
    const bound = await bindPendingIdentity(pending.id, { kind: 'key', value: key, via: 'key', plan });
    if (!bound) return expired(res);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(303, `/oauth/consent?r=${encodeURIComponent(pending.id)}`);
}

// ── consent (R2.10) ────────────────────────────────────────────────────────

function redirectHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.slice(0, -1);
  } catch {
    return 'the app';
  }
}

function planLabel(plan: string | null): string {
  if (!plan || plan === 'FREE') return 'Free';
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

async function consentPage(req: Request, res: Response): Promise<void> {
  const pending = await livePendingFrom(req);
  if (!pending || !pending.identity_kind || !pending.identity_value) return expired(res);
  const client = await oauthClientsStore.getClient(pending.client_id);
  if (!client) return expired(res);
  const accountLabel = pending.identity_kind === 'email' ? pending.identity_value : `your API key ending ${pending.identity_value.slice(-4)}`;
  sendPage(res, 200, renderConsentPage({
    clientLabel: clientLabel(client),
    accountLabel,
    planLabel: planLabel(pending.plan),
    redirectHost: redirectHost(pending.redirect_uri),
    loopback: isLoopbackRedirect(pending.redirect_uri),
    pendingId: pending.id,
    csrf: pending.csrf_token,
  }));
}

async function consentDecision(req: Request, res: Response): Promise<void> {
  const pending = await livePendingFrom(req);
  if (!pending || !pending.identity_kind || !pending.identity_value) return expired(res);
  const csrf = String((req.body as Record<string, unknown>)?.csrf ?? '');
  const want = Buffer.from(pending.csrf_token);
  const got = Buffer.from(csrf);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return expired(res);
  const consumed = await consumePending(pending.id);
  if (!consumed) return expired(res);
  const client = await oauthClientsStore.getClient(consumed.client_id);
  if (!client) return expired(res);
  if ((req.body as Record<string, unknown>)?.decision === 'allow') return issueCodeAndHandOff(res, consumed, client);
  return handOffError(res, consumed, 'access_denied');
}

/** A page handler never throws: a fault after the pending row is known hands the client back. */
function page(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`[oauth] ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (res.headersSent) return;
      busy(res);
    }
  };
}

/**
 * Mount everything when the mode is not `off`; prints the boot line either way. Awaits the schema
 * ensure — a failure is logged and trips the breaker (`oauthHealthy()` false), and the routes
 * still mount: each store call then answers its own refusal, never a crash.
 */
export async function mountOAuth(app: Express, mode: OAuthMode = resolveOAuthMode()): Promise<OAuthMode> {
  console.log(`[oauth] mode=${mode}`);
  if (mode === 'off') return mode;
  try {
    await ensureOAuthSchema();
  } catch (err) {
    console.error(`[oauth] schema ensure failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    res.setHeader('Cache-Control', METADATA_CACHE_CONTROL);
    res.json(protectedResourceMetadata(req.originalUrl));
  });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.setHeader('Cache-Control', METADATA_CACHE_CONTROL);
    res.json(authorizationServerMetadata());
  });

  app.use('/authorize', browserLimiter('authorize'), issOnAuthorizeRedirects, authorizationHandler({ provider: oauthProvider, rateLimit: false }), oauthErrorMapper);
  app.use('/token', express.urlencoded({ extended: false, limit: '8kb' }), tokenLimiter(), refuseClientAssertion, tokenHandler({ provider: oauthProvider, rateLimit: false }), oauthErrorMapper);
  app.use('/register', perIpExemptLimiter('register'), express.json({ limit: '16kb' }), clientRegistrationHandler({ clientsStore: oauthClientsStore, rateLimit: false }), oauthErrorMapper);
  app.use('/revoke', perIpExemptLimiter('revoke'), express.urlencoded({ extended: false, limit: '8kb' }), refuseClientAssertion, revocationHandler({ provider: oauthProvider, rateLimit: false }), oauthErrorMapper);

  const form = express.urlencoded({ extended: false, limit: '4kb' });
  app.post('/oauth/connect/email', browserLimiter('oauth'), form, page(emailStart), oauthErrorMapper);
  app.post('/oauth/connect/email/verify', browserLimiter('oauth'), form, page(emailVerify), oauthErrorMapper);
  app.post('/oauth/connect/key', browserLimiter('oauth'), form, page(keyPath), oauthErrorMapper);
  app.get('/oauth/consent', browserLimiter('oauth'), page(consentPage));
  app.post('/oauth/consent', browserLimiter('oauth'), form, page(consentDecision), oauthErrorMapper);
  return mode;
}
