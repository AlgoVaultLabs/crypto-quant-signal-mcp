#!/usr/bin/env tsx
/**
 * publish-call-ledger-batch.ts — DECISION-CALL-V2-W5 CH2: the daily anchor of the pre_trade_check call ledger.
 *
 * Every logged `pre_trade_check` wrote two leaves into `call_ledger` (CH1: the verdict leaf the caller's receipt
 * carries, and the odds leaf over a secret salt). Once a day this script seals every unbatched leaf into ONE batch,
 * publishes its Merkle root to the call-ledger registry on Base (`CALL_LEDGER_REGISTRY` in onchain-registries.ts),
 * and marks it verified once `verifyRoot` reads the root back — the shared crash-safe engine in
 * src/lib/anchor-batch.ts, under the ONE advisory lock it shares with the signal publisher.
 * Prompt/call-ledger-contract.md v1 is the format; nothing here may change a v1 leaf, tree or table.
 *
 *   cron (signal-1): ops/cron/publish-call-ledger-batch.sh → docker exec … node dist/scripts/publish-call-ledger-batch.js
 *
 * THE RECHECK. After each PASS run, the newest RECHECK_BATCHES verified batches are proved again from scratch:
 * every leaf is RECOMPUTED from its check row in `pre_trade_checks` (and, for an odds leaf, its stored salt), the
 * tree is rebuilt from the recomputed leaves, and the root is compared with `verifyRoot`. A match stamps
 * `recheck_ok_at`. Reading the stored leaves back would prove nothing — it is the check rows that must still say
 * what was anchored. A recheck failure is reported as ANCHOR_ROOT_MISMATCH, like a reconcile mismatch.
 *
 * Tokens (exactly one verdict per run): CALL_LEDGER_ANCHOR_VERDICT=PASS|FAIL|INDETERMINATE (exit 0 / 1 / 3).
 * Every `ANCHOR_ROOT_MISMATCH …` line is the wrapper's page body. INDETERMINATE covers everything undecided:
 * the registry address not yet committed, no key, the lock busy, an RPC or database error, a tx in flight.
 * Before the first receipted check is logged the ledger table does not exist yet: PASS, nothing to anchor.
 */
import type { Hex } from 'viem';
import { buildMerkleTree } from '../lib/merkle.js';
import { dbQuery, isPgBackend } from '../lib/performance-db.js';
import { adoptCallLedger, readLedgerCheckRows } from '../lib/pre-trade-check-log.js';
import { oddsLeaf, oddsRecordFromRow, verdictLeaf, verdictRecordFromRow } from '../lib/call-ledger.js';
import {
  runAnchor,
  pgAdvisoryAnchorLock,
  viemAnchorChain,
  type AnchorChain,
  type AnchorHooks,
  type AnchorLedger,
  type AnchorLock,
  type AnchorVerdict,
  type PendingBatch,
} from '../lib/anchor-batch.js';
import { BASE_CHAIN_ID, CALL_LEDGER_REGISTRY } from '../lib/onchain-registries.js';
import { runScript } from '../lib/script-lifecycle.js';

const TAG = '[call-ledger-anchor]';
const EXIT: Record<AnchorVerdict, number> = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/** The newest verified batches the recheck proves again on every PASS run (contract § Tables). */
export const RECHECK_BATCHES = 7;

/** migrations/056 (first table): the call ledger's batches. Lazily ensured; the migration is byte-equal. */
export const CREATE_CALL_LEDGER_BATCHES_SQL = `CREATE TABLE IF NOT EXISTS call_ledger_batches (
  batch_id      INTEGER     PRIMARY KEY CHECK (batch_id > 0),
  root          TEXT        NOT NULL CHECK (root ~ '^0x[0-9a-f]{64}$'),
  leaf_count    INTEGER     NOT NULL CHECK (leaf_count > 0),
  state         TEXT        NOT NULL CHECK (state IN ('sealed', 'sent', 'verified')),
  tx_hash       TEXT        CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number  BIGINT,
  sealed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  anchored_at   TIMESTAMPTZ,
  recheck_ok_at TIMESTAMPTZ,
  CHECK (state = 'sealed' OR tx_hash IS NOT NULL),
  CHECK ((state = 'verified') = (block_number IS NOT NULL AND anchored_at IS NOT NULL))
)`;

