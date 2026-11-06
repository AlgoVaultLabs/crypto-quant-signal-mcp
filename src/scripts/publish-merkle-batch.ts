#!/usr/bin/env tsx
/**
 * publish-merkle-batch.ts — Daily Merkle root publisher for the signal record.
 *
 * 1. Queries all signals with signal_hash but no merkle_batch_id
 * 2. Builds a Merkle tree from their hashes
 * 3. SEALS the batch (root, count, every proof) in Postgres — before anything is sent
 * 4. Publishes the Merkle root to the Base L2 signal registry, storing the tx hash at once
 * 5. Once the chain confirms it, ONE statement writes the batch row + every signal's batch id and proof
 *
 * Cron: 5 0 * * * (daily at 00:05 UTC)
 *
 * DECISION-CALL-V2-W5 CH2 — the publisher now runs on the shared crash-safe anchor (src/lib/anchor-batch.ts):
 * reconcile → seal → send → verified, one batch per UTC day, under the ONE advisory lock it shares with the
 * call-ledger publisher (one publisher EOA, one nonce sequence). The pre-W5 code sent first and wrote after,
 * so a kill in between orphaned a root forever; every run now reconciles a sealed or sent batch against
 * `verifyRoot` before sealing anything new. What reaches the chain and the tables is unchanged: the same
 * `publishRoot(batchId, root, signalCount)` calldata (builder-code suffix and its simulate gate included), the
 * same `merkle_batches` row and the same `signals.merkle_batch_id` / `merkle_proof` values
 * (tests/unit/anchor-signal-differential.test.ts runs the old code against this one on three batches).
 *
 * `MERKLE_CONTRACT_ADDRESS` must equal the signal row of src/lib/onchain-registries.ts, or the run refuses to send.
 *
 * One token per run: SIGNAL_ANCHOR_VERDICT=PASS|FAIL|INDETERMINATE (exit 0 / 1 / 3). FAIL with
 * ANCHOR_ROOT_MISMATCH means the registry holds a different root for a sealed batch id: the run stops and
 * the pending batch stays sealed. Nothing new is published, so MERKLE_PUBLISH_LIVENESS reports the gap.
 */
import type { Hex } from 'viem';
import { buildMerkleTree } from '../lib/merkle.js';
import { dbQuery, getUnbatchedSignals, getNextBatchId, isPgBackend } from '../lib/performance-db.js';
import {
  runAnchor,
  pgAdvisoryAnchorLock,
  viemAnchorChain,
  type AnchorChain,
  type AnchorHooks,
  type AnchorLedger,
  type AnchorLock,
  type AnchorVerdict,
} from '../lib/anchor-batch.js';
import { BASE_CHAIN_ID, SIGNAL_REGISTRY, sameAddress } from '../lib/onchain-registries.js';
import { runScript } from '../lib/script-lifecycle.js';

const EXIT: Record<AnchorVerdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

// ── DECISION-CALL-V2-W5 CH2: the signal batch, SEALED before it is sent ─────────────────────────────
//
// The pre-W5 publisher sent `publishRoot` and THEN wrote `merkle_batches` + each signal's proof, so a kill in the
// ~3.5 s between orphaned the root for good. Now the batch is SEALED first — root, count, signal ids and each
// signal's proof (exactly `JSON.stringify(proof)`, the string the old writer bound) in ONE row of
// `merkle_batch_seals` — and only when the chain has confirmed it does ONE statement write its `merkle_batches`
// row and every signal's batch id and proof, with the same columns and values the old writer produced, and mark
// the seal `verified` (its signal ids and proofs, now on `signals`, are dropped from the seal row). Readers of
// `merkle_batches`, `signals.merkle_*` and `/api/merkle-batches` see nothing until then, exactly as before.
// The seal row is KEPT: it is the record of WHEN a batch was sealed, which is what "one batch per UTC day" is
// judged on — a batch reconciled the morning after a stopped run does not use up that morning's seal.
// The state machine is src/lib/anchor-batch.ts; signalAnchorLedger below drives these. Postgres only (the anchor
// refuses without DATABASE_URL). Lazily ensured; migrations/056 is byte-equal. They live here, beside their one
// caller, as the call ledger's live in publish-call-ledger-batch.ts — performance-db.ts keeps the readers.

