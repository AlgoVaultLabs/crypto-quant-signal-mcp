/**
 * DECISION-CALL-V2-W5 CH3 — the lookup and the line: `verify://check/{id}` and `GET /api/verify-check?id=`.
 *
 * Contract: the vault's Prompt/call-ledger-contract.md § Lookup, § Copy and § Vectors.
 *
 *   AC3.1  The allow-list. Every body carries EXACTLY the contract's keys for its status, and a key outside the list
 *          never survives the shared builder. The lookup reads only `call_ledger` (never its salt, never an odds row)
 *          and `call_ledger_batches` — never `pre_trade_checks` or `pre_trade_check_outcomes`. That is judged twice:
 *          on the SQL it actually issues, and on its source text.
 *   AC3.2  End to end on a real Postgres engine (PGlite). A check is served by the real engine, logged by the CH1
 *          writer and anchored by the CH2 publisher onto a fake Base registry, then read back over MCP (the served
 *          `ledger.verify` URI itself) and over HTTP. The chain runs served response → record → leaf → proof → root,
 *          and the root is the registry's. A tampered decision fails. The contract's own vectors pin the served
 *          proof: B's verdict leaf, its two siblings, the root.
 *   AC3.3  Copy 1–3 are byte-identical to the contract: the /docs paragraph (in the partial and on the rendered
 *          page), the resource description as resources/templates/list serves it, and the HTTP 400 body.
 *
 * The shared builder has one other user. `verify://signal/{id}` must serve byte for byte what it served before CH3.
 * That is pinned for all three statuses and both id forms, against the pre-CH3 handler's logic restated as an
 * oracle; this block was run green on the pre-CH3 tree before the refactor.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Hex } from 'viem';

const pg = vi.hoisted(() => {
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  delete process.env.DATABASE_URL;
  process.env.ALGOVAULT_IP_HASH_KEY = 'verify-check-test-key-0123456789abcdef';
  return {
    db: null as null | { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    /** Every statement dbQuery issued, in order — AC3.1 judges the lookup on what it actually ran. */
    sql: [] as string[],
    /** verify://signal/{id} fixtures, keyed `hash:<0x…>` / `id:<n>` — the two readers the handler calls. */
    signals: new Map<string, Record<string, unknown>>(),
  };
});

vi.mock('../../src/lib/performance-db.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/performance-db.js')>();
  return {
    ...m,
    isPgBackend: () => true,
    dbQuery: async (sql: string, params: unknown[] = []) => {
      pg.sql.push(sql);
      return (await pg.db!.query(sql, params)).rows;
    },
    getSignalByHash: async (h: string) => pg.signals.get(`hash:${h}`) ?? null,
    getSignalWithBatch: async (id: number) => pg.signals.get(`id:${id}`) ?? null,
  };
});

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createSandboxServer,
  verifyCheckLookup,
  verifyCheckHttpHandler,
  publicVerifyBody,
  VERIFY_SURFACES,
  VERIFY_CHECK_DESCRIPTION,
  VERIFY_CHECK_BAD_ID,
} from '../../src/index.js';
import { main as ledgerMain, _resetCallLedgerBatchesForTest, CREATE_CALL_LEDGER_BATCHES_SQL } from '../../src/scripts/publish-call-ledger-batch.js';
import { recordPreTradeCheck, _resetPreTradeCheckLogForTest } from '../../src/lib/pre-trade-check-log.js';
import { runPreTradeCheck, type PreTradeCheckParams, type PreTradeCheckResponse } from '../../src/tools/pre-trade-check.js';
import { verdictLeaf, verdictRecordFromResponse, CALL_LEDGER_ID_RE } from '../../src/lib/call-ledger.js';
import { buildMerkleTree, verifyProof } from '../../src/lib/merkle.js';
import { CALL_LEDGER_REGISTRY } from '../../src/lib/onchain-registries.js';
import { PKG_VERSION } from '../../src/lib/pkg-version.js';
import type { LicenseInfo } from '../../src/types.js';
import { preTradeWorld } from '../fixtures/pre-trade-world.js';
import { FakeAnchorChain, killAt, memoryLock } from '../fixtures/anchor-world.js';

