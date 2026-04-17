/**
 * Performance DB — dual backend: PostgreSQL (remote) or SQLite (local).
 * If DATABASE_URL env exists → PostgreSQL, else → SQLite at ~/.crypto-quant-signal/performance.db
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { SignalRecord, SignalVerdict, PerformanceStats } from '../types.js';
import { classifyAsset, TIER_DEFINITIONS, getTop20ByOI } from './asset-tiers.js';

const DB_DIR = path.join(os.homedir(), '.crypto-quant-signal');
const DB_PATH = path.join(DB_DIR, 'performance.db');

// ── DB Backend Interface ──

interface DbBackend {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  all(sql: string, ...params: unknown[]): SignalRecord[];
  close(): void;
}

// ── SQLite Backend ──

class SqliteBackend implements DbBackend {
  private db: import('better-sqlite3').Database;

  constructor() {
    // Dynamic import resolved at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  all(sql: string, ...params: unknown[]): SignalRecord[] {
    return this.db.prepare(sql).all(...params) as SignalRecord[];
  }

  close(): void {
    this.db.close();
  }
}

// ── PostgreSQL Backend ──

class PgBackend implements DbBackend {
  private pool: import('pg').Pool;

  constructor(connectionString: string) {
    // Dynamic import resolved at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString });
  }

  exec(sql: string): void {
    // Fire and forget — init schema
    this.pool.query(sql).catch((err) => { console.error('PG exec error:', err.message); });
  }

  run(sql: string, ...params: unknown[]): void {
    // Convert ? placeholders to $1, $2, etc. for pg
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    this.pool.query(pgSql, params).catch((err) => { console.error('PG run error:', err.message); });
  }

  all(sql: string, ...params: unknown[]): SignalRecord[] {
    // Synchronous-style not possible with pg, so we cache results
    // This is called from sync getPerformanceStats — we use a sync workaround
    // by pre-fetching. See getPerformanceStatsAsync below.
    return [];
  }

  close(): void {
    this.pool.end().catch(() => {});
  }

  async query(sql: string, params: unknown[] = []): Promise<SignalRecord[]> {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    const result = await this.pool.query(pgSql, params);
    return result.rows as SignalRecord[];
  }

  async execAsync(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async runAsync(sql: string, ...params: unknown[]): Promise<void> {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    await this.pool.query(pgSql, params);
  }
}

// ── Shared State ──

let backend: DbBackend | null = null;
let isPg = false;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS signals (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    coin TEXT NOT NULL,
    signal TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    timeframe TEXT NOT NULL,
    exchange TEXT NOT NULL DEFAULT 'HL',
    price_at_signal REAL NOT NULL,
    price_after_15m REAL,
    price_after_1h REAL,
    price_after_4h REAL,
    price_after_24h REAL,
    return_pct_15m REAL,
    return_pct_1h REAL,
    return_pct_4h REAL,
    return_pct_24h REAL,
    outcome_price REAL,
    outcome_return_pct REAL,
    created_at INTEGER NOT NULL
  );
`;

// Schema-aware migration descriptors for the `signals` table.
// Order is preserved exactly as historical migrations ran. PostgreSQL uses
// native ADD COLUMN IF NOT EXISTS (PG 9.6+); SQLite uses a single
// PRAGMA table_info() pre-check to skip already-present columns.
type MigrationDescriptor = { table: string; column: string; type: string };

const SIGNAL_MIGRATIONS: MigrationDescriptor[] = [
  // v1.3: unified outcome columns
  { table: 'signals', column: 'outcome_price', type: 'REAL' },
  { table: 'signals', column: 'outcome_return_pct', type: 'REAL' },
  // v1.4: PFE/MAE + 1-candle return
  { table: 'signals', column: 'pfe_return_pct', type: 'REAL' },
  { table: 'signals', column: 'mae_return_pct', type: 'REAL' },
  { table: 'signals', column: 'pfe_price', type: 'REAL' },
  { table: 'signals', column: 'mae_price', type: 'REAL' },
  { table: 'signals', column: 'pfe_candles', type: 'INTEGER' },
  { table: 'signals', column: 'return_1candle', type: 'REAL' },
  // v1.5: exchange column for multi-exchange support
  { table: 'signals', column: 'exchange', type: "TEXT NOT NULL DEFAULT 'HL'" },
  // R5 (2026-04-14): regime label for audit round H5
  { table: 'signals', column: 'regime', type: 'TEXT NULL' },
  // Merkle proof columns
  { table: 'signals', column: 'signal_hash', type: 'VARCHAR(66)' },
  { table: 'signals', column: 'merkle_batch_id', type: 'INTEGER' },
  { table: 'signals', column: 'merkle_proof', type: 'JSONB' },
];

function runMigrations(b: DbBackend, pg: boolean): void {
  if (pg) {
    for (const m of SIGNAL_MIGRATIONS) {
      b.exec(`ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${m.type};`);
    }
    return;
  }
  // SQLite: introspect existing columns once per distinct table, then skip present ones.
  const tables = new Set(SIGNAL_MIGRATIONS.map(m => m.table));
  const existingByTable = new Map<string, Set<string>>();
  for (const t of tables) {
    const rows = b.all(`PRAGMA table_info(${t})`) as unknown as { name: string }[];
    existingByTable.set(t, new Set(rows.map(r => r.name)));
  }
  for (const m of SIGNAL_MIGRATIONS) {
    const present = existingByTable.get(m.table);
    if (present && present.has(m.column)) continue;
    b.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type};`);
  }
}

const CREATE_MERKLE_BATCHES_SQL = `
  CREATE TABLE IF NOT EXISTS merkle_batches (
    batch_id INTEGER PRIMARY KEY,
    merkle_root VARCHAR(66) NOT NULL,
    signal_count INTEGER NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number VARCHAR(20) NOT NULL,
    published_at ${process.env.DATABASE_URL ? 'TIMESTAMP NOT NULL DEFAULT NOW()' : 'TEXT NOT NULL DEFAULT (datetime(\'now\'))'}
  );
`;

const CREATE_FUNDING_HISTORY_SQL = `
  CREATE TABLE IF NOT EXISTS funding_history (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    coin TEXT NOT NULL,
    funding_rate REAL NOT NULL,
    recorded_at INTEGER NOT NULL
  );
`;

const CREATE_HOLD_COUNTS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS hold_counts (
      date DATE NOT NULL,
      timeframe VARCHAR(10) NOT NULL,
      coin VARCHAR(20) NOT NULL,
      hold_count INTEGER DEFAULT 0,
      PRIMARY KEY (date, timeframe, coin)
    );`
  : `CREATE TABLE IF NOT EXISTS hold_counts (
      date TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      coin TEXT NOT NULL,
      hold_count INTEGER DEFAULT 0,
      PRIMARY KEY (date, timeframe, coin)
    );`;

// v1.9.0 L3 (2026-04-15): agent_sessions cohort table.
// Persisted on every tool call (when sessionId is present, i.e. HTTP transport).
const CREATE_AGENT_SESSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id     TEXT PRIMARY KEY,
    first_seen     ${process.env.DATABASE_URL ? 'BIGINT' : 'INTEGER'} NOT NULL,
    last_seen      ${process.env.DATABASE_URL ? 'BIGINT' : 'INTEGER'} NOT NULL,
    call_count     INTEGER NOT NULL DEFAULT 0,
    tools_used     TEXT NOT NULL DEFAULT '',
    tiers_seen     TEXT NOT NULL DEFAULT '',
    first_tool     TEXT,
    first_tier     TEXT,
    ip_hash_first  TEXT
  );
`;

const CREATE_AGENT_SESSIONS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_seen ON agent_sessions(last_seen);
`;

function getBackend(): DbBackend {
  if (backend) return backend;

  if (process.env.DATABASE_URL) {
    isPg = true;
    backend = new PgBackend(process.env.DATABASE_URL);
  } else {
    isPg = false;
    backend = new SqliteBackend();
  }

  backend.exec(CREATE_TABLE_SQL);
  backend.exec(CREATE_FUNDING_HISTORY_SQL);
  backend.exec(CREATE_HOLD_COUNTS_SQL);
  backend.exec(CREATE_MERKLE_BATCHES_SQL);
  backend.exec(CREATE_AGENT_SESSIONS_SQL);
  backend.exec(CREATE_AGENT_SESSIONS_INDEX_SQL);
  runMigrations(backend, isPg);
  return backend;
}

export function closeDb(): void {
  if (backend) {
    backend.close();
    backend = null;
  }
}

// ── Generic DB access for other modules (analytics) ──

export function dbExec(sql: string): void {
  getBackend().exec(sql);
}

export function dbRun(sql: string, ...params: unknown[]): void {
  getBackend().run(sql, ...params);
}

export async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    return b.query(sql, params) as unknown as T[];
  }
  return b.all(sql, ...params) as unknown as T[];
}

export function recordSignal(
  coin: string,
  signal: SignalVerdict,
  confidence: number,
  timeframe: string,
  priceAtSignal: number,
  signalHash?: string,
  exchange: string = 'HL',
  regime?: string | null  // R5: regime label persisted for audit round H5
): void {
  const b = getBackend();
  b.run(
    `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, signal_hash, regime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    coin, signal, confidence, timeframe, exchange, priceAtSignal, Math.floor(Date.now() / 1000), signalHash || null, regime ?? null
  );
}

/**
 * Find signals that need outcome backfill.
 */
