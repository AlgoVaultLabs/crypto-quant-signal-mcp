-- 035 — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2
-- Applied to prod 2026-08-30 (live `date -u` at write time).
--
-- Capture the directional calls we HAND OUT and have never recorded.
--
-- `recordSignal` persists only `signal != 'HOLD' AND confidence >= MIN_TRACKABLE_CONFIDENCE (52)`
-- (`src/tools/get-trade-call.ts`). BUY emits at `raw > 40`, i.e. confidence >= 45. So every BUY in
-- the 45–51 band is DELIVERED TO A PAYING CALLER and written nowhere. Measured on `request_log`
-- 2026-08-30: 1368 of 2197 emitted BUYs all-time (62.27%), 39 of 53 (73.58%) over the audit's
-- 3.2252-day window, 468 of 663 (70.59%) trailing 30d. Two consequences — every BUY/SELL share
-- computed from `signals` is a LOWER BOUND, and the published track record covers a subset of
-- what callers actually receive with no public surface saying so.
--
-- The band is SIDE-AGNOSTIC, not BUY-only. SELL emits at confidence >= 62 today, so it is above
-- the gate — but `request_log` carries 2 emitted SELLs below 52 (min confidence 30), and the
-- per-timeframe threshold layer (`getThresholdForTF`, identity today) can move either side. The
-- predicate is therefore `signal != 'HOLD' AND confidence < 52`, never a BUY 45–51 range.
--
-- WE DO NOT KNOW HOW THIS BAND PERFORMS, and that is the entire point. It has never been
-- recorded, so lowering the gate to 45 would move the published win rate by an unknown amount in
-- an unknown direction — a public-number change made blind. Capture first, decide on evidence.
-- Nothing here is included in any published number; the decision is
-- `OPS-TRACK-RECORD-BAND-DECISION-W{NEXT}`, gated on a stated row count of RESOLVED band rows.
--
-- ADDITIVE AND SAFE TO PRE-APPLY. Two brand-new tables, no FK into any existing table, no ALTER
-- of anything the deployed code writes. Per CLAUDE.md §Deploy: CREATE via SSH BEFORE the commit,
-- so the code lands as a no-op against an already-prepared DB and no INSERT can beat a background
-- migration.
--
-- ── THE PROPERTY THIS MIGRATION BUYS, AND WHY IT IS A SEPARATE TABLE ─────────────────────────
--
-- A nullable flag column on `signals` was considered and REJECTED. Both shapes can be made
-- correct; only one makes the failure UNREPRESENTABLE, and the spec's own tiebreaker is
-- "whichever makes accidental inclusion in a public aggregate structurally harder".
--
--   1. NO `FROM signals` QUERY CAN REACH A BAND ROW. Measured 2026-08-30, twelve readers of
--      `signals` reach a public surface and TEN carried no confidence predicate at all —
--      `buildStatsAggregateSql`'s own docstring said "NO confidence filter (enforced at write)".
--      R1 made all ten explicit, but R1 protects the readers that exist TODAY. A separate table
--      protects the ones written next year by someone who never reads this file.
--
--   2. THE MERKLE ANCHOR CANNOT SEE THEM, BY CONSTRUCTION. This is the decisive one.
--      `getUnbatchedSignals()` selects `WHERE signal_hash IS NOT NULL AND merkle_batch_id IS NULL`
--      and `publish-merkle-batch.ts` anchors the result to Base L2. A band row carrying a
--      `signal_hash` would be published ON-CHAIN into the immutable verified record — breaching
--      both the Data Integrity LAW and the no-onchain-publication-without-approval rule, with no
--      undo once the batch is mined. Under a flag column that hazard is held off by remembering
--      to write NULL. Here the columns DO NOT EXIST: `signal_hash`, `merkle_batch_id` and
--      `merkle_proof` are deliberately absent below, so the anchor path cannot select these rows
--      even if every guard above it were deleted.
--
--   3. THE BACKFILL LANE GETS ITS OWN BUDGET. The tracked outcome evaluator
--      (`getSignalsNeedingUnifiedBackfillAsync`, `LIMIT 5000`, oldest-first) fetches venue candles
--      under a shared upstream weight budget, and it feeds the PUBLISHED number. Band capture is
--      estimated at 5.6k–8.9k rows/day against a tracked stream of ~2,820/day, so a shared queue
--      would let a counterfactual measurement starve the published metric's own evaluator. A
--      separate table is a separate queue.
--
-- Prior art: `migrations/032_hold_decision_capture.sql`, whose `hold_decisions` /
-- `hold_decision_labels` pair is the same quarantine shape for the same reason.

