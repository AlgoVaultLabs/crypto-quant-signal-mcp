/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W3 — the tool-level sign-in challenge (ChatGPT's account-linking trigger).
 *
 * ChatGPT never sees the W1 401: it links an account when a tool declares `securitySchemes` on
 * tools/list AND its refused result carries `_meta["mcp/www_authenticate"]`. Four layers:
 *   1. ELIGIBILITY — `canChallenge` is exactly R3.1's preamble (an independent oracle over the full
 *      product), and `toolWallChallenge` returns the 401's byte-identical header iff it holds.
 *   2. PROJECTION — `toMcpToolResult` attaches the challenge iff the outcome IS a quota wall and the
 *      route decided one; the content is byte-identical either way.
 *   3. THE REAL SERVER over HTTP — `createSandboxServer()` (= `createServer`) behind production's
 *      route order: tools/list carries the schemes on exactly the live metered set, additively; the
 *      thrown and OK-shaped walls reach the wire with `_meta`; mode off / an unhealthy store do not.
 *   4. ROUTE WIRING — the route decides the challenge right after the 401 seam and threads it into
 *      the request context. A test app cannot BE the route, so the source is read.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import express from 'express';

const h = vi.hoisted(() => {
  process.env.ALGOVAULT_IP_HASH_KEY ??= 'a'.repeat(64);
  return { healthy: true };
});

vi.mock('../src/lib/oauth/store.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/oauth/store.js')>()),
  oauthHealthy: () => h.healthy,
}));
vi.mock('../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/performance-db.js')>()),
  recordFunnelEvent: () => {},
}));

import { handleMcpStateless, applyCredentialRefusal, createSandboxServer } from '../src/index.js';
import {
  resolveLicense, requestContext, getRequestWallChallenge, trackCallByKey, _resetCallTrackersForTest,
} from '../src/lib/license.js';
import { hashIp } from '../src/lib/analytics.js';
import { clientIp } from '../src/lib/client-ip.js';
import { resolveSessionIdentity } from '../src/lib/track-token.js';
import { FREE_MONTHLY_CALLS } from '../src/lib/plans.js';
import { liveMcpToolNames } from '../src/lib/equities/equity-tools-flag.js';
import {
  applyChallenge, canChallenge, isMeteredTool, toolWallChallenge, toolSecuritySchemes, _resetChallengeForTest,
  CHALLENGE_DESCRIPTION, TOOL_SECURITY_SCHEMES, type ChallengeEligibility,
} from '../src/lib/oauth/challenge.js';
import { bearerChallengeHeader, WWW_AUTHENTICATE_META_KEY } from '../src/lib/oauth/metadata.js';
import { toMcpToolResult, isQuotaWall, type ValidatedToolInput } from '../src/lib/tool-call-pipeline.js';
import { TierLimitReachedError } from '../src/lib/errors.js';
import type { OAuthMode } from '../src/lib/oauth/mode.js';
import type { LicenseInfo } from '../src/types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const METERED = 'get_trade_call';
const RATE_LIMITED = 'get_track_record';
const CHATGPT_UA = 'openai-mcp/1.0.0';
const OUTSIDE_IP = '203.0.113.0';
/** The literal the 401 has sent since W1 — the `_meta` entry must be this exact string. */
const HEADER_DOCS = 'Bearer error="invalid_token", error_description="Sign in free to keep using AlgoVault", scope="mcp:tools", '
  + 'resource_metadata="https://api.algovault.com/.well-known/oauth-protected-resource/mcp?src=docs"';
const HEADER_BARE = 'Bearer error="invalid_token", error_description="Sign in free to keep using AlgoVault", scope="mcp:tools", '
  + 'resource_metadata="https://api.algovault.com/.well-known/oauth-protected-resource/mcp"';
const SCHEMES = [{ type: 'noauth' }, { type: 'oauth2', scopes: ['mcp:tools'] }];
const ANON: LicenseInfo = { tier: 'free', key: null, outcome: 'ABSENT', anonymous: true };

// ── 1. eligibility ───────────────────────────────────────────────────────────