export const CREATE_MERKLE_BATCH_SEALS_SQL = `CREATE TABLE IF NOT EXISTS merkle_batch_seals (
  batch_id     INTEGER     PRIMARY KEY CHECK (batch_id > 0),
  merkle_root  VARCHAR(66) NOT NULL,
  signal_count INTEGER     NOT NULL CHECK (signal_count > 0),
  signal_ids   INTEGER[],
  proofs       TEXT[],
  state        TEXT        NOT NULL CHECK (state IN ('sealed', 'sent', 'verified')),
  tx_hash      VARCHAR(66),
  sealed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at  TIMESTAMPTZ,
  CHECK (cardinality(signal_ids) = cardinality(proofs)),
  CHECK ((state = 'sealed') = (tx_hash IS NULL)),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL)),
  CHECK ((state = 'verified') = (signal_ids IS NULL AND proofs IS NULL)),
  CHECK (state = 'verified' OR (signal_ids IS NOT NULL AND proofs IS NOT NULL))
)`;

let _merkleBatchSealsEnsured = false;

async function ensureMerkleBatchSeals(): Promise<void> {
  if (_merkleBatchSealsEnsured) return;
  await dbQuery(CREATE_MERKLE_BATCH_SEALS_SQL);
  _merkleBatchSealsEnsured = true;
}

/** Test seam: forget the ensure, so a fresh database is ensured again. */
export function _resetMerkleBatchSealsForTest(): void {
  _merkleBatchSealsEnsured = false;
}

export interface MerkleBatchSealRow {
  batch_id: number;
  merkle_root: string;
  signal_count: number;
  state: 'sealed' | 'sent';
  tx_hash: string | null;
}

/** The sealed-or-sent signal batch, if any (at most one exists: a seal refuses while one is open). */
export async function readUnresolvedMerkleBatches(): Promise<MerkleBatchSealRow[]> {
  await ensureMerkleBatchSeals();
  return dbQuery<MerkleBatchSealRow>(
    `SELECT batch_id, merkle_root, signal_count, state, tx_hash FROM merkle_batch_seals
     WHERE state IN ('sealed', 'sent') ORDER BY batch_id`,
  );
}

/**
 * True when a signal batch was SEALED on the current UTC day — by this publisher (a seal row), or by the pre-W5
 * publisher before this code was deployed (a `merkle_batches` row published today with no seal row). A batch
 * sealed yesterday and confirmed today does not count. `published_at` is a TIMESTAMP stamped by NOW() in the
 * session time zone, so it is read back in that zone before the UTC compare.
 */