const ROOT = resolve(__dirname, '../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const NOW = Date.parse('2026-11-07T05:13:01.123Z');
const REG = `0x${'c1'.repeat(20)}` as Hex;

// ── The contract, verbatim ──────────────────────────────────────────────────────────────────────
const COPY1 = 'Every check comes with a receipt: verify://check/{id} proves the verdict your agent got was recorded unchanged, anchored daily on Base.';
const COPY2 = 'Verify a pre_trade_check receipt against its on-chain Merkle proof. Returns {status, leaf, proof, root, batch, tx}: proof only, never the order or its outcome.';
const COPY3 = 'invalid id (expected pcl_ + 32 hex)';
/** § Lookup: the keys of each body (beside `status` and `_algovault`), in the contract's order. */
const CONTRACT_KEYS = {
  verified: ['id', 'leaf', 'proof', 'root', 'batch', 'tx', 'registry', 'chain', 'anchored_at'],
  pending: ['id', 'leaf'],
  notfound: ['requested_id'],
} as const;
const bodyKeys = (s: keyof typeof CONTRACT_KEYS) => ['_algovault', 'status', ...CONTRACT_KEYS[s]].sort();
/** § Vectors: the four leaves of A and B, their root, and the proof of B's verdict leaf. */
const V = {
  aId: 'pcl_0123456789abcdef0123456789abcdef',
  bId: 'pcl_fedcba9876543210fedcba9876543210',
  aVerdict: '0x24eba412f14c8f6c6dbe725002308afa821a4bd4efbc1c3023ef669a527f131c' as Hex,
  aOdds: '0x3acf600987faa4557d3b252e4f1bf3673bce03353a6a9b0c3ee4e9851c81775b' as Hex,
  bVerdict: '0xf3a11b3698eea5926cb061f63bca5ea4b457f35de3030fcf8b69bc0c1a351a84' as Hex,
  bOdds: '0xa9d19d05a7fea3edb0c9c57b1bbedb9b801b59b491c9c04fb793fc7928cbdffa' as Hex,
  root: '0xa73168a5df181705caaaebbc79cd5a64e25f399a9476bb896680895ea4d12a1d' as Hex,
  bProof: [
    '0xa9d19d05a7fea3edb0c9c57b1bbedb9b801b59b491c9c04fb793fc7928cbdffa',
    '0xa06427c3bd8d904dce0f2460b00c24f6a906ff70cc51481314502153ab586781',
  ] as Hex[],
};

// ── The world: PGlite, an MCP client over the real server, the real HTTP handler ────────────────
let db: PGlite;
let client: Client;
let closeMcp: () => Promise<void>;
let server: http.Server;
let base: string;

beforeAll(async () => {
  db = await PGlite.create();
  pg.db = db;
  const s = createSandboxServer();
  client = new Client({ name: 'verify-check-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
  closeMcp = async () => {
    await client.close();
    await s.close();
  };
  const app = express();
  app.get('/api/verify-check', verifyCheckHttpHandler); // mounted exactly as src/index.ts mounts it (pinned below)
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await closeMcp?.();
  server?.close();
  await db?.close();
});

async function resetDb(): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS call_ledger_batches, call_ledger, pre_trade_checks CASCADE');
  _resetPreTradeCheckLogForTest();
  _resetCallLedgerBatchesForTest();
}

async function readResource(uri: string): Promise<Record<string, unknown>> {
  const r = await client.readResource({ uri });
  return JSON.parse(String((r.contents[0] as { text: string }).text));
}

async function getHttp(query: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/verify-check${query}`);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

const withoutTs = (b: Record<string, unknown>) => {
  const meta = { ...(b._algovault as Record<string, unknown>) };
  delete meta.ts;
  return { ...b, _algovault: meta };
};

let seq = 0;
const FREE = (): LicenseInfo => ({ tier: 'free', key: `av_free_verify_${++seq}`, outcome: 'RESOLVED' } as LicenseInfo);

/** One check through the real engine and the CH1 writer: the served response, its row and its two leaves. */
async function serveAndLog(side: 'long' | 'short'): Promise<PreTradeCheckResponse> {
  const params = { coin: 'BTC', side, sizeUsd: 10_000 + 100 * ++seq, holdHours: 8, timeframe: '4h' } as unknown as PreTradeCheckParams;
  const out = await runPreTradeCheck(params, FREE(), preTradeWorld(NOW));
  if (out.kind !== 'ok') throw new Error(`fixture check refused: ${JSON.stringify(out)}`);
  if (!out.response.ledger) throw new Error('fixture check carries no receipt');
  if (!(await recordPreTradeCheck({ response: out.response, facts: out.facts, channel: 'mcp', licenseKey: null }))) throw new Error('fixture check not logged');
  return out.response;
}

// ── AC3.2 + AC3.1: the end-to-end world ─────────────────────────────────────────────────────────
describe('a receipt, end to end: served → logged → anchored → looked up → verified', () => {
  let chain: FakeAnchorChain;
  let anchored: PreTradeCheckResponse[];
  let late: PreTradeCheckResponse;

  beforeAll(async () => {
    await resetDb();
    anchored = [await serveAndLog('long'), await serveAndLog('short'), await serveAndLog('long')];
    chain = new FakeAnchorChain();
    const lines: string[] = [];
    const code = await ledgerMain({} as NodeJS.ProcessEnv, { registry: REG, chain, lock: memoryLock(), hooks: killAt(null, lines) });
    expect(lines.filter((l) => l.startsWith('CALL_LEDGER_ANCHOR_VERDICT=')), lines.join('\n')).toEqual(['CALL_LEDGER_ANCHOR_VERDICT=PASS']);
    expect(code).toBe(0);
    late = await serveAndLog('short'); // logged after the anchor: its leaf waits for tomorrow's batch
  }, 60_000);

  it('served response → record → leaf → proof → root: the root is the one the registry holds', async () => {
    for (const r of anchored) {
      const leaf = verdictLeaf(verdictRecordFromResponse(r, r.ledger!.id));
      expect(leaf, 'the served values rebuild the served leaf').toBe(r.ledger!.leaf);
      expect(r.ledger!.verify).toBe(`verify://check/${r.ledger!.id}`);

      const body = await readResource(r.ledger!.verify); // the receipt's own URI, resolved by the real server
      expect(body.status).toBe('verified');
      expect(body.id).toBe(r.ledger!.id);
      expect(body.leaf).toBe(leaf);
      expect(verifyProof(leaf, body.proof as Hex[], body.root as Hex), 'the proof reaches the root').toBe(true);

      const onchain = await chain.verifyRoot(body.batch as number);
      expect(body.root, 'the served root is the registry\'s root for that batch').toBe(onchain.root);
      expect(body.tx).toBe((await chain.findPublished(body.batch as number))!.txHash);
      expect(body.registry).toBe(CALL_LEDGER_REGISTRY.address);
      expect(body.chain).toBe('base');
      expect(Number.isFinite(Date.parse(body.anchored_at as string))).toBe(true);
    }
  });

  it('a tampered decision fails: its leaf is not the served one, and the proof does not reach the root', async () => {
    const r = anchored[1];
    const rec = verdictRecordFromResponse(r, r.ledger!.id);
    const body = await readResource(r.ledger!.verify);
    for (const decision of ['GO', 'CAUTION', 'WAIT'].filter((d) => d !== rec.decision)) {
      const forged = verdictLeaf({ ...rec, decision });
      expect(forged).not.toBe(r.ledger!.leaf);
      expect(verifyProof(forged, body.proof as Hex[], body.root as Hex)).toBe(false);
    }
  });

  it('HTTP serves the same body: 200 verified, 200 pending, 404 notfound', async () => {
    const r = anchored[0];
    const viaHttp = await getHttp(`?id=${r.ledger!.id}`);
    expect(viaHttp.status).toBe(200);
    expect(withoutTs(viaHttp.body)).toEqual(withoutTs(await readResource(r.ledger!.verify)));

    const pending = await getHttp(`?id=${late.ledger!.id}`);
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe('pending');
    expect(pending.body.leaf).toBe(late.ledger!.leaf);
    expect(withoutTs(pending.body)).toEqual(withoutTs(await readResource(late.ledger!.verify)));

    const unknown = `pcl_${'0'.repeat(32)}`;
    const missing = await getHttp(`?id=${unknown}`);
    expect(missing.status).toBe(404);
    expect(missing.body.status).toBe('notfound');
    expect(missing.body.requested_id).toBe(unknown);
  });

  it('AC3.1: each status carries exactly the contract\'s keys', async () => {
    const verified = await readResource(anchored[2].ledger!.verify);
    const pending = await readResource(late.ledger!.verify);
    const missing = (await getHttp(`?id=pcl_${'a'.repeat(32)}`)).body;
    expect(Object.keys(verified).sort()).toEqual(bodyKeys('verified'));
    expect(Object.keys(pending).sort()).toEqual(bodyKeys('pending'));
    expect(Object.keys(missing).sort()).toEqual(bodyKeys('notfound'));
    for (const b of [verified, pending, missing]) {
      expect(b._algovault).toMatchObject({ tool: 'verify-check', version: PKG_VERSION, source: 'verify://check/{id}' });
    }
  });

  it('AC3.1: the SQL it runs reads call_ledger (verdict rows, no salt) and call_ledger_batches only', async () => {
    for (const id of [anchored[0].ledger!.id, late.ledger!.id, `pcl_${'b'.repeat(32)}`]) {
      pg.sql = [];
      const r = await verifyCheckLookup(id);
      expect([200, 404]).toContain(r.http);
      expect(pg.sql.length, 'the lookup issued no SQL — it judged nothing').toBeGreaterThan(0);
      for (const sql of pg.sql) {
        expect(sql).not.toMatch(/pre_trade_check/i);
        expect(sql).not.toMatch(/\bsalt\b/i);
        const tables = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
        for (const t of tables) expect(['call_ledger', 'call_ledger_batches']).toContain(t);
        if (tables.includes('call_ledger')) expect(sql).toMatch(/kind = 'verdict'/);
      }
    }
  });
});

