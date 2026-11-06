/**
 * pre-trade-check-log.ts — DECISION-CALL-V2-W1 CH3. The `pre_trade_check` check log.
 *
 * ONE row per served, billed, non-internal call (`pre_trade_checks`, migrations/051, permanent retention):
 * what the caller asked, the decision and its venue, every active rule as it was judged and each venue's
 * figures — so a rule's history is measured from what was served, never reconstructed. INTERNAL: never on
 * a public surface (`Prompt/pre-trade-check-contract-v2.md` § Check log).
 *
 *   writer  the pre_trade_check row of `tool-call-pipeline.ts`, once the response exists. FAIL-OPEN:
 *           the row hands the served outcome over UNREAD, `recordPreTradeCheck` reads it only inside its
 *           catch, never throws, and the call never awaits it — a failure bumps a counter and logs one
 *           line, so the response and its billing are exactly what they would have been.
 *   reader  `pre-trade-health.ts`, the log-parity leg: `countServedChecks` (request_log) against
 *           `countLoggedChecks` (this table) over 24 h. The canary's session is read-only, so it ADOPTS the
 *           table (`to_regclass`) and never reaches the lazy ensure.
 *
 * SHADOW ODDS (DECISION-CALL-V2-W4 CH2, migrations/053): each row also holds the no-edge odds of its order —
 * `p_timeout`, `p_target_first`, `p_stop_first`, `p_liq_hold` and the `odds_version` table they come from —
 * computed by `noEdgeOdds` (pre-trade-calc.ts) from the row's own served figures. LOGGED, NEVER SERVED: no
 * response carries them, and they are computed here, after the response exists, inside the fail-open path.
 *
 * WHAT A ROW NEVER HOLDS: equity, a raw license key, a wallet address or an IP. The caller is `caller_ref`,
 * `callerRef({ licenseKey, payerWallet })` (lifecycle/identity.ts — the hashEmail pattern under its own
 * domains): the license key, else the x402 payer (DECISION-CALL-V2-PAYER-REF-W1), else NULL — a keyless free
 * call. The row names every column from the served response — never a spread — so a field added to the
 * response cannot reach the log without being named here.
 *
 * THE CALL LEDGER (DECISION-CALL-V2-W5 CH1, migrations/055, contract vault `Prompt/call-ledger-contract.md`):
 * a row is written only for a response that carries a receipt (`ledger`, minted by `toPreTradeCheckResponse`
 * on the served, billed, non-internal path — the log's own predicate, decided once). The SAME statement
 * writes the check row (with its `ledger_id`) and both `call_ledger` leaves — the verdict leaf the caller
 * holds and a salted odds leaf (a fresh 32-byte salt, stored on that leaf's row, never served) — so a check
 * is either logged with both leaves or not at all. Before writing, the row must rebuild the served leaf
 * (`verdictRecordFromRow`): a row that would not is refused, never stored. The salt is the only secret here;
 * no reader of this module returns it.
 *
 * PG-targeted ($N placeholders, `::jsonb`): `pre_trade_check` is `residency: 'hosted'`, refused before
 * dispatch on a local install, so this table only ever lives in the hosted Postgres.
 */
import { dbQuery } from './performance-db.js';
import { callerRef } from './lifecycle/identity.js';
import { noEdgeOdds } from './pre-trade-calc.js';
import { ODDS_VERSION } from './pre-trade-odds-calibration.js';
import {
  CALL_LEDGER_TOOL,
  mintOddsSalt,
  oddsLeaf,
  oddsRecordFromRow,
  verdictLeaf,
  verdictRecordFromRow,
  type CheckRowLedgerSource,
} from './call-ledger.js';
import type { PreTradeCheckFacts, PreTradeCheckResponse } from '../tools/pre-trade-check.js';

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pre_trade_checks (
  id               BIGSERIAL        PRIMARY KEY,
  checked_at       TIMESTAMPTZ      NOT NULL,
  rule_version     SMALLINT         NOT NULL,
  channel          TEXT             NOT NULL,
  caller_ref       TEXT,
  coin             TEXT             NOT NULL,
  side             TEXT             NOT NULL,
  size_usd         DOUBLE PRECISION NOT NULL,
  hold_hours       DOUBLE PRECISION NOT NULL,
  timeframe        TEXT             NOT NULL,
  order_type       TEXT             NOT NULL,
  leverage         DOUBLE PRECISION,
  stop_pct         DOUBLE PRECISION,
  target_pct       DOUBLE PRECISION,
  decision         TEXT             NOT NULL,
  decision_venue   TEXT,
  sigma_1h_pct     DOUBLE PRECISION,
  liq_distance_pct DOUBLE PRECISION,
  ref_mid_px       DOUBLE PRECISION,
  rules            JSONB            NOT NULL,
  venues           JSONB            NOT NULL
)`;

// The parity leg counts a 24 h window; the PK cannot serve that order.
const CREATE_CHECKED_AT_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_pre_trade_checks_checked_at ON pre_trade_checks (checked_at)`;

