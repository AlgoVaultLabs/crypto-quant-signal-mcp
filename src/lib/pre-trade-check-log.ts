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
 * WHAT A ROW NEVER HOLDS: equity, a raw license key, a wallet address or an IP. The caller is `caller_ref`,
 * `callerRef({ licenseKey, payerWallet })` (lifecycle/identity.ts — the hashEmail pattern under its own
 * domains): the license key, else the x402 payer (DECISION-CALL-V2-PAYER-REF-W1), else NULL — a keyless free
 * call. The row names every column from the served response — never a spread — so a field added to the
 * response cannot reach the log without being named here.
 *
 * PG-targeted ($N placeholders, `::jsonb`): `pre_trade_check` is `residency: 'hosted'`, refused before
 * dispatch on a local install, so this table only ever lives in the hosted Postgres.
 */
import { dbQuery } from './performance-db.js';
import { callerRef } from './lifecycle/identity.js';
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

let _ensured = false;
let _failures = 0;

/** Idempotent ensure of the table + index (matches migrations/051); once per process. */
async function ensurePreTradeCheckTable(): Promise<void> {
  if (_ensured) return;
  await dbQuery(CREATE_TABLE_SQL);
  await dbQuery(CREATE_CHECKED_AT_INDEX_SQL);
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure flag and the failure counter. */
export function _resetPreTradeCheckLogForTest(): void {
  _ensured = false;
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

/** The row: every column named from the served response — never a spread, never equity. */
export function toPreTradeCheckLogRow(src: PreTradeCheckLogSource): PreTradeCheckLogRow {
  const r = src.response;
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
  };
}

const INSERT_SQL = `INSERT INTO pre_trade_checks (
  checked_at, rule_version, channel, caller_ref, coin, side, size_usd, hold_hours, timeframe, order_type,
  leverage, stop_pct, target_pct, decision, decision_venue, sigma_1h_pct, liq_distance_pct, ref_mid_px, rules, venues
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb)`;

/**
 * Write one row for a served call. NEVER THROWS: building the row (every read of the served outcome, and
 * the pseudonym, which needs the IP-hash key) and the insert both run inside the catch; a failure bumps the counter and logs one line. The call has
 * already been served and billed, and stays exactly that. Resolves true when the row was written.
 */
export async function recordPreTradeCheck(src: PreTradeCheckLogSource): Promise<boolean> {
  try {
    const row = toPreTradeCheckLogRow(src);
    await ensurePreTradeCheckTable();
    await dbQuery(INSERT_SQL, [
      row.checked_at, row.rule_version, row.channel, row.caller_ref, row.coin, row.side, row.size_usd, row.hold_hours,
      row.timeframe, row.order_type, row.leverage, row.stop_pct, row.target_pct, row.decision, row.decision_venue,
      row.sigma_1h_pct, row.liq_distance_pct, row.ref_mid_px, JSON.stringify(row.rules), JSON.stringify(row.venues),
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
