-- 028 — OPS-X402-SETTLEMENT-BACKFILL-W1
-- Split "nothing has looked yet" from "we looked and the money did not move".
--
-- WHAT THIS TOUCHES: exactly the rows whose `CLAIMED_UNSETTLED` was the INSERT-TIME DEFAULT and
-- never a finding. Those are the claims created AFTER the only on-chain classify run
-- (REVENUE-METER-TRUTH-W1 CH2, whose newest examined row is 2026-07-29T14:08:47.787216+00).
--
-- WHAT THIS MUST NOT TOUCH, and why the WHERE is bounded rather than a blanket update:
--   * the 15 pre-cutoff rows — CH2 scanned them and reported UNRESOLVABLE=0, i.e. every lookup
--     SUCCEEDED and found no authorization. That is an ESTABLISHED NEGATIVE and it is correct.
--     Rewriting them to PENDING would DESTROY a real finding and re-open a settled question.
--   * the 3 OPERATOR rows — already terminal.
--
-- THIS IS A CONFIDENCE DOWNGRADE TOWARD THE TRUTH, NEVER AN UPGRADE. It does not assert that the
-- money moved. It cannot: the two affected rows are the 2026-08-10 Circle Gateway payments, and
-- there is exactly ONE Circle transfer id for TWO rows with no key mapping either to the other.
-- (Run #1's settlement was inferred from a starting balance that was never observed.) On-chain
-- reconstruction is impossible for this rail — measured 2026-08-10, the seller EOA holds 0 USDC on
-- OP with zero inbound transfers, because Circle credits the seller inside its own ledger, while
-- the same query returns 312 transfers in 20 blocks. Writing SETTLED here would be fabrication.
--
-- SIDE EFFECT WORTH STATING: PENDING keeps these rows ELIGIBLE for later promotion by
-- `recordSettlementOutcome` if the operator ever supplies the Circle transfer ids;
-- `CLAIMED_UNSETTLED` is terminal and would have foreclosed that.
--
-- Idempotent: a re-run matches zero rows.

UPDATE processed_x402_payments
   SET settlement_state = 'CLAIMED_PENDING'
 WHERE settlement_state = 'CLAIMED_UNSETTLED'
   AND created_at > TIMESTAMPTZ '2026-07-29 14:08:47.787216+00';
