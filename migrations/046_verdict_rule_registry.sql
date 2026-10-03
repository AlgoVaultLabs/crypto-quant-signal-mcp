-- 046_verdict_rule_registry.sql — SIGNAL-VERDICT-RULE-REGISTRY-W1 CH2 (R3 stamps, R4 forward capture)
-- Written 2026-10-03 (live `date -u`). Column names are fixed by the landed registration
-- audits/verdict-rule-registry-preregistration-2026-10-02.md §3; the CH3 gate reads exactly these.
--
-- THE VERDICT RULE BECOMES PER CELL. `TREND_MODE` (one global boolean) is retired; the registry
-- (src/lib/verdict-rule-registry.ts) resolves, per call, which variant of the scoring rule is served
-- in that call's cell (timeframe × confirmed-trend direction) — M today's rule, F fade, H hold — and
-- every row records it:
--   * signals.verdict_rule_version (existing column) becomes a function of the SERVED variant,
--     row-level (ruling Q2 = A): 2 = M, 3 = the served side came from F; 1 is never written again.
--   * rule_config_id (new, on signals AND the emitted arm's sibling) = sha256 of the committed
--     assignment + the kill-switch state, so the forward record is partitionable by configuration.
--   * the emitted arm's sibling gains the forward test's capture, computed at call time from the
--     engine's own locals: the decisive flag, the would-be (negation-off) verdict, each variant's
--     verdict, and the RSI value / pre-negation bucket / funding z that make the decisive flag
--     re-checkable from stored parts.
--
-- ⚠ FORWARD-ONLY. Nothing is backfilled; NULL means "written before the registry". On a row with a
-- non-NULL rule_config_id, a NULL rsi_value (RSI not computable) or funding_z (z below its sample
-- floor) is a measurement, not a gap.
--
-- EVERY COLUMN IS NULLABLE WITH NO DEFAULT: catalog-only on PostgreSQL 16 (ACCESS EXCLUSIVE for
-- microseconds, no rewrite of a live table), and the INSERTs the previously deployed code runs name
-- their columns, so they keep working unchanged across the ALTER. No new table, so ownership and
-- grants are inherited (both tables are owned by algovault_app; aoe_readonly's table-level SELECT
-- covers new columns).
--
-- PRE-APPLIED via SSH BEFORE the code lands — required, not tidiness: the app's migration runner is
-- fire-and-forget, so an INSERT naming a column the background ALTER has not yet added would throw
-- into recordSignal's caller-side catch and lose the signal row. Applied under lock_timeout so a
-- queued ALTER can never stall the serving path's INSERTs behind a long reader; idempotent.
-- `src/lib/performance-db.ts` SIGNAL_MIGRATIONS mirrors these 11 columns (a no-op on prod PG; the
-- real owner for the SQLite fixture backend). Rollback: migrations/046_verdict_rule_registry.down.sql.
SET lock_timeout = '3s';
BEGIN;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS rule_config_id TEXT;
ALTER TABLE signal_scorer_inputs
  ADD COLUMN IF NOT EXISTS rule_config_id TEXT,
  ADD COLUMN IF NOT EXISTS trend_decisive BOOLEAN,
  ADD COLUMN IF NOT EXISTS v1_signal      TEXT,
  ADD COLUMN IF NOT EXISTS v1_raw_final   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS verdict_m      TEXT,
  ADD COLUMN IF NOT EXISTS verdict_f      TEXT,
  ADD COLUMN IF NOT EXISTS verdict_h      TEXT,
  ADD COLUMN IF NOT EXISTS rsi_value      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS rsi_score_pre  SMALLINT,
  ADD COLUMN IF NOT EXISTS funding_z      DOUBLE PRECISION;
COMMIT;
