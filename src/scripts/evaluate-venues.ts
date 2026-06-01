/**
 * evaluate-venues.ts — daily promotion-decision cron.
 *
 * EXCHANGE-SHADOW-PROMOTE-W1 / C3. Runs daily at 06:00 UTC (systemd timer
 * `evaluate-venues.timer` at /etc/systemd/system/). For each `status='shadow'`
 * venue:
 *
 *   1. Compute days_since = (now − integrated_at) / 86400.
 *   2. Compute buy_sell_count = COUNT(*) FROM signals
 *        WHERE exchange = $1 AND signal IN ('BUY','SELL')
 *          AND created_at > EXTRACT(EPOCH FROM integrated_at)::INTEGER
 *   3. Compute pfe_wr = AVG(CASE WHEN (signal='BUY' AND pfe_return_pct>0)
 *                                  OR (signal='SELL' AND pfe_return_pct<0)
 *                              THEN 1.0 ELSE 0.0 END)
 *        FROM signals
 *        WHERE exchange = $1 AND signal IN ('BUY','SELL')
 *          AND pfe_return_pct IS NOT NULL
 *          AND created_at > EXTRACT(EPOCH FROM integrated_at)::INTEGER
 *      (HOLDs EXCLUDED + only Phase-E-backfilled signals count toward WR.)
 *   4. recordEval(venue, pfe_wr, buy_sell_count)
 *   5. Decision tree:
 *        - days_since ≥ 15 AND buy_sell_count ≥ min_buy_sell_sample
 *          AND pfe_wr ≥ 0.80 → setStatus(venue, 'promoted') +
 *          Telegram alert (action='promoted')
 *        - days_since ≥ 15 AND extension_count == 0 →
 *          incrementExtension(venue) + Telegram alert (action='extended')
 *        - days_since ≥ 30 AND extension_count == 1 →
 *          Telegram alert (action='manual_required') — NO automatic state
 *          change; Mr.1 manually triggers PROMOTE / RETIRE / EXTEND_AGAIN.
 *        - else → no action (still inside window OR sample/WR criteria not
 *          yet met but pre-deadline).
 *
 * Idempotent: re-running on the same day is safe — recordEval overwrites
 * `last_eval_*` columns; setStatus only fires when criteria genuinely met;
 * incrementExtension fires once per pass (so day-15 + day-16 reruns would
 * both increment — but the day-16 decision tree branch is `extension_count
 * == 0` which is FALSE after day-15's increment, so day-16 hits no-op).
 *
 * Logs structured one-line summary to stdout (captured to
 * /var/log/algovault-evaluate-venues.log by the systemd service).
 */

import { dbQuery } from '../lib/performance-db.js';
import {
  listVenues,
  recordEval,
  setStatus,
  incrementExtension,
} from '../lib/venue-store.js';
import { sendVenueStatusChange } from '../lib/telegram.js';
import type { VenueRecord } from '../types.js';

const PFE_WR_THRESHOLD = 0.80;
const DAY_15_FLOOR = 15;
const DAY_30_FLOOR = 30;
const SECONDS_PER_DAY = 86400;

export type EvalDecision =
  | { action: 'promoted'; pfe_wr: number; buy_sell_count: number }
  | { action: 'extended'; pfe_wr: number | null; buy_sell_count: number }
  | { action: 'manual_required'; pfe_wr: number | null; buy_sell_count: number }
  | { action: 'no_op'; reason: string; pfe_wr: number | null; buy_sell_count: number; days_since: number };

interface EvalStats {
  pfe_wr: number | null;
  buy_sell_count: number;
  days_since: number;
}

/**
 * Compute current eval stats for a single shadow venue. Pure read — no
 * state mutation. Exported for test seam.
 */
