/**
 * seed-heartbeats.ts — OPS-SEED-ORCHESTRATOR-W1 V2-RESUME (CH3-PRE)
 *
 * Per-venue-per-timeframe ATTEMPT-recency heartbeat. The seeder stamps
 * (exchange, timeframe) -> last_attempt_at on EVERY fire, regardless of whether
 * any signal was recorded (the `signals` table only holds BUY/SELL after the
 * HOLD/confidence filter, so recorded-signal recency is a poor seeding-health
 * proxy — see the report-only freshness check). Attempt recency is the true
 * "did the cron fire + reach this venue" signal.
 *
 * Consumers:
 *  - V5(ii) coverage gate (CH3/CH4): all 5 promoted venues fresh per TF post-fire.
 *  - OPS-SEED-FRESHNESS-W1 (future, dispatch-gated): the sole heartbeat paging path.
 *
 * `performance-db.ts` is firewalled (parallel-session domain), so this lives in
 * its own module and reaches the DB through the exported `dbQuery`. The table is
 * SSH-preapplied (CLAUDE.md "pre-apply schema via SSH then deploy code with
 * IF NOT EXISTS idempotency") and also lazily ensured here for fresh-box repro.
 * PG-targeted ($N placeholders) — the seeder's production backend.
 */

import { dbQuery } from './performance-db.js';

let _ensured = false;

/** Idempotent table ensure (matches the SSH-preapplied DDL); runs once per process. */
async function ensureTable(): Promise<void> {
  if (_ensured) return;
  await dbQuery(
    `CREATE TABLE IF NOT EXISTS seed_heartbeats (
       exchange TEXT NOT NULL,
       timeframe TEXT NOT NULL,
       last_attempt_at BIGINT NOT NULL,
       PRIMARY KEY (exchange, timeframe)
     )`,
  );
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure flag. */
export function _resetSeedHeartbeatEnsure(): void {
  _ensured = false;
}

/**
 * Stamp that `exchange` was ATTEMPTED for `timeframe` at `nowS` (epoch SECONDS,
 * matching `signals.created_at`). Upsert keyed on (exchange, timeframe).
 */
export async function recordSeedHeartbeat(
  exchange: string,
  timeframe: string,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await ensureTable();
  await dbQuery(
    `INSERT INTO seed_heartbeats (exchange, timeframe, last_attempt_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (exchange, timeframe) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at`,
    [exchange, timeframe, nowS],
  );
}

export interface SeedHeartbeatRow {
  exchange: string;
  last_attempt_at: number | null;
}

/**
 * V5(ii) gate query: per-venue latest attempt for a timeframe.
 * `SELECT exchange, max(last_attempt_at) FROM seed_heartbeats WHERE timeframe=$1 GROUP BY exchange`.
 */
export async function getSeedHeartbeats(timeframe: string): Promise<SeedHeartbeatRow[]> {
  return dbQuery<SeedHeartbeatRow>(
    `SELECT exchange, max(last_attempt_at) AS last_attempt_at
       FROM seed_heartbeats WHERE timeframe = $1 GROUP BY exchange`,
    [timeframe],
  );
}
