/**
 * call-ledger.ts — DECISION-CALL-V2-W5 CH1. The call ledger's v1 format, pure: no database, no network.
 *
 * Contract: vault `Prompt/call-ledger-contract.md` (v1). EVERY FORMAT HERE FREEZES AT THE FIRST ANCHOR: a
 * change after it is v2, under new tags and new vectors, and a v1 leaf is never rewritten. The contract's
 * vectors are the oracle (tests/unit/call-ledger.test.ts); never edit a vector to match this code.
 *
 *   id            `pcl_` + 32 lowercase hex — 16 CSPRNG bytes, minted once per logged check, never derived
 *                 from a row id, the request or the time.
 *   verdict leaf  k(k(TAG_VERDICT ‖ k(JCS(record))))           — what the served response committed to
 *   odds leaf     k(k(TAG_ODDS ‖ k(salt ‖ k(JCS(odds_record))))) — a salted commitment, never served
 *
 * k = keccak256 (Ethereum's, not SHA3-256); ‖ = byte concatenation; JCS = RFC 8785. The double hash keeps a
 * leaf's last preimage at 32 B, apart from a Merkle node's 64 B, so no leaf can pose as a node.
 *
 * COMMIT, NEVER REVEAL: a record names no equity, caller, channel, cost, label, odds value or the receipt
 * itself. The two record builders below copy every key BY NAME — never a spread — so a field added to the
 * response or the row cannot reach a leaf without being named here.
 *
 * Producers: the receipt is minted by `toPreTradeCheckResponse` (src/tools/pre-trade-check.ts) on the served
 * path; both leaves are written by `recordPreTradeCheck` (src/lib/pre-trade-check-log.ts). Consumers: the
 * daily anchor (src/scripts/publish-call-ledger-batch.ts) and its recheck, which rebuilds every leaf from the
 * check rows with `verdictRecordFromRow` / `oddsRecordFromRow`.
 */
import { randomBytes } from 'node:crypto';
import { concat, keccak256, stringToBytes, type Hex } from 'viem';

/** The tool this v1 format commits (a future tool joins under its own tag, never this one's). */
export const CALL_LEDGER_TOOL = 'pre_trade_check' as const;

/** A well-formed ledger id: `pcl_` + 32 lowercase hex. */
export const CALL_LEDGER_ID_RE = /^pcl_[0-9a-f]{32}$/;
/** A leaf, a root or a salt: `0x` + 64 lowercase hex. */
export const BYTES32_HEX_RE = /^0x[0-9a-f]{64}$/;

/** Where a receipt is verified: `verify://check/<id>`. */
export const VERIFY_CHECK_URI_PREFIX = 'verify://check/';

/**
 * The tags: k("algovault.call-ledger.v1/pre_trade_check/verdict") and k("algovault.call-ledger.v1/pre_trade_check/odds"),
 * as the contract prints them — literals, checked against the contract's preimages by the vector test. No tag
 * string is a prefix of another (contract § Encoding).
 */
export const TAG_VERDICT: Hex = '0x86ac3703d2f057fa83293b28fc876f702f6fca45a41947100e933fac1655e899';
export const TAG_ODDS: Hex = '0x4d5c95f32d3afdfdb54aee2ea46ee94043fcd233b6bd7c20b670d3a7fd37cf7d';

/** A fresh ledger id: 16 CSPRNG bytes. */
export function mintCallLedgerId(): string {
  return `pcl_${randomBytes(16).toString('hex')}`;
}

/** A fresh odds salt: 32 CSPRNG bytes, stored on the odds leaf's row and never served. */
export function mintOddsSalt(): Hex {
  return `0x${randomBytes(32).toString('hex')}`;
}

// ── Records ─────────────────────────────────────────────────────────────────────────────────────

/** One rule as the verdict commits it: the served row's id, source and result, nothing else. */
export interface VerdictRuleV1 {
  id: string;
  source: string;
  result: string;
}

/** Verdict record v1 — every key always present (null when absent). */
export interface VerdictRecordV1 {
  v: 1;
  tool: typeof CALL_LEDGER_TOOL;
  id: string;
  as_of: string;
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
  venue: string | null;
  rule_version: number;
  rules: VerdictRuleV1[];
}

/** Odds record v1 — the check row's W4 values (logged, never served). */
export interface OddsRecordV1 {
  v: 1;
  id: string;
  odds_version: string;
  p_timeout: number | null;
  p_target_first: number | null;
  p_stop_first: number | null;
  p_liq_hold: number | null;
}

/** What the verdict record reads from a served response — structural, so this module imports no tool. */
export interface ServedVerdictSource {
  as_of: string;
  coin: string;
  side: string;
  size_usd: number;
  hold_hours: number;
  timeframe: string;
  inputs: { order_type: string; leverage: number | null; stop_pct: number | null; target_pct: number | null };
  decision: string;
  best_venue: { exchange: string } | null;
  rule_version: number;
  rules: readonly { id: string; source: string; result: string }[];
}

/** The verdict record of a response AS SERVED: `venue` is `best_venue.exchange`, `rules` keep served order. */
export function verdictRecordFromResponse(r: ServedVerdictSource, id: string): VerdictRecordV1 {
  return {
    v: 1,
    tool: CALL_LEDGER_TOOL,
    id,
    as_of: r.as_of,
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
    venue: r.best_venue ? r.best_venue.exchange : null,
    rule_version: r.rule_version,
    rules: r.rules.map((x) => ({ id: x.id, source: x.source, result: x.result })),
  };
}

