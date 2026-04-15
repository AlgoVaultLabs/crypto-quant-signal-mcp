#!/usr/bin/env npx tsx
/**
 * Activation funnel snapshot query runner.
 *
 * Queries the live performance-db (Postgres in prod, SQLite in dev) via the
 * existing dbQuery helper, assembling a typed FunnelSnapshot JSON for the
 * activation-funnel logbook under activation-funnel/snapshots/.
 *
 * CLI:
 *   npx tsx scripts/funnel-snapshot.ts                       # last 14d, JSON to stdout
 *   npx tsx scripts/funnel-snapshot.ts --days 30             # custom window
 *   npx tsx scripts/funnel-snapshot.ts --since 2026-04-01    # custom start date (ISO)
 *   npx tsx scripts/funnel-snapshot.ts --until 2026-04-15    # custom end date (ISO)
 *
 * Programmatic:
 *   import { generateFunnelSnapshot } from './funnel-snapshot.js';
 *   const snapshot = await generateFunnelSnapshot({ days: 14 });
 *
 * Factual notes:
 *   - `request_log.timestamp` is TEXT (ISO string), NOT a timestamptz column.
 *   - `agent_sessions.first_seen` / `.last_seen` are BIGINT (epoch millis).
 *   - `install` (NPM downloads) is never queryable from the DB — always null.
 *     Future snapshot runs may merge a separate NPM fetch on top.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbQuery, closeDb } from '../src/lib/performance-db.js';

// ── Types ──

export interface FunnelSnapshot {
  generated_at: string; // ISO timestamp
  window: { from: string; to: string }; // ISO, inclusive
  sessions: {
    total: number | null;
    unique_ips: number | null;
    new_in_window: number | null;
  };
  funnel: {
    install: number | null; // NPM — not queryable from DB; always null in v1
    first_call: number | null;
    second_call: number | null;
    fifth_plus_call: number | null;
    paid_upgrade: number | null;
  };
  conversion: {
    install_to_first_call: number | null; // null when install is null
    first_to_second: number | null; // ratio in [0, 1]
    second_to_fifth: number | null;
    fifth_to_paid: number | null;
  };
  stick_rate: number | null; // sessions with call_count >= 2 / total sessions
  time_to_first_call_ms: {
    p50: number | null;
    p90: number | null;
  };
  tool_call_distribution: {
    get_trade_signal: number;
    get_market_regime: number;
    scan_funding_arb: number;
    other: number;
  };
  hold_rate_get_trade_signal: number | null; // 0-1 ratio
  tier_cohort_sizes: {
    free: number;
    starter: number;
    pro: number;
    enterprise: number;
    x402: number;
  };
  warnings: string[]; // non-fatal notes, e.g. "agent_sessions empty — fell back to request_log"
}

export interface SnapshotOptions {
  days?: number; // default 14
  since?: string; // ISO date; overrides `days` if present
  until?: string; // ISO date; default = now
}

// ── Helpers ──

function safeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function safeInt(value: unknown): number | null {
  const n = safeNumber(value);
  return n === null ? null : Math.trunc(n);
}

function ratio(numer: number | null, denom: number | null): number | null {
  if (numer === null || denom === null || denom === 0) return null;
  return numer / denom;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

// ── Main ──

export async function generateFunnelSnapshot(
  opts: SnapshotOptions = {},
): Promise<FunnelSnapshot> {
  const warnings: string[] = [];

  // Window resolution — produce both ISO strings and epoch millis so we can
  // query request_log (TEXT ISO) and agent_sessions (BIGINT millis) correctly.
  const now = new Date();
  const until = opts.until ? new Date(opts.until) : now;
  const from = opts.since
    ? new Date(opts.since)
    : new Date(until.getTime() - (opts.days ?? 14) * 86_400_000);

  if (Number.isNaN(from.getTime())) {
    throw new Error(`Invalid --since date: ${opts.since}`);
  }
  if (Number.isNaN(until.getTime())) {
    throw new Error(`Invalid --until date: ${opts.until}`);
  }

  const windowFromIso = from.toISOString();
  const windowToIso = until.toISOString();
  const windowFromMs = from.getTime();
  const windowToMs = until.getTime();

  // ── Sessions totals (agent_sessions) ──

  let sessionsTotal: number | null = null;
  let uniqueIps: number | null = null;
  let newInWindow: number | null = null;
  try {
    const rows = await dbQuery<{ total: number | string; unique_ips: number | string }>(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT ip_hash_first) AS unique_ips
         FROM agent_sessions
        WHERE first_seen >= ? AND first_seen <= ?`,
      [windowFromMs, windowToMs],
    );
    sessionsTotal = safeInt(rows[0]?.total) ?? 0;
    uniqueIps = safeInt(rows[0]?.unique_ips) ?? 0;
    newInWindow = sessionsTotal; // "new_in_window" is equivalent under the first_seen filter
  } catch (err) {
    warnings.push(
      `agent_sessions totals query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Funnel stages (agent_sessions) ──

  let firstCall: number | null = null;
  let secondCall: number | null = null;
  let fifthPlusCall: number | null = null;
  let paidUpgrade: number | null = null;
  try {
    const rows = await dbQuery<{
      first_call: number | string;
      second_call: number | string;
      fifth_plus_call: number | string;
    }>(
      `SELECT
          SUM(CASE WHEN call_count >= 1 THEN 1 ELSE 0 END) AS first_call,
          SUM(CASE WHEN call_count >= 2 THEN 1 ELSE 0 END) AS second_call,
          SUM(CASE WHEN call_count >= 5 THEN 1 ELSE 0 END) AS fifth_plus_call
        FROM agent_sessions
        WHERE first_seen >= ? AND first_seen <= ?`,
      [windowFromMs, windowToMs],
    );
    firstCall = safeInt(rows[0]?.first_call) ?? 0;
    secondCall = safeInt(rows[0]?.second_call) ?? 0;
    fifthPlusCall = safeInt(rows[0]?.fifth_plus_call) ?? 0;
  } catch (err) {
    warnings.push(
      `agent_sessions funnel query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Fallback: if agent_sessions has zero rows but we have window data,
  // derive first_call from distinct session_ids in request_log.
  if ((firstCall ?? 0) === 0) {
    try {
      const rows = await dbQuery<{ c: number | string }>(
        `SELECT COUNT(DISTINCT session_id) AS c
           FROM request_log
          WHERE timestamp >= ? AND timestamp <= ?`,
        [windowFromIso, windowToIso],
      );
      const fallbackFirst = safeInt(rows[0]?.c) ?? 0;
      if (fallbackFirst > 0) {
        warnings.push(
          'agent_sessions empty for window — fell back to COUNT(DISTINCT session_id) in request_log for first_call',
        );
        firstCall = fallbackFirst;
      }
    } catch (err) {
      warnings.push(
        `request_log first_call fallback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    const rows = await dbQuery<{ c: number | string }>(
      `SELECT COUNT(*) AS c
         FROM agent_sessions
        WHERE first_seen >= ? AND first_seen <= ?
          AND (
            tiers_seen LIKE '%starter%'
            OR tiers_seen LIKE '%pro%'
            OR tiers_seen LIKE '%enterprise%'
            OR tiers_seen LIKE '%x402%'
          )`,
      [windowFromMs, windowToMs],
    );
    paidUpgrade = safeInt(rows[0]?.c) ?? 0;
  } catch (err) {
    warnings.push(
      `agent_sessions paid_upgrade query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Stick rate ──
  // Compute in JS from two integer counts so we don't have to worry about
  // REAL vs NUMERIC casting differences between SQLite and PostgreSQL.
  const stickRate = ratio(secondCall, sessionsTotal);

  // ── Time to (second) call p50 / p90 ──
  // We use (last_seen - first_seen) for sessions with call_count >= 2 as the
  // proxy for "elapsed time before a second call". Sessions with call_count < 2
  // never had a second call — exclude them.
  let p50 = null as number | null;
  let p90 = null as number | null;
  try {
    const rows = await dbQuery<{ delta_ms: number | string }>(
      `SELECT (last_seen - first_seen) AS delta_ms
         FROM agent_sessions
        WHERE first_seen >= ? AND first_seen <= ?
          AND call_count >= 2`,
      [windowFromMs, windowToMs],
    );
    const deltas = rows
      .map((r) => safeNumber(r.delta_ms))
      .filter((n): n is number => n !== null && n >= 0)
      .sort((a, b) => a - b);
    p50 = percentile(deltas, 0.5);
    p90 = percentile(deltas, 0.9);
  } catch (err) {
    warnings.push(
      `agent_sessions time-to-second-call query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Tool call distribution (request_log) ──

  const toolCallDistribution = {
    get_trade_signal: 0,
    get_market_regime: 0,
    scan_funding_arb: 0,
    other: 0,
  };
  try {
    const rows = await dbQuery<{ tool_name: string | null; c: number | string }>(
      `SELECT tool_name, COUNT(*) AS c
         FROM request_log
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY tool_name`,
      [windowFromIso, windowToIso],
    );
    for (const row of rows) {
      const count = safeInt(row.c) ?? 0;
      const name = row.tool_name ?? '';
      if (name === 'get_trade_signal') toolCallDistribution.get_trade_signal += count;
      else if (name === 'get_market_regime') toolCallDistribution.get_market_regime += count;
      else if (name === 'scan_funding_arb') toolCallDistribution.scan_funding_arb += count;
      else toolCallDistribution.other += count;
    }
  } catch (err) {
    warnings.push(
      `request_log tool_call_distribution query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── HOLD rate on get_trade_signal ──

  let holdRateGetTradeSignal: number | null = null;
  try {
    const rows = await dbQuery<{ total: number | string; holds: number | string }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN verdict = 'HOLD' THEN 1 ELSE 0 END) AS holds
         FROM request_log
        WHERE tool_name = 'get_trade_signal'
          AND timestamp >= ? AND timestamp <= ?`,
      [windowFromIso, windowToIso],
    );
    const total = safeInt(rows[0]?.total) ?? 0;
    const holds = safeInt(rows[0]?.holds) ?? 0;
    holdRateGetTradeSignal = total > 0 ? holds / total : null;
  } catch (err) {
    warnings.push(
      `request_log hold_rate query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Tier cohort sizes ──
  // Prefer request_log.license_tier (distinct session_id per tier) because
  // agent_sessions.tiers_seen is a comma-separated blob that would double-count
  // sessions that transitioned tiers.

  const tierCohortSizes = {
    free: 0,
    starter: 0,
    pro: 0,
    enterprise: 0,
    x402: 0,
  };
  try {
    const rows = await dbQuery<{ license_tier: string | null; sessions: number | string }>(
      `SELECT license_tier, COUNT(DISTINCT session_id) AS sessions
         FROM request_log
        WHERE timestamp >= ? AND timestamp <= ?
        GROUP BY license_tier`,
      [windowFromIso, windowToIso],
    );
    for (const row of rows) {
      const sessions = safeInt(row.sessions) ?? 0;
      const tier = (row.license_tier ?? '').toLowerCase();
      if (tier === 'free') tierCohortSizes.free += sessions;
      else if (tier === 'starter') tierCohortSizes.starter += sessions;
      else if (tier === 'pro') tierCohortSizes.pro += sessions;
      else if (tier === 'enterprise') tierCohortSizes.enterprise += sessions;
      else if (tier === 'x402') tierCohortSizes.x402 += sessions;
      else if (tier) {
        warnings.push(`unknown license_tier '${tier}' in request_log — ignored`);
      }
    }
  } catch (err) {
    warnings.push(
      `request_log tier_cohort_sizes query failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Conversion ratios ──
  // install is null in v1, so install_to_first_call is always null.
  const conversion = {
    install_to_first_call: null as number | null,
    first_to_second: ratio(secondCall, firstCall),
    second_to_fifth: ratio(fifthPlusCall, secondCall),
    fifth_to_paid: ratio(paidUpgrade, fifthPlusCall),
  };

  return {
    generated_at: new Date().toISOString(),
    window: { from: windowFromIso, to: windowToIso },
    sessions: {
      total: sessionsTotal,
      unique_ips: uniqueIps,
      new_in_window: newInWindow,
    },
    funnel: {
      install: null,
      first_call: firstCall,
      second_call: secondCall,
      fifth_plus_call: fifthPlusCall,
      paid_upgrade: paidUpgrade,
    },
    conversion,
    stick_rate: stickRate,
    time_to_first_call_ms: { p50, p90 },
    tool_call_distribution: toolCallDistribution,
    hold_rate_get_trade_signal: holdRateGetTradeSignal,
    tier_cohort_sizes: tierCohortSizes,
    warnings,
  };
}

// ── CLI ──

interface CliArgs {
  days?: number;
  since?: string;
  until?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--days' && next !== undefined) {
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --days: ${next}`);
      }
      out.days = n;
      i++;
    } else if (arg === '--since' && next !== undefined) {
      out.since = next;
      i++;
    } else if (arg === '--until' && next !== undefined) {
      out.until = next;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `usage: funnel-snapshot.ts [--days N] [--since YYYY-MM-DD] [--until YYYY-MM-DD]`,
      );
      process.exit(0);
    }
  }
  return out;
}

// Invoked directly? (tsx / node)
// Use fileURLToPath + path.resolve on both sides to survive the macOS
// /private/tmp vs /tmp symlink normalization quirk and URL-encoding differences.
function isMainModule(): boolean {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return path.resolve(thisFile) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = parseCliArgs(process.argv.slice(2));
  generateFunnelSnapshot(args)
    .then((snapshot) => {
      console.log(JSON.stringify(snapshot, null, 2));
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error('funnel-snapshot failed:', err instanceof Error ? err.message : err);
      closeDb();
      process.exit(1);
    });
}
