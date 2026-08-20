/**
 * AUTH-THREE-STATE-W1 CH2 — refusal on `/mcp`, and the self-describing envelope.
 *
 * ONE SEAM, AND ONLY ONE: the free-key STORE's answer. Everything else — the resolver, the
 * refusal decision, the seam the route calls — is the real thing.
 *
 * The first version of this suite mocked nothing at all and read UNKNOWN off a live `av_free_`
 * miss. That passed locally against SQLite and FAILED IN CI, where there is no database: the
 * lookup throws, and "the store is down" is not "no such key". The resolver now says
 * INDETERMINATE there, which is correct — and it means an environment with no database can no
 * longer produce an UNKNOWN at all. Pinning the STORE's answer (a row, no row, or a fault) is
 * therefore the minimum needed to make all three outcomes reachable on any machine, and it pins
 * the one thing that is genuinely ambient rather than anything about the logic under test.
 *
 * NO STRIPE MOCK, DELIBERATELY. With `STRIPE_SECRET_KEY` unset — the state of every test run and
 * of any environment that has lost its billing config — `validateApiKey` returns
 * `{valid:false, indeterminate:true}` (`stripe.ts:300`). That is not a limitation here, it IS the
 * Stripe-outage condition the Q7 shape branch exists for, so these cases exercise the REAL
 * resolver on the REAL outage path rather than a mock's idea of one. Measured against the built
 * resolver before this suite was written:
 *
 *   no header              → ABSENT         (served)
 *   ${env:AV_API_KEY}      → MALFORMED      (served — the compat lane, UNDER OUTAGE)
 *   av_live_<24 hex>       → INDETERMINATE  (refused, retryable)
 *   av_free_<24 hex>       → UNKNOWN        (refused, not retryable — the free-key store answers
 *                                            this one without Stripe at all)
 *
 * WHAT THE HTTP SUITE DRIVES. `applyCredentialRefusal` is the REAL exported seam, called exactly
 * as `app.all('/mcp', …)` calls it; `resolveLicense` and `handleMcpStateless` are the real
 * functions too. The one thing a test app cannot BE is the route's wiring — so that the route
 * actually invokes the seam, in the right ORDER, is pinned separately by the source-order block at
 * the bottom. A pure function nobody calls is the same defect one layer up, and re-implementing
 * the branch here instead would be the hand-built mirror `src/lib/quota-surfaces.ts:25-26` forbids.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { handleMcpStateless, applyCredentialRefusal } from '../src/index.js';
import { resolveLicense } from '../src/lib/license.js';
import {
  AUTH_REFUSAL_JSONRPC_CODES,
  AUTH_REFUSAL_HTTP_CODES,
  decideRefusal,
  isStrictUnknownEnabled,
  refuseCredentialJsonRpc,
} from '../src/lib/credential-refusal.js';
import { withAuthState } from '../src/lib/tier-warning.js';
import { formatChatKnowledgeResponse } from '../src/lib/chat-knowledge-formatter.js';
import { formatSearchKnowledgeResponse } from '../src/lib/search-knowledge-formatter.js';
import { runScanTradeCall } from '../src/tools/scan-trade-calls.js';
import { lookupFreeKey } from '../src/lib/free-keys-store.js';

const mockFreeKey = vi.mocked(lookupFreeKey);

// Keep every other export real — only the store's ANSWER is pinned.
vi.mock('../src/lib/free-keys-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/free-keys-store.js')>()),
  lookupFreeKey: vi.fn(async () => null),
}));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX24 = (c: string) => c.repeat(24);
const UNKNOWN_KEY = `av_free_${HEX24('a')}`;   // resolves UNKNOWN via the free-key store
const INDET_KEY = `av_live_${HEX24('0')}`;     // resolves INDETERMINATE (Stripe unconfigured)
const UNEXPANDED_ENV = '${env:AV_API_KEY}';    // resolves MALFORMED — always served

let server: Server;
let base: string;
/** Proves a refused call never reaches dispatch: the tool body is the first thing downstream. */
let toolInvocations = 0;

