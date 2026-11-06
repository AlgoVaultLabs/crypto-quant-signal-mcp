/**
 * DECISION-CALL-V2-W5 CH2 — the ONE crash-safe anchor (src/lib/anchor-batch.ts) driving BOTH publishers over a REAL
 * Postgres engine (PGlite) and a fake Base registry with a mempool (tests/fixtures/anchor-world.ts).
 *
 * `dbQuery` is routed to PGlite, so every statement the two ledgers issue — the 056 ensures, the one-statement seal,
 * the one-statement confirm — is parsed, planned and constrained by Postgres itself. The call ledger's leaves are
 * REAL: each comes from a real check through the engine and the CH1 writer, so the recheck rebuilds them from rows.
 *
 * AC2.1 — a kill after seal, broadcast, send, receipt or verified converges on the next run, for both publishers,
 *         to one root per batch id: none orphaned, none sent twice.
 * AC2.3 — each mutation the spec names turns at least one test here red (the runs are in the wave's evidence).
 * And: 056 is the two lazy ensures; the lock; the mismatch stop; a revert settled against the registry; one batch
 * per UTC day (a reconciled batch never uses up the next day's seal); the recheck reads the CHECK ROWS.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Hex } from 'viem';

const pg = vi.hoisted(() => ({ db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } }));

vi.mock('../../src/lib/performance-db.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/performance-db.js')>();
  const { SQL_PUBLISHED_POPULATION } = await import('../../src/lib/published-population.js');
  const q = async (sql: string, params: unknown[] = []) => (await pg.db!.query(sql, params)).rows as Array<Record<string, unknown>>;
  return {
    ...m,
    isPgBackend: () => true,
    dbQuery: q,
    // The two UNCHANGED readers the signal publisher calls, on their Postgres branch's own SQL (pinned below).
    getUnbatchedSignals: async () =>
      q(`SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL AND ${SQL_PUBLISHED_POPULATION} ORDER BY created_at ASC`),
    getNextBatchId: async () => {
      const r = await q(`SELECT COALESCE(MAX(batch_id), 0) as last_id FROM merkle_batches`);
      return parseInt(String(r[0].last_id)) + 1;
    },
  };
});

import { runAnchor, ANCHOR_LOCK_KEY, type AnchorHooks, type AnchorStep } from '../../src/lib/anchor-batch.js';
import {
  main as signalMain,
  signalAnchorLedger,
  CREATE_MERKLE_BATCH_SEALS_SQL,
  _resetMerkleBatchSealsForTest,
} from '../../src/scripts/publish-merkle-batch.js';
import {
  main as ledgerMain,
  CREATE_CALL_LEDGER_BATCHES_SQL,
  RECHECK_BATCHES,
  _resetCallLedgerBatchesForTest,
} from '../../src/scripts/publish-call-ledger-batch.js';
import { recordPreTradeCheck, _resetPreTradeCheckLogForTest } from '../../src/lib/pre-trade-check-log.js';
import { runPreTradeCheck, type PreTradeCheckParams } from '../../src/tools/pre-trade-check.js';
import { verifyProof } from '../../src/lib/merkle.js';
import { SIGNAL_REGISTRY } from '../../src/lib/onchain-registries.js';
import type { LicenseInfo } from '../../src/types.js';
import { preTradeWorld } from '../fixtures/pre-trade-world.js';
import { FakeAnchorChain, killAt, memoryLock, signalHash, MERKLE_BATCHES_PG_SQL, SIGNALS_PG_SQL } from '../fixtures/anchor-world.js';

const ROOT = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const M056 = read('migrations/056_anchor_batches.sql');
const M056_DOWN = read('migrations/056_anchor_batches.down.sql');
const NOW = Date.parse('2026-11-07T05:13:01.123Z');
const LEDGER_REGISTRY = `0x${'c1'.repeat(20)}` as Hex;
const OTHER_ROOT = `0x${'ee'.repeat(32)}` as Hex;
const STEPS: AnchorStep[] = ['after-seal', 'after-broadcast', 'after-send', 'after-receipt', 'after-verified'];
type Pub = 'signal' | 'call-ledger';
const PUBS: Pub[] = ['signal', 'call-ledger'];

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
  pg.db = db;
  process.env.ALGOVAULT_IP_HASH_KEY = 'anchor-batch-test-key-0123456789abcdef';
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('DROP TABLE IF EXISTS call_ledger_batches, merkle_batch_seals, call_ledger, pre_trade_checks, signals, merkle_batches CASCADE');
  await db.exec(`${SIGNALS_PG_SQL}; ${MERKLE_BATCHES_PG_SQL};`);
  _resetPreTradeCheckLogForTest();
  _resetMerkleBatchSealsForTest();
  _resetCallLedgerBatchesForTest();
});

// ── the world ───────────────────────────────────────────────────────────────────────────────────

let seq = 0;
async function seedSignals(k: number, confidence = 60): Promise<void> {
  for (let i = 0; i < k; i++) {
    seq += 1;
    await db.query('INSERT INTO signals (coin, confidence, created_at, signal_hash) VALUES ($1, $2, $3, $4)', ['BTC', confidence, 1_794_000_000 + seq, signalHash(String(seq))]);
  }
}
const FREE = (): LicenseInfo => ({ tier: 'free', key: `av_free_anchor_${++seq}`, outcome: 'RESOLVED' } as LicenseInfo);
/** Real checks through the engine and the CH1 writer: each adds a check row and its two leaves. */
async function logChecks(k: number): Promise<void> {
  for (let i = 0; i < k; i++) {
    const params = { coin: 'BTC', side: i % 2 ? 'short' : 'long', sizeUsd: 10_000 + 100 * ++seq, holdHours: 8, timeframe: '4h' } as unknown as PreTradeCheckParams;
    const out = await runPreTradeCheck(params, FREE(), preTradeWorld(NOW));
    if (out.kind !== 'ok') throw new Error(`fixture check refused: ${JSON.stringify(out)}`);
    if (!(await recordPreTradeCheck({ response: out.response, facts: out.facts, channel: 'mcp', licenseKey: null }))) throw new Error('fixture check not logged');
  }
}
const seed = (pub: Pub, k = 3) => (pub === 'signal' ? seedSignals(k + 2) : logChecks(k));

