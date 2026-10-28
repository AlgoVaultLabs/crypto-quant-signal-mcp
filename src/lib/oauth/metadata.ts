/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — our discovery documents (R2.2), not the SDK's
 * `createOAuthMetadata`: the SDK has no CIMD or `iss` flags and cannot echo the resource query.
 *
 * PRM `resource` must equal the URL "as the user enters it in Claude, including any path
 * component" (F5), and our docs tell people to add `…/mcp?src=docs`. RFC 9728 §3.1 puts the
 * well-known segment between host and path, so that query reaches the PRM request — we echo it
 * back, allow-listed: keys `src` and `signin` only, values `^[A-Za-z0-9_-]{1,40}$`, original order,
 * anything else dropped. Both documents are validated against the SDK's own schemas in tests.
 */
import { OAUTH_ISSUER, OAUTH_RESOURCE, OAUTH_RESOURCE_SCOPES, OAUTH_SCOPES } from './mode.js';

const ECHO_KEYS = new Set(['src', 'signin']);
const ECHO_VALUE = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * The allow-listed query, as `?k=v&…` or `''`. `rawUrl` is the request's `originalUrl`, read as
 * a string so the caller's order survives (Express's parsed `req.query` would lose duplicates).
 */
export function echoedQuery(rawUrl: string): string {
  const q = rawUrl.indexOf('?');
  if (q === -1) return '';
  const out: string[] = [];
  for (const [k, v] of new URLSearchParams(rawUrl.slice(q + 1))) {
    if (ECHO_KEYS.has(k) && ECHO_VALUE.test(v)) out.push(`${k}=${v}`);
  }
  return out.length > 0 ? `?${out.join('&')}` : '';
}

/** RFC 9728 document for `/.well-known/oauth-protected-resource{,/mcp}`. */
export function protectedResourceMetadata(rawUrl: string): Record<string, unknown> {
  return {
    resource: `${OAUTH_RESOURCE}${echoedQuery(rawUrl)}`,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_RESOURCE_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'AlgoVault',
  };
}

/**
 * The PRM URL a `WWW-Authenticate` challenge names, carrying the same echoed query. CH2's
 * TOKEN_INVALID 401 and CH3's challenge both build it here, so the two can never disagree.
 */
export function protectedResourceMetadataUrl(rawUrl: string): string {
  return `${OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp${echoedQuery(rawUrl)}`;
}

/**
 * CH3 — the ONE Bearer challenge both `/mcp` 401s send: `applyCredentialRefusal`'s TOKEN_INVALID
 * and the sign-in challenge. Status, header grammar, `no-store` and the body's first two keys are
 * built here and nowhere else, so the two 401s cannot drift; only the description and the optional
 * `algovault` object differ. `description` must stay inside RFC 6750 §3's `error_description`
 * charset (printable ASCII without `"` or `\`) — both callers pass constants a test pins.
 */
export function bearerChallengeHeader(rawUrl: string, description: string): string {
  return `Bearer error="invalid_token", error_description="${description}", scope="mcp:tools", resource_metadata="${protectedResourceMetadataUrl(rawUrl)}"`;
}

export interface BearerChallengeResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export function sendBearerChallenge(
  res: BearerChallengeResponse,
  rawUrl: string,
  description: string,
  algovault?: Record<string, unknown>,
): void {
  res.setHeader('WWW-Authenticate', bearerChallengeHeader(rawUrl, description));
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json(
    algovault === undefined
      ? { error: 'invalid_token', error_description: description }
      : { error: 'invalid_token', error_description: description, algovault },
  );
}

/** RFC 8414 document for `/.well-known/oauth-authorization-server`. */
export function authorizationServerMetadata(): Record<string, unknown> {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/token`,
    registration_endpoint: `${OAUTH_ISSUER}/register`,
    revocation_endpoint: `${OAUTH_ISSUER}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...OAUTH_SCOPES],
  };
}

export const METADATA_CACHE_CONTROL = 'public, max-age=300';
