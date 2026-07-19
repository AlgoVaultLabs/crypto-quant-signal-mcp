/**
 * x402 Payment Verification — USDC on Base chain.
 *
 * Uses the official @x402/core SDK with the Coinbase Facilitator
 * for real on-chain ERC-3009 signature verification and settlement.
 *
 * Flow:
 * 1. Agent sends HTTP request without payment
 * 2. Server responds 402 with PaymentRequired (price, asset, network, recipient)
 * 3. Agent signs ERC-3009 transferWithAuthorization and attaches the payload to the
 *    `Payment-Signature` header (x402 v2, canonical) or `x-payment` (v1) — both accepted
 * 4. Server verifies signature via Facilitator (~100ms)
 * 5. Server responds immediately, settles on-chain asynchronously (~2s)
 *
 * Graceful degradation: if X402_WALLET_ADDRESS is not set, x402 tier is
 * skipped entirely and the server falls through to API key / free tiers.
 */
import { x402ResourceServer } from '@x402/core/server';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import type { X402ToolPricing } from '../types.js';
import { createFacilitatorClient, resolveFacilitatorFromEnv } from './x402-facilitator.js';
import { declareBazaarRoute } from './x402-bazaar.js';
import { FEATURE_REGISTRY, getFeature } from './feature-registry.js';
import {
  GATEWAY_EIP712_DOMAIN_NAME,
  gatewayRequirementsCarryDomain,
  createGatewayScheme,
  probeCircleFacilitator,
  resolveCircleGatewayFromEnv,
  type CircleGatewayConfig,
  type GatewayFacilitatorLike,
} from './circle-gateway.js';

// ── Configuration ──

const WALLET_ADDRESS = process.env.X402_WALLET_ADDRESS || '';
const NETWORK = process.env.X402_NETWORK || 'base-mainnet';
// Facilitator target (legacy self-hosted sidecar vs CDP) is resolved by the
// FacilitatorAdapter from X402_FACILITATOR / X402_FACILITATOR_URL / CDP_API_KEY_*.
// NOTE: prod's legacy facilitator is the self-hosted sidecar (X402_FACILITATOR_URL=
// http://facilitator:4022), NOT the public x402.org facilitator (live-probed 2026-05-29).

// CAIP-2 chain IDs
const CAIP2: Record<string, string> = {
  'base-mainnet': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};
const CAIP2_NETWORK = CAIP2[NETWORK] || 'eip155:8453';

// USDC contract addresses
const USDC_ADDRESS: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

// USDC EIP-712 domain name differs by network (the on-chain `name()`): Base MAINNET
// USDC = "USD Coin", Base SEPOLIA USDC = "USDC". The buyer signs the ERC-3009
// transferWithAuthorization against this exact domain — a wrong name makes the on-chain
// call REVERT at verify (CDP facilitator: "invalid_payload: execution reverted").
// Verified on-chain 2026-06-01 (X402-BAZAAR-HTTP-REDECLARE-W1, caught during the mainnet
// bootstrap; Sepolia proof passed only because Sepolia USDC is coincidentally "USDC").
const USDC_EIP712_NAME: Record<string, string> = {
  'eip155:8453': 'USD Coin',
  'eip155:84532': 'USDC',
};
const usdcExtra = (caip2: string) => ({ name: USDC_EIP712_NAME[caip2] || 'USD Coin', version: '2' });

// Tool pricing in USD (base price — timeframe-tiered pricing applied at request time).
// FEATURE-REGISTRY-SOT-W1 CH3: DERIVED from the feature registry (the SoT) instead of being
// hand-maintained. For each priced feature we emit a key for BOTH the canonical name AND every
// alias, so the canonical `get_trade_call` AND its back-compat alias `get_trade_signal` both
// price-resolve to the feature's $0.02 — closing the canonical-key gap (previously ONLY the
// alias `get_trade_signal` had a key, so a canonical-name payment found no price). The 3
// pre-existing keys (`get_trade_signal`/`scan_funding_arb`/`get_market_regime`) keep IDENTICAL
// values; the ONLY delta is the ADDITIVE canonical `get_trade_call` key (architect A3). Scanner
// + equity stay unpriced (registry `x402:null`) — pricing them is a one-row registry edit.
// IMPORTANT: this map is the price-RESOLUTION source. The *gated* + Bazaar-discoverable route
// set is still `HTTP_TOOLS`/`BAZAAR_ROUTES` (alias-keyed `get_trade_signal`, ratified Cowork A2
// 2026-05-29: `get_trade_call` is intentionally FREE + non-discoverable). Adding the canonical
// key here does NOT gate `get_trade_call` — the MCP gate keys off `HTTP_TOOLS` (index.ts), so a
// free caller still calls `get_trade_call` for free; it merely lets a *voluntary* canonical-name
// payment proof verify. Free-tier generosity (A2) and the canonical-key closure (A3) coexist.
export const TOOL_PRICING: X402ToolPricing = Object.fromEntries(
  FEATURE_REGISTRY.flatMap((f) =>
    f.x402 ? [f.name, ...f.aliases].map((n) => [n, f.x402!.basePriceUsd] as const) : [],
  ),
) as unknown as X402ToolPricing;

