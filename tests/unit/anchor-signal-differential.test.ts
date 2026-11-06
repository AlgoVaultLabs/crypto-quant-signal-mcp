/**
 * DECISION-CALL-V2-W5 CH2 — AC2.2, the differential: the migrated signal publisher against the code it replaced.
 *
 * The old publisher (`git show 43d7f238:src/scripts/publish-merkle-batch.ts`, kept as
 * tests/fixtures/legacy-publish-merkle-batch.ts) and the new one each run three daily batches over IDENTICAL
 * signal rows, each on its own real Postgres engine (PGlite) and its own fake Base node. Nothing about viem is
 * faked: both build REAL viem clients, which encode, append the builder-code suffix, estimate, sign and broadcast
 * exactly as in production — only `http()` is swapped for an EIP-1193 provider that answers like a Base node.
 *
 * What must be equal, byte for byte:
 *   - every SIGNED RAW TRANSACTION each sends (so the publishRoot calldata, its suffix, the target, the nonce,
 *     the gas and the fees) — the strongest form of "the same call";
 *   - every builder-code simulation's calldata;
 *   - `merkle_batches` (all columns but `published_at`, a wall-clock stamp) and `signals`
 *     (id, merkle_batch_id, merkle_proof as Postgres renders the JSONB).
 * In three modes: attribution OFF, ON, and ON with a failing simulation (both fall back to UNATTRIBUTED).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { RpcRequestError, decodeFunctionData, encodeAbiParameters, getAddress, keccak256, parseTransaction, slice, toFunctionSelector, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pg = vi.hoisted(() => ({ db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } }));
const rpc = vi.hoisted(() => ({ current: null as null | { request: (a: { method: string; params?: unknown }) => Promise<unknown> }, urls: [] as string[] }));

vi.mock('../../src/lib/performance-db.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/performance-db.js')>();
  const { SQL_PUBLISHED_POPULATION } = await import('../../src/lib/published-population.js');
  const q = async (sql: string, params: unknown[] = []) => (await pg.db!.query(sql, params)).rows as Array<Record<string, unknown>>;
  return {
    ...m,
    isPgBackend: () => true,
    dbQuery: q,
    // The Postgres branch's own SQL, pinned in tests/unit/anchor-batch.test.ts.
    getUnbatchedSignals: async () =>
      q(`SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL AND ${SQL_PUBLISHED_POPULATION} ORDER BY created_at ASC`),
    getNextBatchId: async () => {
      const r = await q(`SELECT COALESCE(MAX(batch_id), 0) as last_id FROM merkle_batches`);
      return parseInt(String(r[0].last_id)) + 1;
    },
  };
});

// Only the transport is replaced: every client either publisher builds is a real viem client over the fake node.
vi.mock('viem', async (orig) => {
  const m = await orig<typeof import('viem')>();
  return {
    ...m,
    http: (url?: string) => {
      rpc.urls.push(String(url));
      return m.custom({ request: (a: { method: string; params?: unknown }) => rpc.current!.request(a) });
    },
  };
});

import { main as signalMain, _resetMerkleBatchSealsForTest } from '../../src/scripts/publish-merkle-batch.js';
import { MERKLE_ROOT_REGISTRY_ABI, SIGNAL_REGISTRY } from '../../src/lib/onchain-registries.js';
import { memoryLock, signalHash, MERKLE_BATCHES_PG_SQL, SIGNALS_PG_SQL } from '../fixtures/anchor-world.js';

const ZERO_ROOT = `0x${'0'.repeat(64)}` as Hex;
/** MerkleRootRegistry.sol `publishRoot(uint256 batchId, bytes32 root, uint256 signalCount)`. */
const PUBLISH_ROOT = toFunctionSelector('publishRoot(uint256,bytes32,uint256)');
const RPC_URL = 'https://base-node.invalid/differential';
const KEY = generatePrivateKey(); // generated per run — never a committed key
const PUBLISHER = privateKeyToAccount(KEY).address;
const CONTRACT = getAddress(SIGNAL_REGISTRY.address!); // as an operator would paste it: EIP-55 mixed case

