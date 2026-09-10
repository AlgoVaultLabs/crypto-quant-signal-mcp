-- 042 down — FUNNEL-ATTRIBUTION-CLASSIFY-BACKFILL-W1 CH2.
-- Drops the backfill provenance stamp on `signup_attribution`.
--
-- WHAT A ROLLBACK COSTS, STATED PLAINLY. Dropping this column does NOT revert the backfill: the
-- recovered `classification='bot'` and `ua_class` values stay in place, and they become
-- indistinguishable from verdicts the live classifier wrote on the /signup path. The data is not
-- lost, its PROVENANCE is — which is the one thing this column exists to carry.
--
-- It also removes the idempotence key. With the stamp gone,
-- `src/scripts/backfill-signup-attribution-class.ts` would re-scan every row whose
-- `classification` or `ua_class` is still NULL. That re-run is HARMLESS by construction — the
-- projector is pure, the UPDATE re-asserts `classification IS NULL` in its own WHERE, and a
-- second pass over the same UA yields the same verdict — but it is no longer a no-op, so a
-- rollback should be followed by re-applying this migration rather than left standing.
--
-- The forward-safe alternative to a rollback is to leave the column and ignore it: it is
-- nullable, has no default, and no serving path reads it.

ALTER TABLE signup_attribution
  DROP COLUMN IF EXISTS backfilled_at;