// Timeframe-specific pricing for get_trade_signal
export const SIGNAL_TIMEFRAME_PRICING: Record<string, number> = {
  '1m': 0.05,   // premium — HFT scalping
  '3m': 0.04,   // premium — HFT scalping
  '5m': 0.03,   // high demand, frequent use
  '15m': 0.02,  // standard
  '30m': 0.02,  // standard
  '1h': 0.02,   // standard
  '2h': 0.02,   // standard
  '4h': 0.02,   // standard
  '8h': 0.02,   // standard
  '12h': 0.02,  // standard
  '1d': 0.02,   // standard
};

// ── Singleton state ──

let resourceServer: x402ResourceServer | null = null;
let toolRequirements: Map<string, unknown[]> = new Map();
let initialized = false;
/**
 * Resolved Circle Gateway config when the additive scheme is LIVE on this process, else null.
 * Null is the default and the fallback for every Gateway failure — see circle-gateway.ts.
 */
let gatewayActive: CircleGatewayConfig | null = null;

/** Test seam: which Gateway config (if any) the last initX402() actually wired. */
export function _getActiveGatewayForTest(): CircleGatewayConfig | null {
  return gatewayActive;
}

// ── Result types ──

/**
 * Why a verification attempt did NOT yield `valid: true`.
 *
 * OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1: the parent wave (Circle Gateway testnet settle)
 * lost a debugging cycle because every rejection path returned a bare `{ valid: false }` —
 * making "we never saw a payment header", "the vendor rejected the signature" and "our
 * credentials are wrong" indistinguishable from the outside. An UNPAID request and a
 * MALFORMED-dialect request looked identical. Naming each branch is what makes a future
 * wire-protocol mismatch diagnosable instead of invisible.
 *
 * Purely additive — no existing consumer reads this field.
 */
export type X402RejectReason =
  | 'not_configured'        // resource server absent / initX402 never ran
  | 'no_payment_header'     // neither v2 Payment-Signature nor v1 x-payment present
  | 'decode_failed'         // header present but neither base64-v2 nor raw-JSON-v1 decoded
  | 'no_matching_requirement' // decoded, but matched no pre-built requirement for this tool
  | 'facilitator_invalid'   // facilitator verified and rejected (bad signature, funds, nonce)
  | 'verify_error';         // unexpected throw

export interface X402VerificationResult {
  valid: boolean;
  paidAmount?: number;
  payer?: string;
  /** Which dialect the proof arrived in — observability only. */
  dialect?: 'v2-payment-signature' | 'v1-x-payment';
  /** Set whenever `valid === false`. Additive; no consumer reads it yet. */
  rejectReason?: X402RejectReason;
  /** Opaque refs needed for async settlement */
  _settlement?: { paymentPayload: unknown; requirements: unknown };
}

// ── Initialization ──

/**
 * Initialize the x402 resource server. Call once at startup.
 * No-ops if x402 is not configured.
 */