-- ── R2: the captured band ────────────────────────────────────────────────────────────────────
--
-- Column-for-column a mirror of `signals` (types included — `price_at_signal` is REAL there and
-- REAL here) MINUS the three Merkle columns. The mirroring is not tidiness: the eventual
-- comparison must be like-for-like, so a band row has to carry exactly the fields a tracked row
-- carries and be evaluated by the same code against the same column shapes. A narrower table
-- would guarantee the comparison measured our schema instead of the band.
CREATE TABLE IF NOT EXISTS band_signals (
  band_id              BIGSERIAL PRIMARY KEY,

  -- Provenance of the CAPTURE (wall clock), distinct from `created_at` (the DECISION instant,
  -- epoch seconds, the same unit and meaning as `signals.created_at`). Two clocks because a
  -- backfilled row and a live-captured row must be distinguishable without inference.
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── the mirror of `signals` ──
  coin                 TEXT NOT NULL,
  signal               TEXT NOT NULL,
  confidence           SMALLINT NOT NULL,
  timeframe            TEXT NOT NULL,
  exchange             TEXT NOT NULL DEFAULT 'HL',
  price_at_signal      REAL NOT NULL,
  created_at           INTEGER NOT NULL,
  regime               TEXT,
  regime_rule_version  SMALLINT NOT NULL DEFAULT 1,
  verdict_rule_version SMALLINT NOT NULL DEFAULT 1,

  -- ── outcome columns, written ONLY by the band lane (BAND_OUTCOME_ENABLED, default off) ──
  -- Identical names and types to `signals` so `computePFEMAE` + `toSignalOutcomeUpdate`
  -- (`src/lib/pfe-mae.ts`) apply verbatim. Reusing the evaluator rather than reimplementing it is
  -- what makes the eventual band-vs-tracked comparison a difference in the DATA rather than an
  -- artifact of two different labellers.
  outcome_price        REAL,
  outcome_return_pct   REAL,
  return_1candle       REAL,
  pfe_price            REAL,
  pfe_return_pct       REAL,
  mae_price            REAL,
  mae_return_pct       REAL,
  pfe_candles          INTEGER,

  -- ── capture-arm provenance (absent from `signals`, and needed here) ──
  -- `request` = a paying caller received this call; `fleet` = the seeder generated it. The
  -- headline claim is about what CALLERS receive, so the two arms must be separable at analysis
  -- time. `request_log` sees only the request arm and `seed-signals.ts` never touches it, so the
  -- distinction exists nowhere else.
  arm                  TEXT NOT NULL,
  is_bot_internal      BOOLEAN,

  -- ⚠ NO signal_hash. NO merkle_batch_id. NO merkle_proof. See property 2 above. Adding any of
  -- the three re-opens the on-chain publication path for rows that must never be published.

  CONSTRAINT band_signals_signal_ck CHECK (signal IN ('BUY', 'SELL')),
  CONSTRAINT band_signals_arm_ck    CHECK (arm IN ('request', 'fleet')),

  -- The band IS this predicate. A row at or above the recording gate belongs in `signals`, and
  -- misfiling one here would quietly build a comparison corpus that overlaps the published one.
  -- The literal mirrors `MIN_TRACKABLE_CONFIDENCE` in `src/lib/published-population.ts`;
  -- `tests/unit/band-signal-capture.test.ts` reads this file and fails if the two ever disagree,
  -- so the duplication is pinned rather than trusted.
  CONSTRAINT band_signals_below_gate_ck CHECK (confidence >= 0 AND confidence < 52)
);

-- Scan index for the outcome/label lane and for the per-(venue, coin, timeframe) analysis.
CREATE INDEX IF NOT EXISTS idx_band_signals_scan
  ON band_signals (exchange, coin, timeframe, created_at);

