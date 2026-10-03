-- 046_verdict_rule_registry.down.sql — rollback of 046 (SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2).
-- Drops the registry's stamp and capture columns only; verdict_rule_version and every pre-existing
-- column are untouched. Run only AFTER the code that writes these columns is reverted and deployed —
-- otherwise every INSERT naming them fails. If TREND_MODE=on has already been removed from the host
-- .env, restore it BEFORE that revert deploys: the pre-registry code reads it, and unset means v1,
-- which is denied.
SET lock_timeout = '3s';
BEGIN;
ALTER TABLE signal_scorer_inputs
  DROP COLUMN IF EXISTS funding_z,
  DROP COLUMN IF EXISTS rsi_score_pre,
  DROP COLUMN IF EXISTS rsi_value,
  DROP COLUMN IF EXISTS verdict_h,
  DROP COLUMN IF EXISTS verdict_f,
  DROP COLUMN IF EXISTS verdict_m,
  DROP COLUMN IF EXISTS v1_raw_final,
  DROP COLUMN IF EXISTS v1_signal,
  DROP COLUMN IF EXISTS trend_decisive,
  DROP COLUMN IF EXISTS rule_config_id;
ALTER TABLE signals DROP COLUMN IF EXISTS rule_config_id;
COMMIT;
