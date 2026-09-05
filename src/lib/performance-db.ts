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
import { SQL_PUBLISHED_POPULATION, sqlPublishedPopulation, isPublishedPopulation, MIN_TRACKABLE_CONFIDENCE } from './published-population.js';
import { scorerCaptureEnabled, type ScorerParts } from './scorer-input-codes.js';
import { formatWriteLossLog } from './log-redact.js';
// The funding z-score window lives in its own dependency-free leaf: `reasoning` cites
// it in public copy, and every trade-call test mocks THIS module wholesale — so a
// constant declared here would arrive `undefined` at the renderer. See funding-window.ts.
import { FUNDING_Z_MIN_SAMPLES, FUNDING_Z_WINDOW_SECONDS } from './funding-window.js';
// SIGNAL-TREND-MODE-ENABLE-W1 CH1: the writer stamps which VERDICT rule produced each row, and
// the stamp is a function of this flag's LIVE value. `trend-mode-flag.ts` imports nothing, so the
// edge is a leaf and no cycle is introduced. See currentVerdictRuleVersion() below.
import { getTrendMode } from './trend-mode-flag.js';
import { DdlBarrier } from './ddl-barrier.js';

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

// NOTE: the former `safeJson` helper lived here solely to render bound parameters
// into the WRITE-LOST line below. It TRUNCATED but never REDACTED, so it emitted
// live API keys and subscriber emails (SEC-14). Superseded by the structural
// redaction in ./log-redact.ts — see `formatWriteLossLog`.

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

  /**
   * OPS-PG-LANE-BOOTSTRAP-W1 — THE DDL BARRIER. Program order was not execution order without
   * it, and that is not a test-only concern.
   *
   * `exec()` IS the schema path. `getBackend()` below issues ~60 statements in a straight line
   * — a CREATE TABLE, then its CREATE INDEXes — and every other store's `ensure*Schema()` does
   * the same. Each statement used to be handed straight to a 12-connection `Pool` and NOT
   * awaited, so a dozen of them executed CONCURRENTLY on a dozen different connections.
   * Postgres has no reason to run them in the order they were queued, and it does not:
   *
   *   CREATE INDEX idx_signup_emails_optin_at ON signup_emails (optin_at)
   *     -> ERROR: relation "signup_emails" does not exist
   *
   * ...while `CREATE TABLE signup_emails` was still in flight beside it. Because `exec` is
   * fire-and-forget the failure surfaced only as a `[pg-write] WRITE LOST` line, and the index
   * was silently never created. Measured on the Postgres CI lane (run 33400151672): SEVEN
   * tables lost indexes this way inside ONE process — signup_emails, agent_sessions,
   * contact_leads, funnel_events, webhook_subscriptions, webhook_deliveries,
   * subscriber_notifications — and WHICH ones lost them varied run to run on an identical
   * tree, which is what a race looks like from the outside.
   *
   * Production never saw it because production's schema is pre-applied over SSH ahead of the
   * deploys that need it (this file says so in a dozen places), so `IF NOT EXISTS` makes the
   * whole cascade a no-op there. A FRESH database is the case nobody exercises — and a fresh
   * database is exactly what a CI lane, a new Hetzner box, and a restored backup each are.
   *
   * WHY A BARRIER RATHER THAN THE DOCUMENTED REMEDY. CLAUDE.md already carried the rule:
   * "`dbExec`/`dbRun` fire-and-forget on PG — bundle DDL in single multi-statement call". It is
   * correct, and it was ignored by ~60 call sites across a dozen modules for months, because
   * nothing enforced it. A rule that has once failed as prose is retired into a control rather
   * than restated, so ordering is now a property of the backend instead of something each
   * caller has to remember.
   *
   * SHAPE, and why this is not "serialise everything":
   *   - `exec` (DDL) chains FIFO: statement N+1 starts only once N has settled.
   *   - `run` (DML) and `query` (reads) wait for the DDL backlog AS OF THE MOMENT THEY ARE
   *     ISSUED, then run concurrently with each other. Write throughput is unchanged; a write
   *     simply cannot overtake the CREATE TABLE it depends on.
   * Once the startup burst settles this is an already-resolved promise, so the steady-state
   * cost is one microtask per call.
   *
   * HONEST LIMIT: a DDL statement that exhausts its transient-error retries re-enters the chain
   * at its RETRY position, so a connection drop mid-bootstrap can still reorder around the
   * failure. Every DDL statement in this repo is `IF NOT EXISTS`-guarded and idempotent, so
   * re-running it is safe; ordering across a dropped connection is a strictly smaller problem
   * than the one being fixed here and is not claimed to be solved.
   */
  private ddl = new DdlBarrier();

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
    // Fire and forget — init schema. Resilient + loud (see trackedWrite), and ORDERED
    // (see `ddl` below: an index may never be dispatched beside the table it indexes).
    this.trackedWrite('exec', () => this.enqueueDdl(() => this.pool.query(sql)), sql, []);
  }

  run(sql: string, ...params: unknown[]): void {
    // Convert ? placeholders to $1, $2, etc. for pg
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    this.trackedWrite(
      'run',
      () => this.afterDdl(() => this.pool.query(pgSql, params)),
      pgSql,
      params,
    );
  }

  /**
   * Serialise one DDL statement behind every DDL issued before it.
   *
   * Runs `fn` whether the previous statement RESOLVED or REJECTED. A failed CREATE must not
   * wedge the rest of the schema — the barrier's job is to stop later statements OVERTAKING
   * earlier ones, not to make the schema all-or-nothing.
   */
  private enqueueDdl<T>(fn: () => Promise<T>): Promise<T> {
    return this.ddl.enqueue(fn);
  }

  /**
   * Run `fn` after the DDL issued SO FAR, without joining the chain — so reads and writes wait
   * out the schema burst once and then stay fully concurrent with each other.
   */
  private afterDdl<T>(fn: () => Promise<T>): Promise<T> {
    return this.ddl.after(fn);
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
          // SEC-14: the SQL SHAPE stays loggable (that is the diagnostic value);
          // every bound parameter and every value-bearing span of the exception
          // message is masked to len+sha16 by STRUCTURE, never by vendor prefix.
          console.error(formatWriteLossLog(label, r.attempts, r.error, sql, params));
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
    await this.drain();
    await this.pool.end().catch(() => {});
  }

  /**
   * OPS-PG-LANE-BOOTSTRAP-W1 — settle every in-flight fire-and-forget write WITHOUT closing.
   *
   * `closeAsync()` already drained, but only on the way to `pool.end()`, so there was no way to
   * ask "have my writes landed?" and keep using the handle. That gap is the second half of the
   * backend divergence this wave is about: on SQLite `dbRun` returns after the row EXISTS, on
   * Postgres it returns before the statement has even been sent. Any caller that writes and
   * then reads back — every fixture that seeds a row and counts it — is therefore correct on
   * one backend and a coin flip on the other, with nothing in the shared signature to say so.
   */
  async drain(): Promise<void> {
    // Bounded. A settled write can be followed by another the caller issued meanwhile; the cap
    // is a runaway guard, never an expected exit — a caller writing faster than the database
    // settles has a problem this method cannot solve, and spinning forever would hide it.
    for (let i = 0; i < 100 && this.pending.size > 0; i++) {
      await Promise.allSettled([...this.pending]);
    }
    await this.ddl.settled();
  }

  async query(sql: string, params: unknown[] = []): Promise<SignalRecord[]> {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    // Behind the DDL barrier: a read issued during schema bootstrap must not be answered
    // "relation does not exist" by a table that is one statement away from existing.
    const result = await this.afterDdl(() => this.pool.query(pgSql, params));
    return result.rows as SignalRecord[];
  }

  async execAsync(sql: string): Promise<void> {
    // DDL — joins the chain, same as the fire-and-forget `exec`.
    await this.enqueueDdl(() => this.pool.query(sql));
  }

  async runAsync(sql: string, ...params: unknown[]): Promise<void> {
    let idx = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++idx}`);
    await this.afterDdl(() => this.pool.query(pgSql, params));
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
// `sqliteType` is OPTIONAL and TRAILING (CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1): every existing
// descriptor is byte-unchanged and keeps resolving to `type` on both backends. It exists because
// one type string cannot always serve both dialects — `TIMESTAMPTZ` is right for Postgres but
// gives SQLite NUMERIC affinity, which would disagree with the TEXT timestamps the SQLite
// `CREATE TABLE` for that same table already declares. Two timestamp representations inside one
// table is the kind of divergence that surfaces only as a comparison quietly matching nothing.
// Absent → `type` is used verbatim, so this is inert for every incumbent row.
type MigrationDescriptor = { table: string; column: string; type: string; sqliteType?: string };

/** The type an ALTER should use on SQLite. ONE derivation, read by the runner and its test. */
export function sqliteColumnType(m: MigrationDescriptor): string {
  return m.sqliteType ?? m.type;
}

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
  // SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2 (2026-08-07): which RULE produced `regime`.
  //
  // The label rule changed at 2026-08-07T15:28:44Z. `regime` therefore means two different
  // things either side of that instant, and three consumers AGGREGATE it
  // (calibration-audit.ts, audit-thresholds-pertf-from-signals.mjs,
  // audit-r4-inversion-counterfactual.mjs). An aggregate that mixes v1 and v2 rows compares
  // two different measurements, and a delta across two instruments is not a delta — so the
  // boundary is a QUERYABLE COLUMN rather than a sentence in status.md. This repo has four
  // recorded instances of a boundary declared in prose and then silently violated.
  //
  // DEFAULT 1 is deliberate and is what makes the backfill exact rather than a guess: the
  // schema is pre-applied BEFORE the code deploys, so a row written in between is genuinely
  // v1 — the old rule was still the thing running. Only the new code writes 2, explicitly.
  // The VERSION is backfilled; the LABEL never is. Old rows say what the old rule said, and
  // that is the record.
  { table: 'signals', column: 'regime_rule_version', type: 'SMALLINT NOT NULL DEFAULT 1' },
  // SIGNAL-TREND-MODE-ENABLE-W1 CH1 (2026-08-22): which VERDICT rule produced `signal`.
  //
  // The column directly above records which rule produced the LABEL. This one is strictly worse
  // to be without, because a changed verdict rule does not merely relabel rows — IT CHANGES WHICH
  // ROWS EXIST. `recordSignal` is reached only for non-HOLD calls at or above
  // MIN_TRACKABLE_CONFIDENCE (get-trade-call.ts, the `signal !== 'HOLD' && confidence >=` gate),
  // so flipping TREND_MODE admits a different POPULATION into this table rather than a different
  // value in one field of the same population. Pooling the two generations would make the track
  // record a blend of two engines with nothing to separate them — on a record that is
  // Merkle-anchored and can never be restated.
  //
  // DEFAULT 1 is factually correct, not a convenience: every historical row was produced with
  // TREND_MODE unset. There is no backfill and none is owed.
  //
  // Pre-applied to production BEFORE this code landed (CLAUDE.md's pre-apply rule), which is safe
  // ONLY because the column is NOT NULL DEFAULT — the INSERT the deployed code was already
  // running kept working unchanged across the ALTER, and any row written in the gap is genuinely
  // v1. It also closes a real race: runPgMigrationsAsync is fire-and-forget, so without
  // pre-apply the first INSERT naming this column could beat the background ALTER, throw, and be
  // swallowed by recordSignal's caller-side catch — silent signal loss. Measured on the live
  // server: PostgreSQL 16.13, where ADD COLUMN with a NON-VOLATILE default is catalog-only
  // (PG11+) — no table rewrite and no long lock on 502,806 rows / 608 MB during serving hours.
  { table: 'signals', column: 'verdict_rule_version', type: 'SMALLINT NOT NULL DEFAULT 1' },
  // Merkle proof columns
  { table: 'signals', column: 'signal_hash', type: 'VARCHAR(66)' },
  { table: 'signals', column: 'merkle_batch_id', type: 'INTEGER' },
  { table: 'signals', column: 'merkle_proof', type: 'JSONB' },
  // OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 (2026-07-24): failure-classified
  // subscription lifecycle (additive). `BIGINT` is accepted by both backends
  // (SQLite gives it INTEGER affinity), so one type string serves both. On live
  // PG these are pre-applied via SSH before this commit → idempotent no-op here.
  { table: 'webhook_subscriptions', column: 'delivery_state', type: "TEXT NOT NULL DEFAULT 'active'" },
  { table: 'webhook_subscriptions', column: 'failure_class', type: 'TEXT' },
  { table: 'webhook_subscriptions', column: 'quarantined_at', type: 'BIGINT' },
  { table: 'webhook_subscriptions', column: 'next_probe_at', type: 'BIGINT' },
  { table: 'webhook_subscriptions', column: 'last_probe_at', type: 'BIGINT' },
  { table: 'webhook_subscriptions', column: 'last_success_at', type: 'BIGINT' },
  { table: 'webhook_subscriptions', column: 'disabled_reason', type: 'TEXT' },
  // CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1 — the contact_leads quarantine lane. Postgres twin is
  // migrations/031_contact_lead_quarantine.sql, PRE-APPLIED via SSH before that file was
  // committed, so these three are an idempotent no-op against live prod and only do real work on
  // a fresh SQLite dev/test DB.
  //
  // `spam_score` is NOT NULL DEFAULT 0, which is what makes the pre-apply safe: the INSERT the
  // deployed code was already running kept working unchanged across the ALTER, and a row written
  // in the gap is genuinely un-scored rather than wrongly-scored.
  { table: 'contact_leads', column: 'spam_score', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'contact_leads', column: 'spam_reasons', type: 'TEXT' },
  // TIMESTAMPTZ on PG to match created_at / email_sent_at on this same table; TEXT on SQLite to
  // match what that dialect's CREATE TABLE declares for those same two columns. Note this is a
  // DIFFERENT column from webhook_subscriptions.quarantined_at above (BIGINT epoch) — same word,
  // different table, deliberately not unified: they share no consumer, and forcing one
  // representation on both would mean restating one table's existing timestamps.
  { table: 'contact_leads', column: 'quarantined_at', type: 'TIMESTAMPTZ', sqliteType: 'TEXT' },
  // ── OPS-SCORER-INPUT-PERSISTENCE-W1 R1a — the scorer's inputs on the two quarantined siblings.
  //
  // EVERY ONE IS NULLABLE AND CARRIES NO DEFAULT, and that is load-bearing rather than stylistic.
  // `hold_decisions` held 628,423 rows when this landed and `band_signals` is on the live serving
  // path; a DEFAULT risks a table rewrite, while nullable-without-default is catalog-only and
  // takes ACCESS EXCLUSIVE for microseconds. NULL therefore means "written before capture
  // shipped" (or written with the kill switch off) and NEVER "capture failed" — the convention
  // migration 032 established for its own additive columns.
  //
  // `sqliteType: 'REAL'` throughout: SQLite has no SMALLINT or DOUBLE PRECISION and the fixture
  // backend only ever round-trips these, so one affinity serves both integer buckets and float
  // deltas. Prod is PG, where the declared types above are exact.
  //
  // Mirrors migrations/036_scorer_input_capture.sql. On live PG these are pre-applied via SSH
  // before the commit, so this list is an idempotent no-op there and the real schema owner for
  // the SQLite fixture backend.
  { table: 'hold_decisions', column: 'rsi_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'ema_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'funding_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'oi_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'volume_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'raw0', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'funding_delta', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'hurst_delta', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'squeeze_delta', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'raw_final', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'funding_adjust_code', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'hurst_adjust_code', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'hold_decisions', column: 'squeeze_adjust_code', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'rsi_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'ema_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'funding_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'oi_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'volume_score', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'raw0', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'funding_delta', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'hurst_delta', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'squeeze_delta', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'raw_final', type: 'DOUBLE PRECISION', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'funding_adjust_code', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'hurst_adjust_code', type: 'SMALLINT', sqliteType: 'REAL' },
  { table: 'band_signals', column: 'squeeze_adjust_code', type: 'SMALLINT', sqliteType: 'REAL' },
  // ── OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the producer's own write stamp + a DURABLE breaker.
  //
  // `outcome_filled_at` is the column `OPS-RECALIBRATE-HARNESS-RETIRE-W1` probe #11 found missing
  // and substituted for. Its absence is why `outcome-backfill-freshness` had to key on
  // `max(created_at) FILTER (pfe_return_pct IS NOT NULL)` — the birth time of the newest matured
  // signal, which is the SUM of backfill staleness and the emitted population's maturation
  // horizon and cannot separate them. The name is NOT invented: `equity_verdicts` already carries
  // `outcome_filled_at` for the same quantity, so this is one vocabulary, not two.
  //
  // `outcome_attempts` / `outcome_last_attempt_at` are the DURABLE half of a breaker that was
  // process-local. `backfill-outcomes.ts` keeps a `failCounts` Map with MAX_FAIL_PER_SYMBOL=3 —
  // but it resets on every 3-minute fire, AND it never sees the dominant failure at all: a
  // "no candles after signal time" result increments `skipped`, never `failCounts`. Measured
  // 2026-09-05: 3,058 rows whose barrier closed >24h ago (2,574 >7d) sat at the head of the
  // `ORDER BY created_at ASC LIMIT 5000` queue being re-fetched and re-skipped on EVERY batch —
  // `Batch 67 done: 11 filled, 2037 skipped, 0 errors`. With the NULL backlog at 11,748-11,823
  // against that 5,000 cap the window's newest row was 07:16Z, so every fresher signal was
  // structurally invisible to the producer and the 12.1h that paged was the age of the QUEUE
  // FRONTIER, not the producer's last write.
  //
  // THE BREAKER IS A BACKOFF, NOT A TOMBSTONE (Data Integrity LAW). The queue excludes a row only
  // while `outcome_attempts >= N AND outcome_last_attempt_at > now - cooldown`; after the
  // cooldown it re-enters. A permanent exclusion would zero rows that become fillable when a
  // sparse market reopens — CXMT/SPCX/SKHY/DRAM/CBRS/NBIS are exactly that shape (CXMT: 692 of
  // 1,369 rows DID fill) — which is deleting public-facing data by side effect.
  //
  // All three nullable with no DEFAULT: catalog-only on PG (microseconds of ACCESS EXCLUSIVE on a
  // ~598k-row table), which is what makes the CLAUDE.md pre-apply-via-SSH safe here. NULL means
  // "written before this shipped", never "the producer failed" — and the re-keyed canary must
  // therefore report INDETERMINATE on an all-NULL `max(outcome_filled_at)`, never PASS.
  //
  // INTEGER epoch to match `created_at` on this same table, so the canary's window arithmetic
  // stays plain integer maths with no timezone to get wrong.
  { table: 'signals', column: 'outcome_filled_at', type: 'INTEGER' },
  { table: 'signals', column: 'outcome_attempts', type: 'INTEGER' },
  { table: 'signals', column: 'outcome_last_attempt_at', type: 'INTEGER' },
];

/**
 * OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the backfill queue's own constants, exported as DATA.
 *
 * THREE consumers must agree on these and a second literal is the generator bug: the queue
 * predicate in `getSignalsNeedingUnifiedBackfillAsync`, the `outcome-backfill-freshness`
 * REACHABILITY arm (which compares an UNCAPPED backlog count against this exact cap), and the A2
 * drain gate. A canary hardcoding its own `5000` would report healthy against a producer reading
 * a different number — the duplicated-fact class this estate has already paid for twice.
 */
export const BACKFILL_QUEUE_LIMIT = 5000;
/** Attempts after which a row is held out of the queue for `BACKFILL_ATTEMPT_COOLDOWN_S`. */
export const BACKFILL_MAX_ATTEMPTS = 3;
/**
 * How long a maxed-out row stays OUT of the queue before it is retried. Never forever.
 *
 * 24h, derived from the measured sediment rather than picked round: at probe time 3,058 NULL rows
 * had barriers closed >24h and 2,574 >7d, so a 24h cooldown re-admits the whole 7d-plus body once
 * a day — soon enough to catch a reopened market on its next session, and cheap enough that a
 * full re-attempt sweep costs ~3,058 x 300ms ~ 15 min of one run per day instead of ~2,037 wasted
 * fetches in every batch of every run.
 *
 * Instrument, recorded beside the number: `SELECT count(*) FROM signals WHERE outcome_price IS
 * NULL AND created_at + horizon + 86400 <= now()` as `aoe_readonly` on
 * `crypto-quant-signal-mcp-postgres-1`, signal-1, 2026-09-05T18:20:56Z.
 *
 * TODO: revisit by 2026-10-05 — re-derive from the sediment series once the canary's reachability
 * arm has published a fortnight of `sediment_24h` counts. Register row in
 * `Claude files/defensive-reductions-to-revisit.md`.
 */
export const BACKFILL_ATTEMPT_COOLDOWN_S = 86_400;

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
    b.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${sqliteColumnType(m)};`);
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

