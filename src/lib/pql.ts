/**
 * CONVERSION-MEASUREMENT-W1 C3 — Product-Qualified-Lead (PQL) scoring.
 *
 * Flags FREE users showing buying intent so the conversion plays (a later wave)
 * have a cohort to target. A free user is proxied by its `ip_hash` (the keyless
 * quota unit `free:<ipHash>`). Three OR criteria (architect-ratified):
 *   peak_quota_pct >= PQL_QUOTA_PCT  (default 80)  — near the free wall
 *   recent_calls   >= PQL_CALL_FREQ  (default 20)  — high rolling-window usage
 *   reached_aha                                     — got a first BUY/SELL (C1)
 *
 * Substrate vs policy split: the `pql_candidates` VIEW computes the per-ip RAW
 * signals + a simple env-independent score; the env THRESHOLDS (default-deny on
 * NaN/invalid per CLAUDE.md) + the is-PQL decision live in JS here, so a
 * misconfigured env can never silently admit everyone. Read-only — NO outreach.
 *
 * PII: the cohort NEVER exposes the raw `ip_hash` (a forbidden key on the
 * funnel-snapshot shape); it projects an 8-char `candidate_ref` prefix only.
 */
import { stripIpHashVersion } from './analytics.js';
import { dbExec, dbQuery } from './performance-db.js';
import { getMonthlyQuota } from './license.js';

const PG = !!process.env.DATABASE_URL;
export const PQL_VIEW_NAME = 'pql_candidates';

// ── Threshold parsing (strict decimal BEFORE Number; default-deny on NaN) ──
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function parseGateThreshold(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  // default-deny: an invalid threshold becomes Infinity → the `>=` gate admits
  // nobody on that criterion (rather than admitting everyone). NEVER NaN.
  if (!DECIMAL_RE.test(s)) return Infinity;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return Infinity;
  return n;
}

function parseWindowDays(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return def; // a window has no meaningful "deny" — fall back to the default
  const n = parseInt(s, 10);
  return n >= 1 && n <= 365 ? n : def;
}

export interface PqlThresholds {
  quotaPct: number;   // peak_quota_pct >= this (Infinity = denied/disabled)
  callFreq: number;   // recent_calls   >= this (Infinity = denied/disabled)
  windowDays: number; // rolling window for recent_calls
}

export function resolvePqlThresholds(env: NodeJS.ProcessEnv = process.env): PqlThresholds {
  return {
    quotaPct: parseGateThreshold(env.PQL_QUOTA_PCT, 80),
    callFreq: parseGateThreshold(env.PQL_CALL_FREQ, 20),
    windowDays: parseWindowDays(env.PQL_WINDOW_DAYS, 7),
  };
}

function clampDays(d: number): number {
  return Math.max(1, Math.min(365, Math.trunc(Number.isFinite(d) ? d : 7)));
}

/**
 * Build the pql_candidates VIEW DDL. The rolling-window boundary is backend-
 * conditional (PG `interval` vs SQLite `strftime`) and produces an ISO-millis
 * string comparable to the TEXT `request_log.timestamp` column lexicographically.
 * `days` is clamped to an integer (injection-safe).
 */
export function pqlViewDdl(windowDays: number, orReplace: boolean): string {
  const days = clampDays(windowDays);
  const recentBoundary = PG
    ? `to_char(now() - interval '${days} days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
    : `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days')`;
  const botFalse = PG ? 'false' : '0';
  const createClause = `CREATE ${PG && orReplace ? 'OR REPLACE ' : ''}VIEW ${PQL_VIEW_NAME}`;
  return `${createClause} AS
    WITH free_calls AS (
      SELECT ip_hash, session_id, timestamp
      FROM request_log
      WHERE license_tier = 'free' AND is_bot_internal = ${botFalse} AND ip_hash IS NOT NULL
    ),
    call_stats AS (
      SELECT ip_hash,
             COUNT(*) AS total_calls,
             COUNT(*) FILTER (WHERE timestamp >= ${recentBoundary}) AS recent_calls,
             MAX(timestamp) AS last_call
      FROM free_calls
      GROUP BY ip_hash
    ),
    quota AS (
      SELECT SUBSTR(tracker_key, 6) AS ip_hash, call_count
      FROM quota_usage WHERE tracker_key LIKE 'free:%'
    ),
    aha AS (
      SELECT DISTINCT fc.ip_hash
      FROM funnel_events fe
      JOIN free_calls fc ON fc.session_id = fe.session_id
      WHERE fe.event_type = 'first_non_hold_verdict'
    )
    SELECT
      cs.ip_hash,
      cs.total_calls,
      cs.recent_calls,
      cs.last_call,
      COALESCE(q.call_count, 0) AS quota_call_count,
      CASE WHEN a.ip_hash IS NOT NULL THEN 1 ELSE 0 END AS reached_aha,
      (COALESCE(q.call_count, 0) + cs.recent_calls + CASE WHEN a.ip_hash IS NOT NULL THEN 30 ELSE 0 END) AS score
    FROM call_stats cs
    LEFT JOIN quota q ON q.ip_hash = cs.ip_hash
    LEFT JOIN aha a ON a.ip_hash = cs.ip_hash`;
}

