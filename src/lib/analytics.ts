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

export function initAnalytics(): void {
  dbExec(CREATE_TABLE_SQL);
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