// Allowlist for dynamic column names — prevents SQL injection
const VALID_OUTCOME_FIELDS = new Set(['price_after_1h', 'price_after_4h', 'price_after_24h', 'price_after_15m']);
const VALID_RETURN_FIELDS = new Set(['return_pct_1h', 'return_pct_4h', 'return_pct_24h', 'return_pct_15m']);

export function getSignalsNeedingBackfill(hoursAgo: 1 | 4 | 24): SignalRecord[] {
  if (isPg) return []; // For PG, use async version
  const b = getBackend();
  const field = `price_after_${hoursAgo}h`;
  if (!VALID_OUTCOME_FIELDS.has(field)) throw new Error(`Invalid backfill field: ${field}`);
  const cutoff = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
  return b.all(
    `SELECT * FROM signals WHERE ${field} IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT 50`,
    cutoff
  );
}

export async function getSignalsNeedingBackfillAsync(hoursAgo: 1 | 4 | 24): Promise<SignalRecord[]> {
  const b = getBackend();
  const field = `price_after_${hoursAgo}h`;
  if (!VALID_OUTCOME_FIELDS.has(field)) throw new Error(`Invalid backfill field: ${field}`);
  const cutoff = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
  if (isPg && b instanceof PgBackend) {
    return b.query(
      `SELECT * FROM signals WHERE ${field} IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT 50`,
      [cutoff]
    );
  }
  return getSignalsNeedingBackfill(hoursAgo);
}

