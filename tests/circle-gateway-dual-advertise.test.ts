/**
 * CIRCLE-GATEWAY-MIGRATE-W1 R3′ — dual-advertise + R4 price parity.
 *
 * Drives the REAL @x402/core x402ResourceServer and the REAL GatewayEvmScheme (no network: both
 * facilitators are shape-accurate fakes mirroring the live `/v1/x402/supported` responses probed
 * 2026-07-17). What this pins is the composition mechanism itself:
 *
 *   flag OFF → accepts[] == exactly today's single CDP `exact`/eip155:8453 entry
 *   flag ON  → accepts[] gains an ADDITIONAL `exact` entry on eip155:84532 carrying
 *              extra.name === 'GatewayWalletBatched' + extra.verifyingContract
 *
 * R3′ wording is architect-ratified (R0 Q1). The naive "accepts[] lists scheme
 * 'GatewayWalletBatched'" is FALSE BY CONSTRUCTION — Gateway IS `exact`; GatewayWalletBatched is
 * the EIP-712 domain name in `extra`. The `scheme !== GATEWAY_EIP712_DOMAIN_NAME` assertions below
 * are deliberate regression guards against re-introducing that misconception.
 */
import { describe, it, expect } from 'vitest';
import { x402ResourceServer } from '@x402/core/server';
import { createGatewayScheme, GATEWAY_EIP712_DOMAIN_NAME } from '../src/lib/circle-gateway.js';
import { TOOL_PRICING, SIGNAL_TIMEFRAME_PRICING } from '../src/lib/x402.js';

const CDP_NET = 'eip155:8453';
const GW_NET = 'eip155:84532';
const CDP_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const GW_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const GW_SELLER = '0x1111111111111111111111111111111111111111';
/** Live GatewayWallet on Circle's testnet facilitator (probed 2026-07-17). */
const GW_VERIFYING_CONTRACT = '0x0077777d7eba4688bdef3e311b846f25870a19b9';

type Kind = { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> };
const fakeFacilitator = (network: string, extra: Record<string, unknown>) => ({
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network, extra }] as Kind[], extensions: [], signers: {} };
  },
  async verify() { return { isValid: false }; },
  async settle() { return { success: false, transaction: '', network }; },
});

const cdpFacilitator = () => fakeFacilitator(CDP_NET, { name: 'USD Coin', version: '2' });
/** Mirrors Circle's live testnet kind for Base Sepolia verbatim. */
const gatewayFacilitator = () =>
  fakeFacilitator(GW_NET, {
    name: GATEWAY_EIP712_DOMAIN_NAME,
    version: '1',
    verifyingContract: GW_VERIFYING_CONTRACT,
    minValiditySeconds: 604800,
    assets: [{ symbol: 'USDC', address: GW_USDC, decimals: 6 }],
  });

/** The CDP inline scheme, mirroring src/lib/x402.ts's registration. */
const cdpExactScheme = {
  scheme: 'exact',
  async parsePrice(price: string) {
    return { amount: String(Math.round(parseFloat(String(price).replace('$', '')) * 1e6)), asset: CDP_USDC };
  },
  getAssetDecimals() { return 6; },
  async enhancePaymentRequirements(reqs: unknown) { return reqs; },
};

type Reqs = Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string; extra?: Record<string, unknown> }>;

/** Build a resource server the way initX402 does, with/without the Gateway. */
async function buildServer(withGateway: boolean) {
  const facilitators = withGateway ? [cdpFacilitator(), gatewayFacilitator()] : cdpFacilitator();
  const srv = new x402ResourceServer(facilitators as never);
  srv.register(CDP_NET, cdpExactScheme as never);
  if (withGateway) srv.register(GW_NET, createGatewayScheme() as never);
  await srv.initialize();
  return srv;
}

/** Build accepts[] for one price, mirroring initX402's additive concat. */
async function acceptsFor(srv: x402ResourceServer, price: number, withGateway: boolean): Promise<Reqs> {
  const reqs = (await srv.buildPaymentRequirements({
    scheme: 'exact', network: CDP_NET, payTo: PAY_TO, price: `$${price}`, extra: { name: 'USD Coin', version: '2' },
  } as never)) as Reqs;
  if (withGateway) {
    const gw = (await srv.buildPaymentRequirements({
      scheme: 'exact', network: GW_NET, payTo: GW_SELLER, price: `$${price}`,
    } as never)) as Reqs;
    reqs.push(...gw);
  }
  return reqs;
}

describe('R3′ — flag OFF: accepts[] byte-identical to today (AC2)', () => {
  it('advertises exactly ONE entry: exact on Base mainnet', async () => {
    const accepts = await acceptsFor(await buildServer(false), 0.02, false);
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      scheme: 'exact', network: CDP_NET, amount: '20000', asset: CDP_USDC, payTo: PAY_TO,
    });
    expect(accepts[0].extra).toMatchObject({ name: 'USD Coin', version: '2' });
  });

  it('leaks NOTHING Gateway-shaped when off', async () => {
    const accepts = await acceptsFor(await buildServer(false), 0.02, false);
    const blob = JSON.stringify(accepts);
    expect(blob).not.toContain(GATEWAY_EIP712_DOMAIN_NAME);
    expect(blob).not.toContain(GW_NET);
    expect(blob).not.toContain(GW_SELLER);
    expect(accepts.some((a) => a.network === GW_NET)).toBe(false);
  });

  it('does not register the Gateway network at all when off', async () => {
    const srv = await buildServer(false);
    expect(srv.getSupportedKind(2, CDP_NET as never, 'exact')).toBeTruthy();
    expect(srv.getSupportedKind(2, GW_NET as never, 'exact')).toBeFalsy();
  });
});

