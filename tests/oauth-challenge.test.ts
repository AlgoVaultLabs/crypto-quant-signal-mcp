/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH3 — the sign-in challenge.
 *
 * Four layers, each pinning what the one below it cannot:
 *   1. DECISION_MATRIX — `decideChallenge` over every input × every mode, against R3.1 written out
 *      as a separate oracle, plus when the meter may be read (never for `signin`).
 *   2. HTTP — the REAL `applyChallenge` behind the real `resolveLicense` and credential gate, in
 *      production order: the 401 contract byte for byte, the never-challenged credentials, a
 *      challenge charging nothing, and the replaces-refusal (R-2) invariant: every wall fixture
 *      that answers 401 in `wall` is REFUSED by the tool in `optin` — the challenge only ever
 *      replaces a refusal, never a served call.
 *   3. BUILDER PARITY — both `/mcp` 401s go through `sendBearerChallenge`; TOKEN_INVALID's header
 *      stays byte-identical to the literal CH2 shipped.
 *   4. SEAM ORDER — the route calls the seam on the line after the credential gate, above every
 *      emit and charge. A test app cannot BE the route's wiring, so the source is read.
 *
 * Two ambient answers are pinned, nothing else: `oauthHealthy()` (the store's breaker) and the
 * funnel writer (captured, so `stepup_challenge` / `quota_hit_block` can be counted).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const h = vi.hoisted(() => {
  process.env.ALGOVAULT_IP_HASH_KEY ??= 'a'.repeat(64);
  return {
  healthy: true,
  events: [] as Array<{ eventType: string; meta?: Record<string, unknown> }>,
  };
});

vi.mock('../src/lib/oauth/store.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/oauth/store.js')>()),
  oauthHealthy: () => h.healthy,
}));
vi.mock('../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/performance-db.js')>()),
  recordFunnelEvent: (e: { eventType: string; meta?: Record<string, unknown> }) => { h.events.push(e); },
}));
vi.mock('../src/lib/stripe.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/stripe.js')>()),
  // Only the API-key fixture is a paid key; anything else gets the real unconfigured answer
  // (`stripe.ts`: no STRIPE_SECRET_KEY → indeterminate), so MALFORMED stays MALFORMED.
  validateApiKey: vi.fn(async (k: string) => (k === `av_live_${'1'.repeat(24)}`
    ? { valid: true, tier: 'pro', entitlementState: 'ENTITLED', email: 'paid@example.com' }
    : { valid: false, indeterminate: true })),
}));

import { handleMcpStateless, applyCredentialRefusal } from '../src/index.js';
import {
  resolveLicense, requestContext, getRequestLicense, checkQuota, trackCall,
  checkQuotaByKey, trackCallByKey, _resetCallTrackersForTest,
} from '../src/lib/license.js';
import { hashIp } from '../src/lib/analytics.js';
import { clientIp } from '../src/lib/client-ip.js';
import { classifyClient } from '../src/lib/client-registry.js';
import { resolveSessionIdentity } from '../src/lib/track-token.js';
import { FREE_DAILY_CALLS, FREE_MONTHLY_CALLS, freeCallsLabel } from '../src/lib/plans.js';
import {
  applyChallenge, decideChallenge, isMeteredTool, challengeMessage, _resetChallengeForTest,
  CHALLENGE_DESCRIPTION, SIGN_IN_URL, type ChallengeInput, type QuotaPeek,
} from '../src/lib/oauth/challenge.js';
import { bearerChallengeHeader, sendBearerChallenge } from '../src/lib/oauth/metadata.js';
import type { OAuthMode } from '../src/lib/oauth/mode.js';
import type { LicenseInfo } from '../src/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const METERED = 'get_trade_call';
const RATE_LIMITED = 'get_track_record';
const CLAUDE_UA = 'Claude-User/1.0 (+https://www.anthropic.com)';
const CLAUDE_CODE_UA = 'claude-code/2.0.14';
const UNDICI_UA = 'undici';
const EGRESS_IP = '160.79.104.0';   // the a.b.c.0 form the edge delivers (platform-egress.ts)
const OUTSIDE_IP = '203.0.113.0';
const UNEXPANDED_ENV = '${env:AV_API_KEY}'; // resolves MALFORMED — always served

