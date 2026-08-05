-- 026_x402_settlement_and_rail.down.sql
-- REVENUE-METER-TRUTH-W2 · CH3 · revert of 026_x402_settlement_and_rail.sql
--
-- SAFETY. Non-destructive to the CLAIM record: `nonce`, `tool`, `amount`, `created_at` and
-- `payer_wallet` are untouched, and the composite primary key `(payer_wallet, nonce)` from
-- migration 024 is not involved, so replay protection is unaffected by running this.
--
-- WHAT IT COSTS. The settlement classification is DISCARDED. Rebuilding it means re-running the
-- on-chain scan (`backfill-x402-payer-wallet.ts --classify`), which is bounded RPC work against
-- Base — cheap at 18 rows, proportional to the table later. So this revert is lossy in EFFORT,
-- not in payment truth: the chain remains the source and can always be re-read.
--
-- Unlike 024's down-path, this one does not close: there is no future state in which reverting
-- 026 forces a choice between two legitimate payments.
--
-- Postgres only (SQLite test DBs are created fresh from CREATE_PROCESSED_X402_PAYMENTS_SQL).

BEGIN;

DROP INDEX IF EXISTS idx_processed_x402_payments_settlement;

ALTER TABLE processed_x402_payments DROP COLUMN IF EXISTS rail;
ALTER TABLE processed_x402_payments DROP COLUMN IF EXISTS settlement_state;

COMMIT;
