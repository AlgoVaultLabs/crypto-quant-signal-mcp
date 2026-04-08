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

// v1.4 migrations
const MIGRATE_PFE_COLS = [
  `ALTER TABLE signals ADD COLUMN IF NOT EXISTS pfe_return_pct REAL;`,
  `ALTER TABLE signals ADD COLUMN IF NOT EXISTS mae_return_pct REAL;`,
  `ALTER TABLE signals ADD COLUMN IF NOT EXISTS pfe_price REAL;`,
  `ALTER TABLE signals ADD COLUMN IF NOT EXISTS mae_price REAL;`,
  `ALTER TABLE signals ADD COLUMN IF NOT EXISTS pfe_candles INTEGER;`,
];

const CREATE_FUNDING_HISTORY_SQL = `
  CREATE TABLE IF NOT EXISTS funding_history (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    coin TEXT NOT NULL,
    funding_rate REAL NOT NULL,
    recorded_at INTEGER NOT NULL
  );
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
  // v1.4: PFE/MAE columns + funding history table
  for (const sql of MIGRATE_PFE_COLS) {
    try { backend.exec(sql); } catch { /* column already exists */ }
  }
  try { backend.exec(CREATE_FUNDING_HISTORY_SQL); } catch { /* table already exists */ }
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

/** v1.4: Record a funding rate observation for Z-Score computation. */
export function recordFunding(coin: string, fundingRate: number): void {
  const b = getBackend();
  b.run(
    `INSERT INTO funding_history (coin, funding_rate, recorded_at) VALUES (?, ?, ?)`,
    coin, fundingRate, Math.floor(Date.now() / 1000)
  );
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

/** v1.4: Update all outcome columns (unified + PFE/MAE). */
export async function updateSignalOutcomes(id: number, data: {
  outcome_price: number;
  outcome_return_pct: number;
  pfe_price: number;
  pfe_return_pct: number;
  mae_price: number;
  mae_return_pct: number;
  pfe_candles: number;
}): Promise<void> {
  const b = getBackend();
  const sql = `UPDATE signals SET
    outcome_price = ?, outcome_return_pct = ?,
    pfe_price = ?, pfe_return_pct = ?,
    mae_price = ?, mae_return_pct = ?,
    pfe_candles = ?
    WHERE id = ?`;

  if (isPg && b instanceof PgBackend) {
    await b.runAsync(sql,
      data.outcome_price, data.outcome_return_pct,
      data.pfe_price, data.pfe_return_pct,
      data.mae_price, data.mae_return_pct,
      data.pfe_candles, id
    );
  } else {
    b.run(sql,
      data.outcome_price, data.outcome_return_pct,
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

const METHODOLOGY: Record<string, unknown> = {
  WinRate: 'Percentage of signals where price moved in predicted direction after exactly 1 candle at the signal timeframe. wins / total_evaluated.',
  PfeWinRate: 'Percentage of signals where price moved in predicted direction at any point within the evaluation window. PFE Win Rate >= Win Rate always.',
  ProfitFactor: 'Sum of all positive 1-candle returns divided by absolute sum of all negative 1-candle returns. Above 1.0 = net profitable.',
  AvgPFE: 'Mean Peak Favorable Excursion — the best return achieved in the signal direction at any point within the evaluation window. Higher = signals reach better peaks before reverting.',
  AvgMAE: 'Mean Maximum Adverse Excursion — the worst drawdown against the signal direction within the evaluation window. Closer to 0 = tighter risk. Always negative for losing trades.',
  EvaluationWindows: {
    '5m': { candles: 12, total: '1 hour' },
    '15m': { candles: 12, total: '3 hours' },
    '30m': { candles: 8, total: '4 hours' },
    '1h': { candles: 8, total: '8 hours' },
    '2h': { candles: 6, total: '12 hours' },
    '4h': { candles: 6, total: '24 hours' },
    '8h': { candles: 4, total: '32 hours' },
    '12h': { candles: 4, total: '48 hours' },
    '1d': { candles: 3, total: '3 days' },
  },
  DataSource: 'Hyperliquid public API (candleSnapshot + metaAndAssetCtxs).',
  SignalFilter: 'Only signals with confidence >= 40% and non-HOLD verdict are recorded and evaluated.',
};

function emptyStats(): PerformanceStats {
  return {
    totalSignals: 0,
    period: { from: '', to: '' },
    overall: { winRate: null, pfeWinRate: null, profitFactor: null },
    bySignalType: {},
    byTimeframe: {},
    byAsset: {},
    recentSignals: [],
    methodology: METHODOLOGY,
  };
}

function computeStats(all: SignalRecord[]): PerformanceStats {
  if (all.length === 0) return emptyStats();

  const oldest = all[all.length - 1];
  const newest = all[0];

  const evaluated = all.filter(s => s.outcome_return_pct != null && s.signal !== 'HOLD');

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

  const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  // v1.4: PFE-based win rate
  const pfeEvaluated = all.filter(s => s.pfe_return_pct != null && s.signal !== 'HOLD');
  const pfeWins = pfeEvaluated.filter(s => (s.pfe_return_pct ?? 0) > 0);
  const pfeWinRate = pfeEvaluated.length > 0 ? pfeWins.length / pfeEvaluated.length : null;

  // By signal type
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

  // v1.4: By timeframe with PFE/MAE metrics
  const byTimeframe: PerformanceStats['byTimeframe'] = {};
  const allTimeframes = [...new Set(all.map(s => s.timeframe))];
  const TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];
  allTimeframes.sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));

  for (const tf of allTimeframes) {
    const tfSignals = all.filter(s => s.timeframe === tf && s.signal !== 'HOLD');
    const tfEval = tfSignals.filter(s => s.outcome_return_pct != null);
    const tfPfeEval = tfSignals.filter(s => s.pfe_return_pct != null);

    if (tfEval.length === 0) {
      byTimeframe[tf] = { count: tfSignals.length, winRate: null, pfeWinRate: null, avgReturnPct: null, avgPFE: null, avgMAE: null, profitFactor: null };
      continue;
    }

    const tfWins = tfEval.filter(isWin);
    const tfReturns = tfEval.map(pnlReturn);
    const tfPfeWins = tfPfeEval.filter(s => (s.pfe_return_pct ?? 0) > 0);

    const tfGrossProfit = tfReturns.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const tfGrossLoss = Math.abs(tfReturns.filter(r => r < 0).reduce((a, b) => a + b, 0));
    const tfProfitFactor = tfGrossLoss > 0 ? tfGrossProfit / tfGrossLoss : (tfGrossProfit > 0 ? Infinity : null);

    byTimeframe[tf] = {
      count: tfEval.length,
      winRate: tfWins.length / tfEval.length,
      pfeWinRate: tfPfeEval.length > 0 ? tfPfeWins.length / tfPfeEval.length : null,
      avgReturnPct: tfReturns.reduce((a, b) => a + b, 0) / tfReturns.length,
      avgPFE: tfPfeEval.length > 0 ? tfPfeEval.reduce((a, s) => a + (s.pfe_return_pct ?? 0), 0) / tfPfeEval.length : null,
      avgMAE: tfPfeEval.length > 0 ? tfPfeEval.reduce((a, s) => a + (s.mae_return_pct ?? 0), 0) / tfPfeEval.length : null,
      profitFactor: tfProfitFactor,
    };
  }

  // By asset
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
      pfeWinRate,
      profitFactor,
    },
    bySignalType,
    byTimeframe,
    byAsset,
    recentSignals: all.slice(0, 20),
    methodology: METHODOLOGY,
  };
}
