#!/usr/bin/env node
/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH3 — oauth-e2e: a real MCP OAuth client, the way Claude does it.
 *
 *   node scripts/oauth-e2e.mjs [--base https://api.algovault.com] [--env-file ~/.config/algovault/oauth-e2e.env]
 *   node scripts/oauth-e2e.mjs --self-test
 *
 * Legs (one `LEG <name> PASS|FAIL|INDETERMINATE <reason>` line each), then
 * `OAUTH_E2E_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 1 / 3). FAIL beats INDETERMINATE beats PASS:
 *   discovery · signin-challenge · signin-meter · dcr · authorize · loopback-redirect · token ·
 *   mcp-bearer · refresh-rotation · refresh-grace-replay · revoke · refresh-reuse-revokes-family
 *
 * VERDICT TOKENS (verification-gates.md): PASS is only ever positive evidence. A server that cannot
 * be reached, a wall that hides the meter, a key the server does not recognise, a response we could
 * not parse — all INDETERMINATE (exit 3), never PASS and never a false FAIL. FAIL means the server
 * answered and the answer was wrong. An empty leg list is INDETERMINATE.
 *
 * SECRETS: nothing secret is ever printed. Every line goes through `redact()`, which replaces any
 * registered secret (the API key, every token, every code, the state, the pending id) and anything
 * shaped like a token or an email with `<sha16:…>` / `<redacted>`. The identity's email is never
 * held by this script at all in production mode — only its free API key, read from a mode-600 file.
 *
 * `--self-test` is HERMETIC: an in-process express app on 127.0.0.1, wired in production's `/mcp`
 * order from the compiled `dist/` (resolveLicense → applyCredentialRefusal → applyChallenge →
 * handleMcpStateless), MCP_OAUTH=optin, an isolated SQLite DB, no DATABASE_URL / Stripe / Resend /
 * market data. It runs every leg, then runs NEGATIVE CONTROLS — the same legs against a server or
 * an expectation deliberately made wrong — and passes only if every leg is PASS and every control
 * went red. A self-test that cannot fail is not a self-test.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── constants this script holds the server to (mirrors of src/lib/oauth/mode.ts + provider.ts) ──
// The self-test asserts each equals the compiled value, so a drift is a red self-test, not a quiet lie.
const ISSUER = 'https://api.algovault.com';
const RESOURCE = `${ISSUER}/mcp`;
const REFRESH_GRACE_MS = 60_000;
const SCOPE = 'mcp:tools offline_access';
const CHALLENGE_DESCRIPTION = 'Sign in free to keep using AlgoVault';
const EXPECT_WWW =
  `Bearer error="invalid_token", error_description="${CHALLENGE_DESCRIPTION}", scope="mcp:tools", ` +
  `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp?signin=1"`;
const EXPECT_BODY = {
  error: 'invalid_token',
  error_description: CHALLENGE_DESCRIPTION,
  algovault: {
    reason: 'signin',
    message: "Sign in to continue. It's free, no card.",
    sign_in_url: `${ISSUER}/welcome?src=stepup`,
  },
};
const UA = 'algovault-oauth-e2e/1';
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'algovault', 'oauth-e2e.env');

// ── verdict plumbing ────────────────────────────────────────────────────────────────────────────
class Fail extends Error {}
class Ind extends Error {}
const fail = (m) => { throw new Fail(m); };
const ind = (m) => { throw new Ind(m); };
const must = (cond, m) => { if (!cond) fail(m); };
const sha16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** FAIL beats INDETERMINATE beats PASS; no legs at all is INDETERMINATE (vacuity). */
export function aggregate(statuses) {
  if (statuses.length === 0) return 'INDETERMINATE';
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('INDETERMINATE')) return 'INDETERMINATE';
  return 'PASS';
}
const EXIT = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

const secrets = new Set();
const addSecret = (v) => { if (typeof v === 'string' && v.length >= 6) secrets.add(v); return v; };
function redact(text) {
  let s = String(text);
  for (const v of secrets) s = s.split(v).join(`<sha16:${sha16(v)}>`);
  s = s.replace(/\b(?:avat_|avrt_|av_free_|av_live_)[A-Za-z0-9]+/g, '<redacted>');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted>');
  return s;
}
const out = (line) => process.stdout.write(`${redact(line)}\n`);
const errOut = (line) => process.stderr.write(`${redact(line)}\n`);

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────
/** `https://api.algovault.com/x` → `<base>/x`, so a hermetic server can stand in for production. */
const rebase = (cfg, u) => (u.startsWith(cfg.issuer) ? cfg.base + u.slice(cfg.issuer.length) : u);

