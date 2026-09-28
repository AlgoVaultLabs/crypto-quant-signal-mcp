/**
 * IDENTITY-LIFECYCLE-W3 CH1 R5 — the dispatcher, invoked by `ops/cron/lifecycle-dispatch.sh`.
 *
 * CH1 ships the HARNESS WITH ZERO STEPS REGISTERED. That is the chapter boundary, not an
 * oversight: the step predicates are CH2's scope, and a dispatcher that evaluated them here
 * would put CH2's behaviour on the host a chapter early with no readout to observe it.
 *
 * WHY THIS IS `docker exec … node dist/…` AND NOT psql. The eligible set is a function of the
 * MONTHLY METER, and that meter is a ROLLING 30-DAY WINDOW whose expiry rule lives in
 * `loadQuotaRows` (`src/lib/license.ts`): a row whose `period_start` is more than 30 days old is
 * SKIPPED and reads as zero usage. A cron reading `quota_usage` with raw SQL does not know that
 * — MEASURED 2026-09-08, two of the three metered email-bound buckets on signal-1 sit in expired
 * periods — so it would mail "you hit the wall" from a period that ended weeks ago. Single
 * derivation: the app owns the meter, the cron asks the app.
 *
 * Exit contract: `LIFECYCLE_DISPATCH_VERDICT=PASS|FAIL|INDETERMINATE` → 0 / 1 / 3.
 * 3 is the token-law default for a NEW gate. Callers gate on the TOKEN, never the bare code.
 */
import { runScript } from '../lib/script-lifecycle.js';
import { awaitDbWrites } from '../lib/performance-db.js';
import { primeMeter } from '../lib/lifecycle/meter.js';
import { evaluateStep, type StepEvaluation } from '../lib/lifecycle/steps.js';
import { ensureLifecycleSchema } from '../lib/lifecycle/schema.js';
import {
  listStepStates, listRetryable, markFailed, recordSent, stampHeartbeat, listShadowClaims, closeClaim,
  getStepState, markCanaryBatchDone, readHeartbeat, parseDbTimestamp,
} from '../lib/lifecycle/ledger.js';
import {
  resolveMode, sendLifecycle, isStepLive, stepLiveState, CANARY_BATCH_SIZE, type LifecycleMode,
} from '../lib/lifecycle/engine.js';
import { sendLifecycleMessage } from '../lib/email.js';
import { unsubscribeUrl } from '../lib/lifecycle/identity.js';
import { API_BASE, STEP_PRIORITY, type LifecycleStep } from '../lib/lifecycle-copy.js';

const TAG = '[lifecycle-dispatch]';
const MAX_ATTEMPTS = 5;
const RETRY_BATCH = 25;

/**
 * Stamp liveness, THEN print the verdict and exit.
 *
 * The heartbeat is written on EVERY exit path including INDETERMINATE and including a tick that
 * found nothing to do — because with zero eligible recipients (the measured state for three of
 * four steps) a stalled dispatcher and a healthy one leave identical ledgers, so the ledger
 * cannot answer "is the cron alive". A skip still stamps liveness.
 *
 * The stamp is best-effort: if the DB is the thing that is broken, we still owe the caller a
 * verdict token, and losing the heartbeat is strictly better than losing the token.
 */
async function emit(verdict: 'PASS' | 'FAIL' | 'INDETERMINATE', note: string, eligible = 0): Promise<number> {
  try {
    await stampHeartbeat('lifecycle-dispatch', verdict, eligible, new Date(), note.slice(0, 200));
    // SETTLE IT BEFORE WE EXIT. `dbRun` is fire-and-forget on Postgres — it returns before the
    // statement is even sent — and `runScript` ends the pool immediately after `main` resolves.
    // MEASURED on signal-1: the tick logged `PG migration error: Cannot use a pool after calling
    // end on the pool`, which is that race arriving. A lost heartbeat is not cosmetic: the health
    // canary's stall leg reads exactly this row, so a dropped write eventually pages
    // "dispatcher stalled" about a dispatcher that ran perfectly. `awaitDbWrites` settles
    // in-flight writes WITHOUT closing, and is a no-op on SQLite, so this one line is correct on
    // both backends without branching on DATABASE_URL.
    await awaitDbWrites();
  } catch {
    console.log(`${TAG} heartbeat stamp failed — verdict still reported below`);
  }
  console.log(`${TAG} ${new Date().toISOString()} LIFECYCLE_DISPATCH_VERDICT=${verdict} ${note}`);
  // RETURNS the code; it does NOT call process.exit(). `runScript` owns termination — it drains
  // the Postgres pool and arms a watchdog, and a bare process.exit() here would skip the drain
  // and pin a connection for the life of the container (OPS-SCRIPT-EXIT-LIFECYCLE-W1).
  return verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3;
}

