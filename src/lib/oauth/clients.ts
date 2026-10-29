/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — who a client is (R2.4): CIMD first, DCR otherwise.
 *
 * An `https://` client_id is a Client ID Metadata Document: we GET it through the shared egress
 * guard — `resolveAndAssertEgress` validates every resolved address and returns the one to PIN, and
 * `egressGet` dials only that address, never follows a redirect, asks for and accepts only the
 * identity encoding, and stops reading at 5 KB. The document's `client_id` must equal the URL as a
 * RAW string before the SDK's schema ever sees it (C15). Fresh for 24 h in `oauth_cimd_cache`, and
 * served stale when a refetch fails — a CDN blip at the client must not sign anyone out.
 *
 * Anything else is a DCR row (I-5): public clients only. An explicit non-`none` auth method is
 * refused; an omitted one becomes `none`, and the secret the SDK generated for it is stripped
 * before it is stored or returned. Grants we do not issue (Claude's document lists `jwt-bearer`)
 * are tolerated and never issued.
 *
 * GROWTH-AGENT-SIGNIN-OAUTH-W2 — auth-method NEGOTIATION, per OpenAI's CIMD contract: a client's
 * plural `token_endpoint_auth_methods_supported` is what it CAN use, our
 * `TOKEN_ENDPOINT_AUTH_METHODS` is what we accept, and the method is the first of ours in their
 * list; the legacy singular decides only when the plural is absent. ChatGPT publishes singular
 * `private_key_jwt` with plural `["none","private_key_jwt"]`, so it becomes a public PKCE client —
 * Claude's footing. A document offering only methods we do not verify stays refused. The plural is
 * read from the RAW document: the SDK schema is `.strip()` (1.29.0) and never passes it through.
 */
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { egressGet, resolveAndAssertEgress } from '../webhook-ssrf.js';
import { TOKEN_ENDPOINT_AUTH_METHODS } from './metadata.js';
import { getCimd, getDcrClient, insertDcrClient, isoAt, putCimd } from './store.js';

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 3_000;
const CIMD_FRESH_MS = 24 * 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/**
 * The redirect URIs we register: `https`, `http` on a loopback host, or a reverse-DNS private-use
 * scheme (`com.example.app:/cb` — a dot in the scheme). No fragment, no userinfo. Returns why a URI
 * is refused, or null to accept.
 */
export function redirectUriRefusal(uri: unknown): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) return 'not-a-string';
  if (uri.includes('#')) return 'fragment';
  if (/[\u0000- \u007f]/.test(uri)) return 'whitespace';
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'not-a-url';
  }
  if (u.username || u.password) return 'userinfo';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname) ? null : 'http-not-loopback';
  const scheme = u.protocol.slice(0, -1);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/i.test(scheme) ? null : 'scheme';
}

export function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** The label people see: the CIMD URL's host, or `{client_name} (unverified app)` (§Copy C). */
export function clientLabel(client: OAuthClientInformationFull): string {
  if (isCimdClientId(client.client_id)) {
    try {
      return new URL(client.client_id).host;
    } catch {
      /* fall through */
    }
  }
  const name = typeof client.client_name === 'string' && client.client_name.trim() ? client.client_name.trim().slice(0, 60) : 'Unnamed app';
  return `${name} (unverified app)`;
}

/**
 * The token-endpoint auth method we would use with a client offering `offered`: the first of OUR
 * methods it lists (our preference order, never theirs), or null when the two share none.
 */
export function negotiateAuthMethod(offered: readonly string[]): string | null {
  return TOKEN_ENDPOINT_AUTH_METHODS.find((m) => offered.includes(m)) ?? null;
}

/**
 * What a raw CIMD document offers: the plural when it is a non-empty array of strings, else the
 * singular, else — a document naming no method — whatever we accept (W1 read an omitted method as
 * a public client, and still does).
 */
function offeredAuthMethods(raw: Record<string, unknown>): readonly string[] {
  const plural = raw.token_endpoint_auth_methods_supported;
  if (Array.isArray(plural) && plural.length > 0 && plural.every((m) => typeof m === 'string')) return plural;
  const singular = raw.token_endpoint_auth_method;
  return typeof singular === 'string' ? [singular] : TOKEN_ENDPOINT_AUTH_METHODS;
}

/** The host a client is reached at, for `oauth_authorized` / `oauth_active` — never a path or id. */
export function clientHost(clientId: string): string {
  if (!isCimdClientId(clientId)) return 'dcr';
  try {
    return new URL(clientId).host;
  } catch {
    return 'unknown';
  }
}

// ── CIMD ───────────────────────────────────────────────────────────────────

export interface CimdDeps {
  resolve: typeof resolveAndAssertEgress;
  get: typeof egressGet;
}

const DEFAULT_DEPS: CimdDeps = { resolve: resolveAndAssertEgress, get: egressGet };
let deps: CimdDeps = DEFAULT_DEPS;

