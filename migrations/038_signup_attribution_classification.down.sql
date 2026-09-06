-- 038 down — FUNNEL-TRUTH-AND-PAID-ATTRIBUTION-W1 CH1.
-- Drops the intent-classification columns on `signup_attribution`.
--
-- A rollback degrades the scoreboard LOUDLY rather than silently: `/dashboard/funnel` reads the
-- human INTENT stage through ONE exported predicate (`classification = 'browser'`), so with the
-- column gone the query errors and the stage renders as unavailable with its reason named —
-- instead of quietly falling back to the raw all-classes count this wave exists to retire.
--
-- Data loss is real and one-way: the verdicts were computed from request headers that are never
-- stored, so re-applying 038 cannot reconstruct them. Only the forward series resumes.

ALTER TABLE signup_attribution
  DROP COLUMN IF EXISTS classification,
  DROP COLUMN IF EXISTS ua_class;
