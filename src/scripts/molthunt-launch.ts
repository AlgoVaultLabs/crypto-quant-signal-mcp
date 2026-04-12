#!/usr/bin/env tsx
/**
 * molthunt-launch.ts — Register ERC-8004 agent identity on Base + launch project on Molthunt.
 *
 * Usage:
 *   npx tsx src/scripts/molthunt-launch.ts --register   # Step 1: register on-chain identity
 *   npx tsx src/scripts/molthunt-launch.ts --launch     # Step 2: SIWA auth + create project
 *   npx tsx src/scripts/molthunt-launch.ts --all        # Both steps
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Hex } from 'viem';
import { base } from 'viem/chains';

// ── Config ──
const PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY as Hex;
const MOLTHUNT_API = 'https://www.molthunt.com/api/v1';

// ERC-8004 registry on Base mainnet
const ERC8004_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;
const REGISTRY_CAIP10 = `eip155:8453:${ERC8004_REGISTRY}`;

// Minimal ERC-8004 ABI for registration
const REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'agentIdOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// AlgoVault agent metadata
const AGENT_METADATA = {
  name: 'AlgoVault Signal Agent',
  description: 'AI-native crypto signal engine. MCP server delivering trade signals, funding arb scans, and market regime detection.',
  website: 'https://api.algovault.com',
  github: 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp',
};

// Molthunt project details
const PROJECT = {
  name: 'AlgoVault Crypto Quant Signal MCP',
  tagline: 'AI-native crypto signals via MCP — trade signals, funding arb, market regime detection',
  description: `AlgoVault is a remote MCP server that gives AI trading agents real-time crypto intelligence. Three tools ship today:

**get_trade_signal** — Multi-indicator confluence scoring (RSI, MACD, Bollinger, volume profile, funding rate) for any Hyperliquid perp. Returns BUY/SELL/HOLD with confidence bands.

**scan_funding_arb** — Scans all venues for funding rate arbitrage opportunities above your threshold.

**get_market_regime** — Classifies current market as trending/ranging/volatile/breakout with regime-specific strategy recommendations.

All signals include a published track record (win rates, Sharpe ratio, max drawdown) — verified and updated every hour.

Pay-per-call via x402 (USDC on Base) or subscribe via Stripe. Free tier available (5 signals/day).

Built on Streamable HTTP transport — works with Claude Desktop, Cursor, any MCP client.`,
  github_url: 'https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp',
  website_url: 'https://api.algovault.com',
  category_ids: ['cat_ai', 'cat_developer-tools'],
};

// ── Helpers ──

function getAccount() {
  if (!PRIVATE_KEY) {
    console.error('Error: FACILITATOR_PRIVATE_KEY not set');
    process.exit(1);
  }
  return privateKeyToAccount(PRIVATE_KEY);
}

function getClients() {
  const account = getAccount();
  const transport = http('https://mainnet.base.org');
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ chain: base, account, transport });
  return { account, publicClient, walletClient };
}

// ── Step 1: Register ERC-8004 identity ──

async function registerOnChain(): Promise<number> {
  const { account, publicClient, walletClient } = getClients();
  console.log(`[register] Wallet: ${account.address}`);

  // Check if already registered
  const existingId = await publicClient.readContract({
    address: ERC8004_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'agentIdOf',
    args: [account.address],
  });

  if (existingId > 0n) {
    console.log(`[register] Already registered with agent ID: ${existingId}`);
    return Number(existingId);
  }

  // Build agent URI as base64 data URI
  const metadataJson = JSON.stringify(AGENT_METADATA);
  const base64 = Buffer.from(metadataJson).toString('base64');
  const agentURI = `data:application/json;base64,${base64}`;

  console.log('[register] Registering ERC-8004 agent on Base...');
  const hash = await walletClient.writeContract({
    address: ERC8004_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'register',
    args: [agentURI],
  });

  console.log(`[register] Tx hash: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[register] Confirmed in block ${receipt.blockNumber}`);

  // Read back the agent ID
  const agentId = await publicClient.readContract({
    address: ERC8004_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: 'agentIdOf',
    args: [account.address],
  });

  console.log(`[register] Agent ID: ${agentId}`);
  return Number(agentId);
}

// ── Step 2: SIWA auth + launch project ──

async function launchProject(agentId: number): Promise<void> {
  const { account } = getClients();

  // 2a. Get nonce from Molthunt
  console.log('[siwa] Requesting nonce...');
  const nonceRes = await fetch(`${MOLTHUNT_API}/siwa/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: account.address,
      agentId,
      agentRegistry: REGISTRY_CAIP10,
    }),
  });

  if (!nonceRes.ok) {
    const body = await nonceRes.text();
    console.error(`[siwa] Nonce failed: ${nonceRes.status} — ${body}`);
    process.exit(1);
  }

  const nonceData = await nonceRes.json() as {
    success: boolean;
    data: { nonce: string; issuedAt: string; expirationTime: string };
  };
  const { nonce, issuedAt, expirationTime } = nonceData.data;
  console.log(`[siwa] Got nonce: ${nonce.slice(0, 8)}...`);

  // 2b. Build and sign SIWA message
  const { signSIWAMessage } = await import('@buildersgarden/siwa');
  const { createLocalAccountSigner } = await import('@buildersgarden/siwa/signer');

  const signer = createLocalAccountSigner(account);

  const signed = await signSIWAMessage({
    domain: 'www.molthunt.com',
    uri: 'https://www.molthunt.com/siwa',
    agentId,
    agentRegistry: REGISTRY_CAIP10,
    chainId: 8453,
    nonce,
    issuedAt,
    expirationTime,
  }, signer);

  console.log('[siwa] Message signed, verifying...');

  // 2c. Verify with Molthunt
  const verifyRes = await fetch(`${MOLTHUNT_API}/siwa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: signed.message,
      signature: signed.signature,
    }),
  });

  if (!verifyRes.ok) {
    const body = await verifyRes.text();
    console.error(`[siwa] Verify failed: ${verifyRes.status} — ${body}`);
    process.exit(1);
  }

  const verifyData = await verifyRes.json() as {
    success: boolean;
    data: { receipt: string; expiresAt: string };
  };
  const receipt = verifyData.data.receipt;
  console.log(`[siwa] Authenticated! Receipt expires: ${verifyData.data.expiresAt}`);

  // 2d. Create project
  console.log('[molthunt] Creating project...');
  const projectRes = await fetch(`${MOLTHUNT_API}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${receipt}`,
    },
    body: JSON.stringify(PROJECT),
  });

  if (!projectRes.ok) {
    const body = await projectRes.text();
    console.error(`[molthunt] Project creation failed: ${projectRes.status} — ${body}`);
    process.exit(1);
  }

  const projectData = await projectRes.json() as { success: boolean; data: { slug: string; name: string } };
  console.log(`[molthunt] Project created: https://www.molthunt.com/projects/${projectData.data.slug}`);
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const doRegister = args.includes('--register') || args.includes('--all');
  const doLaunch = args.includes('--launch') || args.includes('--all');

  if (!doRegister && !doLaunch) {
    console.error('Usage: --register | --launch | --all');
    process.exit(1);
  }

  let agentId = 0;

  if (doRegister) {
    agentId = await registerOnChain();
  }

  if (doLaunch) {
    if (!agentId) {
      // Read existing agent ID
      const { account, publicClient } = getClients();
      const id = await publicClient.readContract({
        address: ERC8004_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: 'agentIdOf',
        args: [account.address],
      });
      if (id === 0n) {
        console.error('[launch] No agent ID found — run --register first');
        process.exit(1);
      }
      agentId = Number(id);
      console.log(`[launch] Using existing agent ID: ${agentId}`);
    }
    await launchProject(agentId);
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
