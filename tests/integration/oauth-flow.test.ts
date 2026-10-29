/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH2 — OAUTH_FLOW_TEST: the whole authorization server end to end,
 * driven by the MCP SDK's OWN client (`auth()` from `client/auth.js`) against a live http.Server
 * wired exactly like production's `/mcp` (express.json → resolveLicense({ oauth: true }) → the
 * refusal seam → the stateless handler).
 *
 * discovery → DCR → authorize → email code → consent → token → /mcp tools/list 200 → refresh →
 * revoke → /mcp 401. Around it: single-use codes under concurrency, replay revocation, redirect_uri
 * and resource binding, refresh reuse inside / after the grace window, a restart inside it, `iss`
 * on every hand-off, PKCE `plain` refused, the identity → credential re-derivation, and the logs.
 *
 * The SDK client believes it talks to https://api.algovault.com; `fetchFn` rewrites that origin
 * to the test server. Isolated SQLite (`PERFORMANCE_DB_PATH`); no network, no Stripe, no Resend —
 * the identity layer, the free-key store and the two emails are pinned with vi.mock, so the one
 * value a person would read (the 6-digit code) is captured, never printed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const h = vi.hoisted(() => ({
  lastCode: '' as string,
  codeSends: 0,
  freeKeyEmails: 0,
  identity: { outcome: 'FREE', key: 'av_free_' + 'a1'.repeat(12), tier: 'free', customerId: null, subscriptionStatus: null, created: true } as Record<string, unknown>,
  paidValid: true,
}));
const FREE_KEY = 'av_free_' + 'a1'.repeat(12);
const PAID_KEY = 'av_live_' + 'b2'.repeat(12);
const EMAIL = 'algovaultlabs+avoauth-e2e@gmail.com';

vi.mock('../../src/lib/email.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/email.js')>()),
  sendSigninCodeEmail: vi.fn(async (_to: string, code: string) => { h.lastCode = code; h.codeSends += 1; return null; }),
  sendFreeKeyEmail: vi.fn(async () => { h.freeKeyEmails += 1; return null; }),
}));
vi.mock('../../src/lib/signin-identity.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/signin-identity.js')>()),
  resolveSigninIdentity: vi.fn(async () => ({ ...h.identity })),
}));
vi.mock('../../src/lib/free-keys-store.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/free-keys-store.js')>()),
  lookupFreeKey: vi.fn(async (k: string) => (k === FREE_KEY ? { api_key: k, email: EMAIL, ref_code: null } : k === 'av_free_' + 'c3'.repeat(12) ? { api_key: k, email: null, ref_code: null } : null)),
  mintFreeKey: vi.fn(async () => FREE_KEY),
}));
vi.mock('../../src/lib/stripe.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/stripe.js')>()),
  validateApiKey: vi.fn(async () => (h.paidValid ? { valid: true, tier: 'pro', entitlementState: 'ENTITLED' } : { valid: false, entitlementState: 'NOT_ENTITLED' })),
}));
vi.mock('../../src/lib/subscriber-attribution.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/subscriber-attribution.js')>()),
  recordSignupAttribution: vi.fn(),
}));

import { closeDb } from '../../src/lib/performance-db.js';
import { handleMcpStateless, applyCredentialRefusal } from '../../src/index.js';
import { resolveLicense } from '../../src/lib/license.js';
import { mountOAuth, oauthCallbackBranch } from '../../src/lib/oauth/routes.js';
import { _resetOAuthLimitsForTest } from '../../src/lib/oauth/limits.js';
import { _resetProviderMemoryForTest, REFRESH_GRACE_MS } from '../../src/lib/oauth/provider.js';
import { _resetOAuthResolveForTest, resolveOAuthAccess } from '../../src/lib/oauth/resolve.js';
import { _resetOAuthStoreForTest, getToken, sha256Hex } from '../../src/lib/oauth/store.js';
import { OAUTH_ISSUER } from '../../src/lib/oauth/mode.js';
import type { LicenseInfo } from '../../src/types.js';

