/**
 * SIGNAL-TREND-MODE-ENABLE-W1 CH1 — `signals.verdict_rule_version`, the precondition for CH2.
 *
 * WHY THIS COLUMN AT ALL. `regime_rule_version` already records which rule produced a row's LABEL.
 * A changed VERDICT rule is worse to be without, because it does not merely relabel rows — it
 * changes which rows EXIST: `recordSignal` is reached only for non-HOLD calls at or above
 * MIN_TRACKABLE_CONFIDENCE, so flipping `TREND_MODE` admits a different POPULATION into `signals`.
 * Without the stamp, the moment CH2 flips the flag the track record becomes a blend of two engines
 * with nothing to separate them — on a record that is Merkle-anchored and can never be restated.
 *
 * 🔒 THE STAMP IS A FUNCTION, NOT A CONSTANT, AND THAT IS WHAT THIS FILE EXISTS TO PROVE.
 * `TREND_MODE` is an env var: it moves with no deploy and no diff, deliberately, because that is
 * the revert path. A version baked at build time would keep stamping 1 while the engine ran rule 2,
 * producing v1-stamped v2 rows — precisely the failure the column exists to prevent, and
 * undetectable afterwards. So the decisive assertion here is a MID-TEST FLIP against ONE loaded
 * module instance: a build-time constant, a module-scope cache or a memoised read all survive a
 * fresh import and all die on that.
 *
 * SPAWN BUDGET: none required — nothing here spawns a process (`scripts/check-test-budget.mjs`
 * scopes to process-spawning blocks).
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
const ORIGINAL_TREND_MODE = process.env.TREND_MODE;

let tempHome: string;
let perfDb: typeof import('../../src/lib/performance-db.js');

/** The env is the ONLY input to the stamp, so every test starts from the production default. */
function setTrendMode(v: 'on' | 'off' | undefined): void {
  if (v === undefined) delete process.env.TREND_MODE;
  else process.env.TREND_MODE = v;
}

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  setTrendMode(undefined);

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
  if (ORIGINAL_TREND_MODE !== undefined) process.env.TREND_MODE = ORIGINAL_TREND_MODE;
  else delete process.env.TREND_MODE;
});

const dbPathFor = (home: string) => path.join(home, '.crypto-quant-signal', 'performance.db');

describe('CH1 — the version DERIVES from the live flag', () => {
  it('follows TREND_MODE, and default-deny means only the exact string "on" reaches 2', () => {
    for (const v of [undefined, '', 'ON', 'On', 'true', '1', 'yes', 'off', 'onn'] as const) {
      setTrendMode(v as never);
      expect(perfDb.currentVerdictRuleVersion(), `TREND_MODE=${String(v)} must stamp 1`).toBe(1);
    }
    setTrendMode('on');
    expect(perfDb.currentVerdictRuleVersion()).toBe(2);
    setTrendMode('off');
    expect(perfDb.currentVerdictRuleVersion()).toBe(1);
  });

  it('is re-read PER CALL — a build constant or a module-scope cache dies here', () => {
    // ONE module instance, no re-import between reads. This is the assertion that separates
    // "a function of the live flag" from "a value fixed when the module loaded", and it is the
    // whole reason the stamp is not `export const VERDICT_RULE_VERSION`.
    setTrendMode(undefined);
    expect(perfDb.currentVerdictRuleVersion()).toBe(1);
    setTrendMode('on');
    expect(perfDb.currentVerdictRuleVersion()).toBe(2);
    setTrendMode(undefined);
    expect(perfDb.currentVerdictRuleVersion()).toBe(1);
  });
});

