-- 032 — OPS-HOLD-DECISION-CAPTURE-W1 R1 + R2
--
-- Start the clock on the flagship's only untested claim: "the engine stays silent unless the
-- signal is clear". ~99% of evaluations return HOLD and none of them has ever been measured,
-- because the two fields that would make a HOLD testable are destroyed at the source —
-- `src/tools/get-trade-call.ts:273` takes `Math.abs(rawScore)` before deriving confidence, so the
-- would-be side is gone, and neither `request_log` nor `hold_counts` carries a venue or an entry
-- price. This migration adds the columns that make the decision reconstructible. It changes
-- nothing any caller receives.
--
-- ADDITIVE AND SAFE TO PRE-APPLY. Every new `request_log` column is NULLABLE with no default, so
-- the currently-deployed INSERT (14 columns, `src/lib/analytics.ts:510`) stays valid for the whole
-- window between this DDL and the code that writes them. The two new tables have no FK into any
-- existing table. Per CLAUDE.md §Deploy: CREATE via SSH BEFORE the commit, then the code lands as
-- a no-op against an already-prepared DB.
--
-- ── WHY A SEPARATE ID SPACE, AND WHY THAT IS THE WHOLE POINT ──────────────────────────────────
--
-- HOLD labels are COUNTERFACTUAL: they score a trade the engine deliberately did not make. They
-- must never reach `directional_labels`, which is the corpus behind the DWR baseline
-- (`src/scripts/dwr-baseline-report.ts`) and, downstream, the published track record.
--
-- The contamination hazard is not hypothetical and not a naming preference. `directional_labels`
-- keys on `signal_id -> signals.id`. Measured 2026-08-26: `request_log.id` max ~355,326 and
-- `signals.id` max ~512,391 — the two id spaces NUMERICALLY OVERLAP. A HOLD row inserted into
-- `directional_labels` carrying a `request_log.id` would therefore JOIN SILENTLY to an unrelated
-- acted signal and corrupt the flagship metric with no error, no constraint violation, and no
-- visible symptom. So the label table below keys on `hold_decision_id -> hold_decisions.decision_id`,
-- a dedicated BIGSERIAL space that starts at 1 and belongs to nothing else. The failure mode is
-- made unrepresentable rather than forbidden in prose.
--
-- A second reason the id must be its own: capture happens INSIDE `getTradeSignal`
-- (`get-trade-call.ts:1336`), which runs BEFORE `logRequest` at `src/index.ts:484`. At capture
-- time no `request_log.id` exists yet. And the fleet arm never touches `request_log` at all —
-- `src/scripts/seed-signals.ts` calls `getTradeSignal()` directly.

-- ── R1: four additive columns on the existing request_log write path ──────────────────────────
--
-- Populated for the REQUEST arm only (the tool handler), unsampled, both `is_bot_internal` values.
-- NULL on every row written before this wave, and on every non-HOLD row forever — absence here
-- means "not a captured HOLD", never "capture failed".

-- The side the engine WOULD have chosen had the threshold cleared: sign(rawScore) ∈ {-1, 0, +1},
-- where +1 = BUY, -1 = SELL, 0 = an exactly-zero score (no direction at all).
--
-- IDENTITY — PIN THIS, IT IS NOT THE ONLY rawScore IN THE CODEBASE. This is the POST-adjustment
-- score: the value at `get-trade-call.ts:273` after funding-z (:237-256), Hurst (:259-267) and
-- squeeze (:268-271) have all been applied. It is the value the threshold comparison at :274-277
-- actually reads, and therefore the one that would have chosen the side. B-DIR used the
-- PRE-adjustment score. THEY ARE DIFFERENT NUMBERS. Do not join, compare or pool them.
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS would_be_side SMALLINT;

-- The resolved venue (`route.exchange`, `src/index.ts:482`). Without it no candle series can be
-- chosen, so a barrier race cannot be replayed at all — this single absence is why the claim was
-- unmeasurable rather than merely unmeasured. NULL for equity routes, which are venue-less by
-- construction (`src/lib/market-route.ts:43`) and HOLD-free in practice.
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS exchange TEXT;

-- Market regime at decision time: TRENDING_UP | RANGING | TRENDING_DOWN. Already on
-- TradeCallResult (`get-trade-call.ts:1269`), so this costs no new plumbing. A cell key for the
-- pre-registered analysis.
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS regime TEXT;

