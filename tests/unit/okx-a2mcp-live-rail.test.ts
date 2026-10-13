/**
 * OPS-A2MCP-SERVED-TRUTH-W1 CH2-A — the okx.ai A2MCP LIVE rail on a REAL Express app, through the REAL
 * `@okxweb3/x402-express` middleware and `@okxweb3/x402-core` settle path. Only the network is faked.
 *
 *   F9 (A2): with the facilitator healthy, an UNPAID POST to /a2mcp/<tool> gets 402 — the payment
 *   middleware sees the full `req.path` because rail-mount's dispatcher is app-level. A negative
 *   control mounts the same middleware inside a router at /a2mcp and shows it serves the paid route
 *   FREE, so the regression this pins is real, not hypothetical.
 *
 *   A3: SamplingAwareFacilitator — `{ success: false, sampling: true }` from the inner facilitator is
 *   served (200 + the handler's body); `{ success: false }` without the flag stays a 402.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { paymentMiddlewareFromHTTPServer } from '@okxweb3/x402-express';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader } from '@okxweb3/x402-core/http';
import {
  mountOkxA2mcpRoutes,
  buildOkxHttpResourceServer,
  SamplingAwareFacilitator,
  okxA2mcpTools,
} from '../../src/lib/okx-a2mcp.js';
import { servedState, _resetRailServedStateForTest } from '../../src/lib/rail-served-state.js';

const CREDS = { OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: '0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9' };
const PAYTO = CREDS.OKX_A2MCP_PAYTO;

const SUPPORTED = {
  kinds: [{ scheme: 'exact', network: 'eip155:196', x402Version: 2, extra: null }],
  signers: { 'eip155:196': ['0x0000000000000000000000000000000000000001'] },
  extensions: [],
};

const realFetch = globalThis.fetch;
const noTimers = { setTimeout: () => 0, now: () => Date.now(), random: () => 0.5 };

async function listen(app: Express): Promise<{ base: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('LIVE a2mcp rail — F9: the payment middleware sees the full path', () => {
  let server: Server | undefined;
  beforeEach(() => _resetRailServedStateForTest());
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetRailServedStateForTest();
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  it('healthy facilitator → served live; an UNPAID POST /a2mcp/<tool> is 402, never the handler', async () => {
    // Only OKX calls are faked; the test's own requests to the local server use the real fetch.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => (
      String(url).startsWith('https://web3.okx.com')
        ? new Response(JSON.stringify({ data: SUPPORTED }), { status: 200, headers: { 'content-type': 'application/json' } })
        : realFetch(url, init)
    )));
    const app = express();
    const mounted = await mountOkxA2mcpRoutes(app, CREDS, { timers: noTimers });
    expect(mounted.length).toBeGreaterThan(0);
    expect(servedState().a2mcp).toMatchObject({ status: 'served', mode: 'live' });
    const l = await listen(app); server = l.server;

    for (const tool of okxA2mcpTools()) {
      const res = await realFetch(`${l.base}/a2mcp/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"coin":"BTC"}' });
      expect(res.status, `unpaid POST /a2mcp/${tool}`).toBe(402);
      expect(res.headers.get('payment-required')).toBeTruthy();
    }
  });

  it('NEGATIVE CONTROL: the same middleware inside a router at /a2mcp serves the paid route FREE (why A2 is app-level)', async () => {
    const fake = { getSupported: async () => SUPPORTED, verify: async () => ({ isValid: true }), settle: async () => ({ success: true }) } as never;
    const hs = buildOkxHttpResourceServer(fake, okxA2mcpTools(), PAYTO);
    await hs.initialize();
    const app = express();
    const router = express.Router();
    router.use(paymentMiddlewareFromHTTPServer(hs, undefined, undefined, false));
    router.post('/get_trade_call', (_q, r) => r.json({ served: 'free' }));
    app.use('/a2mcp', router);
    const l = await listen(app); server = l.server;
    const res = await realFetch(`${l.base}/a2mcp/get_trade_call`, { method: 'POST' });
    expect(res.status).toBe(200); // req.path is '/get_trade_call' inside the router → no payment required
  });
});

describe('SamplingAwareFacilitator (A3) — okx.ai UA §7.7 sampling calls are answered free', () => {
  let server: Server | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  /** A real app: the real payment middleware over the wrapper over a fake inner facilitator. */
  async function appWith(settle: () => Promise<Record<string, unknown>>) {
    const inner = {
      getSupported: async () => SUPPORTED,
      verify: async () => ({ isValid: true, payer: '0x00000000000000000000000000000000000000aa' }),
      settle: vi.fn(settle),
    };
    const wrapper = new SamplingAwareFacilitator(inner as never);
    const hs = buildOkxHttpResourceServer(wrapper, okxA2mcpTools(), PAYTO);
    await hs.initialize();
    const app = express();
    app.use(paymentMiddlewareFromHTTPServer(hs, undefined, undefined, false));
    app.post('/a2mcp/get_trade_call', (_q, r) => r.json({ verdict: 'HOLD', served: true }));
    const l = await listen(app); server = l.server;
    return { base: l.base, inner, wrapper };
  }

  /** Build a payment header from the route's own 402 challenge (so requirements match exactly). */
  async function paidHeaders(base: string): Promise<Record<string, string>> {
    const unpaid = await realFetch(`${base}/a2mcp/get_trade_call`, { method: 'POST' });
    expect(unpaid.status).toBe(402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get('payment-required')!);
    const payload = {
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0],
      payload: {
        signature: `0x${'11'.repeat(65)}`,
        authorization: {
          from: '0x00000000000000000000000000000000000000aa',
          to: PAYTO,
          value: String(required.accepts[0].amount),
          validAfter: '0',
          validBefore: String(Math.floor(Date.now() / 1000) + 600),
          nonce: `0x${'22'.repeat(32)}`,
        },
      },
    };
    return { 'content-type': 'application/json', 'payment-signature': encodePaymentSignatureHeader(payload as never) };
  }

  it('settle → { success:false, sampling:true } ⇒ 200 + the handler body (served free, counted once)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base, inner, wrapper } = await appWith(async () => ({ success: false, sampling: true, transaction: '', network: 'eip155:196' }));
    const res = await realFetch(`${base}/a2mcp/get_trade_call`, { method: 'POST', headers: await paidHeaders(base), body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'HOLD', served: true });
    expect(inner.settle).toHaveBeenCalledTimes(1);
    expect(wrapper.samplingCount()).toBe(1);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('sampling settle'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('response keys: success,sampling,transaction,network'); // key NAMES only
  });

  it('sampling flagged under extensions.sampling is recognised too', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base } = await appWith(async () => ({ success: false, extensions: { sampling: true }, transaction: '', network: 'eip155:196' }));
    const res = await realFetch(`${base}/a2mcp/get_trade_call`, { method: 'POST', headers: await paidHeaders(base), body: '{}' });
    expect(res.status).toBe(200);
  });

  it('settle → { success:false } WITHOUT the flag ⇒ 402, the buffered body is discarded', async () => {
    const { base, wrapper } = await appWith(async () => ({ success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:196' }));
    const res = await realFetch(`${base}/a2mcp/get_trade_call`, { method: 'POST', headers: await paidHeaders(base), body: '{}' });
    expect(res.status).toBe(402);
    expect(JSON.stringify(await res.json())).not.toContain('"served":true');
    expect(wrapper.samplingCount()).toBe(0);
  });

  it('a normal successful settle is untouched (200, no sampling count)', async () => {
    const { base, wrapper } = await appWith(async () => ({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: 'eip155:196', payer: '0x00000000000000000000000000000000000000aa' }));
    const res = await realFetch(`${base}/a2mcp/get_trade_call`, { method: 'POST', headers: await paidHeaders(base), body: '{}' });
    expect(res.status).toBe(200);
    expect(wrapper.samplingCount()).toBe(0);
  });

  it('sampling:false or a non-boolean flag is NOT sampling (strict === true)', async () => {
    const { base } = await appWith(async () => ({ success: false, sampling: 'true', transaction: '', network: 'eip155:196' }));
    const res = await realFetch(`${base}/a2mcp/get_trade_call`, { method: 'POST', headers: await paidHeaders(base), body: '{}' });
    expect(res.status).toBe(402);
  });
});