export async function initX402(): Promise<void> {
  if (!isX402Configured()) return;
  if (initialized) return;

  // FacilitatorAdapter: two-flag firewall (X402_FACILITATOR / BAZAAR_DISCOVERABLE),
  // stub-first fallback to legacy when CDP keys are absent. Default = legacy
  // (self-hosted sidecar), byte-identical to pre-wave behavior.
  const resolvedFacilitator = resolveFacilitatorFromEnv();
  let facilitator;
  try {
    facilitator = createFacilitatorClient(resolvedFacilitator);
  } catch (err) {
    console.warn('x402: Failed to create facilitator client:', err instanceof Error ? err.message : err);
    return;
  }
  // Register a server-side scheme for USDC price parsing on the target network.
  // The facilitator handles actual cryptographic verification — the server scheme
  // only needs to convert "$0.02" to { amount: "20000", asset: "0x..." }.
  const usdcAddress = USDC_ADDRESS[CAIP2_NETWORK];
  const caip2 = CAIP2_NETWORK as `${string}:${string}`;
  const cdpExactScheme = {
    scheme: 'exact',
    async parsePrice(price: string | number | { amount: string; asset: string }) {
      let usdAmount: number;
      if (typeof price === 'string' && price.startsWith('$')) {
        usdAmount = parseFloat(price.slice(1));
      } else if (typeof price === 'number') {
        usdAmount = price;
      } else if (typeof price === 'object' && 'amount' in price) {
        return { amount: price.amount, asset: price.asset };
      } else {
        usdAmount = parseFloat(String(price));
      }
      const atomicAmount = Math.round(usdAmount * 1_000_000).toString();
      return { amount: atomicAmount, asset: usdcAddress };
    },
    getAssetDecimals() { return 6; },
    async enhancePaymentRequirements(reqs: unknown) { return reqs; },
  };

  // CIRCLE-GATEWAY-MIGRATE-W1 (additive, default OFF). `probeCircleFacilitator` constructs
  // NOTHING when the flag is off and is fail-open on every error → `gateway` stays null and every
  // line below behaves exactly as it did pre-wave.
  const gatewayConfig = resolveCircleGatewayFromEnv();
  const gatewayProbe = await probeCircleFacilitator(gatewayConfig);

  /**
   * Build the resource server. `gateway = null` reproduces the pre-wave sequence byte-for-byte
   * (single facilitator, same registration order) — that exactness is what lets the Q4 fail-open
   * path below retry CDP-only and land in provably pre-wave state.
   */
  const buildResourceServer = (
    facilitators: unknown,
    gateway: { config: CircleGatewayConfig; facilitator: GatewayFacilitatorLike } | null,
  ): x402ResourceServer => {
    const srv = new x402ResourceServer(facilitators as ConstructorParameters<typeof x402ResourceServer>[0]);

    // Register the CDP Bazaar discovery extension only on the cdp + discoverable path.
    // Earns the Bazaar listing when a real settle completes through CDP carrying the
    // discovery metadata (the EXTENSION-RESPONSES header confirms acceptance).
    if (resolvedFacilitator.discoveryEnabled) {
      try {
        srv.registerExtension(bazaarResourceServerExtension);
      } catch (err) {
        console.warn('x402: Failed to register Bazaar discovery extension:', err instanceof Error ? err.message : err);
      }
    }

    srv.register(caip2, cdpExactScheme as Parameters<typeof srv.register>[1]);

    // Additive: the Gateway scheme registers on its OWN network key (testnet eip155:84532) — the
    // CDP registration above is on eip155:8453, so there is no collision. GatewayEvmScheme extends
    // ExactEvmScheme and merges the facilitator's `extra` (verifyingContract / name) through, which
    // is what makes the buyer's EIP-712 domain resolvable.
    if (gateway) {
      srv.register(
        gateway.config.network as `${string}:${string}`,
        createGatewayScheme() as unknown as Parameters<typeof srv.register>[1],
      );
    }
    return srv;
  };

  resourceServer = buildResourceServer(
    gatewayProbe ? [facilitator, gatewayProbe.facilitator] : facilitator,
    gatewayProbe ? { config: gatewayConfig, facilitator: gatewayProbe.facilitator } : null,
  );
  gatewayActive = gatewayProbe ? gatewayConfig : null;

  try {
    await resourceServer.initialize();
  } catch (err) {
    // Q4 fail-open (R0, architect-ratified): initialize() fans getSupported() across EVERY
    // facilitator, so a Circle fault would otherwise fall through to the CDP-killing path below
    // and take the LIVE mainnet revenue rail dark (the 2026-07-01 OKX crash-loop shape,
    // system-map:284). Drop the Gateway and retry CDP-only BEFORE giving up.
    if (gatewayProbe) {
      console.warn(
        'x402: initialize() failed with the Circle Gateway facilitator present — dropping Gateway ' +
        'and retrying CDP-only:', err instanceof Error ? err.message : err,
      );
      gatewayActive = null;
      resourceServer = buildResourceServer(facilitator, null);
      try {
        await resourceServer.initialize();
      } catch (retryErr) {
        console.warn('x402: Failed to initialize resource server (facilitator unreachable?):', retryErr instanceof Error ? retryErr.message : retryErr);
        console.warn('x402: Payments disabled — server will operate on free/API-key tiers only.');
        resourceServer = null;
        return;
      }
    } else {
      console.warn('x402: Failed to initialize resource server (facilitator unreachable?):', err instanceof Error ? err.message : err);
      console.warn('x402: Payments disabled — server will operate on free/API-key tiers only.');
      resourceServer = null;
      return;
    }
  }

  // The Gateway kind must survive the resource server's own view too — if initialize() didn't
  // pick it up, advertising it would produce an accepts[] entry no client could satisfy. Dropping
  // it here leaves the CDP rail exactly as it was.
  if (gatewayActive) {
    const gatewaySupported = resourceServer.getSupportedKind(
      2,
      gatewayActive.network as `${string}:${string}`,
      'exact',
    );
    if (!gatewaySupported) {
      console.warn(
        `x402: Circle Gateway kind (exact on ${gatewayActive.network}) not present after initialize() — ` +
        'Gateway NOT advertised; CDP rail unaffected.',
      );
      gatewayActive = null;
    }
  }

  // Check if the facilitator supports our network
  const supported = resourceServer.getSupportedKind(2, caip2, 'exact');
  if (!supported) {
    console.warn(
      `x402: Facilitator does not support exact on ${CAIP2_NETWORK}. ` +
      `x402 payments disabled. Use X402_NETWORK=base-sepolia for testing, ` +
      `or set X402_FACILITATOR_URL to a facilitator that supports mainnet.`,
    );
    resourceServer = null;
    return;
  }

  // Pre-build payment requirements for each priced tool NAME (canonical + aliases — TOOL_PRICING
  // now derives from the registry). FEATURE-REGISTRY-SOT-W1 CH3: the additive canonical
  // `get_trade_call` key thus gains a verifiable requirement (a canonical-name proof now resolves;
  // it previously found none), BUT `declareBazaarRoute('get_trade_call')` returns `{}` (no
  // BAZAAR_ROUTES entry) → no discovery extension → the CDP Bazaar listing stays the 3 ratified
  // routes. MCP gating is unaffected (it keys off HTTP_TOOLS, not this loop).
  try {
    for (const [tool, price] of Object.entries(TOOL_PRICING)) {
      const resourceConfig: Parameters<typeof resourceServer.buildPaymentRequirements>[0] = {
        scheme: 'exact',
        network: caip2,
        payTo: WALLET_ADDRESS,
        price: `$${price}`,
        extra: usdcExtra(CAIP2_NETWORK),
      };
      // Attach CDP Bazaar discovery metadata so a real settle earns the listing.
      if (resolvedFacilitator.discoveryEnabled) {
        const extensions = declareBazaarRoute(tool);
        if (Object.keys(extensions).length > 0) {
          (resourceConfig as { extensions?: Record<string, unknown> }).extensions = extensions;
        }
      }
      const reqs = await resourceServer.buildPaymentRequirements(resourceConfig);

      // ADDITIVE: append the Gateway option as EXTRA accepts[] entries. The CDP `reqs` above are
      // untouched, so flag-OFF yields a byte-identical accepts[]. Note there is no second price
      // source — `price` is the same resolved value from the single TOOL_PRICING SoT, and `extra`
      // is deliberately NOT hand-set: GatewayEvmScheme.enhancePaymentRequirements merges the
      // facilitator's own `name`/`verifyingContract` in, which is the only way the buyer can build
      // the right EIP-712 domain.
      if (gatewayActive) {
        try {
          const gatewayReqs = await resourceServer.buildPaymentRequirements({
            scheme: 'exact', // Gateway IS `exact`; `GatewayWalletBatched` is extra.name, not a scheme.
            network: gatewayActive.network as `${string}:${string}`,
            payTo: gatewayActive.sellerAddress,
            price: `$${price}`,
          } as Parameters<typeof resourceServer.buildPaymentRequirements>[0]);

          // CIRCLE-GATEWAY-MAINNET-ENABLE-W1 R1b — structural backstop. A successful build is NOT
          // proof the Gateway scheme served it: if GatewayEvmScheme was silently dropped (which is
          // what `register()`'s first-wins guard does whenever Gateway shares a network with CDP),
          // this call still returns entries — plain CDP-shaped payments to the seller address with
          // `extra = {}`, unpayable by any Gateway client. Only the EIP-712 domain distinguishes
          // the two, so assert it and fail-open rather than advertise an unpayable rail.
          if (!gatewayRequirementsCarryDomain(gatewayReqs)) {
            console.warn(
              `x402: Circle Gateway requirements for ${tool} lack the ${GATEWAY_EIP712_DOMAIN_NAME} ` +
              `EIP-712 domain (network=${gatewayActive.network}) — the Gateway scheme did NOT serve ` +
              'this build (scheme collision?). Gateway entry DROPPED; CDP entry retained.',
            );
            gatewayActive = null; // stop claiming ACTIVE in the startup log + later 402s
          } else {
            reqs.push(...gatewayReqs);
          }
        } catch (err) {
          console.warn(
            `x402: Failed to build Circle Gateway requirements for ${tool} — CDP entry retained:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      toolRequirements.set(tool, reqs);
    }
  } catch (err) {
    console.warn('x402: Failed to build payment requirements:', err instanceof Error ? err.message : err);
    console.warn('x402: Payments disabled — server will operate on free/API-key tiers only.');
    resourceServer = null;
    return;
  }

  initialized = true;
  console.log(
    `x402 initialized: network=${NETWORK} facilitator=${resolvedFacilitator.effectiveChoice} ` +
    `discovery=${resolvedFacilitator.discoveryEnabled} wallet=${WALLET_ADDRESS.slice(0, 6)}...`,
  );
  if (gatewayActive) {
    console.log(
      `x402: Circle Gateway scheme ACTIVE (additive) — network=${gatewayActive.network} ` +
      `facilitator=${gatewayActive.facilitatorUrl}${gatewayActive.useStub ? ' [STUB]' : ''} ` +
      `seller=${gatewayActive.sellerAddress.slice(0, 6)}...`,
    );
  } else if (gatewayConfig.reason) {
    // Never an error: default-OFF is the expected steady state.
    console.log(`x402: Circle Gateway scheme inactive — ${gatewayConfig.reason}`);
  }
}

// ── Verification ──

/**
 * Decode an x402 payment header into its PaymentPayload, accepting BOTH wire dialects.
 *
 * OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1. Two dialects exist in the wild:
 *
 *   - **base64** — what `@x402/core`'s own client emits for BOTH versions
 *     (`encodePaymentSignatureHeader` = `safeBase64Encode(JSON.stringify(p))`); only the
 *     header NAME differs by version (v2 `PAYMENT-SIGNATURE`, v1 `X-PAYMENT`). Circle's
 *     `GatewayClient` also base64-encodes. This is the STANDARD.
 *   - **raw JSON** — the non-standard dialect this server historically required, because
 *     verification was a bare `JSON.parse`. The live CDP/operator-harness clients emit it
 *     deliberately to match (see algovault-x402-settle/settle.mjs).
 *
 * Dispatching on SHAPE is provably unambiguous, which is what makes accepting both safe:
 * raw JSON always fails the SDK's `Base64EncodedRegex` (it starts `{`, not a base64 char),
 * and base64 always fails `JSON.parse`. Neither dialect can be mistaken for the other, so
 * no currently-accepted input changes path. Pinned by a test in
 * tests/x402-v2-payment-signature.test.ts so a future SDK change can't silently break it.
 *
 * Exported so the dialect logic is unit-testable without booting the server.
 *
 * @throws if the value is neither valid base64-wrapped JSON nor raw JSON.
 */
export function decodeX402PaymentHeader(raw: string): unknown {
  try {
    // Base64 (standard, both versions) — the SDK validates the charset then JSON-parses.
    return decodePaymentSignatureHeader(raw);
  } catch {
    // Raw JSON (the dialect the live rail sends today). Throws on garbage → caller maps
    // it to `decode_failed` rather than swallowing it as "unpaid".
    return JSON.parse(raw);
  }
}

/**
 * Verify an x402 payment proof from the payment header.
 *
 * Accepts x402 **v2** `Payment-Signature` (canonical — every v2 client, incl. Circle's
 * `GatewayClient`) and x402 **v1** `x-payment` (back-compat with the live CDP rail).
 * v2 is read first, per official x402 migration guidance. Node lowercases inbound header
 * names and both entrypoints pass Express `req.headers`, so the lowercase lookups are the
 * load-bearing ones; the `X-Payment` variant is kept for non-Express callers.
 *
 * Returns verification result with settlement refs for async settle.
 */
export async function verifyX402Payment(
  headers: Record<string, string | undefined>,
  toolName?: string,
): Promise<X402VerificationResult> {
  if (!resourceServer || !initialized) {
    return { valid: false, rejectReason: 'not_configured' };
  }

  const v2Header = headers['payment-signature'] || headers['Payment-Signature'];
  const v1Header = headers['x-payment'] || headers['X-Payment'];
  const paymentHeader = v2Header || v1Header;
  if (!paymentHeader) {
    return { valid: false, rejectReason: 'no_payment_header' };
  }
  const dialect = v2Header ? 'v2-payment-signature' as const : 'v1-x-payment' as const;

  let paymentPayload: unknown;
  try {
    paymentPayload = decodeX402PaymentHeader(paymentHeader);
  } catch (err) {
    // Distinct from `no_payment_header`: a client DID present a proof, we just couldn't
    // read it. This is the branch that stayed silent through the whole v1/v2 defect.
    console.warn(
      `x402 verify: ${dialect} header present but undecodable — ` +
      `${err instanceof Error ? err.message : err}`,
    );
    return { valid: false, dialect, rejectReason: 'decode_failed' };
  }

  try {
    // X402-01 (generator-level hardening): when the caller names the target tool,
    // match the proof against ONLY that tool's pre-built requirement — never the
    // flattened cross-tool pool. This binds the proof to the requested route's
    // price/asset/network/payTo so a $0.01 proof can't deep-equal a $0.02 route's
    // requirement. Callers that pass no toolName (e.g. the shared `resolveLicense`
    // gate) still match against the flattened pool, but the HTTP route then
    // re-asserts the binding via `paymentMatchesToolRoute` (defense-in-depth).
    const candidateReqs = toolName
      ? (toolRequirements.get(toolName) ?? [])
      : Array.from(toolRequirements.values()).flat();
    const typedPayload = paymentPayload as Parameters<typeof resourceServer.verifyPayment>[0];
    const matchingReqs = resourceServer.findMatchingRequirements(
      candidateReqs as Parameters<typeof resourceServer.findMatchingRequirements>[0],
      typedPayload,
    );

    if (!matchingReqs) {
      console.warn(`x402 verify: ${dialect} proof matched no requirement for tool=${toolName ?? '(flattened pool)'}`);
      return { valid: false, dialect, rejectReason: 'no_matching_requirement' };
    }

    // Verify via Facilitator (fast, ~100ms)
    const verifyResult = await resourceServer.verifyPayment(typedPayload, matchingReqs);

    if (!verifyResult.isValid) {
      console.warn(`x402 verify failed [${dialect}]: ${verifyResult.invalidReason} — ${verifyResult.invalidMessage}`);
      return { valid: false, dialect, rejectReason: 'facilitator_invalid' };
    }

    return {
      valid: true,
      dialect,
      payer: verifyResult.payer,
      _settlement: { paymentPayload, requirements: matchingReqs },
    };
  } catch (err) {
    console.error(`x402 verify error [${dialect}]:`, err instanceof Error ? err.message : err);
    return { valid: false, dialect, rejectReason: 'verify_error' };
  }
}

// ── Settlement (fire-and-forget) ──

/**
 * Settle a verified payment asynchronously. Call after responding to the client.
 * Logs success/failure for reconciliation — does not throw.
 */
export function settleX402Async(settlement: { paymentPayload: unknown; requirements: unknown }): void {
  if (!resourceServer) return;

  resourceServer
    .settlePayment(
      settlement.paymentPayload as Parameters<typeof resourceServer.settlePayment>[0],
      settlement.requirements as Parameters<typeof resourceServer.settlePayment>[1],
    )
    .then((result) => {
      if (result.success) {
        console.log(`x402 settled: tx=${result.transaction} payer=${result.payer}`);
      } else {
        console.error(`x402 settle failed: ${result.errorReason} — ${result.errorMessage}`);
      }
    })
    .catch((err) => {
      console.error('x402 settle error:', err instanceof Error ? err.message : err);
    });
}

// ── 402 Response Generation ──

/**
 * Generate a 402 Payment Required response body per x402 v2 spec.
 */
export function generate402Response(
  toolName: string,
  opts?: { resourceUrl?: string; description?: string; includeExtensions?: boolean },
): {
  status: number;
  body: Record<string, unknown>;
} {
  const resourceUrl = opts?.resourceUrl ?? `/mcp`;
  const description = opts?.description ?? `Payment for ${toolName} tool call`;
  // X402-BAZAAR-HTTP-REDECLARE-W1: the HTTP x402 routes pass includeExtensions=true so
  // the 402 carries resource.url (the listed HTTP route) + extensions.bazaar. The buyer's
  // x402 client copies these into the payment payload; CDP reads them on /settle and
  // catalogs the route — this is the channel that EARNS the Bazaar listing (MCP-type
  // lacked it from the public catalog). Default (no opts) = byte-identical prior behavior.
  const extensions = opts?.includeExtensions ? declareBazaarRoute(toolName) : {};
  const extBlock = Object.keys(extensions).length > 0 ? { extensions } : {};
  const resource = { url: resourceUrl, description, mimeType: 'application/json' };

  const reqs = toolRequirements.get(toolName);

  // If x402 is initialized and we have pre-built requirements, use them
  if (reqs && reqs.length > 0) {
    return {
      status: 402,
      body: {
        x402Version: 2,
        error: 'Payment Required',
        resource,
        accepts: reqs,
        ...extBlock,
      },
    };
  }

  // Fallback: return static requirements (x402 not initialized)
  const price = TOOL_PRICING[toolName as keyof X402ToolPricing] ?? 0.02;
  const usdcDecimals = 6;
  const atomicAmount = Math.round(price * 10 ** usdcDecimals).toString();

  return {
    status: 402,
    body: {
      x402Version: 2,
      error: 'Payment Required',
      resource,
      accepts: [
        {
          scheme: 'exact',
          network: CAIP2_NETWORK,
          asset: USDC_ADDRESS[CAIP2_NETWORK],
          amount: atomicAmount,
          payTo: WALLET_ADDRESS || 'not_configured',
          maxTimeoutSeconds: 300,
          extra: usdcExtra(CAIP2_NETWORK),
        },
      ],
      ...extBlock,
    },
  };
}

/**
 * OPS-X402-MCP-PRICE-BINDING-W1: build the JSON-RPC `X402_PAYMENT_REQUIRED`
 * tool-result-error the `/mcp` handler returns when a priced `tools/call` presented
 * an x402 proof that was NOT honored (cross-tool / underpaid / replayed) AND the
 * caller's free-tier quota is exhausted. The error carries the CALLED tool's payment
 * requirements (`generate402Response(tool).accepts` → exact amount / asset / network
 * / payTo) so the agent can resubmit a CORRECT payment — not the generic quota error.
 *
 * The shape matches what the MCP SDK emits for an error thrown inside a tool handler:
 * a transport-level success carrying `{ result: { content:[text], isError:true } }`
 * (the same in-band tool-result-error shape `toolErrorContent` produces, wrapped in
 * the JSON-RPC envelope) so the model SEES the error and can self-correct, per the
 * MCP spec. The handler emits this as a SHORT-CIRCUIT (it does NOT dispatch to the
 * transport), so this returns the full JSON-RPC response object. Additive helper —
 * does not change any existing exported behavior.
 */
export function buildX402PaymentRequiredResult(
  tool: string,
  reason: 'cross_tool' | 'insufficient' | 'replayed',
  id: unknown,
): {
  jsonrpc: '2.0';
  id: unknown;
  result: { content: { type: 'text'; text: string }[]; isError: true };
} {
  const accepts = (generate402Response(tool).body as { accepts?: unknown }).accepts ?? [];
  const suggested_action =
    reason === 'replayed'
      ? 'This payment proof was already used. Submit a fresh x402 payment for this tool (see paymentRequirements).'
      : reason === 'cross_tool'
        ? `The payment proof does not match ${tool}'s price/asset/recipient. Submit an x402 payment for this tool (see paymentRequirements).`
        : `The payment proof underpays ${tool}'s price for this request. Submit an x402 payment meeting paymentRequirements.`;
  const errorPayload = {
    error: 'X402_PAYMENT_REQUIRED',
    code: 'X402_PAYMENT_REQUIRED',
    reason,
    message: `Payment required for ${tool}: the x402 proof presented was not honored (${reason}) and the free-tier quota is exhausted.`,
    paymentRequirements: accepts,
    suggested_action,
  };
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text' as const, text: JSON.stringify(errorPayload) }],
      isError: true,
    },
  };
}

// ── Helpers ──

/**
 * Check if x402 is configured (wallet address set).
 */
export function isX402Configured(): boolean {
  return WALLET_ADDRESS.length > 0;
}

/** Convert a USD price to atomic USDC units (6 decimals), as a string. */
function usdToAtomic(usd: number): string {
  return Math.round(usd * 1_000_000).toString();
}

/**
 * X402-03: the effective USD price for a tool call, accounting for the
 * per-timeframe premium. `SIGNAL_TIMEFRAME_PRICING` (e.g. 1m=$0.05) was declared
 * but never enforced — only the base `TOOL_PRICING` ($0.02) was. The premium
 * applies to `get_trade_signal` (the only timeframe-priced tool); every other
 * tool, and any timeframe without a premium entry, falls back to the base price.
 * Returns `undefined` for an unknown tool.
 */
export function effectivePrice(toolName: string, timeframe?: string): number | undefined {
  const base = TOOL_PRICING[toolName as keyof X402ToolPricing];
  if (base === undefined) return undefined;
  // FEATURE-REGISTRY-SOT-W1 CH3: the timeframe premium applies to the trade-call FEATURE,
  // addressed by EITHER its canonical name `get_trade_call` OR its back-compat alias
  // `get_trade_signal`. Alias-resolve via the registry so both names price IDENTICALLY
  // (previously only the literal `get_trade_signal` got the premium; the canonical name
  // silently fell back to base — the same keying gap CH3 closes for the base price).
  if (timeframe && getFeature(toolName)?.name === 'get_trade_call') {
    const premium = SIGNAL_TIMEFRAME_PRICING[timeframe];
    if (premium !== undefined) return Math.max(premium, base);
  }
  return base;
}

/**
 * Check that the paid amount (atomic USDC units) covers the tool's effective
 * price for the requested timeframe (X402-01 amount check + X402-03 premium).
 * Now LIVE — wired into `paymentMatchesToolRoute` below (previously dead code,
 * the gap that let the cross-tool downgrade through).
 */
export function isPaymentSufficient(
  toolName: string,
  paidAtomic: string | undefined,
  timeframe?: string,
): boolean {
  if (paidAtomic === undefined) return false;
  const price = effectivePrice(toolName, timeframe);
  if (price === undefined) return false;
  const paid = Number(paidAtomic);
  if (!Number.isFinite(paid)) return false;
  return paid >= Number(usdToAtomic(price));
}

/**
 * OPS-MCP-DEFENSE-IN-DEPTH-W1 R1: read the buyer's SIGNED atomic amount directly
 * from the payment payload — `payload.authorization.value` (EIP-3009
 * transferWithAuthorization, the configured USDC/exact scheme), then
 * `payload.permit2Authorization.value` (Permit2), then a defensive un-nested
 * fallback. Mirrors `extractPaymentNonce`'s dual-shape read in
 * x402-idempotency-store.ts (same payload family, same strict string-only
 * acceptance). Returns `undefined` on absent/malformed → callers default-deny.
 */
export function extractSignedAuthorizationValue(paymentPayload: unknown): string | undefined {
  if (!paymentPayload || typeof paymentPayload !== 'object') return undefined;
  const p = paymentPayload as {
    payload?: {
      authorization?: { value?: unknown };
      permit2Authorization?: { value?: unknown };
    };
    authorization?: { value?: unknown };
  };
  const candidates = [
    p.payload?.authorization?.value,        // EIP-3009 (USDC transferWithAuthorization)
    p.payload?.permit2Authorization?.value, // Permit2 flow
    p.authorization?.value,                 // defensive: un-nested authorization
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

/** Read a matched requirement's binding fields (test seam + internal use). */
function reqFields(req: unknown): {
  amount?: string; asset?: string; network?: string; payTo?: string;
} {
  const r = (req ?? {}) as { amount?: unknown; asset?: unknown; network?: unknown; payTo?: unknown };
  return {
    amount: typeof r.amount === 'string' ? r.amount : r.amount != null ? String(r.amount) : undefined,
    asset: typeof r.asset === 'string' ? r.asset : undefined,
    network: typeof r.network === 'string' ? r.network : undefined,
    payTo: typeof r.payTo === 'string' ? r.payTo : undefined,
  };
}

/**
 * X402-01 route-level binding (defense-in-depth on top of the per-tool
 * `verifyX402Payment(headers, tool)` path). Asserts that a verified settlement's
 * matched requirement actually belongs to `toolName`'s route AND covers its
 * effective (timeframe-aware) price:
 *
 *  1. amount/asset/network/payTo of the matched requirement must equal this
 *     tool's pre-built requirement (so a $0.01 scan_funding_arb proof POSTed to
 *     the $0.02 get_trade_signal route is rejected — they have different amounts);
 *  2. the paid atomic amount must be ≥ the tool's effective price for `timeframe`
 *     (so a base-priced $0.02 proof against a premium 1m=$0.05 call is rejected).
 *
 * Returns `false` (reject) when x402 isn't initialized, the tool is unknown, the
 * settlement is malformed, the matched requirement doesn't match the route's
 * requirement, or the amount is insufficient. The route handler calls this after
 * `resolveLicense` returns `tier==='x402'` + a `pendingSettlement`; on `false`
 * it sends 402 and does NOT serve/settle.
 */
export function paymentMatchesToolRoute(
  settlement: { paymentPayload?: unknown; requirements?: unknown } | undefined | null,
  toolName: string,
  timeframe?: string,
): boolean {
  if (!settlement || !settlement.requirements) return false;

  const expected = toolRequirements.get(toolName);
  if (!expected || expected.length === 0) return false; // unknown / unpriced tool → reject

  // The settlement's matched requirement (may be a single req or a 1-element array).
  const matchedRaw = settlement.requirements;
  const matched = Array.isArray(matchedRaw) ? matchedRaw[0] : matchedRaw;
  const exp = reqFields(expected[0]);
  const got = reqFields(matched);

  // (1) Route/identity binding: asset, network, and recipient MUST equal THIS
  // server's pre-built requirement for the tool. These never vary by the buyer's
  // payment, so an exact match binds the proof to our wallet/chain/token (and
  // independently catches the cross-network / wrong-asset / wrong-payTo cases).
  // The AMOUNT is deliberately NOT required to be byte-equal here — over-payment
  // and premium-timeframe amounts legitimately differ from the base requirement;
  // the amount floor is enforced in (2).
  if (
    got.asset !== exp.asset ||
    got.network !== exp.network ||
    got.payTo !== exp.payTo
  ) {
    return false;
  }

  // (2) Effective-price floor (X402-01 amount + X402-03 premium): the paid atomic
  // amount must be ≥ the tool's effective (timeframe-aware) price. This is the
  // check that rejects the cross-tool DOWNGRADE — a $0.01 scan_funding_arb proof
  // (amount 10000) on the $0.02 get_trade_signal route (effective 20000) fails
  // 10000 ≥ 20000 — AND the premium underpay (a $0.02 proof on a 1m=$0.05 call).
  // Over-payment and exact/correct-premium proofs pass (paid ≥ effective).
  if (!isPaymentSufficient(toolName, got.amount, timeframe)) {
    return false;
  }

  // (3) OPS-MCP-DEFENSE-IN-DEPTH-W1 — signed-value floor: the amount in (2) comes
  // from the SERVER's matched requirement, which by construction equals the route's
  // own price; it is the facilitator's signature check that ties it to the buyer.
  // Re-assert the same effective-price floor against what the buyer actually
  // SIGNED (EIP-3009/Permit2 authorization value), so a requirement/signature
  // divergence (SDK or facilitator drift) can never under-charge. A proof clears
  // only when BOTH floors pass; missing/malformed signed value → default-deny.
  const signedValue = extractSignedAuthorizationValue(settlement.paymentPayload);
  if (!isPaymentSufficient(toolName, signedValue, timeframe)) {
    return false;
  }

  return true;
}

/**
 * OPS-X402-MCP-PRICE-BINDING-W1: classify WHY a settlement fails the per-tool
 * route binding, so the MCP `tools/call` downgrade can carry a precise reason in
 * the `X402_PAYMENT_REQUIRED` error. Pure read-over the same internals as
 * `paymentMatchesToolRoute` (no behavior change to it; this is additive):
 *
 *   - `'ok'`          — identity (asset/network/payTo) matches THIS tool's
 *                       requirement AND the paid amount covers its effective
 *                       (timeframe-aware) price → bind passes.
 *   - `'cross_tool'`  — identity does NOT match this tool's requirement (the
 *                       matched requirement belongs to a different route — wrong
 *                       asset/network/payTo). This is the cross-tool downgrade.
 *   - `'insufficient'`— identity matches this tool's route but the amount underpays
 *                       its effective price (e.g. base $0.02 on a premium 1m=$0.05).
 *
 * A missing/malformed settlement or unknown/unpriced tool → `'cross_tool'`
 * (default-deny; treated as "not a payment for this route"). Mirrors the exact
 * checks in `paymentMatchesToolRoute` so `classifyToolRouteMismatch(...) === 'ok'`
 * iff `paymentMatchesToolRoute(...) === true`.
 */
export function classifyToolRouteMismatch(
  settlement: { paymentPayload?: unknown; requirements?: unknown } | undefined | null,
  toolName: string,
  timeframe?: string,
): 'ok' | 'cross_tool' | 'insufficient' {
  if (!settlement || !settlement.requirements) return 'cross_tool';

  const expected = toolRequirements.get(toolName);
  if (!expected || expected.length === 0) return 'cross_tool'; // unknown / unpriced tool

  const matchedRaw = settlement.requirements;
  const matched = Array.isArray(matchedRaw) ? matchedRaw[0] : matchedRaw;
  const exp = reqFields(expected[0]);
  const got = reqFields(matched);

  // Identity binding (asset/network/payTo) — a mismatch means the proof matched a
  // DIFFERENT tool's route (or wrong chain/token/recipient): cross-tool.
  if (got.asset !== exp.asset || got.network !== exp.network || got.payTo !== exp.payTo) {
    return 'cross_tool';
  }

  // Identity matches but the amount underpays the effective price: insufficient.
  if (!isPaymentSufficient(toolName, got.amount, timeframe)) {
    return 'insufficient';
  }

  // OPS-MCP-DEFENSE-IN-DEPTH-W1 — lockstep mirror of paymentMatchesToolRoute (3):
  // the buyer's SIGNED value underpays the effective price (or is absent/malformed)
  // → insufficient. Keeps `classify === 'ok'` iff `paymentMatchesToolRoute === true`.
  const signedValue = extractSignedAuthorizationValue(settlement.paymentPayload);
  if (!isPaymentSufficient(toolName, signedValue, timeframe)) {
    return 'insufficient';
  }

  return 'ok';
}

/** Test seam: snapshot the pre-built per-tool requirements (read-only). */
export function _getToolRequirementsForTest(): Map<string, unknown[]> {
  return new Map(toolRequirements);
}
