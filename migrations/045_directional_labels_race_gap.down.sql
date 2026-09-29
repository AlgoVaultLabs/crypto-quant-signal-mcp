-- 045_directional_labels_race_gap.down.sql — rollback of 045 (EDGE-LABELER-RACE-WINDOW-V2-W1 CH2).
-- Drops the provenance column only; no label, barrier or other column is touched.
ALTER TABLE directional_labels DROP COLUMN IF EXISTS race_gap_candles;