-- The backfill lane's work queue: un-evaluated rows, oldest first. Partial, because the lane only
-- ever asks for rows with no outcome yet and the table is expected to be dominated by evaluated
-- rows within days of the flag going live.
CREATE INDEX IF NOT EXISTS idx_band_signals_pending_outcome
  ON band_signals (created_at) WHERE outcome_price IS NULL;

-- ── R2: counterfactual labels, quarantined from the published corpus ─────────────────────────
--
-- Keys on `band_id -> band_signals.band_id`, NEVER `signal_id`. This is migration 032's warning
-- carried across, and it is a measurement, not a naming preference: `request_log.id` (~355k) and
-- `signals.id` (~524k) NUMERICALLY OVERLAP, so an id from the wrong space inserted into
-- `directional_labels` would JOIN SILENTLY to an unrelated acted signal and corrupt the flagship
-- metric with no error, no constraint violation and no visible symptom. `band_id` is a third
-- dedicated BIGSERIAL space starting at 1 and belonging to nothing else; the declared REFERENCES
-- makes a wrong id fail loudly at INSERT instead of joining wrongly at SELECT.
--
-- `directional_labels` is the corpus behind the DWR baseline (`src/scripts/dwr-baseline-report.ts`)
-- and, downstream, the published track record. Band labels must never reach it.
CREATE TABLE IF NOT EXISTS band_signal_labels (
  band_id           BIGINT NOT NULL REFERENCES band_signals(band_id) ON DELETE CASCADE,
  barrier_spec      TEXT NOT NULL,
  label             SMALLINT NOT NULL,
  ambiguous_candle  BOOLEAN NOT NULL DEFAULT FALSE,
  low_vol_history   BOOLEAN NOT NULL DEFAULT FALSE,
  t_hit_candles     INT,
  mfe_return_pct    DOUBLE PRECISION,
  mae_return_pct    DOUBLE PRECISION,
  barrier_pct       DOUBLE PRECISION NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (band_id, barrier_spec)
);

CREATE INDEX IF NOT EXISTS idx_band_labels_spec_band
  ON band_signal_labels (barrier_spec, band_id);

-- ── OWNERSHIP — MEASURED FAILURE, NOT A PRECAUTION ───────────────────────────────────────────
--
-- The app connects as `algovault_app`; `psql -U algovault` (the bootstrap superuser) is how an
-- operator applies this file. A table created that way is OWNED BY `algovault`, and every
-- sibling — `signals`, `hold_decisions` — is owned by `algovault_app`. The consequence, measured
-- on prod 2026-08-30 immediately after this migration was first applied:
--
--   * every capture INSERT failed on privilege and was swallowed by the writer's fail-open path,
--     so the seam looked deployed and healthy while writing NOTHING for 14 minutes;
--   * the schema-as-code mirror's `CREATE INDEX IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`
--     logged `must be owner of table band_signals` on every boot — the only visible symptom, and
--     it named the cause exactly.
--
-- The band corpus is the one thing this wave exists to produce, and "zero rows" is also what a
-- genuinely quiet window looks like, so a silent privilege failure here is indistinguishable from
-- a correct measurement. Hence: state ownership explicitly rather than inheriting it from
-- whoever ran the file. Guarded on role existence so a fresh deploy without the app role still
-- applies cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'algovault_app') THEN
    EXECUTE 'ALTER TABLE band_signals       OWNER TO algovault_app';
    EXECUTE 'ALTER TABLE band_signal_labels OWNER TO algovault_app';
    EXECUTE 'ALTER SEQUENCE band_signals_band_id_seq OWNER TO algovault_app';
  END IF;
END $$;

-- The monitoring role reads, never writes. Mirrors the grant migration 034 established for the
-- funnel tables; a table the autopilot cannot read is INVISIBLE to a canary rather than absent,
-- so the grant ships with the table instead of being discovered missing later. Granted AFTER the
-- ownership transfer above, because a GRANT must be issued by the owner.
GRANT SELECT ON band_signals, band_signal_labels TO algovault_autopilot;
