/**
 * anchor-batch.ts — DECISION-CALL-V2-W5 CH2: ONE crash-safe anchor for every daily Merkle root AlgoVault publishes.
 *
 * THE DEFECT IT RETIRES. `publish-merkle-batch.ts` SENT `publishRoot` and only THEN wrote its batch row: a kill in
 * the ~3.5 s between (measured 2026-08-29) left a root on chain with no record of it, and the next run minted a NEW
 * batch id, so the orphan was permanent. The interlock registry carried it as the one `no-safe-kill` job.
 *
 * THE ORDER, per batch id, each step durable before the next (Prompt/call-ledger-contract.md § Tree, registry, batches):
 *   sealed    the root and every proof stored, in ONE statement, BEFORE anything is sent
 *   sent      the tx hash stored IMMEDIATELY after the broadcast, before its receipt is awaited
 *   verified  the receipt confirmed AND `verifyRoot(batchId)` read back equal (root and leaf count)
 *
 * EVERY RUN RECONCILES FIRST. Each `sealed` or `sent` batch is settled against `verifyRoot(batchId)` before anything
 * new is sealed:
 *   root equal      → verified (its tx from the stored hash's receipt, else from the `RootPublished` log)
 *   no root (zero)  → send again — but never while a publisher tx is still in flight (a run killed after the
 *                     broadcast has a tx in the mempool that will land; sending again would race it)
 *   root different  → ANCHOR_ROOT_MISMATCH: FAIL and STOP. Nothing further is sealed or sent; the caller pages.
 * A batch id is therefore sent at most once per landing, and a kill at ANY point converges on the next run
 * (tests/unit/anchor-batch.test.ts replays a kill after seal, broadcast, send, receipt and verified).
 *
 * ONE BATCH PER UTC DAY. A ledger seals only when it sealed nothing yet today, so a re-run or catch-up the same day
 * reconciles and stops — the approved cadence is one root a day per registry.
 *
 * ONE LOCK FOR BOTH PUBLISHERS. Both registries are owned by the one publisher EOA, so both publishers spend ONE
 * nonce sequence. `pgAdvisoryAnchorLock` takes ONE Postgres session advisory lock (one key) for the whole run, on a
 * dedicated connection: the server releases it if the process dies. A busy lock is INDETERMINATE, never a wait.
 *
 * Verdicts: PASS (reconciled and, if there was anything to seal, anchored), FAIL (a root mismatch, or a tx that
 * reverted), INDETERMINATE (anything that could not be decided — the lock busy, an RPC or database error, a tx still
 * in flight, a confirmed tx whose root the RPC cannot read back yet). State is never advanced on an INDETERMINATE.
 */
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getBuilderCodeDataSuffix } from './builder-code-constants.js';
import { MERKLE_ROOT_REGISTRY_ABI } from './onchain-registries.js';
import { buildPoolConfig } from './performance-db.js';

export type AnchorVerdict = 'PASS' | 'FAIL' | 'INDETERMINATE';

/** A batch that is sealed (root + proofs stored) but not yet verified on chain. */
export interface PendingBatch {
  batchId: number;
  /** Lowercase 0x + 64 hex. */
  root: Hex;
  /** The `signalCount` argument of `publishRoot`: the batch's leaf count. */
  leafCount: number;
  state: 'sealed' | 'sent';
  /** The last tx hash stored for it (state `sent`), else null. */
  txHash: Hex | null;
}

export interface AnchoredTx {
  txHash: Hex;
  blockNumber: bigint;
  /** `verifyRoot(batchId).timestamp`: the block time the root landed. */
  anchoredAtSec: bigint;
}

/** One ledger's durable state: the call ledger (publish-call-ledger-batch.ts) or the signals (performance-db.ts). */
export interface AnchorLedger {
  readonly name: string;
  /** Every sealed or sent batch, ascending batch id. */
  unresolved(): Promise<PendingBatch[]>;
  /** True when this ledger already sealed a batch on the current UTC day. */
  sealedToday(): Promise<boolean>;
  /** Seal the next batch of every unbatched leaf in ONE statement; null when there is nothing to seal. */
  sealNext(): Promise<PendingBatch | null>;
  markSent(batchId: number, txHash: Hex): Promise<void>;
  markVerified(batchId: number, tx: AnchoredTx): Promise<void>;
}

export interface OnchainBatch {
  root: Hex;
  count: bigint;
  /** 0 when the batch id was never published. */
  timestamp: bigint;
}

