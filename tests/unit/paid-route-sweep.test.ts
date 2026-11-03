/**
 * OPS-AUDIT-REMEDIATION-HIGH-W2-R2 CH1 — G1, the paid-route sweep: NO UNPAID REQUEST REACHES A PAID TOOL.
 *
 * RT-01 (CODE-REVIEW-2026-11 §3). The LIVE a2mcp POST handlers ran `callTool` because of WHERE they sat:
 * behind rail-mount's dispatcher. The dispatcher's ownership test was a case-sensitive `startsWith`,
 * while Express matches routes case-insensitively, so `POST /A2MCP/<tool>` was never owned, fell
 * through to the handler and ran the paid tool free.
 *
 * This gate covers the CLASS, not the instance. Every paid route the rails' OWN builders mount
 * (`mountOkxA2mcpRoutes` + `mountX402HttpRoutes`, the `/x402/get_trade_call` alias included) × every
 * path variant Express or the OKX matcher folds together × every a2mcp state (live-ready over a fake
 * OKX facilitator, live-dark, stub): an unpaid POST answers 402 / 404 / 503 and the `callTool` spy
 * records ZERO calls. Vacuity guard: the routes swept equal the builders' output, and it is > 0 — a
 * rail that mounted nothing would otherwise pass by sweeping nothing.
 *
 * Local test app only. The OKX facilitator is faked at `fetch` (its three endpoints); `callTool` is a
 * spy, so a bypass shows up as a recorded call, never as a real tool run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@okxweb3/x402-core/http';

const spy = vi.hoisted(() => ({
  callTool: vi.fn(async (req: { tool: string; input: unknown }) => ({
    ok: true as const, tool: req.tool, input: req.input, result: { tool: req.tool, ran: 'callTool-spy' },
  })),
}));
vi.mock('../../src/lib/tool-call-pipeline.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  callTool: spy.callTool,
}));

import { mountOkxA2mcpRoutes, mountLiveRoutes, okxA2mcpTools } from '../../src/lib/okx-a2mcp.js';
import { mountX402HttpRoutes } from '../../src/lib/x402-http-routes.js';
import { servedState, _resetRailServedStateForTest } from '../../src/lib/rail-served-state.js';

const PAYTO = '0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9';
const PAYER = '0x00000000000000000000000000000000000000aa';
const CREDS = { OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: PAYTO };
const STUB_ENV = { OKX_AI_ENABLED: 'true' };
/** The Base x402 rail mounts only on cdp + discoverable; CQS_API_KEY unset so no operator key answers. */
const X402_ENV: Record<string, string | undefined> = {
  X402_FACILITATOR: 'cdp', BAZAAR_DISCOVERABLE: 'true', CDP_API_KEY_ID: 'test-id', CDP_API_KEY_SECRET: 'test-secret',
  CQS_API_KEY: undefined,
};
const OKX_BASE = 'https://web3.okx.com';
const SUPPORTED = {
  kinds: [{ scheme: 'exact', network: 'eip155:196', x402Version: 2, extra: null }],
  signers: { 'eip155:196': ['0x0000000000000000000000000000000000000001'] },
  extensions: [],
};

const realFetch = globalThis.fetch;
const noTimers = { setTimeout: () => 0, now: () => Date.now(), random: () => 0.5 };

type State = 'live-ready' | 'live-dark' | 'stub';
const STATES: State[] = ['live-ready', 'live-dark', 'stub'];

/** The fake OKX facilitator, at the network: dark answers getSupported with 401, as OKX once did. */
const okx = { supportedStatus: 200, verifies: 0, settles: 0 };
function stubOkxFacilitator(): void {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith(OKX_BASE)) return realFetch(url, init);
    if (u.endsWith('/api/v6/pay/x402/supported')) {
      return okx.supportedStatus === 200 ? json({ data: SUPPORTED }) : new Response('{}', { status: okx.supportedStatus });
    }
    if (u.endsWith('/api/v6/pay/x402/verify')) { okx.verifies++; return json({ data: { isValid: true, payer: PAYER } }); }
    if (u.endsWith('/api/v6/pay/x402/settle')) {
      okx.settles++;
      return json({ data: { success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:196', payer: PAYER } });
    }
    return new Response('{}', { status: 404 });
  }));
}