export async function computeVenueStats(
  venue: VenueRecord,
  now: Date = new Date(),
): Promise<EvalStats> {
  // OPS-SHADOW-ALERT-HYGIENE-W1 (2026-06-01): the promotion clock AND the
  // sample/WR window both derive from COALESCE(seeding_started_at,
  // integrated_at). `seeding_started_at` is stamped by OPS-SHADOW-PIPELINE-W1
  // (C3) when a venue's seed pipeline actually begins producing signals; until
  // then it is NULL and the clock falls back to `integrated_at` (byte-identical
  // to prior behaviour). This stops a venue's day-15/30 deadline from elapsing
  // before its data pipeline ever started. `integratedUnix` below now holds the
  // *effective clock-start* epoch (kept as the binding name so the two queries
  // are unchanged).
  const effectiveStart = venue.seeding_started_at ?? venue.integrated_at;
  const integratedAt = new Date(effectiveStart);
  const integratedUnix = Math.floor(integratedAt.getTime() / 1000);
  const daysSince = Math.floor((now.getTime() / 1000 - integratedUnix) / SECONDS_PER_DAY);

  // BUY+SELL count since integration (HOLDs excluded per Wave Objective)
  const countRows = await dbQuery<{ buy_sell_count: number | string }>(
    `SELECT COUNT(*)::INTEGER AS buy_sell_count
     FROM signals
     WHERE exchange = ?
       AND signal IN ('BUY', 'SELL')
       AND created_at > ?`,
    [venue.exchange_id, integratedUnix],
  );
  const buySellCount = Number(countRows[0]?.buy_sell_count ?? 0);

  // PFE WR derived from pfe_return_pct (HOLDs excluded; only Phase-E-
  // backfilled signals count via `pfe_return_pct IS NOT NULL`).
  // Returns NULL when no BUY/SELL signals have been Phase-E-evaluated yet.
  const wrRows = await dbQuery<{ pfe_wr: number | string | null }>(
    `SELECT AVG(CASE
                  WHEN (signal = 'BUY'  AND pfe_return_pct > 0) THEN 1.0
                  WHEN (signal = 'SELL' AND pfe_return_pct < 0) THEN 1.0
                  ELSE 0.0
                END)::REAL AS pfe_wr
     FROM signals
     WHERE exchange = ?
       AND signal IN ('BUY', 'SELL')
       AND pfe_return_pct IS NOT NULL
       AND created_at > ?`,
    [venue.exchange_id, integratedUnix],
  );
  const wrRaw = wrRows[0]?.pfe_wr;
  const pfeWr = wrRaw === null || wrRaw === undefined ? null : Number(wrRaw);

  return { pfe_wr: pfeWr, buy_sell_count: buySellCount, days_since: daysSince };
}

/**
 * Apply the C3 decision tree to a single shadow venue's stats. Pure logic —
 * exported for unit-test coverage of every branch.
 */
export function decide(venue: VenueRecord, stats: EvalStats): EvalDecision {
  const { pfe_wr, buy_sell_count, days_since } = stats;

  // Branch 0 (OPS-SHADOW-ALERT-HYGIENE-W1, 2026-06-01): NO PIPELINE YET —
  // silent recovery. A venue with zero BUY/SELL signals has no seed pipeline
  // feeding it (the shadow seed-loop ships in OPS-SHADOW-PIPELINE-W1). It must
  // NOT fire an operator Telegram alert and must NOT burn its extension budget
  // on empty data. Classifying as no_op:'no_pipeline_yet' short-circuits the
  // evaluate loop before sendVenueStatusChange()/incrementExtension() are ever
  // reached (forensic stays in logs, not the alert channel — CLAUDE.md
  // "recovery alerts are noise — default silent recovery"). Placed FIRST so it
  // pre-empts the day-15 extend + day-30 manual_required branches for starved
  // venues (e.g. ASTER/EDGEX and the 10 venues crossing day-15 on 06-03/06-04).
  if (buy_sell_count === 0) {
    return { action: 'no_op', reason: 'no_pipeline_yet', pfe_wr, buy_sell_count, days_since };
  }

  // Branch 1: PROMOTE — day-15 floor passed AND sample-met AND WR-met.
  if (
    days_since >= DAY_15_FLOOR &&
    buy_sell_count >= venue.min_buy_sell_sample &&
    pfe_wr !== null &&
    pfe_wr >= PFE_WR_THRESHOLD
  ) {
    return { action: 'promoted', pfe_wr, buy_sell_count };
  }

  // Branch 2: AUTO-EXTEND — day-15 hit, never extended.
  if (days_since >= DAY_15_FLOOR && days_since < DAY_30_FLOOR && venue.extension_count === 0) {
    return { action: 'extended', pfe_wr, buy_sell_count };
  }

  // Branch 3: MANUAL REQUIRED — day-30 hit after one extension.
  if (days_since >= DAY_30_FLOOR && venue.extension_count >= 1) {
    return { action: 'manual_required', pfe_wr, buy_sell_count };
  }

  // Branch 4: NO-OP — pre-deadline OR mid-cycle.
  const reason = days_since < DAY_15_FLOOR
    ? 'within_initial_window'
    : pfe_wr === null
      ? 'no_phase_e_outcomes_yet'
      : buy_sell_count < venue.min_buy_sell_sample
        ? 'sample_insufficient'
        : pfe_wr < PFE_WR_THRESHOLD
          ? 'wr_below_threshold'
          : 'already_extended_pre_day_30';
  return { action: 'no_op', reason, pfe_wr, buy_sell_count, days_since };
}

