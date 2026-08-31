/**
 * Request analytics — lightweight logging of every MCP tool call.
 * Uses the same DB backend as PerformanceDB (PostgreSQL or SQLite).
 * All logging is fire-and-forget — never blocks tool responses.
 */
import crypto from 'node:crypto';
import { dbExec, dbRun, dbQuery } from './performance-db.js';
// OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: single-derivation — logRequest reads the
// per-request classifyTraffic verdict from the ALS to stamp `request_log.is_automated`.
// analytics.ts is a leaf (only performance-db + crypto); license.ts does NOT import
// analytics → this edge is a DAG, no import cycle (verified in Plan Mode).
import { getRequestIsAutomated, getRequestUserAgent, getRequestHoldCapture } from './license.js';
import type { RequestHoldCapture } from './license.js';
// OPS-CLIENT-ATTRIBUTION-W1: the ONE UA → client identity map (also drives is_automated
// via traffic-classifier.ts). Imported, never re-derived.
import { classifyClient, normalizeUaForStorage, UNKNOWN_CLIENT } from './client-registry.js';
// OPS-DIGEST-PAID-RAIL-SPLIT-W1: the ONE canonical tier→rail map. Pure leaf (type-only
// import of LicenseTier) → no cycle. The IN-lists below are BUILT from these arrays, so a
// newly-added paid tier cannot drift out of the split.
import { SUBSCRIPTION_TIERS, X402_TIERS } from './payment-rail.js';
// OPS-TOP-IP-FORENSICS-W1: the ONE (tool, verdict) → billing-class derivation. Predicates are
// GENERATED from FEATURE_REGISTRY's quota model, so the digest's idea of "billable" cannot
// drift from the runtime meter.
import { billablePredicate, freeHoldPredicate, unmeteredPredicate } from './call-class.js';

