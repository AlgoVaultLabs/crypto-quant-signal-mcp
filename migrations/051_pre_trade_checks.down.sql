-- 051_pre_trade_checks.down.sql — rollback of 051 (DECISION-CALL-V2-W1 CH3).
-- ⚠ DESTRUCTIVE: this DROPS the permanent pre_trade_check check log, which the pre-trade-health canary's
-- log-parity leg reads. Data Integrity LAW: never run it against production without explicit
-- authorization. Take `pg_dump -t pre_trade_checks` first. The lazy ensure in
-- src/lib/pre-trade-check-log.ts recreates the table on the next served call unless the writer is
-- reverted first.
DROP INDEX IF EXISTS idx_pre_trade_checks_checked_at;
DROP TABLE IF EXISTS pre_trade_checks;
