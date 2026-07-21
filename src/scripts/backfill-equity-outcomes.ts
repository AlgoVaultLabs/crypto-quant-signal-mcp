/**
 * backfill-equity-outcomes.ts — EQUITIES-ENGINE-W1 C5 producer.
 *
 * Fills equity_verdicts.pfe_pct (+ internal outcome_return_pct) for BUY/SELL
 * verdicts whose PFE horizon has elapsed, computed PURELY from stored
 * equity_bars_daily (NO Databento call — zero extra data cost). Idempotent
 * (only fills NULL pfe_pct) and graceful no-op before the horizon elapses.
 *
 * Run: docker exec crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/backfill-equity-outcomes.js
 * CJS/Node16.
 */
import { makeEquityPool } from '../lib/equities/equity-store.js';
import { runScript } from '../lib/script-lifecycle.js';
import { computePfeOutcome, type OutcomeBar } from '../lib/equities/equity-outcomes.js';
import { PFE_HORIZON_SESSIONS } from '../lib/equities/equity-constants.js';

const BATCH_LIMIT = 5000;
function log(msg: string): void { console.log(`[backfill-equity-outcomes] ${msg}`); }

export async function backfillEquityOutcomes(): Promise<{ filled: number; pending: number; skippedPreHorizon: number }> {
  const pool = makeEquityPool();
  try {
    const pending = await pool.query(
      `SELECT id, symbol, session_date::text AS session_date, call, pfe_horizon_sessions
         FROM equity_verdicts
        WHERE pfe_pct IS NULL AND call IN ('BUY','SELL')
        ORDER BY session_date ASC
        LIMIT $1`,
      [BATCH_LIMIT]
    );
    let filled = 0;
    let skippedPreHorizon = 0;

    for (const v of pending.rows as Array<{ id: number; symbol: string; session_date: string; call: 'BUY' | 'SELL'; pfe_horizon_sessions: number | null }>) {
      const horizon = v.pfe_horizon_sessions ?? PFE_HORIZON_SESSIONS;
      // entry session + the next `horizon` sessions (chronological).
      const bars = await pool.query(
        `SELECT high::float8 AS high, low::float8 AS low, close::float8 AS close
           FROM equity_bars_daily
          WHERE symbol=$1 AND session_date >= $2
          ORDER BY session_date ASC
          LIMIT $3`,
        [v.symbol, v.session_date, horizon + 1]
      );
      if (bars.rows.length < horizon + 1) { skippedPreHorizon++; continue; } // horizon not elapsed → no-op
      const entry = bars.rows[0].close as number;
      const window = bars.rows.slice(1, horizon + 1) as OutcomeBar[];
      const outcome = computePfeOutcome(entry, window, v.call);
      if (!outcome) { skippedPreHorizon++; continue; } // default-deny on bad data
      await pool.query(
        `UPDATE equity_verdicts SET pfe_pct=$1, outcome_return_pct=$2, outcome_filled_at=now() WHERE id=$3`,
        [outcome.pfe_pct, outcome.outcome_return_pct, v.id]
      );
      filled++;
    }
    log(`filled=${filled} skipped_pre_horizon=${skippedPreHorizon} scanned=${pending.rows.length}`);
    return { filled, pending: pending.rows.length, skippedPreHorizon };
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void runScript('backfill-equity-outcomes', async () => {
    const r = await backfillEquityOutcomes();
    log(`DONE filled=${r.filled} scanned=${r.pending}`);
  }); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
