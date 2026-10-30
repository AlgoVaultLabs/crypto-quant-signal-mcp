-- 050_signals_backfill_fail_class.down.sql — rollback of 050 (OPS-VENUE-MARKET-CLOSED-W2).
-- Drops the attempt class only; every pre-existing column is untouched. Run only AFTER the code that writes
-- and reads it is reverted and deployed — otherwise recordBackfillAttempt's UPDATE and the census SQL the
-- outcome-backfill-freshness canary executes both fail on the missing column.
SET lock_timeout = '3s';
BEGIN;
ALTER TABLE signals DROP COLUMN IF EXISTS backfill_fail_class;
COMMIT;
