/**
 * CIRCLE-GATEWAY-MIGRATE-W1 R5 — LIVE Circle Gateway testnet proof.
 *
 * Gated behind `INTEGRATION=1` (needs network to gateway-api-testnet.circle.com). Default
 * `npm test` SKIPS this file. Salvaged from the parked `feature/circle-gateway-x402-batching`
 * branch (its `/server` import path, INTEGRATION gate, and 503 "no supported networks" branch were
 * all correct); the staged branch's `createGatewayMiddleware` shape was NOT — that's Path A, which
 * cannot dual-advertise (architect R0 Q2 → Path B).
 *
 * SCOPE — what this can and cannot prove:
 *   ✅ Circle's testnet facilitator is live and advertises Base Sepolia
 *   ✅ the REAL BatchFacilitatorClient + GatewayEvmScheme compose into our resource server
 *   ✅ a real 402 accepts[] carries Circle's REAL verifyingContract
 *   ❌ a real SETTLE — that needs a buyer wallet with USDC deposited into the GatewayWallet
 *      contract on Base Sepolia (operator funding). Tracked as the ≤14d follow-up per R5.
 *
 * MAINNET IS NEVER TOUCHED: the module's allow-list refuses any non-testnet host/network.
 */
import { describe, it, expect } from 'vitest';
import { x402ResourceServer } from '@x402/core/server';
import {
  createCircleFacilitator,
  createGatewayScheme,
  probeCircleFacilitator,
  resolveCircleGatewayFromEnv,
  CIRCLE_TESTNET_FACILITATOR_URL,
  GATEWAY_EIP712_DOMAIN_NAME,
} from '../../src/lib/circle-gateway.js';

const GW_NET = 'eip155:84532'; // Base Sepolia
const GW_SELLER = '0x1111111111111111111111111111111111111111';
const LIVE_ENV = { CIRCLE_GATEWAY_ENABLED: 'true', CIRCLE_GATEWAY_SELLER_ADDRESS: GW_SELLER };

describe.skipIf(!process.env.INTEGRATION)('R5 — Circle Gateway testnet (LIVE)', () => {
  it('testnet facilitator is reachable and advertises exact on Base Sepolia', async () => {
    const res = await fetch(`${CIRCLE_TESTNET_FACILITATOR_URL}/v1/x402/supported`);
    if (res.status === 503) {
      throw new Error('Circle Gateway testnet returned 503 (no supported networks) — likely unreachable from this network.');
    }
    expect(res.status).toBe(200);

    const body = (await res.json()) as { kinds: Array<{ scheme: string; network: string; extra?: Record<string, unknown> }> };
    const baseSepolia = body.kinds.find((k) => k.network === GW_NET);
    expect(baseSepolia).toBeTruthy();

    // The load-bearing contract: Gateway IS `exact`; GatewayWalletBatched is extra.name.
    expect(baseSepolia!.scheme).toBe('exact');
    expect(baseSepolia!.extra?.name).toBe(GATEWAY_EIP712_DOMAIN_NAME);
    expect(baseSepolia!.extra?.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // Every kind Circle advertises is `exact` — no exceptions.
    for (const k of body.kinds) expect(k.scheme).toBe('exact');
  }, 30_000);

  it('the REAL BatchFacilitatorClient probes clean against testnet', async () => {
    const config = resolveCircleGatewayFromEnv(LIVE_ENV);
    expect(config.enabled).toBe(true);
    expect(config.useStub).toBe(false);
    expect(config.facilitatorUrl).toBe(CIRCLE_TESTNET_FACILITATOR_URL);

    const probe = await probeCircleFacilitator(config);
    expect(probe).not.toBeNull();
    expect(probe!.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 30_000);

  it('a real 402 accepts[] carries Circle\'s LIVE verifyingContract (R3′ end-to-end)', async () => {
    const config = resolveCircleGatewayFromEnv(LIVE_ENV);
    const facilitator = createCircleFacilitator(config);

    const srv = new x402ResourceServer([facilitator] as never);
    srv.register(GW_NET, createGatewayScheme() as never);
    await srv.initialize();

    expect(srv.getSupportedKind(2, GW_NET as never, 'exact')).toBeTruthy();

    const reqs = (await srv.buildPaymentRequirements({
      scheme: 'exact', network: GW_NET, payTo: GW_SELLER, price: '$0.02',
    } as never)) as Array<{ scheme: string; network: string; amount: string; payTo: string; extra?: Record<string, unknown> }>;

    expect(reqs).toHaveLength(1);
    expect(reqs[0].scheme).toBe('exact');
    expect(reqs[0].network).toBe(GW_NET);
    expect(reqs[0].payTo).toBe(GW_SELLER);
    expect(reqs[0].amount).toBe('20000'); // $0.02 × 1e6 — same SoT price as the CDP rail
    // Merged through by GatewayEvmScheme.enhancePaymentRequirements from the LIVE facilitator.
    expect(reqs[0].extra?.name).toBe(GATEWAY_EIP712_DOMAIN_NAME);
    expect(reqs[0].extra?.verifyingContract).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 45_000);

  it('mainnet stays structurally unreachable even under INTEGRATION (AC5)', () => {
    const c = resolveCircleGatewayFromEnv({
      ...LIVE_ENV,
      CIRCLE_GATEWAY_FACILITATOR_URL: 'https://gateway-api.circle.com',
    });
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/testnet-only/);
  });
});
