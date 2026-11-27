-- 058_refusal_counts.sql — REGIME-TF-ADMISSION-W1 CH2
-- Every refused tool input, kept as a daily count, so "should we add X?" reads demand from day 0. One row per
-- (UTC day, reason, tool, parameter, value, keyed, caller_key):
--
--   day         the UTC day of the refusal
--   reason      invalid_enum_value | unrecognized_keys | timeframe_admission | non_public_venue | <overflow>
--   tool        the served tool name
--   parameter   the refused parameter (for unrecognized_keys, the unknown key itself)
--   value       the refused value: <= 32 chars of [A-Za-z0-9_.:-], else <other>
--   keyed       the request carried an API key
--   caller_key  request_log's ip_hash for the request (no new hash domain), or <none>
--   count       refusals counted under this key that day
--
-- At most 10,000 distinct keys per UTC day; later new keys fold into one <overflow> row.
--
-- Producer: recordRefusal + flushRefusals (src/lib/refusal-counter.ts) — a batched upsert on an interval and at
-- shutdown, never on a request path. Consumer: REGIME-15M-SERVE-W1's daily trigger (distinct refused callers), read
-- as aoe_readonly, the owed-read runner's read-only role. The GRANT is guarded: a database without that role (CI's
-- bootstrap creates it; a dev box may not) applies this file cleanly.
--
-- Not pre-applied: the lazy ensure in src/lib/refusal-counter.ts runs these exact statements once per process before
-- its first flush, under the app's own role. A new table — no code that predates it reads or writes it, so reverting
-- the code is a complete rollback. The statements are identical (pinned by tests/unit/refusal-counter.test.ts, which
-- also applies this file up, down and up again in PGlite).

CREATE TABLE IF NOT EXISTS refusal_counts (
  day        DATE    NOT NULL,
  reason     TEXT    NOT NULL,
  tool       TEXT    NOT NULL,
  parameter  TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  keyed      BOOLEAN NOT NULL,
  caller_key TEXT    NOT NULL,
  count      BIGINT  NOT NULL,
  PRIMARY KEY (day, reason, tool, parameter, value, keyed, caller_key)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoe_readonly') THEN
    GRANT SELECT ON refusal_counts TO aoe_readonly;
  END IF;
END
$$;
