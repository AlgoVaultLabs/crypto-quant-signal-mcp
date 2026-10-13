/**
 * rail-mount.ts — OPS-A2MCP-SERVED-TRUTH-W1 CH2-A (A2): a SELF-HEALING mount for an HTTP payment rail.
 *
 * WHY. The okx.ai A2MCP rail initialised its facilitator ONCE at boot. When OKX refused
 * `getSupported()` (401), `initialize()` threw, the mount caught it, and the rail stayed dark until
 * the next deploy — 257 boots later nobody could say which one first failed. A transient facilitator
 * outage at boot therefore cost a whole deploy cycle, and a persistent one was invisible.
 *
 * WHAT. `createRailDispatcher` returns ONE dispatcher the caller registers for `<prefix>/*` at boot, and runs
 * `init()` in the background with jittered backoff (1, 5, 15, 60 min, then hourly) until it succeeds:
 *   - not ready → every `<prefix>/*` request gets `503` + `Retry-After` + `X-Rail-State:
 *     initializing; since=<ISO>`, and the dispatcher NEVER calls `next()` for those paths, so the
 *     paid route handlers registered behind it can never run unpaid;
 *   - ready → it delegates to the payment middleware `init()` returned, and reports the rail served.
 * The drift canary's leg C reads that header: younger than 30 min is INDETERMINATE, older is
 * DISAGREE `stuck_initializing` — so a rail that cannot come up pages within a week.
 *
 * WHY AN APP-LEVEL ROUTE, NEVER A ROUTER OR `use()` AT `<prefix>` (F9). `@okxweb3/x402-express`
 * matches `req.path` against `^/a2mcp/<tool>$`. Inside a router (or a `use()`) mounted at `/a2mcp`,
 * Express strips the mount path, `req.path` is `/<tool>`, nothing matches, no payment is required,
 * and every paid route is served FREE. The caller registers the dispatcher as an app-level ROUTE,
 * `app.all(\`${PREFIX_CONST}/*\`, handle.dispatch)`, which never rewrites `req.url`, so `req.path`
 * stays the full path. The path is written AT THE CALL SITE from the rail's own exported constant,
 * because the form-action conformance gate places registrations statically: a path-less
 * `app.use(fn)` delegating to a runtime-assigned handler, or a path built from a runtime parameter,
 * made it INDETERMINATE for every form in the app (measured, CH2-A).
 *
 * NO UNHANDLED REJECTION. The app installs no `unhandledRejection` handler (measured: 0 in
 * dist/index.js), so every promise this module creates carries a `.catch`. Retry timers are
 * `unref()`d so they never hold a process open.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { markServed, markDark, type PaidRail } from './rail-served-state.js';

/** Backoff steps (ms) after each failed attempt; the last repeats forever (hourly). */
export const RAIL_MOUNT_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000];

export interface RailMountTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  now(): number;
  random(): number;
}

const REAL_TIMERS: RailMountTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    return t;
  },
  now: () => Date.now(),
  random: () => Math.random(),
};

export interface RailMountOptions {
  rail: PaidRail;
  /** Path prefix the dispatcher owns, e.g. `/a2mcp`. Requests outside it pass straight through. */
  prefix: string;
  /** Mode reported to rail-served-state once ready (e.g. `live`). */
  mode: string;
  /** Number of routes the rail serves once ready (reported only). */
  routes: number;
  /**
   * Initialise the rail and return the request handler to delegate to once ready (the payment
   * middleware). Throwing = not ready yet; the loop retries on the backoff schedule.
   */
  init: () => Promise<RequestHandler>;
  /** Bound on one attempt, so a hung facilitator cannot stall the loop (default 30 s). */
  attemptTimeoutMs?: number;
  /** Test seam: timers + clock + jitter source. */
  timers?: RailMountTimers;
}

