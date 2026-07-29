/**
 * candle-basis-shadow.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH2
 *
 * SHADOW measurement store for the confirmed-bar (closed-candle) re-base. The live
 * verdict still scores on the IN-PROGRESS bar; CH2 instruments a closed-bar basis
 * WITHOUT changing the emitted call (CANDLE_BASIS defaults to 'live' → byte-identical).
 * For each evaluated non-internal signal this persists BOTH verdicts plus the component
 * scores, so the read-only harness (CH4) can quantify divergence and the FLIP wave can
 * retune thresholds from measurement instead of guesswork.
 *
 * Component scores have NEVER been persisted before, so there is no retrospective path —
 * only forward measurement. That is why this table exists at all.
 *
 * Data Integrity: the write is FIRE-AND-FORGET and FULLY try/catch-isolated here — a
 * shadow-write defect NEVER blocks or fails the live verdict (the caller also `void`s +
 * `.catch()`es it; defense-in-depth). Append-only, with a 90-day retention DELETE in the
 * nightly labeler and a monthly VACUUM (ANALYZE) — this lands on the host that runs the
 * Postgres-CPU autopilot, so an unbounded append-only table is not an option.
 *
 * INTERNAL data class, same as `outcome_return_pct`: `vol_score_*` / `raw_*` are raw
 * model internals and are NEVER exposed via MCP, the HTTP API, the landing page or the
 * README. Enforced by the value-binding regex in scripts/security-canary.mjs (Gate B).
 *
 * Shape deliberately clones `oiscore-shadow.ts`: static `dbQuery` import, once-per-process
 * `ensureTable()`, a `_reset…Ensure()` test seam, and a swallowing try/catch. The static
 * import is correct here rather than merely tolerated — `get-trade-call.ts` ALREADY imports
 * `performance-db.js` statically (recordSignal/recordFunding/getFundingZScore/recordHoldCount)
 * and again transitively through `oiscore-shadow.ts`, so this adds no new cycle edge. The
 * lazy-`import()` shape used by `emit-suppressions.ts` exists for modules reachable from the
 * TRANSPORT layer, where the documented init cycle actually bites, and it carries a real
 * cost (a `process.env.VITEST` early-return hack). Verified in-worktree before cloning.
 */

import { dbQuery } from './performance-db.js';
import type { SignalVerdict } from '../types.js';

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS candle_basis_shadow (
  id                BIGSERIAL     PRIMARY KEY,
  recorded_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  coin              TEXT          NOT NULL,
  exchange          TEXT          NOT NULL,
  timeframe         TEXT          NOT NULL,
  call_live         TEXT          NOT NULL,
  call_closed       TEXT,
  error_class       TEXT,
  conf_live         INTEGER       NOT NULL,
  conf_closed       INTEGER,
  raw_live          NUMERIC       NOT NULL,
  raw_closed        NUMERIC,
  vol_score_live    INTEGER       NOT NULL,
  vol_score_closed  INTEGER,
  rsi_score_live    INTEGER       NOT NULL,
  rsi_score_closed  INTEGER,
  elapsed_fraction  NUMERIC,
  n_closed          INTEGER       NOT NULL,
  n_total           INTEGER       NOT NULL
)`;
const CREATE_INDEX_RECORDED_SQL =
  `CREATE INDEX IF NOT EXISTS idx_candle_basis_shadow_recorded ON candle_basis_shadow (recorded_at)`;
const CREATE_INDEX_TF_SQL =
  `CREATE INDEX IF NOT EXISTS idx_candle_basis_shadow_tf_recorded ON candle_basis_shadow (timeframe, recorded_at)`;

let _ensured = false;

/**
 * PG-only. BIGSERIAL / TIMESTAMPTZ / NUMERIC are not SQLite grammar, and `now()` is not
 * a SQLite function, so on the local/test SQLite backend this is an explicit no-op rather
 * than a caught exception.
 *
 * `oiscore-shadow.ts` has no such guard — it relies on its swallowing catch, which works
 * but makes every SQLite-path call do a failing round-trip and log nothing, so "the table
 * is missing" and "the backend can't express the table" are indistinguishable. The
 * backend test outside performance-db.ts is `process.env.DATABASE_URL` (the convention
 * `analytics.ts` already uses); `isPg` itself is module-private.
 */
function isPostgresBacked(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

async function ensureTable(): Promise<void> {
  if (_ensured) return;
  await dbQuery(CREATE_TABLE_SQL);
  await dbQuery(CREATE_INDEX_RECORDED_SQL);
  await dbQuery(CREATE_INDEX_TF_SQL);
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure flag. */
export function _resetCandleBasisShadowEnsure(): void {
  _ensured = false;
}

export interface CandleBasisShadowRow {
  coin: string;
  exchange: string;
  timeframe: string;
  /** The EMITTED verdict under the live (in-progress-bar) basis. */
  callLive: SignalVerdict;
  /** Null iff the closed-basis derivation threw — then `errorClass` is set. */
  callClosed: SignalVerdict | null;
  /** Constructor name of the throw, populated iff `callClosed` is null. */
  errorClass: string | null;
  confLive: number;
  confClosed: number | null;
  rawLive: number;
  rawClosed: number | null;
  volScoreLive: number;
  volScoreClosed: number | null;
  rsiScoreLive: number;
  rsiScoreClosed: number | null;
  /** 0..1 into the in-progress bar; null when the venue omitted a partial bar. */
  elapsedFraction: number | null;
  nClosed: number;
  nTotal: number;
}

/**
 * Persist ONE shadow divergence row. FIRE-AND-FORGET safe: every error is swallowed here
 * (the caller additionally `void`s + `.catch()`es) so a shadow-write failure can NEVER
 * affect the live verdict. Returns true on a successful insert, false on any error or on
 * a non-Postgres backend.
 */
export async function recordCandleBasisShadow(row: CandleBasisShadowRow): Promise<boolean> {
  if (!isPostgresBacked()) return false;
  try {
    await ensureTable();
    await dbQuery(
      `INSERT INTO candle_basis_shadow
        (coin, exchange, timeframe, call_live, call_closed, error_class,
         conf_live, conf_closed, raw_live, raw_closed,
         vol_score_live, vol_score_closed, rsi_score_live, rsi_score_closed,
         elapsed_fraction, n_closed, n_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        row.coin.toUpperCase(),
        row.exchange,
        row.timeframe,
        row.callLive,
        row.callClosed,
        row.errorClass,
        row.confLive,
        row.confClosed,
        row.rawLive,
        row.rawClosed,
        row.volScoreLive,
        row.volScoreClosed,
        row.rsiScoreLive,
        row.rsiScoreClosed,
        row.elapsedFraction,
        row.nClosed,
        row.nTotal,
      ],
    );
    return true;
  } catch {
    // Shadow-only: never propagate. (Operator forensics live in the harness, not here.)
    return false;
  }
}