describe('the contract vectors: the served proof of B\'s verdict leaf is the contract\'s', () => {
  beforeAll(async () => {
    await resetDb();
    await serveAndLog('long'); // creates the 055 objects through the CH1 writer's own ensure
    await db.exec('DELETE FROM call_ledger');
    const tree = buildMerkleTree([V.aVerdict, V.aOdds, V.bVerdict, V.bOdds]);
    expect(tree.root).toBe(V.root);
    const rows: Array<[string, 'verdict' | 'odds', Hex, Hex | null]> = [
      [V.aId, 'verdict', V.aVerdict, null],
      [V.aId, 'odds', V.aOdds, `0x${'11'.repeat(32)}`],
      [V.bId, 'verdict', V.bVerdict, null],
      [V.bId, 'odds', V.bOdds, `0x${'22'.repeat(32)}`],
    ];
    for (const [i, [id, kind, leaf, salt]] of rows.entries()) {
      await db.query(
        `INSERT INTO call_ledger (ledger_id, kind, tool, ref_id, leaf, salt, batch_id, proof) VALUES ($1, $2, 'pre_trade_check', $3, $4, $5, 1, $6::jsonb)`,
        [id, kind, 100 + Math.floor(i / 2), leaf, salt, JSON.stringify(tree.proofs.get(leaf))],
      );
    }
    await db.exec(CREATE_CALL_LEDGER_BATCHES_SQL);
    await db.query(
      `INSERT INTO call_ledger_batches (batch_id, root, leaf_count, state, tx_hash, block_number, anchored_at) VALUES (1, $1, 4, 'verified', $2, 40000001, '2026-11-07T00:13:05Z')`,
      [V.root, `0x${'ab'.repeat(32)}`],
    );
  }, 60_000);

  it('B: the vector leaf, the vector proof, the vector root', async () => {
    const body = await readResource(`verify://check/${V.bId}`);
    expect(body).toMatchObject({ status: 'verified', id: V.bId, leaf: V.bVerdict, proof: V.bProof, root: V.root, batch: 1, tx: `0x${'ab'.repeat(32)}`, chain: 'base', anchored_at: '2026-11-07T00:13:05.000Z' });
    expect(verifyProof(V.bVerdict, V.bProof, V.root)).toBe(true);
  });

  it('a stored proof that does not reach its root is never served as verified', async () => {
    await db.query(`UPDATE call_ledger SET proof = $1::jsonb WHERE ledger_id = $2 AND kind = 'verdict'`, [JSON.stringify([...V.bProof].reverse()), V.bId]);
    const viaHttp = await getHttp(`?id=${V.bId}`);
    expect(viaHttp.status).toBe(500);
    expect(viaHttp.body).toEqual({ error: 'Verification failed' });
    expect(await readResource(`verify://check/${V.bId}`)).toEqual({ error: 'Verification failed' });
  });
});

