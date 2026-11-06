/**
 * DECISION-CALL-V2-W5 CH1 — the call ledger's v1 format (src/lib/call-ledger.ts) and the receipt the response
 * builder mints (src/tools/pre-trade-check.ts `toPreTradeCheckResponse`).
 *
 * THE ORACLE IS THE CONTRACT (vault `Prompt/call-ledger-contract.md` § Vectors), computed by two independent
 * implementations before this code existed. Every string below is copied from it verbatim; a vector this code
 * cannot reproduce is a HALT (spec §4.4), never an edit to the vector.
 *
 * AC1.1 (vector half) — both vectors byte for byte, the four-leaf tree, the proof, the tampered record.
 * AC1.2 — each mutation is red here: equity_usd / caller_ref in the record · `ledger` hashed into itself ·
 *         rules reordered · an odds value or salt served · a refusal carrying a receipt.
 */
import { describe, it, expect } from 'vitest';
import { keccak256, stringToBytes, type Hex } from 'viem';
import {
  CALL_LEDGER_ID_RE,
  TAG_ODDS,
  TAG_VERDICT,
  BYTES32_HEX_RE,
  jcs,
  mintCallLedgerId,
  mintOddsSalt,
  oddsLeaf,
  oddsRecordFromRow,
  receiptOf,
  recordHash,
  verdictLeaf,
  verdictRecordFromResponse,
  verdictRecordFromRow,
  type CheckRowLedgerSource,
  type ServedVerdictSource,
  type VerdictRecordV1,
} from '../../src/lib/call-ledger.js';
import { buildMerkleTree, verifyProof } from '../../src/lib/merkle.js';
import { runPreTradeCheck, type PreTradeCheckResponse } from '../../src/tools/pre-trade-check.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import type { LicenseInfo } from '../../src/types.js';
import { preTradeWorld } from '../fixtures/pre-trade-world.js';

// ── The contract's vectors, verbatim ────────────────────────────────────────────────────────────

const A = {
  id: 'pcl_0123456789abcdef0123456789abcdef',
  salt: `0x${'11'.repeat(32)}` as Hex,
  jcs: '{"as_of":"2026-11-06T07:13:01.123Z","coin":"BTC","decision":"GO","hold_hours":8,"id":"pcl_0123456789abcdef0123456789abcdef","leverage":null,"order_type":"market","rule_version":2,"rules":[{"id":"maxRoundTripBps","result":"pass","source":"default"},{"id":"maxFundingBps","result":"pass","source":"default"},{"id":"regimeCheck","result":"pass","source":"default"}],"side":"long","size_usd":10000,"stop_pct":null,"target_pct":null,"timeframe":"1h","tool":"pre_trade_check","v":1,"venue":"BINANCE"}',
  recordHash: '0x40c733b4a2d594e4b54b23757392c87ebd5318c404e0f46cd9ceec0cb4845749',
  verdictLeaf: '0x24eba412f14c8f6c6dbe725002308afa821a4bd4efbc1c3023ef669a527f131c',
  oddsJcs: '{"id":"pcl_0123456789abcdef0123456789abcdef","odds_version":"odds-v1","p_liq_hold":null,"p_stop_first":null,"p_target_first":null,"p_timeout":null,"v":1}',
  oddsHash: '0x2d42214f61c30d062a03cad26b0dc9fbc3e6458e264eb5ea0d9c1df22a5c5afe',
  oddsLeaf: '0x3acf600987faa4557d3b252e4f1bf3673bce03353a6a9b0c3ee4e9851c81775b',
};
const B = {
  id: 'pcl_fedcba9876543210fedcba9876543210',
  salt: `0x${'22'.repeat(32)}` as Hex,
  jcs: '{"as_of":"2026-11-06T09:30:00.000Z","coin":"SOL","decision":"WAIT","hold_hours":0.5,"id":"pcl_fedcba9876543210fedcba9876543210","leverage":20,"order_type":"limit","rule_version":2,"rules":[{"id":"maxLeverage","result":"fail","source":"yours"},{"id":"noLiqBeforeStop","result":"pass","source":"default"},{"id":"maxRoundTripBps","result":"pass","source":"saved"},{"id":"maxSizePctOf24hVolume","result":"not_evaluated","source":"default"}],"side":"short","size_usd":2500.5,"stop_pct":1.5,"target_pct":3,"timeframe":"4h","tool":"pre_trade_check","v":1,"venue":"OKX"}',
  recordHash: '0xf8aff0c0a5b6d70c2f23d0212525f898ffb6e806b932fe03ba0f71aacbbfb70b',
  verdictLeaf: '0xf3a11b3698eea5926cb061f63bca5ea4b457f35de3030fcf8b69bc0c1a351a84',
  oddsJcs: '{"id":"pcl_fedcba9876543210fedcba9876543210","odds_version":"odds-v1","p_liq_hold":0.00004000320025602048,"p_stop_first":0.09814981498149819,"p_target_first":0.23404340434043405,"p_timeout":0.6678067806780678,"v":1}',
  oddsHash: '0x73f1e5566f229c002559e4789cce83d5c16ba36ed9ba0cf21e81f79869b2478e',
  oddsLeaf: '0xa9d19d05a7fea3edb0c9c57b1bbedb9b801b59b491c9c04fb793fc7928cbdffa',
};
const TREE_ROOT = '0xa73168a5df181705caaaebbc79cd5a64e25f399a9476bb896680895ea4d12a1d';
const PROOF_B_VERDICT = [
  '0xa9d19d05a7fea3edb0c9c57b1bbedb9b801b59b491c9c04fb793fc7928cbdffa',
  '0xa06427c3bd8d904dce0f2460b00c24f6a906ff70cc51481314502153ab586781',
];