describe('canChallenge — R3.1 preamble, every combination', () => {
  it('matches an independent oracle on the full product', () => {
    const B = [false, true];
    const misses: string[] = [];
    let n = 0;
    for (const mode of ['off', 'optin', 'wall'] as OAuthMode[]) for (const healthy of B)
    for (const httpMethod of ['POST', 'GET']) for (const rpcMethod of ['tools/call', 'tools/list'])
    for (const tool of [METERED, RATE_LIMITED, undefined]) for (const anonymous of B)
    for (const hasAuthorization of B) for (const hasPaymentHeader of B) for (const x402Downgrade of B) {
      const i: ChallengeEligibility = { mode, healthy, httpMethod, rpcMethod, tool, anonymous, hasAuthorization, hasPaymentHeader, x402Downgrade };
      const want = mode !== 'off' && healthy && httpMethod === 'POST' && rpcMethod === 'tools/call' && tool === METERED
        && anonymous && !hasAuthorization && !hasPaymentHeader && !x402Downgrade;
      n += 1;
      if (canChallenge(i) !== want && misses.length < 5) misses.push(JSON.stringify(i));
    }
    expect(misses).toEqual([]);
    expect(n).toBe(3 * 2 * 2 * 2 * 3 * 2 * 2 * 2 * 2);
  });
});

describe('toolWallChallenge — the 401 header, byte for byte, iff the preamble holds', () => {
  const req = (over: { headers?: Record<string, string>; body?: unknown; method?: string; url?: string } = {}) => ({
    method: over.method ?? 'POST',
    originalUrl: over.url ?? '/mcp?src=docs&evil=x',
    headers: over.headers ?? {},
    query: {},
    body: over.body ?? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: METERED, arguments: {} } },
  }) as unknown as Request;

  beforeEach(() => { process.env.MCP_OAUTH = 'wall'; h.healthy = true; });
  afterEach(() => { delete process.env.MCP_OAUTH; });

  it('an anonymous metered tools/call gets the exact header the 401 sends, echoed query allow-listed', () => {
    expect(toolWallChallenge(req(), ANON, undefined)).toBe(HEADER_DOCS);
    expect(toolWallChallenge(req({ url: '/mcp' }), ANON, undefined)).toBe(HEADER_BARE);
    expect(toolWallChallenge(req(), ANON, undefined)).toBe(bearerChallengeHeader('/mcp?src=docs', CHALLENGE_DESCRIPTION));
    process.env.MCP_OAUTH = 'optin';
    expect(toolWallChallenge(req(), ANON, undefined)).toBe(HEADER_DOCS);
  });

  it('no challenge when signing in would not lift the refusal', () => {
    expect(toolWallChallenge(req({ headers: { authorization: 'Bearer x' } }), ANON, undefined)).toBeUndefined();
    expect(toolWallChallenge(req({ headers: { 'x-payment': 'p' } }), ANON, undefined)).toBeUndefined();
    expect(toolWallChallenge(req({ headers: { 'payment-signature': 'p' } }), ANON, undefined)).toBeUndefined();
    expect(toolWallChallenge(req(), ANON, {} as never)).toBeUndefined();
    expect(toolWallChallenge(req(), { ...ANON, anonymous: undefined }, undefined)).toBeUndefined();
    expect(toolWallChallenge(req({ body: { method: 'tools/call', params: { name: RATE_LIMITED } } }), ANON, undefined)).toBeUndefined();
    expect(toolWallChallenge(req({ body: { method: 'tools/list' } }), ANON, undefined)).toBeUndefined();
    h.healthy = false;
    expect(toolWallChallenge(req(), ANON, undefined)).toBeUndefined();
    h.healthy = true;
    delete process.env.MCP_OAUTH;
    expect(toolWallChallenge(req(), ANON, undefined)).toBeUndefined();
  });

  it('both halves share one set: securitySchemes iff metered', () => {
    for (const t of ['get_trade_call', 'get_market_regime', 'scan_funding_arb', 'scan_trade_calls', 'scan_market_regimes']) {
      expect(toolSecuritySchemes(t), t).toEqual(SCHEMES);
    }
    for (const t of ['chat_knowledge', 'search_knowledge', 'get_track_record', 'no_such_tool', undefined, 7]) {
      expect(toolSecuritySchemes(t), String(t)).toBeUndefined();
    }
    expect(TOOL_SECURITY_SCHEMES).toEqual(SCHEMES);
  });

  it('outside a request context there is no challenge (stdio)', () => {
    expect(getRequestWallChallenge()).toBeUndefined();
  });
});

// ── 2. projection ────────────────────────────────────────────────────────────

