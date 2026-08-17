-- 029 DOWN — PRICING-BOT-DELIVERY-METERING-W1 CH2
--
-- ⚠️ DROPPING THIS TABLE DESTROYS THE IDEMPOTENCY RECORD, NOT JUST A LEDGER.
-- Every key in it is a claim that a debit already happened. With the table gone, a redelivery or a
-- bot outbox retry that was correctly recognised as a replay becomes a fresh CLAIMED and charges
-- the subscriber a second time. Under R-1's hard wall that walls a paying customer early.
--
-- So this rollback is only safe when the CODE that debits is already rolled back — i.e. revert the
-- server first, confirm nothing calls `consumeEntitlement`, then drop. Rolling the schema back
-- under live code is the dangerous order.
DROP INDEX IF EXISTS idx_entitlement_debits_channel;
DROP INDEX IF EXISTS idx_entitlement_debits_tracker;
DROP TABLE IF EXISTS entitlement_debits;
