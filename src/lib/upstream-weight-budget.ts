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
 * Per-caller acquisition accounting (OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH2): the ledger knew every
 * granted weight and discarded who asked. A per-venue SIDECAR (`<ledger>.callers.json`, beside the ledger,
 * whose keys are untouched) records (caller, class) → {weight, grants, waits, skips, throws} in the SAME
 * critical section that mutates `used`, and each window roll emits one flat line per (caller, class):
 *   {"tag":"upstream-weight-budget","event":"window_caller","venue":…,"window_start":…,"caller":…,
 *    "class":…,"weight":…,"grants":…,"waits":…,"skips":…,"throws":…,"accounting_errors":…}
 * Invariant per venue per window: Σ weight == used, Σ batch == batchUsed, Σ interactive ==
 * interactiveUsed — by construction for every acquisition whose sidecar write succeeds. Past a key cap
 * the weight folds into `_overflow`; an accounting fault puts it into `_error` where possible and is
 * counted in `accounting_errors`; a sidecar that cannot be written leaves a visible `used − Σ` shortfall.
 * ADMISSION IS UNCHANGED: every decision is taken from the ledger before the sidecar is touched, and an
 * accounting fault never throws. The existing `window` line is byte-identical.
 *
 * Build note: this module is compiled CJS (tsconfig module=Node16); it uses
 * synchronous `fs` for the lock critical section and absolute ledger/lock paths
 * — no `import.meta.url`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { UpstreamRateLimitError } from './errors.js';
import { recordRateLimitEvent } from './rate-limit-events.js';
import { processEntrypoint } from './runtime.js';

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
// the WHO, class is the priority lane. A path with no caller context attributes to
// `unattributed:<entrypoint>` (OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1 — it replaced the single
// 'unknown' bucket every untagged process shared): fail-open, it never throws, and it still NAMES the
// spending process, so no acquisition is anonymous.
const callerContext = new AsyncLocalStorage<string>();

/** The no-context caller name for this process: `unattributed:<entrypoint>`. */
export function unattributedCaller(entrypoint: string = processEntrypoint()): string {
  return `unattributed:${entrypoint}`;
}

/** Current caller for the running async context. Defaults to `unattributed:<entrypoint>`. */
export function currentCaller(): string {
  return callerContext.getStore() ?? unattributedCaller();
}

/** Run `fn` (and all async work it spawns) tagged with `caller` (weight class unchanged). */
export function runAsCaller<T>(caller: string, fn: () => T): T {
  return callerContext.run(caller, fn);
}

/** Current weight class for the running async context. Defaults to `interactive`. */
export function currentWeightClass(): WeightClass {
  return weightClassContext.getStore() ?? 'interactive';
}

/**
 * Run `fn` (and all async work it spawns) under the `batch` weight class, tagged `caller`.
 * The caller is REQUIRED (OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1): an untagged batch wrapper does
 * not compile. A nested wrapper must pass its enclosing scope's name — a named inner call OVERRIDES the
 * outer caller. Names are checked by scripts/check-caller-tags.mjs (CALLER_TAG_VERDICT).
 */
export function runAsBatch<T>(fn: () => Promise<T>, caller: string): Promise<T> {
  return weightClassContext.run('batch', () => callerContext.run(caller, fn));
}

/** Run `fn` under the `interactive` weight class (explicit override of a batch scope), tagged `caller` (REQUIRED). */
export function runAsInteractive<T>(fn: () => Promise<T>, caller: string): Promise<T> {
  return weightClassContext.run('interactive', () => callerContext.run(caller, fn));
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
  /** Per-caller accounting sidecar (default `<ledger>.callers.json`). Test seam for fault injection. */
  callersPath?: string;
  /** Distinct named (caller, class) keys per window before weight folds into `_overflow` (default 64). */
  callerKeyCap?: number;
}

type Decision = 'acquired' | 'throw' | 'wait' | 'skip';

/** One (caller, class) row of the per-caller sidecar. */
interface CallerEntry {
  caller: string;
  cls: WeightClass;
  weight: number;
  grants: number;
  waits: number;
  skips: number;
  throws: number;
}

/** The per-venue, per-window caller sidecar. `accountingErrors` counts faults, never guesses. */
interface CallerSidecar {
  windowStartMs: number;
  entries: CallerEntry[];
  accountingErrors: number;
}

