/**
 * regime-snapshots.ts — SCAN-MARKET-REGIMES-W1-V2 CH1
 *
 * The bar-close market-regime snapshot store and its run record.
 *
 *   regime_snapshots      one row per (venue, timeframe, closed bar, coin): the `get_market_regime`
 *                         classifier's own answer for that bar (market-regime-core.ts). Permanent
 *                         retention on every timeframe (V2 §0 Q2) — the per-bar history is the moat.
 *   regime_snapshot_runs  one row per (venue, timeframe) per sampler tick: what the producer did and
 *                         why. Every consumer judges the snapshot from THIS record, never from
 *                         schedule arithmetic (verification-gates LAW).
 *
 * The ONE definitions CH2 (scan_market_regimes) and CH3 (the freshness canary) consume — frozen
 * after CH1, consumers project from them and never re-derive:
 *   latestServableGeneration · readGenerationRows · latestRunDisposition · sampledRegimeVenues
 *   recentDueRuns · lastTickAt · MARKET_REGIME_RULE_VERSION (re-exported) · the row and run types.
 * CH3 adds `adoptExistingRegimeSnapshotTables` — the read-only stand-in for the lazy ensure, so the
 * freshness canary's `default_transaction_read_only` session never issues DDL.
 *
 * "Unserved" is DERIVED, never declared (V2 §0 Q1): a pair is unserved while its newest non-NOT_DUE
 * run is WINDOW_STALE. There is no hand-kept list, so a pair starts serving by itself the first
 * time the sampler can write it.
 *
 * Producer: src/scripts/regime-snapshot-sampler.ts (host cron :11, docker exec in the app container).
 * Schema: migrations/048_regime_snapshots.sql, SSH-preapplied, plus the lazy ensure below for a
 * fresh box. PG-targeted ($N placeholders — the production backend), the same dual-backend deferral
 * as oi-snapshots.ts: the SQL/param contract is mock-tested and verified live post-deploy.
 */

import { dbQuery } from './performance-db.js';
import { getActivePromotedVenueIds } from './venue-store.js';
import type { PromotedVenueId } from './capabilities.js';

export { MARKET_REGIME_RULE_VERSION } from './market-regime-core.js';

/** Every disposition a run row may carry — the CHECK constraint's closed set. */
export const REGIME_RUN_DISPOSITIONS = [
  'COMPLETE',
  'PARTIAL',
  'WINDOW_STALE',
  'NOT_DUE',
  'SKIPPED_BUDGET',
  'FAILED',
] as const;
export type RegimeRunDisposition = (typeof REGIME_RUN_DISPOSITIONS)[number];

/** The timeframes the sampler produces (mirrors `get_market_regime`'s own set). */
export const REGIME_SNAPSHOT_TIMEFRAMES = ['1h', '4h', '1d'] as const;
export type RegimeSnapshotTimeframe = (typeof REGIME_SNAPSHOT_TIMEFRAMES)[number];

/** Default sampled venues (V2 CH1 R3). The env may narrow, never widen past the active promoted set. */
export const DEFAULT_REGIME_SNAPSHOT_VENUES = 'BINANCE,BYBIT,OKX,BITGET';

/** Default coverage a PARTIAL generation needs before it is servable. */
export const DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE = 0.9;

export interface RegimeSnapshotRow {
  exchange: string;
  timeframe: string;
  /** Close of the bar this row classifies (epoch ms) — the generation key and the scan's `as_of`. */
  bar_close_ms: number;
  coin: string;
  regime: string;
  confidence: number;
  trend_strength: string;
  adx: number | null;
  adx_slope: number | null;
  volatility_ratio: number;
  price_structure: string;
  asset_class: string;
  /**
   * The session state AT COMPUTE TIME — history, never a live read (V2 §0 Q6). A consumer serving a
   * live `underlying_session` recomputes it from `asset_class` at serve time.
   */
  underlying_session_at_compute: string;
  /** Close of the first bar of the current regime run; NULL until a transition is observed. */
  regime_since_ms: number | null;
  rule_version: number;
  computed_at: number;
}

