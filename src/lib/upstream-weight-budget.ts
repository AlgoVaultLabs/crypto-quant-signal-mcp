/**
 * upstream-weight-budget.ts — OPS-HL-RATELIMITER-W2
 *
 * A venue-agnostic, CROSS-PROCESS weight ledger (token bucket) for upstream REST
 * APIs that impose a per-IP weight budget per rolling minute (Hyperliquid: 1200
 * weight/min/IP). Every weight-bearing caller in the container — the long-lived
 * MCP server, every `docker exec … node dist/scripts/seed-signals.js` cron fire,
 * the in-server backfill interval — shares ONE budget via a JSON ledger file +
 * an O_EXCL lockfile on the shared container filesystem (`/tmp`). The W1
 * in-process `metaAndAssetCtxs` coalescing cache only collapsed callers WITHIN a
 * single node process; this closes the cross-process gap deferred from W1.
 *
 * Two priority classes (via AsyncLocalStorage, default `interactive`):
 *   - interactive — MCP tool handlers. If a request would exceed `ceilingPerMin`
 *     it THROWS `UpstreamRateLimitError(venue, secondsToWindowRoll)` immediately,
 *     preserving the existing structured-429 → agent-fallback contract.
 *   - batch — seed/backfill bulk callers. They may use only up to
 *     `ceilingPerMin − interactiveReserve` (so bulk load can never starve an
 *     interactive user of the reserve). A batch request that does not fit WAITS
 *     for the window to roll, retrying up to `maxBatchWaitMs`, then returns a
 *     SKIP (`WeightBudgetSkipError`) — it NEVER raises the user-facing throw.
 *     Callers treat SKIP like an `InsufficientCandles` skip: log it, move on,
 *     the next idempotent fire retries.
 *
 * Telemetry (forensics only — NO Telegram, per the no-TG-on-completion law):
 * on each window roll a single structured line is emitted with the closed
 * window's lane counters `{ used, batch_used, interactive_used, waits, skips,
 * throws }`. // TODO: revisit constants by 2026-06-18 with one week of telemetry.
 *
 * Build note: this module is compiled CJS (tsconfig module=Node16); it uses
 * synchronous `fs` for the lock critical section and absolute ledger/lock paths
 * — no `import.meta.url`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { UpstreamRateLimitError } from './errors.js';
import { recordRateLimitEvent } from './rate-limit-events.js';

export type WeightClass = 'interactive' | 'batch';

/**
 * Internal control signal raised by a BATCH `acquire()` that could not fit a
 * request within `maxBatchWaitMs` of window-roll waiting. Distinct from
 * `UpstreamRateLimitError` (which is user-facing and interactive-only): callers
 * catch this, count it as a SKIP (not an error), and let the next fire retry.
 */
export class WeightBudgetSkipError extends Error {
  readonly code = 'WEIGHT_BUDGET_SKIP' as const;
  readonly venue: string;
  readonly weight: number;
  constructor(venue: string, weight: number) {
    super(
      `${venue} weight budget saturated; skipped a ${weight}-weight batch request after the max wait`,
    );
    this.venue = venue;
    this.weight = weight;
    Object.setPrototypeOf(this, WeightBudgetSkipError.prototype);
  }
}

// ── Priority-class context (AsyncLocalStorage, default interactive) ──
const weightClassContext = new AsyncLocalStorage<WeightClass>();

// ── Caller-attribution context (OPS-RATELIMIT-CALLER-ATTRIBUTION-W1) ──
// Sibling ALS carrying WHICH entry point issued the demand (tool name / grid_warmer /
// backfill / seed:<tf>). Read by the recorder at the throw/wait/skip + ban sites so the
// rate_limit_events stream self-pins the driver. Orthogonal to weight class — caller is
// the WHO, class is the priority lane. Default 'unknown' (fail-open: an untagged path
// attributes to 'unknown', never breaks).
const callerContext = new AsyncLocalStorage<string>();

/** Current caller for the running async context. Defaults to `'unknown'`. */
export function currentCaller(): string {
  return callerContext.getStore() ?? 'unknown';
}

