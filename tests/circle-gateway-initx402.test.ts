/**
 * CIRCLE-GATEWAY-MIGRATE-W1 — R1/R3′/Q4 against the REAL initX402() wiring.
 *
 * The sibling dual-advertise suite proves the SDK composition mechanism, but it mirrors
 * initX402's logic rather than calling it — so it could not catch a regression in x402.ts itself.
 * THIS suite drives the real `initX402()` end-to-end, offline, by mocking only the CDP facilitator
 * factory (the one true network dependency) and re-importing the module per case so its
 * import-time env constants (WALLET_ADDRESS / NETWORK / CAIP2_NETWORK) re-evaluate.
 *
 * Covers:
 *   AC2 — flag OFF → accepts[] byte-identical to today, Circle facilitator NEVER constructed
 *   AC3 — flag ON  → accepts[] gains the Gateway entry
 *   Q4  — a THROWING Circle facilitator must NOT take the live CDP rail down
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PAY_TO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const GW_SELLER = '0x1111111111111111111111111111111111111111';
const CDP_NET = 'eip155:8453';
const GW_NET = 'eip155:84532';
const GW_VERIFYING_CONTRACT = '0x0077777d7eba4688bdef3e311b846f25870a19b9';

/** Tracks whether the Circle SDK's real client was constructed (Q4: must not be, when OFF). */
const circleCtor = vi.fn();

vi.mock('../src/lib/x402-facilitator.js', () => ({
  CDP_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
  resolveFacilitatorFromEnv: () => ({
    effectiveChoice: 'legacy',
    discoveryEnabled: false,
    stubFellBack: false,
    facilitatorConfig: undefined,
  }),
  createFacilitatorClient: () => ({
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: CDP_NET, extra: { name: 'USD Coin', version: '2' } }],
        extensions: [],
        signers: {},
      };
    },
    async verify() { return { isValid: false }; },
    async settle() { return { success: false, transaction: '', network: CDP_NET }; },
  }),
}));

// Intercept the Circle SDK so we can (a) count constructions and (b) drive failure modes,
// while still exercising the real circle-gateway.ts + x402.ts code paths.
let circleGetSupportedImpl: () => Promise<unknown> = async () => ({
  kinds: [{
    x402Version: 2, scheme: 'exact', network: GW_NET,
    extra: {
      name: 'GatewayWalletBatched', version: '1', verifyingContract: GW_VERIFYING_CONTRACT,
      minValiditySeconds: 604800,
      assets: [{ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }],
    },
  }],
  extensions: [], signers: {},
});

vi.mock('@circle-fin/x402-batching/server', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    BatchFacilitatorClient: class {
      url: string;
      constructor(cfg: { url: string }) {
        circleCtor(cfg);
        this.url = cfg.url;
      }
      getSupported() { return circleGetSupportedImpl(); }
      async verify() { return { isValid: false }; }
      async settle() { return { success: false, transaction: '', network: GW_NET }; }
    },
  };
});

async function bootX402(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('X402_WALLET_ADDRESS', PAY_TO);
  vi.stubEnv('X402_NETWORK', 'base-mainnet');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const mod = await import('../src/lib/x402.js');
  await mod.initX402();
  return mod;
}

/** accepts[] for one tool, flattened out of the module's private map via its test seam. */
const acceptsOf = (mod: { _getToolRequirementsForTest: () => Map<string, unknown[]> }, tool: string) =>
  (mod._getToolRequirementsForTest().get(tool) ?? []) as Array<{ scheme: string; network: string; payTo: string; extra?: Record<string, unknown> }>;

const anyTool = (mod: { _getToolRequirementsForTest: () => Map<string, unknown[]> }) =>
  Array.from(mod._getToolRequirementsForTest().keys())[0];