async function call(ctx, method, target, { headers = {}, body, form, json, jar } = {}) {
  const { cfg } = ctx;
  const url = /^https?:/.test(target) ? rebase(cfg, target) : cfg.base + target;
  const h = { 'user-agent': UA, ...(cfg.extraHeaders ?? {}), ...headers };
  let payload = body;
  if (form) { payload = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
  if (json !== undefined) { payload = JSON.stringify(json); h['content-type'] = 'application/json'; }
  if (jar && jar.size > 0) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let res;
  let text;
  try {
    res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
    text = await res.text();
  } catch (e) {
    // The URL is deliberately left out: some carry a pending id or a challenge.
    return ind(`network: ${e?.cause?.code ?? e?.name ?? 'error'}`);
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (jar) for (const c of setCookies) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  let parsed;
  return {
    status: res.status,
    headers: res.headers,
    text,
    setCookies,
    get json() { if (parsed === undefined) { try { parsed = JSON.parse(text); } catch { parsed = null; } } return parsed; },
  };
}
/** 429 / 502 / 503 / 504 mean the server did not give an answer about the property — not a FAIL. */
function reachable(res, what) {
  if ([429, 502, 503, 504].includes(res.status)) ind(`${what}: HTTP ${res.status} (no answer)`);
  return res;
}
const expectStatus = (res, want, what) => {
  reachable(res, what);
  const ok = Array.isArray(want) ? want.includes(res.status) : res.status === want;
  must(ok, `${what}: HTTP ${res.status}, want ${Array.isArray(want) ? want.join('|') : want}`);
  return res;
};

/** Streamable HTTP answers `application/json` or SSE `data:` lines. */
function parseRpc(res, id) {
  const candidates = [];
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    for (const line of res.text.split('\n')) {
      if (line.startsWith('data:')) { try { candidates.push(JSON.parse(line.slice(5))); } catch { /* keep scanning */ } }
    }
  } else if (res.json) {
    candidates.push(...(Array.isArray(res.json) ? res.json : [res.json]));
  }
  return candidates.find((m) => m && m.id === id) ?? candidates.find((m) => m && ('result' in m || 'error' in m)) ?? null;
}

class McpClient {
  constructor(ctx, access) { this.ctx = ctx; this.access = access; this.sid = null; this.proto = null; this.n = 0; }
  headers() {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.access ? { authorization: `Bearer ${this.access}` } : {}),
      ...(this.sid ? { 'mcp-session-id': this.sid } : {}),
      ...(this.proto ? { 'mcp-protocol-version': this.proto } : {}),
    };
  }
  async post(msg, query = '') {
    const res = await call(this.ctx, 'POST', `/mcp${query}`, { headers: this.headers(), json: msg });
    return { res, status: res.status, www: res.headers.get('www-authenticate'), rpc: msg.id === undefined ? null : parseRpc(res, msg.id) };
  }
  async request(method, params) { return this.post({ jsonrpc: '2.0', id: ++this.n, method, params }); }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'algovault-oauth-e2e', version: '1' } });
    expectStatus(r.res, 200, 'mcp initialize');
    must(typeof r.rpc?.result?.protocolVersion === 'string', 'mcp initialize: no protocolVersion in the result');
    this.proto = r.rpc.result.protocolVersion;
    this.sid = r.res.headers.get('mcp-session-id'); // stateless server: normally null; replayed only if present
    const n = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expectStatus(n.res, [200, 202], 'mcp notifications/initialized');
  }
}