const ISSUER = 'https://api.algovault.com';
const SERVER_URL = `${ISSUER}/mcp`;
const REDIRECT = 'http://127.0.0.1:54321/callback';
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-flow-'));

let server: Server;
let base = '';
let originalDbPath: string | undefined;
const logs: string[] = [];

const fetchFn = (url: string | URL, init?: RequestInit) => fetch(String(url).replace(ISSUER, base), init);

beforeAll(async () => {
  originalDbPath = process.env.PERFORMANCE_DB_PATH;
  process.env.PERFORMANCE_DB_PATH = path.join(DB_DIR, 'performance.db');
  process.env.MCP_OAUTH = 'optin';
  closeDb();
  _resetOAuthStoreForTest();
  for (const m of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  }
  const app = express();
  await mountOAuth(app, 'optin');
  app.all('/mcp', express.json(), async (req, res) => {
    const { license } = await resolveLicense(req.headers as Record<string, string | undefined>, { oauth: true });
    if (applyCredentialRefusal(req, res, license)) return;
    await handleMcpStateless(req, res, () => {
      const s = new McpServer({ name: 'oauth-flow', version: '0.0.0' });
      s.tool('ping', async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));
      return s;
    });
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  closeDb();
  fs.rmSync(DB_DIR, { recursive: true, force: true });
  delete process.env.MCP_OAUTH;
  if (originalDbPath === undefined) delete process.env.PERFORMANCE_DB_PATH;
  else process.env.PERFORMANCE_DB_PATH = originalDbPath;
  vi.restoreAllMocks();
});

beforeEach(() => {
  _resetOAuthLimitsForTest();
  _resetOAuthResolveForTest();
  h.identity = { outcome: 'FREE', key: FREE_KEY, tier: 'free', customerId: null, subscriptionStatus: null, created: true };
  h.paidValid = true;
  h.freeKeyEmails = 0;
});

// ── the SDK client's side ───────────────────────────────────────────────────

class MemoryProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authUrl?: URL;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata(): OAuthClientMetadata {
    return { redirect_uris: [REDIRECT], client_name: 'Flow Test', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  state() { return 'st-flow-1'; }
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

const field = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] ?? '';
const handOffTarget = (html: string) => {
  const m = html.match(/http-equiv="refresh" content="0;url=([^"]+)"/);
  return m ? new URL(m[1].replace(/&amp;/g, '&')) : null;
};
const form = (path: string, body: Record<string, string>) =>
  fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

/**
 * The person's part: connect page → (email code | key) → consent. Returns the hand-off target.
 * The email path is rate-limited to 3 codes per address per hour — correctly — so only the main
 * flow takes it; the rest prove possession with the free key linked to the same identity.
 */
async function personSignsIn(authUrl: URL, decision: 'allow' | 'cancel' = 'allow', via: 'email' | 'key' = 'key'): Promise<URL> {
  const page = await fetchFn(authUrl.href);
  expect(page.status).toBe(200);
  expect(page.headers.get('set-cookie')).toMatch(/^av_mcp_authz=[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/);
  const r = field(await page.text(), 'r');
  expect(r).not.toBe('');
  let verified: Response;
  if (via === 'email') {
    const sent = await form('/oauth/connect/email', { r, email: EMAIL });
    expect(sent.status).toBe(200);
    verified = await form('/oauth/connect/email/verify', { r, code: h.lastCode });
  } else {
    verified = await form('/oauth/connect/key', { r, api_key: FREE_KEY });
  }
  expect(verified.status).toBe(303);
  const consentPath = verified.headers.get('location')!;
  expect(consentPath).toBe(`/oauth/consent?r=${r}`);
  const consent = await fetch(`${base}${consentPath}`);
  const html = await consent.text();
  expect(html).toContain('Allow Flow Test (unverified app) to use AlgoVault?');
  expect(html).toContain('This app runs on your own computer.');
  const decided = await form('/oauth/consent', { r, csrf: field(html, 'csrf'), decision });
  expect(decided.status).toBe(200);
  return handOffTarget(await decided.text())!;
}

async function mcpList(access: string) {
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  let json: { result?: { tools?: { name: string }[] } } | null = null;
  try { json = JSON.parse(line ? line.slice(5) : text); } catch { /* 401 body is plain JSON */ }
  return { status: r.status, json, www: r.headers.get('www-authenticate') };
}

async function token(body: Record<string, string>) {
  const r = await form('/token', body);
  return { status: r.status, json: (await r.json()) as Record<string, string> };
}

/** A registered client with a fresh code (not yet exchanged). */
async function freshCode(provider = new MemoryProvider()) {
  expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe('REDIRECT');
  const target = await personSignsIn(provider.authUrl!);
  return { provider, code: target.searchParams.get('code')!, target };
}

// ── the flow ────────────────────────────────────────────────────────────────

describe('OAUTH_FLOW_TEST — the SDK client, end to end', () => {
  it('discovery → DCR → authorize → code → token → tools/list → refresh → revoke → 401', async () => {
    const provider = new MemoryProvider();
    expect(await auth(provider, { serverUrl: SERVER_URL, fetchFn })).toBe('REDIRECT');
    expect(provider.info?.client_id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(provider.info).not.toHaveProperty('client_secret');
    const authUrl = provider.authUrl!;
    expect(authUrl.origin).toBe(ISSUER);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('resource')).toBe(SERVER_URL);

    const target = await personSignsIn(authUrl, 'allow', 'email');
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get('state')).toBe('st-flow-1');
    expect(target.searchParams.get('iss')).toBe(OAUTH_ISSUER);
    expect(h.freeKeyEmails).toBe(1); // created → the key email, once

    expect(await auth(provider, { serverUrl: SERVER_URL, authorizationCode: target.searchParams.get('code')!, fetchFn })).toBe('AUTHORIZED');
    const t1 = provider.saved!;
    expect(t1.access_token).toMatch(/^avat_[a-f0-9]{48}$/);
    expect(t1.refresh_token).toMatch(/^avrt_[a-f0-9]{48}$/);
    expect(t1.token_type.toLowerCase()).toBe('bearer');

    const listed = await mcpList(t1.access_token);
    expect(listed.status).toBe(200);
    expect(listed.json?.result?.tools?.map((t) => t.name)).toEqual(['ping']);

    const clientId = provider.info!.client_id;
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: t1.refresh_token!, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.access_token).not.toBe(t1.access_token);
    expect((await mcpList(refreshed.json.access_token)).status).toBe(200);

    const revoked = await form('/revoke', { token: refreshed.json.refresh_token, client_id: clientId });
    expect(revoked.status).toBe(200);
    const after = await mcpList(refreshed.json.access_token);
    expect(after.status).toBe(401);
    expect(after.www).toContain('error="invalid_token"');
    expect(after.www).toContain('resource_metadata="https://api.algovault.com/.well-known/oauth-protected-resource/mcp"');
  });

  it('a returning person is never re-mailed their key', async () => {
    h.identity = { ...h.identity, created: false };
    await freshCode();
    expect(h.freeKeyEmails).toBe(0);
  });
});

