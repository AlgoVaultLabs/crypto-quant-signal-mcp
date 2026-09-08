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
 */
import { runScript } from '../lib/script-lifecycle.js';
import { dbQuery, awaitDbWrites } from '../lib/performance-db.js';
import { ensureLifecycleSchema } from '../lib/lifecycle/schema.js';
import {
  listStepStates, setStepLive, rollbackStep, parseDbTimestamp, type StepState,
} from '../lib/lifecycle/ledger.js';
import { stepGoLiveBlocker, resolveMode, SHADOW_CLOCK_MS } from '../lib/lifecycle/engine.js';
import { LIFECYCLE_STEPS, type LifecycleStep } from '../lib/lifecycle-copy.js';

const TAG = '[lifecycle-readout]';

/** Rollback thresholds for the first 72 h of a step's live life. */
export const ROLLBACK_WINDOW_H = 72;
export const ROLLBACK_BOUNCE_PCT = 5;
export const ROLLBACK_BOUNCE_MIN_N = 10;
export const ROLLBACK_UNSUB_PCT = 20;

export interface StepRow {
  step: LifecycleStep;
  wouldSend: number;
  sent: number;
  failed: number;
  suppressed: number;
  capped: number;
  recipients: number;
  duplicates: number;
  firstAt: string | null;
  lastAt: string | null;
  state: StepState;
  liveHours: number | null;
  bounces: number;
  unsubs: number;
}

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

