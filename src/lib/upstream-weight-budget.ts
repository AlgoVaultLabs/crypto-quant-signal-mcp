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
 * Time-shaped reserve (OPS-HL-SCAN-SLOT-RESERVE-W1): an optional, declared `slotReserve` makes the reserve a
 * function of the window. In a SLOT window (UTC minute-of-hour ∈ `minutes`, read from the shared ledger's
 * window, so every process agrees) batch admits only if `used + w ≤ C − R − Y`, and the declared stand-down
 * batch callers only if `used + w ≤ C − R − Y − Y_b` — the same `used + w` operand as the batch test above, so
 * the top Y_b band goes to the other batch callers alone. A declared interactive stand-down caller WAITS the
 * slot window out instead of acquiring. Every other interactive caller is unchanged (`used + w ≤ C`).
 *   - A slot refusal never produces a skip: past the batch deadline it waits once more, to the next window,
 *     where today's rule decides. Only today's rule can skip or throw.
 *   - Each slot window's roll emits one flat `slot_standdown` line per stand-down batch name, zeros included:
 *     {"tag":"upstream-weight-budget","event":"slot_standdown","venue":…,"window_start":…,"caller":…,"refusals":n}
 *     `refusals` = that caller's attempts refused by the sub-cap that the slot cap would have admitted. The
 *     counts live in the ledger (`slotRefusals`, slot windows only), so they are cross-process like `used`.
 *   - Load-time validation disables the reserve (one `slot_reserve_disabled` line) on any bad declaration, and
 *     any error while evaluating the slot rule falls back to TODAY's decision for that call, with one
 *     `slot_reserve_failopen` line per window. Neither ever throws on the serving path.
 *   - Y = 0 (or no `slotReserve`) disables everything: decisions, the ledger and every log line are byte-identical
 *     to the pre-wave engine (pinned by the replay goldens).
 *
 * Build note: this module is compiled CJS (tsconfig module=Node16); it uses
 * synchronous `fs` for the lock critical section and absolute ledger/lock paths
 * — no `import.meta.url`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import { KNOWN_CALLER_LITERALS } from './caller-tags.js';
import { UpstreamRateLimitError } from './errors.js';
import { FEATURE_REGISTRY } from './feature-registry.js';
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
  /** Slot windows only, while a slot reserve is active: stand-down batch caller → sub-cap refusals. */
  slotRefusals?: Record<string, number>;
}

/**
 * A declared, venue-agnostic time-shaped reserve (OPS-HL-SCAN-SLOT-RESERVE-W1). See the module header.
 * Lists are CLOSED and match caller names exactly.
 */
export interface SlotReserveConfig {
  /** UTC minutes-of-hour whose ledger windows are slot windows, e.g. [0, 30]. */
  minutes: readonly number[];
  /** Y — extra interactive room in slot windows. 0 disables everything, Y_b included. */
  extraReserveWt: number;
  /** Y_b — the band between the stand-down sub-cap and the slot batch cap, for the other batch callers only. */
  standDownBandWt: number;
  standDown: {
    /** Batch callers held to C − R − Y − Y_b in slot windows. */
    batch: readonly string[];
    /** Interactive callers that wait slot windows out instead of acquiring. */
    interactive: readonly string[];
  };
}

/** The validated, normalized form a WeightBudget evaluates against. */
interface SlotRule {
  minutes: ReadonlySet<number>;
  y: number;
  yb: number;
  batch: readonly string[];
  batchSet: ReadonlySet<string>;
  interactiveSet: ReadonlySet<string>;
}

/** Every registry tool name and alias, plus the x402 HTTP twins: never a stand-down caller (paying traffic). */
export function isPayingToolCaller(name: string): boolean {
  if (name.startsWith('x402:')) return true;
  return FEATURE_REGISTRY.some((f) => f.name === name || f.aliases.includes(name));
}

/**
 * Load-time validation of a slot-reserve declaration. Pure; never throws.
 *   { ok: true, active: false } — no declaration, or Y = 0 (disabled, silently: today's engine).
 *   { ok: true, active: true }  — evaluate it.
 *   { ok: false, reason }       — the caller disables the reserve with one loud line.
 */