// ── the anonymous meter (honest observation — see signinLegs) ───────────────────────────────────
function readMeter(rpc) {
  const result = rpc?.result;
  if (!result || result.isError) return null;
  let doc;
  try { doc = JSON.parse(result.content?.[0]?.text ?? ''); } catch { doc = result.structuredContent; }
  const q = doc?._algovault?.quota;
  if (!q || !Number.isFinite(q.used)) return null;
  return { used: q.used, dailyUsed: Number.isFinite(q.daily?.used) ? q.daily.used : null };
}
const TRADE_CALL = (id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_trade_call', arguments: { coin: 'BTC' } } });

/** One plain anonymous metered call → what the meter says afterwards, or why it cannot be read. */
async function plainMeteredCall(ctx, id) {
  try {
    const client = new McpClient(ctx, null);
    const r = await client.post(TRADE_CALL(id));
    if (r.status === 401) return { ok: false, why: 'HTTP 401 (already challenged / walled)' };
    if (r.status !== 200) return { ok: false, why: `HTTP ${r.status}` };
    const meter = readMeter(r.rpc);
    return meter ? { ok: true, ...meter } : { ok: false, why: 'no _algovault.quota in the result (refused, tool error, or unparseable)' };
  } catch (e) {
    if (e instanceof Ind) return { ok: false, why: e.message };
    throw e;
  }
}

// ── legs ────────────────────────────────────────────────────────────────────────────────────────
async function leg(ctx, name, fn) {
  let status = 'PASS';
  let reason = '';
  try {
    reason = (await fn()) || 'ok';
  } catch (e) {
    if (e instanceof Fail) { status = 'FAIL'; reason = e.message; }
    else if (e instanceof Ind) { status = 'INDETERMINATE'; reason = e.message; }
    else { status = 'INDETERMINATE'; reason = `script error (${e?.name}): ${e?.message}`; }
  }
  reason = redact(reason).replace(/\s+/g, ' ').slice(0, 220);
  ctx.results.push({ name, status, reason });
  if (!ctx.quiet) out(`LEG ${name} ${status} ${reason}`);
  return status;
}
const passed = (ctx, name) => ctx.results.some((r) => r.name === name && r.status === 'PASS');
const needs = (ctx, ...names) => {
  for (const n of names) if (!passed(ctx, n)) ind(`not run: prerequisite leg ${n} did not pass`);
};
const endpoint = (ctx, key) => ctx.s.eps?.[key] ?? `${ctx.cfg.issuer}/${key}`;

async function legDiscovery(ctx) {
  const { cfg } = ctx;
  const prmPath = '/.well-known/oauth-protected-resource/mcp';
  const prm = async (query, wantResource) => {
    const r = expectStatus(await call(ctx, 'GET', `${prmPath}${query}`), 200, `PRM${query}`);
    must(r.json && typeof r.json === 'object', `PRM${query}: body is not JSON`);
    must(r.json.resource === wantResource, `PRM${query}: resource is not ${wantResource.replace(cfg.issuer, '<issuer>')}`);
    must(same(r.json.authorization_servers, [cfg.issuer]), `PRM${query}: authorization_servers is not [issuer]`);
    return r.json;
  };
  await prm('', cfg.resource);
  await prm('?src=docs', `${cfg.resource}?src=docs`);
  await prm('?signin=1', `${cfg.resource}?signin=1`);

  const as = expectStatus(await call(ctx, 'GET', '/.well-known/oauth-authorization-server'), 200, 'AS metadata').json;
  must(as && typeof as === 'object', 'AS metadata: body is not JSON');
  must(as.issuer === cfg.issuer, 'AS metadata: issuer is not the expected issuer');
  must(as.client_id_metadata_document_supported === true, 'AS metadata: CIMD flag is not true');
  must(as.authorization_response_iss_parameter_supported === true, 'AS metadata: RFC 9207 iss flag is not true');
  must(Array.isArray(as.code_challenge_methods_supported) && as.code_challenge_methods_supported.includes('S256') && !as.code_challenge_methods_supported.includes('plain'), 'AS metadata: PKCE methods are not S256-only');
  must(Array.isArray(as.token_endpoint_auth_methods_supported) && as.token_endpoint_auth_methods_supported.includes('none'), 'AS metadata: auth method none missing');
  for (const [k, p] of [['authorization_endpoint', 'authorize'], ['token_endpoint', 'token'], ['registration_endpoint', 'register'], ['revocation_endpoint', 'revoke']]) {
    must(as[k] === `${cfg.issuer}/${p}`, `AS metadata: ${k} is not <issuer>/${p}`);
  }
  ctx.s.eps = { authorize: as.authorization_endpoint, token: as.token_endpoint, register: as.registration_endpoint, revoke: as.revocation_endpoint };
  return 'PRM resource + ?src/?signin echo; AS issuer, CIMD, iss, S256, none';
}

/**
 * The signin challenge and its meter, observed together because they share one request.
 *
 * THE METER CHECK, AND WHY IT IS HONEST. No endpoint reports a keyless caller's meter; the only
 * observable is `_algovault.quota.used` in the result of a call that is itself charged. So the
 * minimum spend is two plain metered calls bracketing the challenge:
 *     A  → used = u          (charged: the post-charge reading)
 *     C  → 401               (must charge NOTHING)
 *     B  → used = u + 1      (charged once; a charging challenge would read u + 2)
 * PASS needs EXACTLY +1 (and +1 on the daily meter when it is reported). It is INDETERMINATE —
 * never PASS — when A or B could not be read (walled, challenged, tool error), when the challenge
 * did not come back 401 (nothing to attribute), when the meter ran backwards (a period rolled over)
 * or did not move at all (the instrument is dead). +2 or more is FAIL: the challenge charged, or a
 * second caller shares this IP bucket — either way the claim "unchanged" is not established.
 */
async function signinLegs(ctx) {
  const A = await plainMeteredCall(ctx, 1);
  let C;
  try {
    const r = await new McpClient(ctx, null).post(TRADE_CALL(2), '?signin=1');
    C = { r };
  } catch (e) {
    if (e instanceof Ind) C = { err: e.message }; else throw e;
  }
  const B = await plainMeteredCall(ctx, 3);

  await leg(ctx, 'signin-challenge', async () => {
    if (ctx.cfg.seamAbsent) fail('challenge seam absent (dist/lib/oauth/challenge.js applyChallenge not found)');
    if (C.err) ind(C.err);
    const { r } = C;
    reachable(r.res, 'signin challenge');
    must(r.status === 401, `signin challenge: HTTP ${r.status}, want 401 (the call was served instead of challenged)`);
    must(r.www === EXPECT_WWW, 'signin challenge: WWW-Authenticate differs from the exact expected value');
    must(r.res.headers.get('cache-control') === 'no-store', 'signin challenge: Cache-Control is not no-store');
    must(same(r.res.json, EXPECT_BODY), 'signin challenge: body differs from the exact expected JSON');
    return '401 + exact WWW-Authenticate + no-store + exact body on /mcp?signin=1';
  });

  await leg(ctx, 'signin-meter', async () => {
    if (C.err) ind(`challenge call produced no answer: ${C.err}`);
    if (C.r.status !== 401) ind(`no challenge was issued (HTTP ${C.r.status}), so a challenge's cost cannot be attributed`);
    if (!A.ok || !B.ok) ind(`meter not observable (A: ${A.ok ? 'read' : A.why}; B: ${B.ok ? 'read' : B.why})`);
    const delta = B.used - A.used;
    if (delta < 0) ind(`meter went backwards (${A.used} -> ${B.used}): a period rolled over mid-check`);
    if (delta === 0) ind('meter did not advance across two charged calls: the instrument is not live');
    must(delta === 1, `meter advanced by ${delta}, want exactly 1: the challenge charged, or another caller shares this IP bucket`);
    if (A.dailyUsed !== null && B.dailyUsed !== null) must(B.dailyUsed - A.dailyUsed === 1, `daily meter advanced by ${B.dailyUsed - A.dailyUsed}, want exactly 1`);
    return `meter ${A.used} -> ${B.used} across A, 401, B: the challenge charged nothing`;
  });
}

async function legDcr(ctx) {
  const r = expectStatus(await call(ctx, 'POST', endpoint(ctx, 'register'), {
    json: {
      redirect_uris: [ctx.s.redirect],
      client_name: 'AlgoVault OAuth E2E',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    },
  }), [200, 201], 'POST /register');
  const c = r.json;
  must(c && typeof c.client_id === 'string' && /^[A-Za-z0-9._-]{8,200}$/.test(c.client_id), 'DCR: no usable client_id');
  must(!('client_secret' in c), 'DCR: a public client was issued a client_secret');
  must(c.token_endpoint_auth_method === 'none', 'DCR: token_endpoint_auth_method is not none');
  must(Array.isArray(c.redirect_uris) && c.redirect_uris.includes(ctx.s.redirect), 'DCR: redirect_uris does not carry our loopback URI');
  ctx.s.clientId = c.client_id;
  return 'public client registered (no secret) for the loopback redirect';
}

const b64url = (buf) => buf.toString('base64url');
const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] ?? '';

