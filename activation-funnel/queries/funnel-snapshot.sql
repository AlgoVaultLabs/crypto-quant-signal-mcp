-- =============================================================================
-- Activation Funnel Snapshot — raw SQL (documentation only)
-- =============================================================================
--
-- This file mirrors the queries in scripts/funnel-snapshot.ts, which is what
-- the cron actually runs in production. It exists so a future analyst can
-- reproduce the snapshot directly via psql without needing to read TypeScript.
--
-- Run via:
--   docker exec -i crypto-quant-signal-mcp-postgres-1 \
--     psql -U algovault -d signal_performance \
--     < activation-funnel/queries/funnel-snapshot.sql
--
-- Variables to substitute before running (psql -v name=value, or sed replace):
--   :window_from_iso   e.g. '2026-04-01T00:00:00Z'   — for request_log.timestamp (TEXT ISO)
--   :window_to_iso     e.g. '2026-04-15T00:00:00Z'
--   :window_from_ms    epoch millis of :window_from_iso  — for agent_sessions (BIGINT millis)
--   :window_to_ms      epoch millis of :window_to_iso
--
-- CRITICAL GOTCHA:
--   request_log.timestamp is TEXT (ISO 8601 strings), NOT a timestamptz column.
--   agent_sessions.first_seen / .last_seen are BIGINT (epoch milliseconds).
--   Using the wrong one against the wrong column will silently return zero rows.
--
-- PostgreSQL-specific features used below:
--   - COUNT(*) FILTER (WHERE ...)
--   - PERCENTILE_CONT(...) WITHIN GROUP (ORDER BY ...)
-- The TypeScript version uses portable SUM(CASE WHEN ...) idioms instead, so
-- it runs on both SQLite (dev) and PostgreSQL (prod).
-- =============================================================================


-- ── Sessions totals ──────────────────────────────────────────────────────────

-- All sessions that began in the window
SELECT COUNT(*) AS sessions_total
FROM agent_sessions
WHERE first_seen >= :window_from_ms
  AND first_seen <= :window_to_ms;

-- Unique first-seen IP hashes (crude dedup proxy for "unique agents")
SELECT COUNT(DISTINCT ip_hash_first) AS unique_ips
FROM agent_sessions
WHERE first_seen >= :window_from_ms
  AND first_seen <= :window_to_ms;


-- ── Funnel: first_call / second_call / fifth_plus_call ─────────────────────

-- A single query that produces all three counts in one row.
SELECT
  COUNT(*) FILTER (WHERE call_count >= 1) AS first_call,
  COUNT(*) FILTER (WHERE call_count >= 2) AS second_call,
  COUNT(*) FILTER (WHERE call_count >= 5) AS fifth_plus_call
FROM agent_sessions
WHERE first_seen >= :window_from_ms
  AND first_seen <= :window_to_ms;


-- ── Paid upgrades ────────────────────────────────────────────────────────────

-- A session counts as "paid upgrade" if its terminal tier state includes any
-- paid tier token (starter / pro / enterprise / x402). tiers_seen is a
-- comma-separated deduped blob maintained by the agent-session writer on each
-- tool call.
SELECT COUNT(*) AS paid_upgrades
FROM agent_sessions
WHERE first_seen >= :window_from_ms
  AND first_seen <= :window_to_ms
  AND (
    tiers_seen LIKE '%starter%'
    OR tiers_seen LIKE '%pro%'
    OR tiers_seen LIKE '%enterprise%'
    OR tiers_seen LIKE '%x402%'
  );


-- ── Stick rate ───────────────────────────────────────────────────────────────

-- Fraction of sessions in the window that made at least a second call.
-- NULLIF guards against divide-by-zero when the window has zero sessions.
SELECT
  CAST(SUM(CASE WHEN call_count >= 2 THEN 1 ELSE 0 END) AS NUMERIC)
    / NULLIF(COUNT(*), 0) AS stick_rate
FROM agent_sessions
WHERE first_seen >= :window_from_ms
  AND first_seen <= :window_to_ms;


-- ── Time-to-second-call p50 / p90 ───────────────────────────────────────────

-- Uses (last_seen - first_seen) as the proxy for "elapsed time before a
-- second call" for sessions with call_count >= 2. Sessions with call_count < 2
-- are excluded (they never made a second call).
--
-- PostgreSQL supports PERCENTILE_CONT. The TS runner computes percentiles in
-- JS after fetching the per-session delta list, so it works on both backends.
SELECT
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (last_seen - first_seen)) AS p50_ms,
  PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY (last_seen - first_seen)) AS p90_ms
FROM agent_sessions
WHERE first_seen >= :window_from_ms
  AND first_seen <= :window_to_ms
  AND call_count >= 2;


-- ── Tool call distribution ───────────────────────────────────────────────────

-- Grouped by tool_name, ordered by call volume. The TS runner buckets
-- everything outside the three known tools into an "other" aggregate; the raw
-- SQL leaves each tool separate so analysts can see exactly what's there.
SELECT
  tool_name,
  COUNT(*) AS calls
FROM request_log
WHERE timestamp >= :window_from_iso
  AND timestamp <= :window_to_iso
GROUP BY tool_name
ORDER BY calls DESC;


-- ── HOLD rate on get_trade_signal ───────────────────────────────────────────

-- Ratio of HOLD verdicts to total get_trade_signal calls in the window.
-- This is the top-of-funnel friction metric — L2 HOLD rescue exists to
-- drive this number down.
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN verdict = 'HOLD' THEN 1 ELSE 0 END) AS holds,
  CAST(SUM(CASE WHEN verdict = 'HOLD' THEN 1 ELSE 0 END) AS NUMERIC)
    / NULLIF(COUNT(*), 0) AS hold_rate
FROM request_log
WHERE tool_name = 'get_trade_signal'
  AND timestamp >= :window_from_iso
  AND timestamp <= :window_to_iso;


-- ── Tier cohort sizes ────────────────────────────────────────────────────────

-- Distinct sessions per license tier observed in request_log. The TS runner
-- maps into a fixed {free, starter, pro, enterprise, x402} object and warns
-- on unknown tiers; raw SQL returns whatever the DB has.
SELECT
  license_tier,
  COUNT(DISTINCT session_id) AS sessions
FROM request_log
WHERE timestamp >= :window_from_iso
  AND timestamp <= :window_to_iso
GROUP BY license_tier
ORDER BY sessions DESC;


-- ── Fallback: first_call from request_log when agent_sessions is empty ─────

-- Pre-v1.9.0 rows have no agent_sessions entry. If the cohort table is empty
-- for a given historical window, this is the next-best approximation of
-- "unique agents that made at least one call".
SELECT COUNT(DISTINCT session_id) AS first_call_fallback
FROM request_log
WHERE timestamp >= :window_from_iso
  AND timestamp <= :window_to_iso;