describe('CH1 — the WRITER stamps at runtime', () => {
  it('every new row carries the stamp, and it matches the flag state AT WRITE TIME', async () => {
    // Three writes through ONE loaded module, with the flag moved between them. A row is stamped
    // by the rule that actually produced it — not by the rule that was live when the process
    // booted, which is exactly what a flag flip without a deploy would otherwise corrupt.
    setTrendMode(undefined);
    perfDb.recordSignal('BTC', 'BUY', 80, '1h', 50_000, 'hash-off-1', 'BINANCE', 'TRENDING_UP');

    setTrendMode('on');
    perfDb.recordSignal('ETH', 'BUY', 80, '1h', 3_000, 'hash-on-1', 'BINANCE', 'TRENDING_UP');

    setTrendMode(undefined);
    perfDb.recordSignal('SOL', 'SELL', 80, '1h', 150, 'hash-off-2', 'BINANCE', 'TRENDING_DOWN');

    const rows = await perfDb.dbQuery<{ signal_hash: string; verdict_rule_version: number }>(
      'SELECT signal_hash, verdict_rule_version FROM signals ORDER BY id ASC',
      [],
    );

    // VACUITY GUARD: an empty table would make every expectation below pass by never running.
    expect(rows.length, 'fixture wrote no rows — the assertions below would be vacuous').toBe(3);

    const byHash = new Map(rows.map(r => [r.signal_hash, r.verdict_rule_version]));
    expect(byHash.get('hash-off-1')).toBe(1);
    expect(byHash.get('hash-on-1')).toBe(2);
    expect(byHash.get('hash-off-2')).toBe(1);
  });

  it('leaves the Merkle leaf preimage untouched — LAW 0', async () => {
    // hashSignal() (src/lib/merkle.ts) hashes exactly (coin, signal, confidence, timeframe,
    // timestamp, price). None of those is this column, and none of them is written differently
    // under either flag state, so no anchored root is reachable from this change.
    setTrendMode('on');
    perfDb.recordSignal('BTC', 'BUY', 77, '4h', 51_234.5, 'leaf-preimage', 'BINANCE', 'TRENDING_UP');
    const rows = await perfDb.dbQuery<{
      coin: string; signal: string; confidence: number; timeframe: string; price_at_signal: number;
      verdict_rule_version: number;
    }>('SELECT coin, signal, confidence, timeframe, price_at_signal, verdict_rule_version FROM signals WHERE signal_hash = ?', ['leaf-preimage']);
    expect(rows.length).toBe(1);
    expect(rows[0].coin).toBe('BTC');
    expect(rows[0].signal).toBe('BUY');
    expect(rows[0].confidence).toBe(77);
    expect(rows[0].timeframe).toBe('4h');
    expect(rows[0].price_at_signal).toBeCloseTo(51_234.5, 1);
    expect(rows[0].verdict_rule_version).toBe(2);
  });
});

describe('CH1 — the migration is additive and non-destructive', () => {
  it('DEFAULT 1 lands on pre-existing rows and changes nothing else about them', async () => {
    // Build a signals table that predates the column, populate it, then force the migration —
    // the local stand-in for the live PG table, where DEFAULT 1 is factually correct because
    // every historical row really was produced with TREND_MODE unset.
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

    // VACUITY GUARD, stated before the comparison it protects: "nothing changed" over an empty
    // table is verified-NOTHING wearing verified-clean.
    expect(before.length, 'pre-migration fixture is empty — the comparison below proves nothing').toBe(2);

    vi.resetModules();
    perfDb = await import('../../src/lib/performance-db.js');

    const cols = await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', []);
    expect(cols.map(c => c.name)).toContain('verdict_rule_version');

    const after = await perfDb.dbQuery<Record<string, unknown>>('SELECT * FROM signals ORDER BY id ASC', []);
    expect(after.length, 'the migration must not add or drop rows').toBe(before.length);

    for (let i = 0; i < before.length; i++) {
      for (const key of Object.keys(before[i])) {
        expect(after[i][key], `pre-existing column ${key} on row ${i} must be byte-unchanged`)
          .toEqual(before[i][key]);
      }
      // The point of DEFAULT 1: no backfill statement runs, and none is owed.
      expect(after[i].verdict_rule_version).toBe(1);
    }
  });

  it('is idempotent — a second open re-runs no ALTER and leaves the schema identical', async () => {
    const first = (await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', []))
      .map(r => r.name).sort();
    expect(first, 'schema snapshot is empty — nothing to compare').toContain('verdict_rule_version');

    vi.resetModules();
    perfDb = await import('../../src/lib/performance-db.js');

    const second = (await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', []))
      .map(r => r.name).sort();
    expect(second).toEqual(first);
  });
});

describe('CH1 — the column is INTERNAL and cannot reach a public surface', () => {
  it('formatPublicRecentSignal emits its 6 allow-listed keys and nothing else', () => {
    // The allow-list at the data layer is what makes this structural rather than a promise:
    // a new column cannot leak into /api/performance-public.recentSignals[] no matter what the
    // input row carries. Feed it a row that DOES carry the new field and prove it is dropped.
    const out = perfDb.formatPublicRecentSignal({
      id: 1, coin: 'BTC', tier: 1, timeframe: '1h', exchange: 'BINANCE', created_at: 1_700_000_000,
      // deliberately smuggled in — the formatter's contract is that this is ignored
      verdict_rule_version: 2,
    } as never);
    expect(Object.keys(out).sort()).toEqual(
      ['coin', 'created_at', 'exchange', 'id', 'tier', 'timeframe'],
    );
    expect((out as Record<string, unknown>).verdict_rule_version).toBeUndefined();
  });
});
