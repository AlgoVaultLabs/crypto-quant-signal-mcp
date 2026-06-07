/**
 * OPS-X402-MCP-PRICE-BINDING-W1 (X402-01 MCP surface) — tool-bound resolveLicense.
 *
 * The MCP `/mcp` `tools/call` path serves priced tools to ALL tiers gated only by
 * quota; the x402 payment is a per-call SETTLE that grants the higher `x402` tier.
 * The bug: `resolveLicense(headers)` verified the proof FLATTENED (no tool), so a
 * $0.01 scan_funding_arb proof granted `tier:'x402'` for a $0.02 get_trade_signal
 * call (50% underpay), and one proof replayed across N pre-settle calls.
 *
 * These tests drive the tool-bound `resolveLicense(headers, {tool, timeframe})`
 * directly with `./x402.js` + `./x402-idempotency-store.js` mocked, so they assert
 * the GRANT-vs-DOWNGRADE decision deterministically (no facilitator, no DB):
 *   - cross-tool / premium-timeframe underpay → downgrade (no x402 grant, no settle)
 *   - correct exact / over-price proof → grant x402 + carry the claimed settlement
 *   - the omitted-tool path (HTTP route / webhook authz) keeps the prior flattened
 *     behavior (no claim, no downgrade field)
 *   - the downgrade carries the right `reason` (cross_tool vs insufficient)
 *
 * They FAIL against the pre-fix flattened code (which always granted x402 on any
 * valid proof and never produced an `x402Downgrade`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Controllable mocks for the x402 primitives + idempotency store ──
// resolveLicense calls: isX402Configured(), verifyX402Payment(headers, tool?),
// paymentMatchesToolRoute(settlement, tool, tf), classifyToolRouteMismatch(...),
// and (idempotency) extractPaymentNonce(payload) + tryClaimPayment(nonce, ...).

const mockState = {
  verifyValid: true,
  /** what paymentMatchesToolRoute returns */
  bindOk: true,
  /** what classifyToolRouteMismatch returns when bind fails */
  classify: 'insufficient' as 'ok' | 'cross_tool' | 'insufficient',
  /** what tryClaimPayment returns (true = first use, false = replay/db-error) */
  claimOk: true,
  /** captured args for assertions */
  lastVerifyTool: undefined as string | undefined,
  claimCalls: 0,
};

vi.mock('../src/lib/x402.js', () => ({
  isX402Configured: () => true,
  verifyX402Payment: async (_headers: unknown, tool?: string) => {
    mockState.lastVerifyTool = tool;
    return mockState.verifyValid
      ? { valid: true, payer: '0xPAYER', _settlement: { paymentPayload: { payload: { authorization: { nonce: '0xNONCE' } } }, requirements: { amount: '20000', asset: 'A', network: 'N', payTo: 'P' } } }
      : { valid: false };
  },
  paymentMatchesToolRoute: () => mockState.bindOk,
  classifyToolRouteMismatch: () => mockState.classify,
}));

vi.mock('../src/lib/x402-idempotency-store.js', () => ({
  extractPaymentNonce: (payload: unknown) =>
    (payload as { payload?: { authorization?: { nonce?: string } } })?.payload?.authorization?.nonce,
  tryClaimPayment: async () => {
    mockState.claimCalls += 1;
    return mockState.claimOk;
  },
}));

// Stripe must not be hit on the downgrade-to-free path (no auth header → no call),
// but mock it defensively so an accidental call can't reach the network.
vi.mock('../src/lib/stripe.js', () => ({
  validateApiKey: async () => ({ valid: false }),
}));

let license: typeof import('../src/lib/license.js');

beforeEach(async () => {
  mockState.verifyValid = true;
  mockState.bindOk = true;
  mockState.classify = 'insufficient';
  mockState.claimOk = true;
  mockState.lastVerifyTool = undefined;
  mockState.claimCalls = 0;
  vi.resetModules();
  license = await import('../src/lib/license.js');
});

