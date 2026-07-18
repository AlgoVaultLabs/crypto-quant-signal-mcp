/**
 * Circle Gateway Nanopayments — ADDITIVE x402 payment scheme (CIRCLE-GATEWAY-MIGRATE-W1).
 *
 * This is NOT a migration and NOT a second rail. Circle Gateway is a payment *method* on
 * the SAME `exact` scheme our CDP rail already speaks — Circle's own facilitator advertises
 * `"scheme":"exact"` on every supported kind (live-probed 2026-07-17). What distinguishes a
 * Gateway kind from a CDP kind is the NETWORK plus `extra.name === 'GatewayWalletBatched'`
 * (the EIP-712 *domain name*) and `extra.verifyingContract`.
 *
 * >>> `GatewayWalletBatched` IS NOT AN x402 SCHEME ID. <<<
 * Anything asserting `accepts[].scheme === 'GatewayWalletBatched'` is wrong by construction.
 * (R0 probe: SDK `CIRCLE_BATCHING_SCHEME === 'exact'` while `CIRCLE_BATCHING_NAME ===
 * 'GatewayWalletBatched'`; Circle's seller quickstart shows `"scheme": "exact"`.)
 *
 * Integration shape = "Path B" (architect-ratified R0 Q2): the Circle facilitator joins the
 * EXISTING `x402ResourceServer`'s facilitator array and `GatewayEvmScheme` registers on the
 * Gateway network, so ONE 402 advertises both rails. The alternative (`createGatewayMiddleware`,
 * Circle's quickstart default) is a standalone Express middleware owning its own 402 and CANNOT
 * dual-advertise.
 *
 * SAFETY — why every failure path here is fail-open (R0 Q4, mandatory):
 * `x402ResourceServer.initialize()` fans `getSupported()` across EVERY facilitator in its array.
 * A throw propagates to x402.ts's catch, which sets `resourceServer = null` and disables payments
 * ENTIRELY — i.e. a Circle outage would take the LIVE CDP mainnet revenue rail dark with it. That
 * is the 2026-07-01 OKX crash-loop failure mode (system-map:284 — an uncaught async
 * `RouteConfigurationError` at boot 502'd api.algovault.com for ~1-2min). So: this module NEVER
 * throws into the boot path. It probes Circle in its OWN try/catch and, on ANY failure, returns
 * null → the caller keeps the CDP-only array byte-unchanged.
 *
 * Two-flag firewall:
 *   outer `CIRCLE_GATEWAY_ENABLED` (default OFF) → facilitator is NEVER constructed
 *   inner config-present (`CIRCLE_GATEWAY_SELLER_ADDRESS`) → absent falls back to the Stub
 */
import { BatchFacilitatorClient, GatewayEvmScheme } from '@circle-fin/x402-batching/server';

// ── Hosts ──

/** Circle Gateway testnet facilitator. Live-probed 2026-07-17 → HTTP 200. */
export const CIRCLE_TESTNET_FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';
/** Circle Gateway mainnet facilitator. NOT reachable from this wave — see MAINNET_BLOCKED. */
export const CIRCLE_MAINNET_FACILITATOR_URL = 'https://gateway-api.circle.com';

/**
 * Facilitator hosts this wave is ALLOWED to talk to. Allow-list, never deny-list.
 *
 * Two live traps this closes:
 *  1. `BatchFacilitatorConfig.url` is OPTIONAL and the SDK defaults it to MAINNET
 *     (`gateway-api.circle.com`) — `new BatchFacilitatorClient()` with no args silently points at
 *     mainnet, contradicting "mainnet stays OFF". We always pass `url` explicitly AND verify it.
 *  2. Circle's own `BatchFacilitatorClient` JSDoc example cites `https://gateway.circle.com`,
 *     which is NXDOMAIN (probed). Copying it verbatim yields a dead facilitator.
 */
const ALLOWED_FACILITATOR_URLS: readonly string[] = [CIRCLE_TESTNET_FACILITATOR_URL];

/** CAIP-2 networks this wave is ALLOWED to advertise. Testnet only (architect R0 Q5a). */
const ALLOWED_GATEWAY_NETWORKS: readonly string[] = [
  'eip155:84532', // Base Sepolia — our x402.ts already maps base-sepolia + holds the matching USDC
];

/** The `extra.name` Circle stamps on every Gateway kind — the EIP-712 domain name. */
export const GATEWAY_EIP712_DOMAIN_NAME = 'GatewayWalletBatched';

