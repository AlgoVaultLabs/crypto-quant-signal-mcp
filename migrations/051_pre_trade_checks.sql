-- 051_pre_trade_checks.sql — DECISION-CALL-V2-W1 CH3
-- The pre_trade_check check log: one row per served, billed, non-internal call — what the caller asked,
-- the decision and its venue, every active rule as it was judged, and each venue's figures
-- (Prompt/pre-trade-check-contract-v2.md § Check log).
--
-- INTERNAL — never on a public surface. No equity, no raw license key, no wallet address, no IP column:
-- the caller is caller_ref, a keyed pseudonym of the license key (callerRef in src/lib/lifecycle/identity.ts:
-- HMAC with the estate's IP-hash key under its own `pre-trade-caller-v1:` domain); NULL for a keyless or
-- x402 call.
--
-- Producer: the pre_trade_check row of src/lib/tool-call-pipeline.ts, once the response exists, fail-open
--   (recordPreTradeCheck in src/lib/pre-trade-check-log.ts never throws). The health probe calls the engine
--   directly and never writes.
-- Consumer: src/scripts/pre-trade-health.ts — the log-parity leg (24 h of served non-internal request_log
--   rows against rows here), in a read-only session that ADOPTS the table (to_regclass), never ensures it.
--
-- PERMANENT retention. Not pre-applied: the lazy ensure in src/lib/pre-trade-check-log.ts creates the table
-- and index on the first served call, under the app's own role like every lazily ensured table; IF NOT
-- EXISTS makes this file a no-op after that. The CREATEs are identical (pinned by
-- tests/unit/pre-trade-check-log.test.ts).

CREATE TABLE IF NOT EXISTS pre_trade_checks (
  id               BIGSERIAL        PRIMARY KEY,
  checked_at       TIMESTAMPTZ      NOT NULL,  -- the response's as_of
  rule_version     SMALLINT         NOT NULL,  -- PRE_TRADE_RULE_VERSION the call was judged by
  channel          TEXT             NOT NULL,  -- the pipeline channel: mcp | httpX402
  caller_ref       TEXT,                       -- pc1:<32 hex> pseudonym of the license key; NULL keyless / x402
  coin             TEXT             NOT NULL,
  side             TEXT             NOT NULL,  -- long | short
  size_usd         DOUBLE PRECISION NOT NULL,
  hold_hours       DOUBLE PRECISION NOT NULL,
  timeframe        TEXT             NOT NULL,  -- the regime timeframe
  order_type       TEXT             NOT NULL,  -- market | limit
  leverage         DOUBLE PRECISION,           -- NULL = not sent
  stop_pct         DOUBLE PRECISION,
  target_pct       DOUBLE PRECISION,
  decision         TEXT             NOT NULL,  -- GO | CAUTION | WAIT
  decision_venue   TEXT,                       -- best_venue.exchange; NULL when no venue can take the order
  sigma_1h_pct     DOUBLE PRECISION,
  liq_distance_pct DOUBLE PRECISION,           -- on the decision venue
  ref_mid_px       DOUBLE PRECISION,           -- the decision venue's reference price (top-of-book mid, else mark)
  rules            JSONB            NOT NULL,  -- rules[] as served: {id, source, limit, value, result, detail}
  venues           JSONB            NOT NULL   -- per venue: {exchange, est_cost_bps, round_trip_bps, liq_distance_pct, your_rules}
);

CREATE INDEX IF NOT EXISTS idx_pre_trade_checks_checked_at ON pre_trade_checks (checked_at);