// ── 1. the pure decision ─────────────────────────────────────────────────────

type Quota = 'allowed' | 'monthly' | 'daily' | 'limitless' | 'null' | 'throws';
const QUOTAS: Quota[] = ['allowed', 'monthly', 'daily', 'limitless', 'null', 'throws'];
const peekOf = (q: Quota): (() => QuotaPeek | null) => () => {
  if (q === 'throws') throw new Error('meter unreadable');
  if (q === 'null') return null;
  if (q === 'allowed') return { allowed: true, limit: null };
  return { allowed: false, limit: q === 'limitless' ? null : q };
};

/** R3.1 written out independently of the implementation. */
function oracle(i: Omit<ChallengeInput, 'peekQuota'>, q: Quota): { want: string; peeks: boolean } {
  const base = i.mode !== 'off' && i.healthy && i.httpMethod === 'POST' && i.rpcMethod === 'tools/call'
    && i.tool === METERED && i.anonymous && !i.hasAuthorization && !i.hasPaymentHeader && !i.x402Downgrade;
  if (!base) return { want: 'serve', peeks: false };
  if (i.signin) return { want: 'signin', peeks: false };
  const wallBranch = i.mode === 'wall' && i.anthropicEgress && i.clientFamily === 'claude';
  if (!wallBranch) return { want: 'serve', peeks: false };
  if (q === 'monthly' || q === 'limitless') return { want: 'wall_month', peeks: true };
  if (q === 'daily') return { want: 'wall_day', peeks: true };
  return { want: 'serve', peeks: true };
}

describe('DECISION_MATRIX — every input × every mode', () => {
  it('matches R3.1 on all combinations, and reads the meter only on the wall branch', () => {
    const B = [false, true];
    let n = 0;
    const misses: string[] = [];
    for (const mode of ['off', 'optin', 'wall'] as OAuthMode[]) for (const healthy of B)
    for (const httpMethod of ['POST', 'GET']) for (const rpcMethod of ['tools/call', 'tools/list'])
    for (const tool of [METERED, RATE_LIMITED, undefined]) for (const anonymous of B)
    for (const hasAuthorization of B) for (const hasPaymentHeader of B) for (const x402Downgrade of B)
    for (const signin of B) for (const anthropicEgress of B)
    for (const clientFamily of ['claude', 'claude-code', 'undici', 'other']) for (const q of QUOTAS) {
      const input = { mode, healthy, httpMethod, rpcMethod, tool, anonymous, hasAuthorization, hasPaymentHeader, x402Downgrade, signin, anthropicEgress, clientFamily };
      let peeks = 0;
      const peek = peekOf(q);
      const d = decideChallenge({ ...input, peekQuota: () => { peeks += 1; return peek(); } });
      const got = d.shape === 'serve' ? 'serve' : d.reason;
      const o = oracle(input, q);
      n += 1;
      if (got !== o.want || peeks !== (o.peeks ? 1 : 0)) {
        if (misses.length < 5) misses.push(`${JSON.stringify({ ...input, q })} → ${got}/${peeks} want ${o.want}/${o.peeks}`);
      }
    }
    expect(misses).toEqual([]);
    expect(n).toBe(3 * 2 * 2 * 2 * 3 * 2 * 2 * 2 * 2 * 2 * 2 * 4 * 6);
  });

  const ok: Omit<ChallengeInput, 'peekQuota'> = {
    mode: 'wall', healthy: true, httpMethod: 'POST', rpcMethod: 'tools/call', tool: METERED, anonymous: true,
    hasAuthorization: false, hasPaymentHeader: false, x402Downgrade: false, signin: false, anthropicEgress: true, clientFamily: 'claude',
  };
  const decide = (over: Partial<ChallengeInput>, q: Quota = 'monthly') => {
    const d = decideChallenge({ ...ok, peekQuota: peekOf(q), ...over });
    return d.shape === 'serve' ? 'serve' : d.reason;
  };

  it('the named cases', () => {
    expect(decide({})).toBe('wall_month');
    expect(decide({}, 'daily')).toBe('wall_day');
    expect(decide({ hasAuthorization: true })).toBe('serve');                // MALFORMED / API key / token
    expect(decide({ hasAuthorization: true, signin: true })).toBe('serve');
    expect(decide({ anonymous: false, signin: true })).toBe('serve');
    expect(decide({ hasPaymentHeader: true, signin: true })).toBe('serve');
    expect(decide({ x402Downgrade: true, signin: true })).toBe('serve');
    expect(decide({ anthropicEgress: false })).toBe('serve');                 // family claude outside egress
    for (const f of ['undici', 'other', 'claude-code']) expect(decide({ clientFamily: f })).toBe('serve');
    expect(decide({ clientFamily: 'claude-code', signin: true, anthropicEgress: false })).toBe('signin');
    expect(decide({ tool: RATE_LIMITED, signin: true })).toBe('serve');
    expect(decide({ healthy: false, signin: true })).toBe('serve');
    expect(decide({ mode: 'optin' })).toBe('serve');
    expect(decide({ mode: 'optin', signin: true })).toBe('signin');
    expect(decide({ mode: 'off', signin: true })).toBe('serve');
  });

  it('metered = the registry charges for it; rate-limited and unknown names are not', () => {
    for (const t of ['get_trade_call', 'get_market_regime', 'scan_funding_arb', 'scan_trade_calls', 'scan_market_regimes', 'get_equity_call', 'get_equity_regime']) {
      expect(isMeteredTool(t), t).toBe(true);
    }
    for (const t of ['chat_knowledge', 'search_knowledge', 'get_track_record', 'no_such_tool', undefined]) {
      expect(isMeteredTool(t), String(t)).toBe(false);
    }
  });
});