export async function merkleBatchSealedToday(): Promise<boolean> {
  await ensureMerkleBatchSeals();
  const rows = await dbQuery<{ sealed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM merkle_batch_seals
                    WHERE sealed_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
         OR EXISTS (SELECT 1 FROM merkle_batches mb
                    WHERE (mb.published_at AT TIME ZONE current_setting('TimeZone'))
                          >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                      AND NOT EXISTS (SELECT 1 FROM merkle_batch_seals s WHERE s.batch_id = mb.batch_id)) AS sealed`,
  );
  return rows[0]?.sealed === true;
}

/** Seal one signal batch in ONE statement; false when another batch is open or the id is already taken. */
export async function sealMerkleBatch(b: {
  batchId: number;
  root: string;
  signalCount: number;
  signalIds: number[];
  proofs: string[];
}): Promise<boolean> {
  await ensureMerkleBatchSeals();
  const rows = await dbQuery<{ batch_id: number }>(
    `INSERT INTO merkle_batch_seals (batch_id, merkle_root, signal_count, signal_ids, proofs, state)
     SELECT $1::integer, $2::varchar, $3::integer, $4::integer[], $5::text[], 'sealed'
     WHERE NOT EXISTS (SELECT 1 FROM merkle_batch_seals WHERE state IN ('sealed', 'sent'))
       AND NOT EXISTS (SELECT 1 FROM merkle_batches WHERE batch_id = $1::integer)
     ON CONFLICT (batch_id) DO NOTHING
     RETURNING batch_id`,
    [b.batchId, b.root, b.signalCount, b.signalIds, b.proofs],
  );
  return rows.length === 1;
}

/** Record the broadcast tx hash of the open batch — called IMMEDIATELY after the send. Throws if none is open. */
export async function markMerkleBatchSent(batchId: number, txHash: string): Promise<void> {
  const rows = await dbQuery<{ batch_id: number }>(
    `UPDATE merkle_batch_seals SET state = 'sent', tx_hash = $2::varchar
     WHERE batch_id = $1::integer AND state IN ('sealed', 'sent') RETURNING batch_id`,
    [batchId, txHash],
  );
  if (rows.length !== 1) throw new Error(`signal batch ${batchId} is not open, so its tx ${txHash} could not be recorded`);
}

/**
 * Confirm the open batch in ONE statement: mark its seal `verified` (dropping the signal ids and proofs it
 * carried), insert its `merkle_batches` row (the pre-W5 writer's five columns; `published_at` keeps its NOW()
 * default) and set every listed signal's `merkle_batch_id` + `merkle_proof` (the stored JSON text, cast to the
 * JSONB column as the bound string was). Every CTE reads the pre-statement snapshot, so `o` still holds the ids
 * and proofs the UPDATE clears. Returns whether the batch row was written and how many signals were updated.
 */
export async function confirmMerkleBatch(batchId: number, txHash: string, blockNumber: string): Promise<{ batch: boolean; signals: number }> {
  const rows = await dbQuery<{ batches: number; signals: number }>(
    `WITH o AS (
       SELECT batch_id, merkle_root, signal_count, signal_ids, proofs
       FROM merkle_batch_seals WHERE batch_id = $1::integer AND state IN ('sealed', 'sent')
     ), v AS (
       UPDATE merkle_batch_seals AS m
          SET state = 'verified', tx_hash = $2::varchar, signal_ids = NULL, proofs = NULL, verified_at = now()
         FROM o WHERE m.batch_id = o.batch_id
       RETURNING m.batch_id
     ), b AS (
       INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number)
       SELECT o.batch_id, o.merkle_root, o.signal_count, $2::varchar, $3::varchar FROM o JOIN v ON v.batch_id = o.batch_id
       RETURNING batch_id
     ), s AS (
       UPDATE signals AS sg SET merkle_batch_id = b.batch_id, merkle_proof = u.proof::jsonb
       FROM b, o CROSS JOIN LATERAL unnest(o.signal_ids, o.proofs) AS u(id, proof)
       WHERE sg.id = u.id
       RETURNING sg.id
     )
     SELECT (SELECT COUNT(*) FROM b)::integer AS batches, (SELECT COUNT(*) FROM s)::integer AS signals`,
    [batchId, txHash, blockNumber],
  );
  return { batch: Number(rows[0]?.batches ?? 0) === 1, signals: Number(rows[0]?.signals ?? 0) };
}

function ts(): string {
  return new Date().toISOString();
}

/** The signal record as an anchor ledger: a `merkle_batch_seals` row until confirmed, then `merkle_batches` + `signals`. */
export function signalAnchorLedger(log: (line: string) => void = (l) => console.log(l)): AnchorLedger {
  return {
    name: 'signal',
    async unresolved() {
      const rows = await readUnresolvedMerkleBatches();
      return rows.map((r) => ({
        batchId: Number(r.batch_id),
        root: r.merkle_root as Hex,
        leafCount: Number(r.signal_count),
        state: r.state,
        txHash: (r.tx_hash ?? null) as Hex | null,
      }));
    },
    sealedToday: () => merkleBatchSealedToday(),
    async sealNext() {
      // 1. Get all un-batched signals
      const signals = await getUnbatchedSignals();
      if (signals.length === 0) {
        log(`[${ts()}] No new signals to batch`);
        return null;
      }
      // 2. Build Merkle tree
      const leaves = signals.map((s) => s.signal_hash as `0x${string}`);
      const { root, proofs } = buildMerkleTree(leaves);
      // 3. Get next batch ID
      const batchId = await getNextBatchId();
      // Each signal's proof exactly as the pre-W5 writer bound it; a signal with no proof was never written.
      const signalIds: number[] = [];
      const proofTexts: string[] = [];
      for (const signal of signals) {
        const proof = proofs.get(signal.signal_hash);
        if (proof) {
          signalIds.push(signal.id);
          proofTexts.push(JSON.stringify(proof));
        }
      }
      const sealed = await sealMerkleBatch({ batchId, root, signalCount: signals.length, signalIds, proofs: proofTexts });
      if (!sealed) throw new Error(`batch ${batchId} could not be sealed: another batch is open or the id is already taken`);
      log(`[${ts()}] Publishing batch ${batchId}: ${signals.length} signals, root: ${root}`);
      return { batchId, root, leafCount: signals.length, state: 'sealed' as const, txHash: null };
    },
    markSent: (batchId, txHash) => markMerkleBatchSent(batchId, txHash),
    async markVerified(batchId, tx) {
      log(`[${ts()}] Tx confirmed: ${tx.txHash} (block ${tx.blockNumber})`);
      const done = await confirmMerkleBatch(batchId, tx.txHash, tx.blockNumber.toString());
      if (!done.batch) throw new Error(`batch ${batchId} was not open when its confirmation arrived`);
      log(`[${ts()}] Batch ${batchId} complete: ${done.signals} signals, tx: ${tx.txHash}`);
      log(`[${ts()}] Basescan: https://basescan.org/tx/${tx.txHash}`);
    },
  };
}

