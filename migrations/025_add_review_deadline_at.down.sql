-- 025_add_review_deadline_at.down.sql
-- OPS-VENUE-DAY30-DECISION-W1 — the down-path, produced per the Plan-Mode
-- "schema migration with no down path declared" risk marker.
--
-- ⚠️ READ THIS BEFORE RUNNING IT. THIS REVERT IS ORDER-DEPENDENT.
--
-- Dropping `review_deadline_at` while the deployed code still READS it makes
-- `decide()` in src/scripts/evaluate-venues.ts evaluate against a column that
-- no longer exists. The read reaches it via `SELECT *` in venue-store's
-- `getVenue`/`listVenues` → `rowToRecord`, so the field silently becomes
-- `undefined` rather than throwing at the SQL layer — and `undefined` fails the
-- `!= null` deadline check, which means EVERY day-30 venue immediately reverts
-- to firing `manual_required` daily. That is exactly the 33-day defect this
-- wave retired.
--
-- CORRECT ORDER — both steps, in this order, or do not start:
--   1. Revert the CH2 read first: restore Branch 3 in
--      src/scripts/evaluate-venues.ts to the pre-wave predicate
--      `if (days_since >= DAY_30_FLOOR && venue.extension_count >= 1)`,
--      remove the `setReviewDeadline` self-throttle write from
--      `evaluateAllShadowVenues`, and DEPLOY that. Confirm the running
--      container no longer references the column:
--        docker exec crypto-quant-signal-mcp-mcp-server-1 \
--          grep -c review_deadline_at /app/dist/lib/venue-store.js
--      (expect 0 — note it is dist/lib/venue-store.js, NOT dist/index.js:
--       tsc emits per-module, so a lib symbol never appears in the entrypoint.)
--   2. Only then run this file.
--
-- DATA LOSS NOTICE: dropping the column discards every pending decision
-- deadline. Any venue mid-extension loses its remaining window and re-enters
-- the daily-alert state on the next 06:00 UTC cron fire. The `notes` column
-- retains the human-readable audit trail (` | auto-deferred <ISO> (#N)` and the
-- operator extension reasons), so the history survives even though the
-- machine-readable deadline does not. `seeding_started_at` is NOT touched by
-- this revert — the accrued measurement window is never at risk here, which is
-- the whole point of having split the two fields.
--
-- DO NOT AUTOMATE THIS. No cron, no unattended job. Operator-run only.
--
-- Check what you are about to discard:
--   SELECT exchange_id, status, extension_count, review_deadline_at
--   FROM venues WHERE review_deadline_at IS NOT NULL ORDER BY exchange_id;

BEGIN;

DO $$
DECLARE
  pending_count INTEGER;
BEGIN
  SELECT count(*) INTO pending_count
  FROM venues
  WHERE review_deadline_at IS NOT NULL AND review_deadline_at > NOW();

  IF pending_count > 0 THEN
    RAISE WARNING
      'Dropping review_deadline_at discards % unexpired decision deadline(s). Those venues resume DAILY manual_required alerts on the next 06:00 UTC fire. Confirm step 1 (revert the CH2 read + deploy) is already done.',
      pending_count;
  END IF;
END $$;

ALTER TABLE venues DROP COLUMN IF EXISTS review_deadline_at;

COMMIT;