export interface RegimeSnapshotRunRecord {
  exchange: string;
  timeframe: string;
  /** The reference bar this tick judged; NULL only when the reference read itself failed. */
  bar_close_ms: number | null;
  /** The sampler run's start instant — identical for every pair in one run. */
  tick_at: number;
  disposition: RegimeRunDisposition;
  universe_n: number;
  /** Rows present for the generation after this tick (cumulative across retries), in-universe only. */
  written_n: number;
  too_new_n: number;
  window_stale_n: number;
  skipped_n: number;
  errors_n: number;
  finished_at: number;
}

export interface ServableGeneration {
  exchange: string;
  timeframe: string;
  bar_close_ms: number;
  disposition: 'COMPLETE' | 'PARTIAL';
  universe_n: number;
  written_n: number;
  too_new_n: number;
  window_stale_n: number;
  /** written / (universe − too_new), clamped to [0, 1]. */
  coverage: number;
  tick_at: number;
  finished_at: number;
}

const CREATE_SNAPSHOTS_SQL = `CREATE TABLE IF NOT EXISTS regime_snapshots (
  exchange                      TEXT             NOT NULL,
  timeframe                     TEXT             NOT NULL,
  bar_close_ms                  BIGINT           NOT NULL,
  coin                          TEXT             NOT NULL,
  regime                        TEXT             NOT NULL,
  confidence                    SMALLINT         NOT NULL,
  trend_strength                TEXT             NOT NULL,
  adx                           DOUBLE PRECISION,
  adx_slope                     DOUBLE PRECISION,
  volatility_ratio              DOUBLE PRECISION NOT NULL,
  price_structure               TEXT             NOT NULL,
  asset_class                   TEXT             NOT NULL,
  underlying_session_at_compute TEXT             NOT NULL,
  regime_since_ms               BIGINT,
  rule_version                  SMALLINT         NOT NULL,
  computed_at                   BIGINT           NOT NULL,
  PRIMARY KEY (exchange, timeframe, bar_close_ms, coin)
)`;

const CREATE_RUNS_SQL = `CREATE TABLE IF NOT EXISTS regime_snapshot_runs (
  exchange       TEXT    NOT NULL,
  timeframe      TEXT    NOT NULL,
  bar_close_ms   BIGINT,
  tick_at        BIGINT  NOT NULL,
  disposition    TEXT    NOT NULL CHECK (disposition IN ('COMPLETE','PARTIAL','WINDOW_STALE','NOT_DUE','SKIPPED_BUDGET','FAILED')),
  universe_n     INTEGER NOT NULL DEFAULT 0,
  written_n      INTEGER NOT NULL DEFAULT 0,
  too_new_n      INTEGER NOT NULL DEFAULT 0,
  window_stale_n INTEGER NOT NULL DEFAULT 0,
  skipped_n      INTEGER NOT NULL DEFAULT 0,
  errors_n       INTEGER NOT NULL DEFAULT 0,
  finished_at    BIGINT  NOT NULL,
  PRIMARY KEY (exchange, timeframe, tick_at)
)`;

