-- 027_subscriber_interval.sql
-- OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 · CH2
--
-- WHY. `subscriber_profiles.amount_usd` stores the CHARGE — `Math.round(session.amount_total)/100`
-- (src/lib/subscriber-attribution.ts). The table has no period, so **a stored amount without a
-- period is not a rate**: an annual Starter writes $79 on one day and nothing for eleven months,
-- and that row is byte-indistinguishable from a hypothetical $79 monthly charge. `SUM(amount_usd)`
-- is therefore not MRR and never can be without this dimension.
--
-- This stopped being hypothetical on 2026-08-05, when PRICING-ANNUAL-AND-HOLD-PROMISE-W1 put
-- annual prepay on sale and configured both annual Price ids.
--
-- The live Stripe census could not answer it either: `countActiveSubscriptionsByTier` collapsed
-- annual and monthly into one tier, so "how many of the 3 starters are annual" was unanswerable
-- from either side. CH2 widens that function in the same change.
--
-- LIVE STATE at authoring (probed 2026-08-06 on prod):
--   rows = 4 · all tier='starter' · all status='active' · sum(amount_usd) = 39.96
--   Stripe truth = {starter:3, pro:1} = $78.97/mo. All 4 subscriptions are interval=month;
--   ZERO annual subscribers exist yet. The column is PRE-EMPTIVE and correctly so — it is one
--   checkout away from being needed, and a record that cannot express a distinction the money
--   depends on is the defect this wave exists to close.
--
-- 🛑 `amount_usd` IS NOT TOUCHED. It records what was charged on a date — a true fact, and the
-- only place that fact survives. Data Integrity (add before you remove): the dimension is ADDED
-- and the rate DERIVED beside it; nothing is normalised over the top of the charge.
--
-- WHY billing_interval DEFAULTS TO 'unknown' AND NOT 'month'. Three of four rows would in fact be
-- correct as 'month' today, which is exactly the trap. A guessed default makes CH3's composition
-- check pass on a fiction, and because an annual Starter's rate is $6.58 against a monthly
-- Starter's $9.99, a wrong guess yields a wrong MRR that looks entirely plausible. 'unknown' is
-- the honest state for a row whose cadence has not been established; CH4 resolves each one from
-- Stripe, which is the only source that actually knows.
--
-- WHY monthly_rate_usd IS NULLABLE WITH NO DEFAULT. NULL means "not derivable", which is a
-- REFUSAL, not zero: Enterprise is sold monthly-only, so an Enterprise annual rate does not
-- exist and must not be fabricated. Readers EXCLUDE a NULL from MRR rather than adding 0 — a
-- plan we cannot price is not a plan worth nothing.
--
-- WHY NO CHECK CONSTRAINT on billing_interval — same reasoning migration 026 recorded for
-- `settlement_state`, and it applies harder here. `buildSubscriberProfile` is FAIL-OPEN inside a
-- Stripe webhook handler: a CHECK violation would be swallowed and the profile silently lost,
-- reproducing the exact class (a revenue side-effect that fails open and reports to nobody) that
-- six waves of this arc existed to end. The vocabulary is enforced where a violation is cheap and
-- visible instead: the `StoredBillingInterval` union plus `normalizeBillingInterval`'s
-- default-deny, both unit-tested.
--
-- WHY monthly_rate_usd IS STORED RATHER THAN DERIVED ON READ. It is a MATERIALISATION of
-- `planMonthlyRateUsd` (src/lib/plans.ts), which remains the single derivation and the SoT —
-- exactly one function writes this column. Storing it makes MRR a pure SQL aggregate, so a host
-- canary or an admin query can compute it without a TypeScript runtime. NUMERIC(10,4) keeps the
-- annual quotient ($79/12 = 6.5833…) at four places rather than rounding a rate to cents.
--
-- Postgres only. SQLite test DBs get these columns from `ensureSubscriberIntervalColumns()` in
-- src/lib/subscriber-attribution.ts (PRAGMA table_info pre-check — SQLite has no
-- ADD COLUMN IF NOT EXISTS). Dual-backend law.
--
-- PRE-APPLIED VIA SSH BEFORE THE COMMIT, so the deploy that ships the code is a no-op against
-- prod (CLAUDE.md: pre-apply schema, then ship code with IF NOT EXISTS idempotency).
--
-- DOWN-PATH: migrations/027_subscriber_interval.down.sql. Lossless — both columns are derivable
-- again from Stripe by re-running CH4's backfill.

BEGIN;

-- 1. The cadence. 'unknown' is the honest default for an existing row (see above).
ALTER TABLE subscriber_profiles
  ADD COLUMN IF NOT EXISTS billing_interval TEXT NOT NULL DEFAULT 'unknown';

-- 2. The derived monthly rate. NULL = not derivable; never 0.
ALTER TABLE subscriber_profiles
  ADD COLUMN IF NOT EXISTS monthly_rate_usd NUMERIC(10,4);

-- NOTE: deliberately NO backfill UPDATE here. Migration 026 could transcribe a completed
-- on-chain scan because the answer was already established; here it is not. The cadence of an
-- existing row is knowable only from Stripe, so it is read from Stripe by CH4's idempotent,
-- dry-run-by-default backfill — not guessed by a WHERE clause that would be indistinguishable
-- from truth once written.

COMMIT;