// ── 2. the real seam over HTTP ───────────────────────────────────────────────

let server: Server;
let base = '';
let served = 0;
let refused = 0;

function makeServer(): McpServer {
  const s = new McpServer({ name: 'test-oauth-challenge', version: '0.0.0' });
  // Stand-ins for a metered and a rate-limited tool: the metered one refuses on the meter exactly
  // as the real tools do (checkQuota → refuse, else trackCall).
  s.tool(METERED, async () => {
    const lic = getRequestLicense();
    if (!checkQuota(lic).allowed) { refused += 1; return { isError: true, content: [{ type: 'text' as const, text: 'QUOTA_EXCEEDED' }] }; }
    trackCall(lic);
    served += 1;
    return { content: [{ type: 'text' as const, text: 'served' }] };
  });
  s.tool(RATE_LIMITED, async () => { served += 1; return { content: [{ type: 'text' as const, text: 'served' }] }; });
  return s;
}

beforeAll(async () => {
  // Production's order: express.json → resolveLicense({ oauth: true }) → credential gate →
  // ipHash / sessionId → THE SEAM → requestContext.run → dispatch.
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.all('/mcp', async (req, res) => {
    try {
      const { license, x402Downgrade } = await resolveLicense(req.headers as Record<string, string | undefined>, { oauth: true });
      if (applyCredentialRefusal(req, res, license)) return;
      const ipHash = hashIp(clientIp(req) || 'unknown');
      const sessionId = resolveSessionIdentity(req.headers as Record<string, unknown>, ipHash).id;
      if (await applyChallenge(req, res, license, x402Downgrade, { ipHash, sessionId })) return;
      await requestContext.run({ license, sessionId, ipHash, userAgent: req.headers['user-agent'] ?? null }, () => handleMcpStateless(req, res, makeServer));
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => { server?.close(); });

beforeEach(() => {
  h.healthy = true;
  h.events.length = 0;
  served = 0;
  refused = 0;
  process.env.MCP_OAUTH = 'wall';
  delete process.env.STEPUP_MODE;
  _resetCallTrackersForTest();
  _resetChallengeForTest();
});
afterEach(() => { delete process.env.MCP_OAUTH; delete process.env.STEPUP_MODE; });

const call = (tool = METERED, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: {} } });

async function post(opts: { query?: string; ip?: string; ua?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const r = await fetch(base + (opts.query ?? ''), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'X-Forwarded-For': opts.ip ?? OUTSIDE_IP, 'User-Agent': opts.ua ?? UNDICI_UA, ...opts.headers,
    },
    body: JSON.stringify(opts.body ?? call()),
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

const bucket = (ip: string) => `free:${hashIp(ip)}`;
const used = (ip: string) => checkQuotaByKey(bucket(ip), 'free').used;
const exhaust = (ip: string, units: number) => trackCallByKey(bucket(ip), 'free', units);
const ofType = (t: string) => h.events.filter((e) => e.eventType === t);

describe('the 401 contract, byte for byte', () => {
  it('?signin=1 → 401 with the exact header, no-store and body; the echoed query is allow-listed', async () => {
    const r = await post({ query: '?src=docs&signin=1&evil=x' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", error_description="Sign in free to keep using AlgoVault", scope="mcp:tools", '
      + 'resource_metadata="https://api.algovault.com/.well-known/oauth-protected-resource/mcp?src=docs&signin=1"',
    );
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.text).toBe(
      '{"error":"invalid_token","error_description":"Sign in free to keep using AlgoVault","algovault":'
      + '{"reason":"signin","message":"Sign in to continue. It\'s free, no card.","sign_in_url":"https://api.algovault.com/welcome?src=stepup"}}',
    );
  });

  it('§Copy A wall messages, with N and FREE derived — and literal under STEPUP_MODE=live', () => {
    expect(challengeMessage('wall_day')).toBe(`You've used today's calls available without signing in. Sign in free for ${freeCallsLabel()} calls a month, no card.`);
    process.env.STEPUP_MODE = 'live';
    expect(challengeMessage('wall_month')).toBe("You've used the 20 calls available without signing in this month. Sign in free for 200 calls a month, no card.");
    expect(CHALLENGE_DESCRIPTION).toBe('Sign in free to keep using AlgoVault');
    expect(SIGN_IN_URL).toBe('https://api.algovault.com/welcome?src=stepup');
  });

  it('the wall: Claude at Anthropic egress past the monthly meter → 401 wall_month', async () => {
    exhaust(EGRESS_IP, FREE_MONTHLY_CALLS);
    const r = await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).algovault).toMatchObject({ reason: 'wall_month' });
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://api.algovault.com/.well-known/oauth-protected-resource/mcp"');
  });

  it('the daily wall → 401 wall_day', async () => {
    exhaust(EGRESS_IP, FREE_DAILY_CALLS);
    const r = await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).algovault).toMatchObject({ reason: 'wall_day', message: challengeMessage('wall_day') });
  });
});

