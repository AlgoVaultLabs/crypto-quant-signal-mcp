/**
 * Performance DB — dual backend: PostgreSQL (remote) or SQLite (local).
 * If DATABASE_URL env exists → PostgreSQL, else → SQLite at ~/.crypto-quant-signal/performance.db
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { SignalRecord, SignalVerdict, PerformanceStats } from '../types.js';

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
    this.pool.query(sql).catch(() => {});
  }

  run(sql: string, ...params: unknown[]): void {
    // Convert ? placeholders to $1, $2, etc. for pg
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    this.pool.query(pgSql, params).catch(() => {});
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

// Migration: add unified outcome columns if missing (runs on existing DBs)
const MIGRATE_OUTCOME_COLS = `
  ALTER TABLE signals ADD COLUMN IF NOT EXISTS outcome_price REAL;
`;
const MIGRATE_OUTCOME_COLS_2 = `
  ALTER TABLE signals ADD COLUMN IF NOT EXISTS outcome_return_pct REAL;
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
  // Migrate: add outcome columns to existing tables (safe if already exists)
  try { backend.exec(MIGRATE_OUTCOME_COLS); } catch { /* column already exists */ }
  try { backend.exec(MIGRATE_OUTCOME_COLS_2); } catch { /* column already exists */ }
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
  priceAtSignal: number
): void {
  const b = getBackend();
  b.run(
    `INSERT INTO signals (coin, signal, confidence, timeframe, price_at_signal, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    coin, signal, confidence, timeframe, priceAtSignal, Math.floor(Date.now() / 1000)
  );
}

/**
 * Find signals that need outcome backfill.
 */
export function getSignalsNeedingBackfill(hoursAgo: 1 | 4 | 24): SignalRecord[] {
  if (isPg) return []; // For PG, use async version
  const b = getBackend();
  const field = `price_after_${hoursAgo}h`;
  const cutoff = Math.floor(Date.now() / 1000) - hoursAgo * 3600;
  return b.all(
    `SELECT * FROM signals WHERE ${field} IS NULL AND created_at <= ? ORDER BY created_at ASC LIMIT 50`,
    cutoff
  );
}

export async function getSignalsNeedingBackfillAsync(hoursAgo: 1 | 4 | 24): Promise<SignalRecord[]> {
  const b = getBackend();
  const field = `price_after_${hoursAgo}h`;
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
  const sql = `SELECT * FROM signals WHERE outcome_price IS NULL ORDER BY created_at ASC LIMIT 200`;

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
export function hasRecentSignal(coin: string, timeframe: string, withinSeconds: number): boolean {
  if (isPg) return false; // For PG, use async version
  const b = getBackend();
  const cutoff = Math.floor(Date.now() / 1000) - withinSeconds;
  const rows = b.all(
    `SELECT id FROM signals WHERE coin = ? AND timeframe = ? AND created_at >= ? LIMIT 1`,
    coin, timeframe, cutoff
  );
  return rows.length > 0;
}

export async function hasRecentSignalAsync(coin: string, timeframe: string, withinSeconds: number): Promise<boolean> {
  const b = getBackend();
  const cutoff = Math.floor(Date.now() / 1000) - withinSeconds;
  if (isPg && b instanceof PgBackend) {
    const rows = await b.query(
      `SELECT id FROM signals WHERE coin = ? AND timeframe = ? AND created_at >= ? LIMIT 1`,
      [coin, timeframe, cutoff]
    );
    return rows.length > 0;
  }
  return hasRecentSignal(coin, timeframe, withinSeconds);
}

export function getPerformanceStats(): PerformanceStats {
  if (isPg) {
    // For PG, return empty stats — use async version
    return emptyStats();
  }
  const b = getBackend();
  const all = b.all(`SELECT * FROM signals ORDER BY created_at DESC`);
  return computeStats(all);
}

export async function getPerformanceStatsAsync(): Promise<PerformanceStats> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    const all = await b.query(`SELECT * FROM signals ORDER BY created_at DESC`);
    return computeStats(all);
  }
  return getPerformanceStats();
}

function emptyStats(): PerformanceStats {
  return {
    totalSignals: 0,
    period: { from: '', to: '' },
    overall: { winRate: null, avgReturnPct: null, sharpeRatio: null, maxDrawdownPct: null, profitFactor: null },
    bySignalType: {},
    byTimeframe: {},
    byAsset: {},
    recentSignals: [],
  };
}

function computeStats(all: SignalRecord[]): PerformanceStats {
  if (all.length === 0) return emptyStats();

  const oldest = all[all.length - 1];
  const newest = all[0];

  // v1.3: Use unified outcome_return_pct (evaluated at signal's own timeframe)
  const evaluated = all.filter(s => s.outcome_return_pct != null && s.signal !== 'HOLD');

  // Helper: compute P&L-adjusted return (invert for SELL)
  function pnlReturn(s: SignalRecord): number {
    const r = s.outcome_return_pct ?? 0;
    return Math.max(s.signal === 'SELL' ? -r : r, -100);
  }

  function isWin(s: SignalRecord): boolean {
    if (s.signal === 'BUY') return (s.outcome_return_pct ?? 0) > 0;
    if (s.signal === 'SELL') return (s.outcome_return_pct ?? 0) < 0;
    return false;
  }

  const wins = evaluated.filter(isWin);
  const returns = evaluated.map(pnlReturn);

  const winRate = evaluated.length > 0 ? wins.length / evaluated.length : null;
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;

  let sharpe: number | null = null;
  if (returns.length > 1) {
    const mean = avgReturn!;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpe = (mean / stdDev) * Math.sqrt(2190);
    }
  }

  // Drawdown: sort chronologically (ascending), normalize by peak
  const chronReturns = [...returns].reverse();
  let peak = 0;
  let maxDD = 0;
  let cumReturn = 0;
  for (const r of chronReturns) {
    cumReturn += r;
    if (cumReturn > peak) peak = cumReturn;
    if (peak > 0) {
      const dd = ((cumReturn - peak) / peak) * 100;
      if (dd < maxDD) maxDD = dd;
    }
  }

  const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  const bySignalType: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }> = {};
  for (const type of ['BUY', 'SELL', 'HOLD'] as const) {
    const group = all.filter(s => s.signal === type);
    const evalGroup = group.filter(s => s.outcome_return_pct != null && type !== 'HOLD');
    const winsGroup = evalGroup.filter(isWin);
    const returnsGroup = evalGroup.map(pnlReturn);

    bySignalType[type] = {
      count: group.length,
      winRate: type === 'HOLD' ? null : (evalGroup.length > 0 ? winsGroup.length / evalGroup.length : null),
      avgReturnPct: type === 'HOLD' ? null : (returnsGroup.length > 0 ? returnsGroup.reduce((a, b) => a + b, 0) / returnsGroup.length : null),
    };
  }

  // v1.3: Performance by timeframe — group by signal's timeframe, using unified outcome
  const byTimeframe: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }> = {};
  const allTimeframes = [...new Set(all.map(s => s.timeframe))];
  const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];
  allTimeframes.sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));

  for (const tf of allTimeframes) {
    const tfSignals = all.filter(s => s.timeframe === tf && s.signal !== 'HOLD');
    const tfEval = tfSignals.filter(s => s.outcome_return_pct != null);
    if (tfEval.length === 0) {
      byTimeframe[tf] = { count: tfSignals.length, winRate: null, avgReturnPct: null };
      continue;
    }
    const tfWins = tfEval.filter(isWin);
    const tfReturns = tfEval.map(pnlReturn);
    byTimeframe[tf] = {
      count: tfEval.length,
      winRate: tfWins.length / tfEval.length,
      avgReturnPct: tfReturns.reduce((a, b) => a + b, 0) / tfReturns.length,
    };
  }

  const coins = [...new Set(all.map(s => s.coin))];
  const byAsset: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }> = {};
  for (const coin of coins) {
    const group = all.filter(s => s.coin === coin);
    const evalGroup = group.filter(s => s.outcome_return_pct != null && s.signal !== 'HOLD');
    const winsGroup = evalGroup.filter(isWin);
    const returnsGroup = evalGroup.map(pnlReturn);

    byAsset[coin] = {
      count: group.length,
      winRate: evalGroup.length > 0 ? winsGroup.length / evalGroup.length : null,
      avgReturnPct: returnsGroup.length > 0 ? returnsGroup.reduce((a, b) => a + b, 0) / returnsGroup.length : null,
    };
  }

  return {
    totalSignals: all.length,
    period: {
      from: new Date(oldest.created_at * 1000).toISOString().split('T')[0],
      to: new Date(newest.created_at * 1000).toISOString().split('T')[0],
    },
    overall: {
      winRate,
      avgReturnPct: avgReturn,
      sharpeRatio: sharpe,
      maxDrawdownPct: maxDD < 0 ? Math.round(maxDD * 100) / 100 : null,
      profitFactor,
    },
    bySignalType,
    byTimeframe,
    byAsset,
    recentSignals: all.slice(0, 20),
  };
}