/**
 * A step supplies CANDIDATES. It does not send, meter, cap or decide — `runStep` below does all
 * of that, identically for every step.
 *
 * The split is the whole design. CH2 adds four predicates and NOTHING else: no step can forget
 * the canary batch, mis-order the gates, or skip the suppression check, because no step is given
 * the chance to. A per-step send loop would have been four opportunities to diverge.
 */
export type StepCandidateSource = (now: Date) => Promise<StepEvaluation>;

/**
 * CH2 — the four usage predicates, registered.
 *
 * `product_updates` is deliberately absent: it is CH4's, it reads `signup_emails` rather than the
 * meter, and its cadence is monthly rather than every 15 minutes. Registering it here would make
 * the digest a function of this cron's schedule instead of its own.
 *
 * Each entry is a CANDIDATE SOURCE, not a sender. `runStep` below owns the canary batch, the
 * ordering and every gate, so no predicate can forget one.
 */
const STEP_CANDIDATES: Partial<Record<LifecycleStep, StepCandidateSource>> = {
  quota_wall: (now) => evaluateStep('quota_wall', now),
  quota_80: (now) => evaluateStep('quota_80', now),
  reset_return: (now) => evaluateStep('reset_return', now),
  activation_nudge: (now) => evaluateStep('activation_nudge', now),
};

export interface StepTotals {
  wouldSend: number; sent: number; suppressed: number; capped: number; skipped: number; expired: number;
}

/**
 * Drive ONE step over its candidates. The canary rule lives here, once.
 *
 * FIRST LIVE TICK IS A BATCH OF <= 5 (architect ruling Q1(A)), and the budget covers EVERY send in
 * the step — consumed claims and new eligibles alike. `markCanaryBatchDone` is stamped once that
 * batch has actually sent something, and from the next tick the step is unthrottled. (The W3
 * docstring said the next tick waits for a clean batch; the code never did — it is the next tick,
 * 15 minutes later. Recorded, not silently "fixed": the approved term is "<= 5 on the first live
 * tick".) A step still in shadow has no budget concept at all.
 *
 * LIVE STEPS CONSUME THEIR SHADOW CLAIMS FIRST, OLDEST FIRST (R2). Each `would_send` row is
 * re-evaluated against the step predicate AS OF NOW: still selected → `sendLifecycle` moves the
 * SAME row to `sent`; no longer selected → `expired`, with the predicate's own reason. New
 * eligibles follow, under the same budget.
 */
export async function runStep(
  step: LifecycleStep, evaluation: StepEvaluation, now = new Date(),
): Promise<StepTotals> {
  const t: StepTotals = { wouldSend: 0, sent: 0, suppressed: 0, capped: 0, skipped: 0, expired: 0 };
  const state = await getStepState(step);
  const live = isStepLive(resolveMode(), state);
  // In shadow every candidate is rendered and ledgered. Live, the first tick is rate-limited to
  // the canary batch; `Infinity` afterwards is deliberate — the cap is a one-time gate on the
  // step's debut, not a permanent throttle.
  let budget = !live ? Number.POSITIVE_INFINITY
    : state.canary_batch_done ? Number.POSITIVE_INFINITY : CANARY_BATCH_SIZE;

  const tally = (status: string): void => {
    switch (status) {
      case 'would_send': t.wouldSend += 1; break;
      case 'sent': t.sent += 1; budget -= 1; break;
      case 'suppressed': t.suppressed += 1; break;
      case 'capped': t.capped += 1; break;
      default: t.skipped += 1; break;
    }
  };

  const key = (recipientId: string, periodKey: string) => `${recipientId}\u0000${periodKey}`;
  const pending = new Map(evaluation.candidates.map((c) => [key(c.recipient.recipientId, c.ctx.periodKey), c]));

  if (live) {
    for (const claim of await listShadowClaims(step)) {
      const k = key(claim.recipient_id, claim.period_key);
      const c = pending.get(k);
      if (!c) {
        await closeClaim(claim.id, 'expired', evaluation.explain(claim.recipient_id, claim.period_key));
        t.expired += 1;
        continue;
      }
      pending.delete(k);
      tally((await sendLifecycle(step, c.recipient, c.ctx, { now, liveBudget: budget })).status);
    }
  }

  for (const c of pending.values()) {
    tally((await sendLifecycle(step, c.recipient, c.ctx, { now, liveBudget: budget })).status);
  }

  if (live && !state.canary_batch_done && t.sent > 0) await markCanaryBatchDone(step);
  return t;
}

