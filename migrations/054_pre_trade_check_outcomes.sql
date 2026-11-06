-- 054_pre_trade_check_outcomes.sql — DECISION-CALL-V2-W4 CH3
-- What the price did over each logged pre_trade_check's hold: ONE row per check, mechanical, over the
-- decision venue's own observed candles. PRICES ONLY — never a sided return, never a P&L.
--
--   check_id       the pre_trade_checks row (PK and FK: one outcome per check, never two)
--   labeled_at     when the labeler wrote the row
--   venue          the check's decision venue, whose candles were read
--   interval       the served candle step the path was read on (1m to a 24 h hold, 5m to 7 d, 15m beyond)
--   ref_px         the open of the first bar at or after checked_at — the path's own reference
--   end_px         the last bar's close; high_px / low_px the extremes over the hold
--   bracket_first  target | stop | timeout | both_in_one_bar (one bar crossed both); NULL without a stop AND a target
--   liq_touched    did the path reach the isolated liquidation price; NULL without a served liquidation distance
--   status         labeled | unlabelable (the venue still could not serve the hold 7 days after it ended, or never can)
--   reason         why a check is unlabelable; NULL when labeled
--
-- INTERNAL and QUARANTINED. Producer: src/scripts/pre-trade-outcome-labeler.ts (ops/cron/pre-trade-outcome-labeler.sh,
-- nightly on signal-1), the ONLY writer and the only code in src/ that names this table — pinned by
-- tests/unit/pre-trade-outcome-labeler.test.ts. Consumer: the forward-calibration owed read
-- (ops/monitoring/owed-read-pre-trade-odds-forward.py). No published track-record table (signals,
-- directional_labels, /api/performance-public) reads or joins it. Permanent retention.
--
-- Not pre-applied: the labeler runs these exact statements before its work-list, under the app's own role
-- (the table's owner, so the GRANT is the owner's). They are identical (pinned by
-- tests/unit/pre-trade-outcome-labeler.test.ts).

CREATE TABLE IF NOT EXISTS pre_trade_check_outcomes (
  check_id      BIGINT           PRIMARY KEY REFERENCES pre_trade_checks (id),
  labeled_at    TIMESTAMPTZ      NOT NULL,
  venue         TEXT,
  "interval"    TEXT             NOT NULL,
  ref_px        DOUBLE PRECISION,
  end_px        DOUBLE PRECISION,
  high_px       DOUBLE PRECISION,
  low_px        DOUBLE PRECISION,
  bracket_first TEXT             CHECK (bracket_first IN ('target', 'stop', 'timeout', 'both_in_one_bar')),
  liq_touched   BOOLEAN,
  status        TEXT             NOT NULL CHECK (status IN ('labeled', 'unlabelable')),
  reason        TEXT
);

-- The owed read's SELECT, explicit: the default ACL already grants aoe_readonly `r` on algovault_app's
-- tables (migrations/036 measured it), and this is issued anyway, for migration 035's reason — an
-- inherited read privilege is the one discovered missing later. The labeler's ensure runs it too.
GRANT SELECT ON pre_trade_check_outcomes TO aoe_readonly;
