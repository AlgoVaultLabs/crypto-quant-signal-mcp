/**
 * EQUITIES-ENGINE-W1 — postgres data-access for the equity_* tables.
 *
 * Prod connects via DATABASE_URL (the mcp-server container exposes only that —
 * NOT individual PG* vars, so a bare `new Pool()` would fail). All writes are
 * idempotent. No crypto tables are touched here (Data Integrity firewall).
 */
import type { Pool } from 'pg';
import type { EquityBar } from './equity-bars-provider.js';
import type { UniverseRow } from './equity-universe-rank.js';

/** Create a pool from DATABASE_URL (throws if unset — fail loud, never silent). */
export function makeEquityPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — equity scripts require a postgres connection string.');
  }
  // require() to match the project's CJS/Node16 pg usage (performance-db.ts).
  const { Pool: PgPool } = require('pg');
  return new PgPool({ connectionString });
}

/** Idempotent bulk upsert of daily bars. ON CONFLICT (symbol, session_date) DO NOTHING. */
export async function upsertBars(pool: Pool, bars: EquityBar[], chunkSize = 1000): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < bars.length; i += chunkSize) {
    const chunk = bars.slice(i, i + chunkSize);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((b, j) => {
      const o = j * 7;
      values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`);
      params.push(b.symbol, b.session_date, b.open, b.high, b.low, b.close, b.volume);
    });
    const sql =
      `INSERT INTO equity_bars_daily (symbol, session_date, open, high, low, close, volume) ` +
      `VALUES ${values.join(',')} ON CONFLICT (symbol, session_date) DO NOTHING`;
    const res = await pool.query(sql, params);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Freeze the universe: upsert each row active=true. Symbols absent from `rows`
 * are deactivated (active=false) so a re-freeze is a clean replace.
 */
export async function freezeUniverse(pool: Pool, rows: UniverseRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const symbols = rows.map((r) => r.symbol);
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, j) => {
    const o = j * 4;
    values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},true,now())`);
    params.push(r.symbol, r.rank_adv, r.adv_usd, r.is_etf);
  });
  const sql =
    `INSERT INTO equity_universe (symbol, rank_adv, adv_usd, is_etf, active, frozen_at) ` +
    `VALUES ${values.join(',')} ` +
    `ON CONFLICT (symbol) DO UPDATE SET ` +
    `rank_adv=EXCLUDED.rank_adv, adv_usd=EXCLUDED.adv_usd, is_etf=EXCLUDED.is_etf, ` +
    `active=true, frozen_at=now()`;
  await pool.query(sql, params);
  // Deactivate anything not in the new set.
  await pool.query(
    `UPDATE equity_universe SET active=false WHERE symbol <> ALL($1::text[]) AND active=true`,
    [symbols]
  );
  const res = await pool.query(`SELECT count(*)::int AS c FROM equity_universe WHERE active`);
  return res.rows[0].c as number;
}

export interface UniverseEntry { symbol: string; rank_adv: number | null; is_etf: boolean; }

/** Active universe symbols (ordered: ETFs + by ADV rank). */
export async function getActiveUniverse(pool: Pool): Promise<UniverseEntry[]> {
  const res = await pool.query(
    `SELECT symbol, rank_adv, is_etf FROM equity_universe WHERE active ORDER BY rank_adv NULLS LAST, symbol`
  );
  return res.rows as UniverseEntry[];
}

export async function countBars(pool: Pool): Promise<number> {
  const res = await pool.query(`SELECT count(*)::bigint AS c FROM equity_bars_daily`);
  return Number(res.rows[0].c);
}

export async function countActiveUniverse(pool: Pool): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS c FROM equity_universe WHERE active`);
  return res.rows[0].c as number;
}

/** Max session_date already stored for a symbol (for resumable backfill). */
export async function maxStoredSession(pool: Pool, symbol: string): Promise<string | null> {
  const res = await pool.query(
    `SELECT max(session_date)::text AS d FROM equity_bars_daily WHERE symbol=$1`,
    [symbol]
  );
  return res.rows[0].d ?? null;
}