async function runPub(pub: Pub, chain: FakeAnchorChain, opts: { step?: AnchorStep | null; lock?: ReturnType<typeof memoryLock>; hooks?: AnchorHooks; env?: NodeJS.ProcessEnv } = {}) {
  const lines: string[] = [];
  const hooks = opts.hooks ?? killAt(opts.step ?? null, lines);
  if (opts.hooks) hooks.log = (l) => lines.push(l);
  const lock = opts.lock ?? memoryLock();
  const code = pub === 'signal'
    ? await signalMain(opts.env ?? ({ MERKLE_CONTRACT_ADDRESS: SIGNAL_REGISTRY.address, MERKLE_PUBLISHER_KEY: 'present-not-used' } as unknown as NodeJS.ProcessEnv), { chain, lock, hooks })
    : await ledgerMain(opts.env ?? ({} as NodeJS.ProcessEnv), { registry: LEDGER_REGISTRY, chain, lock, hooks });
  const tokens = lines.filter((l) => /^(SIGNAL|CALL_LEDGER)_ANCHOR_VERDICT=/.test(l));
  return { code, tokens, token: tokens.at(-1)?.split('=')[1], lines };
}

type Batch = { id: number; root: Hex; count: number; state: string };
async function batchesOf(pub: Pub): Promise<Batch[]> {
  const sql = pub === 'signal'
    ? 'SELECT batch_id AS id, merkle_root AS root, signal_count AS count, state FROM merkle_batch_seals ORDER BY batch_id'
    : 'SELECT batch_id AS id, root, leaf_count AS count, state FROM call_ledger_batches ORDER BY batch_id';
  try {
    return ((await db.query(sql)).rows as Batch[]).map((b) => ({ ...b, id: Number(b.id), count: Number(b.count) }));
  } catch {
    return [];
  }
}
async function leavesOf(pub: Pub): Promise<Array<{ leaf: Hex; batch: number | null; proof: Hex[] | null }>> {
  const sql = pub === 'signal'
    ? 'SELECT signal_hash AS leaf, merkle_batch_id AS batch, merkle_proof AS proof FROM signals ORDER BY id'
    : 'SELECT leaf, batch_id AS batch, proof FROM call_ledger ORDER BY id';
  return (await db.query(sql)).rows as Array<{ leaf: Hex; batch: number | null; proof: Hex[] | null }>;
}
const ageSeals = (pub: Pub) =>
  db.exec(pub === 'signal'
    ? "UPDATE merkle_batch_seals SET sealed_at = sealed_at - interval '1 day'"
    : "UPDATE call_ledger_batches SET sealed_at = sealed_at - interval '1 day'");

