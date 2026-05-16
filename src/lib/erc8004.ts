/**
 * ERC-8004 client + addresses + Identity Registry ABI.
 *
 * Addresses verified live on Base mainnet 2026-05-16
 * (audits/ERC-8004-W1-endpoint-truth.md probe rows B-1, B-3, B-4):
 *   - Identity Registry impl getVersion() = "2.0.0"
 *   - Reputation Registry impl getVersion() = "2.0.0"
 *   - Validation Registry NOT canonically deployed on Base mainnet
 *     (per erc-8004/erc-8004-contracts/scripts/addresses.ts:
 *      "TBD - need to mine vanity salts").
 *
 * Path 3 is currently active per ERC-8004-W1 Plan-Mode ratification:
 * we mint identity (C1) but defer attestation (C2) to ERC-8004-W2.
 * Reputation Registry constant exposed for future use; Validation
 * Registry intentionally null until mainnet v2.0.0 ships.
 */

import { type Hex } from 'viem';

export const BASE_CHAIN_ID = 8453 as const;

export const IDENTITY_REGISTRY_ADDRESS =
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

export const REPUTATION_REGISTRY_ADDRESS =
  '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63' as const;

export const VALIDATION_REGISTRY_ADDRESS: `0x${string}` | null = null;

export const AGENT_REGISTRY_CAIP10 =
  `eip155:${BASE_CHAIN_ID}:${IDENTITY_REGISTRY_ADDRESS}` as const;

export const ERC721_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

export const IDENTITY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'tokenURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getVersion',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export function getBaseRpcUrl(): string {
  return process.env.BASE_RPC_URL || 'https://mainnet.base.org';
}

export function normalizePrivateKey(raw: string): Hex {
  return (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
}

// Client construction is intentionally NOT exported here: viem's strict
// generics make a chain-bound client factory hard to share across module
// boundaries without TS7056 (inferred type exceeds serialize limit). Callers
// (e.g. register-erc8004-agent.ts) construct clients inline with viem's
// `createPublicClient` + `createWalletClient`, mirroring publish-merkle-batch.
