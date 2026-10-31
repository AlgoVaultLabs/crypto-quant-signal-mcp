/**
 * DECISION-CALL-V1-W3 CH1 (AC1.5) — pre_trade_check on the x402 rails, end to end through the real
 * derivations.
 *
 *   1. The nudge (on, Bazaar rail served): a KEYLESS caller past its quota calls the real tool through
 *      the real pipeline, exactly as `/mcp` does (ambient request context, `toMcpToolResult`), and the
 *      wall carries `suggested_x402` pointing at `/x402/pre_trade_check` at `price_usd: 0.02`. Nothing
 *      in the nudge names this tool: route and price project from the registry row this wave priced.
 *   2. The binding, through the real `initX402` requirement build (SDK stubbed as in x402-paid-path):
 *      a proof priced for another tool — scan_funding_arb's $0.01 — does not pay for this route, and the
 *      in-band `X402_PAYMENT_REQUIRED` carries this route's amount, "20000".
 *
 * On (2), what "another tool" means is pinned too: identity binds a proof to our wallet, chain and token
 * per RAIL, never per tool (one payTo/asset per rail), and the PRICE is the floor
 * (OPS-X402-MCP-PRICE-BINDING-W1). So a proof at another tool's equal $0.02 price pays for this one, by
 * design; only a cheaper tool's proof is refused, and it is refused as `insufficient`.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'DATABASE_URL', 'X402_NUDGE_ENABLED', 'X402_FACILITATOR', 'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET', 'BAZAAR_DISCOVERABLE', 'X402_NETWORK', 'X402_WALLET_ADDRESS',
] as const;
const ORIG_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

/** Bazaar (Base/USDC) live, OKX off — the fixture `tests/x402-nudge.test.ts` uses. */
const BAZAAR_ENV = {
  X402_NUDGE_ENABLED: '1',
  X402_FACILITATOR: 'cdp',
  CDP_API_KEY_ID: 'test-id',
  CDP_API_KEY_SECRET: 'test-secret',
  BAZAAR_DISCOVERABLE: 'true',
  X402_NETWORK: 'base-mainnet',
};

