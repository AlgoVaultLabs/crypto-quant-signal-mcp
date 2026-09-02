-- 037 — OPS-AOE-MONITORING-DWR-REFOCUS-W1 R1
-- Five columns on `dwr_baseline_runs` carrying the PER-CLUSTER, MIX-MATCHED directional edge.
--
-- WHY A SECOND EDGE COLUMN SET AND NOT A REDEFINITION OF `aggregate_edge`. `aggregate_edge` is
-- `dwr − max(alwaysBUY, alwaysSELL)`, POOLED. That exact quantity is what `edge_gate` and the
-- validity predicate compute (in TS at `src/scripts/dwr-baseline.ts` and in the byte-parity
-- Python port at `autonomous-optimizer/src/feedback/edge_stats.py`), so redefining the column
-- would silently change a PROMOTE/DEMOTE input from a monitoring wave. That migration is
-- declared debt with its own ratified wave and shadow period —
-- `ops/monitoring/population-comparison.registry.json` → `EDGE-DWR-MIX-MATCHED-NULL-W{NEXT}`.
-- These columns are ADDITIVE and gate-free; the digest publishes them and LABELS the divergence
-- from `aggregate_edge` until that wave reconciles the two.
--
-- WHY THE NUMBERS DIFFER SO MUCH, MEASURED 2026-09-02 (tau1.0, low_vol=FALSE, n=282,071,
-- q(BUY)=.9417): pooled max-naive −1.79 pp · pooled mix-matched null −1.75 pp · PER-UTC-DAY
-- mix-matched null −0.05 pp (sd 0.95, 143 clusters). The comparator moves it 0.04 pp; the
-- AGGREGATION moves it ~1.7 pp. Pooling weights the busiest day, and the day — not the row — is
-- the independence unit.
--
-- WHY `verdict` IS A COLUMN AND NOT AN ABSENCE. Below `min_clusters` (20) the mean is
-- INDETERMINATE, and a NULL mean alone cannot distinguish "too few clusters" from "the writer
-- did not run". The reader REFUSES to render a headline whose verdict is not PER_CLUSTER, the
-- same discipline `predicate_version` already gives the `validated` count.
--
-- WHY EVERY COLUMN IS NULLABLE. Rows written before this migration were produced by a report
-- that computed no cluster edge — that is genuinely UNKNOWN, not a known zero, and the reader
-- treats NULL as "unavailable, name the reason" rather than falling back to the pooled artifact.
--
-- ADDITIVE AND SAFE TO PRE-APPLY: nullable columns on an existing table, no FK, no backfill.

ALTER TABLE dwr_baseline_runs
  -- Unweighted mean of the per-UTC-day mix-matched excess, in PERCENTAGE POINTS.
  ADD COLUMN IF NOT EXISTS cluster_edge_mean_pp   DOUBLE PRECISION,
  -- Sample sd of that excess across clusters, in pp. Published BESIDE the mean, never instead
  -- of it: measured, the spread (0.95 pp) is an order of magnitude larger than the mean
  -- (0.05 pp), and a mean without it reads as a conclusion rather than an estimate.
  ADD COLUMN IF NOT EXISTS cluster_edge_sd_pp     DOUBLE PRECISION,
  -- Clusters IN the mean (met the per-cluster row floor).
  ADD COLUMN IF NOT EXISTS cluster_edge_clusters  INTEGER,
  -- Rows inside those clusters. NOT the corpus size — conflating the two overstates coverage.
  ADD COLUMN IF NOT EXISTS cluster_edge_rows      INTEGER,
  -- 'PER_CLUSTER' | 'INDETERMINATE'. "Measured and clean" may never share an output with
  -- "measured nothing", so the reader gates on this and not on the mean being non-NULL.
  ADD COLUMN IF NOT EXISTS cluster_edge_verdict   TEXT;
