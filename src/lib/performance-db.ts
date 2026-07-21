/**
 * Performance DB — dual backend: PostgreSQL (remote) or SQLite (local).
 * If DATABASE_URL env exists → PostgreSQL, else → SQLite at ~/.crypto-quant-signal/performance.db
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { SignalRecord, SignalVerdict, PerformanceStats } from '../types.js';
import { classifyAsset, TIER_DEFINITIONS, getTop20ByOI } from './asset-tiers.js';
import { isShortLivedScript } from './runtime.js';
import { isPfeEligible, SQL_PFE_ELIGIBLE } from './pfe-scoring.js';

/**
 * Resolve the local SQLite DB location AT CONNECT TIME (not once at module
 * load). Resolving here — rather than in a module-level const — is what lets a
 * redirected $HOME or an explicit override take effect even though every caller
 * imports this module statically.
 *
 * Default (production + normal runtime): the operator's persistent
 * `~/.crypto-quant-signal/performance.db`, honoring $HOME. That is how
 * tests/performance-db-migration.test.ts + tests/agent-sessions.test.ts isolate
 * (set HOME to a mkdtemp dir, then open) — behavior is unchanged for them.
 *
 * `PERFORMANCE_DB_PATH` override wins when set. A single vitest test FILE can
 * point the backend at its OWN temp DB so its WHOLE-TABLE COUNT assertions
 * (e.g. a pre/post delta on getUsageStats().totalCalls.allTime) can't be
 * perturbed by another test file's concurrent request_log INSERT — vitest runs
 * test files in parallel, and several of them write request_log. The env is
 * NEVER set in production (DATABASE_URL selects Postgres there anyway), so prod
 * behavior is byte-identical. Used by tests/analytics-external-only.test.ts; see
 * skills shared-sqlite-test-sentinel-prefix-collision +
 * sqlite-fresh-db-wal-first-open-race-in-parallel-tests.
 */
function resolveSqliteDbPath(): string {
  return process.env.PERFORMANCE_DB_PATH || path.join(os.homedir(), '.crypto-quant-signal', 'performance.db');
}

// ── DB Backend Interface ──

interface DbBackend {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  all(sql: string, ...params: unknown[]): SignalRecord[];
  close(): void;
  /**
   * OPS-SCRIPT-EXIT-LIFECYCLE-W1: awaitable close. Resolves only once in-flight
   * writes have drained AND the underlying handle/pool is released, so a
   * short-lived script can `await` it before `process.exit` without losing a
   * write. Optional — a synchronous backend may omit it and `close()` is used.
   */
  closeAsync?(): Promise<void>;
}

// ── SQLite Backend ──

class SqliteBackend implements DbBackend {
  private db: import('better-sqlite3').Database;

  constructor() {
    // Dynamic import resolved at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const dbPath = resolveSqliteDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
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

/**
 * OPS-SCRIPT-POOL-MAX-W1: short-lived cron processes (`dist/scripts/*` — seed,
 * backfill, monitor) run many at once; a 12-conn pool each blew past Postgres
 * max_connections (observed 101/100, 95 idle). They do sequential work, so they
 * get a small per-process connection budget; the long-lived server keeps the
 * bigger one. Pure (argv passed in) so it is unit-testable.
 */
// OPS-HL-CACHE-STAMPEDE-GENERATOR-W1 C3: moved to ./runtime.js (dependency-free) so
// asset-tiers can import it without a cycle; re-exported here for back-compat
// (cross-asset-grid imports `isShortLivedScript` from performance-db).
export { isShortLivedScript };

const DEFAULT_POOL_MAX = isShortLivedScript(process.argv[1]) ? 2 : 12;

/**
 * OPS-POSTGRES-MEM-RIGHTSIZE-W1 — hardened, env-tunable pg Pool config.
 *
 * `new Pool({ connectionString })` inherited the pg defaults, which left the
 * pool exposed during the 2026-06-04 OOM incident: no TCP keepAlive (idle
 * connections dropped by the server/NAT surface as "Connection terminated
 * unexpectedly"), no statement_timeout (a query stuck against a recovering
 * DB pins its connection and feeds the reconnect storm), and an implicit
 * bound an operator couldn't tune. Pure + env-injectable so it is unit-
 * testable without opening a real connection. All overrides default-deny:
 * a non-finite / non-positive env value falls back to the safe default.
 */
export function buildPoolConfig(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultMax: number = DEFAULT_POOL_MAX,
): import('pg').PoolConfig {
  const posInt = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    connectionString,
    max: posInt(env.PG_POOL_MAX, defaultMax),
    connectionTimeoutMillis: posInt(env.PG_CONNECTION_TIMEOUT_MS, 10_000),
    idleTimeoutMillis: posInt(env.PG_IDLE_TIMEOUT_MS, 30_000),
    statement_timeout: posInt(env.PG_STATEMENT_TIMEOUT_MS, 120_000),
    query_timeout: posInt(env.PG_QUERY_TIMEOUT_MS, 120_000),
    keepAlive: true,
    // NB: allowExitOnIdle is deliberately NOT set. With it true, a short-lived
    // seed/backfill process exits as soon as the pool is idle — aborting
    // in-flight fire-and-forget INSERTs before they commit (it silently dropped
    // ~90% of seed signals while it was live, 8504fd8→c656253). Leaving it unset
    // (the pg default, false) lets the pool keep the process alive until the
    // writes drain + close()/pool.end() runs.
  };
}

// ── OPS-SIGNAL-WRITE-RESILIENCE-W1 — resilient + loud fire-and-forget writes ──

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
  } catch {
    return String(v);
  }
}

const TRANSIENT_DB_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const TRANSIENT_DB_PATTERN =
  /EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo|connection terminated|connection timeout|timeout expired|timeout exceeded when trying to connect|too many clients|server closed the connection|terminating connection|the database system is (starting up|in recovery|shutting down)/i;

/**
 * Is this DB error worth retrying? DNS hiccups (musl `getaddrinfo EAI_AGAIN
 * postgres` under concurrent seed load / ENOTFOUND), connection drops &
 * timeouts, and transient pool/PG overload are retryable; deterministic query
 * errors (syntax, constraint violation) are NOT — retrying just fails again.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_DB_CODES.has(code)) return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && TRANSIENT_DB_PATTERN.test(msg);
}

/**
 * Generic bounded retry with injectable sleep (for deterministic tests).
 * Resolves with a discriminated result instead of throwing, so fire-and-forget
 * callers can log loudly on exhaustion without producing an unhandled rejection.
 * `attempts` in the result is the actual number of tries made.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: {
    attempts?: number;
    backoffMs?: number[];
    isRetryable?: (e: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number }> {
  const maxAttempts = opts.attempts ?? 4;
  const backoff = opts.backoffMs ?? [250, 750, 2_000];
  const isRetryable = opts.isRetryable ?? (() => true);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  let tries = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    tries = i;
    try {
      const value = await fn();
      return { ok: true, value, attempts: i };
    } catch (e) {
      lastError = e;
      if (i < maxAttempts && isRetryable(e)) {
        await sleep(backoff[i - 1] ?? backoff[backoff.length - 1] ?? 1_000);
        continue;
      }
      break;
    }
  }
  return { ok: false, error: lastError, attempts: tries };
}

class PgBackend implements DbBackend {
  private pool: import('pg').Pool;
  // In-flight (possibly retrying) fire-and-forget writes. close() drains these
  // before ending the pool so a short-lived seed/backfill process can't exit
  // mid-retry and lose the write.
  private pending = new Set<Promise<void>>();

  constructor(connectionString: string) {
    // Dynamic import resolved at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg');
    this.pool = new Pool(buildPoolConfig(connectionString));
    // Without an 'error' listener an idle-client error (server restart, network
    // blip) is re-thrown as an uncaught exception and can crash the process.
    // Log + swallow — the pool transparently replaces the dead client on the
    // next checkout.
    this.pool.on('error', (err: Error) => {
      console.error('[pg-pool] idle client error (recovering):', err.message);
    });
  }

  exec(sql: string): void {
    // Fire and forget — init schema. Resilient + loud (see trackedWrite).
    this.trackedWrite('exec', () => this.pool.query(sql), sql, []);
  }

  run(sql: string, ...params: unknown[]): void {
    // Convert ? placeholders to $1, $2, etc. for pg
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    this.trackedWrite('run', () => this.pool.query(pgSql, params), pgSql, params);
  }

  /**
   * Fire-and-forget write that (1) RETRIES transient failures — the musl
   * `getaddrinfo EAI_AGAIN postgres` bursts that were silently dropping signals,
   * plus connection drops/timeouts — and (2) on final failure logs LOUDLY with
   * the full SQL + params, so a lost write is recoverable from logs and NEVER
   * silent. Tracked in `pending` so close() drains it before ending the pool.
   */
  private trackedWrite(label: string, exec: () => Promise<unknown>, sql: string, params: unknown[]): void {
    const p = retryAsync(exec, { isRetryable: isTransientDbError })
      .then((r) => {
        if (!r.ok) {
          console.error(
            `[pg-write] WRITE LOST after ${r.attempts} attempt(s) [${label}]: ` +
            `${(r.error as Error)?.message ?? String(r.error)} :: SQL=${sql} PARAMS=${safeJson(params)}`,
          );
        } else if (r.attempts > 1) {
          console.error(`[pg-write] ${label} recovered after ${r.attempts} attempt(s)`);
        }
      })
      .finally(() => { this.pending.delete(p); });
    this.pending.add(p);
  }

  all(sql: string, ...params: unknown[]): SignalRecord[] {
    // Synchronous-style not possible with pg, so we cache results
    // This is called from sync getPerformanceStats — we use a sync workaround
    // by pre-fetching. See getPerformanceStatsAsync below.
    return [];
  }

  close(): void {
    // Fire-and-forget shape kept BYTE-COMPATIBLE for existing callers: drain
    // in-flight (possibly retrying) writes before ending the pool, so a
    // short-lived seed/backfill process can't exit mid-write and lose the signal.
    void this.closeAsync();
  }

  /**
   * OPS-SCRIPT-EXIT-LIFECYCLE-W1: the awaitable form of `close()`.
   *
   * `close()` cannot be awaited, so `closeDb(); process.exit(0)` would kill the
   * process mid-drain and silently drop the very INSERTs `pending` exists to
   * protect — the same ~90% seed-signal loss that made `allowExitOnIdle` unsafe
   * (see buildPoolConfig). Scripts MUST `await` this (via runScript) before exit.
   */
  async closeAsync(): Promise<void> {
    await Promise.allSettled([...this.pending]);
    await this.pool.end().catch(() => {});
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
  // FUNNEL-FIX-ATTRIBUTION-W1: first-touch (write-once) + last-touch acquisition source.
  { table: 'agent_sessions', column: 'first_touch_source', type: 'TEXT' },
  { table: 'agent_sessions', column: 'last_touch_source', type: 'TEXT' },
  // R5 (2026-04-14): regime label for audit round H5
  { table: 'signals', column: 'regime', type: 'TEXT NULL' },
  // Merkle proof columns
  { table: 'signals', column: 'signal_hash', type: 'VARCHAR(66)' },
  { table: 'signals', column: 'merkle_batch_id', type: 'INTEGER' },
  { table: 'signals', column: 'merkle_proof', type: 'JSONB' },
];

