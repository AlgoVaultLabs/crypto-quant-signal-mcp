-- 032 DOWN — OPS-HOLD-DECISION-CAPTURE-W1
--
-- WHAT THIS DESTROYS, AND WHY IT IS NOT RECOVERABLE. Everything below is CAPTURE, not derivation.
-- `hold_decisions` records the would-be side of decisions that were never acted on; that sign is
-- computed inside `deriveVerdict` and then discarded by `Math.abs(rawScore)`
-- (`src/tools/get-trade-call.ts:273`). It exists nowhere else — not in `request_log`, not in
-- `signals` (HOLDs never reach `recordSignal`), not in `hold_counts` (a daily aggregate keyed only
-- on date/timeframe/coin). Dropping these tables does not lose a computation that can be re-run;
-- it loses the observations themselves, and the earliest possible answer date moves forward by
-- however long capture had been running. Rolling back one week costs one week.
--
-- `hold_decision_labels` alone IS recomputable from `hold_decisions` plus candles, so if the goal
-- is only to rebuild labels under a different barrier spec, DELETE from that table by
-- `barrier_spec` and re-run the labeler — do not drop anything.
--
-- WHAT IS SAFE. Nothing here is read by a serving path, a public surface, or a published metric.
-- The whole design keeps HOLD counterfactuals OUT of `directional_labels` and out of every
-- aggregate behind the track record, so a full rollback cannot move a published number. That is
-- the one guarantee this wave makes unconditionally, and it holds in both directions.
--
-- SAFE ORDER — the capture write is fail-open (`get-trade-call.ts`, wrapped in try/catch), so a
-- missing table logs at debug level and never affects a response. Dropping before the code is
-- withdrawn is therefore survivable, but it makes every HOLD do a doomed INSERT. Prefer:
--   1. remove the labeler crontab entry on 204 (otherwise its next fire logs a relation error
--      into a log nobody reads and its verdict token goes INDETERMINATE);
--   2. deploy code with capture disabled (HOLD_DECISION_CAPTURE_ENABLED=0) — no rebuild needed;
--   3. only then run this file.

-- Ownership needs no undo: dropping the tables drops it with them.
DROP INDEX IF EXISTS idx_hold_labels_spec_decision;
DROP TABLE IF EXISTS hold_decision_labels;

DROP INDEX IF EXISTS uq_hold_decisions_fleet_cell;
DROP INDEX IF EXISTS idx_hold_decisions_scan;
DROP TABLE IF EXISTS hold_decisions;

-- The request_log columns are dropped LAST and separately: unlike the tables above they sit on a
-- live, high-traffic table on the serving path. They are additive and nullable, so LEAVING them
-- in place costs nothing and is the safer default — drop them only when the intent is a complete
-- revert of the wave, and never while a deployed build still writes them.
DROP INDEX IF EXISTS idx_request_log_hold_capture;
ALTER TABLE request_log DROP COLUMN IF EXISTS price_at_decision;
ALTER TABLE request_log DROP COLUMN IF EXISTS regime;
ALTER TABLE request_log DROP COLUMN IF EXISTS exchange;
ALTER TABLE request_log DROP COLUMN IF EXISTS would_be_side;