/** The contract's 17 verdict-record keys and 7 odds-record keys. */
const VERDICT_KEYS = ['as_of', 'coin', 'decision', 'hold_hours', 'id', 'leverage', 'order_type', 'rule_version', 'rules', 'side', 'size_usd', 'stop_pct', 'target_pct', 'timeframe', 'tool', 'v', 'venue'];
const ODDS_KEYS = ['id', 'odds_version', 'p_liq_hold', 'p_stop_first', 'p_target_first', 'p_timeout', 'v'];

// A's and B's values as a SERVED response holds them (only the keys the record reads, plus a few it must not).
const servedA = (): ServedVerdictSource & Record<string, unknown> => ({
  as_of: '2026-11-06T07:13:01.123Z', coin: 'BTC', side: 'long', size_usd: 10000, hold_hours: 8, timeframe: '1h',
  inputs: { order_type: 'market', leverage: null, stop_pct: null, target_pct: null, equity_usd: 50_000 } as ServedVerdictSource['inputs'],
  decision: 'GO', best_venue: { exchange: 'BINANCE', est_cost_bps: 9, est_cost_usd: 9, capacity_usd: 1e6 } as { exchange: string }, rule_version: 2,
  rules: [
    { id: 'maxRoundTripBps', source: 'default', limit: 30, value: 9, result: 'pass', detail: 'x' },
    { id: 'maxFundingBps', source: 'default', limit: 10, value: 1, result: 'pass', detail: 'y' },
    { id: 'regimeCheck', source: 'default', limit: true, value: 'RANGING', result: 'pass', detail: 'z' },
  ] as ServedVerdictSource['rules'],
});
const servedB = (): ServedVerdictSource => ({
  as_of: '2026-11-06T09:30:00.000Z', coin: 'SOL', side: 'short', size_usd: 2500.5, hold_hours: 0.5, timeframe: '4h',
  inputs: { order_type: 'limit', leverage: 20, stop_pct: 1.5, target_pct: 3 },
  decision: 'WAIT', best_venue: { exchange: 'OKX' }, rule_version: 2,
  rules: [
    { id: 'maxLeverage', source: 'yours', result: 'fail' },
    { id: 'noLiqBeforeStop', source: 'default', result: 'pass' },
    { id: 'maxRoundTripBps', source: 'saved', result: 'pass' },
    { id: 'maxSizePctOf24hVolume', source: 'default', result: 'not_evaluated' },
  ],
});
// The same values as the stored check row holds them (a driver's Date, the full JSONB rule rows).
const rowB = (): CheckRowLedgerSource => ({
  ledger_id: B.id, checked_at: new Date('2026-11-06T09:30:00.000Z'), coin: 'SOL', side: 'short', size_usd: 2500.5, hold_hours: 0.5,
  timeframe: '4h', order_type: 'limit', leverage: 20, stop_pct: 1.5, target_pct: 3, decision: 'WAIT', decision_venue: 'OKX', rule_version: 2,
  rules: [
    { id: 'maxLeverage', source: 'yours', limit: 10, value: 20, result: 'fail', detail: 'a' },
    { id: 'noLiqBeforeStop', source: 'default', limit: true, value: true, result: 'pass', detail: 'b' },
    { id: 'maxRoundTripBps', source: 'saved', limit: 20, value: 12, result: 'pass', detail: 'c' },
    { id: 'maxSizePctOf24hVolume', source: 'default', limit: 1, value: null, result: 'not_evaluated', detail: 'd' },
  ],
  odds_version: 'odds-v1', p_timeout: 0.6678067806780678, p_target_first: 0.23404340434043405,
  p_stop_first: Math.max(0, 1 - 0.6678067806780678 - 0.23404340434043405), p_liq_hold: 0.00004000320025602048,
});
const rowA = (): CheckRowLedgerSource => ({
  ledger_id: A.id, checked_at: '2026-11-06T07:13:01.123Z', coin: 'BTC', side: 'long', size_usd: 10000, hold_hours: 8, timeframe: '1h',
  order_type: 'market', leverage: null, stop_pct: null, target_pct: null, decision: 'GO', decision_venue: 'BINANCE', rule_version: 2,
  rules: JSON.stringify(servedA().rules), odds_version: 'odds-v1', p_timeout: null, p_target_first: null, p_stop_first: null, p_liq_hold: null,
});