/** Weight past the key cap. It still carries weight, so Σ == used holds. */
const OVERFLOW_CALLER = '_overflow';
/** Weight whose attribution faulted after admission. */
const ERROR_CALLER = '_error';
const DEFAULT_CALLER_KEY_CAP = 64;

/** The per-caller sidecar beside a ledger: `/tmp/algovault-hl-weight.json` → `/tmp/algovault-hl-weight.callers.json`. */
export function callerSidecarPath(ledgerPath: string): string {
  return ledgerPath.endsWith('.json') ? `${ledgerPath.slice(0, -5)}.callers.json` : `${ledgerPath}.callers.json`;
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
  private readonly callersPath: string;
  private readonly callerKeyCap: number;

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
    this.callersPath = opts.callersPath ?? callerSidecarPath(opts.ledgerPath);
    this.callerKeyCap = opts.callerKeyCap ?? DEFAULT_CALLER_KEY_CAP;
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
    const caller = currentCaller(); // read ONCE: the ALS context is fixed for this acquire

    for (;;) {
      const fd = this.tryLock();
      if (fd === null) {
        // Lockfile held by a fresh holder — yield (real time) and retry. This
        // does NOT advance the injected window clock.
        await this.realDelay(this.lockRetryMs + Math.floor(Math.random() * this.lockRetryMs));
        continue;
      }

      let decision: Decision = 'acquired';
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
        // Per-caller accounting, in the SAME critical section, AFTER the decision is final. It reads
        // nothing the decision depends on and never throws, so admission is byte-identical.
        this.account(ledger, decision, weight, cls, caller);
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
        recordRateLimitEvent(this.venue, 'throw', 'BUDGET_CEILING', cls, undefined, currentCaller());
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

  /**
   * Weight a `batch` caller could still acquire in the CURRENT window, without acquiring
   * anything. Read-only: it takes no lock, writes no ledger, and changes no behaviour.
   *
   * It lives here rather than in the caller for two reasons, both load-bearing:
   *
   *   1. **One derivation of the cap.** `ceiling − reserve` is what `acquire()` compares a batch
   *      request against. A caller rebuilding it from `venue-budget-registry.ts`'s 15 exported
   *      `*_CEILING` / `*_RESERVE` pairs would be a second derivation of one number, and the copy
   *      nobody is watching is the one that goes wrong.
   *   2. **Window staleness is invisible from outside.** `_readLedger()` deliberately does NOT
   *      roll, so once a window closes the file still carries the PREVIOUS window's totals until
   *      somebody acquires. An external reader cannot tell — `windowMs` is private — and would
   *      report a saturated lane a full minute after it emptied. That check needs
   *      `windowStartFor`, so it belongs in here.
   *
   * NOT a guard, and a caller must not treat it as one: the headroom reported here can be taken
   * by any other process before that caller reaches its own `acquire()`, which remains the sole
   * authority. It exists only to let a caller skip a request it can predict will stall.
   * (OPS-BAND-OUTCOME-WIRE-W1 R1.)
   */
  batchHeadroom(): number {
    const now = this.now();
    const cap = this.ceiling - this.reserve;
    const ledger = this.readLedgerRaw(now);
    if (ledger.windowStartMs !== this.windowStartFor(now)) return cap; // window already rolled
    return Math.max(0, cap - ledger.batchUsed);
  }

  // ── per-caller accounting (OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH2) — fail-open, never throws ──

  /** Read the sidecar. ENOENT → none; unparseable → none + corrupt; any other read error THROWS (→ fault path). */
  private readSidecar(): { side: CallerSidecar | null; corrupt: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.callersPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { side: null, corrupt: false };
      throw e;
    }
    try {
      const p = JSON.parse(raw) as Partial<CallerSidecar>;
      if (typeof p.windowStartMs !== 'number' || !Array.isArray(p.entries)) return { side: null, corrupt: true };
      const entries = p.entries.filter(
        (e): e is CallerEntry => !!e && typeof e.caller === 'string' && (e.cls === 'batch' || e.cls === 'interactive') && typeof e.weight === 'number',
      );
      return { side: { windowStartMs: p.windowStartMs, entries, accountingErrors: Number(p.accountingErrors) || 0 }, corrupt: false };
    } catch {
      return { side: null, corrupt: true };
    }
  }

  private writeSidecar(side: CallerSidecar): void {
    fs.writeFileSync(this.callersPath, JSON.stringify(side));
  }

  /** The row for (caller, cls), created on first use; past the key cap the weight folds into `_overflow`. */
  private entryFor(side: CallerSidecar, caller: string, cls: WeightClass): CallerEntry {
    let e = side.entries.find((x) => x.caller === caller && x.cls === cls);
    if (e) return e;
    const named = side.entries.filter((x) => x.caller !== OVERFLOW_CALLER && x.caller !== ERROR_CALLER).length;
    const key = named >= this.callerKeyCap && caller !== ERROR_CALLER ? OVERFLOW_CALLER : caller;
    e = side.entries.find((x) => x.caller === key && x.cls === cls);
    if (!e) {
      e = { caller: key, cls, weight: 0, grants: 0, waits: 0, skips: 0, throws: 0 };
      side.entries.push(e);
    }
    return e;
  }

  private static apply(e: CallerEntry, decision: Decision, weight: number): void {
    if (decision === 'acquired') { e.weight += weight; e.grants += 1; }
    else if (decision === 'throw') e.throws += 1;
    else if (decision === 'skip') e.skips += 1;
    else e.waits += 1;
  }

  /** Emit one flat `window_caller` line per (caller, class) of a CLOSED window. Key order is fixed. */
  private emitCallerWindow(side: CallerSidecar): void {
    const rows = [...side.entries].sort((a, b) => (a.cls === b.cls ? a.caller.localeCompare(b.caller) : a.cls.localeCompare(b.cls)));
    const windowStart = new Date(side.windowStartMs).toISOString();
    for (const e of rows) {
      this.log(
        JSON.stringify({
          tag: 'upstream-weight-budget',
          event: 'window_caller',
          venue: this.venue,
          window_start: windowStart,
          caller: e.caller,
          class: e.cls,
          weight: e.weight,
          grants: e.grants,
          waits: e.waits,
          skips: e.skips,
          throws: e.throws,
          accounting_errors: side.accountingErrors,
        }),
      );
    }
  }

  /** Record this decision against (caller, cls). Called under the lock, after the decision. NEVER throws. */
  private account(ledger: Ledger, decision: Decision, weight: number, cls: WeightClass, caller: string): void {
    try {
      const read = this.readSidecar();
      let side = read.side;
      if (side && side.windowStartMs !== ledger.windowStartMs) {
        if (side.entries.length > 0) this.emitCallerWindow(side); // the closed window's attribution
        side = null;
      }
      if (side === null) {
        // A fresh sidecar for THIS window. If the ledger already shows activity from before this decision,
        // that earlier activity has no attribution (a lost, corrupt or unwritable sidecar): count it as ONE
        // accounting error and leave the shortfall visible — never re-attribute it to anyone.
        const priorWeight = ledger.used - (decision === 'acquired' ? weight : 0);
        const priorEvents = ledger.waits + ledger.skips + ledger.throws - (decision === 'acquired' ? 0 : 1);
        const fault = read.corrupt || priorWeight > 0 || priorEvents > 0;
        side = { windowStartMs: ledger.windowStartMs, entries: [], accountingErrors: fault ? 1 : 0 };
      }
      WeightBudget.apply(this.entryFor(side, caller, cls), decision, weight);
      this.writeSidecar(side);
    } catch {
      this.accountFault(ledger.windowStartMs, decision, weight, cls);
    }
  }

  /** The fault path: put the decision into `_error` and count it, if the sidecar can be written at all. */
  private accountFault(windowStartMs: number, decision: Decision, weight: number, cls: WeightClass): void {
    try {
      let side: CallerSidecar | null = null;
      try { side = this.readSidecar().side; } catch { side = null; }
      if (!side || side.windowStartMs !== windowStartMs) side = { windowStartMs, entries: [], accountingErrors: 0 };
      side.accountingErrors += 1;
      WeightBudget.apply(this.entryFor(side, ERROR_CALLER, cls), decision, weight);
      this.writeSidecar(side);
    } catch {
      /* the sidecar cannot be written at all: the `used − Σ` shortfall is what CH3's UNATTRIB_PCT reads */
    }
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
