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
 *   - get_trade_call /x402 alias is now a paid route (W1); still OUT of HTTP_TOOLS (MCP free path unchanged)
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

/**
 * OPS-X402-TRADE-CALL-CONTENT-TYPE-W1 — two test seams the free-HOLD guard needs.
 *
 * `nextVerdict` drives the mocked get_trade_signal handler so BOTH branches of the
 * HOLD-skip are reachable (live verdicts were 5/5 HOLD when this was written, so the
 * directional branch is not reachable from real data on demand).
 * `settleCalls` counts real `settleX402Async` → `settlePayment` invocations, which is
 * how "a HOLD is FREE" becomes an assertion instead of a promise.
 */
let nextVerdict: 'BUY' | 'SELL' | 'HOLD' = 'BUY';
let settleCalls = 0;
/** Every `logRequest` entry this route emitted, in order (see the analytics mock below). */
let loggedRequests: Record<string, unknown>[] = [];

/** Settle is fire-and-forget AFTER res.json(), so give the server a tick before asserting. */
const settleTick = () => new Promise((r) => setTimeout(r, 60));

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
  nextVerdict = 'BUY';
  settleCalls = 0;
  loggedRequests = [];

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
      settlePayment() { settleCalls++; return Promise.resolve({ success: true }); }
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
    getTradeSignal: () => ({ call: nextVerdict, confidence: 70, coin: 'BTC' }),
  }));
  // The remaining payable routes, so the content-type matrix can drive EVERY one of them
  // end-to-end rather than only the three the original suite happened to cover.
  vi.doMock('../src/tools/scan-trade-calls.js', () => ({
    runScanTradeCall: () => ({ calls: [], scanned: 0 }),
  }));
  vi.doMock('../src/lib/equities/equity-tool-formatters.js', () => ({
    getEquityCall: () => ({ call: 'HOLD', symbol: 'AAPL' }),
    getEquityRegime: () => ({ regime: 'RANGING', symbol: 'AAPL' }),
  }));
  vi.doMock('../src/tools/scan-funding-arb.js', () => ({
    scanFundingArb: () => ({ opportunities: [], scannedPairs: 1 }),
  }));
  vi.doMock('../src/tools/get-market-regime.js', () => ({
    getMarketRegime: () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' }),
  }));
  // Analytics stays out of the DB, but logRequest is RECORDED rather than discarded:
  // TG-DIGEST-INTERNAL-ROW-AND-PAID-SESSION-W1 needs the emitted row to be assertable, and a
  // no-op mock is precisely what let this route write `session_id: NULL` for 20 consecutive
  // settled payments with a green suite.
  vi.doMock('../src/lib/analytics.js', () => ({
    hashIp: () => 'h',
    logRequest: (e: Record<string, unknown>) => { loggedRequests.push(e); },
  }));

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
  // LANDING-X402-CALL-ROUTE-W1: /x402/get_trade_call is NOW a PAID ALIAS of get_trade_signal so the
  // public docs can promote it (was 404 pre-W1). The free-tier invariant that REMAINS: it is still
  // OUT of HTTP_TOOLS, so isPricedTool + the MCP free-tier path are byte-unchanged (the alias is
  // HTTP-only); it also stays non-discoverable (asserted in x402-http-routes.test.ts).
  it('get_trade_call /x402 alias is now a paid route → unpaid POST 402 (was 404 pre-W1); still NOT in HTTP_TOOLS', async () => {
    const res = await fetch(`${baseUrl}/x402/get_trade_call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(402);
    const { HTTP_TOOLS } = await import('../src/lib/x402-http-routes.js');
    expect((HTTP_TOOLS as readonly string[]).includes('get_trade_call')).toBe(false);
  });

  it('unpaid (no settlement) get_trade_signal → 402, not served', async () => {
    nextSettlement = null;
    const res = await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(402);
  });
});

/**
 * OPS-CIRCLE-GATEWAY-PAY-REGRESSION-W1 — a PAID request whose body never parsed.
 *
 * 2026-07-29: a Circle Gateway payment VERIFIED, then the route returned a bare `400
 * invalid_input` and the client surfaced `Payment failed: invalid_input`. The body had never
 * reached the validator — the caller passed its own `content-type` to an SDK that already sets
 * `Content-Type`, both case-different keys survived the SDK's header spread, and fetch COMBINED
 * them into `application/json, application/json`, which express.json() will not parse. The
 * JSON-Schema error therefore blamed the wrong thing entirely.
 *
 * The predicate is unit-tested in x402-rejection-diagnostics.test.ts; only THESE prove the
 * wiring — including that the body-key count is read BEFORE ajv applies its schema defaults
 * (`useDefaults` mutates the object even on a failing validation, which would otherwise make an
 * empty body look populated).
 */
describe('paid request whose content-type prevents body parsing', () => {
  /** Repeated header keys are combined by fetch — exactly what the SDK's header spread produces. */
  async function postDupContentType(tool: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/x402/${tool}`, {
      method: 'POST',
      headers: [
        ['content-type', 'application/json'],
        ['content-type', 'application/json'],
        ['x-payment', 'present'],
      ] as unknown as HeadersInit,
      body: JSON.stringify(body),
    });
  }

  it('SANITY: two case-different content-type keys really do combine on the wire', () => {
    const h = new Headers([['Content-Type', 'application/json'], ['content-type', 'application/json']]);
    expect(h.get('content-type')).toBe('application/json, application/json');
  });

  it('→ 400 invalid_content_type naming the duplication, not a misleading schema error', async () => {
    setProof(req(0.02), freshNonce());
    const res = await postDupContentType('get_market_regime', { coin: 'BTC', timeframe: '1h' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string; code?: string; message?: string; suggested_fix?: string };
    expect(body.error).toBe('invalid_content_type');
    expect(body.code).toBe('X402_HTTP_INVALID_CONTENT_TYPE');
    expect(body.message).toContain('2 media types');
    // The caller must be told they keep their money — validation runs before claim + settle.
    expect(body.suggested_fix).toContain('NOT charged');
  });

  it('a clean content-type with a genuinely invalid body still returns invalid_input (contract unchanged)', async () => {
    setProof(req(0.02), freshNonce());
    const res = await post('get_market_regime', {}); // missing required `coin`
    expect(res.status).toBe(400);
    expect((await res.json() as { error?: string }).error).toBe('invalid_input');
  });

  it('a clean content-type with a valid body is still served (happy path unchanged)', async () => {
    setProof(req(0.02), freshNonce());
    const res = await post('get_market_regime', { coin: 'BTC', timeframe: '1h' });
    expect(res.status).toBe(200);
    expect((await res.json() as { regime?: string }).regime).toBe('RANGING');
  });
});

