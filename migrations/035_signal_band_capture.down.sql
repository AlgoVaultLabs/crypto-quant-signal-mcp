-- 035 DOWN — OPS-SIGNAL-PERSISTENCE-BAND-CAPTURE-W1 R2
--
-- ⚠ THIS DESTROYS THE CAPTURE CORPUS AND IT CANNOT BE REBUILT.
--
-- `band_signals` is the ONLY record of the directional calls the engine emitted below the
-- recording gate. `signals` never received them, `hold_counts` counts only HOLDs, and
-- `request_log` sees the request arm alone — it never observes the fleet, which is the larger
-- population by orders of magnitude. Dropping these tables therefore does not "revert to the
-- previous state"; it deletes measurements of decisions that will never be made again, and
-- restarts the successor wave's clock (`OPS-TRACK-RECORD-BAND-DECISION-W{NEXT}` is gated on a
-- stated row count of RESOLVED band rows) from zero.
--
-- Before running this, prefer: stop the writer. The capture seam in `src/tools/get-trade-call.ts`
-- is a leaf `else` branch inside its own try/catch and removing it is a one-file change with no
-- schema impact — the rows already captured stay readable and the successor keeps its corpus.
-- Dropping the tables is the right move only when the DECISION has been made and recorded, or
-- when the capture is being abandoned deliberately with that loss understood and accepted.
--
-- No public number depends on either table, by construction: nothing that feeds a published
-- surface reads them, and neither carries `signal_hash` / `merkle_batch_id` / `merkle_proof`, so
-- no row here has ever been Merkle-anchored. Dropping them is therefore safe for the published
-- record and destructive only to the counterfactual corpus.
--
-- Labels first — `band_signal_labels.band_id` REFERENCES `band_signals(band_id)`, so the reverse
-- order would need a CASCADE that also silences a genuine dependency error.

DROP INDEX IF EXISTS idx_band_labels_spec_band;
DROP TABLE IF EXISTS band_signal_labels;

DROP INDEX IF EXISTS idx_band_signals_pending_outcome;
DROP INDEX IF EXISTS idx_band_signals_scan;
DROP TABLE IF EXISTS band_signals;