describe('CHALLENGE_CHARGES_NOTHING', () => {
  it('a signin challenge: no dispatch, meter unchanged, the meter never read, one stepup_challenge only', async () => {
    exhaust(OUTSIDE_IP, 7);
    const r = await post({ query: '?signin=1' });
    expect(r.status).toBe(401);
    expect(served + refused).toBe(0);
    expect(used(OUTSIDE_IP)).toBe(7);
    expect(h.events.map((e) => e.eventType)).toEqual(['stepup_challenge']);
    expect(h.events[0].meta).toEqual({ reason: 'signin', client_family: 'undici', pool: 'other' });
  });

  it('a wall challenge: no dispatch, meter unchanged; the peek writes quota_hit_block (C20) and nothing else', async () => {
    exhaust(EGRESS_IP, FREE_MONTHLY_CALLS);
    const r = await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    expect(r.status).toBe(401);
    expect(served + refused).toBe(0);
    expect(used(EGRESS_IP)).toBe(FREE_MONTHLY_CALLS);
    expect(h.events.map((e) => e.eventType).sort()).toEqual(['quota_hit_block', 'stepup_challenge']);
    expect(ofType('stepup_challenge')[0].meta).toEqual({ reason: 'wall_month', client_family: 'claude', pool: 'anthropic' });
  });

  it('stepup_challenge is at most one row per bucket per reason per minute', async () => {
    for (let i = 0; i < 3; i++) expect((await post({ query: '?signin=1' })).status).toBe(401);
    expect(ofType('stepup_challenge')).toHaveLength(1);
    exhaust(EGRESS_IP, FREE_MONTHLY_CALLS);
    await post({ ip: EGRESS_IP, ua: CLAUDE_UA, query: '?signin=1' });
    await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    expect(ofType('stepup_challenge').map((e) => e.meta?.reason)).toEqual(['signin', 'signin', 'wall_month']);
  });
});