/** Marker prefix for stub-sourced values, so a stub can never be mistaken for a live rail. */
export const GATEWAY_STUB_PREFIX = '[STUB]';

/**
 * Seller address used when the Gateway is enabled but unconfigured (Stub path). Deliberately the
 * zero address: it is inert, obviously-not-real in logs, and can never receive value.
 */
export const GATEWAY_STUB_SELLER_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── Config resolution ──

export interface CircleGatewayConfig {
  /** Outer flag AND inner checks all passed — the scheme should be wired. */
  enabled: boolean;
  /** Facilitator base URL. Always explicit; never left to the SDK's mainnet default. */
  facilitatorUrl: string;
  /** CAIP-2 network the Gateway scheme advertises on. */
  network: string;
  /** Address receiving the Gateway seller balance. */
  sellerAddress: string;
  /** True when the real Circle config is absent and the Stub facilitator stands in (R2). */
  useStub: boolean;
  /** Human-readable reason when `enabled === false`. Surfaced in logs, never thrown. */
  reason?: string;
}

const DISABLED = (reason: string): CircleGatewayConfig => ({
  enabled: false,
  facilitatorUrl: CIRCLE_TESTNET_FACILITATOR_URL,
  network: ALLOWED_GATEWAY_NETWORKS[0],
  sellerAddress: '',
  useStub: false,
  reason,
});

/** Strict EVM address shape. Untrusted env → validate before it reaches payTo. */
const isEvmAddress = (v: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Resolve the Gateway config from env. Pure + total: it NEVER throws and NEVER constructs a
 * client — callers decide what to do with a disabled result.
 *
 * Default-deny at every step: an unset/typo'd flag, a bad address, a non-allow-listed host or
 * network all resolve to `enabled: false` with a reason, not to a permissive fallback.
 */
export function resolveCircleGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CircleGatewayConfig {
  // ── Outer flag ── default OFF. Anything but an exact 'true' keeps the rail inert.
  if ((env.CIRCLE_GATEWAY_ENABLED || '').toLowerCase() !== 'true') {
    return DISABLED('CIRCLE_GATEWAY_ENABLED is not "true" (default OFF)');
  }

  // ── Facilitator host ── explicit + allow-listed. Never inherit the SDK's mainnet default.
  const facilitatorUrl = env.CIRCLE_GATEWAY_FACILITATOR_URL || CIRCLE_TESTNET_FACILITATOR_URL;
  if (!ALLOWED_FACILITATOR_URLS.includes(facilitatorUrl)) {
    return DISABLED(
      `facilitator ${facilitatorUrl} is not testnet-allow-listed. This wave is testnet-only; ` +
        `enabling mainnet (${CIRCLE_MAINNET_FACILITATOR_URL}) is a separate dispatch after a real ` +
        `testnet settle + operator go.`,
    );
  }

  // ── Network ── testnet only.
  const network = env.CIRCLE_GATEWAY_NETWORK || ALLOWED_GATEWAY_NETWORKS[0];
  if (!ALLOWED_GATEWAY_NETWORKS.includes(network)) {
    return DISABLED(`network ${network} is not testnet-allow-listed (allowed: ${ALLOWED_GATEWAY_NETWORKS.join(', ')})`);
  }

  // ── Inner flag: config-present ── absent → Stub (R2: the wave ships regardless of Circle
  // account state). Present-but-malformed → default-deny rather than silently paying a bad addr.
  const rawSeller = (env.CIRCLE_GATEWAY_SELLER_ADDRESS || '').trim();
  if (!rawSeller) {
    return {
      enabled: true,
      facilitatorUrl,
      network,
      sellerAddress: GATEWAY_STUB_SELLER_ADDRESS,
      useStub: true,
      reason: 'CIRCLE_GATEWAY_SELLER_ADDRESS absent — Stub facilitator (no live Gateway settle)',
    };
  }
  if (!isEvmAddress(rawSeller)) {
    return DISABLED(`CIRCLE_GATEWAY_SELLER_ADDRESS is not a valid EVM address: ${rawSeller.slice(0, 10)}…`);
  }

  return { enabled: true, facilitatorUrl, network, sellerAddress: rawSeller, useStub: false };
}

// ── Facilitator surface ──

/**
 * The structural surface `x402ResourceServer` consumes from a facilitator. Declared locally so
 * the Stub can implement it without importing Circle's internal (non-exported) interface.
 */
export interface GatewayFacilitatorLike {
  verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
  settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<unknown>;
  getSupported(): Promise<{
    kinds: Array<{ x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }>;
    extensions: string[];
    signers: Record<string, string[]>;
  }>;
}

/**
 * Stub Circle facilitator (R2). Returns a realistic `getSupported()` shape — same field names,
 * same `scheme:'exact'`, same `extra.name`/`verifyingContract` keys as the live facilitator — so
 * the 402 `accepts[]` has the true shape without any Circle account.
 *
 * It NEVER validates a payment: `verify` returns invalid and `settle` returns failure, both
 * `[STUB]`-prefixed. A stub that "succeeded" would be a free-money bug.
 */
export class GatewayStubFacilitator implements GatewayFacilitatorLike {
  constructor(
    private readonly network: string,
    /** Shape-accurate placeholder; NOT the live GatewayWallet. Live value comes from Circle. */
    private readonly verifyingContract = '0x0000000000000000000000000000000000000000',
  ) {}

  async getSupported() {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact', // NOT 'GatewayWalletBatched' — see module header.
          network: this.network,
          extra: {
            name: GATEWAY_EIP712_DOMAIN_NAME,
            version: '1',
            verifyingContract: this.verifyingContract,
            stub: true,
          },
        },
      ],
      extensions: [] as string[],
      signers: {} as Record<string, string[]>,
    };
  }

  async verify() {
    return { isValid: false, invalidReason: `${GATEWAY_STUB_PREFIX} Circle Gateway stub cannot verify payments` };
  }

  async settle() {
    return {
      success: false,
      errorReason: `${GATEWAY_STUB_PREFIX} Circle Gateway stub cannot settle payments`,
      transaction: '',
      network: this.network,
    };
  }
}