// OPS-HOLD-DECISION-CAPTURE-W1 R1/R2 — schema-as-code mirror of `migrations/032`.
//
// The migration file is the SoT and carries the full reasoning (why a dedicated id space, why the
// unique index IS the sampler, why `suppression_reason` ships before it has rows). This block
// exists so fresh deploys and SQLite test fixtures inherit the tables without running migrations;
// on live PG it is a no-op against a DB prepared via SSH before the commit landed.
//
// TWO BACKENDS, ONE SEMANTIC. SQLite has no BIGSERIAL and no TIMESTAMPTZ; `INTEGER PRIMARY KEY
// AUTOINCREMENT` gives the same monotonic, never-reused id space, which is the property that
// matters here — an id that cannot be confused with `signals.id` or `request_log.id`.
const CREATE_HOLD_DECISIONS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS hold_decisions (
      decision_id        BIGSERIAL PRIMARY KEY,
      captured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at         INTEGER NOT NULL,
      coin               TEXT NOT NULL,
      timeframe          TEXT NOT NULL,
      exchange           TEXT,
      regime             TEXT,
      would_be_side      SMALLINT NOT NULL,
      confidence         SMALLINT NOT NULL,
      price_at_decision  DOUBLE PRECISION NOT NULL,
      arm                TEXT NOT NULL,
      is_bot_internal    BOOLEAN,
      suppression_reason TEXT NOT NULL,
      CONSTRAINT hold_decisions_side_ck   CHECK (would_be_side IN (-1, 0, 1)),
      CONSTRAINT hold_decisions_arm_ck    CHECK (arm IN ('request', 'fleet')),
      CONSTRAINT hold_decisions_reason_ck CHECK (suppression_reason IN ('below_threshold', 'book_liveness'))
    );`
  : `CREATE TABLE IF NOT EXISTS hold_decisions (
      decision_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at        TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at         INTEGER NOT NULL,
      coin               TEXT NOT NULL,
      timeframe          TEXT NOT NULL,
      exchange           TEXT,
      regime             TEXT,
      would_be_side      INTEGER NOT NULL,
      confidence         INTEGER NOT NULL,
      price_at_decision  REAL NOT NULL,
      arm                TEXT NOT NULL,
      is_bot_internal    INTEGER,
      suppression_reason TEXT NOT NULL,
      CHECK (would_be_side IN (-1, 0, 1)),
      CHECK (arm IN ('request', 'fleet')),
      CHECK (suppression_reason IN ('below_threshold', 'book_liveness'))
    );`;

// The fleet arm's sampler. `ON CONFLICT DO NOTHING` against this index is what bounds the
// ~437k/day firehose to one row per (UTC day × venue × coin × timeframe × confidence-decile ×
// regime) — breadth-first, because distinct (venue, coin) CLUSTERS are the binding constraint on
// the pre-registered analysis, not row count. COALESCE because NULLs compare DISTINCT in a unique
// index, so NULL-venue rows would otherwise bypass the quota entirely.
const CREATE_HOLD_DECISIONS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_hold_decisions_scan
    ON hold_decisions (exchange, coin, timeframe, decided_at);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_hold_decisions_fleet_cell
    ON hold_decisions (
      (decided_at / 86400), COALESCE(exchange, ''), coin, timeframe,
      (confidence / 10), COALESCE(regime, '')
    ) WHERE arm = 'fleet';
`;