describe('quota_hit_block on the wall only', () => {
  it('a signin challenge on an exhausted bucket never reads the meter → no quota_hit_block', async () => {
    exhaust(EGRESS_IP, FREE_MONTHLY_CALLS);
    expect((await post({ ip: EGRESS_IP, ua: CLAUDE_UA, query: '?signin=1' })).status).toBe(401);
    expect(ofType('quota_hit_block')).toHaveLength(0);
  });

  it('the wall peek emits it once, with client_family', async () => {
    exhaust(EGRESS_IP, FREE_MONTHLY_CALLS);
    await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    expect(ofType('quota_hit_block')).toHaveLength(1);
    expect(ofType('quota_hit_block')[0].meta).toMatchObject({ limit: 'monthly', client_family: 'claude' });
  });
});

describe('REPLACES_REFUSAL_INVARIANT (R-2) — the wall only ever replaces a refusal', () => {
  const fixtures: Array<[string, number]> = [['monthly', FREE_MONTHLY_CALLS], ['daily', FREE_DAILY_CALLS]];
  for (const [name, units] of fixtures) {
    it(`${name}: 401 under wall; under optin the same call is REFUSED by the tool, never served`, async () => {
      exhaust(EGRESS_IP, units);
      expect((await post({ ip: EGRESS_IP, ua: CLAUDE_UA })).status).toBe(401);
      process.env.MCP_OAUTH = 'optin';
      const r = await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
      expect(r.status).toBe(200);
      expect(r.text).toContain('QUOTA_EXCEEDED');
      expect(refused).toBe(1);
      expect(served).toBe(0);
    });
  }

  it('under the meter, the wall serves — the same caller is not challenged', async () => {
    exhaust(EGRESS_IP, FREE_DAILY_CALLS - 1);
    const r = await post({ ip: EGRESS_IP, ua: CLAUDE_UA });
    expect(r.status).toBe(200);
    expect(served).toBe(1);
  });
});

