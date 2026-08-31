-- 036 — OPS-SCORER-INPUT-PERSISTENCE-W1 R1
-- Applied to prod 2026-08-31 (live `date -u` at write time).
--
-- STOP THROWING AWAY THE INGREDIENTS.
--
-- The scorer computes five indicator bucket values, multiplies each by its weight, sums them,
-- then applies funding / Hurst / squeeze adjustments. We persist the TOTAL. We discard the PARTS.
-- `hold_decisions` captures the post-adjustment side and the confidence the caller was shown;
-- `signals` captures the confidence; nothing anywhere stores `raw0` or the per-adjustment deltas.
-- Verified 2026-08-31 against BOTH the committed schema-as-code and the LIVE prod catalog: zero
-- scorer columns exist on any table.
--
-- Three waves have hit this wall. EDGE-SCORING-LADDER-REDESIGN-W1 §3.1 recorded it as a
-- first-order finding: this estate cannot backtest any scoring change against its own history.
-- And it blocks the one question worth asking — EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1 measured
-- sub-threshold SELL reads at chance across every band (DWR 0.467–0.514 vs random ~0.495), so
-- score magnitude and directional accuracy are unlinked for SELL. The follow-up — WHICH
-- INGREDIENT, IF ANY, CARRIES SIGNAL — needs the ingredients.
--
-- ⚠ THIS CAPTURE IS FORWARD-ONLY. Nothing can be backfilled, because the inputs were never
-- written down. Attribution becomes possible N days after this ships, never before. This wave
-- does NOT improve DWR and must not be described as if it does; it makes the diagnosis possible.
--
-- ── WHY THIS SHAPE, AND WHY IT IS NOT THE ONE THE SPEC FIRST PRESCRIBED ──────────────────────
--
-- The spec said "sibling tables" for all three arms, on migration 035's structural argument. That
-- is unbuildable here, and the reason is worth recording because it will come up again: ALL THREE
-- writers are `void` fire-and-forget with no `RETURNING` — `recordSignal`
-- (`src/lib/performance-db.ts`), `recordHoldDecision` (`src/lib/hold-decision-capture.ts`) and
-- `recordBandSignalCapture`. A child table can therefore obtain NO foreign key to any parent
-- without adding an awaited DB round-trip to the serving path, which would break the byte-
-- identical-latency requirement. And migration 032's header already forbids the natural-tuple
-- fallback: two callers can legitimately request the same cell in the same second.
--
-- Ratified 2026-08-31, the shape is MIXED, and it is correct rather than a compromise:
--
--   * COLUMNS on `hold_decisions` and `band_signals`. Both are ALREADY quarantined sibling
--     tables with their own dedicated id spaces, unreachable by `FROM signals`, carrying no
--     `signal_hash` and therefore outside the anchor path by construction. `hold_decisions` is
--     additionally covered by `tests/unit/counterfactual-quarantine.test.ts`. The parts land in
--     the SAME ROW as the decision, so there is no join to get wrong and no fourth id space to
--     collide with the three that already overlap numerically.
--   * ONE NEW SIBLING `signal_scorer_inputs` for the emitted arm only. `signals` is the ANCHORED
--     table and is NOT TOUCHED by this migration.
--
-- ON THE ANCHOR, since it is the question that gated the whole design: `hashSignal()`
-- (`src/lib/merkle.ts`) is `keccak256(encodePacked(...))` over an EXPLICIT, ENUMERATED six-field
-- preimage — coin, signal, confidence, timeframe, timestamp, price — built from a struct literal
-- at the call site, never from a row or a serialisation. A new column could not have changed any
-- leaf. So a column on `signals` was PERMITTED and was still declined: the anchor argument is not
-- the only one, and "unreachable by `FROM signals`" is the one that protects readers written next
-- year by someone who never reads this file.

-- ── R1a: the parts, on the two already-quarantined sibling tables ────────────────────────────
--
-- EVERY COLUMN IS NULLABLE AND CARRIES NO DEFAULT. That is a hard requirement, not tidiness:
-- `hold_decisions` holds 628,423 rows and `band_signals` is on the live serving path. A DEFAULT
-- would risk a table rewrite; nullable-without-default is a catalog-only change that takes an
-- ACCESS EXCLUSIVE lock for microseconds. NULL means "written before capture shipped" and never
-- "capture failed" — the same convention migration 032 established for its request_log columns.
--
-- The column set is IDENTICAL on all three surfaces below, deliberately, so the identity gate can
-- UNION them and judge one shape rather than three.

