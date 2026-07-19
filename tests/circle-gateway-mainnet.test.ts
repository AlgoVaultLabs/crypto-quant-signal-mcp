/**
 * CIRCLE-GATEWAY-MAINNET-ENABLE-W1 — mainnet topology + the collision that forced it.
 *
 * Drives the REAL @x402/core `x402ResourceServer` and the REAL `GatewayEvmScheme` (no network).
 *
 * THE FINDING THIS FILE ENCODES. On Base mainnet the CDP rail and Circle Gateway are identical in
 * all three keys the SDK dispatches on — `(x402Version 2, scheme 'exact', network 'eip155:8453')`.
 * They cannot coexist on one resource server, and BOTH failure layers are silent:
 *
 *   1. `register()` is `Map<network, Map<scheme, server>>` guarded by `if (!has(scheme))` —
 *      first-wins, silent no-op. CDP registers first, so GatewayEvmScheme never registers.
 *   2. `getSupportedKind(x402Version, network, scheme)` has no `extra` dimension, so two kinds
 *      differing only by `extra.name` are indistinguishable.
 *
 * The build then still SUCCEEDS and still returns entries — plain CDP-shaped payments to the
 * Gateway seller with `extra = {}`, which no Gateway client can pay. Hence the mainnet Gateway
 * lives on OP Mainnet (`eip155:10`), reproducing the distinct-network topology that the
 * Base-Sepolia settle already proved, and `gatewayRequirementsCarryDomain()` is the structural
 * backstop that makes a regression LOUD instead of silent.
 *
 * The `describe('THE COLLISION')` block below is a CHARACTERIZATION test: it asserts the SDK's
 * current first-wins behavior. If a future SDK bump changes it, this goes red — which is the
 * point. Do not "fix" it by loosening the assertion; re-derive the design.
 */
import { describe, it, expect } from 'vitest';
import { x402ResourceServer } from '@x402/core/server';
import {
  createGatewayScheme,
  gatewayRequirementsCarryDomain,
  GATEWAY_EIP712_DOMAIN_NAME,
  CIRCLE_MAINNET_FACILITATOR_URL,
  resolveCircleGatewayFromEnv,
} from '../src/lib/circle-gateway.js';

const CDP_NET = 'eip155:8453';
const GW_NET = 'eip155:10'; // OP Mainnet — the collision-free Gateway network
const CDP_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const GW_SELLER = '0x2222222222222222222222222222222222222222';

/** Circle's LIVE OP-Mainnet kind, copied verbatim from gateway-api.circle.com (probed 2026-07-19). */
const LIVE_OP_EXTRA = {
  name: GATEWAY_EIP712_DOMAIN_NAME,
  version: '1',
  verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee',
  minValiditySeconds: 604800,
  assets: [{ symbol: 'USDC', address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6 }],
};

type Kind = { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> };
const fakeFacilitator = (network: string, extra: Record<string, unknown>) => ({
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network, extra }] as Kind[], extensions: [], signers: {} };
  },
  async verify() { return { isValid: false }; },
  async settle() { return { success: false, transaction: '', network }; },
});

const cdpFacilitator = () => fakeFacilitator(CDP_NET, { name: 'USD Coin', version: '2' });
const gatewayFacilitator = (net = GW_NET) => fakeFacilitator(net, LIVE_OP_EXTRA);

/** The CDP inline scheme, mirroring src/lib/x402.ts's registration verbatim. */
const cdpExactScheme = {
  scheme: 'exact',
  async parsePrice(price: string) {
    return { amount: String(Math.round(parseFloat(String(price).replace('$', '')) * 1e6)), asset: CDP_USDC };
  },
  getAssetDecimals() { return 6; },
  async enhancePaymentRequirements(reqs: unknown) { return reqs; },
};

type Reqs = Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string; extra?: Record<string, unknown> }>;

