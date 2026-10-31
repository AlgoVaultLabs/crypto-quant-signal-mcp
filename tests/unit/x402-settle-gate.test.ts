/**
 * DECISION-CALL-V1-W3 CH1 (AC1.1) — for every priced tool, on both rails, only a SERVED call settles.
 *
 * HOLD is served (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 R-A stands). A claimed payment whose call was
 * refused, threw, or never reached a tool is UNSERVED: its claim moves CLAIMED_PENDING → CLAIMED_UNSERVED
 * and the authorization is never submitted, so it neither charges the buyer nor reads as money owed.
 *
 *   1. the decision — `x402SettlementAction`, pure, total over the stamp (absent included);
 *   2. the stamp — `callTool` records how the call ended on the AMBIENT request context, which is the
 *      one the `/mcp` POST layer reads after the transport resolves;
 *   3. the store — `recordUnservedClaim` moves a claim out of CLAIMED_PENDING only, on real SQLite;
 *   4. the `/mcp` source order — the decision sits AFTER the transport has run, and nothing settles
 *      outside it;
 *   5. the HTTP rail end to end (the x402-paid-path harness): served → 1 settle, 0 marks; a paid call
 *      that throws or refuses → its status, 0 settles, exactly 1 unserved mark.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ORIG_ENV = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  DATABASE_URL: process.env.DATABASE_URL,
  X402_FACILITATOR: process.env.X402_FACILITATOR,
  BAZAAR_DISCOVERABLE: process.env.BAZAAR_DISCOVERABLE,
  X402_WALLET_ADDRESS: process.env.X402_WALLET_ADDRESS,
  X402_NETWORK: process.env.X402_NETWORK,
  CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
  CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
};
afterAll(() => {
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
});

/** A fresh SQLite store under a temp HOME (no DATABASE_URL), as the idempotency-store suite does. */
async function freshSqlite(prefix: string): Promise<string> {
  delete process.env.DATABASE_URL;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const { closeDb } = await import('../../src/lib/performance-db.js');
  closeDb();
  vi.resetModules();
  return home;
}
async function dropSqlite(home: string): Promise<void> {
  const { closeDb } = await import('../../src/lib/performance-db.js');
  closeDb();
  vi.resetModules();
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
}

const INTERNAL = { tier: 'internal', key: null, outcome: 'RESOLVED' } as const;

// ── 1 ─────────────────────────────────────────────────────────────────────────────────────────

describe('x402SettlementAction — the one settle decision', () => {
  it("settles 'ok' and nothing else — a missing stamp is unserved", async () => {
    const { x402SettlementAction } = await import('../../src/lib/x402.js');
    expect(x402SettlementAction('ok')).toBe('settle');
    expect(x402SettlementAction('refused')).toBe('unserved');
    expect(x402SettlementAction('threw')).toBe('unserved');
    expect(x402SettlementAction(undefined)).toBe('unserved');
  });
});

// ── 2 ─────────────────────────────────────────────────────────────────────────────────────────

