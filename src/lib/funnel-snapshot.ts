/**
 * Activation funnel snapshot library — generates a typed FunnelSnapshot JSON
 * from live performance-db (Postgres in prod, SQLite in dev) via the existing
 * dbQuery helper. Originally at `scripts/funnel-snapshot.ts` (FUNNEL-ANALYTICS-W1,
 * 2026-04-15); extracted to `src/lib/funnel-snapshot.ts` by
 * ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28) so that the `/api/admin/funnel-snapshot`
 * HTTP endpoint can import the function directly (scripts/ is outside tsc rootDir).
 * Interface preserved verbatim; consumers (scripts/funnel-snapshot.ts CLI +
 * scripts/write-funnel-snapshot.ts) continue to work via the thin CLI wrapper
 * at the old path.
 *
 * Programmatic:
 *   import { generateFunnelSnapshot } from '../src/lib/funnel-snapshot.js';
 *   const snapshot = await generateFunnelSnapshot({ days: 14 });
 *
 * CLI (via thin wrapper):
 *   npx tsx scripts/funnel-snapshot.ts                       # last 14d, JSON to stdout
 *   npx tsx scripts/funnel-snapshot.ts --days 30             # custom window
 *   npx tsx scripts/funnel-snapshot.ts --since 2026-04-01    # custom start date (ISO)
 *   npx tsx scripts/funnel-snapshot.ts --until 2026-04-15    # custom end date (ISO)
 *
 * Factual notes:
 *   - `request_log.timestamp` is TEXT (ISO string), NOT a timestamptz column.
 *   - `agent_sessions.first_seen` / `.last_seen` are BIGINT (epoch millis).
 *   - `install` (NPM downloads) fetched from npm registry API at snapshot time
 *     (ACTIVATION-FUNNEL-AUDIT-W1) — null on network failure.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { dbQuery } from './performance-db.js';

// ── Types ──

/**
 * Canonical 14-stage funnel (ACTIVATION-FUNNEL-AUDIT-W1, 2026-05-28).
 *
 * Original 5-stage shape (install / first_call / second_call / fifth_plus_call /
 * paid_upgrade) is PRESERVED in `funnel` for backward compat with existing
 * `activation-funnel/snapshots/<DATE>-auto.json` history (20+ snapshots since
 * 2026-04-15 baseline). 11 NEW stage fields added alongside.
 *
 * Spec aliases (some stages map to existing fields):
 *   - spec stage 1  `npm_install`              == funnel.install (NPM API fetch)
 *   - spec stage 3  `first_tool_call`          == funnel.first_call
 *   - spec stage 9  `stripe_payment_succeeded` == funnel.paid_upgrade
 *   - second_call + fifth_plus_call are stick-rate proxies (NOT in spec's
 *     14-stage list but kept as retention quality signals).
 *
 * Per Q-C Option α: tg_bot_* stages source from `/var/log/algovault-bot/alerts.log`
 * JSON-line grep + bot SQLite reads for tg_bot_start / tg_bot_watchlist_add
 * (those don't currently emit alerts.log lines).
 *
 * Per Q-D Option β: tg_bot_upgrade_clicked is null this wave; populated by
 * follow-up OPS-FUNNEL-STRIPE-PIXEL-W1 wave (Stripe-side conversion pixel +
 * UTM correlation, OR bot-side inline-button CallbackQueryHandler).
 */