describe('toMcpToolResult — `_meta` iff quota wall AND a decided challenge', () => {
  const input = {} as ValidatedToolInput;
  const tierError = () => new TierLimitReachedError({
    currentUsage: 20, monthlyLimit: 20, tier: 'free', suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter',
    resetAtMs: Date.UTC(2026, 10, 24), tool: METERED,
  });
  const walls = {
    threw: { ok: false as const, kind: 'threw' as const, tool: METERED, input, error: tierError() },
    refused: { ok: false as const, kind: 'refused' as const, tool: 'scan_market_regimes', input, payload: { error: 'quota_exhausted', code: 'TIER_LIMIT_REACHED' }, http: { status: 429 }, mcpIsError: true as const },
    okBody: { ok: true as const, tool: 'scan_trade_calls', input, result: { error: 'quota_exhausted', code: 'TIER_LIMIT_REACHED' } },
  };
  const others = {
    threwOther: { ok: false as const, kind: 'threw' as const, tool: METERED, input, error: new Error('boom') },
    refusedOther: { ok: false as const, kind: 'refused' as const, tool: 'scan_market_regimes', input, payload: { code: 'invalid_parameter' }, http: { status: 400 }, mcpIsError: true as const },
    served: { ok: true as const, tool: METERED, input, result: { verdict: 'BUY' } },
  };

  it('every wall shape carries exactly the challenge; nothing else moves', () => {
    for (const [name, o] of Object.entries(walls)) {
      expect(isQuotaWall(o), name).toBe(true);
      const plain = toMcpToolResult(o);
      const withChallenge = toMcpToolResult(o, { wallChallenge: HEADER_BARE });
      expect(withChallenge, name).toEqual({ ...plain, _meta: { 'mcp/www_authenticate': [HEADER_BARE] } });
      expect(JSON.stringify(withChallenge.content)).toBe(JSON.stringify(plain.content));
    }
    expect(WWW_AUTHENTICATE_META_KEY).toBe('mcp/www_authenticate');
  });

  it('no challenge decided → byte-identical to before, no `_meta` key', () => {
    for (const o of Object.values(walls)) {
      expect('_meta' in toMcpToolResult(o, {})).toBe(false);
      expect(JSON.stringify(toMcpToolResult(o, { wallChallenge: undefined }))).toBe(JSON.stringify(toMcpToolResult(o)));
    }
  });

  it('a non-wall outcome never carries it, challenge or not', () => {
    for (const [name, o] of Object.entries(others)) {
      expect(isQuotaWall(o), name).toBe(false);
      expect('_meta' in toMcpToolResult(o, { wallChallenge: HEADER_BARE }), name).toBe(false);
    }
  });
});

// ── 3. the real server over HTTP ─────────────────────────────────────────────

let server: Server;
let base = '';

beforeAll(async () => {
  // Production's order: express.json → resolveLicense({ oauth: true }) → credential gate →
  // ipHash / sessionId → the 401 seam → toolWallChallenge → requestContext.run → createServer.
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
      const wallChallenge = toolWallChallenge(req, license, x402Downgrade);
      await requestContext.run(
        { license, sessionId, ipHash, userAgent: req.headers['user-agent'] ?? null, wallChallenge },
        () => handleMcpStateless(req, res, createSandboxServer),
      );
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(() => { server?.close(); });

type Tool = { name: string; securitySchemes?: unknown; _meta?: Record<string, unknown> } & Record<string, unknown>;
type CallResult = { content: Array<{ type: string; text: string }>; isError?: boolean; _meta?: Record<string, unknown> };

async function rpc(body: unknown, opts: { headers?: Record<string, string> } = {}): Promise<{ result?: unknown; error?: unknown }> {
  const r = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'X-Forwarded-For': OUTSIDE_IP, 'User-Agent': CHATGPT_UA, ...opts.headers,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : text);
}
const listTools = async () => ((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).result as { tools: Tool[] }).tools;
const callTool = async (name: string, args: Record<string, unknown> = {}) =>
  (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })).result as CallResult;
const exhaust = () => trackCallByKey(`free:${hashIp(OUTSIDE_IP)}`, 'free', FREE_MONTHLY_CALLS);