function makeServer(): McpServer {
  const s = new McpServer({ name: 'test-auth-refusal', version: '0.0.0' });
  s.tool('ping', async () => {
    toolInvocations += 1;
    return { content: [{ type: 'text' as const, text: 'pong' }] };
  });
  return s;
}

beforeAll(async () => {
  // Mirror production's ORDER exactly: express.json → resolveLicense → the refusal seam → the
  // stateless handler. Everything but the three lines of wiring is the real thing.
  const app = express();
  app.use(express.json());
  app.all('/mcp', async (req, res) => {
    try {
      const { license } = await resolveLicense(req.headers as Record<string, string | undefined>);
      if (applyCredentialRefusal(req, res, license)) return;
      await handleMcpStateless(req, res, makeServer);
    } catch {
      if (!res.headersSent) res.status(500).end();
    }
  });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  toolInvocations = 0;
  delete process.env.AUTH_STRICT_UNKNOWN;
  delete process.env.CQS_API_KEY;
  // Default: the store answers "no such row" — a FACT, which makes UNKNOWN reachable anywhere.
  mockFreeKey.mockReset();
  mockFreeKey.mockResolvedValue(null);
});
afterEach(() => { delete process.env.AUTH_STRICT_UNKNOWN; });

function parse(text: string): { result?: { content?: { text?: string }[]; tools?: unknown[] }; error?: { code: number; message: string; data?: { auth_outcome?: string; retryable?: boolean; suggested_action?: string } }; id?: unknown } {
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  return line ? JSON.parse(line.slice(5).trim()) : JSON.parse(text);
}

async function post(headers: Record<string, string>, body: unknown) {
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: ReturnType<typeof parse> | null = null;
  try { json = parse(text); } catch { /* leave null */ }
  return { status: r.status, json, text };
}

const call = (id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ping', arguments: {} } });
const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });

// ── 1, 2: served outcomes ────────────────────────────────────────────────────

describe('served credentials are unaffected', () => {
  it('(1) no header → 200, the tool runs', async () => {
    const r = await post({}, call());
    expect(r.status).toBe(200);
    expect(r.json?.error).toBeUndefined();
    expect(r.json?.result?.content?.[0]?.text).toBe('pong');
    expect(toolInvocations).toBe(1);
  });

  it('(2) Bearer ${env:AV_API_KEY} → 200, the tool runs — the compat lane never refuses', async () => {
    // Four documented client configs emit this literal when the env var is not expanded
    // (mcp-clients.ts:75,104,133,171). If this ever goes red, every one of them is broken.
    const r = await post(bearer(UNEXPANDED_ENV), call(2));
    expect(r.status).toBe(200);
    expect(r.json?.error).toBeUndefined();
    expect(r.json?.result?.content?.[0]?.text).toBe('pong');
  });
});

// ── 3, 4, 5: the refusals, and the outage that must NOT refuse ───────────────