export interface TxReceiptLite {
  txHash: Hex;
  blockNumber: bigint;
  status: 'success' | 'reverted';
}

export interface AnchorChain {
  chainId(): Promise<number>;
  verifyRoot(batchId: number): Promise<OnchainBatch>;
  /** True when the publisher has a tx in the mempool (pending nonce above the latest). */
  txInFlight(): Promise<boolean>;
  /** Broadcast `publishRoot(batchId, root, leafCount)`; resolves with the tx hash as soon as it is broadcast. */
  send(batch: PendingBatch): Promise<Hex>;
  /** The receipt, or null when the node has none (not mined, or dropped). */
  receipt(txHash: Hex): Promise<TxReceiptLite | null>;
  /** Waits for the receipt; throws on timeout. */
  waitReceipt(txHash: Hex): Promise<TxReceiptLite>;
  /** The tx that emitted `RootPublished(batchId)` near `atSec`; null when not found. Throws when the logs are unreadable. */
  findPublished(batchId: number, atSec: bigint): Promise<{ txHash: Hex; blockNumber: bigint } | null>;
}

export interface AnchorLock {
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

/** The points a kill can land between durable steps. The engine calls `hooks.at` at each; production passes none. */
export type AnchorStep = 'after-seal' | 'after-broadcast' | 'after-send' | 'after-receipt' | 'after-verified';

export interface AnchorHooks {
  at?: (step: AnchorStep, batchId: number) => void | Promise<void>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface AnchorResult {
  verdict: AnchorVerdict;
  /** One line, naming the batch it concerns. */
  reason: string;
  /** True only for ANCHOR_ROOT_MISMATCH: the run stopped on it and the caller pages. */
  rootMismatch: boolean;
  /** Batch ids this run moved to verified, in order. */
  verified: number[];
  /** The batch id this run sealed, else null. */
  sealed: number | null;
}

type Settled =
  | { kind: 'verified' }
  | { kind: 'stop'; verdict: Exclude<AnchorVerdict, 'PASS'>; reason: string; rootMismatch: boolean };

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

/** How often, and how long apart, a confirmed tx's root is read back before the run calls it INDETERMINATE. */
const READ_BACK_TRIES = 5;
const READ_BACK_GAP_MS = 3_000;

/** Run one ledger's anchor: lock → reconcile → seal (≤ 1 per UTC day) → send → verified. Never throws. */
export async function runAnchor(deps: {
  ledger: AnchorLedger;
  chain: AnchorChain;
  lock: AnchorLock;
  hooks?: AnchorHooks;
}): Promise<AnchorResult> {
  const { ledger, chain, lock } = deps;
  const hooks = deps.hooks ?? {};
  const log = hooks.log ?? ((line: string) => console.log(line));
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: AnchorResult = { verdict: 'PASS', reason: '', rootMismatch: false, verified: [], sealed: null };
  const stop = (s: Extract<Settled, { kind: 'stop' }>): AnchorResult => ({ ...out, verdict: s.verdict, reason: s.reason, rootMismatch: s.rootMismatch });

  const mismatch = (b: PendingBatch, on: OnchainBatch): Settled => ({
    kind: 'stop',
    verdict: 'FAIL',
    rootMismatch: true,
    reason:
      `ANCHOR_ROOT_MISMATCH ${ledger.name} batch ${b.batchId}: the ledger holds root ${b.root} over ${b.leafCount} leaves, ` +
      `the registry holds root ${on.root} over ${on.count} — stopped, nothing further sealed or sent`,
  });
  const undecided = (reason: string): Settled => ({ kind: 'stop', verdict: 'INDETERMINATE', rootMismatch: false, reason });

  /** A root already on chain for this batch id: the same root and count is this batch (find its tx and mark it
   *  verified); anything else is a mismatch, and the run stops. */
  const adopt = async (b: PendingBatch, on: OnchainBatch, knownTx: Hex | null): Promise<Settled> => {
    if (on.root !== b.root || on.count !== BigInt(b.leafCount)) return mismatch(b, on);
    let tx: { txHash: Hex; blockNumber: bigint } | null = null;
    if (knownTx !== null) {
      const rc = await chain.receipt(knownTx);
      if (rc !== null && rc.status === 'success') tx = { txHash: rc.txHash, blockNumber: rc.blockNumber };
    }
    if (tx === null) tx = await chain.findPublished(b.batchId, on.timestamp);
    if (tx === null) return undecided(`${ledger.name} batch ${b.batchId}: its root is on chain but its RootPublished log was not found`);
    await ledger.markVerified(b.batchId, { ...tx, anchoredAtSec: on.timestamp });
    await hooks.at?.('after-verified', b.batchId);
    log(`[anchor] ${ledger.name} batch ${b.batchId}: reconciled — already on chain in block ${tx.blockNumber} (tx ${tx.txHash})`);
    return { kind: 'verified' };
  };

  /** Send, record the hash at once, await the receipt, read the root back, then mark verified. */
  const sendAndConfirm = async (b: PendingBatch): Promise<Settled> => {
    const txHash = await chain.send(b);
    await hooks.at?.('after-broadcast', b.batchId);
    // The idempotency record, IMMEDIATELY after the irreversible send (build-and-runtime rule).
    await ledger.markSent(b.batchId, txHash);
    await hooks.at?.('after-send', b.batchId);
    log(`[anchor] ${ledger.name} batch ${b.batchId}: sent tx ${txHash} (${b.leafCount} leaves, root ${b.root})`);
    const rc = await chain.waitReceipt(txHash);
    await hooks.at?.('after-receipt', b.batchId);
    if (rc.status !== 'success') {
      // A revert with the id already taken on chain ("Batch already published") is settled against the registry
      // at once: the same root is this batch, landed by an earlier tx; a different root is a mismatch.
      const taken = await chain.verifyRoot(b.batchId);
      if (taken.timestamp !== 0n) return adopt(b, taken, null);
      return { kind: 'stop', verdict: 'FAIL', rootMismatch: false, reason: `${ledger.name} batch ${b.batchId}: tx ${txHash} reverted in block ${rc.blockNumber}` };
    }
    let on = await chain.verifyRoot(b.batchId);
    for (let i = 1; i < READ_BACK_TRIES && on.timestamp === 0n; i++) {
      await sleep(READ_BACK_GAP_MS);
      on = await chain.verifyRoot(b.batchId);
    }
    if (on.timestamp === 0n) {
      return undecided(`${ledger.name} batch ${b.batchId}: tx ${txHash} confirmed in block ${rc.blockNumber}, but verifyRoot still reads no root after ${READ_BACK_TRIES} tries`);
    }
    if (on.root !== b.root || on.count !== BigInt(b.leafCount)) return mismatch(b, on);
    await ledger.markVerified(b.batchId, { txHash: rc.txHash, blockNumber: rc.blockNumber, anchoredAtSec: on.timestamp });
    await hooks.at?.('after-verified', b.batchId);
    log(`[anchor] ${ledger.name} batch ${b.batchId}: verified in block ${rc.blockNumber} (tx ${rc.txHash})`);
    return { kind: 'verified' };
  };

  /** Settle one sealed or sent batch against the registry. */
  const settle = async (b: PendingBatch): Promise<Settled> => {
    const on = await chain.verifyRoot(b.batchId);
    if (on.timestamp === 0n) {
      if (b.txHash !== null) {
        const rc = await chain.receipt(b.txHash);
        if (rc !== null && rc.status === 'success') {
          return undecided(`${ledger.name} batch ${b.batchId}: tx ${b.txHash} succeeded but verifyRoot reads no root yet`);
        }
        if (rc === null && (await chain.txInFlight())) {
          return undecided(`${ledger.name} batch ${b.batchId}: tx ${b.txHash} is still in flight`);
        }
      } else if (await chain.txInFlight()) {
        return undecided(`${ledger.name} batch ${b.batchId}: a publisher tx is in flight (a run stopped after its broadcast?) — waiting for it to land`);
      }
      log(`[anchor] ${ledger.name} batch ${b.batchId}: sealed but not on chain — sending`);
      return sendAndConfirm(b);
    }
    return adopt(b, on, b.txHash);
  };

  try {
    if (!(await lock.tryAcquire())) {
      return { ...out, verdict: 'INDETERMINATE', reason: `the anchor lock is held by another publisher run — ${ledger.name} not run` };
    }
  } catch (e) {
    return { ...out, verdict: 'INDETERMINATE', reason: `the anchor lock could not be taken: ${errText(e)}` };
  }
  try {
    // 1. Reconcile, oldest first. Nothing new is sealed while an older batch is unresolved.
    const pending = await ledger.unresolved();
    for (const b of pending) {
      const s = await settle(b);
      if (s.kind === 'stop') return stop(s);
      out.verified.push(b.batchId);
    }
    // 2. Seal — at most one batch per UTC day.
    if (await ledger.sealedToday()) {
      return { ...out, reason: `${ledger.name}: reconciled ${pending.length} batch(es); a batch is already sealed today (UTC), so nothing new is sealed` };
    }
    const b = await ledger.sealNext();
    if (b === null) {
      return { ...out, reason: `${ledger.name}: reconciled ${pending.length} batch(es); 0 unbatched leaves — no batch today` };
    }
    out.sealed = b.batchId;
    await hooks.at?.('after-seal', b.batchId);
    log(`[anchor] ${ledger.name} batch ${b.batchId}: sealed ${b.leafCount} leaves, root ${b.root}`);
    // 3. Send, then verify.
    const s = await sendAndConfirm(b);
    if (s.kind === 'stop') return stop(s);
    out.verified.push(b.batchId);
    return { ...out, reason: `${ledger.name}: batch ${b.batchId} anchored (${b.leafCount} leaves); reconciled ${pending.length} older batch(es)` };
  } catch (e) {
    // Every step before this point is durable; nothing after the throw ran. The next run reconciles from here.
    return { ...out, verdict: 'INDETERMINATE', reason: `${ledger.name}: stopped on an error, state left for the next run to reconcile — ${errText(e)}` };
  } finally {
    await lock.release().catch((e: unknown) => log(`[anchor] lock release failed (the session end releases it): ${errText(e)}`));
  }
}

// ── The Postgres advisory lock ─────────────────────────────────────────────────────────────────────

/** ONE key for both publishers: the ASCII bytes of "Anchor" (0x416e63686f72). */
export const ANCHOR_LOCK_KEY = '71942369996658';

/** A session advisory lock on a DEDICATED connection, held for the run; the server drops it if the process dies. */
export function pgAdvisoryAnchorLock(connectionString: string): AnchorLock {
  const { Client } = require('pg') as typeof import('pg');
  let client: import('pg').Client | null = null;
  const end = async (): Promise<void> => {
    const c = client;
    client = null;
    if (c) await c.end().catch(() => undefined);
  };
  return {
    async tryAcquire() {
      const c = new Client(buildPoolConfig(connectionString));
      client = c;
      await c.connect();
      const r = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS ok', [ANCHOR_LOCK_KEY]);
      if (r.rows[0]?.ok === true) return true;
      await end();
      return false;
    },
    async release() {
      if (!client) return;
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [ANCHOR_LOCK_KEY]);
      } finally {
        await end();
      }
    },
  };
}

