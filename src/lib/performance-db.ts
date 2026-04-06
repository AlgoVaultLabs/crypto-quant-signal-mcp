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
    price_after_1h REAL,
    price_after_4h REAL,
    price_after_24h REAL,
    return_pct_1h REAL,
    return_pct_4h REAL,
    return_pct_24h REAL,
    created_at INTEGER NOT NULL
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
  return backend;
}

export function closeDb(): void {
  if (backend) {
    backend.close();
    backend = null;
  }
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

export function updateOutcome(
  id: number,
  field: 'price_after_1h' | 'price_after_4h' | 'price_after_24h',
  price: number,
  returnPctField: 'return_pct_1h' | 'return_pct_4h' | 'return_pct_24h',
  returnPct: number
): void {
  const b = getBackend();
  b.run(
    `UPDATE signals SET ${field} = ?, ${returnPctField} = ? WHERE id = ?`,
    price, returnPct, id
  );
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
    byAsset: {},
    recentSignals: [],
  };
}

function computeStats(all: SignalRecord[]): PerformanceStats {
  if (all.length === 0) return emptyStats();

  const oldest = all[all.length - 1];
  const newest = all[0];

  const evaluated = all.filter(s => s.return_pct_4h !== null && s.signal !== 'HOLD');
  const wins = evaluated.filter(s => {
    if (s.signal === 'BUY') return (s.return_pct_4h ?? 0) > 0;
    if (s.signal === 'SELL') return (s.return_pct_4h ?? 0) < 0;
    return false;
  });

  const returns = evaluated.map(s => {
    const r = s.return_pct_4h ?? 0;
    return s.signal === 'SELL' ? -r : r;
  });

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

  let peak = 0;
  let maxDD = 0;
  let cumReturn = 0;
  for (const r of returns) {
    cumReturn += r;
    if (cumReturn > peak) peak = cumReturn;
    const dd = peak - cumReturn;
    if (dd > maxDD) maxDD = dd;
  }

  const grossProfit = returns.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  const bySignalType: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }> = {};
  for (const type of ['BUY', 'SELL', 'HOLD'] as const) {
    const group = all.filter(s => s.signal === type);
    const evalGroup = group.filter(s => s.return_pct_4h !== null && type !== 'HOLD');
    const winsGroup = evalGroup.filter(s => {
      if (type === 'BUY') return (s.return_pct_4h ?? 0) > 0;
      if (type === 'SELL') return (s.return_pct_4h ?? 0) < 0;
      return false;
    });
    const returnsGroup = evalGroup.map(s => {
      const r = s.return_pct_4h ?? 0;
      return type === 'SELL' ? -r : r;
    });

    bySignalType[type] = {
      count: group.length,
      winRate: type === 'HOLD' ? null : (evalGroup.length > 0 ? winsGroup.length / evalGroup.length : null),
      avgReturnPct: type === 'HOLD' ? null : (returnsGroup.length > 0 ? returnsGroup.reduce((a, b) => a + b, 0) / returnsGroup.length : null),
    };
  }

  const coins = [...new Set(all.map(s => s.coin))];
  const byAsset: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }> = {};
  for (const coin of coins) {
    const group = all.filter(s => s.coin === coin);
    const evalGroup = group.filter(s => s.return_pct_4h !== null && s.signal !== 'HOLD');
    const winsGroup = evalGroup.filter(s => {
      if (s.signal === 'BUY') return (s.return_pct_4h ?? 0) > 0;
      if (s.signal === 'SELL') return (s.return_pct_4h ?? 0) < 0;
      return false;
    });
    const returnsGroup = evalGroup.map(s => {
      const r = s.return_pct_4h ?? 0;
      return s.signal === 'SELL' ? -r : r;
    });

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
      maxDrawdownPct: maxDD > 0 ? -maxDD : null,
      profitFactor,
    },
    bySignalType,
    byAsset,
    recentSignals: all.slice(0, 20),
  };
}