// QUARANTINE. HOLD labels are counterfactual — they score a trade the engine deliberately did not
// make — and must NEVER reach `directional_labels`, the corpus behind the DWR baseline and the
// published track record. The FK column is `hold_decision_id`, never `signal_id`: `request_log.id`
// and `signals.id` numerically OVERLAP (measured ~355k vs ~512k), so a HOLD row carrying either
// into `directional_labels` would join SILENTLY to an unrelated acted signal. The declared
// REFERENCES makes a wrong id fail loudly at INSERT instead of joining wrongly at SELECT.
const CREATE_HOLD_DECISION_LABELS_SQL = `
  CREATE TABLE IF NOT EXISTS hold_decision_labels (
    hold_decision_id  ${process.env.DATABASE_URL ? 'BIGINT' : 'INTEGER'} NOT NULL REFERENCES hold_decisions(decision_id) ON DELETE CASCADE,
    barrier_spec      TEXT NOT NULL,
    label             SMALLINT NOT NULL,
    ambiguous_candle  BOOLEAN NOT NULL DEFAULT FALSE,
    low_vol_history   BOOLEAN NOT NULL DEFAULT FALSE,
    t_hit_candles     INT,
    mfe_return_pct    DOUBLE PRECISION,
    mae_return_pct    DOUBLE PRECISION,
    barrier_pct       DOUBLE PRECISION NOT NULL,
    computed_at       ${process.env.DATABASE_URL ? 'TIMESTAMPTZ NOT NULL DEFAULT now()' : "TEXT NOT NULL DEFAULT (datetime('now'))"},
    PRIMARY KEY (hold_decision_id, barrier_spec)
  );
  CREATE INDEX IF NOT EXISTS idx_hold_labels_spec_decision
    ON hold_decision_labels (barrier_spec, hold_decision_id);
`;

// ── OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2 — schema-as-code mirror of `migrations/035` ──
//
// The migration file is the SoT and carries the full reasoning. This block exists so fresh
// deploys and SQLite test fixtures inherit the tables without running migrations; on live PG it
// is a no-op against a DB prepared via SSH before the commit landed.
//
// WHAT THIS TABLE IS. The directional calls the engine EMITS and has never recorded:
// `recordSignal` persists only at `confidence >= MIN_TRACKABLE_CONFIDENCE`, while BUY emits from
// confidence 45, so 62.27% of all request-path BUYs are handed to a paying caller and written
// nowhere (measured on `request_log` 2026-08-30, n=2197).
//
// WHAT IT IS NOT, AND THE ABSENCE IS THE DESIGN. There is no `signal_hash`, no `merkle_batch_id`
// and no `merkle_proof` column. `getUnbatchedSignals()` selects `WHERE signal_hash IS NOT NULL
// AND merkle_batch_id IS NULL` and `publish-merkle-batch.ts` anchors the result to Base L2; a
// band row is therefore unanchorable BY CONSTRUCTION rather than by a guard someone has to
// remember. Adding any of the three re-opens on-chain publication for rows that must never be
// published, and an anchored batch has no undo.
//
// TWO BACKENDS, ONE SEMANTIC. SQLite has no BIGSERIAL, SMALLINT or TIMESTAMPTZ; `INTEGER PRIMARY
// KEY AUTOINCREMENT` gives the same monotonic never-reused id space, which is the property that
// matters — a `band_id` that cannot be confused with `signals.id` or `request_log.id`.
//
// The CHECK is built from MIN_TRACKABLE_CONFIDENCE, never a second literal: the band IS "below
// the recording gate", so a row at or above it belongs in `signals` and misfiling one here would
// quietly build a comparison corpus overlapping the published one.
const CREATE_BAND_SIGNALS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS band_signals (
      band_id              BIGSERIAL PRIMARY KEY,
      captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      coin                 TEXT NOT NULL,
      signal               TEXT NOT NULL,
      confidence           SMALLINT NOT NULL,
      timeframe            TEXT NOT NULL,
      exchange             TEXT NOT NULL DEFAULT 'HL',
      price_at_signal      REAL NOT NULL,
      created_at           INTEGER NOT NULL,
      regime               TEXT,
      regime_rule_version  SMALLINT NOT NULL DEFAULT 1,
      verdict_rule_version SMALLINT NOT NULL DEFAULT 1,
      outcome_price        REAL,
      outcome_return_pct   REAL,
      return_1candle       REAL,
      pfe_price            REAL,
      pfe_return_pct       REAL,
      mae_price            REAL,
      mae_return_pct       REAL,
      pfe_candles          INTEGER,
      arm                  TEXT NOT NULL,
      is_bot_internal      BOOLEAN,
      CONSTRAINT band_signals_signal_ck CHECK (signal IN ('BUY', 'SELL')),
      CONSTRAINT band_signals_arm_ck    CHECK (arm IN ('request', 'fleet')),
      CONSTRAINT band_signals_below_gate_ck CHECK (confidence >= 0 AND confidence < ${MIN_TRACKABLE_CONFIDENCE})
    );`
  : `CREATE TABLE IF NOT EXISTS band_signals (
      band_id              INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at          TEXT NOT NULL DEFAULT (datetime('now')),
      coin                 TEXT NOT NULL,
      signal               TEXT NOT NULL,
      confidence           INTEGER NOT NULL,
      timeframe            TEXT NOT NULL,
      exchange             TEXT NOT NULL DEFAULT 'HL',
      price_at_signal      REAL NOT NULL,
      created_at           INTEGER NOT NULL,
      regime               TEXT,
      regime_rule_version  INTEGER NOT NULL DEFAULT 1,
      verdict_rule_version INTEGER NOT NULL DEFAULT 1,
      outcome_price        REAL,
      outcome_return_pct   REAL,
      return_1candle       REAL,
      pfe_price            REAL,
      pfe_return_pct       REAL,
      mae_price            REAL,
      mae_return_pct       REAL,
      pfe_candles          INTEGER,
      arm                  TEXT NOT NULL,
      is_bot_internal      INTEGER,
      CHECK (signal IN ('BUY', 'SELL')),
      CHECK (arm IN ('request', 'fleet')),
      CHECK (confidence >= 0 AND confidence < ${MIN_TRACKABLE_CONFIDENCE})
    );`;

const CREATE_BAND_SIGNALS_INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_band_signals_scan
    ON band_signals (exchange, coin, timeframe, created_at);
  CREATE INDEX IF NOT EXISTS idx_band_signals_pending_outcome
    ON band_signals (created_at) WHERE outcome_price IS NULL;
`;

// QUARANTINE, and the key is the whole point. Keys on `band_id`, NEVER `signal_id`:
// `request_log.id` (~355k) and `signals.id` (~524k) numerically OVERLAP, so an id from the wrong
// space inserted into `directional_labels` — the corpus behind the DWR baseline and the published
// track record — would JOIN SILENTLY to an unrelated acted signal. `band_id` is a third dedicated
// id space; the declared REFERENCES makes a wrong id fail loudly at INSERT rather than join
// wrongly at SELECT.
const CREATE_BAND_SIGNAL_LABELS_SQL = `
  CREATE TABLE IF NOT EXISTS band_signal_labels (
    band_id           ${process.env.DATABASE_URL ? 'BIGINT' : 'INTEGER'} NOT NULL REFERENCES band_signals(band_id) ON DELETE CASCADE,
    barrier_spec      TEXT NOT NULL,
    label             SMALLINT NOT NULL,
    ambiguous_candle  BOOLEAN NOT NULL DEFAULT FALSE,
    low_vol_history   BOOLEAN NOT NULL DEFAULT FALSE,
    t_hit_candles     INT,
    mfe_return_pct    DOUBLE PRECISION,
    mae_return_pct    DOUBLE PRECISION,
    barrier_pct       DOUBLE PRECISION NOT NULL,
    computed_at       ${process.env.DATABASE_URL ? 'TIMESTAMPTZ NOT NULL DEFAULT now()' : "TEXT NOT NULL DEFAULT (datetime('now'))"},
    PRIMARY KEY (band_id, barrier_spec)
  );
  CREATE INDEX IF NOT EXISTS idx_band_labels_spec_band
    ON band_signal_labels (barrier_spec, band_id);
`;

// ── OPS-SCORER-INPUT-PERSISTENCE-W1 R1b: the EMITTED arm's sibling table. ──
//
// The other two arms carry their parts as columns because they are already quarantined siblings.
// This arm's parent is `signals`, the ANCHORED table, which this wave does not touch — so its
// parts live here instead.
//
// ⚠ NO `merkle_batch_id`, NO `merkle_proof`. `getUnbatchedSignals()` selects `FROM signals`, so
// this table is outside the anchor path BY CONSTRUCTION rather than by a guard someone maintains.
// `signal_hash` is present only as a join key back to the parent.
//
// Mirrors migrations/036_scorer_input_capture.sql; that file is the PG owner and this is the
// SQLite fixture owner. The UNIQUE key is `(signal_hash, exchange)`, not the hash alone —
// `hashSignal`'s preimage carries no venue, and 5 measured cross-venue collisions would otherwise
// lose one side's parts to `ON CONFLICT DO NOTHING`.
const CREATE_SIGNAL_SCORER_INPUTS_SQL = `
  CREATE TABLE IF NOT EXISTS signal_scorer_inputs (
    scorer_input_id      ${process.env.DATABASE_URL ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
    captured_at          ${process.env.DATABASE_URL ? 'TIMESTAMPTZ NOT NULL DEFAULT now()' : "TEXT NOT NULL DEFAULT (datetime('now'))"},
    decided_at           INTEGER NOT NULL,
    signal_hash          TEXT NOT NULL,
    coin                 TEXT NOT NULL,
    signal               TEXT NOT NULL,
    confidence           ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    timeframe            TEXT NOT NULL,
    exchange             TEXT NOT NULL,
    regime               TEXT,
    arm                  TEXT NOT NULL,
    is_bot_internal      BOOLEAN,
    verdict_rule_version ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL DEFAULT 1,
    rsi_score            ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    ema_score            ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    funding_score        ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    oi_score             ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    volume_score         ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    raw0                 ${process.env.DATABASE_URL ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL,
    funding_delta        ${process.env.DATABASE_URL ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL,
    hurst_delta          ${process.env.DATABASE_URL ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL,
    squeeze_delta        ${process.env.DATABASE_URL ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL,
    raw_final            ${process.env.DATABASE_URL ? 'DOUBLE PRECISION' : 'REAL'} NOT NULL,
    funding_adjust_code  ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    hurst_adjust_code    ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    squeeze_adjust_code  ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'} NOT NULL,
    CONSTRAINT signal_scorer_inputs_signal_ck CHECK (signal IN ('BUY', 'SELL')),
    CONSTRAINT signal_scorer_inputs_arm_ck    CHECK (arm IN ('request', 'fleet'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_scorer_inputs_hash_exchange
    ON signal_scorer_inputs (signal_hash, exchange);
  CREATE INDEX IF NOT EXISTS idx_signal_scorer_inputs_scan
    ON signal_scorer_inputs (exchange, coin, timeframe, decided_at);
`;

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

