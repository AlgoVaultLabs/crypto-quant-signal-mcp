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
    ip_hash TEXT
  );
`;

// C6 (algovault-skills SKILLS-W1): per-Skill attribution.
// Populated when MCP request carries the X-AlgoVault-Skill-Slug header.
// Public surface: src/resources/skills-analytics.ts + landing/analytics/skills.html
const CREATE_SKILL_INVOCATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS skill_invocations (
    id ${process.env.DATABASE_URL ? 'SERIAL' : 'INTEGER'} PRIMARY KEY${process.env.DATABASE_URL ? '' : ' AUTOINCREMENT'},
    timestamp TEXT NOT NULL,
    slug TEXT NOT NULL,
    tool TEXT NOT NULL,
    session_id TEXT,
    user_agent TEXT
  );
`;
const CREATE_SKILL_INVOCATIONS_INDEX_SLUG_SQL = `
  CREATE INDEX IF NOT EXISTS idx_skill_invocations_slug ON skill_invocations(slug);
`;
const CREATE_SKILL_INVOCATIONS_INDEX_TS_SQL = `
  CREATE INDEX IF NOT EXISTS idx_skill_invocations_timestamp ON skill_invocations(timestamp);
`;

export function initAnalytics(): void {
  dbExec(CREATE_TABLE_SQL);
  dbExec(CREATE_SKILL_INVOCATIONS_SQL);
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
}

export function logRequest(entry: LogEntry): void {
  try {
    dbRun(
      `INSERT INTO request_log (timestamp, session_id, tool_name, asset, timeframe, license_tier, response_time_ms, verdict, confidence, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
 */
export function logSkillInvocation(
  slug: string,
  tool: string,
  sessionId?: string,
  userAgent?: string,
): void {
  if (!slug || !tool) return;
  // Light input sanity — reject anything that looks like injection rather than slug.
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/i.test(slug)) return;
  try {
    dbRun(
      `INSERT INTO skill_invocations (timestamp, slug, tool, session_id, user_agent) VALUES (?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      slug.toLowerCase(),
      tool,
      sessionId || null,
      userAgent ? userAgent.slice(0, 200) : null,
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
       GROUP BY slug
       ORDER BY calls_all_time DESC`,
  );
  if (!rows.length) return [];
  // Pull 24h + 7d windows in two extra queries (cheap on indexed table).
  const wk = await dbQuery<{ slug: string; n: string | number }>(
    `SELECT slug, COUNT(*) AS n FROM skill_invocations WHERE timestamp >= ? GROUP BY slug`,
    [weekAgo],
  );
  const dy = await dbQuery<{ slug: string; n: string | number }>(
    `SELECT slug, COUNT(*) AS n FROM skill_invocations WHERE timestamp >= ? GROUP BY slug`,
    [dayAgo],
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

export async function getUsageStats(): Promise<Record<string, unknown>> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

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
    avgResponseTime,
  ] = await Promise.all([
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log'),
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ?', [dayAgo]),
    dbQuery<{ count: string }>('SELECT COUNT(*) as count FROM request_log WHERE timestamp >= ?', [weekAgo]),
    dbQuery<{ tool_name: string; count: string }>('SELECT tool_name, COUNT(*) as count FROM request_log GROUP BY tool_name ORDER BY count DESC'),
    dbQuery<{ license_tier: string; count: string }>('SELECT license_tier, COUNT(*) as count FROM request_log GROUP BY license_tier ORDER BY count DESC'),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL', [dayAgo]),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE timestamp >= ? AND session_id IS NOT NULL', [weekAgo]),
    dbQuery<{ count: string }>('SELECT COUNT(DISTINCT session_id) as count FROM request_log WHERE session_id IS NOT NULL'),
    dbQuery<{ asset: string; count: string }>('SELECT asset, COUNT(*) as count FROM request_log WHERE asset IS NOT NULL GROUP BY asset ORDER BY count DESC LIMIT 10'),
    dbQuery<{ tool_name: string; avg_ms: string }>('SELECT tool_name, AVG(response_time_ms) as avg_ms FROM request_log GROUP BY tool_name'),
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
    topAssets: topAssets.map(r => ({ asset: r.asset, calls: Number(r.count) })),
    avgResponseTimeMs: Object.fromEntries(avgResponseTime.map(r => [r.tool_name, Math.round(Number(r.avg_ms))])),
    generatedAt: new Date().toISOString(),
  };
}
