/**
 * okx-a2mcp.test.ts — OKX-AI-FIRST-MOVER-W1 R3.
 *
 * Unit-tests the okx.ai A2MCP settlement adapter's PURE surfaces + the Stub provider:
 *   - selectOkxA2mcp two-flag decision (off / stub / live / stub-fallback)
 *   - okxA2mcpTools() DERIVES from the registry (no hardcoded list; excludes equities + knowledge)
 *   - okxA2mcpPriceUsdt0() floor + env override
 *   - StubOkxA2mcpProvider buildChallenge (x402-v2 402, X Layer / USDT0) + settle
 *   - mountOkxA2mcpRoutes off → [] (byte-identical prod); stub → mounts the derived route set
 * (The LIVE facilitator path needs OKX creds + registration and is exercised at enablement, not here.)
 */
import { describe, it, expect } from 'vitest';
import type { Express } from 'express';
import {
  selectOkxA2mcp,
  resolveOkxA2mcpConfig,
  okxA2mcpTools,
  okxA2mcpPriceUsdt0,
  mountOkxA2mcpRoutes,
  StubOkxA2mcpProvider,
  buildOkxHttpResourceServer,
  XLAYER_NETWORK,
  XLAYER_USDT0,
  A2MCP_PREFIX,
} from '../src/lib/okx-a2mcp.js';
import { getFeature } from '../src/lib/feature-registry.js';

const CREDS = { OKX_AI_ENABLED: 'true', OKX_API_KEY: 'k', OKX_SECRET_KEY: 's', OKX_PASSPHRASE: 'p', OKX_A2MCP_PAYTO: '0xabc' };

/** Minimal Express stand-in that records mounted GET/POST paths. */
function fakeApp(): Express & { _paths: string[] } {
  const paths: string[] = [];
  const app = {
    _paths: paths,
    get: (p: string) => { paths.push(`GET ${p}`); return app; },
    post: (p: string) => { paths.push(`POST ${p}`); return app; },
    use: () => app,
  };
  return app as unknown as Express & { _paths: string[] };
}

describe('selectOkxA2mcp — two-flag firewall + stub-fallback', () => {
  it('OKX_AI_ENABLED unset/false → off (nothing mounts)', () => {
    expect(selectOkxA2mcp(resolveOkxA2mcpConfig({})).mode).toBe('off');
    expect(selectOkxA2mcp(resolveOkxA2mcpConfig({ OKX_AI_ENABLED: 'false' })).active).toBe(false);
  });

  it('enabled + full creds + payTo → live', () => {
    const r = selectOkxA2mcp(resolveOkxA2mcpConfig(CREDS));
    expect(r.mode).toBe('live');
    expect(r.active).toBe(true);
    expect(r.payTo).toBe('0xabc');
  });

  it('enabled but any cred/payTo missing → stub-fallback (dark, still active)', () => {
    for (const drop of ['OKX_API_KEY', 'OKX_SECRET_KEY', 'OKX_PASSPHRASE', 'OKX_A2MCP_PAYTO'] as const) {
      const env = { ...CREDS }; delete (env as Record<string, string>)[drop];
      const r = selectOkxA2mcp(resolveOkxA2mcpConfig(env));
      expect(r.mode, `missing ${drop}`).toBe('stub');
      expect(r.active).toBe(true);
      expect(r.stubFellBack).toBe(true);
    }
  });
});

describe('okxA2mcpTools — registry-derived listed set', () => {
  it('is exactly the priced signal suite; excludes equities + knowledge', () => {
    const tools = okxA2mcpTools().sort();
    expect(tools).toEqual(['get_market_regime', 'get_trade_call', 'scan_funding_arb', 'scan_trade_calls'].sort());
    expect(tools).not.toContain('get_equity_call');
    expect(tools).not.toContain('get_equity_regime');
    expect(tools).not.toContain('chat_knowledge');
    expect(tools).not.toContain('search_knowledge');
  });
});

describe('okxA2mcpPriceUsdt0 — derived 1:1 from TOOL_PRICING (registry) as USDT0', () => {
  it('equals the registry basePriceUsd for every listed tool (same price every channel)', () => {
    for (const t of okxA2mcpTools()) {
      expect(okxA2mcpPriceUsdt0(t)).toBe(getFeature(t)!.x402!.basePriceUsd);
    }
  });
  it('matches the R4-signed-off schedule (funding_arb 0.01, others 0.02)', () => {
    expect(okxA2mcpPriceUsdt0('scan_funding_arb')).toBe(0.01);
    expect(okxA2mcpPriceUsdt0('get_trade_call')).toBe(0.02);
    expect(okxA2mcpPriceUsdt0('get_market_regime')).toBe(0.02);
    expect(okxA2mcpPriceUsdt0('scan_trade_calls')).toBe(0.02);
  });
});

