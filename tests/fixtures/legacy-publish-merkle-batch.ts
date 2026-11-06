/**
 * The signal publisher AS IT WAS before DECISION-CALL-V2-W5 CH2 — `git show 43d7f238:src/scripts/publish-merkle-batch.ts`
 * — kept so AC2.2 (tests/unit/anchor-signal-differential.test.ts) can run the old code beside the new one. Verbatim
 * but for two mechanical changes, each marked `LEGACY-FIXTURE`:
 *   1. `publishBatch` is exported and not invoked at import (the original ends `publishBatch().catch(…).finally(…)`).
 *   2. `storeMerkleBatch` / `updateSignalMerkleProof`, which W5 removed from src/lib/performance-db.ts, are defined
 *      below with their Postgres-branch SQL verbatim, run as PgBackend.runAsync ran it (each `?` → `$n`, the same
 *      params) through `dbQuery`.
 * The module reads its env at import, as the original did: set it before importing this file.
 */
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
import { buildMerkleTree } from '../../src/lib/merkle.js';
import { getBuilderCodeDataSuffix } from '../../src/lib/builder-code-constants.js';
import {
  getUnbatchedSignals,
  getNextBatchId,
  dbQuery, // LEGACY-FIXTURE (2): the two writers below run through it
} from '../../src/lib/performance-db.js';

// LEGACY-FIXTURE (2): src/lib/performance-db.ts at 43d7f238, the `isPg && b instanceof PgBackend` branch of each.
async function runAsync(sql: string, ...params: unknown[]): Promise<void> {
  let idx = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
  await dbQuery(pgSql, params);
}
async function storeMerkleBatch(
  batchId: number, merkleRoot: string, signalCount: number, txHash: string, blockNumber: string
): Promise<void> {
  await runAsync(
    `INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number) VALUES (?, ?, ?, ?, ?)`,
    batchId, merkleRoot, signalCount, txHash, blockNumber
  );
}
async function updateSignalMerkleProof(signalId: number, batchId: number, proof: string): Promise<void> {
  await runAsync(
    `UPDATE signals SET merkle_batch_id = ?, merkle_proof = ? WHERE id = ?`,
    batchId, proof, signalId
  );
}

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

export async function publishBatch() { // LEGACY-FIXTURE (1): exported
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

// LEGACY-FIXTURE (1): the original invoked publishBatch() here and closed the database.
