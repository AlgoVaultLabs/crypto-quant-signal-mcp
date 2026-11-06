-- 055_call_ledger.down.sql — rollback of 055 (DECISION-CALL-V2-W5 CH1).
-- ⚠ DESTRUCTIVE: this DROPS every call-ledger leaf, every odds salt and every check row's receipt id. A leaf
-- already anchored on Base can then never be proven again — the caller's receipt points at nothing, and an
-- odds commitment can never be opened (its salt exists nowhere else). Data Integrity LAW: never run it
-- against production without explicit authorization. Take `pg_dump -t call_ledger -t pre_trade_checks` first.
-- The lazy ensure in src/lib/pre-trade-check-log.ts re-creates the (empty) objects on the next logged call
-- unless the writer is reverted first.
ALTER TABLE pre_trade_checks
  DROP COLUMN IF EXISTS ledger_id;
DROP INDEX IF EXISTS idx_call_ledger_batch_id;
DROP TABLE IF EXISTS call_ledger;