/**
 * Execute the full evaluation loop. Reads all shadow venues, evaluates each,
 * applies state-machine writes, fires Telegram alerts. Returns a summary
 * object for logging.
 */
export async function evaluateAllShadowVenues(now: Date = new Date()): Promise<{
  promoted_count_initial: number;
  shadow_count: number;
  actions: { venue: string; decision: EvalDecision }[];
}> {
  const promoted = await listVenues('promoted');
  const shadows = await listVenues('shadow');
  const actions: { venue: string; decision: EvalDecision }[] = [];

  for (const venue of shadows) {
    const stats = await computeVenueStats(venue, now);
    await recordEval(venue.exchange_id, stats.pfe_wr, stats.buy_sell_count, now);

    const decision = decide(venue, stats);
    actions.push({ venue: venue.exchange_id, decision });

    if (decision.action === 'promoted') {
      await setStatus(venue.exchange_id, 'promoted', { promoted_at: now });
      await sendVenueStatusChange({
        venue: venue.exchange_id,
        action: 'promoted',
        pfe_wr: decision.pfe_wr,
        buy_sell_count: decision.buy_sell_count,
        min_buy_sell_sample: venue.min_buy_sell_sample,
        days_since: stats.days_since,
        extension_count: venue.extension_count,
      });
    } else if (decision.action === 'extended') {
      await incrementExtension(venue.exchange_id);
      await sendVenueStatusChange({
        venue: venue.exchange_id,
        action: 'extended',
        pfe_wr: decision.pfe_wr,
        buy_sell_count: decision.buy_sell_count,
        min_buy_sell_sample: venue.min_buy_sell_sample,
        days_since: stats.days_since,
        extension_count: venue.extension_count + 1,
      });
    } else if (decision.action === 'manual_required') {
      // NO automatic state change. Mr.1 manually decides PROMOTE / RETIRE /
      // EXTEND_AGAIN via direct postgres update + redeploy.
      await sendVenueStatusChange({
        venue: venue.exchange_id,
        action: 'manual_required',
        pfe_wr: decision.pfe_wr,
        buy_sell_count: decision.buy_sell_count,
        min_buy_sell_sample: venue.min_buy_sell_sample,
        days_since: stats.days_since,
        extension_count: venue.extension_count,
      });
    }
  }

  return {
    promoted_count_initial: promoted.length,
    shadow_count: shadows.length,
    actions,
  };
}

// ── CLI entrypoint ──

async function main(): Promise<void> {
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();

  try {
    const summary = await evaluateAllShadowVenues(startedAt);
    const promoted = summary.actions.filter(a => a.decision.action === 'promoted').length;
    const extended = summary.actions.filter(a => a.decision.action === 'extended').length;
    const manual = summary.actions.filter(a => a.decision.action === 'manual_required').length;
    const noop = summary.actions.filter(a => a.decision.action === 'no_op').length;

    // Single-line structured summary. Easy for journalctl + grep.
    console.log(
      `[evaluate-venues] ${startedIso} promoted_initial=${summary.promoted_count_initial} ` +
      `shadow=${summary.shadow_count} actions=${summary.actions.length} ` +
      `promoted=${promoted} extended=${extended} manual_required=${manual} no_op=${noop}`,
    );

    // Per-action detail line — helps post-mortem when a state transition fires.
    for (const a of summary.actions) {
      console.log(`[evaluate-venues]   ${a.venue}: ${JSON.stringify(a.decision)}`);
    }
  } catch (err) {
    console.error(`[evaluate-venues] FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// Auto-run only when invoked as a script (not when imported by tests).
// CJS heuristic: require.main === module. Under ts-node/tsx we check
// process.argv[1].
if (require.main === module) {
  main().then(() => process.exit(0));
}
