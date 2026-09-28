/**
 * IDENTITY-LIFECYCLE-W3 CH2 — the readout, in TWO modes over ONE derivation.
 *
 *   --report   read-only. Prints the per-step table and a tri-state verdict. Mutates nothing.
 *   --decide   the same table, then APPLIES the per-step go-live / rollback decisions.
 *
 * The modes share `assess()` so the numbers a human reads are the numbers the flip acts on. Two
 * implementations would drift, and the one that drifted would be whichever nobody was watching —
 * which here means a step lighting itself on figures no operator ever saw.
 *
 * NO HUMAN FLIPS THE FLAG. `--decide` is invoked only by `ops/cron/lifecycle-readout.sh`, and its
 * decision is a pure function of the ledger. That is the wave's central safety property: shipped
 * dark, then measured, then lit — by evidence, on a clock, per step.
 *
 * LIFECYCLE-GOLIVE-SEMANTICS-W1 — what this readout SAYS now matches what the send path DOES.
 * MEASURED 2026-09-28: this cron stamped `activation_nudge` live on 2026-09-16, printed
 * `LIFECYCLE_GOLIVE_VERDICT=LIVE lit=1`, and nothing could send, because the global master was
 * unset and only the send path read it. Per step it now reports ONE verdict projected from the
 * engine's single predicates — `stepLiveState` for "is it live", `stepGoLiveLegs` for "may it go
 * live", `rollbackWindow` for "is the launch guard armed":
 *
 *   LIVE            the send path mails this step
 *   BLOCKED_MASTER  every evidence leg passed; the global master holds it (the 12-day state)
 *   BLOCKED_GATE    an evidence leg failed that is a DEFECT (duplicates, health, unsub, clock)
 *   NOT_DUE         no audience yet, or the 7-day shadow clock is still running
 *   ROLLED_BACK     a breach returned it to shadow; a human clears it
 *   DECIDE_PENDING  --report only: a leg only the deciding cron measures (health, unsub), or a
 *                   step whose legs all pass and which the next --decide run will light
 */
import { runScript } from '../lib/script-lifecycle.js';
import { dbQuery, awaitDbWrites } from '../lib/performance-db.js';
import { ensureLifecycleSchema } from '../lib/lifecycle/schema.js';
import {
  listStepStates, setStepLive, rollbackStep, parseDbTimestamp, type StepState,
} from '../lib/lifecycle/ledger.js';
import {
  stepGoLiveLegs, resolveMode, stepLiveState, rollbackWindow, SHADOW_CLOCK_MS, ROLLBACK_WINDOW_H,
  MASTER_BLOCKER,
  type LifecycleMode, type StepLiveState, type RollbackWindow, type GoLiveLegs,
} from '../lib/lifecycle/engine.js';
import { LIFECYCLE_STEPS, type LifecycleStep } from '../lib/lifecycle-copy.js';

const TAG = '[lifecycle-readout]';

/** Rollback thresholds for the first 72 h after a step's FIRST REAL SEND (R1). */
export { ROLLBACK_WINDOW_H };
export const ROLLBACK_BOUNCE_PCT = 5;
export const ROLLBACK_BOUNCE_MIN_N = 10;
export const ROLLBACK_UNSUB_PCT = 20;

export type StepGoLiveVerdict =
  | 'LIVE' | 'BLOCKED_MASTER' | 'BLOCKED_GATE' | 'NOT_DUE' | 'ROLLED_BACK' | 'DECIDE_PENDING' | 'NOT_MANAGED';

export interface StepRow {
  step: LifecycleStep;
  wouldSend: number;
  sent: number;
  failed: number;
  suppressed: number;
  capped: number;
  expired: number;
  recipients: number;
  duplicates: number;
  firstAt: string | null;
  lastAt: string | null;
  state: StepState;
  liveState: StepLiveState;
  window: RollbackWindow;
  bounces: number;
  unsubs: number;
  /** null for `product_updates`, which this cron never lights. */
  legs: GoLiveLegs | null;
  verdict: StepGoLiveVerdict;
  /** The first refusing leg in DECISION order (master first), or null. */
  blocker: string | null;
}

export interface AssessOptions {
  /** Measured by the deciding cron immediately before deciding; `null` = not measured (report). */
  facts?: { healthPass: boolean | null; unsubSelfTestPass: boolean | null };
  env?: NodeJS.ProcessEnv;
}

/** Evidence legs that mean "not yet", never "broken". */
const NOT_DUE_LEGS = new Set(['no_would_send', 'clock_not_started', 'shadow_clock_not_elapsed']);
/** Evidence legs only the deciding cron measures. */
const UNMEASURED_LEGS = new Set(['health_unmeasured', 'unsub_unmeasured']);