export interface PublishMerkleBatchDeps {
  ledger?: AnchorLedger;
  chain?: AnchorChain;
  lock?: AnchorLock;
  hooks?: AnchorHooks;
}

/** The CLI body. RETURNS the exit code — runScript takes it only from here. */
export async function main(env: NodeJS.ProcessEnv = process.env, deps: PublishMerkleBatchDeps = {}): Promise<number> {
  const log = deps.hooks?.log ?? ((line: string) => console.log(line));
  const say = (verdict: AnchorVerdict, why: string): number => {
    log(`[${ts()}] ${why}`);
    log(`SIGNAL_ANCHOR_VERDICT=${verdict}`);
    return EXIT[verdict];
  };

  const contract = env.MERKLE_CONTRACT_ADDRESS;
  const key = env.MERKLE_PUBLISHER_KEY;
  if (!contract || !key) {
    log(`[${ts()}] Merkle publishing not configured (MERKLE_CONTRACT_ADDRESS or MERKLE_PUBLISHER_KEY missing)`);
    return say('INDETERMINATE', 'not configured — nothing was anchored');
  }
  // The committed table is the address of record: an env var that drifted from it must not anchor anywhere.
  if (!sameAddress(contract, SIGNAL_REGISTRY.address)) {
    return say('FAIL', `MERKLE_CONTRACT_ADDRESS ${contract} differs from the signal registry ${SIGNAL_REGISTRY.address} in onchain-registries.ts — refusing to send`);
  }
  if (!deps.ledger && !isPgBackend()) {
    return say('INDETERMINATE', 'the anchor needs Postgres (DATABASE_URL unset) — nothing was anchored');
  }

  const chain = deps.chain ?? viemAnchorChain({
    registry: SIGNAL_REGISTRY.address as Hex,
    rpcUrl: env.BASE_RPC_URL || 'https://mainnet.base.org',
    publisherKey: key,
    log: (line) => log(`[${ts()}] ${line}`),
  });
  try {
    const id = await chain.chainId();
    if (id !== BASE_CHAIN_ID) return say('FAIL', `BASE_RPC_URL serves chain ${id}, not Base (${BASE_CHAIN_ID}) — refusing to send`);
  } catch (e) {
    return say('INDETERMINATE', `the RPC could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = await runAnchor({
    ledger: deps.ledger ?? signalAnchorLedger(log),
    chain,
    lock: deps.lock ?? pgAdvisoryAnchorLock(env.DATABASE_URL as string),
    hooks: deps.hooks,
  });
  // The engine's mismatch reason already starts with the token: printed once, at the start of its own line.
  if (result.rootMismatch) log(result.reason);
  log(`SIGNAL_ANCHOR_VERIFIED=${result.verified.join(',')}`);
  return say(result.verdict, result.reason);
}

// require.main guard (CJS, target ES2022) — cron invokes this directly.
if (require.main === module) {
  // 10 min: a run is seconds plus one receipt wait (≤ 3 min); a run still going at 10 min is hung, and the next
  // run reconciles whatever it left.
  void runScript('publish-merkle-batch', () => main(), { watchdogMs: 10 * 60_000 });
}