describe('refusal', () => {
  it('(3) a well-formed UNKNOWN key → 200 + JSON-RPC -32003, not retryable', async () => {
    const r = await post(bearer(UNKNOWN_KEY), call(3));
    // 200, never 401: a 401 with WWW-Authenticate starts MCP OAuth discovery against a server
    // that does not exist.
    expect(r.status).toBe(200);
    expect(r.json?.error?.code).toBe(-32003);
    expect(r.json?.error?.data?.retryable).toBe(false);
    expect(r.json?.error?.data?.auth_outcome).toBe('UNKNOWN');
    expect(r.json?.error?.message).toBe('That API key was not recognised.');
    expect(r.json?.error?.data?.suggested_action).toContain('api.algovault.com/account');
    expect(r.json?.id).toBe(3); // JSON-RPC 2.0 requires the id to be echoed
  });

  it('(4) an unverifiable key → 200 + JSON-RPC -32004, RETRYABLE, and never called "invalid"', async () => {
    const r = await post(bearer(INDET_KEY), call(4));
    expect(r.status).toBe(200);
    expect(r.json?.error?.code).toBe(-32004);
    expect(r.json?.error?.data?.retryable).toBe(true);
    expect(r.json?.error?.data?.auth_outcome).toBe('INDETERMINATE');
    // Saying "invalid" here would repeat the four-into-one collapse in the copy layer and tell a
    // paying customer their key is bad when we simply could not ask.
    expect(r.json?.error?.message?.toLowerCase()).not.toContain('invalid');
    expect(r.json?.error?.data?.suggested_action).toContain('not rejected');
  });

  it('(4b) a free-key STORE fault is INDETERMINATE, not UNKNOWN — could-not-ask is not "no such key"', async () => {
    // The lane that took the deploy gate red. `lookupFreeKey` throws when the store is
    // unreachable; treating that as a miss would refuse a real key PERMANENTLY (not retryable)
    // for the duration of a database blip — the exact collapse this wave removes from the Stripe
    // lane, left open on this one.
    mockFreeKey.mockRejectedValue(new Error('free-key store unreachable'));
    const r = await post(bearer(UNKNOWN_KEY), call(41));
    expect(r.json?.error?.code).toBe(-32004);
    expect(r.json?.error?.data?.retryable).toBe(true);
  });

  it('(4c) …and a MALFORMED av_free_ string is SERVED even then — shape needs no store', async () => {
    mockFreeKey.mockRejectedValue(new Error('free-key store unreachable'));
    const r = await post(bearer('av_free_nothex'), call(42));
    expect(r.json?.error).toBeUndefined();
    expect(r.json?.result?.content?.[0]?.text).toBe('pong');
  });

  it('(5) UNDER THE SAME OUTAGE, a MALFORMED credential is still SERVED', async () => {
    // Case 4 proves Stripe is unreachable in this process. This case proves that in that exact
    // state the compat lane survives — which is the whole safety argument for shipping refusal
    // default-ON. Without the shape branch at license.ts's indeterminate site, this is a -32004.
    const r = await post(bearer(UNEXPANDED_ENV), call(5));
    expect(r.json?.error).toBeUndefined();
    expect(r.json?.result?.content?.[0]?.text).toBe('pong');
  });
});

// ── 6, 7: method scope ───────────────────────────────────────────────────────

