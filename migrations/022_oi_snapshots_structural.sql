-- 022_oi_snapshots_structural.sql — OPS-STRUCTURAL-FEATURE-ACCRUAL-W1
--
-- Widens the LIVE OI stream into the full structural feature tuple (mark · index · basis · spread)
-- and makes its retention PERMANENT. It does NOT create a second table: the spec's pinned design
-- called for a new `structural_snapshots` with its own hourly cron at :37, but Plan-Mode probing
-- found `oi_snapshots` already accruing hourly since 2026-06-26 (318,660 rows / 10 venues) on the
-- :17 line. A parallel stream would have doubled venue load and created a SECOND OI derivation
-- against this module's own "ONLY OI fetcher" contract. Architect-confirmed Path A, 2026-07-21.
--
-- Producer: src/scripts/oi-snapshot-sampler.ts (hourly, all 12 promoted venues).
-- Consumers today: computeOiDelta(ForPool) — the oi_change lens + the get_trade_call OI factor.
-- Consumers pre-registered: B-DIR v3 diagnostic (~2026-10-19), B-DIR v3 full (~2027-01-17),
--   carry ranker v2, AVS certified examples — all via the `structural_snapshots` VIEW below.
--
-- Field provenance (live-probed host-side 2026-07-21; full census in
-- audits/OPS-STRUCTURAL-FEATURE-ACCRUAL-W1-endpoint-truth.md §2):
--   mark_price  — venue-native mark (HL markPx · Bybit/Bitget/KuCoin markPrice · Gate mark_price ·
--                 MEXC fairPrice · Phemex markPriceRp · Binance/Aster/BingX premiumIndex.markPrice ·
--                 OKX public/mark-price). HTX exposes NO bulk mark endpoint => permanently NULL,
--                 counted in the coverage report. NEVER substituted from `close` (a last-trade
--                 price is not a mark price).
--   index_price — the venue's OWN index/oracle price. There is no spot-price path in this repo
--                 (all 17 adapters are perps-only), so basis is venue-native index, never a spot
--                 lookup and never another venue's index.
--   basis_bps   — (mark - index)/index * 1e4. NULL unless BOTH sides are strictly-positive finite.
--   spread_bps  — (ask - bid)/mid * 1e4, mid = (ask+bid)/2. NULL unless both sides present.
--                 A crossed/locked book yields a value <= 0 on purpose: that is real microstructure.
--
-- Pre-applied to prod `signal_performance` via SSH psql BEFORE the code push (the push
-- auto-deploys via GHA — the SCAN-RANKBY-W3 lesson); every statement is idempotent, so this file
-- is a no-op against the prepared DB and converges a fresh box.

-- ── 1. The four structural columns ───────────────────────────────────────────────────────────
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS mark_price  DOUBLE PRECISION;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS index_price DOUBLE PRECISION;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS basis_bps   DOUBLE PRECISION;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS spread_bps  DOUBLE PRECISION;

-- ── 2. `oi` becomes NULLABLE ─────────────────────────────────────────────────────────────────
-- ASTER + BINGX expose no bulk OI (their notionalOI_usd is a 24h-VOLUME proxy) but DO expose real
-- mark/index/bid/ask. A row with oi NULL is the HONEST representation of "structural yes, OI no" —
-- the alternative (recording volume as OI) is exactly the mislabeling OI_PROXY_VENUES exists to
-- prevent. The notional read path gained a matching `AND oi IS NOT NULL` guard.
ALTER TABLE oi_snapshots ALTER COLUMN oi DROP NOT NULL;

-- ── 3. Retention is PERMANENT — index the read path accordingly ──────────────────────────────
-- computeOiDeltaForPool filters `exchange = $1 AND ts >= $2` with NO symbol predicate, so the
-- (exchange, symbol, ts) PK cannot range-scan ts — it walks every index entry for the venue. That
-- was survivable while the sampler pruned at 30 days; with retention permanent the table grows
-- ~382k rows (~90 MB)/month, so the read needs its own index.
CREATE INDEX IF NOT EXISTS idx_oi_snapshots_exch_ts ON oi_snapshots (exchange, ts);

-- ── 4. Drop the duplicate index (Q8) ─────────────────────────────────────────────────────────
-- `idx_oi_snapshots_exch_sym_ts` (migrations/011) is byte-identical to `oi_snapshots_pkey` — both
-- btree (exchange, symbol, ts). A pure duplicate costing ~half the table's index storage, which
-- compounds under permanent retention. Rider checked: no consumer names it (grep over
-- src/tests/scripts/migrations found only its own CREATE + the lazy ensure, both removed).
-- ROLLBACK: CREATE INDEX idx_oi_snapshots_exch_sym_ts ON oi_snapshots (exchange, symbol, ts);
DROP INDEX IF EXISTS idx_oi_snapshots_exch_sym_ts;

-- ── 5. The `structural_snapshots` contract name, as a VIEW ───────────────────────────────────
-- The spec asked for a table by this name; a view gives future consumers that contract without a
-- second physical stream, a second OI derivation, or breaking the three live consumers of
-- `oi_snapshots`. `venue`/`open_interest` match the spec's column names.
CREATE OR REPLACE VIEW structural_snapshots AS
  SELECT exchange AS venue, symbol, ts, oi AS open_interest, contracts_oi AS oi_contracts,
         mark_price, index_price, basis_bps, spread_bps
  FROM oi_snapshots;
