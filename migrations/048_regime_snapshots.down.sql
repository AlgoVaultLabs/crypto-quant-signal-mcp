-- 048_regime_snapshots.down.sql — rollback of 048 (SCAN-MARKET-REGIMES-W1-V2 CH1).
-- ⚠ DESTRUCTIVE: this DROPS the permanent per-bar regime history (V2 §0 Q2) and the run record that
-- scan_market_regimes and the regime-snapshot-freshness canary read. Data Integrity LAW: never run it
-- against production while either consumer is live, and never without explicit authorization.
-- Take `pg_dump -t regime_snapshots -t regime_snapshot_runs` first. Disable the :11 sampler cron line
-- before running it, or the lazy ensure in src/lib/regime-snapshots.ts recreates both tables on the
-- next tick.
DROP INDEX IF EXISTS idx_regime_snapshot_runs_pair_bar;
DROP TABLE IF EXISTS regime_snapshot_runs;
DROP TABLE IF EXISTS regime_snapshots;
