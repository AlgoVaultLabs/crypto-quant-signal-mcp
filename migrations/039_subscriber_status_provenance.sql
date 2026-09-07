-- 039 — subscriber_profiles status PROVENANCE. OPS-SUBSCRIBER-STATUS-SOT-W1.
--
-- WHY. OPS-PAYMENT-DECLINE-RECOVERY-PREDICATE-W1 made `subscriber_profiles.status` a load-bearing
-- safety property: the PAYMENT_DECLINE_DRIFT absolute floor counts payers whose money is stuck by
-- reading it. At that moment the only write predicate was `WHERE customer_id = ?`, with no
-- subscription scope and no timestamp — so a customer holding two subscriptions kept whichever
-- event the webhook happened to process LAST, and an out-of-order Stripe delivery left the row on
-- the older value with no way back.
--
-- `subscription_id` already existed but is written ONLY by the checkout upsert and records which
-- subscription the PROFILE was created for. Which subscription the STATUS came from is a
-- different question, and conflating them is what made the existing column look sufficient.
--
-- Both columns are NULLABLE with no default on purpose: a row written before this migration has
-- no provenance, and inventing one would assert a fact nobody measured. `decideStatusWrite`
-- treats a missing watermark as "cannot compare", never as "oldest".
ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;
ALTER TABLE subscriber_profiles ADD COLUMN IF NOT EXISTS status_subscription_id TEXT;