/**
 * OPS-HOUSEKEEPING-W1 Phase B (2026-05-01): symmetric migration-idempotency
 * across both backends. SQLite path (introspect once via PRAGMA, skip
 * already-present columns) was already in place; the Postgres path was
 * running unconditional `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` per
 * migration on every container start. POSTGRES-MAINT-W1's pg_stat_statements
 * top-10 surfaced 13 ALTER TABLE migrations × 34 calls each = ~400 round-
 * trips of postgres work that's no-op on existing schema. This version
 * does the same `information_schema.columns` pre-check on Postgres that
 * SQLite already does via `PRAGMA table_info()`.
 *
 * The Postgres path is fire-and-forget (matches the existing fire-and-forget
 * `b.exec()` shape for PgBackend): runMigrations stays synchronous; the
 * actual introspect-then-ALTER work runs in the background. First
 * invocations of the migrated columns might race with the migrations on a
 * fresh DB — but that's the existing behavior pre-W1, not new risk.
 */
function runMigrations(b: DbBackend, pg: boolean): void {
  if (pg) {
    runPgMigrationsAsync(b as PgBackend).catch((err: unknown) =>
      console.error('PG migration error:', err instanceof Error ? err.message : err)
    );
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

/**
 * Postgres-side migration runner with `information_schema.columns` pre-check.
 * Skips columns that already exist; only fires ALTER for missing ones.
 * Returns count of ALTERs actually executed (useful for tests + observability).
 */
export async function runPgMigrationsAsync(b: PgBackend): Promise<number> {
  const tables = new Set(SIGNAL_MIGRATIONS.map(m => m.table));
  const existingByTable = new Map<string, Set<string>>();
  for (const t of tables) {
    const rows = await b.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [t]
    ) as unknown as { column_name: string }[];
    existingByTable.set(t, new Set(rows.map(r => r.column_name)));
  }
  let alterCount = 0;
  for (const m of SIGNAL_MIGRATIONS) {
    const present = existingByTable.get(m.table);
    if (present && present.has(m.column)) continue;
    // Keep `IF NOT EXISTS` defense-in-depth against parallel-startup races;
    // pre-check eliminates the ~200-300ms-per-call cost when no-op.
    await b.execAsync(`ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${m.type}`);
    console.log(`[migration] PG added column ${m.table}.${m.column} ${m.type}`);
    alterCount += 1;
  }
  return alterCount;
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

// OPS-PFE-METRIC-INTEGRITY-W1 R3: emit_suppressions — the ONLY record of a call the
// book-liveness gate stopped us emitting.
//
// Shaped after hold_counts (daily aggregate, UPSERT-increment) rather than rate_limit_events
// (row-per-event): suppressions are a subset of the ~660k/day evaluation firehose, not a rare
// event. It carries `exchange`, which hold_counts does NOT — freeze is venue-specific (ASTER
// 5.93% of evaluated rows vs 0.000% on BINANCE/BYBIT/OKX/KUCOIN/MEXC), so a counter without a
// venue column could not answer the question it exists to answer.
const CREATE_EMIT_SUPPRESSIONS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS emit_suppressions (
      date DATE NOT NULL,
      exchange VARCHAR(20) NOT NULL,
      timeframe VARCHAR(10) NOT NULL,
      coin VARCHAR(20) NOT NULL,
      reason VARCHAR(32) NOT NULL,
      suppress_count INTEGER DEFAULT 0,
      PRIMARY KEY (date, exchange, timeframe, coin, reason)
    );`
  : `CREATE TABLE IF NOT EXISTS emit_suppressions (
      date TEXT NOT NULL,
      exchange TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      coin TEXT NOT NULL,
      reason TEXT NOT NULL,
      suppress_count INTEGER DEFAULT 0,
      PRIMARY KEY (date, exchange, timeframe, coin, reason)
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
    ip_hash_first  TEXT,
    first_touch_source TEXT,
    last_touch_source  TEXT
  );
`;

const CREATE_AGENT_SESSIONS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_seen ON agent_sessions(last_seen);
`;

/**
 * OPS-POSTGRES-RECAUDIT-W1 (2026-05-22): composite index on `signals` matching
 * the WHERE-clause cardinality of `hasRecentSignalAsync()` at L1030 below
 * (idempotency check for seed-signals; called once per signal write at
 * `src/scripts/seed-signals.ts:478`).
 *
 * Root-cause analysis (audits/OPS-POSTGRES-RECAUDIT-W1-endpoint-truth.md):
 * the `signals` table was historically created with ONLY `signals_pkey` on
 * `(id)`. The idempotency query filters on 4 columns NONE of which are `id`,
 * forcing a parallel sequential scan on the entire 105K-row × 117 MB table on
 * every call. pg_stat_statements showed 7,027,454 calls × 38.07ms mean =
 * 267,559 sec (74 hours) cumulative CPU over the 21-day measurement window
 * — 22% of total postgres CPU, the dominant baseline contributor in the
 * 1% → 33% baseline drift (2026-04-30 → 2026-05-22).
 *
 * Live EXPLAIN ANALYZE post-index: `Index Scan using idx_signals_idempotency`,
 * 0.072ms execution (vs 55.855ms pre-index) — 776× speedup.
 *
 * Index column order matches the query's WHERE-clause cardinality:
 *   - `coin` (highest cardinality of the 4 — ~740 values)
 *   - `timeframe` (11 values)
 *   - `exchange` (17 values; mostly 5 promoted)
 *   - `created_at DESC` (time-axis range — DESC matches `created_at >= $4 LIMIT 1`
 *     semantics — postgres can stop after first matching row in descending order)
 *
 * On fresh deployments / test fixtures, `CREATE INDEX IF NOT EXISTS` is
 * non-blocking on an empty table. On the live production DB, the index was
 * created via `CREATE INDEX CONCURRENTLY` (non-blocking) before this commit;
 * `IF NOT EXISTS` makes this schema-setup idempotent against the live DB.
 */
const CREATE_SIGNALS_IDEMPOTENCY_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_signals_idempotency ON signals (coin, timeframe, exchange, created_at DESC);
`;

/**
 * OPS-FUNDING-STATS-CACHE-W1 (2026-05-23): cross-process materialized view for
 * the funding-stats GROUP BY aggregate. Closes the GREEN_WITH_CAVEAT loop from
 * OPS-POSTGRES-RECAUDIT-W1 by eliminating the residual postgres-CPU spikes
 * attributed to the funding-stats GROUP BY query (top-2 in pg_stat_statements
 * at 92,467 calls × 1188ms = 30.5h cumulative over 21d = 9% of postgres CPU).
 *
 * Root cause (audits/OPS-FUNDING-STATS-CACHE-W1-endpoint-truth.md):
 * `bulkWarmFundingCache` IS already batched + uses `idx_funding_coin_time`
 * (Bitmap Index Scan, 98ms cold-cache). The 9% postgres-CPU residual is
 * cross-process cold-start cost — every cron-spawned `docker exec node ...`
 * process starts with an empty `fundingStatsCache` Map + fires the bulk-warm
 * query immediately. 200 cron fires/hour × 1 bulk-warm/fire = 92K calls/21d.
 * The in-process cache (OPTIMIZE-FUNDING-CACHE-CRON-W1, 2026-05-01) was
 * designed for within-fire reuse and never addressed the cross-fire boundary.
 *
 * Fix (Path R4, architect-ratified): a materialized view aggregates the 14-day
 * funding-stats once per refresh cycle (5-min cadence via host cron); readers
 * query the view first (sub-ms PK lookup); cache-miss for coins not in the
 * view (new listings within 14d window) falls back to the original GROUP BY
 * — fail-open behavior preserves correctness if the refresh stalls.
 *
 * Refresh schedule + monitoring lives outside this module: Hetzner crontab
 * `* /5 * * * * docker exec ... psql -c "REFRESH MATERIALIZED VIEW
 * CONCURRENTLY funding_stats_14d"` (REFRESH CONCURRENTLY requires the unique
 * index below). Initial populate happens automatically on first
 * `CREATE MATERIALIZED VIEW` (postgres default is WITH DATA).
 *
 * SQLite path: matview is PG-only; the reader retains the existing GROUP BY
 * (in JS aggregation) path for SQLite. Math is byte-equivalent (same
 * STDDEV_SAMP semantics).
 *
 * Schema-as-code: `IF NOT EXISTS` makes this idempotent against the live PG
 * where the matview was created via SSH before this commit landed. Fresh
 * deploys + test fixtures inherit the matview automatically.
 */
const CREATE_FUNDING_STATS_MATVIEW_SQL = `
  CREATE MATERIALIZED VIEW IF NOT EXISTS funding_stats_14d AS
  SELECT coin,
         AVG(funding_rate)::float8 AS mean,
         STDDEV_SAMP(funding_rate)::float8 AS stddev,
         COUNT(*)::int AS sample_count
    FROM funding_history
   WHERE recorded_at >= (EXTRACT(EPOCH FROM NOW() - INTERVAL '14 days'))::int
   GROUP BY coin;
`;

const CREATE_FUNDING_STATS_MATVIEW_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS funding_stats_14d_coin_uk ON funding_stats_14d (coin);
`;

// POWER-USER-OUTREACH-W1-V2 (2026-05-28): NEW signup_emails table for free-tier
// email opt-in capture on the /welcome paywall CTA. The v1 wave HALTed at
// Plan-Mode Step 0 with 10 fictional spec primitives; v2 pre-resolves all 10
// in the spec body. This table is the new authoritative store for free-tier
// opt-in emails — Stripe Customer object remains the SoT for PAID-tier emails.
// Dual-backend: PG ships in prod; SQLite branch keeps local-dev + test fixtures
// aligned per CLAUDE.md `Dual-backend PG-only SQL fails local SQLite` rule.
const CREATE_SIGNUP_EMAILS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS signup_emails (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      optin_consent BOOLEAN NOT NULL DEFAULT TRUE,
      optin_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmation_sent_at TIMESTAMPTZ NULL,
      unsubscribed_at TIMESTAMPTZ NULL
    );`
  : `CREATE TABLE IF NOT EXISTS signup_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      optin_consent INTEGER NOT NULL DEFAULT 1,
      optin_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmation_sent_at TEXT NULL,
      unsubscribed_at TEXT NULL
    );`;

const CREATE_SIGNUP_EMAILS_OPTIN_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_signup_emails_optin_at ON signup_emails (optin_at);
`;

const CREATE_SIGNUP_EMAILS_SOURCE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_signup_emails_source ON signup_emails (source);
`;

// POWER-USER-OUTREACH-W1-V2: idempotency sibling for signup_emails, mirroring
// the `processed_stripe_events` pattern from src/lib/stripe-events-store.ts.
// Caller (POST /api/signup-email) computes event_id as
// `signup-email:<sha256(email)>:<NOW>`; INSERT ON CONFLICT DO NOTHING ensures
// at-most-once confirmation-email send even on caller retries.
const CREATE_PROCESSED_SIGNUP_EMAIL_EVENTS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS processed_signup_email_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`
  : `CREATE TABLE IF NOT EXISTS processed_signup_email_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`;

const CREATE_PROCESSED_SIGNUP_EMAIL_EVENTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_pse_email_processed_at ON processed_signup_email_events (processed_at);
`;

/**
 * ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): narrow funnel-events table for the 7
 * NEW activation-funnel stages that don't already live in canonical sources
 * (request_log / processed_stripe_events / agent_sessions / bot SQLite). Stages
 * 4-7 (quota soft/hard/block + upgrade_cta_clicked) emit from MCP-side hooks
 * (tier-warning.ts + license.ts + /signup handler). Bot-side stages (11, 13, 14)
 * stay in `/var/log/algovault-bot/alerts.log` per Q-C Option α — snapshot
 * reader greps alerts.log JSON lines + this table is the SoT for MCP-side
 * funnel events only.
 *
 * Schema rationale: narrow (7 cols) + tightly indexed (ts + event_type +
 * session_id partial) keeps the table fast even at 100K+ rows; mixing into
 * request_log (currently 19K+ rows) would hurt query latency for the dominant
 * analytics path. meta_json is TEXT (portable across PG and SQLite); JSON
 * parsing happens at read time in the snapshot reader.
 */
const CREATE_FUNNEL_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS funnel_events (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    event_type TEXT NOT NULL,
    ts ${process.env.DATABASE_URL ? 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' : 'TEXT NOT NULL DEFAULT (datetime(\'now\'))'},
    session_id TEXT,
    chat_id ${process.env.DATABASE_URL ? 'BIGINT' : 'INTEGER'},
    license_tier TEXT,
    meta_json TEXT
  );
`;

const CREATE_FUNNEL_EVENTS_TS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_funnel_events_ts ON funnel_events (ts);
`;

const CREATE_FUNNEL_EVENTS_TYPE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_funnel_events_event_type ON funnel_events (event_type);
`;

const CREATE_FUNNEL_EVENTS_SESSION_INDEX_SQL = process.env.DATABASE_URL
  ? `CREATE INDEX IF NOT EXISTS idx_funnel_events_session_id ON funnel_events (session_id) WHERE session_id IS NOT NULL;`
  : `CREATE INDEX IF NOT EXISTS idx_funnel_events_session_id ON funnel_events (session_id);`;

// CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): hosted outbound webhook delivery
// service. Two tables under the SIGNAL DB (`signal_performance` on prod PG;
// SQLite locally). CRUD + idempotency helpers live in src/lib/webhooks-store.ts;
// detection in webhook-events.ts; HMAC sign + retry in webhook-delivery.ts.
// Storage notes:
//   - events/assets/timeframes are stored as JSON TEXT on BOTH backends (not
//     PG TEXT[]). Fan-out filtering happens in JS over active subscriptions, so
//     native-array querying isn't needed; JSON TEXT keeps the dual-backend path
//     identical and side-steps PG array-literal param edge cases (CLAUDE.md
//     "Dual-backend PG-only SQL fails SQLite").
//   - webhook_deliveries.event_data is a JSON snapshot of the ALLOW-LISTED event
//     captured at enqueue time, so the delivery worker is fully stateless — it
//     never reads `signals` (no forbidden-key leakage risk) and there is no
//     enqueue→deliver lookup race.
//   - owner_key is the quota tracker key (paid = license.key, free =
//     `free:<ipHash@registration>`), so each delivery draws down the OWNER's
//     monthly call quota via the existing license meter even though the worker
//     runs with no request context.
//   - On live PG these tables are pre-applied via SSH before the code commit
//     lands (CLAUDE.md "pre-apply schema via SSH then deploy code with
//     IF NOT EXISTS idempotency"); `IF NOT EXISTS` makes this a no-op there.
const CREATE_WEBHOOK_SUBSCRIPTIONS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      assets TEXT NULL,
      timeframes TEXT NULL,
      min_confidence INTEGER NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      owner_key TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_delivered_at BIGINT NULL,
      cadence TEXT NULL,
      timeframe TEXT NULL,
      exchange TEXT NULL,
      top_n INTEGER NULL
    );`
  : `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      assets TEXT NULL,
      timeframes TEXT NULL,
      min_confidence INTEGER NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      owner_key TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_delivered_at INTEGER NULL,
      cadence TEXT NULL,
      timeframe TEXT NULL,
      exchange TEXT NULL,
      top_n INTEGER NULL
    );`;

const CREATE_WEBHOOK_SUBSCRIPTIONS_ACTIVE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_active ON webhook_subscriptions (active);
`;

const CREATE_WEBHOOK_SUBSCRIPTIONS_OWNER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_owner_key ON webhook_subscriptions (owner_key);
`;

const CREATE_WEBHOOK_DELIVERIES_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id BIGSERIAL PRIMARY KEY,
      subscription_id BIGINT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at BIGINT NULL,
      response_code INTEGER NULL,
      created_at BIGINT NOT NULL,
      UNIQUE (subscription_id, event_id)
    );`
  : `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER NULL,
      response_code INTEGER NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (subscription_id, event_id)
    );`;

const CREATE_WEBHOOK_DELIVERIES_STATUS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries (status, created_at);
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
  // OPS-PFE-METRIC-INTEGRITY-W1 R3. Idempotent via IF NOT EXISTS; on live PG the table is
  // pre-applied via SSH BEFORE this commit lands, so the deploy is a no-op against a prepared
  // DB (CLAUDE.md: pre-apply schema, then ship schema-as-code).
  backend.exec(CREATE_EMIT_SUPPRESSIONS_SQL);
  backend.exec(CREATE_MERKLE_BATCHES_SQL);
  backend.exec(CREATE_AGENT_SESSIONS_SQL);
  backend.exec(CREATE_AGENT_SESSIONS_INDEX_SQL);
  // POWER-USER-OUTREACH-W1-V2 (2026-05-28): signup_emails + idempotency sibling
  // for free-tier email opt-in capture (POST /api/signup-email endpoint feeds
  // these tables). Idempotent via CREATE TABLE IF NOT EXISTS; on live PG the
  // tables were pre-applied via SSH before this commit landed. Fresh deploys
  // and test fixtures inherit automatically.
  backend.exec(CREATE_SIGNUP_EMAILS_SQL);
  backend.exec(CREATE_SIGNUP_EMAILS_OPTIN_AT_INDEX_SQL);
  backend.exec(CREATE_SIGNUP_EMAILS_SOURCE_INDEX_SQL);
  backend.exec(CREATE_PROCESSED_SIGNUP_EMAIL_EVENTS_SQL);
  backend.exec(CREATE_PROCESSED_SIGNUP_EMAIL_EVENTS_INDEX_SQL);
  // ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): narrow funnel_events table for the
  // 7 NEW activation-funnel MCP-side stages (quota_hit_{soft,hard,block},
  // upgrade_cta_clicked, etc.). Bot-side stages stay in alerts.log per Q-C
  // Option α. Snapshot reader (src/lib/funnel-snapshot.ts) UNIONs across this
  // table + request_log + processed_stripe_events + bot alerts.log.
  backend.exec(CREATE_FUNNEL_EVENTS_SQL);
  backend.exec(CREATE_FUNNEL_EVENTS_TS_INDEX_SQL);
  backend.exec(CREATE_FUNNEL_EVENTS_TYPE_INDEX_SQL);
  backend.exec(CREATE_FUNNEL_EVENTS_SESSION_INDEX_SQL);
  // CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): outbound webhook delivery tables.
  // Pre-applied to live PG via SSH before this commit; IF NOT EXISTS = no-op there.
  backend.exec(CREATE_WEBHOOK_SUBSCRIPTIONS_SQL);
  backend.exec(CREATE_WEBHOOK_SUBSCRIPTIONS_ACTIVE_INDEX_SQL);
  backend.exec(CREATE_WEBHOOK_SUBSCRIPTIONS_OWNER_INDEX_SQL);
  backend.exec(CREATE_WEBHOOK_DELIVERIES_SQL);
  backend.exec(CREATE_WEBHOOK_DELIVERIES_STATUS_INDEX_SQL);
  runMigrations(backend, isPg);
  // OPS-POSTGRES-RECAUDIT-W1 (2026-05-22): create idempotency-check index AFTER
  // migrations so that the `exchange` column (added by v1.5 migration) exists
  // before the index is created on (coin, timeframe, exchange, created_at).
  // For SQLite the migrations are synchronous; for PG they are fire-and-forget
  // but the production DB already has all columns + the index was created
  // manually via CONCURRENTLY before this commit (IF NOT EXISTS makes the
  // schema-setup line idempotent against the live DB).
  backend.exec(CREATE_SIGNALS_IDEMPOTENCY_INDEX_SQL);
  // OPS-FUNDING-STATS-CACHE-W1 (2026-05-23): create funding-stats materialized
  // view (PG-only — SQLite has no MATERIALIZED VIEW). Idempotent via
  // IF NOT EXISTS; on the live PG the matview was created via SSH before this
  // commit. Fresh deploys / test PG fixtures inherit automatically. Unique
  // index on coin is required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
  if (isPg) {
    backend.exec(CREATE_FUNDING_STATS_MATVIEW_SQL);
    backend.exec(CREATE_FUNDING_STATS_MATVIEW_INDEX_SQL);
  }
  return backend;
}

export function closeDb(): void {
  if (backend) {
    backend.close();
    backend = null;
  }
}

/**
 * OPS-SCRIPT-EXIT-LIFECYCLE-W1: awaitable `closeDb()`.
 *
 * Resolves once in-flight writes have drained and the pool is released. The
 * module-level `backend` is cleared BEFORE awaiting so a concurrent caller can
 * never double-close the same handle. Safe to call when no backend is open.
 */
export async function closeDbAsync(): Promise<void> {
  const b = backend;
  backend = null;
  if (!b) return;
  if (typeof b.closeAsync === 'function') await b.closeAsync();
  else b.close();
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
  const createdAt = Math.floor(Date.now() / 1000);
  b.run(
    `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, signal_hash, regime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    coin, signal, confidence, timeframe, exchange, priceAtSignal, createdAt, signalHash || null, regime ?? null
  );
  // CALL-REGIME-WEBHOOK-LAYER-W1 (2026-05-29): post-insert webhook event hook.
  // Flag-gated (default OFF → zero new behavior); fire-and-forget so it never
  // delays or fails a signal write; lazy dynamic import avoids a circular
  // dependency (webhook-events → webhooks-store → performance-db).
  if (process.env.WEBHOOK_DELIVERY_ENABLED === 'true') {
    import('./webhook-events.js')
      .then((m) => m.onSignalRecorded({
        coin, signal, confidence, timeframe, exchange,
        priceAtSignal, signalHash: signalHash || null, regime: regime ?? null, createdAt,
      }))
      .catch((err) => console.error('[webhook-events] hook error:', err instanceof Error ? err.message : err));
  }
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