// The shadow-odds columns (matches migrations/053). Nullable: a row logged before 053 has none, and an order
// without a bracket or a liquidation distance has none of those values.
const ADD_ODDS_COLUMNS_SQL = `ALTER TABLE pre_trade_checks
  ADD COLUMN IF NOT EXISTS p_timeout      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS p_target_first DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS p_stop_first   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS p_liq_hold     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS odds_version   TEXT`;

// The call ledger (matches migrations/055). One row per leaf: a logged check's verdict leaf and its odds leaf,
// written in the check row's own statement. `ref_id` is that row's id (no FK: a future tool joins with its own
// table). `batch_id` and `proof` stay NULL until the daily anchor seals the leaf into a batch.
const CREATE_CALL_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS call_ledger (
  id         BIGSERIAL   PRIMARY KEY,
  ledger_id  TEXT        NOT NULL CHECK (ledger_id ~ '^pcl_[0-9a-f]{32}$'),
  kind       TEXT        NOT NULL CHECK (kind IN ('verdict', 'odds')),
  tool       TEXT        NOT NULL,
  ref_id     BIGINT      NOT NULL,
  leaf       TEXT        NOT NULL UNIQUE CHECK (leaf ~ '^0x[0-9a-f]{64}$'),
  salt       TEXT        CHECK (salt ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id   INTEGER,
  proof      JSONB,
  UNIQUE (ledger_id, kind),
  CHECK ((kind = 'odds') = (salt IS NOT NULL))
)`;

// The anchor reads the unbatched leaves (batch_id IS NULL) and the recheck reads by batch.
const CREATE_CALL_LEDGER_BATCH_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_call_ledger_batch_id ON call_ledger (batch_id)`;

// The check row's receipt id (matches migrations/055). Nullable, no default — a catalog-only change; a row
// logged before 055 has none.
const ADD_LEDGER_ID_COLUMN_SQL = `ALTER TABLE pre_trade_checks
  ADD COLUMN IF NOT EXISTS ledger_id TEXT`;

let _ensured = false;
// Its own flag: the read-only adoption marks the table as present, never the 053 columns, so a process
// whose canary adopted first still runs the ALTER before its first write.
let _oddsColumnsEnsured = false;
// Its own flag, for the same reason: adoption never marks the 055 objects.
let _ledgerEnsured = false;
let _failures = 0;

/** Idempotent ensure of the table + index (051), the odds columns (053) and the call ledger (055); once per process. */
async function ensurePreTradeCheckTable(): Promise<void> {
  if (!_ensured) {
    await dbQuery(CREATE_TABLE_SQL);
    await dbQuery(CREATE_CHECKED_AT_INDEX_SQL);
    _ensured = true;
  }
  if (!_oddsColumnsEnsured) {
    await dbQuery(ADD_ODDS_COLUMNS_SQL);
    _oddsColumnsEnsured = true;
  }
  if (!_ledgerEnsured) {
    await dbQuery(CREATE_CALL_LEDGER_SQL);
    await dbQuery(CREATE_CALL_LEDGER_BATCH_INDEX_SQL);
    await dbQuery(ADD_LEDGER_ID_COLUMN_SQL);
    _ledgerEnsured = true;
  }
}

/** Test-only reset of the once-per-process ensure flags and the failure counter. */
export function _resetPreTradeCheckLogForTest(): void {
  _ensured = false;
  _oddsColumnsEnsured = false;
  _ledgerEnsured = false;
  _failures = 0;
}

/** Test-only read of the failure counter (it is also printed on every failure line). */
export function _preTradeCheckLogFailuresForTest(): number {
  return _failures;
}

/**
 * READ-ONLY adoption (the health canary): `CREATE … IF NOT EXISTS` is refused inside a read-only
 * transaction even when the table exists, so this probes both relations with `to_regclass` and, only
 * when both exist, marks the ensure done. Issues no DDL and no write. False = no call has been logged yet.
 */
export async function adoptPreTradeCheckTable(): Promise<boolean> {
  if (_ensured) return true;
  const rows = await dbQuery<{ t: boolean | null; i: boolean | null }>(
    `SELECT to_regclass('pre_trade_checks') IS NOT NULL AS t, to_regclass('idx_pre_trade_checks_checked_at') IS NOT NULL AS i`,
  );
  const ok = rows[0]?.t === true && rows[0]?.i === true;
  if (ok) _ensured = true;
  return ok;
}

/** One `pre_trade_checks` row as written (`id` is the database's). */
export interface PreTradeCheckLogRow {
  checked_at: string;
  rule_version: number;
  channel: string;
  caller_ref: string | null;
  coin: string;
  side: string;
  size_usd: number;
  hold_hours: number;
  timeframe: string;
  order_type: string;
  leverage: number | null;
  stop_pct: number | null;
  target_pct: number | null;
  decision: string;
  decision_venue: string | null;
  sigma_1h_pct: number | null;
  liq_distance_pct: number | null;
  ref_mid_px: number | null;
  rules: { id: string; source: string; limit: number | boolean; value: number | boolean | string | null; result: string; detail: string }[];
  venues: { exchange: string; est_cost_bps: number | null; round_trip_bps: number | null; liq_distance_pct: number | null; your_rules: string | null }[];
  /** The no-edge odds (logged, never served) and the table they come from. */
  p_timeout: number | null;
  p_target_first: number | null;
  p_stop_first: number | null;
  p_liq_hold: number | null;
  odds_version: string;
  /** The served receipt's id (migrations/055); null for a response that carries none — such a row is never written. */
  ledger_id: string | null;
}

/** What one served call gives the log. */
export interface PreTradeCheckLogSource {
  response: PreTradeCheckResponse;
  /** The pipeline channel the call came in on (`mcp`, `httpX402`). */
  channel: string;
  /** The caller's license key: pseudonymised here, never stored. Null for a keyless or x402 call. */
  licenseKey: string | null;
  /** The x402 payer wallet (`getRequestPayerWallet()`): the caller when there is no key — pseudonymised here,
   *  never stored. Absent off the paid rails. */
  payerWallet?: string | null;
  /** The handler's internal facts (`outcome.facts`; `refMidPx` is the decision venue's reference price) —
   *  handed over unread, so a missing or malformed one fails inside the catch, never at the call site. */
  facts: PreTradeCheckFacts;
}

/** The row: every column named from the served response — never a spread, never equity. The odds are a
 *  function of the served figures alone (stop, target, sigma_H, liquidation distance), so a row recomputes. */
export function toPreTradeCheckLogRow(src: PreTradeCheckLogSource): PreTradeCheckLogRow {
  const r = src.response;
  // The response types `side` as a string; a side it does not spell exactly is no side — null odds, never a guess.
  const side = r.side === 'long' || r.side === 'short' ? r.side : null;
  const odds = side === null ? null : noEdgeOdds({
    side,
    stopPct: r.inputs.stop_pct,
    targetPct: r.inputs.target_pct,
    sigmaHoldPct: r.calc.sigma_hold_pct,
    liqDistancePct: r.calc.liq_distance_pct,
  });
  return {
    checked_at: r.as_of,
    rule_version: r.rule_version,
    channel: src.channel,
    caller_ref: callerRef({ licenseKey: src.licenseKey, payerWallet: src.payerWallet }),
    coin: r.coin,
    side: r.side,
    size_usd: r.size_usd,
    hold_hours: r.hold_hours,
    timeframe: r.timeframe,
    order_type: r.inputs.order_type,
    leverage: r.inputs.leverage,
    stop_pct: r.inputs.stop_pct,
    target_pct: r.inputs.target_pct,
    decision: r.decision,
    decision_venue: r.best_venue ? r.best_venue.exchange : null,
    sigma_1h_pct: r.calc.sigma_1h_pct,
    liq_distance_pct: r.calc.liq_distance_pct,
    ref_mid_px: src.facts.refMidPx,
    rules: r.rules.map((x) => ({ id: x.id, source: x.source, limit: x.limit, value: x.value, result: x.result, detail: x.detail })),
    venues: r.venues.map((v) => ({
      exchange: v.exchange, est_cost_bps: v.est_cost_bps, round_trip_bps: v.round_trip_bps, liq_distance_pct: v.liq_distance_pct, your_rules: v.your_rules,
    })),
    p_timeout: odds === null ? null : odds.pTimeout,
    p_target_first: odds === null ? null : odds.pTargetFirst,
    p_stop_first: odds === null ? null : odds.pStopFirst,
    p_liq_hold: odds === null ? null : odds.pLiqHold,
    odds_version: ODDS_VERSION,
    ledger_id: r.ledger ? r.ledger.id : null,
  };
}

/**
 * ONE statement, so ONE transaction: the check row, then both of its `call_ledger` leaves keyed to the row's
 * new id. A constraint either insert breaks rolls back all three. $1–$25 are the 051 + 053 columns as before;
 * $26 the ledger id, $27 the tool, $28 the verdict leaf, $29 the odds leaf, $30 the odds leaf's salt.
 */
const INSERT_SQL = `WITH chk AS (
  INSERT INTO pre_trade_checks (
    checked_at, rule_version, channel, caller_ref, coin, side, size_usd, hold_hours, timeframe, order_type,
    leverage, stop_pct, target_pct, decision, decision_venue, sigma_1h_pct, liq_distance_pct, ref_mid_px, rules, venues,
    p_timeout, p_target_first, p_stop_first, p_liq_hold, odds_version, ledger_id
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21, $22, $23, $24, $25, $26)
  RETURNING id
)
INSERT INTO call_ledger (ledger_id, kind, tool, ref_id, leaf, salt)
SELECT $26::text, l.kind, $27::text, chk.id, l.leaf, l.salt
FROM chk CROSS JOIN (VALUES ('verdict', $28::text, NULL::text), ('odds', $29::text, $30::text)) AS l (kind, leaf, salt)`;

/** The row as `verdictRecordFromRow` / `oddsRecordFromRow` read it — the same projection the recheck applies to a stored row. */
function ledgerSourceOf(row: PreTradeCheckLogRow): CheckRowLedgerSource {
  return {
    ledger_id: row.ledger_id, checked_at: row.checked_at, coin: row.coin, side: row.side, size_usd: row.size_usd,
    hold_hours: row.hold_hours, timeframe: row.timeframe, order_type: row.order_type, leverage: row.leverage,
    stop_pct: row.stop_pct, target_pct: row.target_pct, decision: row.decision, decision_venue: row.decision_venue,
    rule_version: row.rule_version, rules: row.rules, odds_version: row.odds_version, p_timeout: row.p_timeout,
    p_target_first: row.p_target_first, p_stop_first: row.p_stop_first, p_liq_hold: row.p_liq_hold,
  };
}

/**
 * Write one row for a served call, with both of its ledger leaves. NEVER THROWS: building the row (every
 * read of the served outcome, and the pseudonym, which needs the IP-hash key), both leaves and the insert
 * all run inside the catch; a failure bumps the counter and logs one line. The call has already been served
 * and billed, and stays exactly that. Resolves true when the row was written.
 *
 * REFUSED (counted as a failure, nothing written): a response with no receipt — the pipeline never hands
 * one over, so one here is a caller bug — and a row that does not rebuild the served leaf, which would put
 * a verdict on the record that the caller never received.
 */
export async function recordPreTradeCheck(src: PreTradeCheckLogSource): Promise<boolean> {
  try {
    const row = toPreTradeCheckLogRow(src);
    const receipt = src.response.ledger;
    if (!receipt || row.ledger_id === null) throw new Error('the response carries no ledger receipt — no receipt, no row');
    const source = ledgerSourceOf(row);
    if (verdictLeaf(verdictRecordFromRow(source)) !== receipt.leaf) {
      throw new Error(`the row does not rebuild the served leaf of ${receipt.id}`);
    }
    const salt = mintOddsSalt();
    const odds = oddsLeaf(oddsRecordFromRow(source), salt);
    await ensurePreTradeCheckTable();
    await dbQuery(INSERT_SQL, [
      row.checked_at, row.rule_version, row.channel, row.caller_ref, row.coin, row.side, row.size_usd, row.hold_hours,
      row.timeframe, row.order_type, row.leverage, row.stop_pct, row.target_pct, row.decision, row.decision_venue,
      row.sigma_1h_pct, row.liq_distance_pct, row.ref_mid_px, JSON.stringify(row.rules), JSON.stringify(row.venues),
      row.p_timeout, row.p_target_first, row.p_stop_first, row.p_liq_hold, row.odds_version,
      row.ledger_id, CALL_LEDGER_TOOL, receipt.leaf, odds, salt,
    ]);
    return true;
  } catch (e) {
    _failures += 1;
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[pre-trade-check-log] row not written (failures since start: ${_failures}): ${why.slice(0, 200)}`);
    return false;
  }
}

/**
 * When the log began: its first row's `checked_at` (epoch ms), or null while it holds no row. The parity
 * leg's window never starts before it — a call served before the log existed was never the writer's to
 * log (v1 had no log). Permanent retention fixes the instant once set, so after the log's first 24 h the
 * window is a plain 24 h. A value it cannot read THROWS: the leg is then INDETERMINATE, never a defaulted
 * window. The table must exist: adopt it first.
 */
export async function firstLoggedCheckAt(): Promise<number | null> {
  const rows = await dbQuery<{ first: Date | string | null }>(`SELECT MIN(checked_at) AS first FROM pre_trade_checks`);
  const v = rows[0]?.first ?? null;
  if (v === null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new Error(`pre_trade_checks MIN(checked_at) unreadable: ${String(v).slice(0, 40)}`);
  return ms;
}

/** Rows logged since `sinceMs` — the parity leg's `logged`. The table must exist: adopt it first. */
export async function countLoggedChecks(sinceMs: number): Promise<number> {
  const rows = await dbQuery<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM pre_trade_checks WHERE checked_at >= $1`,
    [new Date(sinceMs).toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Served non-internal pre_trade_check calls since `sinceMs`, from request_log — the parity leg's `served`.
 * The predicate: the pre_trade_check pipeline row writes request_log on success only (`logOnRefusal: false`,
 * `logError: null`), so a row IS a served call, and `is_bot_internal` is that row's
 * `license.tier === 'internal'` — the same test the writer skips internal callers by.
 *   tool_name = 'pre_trade_check' AND is_bot_internal IS NOT TRUE AND timestamp >= <since, ISO-8601>
 * (`request_log.timestamp` is ISO-8601 text, which orders as time.) The caller picks `sinceMs` —
 * the later of 24 h ago and `firstLoggedCheckAt()` — so a v1 call served before the log existed is never
 * counted against it.
 */
export async function countServedChecks(sinceMs: number): Promise<number> {
  const rows = await dbQuery<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM request_log WHERE tool_name = 'pre_trade_check' AND is_bot_internal IS NOT TRUE AND timestamp >= $1`,
    [new Date(sinceMs).toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

// ── The call ledger's reads of this table (DECISION-CALL-V2-W5) ─────────────────────────────────
// The SQL against pre_trade_checks stays in this module: the anchor's recheck and the health canary call
// these, and never select the table themselves. None of them reads a salt, a caller or a venue figure.

/** A stored check row, projected to exactly what the two ledger records read, plus its id. */
export interface LedgerCheckRow extends CheckRowLedgerSource {
  id: number | string;
}

/**
 * The stored rows behind the given check ids (`call_ledger.ref_id`) — the recheck rebuilds every leaf from
 * these with `verdictRecordFromRow` / `oddsRecordFromRow`, never from the stored leaves. Rows in id order.
 */
export async function readLedgerCheckRows(refIds: readonly (number | string)[]): Promise<LedgerCheckRow[]> {
  if (refIds.length === 0) return [];
  return dbQuery<LedgerCheckRow>(
    `SELECT id, ledger_id, checked_at, coin, side, size_usd, hold_hours, timeframe, order_type, leverage, stop_pct, target_pct,
       decision, decision_venue, rule_version, rules, odds_version, p_timeout, p_target_first, p_stop_first, p_liq_hold
     FROM pre_trade_checks WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [refIds.map((x) => String(x))],
  );
}

/**
 * READ-ONLY adoption of the 055 objects (the canary's session is read-only): true when `call_ledger` and
 * `pre_trade_checks.ledger_id` both exist. Issues no DDL. False = no receipted check has been logged yet.
 */
export async function adoptCallLedger(): Promise<boolean> {
  const rows = await dbQuery<{ t: boolean | null; c: boolean | null }>(
    `SELECT to_regclass('call_ledger') IS NOT NULL AS t,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pre_trade_checks' AND column_name = 'ledger_id') AS c`,
  );
  return rows[0]?.t === true && rows[0]?.c === true;
}

/**
 * The canary's "logged check missing a leaf" leg: since the first receipted row, every check row (`checked`)
 * and those lacking its verdict leaf, its odds leaf or a ledger id at all (`missing`) — a row an older writer
 * logged after the ledger began counts. Both counts are printed, so a zero is never a search of nothing.
 * The 055 objects must exist: adopt them first.
 */
export async function countChecksMissingLeaves(): Promise<{ checked: number; missing: number }> {
  const rows = await dbQuery<{ checked: string | number; missing: string | number }>(
    `SELECT COUNT(*) AS checked,
       COUNT(*) FILTER (WHERE c.ledger_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM call_ledger l WHERE l.ledger_id = c.ledger_id AND l.kind = 'verdict')
         OR NOT EXISTS (SELECT 1 FROM call_ledger l WHERE l.ledger_id = c.ledger_id AND l.kind = 'odds')) AS missing
     FROM pre_trade_checks c
     WHERE c.checked_at >= (SELECT MIN(f.checked_at) FROM pre_trade_checks f WHERE f.ledger_id IS NOT NULL)`,
  );
  return { checked: Number(rows[0]?.checked ?? 0), missing: Number(rows[0]?.missing ?? 0) };
}

/**
 * DECISION-CALL-V2-W5 CH2 — the canary's "stale leaf" leg: every leaf (`total`), those not yet in a VERIFIED batch
 * (`unanchored` — never batched, or batched into one still sealed or sent), and the oldest of those. The nightly
 * anchor batches every leaf within ~24 h, so one waiting longer than the canary's bound means the anchor is not
 * keeping up. Before the first anchor `call_ledger_batches` does not exist and every leaf is unanchored.
 * READ-ONLY (to_regclass, never DDL); adopt the 055 objects first.
 */
export async function countUnanchoredLeaves(): Promise<{ total: number; unanchored: number; oldestMs: number | null }> {
  const t = await dbQuery<{ b: boolean | null }>(`SELECT to_regclass('call_ledger_batches') IS NOT NULL AS b`);
  const unanchored = t[0]?.b === true
    ? `l.batch_id IS NULL OR NOT EXISTS (SELECT 1 FROM call_ledger_batches b WHERE b.batch_id = l.batch_id AND b.state = 'verified')`
    : 'TRUE';
  const rows = await dbQuery<{ total: string | number; unanchored: string | number; oldest: Date | string | null }>(
    `SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ${unanchored}) AS unanchored,
       MIN(l.created_at) FILTER (WHERE ${unanchored}) AS oldest
     FROM call_ledger l`,
  );
  const oldest = rows[0]?.oldest ?? null;
  const oldestMs = oldest === null ? null : oldest instanceof Date ? oldest.getTime() : Date.parse(String(oldest));
  return {
    total: Number(rows[0]?.total ?? 0),
    unanchored: Number(rows[0]?.unanchored ?? 0),
    oldestMs: oldestMs !== null && Number.isFinite(oldestMs) ? oldestMs : null,
  };
}