describe('before the first anchor: the tables appear one at a time', () => {
  beforeAll(resetDb);

  it('no call_ledger yet: a well-formed id is notfound (404), not an error', async () => {
    const id = `pcl_${'c'.repeat(32)}`;
    const r = await getHttp(`?id=${id}`);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ status: 'notfound', requested_id: id });
  });

  it('call_ledger but no call_ledger_batches (logged, never anchored): the receipt is pending (200)', async () => {
    const r = await serveAndLog('long');
    expect((await db.query(`SELECT to_regclass('call_ledger_batches') IS NULL AS absent`)).rows).toEqual([{ absent: true }]);
    const viaHttp = await getHttp(`?id=${r.ledger!.id}`);
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.body).toMatchObject({ status: 'pending', id: r.ledger!.id, leaf: r.ledger!.leaf });
    expect(Object.keys(viaHttp.body).sort()).toEqual(bodyKeys('pending'));
  });
});

// ── AC3.1: the builder and the source ───────────────────────────────────────────────────────────
describe('AC3.1 — one public-only allow-list', () => {
  const LEAKS = { salt: `0x${'11'.repeat(32)}`, decision: 'GO', p_timeout: 0.6, caller_ref: 'pc1:abc', odds_leaf: V.aOdds, coin: 'BTC', outcome_return_pct: 1.2 };

  it('VERIFY_SURFACES.check is the contract\'s list, key for key, in order', () => {
    expect(VERIFY_SURFACES.check.keys).toEqual(CONTRACT_KEYS);
    expect(VERIFY_SURFACES.signal.keys).toEqual({ verified: ['leaf', 'root', 'batch', 'tx'], pending: ['leaf', 'requested_id'], notfound: ['requested_id'] });
  });

  it.each(['verified', 'pending', 'notfound'] as const)('the builder drops every key outside the list (%s)', (status) => {
    const full = { _algovault: { tool: 'x' }, status, id: V.bId, leaf: V.bVerdict, proof: V.bProof, root: V.root, batch: 1, tx: '0x', registry: REG, chain: 'base', anchored_at: 'x', requested_id: V.bId, ...LEAKS };
    expect(Object.keys(publicVerifyBody('check', full)).sort()).toEqual(bodyKeys(status));
    const signal = Object.keys(publicVerifyBody('signal', full));
    for (const k of Object.keys(LEAKS)) expect(signal).not.toContain(k);
  });

  it('the builder keeps the order the body was built in (a verify body\'s bytes are part of its shape)', () => {
    const b = publicVerifyBody('check', { _algovault: {}, status: 'verified', id: 'i', salt: 's', leaf: 'l', proof: [], root: 'r', batch: 1, tx: 't', registry: 'g', chain: 'base', anchored_at: 'a' });
    expect(Object.keys(b)).toEqual(['_algovault', 'status', 'id', 'leaf', 'proof', 'root', 'batch', 'tx', 'registry', 'chain', 'anchored_at']);
  });

  it('the lookup\'s source reads neither the check row nor its outcome, and never the salt', () => {
    const src = read('src/index.ts');
    const start = src.indexOf('async function readCheckReceipt(');
    const end = src.indexOf('\n}\n', src.indexOf('export async function verifyCheckHttpHandler('));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const lookup = src.slice(start, end).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    expect(lookup).toContain('call_ledger_batches');
    expect(lookup).not.toMatch(/pre_trade_check/);
    expect(lookup).not.toMatch(/\bsalt\b/);
  });

  it('src/index.ts mounts the handler this file drives, and registers the resource through the one lookup', () => {
    const src = read('src/index.ts');
    expect(src).toContain("app.get('/api/verify-check', verifyCheckHttpHandler);");
    const reg = src.slice(src.indexOf("server.resource(\n    'verify-check',"));
    expect(reg).toMatch(/^server\.resource\(\n {4}'verify-check',\n {4}new ResourceTemplate\('verify:\/\/check\/\{id\}', \{ list: undefined \}\),/);
    expect(reg.slice(0, reg.indexOf('\n  );'))).toContain('await verifyCheckLookup(');
  });
});

// ── AC3.3: the copy ─────────────────────────────────────────────────────────────────────────────
/** An element's rendered text: tags dropped, the three entities the partial uses decoded. */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe('AC3.3 — Copy 1–3, byte-identical to the contract', () => {
  it.each([
    ['the partial', 'docs-src/partials/pre-trade-check.html'],
    ['the rendered /docs', 'landing/docs.html'],
  ])('Copy 1 in %s: after the response description, before the field table', (_, file) => {
    // /docs carries a Response Fields heading in every tool's section: scope to #pre-trade-check first.
    const page = read(file);
    const si = page.indexOf('<section id="pre-trade-check"');
    const next = si === -1 ? -1 : page.indexOf('<section id="', si + 1);
    const html = si === -1 ? page : page.slice(si, next === -1 ? undefined : next);
    const at = html.indexOf('>Response Fields<');
    expect(at).toBeGreaterThan(-1);
    const section = html.slice(at, html.indexOf('</table>', at));
    const p = section.match(/<p [^>]*data-copy-locked="call-ledger-receipt"[^>]*>([\s\S]*?)<\/p>/);
    expect(p, 'the copy-locked receipt paragraph').not.toBeNull();
    expect(textOf(p![1])).toBe(COPY1);
    expect(section.indexOf('The decision, why, and every figure behind it.')).toBeLessThan(section.indexOf('data-copy-locked="call-ledger-receipt"'));
    expect(section.indexOf('data-copy-locked="call-ledger-receipt"')).toBeLessThan(section.indexOf('<table'));
  });

  it('Copy 2 is the resource description, as resources/templates/list serves it', async () => {
    expect(VERIFY_CHECK_DESCRIPTION).toBe(COPY2);
    const { resourceTemplates } = await client.listResourceTemplates();
    const t = resourceTemplates.find((x) => x.uriTemplate === 'verify://check/{id}');
    expect(t, 'verify://check/{id} is advertised').toBeTruthy();
    expect(t!.description).toBe(COPY2);
    expect(t!.mimeType).toBe('application/json');
  });

  it.each([
    ['no id', ''],
    ['an empty id', '?id='],
    ['31 hex', `?id=pcl_${'a'.repeat(31)}`],
    ['33 hex', `?id=pcl_${'a'.repeat(33)}`],
    ['uppercase hex', `?id=pcl_${'A'.repeat(32)}`],
    ['an uppercase prefix', `?id=PCL_${'a'.repeat(32)}`],
    ['a non-hex digit', `?id=pcl_${'a'.repeat(31)}g`],
    ['a leaf, not an id', `?id=${V.bVerdict}`],
    ['a repeated id', `?id=${V.bId}&id=${V.bId}`],
  ])('Copy 3 is the HTTP 400 body (%s)', async (_, q) => {
    expect(VERIFY_CHECK_BAD_ID).toBe(COPY3);
    const r = await getHttp(q);
    expect(r.status).toBe(400);
    expect(r.text).toBe(JSON.stringify({ error: COPY3 }));
  });

  it('the MCP face of a malformed id is the same body', async () => {
    expect(await readResource('verify://check/not-an-id')).toEqual({ error: COPY3 });
    expect(CALL_LEDGER_ID_RE.test('not-an-id')).toBe(false);
  });
});

// ── The shared builder's other user: verify://signal/{id}, byte for byte ─────────────────────────
/** The pre-CH3 verify-signal handler's body, restated (src/index.ts at 9d25c7e7, lines 696–747). */
function legacySignalText(rawId: string, row: Record<string, any> | null): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const body: Record<string, unknown> = {
    _algovault: { tool: 'verify-signal', version: PKG_VERSION, source: 'verify://signal/{id}', ts: new Date().toISOString() },
  };
  if (!row) {
    body.status = 'notfound';
    body.requested_id = rawId;
  } else if (!row.merkle_batch_id || !row.merkle_root) {
    body.status = 'pending';
    body.leaf = row.signal_hash || null;
    body.requested_id = rawId;
  } else {
    body.status = 'verified';
    body.leaf = row.signal_hash;
    body.root = row.merkle_root;
    body.batch = row.merkle_batch_id;
    body.tx = row.tx_hash;
  }
  return JSON.stringify(body, null, 2);
}