// OPS-SEC-DB-LEAST-PRIV-W2: guarded on ownership, because `CREATE INDEX` checks the
// relation's OWNER *before* the `IF NOT EXISTS` short-circuit — so on prod, where the
// matview is owned by `algovault_autopilot` (that role owns it so its postgres-CPU
// recovery action can `REFRESH`, and so the 5-min host cron can refresh as the true
// owner rather than borrowing superuser), a bare CREATE INDEX raises
// `must be owner of materialized view` on EVERY schema-ensure. That was invisible while
// the app connected as the bootstrap superuser, which bypasses the check entirely.
// The index already exists there, so the statement was pure noise on a fire-and-forget
// `exec` — it surfaced as `[pg-write] WRITE LOST`, which is exactly the shape of a real
// lost write and would have trained the eye to ignore it.
// The fresh-box path is unchanged: whoever CREATEs the matview owns it, so the guard
// passes and the unique index (required by REFRESH ... CONCURRENTLY) is created.
const CREATE_FUNDING_STATS_MATVIEW_INDEX_SQL = `
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_class c
       WHERE c.relname = 'funding_stats_14d'
         AND pg_catalog.pg_get_userbyid(c.relowner) = current_user
    ) THEN
      CREATE UNIQUE INDEX IF NOT EXISTS funding_stats_14d_coin_uk ON funding_stats_14d (coin);
    END IF;
  END $$;
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

// CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1 — the first lead-capture surface AlgoVault has.
//
// Replaces a `mailto:` CTA that was dead in two independent ways: Cloudflare rewrites every
// `mailto:` on every page into `/cdn-cgi/l/email-protection#…` (measured — ZERO plain mailto
// survives to a browser), and even fully decoded it needs an OS mail handler the visitor may
// not have. The highest-value CTA on the pricing surface depended on desktop configuration.
//
// `intent` is NOT `enterprise`-only by construction (operator decision, 2026-08-05): a public
// form catches non-enterprise enquiries on day one, so the column exists from the start and the
// enterprise subset stays queryable. A rename later would be worse than a correct name now.
//
// `email_sent_at` / `email_error` record the NOTIFY outcome separately from the CAPTURE, which
// is the whole point of the ordering: persist first, send second. A Resend outage becomes a
// recorded retry candidate instead of a lost lead.
const CREATE_CONTACT_LEADS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS contact_leads (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NULL,
      monthly_volume TEXT NULL,
      message TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT 'enterprise',
      src TEXT NULL,
      ip_hash TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      email_sent_at TIMESTAMPTZ NULL,
      email_error TEXT NULL,
      spam_score INTEGER NOT NULL DEFAULT 0,
      spam_reasons TEXT NULL,
      quarantined_at TIMESTAMPTZ NULL
    );`
  : `CREATE TABLE IF NOT EXISTS contact_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT NULL,
      monthly_volume TEXT NULL,
      message TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT 'enterprise',
      src TEXT NULL,
      ip_hash TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      email_sent_at TEXT NULL,
      email_error TEXT NULL,
      spam_score INTEGER NOT NULL DEFAULT 0,
      spam_reasons TEXT NULL,
      quarantined_at TEXT NULL
    );`;

const CREATE_CONTACT_LEADS_CREATED_AT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_leads_created_at ON contact_leads (created_at);
`;

const CREATE_CONTACT_LEADS_INTENT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_leads_intent ON contact_leads (intent);
`;

// CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1 — twins of migrations/031_contact_lead_quarantine.sql.
//
// Composite rather than a bare ip_hash index: the ip-velocity lookback is always (equality on
// ip_hash) AND (range on created_at), so the second column turns an index scan + filter into a
// range scan.
const CREATE_CONTACT_LEADS_IP_CREATED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_leads_ip_created ON contact_leads (ip_hash, created_at);
`;

// PARTIAL. quarantined_at is NULL for every legitimate lead and a B-tree stores NULLs, so on a
// table whose healthy steady state is almost entirely NULL here, indexing them is pure insert-time
// overhead. Both backends accept this syntax (PostgreSQL; SQLite since 3.8.0, and this repo runs
// better-sqlite3 11.10.0 / SQLite 3.49.2).
const CREATE_CONTACT_LEADS_QUARANTINED_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_contact_leads_quarantined ON contact_leads (quarantined_at)
    WHERE quarantined_at IS NOT NULL;
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
      top_n INTEGER NULL,
      delivery_state TEXT NOT NULL DEFAULT 'active',
      failure_class TEXT NULL,
      quarantined_at BIGINT NULL,
      next_probe_at BIGINT NULL,
      last_probe_at BIGINT NULL,
      last_success_at BIGINT NULL,
      disabled_reason TEXT NULL
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
      top_n INTEGER NULL,
      delivery_state TEXT NOT NULL DEFAULT 'active',
      failure_class TEXT NULL,
      quarantined_at INTEGER NULL,
      next_probe_at INTEGER NULL,
      last_probe_at INTEGER NULL,
      last_success_at INTEGER NULL,
      disabled_reason TEXT NULL
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

// OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 (R4.3) — the subscriber-notification
// idempotency ledger. Mirrors `processed_stripe_events`: the claim is taken BEFORE
// the send, so a retried tick cannot mail a customer twice.
//
//   - notification_key = `${event}:${ownerKey}:${subscriptionId}:${stateEpochBucket}`
//     The bucket makes the key stable for ONE lifecycle occurrence: a sub that is
//     quarantined, recovers, and is quarantined again gets a NEW key (new
//     quarantined_at) and is therefore notified again — correctly.
//   - `outcome` records what actually happened, so the Detect half of
//     Detect→Recover→Alert→Escalate is a query, not a log grep.
//   - NEVER stores the subscriber URL or secret (a webhook URL can embed an auth
//     token). owner_key is stored because it is already this table's tenant key
//     and lives beside webhook_subscriptions.owner_key.
//   - On live PG the table is pre-applied via SSH BEFORE this commit lands
//     (CLAUDE.md schema sequencing); `IF NOT EXISTS` makes the deploy a no-op.
const CREATE_SUBSCRIBER_NOTIFICATIONS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS subscriber_notifications (
      notification_key TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      event TEXT NOT NULL,
      subscription_id BIGINT NULL,
      sent_at BIGINT NOT NULL,
      resend_id TEXT NULL,
      outcome TEXT NOT NULL
    );`
  : `CREATE TABLE IF NOT EXISTS subscriber_notifications (
      notification_key TEXT PRIMARY KEY,
      owner_key TEXT NOT NULL,
      event TEXT NOT NULL,
      subscription_id INTEGER NULL,
      sent_at INTEGER NOT NULL,
      resend_id TEXT NULL,
      outcome TEXT NOT NULL
    );`;

const CREATE_SUBSCRIBER_NOTIFICATIONS_OWNER_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_subscriber_notifications_owner ON subscriber_notifications (owner_key, sent_at);
`;

const CREATE_SUBSCRIBER_NOTIFICATIONS_OUTCOME_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_subscriber_notifications_outcome ON subscriber_notifications (outcome, sent_at);
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
  // OPS-HOLD-DECISION-CAPTURE-W1 R1/R2. Same pre-apply contract as emit_suppressions above: the
  // live PG tables are created via SSH BEFORE this commit lands, so this is a no-op there and a
  // real create for fresh deploys and SQLite fixtures. Indexes are a separate exec because the
  // unique index is the fleet sampler — if it ever failed to create, the table would silently
  // accept the whole firehose, so it must not be buried inside the table DDL's success.
  backend.exec(CREATE_HOLD_DECISIONS_SQL);
  backend.exec(CREATE_HOLD_DECISIONS_INDEXES_SQL);
  backend.exec(CREATE_HOLD_DECISION_LABELS_SQL);
  // OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2. Same pre-apply contract as the two blocks above:
  // `migrations/035` was applied to live PG via SSH before this commit landed, so this is a no-op
  // there and a real create for fresh deploys and SQLite fixtures.
  backend.exec(CREATE_BAND_SIGNALS_SQL);
  backend.exec(CREATE_BAND_SIGNALS_INDEXES_SQL);
  backend.exec(CREATE_BAND_SIGNAL_LABELS_SQL);
  backend.exec(CREATE_MERKLE_BATCHES_SQL);
  backend.exec(CREATE_SIGNAL_SCORER_INPUTS_SQL);
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
  backend.exec(CREATE_CONTACT_LEADS_SQL);
  backend.exec(CREATE_CONTACT_LEADS_CREATED_AT_INDEX_SQL);
  backend.exec(CREATE_CONTACT_LEADS_INTENT_INDEX_SQL);
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
  // OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 (2026-08-01): subscriber-notification
  // idempotency ledger. Pre-applied to live PG via SSH before this commit;
  // IF NOT EXISTS = no-op there.
  backend.exec(CREATE_SUBSCRIBER_NOTIFICATIONS_SQL);
  backend.exec(CREATE_SUBSCRIBER_NOTIFICATIONS_OWNER_INDEX_SQL);
  backend.exec(CREATE_SUBSCRIBER_NOTIFICATIONS_OUTCOME_INDEX_SQL);
  runMigrations(backend, isPg);
  // CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1 — the two quarantine-lane indexes. Placed AFTER
  // runMigrations, and that ordering is load-bearing rather than tidiness: both index a column
  // this wave ADDS, so on a pre-existing SQLite database (every dev machine and every test
  // fixture created before this wave) the table exists WITHOUT it and `CREATE INDEX … ON
  // contact_leads (quarantined_at)` throws `no such column` if it runs first. runMigrations is
  // synchronous on SQLite, so after this line the column is guaranteed present. Same reasoning
  // and same placement as the delivery_state backfill directly below.
  backend.exec(CREATE_CONTACT_LEADS_IP_CREATED_INDEX_SQL);
  backend.exec(CREATE_CONTACT_LEADS_QUARANTINED_INDEX_SQL);
  // OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 (2026-07-24): one-time idempotent
  // backfill of legacy one-way-disabled subs (active=false but still at the
  // DEFAULT delivery_state='active') → 'quarantined' so C4's health-probe sweep
  // re-adjudicates them LIVE rather than force-churning a paying subscriber
  // (Mr.1 Q2). Runs AFTER runMigrations so the columns exist (SQLite sync; PG
  // pre-applied via SSH before this commit / fresh-created above). Guarded WHERE
  // ⇒ no-op once converted; single tiny UPDATE. The store's
  // backfillLegacyWebhookLifecycle() is the byte-equivalent testable twin.
  {
    const nowSec = Math.floor(Date.now() / 1000);
    const falseLit = isPg ? 'FALSE' : '0';
    backend.exec(
      `UPDATE webhook_subscriptions
          SET delivery_state = 'quarantined', failure_class = 'legacy',
              quarantined_at = ${nowSec}, next_probe_at = ${nowSec}
        WHERE active = ${falseLit} AND delivery_state = 'active';`,
    );
  }
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

/**
 * OPS-PG-LANE-BOOTSTRAP-W1 — resolve once every fire-and-forget write issued SO FAR has
 * settled, leaving the handle open.
 *
 * `dbRun()` and `dbExec()` share one signature across two backends with two different
 * happens-before contracts: on SQLite the row exists when the call returns, on Postgres the
 * statement has not been sent yet. Read-after-write is therefore correct on one and a race on
 * the other, and there is nothing in the type to warn a caller — which is how three assertions
 * in `tests/unit/band-population-invariance.test.ts` came to fail non-deterministically on the
 * Postgres lane while being sound on SQLite.
 *
 * Deliberately a no-op on SQLite and when no backend is open, so a caller writes ONE line that
 * is correct on both backends rather than branching on `process.env.DATABASE_URL`. This is NOT
 * on the read path by design: draining inside `dbQuery()` would make every read wait out a
 * retrying write (up to ~3s of backoff) and put a serving path at the mercy of the write queue.
 */