describe('StubOkxA2mcpProvider', () => {
  const provider = new StubOkxA2mcpProvider('0xPAYTO');

  it('buildChallenge → x402-v2 402 on X Layer / USDT0 (header base64 round-trips)', () => {
    const c = provider.buildChallenge('get_trade_call');
    expect(c.status).toBe(402);
    expect(c.headerName).toBe('PAYMENT-REQUIRED');
    const decoded = JSON.parse(Buffer.from(c.header, 'base64').toString('utf8'));
    expect(decoded).toEqual(c.body);
    expect(decoded.x402Version).toBe(2);
    expect(decoded._stub).toBe(true);
    expect(decoded.accepts[0].network).toBe(XLAYER_NETWORK);
    expect(decoded.accepts[0].asset).toBe(XLAYER_USDT0);
    expect(decoded.accepts[0].payTo).toBe('0xPAYTO');
    expect(decoded.accepts[0].scheme).toBe('exact');
  });

  it('settle → payment_required without a payment header; settled with one', async () => {
    expect((await provider.settle('get_trade_call', {})).settled).toBe(false);
    const ok = await provider.settle('get_trade_call', { 'x-payment': 'proof' });
    expect(ok.settled).toBe(true);
    expect(ok.mode).toBe('stub');
    expect(ok.tx?.startsWith('0xSTUB')).toBe(true);
  });
});

describe('mountOkxA2mcpRoutes — dark by default', () => {
  it('OKX_AI_ENABLED off → mounts NOTHING (returns [])', async () => {
    const app = fakeApp();
    expect(await mountOkxA2mcpRoutes(app, {})).toEqual([]);
    expect(app._paths).toEqual([]);
  });

  it('enabled-but-unprovisioned → stub mounts the registry-derived route set', async () => {
    const app = fakeApp();
    const mounted = await mountOkxA2mcpRoutes(app, { OKX_AI_ENABLED: 'true' });
    const expected = okxA2mcpTools().map((t) => `${A2MCP_PREFIX}/${t}`).sort();
    expect(mounted.sort()).toEqual(expected);
    // each mounted tool got a GET (402 challenge) + a POST (settle) route
    for (const t of okxA2mcpTools()) {
      expect(app._paths).toContain(`GET ${A2MCP_PREFIX}/${t}`);
      expect(app._paths).toContain(`POST ${A2MCP_PREFIX}/${t}`);
    }
  });
});

// Regression guard for the OKX-AI-FIRST-MOVER incident (2026-07-01): the LIVE mount crash-looped
// prod because `paymentMiddlewareFromConfig(routes, facilitator)` had NO scheme implementation
// registered for `exact` on eip155:196 → x402HTTPResourceServer.initialize() threw
// RouteConfigurationError. The fix registers ExactEvmScheme; this proves initialize() no longer throws.
describe('live mount boot-safety — exact scheme registered for eip155:196', () => {
  // Minimal FacilitatorClient stub — getSupported() drives initialize()'s sync (no network).
  const fakeFacilitator = {
    getSupported: async () => ({
      kinds: [{ scheme: 'exact', network: 'eip155:196', x402Version: 2, extra: null }],
      signers: { 'eip155:196': ['0x0000000000000000000000000000000000000001'] },
      extensions: [],
    }),
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true }),
  } as never;

  it('buildOkxHttpResourceServer().initialize() RESOLVES (no RouteConfigurationError)', async () => {
    const hs = buildOkxHttpResourceServer(fakeFacilitator, okxA2mcpTools(), '0x62366c50e1bb14ed4ff2b6c8c143f6049df075b9');
    await expect(hs.initialize()).resolves.toBeUndefined();
  });

  it('negative control: WITHOUT the exact scheme, initialize() REJECTS (guards the crash bug)', async () => {
    const core = await import('@okxweb3/x402-core/server');
    const server = new core.x402ResourceServer(fakeFacilitator);
    const hs = new core.x402HTTPResourceServer(server, {
      'POST /a2mcp/get_trade_call': { accepts: [{ scheme: 'exact', network: 'eip155:196', payTo: '0x0', price: '0.02' }] },
    } as never);
    await expect(hs.initialize()).rejects.toThrow();
  });
});