/**
 * Resend rows a live send could not deliver. The send path's ONE predicate gates every row: a
 * `failed` row whose step is not live — rolled back, or held by the master — is left alone.
 * Before this wave the drain checked the master only, so it would have resent a rolled-back
 * step's failures on the next tick.
 */
async function drainRetries(mode: LifecycleMode): Promise<{ retried: number; recovered: number }> {
  if (mode !== 'live-permitted') return { retried: 0, recovered: 0 };
  const states = new Map((await listStepStates()).map((st) => [st.step, st]));
  const rows = await listRetryable(MAX_ATTEMPTS, RETRY_BATCH);
  let retried = 0;
  let recovered = 0;
  for (const r of rows) {
    const st = states.get(r.step);
    if (!st || !isStepLive(mode, st)) continue;
    retried += 1;
    if (!r.recipient_email || !r.rendered_subject || !r.rendered_html || !r.rendered_text) {
      // Nothing to resend from — a row with no rendered body is a shadow-era artifact, not a
      // retryable failure. Retire it rather than looping on it forever.
      await markFailed(r.id, 'unretryable: no rendered body on the ledger row');
      continue;
    }
    try {
      const id = await sendLifecycleMessage({
        to: r.recipient_email,
        subject: r.rendered_subject,
        html: r.rendered_html,
        text: r.rendered_text,
        unsubscribeUrl: unsubscribeUrl(r.recipient_id, API_BASE),
        step: r.step,
        idempotencyKey: `${r.recipient_id}|${r.step}|${r.period_key}`,
      });
      await recordSent(r.id, r.step, id, new Date().toISOString());
      recovered += 1;
    } catch (err) {
      await markFailed(r.id, err instanceof Error ? err.message : String(err));
    }
  }
  return { retried, recovered };
}

export interface TickDeps {
  /** Candidate sources, keyed by step. Defaults to the four registered usage predicates. */
  sources?: Partial<Record<LifecycleStep, StepCandidateSource>>;
  /** Seeds the monthly meter. Injectable so a test tick never reads a real quota table. */
  prime?: () => Promise<void>;
}

export interface TickResult { verdict: 'PASS' | 'FAIL' | 'INDETERMINATE'; note: string; eligible: number }

/**
 * ONE dispatcher tick, minus the heartbeat stamp and the exit — which is everything a tick DOES.
 * Exported so the tick's whole-run properties (the canary batch across every send path in the
 * tick, not just the step loop) are testable; `main` below only emits what this returns.
 */