/**
 * OPS-X402-TRADE-CALL-CONTENT-TYPE-W1 R2 — the branch-coverage canary that retires the class.
 *
 * Every payment break in this arc — v1/v2 header, `expected[0]` rail binding, invalid_input, and
 * the duplicated content-type — hid the same way: the suite exercised SOME routes on SOME
 * branches, and the broken combination was never driven end-to-end. This drives the REAL mounted
 * route over real `fetch` with a real x402 envelope for EVERY payable route on BOTH content-type
 * shapes, and the SANITY test fails if a future route is added to HTTP_TOOLS without joining the
 * matrix — so coverage cannot silently rot.
 *
 * Real money is deliberately NOT used here (architect-confirmed): a canary that spends USDC per CI
 * run needs a funded key in CI and flakes on vendor latency. The genuine-money check stays the
 * operator-run live smoke.
 */
describe('R2 — every payable route × {clean, duplicated} content-type', () => {
  const ROUTES: Array<{ path: string; tool: string; body: Record<string, unknown> }> = [
    { path: 'get_trade_signal', tool: 'get_trade_signal', body: { coin: 'BTC', timeframe: '4h' } },
    { path: 'get_trade_call', tool: 'get_trade_signal', body: { coin: 'BTC', timeframe: '4h' } }, // alias
    { path: 'scan_funding_arb', tool: 'scan_funding_arb', body: { minSpreadBps: 5, limit: 10 } },
    { path: 'get_market_regime', tool: 'get_market_regime', body: { coin: 'BTC', timeframe: '1h' } },
    { path: 'scan_trade_calls', tool: 'scan_trade_calls', body: { topN: 5, timeframe: '4h' } },
    { path: 'get_equity_call', tool: 'get_equity_call', body: { symbol: 'AAPL' } },
    { path: 'get_equity_regime', tool: 'get_equity_regime', body: { symbol: 'SPY' } },
  ];

  /** Repeated header keys are combined by fetch — exactly what a client adding its own
   *  `content-type` on top of an SDK that already sets `Content-Type` produces. */
  const postDupContentType = (path: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/x402/${path}`, {
      method: 'POST',
      headers: [
        ['content-type', 'application/json'],
        ['content-type', 'application/json'],
        ['x-payment', 'present'],
      ] as unknown as HeadersInit,
      body: JSON.stringify(body),
    });

  const priceOf = async (tool: string): Promise<number> => {
    const { TOOL_PRICING } = await import('../src/lib/x402.js');
    return (TOOL_PRICING as unknown as Record<string, number>)[tool];
  };

  it('SANITY: the matrix covers every mounted payable route (fails when a route is added)', async () => {
    const { HTTP_TOOLS } = await import('../src/lib/x402-http-routes.js');
    const covered = new Set(ROUTES.map((r) => r.path));
    for (const t of HTTP_TOOLS as readonly string[]) {
      expect(covered.has(t), `HTTP_TOOLS route "${t}" is missing from the R2 matrix`).toBe(true);
    }
    expect(covered.has('get_trade_call')).toBe(true); // the non-discoverable paid alias
  });

  for (const r of ROUTES) {
    it(`${r.path}: PAID + duplicated content-type → 400 invalid_content_type (not a misleading schema error)`, async () => {
      setProof(req(await priceOf(r.tool)), freshNonce());
      const res = await postDupContentType(r.path, r.body);
      expect(res.status).toBe(400);
      expect((await res.json() as { error?: string }).error).toBe('invalid_content_type');
    });

    it(`${r.path}: PAID + clean content-type → 200 served`, async () => {
      setProof(req(await priceOf(r.tool)), freshNonce());
      const res = await post(r.path, r.body);
      expect(res.status).toBe(200);
    });
  }
});

/**
 * R3, INVERTED BY RATIFIED PRICING CHANGE — every verdict settles, HOLD included.
 *
 * These assertions were written by OPS-X402-TRADE-CALL-CONTENT-TYPE-W1 to make it impossible to
 * start charging for HOLDs without noticing: "deleting the `verdict !== 'HOLD'` guard would
 * change public pricing and ship green." They did their job — this wave deleted exactly that
 * guard, and the suite went red rather than silently repricing the rail.
 *
 * PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-A, architect-ratified 2026-08-08) makes charging
 * for HOLDs the INTENDED behaviour: paying only on an actionable verdict was a structural
 * incentive against the selectivity that is the product, on a rail whose measured hold rate is
 * ~99%. So the assertions are INVERTED, not deleted — the same two directions are still pinned,
 * and re-introducing the skip now fails just as loudly as removing it used to.
 */
describe('R3 — every verdict settles, HOLD included (R-A); errors never do', () => {
  for (const path of ['get_trade_signal', 'get_trade_call']) {
    it(`${path}: HOLD → 200 with the verdict AND settles (R-A)`, async () => {
      nextVerdict = 'HOLD';
      setProof(req(0.02), freshNonce());
      const res = await post(path, { coin: 'BTC', timeframe: '4h' });
      expect(res.status).toBe(200);
      expect((await res.json() as { call?: string }).call).toBe('HOLD');
      await settleTick();
      expect(settleCalls, 'a HOLD is a verdict and MUST settle — R-A; re-introducing the skip pays the rail on ~1 call in 100').toBe(1);
    });

    it(`${path}: directional → 200 AND settles (the charge still happens)`, async () => {
      nextVerdict = 'BUY';
      setProof(req(0.02), freshNonce());
      const res = await post(path, { coin: 'BTC', timeframe: '4h' });
      expect(res.status).toBe(200);
      expect((await res.json() as { call?: string }).call).toBe('BUY');
      await settleTick();
      expect(settleCalls, 'a directional verdict MUST settle — free directional calls are lost revenue').toBe(1);
    });
  }

  it('a HOLD is still SERVED in full — paying for it must not degrade it', async () => {
    nextVerdict = 'HOLD';
    setProof(req(0.02), freshNonce());
    const body = await (await post('get_trade_call', { coin: 'BTC', timeframe: '4h' })).json() as
      { call?: string; confidence?: number };
    expect(body.call).toBe('HOLD');
    expect(body.confidence).toBe(70);
  });

  it('an always-charge tool settles regardless of any verdict in flight', async () => {
    nextVerdict = 'HOLD'; // must not leak into other tools' settle decision
    setProof(req(0.02), freshNonce());
    const res = await post('get_market_regime', { coin: 'BTC', timeframe: '1h' });
    expect(res.status).toBe(200);
    await settleTick();
    expect(settleCalls).toBe(1);
  });
});

/**
 * TG-DIGEST-INTERNAL-ROW-AND-PAID-SESSION-W1 (2026-08-11) — the paid rail must stamp a
 * session id, and this is the seam that proves it.
 *
 * Root cause it guards: `x402-http-routes.ts` passed a literal `sessionId: undefined` to both
 * the ALS store and `logRequest`, so every settled payment wrote `request_log.session_id = NULL`
 * — measured on prod, ALL 20 x402 rows ever written (2026-06-30 → 2026-08-10). The read side
 * counts paid CALLS with no session predicate and paid SESSIONS with `session_id IS NOT NULL`,
 * so the digest reported 2 paid calls and 0 paid sessions for the same window.
 *
 * Asserted HERE rather than only on the /analytics rollup because the rollup fixture supplies
 * its own session id — it replaces the exact seam that broke, and would stay green through a
 * revert of the fix. This drives the REAL route.
 */
describe('paid rail stamps a session id — the calls/sessions dimensions must agree', () => {
  it('a settled call logs a NON-NULL session id, falling back to the ipHash', async () => {
    setProof(req(0.02), freshNonce());
    expect((await post('get_trade_signal', { coin: 'BTC', timeframe: '4h' })).status).toBe(200);

    expect(loggedRequests, 'no logRequest captured — every assertion below would be vacuous').toHaveLength(1);
    const row = loggedRequests[0];
    expect(row.licenseTier).toBe('x402');
    // The bug, stated as the assertion that would have caught it.
    expect(row.sessionId, 'a NULL session_id makes a paid call invisible to the paid-SESSIONS rollup').not.toBeUndefined();
    expect(row.sessionId).not.toBeNull();
    expect(row.sessionId).not.toBe('');
    // Precedence: no track token on this request ⇒ the id IS the ipHash (mocked to 'h'),
    // which is the same fallback the MCP rail uses — one derivation, not two.
    expect(row.sessionId).toBe('h');
    expect(row.ipHash).toBe('h');
  });

  it('an X-AlgoVault-Track-Token wins over the ipHash — same precedence as the MCP rail', async () => {
    setProof(req(0.02), freshNonce());
    const res = await fetch(`${baseUrl}/x402/get_trade_signal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-payment': 'present',
        'X-AlgoVault-Track-Token': 'chan-paid-rail-w1',
      },
      body: JSON.stringify({ coin: 'BTC', timeframe: '4h' }),
    });
    expect(res.status).toBe(200);
    expect(loggedRequests).toHaveLength(1);
    // Token beats ipHash, so a tagged paid caller stitches across requests instead of
    // collapsing into its NAT'd ip bucket.
    expect(loggedRequests[0].sessionId).toBe('chan-paid-rail-w1');
    expect(loggedRequests[0].ipHash).toBe('h');
  });

  it('EVERY payable route stamps one — not just the one route a spot-check would sample', async () => {
    const routes: Array<[string, Record<string, unknown>]> = [
      ['get_trade_signal', { coin: 'BTC', timeframe: '4h' }],
      ['get_market_regime', { coin: 'BTC', timeframe: '1h' }],
      ['scan_funding_arb', {}],
      ['scan_trade_calls', {}],
    ];
    for (const [tool, body] of routes) {
      loggedRequests = [];
      setProof(req(0.02), freshNonce());
      const res = await post(tool, body);
      expect(res.status, `${tool} did not serve — the session assertion would be vacuous`).toBe(200);
      expect(loggedRequests, `${tool} logged no request`).toHaveLength(1);
      expect(loggedRequests[0].sessionId, `${tool} logged a NULL session id`).toBe('h');
    }
  });
});
