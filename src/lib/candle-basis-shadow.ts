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
import type { SignalVerdict, RegimeType } from '../types.js';
import type { PriceStructureResult } from './indicators.js';

/**
 * CH3 widened this from a `get_trade_call`-only table to a `tool`-discriminated one.
 * The trade-call model internals (`raw_*`, `vol_score_*`, `rsi_score_*`) are therefore
 * NULLABLE here where CH2 declared them NOT NULL: `get_market_regime` has no raw score,
 * no volume ladder and no RSI, so a NOT NULL column could only be satisfied by inventing
 * a number — a fabricated value in a measurement table CH4 will aggregate. Nullable and
 * absent is the honest encoding. See `ALTER_SQL` for the matching live migration.
 */
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS candle_basis_shadow (
  id                    BIGSERIAL     PRIMARY KEY,
  recorded_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  tool                  TEXT,
  coin                  TEXT          NOT NULL,
  exchange              TEXT          NOT NULL,
  timeframe             TEXT          NOT NULL,
  call_live             TEXT          NOT NULL,
  call_closed           TEXT,
  error_class           TEXT,
  conf_live             INTEGER       NOT NULL,
  conf_closed           INTEGER,
  raw_live              NUMERIC,
  raw_closed            NUMERIC,
  vol_score_live        INTEGER,
  vol_score_closed      INTEGER,
  rsi_score_live        INTEGER,
  rsi_score_closed      INTEGER,
  structure_live        TEXT,
  structure_closed      TEXT,
  pivot_quality_live    NUMERIC,
  pivot_quality_closed  NUMERIC,
  elapsed_fraction      NUMERIC,
  n_closed              INTEGER       NOT NULL,
  n_total               INTEGER       NOT NULL
)`;

/**
 * Idempotent migration for a table created by CH2. Every statement is safe to re-run, so
 * a fresh database (which gets the final shape from `CREATE_TABLE_SQL`) and an existing
 * one converge on the same schema.
 *
 * `tool` is left NULLABLE with an explicit one-shot backfill rather than given a column
 * DEFAULT: a lingering `DEFAULT 'get_trade_call'` would silently mislabel rows from a
 * future third tool that forgot to pass one, which is the same class of quiet-wrong-value
 * the NOT NULL relaxation above exists to avoid.
 */
const ALTER_SQL = [
  `ALTER TABLE candle_basis_shadow ADD COLUMN IF NOT EXISTS tool TEXT`,
  `ALTER TABLE candle_basis_shadow ADD COLUMN IF NOT EXISTS structure_live TEXT`,
  `ALTER TABLE candle_basis_shadow ADD COLUMN IF NOT EXISTS structure_closed TEXT`,
  `ALTER TABLE candle_basis_shadow ADD COLUMN IF NOT EXISTS pivot_quality_live NUMERIC`,
  `ALTER TABLE candle_basis_shadow ADD COLUMN IF NOT EXISTS pivot_quality_closed NUMERIC`,
  // Every row that predates the discriminator was written by get_trade_call.
  `UPDATE candle_basis_shadow SET tool = 'get_trade_call' WHERE tool IS NULL`,
  `ALTER TABLE candle_basis_shadow ALTER COLUMN raw_live DROP NOT NULL`,
  `ALTER TABLE candle_basis_shadow ALTER COLUMN vol_score_live DROP NOT NULL`,
  `ALTER TABLE candle_basis_shadow ALTER COLUMN rsi_score_live DROP NOT NULL`,
];

const CREATE_INDEX_RECORDED_SQL =
  `CREATE INDEX IF NOT EXISTS idx_candle_basis_shadow_recorded ON candle_basis_shadow (recorded_at)`;
const CREATE_INDEX_TF_SQL =
  `CREATE INDEX IF NOT EXISTS idx_candle_basis_shadow_tf_recorded ON candle_basis_shadow (timeframe, recorded_at)`;
const CREATE_INDEX_TOOL_SQL =
  `CREATE INDEX IF NOT EXISTS idx_candle_basis_shadow_tool_recorded ON candle_basis_shadow (tool, recorded_at)`;

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
  for (const sql of ALTER_SQL) await dbQuery(sql);
  await dbQuery(CREATE_INDEX_RECORDED_SQL);
  await dbQuery(CREATE_INDEX_TF_SQL);
  await dbQuery(CREATE_INDEX_TOOL_SQL);
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure flag. */
export function _resetCandleBasisShadowEnsure(): void {
  _ensured = false;
}

/** Fields every instrumented tool supplies, whatever its verdict vocabulary is. */
interface CandleBasisShadowBase {
  coin: string;
  exchange: string;
  timeframe: string;
  /** Constructor name of the closed-basis throw, populated iff `callClosed` is null. */
  errorClass: string | null;
  confLive: number;
  confClosed: number | null;
  /** 0..1 into the in-progress bar; null when the venue omitted a partial bar. */
  elapsedFraction: number | null;
  nClosed: number;
  nTotal: number;
}

/** `get_trade_call` — CH2's shape. `tool` is optional so CH2's call site stays FROZEN. */
export interface TradeCallShadowRow extends CandleBasisShadowBase {
  tool?: 'get_trade_call';
  /** The EMITTED verdict under the live (in-progress-bar) basis. */
  callLive: SignalVerdict;
  /** Null iff the closed-basis derivation threw — then `errorClass` is set. */
  callClosed: SignalVerdict | null;
  rawLive: number;
  rawClosed: number | null;
  volScoreLive: number;
  volScoreClosed: number | null;
  rsiScoreLive: number;
  rsiScoreClosed: number | null;
}

/**
 * `get_market_regime` — CH3. Its verdict is the REGIME, and the quantity this wave
 * measures is `detectPriceStructure`'s volume-weighted output, so it carries
 * `structure_*` / `pivot_quality_*` instead of the trade-call model internals.
 */
export interface MarketRegimeShadowRow extends CandleBasisShadowBase {
  tool: 'get_market_regime';
  callLive: RegimeType;
  callClosed: RegimeType | null;
  structureLive: PriceStructureResult['structure'];
  structureClosed: PriceStructureResult['structure'] | null;
  pivotQualityLive: number;
  pivotQualityClosed: number | null;
}

export type CandleBasisShadowRow = TradeCallShadowRow | MarketRegimeShadowRow;

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
    // ONE fixed INSERT for both variants: the columns the other tool has no analogue
    // for go in as NULL rather than as an invented number.
    const isRegime = row.tool === 'get_market_regime';
    await dbQuery(
      `INSERT INTO candle_basis_shadow
        (tool, coin, exchange, timeframe, call_live, call_closed, error_class,
         conf_live, conf_closed, raw_live, raw_closed,
         vol_score_live, vol_score_closed, rsi_score_live, rsi_score_closed,
         structure_live, structure_closed, pivot_quality_live, pivot_quality_closed,
         elapsed_fraction, n_closed, n_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21, $22)`,
      [
        row.tool ?? 'get_trade_call',
        row.coin.toUpperCase(),
        row.exchange,
        row.timeframe,
        row.callLive,
        row.callClosed,
        row.errorClass,
        row.confLive,
        row.confClosed,
        isRegime ? null : row.rawLive,
        isRegime ? null : row.rawClosed,
        isRegime ? null : row.volScoreLive,
        isRegime ? null : row.volScoreClosed,
        isRegime ? null : row.rsiScoreLive,
        isRegime ? null : row.rsiScoreClosed,
        isRegime ? row.structureLive : null,
        isRegime ? row.structureClosed : null,
        isRegime ? row.pivotQualityLive : null,
        isRegime ? row.pivotQualityClosed : null,
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