/** Steps 1-5: authorize → connect page → key path → consent → Allow. Returns the hand-off target. */
async function doAuthorize(ctx) {
  const { cfg } = ctx;
  if (!cfg.apiKey) ind(cfg.keyErr || 'no API key available for the key path');
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = `st-${randomBytes(9).toString('hex')}`;
  addSecret(verifier); addSecret(state);
  const jar = new Map();
  const q = new URLSearchParams({
    response_type: 'code', client_id: ctx.s.clientId, redirect_uri: ctx.s.redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state, scope: SCOPE, resource: cfg.resource,
  });
  const page = expectStatus(await call(ctx, 'GET', `${endpoint(ctx, 'authorize')}?${q}`, { jar }), 200, 'GET /authorize');
  must(page.setCookies.some((c) => /^av_mcp_authz=[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/.test(c)), 'GET /authorize: av_mcp_authz cookie missing or wrong attributes');
  const r = field(page.text, 'r');
  must(r !== '', 'GET /authorize: the connect page carries no pending id');
  addSecret(r);

  const keyed = reachable(await call(ctx, 'POST', '/oauth/connect/key', { form: { r, api_key: cfg.apiKey }, jar, headers: { origin: cfg.base } }), 'POST /oauth/connect/key');
  if (keyed.status === 200) ind('key path re-rendered the connect page (key not recognised, or the path is down)');
  must(keyed.status === 303, `POST /oauth/connect/key: HTTP ${keyed.status}, want 303`);
  must(keyed.headers.get('location') === `/oauth/consent?r=${r}`, 'key path: Location is not /oauth/consent?r=<pending>');

  const consent = expectStatus(await call(ctx, 'GET', `/oauth/consent?r=${r}`, { jar }), 200, 'GET /oauth/consent');
  must(/Allow .+ to use AlgoVault\?/.test(consent.text), 'consent page: title "Allow … to use AlgoVault?" missing');
  const csrf = field(consent.text, 'csrf');
  must(csrf !== '', 'consent page: no csrf field');
  addSecret(csrf);

  const decided = reachable(await call(ctx, 'POST', '/oauth/consent', { form: { r, csrf, decision: 'allow' }, jar, headers: { origin: cfg.base } }), 'POST /oauth/consent');
  must(decided.status === 200, `POST /oauth/consent: HTTP ${decided.status}, want the 200 hand-off interstitial (never a 3xx after a form POST)`);
  const m = decided.text.match(/http-equiv="refresh" content="0;url=([^"]+)"/);
  must(m, 'consent decision: no meta-refresh hand-off in the interstitial');
  let target;
  try { target = new URL(m[1].replace(/&amp;/g, '&')); } catch { return fail('consent decision: hand-off URL does not parse'); }
  return { target, state, verifier };
}

/** Steps 6-7: the hand-off lands on OUR loopback listener; check what actually arrived. */
async function doLoopback(ctx, a) {
  const { cfg } = ctx;
  must(`${a.target.origin}${a.target.pathname}` === ctx.s.redirect, 'hand-off target is not our registered redirect_uri');
  const before = ctx.s.hits.length;
  await call(ctx, 'GET', a.target.href); // the "browser" follows the interstitial
  const hit = ctx.s.hits.slice(before).find((u) => u.pathname === '/callback');
  must(hit, 'the loopback listener never received the redirect');
  const code = hit.searchParams.get('code') ?? '';
  must(code.length >= 16, 'loopback redirect carries no usable code');
  addSecret(code);
  must(hit.searchParams.get('state') === a.state, 'loopback redirect: state does not equal the one we sent');
  must(hit.searchParams.get('iss') === cfg.expectIss, 'loopback redirect: iss does not equal the expected issuer');
  must(hit.searchParams.get('error') === null, 'loopback redirect carries an error');
  return code;
}

const ACCESS_RE = /^avat_[a-f0-9]{48}$/;
const REFRESH_RE = /^avrt_[a-f0-9]{48}$/;
function pairOf(res, what) {
  expectStatus(res, 200, what);
  const j = res.json;
  must(j && typeof j === 'object', `${what}: body is not JSON`);
  must(ACCESS_RE.test(j.access_token ?? ''), `${what}: access_token is not avat_ + 48 hex`);
  must(REFRESH_RE.test(j.refresh_token ?? ''), `${what}: refresh_token is not avrt_ + 48 hex`);
  must(String(j.token_type).toLowerCase() === 'bearer', `${what}: token_type is not Bearer`);
  must(Number.isFinite(j.expires_in) && j.expires_in > 0, `${what}: no positive expires_in`);
  addSecret(j.access_token); addSecret(j.refresh_token);
  return { access: j.access_token, refresh: j.refresh_token };
}
const exchangeCode = async (ctx, code, verifier) => pairOf(await call(ctx, 'POST', endpoint(ctx, 'token'), {
  form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ctx.s.redirect, client_id: ctx.s.clientId, resource: ctx.cfg.resource },
}), 'POST /token (authorization_code)');
const refreshWith = (ctx, refresh) => call(ctx, 'POST', endpoint(ctx, 'token'), { form: { grant_type: 'refresh_token', refresh_token: refresh, client_id: ctx.s.clientId } });
const listWith = (ctx, access) => new McpClient(ctx, access).request('tools/list', {});

async function legMcpBearer(ctx) {
  const { access } = ctx.s.t0;
  const c = new McpClient(ctx, access);
  await c.init();
  const list = await c.request('tools/list', {});
  expectStatus(list.res, 200, 'mcp tools/list (Bearer)');
  const names = (list.rpc?.result?.tools ?? []).map((t) => t.name);
  must(names.length > 0 && names.includes('get_track_record'), 'tools/list (Bearer): no tools, or get_track_record missing');
  const rec = await c.request('tools/call', { name: 'get_track_record', arguments: {} });
  expectStatus(rec.res, 200, 'mcp tools/call get_track_record (Bearer)');
  must(rec.rpc?.result && !rec.rpc.result.isError && (rec.rpc.result.content?.length ?? 0) > 0, 'tools/call get_track_record: no content, or an error result');
  return `initialize + tools/list (${names.length} tools) + get_track_record all 200 with the Bearer`;
}

