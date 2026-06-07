/**
 * OPS-X402-MCP-PRICE-BINDING-W1 (X402-01 MCP surface) — the /mcp handler's
 * downgrade→quota branch + the X402_PAYMENT_REQUIRED tool-result-error envelope.
 *
 * The handler, when `resolveLicense` returns an `x402Downgrade` for a priced
 * `tools/call`, peeks quota (read-only). Quota EXHAUSTED → short-circuit a precise
 * `X402_PAYMENT_REQUIRED` JSON-RPC tool-result-error built from the CALLED tool's
 * requirements (`buildX402PaymentRequiredResult`); quota REMAINING → serve free.
 *
 * This file proves the two load-bearing primitives that decision composes, using the
 * REAL functions (no re-implementation, so no drift with the handler):
 *   1. `buildX402PaymentRequiredResult(tool, reason, id)` — a VALID MCP tool-result-
 *      error: `{ jsonrpc:'2.0', id, result:{ content:[text], isError:true } }`, whose
 *      inner payload carries error/code=X402_PAYMENT_REQUIRED + reason +
 *      paymentRequirements = the called tool's real `accepts` (exact amount/asset/
 *      network/payTo) + suggested_action — and NO leaked tool data.
 *   2. `checkQuota(free)` flips `allowed` false⇄true at the quota boundary — the exact
 *      branch condition the handler reads (`!q.allowed` → envelope; else serve).
 *
 * Requirements are built via the real `initX402` pipeline (stub facilitator), so the
 * advertised `accepts` is byte-identical to production's. Mirrors the harness in
 * tests/x402-price-binding.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WALLET = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK = 'eip155:8453';
const atomic = (usd: number) => Math.round(usd * 1_000_000).toString();

function req(amountUsd: number) {
  return {
    scheme: 'exact', network: NETWORK, amount: atomic(amountUsd), asset: USDC,
    payTo: WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' },
  };
}

let x402: typeof import('../src/lib/x402.js');

beforeAll(async () => {
  process.env.X402_WALLET_ADDRESS = WALLET;
  process.env.X402_NETWORK = 'base-mainnet';
  process.env.X402_FACILITATOR = 'legacy';
  delete process.env.DATABASE_URL;
  vi.doMock('../src/lib/x402-facilitator.js', () => ({
    resolveFacilitatorFromEnv: () => ({ effectiveChoice: 'legacy', discoveryEnabled: false }),
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
  vi.doMock('@x402/extensions/bazaar', () => ({ bazaarResourceServerExtension: {} }));
  x402 = await import('../src/lib/x402.js');
  await x402.initX402();
});

afterAll(() => {
  vi.doUnmock('../src/lib/x402-facilitator.js');
  vi.doUnmock('@x402/core/server');
  vi.doUnmock('@x402/extensions/bazaar');
  vi.resetModules();
});

describe('buildX402PaymentRequiredResult — valid MCP tool-result-error envelope', () => {
  it('is a JSON-RPC result-error (jsonrpc 2.0, echoes id, result.isError=true, text content)', () => {
    const env = x402.buildX402PaymentRequiredResult('get_trade_signal', 'insufficient', 42);
    expect(env.jsonrpc).toBe('2.0');
    expect(env.id).toBe(42);
    expect(env.result.isError).toBe(true);
    expect(Array.isArray(env.result.content)).toBe(true);
    expect(env.result.content[0].type).toBe('text');
  });

  it('null id when the request had none (notification-shaped)', () => {
    const env = x402.buildX402PaymentRequiredResult('get_trade_signal', 'cross_tool', undefined);
    expect(env.id).toBe(null);
  });

  it('inner payload carries X402_PAYMENT_REQUIRED + reason + the called tool\'s requirements', () => {
    const env = x402.buildX402PaymentRequiredResult('get_trade_signal', 'cross_tool', 7);
    const payload = JSON.parse(env.result.content[0].text) as {
      error: string; code: string; reason: string;
      paymentRequirements: Array<{ amount?: string; asset?: string; network?: string; payTo?: string }>;
      suggested_action: string;
    };
    expect(payload.error).toBe('X402_PAYMENT_REQUIRED');
    expect(payload.code).toBe('X402_PAYMENT_REQUIRED');
    expect(payload.reason).toBe('cross_tool');
    // paymentRequirements == get_trade_signal's real pre-built requirement ($0.02).
    expect(payload.paymentRequirements[0].amount).toBe(atomic(0.02));
    expect(payload.paymentRequirements[0].asset).toBe(USDC);
    expect(payload.paymentRequirements[0].network).toBe(NETWORK);
    expect(payload.paymentRequirements[0].payTo).toBe(WALLET);
    expect(payload.suggested_action.length).toBeGreaterThan(0);
  });

  it('scan_funding_arb advertises its OWN $0.01 requirement (per-tool, not flattened)', () => {
    const env = x402.buildX402PaymentRequiredResult('scan_funding_arb', 'insufficient', 1);
    const payload = JSON.parse(env.result.content[0].text) as {
      paymentRequirements: Array<{ amount?: string }>;
    };
    expect(payload.paymentRequirements[0].amount).toBe(atomic(0.01));
  });

  it('reason drives suggested_action (replayed vs cross_tool vs insufficient distinct)', () => {
    const texts = (['replayed', 'cross_tool', 'insufficient'] as const).map((r) => {
      const p = JSON.parse(x402.buildX402PaymentRequiredResult('get_trade_signal', r, 1).result.content[0].text) as { suggested_action: string; reason: string };
      return p.suggested_action;
    });
    expect(new Set(texts).size).toBe(3); // all three distinct
  });

  it('leaks NO tool result data + no internal-only fields', () => {
    const env = x402.buildX402PaymentRequiredResult('get_trade_signal', 'insufficient', 1);
    const blob = JSON.stringify(env);
    // A served signal would surface call/confidence/indicators/regime — none here.
    const payload = JSON.parse(env.result.content[0].text) as Record<string, unknown>;
    expect(payload.call).toBeUndefined();
    expect(payload.confidence).toBeUndefined();
    expect(payload.indicators).toBeUndefined();
    expect(blob).not.toMatch(/outcome_return_pct|outcome_price/i);
  });
});

// checkQuota reads license.ts's in-memory tracker; isolate it per-test with a temp
// HOME (SQLite path) + fresh module so the boundary flip is deterministic.
describe('checkQuota(free) — the handler\'s downgrade branch condition', () => {
  let license: typeof import('../src/lib/license.js');
  let tempHome = '';
  const ORIG_HOME = process.env.HOME;
  const ORIG_UP = process.env.USERPROFILE;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-x402env-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    vi.resetModules();
    license = await import('../src/lib/license.js');
  });
  afterEach(async () => {
    const { closeDb } = await import('../src/lib/performance-db.js');
    closeDb();
    if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
    if (ORIG_UP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = ORIG_UP;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('fresh free tier → allowed true (quota remains → handler serves free, no X402_PAYMENT_REQUIRED)', () => {
    const q = license.checkQuota({ tier: 'free', key: null });
    expect(q.allowed).toBe(true);
  });

  it('after exhausting the 100-call free quota → allowed false (→ handler returns X402_PAYMENT_REQUIRED)', () => {
    const free = { tier: 'free' as const, key: null };
    const quota = license.getMonthlyQuota('free'); // 100
    // Drive the in-memory tracker to the cap (same meter checkQuota reads).
    for (let i = 0; i < quota; i++) license.trackCall(free);
    const q = license.checkQuota(free);
    expect(q.allowed).toBe(false);
    expect(q.total).toBe(quota);
  });
});
