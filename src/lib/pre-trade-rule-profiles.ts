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
 *   owner    `profileKeyOf(license)` — the one answer to "whose profile is this", for the reader and for the
 *            routes that write: a keyed caller's key; null for a keyless, x402, internal, malformed or
 *            invalid-token caller. A profile can only belong to a credential that will later read it.
 *
 * A stored value is re-parsed by `parseRules` on every read, so a row the table no longer describes (a rule since
 * retired, a value out of today's bounds) is a read error, never a partial profile.
 *
 * Dual-backend SQL (`?` placeholders, as `webhooks-store.ts`): Postgres in the hosted app, SQLite in a local one.
 */
import { dbQuery } from './performance-db.js';
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
 * The lazy ensure (matches migrations/052), once per process — the `regime-snapshots.ts` pattern, single-flight:
 * every keyed check reads, so a process's first concurrent reads share ONE `CREATE … IF NOT EXISTS` rather than
 * racing two of them (Postgres can fail the loser on its catalog's unique index). A failed ensure is retried by
 * the next call.
 */
let _ensure: Promise<void> | null = null;
function ensureRuleProfileTable(): Promise<void> {
  if (!_ensure) {
    const p = dbQuery(CREATE_TABLE_SQL).then((): void => undefined);
    _ensure = p;
    p.catch(() => { if (_ensure === p) _ensure = null; });
  }
  return _ensure;
}

/** Test-only reset of the once-per-process ensure. */
export function _resetRuleProfilesForTest(): void {
  _ensure = null;
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

/** A stored row, re-parsed: jsonb arrives as an object (Postgres) or as text (SQLite). */
function toProfile(row: { rules: unknown; created_at: unknown; updated_at: unknown }): PreTradeRuleProfile {
  const raw = typeof row.rules === 'string' ? JSON.parse(row.rules) : row.rules;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('pre_trade_rule_profiles row is not a rules object');
  const parsed = parseRules(raw);
  if (!parsed.ok) throw new Error(`pre_trade_rule_profiles row no longer parses: ${parsed.message}`);
  return { rules: parsed.rules, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

/** The profile saved under `ref`, or null when there is none. A read error throws; the caller decides. */
export async function getProfile(ref: string): Promise<PreTradeRuleProfile | null> {
  assertRef(ref);
  await ensureRuleProfileTable();
  const rows = await dbQuery<{ rules: unknown; created_at: unknown; updated_at: unknown }>(
    'SELECT rules, created_at, updated_at FROM pre_trade_rule_profiles WHERE caller_ref = ?',
    [ref],
  );
  return rows.length ? toProfile(rows[0]) : null;
}
