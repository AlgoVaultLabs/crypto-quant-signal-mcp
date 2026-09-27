-- 043_directional_labels_expiry.down.sql — rollback of 043 (EDGE-ADS1-SCORECARD-W1-V2 CH2).
-- Drops the internal expiry column only; no label, barrier or other column is touched.
ALTER TABLE directional_labels DROP COLUMN IF EXISTS ret_at_expiry_pct;
