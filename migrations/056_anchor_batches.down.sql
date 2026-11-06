-- 056_anchor_batches.down.sql — rollback of 056 (DECISION-CALL-V2-W5 CH2).
-- ⚠ DESTRUCTIVE. Dropping call_ledger_batches loses which tx anchored each call-ledger root and when, and every
-- recheck record; the leaves keep a batch id that then points at nothing. Dropping merkle_batch_seals while a
-- signal batch is sealed or sent loses its signal ids and proofs: if its root is already on chain, the batch can
-- never be confirmed into merkle_batches — exactly the orphan this migration exists to prevent. Data Integrity
-- LAW: never run it against production without explicit authorization, and only with no batch open
-- (`SELECT * FROM merkle_batch_seals WHERE state <> 'verified'` and the same on call_ledger_batches return no row).
-- Take `pg_dump -t call_ledger_batches -t merkle_batch_seals` first. The lazy ensures re-create the (empty) tables
-- on the next publisher run unless the publishers are reverted first.
DROP TABLE IF EXISTS merkle_batch_seals;
DROP TABLE IF EXISTS call_ledger_batches;