-- The five indicator bucket values, as produced by `computeIndicatorScores` and consumed by
-- `deriveVerdict`. SMALLINT because every ladder is integer-valued and bounded by [-100, +100]:
--   rsi    {100, 80, 40, 0, -40, -80, -100}   x 0.30      (negated under TREND_MODE)
--   ema    {100, 0, -100}                     x 0.10
--   funding{80, 40, 0, -40, -80}              x 0.25
--   oi     {60, 20, 0, -20, -60}              x 0.15   <- note the max is 60, not 100
--   volume {100, 80, 50, 10, -30, -70}        x 0.20
-- Whence MAX_RAW_SCORE: 30 + 10 + 20 + 9 + 20 = 89. Re-derived here rather than quoted, because
-- that constant is PUBLIC COPY (the confidence divisor) and a stale restatement of it would be a
-- numerical-citation violation waiting to happen.
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS rsi_score            SMALLINT;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS ema_score            SMALLINT;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS funding_score        SMALLINT;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS oi_score             SMALLINT;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS volume_score         SMALLINT;

-- `raw0` = SUM(bucket_i * WEIGHTS_i) BEFORE any adjustment. DOUBLE PRECISION, not REAL: the
-- identity gate asserts the parts reproduce this value, and REAL's 24-bit mantissa would put the
-- storage error above the tolerance the assertion is worth making at.
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS raw0                 DOUBLE PRECISION;

-- The three adjustment deltas, INDIVIDUALLY. Capturing only the total would leave the chain
-- half-observable and repeat the very defect this migration exists to fix, one level up.
--
-- Each is a DIFFERENCE of the running score at a stage boundary inside `deriveVerdict`, never a
-- recomputation, so `raw0 + funding_delta + hurst_delta + squeeze_delta = raw_final` holds by
-- construction. Hurst and squeeze are SIGN-PRESERVING amplifiers reading the score's sign at
-- their own stage, so their deltas are only interpretable in this order — do not reorder them.
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS funding_delta        DOUBLE PRECISION;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS hurst_delta          DOUBLE PRECISION;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS squeeze_delta        DOUBLE PRECISION;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS raw_final            DOUBLE PRECISION;

-- ── The branch codes, and the test that says they are REQUIRED ───────────────────────────────
--
-- RULE: a branch code is required wherever the stage's net delta is NOT INJECTIVE onto its branch
-- set — where two branches, or two branch COMBINATIONS, can emit the same net number. The test
-- was run for all three stages on 2026-08-31 against the live ladder. ALL THREE FAIL:
--
--   FUNDING — two distinct branches emit +10 (the z-present contrarian bonus at z < -1.5, and the
--     z-null raw fallback at annualized < -4.38). Separately, because sellSofteningZ (-2.0) sits
--     BELOW the contrarian gate (-1.5), any z that softens a SELL also satisfies the contrarian
--     branch, so when softening flips the score positive BOTH fire and the net is +30 — a value
--     no single branch produces.
--   HURST — `hurstVal IS NULL` (not evaluated) and 0.45 <= h <= 0.55 (evaluated, neutral) both
--     emit 0. This is the most valuable of the three: Hurst is dead on 5 of 8 venues
--     (EDGE-SCORING-LADDER-REDESIGN-W1 §1.5), so WHETHER it fired is itself a per-venue finding,
--     and a bare 0 destroys it.
--   SQUEEZE — no squeeze, and a squeeze DETECTED then suppressed by the |raw| > 10 magnitude
--     guard, both emit 0. Different facts about the market.
--
-- STORAGE COST OF ALL THREE: ZERO BYTES. Five SMALLINTs occupy 10 bytes and must pad to 16 for
-- the DOUBLE PRECISION run that follows; three more SMALLINTs fill that padding exactly. A
-- property of Postgres alignment, measured rather than assumed.
--
-- Values are defined ONCE in `src/lib/scorer-input-codes.ts` and are not restated here — a
-- second copy of an encoding is a second definition of what a captured row means.
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS funding_adjust_code  SMALLINT;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS hurst_adjust_code    SMALLINT;
ALTER TABLE hold_decisions ADD COLUMN IF NOT EXISTS squeeze_adjust_code  SMALLINT;

-- Same thirteen on the band arm. Band rows are DELIVERED to paying callers — they are emitted
-- calls that merely miss the recording gate — and their parts were discarded identically. The
-- binding reason to do it in this wave rather than a successor is that capture is forward-only:
-- an arm omitted now is permanently lost, and this is precisely where
-- OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 established we had a blind spot.
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS rsi_score            SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS ema_score            SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS funding_score        SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS oi_score             SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS volume_score         SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS raw0                 DOUBLE PRECISION;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS funding_delta        DOUBLE PRECISION;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS hurst_delta          DOUBLE PRECISION;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS squeeze_delta        DOUBLE PRECISION;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS raw_final            DOUBLE PRECISION;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS funding_adjust_code  SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS hurst_adjust_code    SMALLINT;
ALTER TABLE band_signals   ADD COLUMN IF NOT EXISTS squeeze_adjust_code  SMALLINT;

