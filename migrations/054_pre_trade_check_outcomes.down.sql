-- 054_pre_trade_check_outcomes.down.sql — rollback of 054 (DECISION-CALL-V2-W4 CH3).
-- ⚠ DESTRUCTIVE: this DROPS every pre_trade_check outcome label, the forward-calibration read's only label
-- input. A label older than a venue's candle reach cannot be rebuilt. Data Integrity LAW: never run it against
-- production without explicit authorization. Take `pg_dump -t pre_trade_check_outcomes` first. The labeler
-- recreates the (empty) table on its next run unless its crontab line is removed first.
DROP TABLE IF EXISTS pre_trade_check_outcomes;
