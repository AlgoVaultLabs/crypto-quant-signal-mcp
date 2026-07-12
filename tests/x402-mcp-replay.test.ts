/**
 * OPS-X402-MCP-PRICE-BINDING-W1 (X402-02 MCP surface) — idempotency claim on the
 * MCP payment path. Closes the pre-settle replay window on `/mcp` `tools/call`:
 * `verifyX402Payment` is stateless + `settleX402Async` is fire-and-forget, so the
 * same proof replayed across N pre-settle calls would grant `tier:'x402'` N times
 * for ONE on-chain charge. The fix claims the ERC-3009 nonce BEFORE the grant; a
 * replayed (already-claimed) nonce → downgrade (no re-grant, no re-settle). Claim
 * happens AFTER the binding check passes and BEFORE the grant.
 *
 * Drives the tool-bound `resolveLicense(headers, {tool, timeframe})` with `./x402.js`
 * + `./x402-idempotency-store.js` mocked so `tryClaimPayment`'s true/false is the
 * single lever. FAILS against the pre-fix code (which never claimed a nonce on the
 * MCP path and always granted x402 on any valid proof).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockState = {
  bindOk: true,
  claimResults: [] as boolean[], // FIFO: claim #1, #2, ...
  claimCalls: 0,
  nonceSeen: undefined as string | undefined,
};

vi.mock('../src/lib/x402.js', () => ({
  isX402Configured: () => true,
  verifyX402Payment: async () => ({
    valid: true,
    payer: '0xPAYER',
    _settlement: {
      paymentPayload: { payload: { authorization: { nonce: '0xNONCE_AAA' } } },
      requirements: { amount: '20000', asset: 'A', network: 'N', payTo: 'P' },
    },
  }),
  paymentMatchesToolRoute: () => mockState.bindOk,
  classifyToolRouteMismatch: () => 'insufficient',
}));

vi.mock('../src/lib/x402-idempotency-store.js', () => ({
  extractPaymentNonce: (payload: unknown) => {
    const n = (payload as { payload?: { authorization?: { nonce?: string } } })?.payload?.authorization?.nonce;
    mockState.nonceSeen = n;
    return n;
  },
  // OPS-X402-WALLET-ATTRIBUTION-W1: license.ts now also extracts the payer wallet (additive).
  extractPayerWallet: (payload: unknown) =>
    (payload as { payload?: { authorization?: { from?: string } } })?.payload?.authorization?.from,
  tryClaimPayment: async () => {
    const r = mockState.claimResults[mockState.claimCalls] ?? false;
    mockState.claimCalls += 1;
    return r;
  },
}));

vi.mock('../src/lib/stripe.js', () => ({ validateApiKey: async () => ({ valid: false }) }));

let license: typeof import('../src/lib/license.js');

beforeEach(async () => {
  mockState.bindOk = true;
  mockState.claimResults = [];
  mockState.claimCalls = 0;
  mockState.nonceSeen = undefined;
  vi.resetModules();
  license = await import('../src/lib/license.js');
});

afterEach(() => vi.clearAllMocks());

const HEADERS = { 'x-payment': 'present' };
const OPTS = { tool: 'get_trade_signal', timeframe: '4h' };

describe('claim-before-grant ordering', () => {
  it('first use: binding passes then nonce is claimed → grant x402 + pendingSettlement', async () => {
    mockState.claimResults = [true];
    const res = await license.resolveLicense(HEADERS, OPTS);
    expect(res.license.tier).toBe('x402');
    expect(res.pendingSettlement).toBeDefined();
    expect(res.x402Downgrade).toBeUndefined();
    expect(mockState.claimCalls).toBe(1);
    expect(mockState.nonceSeen).toBe('0xNONCE_AAA'); // extracted from the verified payload
  });

  it('claim is NOT attempted when the binding floor fails (no wasted claim)', async () => {
    mockState.bindOk = false; // cross-tool/underpay → reject before claim
    const res = await license.resolveLicense(HEADERS, OPTS);
    expect(mockState.claimCalls).toBe(0);
    expect(res.x402Downgrade).toBeDefined();
    expect(res.pendingSettlement).toBeUndefined();
  });
});

describe('replayed nonce → downgrade (no re-grant, no re-settle)', () => {
  it('a seen nonce (tryClaimPayment=false) → free tier, NO pendingSettlement, reason replayed', async () => {
    mockState.claimResults = [false]; // nonce already claimed
    const res = await license.resolveLicense(HEADERS, OPTS);
    expect(res.license.tier).toBe('free');
    expect(res.pendingSettlement).toBeUndefined(); // ← settle no-ops → no double-charge
    expect(res.x402Downgrade?.reason).toBe('replayed');
    expect(mockState.claimCalls).toBe(1);
  });

  it('two identical proofs in sequence: first grants (claim true), replay downgrades (claim false)', async () => {
    mockState.claimResults = [true, false];
    const first = await license.resolveLicense(HEADERS, OPTS);
    expect(first.license.tier).toBe('x402');
    expect(first.pendingSettlement).toBeDefined();

    const replay = await license.resolveLicense(HEADERS, OPTS);
    expect(replay.license.tier).toBe('free');
    expect(replay.pendingSettlement).toBeUndefined();
    expect(replay.x402Downgrade?.reason).toBe('replayed');
  });
});

describe('DB-error / empty-nonce → default-deny the upgrade (fail-safe)', () => {
  it('tryClaimPayment returns false on DB error → downgrade (fall to free, no settle)', async () => {
    // tryClaimPayment is fail-safe internally (returns false on DB throw / empty
    // nonce); from resolveLicense's view that is indistinguishable from a replay →
    // downgrade. Reason `replayed` is the safe label (no settle either way).
    mockState.claimResults = [false];
    const res = await license.resolveLicense(HEADERS, OPTS);
    expect(res.license.tier).toBe('free');
    expect(res.pendingSettlement).toBeUndefined();
    expect(res.x402Downgrade?.reason).toBe('replayed');
  });
});