export function validateSlotReserve(
  cfg: SlotReserveConfig | undefined, ceiling: number, reserve: number, windowMs: number,
): { ok: true; active: boolean } | { ok: false; reason: string } {
  try {
    if (cfg === undefined) return { ok: true, active: false };
    const y = cfg.extraReserveWt;
    if (!Number.isInteger(y) || y < 0) return { ok: false, reason: 'extraReserveWt is not a non-negative integer' };
    if (y === 0) return { ok: true, active: false };
    const yb = cfg.standDownBandWt;
    if (!Number.isInteger(yb) || yb < 0) return { ok: false, reason: 'standDownBandWt is not a non-negative integer' };
    if (ceiling - reserve - y < 0) return { ok: false, reason: `extraReserveWt ${y} exceeds ceiling − reserve ${ceiling - reserve}` };
    if (yb > ceiling - reserve - y) return { ok: false, reason: `standDownBandWt ${yb} outside [0, ceiling − reserve − Y = ${ceiling - reserve - y}]` };
    if (!(windowMs > 0 && windowMs <= 60_000 && 60_000 % windowMs === 0)) return { ok: false, reason: `windowMs ${windowMs} does not divide a minute` };
    const minutes = cfg.minutes;
    if (!Array.isArray(minutes) || minutes.length === 0) return { ok: false, reason: 'minutes is empty' };
    if (minutes.some((m) => !Number.isInteger(m) || m < 0 || m > 59) || new Set(minutes).size !== minutes.length) {
      return { ok: false, reason: 'minutes must be unique integers in [0, 59]' };
    }
    const batch = cfg.standDown?.batch, inter = cfg.standDown?.interactive;
    if (!Array.isArray(batch) || !Array.isArray(inter)) return { ok: false, reason: 'standDown.batch / standDown.interactive must be arrays' };
    const all = [...batch, ...inter];
    if (all.some((n) => typeof n !== 'string' || n.length === 0)) return { ok: false, reason: 'a stand-down name is not a non-empty string' };
    if (new Set(all).size !== all.length) return { ok: false, reason: 'a stand-down name is listed twice' };
    const paying = all.find((n) => isPayingToolCaller(n));
    if (paying !== undefined) return { ok: false, reason: `stand-down name ${paying} is a paying-tool caller` };
    const unknown = all.find((n) => !KNOWN_CALLER_LITERALS.has(n));
    if (unknown !== undefined) return { ok: false, reason: `stand-down name ${unknown} is not a known caller literal (caller-tags.ts)` };
    return { ok: true, active: true };
  } catch (e) {
    return { ok: false, reason: `validation error: ${e instanceof Error ? e.message : String(e)}` };
  }
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
  /** Optional time-shaped reserve (OPS-HL-SCAN-SLOT-RESERVE-W1). Absent or Y = 0 ⇒ today's engine, byte for byte. */
  slotReserve?: SlotReserveConfig;
  /** Test seam: called at the start of every slot-rule evaluation; a throw exercises the fail-open path. */
  slotFaultInjectForTest?: (windowStartMs: number) => void;
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
  private readonly slot: SlotRule | null;
  private readonly slotFault: ((windowStartMs: number) => void) | undefined;
  private lastFailopenWindowMs = -1;

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
    this.slotFault = opts.slotFaultInjectForTest;
    const v = validateSlotReserve(opts.slotReserve, this.ceiling, this.reserve, this.windowMs);
    if (!v.ok) {
      this.slot = null; // a bad declaration disables the reserve (Y = 0) — never a throw at construction
      this.log(JSON.stringify({ tag: 'upstream-weight-budget', event: 'slot_reserve_disabled', venue: this.venue, reason: v.reason }));
    } else if (v.active && opts.slotReserve) {
      const s = opts.slotReserve;
      this.slot = {
        minutes: new Set(s.minutes), y: s.extraReserveWt, yb: s.standDownBandWt,
        batch: [...s.standDown.batch], batchSet: new Set(s.standDown.batch), interactiveSet: new Set(s.standDown.interactive),
      };
    } else {
      this.slot = null;
    }
  }

  /** True when a slot reserve is active and the window starting at `windowStartMs` is a slot window. */
  private isSlotWindow(windowStartMs: number): boolean {
    return this.slot !== null && this.slot.minutes.has(new Date(windowStartMs).getUTCMinutes());
  }

  /**
   * The batch cap for `caller` in the window starting at `windowStartMs`: today's `ceiling − reserve`, or in a
   * slot window `ceiling − reserve − Y` (stand-down callers: `− Y_b` more). ONE derivation, read by `acquire()`
   * and by `batchHeadroom()`. `slotCap` is the non-stand-down slot cap (null outside slot windows).
   */
  private batchCaps(windowStartMs: number, caller: string): { cap: number; slotCap: number | null } {
    const base = this.ceiling - this.reserve;
    if (!this.slot || !this.isSlotWindow(windowStartMs)) return { cap: base, slotCap: null };
    const slotCap = base - this.slot.y;
    return { cap: this.slot.batchSet.has(caller) ? slotCap - this.slot.yb : slotCap, slotCap };
  }

  /** One `slot_reserve_failopen` line per window per process. Never throws. */
  private slotFailopen(windowStartMs: number, e: unknown): void {
    if (windowStartMs === this.lastFailopenWindowMs) return;
    this.lastFailopenWindowMs = windowStartMs;
    try {
      this.log(JSON.stringify({
        tag: 'upstream-weight-budget', event: 'slot_reserve_failopen', venue: this.venue,
        window_start: new Date(windowStartMs).toISOString(), error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      }));
    } catch { /* a log sink fault must not reach the serving path */ }
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
    let slotExtended = false; // a slot refusal past the deadline waits ONE more window instead of skipping

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
        let cap = cls === 'interactive' ? this.ceiling : this.ceiling - this.reserve;
        // Slot rule (OPS-HL-SCAN-SLOT-RESERVE-W1). Evaluated only when a reserve is active; any error falls back to
        // TODAY's decision for this call. The operand stays `used + w`.
        let slotWait = false; // a declared interactive stand-down caller waits the slot window out
        let slotRefused = false; // the slot rule refused a batch attempt today's rule would admit
        let subCapRefusal = false; // … and it was the stand-down sub-cap, not the slot cap, that refused it
        if (this.slot) {
          try {
            this.slotFault?.(ledger.windowStartMs);
            if (cls === 'batch') {
              const caps = this.batchCaps(ledger.windowStartMs, caller);
              if (caps.slotCap !== null) {
                cap = caps.cap;
                slotRefused = ledger.used + weight > caps.cap && ledger.used + weight <= this.ceiling - this.reserve;
                subCapRefusal = caps.cap < caps.slotCap && ledger.used + weight > caps.cap && ledger.used + weight <= caps.slotCap;
              }
            } else if (now < deadline && this.slot.interactiveSet.has(caller) && this.isSlotWindow(ledger.windowStartMs)) {
              slotWait = true;
            }
          } catch (e) {
            cap = cls === 'interactive' ? this.ceiling : this.ceiling - this.reserve;
            slotWait = false; slotRefused = false; subCapRefusal = false;
            this.slotFailopen(ledger.windowStartMs, e);
          }
        }

        if (slotWait) {
          ledger.waits += 1;
          decision = 'wait';
        } else if (ledger.used + weight <= cap) {
          ledger.used += weight;
          if (cls === 'batch') ledger.batchUsed += weight;
          else ledger.interactiveUsed += weight;
          decision = 'acquired';
        } else if (cls === 'interactive') {
          ledger.throws += 1;
          secondsToRoll = this.secondsToRoll(now);
          decision = 'throw';
        } else if (now >= deadline && !(slotRefused && !slotExtended)) {
          ledger.skips += 1;
          decision = 'skip';
        } else {
          if (now >= deadline) slotExtended = true; // only a slot refusal reaches here past the deadline
          ledger.waits += 1;
          decision = 'wait';
        }
        if (subCapRefusal && decision !== 'acquired') this.countSubCapRefusal(ledger, caller);
        this.writeLedger(ledger);
        // Per-caller accounting, in the SAME critical section, AFTER the decision is final. It reads
        // nothing the decision depends on and never throws, so admission is byte-identical.
        this.account(ledger, decision, weight, cls, caller);
      } finally {
        this.releaseLock(fd);
      }

      if (decision === 'acquired') {
        // Telemetry: an acquire that WAITED before fitting — batch backpressure, or a stand-down caller's
        // slot wait (class `interactive`). Without a slot reserve interactive never waits, so this is unchanged.
        if (totalWaitMs > 0) recordRateLimitEvent(this.venue, 'wait', null, cls, totalWaitMs, currentCaller());
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
        // A stand-down caller that waited a slot window out and then hit the ceiling still leaves its wait row.
        if (totalWaitMs > 0) recordRateLimitEvent(this.venue, 'wait', null, cls, totalWaitMs, currentCaller());
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
      if (waitMs >= WAIT_LOG_THRESHOLD_MS && cls === 'batch') { // `batch_wait` stays batch-only
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
    const ws = this.windowStartFor(now);
    let cap = this.ceiling - this.reserve;
    try {
      cap = this.batchCaps(ws, currentCaller()).cap; // the slot-aware cap `acquire()` uses (OPS-HL-SCAN-SLOT-RESERVE-W1 R6)
    } catch {
      /* advisory only: today's cap */
    }
    const ledger = this.readLedgerRaw(now);
    if (ledger.windowStartMs !== ws) return cap; // window already rolled
    return Math.max(0, cap - ledger.batchUsed);
  }

  /** Count a stand-down sub-cap refusal on the ledger's slot record (initialized with zeros at the window's start). */
  private countSubCapRefusal(ledger: Ledger, caller: string): void {
    try {
      if (ledger.slotRefusals && Object.prototype.hasOwnProperty.call(ledger.slotRefusals, caller)) ledger.slotRefusals[caller] += 1;
    } catch (e) {
      this.slotFailopen(ledger.windowStartMs, e);
    }
  }

  /** One flat `slot_standdown` line per declared stand-down batch name for a CLOSED slot window. Never throws. */
  private emitSlotStanddown(ledger: Ledger): void {
    try {
      if (!this.slot || !ledger.slotRefusals) return;
      const windowStart = new Date(ledger.windowStartMs).toISOString();
      for (const name of this.slot.batch) {
        const n = ledger.slotRefusals[name];
        if (!Number.isInteger(n) || n < 0) continue; // a damaged count is left MISSING, never written as a zero
        this.log(JSON.stringify({ tag: 'upstream-weight-budget', event: 'slot_standdown', venue: this.venue, window_start: windowStart, caller: name, refusals: n }));
      }
    } catch (e) {
      this.slotFailopen(ledger.windowStartMs, e);
    }
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
    const ledger: Ledger = {
      windowStartMs: this.windowStartFor(now),
      used: 0,
      batchUsed: 0,
      interactiveUsed: 0,
      waits: 0,
      skips: 0,
      throws: 0,
    };
    // A slot window's record starts with every stand-down batch name at ZERO, so a zero at roll is a measured
    // zero; a window started by no active process carries no record and emits no slot_standdown line at all.
    if (this.slot && this.isSlotWindow(ledger.windowStartMs)) ledger.slotRefusals = Object.fromEntries(this.slot.batch.map((n) => [n, 0]));
    return ledger;
  }

  private readLedgerRaw(now: number): Ledger {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8')) as Partial<Ledger>;
      if (typeof parsed.windowStartMs !== 'number' || typeof parsed.used !== 'number') {
        return this.emptyLedger(now);
      }
      const ledger: Ledger = {
        windowStartMs: parsed.windowStartMs,
        used: parsed.used,
        batchUsed: parsed.batchUsed ?? 0,
        interactiveUsed: parsed.interactiveUsed ?? 0,
        waits: parsed.waits ?? 0,
        skips: parsed.skips ?? 0,
        throws: parsed.throws ?? 0,
      };
      const sr = parsed.slotRefusals;
      if (sr && typeof sr === 'object' && !Array.isArray(sr)) {
        ledger.slotRefusals = Object.fromEntries(Object.entries(sr).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0));
      }
      return ledger;
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
    if (ledger.slotRefusals) this.emitSlotStanddown(ledger); // slot windows only; absent at Y = 0
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
