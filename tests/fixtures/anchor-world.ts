/**
 * DECISION-CALL-V2-W5 CH2 — the anchor's test world: a fake Base registry with a mempool, and the two signal-record
 * tables in their Postgres form.
 *
 * FakeAnchorChain models what the crash-safety argument depends on: a broadcast tx sits in a mempool until it is
 * mined (or dropped); mining `publishRoot` for a batch id already published REVERTS ("Batch already published",
 * MerkleRootRegistry.sol); `verifyRoot` reads zero until a root lands; `RootPublished` is findable afterwards.
 * Every send and every successful publication is recorded per batch id, so a test can assert "none sent twice,
 * none orphaned".
 */
import { keccak256, toHex, type Hex } from 'viem';
import type { AnchorChain, AnchorHooks, AnchorLock, AnchorStep, OnchainBatch, PendingBatch, TxReceiptLite } from '../../src/lib/anchor-batch.js';

const ZERO_ROOT = `0x${'0'.repeat(64)}` as Hex;

interface MempoolTx { hash: Hex; batchId: number; root: Hex; count: bigint }

export class FakeAnchorChain implements AnchorChain {
  readonly registry = new Map<number, OnchainBatch>();
  mempool: MempoolTx[] = [];
  readonly mined = new Map<Hex, { status: 'success' | 'reverted'; blockNumber: bigint; batchId: number }>();
  readonly sends: Array<{ batchId: number; root: Hex; count: number; hash: Hex }> = [];
  block = 40_000_000n;
  clock = 1_794_000_000n;
  private nonce = 0;
  /** When false, waitReceipt does not mine (the tx stays in flight) and throws as a receipt timeout would. */
  mineOnWait = true;
  chain = 8453;

  async chainId(): Promise<number> {
    return this.chain;
  }

  async verifyRoot(batchId: number): Promise<OnchainBatch> {
    return this.registry.get(batchId) ?? { root: ZERO_ROOT, count: 0n, timestamp: 0n };
  }

  async txInFlight(): Promise<boolean> {
    return this.mempool.length > 0;
  }

  async send(b: PendingBatch): Promise<Hex> {
    this.nonce += 1;
    const hash = keccak256(toHex(`tx:${this.nonce}:${b.batchId}:${b.root}`));
    this.sends.push({ batchId: b.batchId, root: b.root, count: b.leafCount, hash });
    this.mempool.push({ hash, batchId: b.batchId, root: b.root, count: BigInt(b.leafCount) });
    return hash;
  }

  private mineOne(t: MempoolTx): void {
    this.block += 1n;
    this.clock += 2n;
    const taken = this.registry.has(t.batchId);
    if (!taken) this.registry.set(t.batchId, { root: t.root, count: t.count, timestamp: this.clock });
    this.mined.set(t.hash, { status: taken ? 'reverted' : 'success', blockNumber: this.block, batchId: t.batchId });
  }

  /** Time passes: every tx in flight lands. */
  mineAll(): void {
    const pending = this.mempool;
    this.mempool = [];
    for (const t of pending) this.mineOne(t);
  }

  /** The node forgets every tx in flight (a dropped tx never lands). */
  dropAll(): void {
    this.mempool = [];
  }

  /** Someone else's root lands for a batch id (the mismatch case). */
  publishForeign(batchId: number, root: Hex, count: number): void {
    this.mineOne({ hash: keccak256(toHex(`foreign:${batchId}`)), batchId, root, count: BigInt(count) });
  }

  async receipt(txHash: Hex): Promise<TxReceiptLite | null> {
    const r = this.mined.get(txHash);
    return r ? { txHash, blockNumber: r.blockNumber, status: r.status } : null;
  }

  async waitReceipt(txHash: Hex): Promise<TxReceiptLite> {
    const t = this.mempool.find((x) => x.hash === txHash);
    if (t && this.mineOnWait) {
      this.mempool = this.mempool.filter((x) => x !== t);
      this.mineOne(t);
    }
    const r = this.mined.get(txHash);
    if (!r) throw Object.assign(new Error(`Timed out while waiting for transaction with hash "${txHash}"`), { name: 'WaitForTransactionReceiptTimeoutError' });
    return { txHash, blockNumber: r.blockNumber, status: r.status };
  }

  async findPublished(batchId: number): Promise<{ txHash: Hex; blockNumber: bigint } | null> {
    for (const [txHash, r] of this.mined) if (r.batchId === batchId && r.status === 'success') return { txHash, blockNumber: r.blockNumber };
    return null;
  }

  sendsFor(batchId: number): number {
    return this.sends.filter((s) => s.batchId === batchId).length;
  }

  publicationsFor(batchId: number): number {
    return [...this.mined.values()].filter((r) => r.batchId === batchId && r.status === 'success').length;
  }
}

/** An in-memory lock with the advisory lock's semantics: one holder, a busy try returns false. */
export function memoryLock(): AnchorLock & { held: boolean } {
  const l = {
    held: false,
    async tryAcquire() {
      if (l.held) return false;
      l.held = true;
      return true;
    },
    async release() {
      l.held = false;
    },
  };
  return l;
}

export class Killed extends Error {
  constructor(readonly step: AnchorStep) {
    super(`killed ${step}`);
    this.name = 'Killed';
  }
}

/** Hooks that stop the run at one step (a kill between two durable steps). The log is collected. */
export function killAt(step: AnchorStep | null, lines: string[] = []): AnchorHooks {
  return {
    at: (s) => {
      if (s === step) throw new Killed(s);
    },
    log: (line) => lines.push(line),
    sleep: async () => {},
  };
}

/**
 * The signal record's two tables in their Postgres form — the columns publish-merkle-batch reads and writes.
 * merkle_batches is performance-db.ts's CREATE_MERKLE_BATCHES_SQL with DATABASE_URL set (pinned by the test).
 */
export const SIGNALS_PG_SQL = `CREATE TABLE IF NOT EXISTS signals (
  id SERIAL PRIMARY KEY,
  coin TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  signal_hash VARCHAR(66),
  merkle_batch_id INTEGER,
  merkle_proof JSONB
)`;

export const MERKLE_BATCHES_PG_SQL = `CREATE TABLE IF NOT EXISTS merkle_batches (
    batch_id INTEGER PRIMARY KEY,
    merkle_root VARCHAR(66) NOT NULL,
    signal_count INTEGER NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number VARCHAR(20) NOT NULL,
    published_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`;

/** A signal hash that is a valid 32-byte leaf, distinct per seed. */
export const signalHash = (seed: string): Hex => keccak256(toHex(`signal:${seed}`));