/** Run `fn` (and all async work it spawns) tagged with `caller` (weight class unchanged). */
export function runAsCaller<T>(caller: string, fn: () => T): T {
  return callerContext.run(caller, fn);
}

// TEMP DIAGNOSTIC (OPS-RATELIMIT-CALLER-ATTRIBUTION-W1): pin the residual untagged
// interactive throw driver — logs the first few unknown-caller throw stacks (Node async
// stack traces), then goes quiet. REMOVED in the same wave once the driver is tagged.
let _dbgUnknownThrows = 0;

/** Current weight class for the running async context. Defaults to `interactive`. */
export function currentWeightClass(): WeightClass {
  return weightClassContext.getStore() ?? 'interactive';
}

/** Run `fn` (and all async work it spawns) under the `batch` weight class; optionally tag `caller`. */
export function runAsBatch<T>(fn: () => Promise<T>, caller?: string): Promise<T> {
  return weightClassContext.run('batch', caller === undefined ? fn : () => callerContext.run(caller, fn));
}

/** Run `fn` under the `interactive` weight class (explicit override of a batch scope); optionally tag `caller`. */
export function runAsInteractive<T>(fn: () => Promise<T>, caller?: string): Promise<T> {
  return weightClassContext.run('interactive', caller === undefined ? fn : () => callerContext.run(caller, fn));
}

interface Ledger {
  windowStartMs: number;
  used: number;
  batchUsed: number;
  interactiveUsed: number;
  waits: number;
  skips: number;
  throws: number;
}

export interface WeightBudgetOptions {
  /** Display name used in thrown errors + telemetry (e.g. "Hyperliquid"). */
  venue: string;
  /** Absolute path to the JSON ledger on the shared filesystem. */
  ledgerPath: string;
  /** Absolute path to the O_EXCL lockfile (sibling of the ledger). */
  lockPath: string;
  /** Total weight allowed per window across ALL classes. */
  ceilingPerMin: number;
  /** Weight held in reserve for interactive callers (batch may not touch it). */
  interactiveReserve: number;
  /** Window length in ms (default 60_000 — HL's per-minute budget). */
  windowMs?: number;
  /** A lockfile older than this (wall-clock mtime) is considered stale and stolen. */
  staleLockMs?: number;
  /** Max total time a batch caller waits across window rolls before SKIP. */
  maxBatchWaitMs?: number;
  /** Backoff between lockfile-contention retries (real time). */
  lockRetryMs?: number;
  /** Injectable monotonic-ish clock for window accounting (default Date.now). */
  now?: () => number;
  /** Injectable batch window-wait sleep (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Structured-log sink (default console.log). NO Telegram. */
  log?: (line: string) => void;
}

const WAIT_LOG_THRESHOLD_MS = 5_000;