// ── Factory ──

/**
 * Build the Circle facilitator for a resolved config. Stub when unconfigured, real
 * `BatchFacilitatorClient` (explicit testnet URL) otherwise.
 *
 * Throws only on programmer error (disabled config). Callers in the boot path must still wrap —
 * see `probeCircleFacilitator`.
 */
export function createCircleFacilitator(config: CircleGatewayConfig): GatewayFacilitatorLike {
  if (!config.enabled) {
    throw new Error('createCircleFacilitator called with a disabled config');
  }
  if (config.useStub) {
    return new GatewayStubFacilitator(config.network);
  }
  // `url` is ALWAYS passed: the SDK's default is MAINNET (BatchFacilitatorConfig.url is optional).
  return new BatchFacilitatorClient({ url: config.facilitatorUrl }) as unknown as GatewayFacilitatorLike;
}

/** The Gateway server scheme. Extends ExactEvmScheme; merges `extra.verifyingContract` through. */
export function createGatewayScheme(): GatewayEvmScheme {
  return new GatewayEvmScheme();
}

/**
 * Construct + liveness-probe the Circle facilitator, fail-open (R0 Q4).
 *
 * Returns null on ANY failure — construction, network error, a facilitator that doesn't advertise
 * our network, or a malformed response. Null means "carry on with CDP only, byte-unchanged".
 * This function is the boot-path firewall: it must never throw, so a Circle outage can never
 * reach x402.ts's `resourceServer = null` catch and take the live CDP rail down with it.
 */
export async function probeCircleFacilitator(
  config: CircleGatewayConfig,
  /** Injectable for tests — lets a suite drive the real catch path with a throwing facilitator. */
  factory: (c: CircleGatewayConfig) => GatewayFacilitatorLike = createCircleFacilitator,
): Promise<{ facilitator: GatewayFacilitatorLike; verifyingContract?: string } | null> {
  if (!config.enabled) return null;
  try {
    const facilitator = factory(config);
    const supported = await facilitator.getSupported();
    const kind = supported?.kinds?.find(
      (k) => k.network === config.network && k.scheme === 'exact',
    );
    if (!kind) {
      console.warn(
        `circle-gateway: facilitator ${config.facilitatorUrl} does not advertise exact on ` +
          `${config.network} — Gateway scheme NOT registered; CDP rail unaffected.`,
      );
      return null;
    }
    return { facilitator, verifyingContract: kind.extra?.verifyingContract as string | undefined };
  } catch (err) {
    // Fail-open, always. A Circle problem is never allowed to become a CDP problem.
    console.warn(
      'circle-gateway: probe failed — Gateway scheme NOT registered; CDP rail unaffected:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