describe('the real createServer — tools/list', () => {
  beforeEach(() => { h.healthy = true; process.env.MCP_OAUTH = 'wall'; });
  afterEach(() => { delete process.env.MCP_OAUTH; });

  it('exactly the live metered tools declare the schemes, top-level and mirrored into _meta', async () => {
    const tools = await listTools();
    const metered = liveMcpToolNames().filter((t) => isMeteredTool(t)).sort();
    expect(metered.length).toBeGreaterThanOrEqual(5);
    expect(tools.filter((t) => 'securitySchemes' in t).map((t) => t.name).sort()).toEqual(metered);
    for (const t of tools) {
      if (isMeteredTool(t.name)) {
        expect(t.securitySchemes, t.name).toEqual(SCHEMES);
        expect(t._meta?.securitySchemes, t.name).toEqual(SCHEMES);
      } else {
        expect(t._meta?.securitySchemes, t.name).toBeUndefined();
      }
    }
  });

  it('additive only: stripping the two keys gives the MCP_OAUTH-off listing exactly', async () => {
    const on = await listTools();
    delete process.env.MCP_OAUTH;
    const off = await listTools();
    expect(off.some((t) => 'securitySchemes' in t || t._meta?.securitySchemes !== undefined)).toBe(false);
    const stripped = on.map(({ securitySchemes: _s, ...t }) => {
      if (!t._meta) return t;
      const { securitySchemes: _m, ...meta } = t._meta;
      return Object.keys(meta).length > 0 ? { ...t, _meta: meta } : (({ _meta: _x, ...rest }) => rest)(t);
    });
    expect(stripped).toEqual(off);
  });

  it('mode-gated, not health-gated: an unhealthy store keeps the schemes', async () => {
    h.healthy = false;
    expect((await listTools()).filter((t) => 'securitySchemes' in t).length).toBeGreaterThanOrEqual(5);
  });
});

describe('the real createServer — the wall reaches the wire with the challenge', () => {
  beforeEach(() => {
    h.healthy = true;
    process.env.MCP_OAUTH = 'wall';
    _resetCallTrackersForTest();
    _resetChallengeForTest();
  });
  afterEach(() => { delete process.env.MCP_OAUTH; });

  // The REFUSED shape (scan_market_regimes) is PG-only — it answers `hosted_only` on this suite's
  // SQLite backend before reaching its meter — so it is pinned at the projection layer above.
  it('the thrown wall and scan_trade_calls\' OK-shaped wall', async () => {
    exhaust();
    const shapes: Array<[string, Record<string, unknown>, boolean]> = [
      ['get_market_regime', { coin: 'BTC' }, true],
      ['scan_trade_calls', {}, false],
    ];
    for (const [tool, args, isError] of shapes) {
      const r = await callTool(tool, args);
      expect(JSON.parse(r.content[0].text).code, tool).toBe('TIER_LIMIT_REACHED');
      expect(r.isError === true, tool).toBe(isError);
      expect(r._meta, tool).toEqual({ 'mcp/www_authenticate': [HEADER_BARE] });
    }
  });

  it('an unhealthy store or mode off: the same wall, no `_meta`', async () => {
    exhaust();
    h.healthy = false;
    const sick = await callTool('get_market_regime', { coin: 'BTC' });
    expect(JSON.parse(sick.content[0].text).code).toBe('TIER_LIMIT_REACHED');
    expect(sick._meta).toBeUndefined();
    h.healthy = true;
    delete process.env.MCP_OAUTH;
    const off = await callTool('get_market_regime', { coin: 'BTC' });
    expect(JSON.parse(off.content[0].text).code).toBe('TIER_LIMIT_REACHED');
    expect(off._meta).toBeUndefined();
  });
});

// ── 4. route wiring ──────────────────────────────────────────────────────────

describe('the /mcp route decides the challenge after the 401 seam and threads it', () => {
  const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
  const SEAM = 'if (await applyChallenge(req, res, license, x402Downgrade, { ipHash, sessionId })) return;';
  const DECIDE = 'const wallChallenge = toolWallChallenge(req, license, x402Downgrade);';

  it('decided below the seam, before the request context opens, and carried into it', () => {
    const seam = src.indexOf(SEAM);
    const decide = src.indexOf(DECIDE);
    const run = src.indexOf('await requestContext.run({ license, sessionId, ipHash, isAutomated');
    expect(seam).toBeGreaterThan(-1);
    expect(src.indexOf(DECIDE, decide + 1)).toBe(-1);
    expect(decide).toBeGreaterThan(seam);
    expect(src.slice(seam, decide).split('\n').length).toBeLessThanOrEqual(5);
    expect(run).toBeGreaterThan(decide);
    expect(src.slice(run, src.indexOf('\n', run))).toContain(', wallChallenge }, async () => {');
  });
});
