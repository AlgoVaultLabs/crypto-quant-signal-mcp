-- 005_equities_phase1.sql — EQUITIES-ENGINE-W1 C2
-- US equities daily-bar verdict engine (Databento EQUS.MINI, Phase 1).
-- Pre-applied to prod signal_performance via SSH psql BEFORE the code commit;
-- schema-as-code here is IF NOT EXISTS idempotent (no-op on the prepared DB).
--
-- NOTE: equity_adjustment_factors is intentionally ABSENT — EQUITIES-ENGINE-W1
-- C1 probe found Databento adjustment-factors/corporate-actions require a
-- separate subscription (403 license_reference_dataset_no_subscription) which
-- the usage-based EQUS.MINI plan does not include. Split handling uses the
-- gap-quarantine rule instead (see equity-verdict.ts). Do NOT add this table
-- without a Phase-2 reference-data subscription decision.

CREATE TABLE IF NOT EXISTS equity_bars_daily (
  symbol TEXT NOT NULL,
  session_date DATE NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume BIGINT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);

CREATE TABLE IF NOT EXISTS equity_universe (
  symbol TEXT PRIMARY KEY,
  rank_adv INTEGER,
  adv_usd NUMERIC,
  is_etf BOOLEAN DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equity_verdicts (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  session_date DATE NOT NULL,
  call TEXT NOT NULL CHECK (call IN ('BUY','SELL','HOLD')),
  confidence NUMERIC,
  regime TEXT,
  factors_json TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pfe_horizon_sessions INTEGER,
  pfe_pct NUMERIC,
  outcome_return_pct NUMERIC,        -- INTERNAL ONLY — never exposed via MCP/API/landing
  outcome_filled_at TIMESTAMPTZ,
  UNIQUE (symbol, session_date, engine_version)
);

-- Hot-path index: latest verdict per symbol, and outcome backfill scans.
CREATE INDEX IF NOT EXISTS idx_equity_verdicts_symbol_session
  ON equity_verdicts (symbol, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_equity_verdicts_outcome_pending
  ON equity_verdicts (session_date)
  WHERE outcome_filled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_equity_bars_session
  ON equity_bars_daily (session_date);