export interface FunnelSnapshot {
  generated_at: string; // ISO timestamp
  window: { from: string; to: string }; // ISO, inclusive
  sessions: {
    total: number | null;
    unique_ips: number | null;
    new_in_window: number | null;
  };
  funnel: {
    // Existing 5 (UNCHANGED — backward compat with snapshot history):
    install: number | null;
    first_call: number | null;
    second_call: number | null;
    fifth_plus_call: number | null;
    paid_upgrade: number | null;
    // NEW 11 (ACTIVATION-FUNNEL-AUDIT-W1, 2026-05-28):
    mcp_tools_list: number | null;          // stage 2: distinct session_id from request_log WHERE tool_name='tools/list'
    quota_hit_soft: number | null;          // stage 4: COUNT from funnel_events WHERE event_type='quota_hit_soft'
    quota_hit_hard: number | null;          // stage 5: COUNT from funnel_events WHERE event_type='quota_hit_hard'
    quota_hit_block: number | null;         // stage 6: COUNT from funnel_events WHERE event_type='quota_hit_block'
    upgrade_cta_clicked: number | null;     // stage 7: COUNT from funnel_events WHERE event_type='upgrade_cta_clicked'
    stripe_checkout_started: number | null; // stage 8: COUNT from processed_stripe_events WHERE event_type='checkout.session.created'
    tg_bot_start: number | null;            // stage 10: COUNT from bot SQLite subscribers WHERE created_at BETWEEN ? AND ?
    tg_bot_first_command: number | null;    // stage 11: alerts.log grep "event": "tg_bot_first_command"
    tg_bot_watchlist_add: number | null;    // stage 12: COUNT(DISTINCT chat_id) from bot SQLite watchlists WHERE created_at BETWEEN ? AND ?
    tg_bot_quota_hit: number | null;        // stage 13: alerts.log grep "event": "tg_bot_quota_hit"
    tg_bot_upgrade_clicked: number | null;  // stage 14: NULL until OPS-FUNNEL-STRIPE-PIXEL-W1 (Q-D Option β defer)
  };
  conversion: {
    install_to_first_call: number | null; // null when install is null
    first_to_second: number | null; // ratio in [0, 1]
    second_to_fifth: number | null;
    fifth_to_paid: number | null;
  };
  /**
   * Per-stage retention (stage_N count / prior_stage count) across the
   * canonical 14-stage funnel. Useful for downstream leak detection (the
   * `weakest_stage_transition` field below identifies the largest drop).
   * Keys are stage names in canonical order. Value is null when prior_stage
   * count is null/zero.
   */
  stage_retentions: Record<string, number | null>;
  /**
   * The single stage-to-stage transition with the lowest retention ratio
   * across the 14-stage funnel. Identifies the leak step. `null` when no
   * adjacent stages have non-null counts.
   */
  weakest_stage_transition: {
    from: string;
    to: string;
    retention: number | null;
  } | null;
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

// ── 14-stage funnel constants (ACTIVATION-FUNNEL-AUDIT-W1, 2026-05-28) ──

/**
 * Canonical funnel stage order. Each entry references a key in
 * `FunnelSnapshot.funnel`. `weakest_stage_transition` walks adjacent
 * pairs of this list to find the lowest retention ratio. Stage 9
 * `paid_upgrade` is the existing alias for Stripe payment-succeeded
 * (kept verbatim for backward compat with snapshot history).
 */
const CANONICAL_STAGE_ORDER: readonly string[] = Object.freeze([
  'install',                  // 1: npm_install (NPM API fetch)
  'mcp_tools_list',           // 2
  'first_call',               // 3: first_tool_call alias
  'quota_hit_soft',           // 4
  'quota_hit_hard',           // 5
  'quota_hit_block',          // 6
  'upgrade_cta_clicked',      // 7
  'stripe_checkout_started',  // 8
  'paid_upgrade',             // 9: stripe_payment_succeeded alias
  'tg_bot_start',             // 10
  'tg_bot_first_command',     // 11
  'tg_bot_watchlist_add',     // 12
  'tg_bot_quota_hit',         // 13
  'tg_bot_upgrade_clicked',   // 14
]);

// Default Hetzner paths; overridable via env for test/dev.
const BOT_SQLITE_PATH = process.env.ALGOVAULT_BOT_DB_PATH ?? '/var/lib/algovault-bot/state.db';
const BOT_ALERTS_LOG_PATH = process.env.ALGOVAULT_BOT_ALERTS_LOG ?? '/var/log/algovault-bot/alerts.log';
const NPM_PACKAGE_NAME = process.env.ALGOVAULT_NPM_PACKAGE_NAME ?? 'crypto-quant-signal-mcp';

// ── New helpers (ACTIVATION-FUNNEL-AUDIT-W1) ──

/**
 * Count DISTINCT session_ids in `funnel_events` table for a given event_type
 * within the window. Used for MCP-side stages (quota_hit_*, upgrade_cta_clicked).
 * Returns null on query failure (warning pushed by caller).
 *
 * Funnel-stage semantics: a session that crosses the 75% quota threshold and
 * makes 25 more calls before being blocked fires 25 `quota_hit_soft` events;
 * we count that as ONE session at stage 4 (DISTINCT). Same for stages 5/6/7.
 * NULL session_ids are excluded by SQL DISTINCT semantics — acceptable
 * because all MCP-side captures (CH3) emit with session_id set.
 */
async function getFunnelEventCount(
  eventType: string,
  windowFromIso: string,
  windowToIso: string,
): Promise<number | null> {
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(DISTINCT session_id) AS c
       FROM funnel_events
      WHERE event_type = ?
        AND ts >= ? AND ts <= ?`,
    [eventType, windowFromIso, windowToIso],
  );
  return safeInt(rows[0]?.c) ?? 0;
}

/**
 * Count rows in `processed_stripe_events` for a given Stripe event_type
 * within the window. `processed_at` is TIMESTAMPTZ on PG and TEXT
 * (ISO) on SQLite — both compare correctly with ISO string parameters.
 */
async function getStripeEventCount(
  stripeEventType: string,
  windowFromIso: string,
  windowToIso: string,
): Promise<number | null> {
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(*) AS c
       FROM processed_stripe_events
      WHERE event_type = ?
        AND processed_at >= ? AND processed_at <= ?`,
    [stripeEventType, windowFromIso, windowToIso],
  );
  return safeInt(rows[0]?.c) ?? 0;
}

