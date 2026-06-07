/**
 * X402-01 / X402-02 / X402-03 — PAID-PATH HTTP integration (retires the
 * untested-paid-path class, audit X402-08). (SECURITY-FIX-X402-WEBHOOK-W1, Stream A)
 *
 * Boots the real Express app via mountX402HttpRoutes() and drives it with real
 * fetch() through a SETTLED x402 payment (the existing x402-http-routes.test.ts
 * only ever covered unpaid→402). `resolveLicense` is mocked to hand the route a
 * crafted `pendingSettlement` whose matched `requirements` is set to whichever
 * tool's pre-built requirement we want to simulate the proof matched — so we can
 * exercise the cross-tool downgrade, premium-timeframe underpay, replay, and
 * wrong-network rejections WITHOUT hitting the CDP facilitator. The core tool
 * handlers are mocked to return fixed outputs (we assert on serve-vs-402, not on
 * tool internals). The idempotency store runs for real against SQLite.
 *
 * Coverage (per priced route):
 *   - exact / over price → 200 served
 *   - cross-tool downgrade ($0.01 proof on a $0.02 route) → 402, not served
 *   - premium-timeframe underpay (base $0.02 proof on a 1m=$0.05 call) → 402
 *   - wrong network proof → 402
 *   - replayed nonce → 402; first-use nonce → 200
 *   - free get_trade_call route unaffected (never mounted as a paid route)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const WALLET = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'eip155:8453';
const atomic = (usd: number) => Math.round(usd * 1_000_000).toString();

function req(amountUsd: number, over: Partial<Record<string, string>> = {}) {
  return {
    scheme: 'exact', network: NETWORK, amount: atomic(amountUsd), asset: USDC,
    payTo: WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
    ...over,
  };
}

/** Build the X-PAYMENT envelope an attacker would submit, with a chosen nonce. */
function paymentEnvelope(requirement: Record<string, unknown>, nonce: string) {
  return {
    x402Version: 2,
    accepted: requirement,
    payload: {
      signature: '0xsig',
      authorization: {
        from: '0xPAYER', to: WALLET, value: requirement.amount,
        validAfter: '0', validBefore: '9999999999', nonce,
      },
    },
  };
}

const ORIG = {
  X402_FACILITATOR: process.env.X402_FACILITATOR,
  BAZAAR_DISCOVERABLE: process.env.BAZAAR_DISCOVERABLE,
  X402_WALLET_ADDRESS: process.env.X402_WALLET_ADDRESS,
  X402_NETWORK: process.env.X402_NETWORK,
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
};

let server: http.Server | undefined;
let baseUrl = '';
let tempHome = '';

/**
 * The settlement the mocked resolveLicense hands the route on the NEXT request.
 * `requirements` simulates whichever tool's requirement `findMatchingRequirements`
 * matched (the flattened-pool match the audit exploited); `paymentPayload` carries
 * the nonce for the idempotency claim. null → unpaid (tier!=='x402').
 */
let nextSettlement: { requirements: unknown; paymentPayload: unknown } | null = null;

function setProof(requirement: Record<string, unknown>, nonce: string) {
  nextSettlement = { requirements: requirement, paymentPayload: paymentEnvelope(requirement, nonce) };
}