describe('codes are single-use and bound', () => {
  it('two concurrent exchanges: exactly one wins, and the replay revokes what the winner got (C17)', async () => {
    const { provider, code } = await freshCode();
    const body = { grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: provider.info!.client_id, resource: SERVER_URL };
    const [a, b] = await Promise.all([token(body), token(body)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(loser.json.error).toBe('invalid_grant');
    expect((await mcpList(winner.json.access_token)).status).toBe(401);
  });

  it('a code presented again after use revokes its tokens, memory included', async () => {
    const { provider, code } = await freshCode();
    const body = { grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: provider.info!.client_id };
    const first = await token(body);
    expect(first.status).toBe(200);
    expect((await mcpList(first.json.access_token)).status).toBe(200);
    expect((await token(body)).json.error).toBe('invalid_grant');
    expect((await mcpList(first.json.access_token)).status).toBe(401);
  });

  it('redirect_uri: required when the request named it, identical whenever sent (C10)', async () => {
    const { provider, code } = await freshCode();
    const common = { grant_type: 'authorization_code', code, code_verifier: provider.verifier, client_id: provider.info!.client_id };
    expect((await token({ ...common, redirect_uri: 'http://127.0.0.1:54321/other' })).json.error).toBe('invalid_grant');
    const again = await freshCode();
    expect((await token({ grant_type: 'authorization_code', code: again.code, code_verifier: again.provider.verifier, client_id: again.provider.info!.client_id })).json.error).toBe('invalid_grant');
  });

  it('a resource other than /mcp is refused at the token endpoint', async () => {
    const { provider, code } = await freshCode();
    const r = await token({ grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: provider.info!.client_id, resource: 'https://evil.example/mcp' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_grant');
  });

  it('a wrong PKCE verifier is refused', async () => {
    const { provider, code } = await freshCode();
    const r = await token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), redirect_uri: REDIRECT, client_id: provider.info!.client_id });
    expect(r.json.error).toBe('invalid_grant');
  });
});

describe('refresh rotation', () => {
  async function pair() {
    const { provider, code } = await freshCode();
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: provider.info!.client_id });
    return { clientId: provider.info!.client_id, t: t.json };
  }

  it('reuse inside 60 s returns the SAME successor pair (a client retry is not theft)', async () => {
    const { clientId, t } = await pair();
    const a = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    const b = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(b.status).toBe(200);
    expect(b.json.access_token).toBe(a.json.access_token);
    expect(b.json.refresh_token).toBe(a.json.refresh_token);
  });

  it('reuse after 60 s revokes the whole family', async () => {
    const { clientId, t } = await pair();
    const a = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + REFRESH_GRACE_MS + 5_000);
      const b = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
      expect(b.json.error).toBe('invalid_grant');
      expect((await mcpList(a.json.access_token)).status).toBe(401);
      expect((await token({ grant_type: 'refresh_token', refresh_token: a.json.refresh_token, client_id: clientId })).json.error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart inside the window answers invalid_grant and revokes NOTHING (I-18)', async () => {
    const { clientId, t } = await pair();
    const a = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    _resetProviderMemoryForTest();
    const b = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(b.json.error).toBe('invalid_grant');
    expect((await mcpList(a.json.access_token)).status).toBe(200); // from the store, family intact
    expect((await token({ grant_type: 'refresh_token', refresh_token: a.json.refresh_token, client_id: clientId })).status).toBe(200);
  });

  it('another client cannot use or revoke the refresh token', async () => {
    const { t } = await pair();
    const other = await pair();
    expect((await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: other.clientId })).json.error).toBe('invalid_grant');
    await form('/revoke', { token: t.refresh_token, client_id: other.clientId });
    expect((await mcpList(t.access_token)).status).toBe(200);
  });
});