export async function awaitDbWrites(): Promise<void> {
  const b = backend;
  if (b instanceof PgBackend) await b.drain();
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

/**
 * The rule that produced a `signals.regime` value. Bumped ONLY when the label's MEANING
 * changes, never for a refactor — a version that moves without a meaning change makes every
 * consumer's version filter useless.
 *
 * 1 = the pre-2026-08-07 rule: `emaCross` ANDed with an RSI band, `RANGING` as the fallthrough.
 * 2 = SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2: separation band + 12-bar confirmation, no RSI term.
 *     NEVER LANDED — that branch stayed local-only and is published for the record at
 *     `origin/signal-regime-label-rule-fix-w1-v2`. No production row carries 2, and CH4 asserts
 *     that count is 0. The number is burned rather than reused: reusing it would make two
 *     different corpora indistinguishable to a version filter, which is the whole point of the
 *     column.
 * 3 = SIGNAL-TREND-BLINDNESS-FIX-W1: rule 2's axis, consumed from that branch and landed, with
 *     `regime` additionally read by the scorer (CH3). The axis semantics differ from anything that
 *     has run in production, so CH4 can partition without inviting an H5 measurement artifact.
 */
export const REGIME_RULE_VERSION = 3;

/**
 * The instant rule 2 would have gone live. HISTORICAL — rule 2 never landed, so this constant
 * labels nothing and is kept only so the branch's reasoning survives with it.
 *
 * There is deliberately NO `REGIME_RULE_V3_CUTOVER_UTC`, and the asymmetry is the point: a cutover
 * timestamp solves BACKFILL — labelling rows written before the column existed — and rule 3 has no
 * such rows. New rows are stamped by the WRITER below, which knows which rule it is running, so the
 * deploy instant is irrelevant and the schema-applied-before-code window resolves itself: a row
 * written by v1 code carries v1, full stop. A hardcoded best-estimate would instead be a number
 * that LIES whenever the deploy slips, with "correct it in status.md" as its only remedy — which is
 * prose-as-control, the pattern this manual retired.
 */
export const REGIME_RULE_V2_CUTOVER_UTC = '2026-08-07T15:28:44Z';

/**
 * The rule that produced a row's VERDICT. A FUNCTION rather than a constant, and that is the
 * whole point of it.
 *
 * 1 = `TREND_MODE` off — the contrarian RSI ladder in every regime. Every row written before
 *     SIGNAL-TREND-MODE-ENABLE-W1 carries it, correctly, through the column's DEFAULT.
 * 2 = `TREND_MODE` on — a CONFIRMED trend flips the saturated RSI region's sign. Blast radius is
 *     one rung of one ladder inside TRENDING_UP / TRENDING_DOWN; RANGING is untouched.
 *
 * WHY NOT A BUILD-TIME CONSTANT. `TREND_MODE` is an env var, so it moves with no deploy and no
 * diff — deliberately, because that is the revert path. A constant baked at build time would keep
 * stamping 1 while the engine ran rule 2, producing v1-stamped v2 rows: exactly the failure this
 * column exists to prevent, and undetectable after the fact. `getTrendMode()` reads `process.env`
 * per call and caches nothing, so this reads the flag's LIVE value at write time.
 *
 * WHY NO CUTOVER TIMESTAMP, for the same reason rule 3 above has none: a cutover constant solves
 * BACKFILL — labelling rows written before the column existed — and there are none to label, since
 * DEFAULT 1 already labels them correctly. A hardcoded best-estimate instead LIES whenever the
 * deploy slips, with `status.md` as its only remedy, which is prose-as-control.
 *
 * EXTENSION CONTRACT (single-derivation LAW). Every future verdict-rule change adds its case HERE
 * and ONLY here — a threshold move, a `WEIGHTS` retune, a bucket-ladder edit, and above all an AOE
 * weight promotion (`src/lib/aoe-config-reader.ts`), which is runtime-mutable by design and so
 * leaves no diff anywhere to observe. A second site deriving "which verdict rule ran" WILL drift
 * from this one. Note the limit honestly: an AOE promotion additionally needs an `aoe_config_id`
 * companion column, because a version number alone cannot say WHICH promoted vector produced a row.
 */
export function currentVerdictRuleVersion(): 1 | 2 {
  return getTrendMode() === 'on' ? 2 : 1;
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
    `INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, signal_hash, regime, regime_rule_version, verdict_rule_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    coin, signal, confidence, timeframe, exchange, priceAtSignal, createdAt, signalHash || null, regime ?? null,
    REGIME_RULE_VERSION,
    // Evaluated HERE, at write time, never hoisted to a module constant — see
    // currentVerdictRuleVersion(). Note what is NOT touched: the Merkle leaf preimage is exactly
    // (coin, signal, confidence, timeframe, timestamp, price) per hashSignal() in lib/merkle.ts,
    // so neither this column nor its value can move any anchored root.
    currentVerdictRuleVersion()
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
 * OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2 — the band writer.
 *
 * Records a directional call the engine EMITTED but `recordSignal` refuses: `signal != 'HOLD'`
 * with `confidence < MIN_TRACKABLE_CONFIDENCE`. Measured on `request_log` 2026-08-30, 1368 of
 * 2197 emitted BUYs all-time (62.27%) fall here, are delivered to a paying caller, and were
 * written nowhere before this function existed.
 *
 * THIS IS NOT `recordSignal` WITH A DIFFERENT TABLE NAME, and three differences are load-bearing:
 *
 *  1. NO `signalHash` PARAMETER. `band_signals` has no `signal_hash` column, so there is nothing
 *     to pass and nothing to forget. A band row cannot enter the Merkle anchor path because the
 *     column `getUnbatchedSignals()` selects on does not exist on this table.
 *  2. NO WEBHOOK HOOK. `recordSignal` fires `onSignalRecorded` behind `WEBHOOK_DELIVERY_ENABLED`.
 *     A band call was never delivered as a subscribable event and must not become one — these
 *     rows are a measurement corpus, not a product surface.
 *  3. AN `arm`. `request` = a paying caller received this call; `fleet` = the seeder generated it.
 *     The claim this corpus exists to test is about what CALLERS receive, so the two populations
 *     must be separable at analysis time. `request_log` sees only the request arm and
 *     `seed-signals.ts` never touches it, so the distinction is recorded here or nowhere.
 *
 * Everything else mirrors `recordSignal` exactly — same column names, same types, same
 * `created_at` unit (epoch seconds), same rule-version stamping evaluated at WRITE time rather
 * than hoisted to a module constant. The eventual band-vs-tracked comparison has to be a
 * difference in the DATA, never an artifact of two different writers.
 *
 * UNSAMPLED, deliberately, unlike `hold_decisions`. That table samples because the fleet HOLD arm
 * is ~437k rows/day; the band is estimated at 5.6k-8.9k/day against a tracked stream of ~2,820,
 * two orders of magnitude smaller, so full capture is affordable and a sampler would only add a
 * selection effect to a corpus whose entire purpose is to be unbiased.
 */
export function recordBandSignal(
  coin: string,
  signal: SignalVerdict,
  confidence: number,
  timeframe: string,
  priceAtSignal: number,
  exchange: string = 'HL',
  regime: string | null | undefined,
  arm: 'request' | 'fleet',
  isBotInternal: boolean | null | undefined,
  // OPS-SCORER-INPUT-PERSISTENCE-W1 R1. A TRAILING parameter per the repo's N-implementor rule,
  // but REQUIRED rather than optional: capture is forward-only, so a caller that silently omits
  // the parts loses them permanently. The compiler is the only thing that can prevent that, and
  // it can only do it if the parameter is required.
  parts: ScorerParts,
): void {
  const b = getBackend();
  const createdAt = Math.floor(Date.now() / 1000);
  b.run(
    `INSERT INTO band_signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, regime, regime_rule_version, verdict_rule_version, arm, is_bot_internal, rsi_score, ema_score, funding_score, oi_score, volume_score, raw0, funding_delta, hurst_delta, squeeze_delta, raw_final, funding_adjust_code, hurst_adjust_code, squeeze_adjust_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    coin, signal, confidence, timeframe, exchange, priceAtSignal, createdAt, regime ?? null,
    REGIME_RULE_VERSION,
    currentVerdictRuleVersion(),
    arm,
    // SQLite binds no booleans (`SQLite3 can only bind numbers, strings, bigints, buffers, and
    // null`), so the same 0/1 coercion `recordHoldDecisionImpl` applies is needed here. Caught by
    // tests/unit/band-population-invariance.test.ts on the SQLite backend — prod is PG, where the
    // raw boolean is correct, so this would have shipped green and failed only in fixtures.
    isBotInternal === null || isBotInternal === undefined
      ? null
      : (isPg ? isBotInternal : (isBotInternal ? 1 : 0)),
    ...scorerPartsBinds(parts),
  );
}

/**
 * The running count the successor wave is gated on.
 *
 * `OPS-TRACK-RECORD-BAND-DECISION-W{NEXT}` opens on a stated row count of RESOLVED band rows —
 * never a date — so the count has to be readable without an SSH psql session. Returns both legs
 * because they answer different questions: `captured` is how fast the band accrues, `resolved` is
 * how much of it is actually comparable to a tracked row, and only the second one advances the
 * gate. A row is RESOLVED when the outcome evaluator has scored it, which is exactly the
 * condition `isPfeEligible` reads on the tracked side.
 *
 * INTERNAL ONLY. Surfaced on the ADMIN-gated `/api/confidence-bands` and nowhere else;
 * `tests/unit/band-population-invariance.test.ts` asserts the field name is absent from every
 * unauthenticated response.
 */
export async function getBandSignalCounts(): Promise<{ captured: number; resolved: number }> {
  try {
    const rows = await dbQuery<{ captured: string | number; resolved: string | number }>(
      `SELECT count(*) AS captured,
              count(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS resolved
         FROM band_signals`,
    );
    const r = rows[0];
    return { captured: Number(r?.captured ?? 0), resolved: Number(r?.resolved ?? 0) };
  } catch {
    // The table is absent only on a backend that never ran init. Zero is the honest answer for a
    // COUNT over an empty corpus and this figure gates nothing automatically — the successor
    // reads it, a human decides.
    return { captured: 0, resolved: 0 };
  }
}

/**
 * OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2 — the band lane's OWN work queue.
 *
 * A SEPARATE QUERY, NOT A WIDENED ONE, AND THAT IS THE POINT. The tracked evaluator
 * (`getSignalsNeedingUnifiedBackfillAsync`, `LIMIT 5000`, oldest-first) feeds the PUBLISHED
 * number and draws venue candles from a shared upstream weight budget. Band capture is estimated
 * at 5.6k-8.9k rows/day against a tracked stream of ~2,820/day, so pointing both lanes at one
 * oldest-first queue would let a counterfactual measurement sit in front of the published
 * metric's own evaluator. Separate table, separate queue, separate cap — the band can starve, the
 * published metric cannot.
 *
 * `limit` is REQUIRED rather than defaulted. An optional cap that silently defaults is the
 * fix-one-branch-miss-the-other trap expressed in the type system; making it explicit means a new
 * call site has to state its budget out loud.
 */
export async function getBandSignalsNeedingOutcome(limit: number): Promise<SignalRecord[]> {
  const safe = Math.max(1, Math.min(Math.trunc(limit) || 1, 5000));
  return (await dbQuery<SignalRecord>(
    `SELECT band_id AS id, coin, signal, confidence, timeframe, exchange, price_at_signal, created_at,
            outcome_price, pfe_return_pct, mae_return_pct
       FROM band_signals
      WHERE outcome_price IS NULL
      ORDER BY created_at ASC
      LIMIT ${safe}`,
  )) as unknown as SignalRecord[];
}

/**
 * Write one band row's outcome. Column-for-column identical to `updateSignalOutcomes`, because
 * the values come from the SAME `computePFEMAE` + `toSignalOutcomeUpdate` pair the tracked lane
 * uses. Reusing the evaluator rather than reimplementing it is what makes the eventual
 * band-vs-tracked comparison a difference in the DATA rather than an artifact of two labellers —
 * the failure mode the spec names as "an artifact of different labelling".
 */
