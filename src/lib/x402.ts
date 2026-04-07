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
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { X402ToolPricing } from '../types.js';

// ── Configuration ──

const WALLET_ADDRESS = process.env.X402_WALLET_ADDRESS || '';
const NETWORK = process.env.X402_NETWORK || 'base-mainnet';
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || undefined; // default: https://x402.org/facilitator

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

// Tool pricing in USD
export const TOOL_PRICING: X402ToolPricing = {
  get_trade_signal: 0.02,
  scan_funding_arb: 0.01,
  get_market_regime: 0.02,
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

  let facilitator: HTTPFacilitatorClient;
  try {
    facilitator = new HTTPFacilitatorClient(FACILITATOR_URL ? { url: FACILITATOR_URL } : undefined);
  } catch (err) {
    console.warn('x402: Failed to create facilitator client:', err instanceof Error ? err.message : err);
    return;
  }
  resourceServer = new x402ResourceServer(facilitator);

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
      const reqs = await resourceServer.buildPaymentRequirements({
        scheme: 'exact',
        network: caip2,
        payTo: WALLET_ADDRESS,
        price: `$${price}`,
        extra: { name: 'USDC', version: '2' },
      });
      toolRequirements.set(tool, reqs);
    }
  } catch (err) {
    console.warn('x402: Failed to build payment requirements:', err instanceof Error ? err.message : err);
    console.warn('x402: Payments disabled — server will operate on free/API-key tiers only.');
    resourceServer = null;
    return;
  }

  initialized = true;
  console.log(`x402 initialized: network=${NETWORK} wallet=${WALLET_ADDRESS.slice(0, 6)}...`);
}

// ── Verification ──

/**
 * Verify an x402 payment proof from the x-payment header.
 * Returns verification result with settlement refs for async settle.
 */
export async function verifyX402Payment(
  headers: Record<string, string | undefined>,
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

    // Collect all requirements across tools to find a match
    const allReqs = Array.from(toolRequirements.values()).flat();
    const matchingReqs = resourceServer.findMatchingRequirements(
      allReqs as Parameters<typeof resourceServer.findMatchingRequirements>[0],
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
export function generate402Response(toolName: string): {
  status: number;
  body: Record<string, unknown>;
} {
  const reqs = toolRequirements.get(toolName);

  // If x402 is initialized and we have pre-built requirements, use them
  if (reqs && reqs.length > 0) {
    return {
      status: 402,
      body: {
        x402Version: 2,
        error: 'Payment Required',
        resource: {
          url: `/mcp`,
          description: `Payment for ${toolName} tool call`,
          mimeType: 'application/json',
        },
        accepts: reqs,
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
      resource: {
        url: `/mcp`,
        description: `Payment for ${toolName} tool call`,
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: CAIP2_NETWORK,
          asset: USDC_ADDRESS[CAIP2_NETWORK],
          amount: atomicAmount,
          payTo: WALLET_ADDRESS || 'not_configured',
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
        },
      ],
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

/**
 * Check if payment amount covers the tool price.
 */
export function isPaymentSufficient(toolName: string, paidAmount: number | undefined): boolean {
  if (paidAmount === undefined) return false;
  const price = TOOL_PRICING[toolName as keyof X402ToolPricing];
  if (price === undefined) return false;
  return paidAmount >= price;
}
