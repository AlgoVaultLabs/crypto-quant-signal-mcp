-- 033 down — EDGE-DWR-VALIDATED-PREDICATE-W1
-- Drops only what 033 added. The rows themselves are untouched: reverting the SCHEMA does not
-- revert the BAR, and a `fdr_survivors` count computed under the tightened predicate stays
-- correct — it simply stops being self-describing, which is the state 030 shipped in.
ALTER TABLE dwr_baseline_runs
  DROP COLUMN IF EXISTS predicate_version,
  DROP COLUMN IF EXISTS verdict_reason;