let _batchesEnsured = false;

async function ensureCallLedgerBatches(): Promise<void> {
  if (_batchesEnsured) return;
  await dbQuery(CREATE_CALL_LEDGER_BATCHES_SQL);
  _batchesEnsured = true;
}

/** Test seam: forget the ensure, so a fresh database is ensured again. */
export function _resetCallLedgerBatchesForTest(): void {
  _batchesEnsured = false;
}

/**
 * Seal every unbatched leaf in ONE statement: the batch id (MAX + 1), every leaf's batch id + proof, and the
 * batch row. Its `leaf_count` is the tree's size only if every listed leaf was assigned in this statement —
 * otherwise -1, which the table's CHECK (leaf_count > 0) refuses, rolling the whole statement back. A sealed
 * batch therefore always holds exactly the leaves its root was built from.
 */
const SEAL_SQL = `WITH n AS (
  SELECT COALESCE(MAX(batch_id), 0) + 1 AS id FROM call_ledger_batches
), x AS (
  SELECT id, proof FROM jsonb_to_recordset($3::jsonb) AS x(id bigint, proof jsonb)
), u AS (
  UPDATE call_ledger AS l SET batch_id = n.id, proof = x.proof
  FROM n, x
  WHERE l.id = x.id AND l.batch_id IS NULL
  RETURNING l.id
), b AS (
  INSERT INTO call_ledger_batches (batch_id, root, leaf_count, state)
  SELECT n.id, $1::text, CASE WHEN (SELECT COUNT(*) FROM u) = $2::integer THEN $2::integer ELSE -1 END, 'sealed'
  FROM n
  RETURNING batch_id, leaf_count
)
SELECT batch_id, leaf_count FROM b`;