/** Every batch verified with exactly one landing of its root; every root on chain has its row; every leaf proves. */
async function expectConverged(pub: Pub, chain: FakeAnchorChain): Promise<Batch[]> {
  const bs = await batchesOf(pub);
  expect(bs.length).toBeGreaterThan(0);
  for (const b of bs) {
    expect(b.state, `batch ${b.id}`).toBe('verified');
    const on = await chain.verifyRoot(b.id);
    expect(on.root).toBe(b.root);
    expect(on.count).toBe(BigInt(b.count));
    expect(chain.publicationsFor(b.id), `landings of batch ${b.id}`).toBe(1);
  }
  for (const id of chain.registry.keys()) expect(bs.some((b) => b.id === id), `the root of batch ${id} is orphaned`).toBe(true);
  if (pub === 'signal') {
    const mb = (await db.query('SELECT batch_id AS id, merkle_root AS root, signal_count AS count FROM merkle_batches ORDER BY batch_id')).rows as Batch[];
    expect(mb.map((r) => [Number(r.id), r.root, Number(r.count)])).toEqual(bs.map((b) => [b.id, b.root, b.count]));
  }
  for (const l of await leavesOf(pub)) {
    expect(l.batch, `leaf ${l.leaf} is unbatched`).not.toBeNull();
    const b = bs.find((x) => x.id === Number(l.batch))!;
    expect(verifyProof(l.leaf, l.proof!, b.root), `leaf ${l.leaf} proves to batch ${b.id}`).toBe(true);
  }
  return bs;
}

// ── 056 ─────────────────────────────────────────────────────────────────────────────────────────