afterEach(() => {
  vi.clearAllMocks();
});

const HEADERS = { 'x-payment': 'present' };

describe('resolveLicense({tool}) — per-tool verify binding', () => {
  it('passes the called tool into verifyX402Payment (per-tool match, not flattened)', async () => {
    await license.resolveLicense(HEADERS, { tool: 'get_trade_signal', timeframe: '4h' });
    expect(mockState.lastVerifyTool).toBe('get_trade_signal');
  });

  it('omitted tool → flattened verify (no tool arg), no claim, no downgrade field', async () => {
    const res = await license.resolveLicense(HEADERS); // HTTP route / webhook authz path
    expect(mockState.lastVerifyTool).toBeUndefined();
    expect(mockState.claimCalls).toBe(0); // HTTP route does its OWN claim — no double-claim
    expect(res.x402Downgrade).toBeUndefined();
    expect(res.license.tier).toBe('x402'); // valid proof still grants x402 (unchanged)
    expect(res.pendingSettlement).toBeDefined();
  });
});

describe('correct proof → grant x402 + settle (unchanged)', () => {
  it('exact/over-price proof for the called tool → tier x402 + pendingSettlement, claimed once', async () => {
    mockState.bindOk = true;
    mockState.claimOk = true;
    const res = await license.resolveLicense(HEADERS, { tool: 'get_trade_signal', timeframe: '4h' });
    expect(res.license.tier).toBe('x402');
    expect(res.pendingSettlement).toBeDefined(); // settle will fire on this
    expect(res.x402Downgrade).toBeUndefined();
    expect(mockState.claimCalls).toBe(1); // claimed BEFORE grant
  });
});

describe('cross-tool / premium underpay → downgrade (no grant, no settle)', () => {
  it('binding floor fails (cross-tool) → free tier, NO pendingSettlement, reason cross_tool', async () => {
    mockState.bindOk = false;
    mockState.classify = 'cross_tool';
    const res = await license.resolveLicense(HEADERS, { tool: 'get_trade_signal', timeframe: '4h' });
    expect(res.license.tier).toBe('free'); // fell through (no auth header)
    expect(res.pendingSettlement).toBeUndefined(); // ← cleared → settleX402Async no-ops → NO charge
    expect(res.x402Downgrade?.reason).toBe('cross_tool');
    expect(mockState.claimCalls).toBe(0); // claim NOT taken when binding fails
  });

  it('premium-timeframe underpay (identity ok, amount low) → reason insufficient, no settle', async () => {
    mockState.bindOk = false;
    mockState.classify = 'insufficient';
    const res = await license.resolveLicense(HEADERS, { tool: 'get_trade_signal', timeframe: '1m' });
    expect(res.license.tier).toBe('free');
    expect(res.pendingSettlement).toBeUndefined();
    expect(res.x402Downgrade?.reason).toBe('insufficient');
    expect(mockState.claimCalls).toBe(0);
  });
});

describe('free tool / no-proof unaffected', () => {
  it('a non-priced tool name is never passed to the bound path by resolveLicense itself', async () => {
    // resolveLicense binds whatever tool it is GIVEN; the /mcp handler only passes a
    // tool for HTTP_TOOLS (priced). With no proof present, downgrade never triggers.
    mockState.verifyValid = false;
    const res = await license.resolveLicense(HEADERS, { tool: 'get_trade_signal', timeframe: '4h' });
    expect(res.license.tier).toBe('free'); // no valid proof → plain free, no downgrade field
    expect(res.x402Downgrade).toBeUndefined();
    expect(res.pendingSettlement).toBeUndefined();
  });

  it('no x-payment / invalid proof on the bound path → plain free (no settle, no downgrade)', async () => {
    mockState.verifyValid = false;
    const res = await license.resolveLicense({}, { tool: 'get_trade_signal' });
    expect(res.license.tier).toBe('free');
    expect(res.x402Downgrade).toBeUndefined();
    expect(mockState.claimCalls).toBe(0);
  });
});