/** The call ledger as an anchor ledger (`call_ledger` + `call_ledger_batches`). */
export function callLedgerAnchorLedger(): AnchorLedger {
  return {
    name: 'call-ledger',
    async unresolved() {
      const rows = await dbQuery<{ batch_id: number; root: string; leaf_count: number; state: 'sealed' | 'sent'; tx_hash: string | null }>(
        `SELECT batch_id, root, leaf_count, state, tx_hash FROM call_ledger_batches WHERE state IN ('sealed', 'sent') ORDER BY batch_id`,
      );
      return rows.map((r): PendingBatch => ({
        batchId: Number(r.batch_id),
        root: r.root as Hex,
        leafCount: Number(r.leaf_count),
        state: r.state,
        txHash: (r.tx_hash ?? null) as Hex | null,
      }));
    },
    async sealedToday() {
      const rows = await dbQuery<{ sealed: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM call_ledger_batches
                        WHERE sealed_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) AS sealed`,
      );
      return rows[0]?.sealed === true;
    },
    async sealNext() {
      const leaves = await dbQuery<{ id: number | string; leaf: string }>(
        `SELECT id, leaf FROM call_ledger WHERE batch_id IS NULL ORDER BY id`,
      );
      if (leaves.length === 0) return null;
      const tree = buildMerkleTree(leaves.map((l) => l.leaf as Hex));
      const proofs = leaves.map((l) => {
        const proof = tree.proofs.get(l.leaf);
        if (!proof) throw new Error(`leaf ${String(l.id)} has no proof in its own tree`);
        return { id: String(l.id), proof };
      });
      const rows = await dbQuery<{ batch_id: number; leaf_count: number }>(SEAL_SQL, [tree.root, leaves.length, JSON.stringify(proofs)]);
      if (rows.length !== 1) throw new Error(`the seal wrote ${rows.length} batch rows`);
      return { batchId: Number(rows[0].batch_id), root: tree.root, leafCount: leaves.length, state: 'sealed', txHash: null };
    },
    async markSent(batchId, txHash) {
      const rows = await dbQuery<{ batch_id: number }>(
        `UPDATE call_ledger_batches SET state = 'sent', tx_hash = $2::text WHERE batch_id = $1::integer AND state IN ('sealed', 'sent') RETURNING batch_id`,
        [batchId, txHash],
      );
      if (rows.length !== 1) throw new Error(`call-ledger batch ${batchId} is not open, so its tx ${txHash} could not be recorded`);
    },
    async markVerified(batchId, tx) {
      const rows = await dbQuery<{ batch_id: number }>(
        `UPDATE call_ledger_batches
            SET state = 'verified', tx_hash = $2::text, block_number = $3::bigint, anchored_at = to_timestamp($4::double precision)
          WHERE batch_id = $1::integer AND state IN ('sealed', 'sent')
          RETURNING batch_id`,
        [batchId, tx.txHash, tx.blockNumber.toString(), tx.anchoredAtSec.toString()],
      );
      if (rows.length !== 1) throw new Error(`call-ledger batch ${batchId} was not sealed or sent when its confirmation arrived`);
    },
  };
}

export interface RecheckResult {
  verdict: AnchorVerdict;
  /** Batch ids whose recomputed root equals the registry's (recheck_ok_at stamped). */
  ok: number[];
  /** One line per batch that did not recheck, naming the batch and why. */
  failures: string[];
}

/**
 * Prove the newest RECHECK_BATCHES verified batches again from the CHECK ROWS: recompute every leaf, rebuild the
 * tree, compare with `verifyRoot`. FAIL names each batch that does not reproduce; INDETERMINATE when the reads fail.
 */
export async function recheckRecentBatches(chain: Pick<AnchorChain, 'verifyRoot'>): Promise<RecheckResult> {
  const out: RecheckResult = { verdict: 'PASS', ok: [], failures: [] };
  try {
    const batches = await dbQuery<{ batch_id: number; leaf_count: number }>(
      `SELECT batch_id, leaf_count FROM call_ledger_batches WHERE state = 'verified' ORDER BY batch_id DESC LIMIT $1::integer`,
      [RECHECK_BATCHES],
    );
    for (const b of batches) {
      const batchId = Number(b.batch_id);
      const leaves = await dbQuery<{ id: number | string; ledger_id: string; kind: 'verdict' | 'odds'; ref_id: number | string; leaf: string; salt: string | null }>(
        `SELECT id, ledger_id, kind, ref_id, leaf, salt FROM call_ledger WHERE batch_id = $1::integer ORDER BY id`,
        [batchId],
      );
      const refIds = [...new Set(leaves.map((l) => Number(l.ref_id)))];
      const checks = new Map((await readLedgerCheckRows(refIds)).map((c) => [String(c.id), c]));
      const rebuilt: Hex[] = [];
      const bad: string[] = [];
      for (const l of leaves) {
        const check = checks.get(String(l.ref_id));
        if (!check) {
          bad.push(`leaf ${String(l.id)}: its check row ${String(l.ref_id)} is gone`);
          continue;
        }
        if (check.ledger_id !== l.ledger_id) {
          bad.push(`leaf ${String(l.id)}: check row ${String(l.ref_id)} carries ledger id ${String(check.ledger_id)}, the leaf ${l.ledger_id}`);
          continue;
        }
        try {
          const leaf = l.kind === 'verdict' ? verdictLeaf(verdictRecordFromRow(check)) : oddsLeaf(oddsRecordFromRow(check), l.salt as Hex);
          if (leaf !== l.leaf) bad.push(`the ${l.kind} leaf of ${l.ledger_id} does not rebuild from check row ${String(l.ref_id)}`);
          rebuilt.push(leaf);
        } catch (e) {
          bad.push(`the ${l.kind} leaf of ${l.ledger_id} cannot be rebuilt: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (rebuilt.length !== Number(b.leaf_count)) {
        bad.push(`${rebuilt.length} of its ${Number(b.leaf_count)} leaves rebuilt`);
      }
      const on = await chain.verifyRoot(batchId);
      const root = rebuilt.length > 0 ? buildMerkleTree(rebuilt).root : null;
      if (root !== on.root || on.count !== BigInt(rebuilt.length)) {
        bad.push(`the rebuilt root ${root ?? 'none'} over ${rebuilt.length} leaves is not the registry's ${on.root} over ${on.count}`);
      }
      if (bad.length > 0) {
        out.failures.push(`call-ledger batch ${batchId}: ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ''}`);
        continue;
      }
      await dbQuery(`UPDATE call_ledger_batches SET recheck_ok_at = now() WHERE batch_id = $1::integer`, [batchId]);
      out.ok.push(batchId);
    }
  } catch (e) {
    return { ...out, verdict: 'INDETERMINATE', failures: [...out.failures, `the recheck could not read: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (out.failures.length > 0) out.verdict = 'FAIL';
  return out;
}

export interface PublishCallLedgerDeps {
  /** Test seam for the registry address (the committed one is null until §9.3). */
  registry?: Hex | null;
  chain?: AnchorChain;
  lock?: AnchorLock;
  hooks?: AnchorHooks;
}

const worst = (a: AnchorVerdict, b: AnchorVerdict): AnchorVerdict =>
  a === 'FAIL' || b === 'FAIL' ? 'FAIL' : a === 'INDETERMINATE' || b === 'INDETERMINATE' ? 'INDETERMINATE' : 'PASS';

/** The CLI body. RETURNS the exit code — runScript takes it only from here. */
export async function main(env: NodeJS.ProcessEnv = process.env, deps: PublishCallLedgerDeps = {}): Promise<number> {
  const log = deps.hooks?.log ?? ((line: string) => console.log(line));
  const say = (verdict: AnchorVerdict, why: string): number => {
    log(`${TAG} ${new Date().toISOString()} ${why}`);
    log(`CALL_LEDGER_ANCHOR_VERDICT=${verdict}`);
    return EXIT[verdict];
  };

  const registry = deps.registry !== undefined ? deps.registry : CALL_LEDGER_REGISTRY.address;
  if (registry === null) {
    return say('INDETERMINATE', 'no call-ledger registry address is committed in onchain-registries.ts — nothing was anchored');
  }
  const key = env.MERKLE_PUBLISHER_KEY;
  if (!deps.chain && !key) return say('INDETERMINATE', 'MERKLE_PUBLISHER_KEY is not set — nothing was anchored');
  if (!isPgBackend()) return say('INDETERMINATE', 'the anchor needs Postgres (DATABASE_URL unset) — nothing was anchored');

  const chain = deps.chain ?? viemAnchorChain({
    registry,
    rpcUrl: env.BASE_RPC_URL || 'https://mainnet.base.org',
    publisherKey: key as string,
    log: (line) => log(`${TAG} ${line}`),
  });
  try {
    const id = await chain.chainId();
    if (id !== BASE_CHAIN_ID) return say('FAIL', `BASE_RPC_URL serves chain ${id}, not Base (${BASE_CHAIN_ID}) — refusing to send`);
    // The ledger table is created by the first receipted check's write; before that there is nothing to anchor.
    if (!(await adoptCallLedger())) return say('PASS', 'the call ledger holds no leaf yet (call_ledger absent) — nothing to anchor');
    await ensureCallLedgerBatches();
  } catch (e) {
    return say('INDETERMINATE', `preflight could not read: ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = await runAnchor({
    ledger: callLedgerAnchorLedger(),
    chain,
    lock: deps.lock ?? pgAdvisoryAnchorLock(env.DATABASE_URL as string),
    hooks: deps.hooks,
  });
  // The engine's mismatch reason already starts with the token: printed once, at the start of its own line.
  if (result.rootMismatch) log(result.reason);
  let verdict = result.verdict;
  let reason = result.reason;
  if (result.verdict === 'PASS') {
    const r = await recheckRecentBatches(chain);
    log(`${TAG} RECHECK verdict=${r.verdict} batches_ok=${r.ok.length} [${r.ok.join(',')}] failures=${r.failures.length}`);
    for (const f of r.failures) log(r.verdict === 'FAIL' ? `ANCHOR_ROOT_MISMATCH recheck ${f}` : `${TAG} RECHECK ${f}`);
    verdict = worst(verdict, r.verdict);
    if (r.verdict !== 'PASS') reason = `${reason}; the recheck is ${r.verdict}`;
  }
  log(`CALL_LEDGER_ANCHOR_SEALED=${result.sealed ?? ''}`);
  log(`CALL_LEDGER_ANCHOR_VERIFIED=${result.verified.join(',')}`);
  return say(verdict, reason);
}

// require.main guard (CJS, target ES2022) — the cron wrapper invokes this directly.
if (require.main === module) {
  // 10 min: seconds of SQL, one receipt wait (≤ 3 min) and seven verifyRoot reads; anything longer is hung, and the
  // next run reconciles whatever this one left.
  void runScript('publish-call-ledger-batch', () => main(), { watchdogMs: 10 * 60_000 });
}