// ── The viem adapter ───────────────────────────────────────────────────────────────────────────────

type ViemReceipt = { transactionHash: Hex; blockNumber: bigint; status: 'success' | 'reverted' };

/** The slice of a viem PublicClient the anchor reads. A test passes a recording fake with this shape. */
export interface AnchorPublicClient {
  getChainId(): Promise<number>;
  readContract(args: { address: Hex; abi: typeof MERKLE_ROOT_REGISTRY_ABI; functionName: 'verifyRoot'; args: readonly [bigint] }): Promise<readonly [Hex, bigint, bigint]>;
  getTransactionCount(args: { address: Hex; blockTag: 'latest' | 'pending' }): Promise<number>;
  simulateContract(args: Record<string, unknown>): Promise<unknown>;
  getTransactionReceipt(args: { hash: Hex }): Promise<ViemReceipt>;
  waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<ViemReceipt>;
  getBlock(args: { blockTag: 'latest' }): Promise<{ number: bigint; timestamp: bigint }>;
  getContractEvents(args: {
    address: Hex;
    abi: typeof MERKLE_ROOT_REGISTRY_ABI;
    eventName: 'RootPublished';
    args: { batchId: bigint };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Array<{ transactionHash: Hex | null; blockNumber: bigint | null }>>;
}

/** The slice of a viem WalletClient the anchor writes with. */
export interface AnchorWalletClient {
  writeContract(args: Record<string, unknown>): Promise<Hex>;
}

export interface ViemAnchorChainOptions {
  registry: Hex;
  rpcUrl: string;
  /** Read from the environment by the caller; never logged, never part of an error. */
  publisherKey: string;
  /** Test seam: the AC2.2 differential drives THIS adapter with recording fakes in place of viem's clients. */
  clients?: { publicClient: AnchorPublicClient; walletClient: AnchorWalletClient; account: { address: Hex } };
  log?: (line: string) => void;
}

/** Base produces one block every 2 s; `findPublished` estimates a block from a timestamp with it. */
const BASE_BLOCK_SECONDS = 2n;
/** The receipt wait; a longer wait is INDETERMINATE and the next run reconciles. */
const RECEIPT_TIMEOUT_MS = 180_000;

/** The chain side of the anchor over viem: `publishRoot` exactly as the signal publisher has always sent it. */
export function viemAnchorChain(o: ViemAnchorChainOptions): AnchorChain {
  const log = o.log ?? ((line: string) => console.log(line));
  let clients = o.clients;
  if (!clients) {
    const key = (o.publisherKey.startsWith('0x') ? o.publisherKey : `0x${o.publisherKey}`) as Hex;
    const account = privateKeyToAccount(key);
    clients = {
      account,
      // Cast to the slices above: viem's generic signatures are wider than what the anchor calls.
      publicClient: createPublicClient({ chain: base, transport: http(o.rpcUrl) }) as unknown as AnchorPublicClient,
      walletClient: createWalletClient({ chain: base, transport: http(o.rpcUrl), account }) as unknown as AnchorWalletClient,
    };
  }
  const { publicClient: pc, walletClient: wc, account } = clients;
  const lite = (r: ViemReceipt): TxReceiptLite => ({ txHash: r.transactionHash, blockNumber: r.blockNumber, status: r.status });

  return {
    chainId: () => pc.getChainId(),
    async verifyRoot(batchId) {
      const [root, count, timestamp] = await pc.readContract({
        address: o.registry,
        abi: MERKLE_ROOT_REGISTRY_ABI,
        functionName: 'verifyRoot',
        args: [BigInt(batchId)] as const,
      });
      return { root: root.toLowerCase() as Hex, count, timestamp };
    },
    async txInFlight() {
      const [pending, latest] = await Promise.all([
        pc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        pc.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      ]);
      return pending > latest;
    },
    async send(b) {
      // Byte-for-byte the signal publisher's call since OPS-BASE-BUILDER-CODE-W1: the same writeArgs, the same
      // ADDITIVE builder-code suffix behind the same simulate gate, falling back to UNATTRIBUTED on any failure.
      const writeArgs = {
        address: o.registry,
        abi: MERKLE_ROOT_REGISTRY_ABI,
        functionName: 'publishRoot' as const,
        args: [BigInt(b.batchId), b.root, BigInt(b.leafCount)] as const,
      };
      let dataSuffix = getBuilderCodeDataSuffix();
      if (dataSuffix) {
        try {
          await pc.simulateContract({ ...writeArgs, account, dataSuffix });
          log(`Builder-code attribution ON (suffix ${dataSuffix})`);
        } catch (err) {
          log(`Builder-code simulation FAILED — publishing UNATTRIBUTED: ${String(err)}`);
          dataSuffix = undefined;
        }
      }
      return wc.writeContract({ ...writeArgs, ...(dataSuffix ? { dataSuffix } : {}) });
    },
    async receipt(txHash) {
      try {
        return lite(await pc.getTransactionReceipt({ hash: txHash }));
      } catch (e) {
        if (e instanceof Error && e.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },
    async waitReceipt(txHash) {
      return lite(await pc.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS }));
    },
    async findPublished(batchId, atSec) {
      const head = await pc.getBlock({ blockTag: 'latest' });
      const lag = head.timestamp > atSec ? (head.timestamp - atSec) / BASE_BLOCK_SECONDS : 0n;
      const est = head.number > lag ? head.number - lag : 0n;
      for (const span of [60n, 300n]) {
        const fromBlock = est > span ? est - span : 0n;
        const toBlock = est + span < head.number ? est + span : head.number;
        const logs = await pc.getContractEvents({
          address: o.registry,
          abi: MERKLE_ROOT_REGISTRY_ABI,
          eventName: 'RootPublished',
          args: { batchId: BigInt(batchId) },
          fromBlock,
          toBlock,
        });
        const hit = logs.find((l) => l.transactionHash !== null && l.blockNumber !== null);
        if (hit) return { txHash: hit.transactionHash as Hex, blockNumber: hit.blockNumber as bigint };
      }
      return null;
    },
  };
}
