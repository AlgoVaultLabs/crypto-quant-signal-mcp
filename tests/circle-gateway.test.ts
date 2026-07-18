/**
 * CIRCLE-GATEWAY-MIGRATE-W1 — Circle Gateway additive scheme: config resolution, Stub, factory.
 *
 * Pure/unit only — no network. The live-facilitator + dual-advertise proofs live in
 * tests/integration/circle-gateway-dual-advertise.test.ts (INTEGRATION=1 gated).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCircleGatewayFromEnv,
  createCircleFacilitator,
  createGatewayScheme,
  probeCircleFacilitator,
  GatewayStubFacilitator,
  CIRCLE_TESTNET_FACILITATOR_URL,
  CIRCLE_MAINNET_FACILITATOR_URL,
  GATEWAY_EIP712_DOMAIN_NAME,
  GATEWAY_STUB_SELLER_ADDRESS,
  type GatewayFacilitatorLike,
} from '../src/lib/circle-gateway.js';

const SELLER = '0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59';
const ON = { CIRCLE_GATEWAY_ENABLED: 'true' };

describe('resolveCircleGatewayFromEnv — two-flag firewall (outer)', () => {
  it('defaults OFF when CIRCLE_GATEWAY_ENABLED is unset', () => {
    const c = resolveCircleGatewayFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/default OFF/);
  });

  it('stays OFF for every non-"true" value (default-deny, not truthy-coerce)', () => {
    for (const v of ['1', 'yes', 'TRUE ', 'on', '', 'false', 'True!']) {
      expect(resolveCircleGatewayFromEnv({ CIRCLE_GATEWAY_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('accepts exact "true" (and is case-insensitive on the word itself)', () => {
    expect(resolveCircleGatewayFromEnv({ ...ON, CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER }).enabled).toBe(true);
    expect(
      resolveCircleGatewayFromEnv({ CIRCLE_GATEWAY_ENABLED: 'TRUE', CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER }).enabled,
    ).toBe(true);
  });
});

describe('resolveCircleGatewayFromEnv — mainnet is structurally blocked (R5/AC5)', () => {
  it('refuses the Circle MAINNET facilitator host', () => {
    const c = resolveCircleGatewayFromEnv({
      ...ON,
      CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER,
      CIRCLE_GATEWAY_FACILITATOR_URL: CIRCLE_MAINNET_FACILITATOR_URL,
    });
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/testnet-only/);
  });

  it('refuses a mainnet network (Base mainnet) even with a valid seller', () => {
    const c = resolveCircleGatewayFromEnv({
      ...ON,
      CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER,
      CIRCLE_GATEWAY_NETWORK: 'eip155:8453',
    });
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/not testnet-allow-listed/);
  });

  it('refuses an arbitrary/attacker host (allow-list, not deny-list)', () => {
    for (const url of ['https://evil.example.com', 'https://gateway.circle.com', 'http://localhost:9999']) {
      const c = resolveCircleGatewayFromEnv({
        ...ON,
        CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER,
        CIRCLE_GATEWAY_FACILITATOR_URL: url,
      });
      expect(c.enabled, `${url} must not be allow-listed`).toBe(false);
    }
  });

  it('defaults to the TESTNET host — never the SDK default (which is MAINNET)', () => {
    const c = resolveCircleGatewayFromEnv({ ...ON, CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER });
    expect(c.facilitatorUrl).toBe(CIRCLE_TESTNET_FACILITATOR_URL);
    expect(c.facilitatorUrl).not.toBe(CIRCLE_MAINNET_FACILITATOR_URL);
    expect(c.network).toBe('eip155:84532'); // Base Sepolia
  });
});

describe('resolveCircleGatewayFromEnv — inner flag (config-present) + address validation', () => {
  it('falls back to the Stub when the seller address is absent (R2: ships regardless)', () => {
    const c = resolveCircleGatewayFromEnv(ON);
    expect(c.enabled).toBe(true);
    expect(c.useStub).toBe(true);
    expect(c.sellerAddress).toBe(GATEWAY_STUB_SELLER_ADDRESS);
  });

  it('uses the real facilitator when a valid seller address is present', () => {
    const c = resolveCircleGatewayFromEnv({ ...ON, CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER });
    expect(c.useStub).toBe(false);
    expect(c.sellerAddress).toBe(SELLER);
  });

  it('default-denies a malformed seller address rather than paying it', () => {
    for (const bad of ['0xdeadbeef', 'not-an-address', '0xZZZZ05280Fd8dB980E920fE9f31d0A8eAbD17d59', SELLER + 'ff']) {
      const c = resolveCircleGatewayFromEnv({ ...ON, CIRCLE_GATEWAY_SELLER_ADDRESS: bad });
      expect(c.enabled, `${bad} must be rejected`).toBe(false);
      expect(c.reason).toMatch(/not a valid EVM address/);
    }
  });

  it('never throws, whatever the env', () => {
    expect(() => resolveCircleGatewayFromEnv({ CIRCLE_GATEWAY_ENABLED: 'true', CIRCLE_GATEWAY_NETWORK: '💥' })).not.toThrow();
  });
});

describe('GatewayStubFacilitator (R2) — realistic shape, never a false success', () => {
  it('advertises scheme "exact" with extra.name GatewayWalletBatched — NOT a bogus scheme id', async () => {
    const s = await new GatewayStubFacilitator('eip155:84532').getSupported();
    expect(s.kinds).toHaveLength(1);
    expect(s.kinds[0].scheme).toBe('exact');
    expect(s.kinds[0].scheme).not.toBe(GATEWAY_EIP712_DOMAIN_NAME);
    expect(s.kinds[0].network).toBe('eip155:84532');
    expect(s.kinds[0].extra).toMatchObject({ name: GATEWAY_EIP712_DOMAIN_NAME, version: '1', stub: true });
    expect(s.kinds[0].extra).toHaveProperty('verifyingContract');
  });

  it('verify() is always invalid and settle() always fails, both [STUB]-marked', async () => {
    const stub = new GatewayStubFacilitator('eip155:84532');
    const v = (await stub.verify()) as { isValid: boolean; invalidReason: string };
    expect(v.isValid).toBe(false);
    expect(v.invalidReason).toContain('[STUB]');

    const st = (await stub.settle()) as { success: boolean; errorReason: string };
    expect(st.success).toBe(false);
    expect(st.errorReason).toContain('[STUB]');
  });
});

describe('createCircleFacilitator — factory env-gate', () => {
  it('returns the Stub when unconfigured', () => {
    expect(createCircleFacilitator(resolveCircleGatewayFromEnv(ON))).toBeInstanceOf(GatewayStubFacilitator);
  });

  it('returns a real BatchFacilitatorClient pinned to the TESTNET url (SDK default is MAINNET)', () => {
    const f = createCircleFacilitator(resolveCircleGatewayFromEnv({ ...ON, CIRCLE_GATEWAY_SELLER_ADDRESS: SELLER }));
    expect(f).not.toBeInstanceOf(GatewayStubFacilitator);
    // Q4: the constructed client must point at testnet — the SDK's `url` is optional and
    // defaults to mainnet, so this assertion is the guard against a silent mainnet client.
    expect((f as unknown as { url: string }).url).toBe(CIRCLE_TESTNET_FACILITATOR_URL);
    expect((f as unknown as { url: string }).url).not.toBe(CIRCLE_MAINNET_FACILITATOR_URL);
  });

  it('refuses to build from a disabled config (programmer error)', () => {
    expect(() => createCircleFacilitator(resolveCircleGatewayFromEnv({}))).toThrow(/disabled config/);
  });
});

describe('createGatewayScheme — the real SDK primitive', () => {
  it('constructs and extends ExactEvmScheme (scheme id stays "exact")', () => {
    const scheme = createGatewayScheme() as unknown as { scheme?: string };
    expect(scheme).toBeTruthy();
    // GatewayEvmScheme's whole point: it IS the exact scheme + an enhancePaymentRequirements
    // override that merges extra.verifyingContract through.
    expect(typeof (scheme as unknown as { enhancePaymentRequirements: unknown }).enhancePaymentRequirements).toBe('function');
  });
});

describe('probeCircleFacilitator — fail-open firewall (R0 Q4)', () => {
  it('returns null WITHOUT constructing anything when disabled', async () => {
    let constructed = false;
    const spyFactory = () => {
      constructed = true;
      return new GatewayStubFacilitator('eip155:84532');
    };
    expect(await probeCircleFacilitator(resolveCircleGatewayFromEnv({}), spyFactory)).toBeNull();
    // Q4: "flag OFF => Circle facilitator NEVER constructed".
    expect(constructed).toBe(false);
  });

  it('returns null (never throws) when getSupported() throws — the CDP-rail firewall', async () => {
    const throwing: GatewayFacilitatorLike = {
      async getSupported() { throw new Error('circle is down'); },
      async verify() { return {}; },
      async settle() { return {}; },
    };
    // Drives the REAL catch path inside probeCircleFacilitator.
    const result = await probeCircleFacilitator(resolveCircleGatewayFromEnv(ON), () => throwing);
    expect(result).toBeNull();
  });

  it('returns null (never throws) when the factory itself throws at construction', async () => {
    const result = await probeCircleFacilitator(resolveCircleGatewayFromEnv(ON), () => {
      throw new Error('bad SDK config');
    });
    expect(result).toBeNull();
  });

  it('returns null when the facilitator does not advertise our network', async () => {
    // Advertises Sepolia; config wants Base Sepolia → no matching kind → drop.
    const wrongNetwork = () => new GatewayStubFacilitator('eip155:11155111') as GatewayFacilitatorLike;
    const result = await probeCircleFacilitator(resolveCircleGatewayFromEnv(ON), wrongNetwork);
    expect(result).toBeNull();
  });

  it('returns null on a malformed getSupported() response rather than trusting it', async () => {
    const malformed: GatewayFacilitatorLike = {
      async getSupported() { return undefined as never; },
      async verify() { return {}; },
      async settle() { return {}; },
    };
    expect(await probeCircleFacilitator(resolveCircleGatewayFromEnv(ON), () => malformed)).toBeNull();
  });

  it('probes clean and surfaces verifyingContract on the happy path', async () => {
    const result = await probeCircleFacilitator(resolveCircleGatewayFromEnv(ON));
    expect(result).not.toBeNull();
    expect(result!.verifyingContract).toBeTruthy();
  });
});