/**
 * Find signals that need 15-minute outcome backfill.
 */
export async function getSignalsNeedingBackfill15mAsync(): Promise<SignalRecord[]> {
  const b = getBackend();
  const cutoff = Math.floor(Date.now() / 1000) - 15 * 60; // 15 minutes ago
  if (isPg && b instanceof PgBackend) {
    return b.query(
      `SELECT * FROM signals WHERE price_after_15m IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT 50`,
      [cutoff]
    );
  }
  // SQLite fallback
  return b.all(
    `SELECT * FROM signals WHERE price_after_15m IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT 50`,
    cutoff
  );
}

export function updateOutcome(
  id: number,
  field: 'price_after_15m' | 'price_after_1h' | 'price_after_4h' | 'price_after_24h',
  price: number,
  returnPctField: 'return_pct_15m' | 'return_pct_1h' | 'return_pct_4h' | 'return_pct_24h',
  returnPct: number
): void {
  if (!VALID_OUTCOME_FIELDS.has(field)) throw new Error(`Invalid outcome field: ${field}`);
  if (!VALID_RETURN_FIELDS.has(returnPctField)) throw new Error(`Invalid return field: ${returnPctField}`);
  const b = getBackend();
  b.run(
    `UPDATE signals SET ${field} = ?, ${returnPctField} = ? WHERE id = ?`,
    price, returnPct, id
  );
}

/** v1.3: Update the unified outcome columns (signal evaluated at its own timeframe). */
export function updateUnifiedOutcome(
  id: number,
  outcomePrice: number,
  outcomeReturnPct: number
): void {
  const b = getBackend();
  b.run(
    `UPDATE signals SET outcome_price = ?, outcome_return_pct = ? WHERE id = ?`,
    outcomePrice, outcomeReturnPct, id
  );
}

/** v1.4: Record a funding rate observation for Z-Score computation. */
export function recordFunding(coin: string, fundingRate: number): void {
  const b = getBackend();
  b.run(
    `INSERT INTO funding_history (coin, funding_rate, recorded_at) VALUES (?, ?, ?)`,
    coin, fundingRate, Math.floor(Date.now() / 1000)
  );
}

/** Increment the HOLD counter for a coin/timeframe/day. Lightweight — one row per combo. */
export function recordHoldCount(coin: string, timeframe: string): void {
  const b = getBackend();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  if (isPg) {
    b.run(
      `INSERT INTO hold_counts (date, timeframe, coin, hold_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (date, timeframe, coin)
       DO UPDATE SET hold_count = hold_counts.hold_count + 1`,
      today, timeframe, coin
    );
  } else {
    b.run(
      `INSERT INTO hold_counts (date, timeframe, coin, hold_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (date, timeframe, coin)
       DO UPDATE SET hold_count = hold_count + 1`,
      today, timeframe, coin
    );
  }
}

