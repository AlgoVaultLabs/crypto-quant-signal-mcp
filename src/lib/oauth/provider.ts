/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — our `OAuthServerProvider` behind the SDK 1.29.0 handlers.
 *
 * AUTHORIZE (R2.6): a pending row + the `av_mcp_authz` cookie + the connect page. EVERY error inside
 * it is caught and handed back to the client with `iss` + `state` (C9). The SDK's own Phase-2
 * schema refusals (PKCE `plain`, a missing challenge) get theirs from `routes.ts` (W2).
 *
 * TOKENS (R2.11): opaque `avat_` / `avrt_` + 48 hex, SHA-256 at rest, every claim an awaited
 * `UPDATE … RETURNING` in `store.ts`, so exactly one concurrent caller wins each. A code presented
 * twice revokes every token it issued (C17). A rotated refresh token presented again inside 60 s
 * gets the SAME successor pair from process memory; after 60 s the family is revoked; a restart
 * inside the window answers `invalid_grant` and revokes nothing — losing state is not reuse (I-18).
 * `/token` never calls Stripe or Resend: the identity is resolved on `/mcp`, not here.
 *
 * HAND-OFF (R2.10): every authorization response — code, `access_denied`, `temporarily_unavailable`
 * — carries `iss=https://api.algovault.com` and goes out through `sendOffOriginRedirect`, never a
 * 3xx after a form POST (CSP `form-action 'self'` refuses those silently).
 */
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { sendOffOriginRedirect } from '../off-origin-redirect.js';
import { getAuthProvider, isNewSignupEnabled } from '../auth-providers.js';
import { hashIp } from '../analytics.js';
import { recordFunnelEvent } from '../performance-db.js';
import { clientHost, clientLabel, oauthClientsStore } from './clients.js';
import { OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_SCOPES, isOurResource } from './mode.js';
import { COPY_H, renderConnectPage } from './pages.js';
import {
  claimCode,
  getCode,
  getToken,
  insertCode,
  insertPending,
  insertToken,
  isoAt,
  purgeExpired,
  revokeByCode,
  revokeFamily,
  rotateRefresh,
  sha256Hex,
  type PendingRow,
  type TokenRow,
} from './store.js';

export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 90 * 24 * 60 * 60;
export const CODE_TTL_MS = 60 * 1000;
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const REFRESH_GRACE_MS = 60 * 1000;
export const AUTHZ_COOKIE = 'av_mcp_authz';

export function newOpaque(prefix: 'avat_' | 'avrt_'): string {
  return `${prefix}${randomBytes(24).toString('hex')}`;
}

export function newId(): string {
  return randomBytes(18).toString('base64url');
}

// ── in-process state (one container serves /mcp) ───────────────────────────

export interface AccessGrant {
  familyId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  identityKind: string;
  identityValue: string;
  expiresAt: number;
}

/** Fresh access hashes, so a client's immediate retry resolves without a store round trip. */
const freshAccess = new Map<string, AccessGrant>();
/** Old refresh hash → the successor pair it rotated into (60 s grace). */
const refreshGrace = new Map<string, { tokens: OAuthTokens; at: number; clientId: string; familyId: string }>();
/** Codes whose replay lost the claim; the winner revokes after it inserts (C17 race). */
const replayedCodes = new Set<string>();
const revokedFamilies = new Set<string>();

function sweep(now: number): void {
  for (const [k, v] of freshAccess) if (v.expiresAt <= now) freshAccess.delete(k);
  for (const [k, v] of refreshGrace) if (now - v.at > REFRESH_GRACE_MS) refreshGrace.delete(k);
  if (freshAccess.size > 20_000) freshAccess.clear();
  if (revokedFamilies.size > 20_000) revokedFamilies.clear();
  if (replayedCodes.size > 20_000) replayedCodes.clear();
}

/** The access grant for `hash` from process memory, unless its family was revoked here. */
export function freshAccessGrant(hash: string, now: number = Date.now()): AccessGrant | null {
  const g = freshAccess.get(hash);
  if (!g || g.expiresAt <= now || revokedFamilies.has(g.familyId)) return null;
  return g;
}