describe('AC1.1 — the contract vectors, byte for byte', () => {
  it('both tags are k(preimage), and neither preimage is a prefix of the other', () => {
    // The preimages exactly as the contract prints them (§ Encoding).
    const TAG_VERDICT_PREIMAGE = 'algovault.call-ledger.v1/pre_trade_check/verdict';
    const TAG_ODDS_PREIMAGE = 'algovault.call-ledger.v1/pre_trade_check/odds';
    expect(keccak256(stringToBytes(TAG_VERDICT_PREIMAGE))).toBe(TAG_VERDICT);
    expect(keccak256(stringToBytes(TAG_ODDS_PREIMAGE))).toBe(TAG_ODDS);
    expect(TAG_VERDICT).toBe('0x86ac3703d2f057fa83293b28fc876f702f6fca45a41947100e933fac1655e899');
    expect(TAG_ODDS).toBe('0x4d5c95f32d3afdfdb54aee2ea46ee94043fcd233b6bd7c20b670d3a7fd37cf7d');
    expect(TAG_VERDICT_PREIMAGE.startsWith(TAG_ODDS_PREIMAGE) || TAG_ODDS_PREIMAGE.startsWith(TAG_VERDICT_PREIMAGE)).toBe(false);
  });

  for (const [name, v, served, row] of [['A', A, servedA, rowA], ['B', B, servedB, rowB]] as const) {
    it(`vector ${name}: the record from the SERVED response is the contract's JCS, record_hash and verdict_leaf`, () => {
      const rec = verdictRecordFromResponse(served(), v.id);
      expect(jcs(rec)).toBe(v.jcs);
      expect(recordHash(rec)).toBe(v.recordHash);
      expect(verdictLeaf(rec)).toBe(v.verdictLeaf);
    });

    it(`vector ${name}: the record rebuilt from the STORED row is the same bytes; the odds leaf from the row's W4 values`, () => {
      const rec = verdictRecordFromRow(row());
      expect(jcs(rec)).toBe(v.jcs);
      expect(verdictLeaf(rec)).toBe(v.verdictLeaf);
      const odds = oddsRecordFromRow(row());
      expect(jcs(odds)).toBe(v.oddsJcs);
      expect(recordHash(odds)).toBe(v.oddsHash);
      expect(oddsLeaf(odds, v.salt)).toBe(v.oddsLeaf);
    });
  }

  it('B: p_stop_first = max(0, 1 − p_timeout − p_target_first) in IEEE double prints as the contract prints it', () => {
    expect(String(Math.max(0, 1 - 0.6678067806780678 - 0.23404340434043405))).toBe('0.09814981498149819');
    expect(jcs(0.00004000320025602048)).toBe('0.00004000320025602048');
  });

  it('the four-leaf tree: the root, the proof for B\'s verdict leaf, and B with decision GO fails', () => {
    const leaves = [A.verdictLeaf, A.oddsLeaf, B.verdictLeaf, B.oddsLeaf] as Hex[];
    const t = buildMerkleTree(leaves);
    expect(t.root).toBe(TREE_ROOT);
    expect(t.proofs.get(B.verdictLeaf)).toEqual(PROOF_B_VERDICT);
    expect(verifyProof(B.verdictLeaf as Hex, PROOF_B_VERDICT as Hex[], TREE_ROOT as Hex)).toBe(true);
    const tampered = verdictLeaf({ ...verdictRecordFromRow(rowB()), decision: 'GO' });
    expect(tampered).not.toBe(B.verdictLeaf);
    expect(verifyProof(tampered, PROOF_B_VERDICT as Hex[], TREE_ROOT as Hex)).toBe(false);
  });
});

