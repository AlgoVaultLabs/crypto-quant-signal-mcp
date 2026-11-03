/**
 * pre-trade-rule-profiles.ts — DECISION-CALL-V2-W2 CH1. Saved `pre_trade_check` rule profiles: ONE store.
 *
 * A caller with an API key saves a `rules` object once; every check made with that key applies it
 * (`Prompt/pre-trade-check-contract-v2.md` § v2.1). The table is `pre_trade_rule_profiles` (migrations/052): one
 * row per key, keyed by `caller_ref` — the key's `callerRef` pseudonym, the same ref the check log writes for that
 * key — never the key itself.
 *
 *   reader   the pre_trade_check handler (`DEFAULT_PRE_TRADE_CHECK_DEPS.ruleProfile`): a keyed call reads its
 *            profile ONCE, before rule activation. A read error THROWS and the caller decides — the handler
 *            applies no saved rule and adds SAVED_RULES_UNAVAILABLE (adjust), so a keyed call is never GO without
 *            its saved rules.
 *   writer   `/api/pre-trade-rules` (`pre-trade-rules-api.ts`, CH2): PUT replaces the profile, DELETE clears it.
 *   owner    `profileKeyOf(license)` — the one answer to "whose profile is this", for the reader and for the
 *            routes that write: a keyed caller's key; null for a keyless, x402, internal, malformed or
 *            invalid-token caller. A profile can only belong to a credential that will later read it.
 *
 * A stored value is re-parsed by `parseRules` on every read, so a row the table no longer describes (a rule since
 * retired, a value out of today's bounds) is a read error, never a partial profile; a write is parsed the same way
 * first, so the store never saves what it could not read back.
 *
 * Dual-backend SQL (`?` placeholders, as `webhooks-store.ts`): Postgres in the hosted app, SQLite in a local one.
 * Every statement but the ensure returns rows (`RETURNING` on the writes), so each goes through `dbQuery` and is
 * awaited on both.
 */
import { dbExec, dbQuery } from './performance-db.js';
import { callerRef } from './lifecycle/identity.js';
import { credentialOutcomeOf } from './credential-outcome.js';
import { parseRules, type PreTradeRulesInput } from './pre-trade-rules.js';
import type { LicenseInfo } from '../types.js';

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pre_trade_rule_profiles (
  caller_ref TEXT        PRIMARY KEY,
  rules      JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)`;

/**
 * The lazy ensure (matches migrations/052), once per process, through `dbExec` — the DDL path both backends order:
 * SQLite runs it in place, and Postgres queues it on the DDL barrier that every later read and write waits behind
 * (`PgBackend`, OPS-PG-LANE-BOOTSTRAP-W1), so a process's first concurrent reads issue ONE `CREATE … IF NOT EXISTS`
 * and none of them overtakes it. Never `dbQuery`: on SQLite that is `.all()`, which refuses a statement that returns
 * no rows. An ensure that throws (SQLite) is retried by the next call.
 */
let _ensured = false;
function ensureRuleProfileTable(): void {
  if (_ensured) return;
  dbExec(CREATE_TABLE_SQL);
  _ensured = true;
}

/** Test-only reset of the once-per-process ensure. */
export function _resetRuleProfilesForTest(): void {
  _ensured = false;
}

/** One saved profile, as read. */
export interface PreTradeRuleProfile {
  /** The saved rules, parsed against `PRE_TRADE_RULES`. */
  rules: PreTradeRulesInput;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601: the last save, served as `saved_rules.updated_at`. */
  updatedAt: string;
}

/** `callerRef`'s output shape — the only id the table accepts. */
const REF_RE = /^pc1:[0-9a-f]{32}$/;

function assertRef(ref: string): void {
  if (!REF_RE.test(ref)) throw new Error('pre_trade_rule_profiles is keyed by the callerRef pseudonym, never a raw value');
}

/**
 * The API key whose profile a call reads, and the only one a route may write: the caller's key when it resolved to
 * one of ours (or could not be checked, which keeps the key's identity); null for a keyless, x402 or internal call,
 * and for a credential that cannot be a key we issued or a rejected access token. An allow-list of outcomes.
 */
export function profileKeyOf(license: LicenseInfo): string | null {
  if (!license.key || license.tier === 'x402' || license.tier === 'internal') return null;
  const outcome = credentialOutcomeOf(license);
  return outcome === 'RESOLVED' || outcome === 'INDETERMINATE' ? license.key : null;
}

/** The row id for an API key: its `callerRef` pseudonym (the check log's ref for the same key). Throws without the hash key. */
export function profileRefOf(licenseKey: string): string {
  return callerRef({ licenseKey }) as string;
}

/** An ISO-8601 instant from either backend's timestamp; a value that is not one is a read error. */
function iso(v: unknown): string {
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new Error('pre_trade_rule_profiles row carries an unreadable timestamp');
  return new Date(ms).toISOString();
}

interface ProfileRow { rules: unknown; created_at: unknown; updated_at: unknown }

/** A stored row, re-parsed: jsonb arrives as an object (Postgres) or as text (SQLite). */
function toProfile(row: ProfileRow): PreTradeRuleProfile {
  const raw = typeof row.rules === 'string' ? JSON.parse(row.rules) : row.rules;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pre_trade_rule_profiles row is not a rules object');
  const parsed = parseRules(raw);
  if (!parsed.ok) throw new Error(`pre_trade_rule_profiles row no longer parses: ${parsed.message}`);
  return { rules: parsed.rules, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

/** The profile saved under `ref`, or null when there is none. A read error throws; the caller decides. */
export async function getProfile(ref: string): Promise<PreTradeRuleProfile | null> {
  assertRef(ref);
  ensureRuleProfileTable();
  const rows = await dbQuery<ProfileRow>(
    'SELECT rules, created_at, updated_at FROM pre_trade_rule_profiles WHERE caller_ref = ?',
    [ref],
  );
  return rows.length ? toProfile(rows[0]) : null;
}

/**
 * Save `rules` as the profile under `ref`, replacing any earlier one whole (created_at stays, updated_at moves), and
 * return it as stored. Rules `parseRules` refuses throw before any SQL.
 */
export async function putProfile(ref: string, rules: PreTradeRulesInput, nowMs: number = Date.now()): Promise<PreTradeRuleProfile> {
  assertRef(ref);
  const parsed = parseRules(rules);
  if (!parsed.ok) throw new Error(`pre_trade_rule_profiles refuses rules that do not parse: ${parsed.message}`);
  ensureRuleProfileTable();
  const now = new Date(nowMs).toISOString();
  const rows = await dbQuery<ProfileRow>(
    'INSERT INTO pre_trade_rule_profiles (caller_ref, rules, created_at, updated_at) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (caller_ref) DO UPDATE SET rules = EXCLUDED.rules, updated_at = EXCLUDED.updated_at '
      + 'RETURNING rules, created_at, updated_at',
    [ref, JSON.stringify(parsed.rules), now, now],
  );
  if (rows.length !== 1) throw new Error('pre_trade_rule_profiles upsert returned no row');
  return toProfile(rows[0]);
}

/** Clear the profile under `ref`: true when there was one. */
export async function deleteProfile(ref: string): Promise<boolean> {
  assertRef(ref);
  ensureRuleProfileTable();
  const rows = await dbQuery<{ caller_ref: string }>(
    'DELETE FROM pre_trade_rule_profiles WHERE caller_ref = ? RETURNING caller_ref',
    [ref],
  );
  return rows.length > 0;
}