let home = '';
async function freshSqlite(): Promise<void> {
  delete process.env.DATABASE_URL;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-ptc-rail-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
}
async function dropSqlite(): Promise<void> {
  const { closeDb } = await import('../src/lib/performance-db.js');
  closeDb();
  vi.resetModules();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('nudge on — a keyless caller past quota is offered /x402/pre_trade_check at $0.02', () => {
  const MOCKED = ['../src/lib/performance-db.js', '../src/lib/analytics.js'];

  beforeEach(async () => {
    await freshSqlite();
    Object.assign(process.env, BAZAAR_ENV);
    // `residency:'hosted'`: the pipeline's admission refuses on SQLite before the tool runs, so the
    // exported `isPgBackend` reads true. Only the pipeline and the OAuth store import it; `dbQuery`
    // keeps the module's own backend choice (SQLite), so nothing here can open a socket.
    vi.doMock('../src/lib/performance-db.js', async (orig) => ({
      ...(await orig<typeof import('../src/lib/performance-db.js')>()),
      isPgBackend: () => true,
    }));
    vi.doMock('../src/lib/analytics.js', async (orig) => ({
      ...(await orig<typeof import('../src/lib/analytics.js')>()),
      logRequest: () => {},
    }));
  });
  afterEach(async () => {
    for (const m of MOCKED) vi.doUnmock(m);
    for (const k of Object.keys(BAZAAR_ENV)) delete (process.env as Record<string, string | undefined>)[k];
    await dropSqlite();
  });

  it('the wall carries suggested_x402 → /x402/pre_trade_check, price_usd 0.02', async () => {
    const { requestContext, trackCall, checkQuota, _resetCallTrackersForTest, resetLicenseCache } = await import('../src/lib/license.js');
    const { FREE_DAILY_CALLS } = await import('../src/lib/plans.js');
    const { markServed, _resetRailServedStateForTest } = await import('../src/lib/rail-served-state.js');
    const { callTool, toMcpToolResult } = await import('../src/lib/tool-call-pipeline.js');
    _resetCallTrackersForTest();
    resetLicenseCache();
    _resetRailServedStateForTest();
    markServed('httpX402', { mode: 'cdp', routes: 7 }); // what the route mount reports at boot

    const license = { tier: 'free', key: null } as const; // KEYLESS: metered on free:<ipHash>
    const ctx = { license, sessionId: 'ptc-rail-session', ipHash: 'ptc-rail-ip', isAutomated: false } as never;
    const result = await requestContext.run(ctx, async () => {
      for (let i = 0; i < FREE_DAILY_CALLS; i++) trackCall(license);
      expect(checkQuota(license).allowed, 'the fixture must actually be walled').toBe(false);
      // The `/mcp` shape: the POST layer installed the context, so callTool gets no ctx of its own.
      const out = await callTool({
        tool: 'pre_trade_check',
        input: { coin: 'BTC', side: 'long', sizeUsd: 10000 } as never,
        license,
        channel: 'mcp',
      });
      return toMcpToolResult(out);
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text) as {
      code?: string;
      suggested_x402?: { tool: string; primary: { url: string; price_usd: number; rail: string } };
    };
    expect(payload.code).toBe('TIER_LIMIT_REACHED');
    expect(payload.suggested_x402?.tool).toBe('pre_trade_check');
    expect(payload.suggested_x402?.primary.rail).toBe('x402_bazaar');
    expect(payload.suggested_x402?.primary.url).toMatch(/\/x402\/pre_trade_check$/);
    expect(payload.suggested_x402?.primary.price_usd).toBe(0.02);
  });
});

describe('binding — a proof priced for another tool does not pay for /x402/pre_trade_check', () => {
  const WALLET = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const atomic = (usd: number) => Math.round(usd * 1_000_000).toString();
  const req = (usd: number) => ({
    scheme: 'exact', network: 'eip155:8453', amount: atomic(usd), asset: USDC,
    payTo: WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
  });
  /** A verified settlement for `usd`: the matched requirement AND the buyer's signed value. */
  const proof = (usd: number) => ({
    requirements: req(usd),
    paymentPayload: {
      x402Version: 2, accepted: req(usd),
      payload: { signature: '0xsig', authorization: { from: '0xPAYER', to: WALLET, value: atomic(usd), validAfter: '0', validBefore: '9999999999', nonce: '0x01' } },
    },
  });
  const MOCKED = ['../src/lib/x402-facilitator.js', '@x402/core/server', '@x402/core/http', '@x402/extensions/bazaar'];

  beforeEach(async () => {
    await freshSqlite();
    Object.assign(process.env, BAZAAR_ENV, { X402_WALLET_ADDRESS: WALLET });
    vi.doMock('../src/lib/x402-facilitator.js', () => ({
      resolveFacilitatorFromEnv: () => ({ effectiveChoice: 'cdp', discoveryEnabled: true }),
      createFacilitatorClient: () => ({}),
    }));
    vi.doMock('@x402/core/server', () => ({
      x402ResourceServer: class {
        register() {}
        registerExtension() {}
        async initialize() {}
        getSupportedKind() { return true; }
        async buildPaymentRequirements(cfg: { price: string }) { return [req(parseFloat(String(cfg.price).replace('$', '')))]; }
        findMatchingRequirements() { return null; }
        async verifyPayment() { return { isValid: true }; }
        settlePayment() { return Promise.resolve({ success: true }); }
      },
    }));
    vi.doMock('@x402/core/http', () => ({ encodePaymentRequiredHeader: () => 'stub-header' }));
    vi.doMock('@x402/extensions/bazaar', () => ({
      bazaarResourceServerExtension: {},
      declareDiscoveryExtension: () => ({ bazaar: { info: { input: { type: 'http' } } } }),
    }));
  });
  afterEach(async () => {
    for (const m of MOCKED) vi.doUnmock(m);
    for (const k of [...Object.keys(BAZAAR_ENV), 'X402_WALLET_ADDRESS']) delete (process.env as Record<string, string | undefined>)[k];
    await dropSqlite();
  });

  it('priced at $0.02 on /mcp too: the route is in HTTP_TOOLS, which /mcp keys isPricedTool off', async () => {
    const { HTTP_TOOLS } = await import('../src/lib/x402-http-routes.js');
    const { TOOL_PRICING, effectivePrice } = await import('../src/lib/x402.js');
    expect((HTTP_TOOLS as readonly string[]).includes('pre_trade_check')).toBe(true);
    expect((TOOL_PRICING as unknown as Record<string, number>).pre_trade_check).toBe(0.02);
    for (const tf of ['1h', '4h', '1d', undefined]) expect(effectivePrice('pre_trade_check', tf)).toBe(0.02); // flat
  });

  it('a scan_funding_arb ($0.01) proof → refused as insufficient; X402_PAYMENT_REQUIRED carries amount "20000"', async () => {
    const x402 = await import('../src/lib/x402.js');
    await x402.initX402();
    const built = x402._getToolRequirementsForTest().get('pre_trade_check') as Array<{ amount: string }> | undefined;
    expect(built?.[0]?.amount, 'initX402 built this route from the registry price').toBe('20000');

    const cheaper = proof(0.01);
    expect(x402.paymentMatchesToolRoute(cheaper, 'pre_trade_check', '4h')).toBe(false);
    expect(x402.classifyToolRouteMismatch(cheaper, 'pre_trade_check', '4h')).toBe('insufficient');

    const res = x402.buildX402PaymentRequiredResult('pre_trade_check', 'insufficient', 7);
    expect(res.id).toBe(7);
    expect(res.result.isError).toBe(true);
    const body = JSON.parse(res.result.content[0].text) as { code: string; paymentRequirements: Array<{ amount: string }> };
    expect(body.code).toBe('X402_PAYMENT_REQUIRED');
    expect(body.paymentRequirements[0]?.amount).toBe('20000');
  });

  it('pinned: a proof at another tool’s EQUAL $0.02 price pays for this route — identity is per rail, the price is the floor', async () => {
    const x402 = await import('../src/lib/x402.js');
    await x402.initX402();
    expect(x402.paymentMatchesToolRoute(proof(0.02), 'pre_trade_check', '4h')).toBe(true);
    expect(x402.classifyToolRouteMismatch(proof(0.02), 'pre_trade_check', '4h')).toBe('ok');
  });
});
