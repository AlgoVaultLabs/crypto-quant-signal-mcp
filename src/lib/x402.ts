/**
 * x402 Payment Verification — USDC on Base chain.
 *
 * x402 protocol flow:
 * 1. Agent sends HTTP request without payment
 * 2. Server responds 402 with payment instructions (price, token, chain, recipient)
 * 3. Agent pays on-chain, attaches proof to retry request
 * 4. Server verifies settlement, delivers response
 *
 * See https://www.x402.org/ for the full spec.
 *
 * For MVP: we parse the x-payment header and do basic validation.
 * Full on-chain verification comes in Phase 2 when volume justifies gas costs.
 */
import type { X402ToolPricing } from '../types.js';

// Tool pricing in USD
export const TOOL_PRICING: X402ToolPricing = {
  get_trade_signal: 0.02,
  scan_funding_arb: 0.01,
  get_market_regime: 0.02,
};

const WALLET_ADDRESS = process.env.X402_WALLET_ADDRESS || '';

export interface X402VerificationResult {
  valid: boolean;
  paidAmount?: number;
  payer?: string;
}

/**
 * Parse and verify x402 payment proof from request headers.
 * Returns verification result. For MVP, checks the x-payment header exists
 * and contains a JSON payload with the required fields.
 *
 * Full on-chain USDC verification on Base will be implemented in Phase 2.
 */
export function verifyX402Payment(headers: Record<string, string | undefined>): X402VerificationResult {
  const paymentHeader = headers['x-payment'] || headers['X-Payment'];

  if (!paymentHeader) {
    return { valid: false };
  }

  try {
    const proof = JSON.parse(paymentHeader);

    // Basic validation: check required fields exist
    if (!proof.payload || !proof.signature) {
      return { valid: false };
    }

    // Parse the payload
    const payload = typeof proof.payload === 'string' ? JSON.parse(proof.payload) : proof.payload;

    // Verify recipient matches our wallet
    if (WALLET_ADDRESS && payload.recipient && payload.recipient.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
      return { valid: false };
    }

    // MVP: accept any well-formed payment proof
    // Phase 2: verify on-chain USDC settlement on Base
    return {
      valid: true,
      paidAmount: payload.amount ? parseFloat(payload.amount) : undefined,
      payer: payload.payer || undefined,
    };
  } catch {
    return { valid: false };
  }
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

/**
 * Generate 402 Payment Required response body per x402 spec.
 */
export function generate402Response(toolName: string): {
  status: number;
  body: Record<string, unknown>;
} {
  const price = TOOL_PRICING[toolName as keyof X402ToolPricing] ?? 0.02;
  return {
    status: 402,
    body: {
      error: 'Payment Required',
      x402: {
        version: '1',
        price: price.toString(),
        currency: 'USDC',
        chain: 'base',
        recipient: WALLET_ADDRESS || 'not_configured',
        description: `Payment for ${toolName} tool call`,
        accepts: ['x402-payment-proof'],
      },
    },
  };
}

/**
 * Check if x402 is configured (wallet address set).
 */
export function isX402Configured(): boolean {
  return WALLET_ADDRESS.length > 0;
}
