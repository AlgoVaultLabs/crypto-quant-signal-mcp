/**
 * x402 Payment Verification — USDC on Base chain.
 *
 * Uses the official @x402/core SDK with the Coinbase Facilitator
 * for real on-chain ERC-3009 signature verification and settlement.
 *
 * Flow:
 * 1. Agent sends HTTP request without payment
 * 2. Server responds 402 with PaymentRequired (price, asset, network, recipient)
 * 3. Agent signs ERC-3009 transferWithAuthorization, attaches to x-payment header
 * 4. Server verifies signature via Facilitator (~100ms)
 * 5. Server responds immediately, settles on-chain asynchronously (~2s)
 *
 * Graceful degradation: if X402_WALLET_ADDRESS is not set, x402 tier is
 * skipped entirely and the server falls through to API key / free tiers.
 */
import { x402ResourceServer } from '@x402/core/server';
import { bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import type { X402ToolPricing } from '../types.js';
import { createFacilitatorClient, resolveFacilitatorFromEnv } from './x402-facilitator.js';
import { declareBazaarRoute } from './x402-bazaar.js';

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

// Tool pricing in USD (base price — timeframe-tiered pricing applied at request time)
export const TOOL_PRICING: X402ToolPricing = {
  get_trade_signal: 0.02,
  scan_funding_arb: 0.01,
  get_market_regime: 0.02,
};

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

// ── Result types ──

export interface X402VerificationResult {
  valid: boolean;
  paidAmount?: number;
  payer?: string;
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
  resourceServer = new x402ResourceServer(facilitator);

  // Register the CDP Bazaar discovery extension only on the cdp + discoverable path.
  // Earns the Bazaar listing when a real settle completes through CDP carrying the
  // discovery metadata (the EXTENSION-RESPONSES header confirms acceptance).
  if (resolvedFacilitator.discoveryEnabled) {
    try {
      resourceServer.registerExtension(bazaarResourceServerExtension);
    } catch (err) {
      console.warn('x402: Failed to register Bazaar discovery extension:', err instanceof Error ? err.message : err);
    }
  }

  // Register a server-side scheme for USDC price parsing on the target network.
  // The facilitator handles actual cryptographic verification — the server scheme
  // only needs to convert "$0.02" to { amount: "20000", asset: "0x..." }.
  const usdcAddress = USDC_ADDRESS[CAIP2_NETWORK];
  const caip2 = CAIP2_NETWORK as `${string}:${string}`;
  resourceServer.register(caip2, {
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
  } as Parameters<typeof resourceServer.register>[1]);

  try {
    await resourceServer.initialize();
  } catch (err) {
    console.warn('x402: Failed to initialize resource server (facilitator unreachable?):', err instanceof Error ? err.message : err);
    console.warn('x402: Payments disabled — server will operate on free/API-key tiers only.');
    resourceServer = null;
    return;
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

  // Pre-build payment requirements for each tool
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
}

// ── Verification ──

/**
 * Verify an x402 payment proof from the x-payment header.
 * Returns verification result with settlement refs for async settle.
 */
export async function verifyX402Payment(
  headers: Record<string, string | undefined>,
  toolName?: string,
): Promise<X402VerificationResult> {
  if (!resourceServer || !initialized) {
    return { valid: false };
  }

  const paymentHeader = headers['x-payment'] || headers['X-Payment'];
  if (!paymentHeader) {
    return { valid: false };
  }

  try {
    const paymentPayload = JSON.parse(paymentHeader);

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
    const matchingReqs = resourceServer.findMatchingRequirements(
      candidateReqs as Parameters<typeof resourceServer.findMatchingRequirements>[0],
      paymentPayload,
    );

    if (!matchingReqs) {
      return { valid: false };
    }

    // Verify via Facilitator (fast, ~100ms)
    const verifyResult = await resourceServer.verifyPayment(paymentPayload, matchingReqs);

    if (!verifyResult.isValid) {
      console.warn(`x402 verify failed: ${verifyResult.invalidReason} — ${verifyResult.invalidMessage}`);
      return { valid: false };
    }

    return {
      valid: true,
      payer: verifyResult.payer,
      _settlement: { paymentPayload, requirements: matchingReqs },
    };
  } catch (err) {
    console.error('x402 verify error:', err instanceof Error ? err.message : err);
    return { valid: false };
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
  // Premium pricing is only defined for get_trade_signal timeframes.
  if (toolName === 'get_trade_signal' && timeframe) {
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

  return 'ok';
}

/** Test seam: snapshot the pre-built per-tool requirements (read-only). */
export function _getToolRequirementsForTest(): Map<string, unknown[]> {
  return new Map(toolRequirements);
}