/**
 * OPS-RATELIMIT-TELEMETRY-DIGEST-W1 R2 — durable, FAIL-OPEN write of one typed
 * rate-limit event. Fire-and-forget via the shared backend (works from the
 * long-lived MCP server AND short-lived `docker exec` seed crons — both reach the
 * same `getBackend()`). NEVER throws; `ts` defaults to `now()` in the DB. Read
 * weekly by `shadow-digest-weekly`.
 *
 * The PUBLIC entry point is `recordRateLimitEvent` in `./rate-limit-events.ts`,
 * which lazy-`import()`s THIS impl at call time — the transport modules must not
 * statically import performance-db (it closes a cycle:
 * performance-db → asset-tiers → exchange-universe → _upstream-fetch →
 * venue-budget-registry → upstream-weight-budget). The vitest guard lives there.
 */
export function recordRateLimitEventImpl(
  venue: string,
  kind: 'throw' | 'wait' | 'skip',
  code: string | null,
  cls: 'interactive' | 'batch',
  waitMs: number | null,
  caller: string = 'unknown',
): void {
  try {
    getBackend().run(
      `INSERT INTO rate_limit_events (venue, kind, http_or_body_code, class, wait_ms, caller) VALUES (?, ?, ?, ?, ?, ?)`,
      venue, kind, code, cls, waitMs, caller,
    );
  } catch (e) {
    // Fail-open: telemetry must never break or delay the fetch/acquire path.
    console.warn(`[rate-limit-events] record failed (fail-open): ${(e as Error).message}`);
  }
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
 * OPS-PFE-METRIC-INTEGRITY-W1 R3: increment the emit-suppression counter for one
 * (day, venue, timeframe, coin, reason). Mirrors `recordHoldCount` — daily UPSERT-increment,
 * one row per combo — but carries `exchange`, which `hold_counts` lacks.
 *
 * Fail-open by construction: the sole caller is the fire-and-forget wrapper in
 * `emit-suppressions.ts`, and this body swallows its own errors. Telemetry must never break or
 * delay an emission.
 */
export function recordEmitSuppressionImpl(
  exchange: string,
  timeframe: string,
  coin: string,
  reason: string,
): void {
  try {
    const b = getBackend();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (isPg) {
      b.run(
        `INSERT INTO emit_suppressions (date, exchange, timeframe, coin, reason, suppress_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (date, exchange, timeframe, coin, reason)
         DO UPDATE SET suppress_count = emit_suppressions.suppress_count + 1`,
        today, exchange, timeframe, coin, reason
      );
    } else {
      b.run(
        `INSERT INTO emit_suppressions (date, exchange, timeframe, coin, reason, suppress_count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (date, exchange, timeframe, coin, reason)
         DO UPDATE SET suppress_count = suppress_count + 1`,
        today, exchange, timeframe, coin, reason
      );
    }
  } catch (e) {
    // Fail-open: a counter that can fail an emission is worse than no counter.
    console.warn(`[emit-suppressions] record failed (fail-open): ${(e as Error).message}`);
  }
}

/**
 * ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): Record a funnel-stage event.
 *
 * Used by MCP-side captures (tier-warning.ts soft/hard, license.ts checkQuota
 * block, /signup handler upgrade_cta_clicked). Bot-side events stay in alerts.log
 * per Q-C Option α — do NOT call this from algovault-bot.
 *
 * Failure-tolerant: callers fire-and-forget; this is on hot quota-check + signup
 * paths and must not throw on DB error. Same shape as upsertAgentSession().
 *
 * @param eventType one of: 'mcp_tools_list', 'quota_hit_soft', 'quota_hit_hard',
 *   'quota_hit_block', 'upgrade_cta_clicked', 'stripe_checkout_started',
 *   'stripe_payment_succeeded'.
 * @param sessionId optional MCP session-id; null OK for non-MCP events
 * @param chatId optional Telegram chat_id (reserved for future bot→postgres route)
 * @param licenseTier optional 'free'|'starter'|'pro'|'enterprise'|'x402'
 * @param meta optional structured meta; JSON-stringified to TEXT
 */
export function recordFunnelEvent(params: {
  eventType: string;
  sessionId?: string | null;
  chatId?: number | null;
  licenseTier?: string | null;
  meta?: Record<string, unknown> | null;
}): void {
  const { eventType, sessionId, chatId, licenseTier, meta } = params;
  const b = getBackend();
  try {
    const metaJson = meta ? JSON.stringify(meta) : null;
    b.run(
      `INSERT INTO funnel_events (event_type, session_id, chat_id, license_tier, meta_json) VALUES (?, ?, ?, ?, ?)`,
      eventType, sessionId ?? null, chatId ?? null, licenseTier ?? null, metaJson
    );
  } catch (err) {
    // Fail-open per CLAUDE.md `Automation-first recovery → fail-open` rule.
    if (process.env.DEBUG_FUNNEL_EVENTS === '1') {
      console.warn('[funnel-events] recordFunnelEvent error:', err instanceof Error ? err.message : err);
    }
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
  /** FUNNEL-FIX-ATTRIBUTION-W1: classified acquisition source — first_touch is write-once. */
  source?: string | null;
}): Promise<void> {
  const { sessionId, tool, tier, ipHash } = params;
  const src = params.source ?? null;
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
        (session_id, first_seen, last_seen, call_count, tools_used, tiers_seen, first_tool, first_tier, ip_hash_first, first_touch_source, last_touch_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      if (isPg && b instanceof PgBackend) {
        await b.runAsync(insertSql, sessionId, now, now, 1, tool, tier, tool, tier, ipHash, src, src);
      } else {
        b.run(insertSql, sessionId, now, now, 1, tool, tier, tool, tier, ipHash, src, src);
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

    // first_touch_source = COALESCE(existing, src) → WRITE-ONCE (only set when still NULL).
    // last_touch_source = COALESCE(src, existing) → updated only when this hit HAS a source.
    const updateSql = `UPDATE agent_sessions
      SET last_seen = ?, call_count = call_count + 1, tools_used = ?, tiers_seen = ?,
          first_touch_source = COALESCE(first_touch_source, ?),
          last_touch_source = COALESCE(?, last_touch_source)
      WHERE session_id = ?`;
    if (isPg && b instanceof PgBackend) {
      await b.runAsync(updateSql, now, newToolsUsed, newTiersSeen, src, src, sessionId);
    } else {
      b.run(updateSql, now, newToolsUsed, newTiersSeen, src, src, sessionId);
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

/**
 * OPS-MERKLE-BATCH-IDENTITY-W1 — the batch IDENTITY + true total, derived ONCE
 * server-side so no consumer computes them from a paginated array.
 *
 * `getMerkleBatches()` is capped (LIMIT 100). Consumers were deriving both the
 * displayed batch NUMBER and the batch COUNT from `batches.length`, which is
 * only equal to the truth while fewer than `limit` batches exist. Batch 101
 * (2026-07-20) crossed that line and the /verify page pinned at "#100"
 * permanently while its sibling timestamp kept updating — a half-live badge on
 * the page whose entire purpose is verifiability.
 *
 * `latest_batch_id` is MAX(batch_id) — an identity, never a row count.
 */
export async function getMerkleBatchSummary(): Promise<{
  latest_batch_id: number | null;
  batch_count: number;
  total_signals: number;
}> {
  type Row = {
    latest_batch_id: string | number | null;
    batch_count: string | number;
    total_signals: string | number | null;
  };
  const rows = (await dbQuery<Row>(
    `SELECT MAX(batch_id) AS latest_batch_id, COUNT(*) AS batch_count, COALESCE(SUM(signal_count), 0) AS total_signals FROM merkle_batches`,
  )) as Row[];
  const row = rows[0];
  const latest = row?.latest_batch_id;
  return {
    latest_batch_id: latest === null || latest === undefined ? null : Number(latest),
    batch_count: Number(row?.batch_count ?? 0),
    total_signals: Number(row?.total_signals ?? 0),
  };
}

/** Default page size for the public /api/merkle-batches listing. */
export const MERKLE_BATCHES_PAGE_SIZE = 100;

/**
 * OPS-CAPPED-COLLECTION-GUARD-W1 — a PAGE of Merkle batches, newest first.
 *
 * Renamed from `getMerkleBatches`, whose docstring literally read "Get ALL Merkle
 * batches" while returning a `LIMIT`-capped page, and whose `limit = 100` default
 * meant no call site ever typed a number. Two public figures were computed by
 * reducing over the result and were wrong for two days: the batch count (100 vs a
 * true 102) and "calls verified" (386,038 vs a true 387,834).
 *
 * `limit` is REQUIRED so truncation is a conscious act at every call site, and the
 * name now matches this repo's convention for truncating accessors (`getTopAssetsByOI`,
 * `listRecentLedger`, `topReferrers`, `getSampleSignalsFromLatestBatch`,
 * `listPendingNotifications`, `drainEmailNotifications` — every one names its cap;
 * this function was the lone misnomer, and it is the one that shipped wrong numbers).
 *
 * NEVER aggregate over the result. For totals use `getMerkleBatchSummary()`, which
 * derives MAX/COUNT/SUM in SQL over the whole table. Enforced by
 * tests/unit/capped-collection-guard.test.ts.
 */
export async function getRecentMerkleBatches(limit: number): Promise<any[]> {
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

/**
 * DESIGN-W9 (2026-05-11): lookup a signal by its on-chain leaf hash (signal_hash).
 * Used by the `verify://signal/{id}` MCP resource (C4) per Q-W9-8 architect ratification
 * — `{id}` accepts BOTH integer DB ID (existing flow) AND hex `0x…` leaf hash (new flow).
 * Hash form is what agents see in the JSX VFooter demo + via public MCP discovery.
 */
export async function getSignalByHash(signalHash: string): Promise<any | null> {
  const b = getBackend();
  const sql = `
    SELECT s.id, s.coin, s.signal, s.confidence, s.timeframe, s.price_at_signal,
           s.created_at, s.signal_hash, s.merkle_batch_id, s.merkle_proof,
           s.regime, s.exchange,
           mb.merkle_root, mb.tx_hash, mb.block_number, mb.signal_count, mb.published_at
    FROM signals s
    LEFT JOIN merkle_batches mb ON s.merkle_batch_id = mb.batch_id
    WHERE s.signal_hash = ?
  `;
  if (isPg && b instanceof PgBackend) {
    const rows = await b.query(sql, [signalHash]);
    return rows.length > 0 ? rows[0] : null;
  }
  const rows = b.all(sql, signalHash);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * OPTIMIZE-FUNDING-CACHE-W1 (2026-04-30): cached `funding_history` aggregate
 * stats per coin. The DB query at the heart of `getFundingZScore` was the #1
 * CPU sink on the CPX22 box (audit at `audits/CPX22-baseline-2026-04-30.md`):
 * 150-200 queries/sec sustained against a 5.2M-row table = 49.4% postgres
 * CPU sustained. Each query is fast (0.13ms) but volume × frequency = the
 * box.
 *
 * The underlying 14-day rolling window changes on the order of HOURS — a
 * 5-min TTL is invisible to signal quality. We cache (mean, stdDev,
 * sampleCount) per coin; the per-call z-score is computed in-process from
 * `(currentFunding - mean) / stdDev`. Negative results (sampleCount < 20)
 * are also cached, preventing hammer on unknown / new-listing coins.
 *
 * Stampede protection mirrors `src/lib/cross-asset-grid.ts`: an in-flight
 * promise map coalesces N concurrent miss-callers for the same coin into a
 * single DB query.
 */
interface FundingStats {
  mean: number;
  stdDev: number;
  sampleCount: number;
  computedAt: number; // Date.now() ms
}

const FUNDING_STATS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const fundingStatsCache = new Map<string, FundingStats>();
const fundingStatsInflight = new Map<string, Promise<FundingStats | null>>();

/**
 * Loads + aggregates 14-day funding history for one coin, with stampede
 * protection. Returns null only on backend failure (DB error / unavailable);
 * insufficient-sample shape returns FundingStats with sampleCount < 20.
 */
async function loadFundingStats(coin: string): Promise<FundingStats | null> {
  const existing = fundingStatsInflight.get(coin);
  if (existing) return existing;

  const promise = (async (): Promise<FundingStats | null> => {
    try {
      const b = getBackend();
      const cutoff14d = Math.floor(Date.now() / 1000) - 14 * 86400;
      const t0 = Date.now();
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
      const elapsedMs = Date.now() - t0;

      let stats: FundingStats;
      if (rows.length < 20) {
        stats = { mean: 0, stdDev: 0, sampleCount: rows.length, computedAt: Date.now() };
      } else {
        const rates = rows.map(r => r.funding_rate);
        const mean = rates.reduce((a, v) => a + v, 0) / rates.length;
        const variance = rates.reduce((a, v) => a + (v - mean) ** 2, 0) / (rates.length - 1);
        const stdDev = Math.sqrt(variance);
        stats = { mean, stdDev, sampleCount: rows.length, computedAt: Date.now() };
      }

      fundingStatsCache.set(coin, stats);
      // console.debug — NOT console.log — at 200/sec call rate this would
      // flood stdout. Cache-hits are SILENT (not load-bearing per the
      // success-path-logging rule).
      console.debug(`[funding-cache] miss coin=${coin} samples=${stats.sampleCount} db=${elapsedMs}ms`);
      return stats;
    } finally {
      fundingStatsInflight.delete(coin);
    }
  })();

  fundingStatsInflight.set(coin, promise);
  return promise;
}

/**
 * v1.4: Compute Funding Z-Score from rolling 14-day history.
 * v1.10.x (OPTIMIZE-FUNDING-CACHE-W1): cache-first — 5-min TTL on per-coin
 * (mean, stdDev) stats; per-call z-score computed from `currentFunding`
 * argument and cached stats. No API or behavior change visible to callers.
 */
export async function getFundingZScore(coin: string, currentFunding: number): Promise<number | null> {
  const now = Date.now();
  const cached = fundingStatsCache.get(coin);
  if (cached && (now - cached.computedAt) < FUNDING_STATS_TTL_MS) {
    if (cached.sampleCount < 20) return null;
    if (cached.stdDev === 0) return 0;
    return (currentFunding - cached.mean) / cached.stdDev;
  }

  const stats = await loadFundingStats(coin);
  if (!stats) return null;
  if (stats.sampleCount < 20) return null;
  if (stats.stdDev === 0) return 0;
  return (currentFunding - stats.mean) / stats.stdDev;
}

/**
 * OPTIMIZE-FUNDING-CACHE-CRON-W1 (2026-05-01): bulk-warm the in-process
 * cache for N coins via a single batched query. Used at the start of each
 * `seed-signals.js` cron fire so the per-coin `getFundingZScore` calls
 * inside `seedExchange()` hit a warm cache (zero DB roundtrips per signal).
 *
 * The W1 cache architecture (in-process Map) only benefited the long-lived
 * MCP server because every `docker exec node ...` cron fire spawns a fresh
 * process with an empty cache. Audit measurements: ~1,973 cache-miss DB
 * queries per 20 min from cron alone vs 3 from the MCP server. This bulk
 * warmer turns each fire's 50-200 individual queries into 1 batch query,
 * dropping cron cache-miss volume by 90%+.
 *
 * Idempotent: coins whose cache is fresh are skipped; the function is
 * cheap to call multiple times in a single fire. Negative-entry caching
 * (zero-row coins → `sampleCount: 0` cached) prevents per-coin fallback
 * from re-querying for new-listing / unknown coins. Math is identical to
 * `loadFundingStats()` byte-for-byte (Postgres `STDDEV_SAMP` is the
 * sample-stddev with N-1 denominator that JS path uses).
 */
export async function bulkWarmFundingCache(coins: string[]): Promise<void> {
  if (coins.length === 0) return;

  const now = Date.now();
  const cold: string[] = coins.filter((c) => {
    const cached = fundingStatsCache.get(c);
    return !cached || (now - cached.computedAt) >= FUNDING_STATS_TTL_MS;
  });
  const cachedCount = coins.length - cold.length;

  if (cold.length === 0) {
    console.debug(`[funding-cache] bulk-warm n_in=${coins.length} n_warmed=0 n_cached=${cachedCount} db=0ms (all fresh)`);
    return;
  }

  const b = getBackend();
  const cutoff14d = Math.floor(now / 1000) - 14 * 86400;
  const t0 = Date.now();

  try {
    const seen = new Set<string>();
    let matviewHits = 0;
    let fallbackHits = 0;

    if (isPg && b instanceof PgBackend) {
      // OPS-FUNDING-STATS-CACHE-W1 Path R4 (2026-05-23): query the
      // `funding_stats_14d` materialized view first. The matview is refreshed
      // every 5 min via host cron; reads are sub-ms PK lookups (UNIQUE index
      // on `coin`). 92K bulk-warm calls / 21d × 0.9 matview-hit rate eliminates
      // 83K GROUP BY executions; only the 12 refresh-cycle fires/hour pay the
      // 1188ms cost. Coins missing from the matview (new listings within the
      // 14d window that landed after the last refresh) fall through to the
      // GROUP BY below — fail-open behavior preserves correctness.
      const matviewRows = await b.query(
        `SELECT coin, mean, stddev, sample_count
           FROM funding_stats_14d
          WHERE coin = ANY($1::text[])`,
        [cold]
      ) as unknown as { coin: string; mean: number; stddev: number | null; sample_count: number }[];

      const mvTs = Date.now();
      for (const r of matviewRows) {
        seen.add(r.coin);
        matviewHits++;
        const sd = r.stddev ?? 0;
        fundingStatsCache.set(r.coin, {
          mean: Number(r.mean),
          stdDev: Number(sd),
          sampleCount: Number(r.sample_count),
          computedAt: mvTs,
        });
      }

      // Coins NOT in the matview — fall back to the original GROUP BY path.
      // This is the cache-miss path: new-listing coins added to the universe
      // since the last matview refresh, OR a transient matview unavailability
      // (refresh stalled). Fail-open: query the underlying funding_history
      // table directly with the same shape the matview computes from.
      const matviewMisses = cold.filter((c) => !seen.has(c));
      if (matviewMisses.length > 0) {
        const fallbackRows = await b.query(
          `SELECT coin,
                  AVG(funding_rate)::float8 AS mean,
                  STDDEV_SAMP(funding_rate)::float8 AS stddev,
                  COUNT(*)::int AS sample_count
             FROM funding_history
            WHERE recorded_at >= $1 AND coin = ANY($2::text[])
            GROUP BY coin`,
          [cutoff14d, matviewMisses]
        ) as unknown as { coin: string; mean: number; stddev: number | null; sample_count: number }[];

        const fbTs = Date.now();
        for (const r of fallbackRows) {
          seen.add(r.coin);
          fallbackHits++;
          const sd = r.stddev ?? 0;
          fundingStatsCache.set(r.coin, {
            mean: Number(r.mean),
            stdDev: Number(sd),
            sampleCount: Number(r.sample_count),
            computedAt: fbTs,
          });
        }
      }
    } else {
      // SQLite fallback — fetch raw rows then aggregate in JS using the
      // same formulas as `loadFundingStats()` so math is byte-for-byte
      // identical to the per-coin path.
      const placeholders = cold.map(() => '?').join(',');
      const rows = b.all(
        `SELECT coin, funding_rate FROM funding_history
          WHERE recorded_at >= ? AND coin IN (${placeholders})
          ORDER BY coin, recorded_at`,
        cutoff14d, ...cold
      ) as unknown as { coin: string; funding_rate: number }[];

      const grouped = new Map<string, number[]>();
      for (const r of rows) {
        const arr = grouped.get(r.coin) ?? [];
        arr.push(r.funding_rate);
        grouped.set(r.coin, arr);
      }

      const ts = Date.now();
      for (const [coin, rates] of grouped) {
        seen.add(coin);
        const n = rates.length;
        if (n === 0) {
          fundingStatsCache.set(coin, { mean: 0, stdDev: 0, sampleCount: 0, computedAt: ts });
          continue;
        }
        const mean = rates.reduce((a, v) => a + v, 0) / n;
        const variance = n > 1 ? rates.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
        const stdDev = Math.sqrt(variance);
        fundingStatsCache.set(coin, { mean, stdDev, sampleCount: n, computedAt: ts });
      }
    }

    // Negative-entry cache for coins with zero rows in window — prevents
    // per-coin fallback from re-querying for new-listing / unknown coins.
    const ts = Date.now();
    for (const c of cold) {
      if (!seen.has(c)) {
        fundingStatsCache.set(c, { mean: 0, stdDev: 0, sampleCount: 0, computedAt: ts });
      }
    }

    const elapsedMs = Date.now() - t0;
    // OPS-FUNDING-STATS-CACHE-W1: n_matview/n_fallback exposes the matview
    // hit rate. Post-deploy verification gate: n_matview/n_warmed should
    // approach 1.0 in steady state (only matview-misses for new listings hit
    // the GROUP BY fallback). n_matview = 0 (PG only, SQLite n_matview=0 by
    // construction).
    console.debug(`[funding-cache] bulk-warm n_in=${coins.length} n_warmed=${cold.length} n_cached=${cachedCount} n_matview=${matviewHits} n_fallback=${fallbackHits} db=${elapsedMs}ms`);
  } catch (e) {
    const elapsedMs = Date.now() - t0;
    console.debug(`[funding-cache] bulk-warm FAILED n_in=${coins.length} db=${elapsedMs}ms err=${e instanceof Error ? e.message : e}`);
    throw e;
  }
}

// ── OPTIMIZE-FUNDING-CACHE-W1 test seams (underscore-prefixed; non-public). ──

export function _clearFundingStatsCache(): void {
  fundingStatsCache.clear();
  fundingStatsInflight.clear();
}

export function _setFundingStatsForTest(coin: string, stats: FundingStats): void {
  fundingStatsCache.set(coin, stats);
}

export function _getFundingStatsCacheSize(): number {
  return fundingStatsCache.size;
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

/**
 * OPTIMIZE-DASHBOARD-SIGNALS-LIMIT-W1 (2026-05-01) + DASH-W1-FIX (2026-05-03):
 * Two compounding fixes for the dashboard `getPerformanceStats*` hot path
 * that pg_stat_statements surfaced as the dominant cost after
 * POSTGRES-MAINT-W1:
 *
 *   1. Project only the columns `computeStats()` actually reads — `id, coin,
 *      signal, timeframe, confidence, created_at, pfe_return_pct, exchange`
 *      (8 of ~20 cols). Cuts wire bytes + Node heap allocation by ~60-70%.
 *   2. 60s TTL in-memory cache on the computed `PerformanceStats` object —
 *      mirrors the OPTIMIZE-FUNDING-CACHE-W1 cache pattern. Stampede
 *      protection via in-flight-promise map. Cache key buckets by 5-min
 *      windows of "now" so the cache invalidates naturally as time slides
 *      forward (~5-min worst-case staleness).
 *
 * **The original wave also added a `WHERE created_at >= cutoff` 20-day
 * time-window filter, but DASH-W1-FIX reverted it on 2026-05-03 because it
 * silently reduced the public-facing total trade-call count from ~68K (full
 * table) to ~49K (in-window). The CLAUDE.md Data Integrity rule (THE LAW)
 * forbids reducing public-facing data as a side-effect of optimizations:
 * the on-chain Merkle proof advertises 68,047 verified calls; the dashboard
 * MUST surface that same count.** The full-table scan is still bounded by
 * the column projection + 60s cache, which together keep postgres CPU
 * under 5%.
 *
 * Public API + response shape unchanged. No version bump.
 */
const PERF_STATS_TTL_MS = 60 * 1000;
// OPS-PFE-METRIC-INTEGRITY-W1: mae_return_pct is REQUIRED here — the S2 frozen-book
// predicate is `pfe = 0 AND mae = 0`, so without this column `isFrozenEvaluation` sees
// `undefined === 0` (false) and silently excludes NOTHING. Projecting it is what makes the
// eligibility rule real on the row-scan path.
const STATS_COL_PROJECTION = 'id, coin, signal, timeframe, confidence, created_at, pfe_return_pct, mae_return_pct, exchange';

const perfStatsCache = new Map<string, { stats: PerformanceStats; computedAt: number }>();
const perfStatsInflight = new Map<string, Promise<PerformanceStats>>();

function getPerfStatsBucket(): string {
  // 5-min buckets — cache invalidates naturally as time slides forward;
  // multiple concurrent callers landing in the same bucket coalesce to one
  // DB query via the inflight map.
  return `${Math.floor(Date.now() / 1000 / 300)}`;
}

/**
 * Full-table scan column-projected to the columns `computeStats()` actually
 * reads. The `SignalRecord` cast is safe because `computeStats` only
 * references the columns we project. NO time-window filter — public-facing
 * trade-call counts must reflect the full table (matches the on-chain
 * Merkle proof count).
 */
async function loadSignalsForStats(): Promise<SignalRecord[]> {
  const b = getBackend();
  if (isPg && b instanceof PgBackend) {
    return await b.query(
      `SELECT ${STATS_COL_PROJECTION} FROM signals ORDER BY created_at DESC`
    ) as unknown as SignalRecord[];
  }
  return b.all(
    `SELECT ${STATS_COL_PROJECTION} FROM signals ORDER BY created_at DESC`
  ) as unknown as SignalRecord[];
}

export function getPerformanceStats(): PerformanceStats {
  if (isPg) {
    return emptyStats();
  }
  // SQLite path — sync, used in tests / dev. Honor cache-first + column
  // projection identically to the async path. NO time-window filter.
  const bucket = getPerfStatsBucket();
  const cached = perfStatsCache.get(bucket);
  if (cached && (Date.now() - cached.computedAt) < PERF_STATS_TTL_MS) {
    return cached.stats;
  }
  const t0 = Date.now();
  const b = getBackend();
  const all = b.all(
    `SELECT ${STATS_COL_PROJECTION} FROM signals ORDER BY created_at DESC`
  ) as unknown as SignalRecord[];
  const stats = computeStats(all, null);
  perfStatsCache.set(bucket, { stats, computedAt: Date.now() });
  console.debug(`[perf-stats] cache miss bucket=${bucket} rows=${all.length} elapsedMs=${Date.now() - t0}`);
  return stats;
}

export async function getPerformanceStatsAsync(): Promise<PerformanceStats> {
  const bucket = getPerfStatsBucket();

  // Cache check
  const cached = perfStatsCache.get(bucket);
  if (cached && (Date.now() - cached.computedAt) < PERF_STATS_TTL_MS) {
    return cached.stats;
  }

  // Stampede protection — concurrent callers in the same bucket attach to
  // the in-flight promise instead of firing N DB queries.
  const existing = perfStatsInflight.get(bucket);
  if (existing) return existing;

  const promise = (async (): Promise<PerformanceStats> => {
    try {
      const t0 = Date.now();
      const top20 = await getTop20ByOI().catch(() => null);
      // OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH2: SQL GROUP-BY pushdown (PG only, default-OFF
      // flag PERF_STATS_SQL_PUSHDOWN). Byte-equivalent to the loadSignalsForStats +
      // computeStats scan (CH1 oracle gate); returns in ms without holding a pool
      // connection for the full-table load. Default-deny: any non-"1"/"true" → scan.
      const useSql = perfStatsSqlPushdownEnabled() && isPg;
      let stats: PerformanceStats;
      let rows: number;
      if (useSql) {
        const { groups, period, recentRows } = await aggregateSignalsSql();
        stats = rollupStats(groups, period, top20, recentRows);
        rows = period.total;
      } else {
        const all = await loadSignalsForStats();
        stats = computeStats(all, top20);
        rows = all.length;
      }
      perfStatsCache.set(bucket, { stats, computedAt: Date.now() });
      console.debug(`[perf-stats] cache miss bucket=${bucket} mode=${useSql ? 'sql' : 'scan'} rows=${rows} elapsedMs=${Date.now() - t0}`);
      return stats;
    } finally {
      perfStatsInflight.delete(bucket);
    }
  })();

  perfStatsInflight.set(bucket, promise);
  return promise;
}

// ── OPTIMIZE-DASHBOARD-SIGNALS-LIMIT-W1 test seams (underscore-prefixed). ──

export function _clearPerformanceStatsCache(): void {
  perfStatsCache.clear();
  perfStatsInflight.clear();
}

export function _getPerformanceStatsCacheSize(): number {
  return perfStatsCache.size;
}

const METHODOLOGY: Record<string, unknown> = {
  pfeWinRate: 'Peak Favorable Excursion win rate. Did price move in the signal direction at any point during the evaluation window?',
  note: 'AlgoVault provides directional entry signals. Exit timing is determined by your agent or strategy — PFE Win Rate measures whether the direction was correct, independent of exit.',
  evaluationWindows: {
    '1m': '12 candles (12 minutes)', '3m': '12 candles (36 minutes)',
    '5m': '12 candles (1 hour)', '15m': '12 candles (3 hours)', '30m': '8 candles (4 hours)',
    '1h': '8 candles (8 hours)', '2h': '6 candles (12 hours)', '4h': '6 candles (24 hours)',
    '8h': '4 candles (32 hours)', '12h': '4 candles (48 hours)', '1d': '3 candles (3 days)',
  },
  dataSource: 'Hyperliquid public API. Every qualifying signal recorded and evaluated.',
  signalFilter: 'Confidence >= 60%. HOLD signals excluded.',
};

function emptyStats(): PerformanceStats {
  return {
    totalCalls: 0,
    period: { from: '', to: '' },
    overall: { totalCalls: 0, totalEvaluated: 0, pfeWinRate: null },
    byCallType: {},
    byTimeframe: {},
    byAsset: {},
    byExchange: {},
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
  const evaluatedPFE = nonHold.filter(isPfeEligible);
  const pfeWins = evaluatedPFE.filter(s => {
    const pfe = s.pfe_return_pct ?? 0;
    return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
  });
  const pfeWinRate = evaluatedPFE.length > 0 ? pfeWins.length / evaluatedPFE.length : null;

  // By signal type
  const bySignalType: PerformanceStats['byCallType'] = {};  // local var; emitted as byCallType
  for (const type of ['BUY', 'SELL', 'HOLD'] as const) {
    const group = all.filter(s => s.signal === type);
    const pfeGroup = group.filter(isPfeEligible);
    const pfeWinsGroup = pfeGroup.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });

    bySignalType[type] = {
      count: type === 'HOLD' ? group.length : pfeGroup.length,
      evaluated: pfeGroup.length,
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
    const tfPFE = tfSignals.filter(isPfeEligible);
    const tfPFEWins = tfPFE.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });

    byTimeframe[tf] = {
      count: tfPFE.length,
      evaluated: tfPFE.length,
      pfeWinRate: tfPFE.length > 0 ? tfPFEWins.length / tfPFE.length : null,
    };
  }

  // By asset (tier + PFE WR only)
  const coins = [...new Set(all.map(s => s.coin))];
  const byAsset: PerformanceStats['byAsset'] = {};
  for (const coin of coins) {
    const group = all.filter(s => s.coin === coin);
    const nh = group.filter(s => s.signal !== 'HOLD');
    const pfeGroup = nh.filter(isPfeEligible);
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
    const tierPFE = tierSignals.filter(isPfeEligible);
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

  // By exchange — full sub-aggregates per exchange for dashboard filtering
  const exchanges = [...new Set(all.map(s => s.exchange || 'HL'))];
  const byExchange: PerformanceStats['byExchange'] = {};
  for (const ex of exchanges) {
    const exAll = all.filter(s => (s.exchange || 'HL') === ex);
    const exNonHold = exAll.filter(s => s.signal !== 'HOLD');
    const exEvalPFE = exNonHold.filter(isPfeEligible);
    const exPfeWins = exEvalPFE.filter(s => {
      const pfe = s.pfe_return_pct ?? 0;
      return s.signal === 'BUY' ? pfe > 0 : pfe < 0;
    });

    // Per-exchange byTimeframe
    const exByTimeframe: PerformanceStats['byExchange'][string]['byTimeframe'] = {};
    for (const tf of [...new Set(exNonHold.map(s => s.timeframe))]) {
      const g = exNonHold.filter(s => s.timeframe === tf);
      const e = g.filter(isPfeEligible);
      const w = e.filter(s => { const p = s.pfe_return_pct ?? 0; return s.signal === 'BUY' ? p > 0 : p < 0; });
      exByTimeframe[tf] = { count: e.length, evaluated: e.length, pfeWinRate: e.length > 0 ? w.length / e.length : null };
    }

    // Per-exchange byTier
    const exByTier: PerformanceStats['byExchange'][string]['byTier'] = {};
    for (const tierDef of TIER_DEFINITIONS) {
      const tg = exNonHold.filter(s => classifyAsset(s.coin, top20ByOI) === tierDef.tier);
      const te = tg.filter(isPfeEligible);
      const tw = te.filter(s => { const p = s.pfe_return_pct ?? 0; return s.signal === 'BUY' ? p > 0 : p < 0; });
      exByTier[`tier${tierDef.tier}`] = { count: tg.length, evaluated: te.length, pfeWinRate: te.length > 0 ? tw.length / te.length : null };
    }

    // Per-exchange byCallType (was bySignalType pre-1.10)
    const exByCallType: PerformanceStats['byExchange'][string]['byCallType'] = {};
    for (const type of ['BUY', 'SELL', 'HOLD'] as const) {
      const g = exAll.filter(s => s.signal === type);
      const e = g.filter(isPfeEligible);
      const w = e.filter(s => { const p = s.pfe_return_pct ?? 0; return s.signal === 'BUY' ? p > 0 : p < 0; });
      exByCallType[type] = { count: type === 'HOLD' ? g.length : e.length, evaluated: e.length, pfeWinRate: type === 'HOLD' ? null : (e.length > 0 ? w.length / e.length : null) };
    }

    // Per-exchange byAsset
    const exByAsset: PerformanceStats['byExchange'][string]['byAsset'] = {};
    for (const coin of [...new Set(exAll.map(s => s.coin))]) {
      const g = exAll.filter(s => s.coin === coin);
      const nh = g.filter(s => s.signal !== 'HOLD');
      const e = nh.filter(isPfeEligible);
      const w = e.filter(s => { const p = s.pfe_return_pct ?? 0; return s.signal === 'BUY' ? p > 0 : p < 0; });
      exByAsset[coin] = { count: g.length, tier: classifyAsset(coin, top20ByOI), pfeWinRate: e.length > 0 ? w.length / e.length : null };
    }

    byExchange[ex] = {
      exchange: ex,
      count: exNonHold.length,
      evaluated: exEvalPFE.length,
      pfeWinRate: exEvalPFE.length > 0 ? exPfeWins.length / exEvalPFE.length : null,
      byTimeframe: exByTimeframe,
      byTier: exByTier,
      byCallType: exByCallType,
      byAsset: exByAsset,
    };
  }

  return {
    // v1.10.0: `totalCalls`/`byCallType` are the canonical keys (was
    // `totalSignals`/`bySignalType` pre-1.10). DB column literally named
    // `signal` is unchanged — only the API output key is renamed (output-
    // shaping layer, not DB schema; deferred future wave).
    totalCalls: all.length,
    period: {
      from: new Date(oldest.created_at * 1000).toISOString().split('T')[0],
      to: new Date(newest.created_at * 1000).toISOString().split('T')[0],
    },
    overall: {
      totalCalls: nonHold.length,
      totalEvaluated: evaluatedPFE.length,
      pfeWinRate,
    },
    byCallType: bySignalType,
    byTimeframe,
    byAsset,
    byExchange,
    byTier,
    // PERFORMANCE-PUBLIC-SANITIZE-W1 (2026-05-15): Data Integrity LAW enforced
    // at the generator. `.call` (BUY/SELL/HOLD direction) + `.confidence`
    // (0-100 score) DROPPED from public response shape — they are the core
    // paywalled MCP value. Fix-at-the-generator means every downstream
    // consumer (/track-record dashboard, track-record-proxy.js, any future
    // reader) inherits the sanitized shape with zero per-consumer migration.
    // Closes DESIGN-W11-FF3 flagged follow-up. Sanitizer is a pure exported
    // function `formatPublicRecentSignal()` below — directly unit-testable.
    recentSignals: all.slice(0, 20).map(s => formatPublicRecentSignal({
      id: s.id!,
      coin: s.coin,
      timeframe: s.timeframe,
      tier: classifyAsset(s.coin, top20ByOI),
      created_at: s.created_at,
      exchange: s.exchange || 'HL',
    })),
    methodology: METHODOLOGY,
  };
}

// ── OPS-PERFSTATS-SQL-PUSHDOWN-W1 (CH1) — hybrid perf-stats ───────────────────
// SQL does the O(rows) GROUP-BY counting; JS does the O(groups) rollup + ratios
// + tier classification. rollupStats is the pure reconstruction proven
// byte-equivalent to computeStats (the frozen oracle) by
// tests/unit/perfstats-rollup-equivalence.test.ts. aggregateRowsInJs is the
// in-JS analogue of CH2's SQL GROUP BY (aggregateSignalsSql mirrors its shape).

/** One grouped count row — the SQL GROUP BY (coalesce(exchange,'HL'), coin, timeframe, signal) output. */
export interface StatGroupRow {
  exchange: string;
  coin: string;
  timeframe: string;
  signal: SignalVerdict;
  cnt: number;       // count(*)
  pfe_eval: number;  // count(*) FILTER (WHERE pfe_return_pct IS NOT NULL)
  pfe_win: number;   // count(*) FILTER (... AND ((BUY∧pfe>0)∨(SELL∧pfe<0)))
  max_ca: number;    // max(created_at) — deterministic byAsset/byExchange order (Q1)
  max_id: number;    // max(id)
}

/** Period + grand-total — the SQL `SELECT min(created_at), max(created_at), count(*)`. */
export interface PeriodRow {
  min_created_at: number;
  max_created_at: number;
  total: number;
}

const PERF_TF_ORDER = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];

/** Win predicate, identical to computeStats: pfe!=null AND ((BUY∧pfe>0)∨(SELL∧pfe<0)). pfe==0 is NOT a win. */
function isPfeWin(signal: SignalVerdict, pfe: number | null): boolean {
  if (pfe == null) return false;
  if (signal === 'BUY') return pfe > 0;
  if (signal === 'SELL') return pfe < 0;
  return false;  // HOLD/other never a win — matches the SQL FILTER (BUY∧>0 ∨ SELL∧<0) exactly (computeStats only win-evaluates nonHold, so this is byte-equivalent there too)
}

/**
 * In-JS analogue of the CH2 SQL GROUP BY — the reference grouping. Groups raw
 * rows by (exchange||'HL', coin, timeframe, signal) with the exact computeStats
 * win/eval predicates. CH2's aggregateSignalsSql produces the identical shape
 * (the SQL must `GROUP BY coalesce(exchange,'HL'), …` so null-exchange merges to HL).
 */
export function aggregateRowsInJs(rows: SignalRecord[]): { groups: StatGroupRow[]; period: PeriodRow } {
  const map = new Map<string, StatGroupRow>();
  let minCa = Infinity, maxCa = -Infinity;
  for (const r of rows) {
    const ex = r.exchange || 'HL';
    const key = `${ex} ${r.coin} ${r.timeframe} ${r.signal}`;
    let g = map.get(key);
    if (!g) { g = { exchange: ex, coin: r.coin, timeframe: r.timeframe, signal: r.signal, cnt: 0, pfe_eval: 0, pfe_win: 0, max_ca: -Infinity, max_id: -Infinity }; map.set(key, g); }
    g.cnt++;
    if (isPfeEligible(r)) { g.pfe_eval++; if (isPfeWin(r.signal, r.pfe_return_pct!)) g.pfe_win++; }
    if (r.created_at > g.max_ca) g.max_ca = r.created_at;
    const rid = r.id ?? 0;
    if (rid > g.max_id) g.max_id = rid;
    if (r.created_at < minCa) minCa = r.created_at;
    if (r.created_at > maxCa) maxCa = r.created_at;
  }
  return {
    groups: [...map.values()],
    period: { min_created_at: rows.length ? minCa : 0, max_created_at: rows.length ? maxCa : 0, total: rows.length },
  };
}

const _sumCnt = (gs: StatGroupRow[]) => gs.reduce((a, g) => a + g.cnt, 0);
const _sumEval = (gs: StatGroupRow[]) => gs.reduce((a, g) => a + g.pfe_eval, 0);
const _sumWin = (gs: StatGroupRow[]) => gs.reduce((a, g) => a + g.pfe_win, 0);
const _wr = (gs: StatGroupRow[]) => { const e = _sumEval(gs); return e > 0 ? _sumWin(gs) / e : null; };

/** Distinct keys ordered by MAX(created_at) DESC, MAX(id) DESC (Q1 — deterministic, ≈ oracle first-seen). */
function _orderByRecency(keyOf: (g: StatGroupRow) => string, gs: StatGroupRow[]): string[] {
  const m = new Map<string, { ca: number; id: number }>();
  for (const g of gs) {
    const k = keyOf(g);
    const cur = m.get(k);
    if (!cur || g.max_ca > cur.ca || (g.max_ca === cur.ca && g.max_id > cur.id)) m.set(k, { ca: g.max_ca, id: g.max_id });
  }
  return [...m.keys()].sort((a, b) => { const x = m.get(a)!, y = m.get(b)!; return (y.ca - x.ca) || (y.id - x.id); });
}

const _byTf = (gs: StatGroupRow[]) => ({ count: _sumEval(gs), evaluated: _sumEval(gs), pfeWinRate: _wr(gs) });

/**
 * Pure rollup: reconstruct the FULL PerformanceStats from grouped rows + period
 * + top20 + the pre-fetched top-20 recent rows. Byte-equivalent to computeStats
 * (proven by the CH1 oracle test). recentRows is the caller's
 * (created_at DESC, id DESC) LIMIT 20 slice — the pure fn stays row-free otherwise (Q2).
 */
export function rollupStats(
  groups: StatGroupRow[],
  period: PeriodRow,
  top20ByOI: Set<string> | null,
  recentRows: SignalRecord[],
): PerformanceStats {
  if (period.total === 0) return emptyStats();
  const nonHold = groups.filter(g => g.signal !== 'HOLD');

  // byCallType — FIXED literal order incl HOLD (Q3); BUY/SELL count==evaluated
  const byCallType: PerformanceStats['byCallType'] = {};
  for (const type of ['BUY', 'SELL', 'HOLD'] as const) {
    const gs = groups.filter(g => g.signal === type);
    byCallType[type] = type === 'HOLD'
      ? { count: _sumCnt(gs), evaluated: 0, pfeWinRate: null }
      : { count: _sumEval(gs), evaluated: _sumEval(gs), pfeWinRate: _wr(gs) };
  }

  // byTimeframe — keys = distinct tf across ALL groups (incl HOLD), TF_ORDER; values over nonHold∧tf
  const byTimeframe: PerformanceStats['byTimeframe'] = {};
  for (const tf of [...new Set(groups.map(g => g.timeframe))].sort((a, b) => PERF_TF_ORDER.indexOf(a) - PERF_TF_ORDER.indexOf(b))) {
    byTimeframe[tf] = _byTf(nonHold.filter(g => g.timeframe === tf));
  }

  // byAsset — distinct coins across ALL groups, recency-ordered (Q1); count incl HOLD, WR over nonHold
  const byAsset: PerformanceStats['byAsset'] = {};
  for (const coin of _orderByRecency(g => g.coin, groups)) {
    const all = groups.filter(g => g.coin === coin);
    byAsset[coin] = { count: _sumCnt(all), tier: classifyAsset(coin, top20ByOI), pfeWinRate: _wr(all.filter(g => g.signal !== 'HOLD')) };
  }

  // byTier — FIXED TIER_DEFINITIONS order (Q3); nonHold; assets = sorted distinct nonHold coins∈tier
  const byTier: PerformanceStats['byTier'] = {};
  for (const td of TIER_DEFINITIONS) {
    const gs = nonHold.filter(g => classifyAsset(g.coin, top20ByOI) === td.tier);
    byTier[`tier${td.tier}`] = { tier: td.tier, name: td.name, label: td.label, color: td.color, count: _sumCnt(gs), evaluated: _sumEval(gs), pfeWinRate: _wr(gs), assets: [...new Set(gs.map(g => g.coin))].sort() };
  }

  // byExchange — distinct exchange across ALL groups, recency-ordered (Q1)
  const byExchange: PerformanceStats['byExchange'] = {};
  for (const ex of _orderByRecency(g => g.exchange, groups)) {
    const exAll = groups.filter(g => g.exchange === ex);
    const exNon = exAll.filter(g => g.signal !== 'HOLD');
    const exTf: PerformanceStats['byExchange'][string]['byTimeframe'] = {};
    for (const tf of [...new Set(exNon.map(g => g.timeframe))].sort((a, b) => PERF_TF_ORDER.indexOf(a) - PERF_TF_ORDER.indexOf(b))) exTf[tf] = _byTf(exNon.filter(g => g.timeframe === tf));
    const exTier: PerformanceStats['byExchange'][string]['byTier'] = {};
    for (const td of TIER_DEFINITIONS) { const gs = exNon.filter(g => classifyAsset(g.coin, top20ByOI) === td.tier); exTier[`tier${td.tier}`] = { count: _sumCnt(gs), evaluated: _sumEval(gs), pfeWinRate: _wr(gs) }; }
    const exCall: PerformanceStats['byExchange'][string]['byCallType'] = {};
    for (const type of ['BUY', 'SELL', 'HOLD'] as const) { const gs = exAll.filter(g => g.signal === type); exCall[type] = type === 'HOLD' ? { count: _sumCnt(gs), evaluated: 0, pfeWinRate: null } : { count: _sumEval(gs), evaluated: _sumEval(gs), pfeWinRate: _wr(gs) }; }
    const exAsset: PerformanceStats['byExchange'][string]['byAsset'] = {};
    for (const coin of _orderByRecency(g => g.coin, exAll)) { const all = exAll.filter(g => g.coin === coin); exAsset[coin] = { count: _sumCnt(all), tier: classifyAsset(coin, top20ByOI), pfeWinRate: _wr(all.filter(g => g.signal !== 'HOLD')) }; }
    byExchange[ex] = { exchange: ex, count: _sumCnt(exNon), evaluated: _sumEval(exNon), pfeWinRate: _wr(exNon), byTimeframe: exTf, byTier: exTier, byCallType: exCall, byAsset: exAsset };
  }

  return {
    totalCalls: _sumCnt(groups),
    period: {
      from: new Date(period.min_created_at * 1000).toISOString().split('T')[0],
      to: new Date(period.max_created_at * 1000).toISOString().split('T')[0],
    },
    overall: { totalCalls: _sumCnt(nonHold), totalEvaluated: _sumEval(nonHold), pfeWinRate: _wr(nonHold) },
    byCallType,
    byTimeframe,
    byAsset,
    byExchange,
    byTier,
    recentSignals: recentRows.slice(0, 20).map(s => formatPublicRecentSignal({
      id: s.id!, coin: s.coin, timeframe: s.timeframe, tier: classifyAsset(s.coin, top20ByOI), created_at: s.created_at, exchange: s.exchange || 'HL',
    })),
    methodology: METHODOLOGY,
  };
}

/** Recursive canonical key-sort for byte-equivalence comparison (Q1) + the CH2 probe / CH3 shape gate. */
export function canonicalizeForCompare(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalizeForCompare);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonicalizeForCompare((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Test-seam: invoke the FROZEN oracle without exporting/altering computeStats itself. */
export function _computeStatsOracle(rows: SignalRecord[], top20ByOI: Set<string> | null = null): PerformanceStats {
  return computeStats(rows, top20ByOI);
}

// ── OPS-PERFSTATS-SQL-PUSHDOWN-W1 (CH2) — SQL pushdown (PG only, dark behind a flag) ──

/** Default-deny flag parser: ONLY "1"/"true" enable the SQL pushdown (unset/malformed = off). */
export function _parsePerfStatsPushdownFlag(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}
function perfStatsSqlPushdownEnabled(): boolean {
  return _parsePerfStatsPushdownFlag(process.env.PERF_STATS_SQL_PUSHDOWN);
}

/**
 * The three SQL strings of the pushdown — pure (unit-tested for shape; executed
 * by aggregateSignalsSql). NO outcome_* (PII LAW), NO time-window (full-table,
 * Merkle-parity), NO confidence filter (enforced at write). null-exchange
 * coalesces to 'HL' to match computeStats' `s.exchange || 'HL'`. max(created_at)
 * + max(id) per group drive rollup's deterministic byAsset/byExchange order (Q1).
 */
export function buildStatsAggregateSql(): { groupsSql: string; periodSql: string; recentSql: string } {
  // OPS-PFE-METRIC-INTEGRITY-W1: both filters below carry the S2 frozen-book exclusion via the
  // SHARED fragment from pfe-scoring.ts. This path is the LIVE one in prod
  // (PERF_STATS_SQL_PUSHDOWN=1), so a rule applied only to the TypeScript predicates would be a
  // silent no-op on the published number.
  const winFilter = `WHERE ${SQL_PFE_ELIGIBLE} AND ((signal = 'BUY' AND pfe_return_pct > 0) OR (signal = 'SELL' AND pfe_return_pct < 0))`;
  return {
    groupsSql:
      "SELECT coalesce(exchange, 'HL') AS exchange, coin, timeframe, signal, " +
      'count(*) AS cnt, ' +
      `count(*) FILTER (WHERE ${SQL_PFE_ELIGIBLE}) AS pfe_eval, ` +
      `count(*) FILTER (${winFilter}) AS pfe_win, ` +
      'max(created_at) AS max_ca, max(id) AS max_id ' +
      "FROM signals GROUP BY coalesce(exchange, 'HL'), coin, timeframe, signal",
    periodSql:
      'SELECT min(created_at) AS min_created_at, max(created_at) AS max_created_at, count(*) AS total FROM signals',
    recentSql:
      `SELECT ${STATS_COL_PROJECTION} FROM signals ORDER BY created_at DESC, id DESC LIMIT 20`,
  };
}

/**
 * PG-only executor. Returns grouped rows (Number-coerced — node-postgres returns
 * count/bigint as strings) + period + the deterministic top-20 recent rows (left
 * in native b.query types so recentSignals byte-matches loadSignalsForStats rows).
 */
export async function aggregateSignalsSql(): Promise<{ groups: StatGroupRow[]; period: PeriodRow; recentRows: SignalRecord[] }> {
  const b = getBackend();
  if (!(isPg && b instanceof PgBackend)) throw new Error('aggregateSignalsSql: PG backend required');
  const { groupsSql, periodSql, recentSql } = buildStatsAggregateSql();
  // Sequential on ONE pooled connection (~150ms total) — fewer concurrent conns
  // than 3 parallel queries; still ms vs the ~6s full-row-load it replaces.
  const rawGroups = (await b.query(groupsSql)) as unknown as Array<Record<string, unknown>>;
  const rawPeriod = (await b.query(periodSql)) as unknown as Array<Record<string, unknown>>;
  const recentRows = (await b.query(recentSql)) as unknown as SignalRecord[];
  const groups: StatGroupRow[] = rawGroups.map(r => ({
    exchange: String(r.exchange), coin: String(r.coin), timeframe: String(r.timeframe), signal: r.signal as SignalVerdict,
    cnt: Number(r.cnt), pfe_eval: Number(r.pfe_eval), pfe_win: Number(r.pfe_win),
    max_ca: Number(r.max_ca), max_id: Number(r.max_id),
  }));
  const p = rawPeriod[0] ?? {};
  const period: PeriodRow = { min_created_at: Number(p.min_created_at) || 0, max_created_at: Number(p.max_created_at) || 0, total: Number(p.total) || 0 };
  return { groups, period, recentRows };
}

// Probe seams (underscore-prefixed) for the live byte-equivalence gate (audits/perfstats-equivalence-probe.js).
export async function _perfStatsOldPath(top20: Set<string> | null): Promise<{ stats: PerformanceStats; total: number }> {
  const all = await loadSignalsForStats();
  return { stats: computeStats(all, top20), total: all.length };
}
export async function _perfStatsNewPath(top20: Set<string> | null): Promise<{ stats: PerformanceStats; total: number }> {
  const { groups, period, recentRows } = await aggregateSignalsSql();
  return { stats: rollupStats(groups, period, top20, recentRows), total: period.total };
}

// ── Public recent signals (for /api/performance-public.recentSignals[] + /track-record dashboard) ──
//
// PERFORMANCE-PUBLIC-SANITIZE-W1 (2026-05-15): closes DESIGN-W11-FF3 flagged
// follow-up. Pure formatter `formatPublicRecentSignal()` enforces the public-
// shape contract at the data layer via an EXPLICIT allow-list (not a deny-
// list) — new input fields cannot accidentally leak. Forbidden fields
// (`.call`, `.confidence`, `.signal_hash`, `.merkle_*`, `.outcome_*`,
// `.is_bot_internal`, `.session_id`) are NEVER emitted regardless of what
// the input row contains. Per CLAUDE.md "Fix at the generator, not the
// lane" — every downstream consumer inherits the sanitized shape.
//
// Snapshot artifact: audits/performance-public-shape-snapshot-2026-05-14.json
// pins the contract; tests/unit/performance-public-shape.test.ts asserts it.
// Any future additive change requires a NEW dated snapshot file + matching
// unit test (per Q-PSAN-6 version-bump policy in mapping.md §6).

export interface PublicRecentSignal {
  id: number;
  coin: string;
  tier: number;
  timeframe: string;
  exchange: string;
  created_at: number;
}

export interface PublicRecentSignalInput {
  id: number;
  coin: string;
  tier: number;
  timeframe: string;
  exchange: string;
  created_at: number;
}

// Pure formatter — extracted so unit tests assert the public shape contract
// without ESM-mock gymnastics. Matches LANDING-LIVE-CALL-TICKER-W1's
// formatRecentCallRow pattern (canonical pure-formatter-extract-for-shape-test).
//
// SECURITY-CRITICAL: this function is the ONLY place that determines what
// keys appear in /api/performance-public.recentSignals[]. Allow-list pattern:
// only the 6 enumerated keys ship to clients. Any future caller passing a
// row with `.call` / `.confidence` / `.outcome_*` / etc. — those fields are
// IGNORED by this formatter regardless of input shape.
export function formatPublicRecentSignal(row: PublicRecentSignalInput): PublicRecentSignal {
  return {
    id: row.id,
    coin: row.coin,
    tier: row.tier,
    timeframe: row.timeframe,
    exchange: row.exchange,
    created_at: row.created_at,
  };
}

// ── Recent calls (for live ticker on landing/index.html) ──
//
// LANDING-LIVE-CALL-TICKER-W1: thin query for the public /api/recent-calls
// endpoint. Returns N most recent rows sanitized for public consumption —
// NO outcome_*, NO pfe_*, NO mae_*, NO return_pct_*, NO price_*, NO
// signal_hash, NO merkle_*, NO id, NO tier (Phase-E-adjacent per CLAUDE.md
// Data Integrity LAW). Output keys match brand-facts-friendly naming:
// `coin → slug`, `signal → call`, `created_at (unix sec) → created_at_iso
// (ISO 8601 UTC)`, plus computed `seconds_ago` (int).
//
// Cap enforcement happens in the HTTP handler, not here. This helper trusts
// its caller to pass a sane limit; defends with an inner Math.min(limit, 10).

export interface RecentCall {
  slug: string;
  exchange: string;
  timeframe: string;
  call: string;
  confidence: number;
  created_at_iso: string;
  seconds_ago: number;
}

export interface RecentCallDbRow {
  coin: string;
  exchange: string | null;
  timeframe: string;
  signal: string;
  confidence: number;
  created_at: number;
}

// Pure formatter — extracted so unit tests assert the public shape contract
// (no Phase-E / outcome / Merkle leakage) without ESM-mock gymnastics.
export function formatRecentCallRow(row: RecentCallDbRow, nowSec: number): RecentCall {
  return {
    slug: row.coin,
    exchange: row.exchange || 'HL',
    timeframe: row.timeframe,
    call: row.signal,
    confidence: row.confidence,
    created_at_iso: new Date(row.created_at * 1000).toISOString(),
    seconds_ago: Math.max(0, nowSec - row.created_at),
  };
}

export function clampRecentCallsLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || 1, 10));
}

export async function getRecentCallsAsync(limit: number): Promise<RecentCall[]> {
  const safeLimit = clampRecentCallsLimit(limit);
  const rows = await dbQuery<RecentCallDbRow>(
    `SELECT coin, exchange, timeframe, signal, confidence, created_at
     FROM signals
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  const nowSec = Math.floor(Date.now() / 1000);
  return rows.map((r) => formatRecentCallRow(r, nowSec));
}

// ── Verify sample signals (for /api/verify-sample-ids + Try-It pills) ──

export interface VerifySample {
  id: number;
  coin: string;
  signal: string;
  timeframe: string;
  confidence: number;
}

export interface VerifySampleResult {
  batchId: number | null;
  publishedAt: number | null;
  signals: VerifySample[];
}

/**
 * Returns up to `limit` signal IDs from the most recent published Merkle batch,
 * deduplicated by coin for variety. Used by the /verify page's "Try it" pills.
 */
export async function getSampleSignalsFromLatestBatch(limit = 5): Promise<VerifySampleResult> {
  const b = getBackend();
  const empty: VerifySampleResult = { batchId: null, publishedAt: null, signals: [] };

  try {
    // Get the latest batch ID + published_at
    const batchRows = await dbQuery<{ batch_id: number; published_at: string | number }>(
      `SELECT batch_id, published_at FROM merkle_batches ORDER BY batch_id DESC LIMIT 1`
    );
    if (batchRows.length === 0) return empty;
    const batchId = Number(batchRows[0].batch_id);
    const publishedAt = typeof batchRows[0].published_at === 'number'
      ? batchRows[0].published_at
      : new Date(batchRows[0].published_at as string).getTime();

    // Fetch limit*4 random signals from this batch for coin-dedup headroom.
    // Filter to confidence >= 60 to match the track-record dashboard's
    // evaluation threshold (only calls with >= 60% confidence are shown
    // in the public PFE Win Rate stats).
    const rows = await dbQuery<{ id: number; coin: string; signal: string; timeframe: string; confidence: number }>(
      `SELECT id, coin, signal, timeframe, confidence
       FROM signals
       WHERE merkle_batch_id = ?
         AND confidence >= 60
       ORDER BY RANDOM()
       LIMIT ?`,
      [batchId, limit * 4]
    );

    // Dedupe by coin in JS (SQLite and PG both support ORDER BY RANDOM())
    const seen = new Set<string>();
    const signals: VerifySample[] = [];
    for (const r of rows) {
      if (seen.has(r.coin)) continue;
      seen.add(r.coin);
      signals.push({ id: Number(r.id), coin: r.coin, signal: r.signal, timeframe: r.timeframe, confidence: Number(r.confidence) });
      if (signals.length >= limit) break;
    }

    return { batchId, publishedAt, signals };
  } catch (err) {
    console.debug('getSampleSignalsFromLatestBatch failed:', err instanceof Error ? err.message : err);
    return empty;
  }
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