describe('never challenged', () => {
  // Every bucket these cases touch is past the meter, so each case is served ONLY by the check it
  // names — a dropped egress or header check turns it into a 401 (the mutations prove it).
  // A MALFORMED bearer meters on its own literal (`deriveTrackerKey`: `license.key` first).
  beforeEach(() => {
    for (const ip of [EGRESS_IP, OUTSIDE_IP, '160.79.112.0']) exhaust(ip, FREE_MONTHLY_CALLS);
    trackCallByKey(UNEXPANDED_ENV, 'free', FREE_MONTHLY_CALLS);
  });

  const cases: Array<[string, Parameters<typeof post>[0]]> = [
    ['a MALFORMED bearer, even with ?signin=1', { query: '?signin=1', headers: { Authorization: `Bearer ${UNEXPANDED_ENV}` } }],
    ['a MALFORMED bearer at the wall', { ip: EGRESS_IP, ua: CLAUDE_UA, headers: { Authorization: `Bearer ${UNEXPANDED_ENV}` } }],
    ['an API key, even with ?signin=1', { query: '?signin=1', headers: { Authorization: `Bearer av_live_${'1'.repeat(24)}` } }],
    ['an x402 v1 proof header', { query: '?signin=1', headers: { 'X-Payment': 'not-a-proof' } }],
    ['an x402 v2 proof header', { query: '?signin=1', headers: { 'Payment-Signature': 'not-a-proof' } }],
    ['Claude outside Anthropic egress', { ip: '160.79.112.0', ua: CLAUDE_UA }],
    ['undici inside egress', { ip: EGRESS_IP, ua: UNDICI_UA }],
    ['Claude Code inside egress', { ip: EGRESS_IP, ua: CLAUDE_CODE_UA }],
    ['a rate-limited tool, even with ?signin=1', { query: '?signin=1', body: call(RATE_LIMITED) }],
    ['tools/list with ?signin=1', { query: '?signin=1', body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } }],
  ];
  for (const [name, opts] of cases) {
    it(name, async () => {
      const r = await post(opts);
      expect(r.status, r.text).not.toBe(401);
      expect(ofType('stepup_challenge')).toHaveLength(0);
    });
  }

  it('the fixtures are what they claim: MALFORMED and x402 headers resolve anonymous, so only the header checks serve them', async () => {
    for (const hd of [{ authorization: `Bearer ${UNEXPANDED_ENV}` }, { 'x-payment': 'not-a-proof' }, { 'payment-signature': 'not-a-proof' }]) {
      const { license } = await resolveLicense(hd, { oauth: true });
      expect({ hd, anonymous: license.anonymous, tier: license.tier }).toEqual({ hd, anonymous: true, tier: 'free' });
    }
  });

  it('the fixtures classify as the families they claim', () => {
    expect(classifyClient(CLAUDE_UA).name).toBe('claude');
    expect(classifyClient(CLAUDE_CODE_UA).name).toBe('claude-code');
    expect(classifyClient(UNDICI_UA).name).toBe('undici');
  });

  it('Claude Code with ?signin=1 IS challenged — the parameter is an explicit ask', async () => {
    expect((await post({ ua: CLAUDE_CODE_UA, query: '?signin=1' })).status).toBe(401);
  });

  it('oauthHealthy() false → served, even with ?signin=1 and at the wall', async () => {
    h.healthy = false;
    expect((await post({ query: '?signin=1' })).status).toBe(200);
    expect((await post({ ip: EGRESS_IP, ua: CLAUDE_UA })).status).toBe(200);
  });

  it('optin → only ?signin=1; off → never', async () => {
    process.env.MCP_OAUTH = 'optin';
    expect((await post({ ip: EGRESS_IP, ua: CLAUDE_UA })).status).toBe(200);
    expect((await post({ ip: EGRESS_IP, ua: CLAUDE_UA, query: '?signin=1' })).status).toBe(401);
    process.env.MCP_OAUTH = 'off';
    expect((await post({ ip: EGRESS_IP, ua: CLAUDE_UA, query: '?signin=1' })).status).toBe(200);
  });
});

// ── 3. one builder, both 401s ────────────────────────────────────────────────

function captureRes() {
  const out: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const res = {
    setHeader(k: string, v: string) { out.headers[k] = v; },
    status(c: number) { out.status = c; return { json(b: unknown) { out.body = b; } }; },
  };
  return { out, res };
}