/**
 * v1.9.0 L3 (2026-04-15): Upsert an agent_sessions row on every tool call.
 *
 * - First call for a sessionId: INSERT with first_seen=last_seen=now, call_count=1.
 * - Subsequent calls: UPDATE last_seen, increment call_count, append tool/tier
 *   if not already present (comma-separated, dedup in JS for portability).
 *
 * Failure-tolerant: callers should fire-and-forget with `.catch(...)`; this
 * helper is on the hot request path and must not throw on DB error.
 */
export async function upsertAgentSession(params: {
  sessionId: string;
  tool: string;
  tier: string;
  ipHash: string | null;
}): Promise<void> {
  const { sessionId, tool, tier, ipHash } = params;
  const now = Date.now();
  const b = getBackend();

  try {
    // Read current row (works for both PG and SQLite via dbQuery)
    let existing: { tools_used: string; tiers_seen: string }[];
    if (isPg && b instanceof PgBackend) {
      existing = await b.query(
        `SELECT tools_used, tiers_seen FROM agent_sessions WHERE session_id = ?`,
        [sessionId]
      ) as unknown as { tools_used: string; tiers_seen: string }[];
    } else {
      existing = b.all(
        `SELECT tools_used, tiers_seen FROM agent_sessions WHERE session_id = ?`,
        sessionId
      ) as unknown as { tools_used: string; tiers_seen: string }[];
    }

    if (existing.length === 0) {
      // First call — INSERT
      const insertSql = `INSERT INTO agent_sessions
        (session_id, first_seen, last_seen, call_count, tools_used, tiers_seen, first_tool, first_tier, ip_hash_first)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      if (isPg && b instanceof PgBackend) {
        await b.runAsync(insertSql, sessionId, now, now, 1, tool, tier, tool, tier, ipHash);
      } else {
        b.run(insertSql, sessionId, now, now, 1, tool, tier, tool, tier, ipHash);
      }
      return;
    }

    // Subsequent call — dedup tools_used / tiers_seen in JS, then UPDATE
    const currentTools = existing[0].tools_used.split(',').filter(Boolean);
    const currentTiers = existing[0].tiers_seen.split(',').filter(Boolean);
    if (!currentTools.includes(tool)) currentTools.push(tool);
    if (!currentTiers.includes(tier)) currentTiers.push(tier);
    const newToolsUsed = currentTools.join(',');
    const newTiersSeen = currentTiers.join(',');

    const updateSql = `UPDATE agent_sessions
      SET last_seen = ?, call_count = call_count + 1, tools_used = ?, tiers_seen = ?
      WHERE session_id = ?`;
    if (isPg && b instanceof PgBackend) {
      await b.runAsync(updateSql, now, newToolsUsed, newTiersSeen, sessionId);
    } else {
      b.run(updateSql, now, newToolsUsed, newTiersSeen, sessionId);
    }
  } catch (e) {
    console.debug('upsertAgentSession failed:', e instanceof Error ? e.message : e);
  }
}

/** Get total HOLD count and per-tier breakdown. */
export async function getHoldStats(): Promise<{ totalHolds: number; holdsByTier: Record<string, number> }> {
  const b = getBackend();
  const top20 = await getTop20ByOI().catch(() => null);

  let rows: { coin: string; holds: number }[];
  if (isPg && b instanceof PgBackend) {
    const raw = await b.query(
      `SELECT coin, SUM(hold_count)::int as holds FROM hold_counts GROUP BY coin`
    );
    rows = raw.map((r: any) => ({ coin: r.coin, holds: parseInt(r.holds) || 0 }));
  } else {
    const raw = b.all(`SELECT coin, SUM(hold_count) as holds FROM hold_counts GROUP BY coin`);
    rows = (raw as any[]).map(r => ({ coin: r.coin, holds: r.holds || 0 }));
  }

  let totalHolds = 0;
  const holdsByTier: Record<string, number> = {};
  for (const r of rows) {
    totalHolds += r.holds;
    const tier = String(classifyAsset(r.coin, top20));
    holdsByTier[tier] = (holdsByTier[tier] || 0) + r.holds;
  }

  return { totalHolds, holdsByTier };
}

// ── TradFi gate queries ──

export async function getTradFiPfeWinRate(tradfiSymbols: string[]): Promise<{ winRate: number; evaluated: number }> {
  if (tradfiSymbols.length === 0) return { winRate: 100, evaluated: 0 };
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    const placeholders = tradfiSymbols.map((_, i) => `$${i + 1}`).join(',');
    const rows = await b.query(
      `SELECT signal, pfe_return_pct FROM signals WHERE coin IN (${placeholders}) AND pfe_return_pct IS NOT NULL`,
      tradfiSymbols
    );
    if (rows.length === 0) return { winRate: 100, evaluated: 0 };
    const wins = rows.filter((r: any) =>
      r.signal === 'BUY' ? r.pfe_return_pct > 0 : r.pfe_return_pct < 0
    );
    return { winRate: (wins.length / rows.length) * 100, evaluated: rows.length };
  }
  // SQLite fallback
  const all = b.all(`SELECT coin, signal, pfe_return_pct FROM signals WHERE pfe_return_pct IS NOT NULL`);
  const tfSet = new Set(tradfiSymbols);
  const tfSignals = all.filter(s => tfSet.has(s.coin));
  if (tfSignals.length === 0) return { winRate: 100, evaluated: 0 };
  const wins = tfSignals.filter(s =>
    s.signal === 'BUY' ? (s.pfe_return_pct ?? 0) > 0 : (s.pfe_return_pct ?? 0) < 0
  );
  return { winRate: (wins.length / tfSignals.length) * 100, evaluated: tfSignals.length };
}

// ── Merkle batch queries ──

/** Get un-batched signals that have a hash but no batch ID. */
export async function getUnbatchedSignals(): Promise<{ id: number; signal_hash: string }[]> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    return b.query(
      `SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL ORDER BY created_at ASC`
    ) as any;
  }
  return b.all(
    `SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL ORDER BY created_at ASC`
  ) as any;
}

/** Get the next batch ID. */
export async function getNextBatchId(): Promise<number> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    const rows = await b.query(`SELECT COALESCE(MAX(batch_id), 0) as last_id FROM merkle_batches`);
    return parseInt((rows[0] as any).last_id) + 1;
  }
  const rows = b.all(`SELECT COALESCE(MAX(batch_id), 0) as last_id FROM merkle_batches`);
  return parseInt((rows[0] as any).last_id) + 1;
}

/** Store a published Merkle batch. */
export async function storeMerkleBatch(
  batchId: number, merkleRoot: string, signalCount: number, txHash: string, blockNumber: string
): Promise<void> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    await b.runAsync(
      `INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number) VALUES (?, ?, ?, ?, ?)`,
      batchId, merkleRoot, signalCount, txHash, blockNumber
    );
  } else {
    b.run(
      `INSERT INTO merkle_batches (batch_id, merkle_root, signal_count, tx_hash, block_number) VALUES (?, ?, ?, ?, ?)`,
      batchId, merkleRoot, signalCount, txHash, blockNumber
    );
  }
}

/** Update a signal with its batch ID and Merkle proof. */
export async function updateSignalMerkleProof(signalId: number, batchId: number, proof: string): Promise<void> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    await b.runAsync(
      `UPDATE signals SET merkle_batch_id = ?, merkle_proof = ? WHERE id = ?`,
      batchId, proof, signalId
    );
  } else {
    b.run(
      `UPDATE signals SET merkle_batch_id = ?, merkle_proof = ? WHERE id = ?`,
      batchId, proof, signalId
    );
  }
}

/** Get all Merkle batches (most recent first). */
export async function getMerkleBatches(limit = 100): Promise<any[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    return b.query(
      `SELECT batch_id, merkle_root, signal_count, tx_hash, block_number, published_at FROM merkle_batches ORDER BY batch_id DESC LIMIT ?`,
      [safeLimit]
    );
  }
  return b.all(
    `SELECT batch_id, merkle_root, signal_count, tx_hash, block_number, published_at FROM merkle_batches ORDER BY batch_id DESC LIMIT ?`,
    safeLimit
  ) as any;
}

/** Get a signal with its batch info for verification. */
export async function getSignalWithBatch(signalId: number): Promise<any | null> {
  const b = getBackend();
  const sql = `
    SELECT s.id, s.coin, s.signal, s.confidence, s.timeframe, s.price_at_signal,
           s.created_at, s.signal_hash, s.merkle_batch_id, s.merkle_proof,
           mb.merkle_root, mb.tx_hash, mb.block_number, mb.signal_count, mb.published_at
    FROM signals s
    LEFT JOIN merkle_batches mb ON s.merkle_batch_id = mb.batch_id
    WHERE s.id = ?
  `;
  if (isPg && b instanceof PgBackend) {
    const rows = await b.query(sql, [signalId]);
    return rows.length > 0 ? rows[0] : null;
  }
  const rows = b.all(sql, signalId);
  return rows.length > 0 ? rows[0] : null;
}

/** v1.4: Compute Funding Z-Score from rolling 14-day history. */
export async function getFundingZScore(coin: string, currentFunding: number): Promise<number | null> {
  const b = getBackend();
  const cutoff14d = Math.floor(Date.now() / 1000) - 14 * 86400;

  let rows: { funding_rate: number }[];
  if (isPg && b instanceof PgBackend) {
    rows = await b.query(
      'SELECT funding_rate FROM funding_history WHERE coin = ? AND recorded_at >= ? ORDER BY recorded_at',
      [coin, cutoff14d]
    ) as unknown as { funding_rate: number }[];
  } else {
    rows = b.all(
      'SELECT funding_rate FROM funding_history WHERE coin = ? AND recorded_at >= ? ORDER BY recorded_at',
      coin, cutoff14d
    ) as unknown as { funding_rate: number }[];
  }

  if (rows.length < 20) return null; // Need minimum ~20 data points

  const rates = rows.map(r => r.funding_rate);
  const mean = rates.reduce((a, v) => a + v, 0) / rates.length;
  const variance = rates.reduce((a, v) => a + (v - mean) ** 2, 0) / (rates.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;
  return (currentFunding - mean) / stdDev;
}

/** v1.4.1: Update all outcome columns (unified + PFE/MAE + 1-candle). */
export async function updateSignalOutcomes(id: number, data: {
  outcome_price: number;
  outcome_return_pct: number;
  return_1candle: number;
  pfe_price: number;
  pfe_return_pct: number;
  mae_price: number;
  mae_return_pct: number;
  pfe_candles: number;
}): Promise<void> {
  const b = getBackend();
  const sql = `UPDATE signals SET
    outcome_price = ?, outcome_return_pct = ?, return_1candle = ?,
    pfe_price = ?, pfe_return_pct = ?,
    mae_price = ?, mae_return_pct = ?,
    pfe_candles = ?
    WHERE id = ?`;

  if (isPg && b instanceof PgBackend) {
    await b.runAsync(sql,
      data.outcome_price, data.outcome_return_pct, data.return_1candle,
      data.pfe_price, data.pfe_return_pct,
      data.mae_price, data.mae_return_pct,
      data.pfe_candles, id
    );
  } else {
    b.run(sql,
      data.outcome_price, data.outcome_return_pct, data.return_1candle,
      data.pfe_price, data.pfe_return_pct,
      data.mae_price, data.mae_return_pct,
      data.pfe_candles, id
    );
  }
}

/**
 * v1.3: Find signals that need unified outcome backfill.
 * Only returns signals where outcome_price IS NULL and enough time has passed
 * for the signal's own timeframe.
 */
const TIMEFRAME_SECONDS: Record<string, number> = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800, '12h': 43200, '1d': 86400,
};

export async function getSignalsNeedingUnifiedBackfillAsync(): Promise<SignalRecord[]> {
  const b = getBackend();
  const now = Math.floor(Date.now() / 1000);

  // Build a CASE-based query: only select signals old enough for their timeframe
  // We use a generous approach: fetch all pending, then filter in JS (simpler across SQLite/PG)
  const sql = `SELECT * FROM signals WHERE outcome_price IS NULL ORDER BY created_at ASC LIMIT 5000`;

  let rows: SignalRecord[];
  if (isPg && b instanceof PgBackend) {
    rows = await b.query(sql);
  } else {
    rows = b.all(sql);
  }

  // Filter: only signals old enough for their timeframe
  return rows.filter(s => {
    const evalWindow = TIMEFRAME_SECONDS[s.timeframe];
    if (!evalWindow) return false;
    return (now - s.created_at) >= evalWindow;
  });
}

/**
 * Check if a signal for the given coin+timeframe was recorded within the last N seconds.
 * Used by seed script for idempotency.
 */
export function hasRecentSignal(coin: string, timeframe: string, withinSeconds: number, exchange: string = 'HL'): boolean {
  if (isPg) return false; // For PG, use async version
  const b = getBackend();
  const cutoff = Math.floor(Date.now() / 1000) - withinSeconds;
  const rows = b.all(
    `SELECT id FROM signals WHERE coin = ? AND timeframe = ? AND exchange = ? AND created_at >= ? LIMIT 1`,
    coin, timeframe, exchange, cutoff
  );
  return rows.length > 0;
}

export async function hasRecentSignalAsync(coin: string, timeframe: string, withinSeconds: number, exchange: string = 'HL'): Promise<boolean> {
  const b = getBackend();
  const cutoff = Math.floor(Date.now() / 1000) - withinSeconds;
  if (isPg && b instanceof PgBackend) {
    const rows = await b.query(
      `SELECT id FROM signals WHERE coin = ? AND timeframe = ? AND exchange = ? AND created_at >= ? LIMIT 1`,
      [coin, timeframe, exchange, cutoff]
    );
    return rows.length > 0;
  }
  return hasRecentSignal(coin, timeframe, withinSeconds, exchange);
}

export function getPerformanceStats(): PerformanceStats {
  if (isPg) {
    return emptyStats();
  }
  const b = getBackend();
  const all = b.all(`SELECT * FROM signals ORDER BY created_at DESC`);
  return computeStats(all, null);
}

export async function getPerformanceStatsAsync(): Promise<PerformanceStats> {
  const top20 = await getTop20ByOI().catch(() => null);
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    const all = await b.query(`SELECT * FROM signals ORDER BY created_at DESC`);
    return computeStats(all, top20);
  }
  const all = b.all(`SELECT * FROM signals ORDER BY created_at DESC`);
  return computeStats(all, top20);
}

const METHODOLOGY: Record<string, unknown> = {
  pfeWinRate: 'Peak Favorable Excursion win rate. Did price move in the signal direction at any point during the evaluation window?',
  note: 'AlgoVault provides directional entry signals. Exit timing is determined by your agent or strategy — PFE Win Rate measures whether the direction was correct, independent of exit.',
  evaluationWindows: {
    '5m': '12 candles (1 hour)', '15m': '12 candles (3 hours)', '30m': '8 candles (4 hours)',
    '1h': '8 candles (8 hours)', '2h': '6 candles (12 hours)', '4h': '6 candles (24 hours)',
    '8h': '4 candles (32 hours)', '12h': '4 candles (48 hours)', '1d': '3 candles (3 days)',
  },
  dataSource: 'Hyperliquid public API. Every qualifying signal recorded and evaluated.',
  signalFilter: 'Confidence >= 60%. HOLD signals excluded.',
};

function emptyStats(): PerformanceStats {
  return {
    totalSignals: 0,
    period: { from: '', to: '' },
    overall: { totalSignals: 0, totalEvaluated: 0, pfeWinRate: null },
    bySignalType: {},
    byTimeframe: {},
    byAsset: {},
    byTier: {},
    recentSignals: [],
    methodology: METHODOLOGY,
  };
}

function computeStats(all: SignalRecord[], top20ByOI: Set<string> | null = null): PerformanceStats {
  if (all.length === 0) return emptyStats();

  const oldest = all[all.length - 1];
  const newest = all[0];

  const nonHold = all.filter(s => s.signal !== 'HOLD');

  // PFE Win Rate: did price move in signal direction during eval window?
  const evaluatedPFE = nonHold.filter(s => s.pfe_return_pct != null);
  const pfeWins = evaluatedPFE.filter(s => {
    const pfe = s.pfe_return_pct ?? 0;
    return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
  });
  const pfeWinRate = evaluatedPFE.length > 0 ? pfeWins.length / evaluatedPFE.length : null;

  // By signal type
  const bySignalType: Record<string, { count: number; pfeWinRate: number | null }> = {};
  for (const type of ['BUY', 'SELL', 'HOLD'] as const) {
    const group = all.filter(s => s.signal === type);
    const pfeGroup = group.filter(s => s.pfe_return_pct != null && type !== 'HOLD');
    const pfeWinsGroup = pfeGroup.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });

    bySignalType[type] = {
      count: type === 'HOLD' ? group.length : pfeGroup.length,
      pfeWinRate: type === 'HOLD' ? null : (pfeGroup.length > 0 ? pfeWinsGroup.length / pfeGroup.length : null),
    };
  }

  // By timeframe
  const byTimeframe: PerformanceStats['byTimeframe'] = {};
  const allTimeframes = [...new Set(all.map(s => s.timeframe))];
  const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];
  allTimeframes.sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));

  for (const tf of allTimeframes) {
    const tfSignals = nonHold.filter(s => s.timeframe === tf);
    const tfPFE = tfSignals.filter(s => s.pfe_return_pct != null);
    const tfPFEWins = tfPFE.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });

    byTimeframe[tf] = {
      count: tfPFE.length,
      pfeWinRate: tfPFE.length > 0 ? tfPFEWins.length / tfPFE.length : null,
    };
  }

  // By asset (tier + PFE WR only)
  const coins = [...new Set(all.map(s => s.coin))];
  const byAsset: PerformanceStats['byAsset'] = {};
  for (const coin of coins) {
    const group = all.filter(s => s.coin === coin);
    const nh = group.filter(s => s.signal !== 'HOLD');
    const pfeGroup = nh.filter(s => s.pfe_return_pct != null);
    const pfeWinsGroup = pfeGroup.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });

    byAsset[coin] = {
      count: group.length,
      tier: classifyAsset(coin, top20ByOI),
      pfeWinRate: pfeGroup.length > 0 ? pfeWinsGroup.length / pfeGroup.length : null,
    };
  }

  // By tier
  const byTier: PerformanceStats['byTier'] = {};
  for (const tierDef of TIER_DEFINITIONS) {
    const tierSignals = nonHold.filter(s => classifyAsset(s.coin, top20ByOI) === tierDef.tier);
    const tierPFE = tierSignals.filter(s => s.pfe_return_pct != null);
    const tierPFEWins = tierPFE.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });
    const tierCoins = [...new Set(tierSignals.map(s => s.coin))].sort();

    byTier[`tier${tierDef.tier}`] = {
      tier: tierDef.tier,
      name: tierDef.name,
      label: tierDef.label,
      color: tierDef.color,
      count: tierSignals.length,
      evaluated: tierPFE.length,
      pfeWinRate: tierPFE.length > 0 ? tierPFEWins.length / tierPFE.length : null,
      assets: tierCoins,
    };
  }

  return {
    totalSignals: all.length,
    period: {
      from: new Date(oldest.created_at * 1000).toISOString().split('T')[0],
      to: new Date(newest.created_at * 1000).toISOString().split('T')[0],
    },
    overall: {
      totalSignals: nonHold.length,
      totalEvaluated: evaluatedPFE.length,
      pfeWinRate,
    },
    bySignalType,
    byTimeframe,
    byAsset,
    byTier,
    recentSignals: all.slice(0, 20).map(s => ({
      coin: s.coin, signal: s.signal, confidence: s.confidence,
      timeframe: s.timeframe, tier: classifyAsset(s.coin, top20ByOI),
      created_at: s.created_at,
      exchange: s.exchange || 'HL',
    })),
    methodology: METHODOLOGY,
  };
}

// ── Confidence band analysis ──

export interface ConfidenceBand {
  band: string;
  total: number;
  evaluated: number;
  pfeWinRate: number | null;
  buyCount: number;
  sellCount: number;
  avgConfidence: number;
  avgPfePct: number | null;
}

export async function getConfidenceBands(): Promise<ConfidenceBand[]> {
  const b = getBackend();
  if (!(isPg && b instanceof PgBackend)) {
    return [];
  }

  const sql = `
    SELECT
      CASE
        WHEN confidence >= 50 AND confidence < 55 THEN '50-54'
        WHEN confidence >= 55 AND confidence < 60 THEN '55-59'
        WHEN confidence >= 60 AND confidence < 65 THEN '60-64'
        WHEN confidence >= 65 AND confidence < 70 THEN '65-69'
        WHEN confidence >= 70 AND confidence < 75 THEN '70-74'
        WHEN confidence >= 75 AND confidence < 80 THEN '75-79'
        WHEN confidence >= 80 AND confidence < 85 THEN '80-84'
        WHEN confidence >= 85 AND confidence < 90 THEN '85-89'
        WHEN confidence >= 90 THEN '90+'
      END as band,
      COUNT(*) as total,
      COUNT(CASE WHEN pfe_return_pct IS NOT NULL THEN 1 END) as evaluated,
      COUNT(CASE
        WHEN signal = 'BUY' AND pfe_return_pct > 0 THEN 1
        WHEN signal = 'SELL' AND pfe_return_pct < 0 THEN 1
      END) as pfe_wins,
      COUNT(CASE WHEN signal = 'BUY' THEN 1 END) as buy_count,
      COUNT(CASE WHEN signal = 'SELL' THEN 1 END) as sell_count,
      ROUND(AVG(confidence)::numeric, 1) as avg_confidence,
      ROUND(AVG(CASE
        WHEN signal = 'BUY' AND pfe_return_pct > 0 THEN pfe_return_pct
        WHEN signal = 'SELL' AND pfe_return_pct < 0 THEN ABS(pfe_return_pct)
      END)::numeric, 3) as avg_pfe_pct
    FROM signals
    WHERE signal IN ('BUY', 'SELL')
    GROUP BY band
    ORDER BY band
  `;

  const rows = await b.query(sql);
  return rows
    .filter((r: any) => r.band !== null)
    .map((r: any) => ({
      band: r.band,
      total: parseInt(r.total),
      evaluated: parseInt(r.evaluated),
      pfeWinRate: parseInt(r.evaluated) > 0 ? parseInt(r.pfe_wins) / parseInt(r.evaluated) : null,
      buyCount: parseInt(r.buy_count),
      sellCount: parseInt(r.sell_count),
      avgConfidence: parseFloat(r.avg_confidence),
      avgPfePct: r.avg_pfe_pct ? parseFloat(r.avg_pfe_pct) : null,
    }));
}
