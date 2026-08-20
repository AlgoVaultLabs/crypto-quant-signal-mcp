-- OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH3c
--
-- `bot_daily_metrics` HAD NO COMMITTED DDL. The table was created directly in production and then
-- widened ad hoc, wave by wave: `calls_paid_linked`, `walled_now`, `walled_silent`,
-- `plan_units_debited`, `outbox_pending`, `walled_paid_now` were each applied by hand with no
-- migration. Its schema existed in exactly one place — the running database — so a fresh database
-- could not be built and nothing in the repo stated what the bot bridge writes into.
--
-- That is the same class of defect this wave exists to remove (state that is real but undeclared),
-- sitting directly in the path CH3c has to touch. So this migration DECLARES the table rather than
-- only adding the new column.
--
-- The column list below was generated from production's `information_schema` on 2026-08-20, not
-- authored from memory: it is a transcription of what is actually there, in ordinal order.
--
-- Idempotent on purpose: a no-op against prod (where every object already exists) and a real
-- declaration against a fresh database. Only `deployed_sha` is new.

CREATE TABLE IF NOT EXISTS bot_daily_metrics (
  metric_date              date PRIMARY KEY,
  calls_total              integer NOT NULL DEFAULT 0,
  calls_watch              integer NOT NULL DEFAULT 0,
  calls_scanwatch          integer NOT NULL DEFAULT 0,
  calls_scan               integer NOT NULL DEFAULT 0,
  alerts_regime            integer NOT NULL DEFAULT 0,
  subscribers              integer NOT NULL DEFAULT 0,
  new_subscribers_24h      integer NOT NULL DEFAULT 0,
  blocked_subscribers      integer NOT NULL DEFAULT 0,
  watchlist_entries        integer NOT NULL DEFAULT 0,
  quota_exhausted_notices  integer NOT NULL DEFAULT 0,
  generated_at             timestamptz NOT NULL DEFAULT now(),
  calls_paid_linked        integer NOT NULL DEFAULT 0,
  walled_now               integer NOT NULL DEFAULT 0,
  walled_silent            integer NOT NULL DEFAULT 0,
  plan_units_debited       integer NOT NULL DEFAULT 0,
  outbox_pending           integer NOT NULL DEFAULT 0,
  walled_paid_now          integer NOT NULL DEFAULT 0
);

-- Backfill for a database that predates this file (i.e. production).
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS calls_paid_linked       integer NOT NULL DEFAULT 0;
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS walled_now              integer NOT NULL DEFAULT 0;
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS walled_silent           integer NOT NULL DEFAULT 0;
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS plan_units_debited      integer NOT NULL DEFAULT 0;
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS outbox_pending          integer NOT NULL DEFAULT 0;
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS walled_paid_now         integer NOT NULL DEFAULT 0;

-- NEW: the commit the bot's running code was deployed from.
--
-- NULLABLE WITH NO DEFAULT, deliberately, and it is the only column here that is. Every other
-- column is a COUNT, where 0 is a true measurement. This one is a FACT ABOUT THE DEPLOY, where the
-- absence of a value is itself the finding: `NULL` means "this bot deploy recorded no provenance",
-- which the drift canary must be able to see. A `DEFAULT ''` or `DEFAULT 'unknown'` would render a
-- missing measurement as a confident one and re-create the defect.
ALTER TABLE bot_daily_metrics ADD COLUMN IF NOT EXISTS deployed_sha text;

COMMENT ON COLUMN bot_daily_metrics.deployed_sha IS
  'Commit sha the bot was deployed from, or NULL for "no provenance recorded". Never a placeholder.';