/** Build a server the way initX402 does. `gwNet=null` = flag OFF (CDP only). */
async function buildServer(gwNet: string | null) {
  const facilitators = gwNet ? [cdpFacilitator(), gatewayFacilitator(gwNet)] : cdpFacilitator();
  const srv = new x402ResourceServer(facilitators as never);
  srv.register(CDP_NET, cdpExactScheme as never);           // CDP FIRST, exactly as production does
  if (gwNet) srv.register(gwNet, createGatewayScheme() as never);
  await srv.initialize();
  return srv;
}

const buildGatewayReqs = (srv: x402ResourceServer, net: string, price = 0.02) =>
  srv.buildPaymentRequirements({ scheme: 'exact', network: net, payTo: GW_SELLER, price: `$${price}` } as never) as Promise<Reqs>;

// ─────────────────────────────────────────────────────────────────────────────

describe('THE COLLISION — why mainnet Gateway is NOT on eip155:8453 (characterization)', () => {
  it('register() is FIRST-WINS: a 2nd exact scheme on the same network is a silent no-op', async () => {
    const srv = new x402ResourceServer(cdpFacilitator() as never);
    srv.register(CDP_NET, cdpExactScheme as never);
    srv.register(CDP_NET, createGatewayScheme() as never); // would-be mainnet collision

    const registry = (srv as unknown as { registeredServerSchemes: Map<string, Map<string, unknown>> })
      .registeredServerSchemes.get(CDP_NET)!;
    expect([...registry.keys()]).toEqual(['exact']);        // ONE entry, not two
    expect(registry.get('exact')).toBe(cdpExactScheme);     // CDP won; Gateway was dropped
  });

  it('the dropped Gateway still BUILDS — with extra={}, i.e. unpayable by any Gateway client', async () => {
    const srv = new x402ResourceServer([cdpFacilitator(), gatewayFacilitator(CDP_NET)] as never);
    srv.register(CDP_NET, cdpExactScheme as never);
    srv.register(CDP_NET, createGatewayScheme() as never);
    await srv.initialize();

    const reqs = await buildGatewayReqs(srv, CDP_NET);
    expect(reqs.length).toBeGreaterThan(0);                       // no throw — this is the trap
    expect(JSON.stringify(reqs)).not.toContain(GATEWAY_EIP712_DOMAIN_NAME);
    // ...and the backstop catches exactly this.
    expect(gatewayRequirementsCarryDomain(reqs)).toBe(false);
  });

  it('getSupportedKind() cannot disambiguate: it answers TRUE from the CDP kind', async () => {
    const srv = new x402ResourceServer([cdpFacilitator(), gatewayFacilitator(CDP_NET)] as never);
    srv.register(CDP_NET, cdpExactScheme as never);
    await srv.initialize();
    // The pre-existing liveness guard would pass here even though NO Gateway scheme is registered —
    // which is why it is insufficient on a shared network.
    expect(srv.getSupportedKind(2, CDP_NET as `${string}:${string}`, 'exact')).toBeTruthy();
  });
});

