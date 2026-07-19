/**
 * CIRCLE-GATEWAY-MAINNET-ENABLE-W1 R1b — the structural backstop, driven through REAL initX402().
 *
 * The sibling `circle-gateway-mainnet.test.ts` proves `gatewayRequirementsCarryDomain()` returns
 * the right answer, and proves the SDK's first-wins collision. Neither proves that **x402.ts
 * actually calls the guard** — delete the call and both suites stay green. That gap is the same
 * shape as the defect this whole arc started with, so it gets its own suite.
 *
 * Method: mock `GatewayEvmScheme` so its `enhancePaymentRequirements` is a PASS-THROUGH — which is
 * precisely what production sees when the real Gateway scheme was silently dropped by `register()`
 * and the CDP scheme served the build instead. The requirements then come back WITHOUT the
 * `GatewayWalletBatched` domain, and initX402 must drop the Gateway entry and stop reporting ACTIVE.
 *
 * The env allow-list already refuses `eip155:8453`, so this failure mode is not reachable via env
 * today — that is defence in depth, not redundancy. The guard exists for the next change (an SDK
 * bump, a Circle `extra` change, or someone widening the allow-list), and this suite is what keeps
 * it wired until then.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PAY_TO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const GW_SELLER = '0x2222222222222222222222222222222222222222';
const CDP_NET = 'eip155:8453';
const GW_NET = 'eip155:10';
const MAINNET_FACILITATOR = 'https://gateway-api.circle.com';
const OP_VERIFYING_CONTRACT = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';

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

/** Flipped per-test: does the registered Gateway scheme merge the EIP-712 domain, or not? */
let schemeMergesDomain = true;

vi.mock('@circle-fin/x402-batching/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const RealGatewayScheme = actual.GatewayEvmScheme as new () => {
    enhancePaymentRequirements(r: unknown, ...rest: unknown[]): Promise<unknown>;
  };
  return {
    ...actual,
    // Simulates the collision outcome: the Gateway scheme is not the one serving the build, so
    // nothing merges `extra.name`/`verifyingContract` — exactly CDP's pass-through behavior.
    GatewayEvmScheme: class extends RealGatewayScheme {
      async enhancePaymentRequirements(r: unknown, ...rest: unknown[]) {
        return schemeMergesDomain ? super.enhancePaymentRequirements(r, ...rest) : r;
      }
    },
    BatchFacilitatorClient: class {
      constructor(public cfg: { url: string }) {}
      async getSupported() {
        return {
          kinds: [{
            x402Version: 2, scheme: 'exact', network: GW_NET,
            extra: {
              name: 'GatewayWalletBatched', version: '1', verifyingContract: OP_VERIFYING_CONTRACT,
              minValiditySeconds: 604800,
              assets: [{ symbol: 'USDC', address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6 }],
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

async function bootMainnetGateway() {
  vi.resetModules();
  vi.stubEnv('X402_WALLET_ADDRESS', PAY_TO);
  vi.stubEnv('X402_NETWORK', 'base-mainnet');
  vi.stubEnv('CIRCLE_GATEWAY_ENABLED', 'true');
  vi.stubEnv('CIRCLE_GATEWAY_FACILITATOR_URL', MAINNET_FACILITATOR);
  vi.stubEnv('CIRCLE_GATEWAY_NETWORK', GW_NET);
  vi.stubEnv('CIRCLE_GATEWAY_SELLER_ADDRESS', GW_SELLER);
  const mod = await import('../src/lib/x402.js');
  await mod.initX402();
  return mod;
}

const acceptsOf = (mod: { _getToolRequirementsForTest: () => Map<string, unknown[]> }) => {
  const tool = Array.from(mod._getToolRequirementsForTest().keys())[0];
  return (mod._getToolRequirementsForTest().get(tool) ?? []) as Array<{ network: string; payTo: string; extra?: Record<string, unknown> }>;
};

beforeEach(() => { schemeMergesDomain = true; });
afterEach(() => vi.unstubAllEnvs());

describe('R1b — initX402 drops a Gateway entry that lacks the EIP-712 domain', () => {
  it('POSITIVE CONTROL: domain present → Gateway IS advertised on OP Mainnet', async () => {
    const mod = await bootMainnetGateway();
    const accepts = acceptsOf(mod);

    expect(accepts).toHaveLength(2);
    expect(accepts[1]).toMatchObject({ network: GW_NET, payTo: GW_SELLER });
    expect(accepts[1].extra).toMatchObject({ name: 'GatewayWalletBatched', verifyingContract: OP_VERIFYING_CONTRACT });
    expect(mod._getActiveGatewayForTest()).not.toBeNull();
  });

  it('domain ABSENT → Gateway entry dropped, CDP entry retained untouched', async () => {
    schemeMergesDomain = false;
    const mod = await bootMainnetGateway();
    const accepts = acceptsOf(mod);

    expect(accepts).toHaveLength(1);                                   // Gateway dropped
    expect(accepts[0]).toMatchObject({ network: CDP_NET, payTo: PAY_TO }); // CDP intact
    expect(JSON.stringify(accepts)).not.toContain('GatewayWalletBatched');
    expect(accepts.some((a) => a.payTo === GW_SELLER)).toBe(false);    // never advertise the seller
  });

  it('domain ABSENT → stops reporting ACTIVE (no false-positive liveness claim)', async () => {
    schemeMergesDomain = false;
    const mod = await bootMainnetGateway();
    // The pre-existing getSupportedKind() check passes here; only the R1b guard nulls this.
    expect(mod._getActiveGatewayForTest()).toBeNull();
  });

  it('domain ABSENT → warns loudly (a silent drop would repeat the original defect)', async () => {
    schemeMergesDomain = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await bootMainnetGateway();
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain('GatewayWalletBatched');
    expect(said).toMatch(/DROPPED|CDP entry retained/i);
    warn.mockRestore();
  });
});
