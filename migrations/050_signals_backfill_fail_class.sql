-- 050_signals_backfill_fail_class.sql — OPS-VENUE-MARKET-CLOSED-W2 (the producer classifies each failed attempt)
-- Written 2026-10-30 (live `date -u`).
--
-- WHY. The outcome backfill records a failed attempt with no reason, so the census counter `attempted`
-- (`buildWindowedCensusCounters`, shared by the venue and coin censuses) counted a venue's own refusal
-- (BingX pausing its session-gated NC* markets, `VenueMarketClosedError`) as our failure. Arm 3e of
-- outcome-backfill-freshness then paged `BINGX|NCSKRIG2USD` on 2026-10-30 once the US session opened, for
-- attempts the producer had refused with zero requests. The producer now writes the class ONCE, at attempt
-- time — venue_closed · no_candles · unevaluable · error (`BACKFILL_FAIL_CLASSES`, performance-db.ts) — and
-- `attempted` excludes the exogenous ones.
--
-- NULLABLE WITH NO DEFAULT: catalog-only on PostgreSQL 16 (ACCESS EXCLUSIVE for microseconds, no rewrite of
-- ~1.24M rows), and the deployed INSERT and UPDATEs name their columns, so they keep working across the
-- ALTER. NULL means "attempted before W2 shipped" (or never attempted) and still COUNTS as attempted, so
-- pre-W2 rows keep today's meaning. A DEFAULT would stamp those rows with a class they never had.
-- No new table: ownership (algovault_app) and aoe_readonly's table-level SELECT cover the new column.
--
-- PRE-APPLIED via SSH BEFORE the code lands: the app's migration runner is fire-and-forget, and the census
-- SQL the canary executes names this column, so it must exist before the emitter that writes it deploys.
-- `src/lib/performance-db.ts` SIGNAL_MIGRATIONS mirrors it (a no-op on prod PG; the real owner for the
-- SQLite fixture backend). Rollback: migrations/050_signals_backfill_fail_class.down.sql.
SET lock_timeout = '3s';
BEGIN;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS backfill_fail_class TEXT;
COMMIT;