export function isFamilyRevokedHere(familyId: string): boolean {
  return revokedFamilies.has(familyId);
}

/** Test seam: what a restart loses. */
export function _resetProviderMemoryForTest(): void {
  freshAccess.clear();
  refreshGrace.clear();
  replayedCodes.clear();
  revokedFamilies.clear();
}

// ── hand-off ───────────────────────────────────────────────────────────────

/**
 * Send the browser back to `redirectUri` with `params` + `state` + `iss`. An https target uses the
 * hand-off's existing mode; loopback and private-use targets the explicit OAuth mode, which accepts
 * only this already-validated URI.
 */
export function handOff(
  res: Response,
  label: string,
  redirectUri: string,
  params: Record<string, string>,
  state: string | null | undefined,
): void {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', OAUTH_ISSUER);
  const copy = { title: COPY_H.handoffTitle, body: COPY_H.handoffBody(label), cta: COPY_H.handoffCta(label) };
  sendOffOriginRedirect(res, url.href, copy, redirectUri.startsWith('https:') ? undefined : { redirectUri });
}

export async function handOffError(
  res: Response,
  pending: Pick<PendingRow, 'client_id' | 'redirect_uri' | 'state'>,
  error: 'access_denied' | 'temporarily_unavailable',
): Promise<void> {
  let label = 'the app';
  try {
    const client = await oauthClientsStore.getClient(pending.client_id);
    if (client) label = clientLabel(client);
  } catch {
    /* the label is cosmetic; the hand-off still goes */
  }
  handOff(res, label, pending.redirect_uri, { error }, pending.state);
}

// ── codes ──────────────────────────────────────────────────────────────────

/** Allow on the consent page: a single-use code bound to everything the token exchange checks. */
export async function issueCodeAndHandOff(res: Response, pending: PendingRow, client: OAuthClientInformationFull): Promise<void> {
  const code = randomBytes(32).toString('base64url');
  const now = Date.now();
  await insertCode({
    code_hash: sha256Hex(code),
    pending_id: pending.id,
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    redirect_uri_explicit: pending.redirect_uri_explicit,
    code_challenge: pending.code_challenge,
    resource: pending.resource,
    scopes: pending.scopes,
    identity_kind: pending.identity_kind!,
    identity_value: pending.identity_value!,
    via: pending.via ?? 'unknown',
    plan: pending.plan ?? 'FREE',
    created_at: isoAt(now),
    expires_at: isoAt(now + CODE_TTL_MS),
  });
  handOff(res, clientLabel(client), pending.redirect_uri, { code }, pending.state);
}

// ── the provider ───────────────────────────────────────────────────────────

function oauthTokens(access: string, refresh: string, scopes: string): OAuthTokens {
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes };
}

async function issuePair(
  base: { clientId: string; resource: string; scopes: string; identityKind: string; identityValue: string; codeHash: string | null },
  familyId: string,
  parentHash: string | null,
  now: number,
): Promise<OAuthTokens> {
  const access = newOpaque('avat_');
  const refresh = newOpaque('avrt_');
  const accessHash = sha256Hex(access);
  const common = {
    family_id: familyId,
    code_hash: base.codeHash,
    client_id: base.clientId,
    resource: base.resource,
    scopes: base.scopes,
    identity_kind: base.identityKind,
    identity_value: base.identityValue,
    parent_hash: parentHash,
    created_at: isoAt(now),
  };
  await insertToken({ ...common, token_hash: accessHash, kind: 'access', expires_at: isoAt(now + ACCESS_TTL_S * 1000) });
  await insertToken({ ...common, token_hash: sha256Hex(refresh), kind: 'refresh', expires_at: isoAt(now + REFRESH_TTL_S * 1000) });
  sweep(now);
  freshAccess.set(accessHash, {
    familyId,
    clientId: base.clientId,
    resource: base.resource,
    scopes: base.scopes.split(' ').filter(Boolean),
    identityKind: base.identityKind,
    identityValue: base.identityValue,
    expiresAt: now + ACCESS_TTL_S * 1000,
  });
  return oauthTokens(access, refresh, base.scopes);
}

