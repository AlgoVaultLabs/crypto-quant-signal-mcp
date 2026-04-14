-- Migration 001: Add regime column to signals table
-- R5 from generator audit 2026-04-14
--
-- The signal generator already computes `regime` (TRENDING_UP / TRENDING_DOWN /
-- RANGING) at scoring time, but historically it was only used in memory to gate
-- direction thresholds and was never persisted. The next audit round needs to
-- correlate regime label → confidence bucket (H5 — is the regime filter over-firing
-- and dragging high-confidence signals down?), which requires the label on every row.
--
-- This migration only affects new rows. Existing rows stay NULL — no backfill.
-- A later audit task can reconstruct regime for historical rows by replaying the
-- classifier against stored OHLCV, but that is out of scope here.
--
-- Safe to run multiple times: `ADD COLUMN IF NOT EXISTS` is idempotent.

ALTER TABLE signals ADD COLUMN IF NOT EXISTS regime TEXT NULL;

-- Sanity check — should return 'regime' in the column list:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'signals' AND column_name = 'regime';