-- ── R1b: the emitted arm's sibling table ─────────────────────────────────────────────────────
--
-- ⚠ NO signal_hash-bearing row is added to `signals`, and this table carries NO `merkle_batch_id`
-- and NO `merkle_proof`. `getUnbatchedSignals()` selects `FROM signals WHERE signal_hash IS NOT
-- NULL AND merkle_batch_id IS NULL` and `publish-merkle-batch.ts` anchors the result to Base L2.
-- This table is not `signals`, so that query cannot reach it — by construction, not by a guard
-- someone has to remember. It holds `signal_hash` only as a JOIN KEY back to the parent.
CREATE TABLE IF NOT EXISTS signal_scorer_inputs (
  scorer_input_id      BIGSERIAL PRIMARY KEY,

  -- Wall-clock capture stamp, distinct from `decided_at` (the DECISION instant, epoch seconds,
  -- the same unit and meaning as `signals.created_at`). Two clocks, because a row captured live
  -- and a row captured by any future lane must be distinguishable without inference.
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at           INTEGER NOT NULL,

  -- ── the join key back to the anchored parent ──
  --
  -- NO FOREIGN KEY, and the reason is the shape of the parent's writer, not an oversight:
  -- `recordSignal` is fire-and-forget, so the parent INSERT is not ordered with respect to this
  -- one and a declared REFERENCES could fail spuriously on a row that is about to exist. Stated
  -- rather than hidden, because migration 032's whole point is that a declared FK is what makes a
  -- wrong id fail loudly, and this arm does not get that protection.
  --
  -- MEASURED, 2026-08-31, on 530,577 live rows:
  --   * `signals.signal_hash` is NULL on ZERO rows — all-time, trailing-30d and trailing-7d.
  --     The spec assumed nulls exist because `getUnbatchedSignals` filters `IS NOT NULL`; that
  --     filter is defensive (the writer's parameter is optional) and has never yet excluded a
  --     row. UNJOINABLE FRACTION OF THE EMITTED ARM: 0.0000%.
  --   * 1,407 hashes are shared by more than one row (2,906 rows, 0.548%, worst group 4).
  --     1,400 of those groups are identical on exchange, regime AND created_at with CONSECUTIVE
  --     ids — the same decision written twice, whose parts are by definition identical, so
  --     collapsing them is lossless and prevents a cartesian fan-out inflating any future
  --     aggregate.
  --   * BUT 5 groups differ by EXCHANGE. `hashSignal`'s preimage does not include the venue, so
  --     two genuinely different decisions on two venues CAN collide on one hash — and their
  --     bucket vectors differ, because different venues mean different candles. Under a
  --     `UNIQUE (signal_hash)` one of them would silently lose its parts: a capture defect of
  --     exactly the class this wave exists to prevent, small today and structurally unbounded.
  --
  -- Hence the key is `(signal_hash, exchange)`. It still collapses all 1,400 true double-writes,
  -- keeps the 5 cross-venue collisions as distinct rows, and — being strictly more selective than
  -- the hash alone — prevents the fan-out MORE completely, not less.
  signal_hash          TEXT NOT NULL,

  -- ── self-describing identity, so the corpus is analyzable without joining `signals` ──
  -- Carried deliberately: the attribution this table exists for is cell-conditional (venue,
  -- regime, arm), and a corpus that can only be read through a join to the anchored table
  -- invites exactly the join into the published population that the quarantine forbids.
  coin                 TEXT NOT NULL,
  signal               TEXT NOT NULL,
  confidence           SMALLINT NOT NULL,
  timeframe            TEXT NOT NULL,
  exchange             TEXT NOT NULL,
  regime               TEXT,

  -- `request` = a paying caller received this call; `fleet` = the seeder generated it. Resolved
  -- inside the writer from `currentCaller()`, never guessed at the call site — the same contract
  -- as `hold_decisions.arm` and `band_signals.arm`.
  arm                  TEXT NOT NULL,
  is_bot_internal      BOOLEAN,

  -- The parts are only comparable WITHIN one verdict-rule generation: TREND_MODE flips the RSI
  -- ladder's sign in the saturated region, which changes what a given `rsi_score` MEANS. Stamped
  -- from the flag's live value at write time by `currentVerdictRuleVersion()`, never a build
  -- constant — the flag moves with no deploy and no diff.
  verdict_rule_version SMALLINT NOT NULL DEFAULT 1,

  -- ── the parts: identical shape to the two ALTERed tables above ──
  rsi_score            SMALLINT NOT NULL,
  ema_score            SMALLINT NOT NULL,
  funding_score        SMALLINT NOT NULL,
  oi_score             SMALLINT NOT NULL,
  volume_score         SMALLINT NOT NULL,
  raw0                 DOUBLE PRECISION NOT NULL,
  funding_delta        DOUBLE PRECISION NOT NULL,
  hurst_delta          DOUBLE PRECISION NOT NULL,
  squeeze_delta        DOUBLE PRECISION NOT NULL,
  raw_final            DOUBLE PRECISION NOT NULL,
  funding_adjust_code  SMALLINT NOT NULL,
  hurst_adjust_code    SMALLINT NOT NULL,
  squeeze_adjust_code  SMALLINT NOT NULL,

  -- NOT NULL is safe on a brand-new table (nothing to rewrite) and is the stronger statement:
  -- on THIS arm a row exists only because the writer had every part in hand, so a NULL here
  -- would mean a writer bug rather than a pre-capture row. The two ALTERed tables cannot make
  -- that claim and are correctly nullable there.
  CONSTRAINT signal_scorer_inputs_signal_ck CHECK (signal IN ('BUY', 'SELL')),
  CONSTRAINT signal_scorer_inputs_arm_ck    CHECK (arm IN ('request', 'fleet'))
);

-- The dedupe key. Paired with `ON CONFLICT DO NOTHING` in the writer: FIRST write wins, every
-- subsequent one is an atomic no-op. See the `signal_hash` comment for the measurement that
-- chose the composite over the bare hash.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_scorer_inputs_hash_exchange
  ON signal_scorer_inputs (signal_hash, exchange);

-- The attribution scan: per-venue, per-cell, oldest-first — the shape
-- EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT} reads.
CREATE INDEX IF NOT EXISTS idx_signal_scorer_inputs_scan
  ON signal_scorer_inputs (exchange, coin, timeframe, decided_at);

