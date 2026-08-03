-- 024_x402_idempotency_payer_nonce_pk.down.sql
-- OPS-AUDIT-REMEDIATION-LOW-W2 · Ch3 · SEC-49 — the down-path, produced per the Plan-Mode gate.
--
-- ⚠️ READ THIS BEFORE RUNNING IT.
--
-- This revert is safe ONLY while no nonce is shared across payers — which is precisely the
-- situation the up-migration exists to permit. The moment the fix does its job and two different
-- payers legitimately settle the same nonce, restoring PRIMARY KEY (nonce) becomes IMPOSSIBLE
-- without deleting one of two real payments. The revert window closes on first collision.
--
-- Check before running:
--   SELECT nonce, count(*) FROM processed_x402_payments GROUP BY nonce HAVING count(*) > 1;
-- Any row returned ⇒ DO NOT RUN THIS. Reverting would destroy a settled payment record, which
-- the Data Integrity law forbids outright. Fix forward instead.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM processed_x402_payments GROUP BY nonce HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'REFUSING REVERT: a nonce is shared across payers. Restoring PRIMARY KEY (nonce) would delete a legitimate settled payment. Fix forward.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'processed_x402_payments'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (payer_wallet, nonce)'
  ) THEN
    ALTER TABLE processed_x402_payments DROP CONSTRAINT processed_x402_payments_pkey;
    ALTER TABLE processed_x402_payments ADD PRIMARY KEY (nonce);
  END IF;
END $$;

-- payer_wallet's NOT NULL / DEFAULT '' is deliberately LEFT IN PLACE: it is harmless under the
-- old key, and dropping it would re-open the NULL-payer hole for no benefit.

COMMIT;
