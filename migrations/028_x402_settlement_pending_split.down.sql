-- 028 DOWN — OPS-X402-SETTLEMENT-BACKFILL-W1
--
-- Restores the pre-split label on exactly the rows 028 moved. Bounded by the SAME cutoff, so it
-- cannot reach the 15 established negatives it never touched.
--
-- ⚠️ It deliberately does NOT restore rows that have since been PROMOTED. Once
-- `recordSettlementOutcome` writes SETTLED/OPERATOR, that is an established fact recorded from the
-- rail's own result; a rollback of a LABELLING change must never un-settle money that moved. Only
-- rows still sitting at PENDING are reverted.

UPDATE processed_x402_payments
   SET settlement_state = 'CLAIMED_UNSETTLED'
 WHERE settlement_state = 'CLAIMED_PENDING'
   AND created_at > TIMESTAMPTZ '2026-07-29 14:08:47.787216+00';
