-- 053_pre_trade_checks_shadow_odds.sql — DECISION-CALL-V2-W4 CH2
-- Shadow no-edge odds on the pre_trade_check log: what a driftless price would do over the order's hold,
-- as the check stood, recalibrated by a pre-registered table. LOGGED, NEVER SERVED (spec §0): the served
-- response and its shape snapshot are unchanged.
--
--   p_timeout       neither bracket barrier within the hold        (null without a stop AND a target)
--   p_target_first  the target before the stop                     (null without a stop AND a target)
--   p_stop_first    max(0, 1 − p_timeout − p_target_first), one derivation from the two logged values
--   p_liq_hold      the isolated liquidation price within the hold (null without a liquidation distance)
--   odds_version    the generated table every value came from (src/lib/pre-trade-odds-calibration.ts);
--                   its pass flags say which field is calibrated — odds-v1: liquidation only
--
-- INTERNAL. Producer: noEdgeOdds (src/lib/pre-trade-calc.ts) inside recordPreTradeCheck
--   (src/lib/pre-trade-check-log.ts), from the served response's own figures, after the response, fail-open.
-- Consumer: the forward-calibration owed read (ops/monitoring/owed-read-pre-trade-odds-forward.py).
--
-- Not pre-applied: the lazy ensure in src/lib/pre-trade-check-log.ts runs this exact statement once per
-- process before its first insert, under the app's own role (the table's owner). Every column is nullable
-- with no default — a catalog-only change — so a row written by code that predates them stays valid and
-- reads NULL. The statements are identical (pinned by tests/unit/pre-trade-check-log.test.ts).

ALTER TABLE pre_trade_checks
  ADD COLUMN IF NOT EXISTS p_timeout      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS p_target_first DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS p_stop_first   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS p_liq_hold     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS odds_version   TEXT;