/**
 * A `pre_trade_checks` row as a driver returns it (node-pg in production, PGlite in tests): `checked_at` a
 * Date (or its ISO text), every DOUBLE PRECISION a number, `rules` the JSONB array (or its text).
 */
export interface CheckRowLedgerSource {
  ledger_id: string | null;
  checked_at: Date | string;
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
  rule_version: number;
  rules: unknown;
  odds_version: string | null;
  p_timeout: number | null;
  p_target_first: number | null;
  p_stop_first: number | null;
  p_liq_hold: number | null;
}

/** `checked_at` as ISO 8601 UTC with milliseconds and `Z` — the served `as_of`'s own form. Throws when unreadable. */
export function isoMs(v: Date | string): string {
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`call-ledger: unreadable timestamp ${String(v).slice(0, 40)}`);
  return new Date(ms).toISOString();
}

function ledgerIdOf(row: { ledger_id: string | null }): string {
  if (typeof row.ledger_id !== 'string' || !CALL_LEDGER_ID_RE.test(row.ledger_id)) {
    throw new Error(`call-ledger: row carries no ledger id (${String(row.ledger_id).slice(0, 40)})`);
  }
  return row.ledger_id;
}

function rulesOf(raw: unknown): VerdictRuleV1[] {
  const arr = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(arr)) throw new Error('call-ledger: rules is not an array');
  return arr.map((x: { id: string; source: string; result: string }) => ({ id: x.id, source: x.source, result: x.result }));
}

/** The verdict record rebuilt from the stored check row — the recheck's input, never the stored leaf. */
export function verdictRecordFromRow(row: CheckRowLedgerSource): VerdictRecordV1 {
  return {
    v: 1,
    tool: CALL_LEDGER_TOOL,
    id: ledgerIdOf(row),
    as_of: isoMs(row.checked_at),
    coin: row.coin,
    side: row.side,
    size_usd: row.size_usd,
    hold_hours: row.hold_hours,
    timeframe: row.timeframe,
    order_type: row.order_type,
    leverage: row.leverage,
    stop_pct: row.stop_pct,
    target_pct: row.target_pct,
    decision: row.decision,
    venue: row.decision_venue,
    rule_version: row.rule_version,
    rules: rulesOf(row.rules),
  };
}

/** The odds record rebuilt from the stored check row's W4 values. */
export function oddsRecordFromRow(row: CheckRowLedgerSource): OddsRecordV1 {
  if (typeof row.odds_version !== 'string') throw new Error('call-ledger: row carries no odds_version');
  return {
    v: 1,
    id: ledgerIdOf(row),
    odds_version: row.odds_version,
    p_timeout: row.p_timeout,
    p_target_first: row.p_target_first,
    p_stop_first: row.p_stop_first,
    p_liq_hold: row.p_liq_hold,
  };
}

// ── Encoding ────────────────────────────────────────────────────────────────────────────────────

/**
 * RFC 8785 (JCS) for the JSON values a record holds. Keys sort by UTF-16 code units (the default `sort`);
 * numbers print as ECMAScript prints them (`JSON.stringify`: `10000`, `0.00004000320025602048`, `-0` → `0`);
 * strings as `JSON.stringify` escapes them; no whitespace. THROWS on a non-finite number, `undefined`, a
 * function or any other non-JSON value — a record names every key, null when absent, never an omission.
 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`JCS: non-finite number ${String(value)}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((x) => jcs(x)).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new Error('JCS: not a plain object');
      const obj = value as Record<string, unknown>;
      return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`JCS: unsupported value of type ${typeof value}`);
  }
}

/** k(JCS(record)) — the verdict's `record_hash`, the odds' `odds_hash`. */
export function recordHash(record: VerdictRecordV1 | OddsRecordV1): Hex {
  return keccak256(stringToBytes(jcs(record)));
}

/** k(k(TAG_VERDICT ‖ record_hash)). */
export function verdictLeaf(record: VerdictRecordV1): Hex {
  return keccak256(keccak256(concat([TAG_VERDICT, recordHash(record)])));
}

/** k(k(TAG_ODDS ‖ k(salt ‖ odds_hash))). THROWS unless the salt is 32 bytes of lowercase hex. */
export function oddsLeaf(record: OddsRecordV1, salt: Hex): Hex {
  if (!BYTES32_HEX_RE.test(salt)) throw new Error('call-ledger: salt must be 0x + 64 lowercase hex');
  return keccak256(keccak256(concat([TAG_ODDS, keccak256(concat([salt, recordHash(record)]))])));
}

// ── The receipt ─────────────────────────────────────────────────────────────────────────────────

/** The served `ledger` block: the id, the verdict leaf, and where to verify it. */
export interface CallLedgerReceipt {
  id: string;
  leaf: Hex;
  verify: string;
}

/** The receipt of a verdict record. */
export function receiptOf(record: VerdictRecordV1): CallLedgerReceipt {
  return { id: record.id, leaf: verdictLeaf(record), verify: `${VERIFY_CHECK_URI_PREFIX}${record.id}` };
}