export async function updateBandSignalOutcomes(bandId: number, data: {
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
  const sql = `UPDATE band_signals SET
    outcome_price = ?, outcome_return_pct = ?, return_1candle = ?,
    pfe_price = ?, pfe_return_pct = ?,
    mae_price = ?, mae_return_pct = ?,
    pfe_candles = ?
    WHERE band_id = ?`;
  const args = [
    data.outcome_price, data.outcome_return_pct, data.return_1candle,
    data.pfe_price, data.pfe_return_pct,
    data.mae_price, data.mae_return_pct,
    data.pfe_candles, bandId,
  ] as const;
  if (isPg && b instanceof PgBackend) {
    await b.runAsync(sql, ...args);
  } else {
    b.run(sql, ...args);
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
 * OPS-HOLD-DECISION-CAPTURE-W1 R1 — persist one HOLD decision.
 *
 * Reached only through the lazy `import()` in `hold-decision-capture.ts` (that module has zero
 * static imports so it can never join the documented init cycle). Fail-open: a capture that can
 * break a trade call is worse than no capture.
 *
 * ── ON CONFLICT DO NOTHING IS THE SAMPLER, AND IT IS ARM-ASYMMETRIC BY DESIGN ──
 *
 * The `WHERE arm = 'fleet'` predicate on `uq_hold_decisions_fleet_cell` means the conflict target
 * only ever matches fleet rows. So the SAME statement gives two different behaviours, both
 * intended:
 *   * request arm (~3.19k/day, both `is_bot_internal` values) — no matching index, every row is
 *     written. Unsampled, because at ~300 external + ~2.9k bot HOLDs/day the whole arm costs
 *     ~1.5 MB/yr and the analysis needs every one of its ~28 distinct assets.
 *   * fleet arm (~437k/day) — first row per cell per UTC day wins, the rest are silent no-ops.
 *
 * The no-op is NOT a dropped observation to be logged: it is the sampling decision itself, taken
 * once per cell per day. What DOES get logged is the process-local runaway cap in the caller,
 * because that one really is truncation.
 */

/**
 * OPS-SCORER-INPUT-PERSISTENCE-W1 — bind the thirteen scorer columns, or thirteen NULLs when the
 * kill switch is off.
 *
 * The two column-arms cannot "skip" the parts the way the emitted arm skips its whole INSERT:
 * their parts are columns in a row that must still be written. So the switch nulls them, and NULL
 * already means exactly the right thing on those tables — "not captured" — because it is what
 * every row predating this wave carries.
 *
 * ONE function, so the hold and band writers cannot disagree about the column ORDER. Thirteen
 * positional binds duplicated across two call sites is a transposition waiting to happen, and a
 * transposed `hurst_delta`/`squeeze_delta` pair would still satisfy the sum identity.
 */
function scorerPartsBinds(parts: ScorerParts): Array<number | null> {
  if (!scorerCaptureEnabled()) return new Array(13).fill(null);
  return [
    parts.rsiScore, parts.emaScore, parts.fundingScore, parts.oiScore, parts.volumeScore,
    parts.raw0, parts.fundingDelta, parts.hurstDelta, parts.squeezeDelta, parts.rawFinal,
    parts.fundingAdjustCode, parts.hurstAdjustCode, parts.squeezeAdjustCode,
  ];
}

export function recordHoldDecisionImpl(c: {
  decidedAt: number;
  coin: string;
  timeframe: string;
  exchange: string | null;
  regime: string | null;
  wouldBeSide: number;
  confidence: number;
  priceAtDecision: number;
  arm: string;
  isBotInternal: boolean | null;
  suppressionReason: string;
  // OPS-SCORER-INPUT-PERSISTENCE-W1 R1 — the scorer's own inputs, written into the SAME ROW as
  // the decision. No join, and no fourth id space to collide with the three that already
  // overlap numerically (see migration 036's header).
  parts: ScorerParts;
}): void {
  try {
    const b = getBackend();
    const botValue = c.isBotInternal === null ? null : (isPg ? c.isBotInternal : (c.isBotInternal ? 1 : 0));
    b.run(
      `INSERT INTO hold_decisions
         (decided_at, coin, timeframe, exchange, regime, would_be_side, confidence,
          price_at_decision, arm, is_bot_internal, suppression_reason,
          rsi_score, ema_score, funding_score, oi_score, volume_score, raw0, funding_delta, hurst_delta, squeeze_delta, raw_final, funding_adjust_code, hurst_adjust_code, squeeze_adjust_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      c.decidedAt, c.coin, c.timeframe, c.exchange, c.regime, c.wouldBeSide, c.confidence,
      c.priceAtDecision, c.arm, botValue, c.suppressionReason,
      ...scorerPartsBinds(c.parts),
    );
  } catch (e) {
    console.warn(`[hold-decision-capture] record failed (fail-open): ${(e as Error).message}`);
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
      `SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL AND ${SQL_PUBLISHED_POPULATION} ORDER BY created_at ASC`
    ) as any;
  }
  return b.all(
    `SELECT id, signal_hash FROM signals WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL AND ${SQL_PUBLISHED_POPULATION} ORDER BY created_at ASC`
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
  latest_published_at: string | null;
  latest_signal_count: number | null;
}> {
  type Row = {
    latest_batch_id: string | number | null;
    batch_count: string | number;
    total_signals: string | number | null;
    latest_published_at: string | Date | null;
    latest_signal_count: string | number | null;
  };
  // OPS-DIGEST-MERKLE-ANCHOR-W1: `latest_published_at` / `latest_signal_count`
  // are ADDITIVE — the three pre-existing fields are byte-unchanged and the
  // public /api/merkle-batches allow-list does not name the new two, so the
  // public response shape is untouched. They exist so the daily Telegram digest
  // can render the SAME batch identity + total the /verify page renders WITHOUT
  // reducing over the LIMIT-capped `getRecentMerkleBatches()` page (the exact
  // defect OPS-MERKLE-BATCH-IDENTITY-W1 retired). Correlated scalar subqueries
  // over a PRIMARY KEY index are portable to both backends and cost one extra
  // index seek each.
  const rows = (await dbQuery<Row>(
    `SELECT MAX(batch_id) AS latest_batch_id, COUNT(*) AS batch_count, COALESCE(SUM(signal_count), 0) AS total_signals,
            (SELECT published_at  FROM merkle_batches ORDER BY batch_id DESC LIMIT 1) AS latest_published_at,
            (SELECT signal_count  FROM merkle_batches ORDER BY batch_id DESC LIMIT 1) AS latest_signal_count
       FROM merkle_batches`,
  )) as Row[];
  const row = rows[0];
  const latest = row?.latest_batch_id;
  const latestCount = row?.latest_signal_count;
  return {
    latest_batch_id: latest === null || latest === undefined ? null : Number(latest),
    batch_count: Number(row?.batch_count ?? 0),
    total_signals: Number(row?.total_signals ?? 0),
    latest_published_at: normalizeSqlTimestamp(row?.latest_published_at ?? null),
    latest_signal_count:
      latestCount === null || latestCount === undefined ? null : Number(latestCount),
  };
}

/**
 * Normalise a `published_at`-class column to an ISO-8601 UTC string.
 *
 * The two backends hand back two different shapes for the SAME column: node-pg
 * hydrates `TIMESTAMP` into a JS `Date`, while SQLite returns the raw
 * `datetime('now')` TEXT (`'2026-08-26 00:05:03'`) — UTC, but with no zone
 * marker, so `new Date(...)` would read it as LOCAL time and silently shift the
 * value by the host offset. Returns null for anything unparseable rather than an
 * Invalid Date, so a consumer's freshness verdict degrades to "unknown" instead
 * of to a fabricated timestamp.
 */
function normalizeSqlTimestamp(v: string | Date | null): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== 'string' || v.trim() === '') return null;
  const raw = v.trim();
  // Already zone-qualified (…Z or ±HH:MM) → trust it. Otherwise it is SQLite's
  // space-separated UTC text; make the UTC intent explicit before parsing.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
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
    WHERE s.id = ? AND ${sqlPublishedPopulation('s')}
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
    WHERE s.signal_hash = ? AND ${sqlPublishedPopulation('s')}
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
      const cutoff14d = Math.floor(Date.now() / 1000) - FUNDING_Z_WINDOW_SECONDS;
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
      if (rows.length < FUNDING_Z_MIN_SAMPLES) {
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
    if (cached.sampleCount < FUNDING_Z_MIN_SAMPLES) return null;
    if (cached.stdDev === 0) return 0;
    return (currentFunding - cached.mean) / cached.stdDev;
  }

  const stats = await loadFundingStats(coin);
  if (!stats) return null;
  if (stats.sampleCount < FUNDING_Z_MIN_SAMPLES) return null;
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
  const cutoff14d = Math.floor(now / 1000) - FUNDING_Z_WINDOW_SECONDS;
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

/**
 * v1.4.1: Update all outcome columns (unified + PFE/MAE + 1-candle).
 *
 * OPS-OUTCOME-BACKFILL-STALL-W1 A1 — `outcome_filled_at` is stamped HERE, in this one statement,
 * and that placement is load-bearing twice over.
 *
 * SINGLE DERIVATION. There are TWO callers, not one: `src/scripts/backfill-outcomes.ts` (the
 * 3-minute cron) and `src/resources/signal-performance.ts` (the MCP resource, which lazily
 * backfills on read). Stamping at the call sites would be two independent derivations of one
 * fact, and the second one is exactly the sort that gets forgotten by the wave that adds a third
 * caller — after which the re-keyed freshness canary silently under-reports the producer.
 *
 * ATOMICITY. The stamp goes in the SAME `UPDATE`, never a follow-up statement. A crash between
 * two statements would mint rows carrying an outcome and no stamp — permanently invisible to a
 * canary keyed on `max(outcome_filled_at)`, and indistinguishable from a producer that never ran.
 * One statement makes that state unrepresentable rather than merely unlikely.
 *
 * `outcome_attempts` is deliberately NOT reset on success: it is the row's attempt HISTORY, and
 * the queue predicate already stops consulting it the moment `outcome_price` is non-NULL.
 */
export async function updateSignalOutcomes(id: number, data: {
  outcome_price: number;
  outcome_return_pct: number;
  return_1candle: number;
  pfe_price: number;
  pfe_return_pct: number;
  mae_price: number;
  mae_return_pct: number;
  pfe_candles: number;
}, nowEpoch?: number): Promise<void> {
  const b = getBackend();
  const filledAt = Math.trunc(nowEpoch ?? Math.floor(Date.now() / 1000));
  const sql = `UPDATE signals SET
    outcome_price = ?, outcome_return_pct = ?, return_1candle = ?,
    pfe_price = ?, pfe_return_pct = ?,
    mae_price = ?, mae_return_pct = ?,
    pfe_candles = ?, outcome_filled_at = ?
    WHERE id = ?`;

  if (isPg && b instanceof PgBackend) {
    await b.runAsync(sql,
      data.outcome_price, data.outcome_return_pct, data.return_1candle,
      data.pfe_price, data.pfe_return_pct,
      data.mae_price, data.mae_return_pct,
      data.pfe_candles, filledAt, id
    );
  } else {
    b.run(sql,
      data.outcome_price, data.outcome_return_pct, data.return_1candle,
      data.pfe_price, data.pfe_return_pct,
      data.mae_price, data.mae_return_pct,
      data.pfe_candles, filledAt, id
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

/**
 * OPS-OUTCOME-BACKFILL-STALL-W1 A1 — the queue predicate, built as a PURE fn.
 *
 * Pure and exported because the SQL string is otherwise the one artifact no test executes: the
 * unit suite mocks the backend, so a `%`-formatted or mis-parenthesised predicate would ship
 * green. Its shape is asserted directly by `tests/unit/backfill-queue-backoff.test.ts`.
 *
 * The backoff clause is `NOT (maxed AND still cooling)`, written with an explicit
 * `outcome_attempts IS NULL` arm because SQL three-valued logic makes `NOT (NULL >= 3 AND ...)`
 * evaluate to NULL — i.e. FALSE for a WHERE — which would silently exclude every historical row
 * that has never been attempted. That is the whole backlog. The arm is not defensive noise; it
 * is the difference between a backoff and a total outage.
 */
export function buildBackfillQueueSql(nowEpoch: number, limit = BACKFILL_QUEUE_LIMIT): string {
  const cutoff = Math.trunc(nowEpoch) - BACKFILL_ATTEMPT_COOLDOWN_S;
  return (
    `SELECT * FROM signals WHERE outcome_price IS NULL` +
    ` AND (outcome_attempts IS NULL` +
    ` OR outcome_attempts < ${BACKFILL_MAX_ATTEMPTS}` +
    ` OR outcome_last_attempt_at IS NULL` +
    ` OR outcome_last_attempt_at <= ${cutoff})` +
    ` ORDER BY created_at ASC LIMIT ${Math.trunc(limit)}`
  );
}

export async function getSignalsNeedingUnifiedBackfillAsync(): Promise<SignalRecord[]> {
  const b = getBackend();
  const now = Math.floor(Date.now() / 1000);

  // Build a CASE-based query: only select signals old enough for their timeframe
  // We use a generous approach: fetch all pending, then filter in JS (simpler across SQLite/PG)
  //
  // OPS-OUTCOME-BACKFILL-STALL-W1: the cap is unchanged at BACKFILL_QUEUE_LIMIT. Raising it was
  // considered and REJECTED — a capacity constant is a COUNTDOWN, not a lifecycle change, and
  // with permanently-unfillable rows at the head of a FIFO any raised constant is consumed by
  // sediment first and returns as a fresh incident at the next volume step. What changed is that
  // sediment now AGES OUT of the window under a bounded backoff, so the cap governs live work.
  const sql = buildBackfillQueueSql(now);

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
 * OPS-OUTCOME-BACKFILL-STALL-W1 A1 — record ONE failed backfill attempt against a row.
 *
 * Called on BOTH terminal non-fill paths, and the "both" is the generator fix. The pre-existing
 * in-process `failCounts` breaker only ever saw thrown errors; the dominant sediment class is a
 * "no candles after signal time" result, which increments `skipped` and touches no counter at
 * all. A breaker blind to the majority of its own failure population is not a breaker.
 *
 * `COALESCE(outcome_attempts, 0) + 1` so a historical NULL row starts at 1 rather than staying
 * NULL forever. Fire-and-forget is deliberate here and ONLY here: this is bookkeeping, not the
 * outcome write, and a lost increment costs one extra re-attempt rather than a wrong number.
 */
export async function recordBackfillAttempt(id: number, nowEpoch?: number): Promise<void> {
  const b = getBackend();
  const now = Math.trunc(nowEpoch ?? Math.floor(Date.now() / 1000));
  const sql =
    `UPDATE signals SET outcome_attempts = COALESCE(outcome_attempts, 0) + 1,` +
    ` outcome_last_attempt_at = ? WHERE id = ?`;
  if (isPg && b instanceof PgBackend) {
    await b.runAsync(sql, now, id);
  } else {
    b.run(sql, now, id);
  }
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
      `SELECT ${STATS_COL_PROJECTION} FROM signals WHERE ${SQL_PUBLISHED_POPULATION} ORDER BY created_at DESC`
    ) as unknown as SignalRecord[];
  }
  return b.all(
    `SELECT ${STATS_COL_PROJECTION} FROM signals WHERE ${SQL_PUBLISHED_POPULATION} ORDER BY created_at DESC`
  ) as unknown as SignalRecord[];
}

export function getPerformanceStats(): PerformanceStats {
  // Resolve the backend FIRST. `isPg` is a module-level `let` assigned inside `getBackend()`,
  // so reading it before that call answers `false` on the FIRST invocation in any process —
  // including a Postgres one. The old order took the SQLite branch exactly once per process,
  // then called `b.all()` on `PgBackend`, which returns `[]` by construction: a real-looking
  // `[perf-stats] cache miss ... rows=0` line, computed off a backend that cannot answer.
  // Every later call took the PG branch, so the wrong answer appeared once and hid.
  const b = getBackend();
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
  const all = b.all(
    `SELECT ${STATS_COL_PROJECTION} FROM signals WHERE ${SQL_PUBLISHED_POPULATION} ORDER BY created_at DESC`
  ) as unknown as SignalRecord[];
  // OPS-RECENT-SIGNALS-VENUE-FILTER-W1: `null` = unfiltered, and it is a decision, not an
  // omission. This is the SYNCHRONOUS SQLite path — `getPerformanceStats()` returns
  // `emptyStats()` outright under PG, so prod never reaches here — and the venue allow-list
  // resolves from an async DB read that a sync function cannot await. Documented rather than
  // faked: a SQLite deployment serving this path would not have the row filter.
  const stats = computeStats(all, null, null);
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
      // OPS-RECENT-SIGNALS-VENUE-FILTER-W1: resolve the public venue allow-list ONCE, here,
      // and hand the SAME set to whichever branch runs. Measured 2026-08-29,
      // PERF_STATS_SQL_PUSHDOWN=1 in prod — the SQL branch is the LIVE one, so a fix applied
      // only to the in-memory branch below would be a no-op in production while looking green
      // locally. That is exactly why the parameter is required rather than defaulted.
      //
      // Reuses the aggregate lane's resolver (fail-CLOSED, lazily imported so the DB layer
      // gains no static edge to venue-store, which imports THIS module). ONE venue source
      // governs aggregates and rows alike.
      const { resolvePublicPerformanceAllowList } = await import('./public-performance-formatter.js');
      const recentVenues = (await resolvePublicPerformanceAllowList()).venues;
      let stats: PerformanceStats;
      let rows: number;
      if (useSql) {
        const { groups, period, recentRows } = await aggregateSignalsSql(recentVenues);
        stats = rollupStats(groups, period, top20, recentRows, recentVenues);
        rows = period.total;
      } else {
        const all = await loadSignalsForStats();
        stats = computeStats(all, top20, recentVenues);
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

/**
 * The published methodology block — ONE literal, read by all three public channels
 * (`performance://signal-performance`, `GET /api/performance-public`, `get_track_record`),
 * so a correction here repairs every surface at once.
 *
 * EXPORTED for `tests/unit/public-performance-formatter.test.ts`, which asserts the public
 * formatter's by-name allow-list covers every key declared here — adding a key fails the
 * build until it is deliberately admitted, instead of being silently dropped.
 */
export const METHODOLOGY: Record<string, unknown> = {
  pfeWinRate: 'Peak Favorable Excursion win rate. Did price move in the signal direction at any point during the evaluation window?',
  note: 'AlgoVault provides directional entry signals. Exit timing is determined by your agent or strategy — PFE Win Rate measures whether the direction was correct, independent of exit.',
  evaluationWindows: {
    '1m': '12 candles (12 minutes)', '3m': '12 candles (36 minutes)',
    '5m': '12 candles (1 hour)', '15m': '12 candles (3 hours)', '30m': '8 candles (4 hours)',
    '1h': '8 candles (8 hours)', '2h': '6 candles (12 hours)', '4h': '6 candles (24 hours)',
    '8h': '4 candles (32 hours)', '12h': '4 candles (48 hours)', '1d': '3 candles (3 days)',
  },
  dataSource: 'Hyperliquid public API. Every qualifying signal recorded and evaluated.',
  // DEV-TRACK-RECORD-TOOL-PARITY-W1 CH2 — CORRECTED. This read `'Confidence >= 60%. HOLD
  // signals excluded.'` and had been FALSE since 2026-04-15, when R6 lowered
  // MIN_TRACKABLE_CONFIDENCE from 60 to 52 (src/tools/get-trade-call.ts:193, gate site :1336).
  // CRYPTO-PFE-BENCHMARK-AUDIT-W1 measured it false on 2026-07-02 (finding 1) and it stayed
  // live on both public channels for ~8 more weeks; this wave would have carried it onto a
  // third. CLAUDE.md: a disclosed methodology filter must be grep-proven as a real predicate
  // on BOTH the write and the read path.
  //
  // Measured on prod 2026-08-28 (n=521,677 signals), which is why the wording is what it is:
  //   • min(confidence) = 52 and rows below 52 = 0  → the RECORDING gate is exactly 52.
  //   • rows with confidence < 60 = 304,518 (58.4%) → a ">= 60%" claim misdescribed the
  //     majority of the population behind the published win rate.
  //   • the READ path applies no confidence predicate at all: `loadSignalsForStats` is a bare
  //     SELECT, the SQL-pushdown branch is its declared byte-equivalent, and `computeStats`
  //     filters only `signal !== 'HOLD'` — hence the explicit second sentence.
  //   • boundary check, since the window opens 2026-04-10 and the gate moved 2026-04-15:
  //     36,767 in-window rows predate the change and **0** of them are below 60. Every
  //     pre-change row therefore satisfies ">= 52%" too, so no boundary clause is owed. That
  //     is a measurement, not an assumption — see the wave's audit for the query.
  signalFilter: 'Recording gate: non-HOLD calls with confidence >= 52% at signal time. Aggregation excludes HOLD and applies no further confidence filter.',
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

/**
 * OPS-RECENT-SIGNALS-VENUE-FILTER-W1 — who may appear in the public RECENCY window.
 *
 * `ReadonlySet<string>` — admit only these venue ids into `recentSignals`. This is the SAME
 * resolved set the aggregate lane uses (`resolvePublicPerformanceAllowList()` in
 * public-performance-formatter.ts): `listVenues('promoted')` ∩ `getActivePromotedVenueIds()`,
 * fail-CLOSED. There is no second venue source, and the RAW static promoted-venue constant in
 * `capabilities.ts` is never read here — it still carries the RETIRED `BITMART` (15 ids against
 * the live 14). (Named descriptively rather than by symbol on purpose: this wave's verification
 * gate bans that identifier from this file by grep, and a comment explaining why it is banned
 * would otherwise keep the gate red for the wrong reason.)
 *
 * `null` — UNFILTERED. Legal, and it means *admin or oracle context*, never "caller forgot".
 * The parameter is deliberately REQUIRED at every producer below rather than defaulted: an
 * optional param defaulting to unfiltered is the fix-one-branch-miss-the-other trap expressed
 * in the type system, where a missed call site keeps the old behaviour AND compiles clean.
 * Required means omission is a compile error, so "both branches" is structural rather than
 * remembered. `tests/unit/perfstats-rollup-equivalence.test.ts` pins that the two public paths
 * pass a real set and not `null`.
 */
export type RecentVenueScope = ReadonlySet<string> | null;

/**
 * Rows admitted to the public recency window. FAIL-CLOSED: an empty scope admits nothing.
 *
 * `undefined` is NOT `null` and is not treated as unfiltered. TypeScript makes it unreachable
 * from a typed caller — the parameter is required — so it can only arrive from untyped JS or a
 * stale call site, which is a programming error and not a runtime condition. It throws with the
 * contract named, because the alternative was a bare `TypeError: Cannot read properties of
 * undefined (reading 'has')` several frames from the cause. This is not a live-serving-path
 * guard (which would refuse rather than throw); it is unreachable-by-construction, made legible.
 */
function admitRecent(rows: SignalRecord[], scope: RecentVenueScope): SignalRecord[] {
  if (scope === undefined) {
    throw new Error(
      '[perf-stats] recentVenues is required: pass a ReadonlySet<string> for a public path, '
      + 'or an explicit `null` for an admin/oracle path. `undefined` is never a valid scope.',
    );
  }
  if (scope === null) return rows;
  return rows.filter(r => scope.has(r.exchange || 'HL'));
}

function computeStats(rows: SignalRecord[], top20ByOI: Set<string> | null, recentVenues: RecentVenueScope): PerformanceStats {
  // OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R1 — the published population, stated ONCE.
  //
  // Applied here rather than at each cohort deliberately: this function derives ~11 separate
  // breakdowns (overall, per-signal-type, per-timeframe, per-asset, per-tier, per-exchange, the
  // period bounds, totalCalls, recentSignals…), and eleven parallel copies of one rule is exactly
  // the drift `pfe-scoring.ts` was extracted to end. Filtering the input is the single-derivation
  // form: every cohort below inherits the population instead of restating it.
  //
  // Idempotent against the SQL predicate on the loader — both project from the same constant, and
  // a row excluded by one is excluded by the other. That redundancy is the point: the scan path
  // and the SQL-pushdown path (`rollupStats`) must agree byte-for-byte, and they now do so
  // because both name the population rather than because both happened to inherit it.
  const all = rows.filter(isPublishedPopulation);
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
    // OPS-RECENT-SIGNALS-VENUE-FILTER-W1: filter BEFORE the slice, never after. Filtering the
    // 20 would yield a jittery 14-to-20-row ticker whose LENGTH leaks how many rows were
    // dropped; filtering the pool keeps the window at the 20 most recent PROMOTED rows.
    recentSignals: admitRecent(all, recentVenues).slice(0, 20).map(s => formatPublicRecentSignal({
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
 * Separator for the in-memory (exchange, coin, timeframe, signal) group key in
 * `aggregateRowsInJs`. U+0000 is chosen because it can never occur inside an
 * exchange id, coin, timeframe or verdict - a printable separator (`|`, `:`, `-`)
 * could appear in a value and silently MERGE two distinct tuples into one group,
 * corrupting the counts. Pinned by tests/unit/perfstats-key-separator.test.ts.
 *
 * The key is EPHEMERAL: built per row, used as a Map key, and discarded when the
 * function returns `[...map.values()]`. It is never persisted, so this constant is
 * NOT a stored-data contract - but its VALUE must still not change, for the
 * collision reason above.
 *
 * Written as the escape sequence rather than a raw NUL byte
 * (OPS-GREPPABLE-SOURCE-GUARD-W1): the compiled string is byte-identical, but a raw
 * NUL makes tools that skip binary files - notably ugrep invoked with `-I`, which is
 * how the agent shell resolves `grep` - silently skip this ENTIRE file and report
 * its contents as ABSENT. That cost a 3-chapter false HALT on 2026-08-01. Enforced
 * repo-wide by scripts/check-source-greppable.mjs.
 */
export const STAT_GROUP_KEY_SEP = '\u0000';

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
    const key = `${ex}${STAT_GROUP_KEY_SEP}${r.coin}${STAT_GROUP_KEY_SEP}${r.timeframe}${STAT_GROUP_KEY_SEP}${r.signal}`;
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
  recentVenues: RecentVenueScope,
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
    // OPS-RECENT-SIGNALS-VENUE-FILTER-W1: on THIS branch the venue predicate is already in the
    // SQL (`recentSql`), because `LIMIT 20` runs in the database — a JS filter here could never
    // see a 21st row to backfill with. `admitRecent` is applied anyway so the two branches are
    // byte-identical for a caller that hands this function an unfiltered `recentRows` (the
    // equivalence oracle does exactly that), and so the guarantee does not rest on the SQL alone.
    recentSignals: admitRecent(recentRows, recentVenues).slice(0, 20).map(s => formatPublicRecentSignal({
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
export function _computeStatsOracle(rows: SignalRecord[], top20ByOI: Set<string> | null, recentVenues: RecentVenueScope): PerformanceStats {
  return computeStats(rows, top20ByOI, recentVenues);
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
 * Merkle-parity).
 *
 * ⚠ THE CONFIDENCE FILTER IS NOW EXPLICIT, AND THIS LINE IS WHY THE WAVE HAPPENED. It read
 * "NO confidence filter (enforced at write)" until OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R1 —
 * an accurate description of an inverted design. The published population was inherited from
 * `recordSignal`'s write gate and stated nowhere on the read side, so ONE insert below that gate
 * would have moved the published win rate, the published call count and the on-chain Merkle
 * anchor with nothing failing anywhere. All three strings below now carry
 * `SQL_PUBLISHED_POPULATION`, and this is the LIVE branch in prod
 * (`PERF_STATS_SQL_PUSHDOWN=1`) — a predicate applied only to the TypeScript path would have
 * been a silent no-op on the published number. null-exchange
 * coalesces to 'HL' to match computeStats' `s.exchange || 'HL'`. max(created_at)
 * + max(id) per group drive rollup's deterministic byAsset/byExchange order (Q1).
 */
export function buildStatsAggregateSql(recentVenues: RecentVenueScope): { groupsSql: string; periodSql: string; recentSql: string; recentParams: unknown[] } {
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
      `FROM signals WHERE ${SQL_PUBLISHED_POPULATION} GROUP BY coalesce(exchange, 'HL'), coin, timeframe, signal`,
    periodSql:
      `SELECT min(created_at) AS min_created_at, max(created_at) AS max_created_at, count(*) AS total FROM signals WHERE ${SQL_PUBLISHED_POPULATION}`,
    // OPS-RECENT-SIGNALS-VENUE-FILTER-W1: the venue predicate belongs INSIDE this query. The
    // `LIMIT 20` executes in the database, so a post-query filter cannot reach a 21st row —
    // it could only ever shrink the window. Parameterised with the repo's `?` convention
    // (PgBackend rewrites to `$n`). FAIL-CLOSED by construction rather than by a branch: an
    // EMPTY scope produces `= ANY('{}')`, which matches nothing, so a venue-registry fault
    // withholds rows instead of leaking them.
    recentSql:
      `SELECT ${STATS_COL_PROJECTION} FROM signals WHERE ${SQL_PUBLISHED_POPULATION}`
      + (recentVenues === null ? '' : " AND coalesce(exchange, 'HL') = ANY(?)")
      + ' ORDER BY created_at DESC, id DESC LIMIT 20',
    recentParams: recentVenues === null ? [] : [[...recentVenues]],
  };
}

/**
 * PG-only executor. Returns grouped rows (Number-coerced — node-postgres returns
 * count/bigint as strings) + period + the deterministic top-20 recent rows (left
 * in native b.query types so recentSignals byte-matches loadSignalsForStats rows).
 */
export async function aggregateSignalsSql(recentVenues: RecentVenueScope): Promise<{ groups: StatGroupRow[]; period: PeriodRow; recentRows: SignalRecord[] }> {
  const b = getBackend();
  if (!(isPg && b instanceof PgBackend)) throw new Error('aggregateSignalsSql: PG backend required');
  const { groupsSql, periodSql, recentSql, recentParams } = buildStatsAggregateSql(recentVenues);
  // Sequential on ONE pooled connection (~150ms total) — fewer concurrent conns
  // than 3 parallel queries; still ms vs the ~6s full-row-load it replaces.
  const rawGroups = (await b.query(groupsSql)) as unknown as Array<Record<string, unknown>>;
  const rawPeriod = (await b.query(periodSql)) as unknown as Array<Record<string, unknown>>;
  const recentRows = (await b.query(recentSql, recentParams)) as unknown as SignalRecord[];
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
export async function _perfStatsOldPath(top20: Set<string> | null, recentVenues: RecentVenueScope = null): Promise<{ stats: PerformanceStats; total: number }> {
  const all = await loadSignalsForStats();
  return { stats: computeStats(all, top20, recentVenues), total: all.length };
}
export async function _perfStatsNewPath(top20: Set<string> | null, recentVenues: RecentVenueScope = null): Promise<{ stats: PerformanceStats; total: number }> {
  const { groups, period, recentRows } = await aggregateSignalsSql(recentVenues);
  return { stats: rollupStats(groups, period, top20, recentRows, recentVenues), total: period.total };
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
     WHERE ${SQL_PUBLISHED_POPULATION}
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
    WHERE signal IN ('BUY', 'SELL') AND ${SQL_PUBLISHED_POPULATION}
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

/**
 * OPS-SCORER-INPUT-PERSISTENCE-W1 R1b — the EMITTED arm's scorer-input writer.
 *
 * The other two arms write their parts into their own row, because `hold_decisions` and
 * `band_signals` are already quarantined sibling tables. The emitted arm's parent is `signals`,
 * which is the ANCHORED table, so its parts go to a sibling instead and this is that sibling's
 * only writer.
 *
 * THREE THINGS ARE DELIBERATELY ABSENT, and each absence is a property rather than an omission:
 *
 *  1. NO `merkle_batch_id`, NO `merkle_proof`, and no write to `signals`. `getUnbatchedSignals()`
 *     selects `FROM signals`, so this table is outside the anchor path by construction — not by
 *     a guard that a later wave might delete. `signal_hash` is here ONLY as a join key.
 *  2. NO WEBHOOK HOOK. `recordSignal` fires `onSignalRecorded` behind `WEBHOOK_DELIVERY_ENABLED`.
 *     These rows are a measurement corpus, never a subscribable product event.
 *  3. NO `RETURNING`, and nothing awaits this. It is called beside `recordSignal` on the serving
 *     path; the response must not wait on it, which is the same contract every sibling capture
 *     writer in this file already keeps.
 *
 * `ON CONFLICT DO NOTHING` against `uq_signal_scorer_inputs_hash_exchange` — FIRST write wins.
 * Measured 2026-08-31, that collapses 1,400 same-decision double-writes (identical rows with
 * consecutive ids) losslessly, while the composite key keeps the 5 measured cross-venue hash
 * collisions as distinct rows, because `hashSignal`'s preimage carries no venue and those rows'
 * parts genuinely differ. See migration 036 for the full measurement.
 */
export function recordScorerInputs(c: {
  decidedAt: number;
  signalHash: string;
  coin: string;
  signal: SignalVerdict;
  confidence: number;
  timeframe: string;
  exchange: string;
  regime: string | null | undefined;
  arm: 'request' | 'fleet';
  isBotInternal: boolean | null | undefined;
  parts: ScorerParts;
}): void {
  const b = getBackend();
  const p = c.parts;
  b.run(
    `INSERT INTO signal_scorer_inputs
       (decided_at, signal_hash, coin, signal, confidence, timeframe, exchange, regime,
        arm, is_bot_internal, verdict_rule_version,
        rsi_score, ema_score, funding_score, oi_score, volume_score,
        raw0, funding_delta, hurst_delta, squeeze_delta, raw_final,
        funding_adjust_code, hurst_adjust_code, squeeze_adjust_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    c.decidedAt, c.signalHash, c.coin, c.signal, c.confidence, c.timeframe, c.exchange,
    c.regime ?? null, c.arm,
    // Same SQLite boolean coercion the two sibling writers apply — prod is PG, where the raw
    // boolean is correct, so omitting it would ship green and fail only in fixtures.
    c.isBotInternal === null || c.isBotInternal === undefined
      ? null
      : (isPg ? c.isBotInternal : (c.isBotInternal ? 1 : 0)),
    // Evaluated at WRITE time, never hoisted: TREND_MODE moves with no deploy and no diff, and it
    // changes what a given `rsi_score` MEANS. Rows from two generations must not be pooled.
    currentVerdictRuleVersion(),
    p.rsiScore, p.emaScore, p.fundingScore, p.oiScore, p.volumeScore,
    p.raw0, p.fundingDelta, p.hurstDelta, p.squeezeDelta, p.rawFinal,
    p.fundingAdjustCode, p.hurstAdjustCode, p.squeezeAdjustCode,
  );
}

/**
 * THE RUNNING COUNT IS NOT AN ENDPOINT HERE, AND THAT IS A DELIBERATE TRADE.
 *
 * `EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT}` opens on a stated ROW COUNT of captured-and-labeled
 * rows, so the count has to be readable. `getBandSignalCounts` above solves the same problem by
 * feeding the admin-gated `/api/confidence-bands`, and this wave first copied that shape —
 * a `getScorerInputCounts()` reader. It was REMOVED before shipping, for two reasons:
 *
 *  1. It had ZERO non-test callers. A helper with no consumer is not "ready for the successor",
 *     it is dead code that a unit test can make look alive.
 *  2. Wiring it to the endpoint would put a reference to this store inside `src/index.ts` — the
 *     public-serving module — and `tests/unit/scorer-input-quarantine.test.ts` exists precisely
 *     to refuse that. An allowlist row for `index.ts` would gut the guard on its first use.
 *
 * The count is published instead by `ops/monitoring/scorer-input-identity-canary.py`, which
 * already prints `captured=N` per arm on every scheduled run and is the one thing that reads all
 * three arms. A figure a human reads once per wave does not need an HTTP surface; it needs to
 * exist on a schedule, which it does.
 */
