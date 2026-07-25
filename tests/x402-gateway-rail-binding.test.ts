/**
 * CIRCLE-GATEWAY-FLIP-SMOKE-W1 — multi-rail payment-binding regression.
 *
 * When the Circle Gateway rail is flipped ON, every priced tool advertises TWO requirements:
 * the CDP rail (`eip155:8453`) AND the Gateway rail (`eip155:10`) — `reqs.push(...gatewayReqs)`
 * in initX402. But the per-route binding firewall `paymentMatchesToolRoute` (and its lockstep
 * mirror `classifyToolRouteMismatch`) bound the buyer's proof to the tool's identity by checking
 * ONLY `expected[0]` — the CDP rail — so every valid Gateway proof was 402'd as "cross-tool".
 * The first real mainnet Gateway pay hit this; it escaped tests because the testnet settle used a
 * LOCAL seller helper that runs verify→settle directly and never exercises this binding check.
 *
 * These build the REAL two-rail requirements through the actual initX402 pipeline (same mock shape
 * as circle-gateway-mainnet-guard.test.ts), then assert: a Gateway proof BINDS, a CDP proof still
 * binds, and the cross-tool / premium-underpay / wrong-identity protections still hold on BOTH
 * rails — i.e. the identity check widened to "any advertised rail" without weakening the price
 * floor that is the actual cross-tool defense.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const PAY_TO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59'; // CDP wallet
const GW_SELLER = '0x2222222222222222222222222222222222222222'; // Gateway seller
const CDP_NET = 'eip155:8453';
const GW_NET = 'eip155:10';
const OP_USDC = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
const OP_VERIFYING_CONTRACT = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
const atomic = (usd: number) => Math.round(usd * 1_000_000).toString();

vi.mock('../src/lib/x402-facilitator.js', () => ({
  CDP_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
  resolveFacilitatorFromEnv: () => ({
    effectiveChoice: 'legacy', discoveryEnabled: false, stubFellBack: false, facilitatorConfig: undefined,
  }),
  createFacilitatorClient: () => ({
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: CDP_NET, extra: { name: 'USD Coin', version: '2' } }],
        extensions: [], signers: {},
      };
    },
    async verify() { return { isValid: false }; },
    async settle() { return { success: false, transaction: '', network: CDP_NET }; },
  }),
}));

// Real GatewayEvmScheme (merges the EIP-712 domain); only the facilitator client is mocked so the
// Gateway rail builds on OP Mainnet without a network call — exactly circle-gateway-mainnet-guard's
// POSITIVE-CONTROL shape.
vi.mock('@circle-fin/x402-batching/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    BatchFacilitatorClient: class {
      constructor(public cfg: { url: string }) {}
      async getSupported() {
        return {
          kinds: [{
            x402Version: 2, scheme: 'exact', network: GW_NET,
            extra: {
              name: 'GatewayWalletBatched', version: '1', verifyingContract: OP_VERIFYING_CONTRACT,
              minValiditySeconds: 604800,
              assets: [{ symbol: 'USDC', address: OP_USDC, decimals: 6 }],
            },
          }],
          extensions: [], signers: {},
        };
      }
      async verify() { return { isValid: false }; }
      async settle() { return { success: false, transaction: '', network: GW_NET }; }
    },
  };
});

let x402: typeof import('../src/lib/x402.js');
let cdpReq: Record<string, unknown>;
let gwReq: Record<string, unknown>;

/** A production-shaped settlement: the SDK-matched requirement + the buyer's SIGNED authorization value. */
const settleWith = (matched: Record<string, unknown>, signedAtomic: string) => ({
  paymentPayload: { payload: { authorization: { value: signedAtomic, nonce: '0xNONCE' } } },
  requirements: matched,
});

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv('X402_WALLET_ADDRESS', PAY_TO);
  vi.stubEnv('X402_NETWORK', 'base-mainnet');
  vi.stubEnv('CIRCLE_GATEWAY_ENABLED', 'true');
  vi.stubEnv('CIRCLE_GATEWAY_FACILITATOR_URL', 'https://gateway-api.circle.com');
  vi.stubEnv('CIRCLE_GATEWAY_NETWORK', GW_NET);
  vi.stubEnv('CIRCLE_GATEWAY_SELLER_ADDRESS', GW_SELLER);
  delete process.env.DATABASE_URL;
  x402 = await import('../src/lib/x402.js');
  await x402.initX402();
  const reqs = x402._getToolRequirementsForTest().get('get_trade_signal') as Record<string, unknown>[];
  cdpReq = reqs[0];
  gwReq = reqs[1];
});

afterAll(() => vi.unstubAllEnvs());

describe('multi-rail payment binding — Gateway rail active', () => {
  it('SANITY: get_trade_signal advertises BOTH the CDP and Gateway rails at $0.02', () => {
    expect(cdpReq).toMatchObject({ network: CDP_NET, payTo: PAY_TO, amount: atomic(0.02) });
    expect(gwReq).toMatchObject({ network: GW_NET, payTo: GW_SELLER, amount: atomic(0.02) });
    expect((gwReq.extra as { name?: string })?.name).toBe('GatewayWalletBatched');
  });

  it('a valid GATEWAY proof BINDS to get_trade_signal (regression: was 402d as cross-tool)', () => {
    const s = settleWith(gwReq, gwReq.amount as string);
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '4h')).toBe(true);
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('ok');
  });

  it('a valid CDP proof still BINDS to get_trade_signal (no regression)', () => {
    const s = settleWith(cdpReq, cdpReq.amount as string);
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '4h')).toBe(true);
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('ok');
  });

  it('cross-tool DOWNGRADE still rejected on the Gateway rail ($0.01 scan_funding_arb proof on the $0.02 route)', () => {
    // Same Gateway identity (network/asset/payTo) but the cheaper tool's amount — the price floor
    // (not the identity check) is what must catch this.
    const cheapGw = x402._getToolRequirementsForTest().get('scan_funding_arb')![1] as Record<string, unknown>;
    expect(cheapGw.amount).toBe(atomic(0.01));
    const s = settleWith(cheapGw, cheapGw.amount as string);
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '4h')).toBe(false);
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('insufficient');
  });

  it('premium-timeframe underpay still rejected on the Gateway rail ($0.02 proof on a 1m=$0.05 call)', () => {
    const s = settleWith(gwReq, gwReq.amount as string);
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '1m')).toBe(false);
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '1m')).toBe('insufficient');
  });

  it('a proof on a rail we do NOT advertise is rejected (identity binds to no rail)', () => {
    const alien = { ...gwReq, network: 'eip155:42161' }; // Arbitrum — not one of our advertised rails
    const s = settleWith(alien, alien.amount as string);
    expect(x402.paymentMatchesToolRoute(s, 'get_trade_signal', '4h')).toBe(false);
    expect(x402.classifyToolRouteMismatch(s, 'get_trade_signal', '4h')).toBe('cross_tool');
  });

  it('wrong asset / payTo still rejected even on an advertised network', () => {
    const wrongAsset = { ...gwReq, asset: '0x0000000000000000000000000000000000000000' };
    const wrongPayTo = { ...gwReq, payTo: '0x000000000000000000000000000000000000dead' };
    expect(x402.paymentMatchesToolRoute(settleWith(wrongAsset, wrongAsset.amount as string), 'get_trade_signal', '4h')).toBe(false);
    expect(x402.paymentMatchesToolRoute(settleWith(wrongPayTo, wrongPayTo.amount as string), 'get_trade_signal', '4h')).toBe(false);
  });
});