// `latestServableGeneration` walks one pair's runs newest-bar-first; the PK is (…, tick_at) and
// cannot serve that order, so the bar order gets its own index.
const CREATE_RUNS_BAR_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_regime_snapshot_runs_pair_bar ON regime_snapshot_runs (exchange, timeframe, bar_close_ms, tick_at)`;

let _ensured = false;

/** Idempotent ensure of both tables + the index (matches migrations/048); once per process. */
export async function ensureRegimeSnapshotTables(): Promise<void> {
  if (_ensured) return;
  await dbQuery(CREATE_SNAPSHOTS_SQL);
  await dbQuery(CREATE_RUNS_SQL);
  await dbQuery(CREATE_RUNS_BAR_INDEX_SQL);
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure flag. */
export function _resetRegimeSnapshotsEnsure(): void {
  _ensured = false;
}

/**
 * READ-ONLY adoption of the existing schema (CH3 freshness canary). `CREATE … IF NOT EXISTS` is
 * refused inside a read-only transaction even when the table exists (SQLSTATE 25006), so a session
 * opened with `default_transaction_read_only=on` must never reach the lazy ensure. This probes
 * existence with `to_regclass` and, only when all three relations exist, marks the ensure done —
 * every reader below then skips its DDL. Issues no DDL and no write. False = the store is absent.
 */
export async function adoptExistingRegimeSnapshotTables(): Promise<boolean> {
  if (_ensured) return true;
  const rows = await dbQuery<{ s: boolean | null; r: boolean | null; i: boolean | null }>(
    `SELECT to_regclass('regime_snapshots') IS NOT NULL AS s, to_regclass('regime_snapshot_runs') IS NOT NULL AS r, to_regclass('idx_regime_snapshot_runs_pair_bar') IS NOT NULL AS i`,
  );
  const ok = rows[0]?.s === true && rows[0]?.r === true && rows[0]?.i === true;
  if (ok) _ensured = true;
  return ok;
}

/**
 * `REGIME_SNAPSHOT_MIN_COVERAGE`, default-deny parse: anything that is not a finite number in
 * (0, 1] is the default, never a looser value. A typo must not make a 10%-written generation
 * servable.
 */
export function regimeSnapshotMinCoverage(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGIME_SNAPSHOT_MIN_COVERAGE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_REGIME_SNAPSHOT_MIN_COVERAGE;
}

/** written / (universe − too_new), clamped to [0, 1]; 0 when nothing was writable. */
export function generationCoverage(r: Pick<RegimeSnapshotRunRecord, 'universe_n' | 'written_n' | 'too_new_n'>): number {
  const denom = r.universe_n - r.too_new_n;
  if (!(denom > 0)) return 0;
  return Math.max(0, Math.min(1, r.written_n / denom));
}

/** True when a run row describes a generation a consumer may serve. The ONE servability rule. */
export function isServableRun(
  r: Pick<RegimeSnapshotRunRecord, 'disposition' | 'universe_n' | 'written_n' | 'too_new_n'>,
  minCoverage: number = regimeSnapshotMinCoverage(),
): boolean {
  if (r.disposition === 'COMPLETE') return true;
  return r.disposition === 'PARTIAL' && generationCoverage(r) >= minCoverage;
}

/**
 * The sampled venues: `REGIME_SNAPSHOT_VENUES` (default BINANCE,BYBIT,OKX,BITGET) ∩ the ACTIVE
 * promoted set. Unknown or non-promoted tokens are dropped with ONE warning; order follows the env.
 */
export async function sampledRegimeVenues(
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<PromotedVenueId[]> {
  const raw = env.REGIME_SNAPSHOT_VENUES?.trim() ? env.REGIME_SNAPSHOT_VENUES : DEFAULT_REGIME_SNAPSHOT_VENUES;
  const active = new Set<string>(await getActivePromotedVenueIds(nowMs));
  const out: PromotedVenueId[] = [];
  const ignored: string[] = [];
  for (const tok of raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)) {
    if (active.has(tok)) {
      if (!out.includes(tok as PromotedVenueId)) out.push(tok as PromotedVenueId);
    } else {
      ignored.push(tok);
    }
  }
  if (ignored.length) {
    console.warn(`[regime-snapshots] REGIME_SNAPSHOT_VENUES: ignoring ${ignored.join(',')} (not an active promoted venue)`);
  }
  return out;
}

const SNAPSHOT_COLS = [
  'exchange', 'timeframe', 'bar_close_ms', 'coin', 'regime', 'confidence', 'trend_strength', 'adx',
  'adx_slope', 'volatility_ratio', 'price_structure', 'asset_class', 'underlying_session_at_compute',
  'regime_since_ms', 'rule_version', 'computed_at',
] as const satisfies readonly (keyof RegimeSnapshotRow)[];
const INSERT_CHUNK = 200; // 16 params/row → 3,200 per statement, far under PG's 65,535 cap

/**
 * Batch-insert snapshot rows, first-write-wins per (exchange, timeframe, bar_close_ms, coin) →
 * idempotent re-runs and retries. Returns rows attempted.
 */
export async function recordRegimeSnapshots(rows: RegimeSnapshotRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureRegimeSnapshotTables();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const tuples: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((r, j) => {
      const b = j * SNAPSHOT_COLS.length;
      tuples.push(`(${SNAPSHOT_COLS.map((_, k) => `$${b + k + 1}`).join(', ')})`);
      for (const c of SNAPSHOT_COLS) params.push(r[c]);
    });
    await dbQuery(
      `INSERT INTO regime_snapshots (${SNAPSHOT_COLS.join(', ')}) VALUES ${tuples.join(', ')} ` +
        `ON CONFLICT (exchange, timeframe, bar_close_ms, coin) DO NOTHING`,
      params,
    );
  }
  return rows.length;
}

const RUN_COLS = [
  'exchange', 'timeframe', 'bar_close_ms', 'tick_at', 'disposition', 'universe_n', 'written_n',
  'too_new_n', 'window_stale_n', 'skipped_n', 'errors_n', 'finished_at',
] as const satisfies readonly (keyof RegimeSnapshotRunRecord)[];

/** Append one run row. One per (exchange, timeframe, tick_at); a duplicate tick is a no-op. */
export async function recordRegimeSnapshotRun(run: RegimeSnapshotRunRecord): Promise<void> {
  if (!REGIME_RUN_DISPOSITIONS.includes(run.disposition)) {
    throw new Error(`recordRegimeSnapshotRun: unknown disposition '${run.disposition}'`);
  }
  await ensureRegimeSnapshotTables();
  await dbQuery(
    `INSERT INTO regime_snapshot_runs (${RUN_COLS.join(', ')}) ` +
      `VALUES (${RUN_COLS.map((_, k) => `$${k + 1}`).join(', ')}) ` +
      `ON CONFLICT (exchange, timeframe, tick_at) DO NOTHING`,
    RUN_COLS.map((c) => run[c]),
  );
}

// PG returns BIGINT columns as strings (the int8 trap) — every numeric read goes through num().
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

function toRunRecord(r: Record<string, unknown>): RegimeSnapshotRunRecord {
  return {
    exchange: String(r.exchange),
    timeframe: String(r.timeframe),
    bar_close_ms: numOrNull(r.bar_close_ms),
    tick_at: num(r.tick_at),
    disposition: String(r.disposition) as RegimeRunDisposition,
    universe_n: num(r.universe_n),
    written_n: num(r.written_n),
    too_new_n: num(r.too_new_n),
    window_stale_n: num(r.window_stale_n),
    skipped_n: num(r.skipped_n),
    errors_n: num(r.errors_n),
    finished_at: num(r.finished_at),
  };
}

function toSnapshotRow(r: Record<string, unknown>): RegimeSnapshotRow {
  return {
    exchange: String(r.exchange),
    timeframe: String(r.timeframe),
    bar_close_ms: num(r.bar_close_ms),
    coin: String(r.coin),
    regime: String(r.regime),
    confidence: num(r.confidence),
    trend_strength: String(r.trend_strength),
    adx: numOrNull(r.adx),
    adx_slope: numOrNull(r.adx_slope),
    volatility_ratio: num(r.volatility_ratio),
    price_structure: String(r.price_structure),
    asset_class: String(r.asset_class),
    underlying_session_at_compute: String(r.underlying_session_at_compute),
    regime_since_ms: numOrNull(r.regime_since_ms),
    rule_version: num(r.rule_version),
    computed_at: num(r.computed_at),
  };
}

const RUN_SELECT = `exchange, timeframe, bar_close_ms, tick_at, disposition, universe_n, written_n, too_new_n, window_stale_n, skipped_n, errors_n, finished_at`;

/**
 * The newest servable generation for a pair: the newest bar whose LATEST generation-carrying run
 * (COMPLETE or PARTIAL) is COMPLETE, or PARTIAL at ≥ `REGIME_SNAPSHOT_MIN_COVERAGE`. NULL when none.
 *
 * The coverage predicate runs in SQL so the plan is Limit → Filter → Unique → index scan: it stops at
 * the first servable bar instead of materialising a permanent table's history.
 */
export async function latestServableGeneration(
  exchange: string,
  timeframe: string,
  minCoverage: number = regimeSnapshotMinCoverage(),
): Promise<ServableGeneration | null> {
  await ensureRegimeSnapshotTables();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${RUN_SELECT} FROM (` +
      `SELECT DISTINCT ON (bar_close_ms) ${RUN_SELECT} FROM regime_snapshot_runs ` +
      `WHERE exchange = $1 AND timeframe = $2 AND bar_close_ms IS NOT NULL AND disposition IN ('COMPLETE','PARTIAL') ` +
      `ORDER BY bar_close_ms DESC, tick_at DESC` +
    `) latest ` +
    `WHERE disposition = 'COMPLETE' OR (universe_n - too_new_n > 0 AND written_n::float8 / (universe_n - too_new_n) >= $3) ` +
    `ORDER BY bar_close_ms DESC LIMIT 1`,
    [exchange, timeframe, minCoverage],
  );
  const r = rows[0];
  if (!r) return null;
  const run = toRunRecord(r);
  // Belt and braces: the SQL predicate and the ONE JS rule must agree on what is servable.
  if (!isServableRun(run, minCoverage)) return null;
  return {
    exchange: run.exchange,
    timeframe: run.timeframe,
    bar_close_ms: run.bar_close_ms as number,
    disposition: run.disposition as 'COMPLETE' | 'PARTIAL',
    universe_n: run.universe_n,
    written_n: run.written_n,
    too_new_n: run.too_new_n,
    window_stale_n: run.window_stale_n,
    coverage: generationCoverage(run),
    tick_at: run.tick_at,
    finished_at: run.finished_at,
  };
}