export async function runTick(now = new Date(), deps: TickDeps = {}): Promise<TickResult> {
  const sources = deps.sources ?? STEP_CANDIDATES;
  let mode: LifecycleMode;
  try {
    ensureLifecycleSchema();
    mode = resolveMode();
  } catch (err) {
    return { verdict: 'INDETERMINATE', note: `schema/mode unavailable: ${err instanceof Error ? err.message : err}`, eligible: 0 };
  }

  if (mode! === 'off') return { verdict: 'PASS', note: 'mode=off registered_steps=0 nothing_evaluated=1', eligible: 0 };

  let states;
  try {
    states = await listStepStates();
  } catch (err) {
    return { verdict: 'INDETERMINATE', note: `step-state read failed: ${err instanceof Error ? err.message : err}`, eligible: 0 };
  }

  // Iterated in STEP_PRIORITY order, not registration order. When the <=1/day cap forces a
  // choice between two eligible steps, whichever runs FIRST wins the slot — so the order is the
  // policy, and leaving it to object-key order would rent a user-visible decision from the
  // iteration behaviour of a language construct. quota_wall outranks everything; the digest yields.
  // SEED THE METER BEFORE ANY PREDICATE RUNS. This is a fresh process, so `callTrackers` is
  // empty until `initQuotaDb` loads `quota_usage` — and an unseeded read reports every bucket at
  // zero usage, which means `quota_80` finds nobody and `reset_return` finds everybody. An
  // unprimed tick would be silently, confidently wrong in BOTH directions.
  try {
    await (deps.prime ?? primeMeter)();
  } catch (err) {
    return { verdict: 'INDETERMINATE', note: `meter prime failed: ${err instanceof Error ? err.message : err}`, eligible: 0 };
  }

  const registered = STEP_PRIORITY.filter((s) => sources[s]);
  const totals = { wouldSend: 0, sent: 0, suppressed: 0, capped: 0, skipped: 0, expired: 0 };
  for (const step of registered) {
    try {
      const evaluation = await sources[step]!(now);
      const r = await runStep(step, evaluation, now);
      totals.wouldSend += r.wouldSend; totals.sent += r.sent;
      totals.suppressed += r.suppressed; totals.capped += r.capped; totals.skipped += r.skipped;
      totals.expired += r.expired;
    } catch (err) {
      return { verdict: 'FAIL', note: `step '${step}' candidate source threw: ${err instanceof Error ? err.message : err}`, eligible: 0 };
    }
  }

  let retry = { retried: 0, recovered: 0 };
  try {
    retry = await drainRetries(mode!);
  } catch (err) {
    return { verdict: 'INDETERMINATE', note: `retry drain failed: ${err instanceof Error ? err.message : err}`, eligible: 0 };
  }

  // POSITIVE PER-CHECK OUTPUT. "Installed is not working" — a tick that printed only a verdict
  // would be indistinguishable from a dark one, so every quantity this run observed is on the
  // line, including the zeros.
  // Liveness from the ONE predicate: a step stamped live but held by the master is reported as
  // held, never as live — the heartbeat said `live_steps=1` for 12 days while nothing could send.
  const liveSteps = states!.filter((st) => isStepLive(mode, st)).map((st) => st.step);
  const heldSteps = states!.filter((st) => stepLiveState(mode, st) === 'blocked-master').map((st) => st.step);
  const prev = await readHeartbeat('lifecycle-dispatch').catch(() => null);
  const prevMs = prev ? parseDbTimestamp(prev.last_run_at) : NaN;
  const sinceLast = Number.isFinite(prevMs) ? Math.round((Date.now() - prevMs) / 60000) : -1;
  return {
    verdict: 'PASS',
    note: `mode=${mode!} registered_steps=${registered.length} live_steps=${liveSteps.length}` +
      `${liveSteps.length ? `(${liveSteps.join(',')})` : ''} master_held=${heldSteps.length}` +
      `${heldSteps.length ? `(${heldSteps.join(',')})` : ''} canary_batch=${CANARY_BATCH_SIZE} ` +
      `would_send=${totals.wouldSend} sent=${totals.sent} expired=${totals.expired} suppressed=${totals.suppressed} ` +
      `capped=${totals.capped} skipped=${totals.skipped} retried=${retry.retried} recovered=${retry.recovered} ` +
      `min_since_last_tick=${sinceLast}`,
    eligible: totals.wouldSend + totals.sent + totals.suppressed + totals.capped,
  };
}

async function main(): Promise<number> {
  const r = await runTick(new Date());
  return await emit(r.verdict, r.note, r.eligible);
}

// ENTRYPOINT GUARD — required, and here it is load-bearing rather than hygiene. This module
// exports `runStep`, which CH2's tests and any future canary will import; without the guard, that
// import would RUN a dispatcher tick, and in `live` mode a tick SENDS EMAIL TO REAL PEOPLE.
// Live cron invokes `node dist/scripts/lifecycle-dispatch.js`, so the guard is TRUE there.
if (require.main === module) {
  // `runScript` owns the exit: it awaits `main`, uses its returned number as the exit code,
  // drains the DB pool, and forces exit if a handle outlives the work.
  void runScript('lifecycle-dispatch', async () => {
    try {
      return await main();
    } catch (err) {
      return await emit('INDETERMINATE', `unhandled: ${err instanceof Error ? err.message : err}`);
    }
  });
}
