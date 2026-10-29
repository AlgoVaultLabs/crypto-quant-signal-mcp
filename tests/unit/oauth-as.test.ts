/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — the authorization server's pieces, one at a time: the two
 * metadata documents against the SDK's own schemas, the DDL against migrations/049, client identity
 * (CIMD + DCR), and the OAuth mode of the off-origin hand-off. The end-to-end flow is
 * `tests/integration/oauth-flow.test.ts`.
 *
 * The CIMD/DCR cases run on an ISOLATED SQLite (`PERFORMANCE_DB_PATH`), so no other file's rows
 * can perturb them and CI needs no database.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { closeDb } from '../../src/lib/performance-db.js';
import {
  authorizationServerMetadata,
  echoedQuery,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
} from '../../src/lib/oauth/metadata.js';
import { OAUTH_ISSUER, OAUTH_RESOURCE, isOurResource, resolveOAuthMode } from '../../src/lib/oauth/mode.js';
import { _resetOAuthStoreForTest, ensureOAuthSchema } from '../../src/lib/oauth/store.js';

const OAUTH_TABLES = ['oauth_clients', 'oauth_cimd_cache', 'oauth_pending', 'oauth_codes', 'oauth_tokens', 'email_otps'];
import {
  _setCimdDepsForTest,
  clientLabel,
  oauthClientsStore,
  parseCimdDocument,
  redirectUriRefusal,
} from '../../src/lib/oauth/clients.js';
import { sendOffOriginRedirect } from '../../src/lib/off-origin-redirect.js';
import { AUTH_REFUSAL_HTTP_CODES, refuseCredentialHttp } from '../../src/lib/credential-refusal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (name: string) => fs.readFileSync(path.join(ROOT, 'tests/fixtures/oauth', name), 'utf8');
const CLAUDE = fixture('claude-cimd.json');
const CLAUDE_CODE = fixture('claude-code-cimd.json');
const CLAUDE_ID = JSON.parse(CLAUDE).client_id as string;
const CLAUDE_CODE_ID = JSON.parse(CLAUDE_CODE).client_id as string;
// W2: byte-exact copies of ChatGPT's two live documents (fetched from inside the container, R0).
const CHATGPT_STABLE = fixture('chatgpt-stable-cimd.json');
const CHATGPT = fixture('chatgpt-cimd.json');
const CHATGPT_STABLE_ID = JSON.parse(CHATGPT_STABLE).client_id as string;
const CHATGPT_ID = JSON.parse(CHATGPT).client_id as string;

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-as-'));
let originalDbPath: string | undefined;

beforeAll(async () => {
  originalDbPath = process.env.PERFORMANCE_DB_PATH;
  process.env.PERFORMANCE_DB_PATH = path.join(DB_DIR, 'performance.db');
  closeDb();
  _resetOAuthStoreForTest();
  await ensureOAuthSchema();
});

afterAll(() => {
  closeDb();
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  if (originalDbPath === undefined) delete process.env.PERFORMANCE_DB_PATH;
  else process.env.PERFORMANCE_DB_PATH = originalDbPath;
});

afterEach(() => {
  _setCimdDepsForTest(null);
  vi.useRealTimers();
});

// ── metadata ────────────────────────────────────────────────────────────────