/**
 * Duplicates must be structurally 0 — `UNIQUE(recipient_id, step, period_key)` makes a second row
 * impossible. Counting them anyway is the point: if this ever returns non-zero, the constraint is
 * gone, and a gate that only checks things that CAN break is blind to the ones that shouldn't.
 */
async function duplicatesFor(step: LifecycleStep): Promise<number> {
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM (
       SELECT recipient_id, period_key FROM lifecycle_sends
        WHERE step = ? GROUP BY recipient_id, period_key HAVING COUNT(*) > 1
     ) d`, [step],
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Does this step carry a go-live stamp? Projected from the ONE liveness predicate — "stamped" is
 * `live` or `blocked-master` — never re-read from `live_since`, which is how six copies drifted.
 */
export function isStamped(r: Pick<StepRow, 'liveState'>): boolean {
  return r.liveState === 'live' || r.liveState === 'blocked-master';
}

/** ONE projection from the engine's predicates to the per-step verdict. Pure. */
export function stepGoLiveVerdict(liveState: StepLiveState, legs: GoLiveLegs | null): StepGoLiveVerdict {
  if (liveState === 'rolled-back') return 'ROLLED_BACK';
  if (liveState === 'live') return 'LIVE';
  if (!legs) return 'NOT_MANAGED';
  if (legs.evidence === null) return legs.master ? 'DECIDE_PENDING' : 'BLOCKED_MASTER';
  if (NOT_DUE_LEGS.has(legs.evidence)) return 'NOT_DUE';
  if (UNMEASURED_LEGS.has(legs.evidence)) return 'DECIDE_PENDING';
  return 'BLOCKED_GATE';
}

/** Worst-wins over the steps the cron manages; `NOT_MANAGED` never votes. */
const VERDICT_RANK: Record<StepGoLiveVerdict, number> = {
  NOT_MANAGED: 0, NOT_DUE: 1, LIVE: 2, DECIDE_PENDING: 3, BLOCKED_MASTER: 4, BLOCKED_GATE: 5, ROLLED_BACK: 6,
};
export function aggregateVerdict(verdicts: StepGoLiveVerdict[]): StepGoLiveVerdict {
  let worst: StepGoLiveVerdict = 'NOT_DUE';
  for (const v of verdicts) if (VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  return worst;
}

export async function assess(now = new Date(), opts: AssessOptions = {}): Promise<StepRow[]> {
  ensureLifecycleSchema();
  const env = opts.env ?? process.env;
  const mode = resolveMode(env);
  const facts = opts.facts ?? { healthPass: null, unsubSelfTestPass: null };
  const states = await listStepStates();
  const byStep = new Map(states.map((s) => [s.step, s]));
  const out: StepRow[] = [];

  for (const step of LIFECYCLE_STEPS) {
    const agg = await dbQuery<Record<string, unknown>>(
      `SELECT
         SUM(CASE WHEN status='would_send' THEN 1 ELSE 0 END) AS would_send,
         SUM(CASE WHEN status='sent'       THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status='failed'     THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END) AS suppressed,
         SUM(CASE WHEN status='capped'     THEN 1 ELSE 0 END) AS capped,
         SUM(CASE WHEN status='expired'    THEN 1 ELSE 0 END) AS expired,
         COUNT(DISTINCT recipient_id) AS recipients,
         MIN(created_at) AS first_at,
         MAX(created_at) AS last_at
       FROM lifecycle_sends WHERE step = ?`, [step],
    );
    const a = agg[0] ?? {};
    const state = byStep.get(step)!;
    const liveState = stepLiveState(mode, state);
    const window = rollbackWindow(state, now);

    // Bounces/complaints attributable to THIS step's launch window: suppression rows written
    // since its FIRST REAL SEND. Deliberately NOT since `live_since` — a bounce cannot precede a
    // send, and a window opened at the stamp would count a period in which nothing was mailed.
    const since = window.status === 'not_opened' ? null : window.opensAt;
    const supp = since
      ? await dbQuery<{ reason: string; c: number | string }>(
          `SELECT reason, COUNT(*) AS c FROM lifecycle_suppressions
            WHERE created_at >= ? GROUP BY reason`, [since])
      : [];
    const bounces = supp.filter((r) => r.reason === 'bounce' || r.reason === 'complaint')
      .reduce((n, r) => n + Number(r.c), 0);
    const unsubs = supp.filter((r) => r.reason === 'unsubscribe')
      .reduce((n, r) => n + Number(r.c), 0);

    const wouldSend = Number(a.would_send ?? 0);
    const duplicates = await duplicatesFor(step);
    // `product_updates` is CH4's and is never lit by this cron, so it has no go-live legs here.
    const legs = step === 'product_updates' ? null : await stepGoLiveLegs(step, {
      duplicates, wouldSendCount: wouldSend, healthPass: facts.healthPass, unsubSelfTestPass: facts.unsubSelfTestPass,
    }, now, env);

    out.push({
      step,
      wouldSend,
      sent: Number(a.sent ?? 0),
      failed: Number(a.failed ?? 0),
      suppressed: Number(a.suppressed ?? 0),
      capped: Number(a.capped ?? 0),
      expired: Number(a.expired ?? 0),
      recipients: Number(a.recipients ?? 0),
      duplicates,
      firstAt: a.first_at ? new Date(parseDbTimestamp(a.first_at as string)).toISOString() : null,
      lastAt: a.last_at ? new Date(parseDbTimestamp(a.last_at as string)).toISOString() : null,
      state,
      liveState,
      window,
      bounces,
      unsubs,
      legs,
      verdict: stepGoLiveVerdict(liveState, legs),
      blocker: legs ? (legs.master ? legs.evidence : MASTER_BLOCKER) : null,
    });
  }
  return out;
}

/**
 * Why this step must roll back, or null. Pure.
 *
 * The legs apply ONLY while the launch window is ARMED — the 72 h after the step's first real send.
 * Before that send the window is `not_opened` (nothing was mailed, nothing can have bounced); after
 * it closes, steady-state deliverability is the health canary's job.
 */
export function rollbackReason(r: StepRow): string | null {
  if (!isStamped(r)) return null;
  if (r.window.status !== 'armed') return null;
  if (r.sent >= ROLLBACK_BOUNCE_MIN_N && r.bounces * 100 >= r.sent * ROLLBACK_BOUNCE_PCT) {
    return `bounce+complaint ${r.bounces}/${r.sent} >= ${ROLLBACK_BOUNCE_PCT}% in the first ${ROLLBACK_WINDOW_H}h after the first send`;
  }
  if (r.sent > 0 && r.unsubs * 100 >= r.sent * ROLLBACK_UNSUB_PCT) {
    return `unsubscribe ${r.unsubs}/${r.sent} >= ${ROLLBACK_UNSUB_PCT}% of sends`;
  }
  return null;
}

/** `not_opened` · `armed(opens_at=…,closes_at=…)` · `closed(closes_at=…)`. */
export function windowLabel(w: RollbackWindow): string {
  if (w.status === 'not_opened') return 'not_opened';
  if (w.status === 'armed') return `armed(opens_at=${w.opensAt},closes_at=${w.closesAt})`;
  return `closed(closes_at=${w.closesAt})`;
}

function table(rows: StepRow[]): string {
  const h = ['step', 'would', 'sent', 'fail', 'supp', 'capd', 'exp', 'rcpt', 'dup', 'state', 'window', 'bnc', 'uns'];
  const body = rows.map((r) => [
    r.step, r.wouldSend, r.sent, r.failed, r.suppressed, r.capped, r.expired, r.recipients, r.duplicates,
    r.liveState, isStamped(r) ? r.window.status : '-', r.bounces, r.unsubs,
  ].map(String));
  const w = h.map((_, i) => Math.max(h[i].length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(w[i])).join('  ');
  return [line(h), ...body.map(line)].join('\n');
}

/**
 * The human- and gate-readable report. `master=` is printed FIRST, and `rollback_window=` only on
 * steps carrying a go-live stamp, so the first occurrence of each token is the one that matters
 * (the AC5 gate reads first occurrences). One step per line — a step's verdict never shares a
 * line with another step's.
 */
export function reportLines(rows: StepRow[], mode: LifecycleMode): string[] {
  const out = [`${TAG} master=${mode}`, ...table(rows).split('\n')];
  for (const r of rows) {
    const parts = [`${TAG} step=${r.step}`, `verdict=${r.verdict}`, `state=${r.liveState}`];
    if (r.blocker && r.verdict !== 'LIVE') parts.push(`leg=${r.blocker}`);
    if (isStamped(r)) parts.push(`rollback_window=${windowLabel(r.window)}`);
    parts.push(`would_send=${r.wouldSend}`, `sent=${r.sent}`, `expired=${r.expired}`);
    out.push(parts.join(' '));
  }
  return out;
}

/**
 * The published record's `metrics` (canary `lifecycle-readout`). COUNTS AND VERDICTS ONLY — the
 * ledger stays on the host (architect ruling Q7); no address, body or recipient id leaves.
 */
export function resultMetrics(rows: StepRow[], mode: LifecycleMode): {
  master: LifecycleMode;
  verdict: StepGoLiveVerdict;
  steps: Record<string, { verdict: StepGoLiveVerdict; would_send: number; sent: number; expired: number; live: boolean; rollback_window: string }>;
} {
  const steps: Record<string, { verdict: StepGoLiveVerdict; would_send: number; sent: number; expired: number; live: boolean; rollback_window: string }> = {};
  for (const r of rows) {
    steps[r.step] = {
      verdict: r.verdict, would_send: r.wouldSend, sent: r.sent, expired: r.expired,
      live: r.liveState === 'live', rollback_window: r.window.status,
    };
  }
  return { master: mode, verdict: aggregateVerdict(rows.map((r) => r.verdict)), steps };
}

async function main(): Promise<number> {
  const decide = process.argv.includes('--decide');
  const now = new Date();
  const env = process.env;
  const mode = resolveMode(env);
  // The deciding cron measures health and the unsubscribe self-test immediately before deciding
  // and passes both in; the read-only twin measures neither, and says so (`null`), rather than
  // reporting an unmeasured leg as failed or passed.
  const facts = decide
    ? { healthPass: env.LIFECYCLE_HEALTH_OK === '1', unsubSelfTestPass: env.LIFECYCLE_UNSUB_OK === '1' }
    : { healthPass: null, unsubSelfTestPass: null };

  let rows: StepRow[];
  try {
    rows = await assess(now, { facts, env });
  } catch (err) {
    console.log(`${TAG} LIFECYCLE_READOUT_VERDICT=INDETERMINATE ledger unreadable: ${err instanceof Error ? err.message : err}`);
    return 3;
  }

  const actions: string[] = [];
  let litNow = 0;
  let rolledBackNow = 0;
  if (decide) {
    for (const r of rows) {
      const back = rollbackReason(r);
      if (back) {
        await rollbackStep(r.step, now.toISOString(), back);
        actions.push(`ROLLED_BACK ${r.step}: ${back}`);
        rolledBackNow += 1;
        continue;
      }
      // `product_updates` is CH4's and is never flipped by this cron.
      if (!r.legs) continue;
      // Stamp live only when the MASTER permits and every evidence leg passes — the decision
      // order `stepGoLiveBlocker` encodes. While the master blocks, a step whose evidence passed
      // reports BLOCKED_MASTER and is NOT stamped; it lights on the first run after the flip.
      if (r.legs.master && r.legs.evidence === null && r.liveState === 'shadow') {
        await setStepLive(r.step, now.toISOString());
        actions.push(`LIVE ${r.step}`);
        litNow += 1;
      } else if (r.blocker) {
        actions.push(`hold ${r.step}: ${r.blocker}`);
      }
    }
    await awaitDbWrites();
    // Report the state the actions produced, not the state before them.
    if (litNow + rolledBackNow > 0) rows = await assess(now, { facts, env });
  }

  for (const line of reportLines(rows, mode)) console.log(line);
  for (const a of actions) console.log(`${TAG} ${a}`);

  if (decide) {
    console.log(`${TAG} LIFECYCLE_GOLIVE_VERDICT=${aggregateVerdict(rows.map((r) => r.verdict))} lit_now=${litNow} rolled_back_now=${rolledBackNow}`);
    // The wrapper publishes this line to canary_result_log so the vault can read the go-live
    // state (the 12-day blind spot this wave closes). Counts and verdicts only.
    console.log(`${TAG} RESULT_JSON=${JSON.stringify(resultMetrics(rows, mode))}`);
  }

  const totalDup = rows.reduce((n, r) => n + r.duplicates, 0);
  // POSITIVE per-check output: the shadow-clock horizon is printed even when nothing moved, so a
  // reader can see WHEN a step becomes eligible rather than inferring it from silence.
  console.log(`${TAG} mode=${mode} duplicates=${totalDup} shadow_clock_h=${Math.round(SHADOW_CLOCK_MS / 3600_000)} ` +
    rows.map((r) => `${r.step}=${r.liveState}`).join(' '));
  console.log(`${TAG} LIFECYCLE_READOUT_VERDICT=${totalDup === 0 ? 'PASS' : 'FAIL'}`);
  return totalDup === 0 ? 0 : 1;
}

if (require.main === module) {
  void runScript('lifecycle-readout', main);
}