describe('callTool stamps how the call ended on the ambient request context', () => {
  const MOCKED = ['../../src/tools/get-market-regime.js', '../../src/lib/analytics.js'];
  let regime: () => unknown = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });
  let home = '';

  beforeEach(async () => {
    home = await freshSqlite('cqs-settle-stamp-');
    regime = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });
    vi.doMock('../../src/tools/get-market-regime.js', async (orig) => ({
      ...(await orig<typeof import('../../src/tools/get-market-regime.js')>()),
      getMarketRegime: async () => regime(),
    }));
    vi.doMock('../../src/lib/analytics.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/analytics.js')>()),
      logRequest: () => {},
    }));
  });
  afterEach(async () => {
    for (const m of MOCKED) vi.doUnmock(m);
    await dropSqlite(home);
  });

  /** One `callTool` inside a request context (the `/mcp` POST layer's shape: no ctx handed to callTool). */
  async function stampedOutcome(timeframe: string): Promise<string | undefined> {
    const { requestContext, getRequestToolOutcome } = await import('../../src/lib/license.js');
    const { callTool } = await import('../../src/lib/tool-call-pipeline.js');
    return requestContext.run({ license: INTERNAL } as never, async () => {
      await callTool({
        tool: 'get_market_regime',
        input: { coin: 'BTC', timeframe, exchange: 'BINANCE' } as never,
        license: INTERNAL as never,
        channel: 'mcp',
      });
      return getRequestToolOutcome();
    });
  }

  it("'ok' when the tool served (a HOLD-free regime result is served)", async () => {
    regime = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });
    expect(await stampedOutcome('4h')).toBe('ok');
  });

  it("'refused' on an in-band refusal (a timeframe outside the tool's enum, refused before dispatch)", async () => {
    expect(await stampedOutcome('7h')).toBe('refused');
  });

  it("'threw' when the tool threw", async () => {
    regime = () => { throw new Error('upstream down'); };
    expect(await stampedOutcome('4h')).toBe('threw');
  });

  it('outside a request context the stamp is a no-op — no throw, nothing recorded', async () => {
    const { getRequestToolOutcome } = await import('../../src/lib/license.js');
    const { callTool } = await import('../../src/lib/tool-call-pipeline.js');
    const out = await callTool({
      tool: 'get_market_regime',
      input: { coin: 'BTC', timeframe: '4h', exchange: 'BINANCE' } as never,
      license: INTERNAL as never,
      channel: 'mcp',
    });
    expect(out.ok).toBe(true);
    expect(getRequestToolOutcome()).toBeUndefined();
  });
});

// ── 3 ─────────────────────────────────────────────────────────────────────────────────────────

describe('recordUnservedClaim — moves a claim out of CLAIMED_PENDING only (real SQLite)', () => {
  type Store = typeof import('../../src/lib/x402-idempotency-store.js');
  let store: Store;
  let home = '';
  const PAYER = '0x1111111111111111111111111111111111111111';
  let seq = 0;
  const nonce = () => `0x${(++seq).toString(16).padStart(64, 'a')}`;

  beforeEach(async () => {
    home = await freshSqlite('cqs-settle-store-');
    store = await import('../../src/lib/x402-idempotency-store.js');
  });
  afterEach(async () => { await dropSqlite(home); });

  async function stateOf(n: string): Promise<string | undefined> {
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const rows = await dbQuery<{ settlement_state: string }>(
      'SELECT settlement_state FROM processed_x402_payments WHERE nonce = ?', [n]);
    return rows[0]?.settlement_state;
  }
  async function claim(n: string): Promise<void> {
    expect(await store.tryClaimPayment(n, 'get_market_regime', '20000', PAYER, store.RAIL_BASE_USDC)).toBe('CLAIMED');
    expect(await stateOf(n)).toBe('CLAIMED_PENDING');
  }

  it('a pending claim is marked unserved exactly once; a repeat mark is NOT_FOUND', async () => {
    const n = nonce();
    await claim(n);
    expect(await store.recordUnservedClaim(n, PAYER)).toBe('MARKED');
    expect(await stateOf(n)).toBe('CLAIMED_UNSERVED');
    expect(await store.recordUnservedClaim(n, PAYER)).toBe('NOT_FOUND');
    expect(await stateOf(n)).toBe('CLAIMED_UNSERVED');
  });

  it('never rewrites a row the rail already settled', async () => {
    const n = nonce();
    await claim(n);
    expect(await store.recordSettlementOutcome(n, PAYER, 'SETTLED', '0xtx')).toBe('PROMOTED');
    expect(await store.recordUnservedClaim(n, PAYER)).toBe('NOT_FOUND');
    expect(await stateOf(n)).toBe('SETTLED');
  });

  it("never rewrites a row the reconciler already judged (CLAIMED_EXPIRED)", async () => {
    const n = nonce();
    await claim(n);
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    await dbQuery("UPDATE processed_x402_payments SET settlement_state = 'CLAIMED_EXPIRED' WHERE nonce = ? RETURNING nonce", [n]);
    expect(await store.recordUnservedClaim(n, PAYER)).toBe('NOT_FOUND');
    expect(await stateOf(n)).toBe('CLAIMED_EXPIRED');
  });

  it('promotion OUT of CLAIMED_UNSERVED still works — the rail’s receipt wins', async () => {
    const n = nonce();
    await claim(n);
    expect(await store.recordUnservedClaim(n, PAYER)).toBe('MARKED');
    expect(await store.recordSettlementOutcome(n, PAYER, 'SETTLED', '0xtx')).toBe('PROMOTED');
    expect(await stateOf(n)).toBe('SETTLED');
  });

  it('a different payer or an empty nonce marks nothing', async () => {
    const n = nonce();
    await claim(n);
    expect(await store.recordUnservedClaim(n, '0x2222222222222222222222222222222222222222')).toBe('NOT_FOUND');
    expect(await store.recordUnservedClaim('', PAYER)).toBe('NOT_FOUND');
    expect(await stateOf(n)).toBe('CLAIMED_PENDING');
  });
});

