/**
 * X402-BAZAAR-HTTP-REDECLARE-W1 — HTTP x402 resource routes.
 *
 * Boots a minimal Express app with mountX402HttpRoutes() on an ephemeral port and
 * drives it with real fetch(). Covers: two-flag firewall mount (404 when off),
 * 402 enforcement when unpaid + the listing channel (resource URL + bazaar ext) +
 * no free-data leak, handler parity (same core fns + mapped args as the MCP tools),
 * and input validation against the published JSON Schema.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIG = {
  X402_FACILITATOR: process.env.X402_FACILITATOR,
  BAZAAR_DISCOVERABLE: process.env.BAZAAR_DISCOVERABLE,
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
};

let server: http.Server | undefined;
let baseUrl = '';
let tempHome = '';

async function bootApp(flags: { facilitator?: string; bazaar?: string }): Promise<string[]> {
  if (flags.facilitator !== undefined) process.env.X402_FACILITATOR = flags.facilitator;
  else delete process.env.X402_FACILITATOR;
  if (flags.bazaar !== undefined) process.env.BAZAAR_DISCOVERABLE = flags.bazaar;
  else delete process.env.BAZAAR_DISCOVERABLE;
  // Stub-first: discoveryEnabled requires cdp keys present (else the adapter falls
  // back to legacy and the routes intentionally don't mount). The real mainnet flip
  // happens with keys in .env; mirror that here with dummy keys (no real settle in
  // these tests — unpaid → 402 short-circuits before any facilitator call).
  if (flags.facilitator === 'cdp') {
    process.env.CDP_API_KEY_ID = 'test-cdp-key-id';
    process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret';
  } else {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
  }

  const express = (await import('express')).default;
  const { mountX402HttpRoutes } = await import('../src/lib/x402-http-routes.js');
  const app = express();
  const mounted = mountX402HttpRoutes(app);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mounted;
}

beforeEach(() => {
  delete process.env.DATABASE_URL; // SQLite path
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-x402http-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('x402 HTTP routes — two-flag firewall mount (R5)', () => {
  it('defaults (legacy/false) → routes NOT mounted → 404 (byte-identical prod)', async () => {
    const mounted = await bootApp({ facilitator: 'legacy', bazaar: 'false' });
    expect(mounted).toEqual([]);
    const res = await fetch(`${baseUrl}/x402/get_trade_signal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('unset flags → routes NOT mounted', async () => {
    const mounted = await bootApp({});
    expect(mounted).toEqual([]);
  });

  it('cdp + true (but not cdp + false) → mounts exactly the 3 paid routes', async () => {
    expect(await bootApp({ facilitator: 'cdp', bazaar: 'false' })).toEqual([]);
    if (server) { await new Promise<void>((r) => server!.close(() => r())); server = undefined; }
    const mounted = await bootApp({ facilitator: 'cdp', bazaar: 'true' });
    expect(mounted.slice().sort()).toEqual([
      '/x402/get_market_regime',
      '/x402/get_trade_signal',
      '/x402/scan_funding_arb',
    ]);
  });
});

describe('x402 HTTP routes — paywall + listing channel (R2, R3, item K)', () => {
  it('unpaid POST → 402 carrying the HTTP resource URL + bazaar HTTP-ext, NO tool data leaked', async () => {
    await bootApp({ facilitator: 'cdp', bazaar: 'true' });
    const res = await fetch(`${baseUrl}/x402/get_trade_signal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coin: 'BTC' }),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as Record<string, unknown> & {
      x402Version?: number;
      resource?: { url?: string };
      extensions?: { bazaar?: { info?: { input?: { type?: string } } } };
    };
    expect(body.x402Version).toBe(2);
    expect(body.resource?.url).toMatch(/\/x402\/get_trade_signal$/);
    expect(body.extensions?.bazaar?.info?.input?.type).toBe('http'); // listing channel present
    // No free-data leak: the 402 is a payment-required envelope — NO top-level live
    // tool result (a computed signal would surface as top-level call/confidence/etc.).
    // (Static shape EXAMPLES inside extensions.bazaar.…output.example are public API
    // documentation, intentionally present — not a leak of the buyer's query result.)
    expect(body.call).toBeUndefined();
    expect(body.confidence).toBeUndefined();
    expect(body.indicators).toBeUndefined();
    expect(body.regime).toBeUndefined();
    // Internal-only fields never appear ANYWHERE (even in metadata examples).
    expect(JSON.stringify(body)).not.toMatch(/outcome_return_pct|outcome_price/i);
  });

  it('all 3 routes enforce 402 when unpaid', async () => {
    await bootApp({ facilitator: 'cdp', bazaar: 'true' });
    for (const t of ['get_trade_signal', 'scan_funding_arb', 'get_market_regime']) {
      const res = await fetch(`${baseUrl}/x402/${t}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect(res.status, t).toBe(402);
    }
  });
});

describe('x402 HTTP routes — handler parity (R1: same core fn + args as MCP)', () => {
  it('callCoreHandler dispatches to the same core fns with the mapped args', async () => {
    vi.resetModules();
    const calls: Record<string, unknown> = {};
    vi.doMock('../src/tools/get-trade-call.js', () => ({
      getTradeSignal: (i: unknown) => { calls.getTradeSignal = i; return { call: 'BUY' }; },
    }));
    vi.doMock('../src/tools/scan-funding-arb.js', () => ({
      scanFundingArb: (i: unknown) => { calls.scanFundingArb = i; return { opportunities: [] }; },
    }));
    vi.doMock('../src/tools/get-market-regime.js', () => ({
      getMarketRegime: (i: unknown) => { calls.getMarketRegime = i; return { regime: 'RANGING' }; },
    }));
    const { callCoreHandler } = await import('../src/lib/x402-http-routes.js');
    const license = { tier: 'x402' as const, key: null };

    await callCoreHandler('get_trade_signal', { coin: 'BTC', timeframe: '4h', includeReasoning: true, exchange: 'BINANCE' }, license);
    expect(calls.getTradeSignal).toEqual({ coin: 'BTC', timeframe: '4h', includeReasoning: true, exchange: 'BINANCE', license });

    await callCoreHandler('scan_funding_arb', { minSpreadBps: 5, limit: 10 }, license);
    expect(calls.scanFundingArb).toEqual({ minSpreadBps: 5, limit: 10, license });

    await callCoreHandler('get_market_regime', { coin: 'ETH', timeframe: '4h', exchange: 'HL' }, license);
    expect(calls.getMarketRegime).toEqual({ coin: 'ETH', timeframe: '4h', exchange: 'HL' }); // no license — matches MCP handler

    vi.doUnmock('../src/tools/get-trade-call.js');
    vi.doUnmock('../src/tools/scan-funding-arb.js');
    vi.doUnmock('../src/tools/get-market-regime.js');
    vi.resetModules();
  });
});

describe('x402 HTTP routes — input validation against published JSON Schema (R10)', () => {
  it('the route ajv-validates the body against BAZAAR_ROUTES[tool].inputSchema', async () => {
    const Ajv = (await import('ajv')).default;
    const { BAZAAR_ROUTES } = await import('../src/lib/x402-bazaar.js');
    const ajv = new Ajv({ useDefaults: true, coerceTypes: true, allErrors: true });
    const v = ajv.compile(BAZAAR_ROUTES['get_trade_signal'].inputSchema);
    expect(v({}), 'missing required coin must fail').toBe(false);
    expect(v({ coin: 'BTC', timeframe: 'not-a-tf' }), 'out-of-enum timeframe must fail').toBe(false);
    expect(v({ coin: 'BTC', bogus: 1 }), 'additionalProperties must fail').toBe(false);
    expect(v({ coin: 'BTC' }), 'valid (defaults applied) must pass').toBe(true);
  });
});
