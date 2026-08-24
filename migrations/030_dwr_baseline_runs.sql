-- 030 — EDGE-DWR-REFRESH-W1 R4
-- The DWR / Directional-Edge scoreboard, one row per (calendar month × barrier spec).
--
-- WHY A TABLE AND NOT A JSON FILE ON THE HOST. R4 asked for "a table or JSON on 204 the digest
-- can read without recomputing". The operator digest runs IN-CONTAINER
-- (`docker exec … node dist/scripts/monitor.js --mode digest`), so a file under /var/lib on the
-- host is NOT reachable from it without a new bind mount. A row in `signal_performance` is
-- reachable by every existing consumer — the digest, the admin endpoints, an ad-hoc psql — with
-- no new plumbing. Measured cost of the alternative: a bind mount + a reader + a parser, all to
-- carry ~20 numbers a month.
--
-- WHY MONTH IS THE KEY, NOT A TIMESTAMP. The point of this table is to make DWR *tracked* rather
-- than *discovered*: the previous baseline was recomputed by hand twice, seven weeks apart, and
-- the second run's numbers were already being cited under the first run's filename. A
-- (run_month, spec) primary key makes the monthly job IDEMPOTENT by construction — a re-run in
-- the same month refreshes that month's row instead of appending a near-duplicate, so a forced
-- verification run cannot inflate the series. `run_ts` still records WHEN the surviving
-- computation happened, so freshness is readable without a second table.
--
-- WHAT THE CI IS, AND WHAT IT IS NOT. `aggregate_dwr_ci_{lo,hi}` is the WILSON interval on the
-- DWR proportion — the only interval the canonical stats module (`src/scripts/edge-stats.ts`)
-- derives. `aggregate_edge` is a POINT estimate (dwr − best directionless benchmark) and
-- deliberately carries no interval: no interval for a difference of two dependent proportions
-- exists in that module, and inventing one here would be a new statistic in a wave whose spec
-- forbids re-derived statistics. Do not "add the missing edge CI" without ratifying the estimator.
--
-- WHAT THE ROLLUPS ARE. `by_venue` / `by_timeframe` are DESCRIPTIVE projections of the same
-- `computeCellStats`, NOT members of the BH-FDR family (see the report module's header). They
-- exist because per-venue label coverage ranges from 100% to 3% — an aggregate hides a venue
-- that is barely labeled next to one that is fully labeled.
--
-- ADDITIVE AND SAFE TO PRE-APPLY: a fresh table with no FK, so it lands ahead of the code that
-- writes it.

CREATE TABLE IF NOT EXISTS dwr_baseline_runs (
  -- YYYY-MM of the run. With `spec`, the idempotency key: one surviving row per month per spec.
  run_month             TEXT NOT NULL,
  -- Barrier spec, e.g. 'tau1.0-floor0.30-v1'. Every spec the report computes gets its own row;
  -- collapsing them to the primary spec would hide that the τ choice moves the powered count.
  spec                  TEXT NOT NULL,
  -- When the surviving computation for this (month, spec) actually ran.
  run_ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL for a full-corpus run; an ISO date when the run was bounded (the healing-only re-run).
  -- A bounded run is NOT the monthly series and must never overwrite it, so the monthly job
  -- always writes the unbounded report.
  window_signals_before TEXT,

  -- Corpus size, so a moved number can always be attributed to corpus growth first.
  corpus_eligible       INTEGER NOT NULL,
  corpus_labeled        INTEGER NOT NULL,
  coverage_pct          DOUBLE PRECISION,

  -- The multiple-testing family and what survived it. `fdr_survivors` is the headline: it is
  -- EXPECTED to be 0, and a 0 here is a successful measurement, not a failed one.
  family_size           INTEGER NOT NULL,
  powered_cells         INTEGER NOT NULL,
  testable_cells        INTEGER NOT NULL,
  constant_side_cells   INTEGER NOT NULL,
  raw_pass              INTEGER NOT NULL,
  fdr_pass              INTEGER NOT NULL,
  bonferroni_pass       INTEGER NOT NULL,
  fdr_survivors         INTEGER NOT NULL,
  verdict               TEXT NOT NULL,

  median_dwr            DOUBLE PRECISION,
  median_edge           DOUBLE PRECISION,

  -- Pooled over every labeled row in the spec. Mixes timeframes and tiers by construction.
  aggregate_n           INTEGER NOT NULL,
  aggregate_decided     INTEGER NOT NULL,
  aggregate_dwr         DOUBLE PRECISION,
  aggregate_benchmark   DOUBLE PRECISION,
  aggregate_edge        DOUBLE PRECISION,
  aggregate_dwr_ci_lo   DOUBLE PRECISION,
  aggregate_dwr_ci_hi   DOUBLE PRECISION,

  by_venue              JSONB NOT NULL,
  by_timeframe          JSONB NOT NULL,
  coverage_by_venue     JSONB NOT NULL,

  PRIMARY KEY (run_month, spec)
);

-- The series read: "how has the primary spec moved month over month?"
CREATE INDEX IF NOT EXISTS idx_dwr_baseline_runs_spec_ts ON dwr_baseline_runs (spec, run_ts DESC);

-- ⚠️ GRANTS ARE PART OF THE MIGRATION (learned on migration 029's first live drain: the table is
-- created by the bootstrap superuser `algovault`, but both the writer and every reader connect as
-- `algovault_app`, which has no privilege on a brand-new table — and the app's own lazy
-- `CREATE TABLE IF NOT EXISTS` path cannot fix that, since it runs as the same unprivileged role).
-- The writer needs INSERT + UPDATE for the monthly upsert; nothing needs DELETE.
GRANT SELECT, INSERT, UPDATE ON dwr_baseline_runs TO algovault_app;
GRANT SELECT ON dwr_baseline_runs TO algovault_autopilot;
