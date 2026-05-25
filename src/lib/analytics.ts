/**
 * Request analytics — lightweight logging of every MCP tool call.
 * Uses the same DB backend as PerformanceDB (PostgreSQL or SQLite).
 * All logging is fire-and-forget — never blocks tool responses.
 */
import crypto from 'node:crypto';
import { dbExec, dbRun, dbQuery } from './performance-db.js';

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
    is_bot_internal ${process.env.DATABASE_URL ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${process.env.DATABASE_URL ? 'FALSE' : '0'}
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
}

// ── IP hashing ──

export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
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
}

export function logRequest(entry: LogEntry): void {
  try {
    const botInternalValue = entry.isBotInternal
      ? (process.env.DATABASE_URL ? true : 1)
      : (process.env.DATABASE_URL ? false : 0);
    dbRun(
      `INSERT INTO request_log (timestamp, session_id, tool_name, asset, timeframe, license_tier, response_time_ms, verdict, confidence, ip_hash, is_bot_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  ]);

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
    topAssets: topAssets.map(r => ({ asset: r.asset, calls: Number(r.count) })),
    // C1 (LATENCY-W1): truthful per-tool latency stats. Replaces the misleading
    // single-number `avgResponseTimeMs` (kept as a field per row for context but
    // no longer the headline — the dashboard column is gone).
    toolStats,
    generatedAt: new Date().toISOString(),
  };
}