/**
 * A JSON-RPC error response exactly as viem's http transport surfaces it (RpcRequestError, a BaseError): viem
 * rethrows it untouched and does not retry it. A plain Error would become UnknownRpcError (code -1) — retried.
 */
const nodeError = (method: string, code: number, message: string) =>
  new RpcRequestError({ body: { method }, error: { code, message, data: '0x' }, url: RPC_URL });

/** A Base node as far as these two publishers can tell: chain id, nonce, fees, gas, eth_call, broadcast, receipts. */
class FakeBaseNode {
  readonly sentRaw: Hex[] = [];
  readonly simulated: Hex[] = [];
  readonly methods = new Set<string>();
  readonly registry = new Map<bigint, { root: Hex; count: bigint; timestamp: bigint }>();
  private readonly receipts = new Map<Hex, Record<string, unknown>>();
  private nonce = 7n;
  private block = 40_000_000n;
  private clock = 1_794_000_000n;
  constructor(private readonly simulateFails: boolean) {}

  private blockObj() {
    const h = keccak256(toHex(`block:${this.block}`));
    return {
      number: toHex(this.block), hash: h, parentHash: keccak256(toHex(`block:${this.block - 1n}`)), timestamp: toHex(this.clock),
      baseFeePerGas: toHex(5_000_000n), gasLimit: toHex(150_000_000n), gasUsed: toHex(0n), miner: `0x${'42'.repeat(20)}`,
      nonce: '0x0000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x100',
      logsBloom: `0x${'00'.repeat(256)}`, sha3Uncles: ZERO_ROOT, stateRoot: ZERO_ROOT, receiptsRoot: ZERO_ROOT,
      transactionsRoot: ZERO_ROOT, mixHash: ZERO_ROOT, transactions: [], uncles: [],
    };
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.methods.add(method);
    const p = (params ?? []) as unknown[];
    switch (method) {
      case 'eth_chainId':
        return toHex(8453);
      case 'eth_blockNumber':
        return toHex(this.block);
      case 'eth_getBlockByNumber':
        return this.blockObj();
      case 'eth_maxPriorityFeePerGas':
        return toHex(1_000_000n);
      case 'eth_gasPrice':
        return toHex(6_000_000n);
      case 'eth_estimateGas':
        return toHex(90_000n);
      case 'eth_getTransactionCount':
        return toHex(this.nonce); // pending === latest: nothing in flight
      case 'eth_call': {
        const data = (p[0] as { data: Hex }).data;
        if (data.startsWith(PUBLISH_ROOT)) {
          // the builder-code pre-send simulation
          this.simulated.push(data);
          if (this.simulateFails) throw nodeError('eth_call', 3, 'execution reverted');
          return '0x';
        }
        const { functionName, args } = decodeFunctionData({ abi: MERKLE_ROOT_REGISTRY_ABI, data });
        if (functionName !== 'verifyRoot') throw new Error(`FakeBaseNode: unexpected eth_call ${functionName}`);
        const b = this.registry.get(args![0] as bigint);
        return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [b?.root ?? ZERO_ROOT, b?.count ?? 0n, b?.timestamp ?? 0n]);
      }
      case 'eth_sendRawTransaction': {
        const raw = p[0] as Hex;
        this.sentRaw.push(raw);
        const tx = parseTransaction(raw);
        // publishRoot's three static words; anything after them is the builder-code suffix
        const { args } = decodeFunctionData({ abi: MERKLE_ROOT_REGISTRY_ABI, data: slice(tx.data!, 0, 100) });
        const [batchId, root, count] = args as readonly [bigint, Hex, bigint];
        this.block += 1n;
        this.clock += 2n;
        this.nonce += 1n;
        const taken = this.registry.has(batchId);
        if (!taken) this.registry.set(batchId, { root, count, timestamp: this.clock });
        const hash = keccak256(raw);
        this.receipts.set(hash, {
          transactionHash: hash, transactionIndex: '0x0', blockHash: keccak256(toHex(`block:${this.block}`)), blockNumber: toHex(this.block),
          from: PUBLISHER.toLowerCase(), to: tx.to!.toLowerCase(), cumulativeGasUsed: toHex(60_000n), gasUsed: toHex(60_000n),
          effectiveGasPrice: toHex(6_000_000n), contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`,
          status: taken ? '0x0' : '0x1', type: '0x2',
        });
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return this.receipts.get(p[0] as Hex) ?? null;
      case 'eth_fillTransaction':
        // As a node without it answers (JSON-RPC -32601). viem marks the client and fills the transaction locally.
        throw nodeError(method, -32601, 'the method eth_fillTransaction does not exist/is not available');
      default:
        throw new Error(`FakeBaseNode: unexpected ${method}`);
    }
  }
}

let legacyDb: PGlite;
let newDb: PGlite;
let publishBatch: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['MERKLE_CONTRACT_ADDRESS', 'MERKLE_PUBLISHER_KEY', 'BASE_RPC_URL', 'BASE_BUILDER_CODE_ENABLED', 'BASE_BUILDER_CODE', 'BASE_BUILDER_CODE_SUFFIX'];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  delete process.env.BASE_BUILDER_CODE;
  delete process.env.BASE_BUILDER_CODE_SUFFIX;
  // The legacy module reads these at import, as it did in production.
  process.env.MERKLE_CONTRACT_ADDRESS = CONTRACT;
  process.env.MERKLE_PUBLISHER_KEY = KEY;
  process.env.BASE_RPC_URL = RPC_URL;
  ({ publishBatch } = await import('../fixtures/legacy-publish-merkle-batch.js'));
  legacyDb = await PGlite.create();
  newDb = await PGlite.create();
}, 60_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await legacyDb.close();
  await newDb.close();
});

beforeEach(async () => {
  for (const db of [legacyDb, newDb]) {
    await db.exec('DROP TABLE IF EXISTS merkle_batch_seals, signals, merkle_batches CASCADE');
    await db.exec(`${SIGNALS_PG_SQL}; ${MERKLE_BATCHES_PG_SQL};`);
  }
  _resetMerkleBatchSealsForTest();
  rpc.urls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/**
 * Three daily batches: 7 signals of which 2 sit below the published floor (52) · a single-leaf batch · 6 signals
 * where two share one hash (production has no UNIQUE on signal_hash alone — migration 047's index is not unique).
 */
const BATCHES: Array<Array<{ conf: number; hash: string }>> = [
  [{ conf: 60, hash: 'a1' }, { conf: 70, hash: 'a2' }, { conf: 40, hash: 'a3' }, { conf: 55, hash: 'a4' }, { conf: 80, hash: 'a5' }, { conf: 30, hash: 'a6' }, { conf: 65, hash: 'a7' }],
  [{ conf: 75, hash: 'b1' }],
  [{ conf: 60, hash: 'c1' }, { conf: 61, hash: 'c2' }, { conf: 62, hash: 'c3' }, { conf: 63, hash: 'c4' }, { conf: 64, hash: 'c2' }, { conf: 65, hash: 'c6' }],
];

let createdAt = 1_794_000_000;
async function insertBatch(rows: Array<{ conf: number; hash: string }>): Promise<void> {
  for (const r of rows) {
    createdAt += 60;
    for (const db of [legacyDb, newDb]) {
      await db.query('INSERT INTO signals (coin, confidence, created_at, signal_hash) VALUES ($1, $2, $3, $4)', ['ETH', r.conf, createdAt, signalHash(`diff:${r.hash}`)]);
    }
  }
}

async function runBoth(mode: 'off' | 'on' | 'on-sim-fails') {
  if (mode === 'off') delete process.env.BASE_BUILDER_CODE_ENABLED;
  else process.env.BASE_BUILDER_CODE_ENABLED = '1';
  const legacyNode = new FakeBaseNode(mode === 'on-sim-fails');
  const newNode = new FakeBaseNode(mode === 'on-sim-fails');
  const newLines: string[] = [];
  for (const rows of BATCHES) {
    await insertBatch(rows);

    pg.db = legacyDb;
    rpc.current = legacyNode;
    await publishBatch();

    pg.db = newDb;
    rpc.current = newNode;
    const code = await signalMain(
      { MERKLE_CONTRACT_ADDRESS: CONTRACT, MERKLE_PUBLISHER_KEY: KEY, BASE_RPC_URL: RPC_URL } as unknown as NodeJS.ProcessEnv,
      { lock: memoryLock(), hooks: { log: (l) => newLines.push(l), sleep: async () => {} } },
    );
    expect(code, newLines.join('\n')).toBe(0);
    expect(newLines.at(-1)).toBe('SIGNAL_ANCHOR_VERDICT=PASS');

    // A day passes (the cron is daily; the new publisher seals at most once per UTC day).
    for (const db of [legacyDb, newDb]) await db.exec("UPDATE merkle_batches SET published_at = published_at - interval '1 day'");
    await newDb.exec("UPDATE merkle_batch_seals SET sealed_at = sealed_at - interval '1 day'");
  }
  return { legacyNode, newNode, newLines };
}

const batchesOf = async (db: PGlite) =>
  (await db.query('SELECT batch_id, merkle_root, signal_count, tx_hash, block_number FROM merkle_batches ORDER BY batch_id')).rows;
const signalsOf = async (db: PGlite) =>
  (await db.query('SELECT id, merkle_batch_id, merkle_proof::text AS merkle_proof FROM signals ORDER BY id')).rows as Array<{ id: number; merkle_batch_id: number | null; merkle_proof: string | null }>;

describe('AC2.2 — the migrated signal publisher sends the same bytes and writes the same rows as the code it replaced', () => {
  it.each(['off', 'on', 'on-sim-fails'] as const)('builder-code attribution %s: three batches, byte for byte', async (mode) => {
    const { legacyNode, newNode } = await runBoth(mode);

    // Not vacuous: the legacy run really published three batches and proved every published signal.
    expect(legacyNode.sentRaw).toHaveLength(3);
    const legacyBatches = await batchesOf(legacyDb);
    expect(legacyBatches.map((b) => (b as { signal_count: number }).signal_count)).toEqual([5, 1, 6]);
    const legacySignals = await signalsOf(legacyDb);
    expect(legacySignals.filter((s) => s.merkle_batch_id !== null)).toHaveLength(12);
    expect(legacySignals.filter((s) => s.merkle_batch_id === null)).toHaveLength(2); // the two below the floor

    // The same signed transactions — calldata, suffix, target, nonce, gas, fees, signature.
    expect(newNode.sentRaw).toEqual(legacyNode.sentRaw);
    const calldata = newNode.sentRaw.map((raw) => parseTransaction(raw).data!);
    expect(calldata.map((d) => d.slice(0, 10))).toEqual(Array(3).fill(PUBLISH_ROOT));
    expect(newNode.sentRaw.map((raw) => parseTransaction(raw).to!.toLowerCase())).toEqual(Array(3).fill(SIGNAL_REGISTRY.address!.toLowerCase()));
    if (mode === 'on') expect(calldata.every((d) => d.length > 2 + 2 * 100), 'the suffix rides on every send').toBe(true);
    else expect(calldata.every((d) => d.length === 2 + 2 * 100), 'unattributed: exactly the three ABI words').toBe(true);

    // The same pre-send simulations (none when attribution is off).
    expect(newNode.simulated).toEqual(legacyNode.simulated);
    expect(legacyNode.simulated).toHaveLength(mode === 'off' ? 0 : 3);

    // The same registry state and the same rows.
    expect([...newNode.registry]).toEqual([...legacyNode.registry]);
    expect(await batchesOf(newDb)).toEqual(legacyBatches);
    expect(await signalsOf(newDb)).toEqual(legacySignals);

    // Both read the same RPC variable.
    expect(new Set(rpc.urls)).toEqual(new Set([RPC_URL]));
  }, 120_000);

  it('the duplicate-hash pair gets one proof each, identical in both, and it verifies', async () => {
    await runBoth('off');
    const rows = (await signalsOf(newDb)).filter((s) => s.merkle_batch_id === 3);
    expect(rows).toHaveLength(6);
    const dup = rows.filter((_, i) => i === 1 || i === 4);
    expect(dup[0].merkle_proof).toBe(dup[1].merkle_proof);
  }, 120_000);
});