/** Every row of ONE generation, coin-ordered. Never mixes bars. */
export async function readGenerationRows(
  exchange: string,
  timeframe: string,
  barCloseMs: number,
): Promise<RegimeSnapshotRow[]> {
  await ensureRegimeSnapshotTables();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${SNAPSHOT_COLS.join(', ')} FROM regime_snapshots ` +
      `WHERE exchange = $1 AND timeframe = $2 AND bar_close_ms = $3 ORDER BY coin`,
    [exchange, timeframe, barCloseMs],
  );
  return rows.map(toSnapshotRow);
}

/**
 * The newest non-NOT_DUE run for a pair — what the producer last DID with a due bar. A pair is
 * unserved exactly while this is WINDOW_STALE. NULL when the pair has never had a due tick.
 */
export async function latestRunDisposition(
  exchange: string,
  timeframe: string,
): Promise<RegimeSnapshotRunRecord | null> {
  await ensureRegimeSnapshotTables();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${RUN_SELECT} FROM regime_snapshot_runs ` +
      `WHERE exchange = $1 AND timeframe = $2 AND disposition <> 'NOT_DUE' ORDER BY tick_at DESC LIMIT 1`,
    [exchange, timeframe],
  );
  return rows[0] ? toRunRecord(rows[0]) : null;
}