-- Entry price at decision time (`result.price`, `get-trade-call.ts:1267`).
--
-- WHY THIS COLUMN EXISTS AT ALL — the spec asked for three fields and this is the fourth.
-- `runTripleBarrier(side, entryPrice, forwardAsc, barrierPct, W)`
-- (`src/scripts/directional-labeler.ts:79-85`) cannot run without an entry price, and a HOLD has
-- none anywhere: `request_log` has no price column, and HOLDs never reach `signals` (recordSignal
-- fires only under `signal !== 'HOLD' && confidence >= 52`, `get-trade-call.ts:1326`), so
-- `signals.price_at_signal` does not exist for any HOLD that has ever occurred.
--
-- The alternative — reconstructing entry from the bar containing the decision timestamp at label
-- time — is free but WRONG HERE: the acted arm records a live adapter price while the HOLD arm
-- would carry a bar close, putting a systematic entry-price difference between the two arms
-- inside the primary comparison. A bias in the instrument is tolerable anywhere except in the
-- one quantity the study exists to measure.
ALTER TABLE request_log ADD COLUMN IF NOT EXISTS price_at_decision DOUBLE PRECISION;

-- Partial index: the analysis only ever reads captured HOLDs, which are a small minority of the
-- table. Partial keeps the index off the ~355k historical rows and off every non-HOLD row.
CREATE INDEX IF NOT EXISTS idx_request_log_hold_capture
  ON request_log (timestamp, exchange, timeframe)
  WHERE would_be_side IS NOT NULL;

-- ── R1: the capture table — the labeling work-list for BOTH arms ──────────────────────────────
--
-- Written at the single HOLD site (`get-trade-call.ts:1336`), which is the only place in the
-- codebase that sees every HOLD: the request path (index.ts -> routeTradeCall -> getTradeSignal)
-- and the fleet path (seed-signals.ts:774 -> getTradeSignal). It fires ~437k times/day, matching
-- the `hold_counts` daily sum (measured 426,922–446,807 over 10 days).
--
-- SAMPLING IS AT CAPTURE, NEVER capture-all-then-sample. The request arm (~3.19k/day) is taken
-- at 100%; the fleet arm (~437k/day) is sampled breadth-first so that distinct (exchange, coin)
-- clusters — the binding constraint on the pre-registered analysis — are maximised rather than
-- depth on a few popular coins.
CREATE TABLE IF NOT EXISTS hold_decisions (
  -- Dedicated id space. See the header: this is a correctness property, not a naming choice.
  decision_id       BIGSERIAL PRIMARY KEY,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Decision-time epoch SECONDS. Mirrors `signals.created_at` so the two arms' barrier replays
  -- index candles the same way; `captured_at` is wall-clock bookkeeping and is NOT interchangeable.
  decided_at        INTEGER NOT NULL,

  coin              TEXT NOT NULL,
  timeframe         TEXT NOT NULL,
  -- NULL only for venue-less (equity) routes.
  exchange          TEXT,
  regime            TEXT,

  -- +1 BUY, -1 SELL, 0 no direction. POST-adjustment sign — see the request_log column above.
  would_be_side     SMALLINT NOT NULL,
  -- The confidence the caller was shown: min(round(|rawScore| / MAX_RAW_SCORE * 100), 100).
  confidence        SMALLINT NOT NULL,
  price_at_decision DOUBLE PRECISION NOT NULL,

  -- 'request' (tool handler) | 'fleet' (seed / batch). Discriminated from `currentCaller()`
  -- (`src/lib/upstream-weight-budget.ts:73`) against an explicit allowlist; anything unrecognised
  -- defaults to 'fleet', so an unknown caller lands in the BOUNDED sampled arm and can never
  -- blow the unsampled budget.
  arm               TEXT NOT NULL,
  -- Only meaningful on the request arm; the algovault-bot accounts for ~91% of it.
  is_bot_internal   BOOLEAN,

  -- WHY THIS COLUMN EXISTS BEFORE IT HAS ANY ROWS. There are TWO HOLD populations and pooling
  -- them biases the analysis:
  --   'below_threshold' — |rawScore| never cleared BUY>40 / SELL>55. The claim's real subject.
  --   'book_liveness'   — the score DID clear, but the book was not trading, so
  --                       `get-trade-call.ts:291-296` forced HOLD *after* the comparison.
  -- The second population is categorically different: those decisions were confident. Live env is
  -- EMIT_BOOK_LIVENESS_MODE=shadow (verified 2026-08-26), so `bookLive` is undefined
  -- (`get-trade-call.ts:1028`) and that branch is DEAD today — which is precisely why the column
  -- goes in now. Adding it after the gate flips would leave a permanently unclassifiable segment
  -- straddling the cutover.
  suppression_reason TEXT NOT NULL,

  -- One capture per decision. The natural key is deliberately NOT (coin, timeframe, exchange,
  -- decided_at): two callers can legitimately request the same cell in the same second and each
  -- is its own decision event.
  CONSTRAINT hold_decisions_side_ck   CHECK (would_be_side IN (-1, 0, 1)),
  CONSTRAINT hold_decisions_arm_ck    CHECK (arm IN ('request', 'fleet')),
  CONSTRAINT hold_decisions_reason_ck CHECK (suppression_reason IN ('below_threshold', 'book_liveness'))
);