async function legRefreshRotation(ctx) {
  const { t0 } = ctx.s;
  const r = await refreshWith(ctx, t0.refresh);
  const tResp = Date.now();
  const t1 = pairOf(r, 'POST /token (refresh_token)');
  must(t1.access !== t0.access && t1.refresh !== t0.refresh, 'refresh did not rotate: the pair is not new');
  expectStatus((await listWith(ctx, t1.access)).res, 200, 'mcp tools/list with the rotated access token');
  ctx.s.t1 = t1;
  ctx.s.rotatedAt = tResp;
  return 'refresh returned a NEW pair and the new access token serves /mcp';
}

async function legGraceReplay(ctx) {
  const { t0, t1, rotatedAt } = ctx.s;
  if (Date.now() - rotatedAt > ctx.cfg.graceMs - 5_000) ind('replay would fall outside the 60 s grace window (slow run): not testable');
  const pair = pairOf(await refreshWith(ctx, t0.refresh), 'replay of the old refresh (inside the grace)');
  const want = ctx.cfg.replayExpect === 'original' ? t0 : t1;
  must(pair.access === want.access && pair.refresh === want.refresh, 'replay inside the grace did not return the SAME pair as the rotation');
  return 'old refresh replayed inside 60 s returned exactly the rotation pair';
}