describe('R3′ — flag ON: accepts[] gains the Gateway entry (AC3)', () => {
  it('advertises BOTH kinds on one resource server', async () => {
    const srv = await buildServer(true);
    expect(srv.getSupportedKind(2, CDP_NET as never, 'exact')).toBeTruthy();
    expect(srv.getSupportedKind(2, GW_NET as never, 'exact')).toBeTruthy();
  });

  it('accepts[] gains ≥1 ADDITIONAL entry — the CDP entry is untouched', async () => {
    const off = await acceptsFor(await buildServer(false), 0.02, false);
    const on = await acceptsFor(await buildServer(true), 0.02, true);

    expect(on.length).toBeGreaterThan(off.length);
    // The CDP entry must survive byte-for-byte — additive means additive.
    expect(on[0]).toEqual(off[0]);
  });

  it('the ADDITIONAL entry is scheme "exact" + extra.name GatewayWalletBatched + verifyingContract', async () => {
    const accepts = await acceptsFor(await buildServer(true), 0.02, true);
    const gw = accepts.filter((a) => a.network === GW_NET);
    expect(gw).toHaveLength(1);

    // The ratified R3′ predicate, exactly.
    expect(gw[0].scheme).toBe('exact');
    expect(gw[0].extra?.name).toBe(GATEWAY_EIP712_DOMAIN_NAME);
    expect(gw[0].extra?.verifyingContract).toBe(GW_VERIFYING_CONTRACT);
    expect(gw[0].payTo).toBe(GW_SELLER);
    // GatewayEvmScheme resolves Base Sepolia USDC itself — we never hand-set an asset.
    expect(gw[0].asset).toBe(GW_USDC);
  });

  it('REGRESSION GUARD: no accepts[] entry ever uses GatewayWalletBatched as a SCHEME id', async () => {
    const accepts = await acceptsFor(await buildServer(true), 0.02, true);
    expect(accepts.length).toBeGreaterThanOrEqual(2);
    for (const a of accepts) {
      expect(a.scheme).toBe('exact');
      expect(a.scheme).not.toBe(GATEWAY_EIP712_DOMAIN_NAME);
    }
    // GatewayWalletBatched appears ONLY as extra.name, never as a scheme.
    expect(accepts.filter((a) => a.extra?.name === GATEWAY_EIP712_DOMAIN_NAME)).toHaveLength(1);
  });

  it('the two rails are distinguished by NETWORK, not by scheme string', async () => {
    const accepts = await acceptsFor(await buildServer(true), 0.02, true);
    expect(new Set(accepts.map((a) => a.scheme))).toEqual(new Set(['exact']));
    expect(new Set(accepts.map((a) => a.network))).toEqual(new Set([CDP_NET, GW_NET]));
  });
});

describe('R4 — price parity from the single TOOL_PRICING SoT (AC4)', () => {
  it('CDP amount === Gateway amount for every priced tool', async () => {
    const srv = await buildServer(true);
    const priced = Object.entries(TOOL_PRICING) as Array<[string, number]>;
    expect(priced.length).toBeGreaterThan(0);

    for (const [tool, price] of priced) {
      const accepts = await acceptsFor(srv, price, true);
      const cdp = accepts.find((a) => a.network === CDP_NET)!;
      const gw = accepts.find((a) => a.network === GW_NET)!;
      expect(gw, `${tool}: gateway entry missing`).toBeTruthy();
      expect(gw.amount, `${tool}: price drift CDP=${cdp.amount} GW=${gw.amount}`).toBe(cdp.amount);
      // Both are 6-decimal USDC → the atomic amount must equal the USD price × 1e6.
      expect(gw.amount).toBe(String(Math.round(price * 1e6)));
    }
  });

  it('parity holds across the TIMEFRAME dimension too (architect R0 Q5d)', async () => {
    // SIGNAL_TIMEFRAME_PRICING overrides get_trade_signal per timeframe ($0.05@1m … $0.02@1d),
    // so a basePriceUsd-only parity test would pin an incomplete surface.
    const srv = await buildServer(true);
    const timeframes = Object.entries(SIGNAL_TIMEFRAME_PRICING);
    expect(timeframes.length).toBeGreaterThan(0);
    expect(new Set(timeframes.map(([, p]) => p)).size).toBeGreaterThan(1); // the surface really does vary

    for (const [tf, price] of timeframes) {
      const accepts = await acceptsFor(srv, price, true);
      const cdp = accepts.find((a) => a.network === CDP_NET)!;
      const gw = accepts.find((a) => a.network === GW_NET)!;
      expect(gw.amount, `${tf}: price drift CDP=${cdp.amount} GW=${gw.amount}`).toBe(cdp.amount);
      expect(gw.amount).toBe(String(Math.round(price * 1e6)));
    }
  });

  it('there is no second price source — Gateway reads the same resolved price', async () => {
    // Guard against a future "gateway pricing" map: the Gateway config we pass carries no price
    // of its own; it is handed the SAME resolved value the CDP entry used.
    const srv = await buildServer(true);
    const accepts = await acceptsFor(srv, 0.05, true);
    expect(new Set(accepts.map((a) => a.amount))).toEqual(new Set(['50000']));
  });
});
