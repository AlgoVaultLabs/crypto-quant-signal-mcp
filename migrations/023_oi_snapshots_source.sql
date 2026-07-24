-- 023_oi_snapshots_source.sql — OPS-BASIS-RETRO-BACKFILL-W1
--
-- Adds a PROVENANCE column so reconstructed basis rows are distinguishable from the live/native
-- stream, and exposes it on the `structural_snapshots` contract view (additive; the pre-registered
-- B-DIR v3 consumer must know a row's origin — retro basis is the hourly kline CLOSE, the live
-- stream is the :17 point sample, and retro rows carry OI/spread NULL by construction).
--
--   source = NULL         ⇔ live/native :17 sampler. The ~397k pre-source rows stay NULL (architect
--                            Q2, 2026-07-24 — "= live/pre-source, documented"); every FUTURE live
--                            write also stays NULL (recordOiSnapshots is byte-unchanged, 9-col).
--   source = 'retro-basis' ⇔ reconstructed from historical mark/index klines (oi + spread NULL —
--                            OI history caps ~30d/venue, order books are not reconstructible).
--
-- Additive + idempotent. Pre-applied on prod `signal_performance` via SSH psql BEFORE the push (the
-- push auto-deploys via GHA — the SCAN-RANKBY-W3 / pre-apply-schema lesson); this file is then a
-- no-op against the prepared DB and converges a fresh box (mirrored by oi-snapshots.ts::ensureTable).

ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS source TEXT;

-- Widen the contract view (additive column only — existing consumers select by name, never *).
CREATE OR REPLACE VIEW structural_snapshots AS
  SELECT exchange AS venue, symbol, ts, oi AS open_interest, contracts_oi AS oi_contracts,
         mark_price, index_price, basis_bps, spread_bps, source
  FROM oi_snapshots;
