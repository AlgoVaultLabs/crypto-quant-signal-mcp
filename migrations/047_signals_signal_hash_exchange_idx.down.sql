-- 047_signals_signal_hash_exchange_idx.down.sql — rollback of 047 (SIGNAL-VERDICT-RULE-REGISTRY-W1 CH3).
-- ⚠ THIS DROPS AN INDEX A SERVING READ DEPENDS ON. getSignalByHash (src/lib/performance-db.ts; called
-- from the signal-lookup routes in src/index.ts) finds a signal by `signal_hash`, and this index is its
-- plan: measured 2026-10-03, 92-184 ms full scans of `signals` before it, 0.14 ms with it. Dropping it
-- returns every such lookup to a full scan of the serving table.
-- `psql -f` only (autocommit): DROP INDEX CONCURRENTLY refuses a transaction block and never blocks the
-- seeders' writes. Without the index the verdict-rule gate also reads INDETERMINATE at every look (its
-- guard refuses a per-row scan of the serving database), so roll this back only together with the gate.
DROP INDEX CONCURRENTLY IF EXISTS idx_signals_signal_hash_exchange;