/** `/a2mcp/get_trade_call` → ['a2mcp', 'get_trade_call']. */
function parts(route: string): [string, string] {
  const m = /^\/([^/]+)\/([^/]+)$/.exec(route);
  if (!m) throw new Error(`unexpected route shape: ${route}`);
  return [m[1], m[2]];
}
const alternateCase = (s: string): string => s.split('').map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join('');

/**
 * Every spelling of a route that Express (case-insensitive, optional trailing slash) or the OKX matcher
 * (`normalizePath`: decode, `\` → `/`, collapse `//`, strip a trailing `/`; RegExp flag `i`) folds onto
 * it. `underPrefix` = Express itself routes the spelling under the rail's prefix, so a dark dispatcher
 * must answer it 503; the other spellings never reach any prefix handler and fall through to 404.
 */
const VARIANTS: Array<{ name: string; underPrefix: boolean; path(route: string): string }> = [
  { name: 'canonical', underPrefix: true, path: (r) => r },
  { name: 'UPPER prefix', underPrefix: true, path: (r) => { const [p, t] = parts(r); return `/${p.toUpperCase()}/${t}`; } },
  { name: 'Mixed prefix', underPrefix: true, path: (r) => { const [p, t] = parts(r); return `/${alternateCase(p)}/${t}`; } },
  { name: 'UPPER tool', underPrefix: true, path: (r) => { const [p, t] = parts(r); return `/${p}/${t.toUpperCase()}`; } },
  { name: 'trailing /', underPrefix: true, path: (r) => `${r}/` },
  { name: '// after the prefix', underPrefix: true, path: (r) => { const [p, t] = parts(r); return `/${p}//${t}`; } },
  { name: '// leading', underPrefix: false, path: (r) => `/${r}` },
  {
    name: '%-encoded prefix char', underPrefix: false,
    path: (r) => { const [p, t] = parts(r); return `/%${p.charCodeAt(0).toString(16).toUpperCase()}${p.slice(1)}/${t}`; },
  },
];

