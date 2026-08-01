#!/usr/bin/env tsx
/**
 * publish-merkle-batch.ts — Daily Merkle root publisher.
 *
 * 1. Queries all signals with signal_hash but no merkle_batch_id
 * 2. Builds a Merkle tree from their hashes
 * 3. Publishes the Merkle root to Base L2 smart contract
 * 4. Stores batch metadata + proofs in PostgreSQL
 * 5. Updates signals with the batch ID
 *
 * Cron: 5 0 * * * (daily at 00:05 UTC)
 */

import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { buildMerkleTree } from '../lib/merkle.js';
import { getBuilderCodeDataSuffix } from '../lib/builder-code-constants.js';
import {
  getUnbatchedSignals,
  getNextBatchId,
  storeMerkleBatch,
  updateSignalMerkleProof,
  closeDb,
} from '../lib/performance-db.js';

const MERKLE_CONTRACT = process.env.MERKLE_CONTRACT_ADDRESS;
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const PUBLISHER_KEY = process.env.MERKLE_PUBLISHER_KEY;

const abi = [
  {
    name: 'publishRoot',
    type: 'function' as const,
    inputs: [
      { name: 'batchId', type: 'uint256' as const },
      { name: 'root', type: 'bytes32' as const },
      { name: 'signalCount', type: 'uint256' as const },
    ],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
] as const;

function ts(): string {
  return new Date().toISOString();
}

async function publishBatch() {
  if (!MERKLE_CONTRACT || !PUBLISHER_KEY) {
    console.log(`[${ts()}] Merkle publishing not configured (MERKLE_CONTRACT_ADDRESS or MERKLE_PUBLISHER_KEY missing)`);
    return;
  }

  // 1. Get all un-batched signals
  const signals = await getUnbatchedSignals();

  if (signals.length === 0) {
    console.log(`[${ts()}] No new signals to batch`);
    return;
  }

  // 2. Build Merkle tree
  const leaves = signals.map(s => s.signal_hash as `0x${string}`);
  const { root, proofs } = buildMerkleTree(leaves);

  // 3. Get next batch ID
  const batchId = await getNextBatchId();

  // 4. Publish to Base L2
  const account = privateKeyToAccount(
    (PUBLISHER_KEY.startsWith('0x') ? PUBLISHER_KEY : `0x${PUBLISHER_KEY}`) as `0x${string}`
  );

  const walletClient = createWalletClient({
    chain: base,
    transport: http(BASE_RPC),
    account,
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(BASE_RPC),
  });

  console.log(`[${ts()}] Publishing batch ${batchId}: ${signals.length} signals, root: ${root}`);

  // Builder-code attribution (OPS-BASE-BUILDER-CODE-W1) — ADDITIVE TELEMETRY ONLY.
  // ERC-8021 appends the suffix AFTER the ABI-encoded args; the contract ignores the
  // trailing bytes (simulated on Base mainnet: no revert, +534 gas / +0.54%).
  // Every failure path below falls back to publishing UNATTRIBUTED — an anchor must
  // never fail because of attribution.
  const writeArgs = {
    address: MERKLE_CONTRACT as `0x${string}`,
    abi,
    functionName: 'publishRoot' as const,
    args: [BigInt(batchId), root, BigInt(signals.length)] as const,
  };

  let dataSuffix = getBuilderCodeDataSuffix();
  if (dataSuffix) {
    try {
      // Pre-send gate: prove the attributed calldata does not revert before broadcasting.
      await publicClient.simulateContract({ ...writeArgs, account, dataSuffix });
      console.log(`[${ts()}] Builder-code attribution ON (suffix ${dataSuffix})`);
    } catch (err) {
      console.warn(
        `[${ts()}] Builder-code simulation FAILED — publishing UNATTRIBUTED: ${String(err)}`
      );
      dataSuffix = undefined;
    }
  }

  const txHash = await walletClient.writeContract({
    ...writeArgs,
    ...(dataSuffix ? { dataSuffix } : {}),
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`[${ts()}] Tx confirmed: ${receipt.transactionHash} (block ${receipt.blockNumber})`);

  // 5. Store batch metadata in PostgreSQL
  await storeMerkleBatch(
    batchId, root, signals.length,
    receipt.transactionHash, receipt.blockNumber.toString()
  );

  // 6. Store individual proofs + update batch IDs
  for (const signal of signals) {
    const proof = proofs.get(signal.signal_hash);
    if (proof) {
      await updateSignalMerkleProof(signal.id, batchId, JSON.stringify(proof));
    }
  }

  console.log(`[${ts()}] Batch ${batchId} complete: ${signals.length} signals, tx: ${receipt.transactionHash}`);
  console.log(`[${ts()}] Basescan: https://basescan.org/tx/${receipt.transactionHash}`);
}

publishBatch()
  .catch((err) => {
    console.error(`[${ts()}] Fatal:`, err);
    process.exit(1);
  })
  .finally(() => closeDb());