-- The labeler's work-list scan: unlabeled rows, oldest first, per venue.
CREATE INDEX IF NOT EXISTS idx_hold_decisions_scan
  ON hold_decisions (exchange, coin, timeframe, decided_at);

-- ── THE SAMPLER IS THIS INDEX. It is not a lookup that supports a sampler; it IS the sampler. ──
--
-- Cell = (UTC day, exchange, coin, timeframe, confidence-decile, regime). UNIQUE + the writer's
-- `ON CONFLICT DO NOTHING` means the FIRST fleet HOLD in each cell each day is captured and every
-- subsequent one is an atomic no-op. Consequences, all of them deliberate:
--
--   * Sampling happens AT capture. Nothing is ever stored and then thinned, which is the failure
--     mode the spec named: a capture-all-then-sample design pays the full 437k/day storage cost
--     to end up with the same rows.
--   * BREADTH-FIRST BY CONSTRUCTION. The binding constraint on the pre-registered analysis is
--     distinct (exchange, coin) CLUSTERS, not row count — measured, the request arm tops out at
--     ~28 distinct assets no matter how long it runs, while the fleet covers ~2,000 coins across
--     17 venues. One row per cell spends the entire budget on width.
--   * RACE-FREE AND UNBIASED. A read-then-insert quota would need an extra round trip per HOLD
--     and would still double-write under concurrency. A deterministic hash prefilter — the
--     obvious cheaper alternative — is WRONG here: hashed on the cell key it is constant per
--     cell, so the same coins would be excluded every single day, turning a sampler into a
--     permanent venue/coin blocklist.
--
--   * N IS STRUCTURALLY 1, NOT A TUNABLE. An env knob cannot express itself in a unique index,
--     and the version of this that "supports N>1" is a read-then-insert with all the properties
--     above given up. Raising N is a migration that changes the cell key (e.g. an hour bucket),
--     which is the honest cost of the change.
--
-- COALESCE, not the bare columns: `exchange` and `regime` are nullable, NULLs compare DISTINCT in
-- a unique index, and NULL-venue rows would therefore bypass the quota entirely and re-admit the
-- firehose through the one gap in the gate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hold_decisions_fleet_cell
  ON hold_decisions (
    (decided_at / 86400),
    COALESCE(exchange, ''),
    coin,
    timeframe,
    (confidence / 10),
    COALESCE(regime, '')
  )
  WHERE arm = 'fleet';

-- ── R2: the quarantined counterfactual labels ─────────────────────────────────────────────────
--
-- Same barrier rule as the published corpus — vol-scaled ±τ·σ with the 0.30% fee floor, evaluated
-- over the published windows — applied to `would_be_side` as the HYPOTHETICAL direction. Shape
-- deliberately mirrors `directional_labels` so the two are comparable, with two differences that
-- are the entire point: the FK targets `hold_decisions`, and there is no `metric_version` because
-- these numbers are INTERNAL and must never be versioned into anything published.
CREATE TABLE IF NOT EXISTS hold_decision_labels (
  -- NEVER `signal_id`. See the header. The FK is declared so the DB itself refuses a row whose
  -- id does not exist in `hold_decisions` — an accidental `signals.id` or `request_log.id` fails
  -- loudly at INSERT instead of joining silently to the wrong row later.
  hold_decision_id  BIGINT NOT NULL REFERENCES hold_decisions(decision_id) ON DELETE CASCADE,
  barrier_spec      TEXT NOT NULL,
  -- -1 loss / 0 timeout / +1 win, relative to `would_be_side`. Same encoding as directional_labels.
  label             SMALLINT NOT NULL,
  ambiguous_candle  BOOLEAN NOT NULL DEFAULT FALSE,
  low_vol_history   BOOLEAN NOT NULL DEFAULT FALSE,
  t_hit_candles     INT,
  mfe_return_pct    DOUBLE PRECISION,
  mae_return_pct    DOUBLE PRECISION,
  barrier_pct       DOUBLE PRECISION NOT NULL,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hold_decision_id, barrier_spec)
);

CREATE INDEX IF NOT EXISTS idx_hold_labels_spec_decision
  ON hold_decision_labels (barrier_spec, hold_decision_id);