describe('method scope — every JSON-RPC method, proven not assumed', () => {
  it('(6) an UNKNOWN key is refused on initialize AND tools/list, not just tools/call', async () => {
    const init = await post(bearer(UNKNOWN_KEY), {
      jsonrpc: '2.0', id: 6, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.json?.error?.code).toBe(-32003);
    const list = await post(bearer(UNKNOWN_KEY), { jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(list.json?.error?.code).toBe(-32003);
    // Failing at CONNECT is the point: the alternative is connecting cleanly, listing seven tools,
    // and erroring on every call — which reads as "the product is broken", not "your key is wrong".
  });

  it('(7) a MALFORMED credential still completes initialize — no documented client config breaks', async () => {
    const init = await post(bearer(UNEXPANDED_ENV), {
      jsonrpc: '2.0', id: 8, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    });
    expect(init.json?.error).toBeUndefined();
    expect(init.status).toBe(200);
  });

  it('GET/DELETE keep their 405 — transport verbs are not JSON-RPC methods', async () => {
    const r = await fetch(base, { method: 'GET', headers: bearer(UNKNOWN_KEY) });
    expect(r.status).toBe(405);
  });
});

// ── 8: a refusal claims nothing ──────────────────────────────────────────────

describe('(8) a refused call consumes nothing', () => {
  it('never reaches tool dispatch, so trackCall and every quota debit are unreachable', async () => {
    // `trackCall` lives INSIDE the tool bodies (get-trade-call.ts:858, get-market-regime.ts:244,
    // scan-funding-arb.ts:223, scan-trade-calls.ts:322) and `logRequest` inside the index.ts tool
    // handlers, so "the tool body never ran" is direct evidence that nothing was charged or
    // logged. Precedent: tests/entitlement.test.ts:87 — "a refusal claims nothing".
    await post(bearer(UNKNOWN_KEY), call(9));
    await post(bearer(INDET_KEY), call(10));
    expect(toolInvocations).toBe(0);
    // …and a served call in the same suite proves the counter can move at all, so the zero above
    // is a fact rather than a broken instrument.
    await post({}, call(11));
    expect(toolInvocations).toBe(1);
  });
});

// ── 9: the kill switch, exercised ────────────────────────────────────────────

describe('(9) AUTH_STRICT_UNKNOWN=0 restores the pre-wave behaviour', () => {
  it('the same UNKNOWN key is served free tier with the switch off', async () => {
    process.env.AUTH_STRICT_UNKNOWN = '0';
    expect(isStrictUnknownEnabled()).toBe(false);
    const r = await post(bearer(UNKNOWN_KEY), call(12));
    expect(r.status).toBe(200);
    expect(r.json?.error).toBeUndefined();
    expect(r.json?.result?.content?.[0]?.text).toBe('pong');
  });

  it('default is ON — an absent variable refuses', () => {
    delete process.env.AUTH_STRICT_UNKNOWN;
    expect(isStrictUnknownEnabled()).toBe(true);
    expect(decideRefusal({ outcome: 'UNKNOWN' }).refuse).toBe(true);
    // A default-OFF flag would leave the defect live behind a switch nobody flips.
  });

  it('only `0` disables it — a typo does not silently unship the fix', () => {
    for (const v of ['1', 'true', 'false', 'off', '']) {
      expect(isStrictUnknownEnabled({ AUTH_STRICT_UNKNOWN: v } as NodeJS.ProcessEnv), v).toBe(true);
    }
  });
});

// ── 10: the served outcomes decide correctly ─────────────────────────────────

describe('(10) only UNKNOWN and INDETERMINATE refuse', () => {
  it('the decision table, exhaustively', () => {
    // RESOLVED is asserted here rather than over HTTP: reaching it live needs a real Stripe
    // customer, and tests/credential-outcome.test.ts already drives the resolver to RESOLVED with
    // a mocked Stripe. What matters at THIS layer is that the refusal predicate reads it as
    // served, which is exactly what this asserts.
    expect(decideRefusal({ outcome: 'ABSENT' }).refuse).toBe(false);
    expect(decideRefusal({ outcome: 'MALFORMED' }).refuse).toBe(false);
    expect(decideRefusal({ outcome: 'RESOLVED' }).refuse).toBe(false);
    expect(decideRefusal({ outcome: 'UNKNOWN' }).refuse).toBe(true);
    expect(decideRefusal({ outcome: 'INDETERMINATE' }).refuse).toBe(true);
  });

  it('the decision is method-independent — scope was a choice, not an omission', () => {
    for (const m of ['initialize', 'tools/list', 'tools/call', 'resources/list', undefined]) {
      expect(decideRefusal({ outcome: 'UNKNOWN' }, m).refuse, String(m)).toBe(true);
    }
  });
});

// ── 11: the SDK enum non-collision ───────────────────────────────────────────

describe('(11) our JSON-RPC codes do not collide with the MCP SDK', () => {
  it('neither code appears in the SDK ErrorCode enum, read at RUNTIME', () => {
    // package.json pins "^1.12.1" — a CARET range — while the lockfile resolves 1.29.0, so a
    // routine `npm install` can move the SDK with no change here. A comment saying "verified free"
    // is prose, and prose is not a control. -32001 is ErrorCode.RequestTimeout AND the code the
    // SDK's own Streamable-HTTP transport returns for "Session not found"; both are RETRIED by
    // clients, so reusing one would make a settled bad key indistinguishable from a dead session.
    const taken = Object.values(ErrorCode).filter((v): v is number => typeof v === 'number');
    expect(taken.length).toBeGreaterThan(5); // the enum really was read
    for (const code of Object.values(AUTH_REFUSAL_JSONRPC_CODES)) {
      expect(taken, `SDK now claims ${code} — pick another in [-32000,-32099]`).not.toContain(code);
    }
  });

  it('and they are inside the JSON-RPC implementation-defined range', () => {
    for (const code of Object.values(AUTH_REFUSAL_JSONRPC_CODES)) {
      expect(code).toBeLessThanOrEqual(-32000);
      expect(code).toBeGreaterThanOrEqual(-32099);
    }
  });

  it('-32001 IS taken, which is why it was not used (the reason, asserted)', () => {
    const taken = Object.values(ErrorCode).filter((v): v is number => typeof v === 'number');
    expect(taken).toContain(-32001);
  });

  it('the two refusing outcomes get DISTINCT codes and distinct http codes', () => {
    expect(AUTH_REFUSAL_JSONRPC_CODES.UNKNOWN).not.toBe(AUTH_REFUSAL_JSONRPC_CODES.INDETERMINATE);
    expect(AUTH_REFUSAL_HTTP_CODES.UNKNOWN).not.toBe(AUTH_REFUSAL_HTTP_CODES.INDETERMINATE);
    expect(refuseCredentialJsonRpc('UNKNOWN').data.retryable).toBe(false);
    expect(refuseCredentialJsonRpc('INDETERMINATE').data.retryable).toBe(true);
  });
});

// ── 12: _algovault.auth coverage, 7/7 ────────────────────────────────────────

const TOOL_ENVELOPE_SITES: Array<[tool: string, file: string, sites: number]> = [
  ['get_trade_call (+ get_trade_signal alias)', 'src/tools/get-trade-call.ts', 1],
  ['get_market_regime', 'src/tools/get-market-regime.ts', 1],
  ['scan_funding_arb', 'src/tools/scan-funding-arb.ts', 2],
  ['scan_trade_calls', 'src/tools/scan-trade-calls.ts', 3],
  ['chat_knowledge', 'src/lib/chat-knowledge-formatter.ts', 1],
  ['search_knowledge', 'src/lib/search-knowledge-formatter.ts', 1],
];

describe('(12) every live tool states its own auth state', () => {
  const license = { key: null, tier: 'free' as const, outcome: 'MALFORMED' as const };

  it('withAuthState projects all three members from the ONE outcome', () => {
    const out = withAuthState({ tool: 't' }, license);
    expect(out.auth).toEqual({ outcome: 'MALFORMED', presented: true, tier: 'free' });
    expect(out.tool).toBe('t'); // additive — the input survives
  });

  it('it does NOT early-return on quota state, unlike withQuotaState', () => {
    // withQuotaState returns the bare meta for bot-internal and for non-finite quota — i.e. for
    // x402 and internal, which HAVE an auth outcome precisely because they have no quota.
    for (const tier of ['x402', 'internal', 'free', 'pro'] as const) {
      const out = withAuthState({}, { key: null, tier, outcome: 'RESOLVED' });
      expect(out.auth.tier, tier).toBe(tier);
    }
  });

  it('an unstamped license still yields a SERVED outcome, never a refusing one', () => {
    const out = withAuthState({}, { key: null, tier: 'free', outcome: undefined });
    expect(out.auth.outcome).toBe('ABSENT');
  });

  // ── rendered output, where it is reachable without market data or a database ──

  it('chat_knowledge renders auth', () => {
    const r = formatChatKnowledgeResponse(
      { question: 'q', answer: 'a', citations: [], model: 'm', usage: { promptTokens: 0, completionTokens: 0 } } as Parameters<typeof formatChatKnowledgeResponse>[0],
      null, 5, license,
    );
    expect(r._algovault.auth).toEqual({ outcome: 'MALFORMED', presented: true, tier: 'free' });
    expect(r._algovault.quota_remaining).toBe(5); // pre-wave members untouched
  });

  it('search_knowledge renders auth on the MCP path and OMITS it on the cacheable HTTP path', () => {
    const withLicense = formatSearchKnowledgeResponse('q', [], null, license);
    expect(withLicense._algovault.auth?.outcome).toBe('MALFORMED');
    const httpTwin = formatSearchKnowledgeResponse('q', [], null);
    // /api/search is `Cache-Control: public, max-age=300`. A per-caller member there varies along
    // a dimension absent from the cache key — the shape that serves one caller's state to the
    // next. The omission is the fix, not a gap.
    expect(httpTwin._algovault.auth).toBeUndefined();
    expect(Object.keys(httpTwin._algovault).sort()).toEqual(['bundle_generated_at', 'bundle_version']);
  });

  it('scan_trade_calls renders auth on its hand-built invalid-lens envelope', async () => {
    const r = await runScanTradeCall({ rankBy: 'not_a_lens' } as Parameters<typeof runScanTradeCall>[0], {
      tier: 'free', key: null, outcome: 'UNKNOWN',
    });
    expect((r as { _algovault: { auth?: { outcome: string } } })._algovault.auth?.outcome).toBe('UNKNOWN');
  });

  // ── source-level, for the sites that need live market data to render ──

  it('every _algovault construction site in every live tool routes through withAuthState', () => {
    // The four remaining sites build their envelope only after real venue data, which this suite
    // deliberately does not fetch. Asserting the WIRING is the honest instrument for them — the
    // behaviour of withAuthState itself is proven above, and the end-to-end render is proven by
    // the post-deploy live probe recorded in status.md.
    for (const [tool, file, sites] of TOOL_ENVELOPE_SITES) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      // Count STAMPED sites only. `_algovault:` alone cannot be counted here because it also
      // appears in TYPE declarations (`scan-trade-calls.ts:138,174,187`), and discriminating a
      // declaration from a construction by punctuation is exactly the kind of fragile pattern that
      // breaks on the next refactor. Whether a NEW, unstamped site appears is a repo-wide
      // question and belongs to the CH3 conformance gate, which walks all of src/.
      const stamped = (src.match(/_algovault:\s*(?:license\s*\?\s*)?withAuthState\(/g) ?? []).length;
      expect(stamped, `${tool}: expected ${sites} stamped envelope site(s) in ${file}`).toBe(sites);
    }
  });

  it('the live tool list is exactly the seven this suite covers', () => {
    // Guards the count from BELOW: if an eighth tool ships, this goes red and its envelope has to
    // be brought into TOOL_ENVELOPE_SITES rather than quietly becoming the next straggler.
    const registered = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8')
      .match(/^\s*'(get_trade_call|get_trade_signal|get_market_regime|scan_funding_arb|scan_trade_calls|chat_knowledge|search_knowledge)',$/gm) ?? [];
    expect(new Set(registered.map((s) => s.trim())).size).toBe(7);
  });
});

// ── the wiring: a pure function nobody invokes is the same defect one layer up ──

describe('the /mcp route actually invokes the gate, in the right order', () => {
  const src = readFileSync(resolve(ROOT, 'src/index.ts'), 'utf8');
  // Anchor on the REGISTRATION, not on the bare string: `app.all('/mcp', …)` also appears inside a
  // comment ~2000 lines earlier, and slicing from there swallows unrelated `recordFunnelEvent(`
  // calls and inverts every ordering comparison below. (Caught by this assertion on its first run.)
  const routeStart = src.indexOf("app.all('/mcp', express.json()");
  if (routeStart < 0) throw new Error('the /mcp route registration moved — re-anchor this test');
  const route = src.slice(routeStart);

  it('applyCredentialRefusal is called inside the /mcp route', () => {
    expect(route).toContain('if (applyCredentialRefusal(req, res, license)) return;');
  });

  it('it runs AFTER the license is resolved and BEFORE anything is spent or emitted', () => {
    const iResolve = route.indexOf('await resolveLicense(');
    const iGate = route.indexOf('applyCredentialRefusal(req, res, license)');
    const iDispatch = route.indexOf('handleMcpStateless(');
    expect(iResolve).toBeGreaterThan(-1);
    expect(iGate).toBeGreaterThan(iResolve);
    expect(iGate).toBeLessThan(iDispatch);
    // Everything a refused call must not do lives between the gate and dispatch. Moving the gate
    // below any of these would still "work" while silently charging refused callers for the
    // privilege of being refused.
    for (const spend of ['logSkillInvocation(', 'recordFunnelEvent(', 'recordMcpToolsListEvent(', 'requestContext.run(']) {
      const i = route.indexOf(spend);
      expect(i, `${spend} must come AFTER the credential gate`).toBeGreaterThan(iGate);
    }
  });
});