/**
 * Count distinct session_ids that invoked `tools/list` within the window.
 * Stage 2 proxy. `request_log.tool_name` for the MCP `tools/list` JSON-RPC
 * method is stored verbatim — confirmed via Plan-Mode P11.
 */
async function getMcpToolsListSessionCount(
  windowFromIso: string,
  windowToIso: string,
): Promise<number | null> {
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(DISTINCT session_id) AS c
       FROM request_log
      WHERE tool_name = 'tools/list'
        AND timestamp >= ? AND timestamp <= ?`,
    [windowFromIso, windowToIso],
  );
  return safeInt(rows[0]?.c) ?? 0;
}

/**
 * Spawn `sqlite3` CLI against the bot's read-only SQLite DB. Used for
 * stages 10 (tg_bot_start = subscribers row created) + 12
 * (tg_bot_watchlist_add = watchlists row created) which don't emit
 * alerts.log lines.
 *
 * Returns null when bot DB is unreachable (typical for local dev — caller
 * pushes a warning). Hetzner production has sqlite3 in `/usr/bin/sqlite3`
 * by default; the bot DB is at `/var/lib/algovault-bot/state.db`.
 */
function readBotSqliteCount(
  table: 'subscribers' | 'watchlists',
  windowFromIso: string,
  windowToIso: string,
  warnings: string[],
): number | null {
  if (!fs.existsSync(BOT_SQLITE_PATH)) {
    warnings.push(`bot SQLite ${BOT_SQLITE_PATH} not found — stage ${table === 'subscribers' ? 'tg_bot_start' : 'tg_bot_watchlist_add'} reports null`);
    return null;
  }
  try {
    // Both tables have `created_at` per bot's db.py schema (subscribers:
    // L36 default datetime('now'); watchlists: assumed same convention).
    // Use distinct counter for watchlists (one row per coin/tf/exchange
    // per user; want distinct chat_ids for funnel cohort sizing).
    const sql = table === 'subscribers'
      ? `SELECT COUNT(*) FROM subscribers WHERE created_at >= '${windowFromIso}' AND created_at <= '${windowToIso}';`
      : `SELECT COUNT(DISTINCT chat_id) FROM watchlists WHERE created_at >= '${windowFromIso}' AND created_at <= '${windowToIso}';`;
    const result = execSync(`sqlite3 -readonly ${BOT_SQLITE_PATH} "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const n = Number(result);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    warnings.push(
      `bot SQLite ${table} count failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Grep `/var/log/algovault-bot/alerts.log` JSON-line entries matching a
 * specific event_type within the window. Used for stages 11
 * (tg_bot_first_command) + 13 (tg_bot_quota_hit) per Q-C Option α —
 * bot's `log_alert_event()` writes structured JSON lines to this file.
 *
 * Returns null when alerts.log is unreachable (typical for local dev).
 *
 * Note: file may be logrotated (8-week / weekly per
 * `/etc/logrotate.d/algovault-bot`); we only grep the active log file
 * — events older than ~1 week may be in rotated .gz files but our
 * default snapshot window is 14 days so we may miss events from days
 * 8-14. Per Q-C Option α tradeoff documented in plan file; acceptable.
 */
function readAlertsLogEventCount(
  eventType: string,
  windowFromIso: string,
  windowToIso: string,
  warnings: string[],
): number | null {
  if (!fs.existsSync(BOT_ALERTS_LOG_PATH)) {
    warnings.push(`bot alerts.log ${BOT_ALERTS_LOG_PATH} not found — stage ${eventType} reports null`);
    return null;
  }
  try {
    const raw = fs.readFileSync(BOT_ALERTS_LOG_PATH, 'utf-8');
    let count = 0;
    // Iterate line-by-line; the existing log_setup.py emits one JSON
    // object per line via `alerts_logger().info(json.dumps(...))`.
    // Each line: '<datestamp> <pid> <levelname> {"ts":"...","event":"...","..."}'
    // OR (depending on log_setup.py formatter): '{"ts":"...","event":"...","..."}'
    // Try to extract a JSON object via { ... } regex anchored on `"event"`.
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.includes(`"event": "${eventType}"`) && !line.includes(`"event":"${eventType}"`)) continue;
      // Try to extract a JSON object from the line for the `ts` field.
      const jsonStart = line.indexOf('{');
      if (jsonStart < 0) continue;
      try {
        const obj = JSON.parse(line.slice(jsonStart));
        const tsStr = typeof obj.ts === 'string' ? obj.ts : null;
        if (!tsStr) continue;
        if (tsStr >= windowFromIso && tsStr <= windowToIso) count += 1;
      } catch {
        continue; // malformed line; skip
      }
    }
    return count;
  } catch (err) {
    warnings.push(
      `alerts.log read for ${eventType} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Fetch NPM download count from registry stats API for the window.
 * Stage 1 (npm_install). Failure-tolerant; returns null on network /
 * parse error + pushes warning. NPM stats API endpoint:
 *   https://api.npmjs.org/downloads/range/YYYY-MM-DD:YYYY-MM-DD/<pkg>
 * Returns: { downloads: [{day: 'YYYY-MM-DD', downloads: N}, ...], package, start, end }
 * We sum the daily counts for the window.
 *
 * NPM dates are inclusive YYYY-MM-DD. We convert ISO timestamps to dates;
 * for sub-day windows (window < 24h), this rounds to nearest day boundary
 * which may slightly over-count vs the exact ISO range. Acceptable for
 * funnel-snapshot use case (weekly cadence).
 */
async function fetchNpmDownloadCount(
  windowFromIso: string,
  windowToIso: string,
  warnings: string[],
): Promise<number | null> {
  try {
    const fromDate = windowFromIso.slice(0, 10); // YYYY-MM-DD
    const toDate = windowToIso.slice(0, 10);
    const url = `https://api.npmjs.org/downloads/range/${fromDate}:${toDate}/${NPM_PACKAGE_NAME}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      warnings.push(`npm registry API returned HTTP ${response.status} for ${NPM_PACKAGE_NAME}`);
      return null;
    }
    const data = (await response.json()) as { downloads?: Array<{ day: string; downloads: number }> };
    if (!data || !Array.isArray(data.downloads)) {
      warnings.push(`npm registry API response missing 'downloads' array for ${NPM_PACKAGE_NAME}`);
      return null;
    }
    let total = 0;
    for (const day of data.downloads) {
      if (typeof day?.downloads === 'number') total += day.downloads;
    }
    return total;
  } catch (err) {
    warnings.push(
      `npm install count fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
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

  // ── Connectivity probe — fail fast if the database is unreachable ──
  // This is intentionally NOT wrapped in try/catch. If Postgres is down
  // (ECONNREFUSED, timeout, auth failure), the throw propagates up to the
  // CLI entry point which exits non-zero. Without this probe, the per-query
  // defensive try/catch blocks below would silently degrade every field to
  // null, and the wrapper would commit an all-null snapshot to origin/main.
  // See status.md R5.2 failure-mode test (2026-04-15 15:23 UTC).
  await dbQuery('SELECT 1');

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

  // ── Conversion ratios (legacy 5-stage; preserved verbatim) ──
  // install is now potentially non-null via npm registry fetch below.
  const conversion = {
    install_to_first_call: null as number | null, // computed AFTER install fetch
    first_to_second: ratio(secondCall, firstCall),
    second_to_fifth: ratio(fifthPlusCall, secondCall),
    fifth_to_paid: ratio(paidUpgrade, fifthPlusCall),
  };

  // ── ACTIVATION-FUNNEL-AUDIT-W1: 11 NEW stage counts ──
  // Each query is failure-tolerant: returns null + pushes warning on error;
  // never throws (would block snapshot commit). Per-stage independence: if
  // one stage fails, others still populate.

  let install: number | null = null;
  try {
    install = await fetchNpmDownloadCount(windowFromIso, windowToIso, warnings);
  } catch (err) {
    warnings.push(`unexpected npm fetch error: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Now that install is potentially non-null, compute install_to_first_call.
  conversion.install_to_first_call = ratio(firstCall, install);

  let mcpToolsList: number | null = null;
  try {
    mcpToolsList = await getMcpToolsListSessionCount(windowFromIso, windowToIso);
  } catch (err) {
    warnings.push(`request_log mcp_tools_list query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let quotaHitSoft: number | null = null;
  let quotaHitHard: number | null = null;
  let quotaHitBlock: number | null = null;
  let upgradeCtaClicked: number | null = null;
  try {
    quotaHitSoft = await getFunnelEventCount('quota_hit_soft', windowFromIso, windowToIso);
    quotaHitHard = await getFunnelEventCount('quota_hit_hard', windowFromIso, windowToIso);
    quotaHitBlock = await getFunnelEventCount('quota_hit_block', windowFromIso, windowToIso);
    upgradeCtaClicked = await getFunnelEventCount('upgrade_cta_clicked', windowFromIso, windowToIso);
  } catch (err) {
    warnings.push(`funnel_events query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let stripeCheckoutStarted: number | null = null;
  try {
    stripeCheckoutStarted = await getStripeEventCount('checkout.session.created', windowFromIso, windowToIso);
  } catch (err) {
    warnings.push(`processed_stripe_events checkout query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Bot-side stages (Q-C Option α: alerts.log + bot SQLite).
  const tgBotStart = readBotSqliteCount('subscribers', windowFromIso, windowToIso, warnings);
  const tgBotFirstCommand = readAlertsLogEventCount('tg_bot_first_command', windowFromIso, windowToIso, warnings);
  const tgBotWatchlistAdd = readBotSqliteCount('watchlists', windowFromIso, windowToIso, warnings);
  const tgBotQuotaHit = readAlertsLogEventCount('tg_bot_quota_hit', windowFromIso, windowToIso, warnings);
  // Stage 14: deferred per Q-D Option β (OPS-FUNNEL-STRIPE-PIXEL-W1 follow-up).
  const tgBotUpgradeClicked: number | null = null;

  // ── Compute stage_retentions + weakest_stage_transition ──

  const funnelCounts: Record<string, number | null> = {
    install,
    mcp_tools_list: mcpToolsList,
    first_call: firstCall,
    quota_hit_soft: quotaHitSoft,
    quota_hit_hard: quotaHitHard,
    quota_hit_block: quotaHitBlock,
    upgrade_cta_clicked: upgradeCtaClicked,
    stripe_checkout_started: stripeCheckoutStarted,
    paid_upgrade: paidUpgrade,
    tg_bot_start: tgBotStart,
    tg_bot_first_command: tgBotFirstCommand,
    tg_bot_watchlist_add: tgBotWatchlistAdd,
    tg_bot_quota_hit: tgBotQuotaHit,
    tg_bot_upgrade_clicked: tgBotUpgradeClicked,
  };

  const stageRetentions: Record<string, number | null> = {};
  let weakestTransition: { from: string; to: string; retention: number | null } | null = null;
  for (let i = 1; i < CANONICAL_STAGE_ORDER.length; i++) {
    const fromKey = CANONICAL_STAGE_ORDER[i - 1];
    const toKey = CANONICAL_STAGE_ORDER[i];
    const fromCount = funnelCounts[fromKey];
    const toCount = funnelCounts[toKey];
    const r = ratio(toCount, fromCount);
    const key = `${fromKey}_to_${toKey}`;
    stageRetentions[key] = r;
    // Track minimum non-null retention as the weakest transition.
    if (r !== null && (weakestTransition === null || (weakestTransition.retention !== null && r < weakestTransition.retention))) {
      weakestTransition = { from: fromKey, to: toKey, retention: r };
    }
  }

  // ── Data-quality gate ──
  // Belt-and-suspenders: even if the connectivity probe passed, individual
  // queries might silently return null for structural reasons (wrong table
  // name, schema drift, transient lock timeout). If ALL three critical
  // fields are null, the snapshot is garbage and should not be committed.
  // See status.md R5.2 failure-mode test (2026-04-15 15:23 UTC).
  const criticalNulls = [sessionsTotal, firstCall, holdRateGetTradeSignal]
    .filter((v) => v === null || v === undefined).length;
  if (criticalNulls === 3) {
    throw new Error(
      `Data quality gate failed: all 3 critical fields (sessions.total, funnel.first_call, hold_rate) are null — probable database issue. Warnings: ${warnings.join('; ')}`,
    );
  }

  return {
    generated_at: new Date().toISOString(),
    window: { from: windowFromIso, to: windowToIso },
    sessions: {
      total: sessionsTotal,
      unique_ips: uniqueIps,
      new_in_window: newInWindow,
    },
    funnel: {
      // Existing 5 (UNCHANGED — backward compat):
      install,
      first_call: firstCall,
      second_call: secondCall,
      fifth_plus_call: fifthPlusCall,
      paid_upgrade: paidUpgrade,
      // NEW 11 (ACTIVATION-FUNNEL-AUDIT-W1, 2026-05-28):
      mcp_tools_list: mcpToolsList,
      quota_hit_soft: quotaHitSoft,
      quota_hit_hard: quotaHitHard,
      quota_hit_block: quotaHitBlock,
      upgrade_cta_clicked: upgradeCtaClicked,
      stripe_checkout_started: stripeCheckoutStarted,
      tg_bot_start: tgBotStart,
      tg_bot_first_command: tgBotFirstCommand,
      tg_bot_watchlist_add: tgBotWatchlistAdd,
      tg_bot_quota_hit: tgBotQuotaHit,
      tg_bot_upgrade_clicked: tgBotUpgradeClicked,
    },
    conversion,
    stage_retentions: stageRetentions,
    weakest_stage_transition: weakestTransition,
    stick_rate: stickRate,
    time_to_first_call_ms: { p50, p90 },
    tool_call_distribution: toolCallDistribution,
    hold_rate_get_trade_signal: holdRateGetTradeSignal,
    tier_cohort_sizes: tierCohortSizes,
    warnings,
  };
}

// CLI handler lives at `scripts/funnel-snapshot.ts` (thin wrapper that imports
// generateFunnelSnapshot + parses --days/--since/--until args). The library
// file stays in src/lib/ so the compiled mcp-server can import it from
// `/api/admin/funnel-snapshot` HTTP endpoint.