describe('MAINNET TOPOLOGY — Gateway on OP Mainnet coexists cleanly', () => {
  it('flag ON: accepts[] carries BOTH rails, each on its own network', async () => {
    const srv = await buildServer(GW_NET);
    const cdp = (await srv.buildPaymentRequirements({
      scheme: 'exact', network: CDP_NET, payTo: PAY_TO, price: '$0.02', extra: { name: 'USD Coin', version: '2' },
    } as never)) as Reqs;
    const gw = await buildGatewayReqs(srv, GW_NET);
    const accepts = [...cdp, ...gw];

    expect(accepts).toHaveLength(2);
    expect(accepts[0]).toMatchObject({ scheme: 'exact', network: CDP_NET, payTo: PAY_TO, asset: CDP_USDC });
    expect(accepts[1]).toMatchObject({ scheme: 'exact', network: GW_NET, payTo: GW_SELLER });
  });

  it('the Gateway entry carries the GatewayWalletBatched domain + live verifyingContract', async () => {
    const srv = await buildServer(GW_NET);
    const gw = await buildGatewayReqs(srv, GW_NET);
    expect(gw[0].extra).toMatchObject({
      name: GATEWAY_EIP712_DOMAIN_NAME,
      verifyingContract: LIVE_OP_EXTRA.verifyingContract,
    });
    expect(gatewayRequirementsCarryDomain(gw)).toBe(true);
  });

  it('GatewayEvmScheme resolves OP-Mainnet USDC itself (no USDC_ADDRESS entry needed)', async () => {
    const srv = await buildServer(GW_NET);
    const gw = await buildGatewayReqs(srv, GW_NET);
    // On-chain verified 2026-07-19 across 2 RPCs: chainId 10, symbol USDC, decimals 6.
    expect(gw[0].asset.toLowerCase()).toBe('0x0b2c639c533813f4aa9d7837caf62653d097ff85');
  });

  it('flag OFF: exactly ONE entry, and nothing Gateway-shaped leaks', async () => {
    const srv = await buildServer(null);
    const accepts = (await srv.buildPaymentRequirements({
      scheme: 'exact', network: CDP_NET, payTo: PAY_TO, price: '$0.02', extra: { name: 'USD Coin', version: '2' },
    } as never)) as Reqs;

    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({ scheme: 'exact', network: CDP_NET, payTo: PAY_TO });
    expect(JSON.stringify(accepts)).not.toContain(GATEWAY_EIP712_DOMAIN_NAME);
    expect(accepts.some((a) => a.network === GW_NET)).toBe(false);
  });
});

describe('gatewayRequirementsCarryDomain — the structural backstop', () => {
  const ok = [{ extra: { name: GATEWAY_EIP712_DOMAIN_NAME } }];
  it('true only when EVERY entry carries the domain', () => {
    expect(gatewayRequirementsCarryDomain(ok)).toBe(true);
    expect(gatewayRequirementsCarryDomain([...ok, { extra: {} }])).toBe(false);
  });
  it('false (never throws) on empty / non-array / malformed input', () => {
    for (const bad of [[], null, undefined, {}, 'nope', [null], [{ extra: null }], [{}]]) {
      expect(gatewayRequirementsCarryDomain(bad)).toBe(false);
    }
  });
  it('false on the CDP USDC domain — the exact confusion it exists to catch', () => {
    expect(gatewayRequirementsCarryDomain([{ extra: { name: 'USD Coin', version: '2' } }])).toBe(false);
  });
});

describe('env allow-lists — mainnet opened, Base kept CLOSED to Gateway', () => {
  const base = {
    CIRCLE_GATEWAY_ENABLED: 'true',
    CIRCLE_GATEWAY_FACILITATOR_URL: CIRCLE_MAINNET_FACILITATOR_URL,
    CIRCLE_GATEWAY_SELLER_ADDRESS: GW_SELLER,
  };

  it('accepts the mainnet facilitator + OP Mainnet', () => {
    const c = resolveCircleGatewayFromEnv({ ...base, CIRCLE_GATEWAY_NETWORK: GW_NET } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ enabled: true, network: GW_NET, useStub: false, facilitatorUrl: CIRCLE_MAINNET_FACILITATOR_URL });
  });

  it('REJECTS eip155:8453 — re-opening the collision must be impossible via env alone', () => {
    const c = resolveCircleGatewayFromEnv({ ...base, CIRCLE_GATEWAY_NETWORK: CDP_NET } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/not testnet-allow-listed|allow-list/i);
  });

  it('still defaults OFF with the flag unset, even with mainnet config present', () => {
    const { CIRCLE_GATEWAY_ENABLED: _omit, ...noFlag } = base;
    const c = resolveCircleGatewayFromEnv({ ...noFlag, CIRCLE_GATEWAY_NETWORK: GW_NET } as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/default OFF/i);
  });
});
