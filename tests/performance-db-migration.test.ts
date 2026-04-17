/**
 * Tests for the schema-aware migration runner in performance-db.ts.
 *
 * Strategy: redirect HOME to a mkdtempSync directory BEFORE dynamically
 * importing performance-db.js so the module-level DB_DIR/DB_PATH constants
 * resolve to the temp dir. Each test gets a fresh DB via vi.resetModules()
 * + a new temp dir, ensuring isolation. Mirrors tests/agent-sessions.test.ts.
 *
 * Note: DATABASE_URL is unset for these tests so the SQLite backend is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let tempHome: string;
let perfDb: typeof import('../src/lib/performance-db.js');

beforeEach(async () => {
  delete process.env.DATABASE_URL;

  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-perf-db-migration-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  vi.resetModules();
  perfDb = await import('../src/lib/performance-db.js');
});

afterEach(() => {
  try {
    perfDb.closeDb();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (ORIGINAL_USERPROFILE !== undefined) process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;
  if (ORIGINAL_DATABASE_URL !== undefined) process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const EXPECTED_MIGRATED_COLUMNS = [
  'outcome_price',
  'outcome_return_pct',
  'pfe_return_pct',
  'mae_return_pct',
  'pfe_price',
  'mae_price',
  'pfe_candles',
  'return_1candle',
  'exchange',
  'regime',
  'signal_hash',
  'merkle_batch_id',
  'merkle_proof',
];

describe('performance-db migrations', () => {
  it('creates all expected columns on a fresh signals table', async () => {
    const rows = await perfDb.dbQuery<{ name: string }>(
      'PRAGMA table_info(signals)',
      []
    );
    const names = new Set(rows.map(r => r.name));
    for (const col of EXPECTED_MIGRATED_COLUMNS) {
      expect(names.has(col), `expected column ${col} to exist after migration`).toBe(true);
    }
  });

  it('is idempotent: subsequent dbQuery calls do not throw and the schema is stable', async () => {
    // First call already triggered getBackend() via the implicit import-side
    // initialization in dbQuery. Capture the schema snapshot.
    const before = await perfDb.dbQuery<{ name: string }>(
      'PRAGMA table_info(signals)',
      []
    );
    const beforeNames = before.map(r => r.name).sort();

    // Trigger getBackend() again via another query — must not re-run ALTERs
    // and must not throw.
    expect(async () => {
      await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', []);
    }).not.toThrow();

    const after = await perfDb.dbQuery<{ name: string }>(
      'PRAGMA table_info(signals)',
      []
    );
    const afterNames = after.map(r => r.name).sort();

    expect(afterNames).toEqual(beforeNames);
  });

  it('migrates an existing partially-populated signals table without errors', async () => {
    // First trigger the initial migration so the DB file + dir exist.
    await perfDb.dbQuery<{ name: string }>('PRAGMA table_info(signals)', []);

    // Open the SQLite file directly, drop the migrated columns, then re-import
    // to force getBackend() to re-add them via runMigrations.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const dbPath = path.join(tempHome, '.crypto-quant-signal', 'performance.db');

    // Close handle so we can reopen for direct manipulation.
    perfDb.closeDb();

    const raw = new Database(dbPath);
    // Recreate the base signals table without any of the migrated columns.
    raw.exec('DROP TABLE signals;');
    raw.exec(`
      CREATE TABLE signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coin TEXT NOT NULL,
        signal TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        timeframe TEXT NOT NULL,
        price_at_signal REAL NOT NULL,
        price_after_15m REAL,
        price_after_1h REAL,
        price_after_4h REAL,
        price_after_24h REAL,
        return_pct_15m REAL,
        return_pct_1h REAL,
        return_pct_4h REAL,
        return_pct_24h REAL,
        created_at INTEGER NOT NULL
      );
    `);
    // Insert a row that pre-dates all migrations.
    raw.prepare(
      `INSERT INTO signals (coin, signal, confidence, timeframe, price_at_signal, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('BTC', 'BUY', 75, '1h', 50000, Math.floor(Date.now() / 1000));
    raw.close();

    // Re-import the module so getBackend() runs migrations against the legacy schema.
    vi.resetModules();
    const reloaded = await import('../src/lib/performance-db.js');

    const rows = await reloaded.dbQuery<{ name: string }>(
      'PRAGMA table_info(signals)',
      []
    );
    const names = new Set(rows.map(r => r.name));
    for (const col of EXPECTED_MIGRATED_COLUMNS) {
      expect(names.has(col), `expected migrated column ${col} after reload`).toBe(true);
    }

    // Pre-existing row must survive the migration.
    const existing = await reloaded.dbQuery<{ coin: string }>(
      'SELECT coin FROM signals WHERE coin = ?',
      ['BTC']
    );
    expect(existing.length).toBe(1);
    expect(existing[0].coin).toBe('BTC');

    reloaded.closeDb();
  });
});
