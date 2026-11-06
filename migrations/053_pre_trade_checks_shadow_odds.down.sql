-- 053_pre_trade_checks_shadow_odds.down.sql — rollback of 053 (DECISION-CALL-V2-W4 CH2).
-- ⚠ DESTRUCTIVE: this DROPS every logged shadow odd, the forward-calibration read's only input; they cannot be
-- recomputed after the fact (each is the odds as the check stood). Data Integrity LAW: never run it against
-- production without explicit authorization. Take `pg_dump -t pre_trade_checks` first. The lazy ensure in
-- src/lib/pre-trade-check-log.ts re-adds the (empty) columns on the next served call unless the writer is
-- reverted first.
ALTER TABLE pre_trade_checks
  DROP COLUMN IF EXISTS odds_version,
  DROP COLUMN IF EXISTS p_liq_hold,
  DROP COLUMN IF EXISTS p_stop_first,
  DROP COLUMN IF EXISTS p_target_first,
  DROP COLUMN IF EXISTS p_timeout;