describe('JCS (RFC 8785) as the records need it', () => {
  it('sorts keys by UTF-16 code units, prints numbers as ECMAScript does, no whitespace', () => {
    expect(jcs({ b: 1, a: [true, null, 'x'], A: 10000, é: 0.5, z: 1e21 })).toBe('{"A":10000,"a":[true,null,"x"],"b":1,"z":1e+21,"é":0.5}');
    expect(jcs(-0)).toBe('0');
    expect(jcs(1e-7)).toBe('1e-7');
    expect(jcs('quote " and \u0001')).toBe('"quote \\" and \\u0001"');
  });

  it('refuses what a record must never hold: a non-finite number, an absent key, a Date', () => {
    for (const bad of [NaN, Infinity, -Infinity, { a: undefined }, new Date(0), () => 1, 1n]) expect(() => jcs(bad), String(bad)).toThrow();
  });
});

describe('ids, salts and the receipt', () => {
  it('an id is pcl_ + 32 lowercase hex from the CSPRNG — 1,000 mints, 1,000 ids', () => {
    const ids = Array.from({ length: 1000 }, () => mintCallLedgerId());
    for (const id of ids) expect(id).toMatch(CALL_LEDGER_ID_RE);
    expect(new Set(ids).size).toBe(1000);
  });

  it('a salt is 0x + 64 lowercase hex; an odds leaf refuses any other salt', () => {
    const s = mintOddsSalt();
    expect(s).toMatch(BYTES32_HEX_RE);
    const odds = oddsRecordFromRow(rowB());
    for (const bad of [`0x${'2'.repeat(63)}`, `0x${'AB'.repeat(32)}`, '22'.repeat(32)]) expect(() => oddsLeaf(odds, bad as Hex), bad).toThrow();
  });

  it('receiptOf = {id, leaf: verdict_leaf, verify: verify://check/<id>}', () => {
    expect(receiptOf(verdictRecordFromRow(rowB()))).toEqual({ id: B.id, leaf: B.verdictLeaf, verify: `verify://check/${B.id}` });
  });

  it('a row without a well-formed ledger id or odds version is refused, never hashed', () => {
    expect(() => verdictRecordFromRow({ ...rowB(), ledger_id: null })).toThrow(/ledger id/);
    expect(() => verdictRecordFromRow({ ...rowB(), ledger_id: 'pcl_XYZ' })).toThrow(/ledger id/);
    expect(() => oddsRecordFromRow({ ...rowB(), odds_version: null })).toThrow(/odds_version/);
    expect(() => verdictRecordFromRow({ ...rowB(), checked_at: 'not a time' })).toThrow(/timestamp/);
  });
});

describe('AC1.2 — what the record commits, and what it never holds', () => {
  it('the record has exactly the contract\'s 17 keys; the odds record its 7', () => {
    expect(Object.keys(verdictRecordFromResponse(servedA(), A.id)).sort()).toEqual(VERDICT_KEYS);
    expect(Object.keys(verdictRecordFromRow(rowA())).sort()).toEqual(VERDICT_KEYS);
    expect(Object.keys(oddsRecordFromRow(rowA())).sort()).toEqual(ODDS_KEYS);
  });

  it('equity_usd, caller_ref, channel and every cost are not in it: changing them leaves the leaf unchanged', () => {
    const base = verdictLeaf(verdictRecordFromResponse(servedA(), A.id));
    const poisoned = { ...servedA(), caller_ref: 'pc1:abc', channel: 'mcp', venues: [{ est_cost_bps: 1 }], ledger: { id: 'x' } };
    poisoned.inputs = { ...poisoned.inputs, equity_usd: 1 } as ServedVerdictSource['inputs'];
    (poisoned.best_venue as Record<string, unknown>).est_cost_bps = 999;
    expect(verdictLeaf(verdictRecordFromResponse(poisoned, A.id))).toBe(base);
    expect(jcs(verdictRecordFromResponse(poisoned, A.id))).not.toMatch(/equity|caller|channel|cost|ledger/);
  });

  it('rules are committed in SERVED order: B is not alphabetical, and reordering changes the leaf', () => {
    const rec = verdictRecordFromResponse(servedB(), B.id);
    expect(rec.rules.map((r) => r.id)).toEqual(['maxLeverage', 'noLiqBeforeStop', 'maxRoundTripBps', 'maxSizePctOf24hVolume']);
    const swapped: VerdictRecordV1 = { ...rec, rules: [rec.rules[1], rec.rules[0], ...rec.rules.slice(2)] };
    expect(verdictLeaf(swapped)).not.toBe(B.verdictLeaf);
  });

  it('every committed field moves the leaf (the record is not a constant)', () => {
    const rec = verdictRecordFromRow(rowB());
    const edits: Partial<VerdictRecordV1>[] = [
      { as_of: '2026-11-06T09:30:00.001Z' }, { coin: 'BTC' }, { side: 'long' }, { size_usd: 2500.25 }, { hold_hours: 1 }, { timeframe: '1h' },
      { order_type: 'market' }, { leverage: null }, { stop_pct: 1.6 }, { target_pct: null }, { decision: 'CAUTION' }, { venue: null },
      { rule_version: 3 }, { id: A.id },
    ];
    for (const e of edits) expect(verdictLeaf({ ...rec, ...e }), JSON.stringify(e)).not.toBe(B.verdictLeaf);
  });
});

