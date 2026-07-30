/**
 * Admin authorization sources — OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch1 (SEC-10).
 *
 * WHY THIS EXISTS. `ADMIN_API_KEY` used to be an accepted authorization source
 * straight off `req.query.key`, and the payout page then re-embedded that same key
 * into the rendered HTML as a form action. So the credential that authorizes
 * `POST /admin/referrals/payouts/approve-all` — a step the UI itself labels
 * irreversible because it sends USDC on Base — persisted in the operator's browser
 * history and address bar, and in every access log along the way. Copying that URL
 * into a ticket, chat or screenshot disclosed a working credential, and because the
 * key was accepted FROM the query string, the leaked URL was directly replayable.
 *
 * THE RULE: a URL key may BOOTSTRAP a session; it may never AUTHORIZE a request.
 *
 *   • `resolveAdminAuth` accepts a Bearer token or a valid session cookie. It does
 *     not read the query string at all — there is no branch in which `?key=` grants
 *     access, which is what makes the leaked-URL replay structurally impossible.
 *   • The bootstrap (`buildAdminSessionCookie` + a 303 to the clean path) is the one
 *     sanctioned place a URL key is read. It exchanges the key for an HttpOnly
 *     cookie and immediately redirects, so the key never survives in the address bar
 *     and never reaches a rendered page.
 *
 * Extracted to its own leaf module because the predicate previously lived in a
 * closure inside `index.ts`, which boots the server at import — so it could not be
 * unit-tested at all. This is the seam that makes the rule assertable.
 */

export const ADMIN_COOKIE_NAME = 'av_admin_session';
export const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How the request was authorized — `none` means it was not. */
export type AdminAuthVia = 'bearer' | 'cookie' | 'none';

export interface AdminAuthInput {
  authorization?: string | string[] | undefined;
  cookie?: string | undefined;
}

export interface AdminAuthDeps {
  adminKey: string;
  /** Constant-time comparison (index.ts `safeCompare`), injected so this stays pure. */
  compare: (a: string, b: string) => boolean;
  isValidSession: (cookieHeader?: string) => boolean;
}

/** Strip a `Bearer ` prefix from an Authorization header value. */
export function bearerToken(authorization?: string | string[] | undefined): string {
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof raw !== 'string') return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Resolve admin authorization from Bearer + session cookie ONLY.
 *
 * Deliberately takes no query input: the absence of that parameter is the fix. A
 * future caller cannot re-introduce URL-key auth by passing it in.
 */
export function resolveAdminAuth(input: AdminAuthInput, deps: AdminAuthDeps): { authorized: boolean; via: AdminAuthVia } {
  const token = bearerToken(input.authorization);
  if (token && deps.adminKey && deps.compare(token, deps.adminKey)) {
    return { authorized: true, via: 'bearer' };
  }
  if (deps.isValidSession(input.cookie)) return { authorized: true, via: 'cookie' };
  return { authorized: false, via: 'none' };
}

/** The single derivation of the admin session cookie (was duplicated at 3 call sites). */
export function buildAdminSessionCookie(token: string, opts?: { secure?: boolean; ttlMs?: number }): string {
  const ttl = opts?.ttlMs ?? ADMIN_SESSION_TTL_MS;
  return (
    `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; ` +
    `Max-Age=${Math.floor(ttl / 1000)}${opts?.secure ? '; Secure' : ''}`
  );
}

/** 401 body for a route that HAS a `?key=` bootstrap (an operator can just open it). */
export const ADMIN_UNAUTHORIZED_PAGE =
  'Unauthorized — add ?key=YOUR_ADMIN_KEY to the URL (it is exchanged for a session cookie and removed from the address bar).';

/** 401 body for a route with NO bootstrap (POST / JSON): Bearer or an existing cookie. */
export const ADMIN_UNAUTHORIZED_API =
  'Unauthorized — send `Authorization: Bearer YOUR_ADMIN_KEY`, or open an admin page with ?key= once to set the session cookie. A key in the query string is no longer accepted as authorization.';
