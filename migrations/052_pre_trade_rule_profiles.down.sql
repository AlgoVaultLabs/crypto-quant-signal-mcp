-- 052_pre_trade_rule_profiles.down.sql — rollback of 052 (DECISION-CALL-V2-W2 CH1).
-- ⚠ DESTRUCTIVE: this DROPS every caller's saved rules. Data Integrity LAW: never run it against production without
-- explicit authorization. Take `pg_dump -t pre_trade_rule_profiles` first. The lazy ensure in
-- src/lib/pre-trade-rule-profiles.ts recreates the (empty) table on the next keyed check unless the reader is
-- reverted first.
DROP TABLE IF EXISTS pre_trade_rule_profiles;