// ── The receipt on the served path (the real handler, offline) ─────────────────────────────────

const NOW = Date.parse('2026-11-06T07:13:01.123Z');
let n = 0;
const free = (): LicenseInfo => ({ tier: 'free', key: `av_free_ledger_${++n}`, outcome: 'RESOLVED' } as LicenseInfo);
const INTERNAL: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' } as LicenseInfo;
async function served(p: Record<string, unknown>, lic: LicenseInfo): Promise<PreTradeCheckResponse> {
  _resetCallTrackersForTest();
  resetLicenseCache();
  const out = await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000, ...p } as never, lic, preTradeWorld(NOW));
  if (out.kind !== 'ok') throw new Error(`expected a served check, got ${JSON.stringify(out.payload)}`);
  return out.response;
}

describe('the receipt — minted once, on the logged path, from the response as served', () => {
  it('a keyed call carries ledger {id, leaf, verify}; leaf = the verdict leaf of the served values; after as_of, before _algovault', async () => {
    const r = await served({ leverage: 20, stopPct: 1.5, targetPct: 3, orderType: 'limit', holdHours: 0.5, sizeUsd: 2500.5, side: 'short' }, free());
    expect(r.ledger).toBeDefined();
    const { id, leaf, verify } = r.ledger!;
    expect(id).toMatch(CALL_LEDGER_ID_RE);
    expect(leaf).toBe(verdictLeaf(verdictRecordFromResponse(r, id)));
    expect(verify).toBe(`verify://check/${id}`);
    const keys = Object.keys(r);
    expect(keys.slice(-3)).toEqual(['as_of', 'ledger', '_algovault']);
    expect(Object.keys(r.ledger!)).toEqual(['id', 'leaf', 'verify']);
  });

  it('`ledger` is never hashed into itself: a verifier rebuilding from the served JSON — receipt included — gets the served leaf', async () => {
    const r = await served({}, free());
    const wire = JSON.parse(JSON.stringify(r)) as PreTradeCheckResponse;
    expect(wire.ledger).toBeDefined();
    expect(verdictLeaf(verdictRecordFromResponse(wire, wire.ledger!.id))).toBe(r.ledger!.leaf);
  });

  it('two calls, two ids; an internal call carries none', async () => {
    const [a, b] = [await served({}, free()), await served({}, free())];
    expect(a.ledger!.id).not.toBe(b.ledger!.id);
    expect(a.ledger!.leaf).not.toBe(b.ledger!.leaf);
    const internal = await served({}, INTERNAL);
    expect(internal).not.toHaveProperty('ledger');
  });

  it('a refusal never carries a receipt (each refusal class the handler emits offline)', async () => {
    _resetCallTrackersForTest();
    const world = preTradeWorld(NOW);
    const refusals = [
      await runPreTradeCheck({ coin: 'BTC', side: 'sideways', sizeUsd: 10_000 } as never, free(), world),
      await runPreTradeCheck({ coin: 'BTC', side: 'long', sizeUsd: 10_000, exchanges: ['NOPE'] } as never, free(), world),
      await runPreTradeCheck({ coin: 'ZZZQQ', side: 'long', sizeUsd: 10_000 } as never, free(), world),
    ];
    expect(refusals.map((o) => o.kind)).toEqual(['refused', 'refused', 'refused']);
    for (const o of refusals) expect(JSON.stringify(o)).not.toMatch(/"ledger"|pcl_|verify:\/\/check/);
  });

  it('no odds value, salt or odds key is ever served', async () => {
    const r = await served({ leverage: 20, stopPct: 2, targetPct: 4 }, free());
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/"salt"|odds|p_timeout|p_target_first|p_stop_first|p_liq_hold/i);
  });
});
