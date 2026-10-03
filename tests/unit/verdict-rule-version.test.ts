/**
 * verdict-rule-version.test.ts — the per-row verdict-rule stamp.
 *
 * ORIGIN: SIGNAL-TREND-MODE-ENABLE-W1 CH1 added `signals.verdict_rule_version` because a changed
 * VERDICT rule changes which rows EXIST (`recordSignal` is reached only for non-HOLD calls at or
 * above MIN_TRACKABLE_CONFIDENCE), so without the stamp the Merkle-anchored track record would
 * become an unseparable blend of two engines. The stamp was then a function of the `TREND_MODE`
 * env var, re-read at write time.
 *
 * REWRITTEN by SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2. `TREND_MODE` is retired as a selector. The rule
 * that produced a call is resolved ONCE per call by `src/lib/verdict-rule-registry.ts` and handed to
 * all three writers as a stamp (ruling Q4 = A): 2 = today's rule (M), 3 = a fade (F), never 1 again
 * (ruling Q2 = A: row-level). `rule_config_id` — the committed assignment's identity — rides on
 * `signals` and on the emitted arm's capture sibling. What this file proves:
 *   1. every writer persists EXACTLY the stamp it is handed, for both 2 and 3 — no writer derives it;
 *   2. the emitted arm's sibling persists the ten registered capture columns (registration §3);
 *   3. LAW 0: the Merkle leaf preimage is untouched;
 *   4. the migration is additive: pre-existing rows byte-unchanged, the new columns NULL on them,
 *      and a second open re-runs nothing;
 *   5. neither stamp column can reach `/api/performance-public` (allow-list).
 *
 * SPAWN BUDGET: none required — nothing here spawns a process.
 *
 * BACKEND: SQLite. `DATABASE_URL` is deleted and `HOME` redirected to a mkdtemp dir BEFORE the
 * dynamic import, so the module-level DB path resolves into the temp dir — the same isolation
 * `tests/performance-db-migration.test.ts` uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempHome: string;
let perfDb: typeof import('../../src/lib/performance-db.js');

const ID_M = 'a'.repeat(64);
const ID_F = 'b'.repeat(64);
const STAMP_M = { verdictRuleVersion: 2 as const, ruleConfigId: ID_M };
const STAMP_F = { verdictRuleVersion: 3 as const, ruleConfigId: ID_F };

const PARTS = {
  rsiScore: 100, emaScore: 100, fundingScore: 0, oiScore: 60, volumeScore: 80,
  raw0: 65, fundingDelta: 0, hurstDelta: 10, squeezeDelta: 0, rawFinal: 75,
  fundingAdjustCode: 32, hurstAdjustCode: 3, squeezeAdjustCode: 0,
};
const CAPTURE = {
  trendDecisive: true, v1Signal: 'HOLD' as const, v1RawFinal: 15, verdictM: 'BUY' as const,
  verdictF: 'SELL' as const, verdictH: 'HOLD' as const, rsiValue: 81.25, rsiScorePre: -100, fundingZ: null,
};

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-verdict-rule-version-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.resetModules();
  perfDb = await import('../../src/lib/performance-db.js');
});

afterEach(() => {
  try { perfDb.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME; else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const dbPathFor = (home: string) => path.join(home, '.crypto-quant-signal', 'performance.db');

describe('every writer persists exactly the stamp it is handed', () => {
  it('signals: verdict_rule_version + rule_config_id, for both 2 and 3', async () => {
    perfDb.recordSignal('BTC', 'BUY', 80, '1h', 50_000, 'hash-m', 'BINANCE', 'TRENDING_UP', STAMP_M);
    perfDb.recordSignal('ETH', 'SELL', 80, '4h', 3_000, 'hash-f', 'BINANCE', 'TRENDING_DOWN', STAMP_F);
    const rows = await perfDb.dbQuery<{ signal_hash: string; verdict_rule_version: number; rule_config_id: string }>(
      'SELECT signal_hash, verdict_rule_version, rule_config_id FROM signals ORDER BY id ASC', [],
    );
    // VACUITY GUARD: an empty table would make every expectation below pass by never running.
    expect(rows.length, 'fixture wrote no rows — the assertions below would be vacuous').toBe(2);
    expect(rows[0]).toEqual({ signal_hash: 'hash-m', verdict_rule_version: 2, rule_config_id: ID_M });
    expect(rows[1]).toEqual({ signal_hash: 'hash-f', verdict_rule_version: 3, rule_config_id: ID_F });
  });

  it('band_signals: the stamp argument only (ruling Q4 = A)', async () => {
    perfDb.recordBandSignal('SOL', 'BUY', 47, '5m', 100, 'HL', 'TRENDING_UP', 'request', false, PARTS, 2);
    perfDb.recordBandSignal('SOL', 'SELL', 47, '5m', 100, 'HL', 'TRENDING_DOWN', 'fleet', true, PARTS, 3);
    const rows = await perfDb.dbQuery<{ verdict_rule_version: number }>(
      'SELECT verdict_rule_version FROM band_signals ORDER BY band_id ASC', [],
    );
    expect(rows.map((r) => r.verdict_rule_version)).toEqual([2, 3]);
  });

  it('signal_scorer_inputs: the stamp and all ten registered capture columns', async () => {
    perfDb.recordScorerInputs({
      decidedAt: 1_790_000_000, signalHash: 'hash-cap', coin: 'BTC', signal: 'BUY', confidence: 84,
      timeframe: '4h', exchange: 'BINANCE', regime: 'TRENDING_UP', arm: 'fleet', isBotInternal: false,
      parts: PARTS, stamp: STAMP_M, capture: CAPTURE,
    });
    perfDb.recordScorerInputs({
      decidedAt: 1_790_000_001, signalHash: 'hash-cap-2', coin: 'ETH', signal: 'SELL', confidence: 70,
      timeframe: '1h', exchange: 'BINANCE', regime: 'RANGING', arm: 'request', isBotInternal: null,
      parts: { ...PARTS, rawFinal: -62 }, stamp: STAMP_F,
      capture: { ...CAPTURE, trendDecisive: false, v1Signal: 'SELL', v1RawFinal: -60, verdictM: 'SELL', verdictF: 'SELL', verdictH: 'SELL', rsiValue: null, rsiScorePre: 0, fundingZ: -2.31 },
    });
    const rows = await perfDb.dbQuery<Record<string, unknown>>(
      `SELECT signal_hash, verdict_rule_version, rule_config_id, trend_decisive, v1_signal, v1_raw_final,
              verdict_m, verdict_f, verdict_h, rsi_value, rsi_score_pre, funding_z
         FROM signal_scorer_inputs ORDER BY scorer_input_id ASC`, [],
    );
    expect(rows.length, 'fixture wrote no rows').toBe(2);
    expect(rows[0]).toEqual({
      signal_hash: 'hash-cap', verdict_rule_version: 2, rule_config_id: ID_M,
      trend_decisive: 1, // SQLite has no boolean; prod PG stores true
      v1_signal: 'HOLD', v1_raw_final: 15, verdict_m: 'BUY', verdict_f: 'SELL', verdict_h: 'HOLD',
      rsi_value: 81.25, rsi_score_pre: -100, funding_z: null,
    });
    expect(rows[1]).toMatchObject({
      verdict_rule_version: 3, rule_config_id: ID_F, trend_decisive: 0, v1_signal: 'SELL',
      verdict_m: 'SELL', verdict_f: 'SELL', verdict_h: 'SELL', rsi_value: null, rsi_score_pre: 0, funding_z: -2.31,
    });
  });

  it('no writer derives the stamp itself — the retired env-derived function is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'lib', 'performance-db.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/currentVerdictRuleVersion\s*\(/);
    expect(src).not.toMatch(/getTrendMode|TREND_MODE/);
    expect((perfDb as Record<string, unknown>).currentVerdictRuleVersion).toBeUndefined();
  });
});

describe('LAW 0 — the Merkle leaf preimage is untouched', () => {
  it('the six preimage fields are written exactly as handed, whatever the stamp', async () => {
    // hashSignal() (src/lib/merkle.ts) hashes exactly (coin, signal, confidence, timeframe,
    // timestamp, price). Neither stamp column is one of them, so no anchored root can move.
    perfDb.recordSignal('BTC', 'BUY', 77, '4h', 51_234.5, 'leaf-preimage', 'BINANCE', 'TRENDING_UP', STAMP_F);
    const rows = await perfDb.dbQuery<{
      coin: string; signal: string; confidence: number; timeframe: string; price_at_signal: number;
      verdict_rule_version: number; rule_config_id: string;
    }>('SELECT coin, signal, confidence, timeframe, price_at_signal, verdict_rule_version, rule_config_id FROM signals WHERE signal_hash = ?', ['leaf-preimage']);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ coin: 'BTC', signal: 'BUY', confidence: 77, timeframe: '4h', verdict_rule_version: 3, rule_config_id: ID_F });
    expect(rows[0].price_at_signal).toBeCloseTo(51_234.5, 1);
  });
});

describe('the migration is additive and non-destructive', () => {
  it('signals: pre-existing rows byte-unchanged; verdict_rule_version DEFAULT 1, rule_config_id NULL', async () => {
    await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', []);
    perfDb.closeDb();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const raw = new Database(dbPathFor(tempHome));
    raw.exec('DROP TABLE signals;');
    raw.exec(`
      CREATE TABLE signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        signal TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        timeframe TEXT NOT NULL,
        price_at_signal REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const ins = raw.prepare(
      'INSERT INTO signals (coin, signal, confidence, timeframe, price_at_signal, created_at) VALUES (?,?,?,?,?,?)',
    );
    ins.run('BTC', 'BUY', 61, '1h', 40_000, 1_700_000_000);
    ins.run('ETH', 'SELL', 73, '4h', 2_500, 1_700_000_100);
    const before = raw.prepare('SELECT * FROM signals ORDER BY id ASC').all() as Record<string, unknown>[];
    raw.close();
    expect(before.length, 'pre-migration fixture is empty — the comparison below proves nothing').toBe(2);

    vi.resetModules();
    perfDb = await import('../../src/lib/performance-db.js');

    const cols = (await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', [])).map((c) => c.name);
    expect(cols).toContain('verdict_rule_version');
    expect(cols).toContain('rule_config_id');

    const after = await perfDb.dbQuery<Record<string, unknown>>('SELECT * FROM signals ORDER BY id ASC', []);
    expect(after.length, 'the migration must not add or drop rows').toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      for (const key of Object.keys(before[i])) {
        expect(after[i][key], `pre-existing column ${key} on row ${i} must be byte-unchanged`).toEqual(before[i][key]);
      }
      expect(after[i].verdict_rule_version).toBe(1);
      expect(after[i].rule_config_id).toBeNull();
    }
  });

  it('signal_scorer_inputs: a pre-registry table gains the ten capture columns, NULL on existing rows', async () => {
    perfDb.recordScorerInputs({
      decidedAt: 1_790_000_000, signalHash: 'pre-registry', coin: 'BTC', signal: 'BUY', confidence: 84,
      timeframe: '4h', exchange: 'BINANCE', regime: 'TRENDING_UP', arm: 'fleet', isBotInternal: false,
      parts: PARTS, stamp: STAMP_M, capture: CAPTURE,
    });
    perfDb.closeDb();

    // Rebuild the table at its pre-registry (migration 036) shape, keeping one row.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const raw = new Database(dbPathFor(tempHome));
    const NEW = ['rule_config_id', 'trend_decisive', 'v1_signal', 'v1_raw_final', 'verdict_m', 'verdict_f', 'verdict_h', 'rsi_value', 'rsi_score_pre', 'funding_z'];
    const keep = (raw.prepare('PRAGMA table_info(signal_scorer_inputs)').all() as { name: string }[])
      .map((c) => c.name).filter((n) => !NEW.includes(n));
    raw.exec(`CREATE TABLE ssi_old AS SELECT ${keep.join(', ')} FROM signal_scorer_inputs;`);
    raw.exec('DROP TABLE signal_scorer_inputs;');
    raw.exec('ALTER TABLE ssi_old RENAME TO signal_scorer_inputs;');
    const before = raw.prepare('SELECT * FROM signal_scorer_inputs').all() as Record<string, unknown>[];
    raw.close();
    expect(before.length).toBe(1);
    for (const n of NEW) expect(Object.keys(before[0])).not.toContain(n);

    vi.resetModules();
    perfDb = await import('../../src/lib/performance-db.js');
    const after = await perfDb.dbQuery<Record<string, unknown>>('SELECT * FROM signal_scorer_inputs', []);
    expect(after.length).toBe(1);
    for (const key of Object.keys(before[0])) expect(after[0][key], key).toEqual(before[0][key]);
    for (const n of NEW) expect(after[0][n], n).toBeNull();
  });

  it('is idempotent — a second open re-runs no ALTER and leaves both schemas identical', async () => {
    const snap = async () => ({
      signals: (await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', [])).map((r) => r.name).sort(),
      ssi: (await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signal_scorer_inputs)', [])).map((r) => r.name).sort(),
    });
    const first = await snap();
    expect(first.signals).toContain('rule_config_id');
    expect(first.ssi).toContain('funding_z');
    vi.resetModules();
    perfDb = await import('../../src/lib/performance-db.js');
    expect(await snap()).toEqual(first);
  });
});

describe('neither stamp column can reach a public surface', () => {
  it('formatPublicRecentSignal emits its 6 allow-listed keys and nothing else', () => {
    const out = perfDb.formatPublicRecentSignal({
      id: 1, coin: 'BTC', tier: 1, timeframe: '1h', exchange: 'BINANCE', created_at: 1_700_000_000,
      // deliberately smuggled in — the formatter's contract is that these are ignored
      verdict_rule_version: 3,
      rule_config_id: ID_F,
    } as never);
    expect(Object.keys(out).sort()).toEqual(['coin', 'created_at', 'exchange', 'id', 'tier', 'timeframe']);
    expect((out as Record<string, unknown>).verdict_rule_version).toBeUndefined();
    expect((out as Record<string, unknown>).rule_config_id).toBeUndefined();
  });
});