-- ── OWNERSHIP — MEASURED FAILURE, NOT A PRECAUTION ───────────────────────────────────────────
--
-- The app connects as `algovault_app`; this file is applied over SSH as the bootstrap superuser
-- `algovault`. A table created that way is OWNED BY `algovault` and `algovault_app` gets nothing,
-- so every capture INSERT is refused, the refusal is swallowed by the writer's fail-open path,
-- and the outcome is an empty table with a green deploy and no alert. That is not hypothetical:
-- it happened to migration 032 on 2026-08-26 (zero rows against 154,216 HOLDs on the same code
-- path) and again to migration 035 on 2026-08-30 (14 minutes of silent refusals). "Zero rows" is
-- also what a genuinely quiet window looks like, which is why a silent privilege failure here is
-- indistinguishable from a correct measurement. Guarded on role existence so a fresh deploy
-- without the app role still applies cleanly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'algovault_app') THEN
    EXECUTE 'ALTER TABLE signal_scorer_inputs OWNER TO algovault_app';
    EXECUTE 'ALTER SEQUENCE signal_scorer_inputs_scorer_input_id_seq OWNER TO algovault_app';
  END IF;
END $$;

-- ── READ ACCESS FOR THE IDENTITY CANARY — and the role choice is a measurement ───────────────
--
-- MEASURED 2026-08-31 with `has_table_privilege`, because a table a canary cannot read is
-- INVISIBLE to it rather than absent, and a gate that silently sees two of three arms would print
-- a green PASS having never checked the arm carrying 94% of the corpus:
--
--            role                 signals   hold_decisions   band_signals
--            aoe_readonly            t            t               t
--            algovault_autopilot     t            f               t
--
-- So the R3 canary runs as `aoe_readonly`, which is also what 3 of the 5 existing monitoring
-- consumers use. That choice needs NO privilege change anywhere: in particular it does not widen
-- access to the quarantined counterfactual store, which an `algovault_autopilot` canary would
-- have required. Recorded here so the next canary author does not pick the other role and get a
-- silently partial gate.
--
-- The explicit GRANTs below are redundant against the default ACLs on this database (both roles
-- already receive `r` on tables created by `algovault` and `algovault_app`) and are issued anyway,
-- for the reason migration 035 states: inheriting a privilege is a thing you discover missing
-- later, and both prior capture tables shipped a silent privilege failure. Issued AFTER the
-- ownership transfer, because a GRANT must come from the owner.
GRANT SELECT ON signal_scorer_inputs TO algovault_autopilot;
GRANT SELECT ON signal_scorer_inputs TO aoe_readonly;