// ── Table creation ──

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS request_log (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    timestamp TEXT NOT NULL,
    session_id TEXT,
    tool_name TEXT NOT NULL,
    asset TEXT,
    timeframe TEXT,
    license_tier TEXT NOT NULL,
    response_time_ms INTEGER NOT NULL,
    verdict TEXT,
    confidence INTEGER,
    ip_hash TEXT,
    is_bot_internal ${process.env.DATABASE_URL ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${process.env.DATABASE_URL ? 'FALSE' : '0'},
    is_automated ${process.env.DATABASE_URL ? 'BOOLEAN NOT NULL' : 'INTEGER NOT NULL'} DEFAULT ${process.env.DATABASE_URL ? 'FALSE' : '0'},
    user_agent TEXT,
    client_name TEXT,
    would_be_side ${process.env.DATABASE_URL ? 'SMALLINT' : 'INTEGER'},
    exchange TEXT,
    regime TEXT,
    price_at_decision ${process.env.DATABASE_URL ? 'DOUBLE PRECISION' : 'REAL'}
  );
`;

// BOT-W1 / D1-C, 2026-05-08: idempotent ALTER for existing deployments where
// request_log was created before is_bot_internal landed.
//
// SQLite 3.49 (verified empirically 2026-05-24 in DASH-EXTERNAL-ONLY-W1-PATCH-A)
// does NOT support `ADD COLUMN IF NOT EXISTS` (despite older CLAUDE.md claim).
// Split per backend: PG uses IF NOT EXISTS (idempotent no-op); SQLite omits it
// (throws "duplicate column" on re-run — caught by the try/catch in initAnalytics).
const ALTER_BOT_INTERNAL_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS is_bot_internal BOOLEAN DEFAULT FALSE;`
  : `ALTER TABLE request_log ADD COLUMN is_bot_internal INTEGER DEFAULT 0;`;

// OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1 (2026-07-03): idempotent ALTER mirroring
// the is_bot_internal pattern. Pre-applied on prod PG via SSH BEFORE this deploy
// (information_schema-guarded) — the code path is a no-op there. Fresh deploys get the
// column at CREATE TABLE; existing deploys (incl. the SQLite test/dev DB) get it here.
// PG: IF NOT EXISTS (idempotent no-op). SQLite: bare (throws "duplicate column" on
// re-run — caught by initAnalytics try/catch). NOT NULL DEFAULT FALSE = every row has a
// concrete verdict (fail-open genuine); matches the live prod column.
const ALTER_AUTOMATED_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS is_automated BOOLEAN NOT NULL DEFAULT FALSE;`
  : `ALTER TABLE request_log ADD COLUMN is_automated INTEGER NOT NULL DEFAULT 0;`;

// OPS-CLIENT-ATTRIBUTION-W1 (2026-07-31): the UA was ALREADY being read (it sets
// `is_automated`) and then discarded, so a heavy caller could be classified but never named —
// OPS-TOP-IP-FORENSICS-W1 tested 30 candidate hashes for its top talker and matched none.
// These two columns close that permanently, at the row that already exists.
//
// Both are NULLABLE with no default: on PG 11+ that is a metadata-only catalog change, so a
// ~41k-rows/7d table is NOT rewritten. Pre-applied on prod PG via SSH BEFORE this deploy
// (information_schema-guarded) — the code path is a no-op there.
// PG: IF NOT EXISTS (idempotent). SQLite: bare — it has NO `ADD COLUMN IF NOT EXISTS`
// (verified 3.49, DASH-EXTERNAL-ONLY-W1-PATCH-A), so re-runs throw "duplicate column" and are
// caught by initAnalytics's try/catch, exactly like the two ALTERs above.
//
// PII: a User-Agent is not an address. No IP, no other header, nothing from Authorization; the
// stored value is truncated to MAX_UA_LEN.
const ALTER_USER_AGENT_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS user_agent TEXT;`
  : `ALTER TABLE request_log ADD COLUMN user_agent TEXT;`;
const ALTER_CLIENT_NAME_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS client_name TEXT;`
  : `ALTER TABLE request_log ADD COLUMN client_name TEXT;`;

// OPS-HOLD-DECISION-CAPTURE-W1 (2026-08-26): the four fields that make a HOLD reconstructible.
// Same shape as the four ALTERs above, for the same reasons — PG gets IF NOT EXISTS (idempotent
// no-op against the prod DB, where migration 032 pre-applied them via SSH before this deploy);
// SQLite gets a bare ALTER and throws "duplicate column" on re-run, caught by initAnalytics.
//
// THEY LIVE HERE, NOT IN performance-db.ts's SIGNAL_MIGRATIONS, and that is not a style choice.
// `request_log` is created by THIS file; `SIGNAL_MIGRATIONS` runs during performance-db init,
// which happens FIRST. Rows for `request_log` there ALTER a table that does not exist yet, the
// throw aborts the rest of DB init, and `request_log` is then never created at all — measured
// 2026-08-26 as 173 failures across 41 test files, every one of them reporting
// "no such table: request_log" rather than anything resembling the actual cause. Add a column
// where its table is owned.
//
// All four are NULLABLE with no default. On PG 11+ that is a metadata-only catalog change, so a
// ~355k-row table is not rewritten. A default would also be WRONG independently of cost: these
// columns are populated only on captured HOLDs, and NULL has to keep meaning "not a captured
// HOLD" rather than a fabricated side, venue or price on every other row and on all history.
const ALTER_WOULD_BE_SIDE_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS would_be_side SMALLINT;`
  : `ALTER TABLE request_log ADD COLUMN would_be_side INTEGER;`;
const ALTER_HOLD_EXCHANGE_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS exchange TEXT;`
  : `ALTER TABLE request_log ADD COLUMN exchange TEXT;`;
const ALTER_HOLD_REGIME_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS regime TEXT;`
  : `ALTER TABLE request_log ADD COLUMN regime TEXT;`;
const ALTER_PRICE_AT_DECISION_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS price_at_decision DOUBLE PRECISION;`
  : `ALTER TABLE request_log ADD COLUMN price_at_decision REAL;`;

// DASH-EXTERNAL-ONLY-W1, 2026-05-24: partial index for external-only reads.
// Speeds the 24h/7d/all-time tiles in getUsageStats() + getToolLatencyStats(),
// which all carry `WHERE is_bot_internal = FALSE` + time-window. Partial index
// stays small (~6% of rows at install — 980/15130 external/total). Index name
// matches the AC3 verification probe (`\di idx_request_log_external_ts`).
const CREATE_REQUEST_LOG_EXTERNAL_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_request_log_external_ts ON request_log(timestamp) WHERE is_bot_internal = ${process.env.DATABASE_URL ? 'FALSE' : '0'};
`;

// C6 (algovault-skills SKILLS-W1): per-Skill attribution.
// Populated when MCP request carries the X-AlgoVault-Skill-Slug header.
// Public surface: src/resources/skills-analytics.ts + landing/analytics/skills.html
//
// DASH-EXTERNAL-ONLY-W1-PATCH-A (2026-05-24): is_bot_internal column added at
// table creation. Defense-in-depth alongside the write-side gate at the /mcp
// middleware (src/index.ts ~L1769) which short-circuits the entire
// logSkillInvocation call when license.tier === 'internal'. Either layer alone
// would prevent leak; both together is belt + suspenders.
const CREATE_SKILL_INVOCATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS skill_invocations (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    timestamp TEXT NOT NULL,
    slug TEXT NOT NULL,
    tool TEXT NOT NULL,
    session_id TEXT,
    user_agent TEXT,
    is_bot_internal ${process.env.DATABASE_URL ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${process.env.DATABASE_URL ? 'FALSE' : '0'}
  );
`;
// DASH-EXTERNAL-ONLY-W1-PATCH-A: idempotent ALTER for existing deployments
// where skill_invocations was created pre-W1-PATCH-A. Mirrors the W1
// is_bot_internal pattern on request_log.
//
// SQLite 3.49 (verified empirically 2026-05-24) does NOT support
// `ADD COLUMN IF NOT EXISTS` despite CLAUDE.md claim of "SQLite 3.35+
// supports it". Split per backend: PG uses IF NOT EXISTS (idempotent;
// no-op on re-run); SQLite omits IF NOT EXISTS (throws "duplicate
// column" if already added — caught by the try/catch in initAnalytics).
const ALTER_SKILL_INVOCATIONS_BOT_INTERNAL_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE skill_invocations ADD COLUMN IF NOT EXISTS is_bot_internal BOOLEAN DEFAULT FALSE;`
  : `ALTER TABLE skill_invocations ADD COLUMN is_bot_internal INTEGER DEFAULT 0;`;
const CREATE_SKILL_INVOCATIONS_INDEX_SLUG_SQL = `
  CREATE INDEX IF NOT EXISTS idx_skill_invocations_slug ON skill_invocations(slug);
`;
const CREATE_SKILL_INVOCATIONS_INDEX_TS_SQL = `
  CREATE INDEX IF NOT EXISTS idx_skill_invocations_timestamp ON skill_invocations(timestamp);
`;

// OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1 (2026-07-06): the algovault-bot daily metric bridge
// (Option A). Written by algovault-bot's digest.py (single-derivation, least-priv role);
// READ here for the main digest's 🔁 TG bot line. Pre-applied on prod PG via SSH BEFORE this
// deploy → this CREATE IF NOT EXISTS is a no-op there (schema-as-code parity). The SQLite
// variant lets unit tests / stdio init create the table so getUsageStats() never throws on a
// fresh DB (empty table → tgBot null → renderer omits the line).
// OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1: widen an EXISTING bot_daily_metrics.
//
// The CREATE above only ever builds a FRESH database — `CREATE TABLE IF NOT EXISTS` no-ops against
// prod, where this table has existed since OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1. That is why the six
// columns added since then each needed a hand-run ALTER over SSH (see the exec site's comment,
// "Pre-applied on prod PG via SSH"): the code declared them, but nothing in the code could ADD
// them to the live table. This follows the ALTER pattern this file already uses for request_log,
// so the column reaches prod the same way it reaches a fresh DB — no SSH step.
const ALTER_BOT_DEPLOYED_SHA_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS deployed_sha TEXT;`
  : `ALTER TABLE bot_daily_metrics ADD COLUMN deployed_sha TEXT;`;

const CREATE_BOT_DAILY_METRICS_SQL = process.env.DATABASE_URL
  ? `CREATE TABLE IF NOT EXISTS bot_daily_metrics (
      metric_date DATE PRIMARY KEY,
      calls_total INTEGER NOT NULL DEFAULT 0,
      calls_watch INTEGER NOT NULL DEFAULT 0,
      calls_scanwatch INTEGER NOT NULL DEFAULT 0,
      calls_scan INTEGER NOT NULL DEFAULT 0,
      alerts_regime INTEGER NOT NULL DEFAULT 0,
      subscribers INTEGER NOT NULL DEFAULT 0,
      new_subscribers_24h INTEGER NOT NULL DEFAULT 0,
      blocked_subscribers INTEGER NOT NULL DEFAULT 0,
      watchlist_entries INTEGER NOT NULL DEFAULT 0,
      quota_exhausted_notices INTEGER NOT NULL DEFAULT 0,
      -- OPS-DIGEST-TGBOT-TIER-AND-WALLED-W1 (2026-08-16)
      calls_paid_linked INTEGER NOT NULL DEFAULT 0,
      walled_now INTEGER NOT NULL DEFAULT 0,
      walled_silent INTEGER NOT NULL DEFAULT 0,
      -- PRICING-BOT-DELIVERY-METERING-W1 CH6e
      plan_units_debited INTEGER NOT NULL DEFAULT 0,
      outbox_pending INTEGER NOT NULL DEFAULT 0,
      walled_paid_now INTEGER NOT NULL DEFAULT 0,
      -- OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1: the commit the BOT was deployed from.
      -- The only NULLABLE column here, deliberately. Every other column is a count where 0
      -- is a true measurement; this one is a fact about the deploy where absence IS the
      -- finding, and NULL is how the drift canary tells "no provenance recorded" apart
      -- from "deployed from commit X". A DEFAULT would erase exactly that distinction.
      deployed_sha TEXT,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`
  : `CREATE TABLE IF NOT EXISTS bot_daily_metrics (
      metric_date TEXT PRIMARY KEY,
      calls_total INTEGER NOT NULL DEFAULT 0,
      calls_watch INTEGER NOT NULL DEFAULT 0,
      calls_scanwatch INTEGER NOT NULL DEFAULT 0,
      calls_scan INTEGER NOT NULL DEFAULT 0,
      alerts_regime INTEGER NOT NULL DEFAULT 0,
      subscribers INTEGER NOT NULL DEFAULT 0,
      new_subscribers_24h INTEGER NOT NULL DEFAULT 0,
      blocked_subscribers INTEGER NOT NULL DEFAULT 0,
      watchlist_entries INTEGER NOT NULL DEFAULT 0,
      quota_exhausted_notices INTEGER NOT NULL DEFAULT 0,
      -- OPS-DIGEST-TGBOT-TIER-AND-WALLED-W1 (2026-08-16)
      calls_paid_linked INTEGER NOT NULL DEFAULT 0,
      walled_now INTEGER NOT NULL DEFAULT 0,
      walled_silent INTEGER NOT NULL DEFAULT 0,
      -- PRICING-BOT-DELIVERY-METERING-W1 CH6e
      plan_units_debited INTEGER NOT NULL DEFAULT 0,
      outbox_pending INTEGER NOT NULL DEFAULT 0,
      walled_paid_now INTEGER NOT NULL DEFAULT 0,
      -- OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1: the commit the BOT was deployed from.
      -- The only NULLABLE column here, deliberately. Every other column is a count where 0
      -- is a true measurement; this one is a fact about the deploy where absence IS the
      -- finding, and NULL is how the drift canary tells "no provenance recorded" apart
      -- from "deployed from commit X". A DEFAULT would erase exactly that distinction.
      deployed_sha TEXT,
      generated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`;

/** Staleness threshold for the bridged bot metric: a skipped 03:00 bot digest ages the row
 * to ~29h by the 08:00 main digest → past this ⇒ render "metrics stale" not a frozen number. */
export const TG_BOT_STALE_MS = 26 * 60 * 60 * 1000;

/** Epoch ms from generated_at whatever shape the driver hands back: the node-postgres
 * driver parses TIMESTAMPTZ to a JS `Date`; SQLite/tests give a string; be liberal. */
function toEpochMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  const direct = Date.parse(s); // handles ISO 8601 + JS Date.toString()
  if (Number.isFinite(direct)) return direct;
  // Fallback: raw PG timestamptz text ("2026-07-06 14:31:39.6+00") — space sep + minute-less offset.
  return Date.parse(s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
}

/** Normalize a value that may be a JS Date (pg driver) or string to a clean stamp. */
function stampStr(v: unknown, dateOnly: boolean): string {
  if (v instanceof Date) return dateOnly ? v.toISOString().slice(0, 10) : v.toISOString();
  return String(v ?? '');
}

/** Pure: map the latest bot_daily_metrics row → the `tgBot` payload the digest renderer reads.
 * null row → null (renderer omits the line); unparseable/aged generated_at → stale=true. */
export function deriveTgBot(
  row:
    | {
        calls_total?: unknown;
        calls_watch?: unknown;
        calls_scanwatch?: unknown;
        calls_scan?: unknown;
        subscribers?: unknown;
        calls_paid_linked?: unknown;
        walled_now?: unknown;
        walled_silent?: unknown;
        plan_units_debited?: unknown;
        outbox_pending?: unknown;
        walled_paid_now?: unknown;
        metric_date?: unknown;
        generated_at?: unknown;
      }
    | undefined,
  nowMs: number,
): Record<string, unknown> | null {
  if (!row) return null;
  const genMs = toEpochMs(row.generated_at);
  const stale = !Number.isFinite(genMs) || nowMs - genMs > TG_BOT_STALE_MS;
  return {
    present: true,
    stale,
    calls_total: Number(row.calls_total ?? 0),
    calls_watch: Number(row.calls_watch ?? 0),
    calls_scanwatch: Number(row.calls_scanwatch ?? 0),
    calls_scan: Number(row.calls_scan ?? 0),
    subscribers: Number(row.subscribers ?? 0),
    // OPS-DIGEST-TGBOT-TIER-AND-WALLED-W1. `?? 0` is WRONG for these three: a bridge row
    // written by a bot that predates the widened upsert has no value, and 0 would render as
    // the confident claim "no paying subscriber used the bot" / "nobody is walled". Absent
    // stays absent, and the renderer omits the annotation rather than asserting a zero.
    ...(row.calls_paid_linked === undefined || row.calls_paid_linked === null
      ? {}
      : { calls_paid_linked: Number(row.calls_paid_linked) }),
    ...(row.walled_now === undefined || row.walled_now === null
      ? {}
      : { walled_now: Number(row.walled_now) }),
    ...(row.walled_silent === undefined || row.walled_silent === null
      ? {}
      : { walled_silent: Number(row.walled_silent) }),
    // CH6e — same absent-is-not-zero discipline: a bot predating the widened upsert has no value,
    // and `?? 0` would render "nothing queued" as a confident fact about a missing measurement.
    ...(row.plan_units_debited === undefined || row.plan_units_debited === null
      ? {}
      : { plan_units_debited: Number(row.plan_units_debited) }),
    ...(row.outbox_pending === undefined || row.outbox_pending === null
      ? {}
      : { outbox_pending: Number(row.outbox_pending) }),
    ...(row.walled_paid_now === undefined || row.walled_paid_now === null
      ? {}
      : { walled_paid_now: Number(row.walled_paid_now) }),
    metric_date: stampStr(row.metric_date, true),
    generated_at: stampStr(row.generated_at, false),
  };
}

export function initAnalytics(): void {
  dbExec(CREATE_TABLE_SQL);
  // BOT-W1 / D1-C: backward-compat migration for request_log (is_bot_internal).
  try {
    dbExec(ALTER_BOT_INTERNAL_SQL);
  } catch {
    // Older PG (<9.6) / SQLite (<3.35) — column may already exist or syntax
    // differs. Best-effort; the column has DEFAULT 0/FALSE so old rows remain
    // queryable.
  }
  // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: backward-compat is_automated column
  // (pre-applied on prod PG via SSH → no-op here; SQLite dev/test gets it now).
  try {
    dbExec(ALTER_AUTOMATED_SQL);
  } catch {
    // Best-effort — column may already exist (PG IF NOT EXISTS no-ops; SQLite
    // "duplicate column" caught here). DEFAULT FALSE keeps old rows queryable.
  }
  // OPS-CLIENT-ATTRIBUTION-W1: durable client attribution (user_agent + client_name).
  // Separate try/catch per column so a SQLite "duplicate column" on the first does not
  // skip the second — they were added in one wave but are independent statements.
  try {
    dbExec(ALTER_USER_AGENT_SQL);
  } catch {
    // Best-effort — column may already exist (PG IF NOT EXISTS no-ops; SQLite throws).
  }
  try {
    dbExec(ALTER_CLIENT_NAME_SQL);
  } catch {
    // Best-effort — see above. Both columns are nullable, so old rows stay queryable.
  }
  // OPS-HOLD-DECISION-CAPTURE-W1: the HOLD capture columns. One try/catch EACH, for the reason
  // stated above the pair before them — a SQLite "duplicate column" on an earlier statement must
  // not skip the later ones. Four independent columns, four independent attempts.
  for (const sql of [ALTER_WOULD_BE_SIDE_SQL, ALTER_HOLD_EXCHANGE_SQL, ALTER_HOLD_REGIME_SQL, ALTER_PRICE_AT_DECISION_SQL]) {
    try {
      dbExec(sql);
    } catch {
      // Best-effort — column may already exist (PG IF NOT EXISTS no-ops; SQLite throws).
    }
  }
  // DASH-EXTERNAL-ONLY-W1: partial index on (timestamp) WHERE NOT is_bot_internal.
  // Idempotent CREATE INDEX IF NOT EXISTS; safe to fire on fresh deploy + existing PG.
  try {
    dbExec(CREATE_REQUEST_LOG_EXTERNAL_INDEX_SQL);
  } catch {
    // Best-effort — partial indexes are PG-only on older SQLite; the query
    // planner falls back to seq scan on the read path, no correctness loss.
  }
  dbExec(CREATE_SKILL_INVOCATIONS_SQL);
  // DASH-EXTERNAL-ONLY-W1-PATCH-A: idempotent is_bot_internal column on
  // skill_invocations for existing deployments. Best-effort try/catch matches
  // the request_log shape above.
  try {
    dbExec(ALTER_SKILL_INVOCATIONS_BOT_INTERNAL_SQL);
  } catch {
    // Older PG (<9.6) / SQLite (<3.35) — column may already exist or syntax
    // differs. Best-effort; column has DEFAULT 0/FALSE so old rows remain
    // queryable.
  }
  dbExec(CREATE_SKILL_INVOCATIONS_INDEX_SLUG_SQL);
  dbExec(CREATE_SKILL_INVOCATIONS_INDEX_TS_SQL);
  // OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1: bot_daily_metrics (bot writes, main digest reads).
  // Pre-applied on prod PG via SSH → no-op there; SQLite dev/test gets it now. Best-effort.
  try {
    dbExec(CREATE_BOT_DAILY_METRICS_SQL);
  } catch {
    // Best-effort — table may already exist (PG IF NOT EXISTS no-ops); a failure here must
    // not break analytics init (the read path treats a missing table as "tgBot null" anyway).
  }
  // Separate try/catch: a SQLite "duplicate column" here must not be swallowed by the CREATE's
  // catch, and vice versa.
  try {
    dbExec(ALTER_BOT_DEPLOYED_SHA_SQL);
  } catch {
    // Best-effort — PG IF NOT EXISTS no-ops; SQLite throws when the column is already there.
  }
}

// ── IP pseudonymisation (keyed + versioned) ─────────────────────────────────────────────────────
//
// OPS-SEC-IPHASH-SALT-W1. This was `sha256(ip)[0:16]` — UNKEYED, so a stored `ip_hash` was
// reversible by brute force in seconds: the input space is ~2^32 for a full IPv4 and only ~2^24 for
// the /24-masked value we actually hash (Cloudflare masks CF-Connecting-IP upstream). An unkeyed
// hash over a tiny input space is not a pseudonym, it is an encoding — so the analytics and quota
// tables were effectively an address store, and any read path onto them a de-anonymisation dataset.
//
// Now HMAC-SHA256 under a server-side key held only in the host `.env` (mode 600). HMAC rather than
// `sha256(salt + ip)` because HMAC is the purpose-built keyed-hash primitive.
//
// VERSIONING is the durable half of the fix. Every value carries its derivation version inline, so
// the pre/post boundary is LEGIBLE instead of two incompatible namespaces silently sharing a
// column. Historical `v1` values are never re-hashed — they cannot be, the input IP is gone, which
// is exactly the property we wanted. A future rotation bumps the tag and becomes a non-event.
//
// The prefix rides in the VALUE rather than a sibling column because the highest-value consumers are
// keys, not rows: `quota_usage.tracker_key` (`free:<hash>`), `chat_usage_monthly.api_key`
// (`ip:<hash>`) and `agent_sessions.session_id` have nowhere to put a sibling column. It also keeps
// the PQL cross-table join intact: `SUBSTR('free:v2:<hash>', 6)` = `v2:<hash>`, which still matches
// `request_log.ip_hash` exactly.

/** Current pseudonym derivation version. Bump ONLY together with a key rotation. */
export const IP_HASH_VERSION = 'v2';

const IP_HASH_KEY_ENV = 'ALGOVAULT_IP_HASH_KEY';

/**
 * Values that look like a key but are not one. A placeholder that silently "works" would emit
 * v2-labelled pseudonyms under a guessable key — worse than v1, because the label would assert a
 * protection that does not exist.
 */
const PLACEHOLDER_KEYS = new Set([
  'changeme', 'change-me', 'placeholder', 'todo', 'replace-me', 'secret', 'key',
  'your-key-here', 'xxx', 'test', 'dev',
]);

/** Thrown at HTTP boot, or on use, when the key is absent or obviously not a real key. */
export class IpHashKeyError extends Error {
  readonly code = 'IP_HASH_KEY_MISSING';
  constructor(detail: string) {
    super(
      `${IP_HASH_KEY_ENV} ${detail}. IP pseudonymisation is keyed (OPS-SEC-IPHASH-SALT-W1) and has ` +
      'NO unkeyed fallback by design — a fallback would silently write reversible v1-shaped values ' +
      'under a v2 label. Generate one with `openssl rand -hex 32` and add it to the host .env ' +
      '(mode 600) BEFORE deploying. See docs/RUNBOOK-IPHASH-ROTATION.md.',
    );
    this.name = 'IpHashKeyError';
  }
}

/**
 * The ONE place the key is resolved and validated (single-derivation rule). Throws rather than
 * returning a fallback — see IpHashKeyError.
 */
export function resolveIpHashKey(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[IP_HASH_KEY_ENV];
  if (raw === undefined || raw === null) throw new IpHashKeyError('is not set');
  const key = raw.trim();
  if (!key) throw new IpHashKeyError('is empty');
  if (PLACEHOLDER_KEYS.has(key.toLowerCase())) throw new IpHashKeyError(`is the placeholder "${key}"`);
  if (key.length < 32) throw new IpHashKeyError(`is only ${key.length} chars (need >= 32; use \`openssl rand -hex 32\`)`);
  return key;
}

/**
 * Assert the key is usable. Called at HTTP-transport boot so a mis-sequenced deploy fails LOUDLY and
 * IMMEDIATELY, rather than lazily on the first request that would have written a bucket.
 *
 * Deliberately NOT called in stdio mode: every `hashIp` call site takes an Express `req`, so the
 * stdio/npx path never reaches it, and requiring a key there would break every published
 * `npx crypto-quant-signal-mcp` install for a protection those users are not exposed to.
 */
export function assertIpHashKeyConfigured(env: NodeJS.ProcessEnv = process.env): void {
  resolveIpHashKey(env);
}

/**
 * Keyed, version-tagged pseudonym for an IP-derived value. Output: `v2:<16 hex>`.
 *
 * Never returns an unkeyed value — it throws instead. Do NOT catch-and-default this: a defaulted
 * pseudonym is the reversible bug wearing the new label.
 */
export function hashIp(ip: string): string {
  const key = resolveIpHashKey();
  const mac = crypto.createHmac('sha256', key).update(ip).digest('hex').slice(0, 16);
  return `${IP_HASH_VERSION}:${mac}`;
}

/** Strip the version prefix — for display/truncation only, never for storage or joins. */
export function stripIpHashVersion(value: string | null | undefined): string {
  if (!value) return '';
  const i = value.indexOf(':');
  return i === -1 ? value : value.slice(i + 1);
}

// ── Logging (fire-and-forget) ──

interface LogEntry {
  sessionId?: string;
  toolName: string;
  asset?: string;
  timeframe?: string;
  licenseTier: string;
  responseTimeMs: number;
  verdict?: string;
  confidence?: number;
  ipHash?: string;
  // BOT-W1 / D1-C: true when the request matched the X-AlgoVault-Internal-Key
  // bypass header. Preserved for analytics attribution — bot calls don't tick
  // the user quota counter, but we still want to count them by tool.
  isBotInternal?: boolean;
  // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: the per-request classifyTraffic
  // verdict. Optional — when omitted, logRequest reads it from the ALS
  // (getRequestIsAutomated), so the 12 existing call sites need no change.
  isAutomated?: boolean;
  // OPS-CLIENT-ATTRIBUTION-W1: raw User-Agent. Optional — when omitted, read from the
  // ALS (getRequestUserAgent), so existing call sites need no change. Truncated and
  // classified inside logRequest so BOTH derived values come from one place.
  userAgent?: string | null;
  // OPS-HOLD-DECISION-CAPTURE-W1: the four fields that make a HOLD reconstructible. Optional —
  // when omitted, logRequest reads them from the ALS (getRequestHoldCapture), so the existing
  // call sites need no change, exactly as with isAutomated/userAgent above.
  //
  // Stamped INSIDE the engine rather than threaded down from the handler, because the field that
  // matters cannot be observed from outside it: `deriveVerdict` takes `Math.abs(rawScore)` at
  // `get-trade-call.ts:273`, so by the time a handler sees the result the would-be side is gone.
  // `exchange` and `regime` COULD have been read off `route`/`result` at the call site, and are
  // deliberately not — taking all four from one stamp is what guarantees they describe the same
  // decision rather than merely the same request.
  holdCapture?: RequestHoldCapture;

  // OPS-HL-INTERACTIVE-STARVATION-W1: `regime` and `exchange` as EXPLICIT entry fields, for tools
  // that know both at the call site and are not `get_trade_call` HOLD captures.
  //
  // These share the two `request_log` columns with `holdCapture`, and that is deliberate rather
  // than a collision: the columns describe the row, not the wave that added them. They must NOT be
  // routed through `holdCapture`, whose contract is "NULL means this row is not a captured HOLD" —
  // stamping a `get_market_regime` row into it would silently enrol regime calls in the
  // hold-decision population that `hold-decision-capture.ts` and the directional labeler select.
  //
  // Precedence below is `entry ?? hold ?? null`, so `get_trade_call` — which passes neither — is
  // byte-identical to before, and no existing call site changes.
  regime?: string | null;
  exchange?: string | null;
}

export function logRequest(entry: LogEntry): void {
  try {
    const botInternalValue = entry.isBotInternal
      ? (process.env.DATABASE_URL ? true : 1)
      : (process.env.DATABASE_URL ? false : 0);
    // Single-derivation: prefer an explicit entry value, else the ALS verdict
    // computed once at the POST/x402 layer. Fail-open FALSE (never inflate the
    // automated bucket) via getRequestIsAutomated's own default.
    const isAutomated = entry.isAutomated ?? getRequestIsAutomated();
    const automatedValue = isAutomated
      ? (process.env.DATABASE_URL ? true : 1)
      : (process.env.DATABASE_URL ? false : 0);
    // OPS-CLIENT-ATTRIBUTION-W1: same single-derivation shape as isAutomated — an explicit
    // entry value wins, else the ALS value stamped once at the POST layer. Both stored
    // values derive from the ONE client registry, so the raw UA and the normalized name can
    // never disagree about what a client is.
    const rawUa = entry.userAgent ?? getRequestUserAgent();
    const uaValue = normalizeUaForStorage(rawUa);
    const clientNameValue = uaValue === null ? UNKNOWN_CLIENT : classifyClient(rawUa).name;
    // OPS-HOLD-DECISION-CAPTURE-W1: same single-derivation shape as isAutomated/userAgent above —
    // an explicit entry value wins, else the stamp the engine left in the ALS. `undefined` on
    // every non-HOLD request, which is why all four columns are nullable: NULL here means "this
    // row is not a captured HOLD", never "capture failed".
    //
    // THIS IS THE READER the license.ts seam is required to have. If this line goes, delete the
    // seam in the same commit — `tests/unit/hold-decision-capture.test.ts` fails if it does not.
    const hold = entry.holdCapture ?? getRequestHoldCapture();
    dbRun(
      `INSERT INTO request_log (timestamp, session_id, tool_name, asset, timeframe, license_tier, response_time_ms, verdict, confidence, ip_hash, is_bot_internal, is_automated, user_agent, client_name, would_be_side, exchange, regime, price_at_decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      entry.sessionId || null,
      entry.toolName,
      entry.asset || null,
      entry.timeframe || null,
      entry.licenseTier,
      entry.responseTimeMs,
      entry.verdict || null,
      entry.confidence ?? null,
      entry.ipHash || null,
      botInternalValue,
      automatedValue,
      uaValue,
      clientNameValue,
      hold?.wouldBeSide ?? null,
      // OPS-HL-INTERACTIVE-STARVATION-W1: explicit entry value wins, else the HOLD stamp — the same
      // single-derivation precedence as isAutomated/userAgent/holdCapture above. `get_trade_call`
      // passes neither, so its rows are unchanged.
      entry.exchange ?? hold?.exchange ?? null,
      entry.regime ?? hold?.regime ?? null,
      hold?.priceAtDecision ?? null,
    );
  } catch {
    // Never fail the request — logging is best-effort
  }
}

// ── C6 — per-Skill attribution (algovault-skills SKILLS-W1) ──

/**
 * Fire-and-forget log of a Skill invocation.
 * Called from index.ts /mcp POST handler when X-AlgoVault-Skill-Slug header is present.
 * Slug values are caller-supplied — store as-is, query side does aggregation.
 *
 * DASH-EXTERNAL-ONLY-W1-PATCH-A (2026-05-24): `isBotInternal` optional param
 * (default false) populates the column for defense-in-depth alongside the
 * write-side gate at /mcp middleware. In practice today, the /mcp middleware
 * short-circuits the entire call when license.tier === 'internal', so this
 * param will only land TRUE if a future code path bypasses the gate.
 */
export function logSkillInvocation(
  slug: string,
  tool: string,
  sessionId?: string,
  userAgent?: string,
  isBotInternal?: boolean,
): void {
  if (!slug || !tool) return;
  // Light input sanity — reject anything that looks like injection rather than slug.
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(slug)) return;
  const botInternalValue = isBotInternal
    ? (process.env.DATABASE_URL ? true : 1)
    : (process.env.DATABASE_URL ? false : 0);
  try {
    dbRun(
      `INSERT INTO skill_invocations (timestamp, slug, tool, session_id, user_agent, is_bot_internal) VALUES (?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      slug.toLowerCase(),
      tool,
      sessionId || null,
      userAgent ? userAgent.slice(0, 200) : null,
      botInternalValue,
    );
  } catch {
    // Never fail the request — logging is best-effort.
  }
}

/**
 * Aggregate per-slug counts: calls_24h, calls_7d, first_seen, last_seen.
 * Public-safe — slug-level totals only, no user data.
 */
export async function getSkillInvocationStats(): Promise<Array<{
  slug: string;
  calls_24h: number;
  calls_7d: number;
  calls_all_time: number;
  first_seen: string | null;
  last_seen: string | null;
}>> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  // DASH-EXTERNAL-ONLY-W1-PATCH-A: external-only filter mirrors getUsageStats.
  // Cross-DB boolean encoding matches logRequest at line 96-98 / logSkillInvocation.
  const BOT_FALSE = process.env.DATABASE_URL ? false : 0;
  const rows = await dbQuery<{
    slug: string;
    calls_all_time: string | number;
    first_seen: string;
    last_seen: string;
  }>(
    `SELECT slug,
            COUNT(*) AS calls_all_time,
            MIN(timestamp) AS first_seen,
            MAX(timestamp) AS last_seen
       FROM skill_invocations
       WHERE is_bot_internal = ?
       GROUP BY slug
       ORDER BY calls_all_time DESC`,
    [BOT_FALSE],
  );
  if (!rows.length) return [];
  // Pull 24h + 7d windows in two extra queries (cheap on indexed table).
  const wk = await dbQuery<{ slug: string; n: string | number }>(
    `SELECT slug, COUNT(*) AS n FROM skill_invocations WHERE timestamp >= ? AND is_bot_internal = ? GROUP BY slug`,
    [weekAgo, BOT_FALSE],
  );
  const dy = await dbQuery<{ slug: string; n: string | number }>(
    `SELECT slug, COUNT(*) AS n FROM skill_invocations WHERE timestamp >= ? AND is_bot_internal = ? GROUP BY slug`,
    [dayAgo, BOT_FALSE],
  );
  const wkMap = new Map(wk.map(r => [r.slug, Number(r.n)]));
  const dyMap = new Map(dy.map(r => [r.slug, Number(r.n)]));
  return rows.map(r => ({
    slug: r.slug,
    calls_24h: dyMap.get(r.slug) ?? 0,
    calls_7d: wkMap.get(r.slug) ?? 0,
    calls_all_time: Number(r.calls_all_time),
    first_seen: r.first_seen ?? null,
    last_seen: r.last_seen ?? null,
  }));
}

// ── Usage stats (for resource + admin endpoint) ──

/**
 * Compute a percentile from a SORTED-ASCENDING numeric array using linear interpolation
 * (NumPy / pandas default — matches `numpy.percentile(arr, q*100)` for q in [0,1]).
 *
 * Why linear interpolation (not nearest-rank): for arr=[100,200,...,1000] (n=10),
 * p50=550 (between 500 and 600), p95=955 (between 900 and 1000). These are the
 * values the spec's AC1.3 asserts (≈550, ≈950). Nearest-rank would give 500/1000.
 *
 * Returns null for empty input.
 */
export function percentile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  if (q <= 0) return sortedAsc[0];
  if (q >= 1) return sortedAsc[sortedAsc.length - 1];
  const pos = q * (sortedAsc.length - 1);  // 0-indexed continuous position
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/**
 * Per-tool latency stats over a configurable window (default last 7d).
 * Application-layer percentile computation — Postgres + SQLite portable
 * (PERCENTILE_CONT WITHIN GROUP is Postgres-only).
 *
 * Hard cap of 100K rows per tool query — plenty for any sensible window;
 * if a future tool blows past it, paginate then.
 *
 * `insufficient_data: true` flag when n < 5 → percentile cells render '—'.
 */
export interface ToolLatencyStats {
  tool_name: string;
  n: number;
  p50_ms: number | null;
  p95_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  avg_ms: number | null;       // kept for context; no longer headline
  insufficient_data: boolean;  // true iff n < 5
}

export async function getToolLatencyStats(
  windowMs: number = 7 * 86_400_000,
  opts?: { externalOnly?: boolean },
): Promise<ToolLatencyStats[]> {
  const since = new Date(Date.now() - windowMs).toISOString();
  // DASH-EXTERNAL-ONLY-W1: default external-only; opts.externalOnly=false keeps
  // backward-compat seam for any future caller that wants both. Cross-DB boolean
  // encoding mirrors logRequest at line 96-98.
  const externalOnly = opts?.externalOnly ?? true;
  const BOT_FALSE = process.env.DATABASE_URL ? false : 0;
  // Pull (tool_name, response_time_ms) rows ordered ascending so per-tool slices
  // are already sorted — saves a per-tool sort pass.
  const rows = externalOnly
    ? await dbQuery<{ tool_name: string; response_time_ms: number }>(
        'SELECT tool_name, response_time_ms FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? ORDER BY tool_name ASC, response_time_ms ASC LIMIT 100000',
        [since, BOT_FALSE],
      )
    : await dbQuery<{ tool_name: string; response_time_ms: number }>(
        'SELECT tool_name, response_time_ms FROM request_log WHERE timestamp >= ? ORDER BY tool_name ASC, response_time_ms ASC LIMIT 100000',
        [since],
      );
  // Bucket per tool (rows are already sorted by tool_name then ms — single pass).
  const byTool = new Map<string, number[]>();
  for (const r of rows) {
    const ms = Number(r.response_time_ms);
    if (!Number.isFinite(ms) || ms < 0) continue;
    let arr = byTool.get(r.tool_name);
    if (!arr) { arr = []; byTool.set(r.tool_name, arr); }
    arr.push(ms);
  }
  const out: ToolLatencyStats[] = [];
  for (const [tool_name, sorted] of byTool) {
    const n = sorted.length;
    const insufficient = n < 5;
    const sum = n > 0 ? sorted.reduce((s, v) => s + v, 0) : 0;
    out.push({
      tool_name,
      n,
      p50_ms: insufficient ? null : Math.round(percentile(sorted, 0.50) ?? 0),
      p95_ms: insufficient ? null : Math.round(percentile(sorted, 0.95) ?? 0),
      min_ms: n > 0 ? sorted[0] : null,
      max_ms: n > 0 ? sorted[n - 1] : null,
      avg_ms: n > 0 ? Math.round(sum / n) : null,
      insufficient_data: insufficient,
    });
  }
  // Sort: lowest p95 first (best-performing on top), insufficient_data last.
  out.sort((a, b) => {
    if (a.insufficient_data !== b.insufficient_data) return a.insufficient_data ? 1 : -1;
    return (a.p95_ms ?? Infinity) - (b.p95_ms ?? Infinity);
  });
  return out;
}

export async function getUsageStats(): Promise<Record<string, unknown>> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  // Cross-DB boolean encoding (matches logRequest at line 96-98).
  // PG: native BOOLEAN; SQLite: INTEGER 0/1.
  const BOT_TRUE = process.env.DATABASE_URL ? true : 1;
  const BOT_FALSE = process.env.DATABASE_URL ? false : 0;

  // OPS-DIGEST-PAID-RAIL-SPLIT-W1: placeholder lists generated from the canonical rail map
  // (never a hand-written IN-list that could drift from PAYMENT_RAIL_BY_TIER).
  const subTierPlaceholders = SUBSCRIPTION_TIERS.map(() => '?').join(',');
  const x402TierPlaceholders = X402_TIERS.map(() => '?').join(',');

  // OPS-TOP-IP-FORENSICS-W1: call-class predicates, generated from the canonical quota model.
  // A null predicate (a class with no tools) collapses to a constant-false guard rather than an
  // `IN ()` syntax error — the count then honestly reads 0 instead of the query throwing.
  const FALSE_PRED = { sql: '1 = 0', params: [] as string[] };
  const billable = billablePredicate() ?? FALSE_PRED;
  const freeHold = freeHoldPredicate() ?? FALSE_PRED;
  const unmetered = unmeteredPredicate() ?? FALSE_PRED;

  const [
    total,
    last24h,
    last7d,
    byTool,
    byTier,
    uniqueSessions24h,
    uniqueSessions7d,
    uniqueSessionsAll,
    topAssets,
    toolStats,
    externalCalls24h,
    internalCalls24h,
    externalSessions24h,
    // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1
    genuineFree24h,
    genuinePaid24h,
    automatedFree24h,
    genuineSessions24h,
    automatedSessions24h,
    genuineFree7d,
    genuinePaid7d,
    automatedFree7d,
    topSessions24h,
    topAssetsGenuine24h,
    // OPS-DIGEST-CHANNEL-LABELS-W1: per-channel distinct sessions + Raw-bucket concentration.
    recognizedSessions24h,
    paidSessions24h,
    rawTopSessions24h,
    // OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1: the bot's latest daily metric (Option A bridge).
    botDailyMetrics,
    // OPS-DIGEST-PAID-RAIL-SPLIT-W1: the 💳 Paid bucket split BY PAYMENT RAIL.
    paidSubscription24h,
    paidX40224h,
    paidSubscriptionSessions24h,
    paidX402Sessions24h,
    // OPS-TOP-IP-FORENSICS-W1: the billable/free-HOLD/unmetered decomposition.
    billableCalls24h,
    freeHoldCalls24h,
    unmeteredCalls24h,
    billableSessions24h,
    billableCalls7d,
    freeHoldCalls7d,
  ] = await Promise.all([
    // DASH-EXTERNAL-ONLY-W1: every dashboard tile / breakdown counts EXTERNAL
    // calls only (internal loopback like algovault-bot excluded). Per CLAUDE.md
    // "Fix at the generator, not the lane" — filter cascades from these 9
    // queries into all consumers (/dashboard, /analytics, analytics-summary
    // MCP resource). Additive externalCalls24h / internalCalls24h /
    // externalSessions24h fields below preserve the split for callers that
    // need it (monitor.ts daily digest).
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE is_bot_internal = ?', [BOT_FALSE]),
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ?', [dayAgo, BOT_FALSE]),
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ?', [weekAgo, BOT_FALSE]),
    dbQuery<{ tool_name: string; count: string }>('SELECT tool_name, COUNT(*) as count FROM request_log WHERE is_bot_internal = ? GROUP BY tool_name ORDER BY count DESC', [BOT_FALSE]),
    dbQuery<{ license_tier: string; count: string }>('SELECT license_tier, COUNT(*) as count FROM request_log WHERE is_bot_internal = ? GROUP BY license_tier ORDER BY count DESC', [BOT_FALSE]),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ?', [dayAgo, BOT_FALSE]),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ?', [weekAgo, BOT_FALSE]),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE session_id IS NOT NULL AND is_bot_internal = ?', [BOT_FALSE]),
    // Top assets — 24h window so the digest reflects today's activity, not all-time.
    dbQuery<{ asset: string; count: string }>('SELECT asset, COUNT(*) as count FROM request_log WHERE asset IS NOT NULL AND timestamp >= ? AND is_bot_internal = ? GROUP BY asset ORDER BY count DESC LIMIT 10', [dayAgo, BOT_FALSE]),
    getToolLatencyStats(),  // last 7d window, app-layer percentiles; external-only by default (DASH-EXTERNAL-ONLY-W1)
    // External vs internal split — driven by is_bot_internal column (BOT-W1 / D1-C).
    // Used by monitor.ts daily digest to distinguish algovault-bot self-traffic from
    // organic external MCP-client traffic. Preserved as additive fields even though
    // the main tiles are now external-only (DASH-EXTERNAL-ONLY-W1).
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ?', [dayAgo, BOT_FALSE]),
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ?', [dayAgo, BOT_TRUE]),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ?', [dayAgo, BOT_FALSE]),
    // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: genuine vs automated split.
    // Payment = legitimacy → PAID (license_tier NOT IN 'free','internal') is ALWAYS
    // genuine, is_automated IGNORED; the automated bucket is FREE-tier bots ONLY.
    // Every external row (is_bot_internal=false) is exactly one of: paid[genuine] ·
    // free-nonbot[genuine] · free-bot[automated] → sums reconcile with externalCalls,
    // no double-count. Cross-DB boolean encoding reuses BOT_TRUE/BOT_FALSE (is_automated
    // is the same BOOLEAN/INTEGER type as is_bot_internal).
    dbQuery<{ count: string }>("SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ?", [dayAgo, BOT_FALSE, BOT_FALSE]),
    dbQuery<{ count: string }>("SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier NOT IN ('free','internal')", [dayAgo, BOT_FALSE]),
    dbQuery<{ count: string }>("SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ?", [dayAgo, BOT_FALSE, BOT_TRUE]),
    dbQuery<{ count: string }>("SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND (license_tier <> 'free' OR is_automated = ?)", [dayAgo, BOT_FALSE, BOT_FALSE]),
    dbQuery<{ count: string }>("SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ?", [dayAgo, BOT_FALSE, BOT_TRUE]),
    dbQuery<{ count: string }>("SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ?", [weekAgo, BOT_FALSE, BOT_FALSE]),
    dbQuery<{ count: string }>("SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier NOT IN ('free','internal')", [weekAgo, BOT_FALSE]),
    dbQuery<{ count: string }>("SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ?", [weekAgo, BOT_FALSE, BOT_TRUE]),
    // Concentration surge-flag: top session_id share of ALL external (genuine+automated) 24h.
    dbQuery<{ session_id: string; count: string }>("SELECT session_id, COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND session_id IS NOT NULL GROUP BY session_id ORDER BY count DESC LIMIT 5", [dayAgo, BOT_FALSE]),
    // Top assets over the GENUINE slice only (so bot-BTC-polling doesn't dominate).
    dbQuery<{ asset: string; count: string }>("SELECT asset, COUNT(*) as count FROM request_log WHERE asset IS NOT NULL AND timestamp >= ? AND is_bot_internal = ? AND (license_tier <> 'free' OR is_automated = ?) GROUP BY asset ORDER BY count DESC LIMIT 10", [dayAgo, BOT_FALSE, BOT_FALSE]),
    // OPS-DIGEST-CHANNEL-LABELS-W1: per-channel distinct sessions (24h) for the digest
    // Sessions block. Recognized clients = genuine free-tier sessions (is_automated=false);
    // Paid = distinct sessions on any non-free non-internal tier. (Raw-client sessions
    // already = externalAutomated.sessions.)
    dbQuery<{ count: string }>("SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ?", [dayAgo, BOT_FALSE, BOT_FALSE]),
    dbQuery<{ count: string }>("SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND license_tier NOT IN ('free','internal')", [dayAgo, BOT_FALSE]),
    // Concentration re-scoped to the Raw API clients bucket (free-tier automated) — where a
    // poller surge actually shows; the prior all-external scope (externalConcentration, kept
    // for back-compat) diluted it. Denominator = the raw bucket total (automatedFree24h).
    dbQuery<{ session_id: string; count: string }>("SELECT session_id, COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier = 'free' AND is_automated = ? AND session_id IS NOT NULL GROUP BY session_id ORDER BY count DESC LIMIT 5", [dayAgo, BOT_FALSE, BOT_TRUE]),
    // OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1: latest bot daily metric row (portable columns only —
    // freshness computed in JS via deriveTgBot, so the query stays PG/SQLite-agnostic).
    dbQuery<{
      metric_date: string;
      calls_total: string;
      calls_watch: string;
      calls_scanwatch: string;
      calls_scan: string;
      subscribers: string;
      generated_at: string;
    }>('SELECT metric_date, calls_total, calls_watch, calls_scanwatch, calls_scan, subscribers, calls_paid_linked, walled_now, walled_silent, plan_units_debited, outbox_pending, walled_paid_now, generated_at FROM bot_daily_metrics ORDER BY metric_date DESC LIMIT 1', []),
    // OPS-DIGEST-PAID-RAIL-SPLIT-W1: 💳 Paid split by payment RAIL, so the digest stops
    // labelling Stripe-subscription traffic as "x402 / a2mcp". Same window + same
    // is_bot_internal filter as `genuinePaid24h`, so the two rails sum to `paid` unless a
    // paid tier is unclassified — which the renderer surfaces as `other N`, never drops.
    // Base x402 and OKX a2mcp both resolve to tier='x402' and are NOT separable here.
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier IN (${subTierPlaceholders})`, [dayAgo, BOT_FALSE, ...SUBSCRIPTION_TIERS]),
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND license_tier IN (${x402TierPlaceholders})`, [dayAgo, BOT_FALSE, ...X402_TIERS]),
    dbQuery<{ count: string }>(`SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND license_tier IN (${subTierPlaceholders})`, [dayAgo, BOT_FALSE, ...SUBSCRIPTION_TIERS]),
    dbQuery<{ count: string }>(`SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND license_tier IN (${x402TierPlaceholders})`, [dayAgo, BOT_FALSE, ...X402_TIERS]),
    // OPS-TOP-IP-FORENSICS-W1: billable / free-by-design-HOLD / unmetered over the EXTERNAL
    // slice (same is_bot_internal=false scope as externalCalls24h, so the three classes plus
    // `unclassified` reconcile to it exactly). `internal` is already carried by
    // totalCallsInternal — it is not re-counted here.
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND ${billable.sql}`, [dayAgo, BOT_FALSE, ...billable.params]),
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND ${freeHold.sql}`, [dayAgo, BOT_FALSE, ...freeHold.params]),
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND ${unmetered.sql}`, [dayAgo, BOT_FALSE, ...unmetered.params]),
    dbQuery<{ count: string }>(`SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL AND is_bot_internal = ? AND ${billable.sql}`, [dayAgo, BOT_FALSE, ...billable.params]),
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND ${billable.sql}`, [weekAgo, BOT_FALSE, ...billable.params]),
    dbQuery<{ count: string }>(`SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ? AND is_bot_internal = ? AND ${freeHold.sql}`, [weekAgo, BOT_FALSE, ...freeHold.params]),
  ]);

  // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: concentration % of the top talkers
  // over ALL external calls (the surge flag). Denominator = total external 24h.
  const extTotal24h = Number(externalCalls24h[0]?.count ?? 0);
  const topSessionCounts = topSessions24h.map(r => Number(r.count));
  const top1Calls = topSessionCounts[0] ?? 0;
  const top5Calls = topSessionCounts.slice(0, 5).reduce((s, v) => s + v, 0);
  const pctOfExternal = (n: number): number =>
    extTotal24h > 0 ? Math.round((n / extTotal24h) * 1000) / 10 : 0;
  const genuineFreeN = Number(genuineFree24h[0]?.count ?? 0);
  const genuinePaidN = Number(genuinePaid24h[0]?.count ?? 0);
  // OPS-DIGEST-CHANNEL-LABELS-W1: concentration over the Raw API clients bucket only
  // (free-tier automated) — denominator = that bucket's call total, not all-external.
  const rawTotal24h = Number(automatedFree24h[0]?.count ?? 0);
  const rawTopCounts = rawTopSessions24h.map(r => Number(r.count));
  const rawTop1 = rawTopCounts[0] ?? 0;
  const rawTop5 = rawTopCounts.slice(0, 5).reduce((s, v) => s + v, 0);
  const pctOfRaw = (n: number): number =>
    rawTotal24h > 0 ? Math.round((n / rawTotal24h) * 1000) / 10 : 0;

  return {
    totalCalls: {
      allTime: Number(total[0]?.count ?? 0),
      last24h: Number(last24h[0]?.count ?? 0),
      last7d: Number(last7d[0]?.count ?? 0),
    },
    byTool: Object.fromEntries(byTool.map(r => [r.tool_name, Number(r.count)])),
    byTier: Object.fromEntries(byTier.map(r => [r.license_tier, Number(r.count)])),
    uniqueSessions: {
      allTime: Number(uniqueSessionsAll[0]?.count ?? 0),
      last24h: Number(uniqueSessions24h[0]?.count ?? 0),
      last7d: Number(uniqueSessions7d[0]?.count ?? 0),
    },
    // External / internal split — additive fields, last24h only (digest scope).
    // Existing totalCalls/uniqueSessions remain unchanged (include both) for
    // backward compat with the admin /dashboard and the paywalled
    // analytics-summary MCP resource.
    totalCallsExternal: { last24h: Number(externalCalls24h[0]?.count ?? 0) },
    totalCallsInternal: { last24h: Number(internalCalls24h[0]?.count ?? 0) },
    uniqueSessionsExternal: { last24h: Number(externalSessions24h[0]?.count ?? 0) },
    // OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: the genuine-vs-automated split.
    // Payment = legitimacy → paid always genuine; automated = free-tier bots only.
    // Invariant: externalGenuine.total + externalAutomated.total == totalCallsExternal.last24h.
    externalGenuine: {
      total: genuineFreeN + genuinePaidN,
      free: genuineFreeN,
      paid: genuinePaidN,
      sessions: Number(genuineSessions24h[0]?.count ?? 0),
      // OPS-DIGEST-CHANNEL-LABELS-W1: per-channel session counts for the digest Sessions
      // block. freeSessions = 🟢 Recognized clients; paidSessions = 💳 Paid. (`sessions`
      // stays = genuine-total for back-compat.)
      freeSessions: Number(recognizedSessions24h[0]?.count ?? 0),
      paidSessions: Number(paidSessions24h[0]?.count ?? 0),
      // OPS-DIGEST-PAID-RAIL-SPLIT-W1: ADDITIVE per-rail split of `paid`/`paidSessions`
      // (the aggregates above are unchanged — add before you remove, per Data Integrity).
      // Invariant: paidSubscription + paidX402 <= paid; any shortfall is an unclassified
      // paid tier and renders as `other N` in the digest.
      paidSubscription: Number(paidSubscription24h[0]?.count ?? 0),
      paidX402: Number(paidX40224h[0]?.count ?? 0),
      paidSubscriptionSessions: Number(paidSubscriptionSessions24h[0]?.count ?? 0),
      paidX402Sessions: Number(paidX402Sessions24h[0]?.count ?? 0),
      last7d: {
        total: Number(genuineFree7d[0]?.count ?? 0) + Number(genuinePaid7d[0]?.count ?? 0),
        free: Number(genuineFree7d[0]?.count ?? 0),
        paid: Number(genuinePaid7d[0]?.count ?? 0),
      },
    },
    externalAutomated: {
      total: Number(automatedFree24h[0]?.count ?? 0),
      sessions: Number(automatedSessions24h[0]?.count ?? 0),
      last7d: { total: Number(automatedFree7d[0]?.count ?? 0) },
    },
    // OPS-TOP-IP-FORENSICS-W1: ADDITIVE call-class decomposition of the external slice. The
    // pre-existing totals above are UNCHANGED (add before you remove, per Data Integrity) —
    // this is a new lens on the same rows, not a replacement series.
    //
    // Invariant: billable + freeHold + unmetered + unclassified == totalCallsExternal.last24h.
    // `unclassified` is computed as the REMAINDER rather than queried, so a tool_name with no
    // registry entry (a retired tool's historical rows) can never silently vanish — it shows up
    // as a non-zero remainder the digest renders as `other N`. Clamped at 0: the three classes
    // are mutually exclusive by construction, but a negative would be a louder bug than a 0.
    callClasses: (() => {
      const billableN = Number(billableCalls24h[0]?.count ?? 0);
      const freeHoldN = Number(freeHoldCalls24h[0]?.count ?? 0);
      const unmeteredN = Number(unmeteredCalls24h[0]?.count ?? 0);
      return {
        billable: billableN,
        freeHold: freeHoldN,
        unmetered: unmeteredN,
        unclassified: Math.max(0, extTotal24h - billableN - freeHoldN - unmeteredN),
        billableSessions: Number(billableSessions24h[0]?.count ?? 0),
        last7d: {
          billable: Number(billableCalls7d[0]?.count ?? 0),
          freeHold: Number(freeHoldCalls7d[0]?.count ?? 0),
        },
      };
    })(),
    externalConcentration: { top1_pct: pctOfExternal(top1Calls), top5_pct: pctOfExternal(top5Calls) },
    // OPS-DIGEST-CHANNEL-LABELS-W1: concentration scoped to the Raw API clients bucket
    // (the digest's "top IP %" now reads from this, on the 🔌 Raw API clients line).
    rawConcentration: { top1_pct: pctOfRaw(rawTop1), top5_pct: pctOfRaw(rawTop5) },
    // OPS-DIGEST-TGBOT-METRIC-BRIDGE-W1: the bridged 🔁 TG bot line source (fresh/stale/missing
    // resolved here; renderer just projects). null → renderer omits the line (fail-open).
    tgBot: deriveTgBot(botDailyMetrics[0], Date.now()),
    topAssets: topAssets.map(r => ({ asset: r.asset, calls: Number(r.count) })),
    // Genuine-slice top assets — the digest uses THIS (bot-BTC excluded).
    topAssetsGenuine: topAssetsGenuine24h.map(r => ({ asset: r.asset, calls: Number(r.count) })),
    // C1 (LATENCY-W1): truthful per-tool latency stats. Replaces the misleading
    // single-number `avgResponseTimeMs` (kept as a field per row for context but
    // no longer the headline — the dashboard column is gone).
    toolStats,
    generatedAt: new Date().toISOString(),
  };
}