export interface RailMountHandle {
  /** The dispatcher. Register it BEFORE the rail's route handlers: `app.all(\`${PREFIX}/*\`, h.dispatch)`. */
  dispatch: RequestHandler;
  /** Resolves after the FIRST attempt settles (success or failure); never rejects. */
  firstAttempt: Promise<void>;
  isReady(): boolean;
  attempts(): number;
}

/** ±20 % jitter, never below 1 s. */
export function jitteredDelay(baseMs: number, random: number): number {
  return Math.max(1_000, Math.round(baseMs * (0.8 + 0.4 * random)));
}

/** Backoff delay before attempt `failures + 1`, given `failures` consecutive failures so far. */
export function backoffFor(failures: number): number {
  const i = Math.min(Math.max(failures - 1, 0), RAIL_MOUNT_BACKOFF_MS.length - 1);
  return RAIL_MOUNT_BACKOFF_MS[i];
}

function withTimeout<T>(p: Promise<T>, ms: number, timers: RailMountTimers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    timers.setTimeout(() => {
      if (!done) { done = true; reject(new Error(`init attempt timed out after ${ms}ms`)); }
    }, ms);
    p.then(
      (v) => { if (!done) { done = true; resolve(v); } },
      (e) => { if (!done) { done = true; reject(e); } },
    );
  });
}

/**
 * Build the dispatcher and start the init loop. The caller registers `dispatch` on the app BEFORE the
 * rail's route handlers, so it sits in front of them in Express's stack.
 */
export function createRailDispatcher(opts: RailMountOptions): RailMountHandle {
  const timers = opts.timers ?? REAL_TIMERS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 30_000;
  const since = new Date(timers.now()).toISOString();
  const owns = (p: string): boolean => p === opts.prefix || p.startsWith(`${opts.prefix}/`);

  let ready: RequestHandler | null = null;
  let attempts = 0;
  let failures = 0;
  let nextAttemptAt = timers.now();

  markDark(opts.rail, `initializing since ${since}`);

  const dispatch: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!owns(req.path)) return next();
    if (ready) return ready(req, res, next);
    const retryAfterS = Math.max(1, Math.ceil((nextAttemptAt - timers.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfterS));
    res.setHeader('X-Rail-State', `initializing; since=${since}`);
    res.status(503).json({
      error: 'rail_initializing',
      code: 'RAIL_INITIALIZING',
      rail: opts.rail,
      since,
      retry_after_s: retryAfterS,
      message: `The ${opts.prefix} payment rail is starting; retry after ${retryAfterS}s.`,
    });
    // Deliberately no next(): the paid handlers behind this dispatcher must never run unpaid.
  };

  const attempt = (): Promise<void> => {
    attempts++;
    let p: Promise<RequestHandler>;
    try {
      p = opts.init();
    } catch (e) {
      p = Promise.reject(e);
    }
    return withTimeout(p, attemptTimeoutMs, timers)
      .then((handler) => {
        ready = handler;
        markServed(opts.rail, { mode: opts.mode, routes: opts.routes });
        console.log(`[rail-mount] ${opts.rail} ready after ${attempts} attempt(s)`);
      })
      .catch((err: unknown) => {
        failures++;
        const delay = jitteredDelay(backoffFor(failures), timers.random());
        nextAttemptAt = timers.now() + delay;
        const msg = err instanceof Error ? err.message : String(err);
        markDark(opts.rail, `initializing since ${since} (attempt ${attempts} failed: ${msg})`);
        console.error(`[rail-mount] ${opts.rail} init attempt ${attempts} failed: ${msg} — next in ${Math.round(delay / 1000)}s`);
        timers.setTimeout(() => {
          attempt().catch(() => { /* attempt() never rejects; belt and braces */ });
        }, delay);
      });
  };

  const firstAttempt = attempt().catch(() => { /* never rejects */ });
  return {
    dispatch,
    firstAttempt,
    isReady: () => ready !== null,
    attempts: () => attempts,
  };
}