let _pqlViewInitForDays: number | null = null;

/** Idempotently (re)create the view for the given window. PG CREATE OR REPLACE; SQLite DROP+CREATE. */
export async function ensurePqlView(windowDays?: number): Promise<void> {
  const days = clampDays(windowDays ?? resolvePqlThresholds().windowDays);
  if (_pqlViewInitForDays === days) return;
  if (PG) {
    dbExec(pqlViewDdl(days, true));
  } else {
    dbExec(`DROP VIEW IF EXISTS ${PQL_VIEW_NAME};`);
    dbExec(pqlViewDdl(days, false));
  }
  _pqlViewInitForDays = days;
}

/** Reset the view-init latch — tests only. */
export function _resetPqlViewInitForTest(): void {
  _pqlViewInitForDays = null;
}

export interface PqlCandidate {
  candidate_ref: string;     // 8-char ip_hash prefix — NON-PII (never the full hash)
  peak_quota_pct: number;    // quota_call_count / free_monthly_quota * 100
  recent_calls: number;      // calls in the rolling window
  total_calls: number;       // all-time free calls from this user
  reached_aha: boolean;      // received a first BUY/SELL (first_non_hold_verdict)
  score: number;             // simple env-independent intent score
  last_call_at: string | null;
}

export interface PqlCohort {
  generated_at: string;
  window_days: number;
  thresholds: { quota_pct: number | null; call_freq: number | null };
  count: number;
  candidates: PqlCandidate[];
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function displayThresholds(t: PqlThresholds): { quota_pct: number | null; call_freq: number | null } {
  return {
    quota_pct: Number.isFinite(t.quotaPct) ? t.quotaPct : null,
    call_freq: Number.isFinite(t.callFreq) ? t.callFreq : null,
  };
}

/**
 * The scored PQL cohort: free users meeting ANY threshold criterion, projected
 * to a non-PII shape and ordered by score desc. Fully fail-open — any error
 * (missing view, query failure) yields an empty cohort (the admin endpoint must
 * never 500 on PQL). Read-only.
 */
export async function getPqlCandidates(opts?: { limit?: number; thresholds?: PqlThresholds }): Promise<PqlCohort> {
  const t = opts?.thresholds ?? resolvePqlThresholds();
  const limit = Math.min(Math.max(Math.trunc(opts?.limit ?? 100), 1), 500);
  const base: PqlCohort = {
    generated_at: new Date().toISOString(),
    window_days: t.windowDays,
    thresholds: displayThresholds(t),
    count: 0,
    candidates: [],
  };
  try {
    await ensurePqlView(t.windowDays);
    const freeQuota = getMonthlyQuota('free');
    const rows = await dbQuery<{
      ip_hash: string; total_calls: number | string; recent_calls: number | string;
      last_call: string | null; quota_call_count: number | string; reached_aha: number | string; score: number | string;
    }>(
      `SELECT ip_hash, total_calls, recent_calls, last_call, quota_call_count, reached_aha, score
         FROM ${PQL_VIEW_NAME} ORDER BY score DESC`, []);
    const candidates: PqlCandidate[] = [];
    for (const r of rows) {
      const recentCalls = num(r.recent_calls);
      const reachedAha = num(r.reached_aha) === 1;
      const quotaCalls = num(r.quota_call_count);
      const peakQuotaPct = freeQuota > 0 ? Math.round((quotaCalls / freeQuota) * 10000) / 100 : 0;
      const isPql = peakQuotaPct >= t.quotaPct || recentCalls >= t.callFreq || reachedAha;
      if (!isPql) continue;
      candidates.push({
        // OPS-SEC-IPHASH-SALT-W1: slice PAST the version prefix. A bare `.slice(0, 8)` on a
        // `v2:<hash>` value spends 3 of its 8 chars on "v2:", cutting the admin ref to 5
        // meaningful chars and colliding candidates that are genuinely distinct.
        candidate_ref: typeof r.ip_hash === 'string' && r.ip_hash.length > 0
          ? (stripIpHashVersion(r.ip_hash).slice(0, 8) || 'unknown')
          : 'unknown',
        peak_quota_pct: peakQuotaPct,
        recent_calls: recentCalls,
        total_calls: num(r.total_calls),
        reached_aha: reachedAha,
        score: num(r.score),
        last_call_at: r.last_call ?? null,
      });
      if (candidates.length >= limit) break;
    }
    return { ...base, count: candidates.length, candidates };
  } catch (err) {
    console.warn('[getPqlCandidates] failed (fail-open → empty cohort):', err instanceof Error ? err.message : err);
    return base;
  }
}