async function listen(app: Express): Promise<{ base: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** The production app's mount order (src/index.ts): the Base x402 routes, then the a2mcp rail. */
async function buildApp(state: State): Promise<{ app: Express; x402: string[]; a2mcp: string[] }> {
  okx.supportedStatus = state === 'live-dark' ? 401 : 200;
  const app = express();
  const x402 = mountX402HttpRoutes(app);
  const a2mcp = await mountOkxA2mcpRoutes(app, state === 'stub' ? STUB_ENV : CREDS, { timers: noTimers });
  return { app, x402, a2mcp };
}

const savedEnv: Record<string, string | undefined> = {};
let server: Server | undefined;

beforeAll(() => {
  for (const [k, v] of Object.entries(X402_ENV)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => {
  _resetRailServedStateForTest();
  spy.callTool.mockClear();
  Object.assign(okx, { supportedStatus: 200, verifies: 0, settles: 0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  stubOkxFacilitator();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetRailServedStateForTest();
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

describe('G1 — every paid route × every spelling × every a2mcp state: unpaid never reaches callTool', () => {
  for (const state of STATES) {
    it(`${state}: an unpaid POST is answered 402/404/503 and callTool records 0 calls`, async () => {
      const { app, x402, a2mcp } = await buildApp(state);
      expect(servedState().a2mcp.status).toBe(state === 'live-dark' ? 'dark' : 'served');
      const l = await listen(app); server = l.server;

      const routes = [...x402, ...a2mcp];
      const swept = new Set<string>();
      const violations: string[] = [];
      for (const route of routes) {
        for (const v of VARIANTS) {
          const path = v.path(route);
          const before = spy.callTool.mock.calls.length;
          const res = await realFetch(`${l.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"coin":"BTC"}' });
          await res.arrayBuffer();
          const ran = spy.callTool.mock.calls.length - before;
          if (![402, 404, 503].includes(res.status) || ran !== 0) {
            violations.push(`${state} POST ${path} [${v.name}] → ${res.status}, callTool ×${ran}`);
          }
        }
        swept.add(route);
      }

      expect(violations, 'unpaid requests that reached a paid handler').toEqual([]);
      expect(spy.callTool).not.toHaveBeenCalled();
      expect(okx.settles, 'no unpaid request reached settlement').toBe(0);
      // Vacuity guard, where the corpus is CONSTRUCTED: the builders' own output, every route of it swept.
      expect(a2mcp.length).toBeGreaterThan(0);
      expect(x402.length).toBeGreaterThan(0);
      expect(x402, 'the /x402/get_trade_call alias is a builder route').toContain('/x402/get_trade_call');
      expect(swept.size).toBe(x402.length + a2mcp.length);
    });
  }

  it('live-dark: every spelling Express routes under /a2mcp gets 503 + X-Rail-State on GET and POST (drift-canary leg C)', async () => {
    const { app, a2mcp } = await buildApp('live-dark');
    const l = await listen(app); server = l.server;
    const violations: string[] = [];
    for (const route of a2mcp) {
      for (const v of VARIANTS) {
        for (const method of ['GET', 'POST']) {
          const path = v.path(route);
          const res = await realFetch(`${l.base}${path}`, {
            method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"coin":"BTC"}' } : {}),
          });
          await res.arrayBuffer();
          const want = v.underPrefix ? 503 : 404;
          const railState = res.headers.get('x-rail-state') ?? '';
          if (res.status !== want || (want === 503 && !railState.startsWith('initializing; since='))) {
            violations.push(`${method} ${path} [${v.name}] → ${res.status} x-rail-state=${JSON.stringify(railState)} (want ${want})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
    expect(spy.callTool).not.toHaveBeenCalled();
  });

  it('served: GET discovery stays a 402 challenge on every a2mcp route (live-ready and stub)', async () => {
    for (const state of ['live-ready', 'stub'] as const) {
      const { app, a2mcp } = await buildApp(state);
      const l = await listen(app);
      try {
        for (const route of a2mcp) {
          const res = await realFetch(`${l.base}${route}`);
          expect(res.status, `${state} GET ${route}`).toBe(402);
          expect(res.headers.get('payment-required'), `${state} GET ${route}`).toBeTruthy();
        }
      } finally {
        await new Promise((r) => l.server.close(r));
      }
    }
  });
});

describe('CH1 fail-closed handler + positive control', () => {
  it('AC 1.1 — the LIVE handlers with NO dispatcher in front: an unpaid or header-forged POST gets 402, callTool 0', async () => {
    const app = express();
    const mounted = mountLiveRoutes(app, okxA2mcpTools(), PAYTO);
    expect(mounted.length).toBeGreaterThan(0);
    const l = await listen(app); server = l.server;
    const forgeries: Array<Record<string, string>> = [{}, { 'payment-signature': 'forged' }, { 'x-payment': 'forged' }];
    for (const route of mounted) {
      for (const extra of forgeries) {
        const res = await realFetch(`${l.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: '{"coin":"BTC"}' });
        expect(res.status, `POST ${route} ${JSON.stringify(extra)}`).toBe(402);
        expect(res.headers.get('payment-required')).toBeTruthy();
      }
    }
    expect(spy.callTool).not.toHaveBeenCalled();
  });

  /** A payment header built from the route's own 402 challenge, so the requirements match exactly. */
  async function paidHeaders(url: string): Promise<Record<string, string>> {
    const unpaid = await realFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unpaid.status).toBe(402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const payload = {
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0],
      payload: {
        signature: `0x${'11'.repeat(65)}`,
        authorization: {
          from: PAYER, to: PAYTO, value: String(required.accepts[0].amount),
          validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: `0x${'22'.repeat(32)}`,
        },
      },
    };
    return { 'content-type': 'application/json', 'payment-signature': encodePaymentSignatureHeader(payload as never) };
  }

  it('AC 1.3 — POSITIVE CONTROL: a verified payment → 200 + one settle + one callTool, on the canonical AND an UPPER-prefix spelling', async () => {
    const { app } = await buildApp('live-ready');
    const l = await listen(app); server = l.server;
    for (const path of ['/a2mcp/get_trade_call', '/A2MCP/get_trade_call']) {
      const settlesBefore = okx.settles;
      const callsBefore = spy.callTool.mock.calls.length;
      const res = await realFetch(`${l.base}${path}`, { method: 'POST', headers: await paidHeaders(`${l.base}${path}`), body: '{"coin":"BTC"}' });
      expect(res.status, `paid POST ${path}`).toBe(200);
      expect(await res.json()).toEqual({ tool: 'get_trade_signal', ran: 'callTool-spy' });
      expect(res.headers.get('payment-response'), 'the settlement receipt header').toBeTruthy();
      expect(okx.settles - settlesBefore, `one settle for ${path}`).toBe(1);
      expect(spy.callTool.mock.calls.length - callsBefore, `one callTool for ${path}`).toBe(1);
    }
  });
});
