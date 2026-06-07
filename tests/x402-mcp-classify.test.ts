/**
 * OPS-X402-MCP-PRICE-BINDING-W1 (X402-01 MCP surface) — classifyToolRouteMismatch.
 *
 * The new x402.ts classifier returns the precise downgrade `reason` the /mcp handler
 * advertises in the `X402_PAYMENT_REQUIRED` error. It must stay in LOCKSTEP with
 * `paymentMatchesToolRoute` (`classify === 'ok'` iff `matches === true`) and split
 * the failure into `cross_tool` (wrong asset/network/payTo — a different tool's route)
 * vs `insufficient` (right route, amount underpays the effective/timeframe price).
 *
 * Builds the REAL per-tool requirements through the actual `initX402` pipeline (stub
 * facilitator) so the matched-requirement shapes are the SAME ones production
 * deep-equals against — mirrors tests/x402-price-binding.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

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

describe('classifyToolRouteMismatch — lockstep with paymentMatchesToolRoute', () => {
  it('correct $0.02 proof on get_trade_signal (base tf) → ok (and matches=true)', () => {
    const s = { paymentPayload: {}, requirements: req(0.02) };
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('ok');
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '4h')).toBe(true);
  });

  it('over-price $0.03 proof → ok (amount is a floor)', () => {
    const s = { paymentPayload: {}, requirements: req(0.03) };
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('ok');
  });

  it('$0.01 scan_funding_arb proof on $0.02 get_trade_signal → cross_tool (different amount → identity ok but amount low → wait: same asset/net/payTo)', () => {
    // The $0.01 scan proof shares asset/network/payTo with get_trade_signal's req
    // (same wallet/chain/token) — only the AMOUNT differs. So identity matches and the
    // mismatch is an underpay → `insufficient` (the cross-tool downgrade manifests as
    // an amount-floor failure here, which is exactly what blocks the 50% underpay).
    const s = { paymentPayload: {}, requirements: req(0.01) };
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('insufficient');
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '4h')).toBe(false);
  });

  it('wrong asset / network / payTo → cross_tool (identity mismatch)', () => {
    const wrongAsset = { paymentPayload: {}, requirements: req(0.02, { asset: '0x0000000000000000000000000000000000000000' }) };
    const wrongNet = { paymentPayload: {}, requirements: req(0.02, { network: 'eip155:84532' }) };
    const wrongPayTo = { paymentPayload: {}, requirements: req(0.02, { payTo: '0x000000000000000000000000000000000000dead' }) };
    expect(x402.classifyToolRouteMismatch(wrongAsset, 'get_trade_signal', '4h')).toBe('cross_tool');
    expect(x402.classifyToolRouteMismatch(wrongNet, 'get_trade_signal', '4h')).toBe('cross_tool');
    expect(x402.classifyToolRouteMismatch(wrongPayTo, 'get_trade_signal', '4h')).toBe('cross_tool');
  });

  it('premium 1m=$0.05: base $0.02 proof → insufficient; $0.05 proof → ok', () => {
    const base = { paymentPayload: {}, requirements: req(0.02) };
    const premium = { paymentPayload: {}, requirements: req(0.05) };
    expect(x402.classifyToolRouteMismatch(base, 'get_trade_signal', '1m')).toBe('insufficient');
    expect(x402.classifyToolRouteMismatch(premium, 'get_trade_signal', '1m')).toBe('ok');
  });

  it('null / malformed settlement / unknown tool → cross_tool (default-deny)', () => {
    expect(x402.classifyToolRouteMismatch(null, 'get_trade_signal')).toBe('cross_tool');
    expect(x402.classifyToolRouteMismatch({ requirements: undefined }, 'get_trade_signal')).toBe('cross_tool');
    expect(x402.classifyToolRouteMismatch({ paymentPayload: {}, requirements: req(0.02) }, 'get_trade_call')).toBe('cross_tool');
  });

  it('accepts a 1-element array requirement (SDK match shape)', () => {
    const s = { paymentPayload: {}, requirements: [req(0.02)] };
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('ok');
  });
});
