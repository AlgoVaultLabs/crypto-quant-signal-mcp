/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — the ONE OAuth mode resolver.
 *
 * `MCP_OAUTH` unset or anything unknown is `off`, and `off` is today: none of the nine OAuth paths
 * is mounted (every one answers the app's own 404, byte-identical), and an `avat_` bearer reaching
 * `/mcp` is MALFORMED and served exactly as before. That makes the env value the one-value rollback
 * lever. Every consumer — the mount, token resolution on `/mcp`, the CH3 challenge, the canary and
 * the readout — reads this function, never the env var directly.
 *
 * LEAF: no imports, so `license.ts` can consult it on every request without closing a cycle.
 */
export type OAuthMode = 'off' | 'optin' | 'wall';

export function resolveOAuthMode(env: NodeJS.ProcessEnv = process.env): OAuthMode {
  const v = (env.MCP_OAUTH ?? '').trim().toLowerCase();
  return v === 'optin' || v === 'wall' ? v : 'off';
}

/** The one string every `iss` we issue equals — no trailing slash (RFC 9207, F7). */
export const OAUTH_ISSUER = 'https://api.algovault.com';

/** The protected resource, by origin + path. A token's audience is compared on these two only. */
export const OAUTH_RESOURCE = 'https://api.algovault.com/mcp';

export const OAUTH_RESOURCE_SCOPES: readonly string[] = ['mcp:tools'];
export const OAUTH_SCOPES: readonly string[] = ['mcp:tools', 'offline_access'];

/** True iff `value` names `OAUTH_RESOURCE` by origin + path (the query is ignored). */
export function isOurResource(value: string | URL | null | undefined): boolean {
  if (value == null) return false;
  try {
    const u = typeof value === 'string' ? new URL(value) : value;
    const ours = new URL(OAUTH_RESOURCE);
    return u.origin === ours.origin && u.pathname === ours.pathname;
  } catch {
    return false;
  }
}