export async function assess(now = new Date()): Promise<StepRow[]> {
  ensureLifecycleSchema();
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
         COUNT(DISTINCT recipient_id) AS recipients,
         MIN(created_at) AS first_at,
         MAX(created_at) AS last_at
       FROM lifecycle_sends WHERE step = ?`, [step],
    );
    const a = agg[0] ?? {};
    const state = byStep.get(step)!;
    const liveMs = state.live_since ? now.getTime() - parseDbTimestamp(state.live_since) : null;

    // Bounces/complaints attributable to THIS step's live window: suppression rows written since
    // it went live. Deliberately NOT "all suppressions ever" — a bounce from before a step was
    // lit says nothing about that step, and charging it would roll back a healthy one.
    const since = state.live_since ? new Date(parseDbTimestamp(state.live_since)).toISOString() : null;
    const supp = since
      ? await dbQuery<{ reason: string; c: number | string }>(
          `SELECT reason, COUNT(*) AS c FROM lifecycle_suppressions
            WHERE created_at >= ? GROUP BY reason`, [since])
      : [];
    const bounces = supp.filter((r) => r.reason === 'bounce' || r.reason === 'complaint')
      .reduce((n, r) => n + Number(r.c), 0);
    const unsubs = supp.filter((r) => r.reason === 'unsubscribe')
      .reduce((n, r) => n + Number(r.c), 0);

    out.push({
      step,
      wouldSend: Number(a.would_send ?? 0),
      sent: Number(a.sent ?? 0),
      failed: Number(a.failed ?? 0),
      suppressed: Number(a.suppressed ?? 0),
      capped: Number(a.capped ?? 0),
      recipients: Number(a.recipients ?? 0),
      duplicates: await duplicatesFor(step),
      firstAt: a.first_at ? new Date(parseDbTimestamp(a.first_at as string)).toISOString() : null,
      lastAt: a.last_at ? new Date(parseDbTimestamp(a.last_at as string)).toISOString() : null,
      state,
      liveHours: liveMs === null || !Number.isFinite(liveMs) ? null : Math.floor(liveMs / 3600_000),
      bounces,
      unsubs,
    });
  }
  return out;
}

/** Why this LIVE step must roll back, or null. Pure. */
export function rollbackReason(r: StepRow): string | null {
  if (!r.state.live_since) return null;
  if (r.liveHours === null || r.liveHours > ROLLBACK_WINDOW_H) return null;
  if (r.sent >= ROLLBACK_BOUNCE_MIN_N && r.bounces * 100 >= r.sent * ROLLBACK_BOUNCE_PCT) {
    return `bounce+complaint ${r.bounces}/${r.sent} >= ${ROLLBACK_BOUNCE_PCT}% in the first ${ROLLBACK_WINDOW_H}h`;
  }
  if (r.sent > 0 && r.unsubs * 100 >= r.sent * ROLLBACK_UNSUB_PCT) {
    return `unsubscribe ${r.unsubs}/${r.sent} >= ${ROLLBACK_UNSUB_PCT}% of sends`;
  }
  return null;
}

function table(rows: StepRow[]): string {
  const h = ['step', 'would', 'sent', 'fail', 'supp', 'capd', 'rcpt', 'dup', 'state', 'liveh', 'bnc', 'uns'];
  const body = rows.map((r) => [
    r.step, r.wouldSend, r.sent, r.failed, r.suppressed, r.capped, r.recipients, r.duplicates,
    r.state.rolled_back_at ? 'rolled-back' : r.state.live_since ? 'live' : 'shadow',
    r.liveHours ?? '-', r.bounces, r.unsubs,
  ].map(String));
  const w = h.map((_, i) => Math.max(h[i].length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(w[i])).join('  ');
  return [line(h), ...body.map(line)].join('\n');
}

async function main(): Promise<number> {
  const decide = process.argv.includes('--decide');
  const now = new Date();
  let rows: StepRow[];
  try {
    rows = await assess(now);
  } catch (err) {
    console.log(`${TAG} LIFECYCLE_READOUT_VERDICT=INDETERMINATE ledger unreadable: ${err instanceof Error ? err.message : err}`);
    return 3;
  }

  console.log(table(rows));
  const mode = resolveMode();
  const totalDup = rows.reduce((n, r) => n + r.duplicates, 0);

  const actions: string[] = [];
  if (decide) {
    for (const r of rows) {
      const back = rollbackReason(r);
      if (back) {
        await rollbackStep(r.step, now.toISOString(), back);
        actions.push(`ROLLED_BACK ${r.step}: ${back}`);
        continue;
      }
      // `product_updates` is CH4's and is never flipped by this cron.
      if (r.step === 'product_updates') continue;
      const blocker = await stepGoLiveBlocker(r.step, {
        duplicates: r.duplicates,
        wouldSendCount: r.wouldSend,
        healthPass: process.env.LIFECYCLE_HEALTH_OK === '1',
        unsubSelfTestPass: process.env.LIFECYCLE_UNSUB_OK === '1',
      }, now);
      if (blocker === null && !r.state.live_since) {
        await setStepLive(r.step, now.toISOString());
        actions.push(`LIVE ${r.step}`);
      } else if (blocker) {
        actions.push(`hold ${r.step}: ${blocker}`);
      }
    }
    await awaitDbWrites();
  }

  for (const a of actions) console.log(`${TAG} ${a}`);

  const lit = actions.filter((a) => a.startsWith('LIVE ')).length;
  const back = actions.filter((a) => a.startsWith('ROLLED_BACK ')).length;
  if (decide) {
    console.log(`${TAG} LIFECYCLE_GOLIVE_VERDICT=${back > 0 ? 'ROLLED_BACK' : lit > 0 ? 'LIVE' : 'HOLD'} lit=${lit} rolled_back=${back}`);
  }

  // POSITIVE per-check output: the shadow-clock horizon is printed even when nothing moved, so a
  // reader can see WHEN a step becomes eligible rather than inferring it from silence.
  console.log(`${TAG} mode=${mode} duplicates=${totalDup} shadow_clock_h=${Math.round(SHADOW_CLOCK_MS / 3600_000)} ` +
    rows.map((r) => `${r.step}=${r.state.rolled_back_at ? 'rolled-back' : r.state.live_since ? 'live' : 'shadow'}`).join(' '));
  console.log(`${TAG} LIFECYCLE_READOUT_VERDICT=${totalDup === 0 ? 'PASS' : 'FAIL'}`);
  return totalDup === 0 ? 0 : 1;
}

if (require.main === module) {
  void runScript('lifecycle-readout', main);
}
