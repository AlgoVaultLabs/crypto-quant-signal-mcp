-- 048_regime_snapshots.sql — SCAN-MARKET-REGIMES-W1-V2 CH1
-- The bar-close market-regime snapshot store + its run record.
--
-- regime_snapshots: one row per (venue, timeframe, closed bar, coin) — the get_market_regime
--   classifier's OWN answer for that bar (src/lib/market-regime-core.ts, single derivation), stamped
--   with MARKET_REGIME_RULE_VERSION (never REGIME_RULE_VERSION, which versions scan_trade_calls'
--   3-label classifier). `underlying_session_at_compute` is HISTORY: consumers serving a live
--   session recompute it from asset_class at serve time (V2 §0 Q6). No funding field: funding moves
--   within a bar and stays with the per-coin get_market_regime read.
-- regime_snapshot_runs: one row per (venue, timeframe) per sampler tick — what the producer did
--   with the bar and why. Consumers judge freshness and servability from THIS record only.
--
-- Producer: src/scripts/regime-snapshot-sampler.ts (signal-1 host cron :11, docker exec in the app
--   container). Consumers: src/lib/regime-snapshots.ts readers → scan_market_regimes (CH2) and the
--   regime-snapshot-freshness canary (CH3).
--
-- Append-only, first-write-wins (ON CONFLICT DO NOTHING on each PK). PERMANENT retention on every
-- timeframe (V2 §0 Q2: measured 6.2-8.3 GB/yr, ~3%/yr of free disk; disk-headroom-canary.py is the
-- backstop; the day-30 pg_total_relation_size('regime_snapshots') re-measure is OWED).
-- Pre-applied to prod `signal_performance` via SSH psql BEFORE the code commit, under
-- `SET ROLE algovault_app` so the tables are owned by the app role like every other app table and the
-- role's default ACL grants SELECT to aoe_readonly + algovault_autopilot (the read-only canary roles).
-- IF NOT EXISTS = no-op against the prepared DB; the CREATEs are identical to the lazy ensure in
-- src/lib/regime-snapshots.ts (pinned by tests/unit/regime-snapshots.test.ts).

CREATE TABLE IF NOT EXISTS regime_snapshots (
  exchange                      TEXT             NOT NULL,  -- sampled PROMOTED ExchangeId
  timeframe                     TEXT             NOT NULL,  -- 1h | 4h | 1d
  bar_close_ms                  BIGINT           NOT NULL,  -- close of the classified bar (epoch ms) = generation key
  coin                          TEXT             NOT NULL,  -- bare coin, uppercase
  regime                        TEXT             NOT NULL,  -- TRENDING_UP | TRENDING_DOWN | RANGING | VOLATILE
  confidence                    SMALLINT         NOT NULL,  -- 0-100
  trend_strength                TEXT             NOT NULL,  -- STRONG | MODERATE | WEAK
  adx                           DOUBLE PRECISION,           -- as get_market_regime emits it (1 dp); NULL when unavailable
  adx_slope                     DOUBLE PRECISION,           -- 2 dp; NULL when unavailable
  volatility_ratio              DOUBLE PRECISION NOT NULL,  -- ATR / price (4 dp)
  price_structure               TEXT             NOT NULL,
  asset_class                   TEXT             NOT NULL,  -- resolveAssetClass (shared warm); UNKNOWN when unresolved
  underlying_session_at_compute TEXT             NOT NULL,  -- HISTORY, never served as live
  regime_since_ms               BIGINT,                     -- close of the first bar of the current regime run; NULL until observed
  rule_version                  SMALLINT         NOT NULL,  -- MARKET_REGIME_RULE_VERSION
  computed_at                   BIGINT           NOT NULL,  -- epoch ms
  PRIMARY KEY (exchange, timeframe, bar_close_ms, coin)
);

CREATE TABLE IF NOT EXISTS regime_snapshot_runs (
  exchange       TEXT    NOT NULL,
  timeframe      TEXT    NOT NULL,
  bar_close_ms   BIGINT,          -- the reference bar judged; NULL only when the reference read failed
  tick_at        BIGINT  NOT NULL, -- the sampler run's start (epoch ms), shared by every pair in one run
  disposition    TEXT    NOT NULL CHECK (disposition IN ('COMPLETE','PARTIAL','WINDOW_STALE','NOT_DUE','SKIPPED_BUDGET','FAILED')),
  universe_n     INTEGER NOT NULL DEFAULT 0,
  written_n      INTEGER NOT NULL DEFAULT 0,  -- rows present for the generation after this tick, in-universe
  too_new_n      INTEGER NOT NULL DEFAULT 0,
  window_stale_n INTEGER NOT NULL DEFAULT 0,
  skipped_n      INTEGER NOT NULL DEFAULT 0,
  errors_n       INTEGER NOT NULL DEFAULT 0,
  finished_at    BIGINT  NOT NULL,
  PRIMARY KEY (exchange, timeframe, tick_at)
);

-- latestServableGeneration walks one pair's runs newest-bar-first; the PK cannot serve that order.
CREATE INDEX IF NOT EXISTS idx_regime_snapshot_runs_pair_bar ON regime_snapshot_runs (exchange, timeframe, bar_close_ms, tick_at);

-- Append-only (docs/RUNBOOK-POSTGRES-MAINT.md): an insert-driven autovacuum threshold keeps the
-- visibility map fresh for one-generation reads. Migration-only on purpose — the lazy ensure stays
-- CREATE-only, so no process start ever takes a lock on the table to re-set a storage parameter.
ALTER TABLE regime_snapshots SET (autovacuum_vacuum_insert_scale_factor = 0.05);