// ── 4 ─────────────────────────────────────────────────────────────────────────────────────────

describe('/mcp — the settle decision comes after the transport, and nothing settles outside it', () => {
  const INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');
  const start = INDEX.indexOf("app.all('/mcp',");
  const end = INDEX.indexOf('mountX402HttpRoutes(app)', start);
  const handler = INDEX.slice(start, end);

  it('the /mcp handler is found (the pin reads a real body, not an empty slice)', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain('await handleMcpStateless(req, res, createServer);');
  });

  it('x402SettlementAction runs after handleMcpStateless( and after the last transport.handleRequest(', () => {
    const decision = handler.indexOf('x402SettlementAction(');
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(handler.indexOf('handleMcpStateless('));
    expect(decision).toBeGreaterThan(handler.lastIndexOf('transport.handleRequest('));
    expect(handler).toMatch(/if \(x402SettlementAction\(outcome\) === 'settle'\) \{\s*settleX402Async\(pendingSettlement\);/);
  });

  it('no settleX402Async(pendingSettlement) outside the decision — in the handler or anywhere in index.ts', () => {
    expect(INDEX.match(/settleX402Async\(pendingSettlement\)/g)?.length).toBe(1);
    expect(handler.match(/markX402Unserved\(pendingSettlement\)/g)?.length).toBe(1);
  });
});

// ── 5 ─────────────────────────────────────────────────────────────────────────────────────────