async function legRevoke(ctx) {
  needs(ctx, 'dcr');
  const a = await doAuthorize(ctx);
  const code = await doLoopback(ctx, a);
  const t2 = await exchangeCode(ctx, code, a.verifier);
  expectStatus((await listWith(ctx, t2.access)).res, 200, 'mcp tools/list before revoke (second authorization)');
  expectStatus(await call(ctx, 'POST', endpoint(ctx, 'revoke'), { form: { token: t2.refresh, client_id: ctx.s.clientId } }), 200, 'POST /revoke');
  const after = await listWith(ctx, t2.access);
  reachable(after.res, 'mcp after revoke');
  must(after.status === ctx.cfg.revokedStatus, `mcp with the revoked token: HTTP ${after.status}, want ${ctx.cfg.revokedStatus}`);
  must((after.www ?? '').startsWith('Bearer error="invalid_token"'), 'mcp with the revoked token: WWW-Authenticate lacks error="invalid_token"');
  must((after.www ?? '').includes(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`), 'mcp with the revoked token: resource_metadata not named');
  const again = reachable(await refreshWith(ctx, t2.refresh), 'refresh after revoke');
  must(again.status === 400 && again.json?.error === 'invalid_grant', 'refresh after revoke: not 400 invalid_grant');
  return 'second authorization: /revoke 200, then /mcp 401 invalid_token + PRM, refresh invalid_grant';
}

async function legReuse(ctx) {
  const { t0, t1, rotatedAt } = ctx.s;
  const wait = rotatedAt + ctx.cfg.graceMs + ctx.cfg.graceMarginMs - Date.now();
  if (wait > 0) { errOut(`waiting ${Math.ceil(wait / 1000)}s for the refresh grace to elapse`); await sleep(wait); }
  const replay = reachable(await refreshWith(ctx, t0.refresh), 'replay of the old refresh (after the grace)');
  must(replay.status === 400 && replay.json?.error === 'invalid_grant', `replay after the grace: HTTP ${replay.status}${replay.json?.error ? ` ${replay.json.error}` : ''}, want 400 invalid_grant`);
  const after = await listWith(ctx, t1.access);
  reachable(after.res, 'mcp after family revocation');
  must(after.status === 401, `newest access token after family revocation: HTTP ${after.status}, want 401`);
  must((after.www ?? '').includes('error="invalid_token"'), 'newest access token after family revocation: WWW-Authenticate lacks error="invalid_token"');
  const live = reachable(await refreshWith(ctx, t1.refresh), 'refresh with the newest refresh');
  must(live.status === 400 && live.json?.error === 'invalid_grant', 'newest refresh after family revocation: not 400 invalid_grant');
  return 'old refresh replayed after the grace: invalid_grant; newest access 401; newest refresh invalid_grant';
}

/** Every leg in order. `until` stops after the named leg (used by the negative controls). */
async function runLegs(ctx, until = null) {
  const done = (name) => until === name;
  await leg(ctx, 'discovery', () => legDiscovery(ctx));
  if (done('discovery')) return;
  await signinLegs(ctx);
  if (done('signin-challenge') || done('signin-meter')) return;
  await leg(ctx, 'dcr', () => legDcr(ctx));
  if (done('dcr')) return;
  await leg(ctx, 'authorize', async () => {
    needs(ctx, 'dcr');
    ctx.s.a1 = await doAuthorize(ctx);
    return 'authorize → key path → consent → Allow → 200 hand-off interstitial';
  });
  if (done('authorize')) return;
  await leg(ctx, 'loopback-redirect', async () => {
    needs(ctx, 'authorize');
    ctx.s.code1 = await doLoopback(ctx, ctx.s.a1);
    return 'loopback listener got code + state (equal) + iss (equal)';
  });
  if (done('loopback-redirect')) return;
  await leg(ctx, 'token', async () => {
    needs(ctx, 'loopback-redirect');
    ctx.s.t0 = await exchangeCode(ctx, ctx.s.code1, ctx.s.a1.verifier);
    return 'authorization_code + PKCE verifier + resource → avat_/avrt_ pair';
  });
  if (done('token')) return;
  await leg(ctx, 'mcp-bearer', async () => { needs(ctx, 'token'); return legMcpBearer(ctx); });
  if (done('mcp-bearer')) return;
  await leg(ctx, 'refresh-rotation', async () => { needs(ctx, 'token'); return legRefreshRotation(ctx); });
  if (done('refresh-rotation')) return;
  await leg(ctx, 'refresh-grace-replay', async () => { needs(ctx, 'refresh-rotation'); return legGraceReplay(ctx); });
  if (done('refresh-grace-replay')) return;
  // The second authorization + revoke run while the grace clock is ticking, so the 60 s wait is not idle.
  await leg(ctx, 'revoke', () => legRevoke(ctx));
  if (done('revoke')) return;
  await leg(ctx, 'refresh-reuse-revokes-family', async () => { needs(ctx, 'refresh-rotation'); return legReuse(ctx); });
}

// ── context ─────────────────────────────────────────────────────────────────────────────────────
async function startLoopback() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(new URL(req.url, 'http://127.0.0.1')); res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { hits, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

function newCtx(cfg, loop, { quiet = false } = {}) {
  return { cfg, results: [], quiet, s: { redirect: `http://127.0.0.1:${loop.port}/callback`, hits: loop.hits } };
}
const baseCfg = (over) => ({
  base: ISSUER, issuer: ISSUER, resource: RESOURCE, expectIss: ISSUER, apiKey: null, keyErr: null, seamAbsent: false,
  timeoutMs: 20_000, extraHeaders: null, graceMs: REFRESH_GRACE_MS, graceMarginMs: 1_500, replayExpect: 'rotation', revokedStatus: 401, ...over,
});

function readApiKey(envFile) {
  let st;
  try { st = fs.statSync(envFile); } catch { return { keyErr: `env file ${envFile} not found` }; }
  if (!st.isFile()) return { keyErr: `env file ${envFile} is not a file` };
  if ((st.mode & 0o077) !== 0) return { keyErr: `env file ${envFile} is group/world accessible (need mode 600): not read` };
  let text;
  try { text = fs.readFileSync(envFile, 'utf8'); } catch { return { keyErr: `env file ${envFile} unreadable` }; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?OAUTH_E2E_API_KEY\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].replace(/^(['"])(.*)\1$/, '$2');
    if (!/^[A-Za-z0-9_]{8,128}$/.test(key)) return { keyErr: 'OAUTH_E2E_API_KEY in the env file is malformed' };
    return { apiKey: addSecret(key) };
  }
  return { keyErr: 'OAUTH_E2E_API_KEY is not set in the env file' };
}

// ── production mode ─────────────────────────────────────────────────────────────────────────────
async function runProduction({ base, envFile }) {
  const loop = await startLoopback();
  const cfg = baseCfg({ base: base.replace(/\/+$/, ''), ...readApiKey(envFile) });
  const ctx = newCtx(cfg, loop);
  try { await runLegs(ctx); } finally { await loop.close(); }
  const verdict = aggregate(ctx.results.map((r) => r.status));
  out(`OAUTH_E2E_VERDICT=${verdict}`);
  return EXIT[verdict];
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────
async function selfTest() {
  const lines = [];
  const rec = (kind, name, ok, reason) => { lines.push(ok); out(`${kind} ${name} ${ok ? 'PASS' : 'FAIL'} ${reason}`); };
  const quietConsole = () => { for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = () => undefined; };

  // Hermetic by construction: no network credentials of any kind, an isolated DB, every env read
  // happens before the first dist import.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-e2e-selftest-'));
  for (const k of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'STEPUP_MODE', 'X402_PAY_TO']) delete process.env[k];
  Object.assign(process.env, {
    MCP_OAUTH: 'optin',
    PERFORMANCE_DB_PATH: path.join(tmp, 'performance.db'),
    ALGOVAULT_IP_HASH_KEY: randomBytes(24).toString('hex'),
  });
  quietConsole();

  const dist = path.resolve(HERE, '..', 'dist');
  const loadOpt = async (rel) => {
    try {
      const m = await import(pathToFileURL(path.join(dist, rel)).href);
      return { ...(m.default && typeof m.default === 'object' ? m.default : {}), ...m };
    } catch { return null; }
  };
  const mods = {};
  for (const [k, rel] of Object.entries({
    index: 'index.js', license: 'lib/license.js', tier: 'lib/tier-warning.js', routes: 'lib/oauth/routes.js',
    provider: 'lib/oauth/provider.js', mode: 'lib/oauth/mode.js', analytics: 'lib/analytics.js', clientIp: 'lib/client-ip.js',
    freeKeys: 'lib/free-keys-store.js', registry: 'lib/feature-registry.js', perfDb: 'lib/performance-db.js',
  })) {
    mods[k] = await loadOpt(rel);
    if (!mods[k]) {
      rec('PRE', 'dist', false, `dist/${rel} will not import — run \`npm run build\` first`);
      out('OAUTH_E2E_SELFTEST=FAIL');
      return 1;
    }
  }
  const challengeMod = await loadOpt('lib/oauth/challenge.js');
  const seam = typeof challengeMod?.applyChallenge === 'function' ? challengeMod.applyChallenge : null;
  const { default: express } = await import('express');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');

  // PRE: the instrument must match the thing it measures.
  rec('PRE', 'aggregate', aggregate(['PASS', 'FAIL']) === 'FAIL' && aggregate(['PASS', 'INDETERMINATE']) === 'INDETERMINATE' && aggregate(['PASS', 'PASS']) === 'PASS'
    && aggregate([]) === 'INDETERMINATE' && aggregate(['FAIL', 'INDETERMINATE']) === 'FAIL', 'verdict fold: FAIL > INDETERMINATE > PASS, no legs is INDETERMINATE');
  const srcRoot = path.resolve(HERE, '..', 'src');
  const stale = [];
  for (const rel of ['index', 'lib/license', 'lib/oauth/metadata', 'lib/oauth/routes', 'lib/oauth/provider', 'lib/oauth/mode', 'lib/oauth/challenge']) {
    const ts = path.join(srcRoot, `${rel}.ts`);
    const js = path.join(dist, `${rel}.js`);
    if (!fs.existsSync(ts)) continue;
    if (!fs.existsSync(js) || fs.statSync(js).mtimeMs < fs.statSync(ts).mtimeMs) stale.push(rel);
  }
  rec('PRE', 'dist-fresh', stale.length === 0, stale.length === 0 ? 'dist is newer than the sources the harness exercises' : `dist is stale for ${stale.join(', ')} — run \`npm run build\``);
  rec('PRE', 'constants', mods.provider.REFRESH_GRACE_MS === REFRESH_GRACE_MS && mods.mode.OAUTH_ISSUER === ISSUER && mods.mode.OAUTH_RESOURCE === RESOURCE,
    'REFRESH_GRACE_MS, issuer and resource in this script equal the compiled values');
  const unit = (n) => mods.registry.getFeature(n)?.quota?.unit;
  rec('PRE', 'stub-matches-registry', unit('get_trade_call') !== undefined && unit('get_trade_call') !== 'rate-limited' && unit('get_track_record') === 'rate-limited',
    `registry: get_trade_call is metered (${unit('get_trade_call')}), get_track_record is rate-limited — the stub tool charges the way the real one is classified`);
  rec('PRE', 'seam', seam !== null, seam ? 'applyChallenge present in dist/lib/oauth/challenge.js' : 'challenge seam absent: dist/lib/oauth/challenge.js has no applyChallenge');

  // The hermetic tools. `get_trade_call` is a STUB: it replaces market data + the verdict, and keeps
  // exactly the metering sequence of the real handler (checkQuota → trackCall → withQuotaState with the
  // post-charge reading) using the REAL functions, so the meter the harness reads is the real meter.
  const dayResetMs = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
  const makeServer = () => {
    const s = new McpServer({ name: 'oauth-e2e-hermetic', version: '0.0.0' });
    s.tool('get_trade_call', { coin: z.string() }, async ({ coin }) => {
      const license = mods.license.getRequestLicense();
      const pre = mods.license.checkQuota(license);
      if (!pre.allowed) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'quota_exhausted' }) }] };
      const charged = mods.license.trackCall(license);
      const meta = mods.tier.withQuotaState({ tool: 'get_trade_call' }, {
        tier: license.tier, used: charged.used, total: charged.total, resetAtMs: mods.license.monthResetAtMs(license),
        dailyUsed: charged.daily_used, dailyTotal: charged.daily_total, dailyResetAtMs: dayResetMs(),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ call: 'HOLD', coin, _algovault: meta }) }] };
    });
    s.tool('get_track_record', async () => ({ content: [{ type: 'text', text: JSON.stringify({ hermetic: true }) }] }));
    return s;
  };

  const servers = [];
  async function makeApp({ oauth, withSeam, chargeFirst = false, trustProxy = false }) {
    const app = express();
    if (trustProxy) app.set('trust proxy', true);
    if (oauth) await mods.routes.mountOAuth(app, 'optin');
    app.all('/mcp', express.json(), async (req, res) => {
      const { license, x402Downgrade } = await mods.license.resolveLicense(req.headers, { oauth: true });
      if (mods.index.applyCredentialRefusal(req, res, license)) return;
      const ipHash = mods.analytics.hashIp(mods.clientIp.clientIp(req) || 'unknown');
      const sessionId = ipHash;
      const userAgent = req.headers['user-agent'] ?? null;
      if (chargeFirst && req.query?.signin === '1' && req.body?.method === 'tools/call' && license.anonymous === true) {
        await mods.license.requestContext.run({ license, sessionId, ipHash, userAgent }, async () => { mods.license.trackCall(license); });
      }
      if (withSeam && seam && await seam(req, res, license, x402Downgrade, { ipHash, sessionId })) return;
      await mods.license.requestContext.run({ license, sessionId, ipHash, userAgent }, () => mods.index.handleMcpStateless(req, res, makeServer));
    });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  // The identity's free key, minted through the REAL store into the isolated DB (never printed).
  // On a FRESH SQLite file the store adds `bucket_key` fire-and-forget right after the first schema
  // ensure, so the first read can beat the ALTER ("no such column"). Warm the schema, then retry that
  // one error a few times; anything else is a real failure.
  mods.freeKeys.ensureFreeKeysSchema();
  let minted;
  for (let attempt = 0; ; attempt += 1) {
    try { minted = await mods.freeKeys.mintFreeKeyOutcome('oauth-e2e-selftest@example.test'); break; }
    catch (e) {
      if (attempt >= 8 || !/no such column: bucket_key/.test(String(e?.message))) throw e;
      await sleep(150);
    }
  }
  addSecret(minted.key);

  // The key reaches the legs through the REAL env-file reader (mode 600), exactly as in production.
  const envFile = path.join(tmp, 'oauth-e2e.env');
  fs.writeFileSync(envFile, `# hermetic\nOAUTH_E2E_API_KEY=${minted.key}\n`, { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  const viaFile = readApiKey(envFile);
  rec('PRE', 'env-file-reader', viaFile.apiKey === minted.key, 'a mode-600 env file yields the key');
  fs.chmodSync(envFile, 0o644);
  const loose = readApiKey(envFile);
  rec('PRE', 'env-file-mode-refused', !loose.apiKey && /mode 600/.test(loose.keyErr ?? ''), 'a group/world-readable env file is refused, not read');
  fs.chmodSync(envFile, 0o600);
  fs.writeFileSync(envFile, '# no key here\n', { mode: 0o600 });
  rec('PRE', 'env-file-missing-var', !readApiKey(envFile).apiKey, 'an env file without OAUTH_E2E_API_KEY yields no key');

  const goodBase = await makeApp({ oauth: true, withSeam: true });
  const loop = await startLoopback();
  const mk = (over = {}, base = goodBase) => newCtx(baseCfg({ base, apiKey: viaFile.apiKey, seamAbsent: seam === null, graceMarginMs: 1_500, ...over }), loop, { quiet: true });

  // INSTRUMENT CALIBRATION: two consecutive plain metered calls move the real meter by exactly 1 each,
  // and a challenge-less server reads the same — so "+1" in signin-meter means what it says.
  {
    const c = mk();
    const a = await plainMeteredCall(c, 11);
    const b = await plainMeteredCall(c, 12);
    rec('PRE', 'meter-instrument', a.ok && b.ok && b.used - a.used === 1, `two plain calls through the real trackCall read ${a.ok ? a.used : '?'} -> ${b.ok ? b.used : '?'} (exactly +1 each)`);
  }

  // ── the main run: every leg, against the production-ordered server ──
  const main = mk();
  main.quiet = false;
  await runLegs(main);
  for (const r of main.results) lines.push(r.status === 'PASS');

  // ── negative controls: each leg must be able to go red ──
  const control = async (name, build, want = 'FAIL') => {
    let result;
    try { result = await build(); } catch (e) { result = { status: 'ERROR', reason: String(e?.message ?? e) }; }
    rec('CONTROL', name, result.status === want, result.status === want ? `answered ${want} as required: ${result.reason}` : `expected ${want}, got ${result.status}: ${result.reason}`);
  };
  const legResult = (ctx, name) => ctx.results.find((r) => r.name === name) ?? { status: 'MISSING', reason: 'leg did not run' };

  if (seam) {
    await control('challenge-not-served', async () => {
      const c = mk({}, await makeApp({ oauth: false, withSeam: false }));
      await signinLegs(c);
      return legResult(c, 'signin-challenge');
    });
    await control('challenge-charges-meter', async () => {
      const c = mk({}, await makeApp({ oauth: false, withSeam: true, chargeFirst: true }));
      await signinLegs(c);
      return legResult(c, 'signin-meter');
    });
  } else {
    rec('CONTROL', 'challenge-not-served', false, 'cannot build the challenge controls: seam absent');
  }
  if (seam) {
    // A caller whose meter is already spent cannot be observed: signin-meter must say INDETERMINATE,
    // never PASS — while the challenge itself (which never reads the meter) must still be a clean PASS.
    const walled = '203.0.113.77';
    const wallBase = await makeApp({ oauth: false, withSeam: true, trustProxy: true });
    const license = { tier: 'free', key: null, outcome: 'ABSENT', anonymous: true };
    const ipHash = mods.analytics.hashIp(walled);
    await mods.license.requestContext.run({ license, sessionId: ipHash, ipHash }, async () => { for (let i = 0; i < 400; i += 1) mods.license.trackCall(license); });
    const wc = mk({ extraHeaders: { 'x-forwarded-for': walled } }, wallBase);
    await signinLegs(wc);
    await control('walled-meter-is-indeterminate', async () => legResult(wc, 'signin-meter'), 'INDETERMINATE');
    await control('walled-challenge-still-401', async () => legResult(wc, 'signin-challenge'), 'PASS');
  }
  await control('key-unavailable-is-indeterminate', async () => {
    const c = mk({ apiKey: null, keyErr: 'no key (control)' });
    await runLegs(c, 'authorize');
    return legResult(c, 'authorize');
  }, 'INDETERMINATE');
  await control('wrong-issuer-expectation', async () => {
    const c = mk({ expectIss: 'https://wrong.example' });
    await runLegs(c, 'loopback-redirect');
    return legResult(c, 'loopback-redirect');
  });
  await control('wrong-replay-expectation', async () => {
    const c = mk({ replayExpect: 'original' });
    await runLegs(c, 'refresh-grace-replay');
    return legResult(c, 'refresh-grace-replay');
  });
  await control('wrong-revoked-status-expectation', async () => {
    const c = mk({ revokedStatus: 200 });
    await runLegs(c, 'revoke');
    return legResult(c, 'revoke');
  });

  const allOk = lines.every(Boolean) && lines.length > 0;
  out(`OAUTH_E2E_SELFTEST=${allOk ? 'PASS' : 'FAIL'}`);
  await loop.close();
  for (const s of servers) s.close();
  try { mods.perfDb.closeDb?.(); } catch { /* best-effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  return allOk ? 0 : 1;
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { base: ISSUER, envFile: DEFAULT_ENV_FILE, selfTest: false };
  const args = argv.flatMap((a) => (/^--(base|env-file)=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]));
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--base') o.base = args[++i] ?? '';
    else if (a === '--env-file') o.envFile = (args[++i] ?? '').replace(/^~(?=$|\/)/, os.homedir());
    else if (a === '--help' || a === '-h') o.help = true;
    else o.bad = a;
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  // `process.exitCode`, never `process.exit()`: an exit drops a queued pipe write, and the verdict
  // token is the last line written (tests/unit/verdict-exit-path.test.ts).
  if (o.help || o.bad || !/^https?:\/\//.test(o.base)) {
    process.stderr.write('usage: node scripts/oauth-e2e.mjs [--base https://api.algovault.com] [--env-file <path>] | --self-test\n');
    process.exitCode = o.help ? 0 : 2;
  } else {
    process.exitCode = await (o.selfTest ? selfTest() : runProduction(o)).catch((e) => {
      errOut(`fatal: ${e?.name}: ${e?.message}`);
      out(o.selfTest ? 'OAUTH_E2E_SELFTEST=FAIL' : 'OAUTH_E2E_VERDICT=INDETERMINATE');
      return o.selfTest ? 1 : 3;
    });
  }
}