/** Statements as text: comments out, whitespace collapsed, no trailing `;`. */
const statementsOf = (sql: string) =>
  sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('056 — the migration IS the two lazy ensures, and Postgres accepts it', () => {
  it('the same two statements, in order, once normalized', () => {
    expect(statementsOf(M056)).toEqual([norm(CREATE_CALL_LEDGER_BATCHES_SQL), norm(CREATE_MERKLE_BATCH_SEALS_SQL)]);
  });

  it('runs twice (idempotent), and its DESTRUCTIVE down drops both tables', async () => {
    await db.exec(M056);
    await db.exec(M056);
    const n = async (t: string) => Number(((await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = '${t}'`)).rows[0] as { n: number }).n);
    expect([await n('call_ledger_batches'), await n('merkle_batch_seals')]).toEqual([1, 1]);
    expect(M056_DOWN).toContain('DESTRUCTIVE');
    await db.exec(M056_DOWN);
    expect([await n('call_ledger_batches'), await n('merkle_batch_seals')]).toEqual([0, 0]);
  });

  it('the constraints hold the state machine: a verified row carries its anchor, a sent row its tx, a seal its proofs until verified', async () => {
    await db.exec(M056);
    const bad = async (sql: string) => expect(db.query(sql)).rejects.toThrow(/check constraint|violates/);
    const R = `'0x${'ab'.repeat(32)}'`;
    const T = `'0x${'cd'.repeat(32)}'`;
    await bad(`INSERT INTO call_ledger_batches (batch_id, root, leaf_count, state) VALUES (1, ${R}, 2, 'sent')`);
    await bad(`INSERT INTO call_ledger_batches (batch_id, root, leaf_count, state, tx_hash) VALUES (1, ${R}, 2, 'verified', ${T})`);
    await bad(`INSERT INTO call_ledger_batches (batch_id, root, leaf_count, state) VALUES (1, ${R}, 0, 'sealed')`);
    await bad(`INSERT INTO call_ledger_batches (batch_id, root, leaf_count, state) VALUES (1, 'not-a-root', 2, 'sealed')`);
    await bad(`INSERT INTO merkle_batch_seals (batch_id, merkle_root, signal_count, state) VALUES (1, ${R}, 2, 'sealed')`);
    await bad(`INSERT INTO merkle_batch_seals (batch_id, merkle_root, signal_count, signal_ids, proofs, state, tx_hash) VALUES (1, ${R}, 2, '{1,2}', '{"[]"}', 'sent', ${T})`);
    await bad(`INSERT INTO merkle_batch_seals (batch_id, merkle_root, signal_count, signal_ids, proofs, state, tx_hash, verified_at) VALUES (1, ${R}, 2, '{1}', '{"[]"}', 'verified', ${T}, now())`);
    await bad(`INSERT INTO merkle_batch_seals (batch_id, merkle_root, signal_count, signal_ids, proofs, state, tx_hash) VALUES (1, ${R}, 2, '{1}', '{"[]"}', 'sealed', ${T})`);
    await db.query(`INSERT INTO merkle_batch_seals (batch_id, merkle_root, signal_count, state, tx_hash, verified_at) VALUES (1, ${R}, 2, 'verified', ${T}, now())`);
  });

  it('PG16 only: no statement uses 17/18-only syntax (PGlite runs 18.6, production 16.13)', () => {
    const sql = [M056, M056_DOWN, read('src/lib/anchor-batch.ts'), read('src/scripts/publish-merkle-batch.ts'), read('src/scripts/publish-call-ledger-batch.ts')].join('\n');
    for (const re of [/\bRETURNING\s+(OLD|NEW)\b/i, /\bMERGE\s+INTO\b/i, /\bJSON_(TABLE|QUERY|VALUE|EXISTS)\s*\(/i, /\buuidv7\s*\(/i, /\bVIRTUAL\b/, /\bWITHOUT\s+OVERLAPS\b/i, /\bON_ERROR\b/]) {
      expect(sql, String(re)).not.toMatch(re);
    }
  });
});

// ── AC2.1 ───────────────────────────────────────────────────────────────────────────────────────

describe('AC2.1 — a kill at any step converges on the next run: one root per batch id, none orphaned, none sent twice', () => {
  it.each(PUBS.flatMap((p) => STEPS.map((s) => [p, s] as const)))('%s killed %s', async (pub, step) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    const r1 = await runPub(pub, chain, { step });
    expect(r1.token).toBe('INDETERMINATE');
    expect(r1.tokens).toHaveLength(1);
    chain.mineAll(); // time passes: a tx broadcast before the kill lands
    const r2 = await runPub(pub, chain);
    expect(r2.token, r2.lines.join('\n')).toBe('PASS');
    expect(r2.code).toBe(0);
    const bs = await expectConverged(pub, chain);
    expect(bs.map((b) => b.id)).toEqual([1]);
    expect(chain.sendsFor(1), 'sends of batch 1').toBe(1);
    if (pub === 'call-ledger') {
      const rc = (await db.query('SELECT recheck_ok_at FROM call_ledger_batches WHERE batch_id = 1')).rows[0] as { recheck_ok_at: unknown };
      expect(rc.recheck_ok_at, 'the next PASS run rechecks it').not.toBeNull();
    }
  });

  it.each(PUBS)('%s: re-run while the killed run’s tx is still in flight waits (INDETERMINATE, nothing sent), then converges', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    await runPub(pub, chain, { step: 'after-broadcast' });
    const r2 = await runPub(pub, chain);
    expect(r2.token).toBe('INDETERMINATE');
    expect(chain.sends).toHaveLength(1);
    chain.mineAll();
    expect((await runPub(pub, chain)).token).toBe('PASS');
    await expectConverged(pub, chain);
    expect(chain.sendsFor(1)).toBe(1);
  });

  it.each(PUBS)('%s: a tx that never lands (killed after broadcast, then dropped) is sent again — and lands once', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    await runPub(pub, chain, { step: 'after-broadcast' });
    chain.dropAll();
    expect((await runPub(pub, chain)).token).toBe('PASS');
    await expectConverged(pub, chain);
    expect(chain.sendsFor(1)).toBe(2);
    expect(chain.publicationsFor(1)).toBe(1);
  });

  it.each(PUBS)('%s: a resend that reverts because the first tx landed after all is THIS batch, adopted from the registry', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    await runPub(pub, chain, { step: 'after-broadcast' });
    const lost = chain.mempool;
    chain.dropAll(); // the node forgot it …
    const hooks = killAt(null);
    hooks.at = (s) => {
      if (s === 'after-send') {
        chain.mempool = [...lost, ...chain.mempool]; // … and it reappears, ahead of the resend
        chain.mineAll();
      }
    };
    const r2 = await runPub(pub, chain, { hooks });
    expect(r2.token, r2.lines.join('\n')).toBe('PASS');
    await expectConverged(pub, chain);
    expect(chain.sendsFor(1)).toBe(2);
    expect([...chain.mined.values()].filter((m) => m.batchId === 1).map((m) => m.status)).toEqual(['success', 'reverted']);
  });
});

// ── the stops ───────────────────────────────────────────────────────────────────────────────────

describe('a root mismatch stops the run, names the batch once, and seals or sends nothing more', () => {
  it.each(PUBS)('%s: the registry holds another root for the sealed batch id', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    await runPub(pub, chain, { step: 'after-seal' });
    chain.publishForeign(1, OTHER_ROOT, 3);
    await ageSeals(pub); // a new seal would otherwise be due today
    await seed(pub);
    const r = await runPub(pub, chain);
    expect(r.token).toBe('FAIL');
    expect(r.code).toBe(1);
    const mm = r.lines.filter((l) => l.startsWith('ANCHOR_ROOT_MISMATCH '));
    expect(mm).toHaveLength(1);
    expect(mm[0]).toMatch(new RegExp(`^ANCHOR_ROOT_MISMATCH ${pub} batch 1: `));
    expect(mm[0]).not.toContain('ANCHOR_ROOT_MISMATCH ANCHOR_ROOT_MISMATCH');
    expect(chain.sends).toHaveLength(0);
    expect((await batchesOf(pub)).map((b) => [b.id, b.state])).toEqual([[1, 'sealed']]);
  });

  it.each(PUBS)('%s: a send that reverts on an id taken by another root is a mismatch in the SAME run', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    const hooks = killAt(null);
    hooks.at = (s, id) => { if (s === 'after-send') chain.publishForeign(id, OTHER_ROOT, 3); };
    const r = await runPub(pub, chain, { hooks });
    expect(r.token).toBe('FAIL');
    expect(r.lines.some((l) => l.startsWith(`ANCHOR_ROOT_MISMATCH ${pub} batch 1: `))).toBe(true);
    expect((await batchesOf(pub)).map((b) => b.state)).toEqual(['sent']);
  });

  it.each(PUBS)('%s: the lock held by the other publisher is INDETERMINATE — nothing sealed, nothing sent', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    const lock = memoryLock();
    lock.held = true;
    const r = await runPub(pub, chain, { lock });
    expect(r.token).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
    expect(r.lines.join('\n')).toMatch(/anchor lock is held/);
    expect(await batchesOf(pub)).toEqual([]);
    expect(chain.sends).toHaveLength(0);
  });

  it('the lock is released when a run ends, however it ends', async () => {
    await seedSignals(4);
    const chain = new FakeAnchorChain();
    const lock = memoryLock();
    await runPub('signal', chain, { step: 'after-send', lock });
    expect(lock.held).toBe(false);
    await runPub('signal', chain, { lock });
    expect(lock.held).toBe(false);
  });
});

// ── one batch per UTC day ───────────────────────────────────────────────────────────────────────

describe('one batch per UTC day, judged on the SEAL day', () => {
  it.each(PUBS)('%s: a second run the same day seals nothing; the next day seals the rest', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    expect((await runPub(pub, chain)).token).toBe('PASS');
    await seed(pub);
    const r2 = await runPub(pub, chain);
    expect(r2.token).toBe('PASS');
    expect(r2.lines.join('\n')).toMatch(/already sealed today/);
    expect((await batchesOf(pub)).map((b) => b.id)).toEqual([1]);
    await ageSeals(pub);
    expect((await runPub(pub, chain)).token).toBe('PASS');
    const bs = await expectConverged(pub, chain);
    expect(bs.map((b) => b.id)).toEqual([1, 2]);
  });

  it.each(PUBS)('%s: a batch sealed yesterday and confirmed today does not use up today’s seal', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    await runPub(pub, chain, { step: 'after-send' });
    await ageSeals(pub);
    chain.mineAll();
    await seed(pub);
    const r = await runPub(pub, chain);
    expect(r.token).toBe('PASS');
    const bs = await expectConverged(pub, chain);
    expect(bs.map((b) => b.id)).toEqual([1, 2]);
  });

  it('signal: a batch the pre-W5 publisher published today (no seal row) counts as today’s', async () => {
    await seedSignals(4);
    await db.query(`INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number) VALUES (1, $1, 3, $2, '100')`, [OTHER_ROOT, `0x${'ab'.repeat(32)}`]);
    const chain = new FakeAnchorChain();
    const r = await runPub('signal', chain);
    expect(r.token).toBe('PASS');
    expect(r.lines.join('\n')).toMatch(/already sealed today/);
    await db.exec("UPDATE merkle_batches SET published_at = published_at - interval '1 day'");
    expect((await runPub('signal', chain)).token).toBe('PASS');
    expect((await batchesOf('signal')).map((b) => [b.id, b.state])).toEqual([[2, 'verified']]);
  });

  it.each(PUBS)('%s: nothing to seal is PASS — no batch, no send', async (pub) => {
    if (pub === 'call-ledger') await logChecks(1);
    const chain = new FakeAnchorChain();
    if (pub === 'call-ledger') {
      expect((await runPub(pub, chain)).token).toBe('PASS');
      await ageSeals(pub);
      chain.sends.length = 0;
    }
    const r = await runPub(pub, chain);
    expect(r.token).toBe('PASS');
    expect(r.lines.join('\n')).toMatch(/0 unbatched leaves|No new signals/);
    expect(chain.sends).toHaveLength(0);
  });

  it('signal: only the published population is batched (confidence below the floor stays unbatched)', async () => {
    await seedSignals(3);
    await seedSignals(2, 10);
    await runPub('signal', new FakeAnchorChain());
    const rows = (await db.query('SELECT confidence, merkle_batch_id FROM signals ORDER BY id')).rows as Array<{ confidence: number; merkle_batch_id: number | null }>;
    expect(rows.map((r) => r.merkle_batch_id === null)).toEqual([false, false, false, true, true]);
  });
});

// ── the refusals ────────────────────────────────────────────────────────────────────────────────

describe('the publishers refuse before they send', () => {
  it('signal: MERKLE_CONTRACT_ADDRESS that is not the committed signal registry is FAIL — nothing sealed or sent', async () => {
    await seedSignals(4);
    const chain = new FakeAnchorChain();
    const r = await runPub('signal', chain, { env: { MERKLE_CONTRACT_ADDRESS: `0x${'99'.repeat(20)}`, MERKLE_PUBLISHER_KEY: 'present-not-used' } as unknown as NodeJS.ProcessEnv });
    expect(r.token).toBe('FAIL');
    expect(r.lines.join('\n')).toMatch(/refusing to send/);
    expect(chain.sends).toHaveLength(0);
    expect(await batchesOf('signal')).toEqual([]);
  });

  it('signal: the same address in another case is the same address', async () => {
    await seedSignals(4);
    const chain = new FakeAnchorChain();
    const r = await runPub('signal', chain, { env: { MERKLE_CONTRACT_ADDRESS: SIGNAL_REGISTRY.address!.toUpperCase().replace('0X', '0x'), MERKLE_PUBLISHER_KEY: 'present-not-used' } as unknown as NodeJS.ProcessEnv });
    expect(r.token).toBe('PASS');
  });

  it('signal: not configured is INDETERMINATE, never a silent exit 0', async () => {
    const r = await runPub('signal', new FakeAnchorChain(), { env: {} as NodeJS.ProcessEnv });
    expect(r.token).toBe('INDETERMINATE');
    expect(r.code).toBe(3);
  });

  it.each(PUBS)('%s: an RPC that is not Base is FAIL — nothing sent', async (pub) => {
    await seed(pub);
    const chain = new FakeAnchorChain();
    chain.chain = 1;
    const r = await runPub(pub, chain);
    expect(r.token).toBe('FAIL');
    expect(chain.sends).toHaveLength(0);
  });

  it('call-ledger: no committed registry address is INDETERMINATE', async () => {
    await logChecks(1);
    const lines: string[] = [];
    const code = await ledgerMain({} as NodeJS.ProcessEnv, { registry: null, chain: new FakeAnchorChain(), lock: memoryLock(), hooks: killAt(null, lines) });
    expect(code).toBe(3);
    expect(lines).toContain('CALL_LEDGER_ANCHOR_VERDICT=INDETERMINATE');
  });

  it('call-ledger: before the first receipted check there is nothing to anchor — PASS', async () => {
    const r = await runPub('call-ledger', new FakeAnchorChain());
    expect(r.token).toBe('PASS');
    expect(r.lines.join('\n')).toMatch(/holds no leaf yet/);
  });
});

// ── the recheck ─────────────────────────────────────────────────────────────────────────────────

describe('the recheck proves each recent batch again FROM THE CHECK ROWS', () => {
  it('a clean ledger rechecks: recheck_ok_at stamped', async () => {
    await logChecks(3);
    const r = await runPub('call-ledger', new FakeAnchorChain());
    expect(r.token).toBe('PASS');
    expect(r.lines.some((l) => /RECHECK verdict=PASS batches_ok=1 \[1\]/.test(l))).toBe(true);
  });

  it('a check row edited after its anchor fails the recheck even though every stored leaf is intact', async () => {
    await logChecks(3);
    const chain = new FakeAnchorChain();
    expect((await runPub('call-ledger', chain)).token).toBe('PASS');
    await db.exec('UPDATE pre_trade_checks SET size_usd = size_usd + 1 WHERE id = (SELECT MIN(id) FROM pre_trade_checks)');
    const r = await runPub('call-ledger', chain);
    expect(r.token).toBe('FAIL');
    expect(r.lines.some((l) => l.startsWith('ANCHOR_ROOT_MISMATCH recheck call-ledger batch 1: '))).toBe(true);
  });

  it('a stored leaf replaced after its anchor fails the recheck', async () => {
    await logChecks(2);
    const chain = new FakeAnchorChain();
    await runPub('call-ledger', chain);
    await db.exec(`UPDATE call_ledger SET leaf = '0x${'ab'.repeat(32)}' WHERE id = (SELECT MIN(id) FROM call_ledger)`);
    expect((await runPub('call-ledger', chain)).token).toBe('FAIL');
  });

  it(`it reads the newest ${RECHECK_BATCHES} verified batches`, () => {
    expect(RECHECK_BATCHES).toBe(7);
    expect(read('src/scripts/publish-call-ledger-batch.ts')).toMatch(/WHERE state = 'verified' ORDER BY batch_id DESC LIMIT \$1::integer`,\s*\[RECHECK_BATCHES\]/);
  });
});

// ── the pins ────────────────────────────────────────────────────────────────────────────────────

describe('pins', () => {
  const PERF = read('src/lib/performance-db.ts');
  const ENGINE = read('src/lib/anchor-batch.ts');

  it('the mocked readers ARE performance-db’s Postgres-branch SQL (so this file tests what production runs)', () => {
    expect(PERF).toContain('`SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL AND ${SQL_PUBLISHED_POPULATION} ORDER BY created_at ASC`');
    expect(PERF).toContain('`SELECT COALESCE(MAX(batch_id), 0) as last_id FROM merkle_batches`');
  });

  it('the fixture’s merkle_batches is performance-db’s, column for column', () => {
    for (const col of ['batch_id INTEGER PRIMARY KEY,', 'merkle_root VARCHAR(66) NOT NULL,', 'signal_count INTEGER NOT NULL,', 'tx_hash VARCHAR(66) NOT NULL,', 'block_number VARCHAR(20) NOT NULL,']) {
      expect(PERF).toContain(col);
      expect(MERKLE_BATCHES_PG_SQL).toContain(col);
    }
    expect(PERF).toContain("published_at ${process.env.DATABASE_URL ? 'TIMESTAMP NOT NULL DEFAULT NOW()'");
  });

  it('both publishers take the ONE advisory lock, on one key', () => {
    for (const f of ['src/scripts/publish-merkle-batch.ts', 'src/scripts/publish-call-ledger-batch.ts']) {
      expect(read(f)).toMatch(/lock: deps\.lock \?\? pgAdvisoryAnchorLock\(env\.DATABASE_URL as string\)/);
    }
    expect(ENGINE.match(/pg_try_advisory_lock\(\$1::bigint\)/g)).toHaveLength(1);
    expect(ENGINE.match(/\[ANCHOR_LOCK_KEY\]/g)).toHaveLength(2);
    // The key IS the bytes its comment names: derived here from the string, so the two can never drift apart again.
    expect(BigInt(ANCHOR_LOCK_KEY)).toBe(BigInt(`0x${Buffer.from('Anchor', 'ascii').toString('hex')}`));
    expect(ENGINE).toContain('the ASCII bytes of "Anchor" (0x416e63686f72)');
  });

  it('the engine runs reconcile → seal → send → verified, and never seals while an older batch is unresolved', () => {
    const body = ENGINE.slice(ENGINE.indexOf('export async function runAnchor'));
    const at = (s: string) => body.indexOf(s);
    expect(at('await lock.tryAcquire()')).toBeGreaterThan(0);
    expect(at('await ledger.unresolved()')).toBeGreaterThan(at('await lock.tryAcquire()'));
    expect(at('await ledger.sealedToday()')).toBeGreaterThan(at('await ledger.unresolved()'));
    expect(at('await ledger.sealNext()')).toBeGreaterThan(at('await ledger.sealedToday()'));
  });

  it('a direct runAnchor on the signal ledger never throws, even on a database error', async () => {
    await db.exec('DROP TABLE merkle_batches');
    const r = await runAnchor({ ledger: signalAnchorLedger(() => {}), chain: new FakeAnchorChain(), lock: memoryLock(), hooks: killAt(null) });
    expect(r.verdict).toBe('INDETERMINATE');
  });
});
