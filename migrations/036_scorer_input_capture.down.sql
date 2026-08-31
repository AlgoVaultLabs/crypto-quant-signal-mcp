-- 036 DOWN — OPS-SCORER-INPUT-PERSISTENCE-W1
--
-- ⚠ READ THIS BEFORE RUNNING IT. Capture is FORWARD-ONLY: the scorer's inputs are not recorded
-- anywhere else and cannot be reconstructed, because they never existed outside the process that
-- computed them. Running this file does not "roll back a schema change" — it DESTROYS the only
-- copy of every part captured since 2026-08-31, and the clock on
-- EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT} restarts from zero on the day the columns come back.
--
-- The recovery you almost certainly want instead is the KILL SWITCH, which stops the writes and
-- keeps the corpus:
--
--     SCORER_INPUT_CAPTURE_ENABLED=0     (no rebuild, no deploy, instantly reversible)
--
-- This file exists because a migration without a down migration is an undocumented one-way door,
-- not because reversing it is a routine act.

-- The two ALTERed tables: drop only the columns this migration added. `hold_decisions` and
-- `band_signals` themselves belong to migrations 032 and 035 and must survive.
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS rsi_score;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS ema_score;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS funding_score;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS oi_score;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS volume_score;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS raw0;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS funding_delta;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS hurst_delta;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS squeeze_delta;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS raw_final;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS funding_adjust_code;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS hurst_adjust_code;
ALTER TABLE hold_decisions DROP COLUMN IF EXISTS squeeze_adjust_code;

ALTER TABLE band_signals   DROP COLUMN IF EXISTS rsi_score;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS ema_score;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS funding_score;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS oi_score;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS volume_score;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS raw0;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS funding_delta;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS hurst_delta;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS squeeze_delta;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS raw_final;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS funding_adjust_code;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS hurst_adjust_code;
ALTER TABLE band_signals   DROP COLUMN IF EXISTS squeeze_adjust_code;

-- The emitted arm's table, its indexes and its sequence go with it.
DROP TABLE IF EXISTS signal_scorer_inputs;

-- The column-level grant on `hold_decisions` is dropped with its columns, so there is nothing to
-- revoke here. Recorded explicitly so a reader does not add a REVOKE that would error.
