-- 037 down — OPS-AOE-MONITORING-DWR-REFOCUS-W1 R1.
-- Drops the per-cluster mix-matched edge columns. The AOE digest reader treats their ABSENCE the
-- same way it treats NULL: it names the figure unavailable rather than falling back to the
-- pooled `aggregate_edge`, so a rollback degrades the headline loudly instead of silently
-- restoring the artifact this wave retired.

ALTER TABLE dwr_baseline_runs
  DROP COLUMN IF EXISTS cluster_edge_mean_pp,
  DROP COLUMN IF EXISTS cluster_edge_sd_pp,
  DROP COLUMN IF EXISTS cluster_edge_clusters,
  DROP COLUMN IF EXISTS cluster_edge_rows,
  DROP COLUMN IF EXISTS cluster_edge_verdict;