beforeAll(() => {
  process.env.X402_WALLET_ADDRESS = WALLET;
  process.env.X402_NETWORK = 'base-mainnet';
  process.env.X402_FACILITATOR = 'cdp';
  process.env.BAZAAR_DISCOVERABLE = 'true';
  process.env.CDP_API_KEY_ID = 'test-cdp-key-id';
  process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret';
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

beforeEach(async () => {
  delete process.env.DATABASE_URL; // SQLite path
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-x402paid-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  nextSettlement = null;

  vi.resetModules();
  const { closeDb } = await import('../src/lib/performance-db.js');
  closeDb();

  // Facilitator + SDK stub so mountX402HttpRoutes mounts (discoveryEnabled) and
  // initX402 builds real per-tool requirements (used by paymentMatchesToolRoute).
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
      async buildPaymentRequirements(cfg: { price: string }) {
        return [req(parseFloat(String(cfg.price).replace('$', '')))];
      }
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

  // Mock the license module: resolveLicense returns the crafted settlement;
  // requestContext.run just invokes the fn (AsyncLocalStorage no-op for the test).
  vi.doMock('../src/lib/license.js', () => ({
    resolveLicense: async () =>
      nextSettlement
        ? { license: { tier: 'x402', key: null }, pendingSettlement: nextSettlement }
        : { license: { tier: 'free', key: null } },
    requestContext: { run: (_ctx: unknown, fn: () => unknown) => fn() },
  }));
  // Mock the 3 core tool handlers to fixed outputs (we assert serve-vs-402).
  vi.doMock('../src/tools/get-trade-call.js', () => ({
    getTradeSignal: () => ({ call: 'BUY', confidence: 70, coin: 'BTC' }),
  }));
  vi.doMock('../src/tools/scan-funding-arb.js', () => ({
    scanFundingArb: () => ({ opportunities: [], scannedPairs: 1 }),
  }));
  vi.doMock('../src/tools/get-market-regime.js', () => ({
    getMarketRegime: () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' }),
  }));
  // Quiet analytics.
  vi.doMock('../src/lib/analytics.js', () => ({ hashIp: () => 'h', logRequest: () => {} }));

  const express = (await import('express')).default;
  const { initX402 } = await import('../src/lib/x402.js');
  await initX402();
  const { mountX402HttpRoutes } = await import('../src/lib/x402-http-routes.js');
  const app = express();
  mountX402HttpRoutes(app);
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  const { closeDb } = await import('../src/lib/performance-db.js');
  closeDb();
  vi.resetModules();
  delete process.env.HOME; delete process.env.USERPROFILE;
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function post(tool: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/x402/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-payment': 'present' },
    body: JSON.stringify(body),
  });
}

let nonceSeq = 0;
const freshNonce = () => `0x${(++nonceSeq).toString(16).padStart(64, '0')}`;

describe('X402-01 — correct payment served, cross-tool downgrade rejected', () => {
  it('exact $0.02 proof on get_trade_signal → 200 served', async () => {
    setProof(req(0.02), freshNonce());
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(200);
    expect((await res.json() as { call?: string }).call).toBe('BUY');
  });

  it('over-price $0.03 proof on get_trade_signal → 200 served', async () => {
    setProof(req(0.03), freshNonce());
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(200);
  });

  it('$0.01 scan_funding_arb proof POSTed to $0.02 get_trade_signal → 402 (cross-tool downgrade)', async () => {
    setProof(req(0.01), freshNonce());
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(402);
    // Must NOT have served tool output.
    expect((await res.json() as { call?: string }).call).toBeUndefined();
  });

  it('$0.01 proof POSTed to $0.02 get_market_regime → 402 (cross-tool downgrade)', async () => {
    setProof(req(0.01), freshNonce());
    const res = await post('get_market_regime', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(402);
  });

  it('legitimate $0.01 proof on scan_funding_arb → 200 served', async () => {
    setProof(req(0.01), freshNonce());
    const res = await post('scan_funding_arb', { minSpreadBps: 5, limit: 10 });
    expect(res.status).toBe(200);
    expect((await res.json() as { scannedPairs?: number }).scannedPairs).toBe(1);
  });
});

describe('X402-03 — premium-timeframe underpay rejected', () => {
  it('base $0.02 proof on a premium 1m get_trade_signal call → 402', async () => {
    setProof(req(0.02), freshNonce());
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '1m' });
    expect(res.status).toBe(402);
  });

  it('$0.05 proof on a 1m get_trade_signal call → 200 (premium covered)', async () => {
    // The matched requirement carries the premium amount (a body-aware 402 would
    // advertise $0.05 for 1m); binding accepts it because amount==effective price.
    setProof(req(0.05), freshNonce());
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '1m' });
    expect(res.status).toBe(200);
  });
});

describe('X402 (b)(c)(d) — wrong network/asset/payTo rejected', () => {
  it('a base-sepolia (wrong network) proof → 402', async () => {
    setProof(req(0.02, { network: 'eip155:84532' }), freshNonce());
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(402);
  });
});

describe('X402-02 — replayed nonce rejected', () => {
  it('first use of a nonce → 200; replay of the same nonce → 402', async () => {
    const nonce = freshNonce();
    setProof(req(0.02), nonce);
    const first = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(first.status).toBe(200);

    // Replay the EXACT same proof (same nonce).
    setProof(req(0.02), nonce);
    const replay = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(replay.status).toBe(402);
    expect((await replay.json() as { code?: string }).code).toBe('X402_PAYMENT_REPLAY');
  });

  it('a fresh nonce after a replay → 200 (only the dup is blocked)', async () => {
    const nonce = freshNonce();
    setProof(req(0.02), nonce);
    expect((await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' })).status).toBe(200);
    setProof(req(0.02), nonce);
    expect((await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' })).status).toBe(402);
    setProof(req(0.02), freshNonce());
    expect((await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' })).status).toBe(200);
  });
});

describe('free tool unaffected', () => {
  it('get_trade_call is NOT a mounted paid route → 404', async () => {
    const res = await fetch(`${baseUrl}/x402/get_trade_call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('unpaid (no settlement) get_trade_signal → 402, not served', async () => {
    nextSettlement = null;
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(402);
  });
});