describe('verify://signal/{id} serves exactly what it served before CH3', () => {
  const PHASE_E = { outcome_return_pct: 3.2, won: true, pfe_bps: 140, coin: 'BTC', signal: 'BUY', confidence: 71, price_at_signal: 1 };
  const verified = { id: 41, signal_hash: `0x${'ab'.repeat(32)}`, merkle_batch_id: 12, merkle_root: `0x${'cd'.repeat(32)}`, tx_hash: `0x${'ef'.repeat(32)}`, merkle_proof: '[]', ...PHASE_E };
  const pending = { id: 42, signal_hash: `0x${'12'.repeat(32)}`, merkle_batch_id: null, merkle_root: null, ...PHASE_E };
  const unhashed = { id: 43, signal_hash: null, merkle_batch_id: null, merkle_root: null, ...PHASE_E };
  const noTx = { id: 44, signal_hash: `0x${'34'.repeat(32)}`, merkle_batch_id: 13, merkle_root: `0x${'56'.repeat(32)}`, ...PHASE_E };

  beforeAll(() => {
    pg.signals.set(`hash:${verified.signal_hash}`, verified);
    pg.signals.set('id:41', verified);
    pg.signals.set(`hash:0X${'12'.repeat(32)}`, pending);
    pg.signals.set('id:42', pending);
    pg.signals.set('id:43', unhashed);
    pg.signals.set('id:44', noTx);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-07T03:00:00.000Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
    pg.signals.clear();
  });

  it.each([
    ['verified by hash', verified.signal_hash, verified],
    ['verified by id', '41', verified],
    ['pending by 0X hash', `0X${'12'.repeat(32)}`, pending],
    ['pending by id', '42', pending],
    ['pending, unhashed (leaf null)', '43', unhashed],
    ['verified, no tx (key omitted)', '44', noTx],
    ['notfound by hash', `0x${'00'.repeat(32)}`, null],
    ['notfound by id', '999', null],
    ['notfound, not a number', 'abc', null],
    ['notfound, not positive', '-5', null],
  ])('%s', async (_, rawId, row) => {
    const r = await client.readResource({ uri: `verify://signal/${rawId}` });
    expect(String((r.contents[0] as { text: string }).text)).toBe(legacySignalText(rawId, row));
  });
});
