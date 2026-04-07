#!/usr/bin/env node

/**
 * Self-hosted x402 Facilitator for Base mainnet.
 *
 * Verifies ERC-3009 signatures and settles USDC transfers on-chain.
 * The facilitator wallet only needs ETH for gas (~$0.001-0.01 per tx).
 * USDC flows directly from payer → recipient (your Rabby wallet).
 *
 * Endpoints (matching HTTPFacilitatorClient expectations):
 *   POST /verify     — verify a payment signature
 *   POST /settle     — submit the on-chain transfer
 *   GET  /supported  — list supported schemes/networks
 *   GET  /health     — health check
 *
 * Env vars:
 *   FACILITATOR_PRIVATE_KEY — hex private key for the gas wallet
 *   FACILITATOR_PORT        — port to listen on (default: 4022)
 */
import express from 'express';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { x402Facilitator } from '@x402/core/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
// Facilitator-side ExactEvmScheme (different from the client-side one)
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';

const PORT = parseInt(process.env.FACILITATOR_PORT || '4022', 10);
const PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('FACILITATOR_PRIVATE_KEY is required');
  process.exit(1);
}

// ── EVM Wallet ──

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const viemClient = createWalletClient({
  account,
  chain: base,
  transport: http(), // viem default Base RPC
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  address: account.address,
  getCode: (args) => viemClient.getCode(args),
  readContract: (args) => viemClient.readContract({ ...args, args: args.args || [] } as Parameters<typeof viemClient.readContract>[0]),
  verifyTypedData: (args) => viemClient.verifyTypedData(args as Parameters<typeof viemClient.verifyTypedData>[0]),
  writeContract: (args) => viemClient.writeContract({ ...args, args: args.args || [] } as Parameters<typeof viemClient.writeContract>[0]),
  sendTransaction: (args) => viemClient.sendTransaction(args as Parameters<typeof viemClient.sendTransaction>[0]),
  waitForTransactionReceipt: (args) => viemClient.waitForTransactionReceipt(args),
});

// ── Facilitator ──

const facilitator = new x402Facilitator();
facilitator.register('eip155:8453' as `${string}:${string}`, new ExactEvmScheme(evmSigner));

facilitator.onAfterSettle(async (ctx) => {
  console.log(`[settle] tx=${ctx.result.transaction} payer=${ctx.result.payer} success=${ctx.result.success}`);
});
facilitator.onSettleFailure(async (ctx) => {
  console.error(`[settle-fail] ${ctx.error.message}`);
});

// ── HTTP Server ──

const app = express();
app.use(express.json());

app.post('/verify', async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    res.json(result);
  } catch (err) {
    console.error('verify error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.post('/settle', async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    res.json(result);
  } catch (err) {
    console.error('settle error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

app.get('/supported', (_req, res) => {
  res.json(facilitator.getSupported());
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', wallet: account.address, network: 'eip155:8453' });
});

app.listen(PORT, () => {
  console.log(`x402 facilitator running on http://0.0.0.0:${PORT}`);
  console.log(`Network: Base mainnet (eip155:8453)`);
  console.log(`Gas wallet: ${account.address}`);
});
