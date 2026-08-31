-- 024_x402_idempotency_payer_nonce_pk.sql
-- OPS-AUDIT-REMEDIATION-LOW-W2 · Ch3 · SEC-49
--
-- WHY. processed_x402_payments keys idempotency on the bare ERC-3009 nonce. A nonce is unique
-- PER AUTHORIZER, not globally — the spec this table implements says so — so the single-column
-- key is semantically wrong. Two payers who happen to pick the same nonce collide, and a
-- collision means the SECOND payer's legitimate payment is read as a replay and silently
-- skipped: they pay on-chain and receive nothing. Nothing detects it; the route just 402s.
--
-- LIVE STATE at authoring (probed 2026-08-02 on prod):
--   rows = 18 · payer_wallet NULL or '' = 4 · distinct nonces = 18
--   nonces shared across payers = 0        <- so no row conflicts under the new key
--   owner = algovault_app (the app owns its tables, so this DDL runs as the app role)
--
-- The 4 NULL/'' rows predate OPS-X402-WALLET-ATTRIBUTION-W1 and their payer is UNRECOVERABLE
-- (the authorization was not retained). '' is the correct terminal value rather than dropping
-- them: it keeps them participating in dedupe under the composite key instead of letting an
-- unextractable payer bypass the claim entirely.
--
-- DOWN-PATH: see migrations/024_x402_idempotency_payer_nonce_pk.down.sql. It is safe TODAY and
-- becomes lossy the moment this fix does its job — reverting after a genuine cross-payer
-- collision has been recorded would require deleting one of two legitimate payments. The revert
-- window closes on first collision. Recorded here rather than discovered later.
--
-- Postgres only. SQLite cannot ALTER a primary key at all; its tables are created fresh from
-- CREATE_PROCESSED_X402_PAYMENTS_SQL in src/lib/x402-idempotency-store.ts, which carries the
-- composite key directly, so test DBs need no migration. (Dual-backend law: PG has
-- ADD COLUMN IF NOT EXISTS, SQLite does not.)

BEGIN;

-- 0. THE COLUMN THIS MIGRATION EDITS MUST EXIST, and until OPS-X402-PAYER-WALLET-MIGRATION-W1 it
--    did not — not in any migration. `payer_wallet` was added to prod over SSH and, for every
--    other database, by the app's own `ADD COLUMN IF NOT EXISTS` inside
--    CREATE_PROCESSED_X402_PAYMENTS_SQL (src/lib/x402-idempotency-store.ts). migrations/010 creates
--    this table WITHOUT the column, so applying migrations/ in order to an EMPTY database failed
--    right here — and because this file is one transaction, the PK swap below was lost with it,
--    then 026 and 028 failed on the columns 026's own rollback had just removed. Nine errors, ONE
--    absent column. Measured on postgres-lane run 33407686342.
--
--    A no-op against prod and against any database the app has touched. It is here rather than in
--    a new migration 037 because 037 would run AFTER this file had already aborted; the only place
--    that repairs the chain is inside the transaction that needs the column.
--
--    The general rule this instance produced: the pre-apply-over-SSH convention means a migration
--    can be INCOMPLETE and still work in production forever, because a human supplied the missing
--    piece by hand. `migrations/` is only a schema history if it can build one from nothing.
ALTER TABLE processed_x402_payments ADD COLUMN IF NOT EXISTS payer_wallet TEXT;

-- 1. Back-fill: an unextractable payer becomes '' so it still dedupes.
UPDATE processed_x402_payments SET payer_wallet = '' WHERE payer_wallet IS NULL;

-- 2. Make the new key column total.
ALTER TABLE processed_x402_payments ALTER COLUMN payer_wallet SET DEFAULT '';
ALTER TABLE processed_x402_payments ALTER COLUMN payer_wallet SET NOT NULL;

-- 3. Swap the key. Guarded so a re-run is a no-op (the deploy applies schema idempotently).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'processed_x402_payments'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (nonce)'
  ) THEN
    ALTER TABLE processed_x402_payments DROP CONSTRAINT processed_x402_payments_pkey;
    ALTER TABLE processed_x402_payments ADD PRIMARY KEY (payer_wallet, nonce);
  END IF;
END $$;

-- 4. A replay lookup by bare nonce still needs to be fast (the composite PK's leading column is
--    payer_wallet, so it cannot serve a nonce-only probe).
CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_nonce ON processed_x402_payments (nonce);

COMMIT;
