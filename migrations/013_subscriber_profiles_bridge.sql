-- 013_subscriber_profiles_bridge.sql — CONVERSION-MEASUREMENT-W1 / C2
-- Best-effort pre-conversion bridge: link a paid conversion back to the
-- customer's PRE-conversion FREE usage (as far as is structurally possible) and
-- record an HONEST confidence per match path. Written by buildSubscriberProfile()
-- (src/lib/subscriber-attribution.ts) at checkout.session.completed, and
-- backfilled for existing rows by backfillSubscriberBridges().
--
-- ADDITIVE ONLY — five new columns on the EXISTING subscriber_profiles table; no
-- existing column/query touched; Data-Integrity safe. NON-PII (counts / pct /
-- a confidence label only — never an email/IP/name; outcome_return_pct absent).
--
-- bridge_confidence semantics (Factuality LAW — never fabricate a bridge):
--   deterministic — track-token (analytics session_id derives from it) OR a
--                   known free-tier email opt-in (signup_emails).
--   probabilistic — ip_hash only (the /signup click IP; NAT-shared → inferred).
--   none          — no link (e.g. a COLD /signup with no opt-in + no attribution
--                   row — the honest answer for the lone existing subscriber).
--
-- Pre-applied to prod signal_performance via SSH psql BEFORE the code commit
-- lands; PG ADD COLUMN IF NOT EXISTS + the runtime ensureSubscriberBridgeColumns()
-- pre-check make the committed code a no-op against the prepared DB. (SQLite has
-- no ADD COLUMN IF NOT EXISTS; tests use the PRAGMA table_info() pre-check in
-- ensureSubscriberBridgeColumns().)

ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS pre_conversion_calls    INTEGER;       -- request_log rows before converted_at via the linked key
ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS pre_conversion_sessions INTEGER;       -- COUNT(DISTINCT session_id) of that pre-conversion usage
ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS time_to_first_call_s    INTEGER;       -- seconds from first pre-conversion call to conversion (free tenure)
ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS peak_quota_pct          NUMERIC(6,2);  -- max(quota_usage.call_count)/free_monthly_quota*100 over linked ip_hash(es)
ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS bridge_confidence       TEXT;          -- deterministic | probabilistic | none
