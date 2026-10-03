-- 047_signals_signal_hash_exchange_idx.down.sql — rollback of 047 (SIGNAL-VERDICT-RULE-REGISTRY-W1 CH3).
-- `psql -f` only (autocommit): DROP INDEX CONCURRENTLY refuses a transaction block and never blocks the
-- seeders' writes. Without the index the verdict-rule gate reads INDETERMINATE at every look (its guard
-- refuses a per-row scan of the serving database), so roll this back only together with the gate.
DROP INDEX CONCURRENTLY IF EXISTS idx_signals_signal_hash_exchange;
