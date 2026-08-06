-- 027_subscriber_interval.down.sql
-- OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 · CH2 · revert of 027_subscriber_interval.sql
--
-- SAFETY. Non-destructive to the conversion record: `customer_id`, `tier`, `status`,
-- `amount_usd`, `currency`, the attribution columns and the C2 bridge columns are all untouched.
-- `amount_usd` in particular is never written by the up-path, so nothing it recorded can be lost
-- by reverting.
--
-- WHAT IT COSTS. The cadence and the derived rate are DISCARDED, so MRR again becomes underivable
-- from the table — the exact state this migration closed. Rebuilding is cheap and non-lossy:
-- re-apply 027 and re-run CH4's backfill, which reads both values from Stripe (the only source
-- that ever knew them). So this revert is lossy in EFFORT, not in billing truth.
--
-- Reverting does NOT affect entitlement or billing in any way. `validateApiKey` resolves tier
-- live from the Stripe price id and has never read this table; these columns are reporting-only.
--
-- Postgres only (SQLite test DBs are created fresh / columns added by
-- `ensureSubscriberIntervalColumns()`).

BEGIN;

ALTER TABLE subscriber_profiles DROP COLUMN IF EXISTS monthly_rate_usd;
ALTER TABLE subscriber_profiles DROP COLUMN IF EXISTS billing_interval;

COMMIT;