describe('metadata documents conform to the SDK schemas (SCHEMA_CONFORMANCE)', () => {
  it('RFC 9728 protected-resource metadata parses, and names our issuer + resource', () => {
    const doc = protectedResourceMetadata('/.well-known/oauth-protected-resource/mcp');
    const parsed = OAuthProtectedResourceMetadataSchema.parse(doc);
    expect(parsed.resource).toBe(OAUTH_RESOURCE);
    expect(parsed.authorization_servers).toEqual([OAUTH_ISSUER]);
    expect(parsed.scopes_supported).toEqual(['mcp:tools']);
  });

  it('RFC 8414 authorization-server metadata parses; S256 only, public clients only', () => {
    const parsed = OAuthMetadataSchema.parse(authorizationServerMetadata());
    expect(parsed.issuer).toBe(OAUTH_ISSUER);
    expect(parsed.code_challenge_methods_supported).toEqual(['S256']);
    expect(parsed.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(parsed.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(parsed.scopes_supported).toEqual(['mcp:tools', 'offline_access']);
    const raw = authorizationServerMetadata();
    expect(raw.client_id_metadata_document_supported).toBe(true);
    expect(raw.authorization_response_iss_parameter_supported).toBe(true);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) {
      expect(String(parsed[k]).startsWith(`${OAUTH_ISSUER}/`)).toBe(true);
    }
  });

  it('the echoed query is allow-listed: src + signin only, safe values only, order kept', () => {
    expect(echoedQuery('/mcp?src=docs&signin=1')).toBe('?src=docs&signin=1');
    expect(echoedQuery('/mcp?x=1&src=docs')).toBe('?src=docs');
    expect(echoedQuery('/mcp?src=%3Cscript%3E')).toBe('');
    expect(echoedQuery('/mcp')).toBe('');
    expect(protectedResourceMetadataUrl('/mcp?src=docs&evil=1')).toBe(
      `${OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp?src=docs`,
    );
    // …and the echoed resource is still OUR resource.
    expect(isOurResource(protectedResourceMetadata('/mcp?src=docs').resource as string)).toBe(true);
    expect(isOurResource('https://evil.example/mcp')).toBe(false);
  });

  it('MCP_OAUTH governs the mode: unset / unknown → off', () => {
    expect(resolveOAuthMode({})).toBe('off');
    expect(resolveOAuthMode({ MCP_OAUTH: 'banana' })).toBe('off');
    expect(resolveOAuthMode({ MCP_OAUTH: 'optin' })).toBe('optin');
  });
});

describe('REST: an OAuth token off /mcp is a 401 with ok:false (C12)', () => {
  it('refuseCredentialHttp(TOKEN_INVALID) → 401 { ok:false, code, error, suggested_action }', () => {
    let status = 0;
    let body: Record<string, unknown> = {};
    const res = { status(c: number) { status = c; return this; }, json(b: Record<string, unknown>) { body = b; return this; } };
    refuseCredentialHttp(res as never, 'TOKEN_INVALID');
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.code).toBe(AUTH_REFUSAL_HTTP_CODES.TOKEN_INVALID);
    expect(typeof body.error).toBe('string');
    expect(typeof body.suggested_action).toBe('string');
  });
});

// ── DDL parity ──────────────────────────────────────────────────────────────

describe('store DDL ≡ migrations/049_oauth.sql', () => {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

  it('every CREATE the lazy ensure runs is in the migration, verbatim', () => {
    const store = fs.readFileSync(path.join(ROOT, 'src/lib/oauth/store.ts'), 'utf8');
    const migration = norm(fs.readFileSync(path.join(ROOT, 'migrations/049_oauth.sql'), 'utf8'));
    const creates = [...store.matchAll(/[`'](CREATE (?:TABLE|INDEX)[^`']+)[`']/g)].map((m) => norm(m[1]));
    expect(creates.length).toBe(OAUTH_TABLES.length + 4);
    for (const c of creates) expect(migration, c.slice(0, 60)).toContain(c.replace(/;$/, ''));
  });

  it('the down migration drops every table the store owns', () => {
    const down = fs.readFileSync(path.join(ROOT, 'migrations/049_oauth.down.sql'), 'utf8');
    for (const t of OAUTH_TABLES) expect(down).toMatch(new RegExp(`DROP TABLE IF EXISTS ${t}\\b`));
  });
});

// ── redirect URIs ───────────────────────────────────────────────────────────