async function revokeFamilyEverywhere(familyId: string): Promise<void> {
  revokedFamilies.add(familyId);
  for (const [k, v] of freshAccess) if (v.familyId === familyId) freshAccess.delete(k);
  await revokeFamily(familyId);
}

/**
 * A replayed code: revoke what it issued in the store AND in this process's fresh-access map —
 * otherwise a just-issued access token keeps resolving from memory for its whole hour.
 */
async function revokeCodeEverywhere(codeHash: string, now: number = Date.now()): Promise<void> {
  replayedCodes.add(codeHash);
  for (const familyId of await revokeByCode(codeHash, now)) {
    revokedFamilies.add(familyId);
    for (const [k, v] of freshAccess) if (v.familyId === familyId) freshAccess.delete(k);
  }
}

function requestedRedirectWasExplicit(res: Response): boolean {
  const req = res.req;
  const source = (req?.method === 'POST' ? req.body : req?.query) as Record<string, unknown> | undefined;
  return typeof source?.redirect_uri === 'string';
}

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return oauthClientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const label = clientLabel(client);
    try {
      void purgeExpired().catch(() => undefined);
      const scopes = params.scopes && params.scopes.length > 0 ? params.scopes : ['mcp:tools'];
      if (scopes.some((s) => !OAUTH_SCOPES.includes(s))) {
        return handOff(res, label, params.redirectUri, { error: 'invalid_scope' }, params.state);
      }
      // RFC 8707: present → must name /mcp by origin + path (its query is kept for attribution).
      if (params.resource && !isOurResource(params.resource)) {
        return handOff(res, label, params.redirectUri, { error: 'invalid_target' }, params.state);
      }
      const resource = params.resource ? params.resource.href : OAUTH_RESOURCE;
      const id = newId();
      const now = Date.now();
      await insertPending({
        id,
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        redirect_uri_explicit: requestedRedirectWasExplicit(res) ? 1 : 0,
        code_challenge: params.codeChallenge,
        state: params.state ?? null,
        scopes: scopes.join(' '),
        resource,
        csrf_token: newId(),
        created_at: isoAt(now),
        expires_at: isoAt(now + PENDING_TTL_MS),
      });
      const signup = isNewSignupEnabled();
      const live = (id: 'google' | 'github'): boolean => {
        try {
          return getAuthProvider(id).live;
        } catch {
          return false;
        }
      };
      res.setHeader('Set-Cookie', `${AUTHZ_COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(
        renderConnectPage({
          clientLabel: label,
          pendingId: id,
          providers: { google: signup && live('google'), github: signup && live('github') },
        }),
      );
    } catch (err) {
      console.error(`[oauth] authorize failed: ${err instanceof Error ? err.message : String(err)}`);
      handOff(res, label, params.redirectUri, { error: 'temporarily_unavailable' }, params.state);
    }
  },

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const hash = sha256Hex(authorizationCode);
    const row = await getCode(hash);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('The authorization code is invalid.');
    if (row.used_at) {
      // C16 + C17: a code seen twice is a replay — everything it issued is revoked.
      await revokeCodeEverywhere(hash);
      throw new InvalidGrantError('The authorization code was already used.');
    }
    if (Date.parse(row.expires_at) <= Date.now()) throw new InvalidGrantError('The authorization code expired.');
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256Hex(authorizationCode);
    const now = Date.now();
    const row = await claimCode(hash, now);
    if (!row) {
      // Lost the atomic claim: a concurrent or later replay. Revoke what the winner issued.
      await revokeCodeEverywhere(hash, now);
      throw new InvalidGrantError('The authorization code is invalid, expired or already used.');
    }
    if (row.client_id !== client.client_id) throw new InvalidGrantError('The authorization code was issued to another client.');
    // C10 / I-4: required and identical iff the authorize request carried it; identical whenever sent.
    if (row.redirect_uri_explicit === 1 && redirectUri === undefined) throw new InvalidGrantError('redirect_uri is required.');
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    // I-3: the token is for /mcp, by origin + path.
    if (resource !== undefined && !(isOurResource(resource) && isOurResource(row.resource))) {
      throw new InvalidGrantError('resource does not match the authorization request.');
    }
    const tokens = await issuePair(
      { clientId: row.client_id, resource: row.resource, scopes: row.scopes, identityKind: row.identity_kind, identityValue: row.identity_value, codeHash: hash },
      newId(),
      null,
      now,
    );
    if (replayedCodes.has(hash)) await revokeCodeEverywhere(hash);
    try {
      recordFunnelEvent({
        eventType: 'oauth_authorized',
        sessionId: hashIp(`oauth-identity:${row.identity_value}`),
        licenseTier: row.plan === 'FREE' ? 'free' : row.plan.toLowerCase(),
        meta: { client_host: clientHost(row.client_id), outcome: row.plan === 'FREE' ? 'FREE' : 'PAID', via: row.via },
      });
    } catch {
      /* best-effort */
    }
    return tokens;
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256Hex(refreshToken);
    const now = Date.now();
    const grace = refreshGrace.get(hash);
    if (grace && grace.clientId === client.client_id && now - grace.at <= REFRESH_GRACE_MS && !revokedFamilies.has(grace.familyId)) return grace.tokens;
    const tok: TokenRow | null = await getToken(hash);
    if (!tok || tok.kind !== 'refresh' || tok.client_id !== client.client_id || tok.revoked_at) {
      throw new InvalidGrantError('The refresh token is invalid.');
    }
    if (tok.rotated_at) {
      // Presented again after rotation. Inside the window with no memory of it = a restart (I-18).
      if (now - Date.parse(tok.rotated_at) > REFRESH_GRACE_MS) await revokeFamilyEverywhere(tok.family_id);
      throw new InvalidGrantError('The refresh token was already used.');
    }
    if (Date.parse(tok.expires_at) <= now) throw new InvalidGrantError('The refresh token expired.');
    if (resource !== undefined && !isOurResource(resource)) throw new InvalidGrantError('resource does not match the grant.');
    const granted = tok.scopes.split(' ').filter(Boolean);
    if (scopes && scopes.some((s) => !granted.includes(s))) throw new InvalidScopeError('The requested scope exceeds the grant.');
    const claimed = await rotateRefresh(hash, now);
    if (!claimed) {
      const raced = refreshGrace.get(hash);
      if (raced && raced.clientId === client.client_id && !revokedFamilies.has(raced.familyId)) return raced.tokens;
      throw new InvalidGrantError('The refresh token was already used.');
    }
    const tokens = await issuePair(
      { clientId: tok.client_id, resource: tok.resource, scopes: tok.scopes, identityKind: tok.identity_kind, identityValue: tok.identity_value, codeHash: tok.code_hash },
      tok.family_id,
      hash,
      now,
    );
    refreshGrace.set(hash, { tokens, at: now, clientId: client.client_id, familyId: tok.family_id });
    return tokens;
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = sha256Hex(token);
    const fresh = freshAccessGrant(hash);
    if (fresh) {
      return { token, clientId: fresh.clientId, scopes: fresh.scopes, expiresAt: Math.floor(fresh.expiresAt / 1000), resource: new URL(fresh.resource) };
    }
    const row = await getToken(hash);
    if (!row || row.kind !== 'access' || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
      throw new InvalidTokenError('The access token is invalid or expired.');
    }
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' ').filter(Boolean),
      expiresAt: Math.floor(Date.parse(row.expires_at) / 1000),
      resource: new URL(row.resource),
    };
  },

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // RFC 7009: an unknown token, or another client's, is answered 200 with nothing revoked.
    const row = await getToken(sha256Hex(request.token));
    if (!row || row.client_id !== client.client_id) return;
    await revokeFamilyEverywhere(row.family_id);
  },
};