describe('HTTP rail — served settles once; a paid call that throws or refuses is marked unserved once', () => {
  const WALLET = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const atomic = (usd: number) => Math.round(usd * 1_000_000).toString();
  const req = (usd: number) => ({
    scheme: 'exact', network: 'eip155:8453', amount: atomic(usd), asset: USDC,
    payTo: WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
  });
  const MOCKED = [
    '../../src/lib/x402-facilitator.js', '@x402/core/server', '@x402/core/http', '@x402/extensions/bazaar',
    '../../src/lib/license.js', '../../src/tools/get-market-regime.js', '../../src/lib/analytics.js',
    '../../src/lib/x402-idempotency-store.js',
  ];

  let server: http.Server | undefined;
  let baseUrl = '';
  let home = '';
  let settleCalls = 0;
  let unservedMarks = 0;
  let nextSettlement: { requirements: unknown; paymentPayload: unknown } | null = null;
  let regime: () => unknown = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });
  let seq = 0;

  function setProof(requirement: Record<string, unknown>): string {
    const nonce = `0x${(++seq).toString(16).padStart(64, 'b')}`;
    nextSettlement = {
      requirements: requirement,
      paymentPayload: {
        x402Version: 2, accepted: requirement,
        payload: { signature: '0xsig', authorization: { from: '0xPAYER', to: WALLET, value: requirement.amount, validAfter: '0', validBefore: '9999999999', nonce } },
      },
    };
    return nonce;
  }

  beforeEach(async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    process.env.X402_NETWORK = 'base-mainnet';
    process.env.X402_FACILITATOR = 'cdp';
    process.env.BAZAAR_DISCOVERABLE = 'true';
    process.env.CDP_API_KEY_ID = 'test-cdp-key-id';
    process.env.CDP_API_KEY_SECRET = 'test-cdp-key-secret';
    home = await freshSqlite('cqs-settle-http-');
    settleCalls = 0;
    unservedMarks = 0;
    nextSettlement = null;
    regime = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });

    vi.doMock('../../src/lib/x402-facilitator.js', () => ({
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
        settlePayment() { settleCalls++; return Promise.resolve({ success: true }); }
      },
    }));
    vi.doMock('@x402/core/http', () => ({ encodePaymentRequiredHeader: () => 'stub-header' }));
    vi.doMock('@x402/extensions/bazaar', () => ({
      bazaarResourceServerExtension: {},
      declareDiscoveryExtension: () => ({ bazaar: { info: { input: { type: 'http' } } } }),
    }));
    vi.doMock('../../src/lib/license.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/license.js')>()),
      resolveLicense: async () =>
        nextSettlement
          ? { license: { tier: 'x402', key: null }, pendingSettlement: nextSettlement }
          : { license: { tier: 'free', key: null } },
    }));
    vi.doMock('../../src/tools/get-market-regime.js', async (orig) => ({
      ...(await orig<typeof import('../../src/tools/get-market-regime.js')>()),
      getMarketRegime: async () => regime(),
    }));
    vi.doMock('../../src/lib/analytics.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/analytics.js')>()),
      hashIp: () => 'h',
      logRequest: () => {},
    }));
    // The REAL store, with the unserved mark COUNTED rather than replaced: "exactly once" is asserted
    // on the call, and the row state is asserted on the database the real function wrote.
    vi.doMock('../../src/lib/x402-idempotency-store.js', async (orig) => {
      const m = await orig<typeof import('../../src/lib/x402-idempotency-store.js')>();
      return {
        ...m,
        recordUnservedClaim: async (...a: Parameters<typeof m.recordUnservedClaim>) => { unservedMarks++; return m.recordUnservedClaim(...a); },
      };
    });

    const express = (await import('express')).default;
    const { initX402 } = await import('../../src/lib/x402.js');
    await initX402();
    const { mountX402HttpRoutes } = await import('../../src/lib/x402-http-routes.js');
    const app = express();
    mountX402HttpRoutes(app);
    server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    for (const m of MOCKED) vi.doUnmock(m);
    await dropSqlite(home);
  });

  /** Settle and mark are fire-and-forget AFTER the response, so give the server a tick. */
  const tick = () => new Promise((r) => setTimeout(r, 80));
  const post = (tool: string, body: Record<string, unknown>) => fetch(`${baseUrl}/x402/${tool}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-payment': 'present' }, body: JSON.stringify(body),
  });
  async function stateOf(n: string): Promise<string | undefined> {
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    return (await dbQuery<{ settlement_state: string }>('SELECT settlement_state FROM processed_x402_payments WHERE nonce = ?', [n]))[0]?.settlement_state;
  }

  it('a served paid call settles exactly once and is never marked unserved', async () => {
    const n = setProof(req(0.02));
    const res = await post('get_market_regime', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(200);
    await tick();
    expect(settleCalls).toBe(1);
    expect(unservedMarks).toBe(0);
    expect(await stateOf(n)).toBe('SETTLED');
  });

  it('a paid call whose tool THREW → 500, never settles, marked unserved exactly once', async () => {
    regime = () => { throw new Error('upstream down'); };
    const n = setProof(req(0.02));
    const res = await post('get_market_regime', { coin: 'BTC', timeframe: '4h' });
    expect(res.status).toBe(500);
    await tick();
    expect(settleCalls).toBe(0);
    expect(unservedMarks).toBe(1);
    expect(await stateOf(n)).toBe('CLAIMED_UNSERVED');
  });
});
