/**
 * OPS-SCRIPT-EXIT-LIFECYCLE-W1 — the ONE entrypoint wrapper every short-lived
 * `src/scripts/*` cron/CLI must use.
 *
 * ## Why this exists
 *
 * Every script tail was `.catch()`-only:
 *
 *     main().catch((err) => { console.error('Fatal:', err); closeDb(); process.exit(1); });
 *
 * — cleanup and exit wired EXCLUSIVELY to the failure branch. Because
 * `buildPoolConfig` deliberately leaves `allowExitOnIdle` unset (setting it true
 * once dropped ~90% of seed signals by aborting in-flight INSERTs), an explicit
 * close is the ONLY exit path. So crashes exited cleanly and SUCCESSES became
 * immortal: on 2026-07-21 the prod container held 86 finished-but-hung
 * `dist/scripts/*` processes — the oldest 1d06h old with 0:00 CPU — each pinning
 * 1-2 Postgres connections. With `max_connections=100` (97 usable) that
 * saturated the DB (peak 98, 4,455 `FATAL: sorry, too many clients` in 48h) and
 * surfaced as the misleading TG alert `Backfill queue check failed: ...`.
 *
 * A prior wave (OPS-SCRIPT-POOL-MAX-W1, 2026-06-05) treated the same alert by
 * capping script pools 12->2. That bought 6x headroom and delayed recurrence by
 * ~6 weeks without removing the generator. This is the generator fix.
 *
 * ## The invariant
 *
 * A short-lived script process MUST NOT outlive its work — on ANY path:
 * success, throw, or a leaked handle nobody has identified.
 *
 *   1. success -> drain -> exit(0)
 *   2. failure -> log -> drain -> exit(1)
 *   3. neither (a retained handle: un-released client, open socket, live timer)
 *      -> WATCHDOG -> exit(75)
 *
 * (3) is what makes this robust: only ~5-13% of runs actually hung, and the
 * specific pinning handle was never isolated. The watchdog bounds the process
 * WITHOUT needing to know, so the fix cannot be defeated by a leak we haven't
 * found. It is `.unref()`'d so it never itself keeps the process alive — an
 * unref'd timer still fires while the process is alive for any other reason,
 * which is exactly the zombie case.
 *
 * Draining is NOT optional and NOT skippable: `closeDb()` is fire-and-forget,
 * so `closeDb(); process.exit(0)` (the intuitive fix, and what 12 already-healthy
 * scripts do) would abort in-flight writes and reintroduce the signal loss above.
 * We `await closeDbAsync()` under a bounded grace instead.
 */
import { closeDbAsync } from './performance-db.js';

/** Hard ceiling on total process lifetime. Generous: real runs finish in seconds. */
const DEFAULT_WATCHDOG_MS = 10 * 60_000;
/** Bounded wait for in-flight writes to drain before exiting. */
const DEFAULT_DRAIN_GRACE_MS = 15_000;
/** Exit code for a watchdog-forced exit — distinct from app failure (1). */
export const EXIT_WATCHDOG = 75;

/** Default-deny env override: non-finite / non-positive falls back to `fallback`. */
function posInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Await `closeDbAsync()` but never block exit longer than `ms`. */
async function drainWithTimeout(label: string, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([closeDbAsync().then(() => 'drained' as const), timeout]);
    if (outcome === 'timeout') {
      console.error(`[script-lifecycle] DRAIN_TIMEOUT label=${label} after ${ms}ms — exiting anyway`);
    }
  } catch (err) {
    console.error(`[script-lifecycle] DRAIN_ERROR label=${label}:`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a short-lived script's `main` with guaranteed drain-then-exit on every path.
 *
 * Replaces the hand-rolled `main().catch(...)` tail. Call it inside the
 * `require.main === module` guard so the module stays test-importable:
 *
 *     if (require.main === module) {
 *       void runScript('seed-signals', main);
 *     }
 *
 * Never resolves in practice — it always terminates the process.
 */
export async function runScript(
  label: string,
  main: () => Promise<unknown>,
  opts: { watchdogMs?: number; drainGraceMs?: number } = {},
): Promise<void> {
  const watchdogMs = posInt(process.env.SCRIPT_WATCHDOG_MS, opts.watchdogMs ?? DEFAULT_WATCHDOG_MS);
  const drainGraceMs = posInt(
    process.env.SCRIPT_DRAIN_GRACE_MS,
    opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS,
  );

  const watchdog = setTimeout(() => {
    console.error(
      `[script-lifecycle] WATCHDOG label=${label} exceeded ${watchdogMs}ms — forcing exit(${EXIT_WATCHDOG}). ` +
        'A handle outlived the work; see OPS-SCRIPT-EXIT-LIFECYCLE-W1.',
    );
    process.exit(EXIT_WATCHDOG);
  }, watchdogMs);
  watchdog.unref?.();

  let code = 0;
  try {
    // A script whose `main` resolves to a number keeps that as its exit code
    // (e.g. nightly-carry-labeler returns a label-stream status). Anything else
    // is success. Out-of-range values fall back to 0 rather than corrupting exit.
    const result = await main();
    if (typeof result === 'number' && Number.isInteger(result) && result >= 0 && result < 256) {
      code = result;
    }
  } catch (err) {
    console.error(`[script-lifecycle] FATAL label=${label}:`, err);
    code = 1;
  } finally {
    await drainWithTimeout(label, drainGraceMs);
    clearTimeout(watchdog);
    process.exit(code);
  }
}
