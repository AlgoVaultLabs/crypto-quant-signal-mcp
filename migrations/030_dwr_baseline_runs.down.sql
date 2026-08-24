-- 030 DOWN — EDGE-DWR-REFRESH-W1 R4
--
-- Dropping this destroys the DWR time series and nothing else: no public surface reads it, no
-- serving path depends on it, and the numbers are recomputable from `directional_labels` +
-- `signals` by re-running `dist/scripts/dwr-baseline-report.js`. Recomputable is not free,
-- though — the series' whole purpose is that nobody has to re-derive it by hand and mis-date the
-- result afterwards, so prefer leaving the table and retiring the cron.
--
-- Safe order: remove the monthly crontab entry FIRST (otherwise the next fire recreates nothing
-- and simply logs a permission/relation error into a log nobody reads), then drop.
DROP INDEX IF EXISTS idx_dwr_baseline_runs_spec_ts;
DROP TABLE IF EXISTS dwr_baseline_runs;