describe('every authorization response carries iss — the SDK schema refusal included (W2)', () => {
  it('Cancel → access_denied + state + iss', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const target = await personSignsIn(provider.authUrl!, 'cancel');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('state')).toBe('st-flow-1');
    expect(target.searchParams.get('iss')).toBe(OAUTH_ISSUER);
    expect(target.searchParams.get('code')).toBeNull();
  });

  it('identity layer INDETERMINATE → temporarily_unavailable + iss, and no code', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const r = field(await (await fetchFn(provider.authUrl!.href)).text(), 'r');
    await form('/oauth/connect/email', { r, email: EMAIL });
    h.identity = { outcome: 'INDETERMINATE', key: null, tier: null, customerId: null, subscriptionStatus: null, created: false };
    const res = await form('/oauth/connect/email/verify', { r, code: h.lastCode });
    const target = handOffTarget(await res.text())!;
    expect(target.searchParams.get('error')).toBe('temporarily_unavailable');
    expect(target.searchParams.get('iss')).toBe(OAUTH_ISSUER);
  });

  it('PKCE plain or omitted is refused by the SDK schema: a 302 with iss exactly once and no pending row (C8/C9, W2)', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    for (const mutate of [(u: URL) => u.searchParams.set('code_challenge_method', 'plain'), (u: URL) => u.searchParams.delete('code_challenge')]) {
      const u = new URL(provider.authUrl!.href);
      mutate(u);
      const res = await fetchFn(u.href, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('set-cookie')).toBeNull();
      const loc = new URL(res.headers.get('location')!);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.getAll('iss')).toEqual([OAUTH_ISSUER]);
    }
  });

  it('an unregistered redirect_uri is a 400 page, never a redirect', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const u = new URL(provider.authUrl!.href);
    u.searchParams.set('redirect_uri', 'http://evil.example/cb');
    const res = await fetchFn(u.href, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('a client assertion is a method outside the intersection (W2)', () => {
  const ASSERTION = { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln' };

  it('/token answers 400 invalid_client before the SDK reads the grant, and logs the client host only', async () => {
    const { provider, code } = await freshCode();
    const clientId = provider.info!.client_id;
    const before = logs.length;
    const refused = await token({ grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: clientId, ...ASSERTION });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe('invalid_client');
    const typeOnly = await token({ grant_type: 'authorization_code', code, client_id: clientId, client_assertion_type: ASSERTION.client_assertion_type });
    expect(typeOnly.json.error).toBe('invalid_client');
    const lines = logs.slice(before).filter((l) => l.includes('token_refused'));
    expect(lines).toEqual(Array(2).fill('[oauth] token_refused reason=assertion_outside_intersection client_host=dcr'));
    expect(logs.join('\n')).not.toContain(ASSERTION.client_assertion);
    // The refusal consumed nothing: the code still exchanges once, the public-client way.
    const ok = await token({ grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: clientId });
    expect(ok.status).toBe(200);
  });

  it('/revoke answers 400 invalid_client too', async () => {
    const res = await form('/revoke', { token: 'avrt_' + '0'.repeat(48), client_id: 'https://chatgpt.com/oauth/client.json', ...ASSERTION });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error).toBe('invalid_client');
    expect(logs.at(-1)).toBe('[oauth] token_refused reason=assertion_outside_intersection client_host=chatgpt.com');
  });
});

describe('the key path', () => {
  async function connect() {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const r = field(await (await fetchFn(provider.authUrl!.href)).text(), 'r');
    return { provider, r };
  }

  it('a linked free key continues to consent as its email', async () => {
    const { r } = await connect();
    const res = await form('/oauth/connect/key', { r, api_key: FREE_KEY });
    expect(res.status).toBe(303);
    const consent = await (await fetch(`${base}${res.headers.get('location')}`)).text();
    expect(consent).toContain(`as ${EMAIL}, on your Free plan`);
  });

  it('an ephemeral key (no email) is refused with the §Copy H line', async () => {
    const { r } = await connect();
    const res = await form('/oauth/connect/key', { r, api_key: 'av_free_' + 'c3'.repeat(12) });
    expect(res.status).toBe(200);
    expect((await res.text()).replace(/&#39;/g, "'")).toContain("That key isn't linked to an account yet.");
  });

  it('an unknown key, and an access token pasted as a key, are not recognised', async () => {
    const { r } = await connect();
    for (const k of ['av_free_' + 'd4'.repeat(12), 'avat_' + 'e5'.repeat(24)]) {
      const res = await form('/oauth/connect/key', { r, api_key: k });
      expect((await res.text()).replace(/&#39;/g, "'")).toContain("We couldn't use that key.");
    }
  });
});

describe('email code limits', () => {
  it('five wrong codes burn the code', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const r = field(await (await fetchFn(provider.authUrl!.href)).text(), 'r');
    await form('/oauth/connect/email', { r, email: EMAIL });
    const good = h.lastCode;
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await form('/oauth/connect/email/verify', { r, code: bad })).status).toBe(200);
    expect((await form('/oauth/connect/email/verify', { r, code: good })).status).toBe(200); // no 303
  });
  it('three sends per address per hour; the response is identical either way', async () => {
    // An hour on, so this file's earlier codes to the same address are out of the window.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
      const provider = new MemoryProvider();
      await auth(provider, { serverUrl: SERVER_URL, fetchFn });
      const r = field(await (await fetchFn(provider.authUrl!.href)).text(), 'r');
      const before = h.codeSends;
      const pages: string[] = [];
      for (let i = 0; i < 5; i++) pages.push(await (await form('/oauth/connect/email', { r, email: EMAIL })).text());
      expect(h.codeSends - before).toBe(3);
      expect(new Set(pages).size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a token names a PERSON; /mcp re-derives their credential every time (R2.12)', () => {
  async function accessToken() {
    const { provider, code } = await freshCode();
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: provider.verifier, redirect_uri: REDIRECT, client_id: provider.info!.client_id });
    return t.json.access_token;
  }
  const seen: string[] = [];
  const resolver = (outcome: LicenseInfo['outcome'] = 'RESOLVED') => async (hdr?: string): Promise<LicenseInfo> => {
    seen.push(hdr ?? '');
    return { tier: hdr?.includes('av_live_') ? 'pro' : 'free', key: hdr?.slice(7) ?? null, outcome } as LicenseInfo;
  };

  it('FREE → their free key; upgrade → their paid key; lapse → the free key again', async () => {
    const access = await accessToken();
    seen.length = 0;
    expect((await resolveOAuthAccess(access, resolver())).tier).toBe('free');
    expect(seen.pop()).toBe(`Bearer ${FREE_KEY}`);

    h.identity = { outcome: 'PAID', key: PAID_KEY, tier: 'pro', customerId: 'cus_test', subscriptionStatus: 'active', created: false };
    _resetOAuthResolveForTest();
    expect((await resolveOAuthAccess(access, resolver())).tier).toBe('pro');
    expect(seen.pop()).toBe(`Bearer ${PAID_KEY}`);

    h.paidValid = false;
    _resetOAuthResolveForTest();
    expect((await resolveOAuthAccess(access, resolver())).tier).toBe('free');
    expect(seen.pop()).toBe(`Bearer ${FREE_KEY}`);
  });

  it('INDETERMINATE: the last good license if there is one, else today’s INDETERMINATE (-32004)', async () => {
    const access = await accessToken();
    const good = await resolveOAuthAccess(access, resolver());
    expect(good.outcome).toBe('RESOLVED');
    expect(await resolveOAuthAccess(access, resolver('INDETERMINATE'))).toEqual(good);
    // No good answer yet for this token → INDETERMINATE, retryable — never a guess.
    const first = await resolveOAuthAccess(await accessToken(), resolver('INDETERMINATE'));
    expect(first.outcome).toBe('INDETERMINATE');
    expect(first.retryable).toBe(true);
    // The 24 h bound never outlives the token itself: past its hour it is TOKEN_INVALID → the 401.
    expect((await resolveOAuthAccess(access, resolver('INDETERMINATE'), Date.now() + 2 * 60 * 60 * 1000)).outcome).toBe('TOKEN_INVALID');
  });

  it('an unknown access token is TOKEN_INVALID, never a store lookup of anything else', async () => {
    const r = await resolveOAuthAccess('avat_' + 'f6'.repeat(24), resolver());
    expect(r.outcome).toBe('TOKEN_INVALID');
    expect(await getToken(sha256Hex('avat_' + 'f6'.repeat(24)))).toBeNull();
  });
});

describe('the IdP callback branch', () => {
  const resMock = () => {
    const headers: Record<string, unknown> = {};
    return { headers, headersSent: false, statusCode: 0, body: '',
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; return this; },
      status(c: number) { this.statusCode = c; return this; },
      send(b: string) { this.body = b; return this; },
      redirect(c: number, l: string) { this.statusCode = c; headers.location = l; return this; } };
  };
  const ident = (o: Record<string, unknown>) => o as never;

  it('no cookie → false and the response is untouched (today’s page renders byte-identical)', async () => {
    const res = resMock();
    const handled = await oauthCallbackBranch({ headers: {} } as never, res as never, { identity: ident(h.identity), email: EMAIL, via: 'google', clearCookies: ['a=; Max-Age=0'] });
    expect(handled).toBe(false);
    expect(res.headers).toEqual({});
    expect(res.statusCode).toBe(0);
  });

  it('cookie + INDETERMINATE identity → temporarily_unavailable hand-off, ONE Set-Cookie array (C11)', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const page = await fetchFn(provider.authUrl!.href);
    const cookie = page.headers.get('set-cookie')!.split(';')[0];
    const res = resMock();
    const handled = await oauthCallbackBranch({ headers: { cookie } } as never, res as never, {
      identity: ident({ outcome: 'INDETERMINATE', key: null }), email: EMAIL, via: 'google', clearCookies: ['a=; Max-Age=0', 'b=; Max-Age=0', 'c=; Max-Age=0'],
    });
    expect(handled).toBe(true);
    const set = res.headers['set-cookie'] as string[];
    expect(set).toHaveLength(4);
    expect(set[3]).toMatch(/^av_mcp_authz=; .*Max-Age=0$/);
    const target = handOffTarget(res.body)!;
    expect(target.searchParams.get('error')).toBe('temporarily_unavailable');
    expect(target.searchParams.get('iss')).toBe(OAUTH_ISSUER);
  });

  it('cookie + FREE identity → 303 to consent', async () => {
    const provider = new MemoryProvider();
    await auth(provider, { serverUrl: SERVER_URL, fetchFn });
    const cookie = (await fetchFn(provider.authUrl!.href)).headers.get('set-cookie')!.split(';')[0];
    const res = resMock();
    expect(await oauthCallbackBranch({ headers: { cookie } } as never, res as never, { identity: ident(h.identity), email: EMAIL, via: 'google', clearCookies: [] })).toBe(true);
    expect(res.statusCode).toBe(303);
    expect(String(res.headers.location)).toMatch(/^\/oauth\/consent\?r=/);
  });
});

describe('mode off: nothing is mounted', () => {
  it('every OAuth path keeps the app’s own 404', async () => {
    const app = express();
    expect(await mountOAuth(app, 'off')).toBe('off');
    const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const paths = [
        '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server',
        '/authorize', '/token', '/register', '/revoke', '/oauth/consent', '/oauth/connect/email', '/oauth/connect/email/verify', '/oauth/connect/key',
      ];
      for (const p of paths) {
        expect((await fetch(`${b}${p}`)).status, p).toBe(404);
        expect((await fetch(`${b}${p}`, { method: 'POST' })).status, p).toBe(404);
      }
    } finally {
      s.close();
    }
  });
});

describe('no secret reaches a log line', () => {
  it('no access / refresh token, code, key, email or Authorization header was ever logged', () => {
    const all = logs.join('\n');
    expect(all).not.toMatch(/avat_[a-f0-9]{8}/);
    expect(all).not.toMatch(/avrt_[a-f0-9]{8}/);
    expect(all).not.toContain(FREE_KEY);
    expect(all).not.toContain(PAID_KEY);
    expect(all).not.toContain(EMAIL);
    expect(all).not.toMatch(/authorization:\s*bearer/i);
    expect(all).toContain('[oauth] mode=optin');
  });
});