export class WeightBudget {
  private readonly venue: string;
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly ceiling: number;
  private readonly reserve: number;
  private readonly windowMs: number;
  private readonly staleLockMs: number;
  private readonly maxBatchWaitMs: number;
  private readonly lockRetryMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(opts: WeightBudgetOptions) {
    this.venue = opts.venue;
    this.ledgerPath = opts.ledgerPath;
    this.lockPath = opts.lockPath;
    this.ceiling = opts.ceilingPerMin;
    this.reserve = opts.interactiveReserve;
    this.windowMs = opts.windowMs ?? 60_000;
    this.staleLockMs = opts.staleLockMs ?? 2_000;
    this.maxBatchWaitMs = opts.maxBatchWaitMs ?? 300_000;
    this.lockRetryMs = opts.lockRetryMs ?? 15;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * Reserve `weight` for the given class against the shared ledger.
   *  - interactive: resolves if it fits within `ceiling`, else THROWS
   *    `UpstreamRateLimitError`.
   *  - batch: resolves if it fits within `ceiling − reserve`, else waits for
   *    window rolls up to `maxBatchWaitMs`, then THROWS `WeightBudgetSkipError`.
   */
  async acquire(weight: number, cls: WeightClass): Promise<void> {
    const deadline = this.now() + this.maxBatchWaitMs;
    let totalWaitMs = 0; // accumulated across wait iterations → exactly 1 'wait'/'skip' telemetry row per acquire

    for (;;) {
      const fd = this.tryLock();
      if (fd === null) {
        // Lockfile held by a fresh holder — yield (real time) and retry. This
        // does NOT advance the injected window clock.
        await this.realDelay(this.lockRetryMs + Math.floor(Math.random() * this.lockRetryMs));
        continue;
      }

      let decision: 'acquired' | 'throw' | 'wait' | 'skip' = 'acquired';
      let secondsToRoll = 0;
      try {
        const now = this.now();
        const ledger = this.roll(this.readLedgerRaw(now), now);
        const cap = cls === 'interactive' ? this.ceiling : this.ceiling - this.reserve;

        if (ledger.used + weight <= cap) {
          ledger.used += weight;
          if (cls === 'batch') ledger.batchUsed += weight;
          else ledger.interactiveUsed += weight;
          this.writeLedger(ledger);
          decision = 'acquired';
        } else if (cls === 'interactive') {
          ledger.throws += 1;
          this.writeLedger(ledger);
          secondsToRoll = this.secondsToRoll(now);
          decision = 'throw';
        } else if (now >= deadline) {
          ledger.skips += 1;
          this.writeLedger(ledger);
          decision = 'skip';
        } else {
          ledger.waits += 1;
          this.writeLedger(ledger);
          decision = 'wait';
        }
      } finally {
        this.releaseLock(fd);
      }

      if (decision === 'acquired') {
        // Telemetry: a batch acquire that WAITED before fitting (interactive never waits).
        if (totalWaitMs > 0) recordRateLimitEvent(this.venue, 'wait', null, 'batch', totalWaitMs, currentCaller());
        return;
      }

      if (decision === 'throw') {
        this.log(
          JSON.stringify({
            tag: 'upstream-weight-budget',
            event: 'interactive_throw',
            venue: this.venue,
            weight,
            retry_after_seconds: secondsToRoll,
          }),
        );
        const _dbgCaller = currentCaller();
        if (_dbgCaller === 'unknown' && _dbgUnknownThrows < 6) {
          _dbgUnknownThrows++;
          console.log(`[caller-debug] unknown ${this.venue} interactive throw #${_dbgUnknownThrows}:\n${new Error('caller-trace').stack}`);
        }
        recordRateLimitEvent(this.venue, 'throw', 'BUDGET_CEILING', cls, undefined, _dbgCaller);
        throw new UpstreamRateLimitError(this.venue, secondsToRoll);
      }

      if (decision === 'skip') {
        this.log(
          JSON.stringify({
            tag: 'upstream-weight-budget',
            event: 'batch_skip',
            venue: this.venue,
            weight,
            max_batch_wait_ms: this.maxBatchWaitMs,
          }),
        );
        recordRateLimitEvent(this.venue, 'skip', null, 'batch', totalWaitMs || null, currentCaller());
        throw new WeightBudgetSkipError(this.venue, weight);
      }

      // wait: sleep until the next window boundary (capped to the remaining
      // deadline), then loop and re-evaluate against the rolled window.
      const now = this.now();
      const msToRoll = this.windowMs - (now % this.windowMs);
      const msLeft = Math.max(0, deadline - now);
      const waitMs = Math.max(1, Math.min(msToRoll, msLeft) || msToRoll);
      if (waitMs >= WAIT_LOG_THRESHOLD_MS) {
        this.log(
          JSON.stringify({
            tag: 'upstream-weight-budget',
            event: 'batch_wait',
            venue: this.venue,
            weight,
            wait_ms: waitMs,
          }),
        );
      }
      totalWaitMs += waitMs;
      await this.sleep(waitMs);
    }
  }

  /** Read the persisted ledger (no roll). Test/forensics helper. */
  _readLedger(): Ledger {
    return this.readLedgerRaw(this.now());
  }

  // ── internals ──

  private windowStartFor(now: number): number {
    return Math.floor(now / this.windowMs) * this.windowMs;
  }

  private secondsToRoll(now: number): number {
    return Math.ceil((this.windowMs - (now % this.windowMs)) / 1000);
  }

  private emptyLedger(now: number): Ledger {
    return {
      windowStartMs: this.windowStartFor(now),
      used: 0,
      batchUsed: 0,
      interactiveUsed: 0,
      waits: 0,
      skips: 0,
      throws: 0,
    };
  }

  private readLedgerRaw(now: number): Ledger {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as Partial<Ledger>;
      if (typeof parsed.windowStartMs !== 'number' || typeof parsed.used !== 'number') {
        return this.emptyLedger(now);
      }
      return {
        windowStartMs: parsed.windowStartMs,
        used: parsed.used,
        batchUsed: parsed.batchUsed ?? 0,
        interactiveUsed: parsed.interactiveUsed ?? 0,
        waits: parsed.waits ?? 0,
        skips: parsed.skips ?? 0,
        throws: parsed.throws ?? 0,
      };
    } catch {
      // Missing or corrupt ledger → start a fresh window.
      return this.emptyLedger(now);
    }
  }