beforeEach(() => {
  circleCtor.mockClear();
  circleGetSupportedImpl = async () => ({
    kinds: [{
      x402Version: 2, scheme: 'exact', network: GW_NET,
      extra: {
        name: 'GatewayWalletBatched', version: '1', verifyingContract: GW_VERIFYING_CONTRACT,
        minValiditySeconds: 604800,
        assets: [{ symbol: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 }],
      },
    }],
    extensions: [], signers: {},
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('initX402 — flag OFF (default): the live CDP rail is untouched (AC2)', () => {
  it('builds accepts[] with ONLY the CDP entry', async () => {
    const mod = await bootX402({});
    const tool = anyTool(mod);
    expect(tool).toBeTruthy();
    const accepts = acceptsOf(mod, tool);
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({ scheme: 'exact', network: CDP_NET, payTo: PAY_TO });
  });

  it('NEVER constructs the Circle facilitator (Q4)', async () => {
    await bootX402({});
    expect(circleCtor).not.toHaveBeenCalled();
  });

  it('reports no active gateway', async () => {
    const mod = await bootX402({});
    expect(mod._getActiveGatewayForTest()).toBeNull();
  });

  it('every priced tool gets exactly one accepts entry', async () => {
    const mod = await bootX402({});
    const reqs = mod._getToolRequirementsForTest();
    expect(reqs.size).toBeGreaterThan(0);
    for (const [tool, accepts] of reqs) {
      expect(accepts, `${tool} should have 1 CDP entry`).toHaveLength(1);
    }
  });
});

describe('initX402 — flag ON: dual-advertise on the real wiring (AC3)', () => {
  const ON = { CIRCLE_GATEWAY_ENABLED: 'true', CIRCLE_GATEWAY_SELLER_ADDRESS: GW_SELLER };

  it('constructs the Circle client pinned to the TESTNET url (never the SDK mainnet default)', async () => {
    await bootX402(ON);
    expect(circleCtor).toHaveBeenCalledTimes(1);
    expect(circleCtor).toHaveBeenCalledWith({ url: 'https://gateway-api-testnet.circle.com' });
  });

  it('accepts[] gains the Gateway entry alongside the untouched CDP entry', async () => {
    const mod = await bootX402(ON);
    const accepts = acceptsOf(mod, anyTool(mod));
    expect(accepts).toHaveLength(2);

    const cdp = accepts.find((a) => a.network === CDP_NET)!;
    const gw = accepts.find((a) => a.network === GW_NET)!;
    expect(cdp).toMatchObject({ scheme: 'exact', payTo: PAY_TO });
    expect(gw).toMatchObject({ scheme: 'exact', payTo: GW_SELLER });
    expect(gw.extra?.name).toBe('GatewayWalletBatched');
    expect(gw.extra?.verifyingContract).toBe(GW_VERIFYING_CONTRACT);
  });

  it('reports the active gateway config', async () => {
    const mod = await bootX402(ON);
    const active = mod._getActiveGatewayForTest();
    expect(active).toMatchObject({ enabled: true, network: GW_NET, sellerAddress: GW_SELLER, useStub: false });
  });

  it('the CDP accepts entry is IDENTICAL with the flag on vs off (additive means additive)', async () => {
    const off = acceptsOf(await bootX402({}), 'get_trade_signal');
    const on = acceptsOf(await bootX402(ON), 'get_trade_signal');
    expect(on.find((a) => a.network === CDP_NET)).toEqual(off[0]);
  });
});

describe('initX402 — Q4: a broken Circle facilitator must NOT kill the live CDP rail', () => {
  const ON = { CIRCLE_GATEWAY_ENABLED: 'true', CIRCLE_GATEWAY_SELLER_ADDRESS: GW_SELLER };

  it('Circle getSupported() THROWS → CDP still serves its 402, Gateway silently dropped', async () => {
    circleGetSupportedImpl = async () => { throw new Error('circle gateway is down'); };
    const mod = await bootX402(ON);

    // The rail is ALIVE and byte-identical to flag-OFF.
    const accepts = acceptsOf(mod, anyTool(mod));
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({ scheme: 'exact', network: CDP_NET, payTo: PAY_TO });
    expect(mod._getActiveGatewayForTest()).toBeNull();
  });

  it('Circle advertises the WRONG network → Gateway dropped, CDP unaffected', async () => {
    circleGetSupportedImpl = async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:11155111', extra: { name: 'GatewayWalletBatched' } }],
      extensions: [], signers: {},
    });
    const mod = await bootX402(ON);
    expect(acceptsOf(mod, anyTool(mod))).toHaveLength(1);
    expect(mod._getActiveGatewayForTest()).toBeNull();
  });

  it('Circle returns a malformed response → Gateway dropped, CDP unaffected', async () => {
    circleGetSupportedImpl = async () => ({ kinds: null }) as never;
    const mod = await bootX402(ON);
    expect(acceptsOf(mod, anyTool(mod))).toHaveLength(1);
    expect(mod._getActiveGatewayForTest()).toBeNull();
  });

  it('a malformed seller address default-denies without touching CDP', async () => {
    const mod = await bootX402({ CIRCLE_GATEWAY_ENABLED: 'true', CIRCLE_GATEWAY_SELLER_ADDRESS: '0xnope' });
    expect(circleCtor).not.toHaveBeenCalled();
    expect(acceptsOf(mod, anyTool(mod))).toHaveLength(1);
    expect(mod._getActiveGatewayForTest()).toBeNull();
  });
});