describe('redirect URIs', () => {
  it('registers https, loopback http and reverse-DNS private-use schemes only', () => {
    expect(redirectUriRefusal('https://claude.ai/api/mcp/auth_callback')).toBeNull();
    expect(redirectUriRefusal('http://127.0.0.1:5173/cb')).toBeNull();
    expect(redirectUriRefusal('http://localhost/callback')).toBeNull();
    expect(redirectUriRefusal('http://[::1]:9/cb')).toBeNull();
    expect(redirectUriRefusal('com.example.app:/cb')).toBeNull();
    expect(redirectUriRefusal('http://evil.example/cb')).toBe('http-not-loopback');
    expect(redirectUriRefusal('https://claude.ai/cb#frag')).toBe('fragment');
    expect(redirectUriRefusal('https://u:p@claude.ai/cb')).toBe('userinfo');
    expect(redirectUriRefusal('javascript:alert(1)')).toBe('scheme');
    expect(redirectUriRefusal('myapp:/cb')).toBe('scheme');
    expect(redirectUriRefusal('https://claude.ai/a b')).toBe('whitespace');
  });

  it('matching is the SDK redirectUriMatches (C7): exact, loopback port relaxed, never cross-host', () => {
    expect(redirectUriMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1:54321/callback', 'http://127.0.0.1/callback')).toBe(true);
    expect(redirectUriMatches('http://localhost:54321/callback', 'http://localhost/callback')).toBe(true);
    expect(redirectUriMatches('http://localhost:1/callback', 'http://127.0.0.1/callback')).toBe(false);
    expect(redirectUriMatches('https://claude.ai:444/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(false);
    expect(redirectUriMatches('https://evil.example/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(false);
  });
});

// ── CIMD ────────────────────────────────────────────────────────────────────

describe('CIMD — Client ID Metadata Documents', () => {
  it('both live Claude documents are accepted; jwt-bearer is tolerated, never issued', () => {
    const claude = parseCimdDocument(CLAUDE_ID, CLAUDE);
    expect(claude?.client_id).toBe(CLAUDE_ID);
    expect(claude?.token_endpoint_auth_method).toBe('none');
    expect(claude?.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback');
    expect(JSON.parse(CLAUDE).grant_types).toContain('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(authorizationServerMetadata().grant_types_supported).not.toContain('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(parseCimdDocument(CLAUDE_CODE_ID, CLAUDE_CODE)?.client_id).toBe(CLAUDE_CODE_ID);
    expect(clientLabel(claude!)).toBe('claude.ai');
  });

  it('client_id must equal the URL as a RAW string, before the schema (C15)', () => {
    const doc = JSON.parse(CLAUDE);
    expect(parseCimdDocument(`${CLAUDE_ID}/`, CLAUDE)).toBeNull();
    expect(parseCimdDocument(CLAUDE_ID.toUpperCase(), CLAUDE)).toBeNull();
    expect(parseCimdDocument(CLAUDE_ID, JSON.stringify({ ...doc, client_id: `${CLAUDE_ID}?x=1` }))).toBeNull();
  });

  it('a confidential method, a bad redirect, or no JSON object is refused', () => {
    const doc = JSON.parse(CLAUDE);
    expect(parseCimdDocument(CLAUDE_ID, JSON.stringify({ ...doc, token_endpoint_auth_method: 'client_secret_basic' }))).toBeNull();
    expect(parseCimdDocument(CLAUDE_ID, JSON.stringify({ ...doc, redirect_uris: ['http://evil.example/cb'] }))).toBeNull();
    expect(parseCimdDocument(CLAUDE_ID, '[]')).toBeNull();
    expect(parseCimdDocument(CLAUDE_ID, 'not json')).toBeNull();
  });

  it('W2: both ChatGPT documents negotiate to a public client from the plural, not the singular', () => {
    for (const [id, body] of [[CHATGPT_STABLE_ID, CHATGPT_STABLE], [CHATGPT_ID, CHATGPT]] as const) {
      const raw = JSON.parse(body);
      expect(raw.token_endpoint_auth_method).toBe('private_key_jwt');
      expect(raw.token_endpoint_auth_methods_supported).toEqual(['none', 'private_key_jwt']);
      const client = parseCimdDocument(id, body);
      expect(client?.client_id).toBe(id);
      expect(client?.token_endpoint_auth_method).toBe('none');
      expect(clientLabel(client!)).toBe('chatgpt.com');
    }
    expect(parseCimdDocument(CHATGPT_STABLE_ID, CHATGPT_STABLE)?.redirect_uris).toEqual(['https://chatgpt.com/connector_platform_oauth_redirect']);
  });

  it('W2: a plural with no method we accept is refused; a non-array plural leaves the singular to decide', () => {
    const doc = JSON.parse(CHATGPT_STABLE);
    expect(parseCimdDocument(CHATGPT_STABLE_ID, JSON.stringify({ ...doc, token_endpoint_auth_methods_supported: ['private_key_jwt'] }))).toBeNull();
    // Not an array → the singular decides: private_key_jwt is refused, none is accepted.
    expect(parseCimdDocument(CHATGPT_STABLE_ID, JSON.stringify({ ...doc, token_endpoint_auth_methods_supported: 'none' }))).toBeNull();
    expect(parseCimdDocument(CHATGPT_STABLE_ID, JSON.stringify({ ...doc, token_endpoint_auth_methods_supported: 'none', token_endpoint_auth_method: 'none' }))?.token_endpoint_auth_method).toBe('none');
    // An empty plural is no plural.
    expect(parseCimdDocument(CHATGPT_STABLE_ID, JSON.stringify({ ...doc, token_endpoint_auth_methods_supported: [] }))).toBeNull();
    // Claude's documents carry no plural and are unchanged.
    expect(parseCimdDocument(CLAUDE_ID, CLAUDE)?.token_endpoint_auth_method).toBe('none');
    expect(parseCimdDocument(CLAUDE_CODE_ID, CLAUDE_CODE)?.token_endpoint_auth_method).toBe('none');
  });

  it('W2: the cached copy of a negotiated client round-trips — the schema strips the plural, the stored method survives', async () => {
    const get = vi.fn(async () => ({ status: 200, contentType: 'application/json', body: CHATGPT_STABLE }));
    _setCimdDepsForTest({ resolve: (async () => ({ address: '160.79.104.10', family: 4 })) as never, get: get as never });
    const first = await oauthClientsStore.getClient(CHATGPT_STABLE_ID);
    expect(first?.token_endpoint_auth_method).toBe('none');
    const cachedRead = await oauthClientsStore.getClient(CHATGPT_STABLE_ID);
    expect(get).toHaveBeenCalledTimes(1);
    expect(cachedRead).toEqual(first);
  });

  it('fetches through the egress guard: the resolved address is PINNED, 3 s, 5 KB, JSON', async () => {
    const pin = { address: '160.79.104.10', family: 4 };
    const resolve = vi.fn(async () => pin);
    const get = vi.fn(async () => ({ status: 200, contentType: 'application/json', body: CLAUDE }));
    _setCimdDepsForTest({ resolve: resolve as never, get: get as never });
    const client = await oauthClientsStore.getClient(CLAUDE_ID);
    expect(client?.client_id).toBe(CLAUDE_ID);
    expect(resolve).toHaveBeenCalledWith(CLAUDE_ID);
    const [url, opts] = get.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe(CLAUDE_ID);
    expect(opts).toMatchObject({ pin, maxBytes: 5120, timeoutMs: 3000, headers: { Accept: 'application/json' } });
    // Cached: a second read inside 24 h never dials.
    await oauthClientsStore.getClient(CLAUDE_ID);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('serves the last good document STALE when a refetch fails after 24 h', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const get = vi.fn(async () => { throw new Error('cimd host down'); });
    _setCimdDepsForTest({ resolve: (async () => ({ address: '160.79.104.10', family: 4 })) as never, get: get as never });
    const client = await oauthClientsStore.getClient(CLAUDE_ID);
    expect(get).toHaveBeenCalledTimes(1);
    expect(client?.client_id).toBe(CLAUDE_ID);
  });

  it('an internal address, an over-size body, a redirect, a non-200 or a bare host is no client', async () => {
    // The REAL guard refuses a loopback literal before any dial.
    const dial = vi.fn();
    _setCimdDepsForTest({ get: dial as never });
    expect(await oauthClientsStore.getClient('https://127.0.0.1/client.json')).toBeUndefined();
    expect(await oauthClientsStore.getClient('https://10.0.0.1/client.json')).toBeUndefined();
    expect(dial).not.toHaveBeenCalled();

    const pin = (async () => ({ address: '160.79.104.10', family: 4 })) as never;
    _setCimdDepsForTest({ resolve: pin, get: (async () => { throw new Error('size cap exceeded'); }) as never });
    expect(await oauthClientsStore.getClient('https://a.example/big.json')).toBeUndefined();
    _setCimdDepsForTest({ resolve: pin, get: (async () => { throw new Error('unexpected redirect'); }) as never });
    expect(await oauthClientsStore.getClient('https://a.example/moved.json')).toBeUndefined();
    _setCimdDepsForTest({ resolve: pin, get: (async () => ({ status: 404, contentType: 'text/html', body: '' })) as never });
    expect(await oauthClientsStore.getClient('https://a.example/missing.json')).toBeUndefined();
    const bare = vi.fn();
    _setCimdDepsForTest({ resolve: pin, get: bare as never });
    expect(await oauthClientsStore.getClient('https://a.example/')).toBeUndefined();
    expect(bare).not.toHaveBeenCalled();
  });
});

// ── DCR ─────────────────────────────────────────────────────────────────────

describe('DCR — public clients only', () => {
  const base = { redirect_uris: ['http://127.0.0.1/callback'], client_name: 'Test Client', client_id: 'test-dcr-0123456789', client_id_issued_at: 1 };

  it('an omitted method becomes none, and the SDK-generated secret is stripped before storage', async () => {
    const out = await oauthClientsStore.registerClient!({ ...base, client_secret: 'sdk-generated', client_secret_expires_at: 0 } as never);
    expect(out.token_endpoint_auth_method).toBe('none');
    expect(out).not.toHaveProperty('client_secret');
    expect(out).not.toHaveProperty('client_secret_expires_at');
    const back = await oauthClientsStore.getClient(base.client_id);
    expect(back?.redirect_uris).toEqual(base.redirect_uris);
    expect(back).not.toHaveProperty('client_secret');
    expect(clientLabel(back!)).toBe('Test Client (unverified app)');
  });

  it('an explicit confidential method, no redirect, or a non-loopback http redirect is refused', async () => {
    await expect(oauthClientsStore.registerClient!({ ...base, client_id: 'test-dcr-a', token_endpoint_auth_method: 'client_secret_post' } as never)).rejects.toBeInstanceOf(InvalidClientMetadataError);
    await expect(oauthClientsStore.registerClient!({ ...base, client_id: 'test-dcr-b0000000', redirect_uris: [] } as never)).rejects.toBeInstanceOf(InvalidClientMetadataError);
    await expect(oauthClientsStore.registerClient!({ ...base, client_id: 'test-dcr-c0000000', redirect_uris: ['http://evil.example/cb'] } as never)).rejects.toBeInstanceOf(InvalidClientMetadataError);
  });

  it('an id that is not ours is never looked up', async () => {
    expect(await oauthClientsStore.getClient("x' OR 1=1 --")).toBeUndefined();
    expect(await oauthClientsStore.getClient('http://claude.ai/oauth/x')).toBeUndefined();
  });
});

// ── the hand-off, OAuth mode ────────────────────────────────────────────────

function mockRes() {
  return {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); return this; },
    send(html: string) { this.body = html; return this; },
  };
}
const COPY = { title: 'Signed in', body: 'Taking you back…', cta: 'Continue' };
const handOffStatus = (target: string, redirectUri?: string) => {
  const res = mockRes();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  sendOffOriginRedirect(res as never, target, COPY, redirectUri ? { redirectUri } : undefined);
  return res.statusCode;
};

describe('sendOffOriginRedirect — OAuth mode accepts exactly the validated redirect URI', () => {
  it('loopback and private-use targets pass in OAuth mode, only for their own redirect URI', () => {
    expect(handOffStatus('http://127.0.0.1:54321/callback?code=c&iss=x', 'http://127.0.0.1:54321/callback')).toBe(200);
    expect(handOffStatus('com.example.app:/cb?code=c', 'com.example.app:/cb')).toBe(200);
    expect(handOffStatus('http://127.0.0.1:54321/other?code=c', 'http://127.0.0.1:54321/callback')).toBe(502);
    expect(handOffStatus('http://127.0.0.1:1/callback?code=c', 'http://127.0.0.1:54321/callback')).toBe(502);
    expect(handOffStatus('http://evil.example/cb?code=c', 'http://evil.example/cb')).toBe(502);
    expect(handOffStatus('http://u:p@127.0.0.1:5/cb?code=c', 'http://u:p@127.0.0.1:5/cb')).toBe(502);
    expect(handOffStatus('javascript:alert(1)', 'javascript:alert(1)')).toBe(502);
  });

  it('without OAuth mode a loopback target is still refused (today’s https-only hand-off)', () => {
    expect(handOffStatus('http://127.0.0.1:54321/callback?code=c')).toBe(502);
    expect(handOffStatus('https://claude.ai/api/mcp/auth_callback?code=c')).toBe(200);
  });
});