  /** Roll to the current window if we've crossed a minute boundary; emit telemetry for the closed window. */
  private roll(ledger: Ledger, now: number): Ledger {
    const cur = this.windowStartFor(now);
    if (ledger.windowStartMs === cur) return ledger;
    if (ledger.used > 0 || ledger.waits > 0 || ledger.skips > 0 || ledger.throws > 0) {
      this.log(
        JSON.stringify({
          tag: 'upstream-weight-budget',
          event: 'window',
          venue: this.venue,
          window_start: new Date(ledger.windowStartMs).toISOString(),
          used: ledger.used,
          batch_used: ledger.batchUsed,
          interactive_used: ledger.interactiveUsed,
          waits: ledger.waits,
          skips: ledger.skips,
          throws: ledger.throws,
        }),
      );
    }
    return this.emptyLedger(now);
  }

  private writeLedger(ledger: Ledger): void {
    fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger));
  }

  /**
   * Try to acquire the O_EXCL lock. Returns the open fd on success, or null if a
   * fresh lock is held by someone else. A lock whose mtime is older than
   * `staleLockMs` (real wall-clock) is stolen. Lock staleness is a real-time
   * filesystem concern — it deliberately uses `Date.now()`, NOT the injectable
   * window clock.
   */
  private tryLock(): number | null {
    try {
      const fd = fs.openSync(this.lockPath, 'wx'); // O_CREAT | O_EXCL | O_WRONLY
      try {
        fs.writeSync(fd, `pid=${process.pid} ts=${Date.now()}\n`);
      } catch {
        /* forensic write only */
      }
      return fd;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw e;
      // Lock present — steal if stale.
      try {
        const st = fs.statSync(this.lockPath);
        if (Date.now() - st.mtimeMs > this.staleLockMs) {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            /* someone else stole it first */
          }
          try {
            const fd = fs.openSync(this.lockPath, 'wx');
            try {
              fs.writeSync(fd, `pid=${process.pid} ts=${Date.now()} (stolen)\n`);
            } catch {
              /* forensic */
            }
            return fd;
          } catch {
            return null; // lost the steal race — caller retries
          }
        }
      } catch {
        /* lock vanished between open and stat — caller retries */
      }
      return null;
    }
  }

  private releaseLock(fd: number): void {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }

  private realDelay(ms: number): Promise<void> {
    return new Promise<void>((r) => setTimeout(r, ms));
  }
}

// ── Venue budget singletons live in `venue-budget-registry.ts` ──
// OPS-ADAPTER-RATELIMIT-UNIFY-W1 C2: the HL (#1) + Binance (#2) `WeightBudget`
// instances and their CEILING/RESERVE constants moved to
// `./venue-budget-registry.ts` — the single SoT for *which* venues are budgeted —
// so the 3rd+ consumers (BYBIT/OKX/BITGET, C3) are added there per the CLAUDE.md
// "extract to a shared registry at the 3rd consumer" threshold. This module is now
// purely the engine: the `WeightBudget` class above + the weight-class ALS
// framework. The canonical HL ledger-path literal (the R6 deploy-smoke grep
// target) moved with them to `dist/lib/venue-budget-registry.js`.
