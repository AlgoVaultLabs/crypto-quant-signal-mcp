-- 033 — EDGE-DWR-VALIDATED-PREDICATE-W1
-- Two columns on `dwr_baseline_runs`, both about the same thing: making a `validated` count
-- SELF-DESCRIBING, so no consumer can render one without knowing which bar produced it.
--
-- WHY predicate_version EXISTS. On 2026-08-26 the `validated` predicate was TIGHTENED: it gained
-- CI separation, W>L, two cost-aware magnitude conditions, and a requirement that the holdout
-- edge be POSITIVE rather than merely the same sign as the full-sample edge. Under the old bar,
-- two live tau=0.5 cells certified — one losing 5,124 of 10,377 races, one with a NEGATIVE edge
-- in both halves of the walk-forward split. Rows written before that day carry the OLD meaning
-- of the word "validated" in the SAME `fdr_survivors` column, and nothing in the row said so.
-- The AOE operator digest reads this table across the pg-tunnel and now REFUSES to render the
-- field unless this column matches the version it was built against — a cross-repo lock that a
-- comment could not provide. This is the discipline `barrier_spec` already carries for the
-- metric; `predicate_version` carries it for the bar.
--
-- WHY THE COLUMN IS NOT NULLABLE, AND WHAT THE BACKFILL SAYS. Every existing row was written by
-- the pre-2026-08-26 predicate, which is a KNOWN fact, not an unknown — so the backfill states
-- it rather than leaving NULL. NULL would be indistinguishable from "a writer forgot", and the
-- digest's version gate would then have to guess.
--
-- WHY verdict_reason EXISTS. The `verdict` domain widens from two values to three. Previously
-- `NO-VALIDATED-EDGE` was emitted both when a real family was tested and nothing survived AND
-- when there was no testable family at all — exit-0 encoding both "verified, clean" and
-- "verified nothing", which the verdict-token law forbids. `INDETERMINATE` now covers the
-- second case and `verdict_reason` says which vacuity it was.
--
--   verdict ∈ { 'EDGE-FOUND', 'NO-VALIDATED-EDGE', 'INDETERMINATE' }
--   verdict_reason ∈ { NULL, 'no_powered_cells' }
--
-- Deliberately NOT a CHECK constraint: migration 030 shipped `verdict` as a bare TEXT, a CHECK
-- added now would have to be re-issued on every future token, and the domain is asserted where
-- it is produced (`dwr-baseline-report.ts`) and where it is consumed (the digest's version gate)
-- rather than rented from the database.
--
-- ADDITIVE AND SAFE TO PRE-APPLY: two ADD COLUMNs, no FK, no rewrite of any existing value.

ALTER TABLE dwr_baseline_runs
  ADD COLUMN IF NOT EXISTS predicate_version TEXT,
  ADD COLUMN IF NOT EXISTS verdict_reason    TEXT;

-- Every pre-existing row was written by the old bar. Stated, not left NULL.
UPDATE dwr_baseline_runs SET predicate_version = 'v1-sign-only-pre-2026-08-26'
 WHERE predicate_version IS NULL;

ALTER TABLE dwr_baseline_runs ALTER COLUMN predicate_version SET NOT NULL;

-- Grants: migration 030's lesson is that a column added later inherits the table's grants, but
-- the table's grants are restated here so a fresh bootstrap that runs 033 standalone is correct.
GRANT SELECT, INSERT, UPDATE ON dwr_baseline_runs TO algovault_app;
GRANT SELECT ON dwr_baseline_runs TO algovault_autopilot;