/** Test seam: inject the resolver / pinned GET. */
export function _setCimdDepsForTest(next: Partial<CimdDeps> | null): void {
  deps = next ? { ...DEFAULT_DEPS, ...next } : DEFAULT_DEPS;
}

/** Validate a fetched document for `clientId`; the parsed client, or null. */
export function parseCimdDocument(clientId: string, body: string): OAuthClientInformationFull | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // C15: raw string equality BEFORE the schema — a parse that normalised the URL must not decide it.
  if ((raw as Record<string, unknown>).client_id !== clientId) return null;
  // W2: negotiated on the RAW document too — the schema below strips the plural.
  const method = negotiateAuthMethod(offeredAuthMethods(raw as Record<string, unknown>));
  if (method === null) return null;
  const parsed = OAuthClientMetadataSchema.safeParse(raw);
  if (!parsed.success) return null;
  const meta = parsed.data;
  if (meta.redirect_uris.length === 0 || meta.redirect_uris.some((u) => redirectUriRefusal(u) !== null)) return null;
  return { ...meta, client_id: clientId, token_endpoint_auth_method: method };
}

async function fetchCimd(clientId: string): Promise<string | null> {
  try {
    const u = new URL(clientId);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.pathname === '/') return null;
    const pin = await deps.resolve(clientId);
    const res = await deps.get(clientId, {
      headers: { Accept: 'application/json' },
      timeoutMs: CIMD_TIMEOUT_MS,
      pin,
      maxBytes: CIMD_MAX_BYTES,
    });
    if (res.status !== 200) return null;
    return res.body;
  } catch {
    return null;
  }
}

async function getCimdClient(clientId: string, now: number): Promise<OAuthClientInformationFull | undefined> {
  const cached = await getCimd(clientId);
  const cachedClient = cached ? parseCimdDocument(clientId, cached.document_json) : null;
  if (cachedClient && now - Date.parse(cached!.fetched_at) < CIMD_FRESH_MS) return cachedClient;
  const body = await fetchCimd(clientId);
  const fresh = body === null ? null : parseCimdDocument(clientId, body);
  if (fresh) {
    await putCimd(clientId, JSON.stringify(fresh), now);
    return fresh;
  }
  // Stale on failure: the last good document keeps working while the client's host is down.
  return cachedClient ?? undefined;
}

// ── DCR ────────────────────────────────────────────────────────────────────

async function getDcr(clientId: string, now: number): Promise<OAuthClientInformationFull | undefined> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) return undefined;
  const row = await getDcrClient(clientId, now);
  if (!row) return undefined;
  try {
    return JSON.parse(row.metadata_json) as OAuthClientInformationFull;
  } catch {
    return undefined;
  }
}

async function registerDcr(
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & Partial<Pick<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>>,
): Promise<OAuthClientInformationFull> {
  // W2: the same negotiation as CIMD — an omitted method offers whatever we accept.
  const requested = client.token_endpoint_auth_method;
  const method = negotiateAuthMethod(requested === undefined ? TOKEN_ENDPOINT_AUTH_METHODS : [requested]);
  if (method === null) {
    throw new InvalidClientMetadataError(`Only public clients are supported: token_endpoint_auth_method must be ${TOKEN_ENDPOINT_AUTH_METHODS.join(' or ')}.`);
  }
  if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
    throw new InvalidClientMetadataError('At least one redirect_uri is required.');
  }
  for (const uri of client.redirect_uris) {
    if (redirectUriRefusal(uri) !== null) {
      throw new InvalidClientMetadataError('Each redirect_uri must be https, http on a loopback host, or a private-use scheme, with no fragment.');
    }
  }
  if (typeof client.client_id !== 'string') throw new InvalidClientMetadataError('client_id generation is required.');
  // I-5 / C15: whatever secret the SDK generated for an omitted method is dropped here, before it
  // is stored or returned — a public client never holds one.
  const { client_secret: _secret, client_secret_expires_at: _expires, ...rest } = client;
  const stored: OAuthClientInformationFull = { ...rest, client_id: client.client_id, token_endpoint_auth_method: method };
  const now = Date.now();
  await insertDcrClient({
    client_id: stored.client_id,
    client_name: typeof stored.client_name === 'string' ? stored.client_name.slice(0, 200) : null,
    redirect_uris_json: JSON.stringify(stored.redirect_uris),
    metadata_json: JSON.stringify(stored),
    created_at: isoAt(now),
    last_used_at: isoAt(now),
  });
  return stored;
}

export const oauthClientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string) {
    const now = Date.now();
    return isCimdClientId(clientId) ? getCimdClient(clientId, now) : getDcr(clientId, now);
  },
  registerClient: registerDcr as OAuthRegisteredClientsStore['registerClient'],
};