describe('BUILDER PARITY', () => {
  // The literal CH2 shipped in applyCredentialRefusal, before the builder existed.
  const TOKEN_INVALID_HEADER = 'Bearer error="invalid_token", error_description="The access token is invalid or expired.", scope="mcp:tools", resource_metadata="https://api.algovault.com/.well-known/oauth-protected-resource/mcp?src=docs"';

  it("TOKEN_INVALID's 401 is byte-identical to CH2's literal, and goes through the builder", () => {
    const { out, res } = captureRes();
    const req = { method: 'POST', originalUrl: '/mcp?src=docs', body: { method: 'tools/list', id: 1 } };
    const lic = { tier: 'free', key: null, outcome: 'TOKEN_INVALID' } as unknown as LicenseInfo;
    expect(applyCredentialRefusal(req as never, res as never, lic)).toBe(true);
    expect(out.status).toBe(401);
    expect(out.headers['WWW-Authenticate']).toBe(TOKEN_INVALID_HEADER);
    expect(out.headers['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(out.body)).toBe('{"error":"invalid_token","error_description":"The access token is invalid or expired."}');
    const viaBuilder = captureRes();
    sendBearerChallenge(viaBuilder.res, '/mcp?src=docs', 'The access token is invalid or expired.');
    expect(viaBuilder.out).toEqual(out);
  });

  it('the two headers differ only in the description', () => {
    const a = bearerChallengeHeader('/mcp?signin=1', 'The access token is invalid or expired.');
    const b = bearerChallengeHeader('/mcp?signin=1', CHALLENGE_DESCRIPTION);
    expect(a.replace('The access token is invalid or expired.', CHALLENGE_DESCRIPTION)).toBe(b);
  });

  it('both descriptions sit inside RFC 6750 §3 error_description charset', () => {
    for (const d of ['The access token is invalid or expired.', CHALLENGE_DESCRIPTION]) {
      expect(d).toMatch(/^[\x20\x21\x23-\x5B\x5D-\x7E]+$/);
    }
  });

  it('no WWW-Authenticate is set in the route file — every 401 goes through the builder', () => {
    const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
    expect(src).not.toMatch(/setHeader\(\s*['"]WWW-Authenticate/);
    expect(src).toContain("sendBearerChallenge(res, req.originalUrl, 'The access token is invalid or expired.');");
    const ch = readFileSync(resolve(ROOT, 'src/lib/oauth/challenge.ts'), 'utf8');
    expect(ch).toContain('sendBearerChallenge(res, req.originalUrl, CHALLENGE_DESCRIPTION,');
  });
});

// ── 4. the wiring ────────────────────────────────────────────────────────────

describe('SEAM_ORDER — the route calls the seam right below the credential gate', () => {
  const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
  const routeStart = src.indexOf("app.all('/mcp', express.json()");
  if (routeStart < 0) throw new Error('the /mcp route registration moved — re-anchor this test');
  const route = src.slice(routeStart);
  const SEAM = 'if (await applyChallenge(req, res, license, x402Downgrade, { ipHash, sessionId })) return;';

  it('the seam is in the route, once', () => {
    expect(route.split(SEAM).length - 1).toBe(1);
  });

  it('gate → hoisted ipHash/sessionId → seam → every emit, charge and dispatch', () => {
    const iGate = route.indexOf('if (applyCredentialRefusal(req, res, license)) return;');
    const iIp = route.indexOf('const ipHash = hashIp(');
    const iSession = route.indexOf('const sessionId = MCP_STATELESS');
    const iSeam = route.indexOf(SEAM);
    expect(iGate).toBeGreaterThan(-1);
    expect(iIp).toBeGreaterThan(iGate);
    expect(iSession).toBeGreaterThan(iIp);
    expect(iSeam).toBeGreaterThan(iSession);
    for (const after of ['recordNonPublicVenue(', 'logSkillInvocation(', 'recordFunnelEvent(', 'recordMcpToolsListEvent(', 'requestContext.run(', 'handleMcpStateless(']) {
      const i = route.indexOf(after);
      expect(i, `${after} must come AFTER the challenge seam`).toBeGreaterThan(iSeam);
    }
  });

  it('nothing between the gate and the seam writes', () => {
    const between = route.slice(route.indexOf('if (applyCredentialRefusal(req, res, license)) return;'), route.indexOf(SEAM));
    for (const w of ['recordFunnelEvent(', 'trackCall(', 'logRequest(', 'recordNonPublicVenue(', 'requestContext.run(', 'res.json(', 'res.status(']) {
      expect(between, w).not.toContain(w);
    }
  });
});