/** The newest run row for ONE bar of a pair — the sampler's due test. NULL when the bar is unseen. */
export async function latestRunForBar(
  exchange: string,
  timeframe: string,
  barCloseMs: number,
): Promise<RegimeSnapshotRunRecord | null> {
  await ensureRegimeSnapshotTables();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${RUN_SELECT} FROM regime_snapshot_runs ` +
      `WHERE exchange = $1 AND timeframe = $2 AND bar_close_ms = $3 AND disposition <> 'NOT_DUE' ` +
      `ORDER BY tick_at DESC LIMIT 1`,
    [exchange, timeframe, barCloseMs],
  );
  return rows[0] ? toRunRecord(rows[0]) : null;
}

/** The newest `limit` non-NOT_DUE runs for a pair, newest first (the canary's consecutive-failure read). */
export async function recentDueRuns(
  exchange: string,
  timeframe: string,
  limit: number,
): Promise<RegimeSnapshotRunRecord[]> {
  await ensureRegimeSnapshotTables();
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT ${RUN_SELECT} FROM regime_snapshot_runs ` +
      `WHERE exchange = $1 AND timeframe = $2 AND disposition <> 'NOT_DUE' ORDER BY tick_at DESC LIMIT ${n}`,
    [exchange, timeframe],
  );
  return rows.map(toRunRecord);
}

/**
 * The producer's newest tick for a venue (NOT_DUE included), or for one pair when `timeframe` is
 * given. NULL when none. Per pair so each read is a PK backward scan, never a venue-wide MAX.
 */
export async function lastTickAt(exchange: string, timeframe?: string): Promise<number | null> {
  await ensureRegimeSnapshotTables();
  const tfs: readonly string[] = timeframe ? [timeframe] : REGIME_SNAPSHOT_TIMEFRAMES;
  let newest: number | null = null;
  for (const tf of tfs) {
    const rows = await dbQuery<Record<string, unknown>>(
      `SELECT tick_at FROM regime_snapshot_runs WHERE exchange = $1 AND timeframe = $2 ORDER BY tick_at DESC LIMIT 1`,
      [exchange, tf],
    );
    const t = numOrNull(rows[0]?.tick_at);
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}
