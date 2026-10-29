/**
 * OPS-DIGEST-EVAL-COVERAGE-W1 — one row of every `pfeExclusionOf` class, plus the rows that must count nowhere.
 *
 * Shared by `digest-signal-performance.test.ts` (AC2: S, X, P equal the class counts) and
 * `perfstats-sql-aggregate.test.ts` (AC3: the real SQL groups equal `aggregateRowsInJs`). The classes come from the
 * REAL registry (`PFE_DEFECT_WINDOWS`): PHEMEX before the CH3a container start, ASTER 1m before the CH3a-R1 one.
 * Both tests derive their expectations through `pfeExclusionOf`, never from a hand-counted literal.
 */
import { CH3A_START, CH3A_R1_START } from '../../src/lib/pfe-scoring.js';
import { statGroupRowOf, type PeriodRow, type StatGroupRow } from '../../src/lib/performance-db.js';
import type { SignalRecord } from '../../src/types.js';

/** A UTC day boundary before CH3a: phase 0 of every step, so inside any `withinAfterBoundaryS` window. */
const BEFORE = Math.floor((CH3A_START - 86_400) / 86_400) * 86_400;
/** Two days after CH3a-R1: outside every registry window. */
const AFTER = Math.floor((CH3A_R1_START + 2 * 86_400) / 86_400) * 86_400;

let nextId = 1;
const row = (
  exchange: string | null, coin: string, timeframe: string, signal: 'BUY' | 'SELL' | 'HOLD',
  pfe: number | null, mae: number | null, created_at: number, confidence = 70,
): SignalRecord => ({
  id: nextId++, coin, signal, timeframe, confidence, price_at_signal: 100,
  price_after_15m: null, price_after_1h: null, price_after_4h: null, price_after_24h: null,
  return_pct_15m: null, return_pct_1h: null, return_pct_4h: null, return_pct_24h: null,
  pfe_return_pct: pfe, mae_return_pct: mae, created_at, exchange: exchange ?? undefined,
} as unknown as SignalRecord);

export const EVAL_COVERAGE_ROWS: readonly SignalRecord[] = Object.freeze([
  // eligible (scored)
  row('BINANCE', 'BTC', '5m', 'BUY', 1.2, -0.3, AFTER + 1),
  row('BINANCE', 'BTC', '5m', 'BUY', 0, -1.1, AFTER + 2),            // S1: a genuine loss stays scored
  row('BINANCE', 'ETH', '1h', 'SELL', -0.8, 0.4, AFTER + 3),
  row(null, 'SOL', '15m', 'BUY', 0.5, -0.2, AFTER + 4),              // NULL exchange is HL
  row('PHEMEX', 'BTC', '1h', 'BUY', 0.7, -0.2, AFTER + 5),           // the venue, after its window
  // frozen (S2)
  row('BINANCE', 'BTC', '5m', 'BUY', 0, 0, AFTER + 6),
  row('HL', 'SOL', '15m', 'SELL', 0, 0, AFTER + 7),
  row('PHEMEX', 'BTC', '1h', 'BUY', 0, 0, BEFORE + 1),               // frozen inside a window: frozen wins
  // defect_window (PFE_DEFECT_WINDOWS)
  row('PHEMEX', 'BTC', '1h', 'BUY', 0.9, -0.1, BEFORE + 2),
  row('PHEMEX', 'BTC', '1h', 'SELL', -0.3, 0.2, BEFORE + 3),
  row('ASTER', 'ETH', '1m', 'BUY', 0.4, -0.1, BEFORE + 4),
  // unevaluated
  row('BINANCE', 'BTC', '5m', 'BUY', null, null, AFTER + 8),
  row('HL', 'SOL', '15m', 'SELL', null, null, AFTER + 9),
  row('PHEMEX', 'BTC', '1h', 'BUY', null, null, BEFORE + 5),         // unevaluated inside a window: unevaluated wins
  // HOLD: never in T, E, S, X or P — including a HOLD that carries a result
  row('BINANCE', 'BTC', '5m', 'HOLD', null, null, AFTER + 10),
  row('BINANCE', 'BTC', '5m', 'HOLD', 0.5, -0.1, AFTER + 11),
  // below the published population (confidence < 52): in no count at all
  row('BINANCE', 'BTC', '5m', 'BUY', 2.0, -0.1, AFTER + 12, 40),
  row('BINANCE', 'BTC', '5m', 'BUY', null, null, AFTER + 13, 40),
]);

/**
 * Execute `groupsSql` + `periodSql` in a real SQL engine (better-sqlite3) over `rows`, mapping each group row with the
 * PRODUCTION mapping (`statGroupRowOf`). The period mapping is `aggregateSignalsSql`'s.
 */
export function runStatsSqlInSqlite(rows: readonly SignalRecord[], groupsSql: string, periodSql: string): { groups: StatGroupRow[]; period: PeriodRow } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE signals (id INTEGER PRIMARY KEY, coin TEXT, signal TEXT, timeframe TEXT, confidence REAL, created_at INTEGER, pfe_return_pct REAL, mae_return_pct REAL, exchange TEXT)');
    const ins = db.prepare('INSERT INTO signals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) {
      ins.run(r.id, r.coin, r.signal, r.timeframe, r.confidence, r.created_at, r.pfe_return_pct ?? null, r.mae_return_pct ?? null, r.exchange ?? null);
    }
    const groups = (db.prepare(groupsSql).all() as Record<string, unknown>[]).map(statGroupRowOf);
    const p = (db.prepare(periodSql).get() ?? {}) as Record<string, unknown>;
    return {
      groups,
      period: { min_created_at: Number(p.min_created_at) || 0, max_created_at: Number(p.max_created_at) || 0, total: Number(p.total) || 0 },
    };
  } finally {
    db.close();
  }
}
