-- 016_referral_channel_tg.sql — TG-REFERRAL-W1 / C1
-- Additive widen: allow channel='tg' on referral_attributions for the Telegram
-- identity lane (a TG referee→referrer join). The existing 'paid_checkout' /
-- 'free_signup' values are unchanged; no row is touched, no data lost.
--
-- Pre-applied to prod signal_performance via SSH psql BEFORE the code commit lands
-- (CLAUDE.md "pre-apply schema via SSH then deploy code with IF NOT EXISTS
-- idempotency"). The in-code DDL CHECK in src/lib/referral-store.ts mirrors this
-- (fresh/test DBs get 'tg' directly); this file widens the EXISTING prod table's
-- CHECK (CREATE TABLE IF NOT EXISTS never alters an existing constraint).
--
-- PG-only. The inline CHECK created in migration 015 line 30 is auto-named
-- `referral_attributions_channel_check` by Postgres; DROP IF EXISTS makes this
-- migration idempotent / re-runnable. SQLite (test backend) never runs this —
-- its fresh tables come from referral-store.ts with 'tg' already in the CHECK.

ALTER TABLE referral_attributions
  DROP CONSTRAINT IF EXISTS referral_attributions_channel_check;

ALTER TABLE referral_attributions
  ADD CONSTRAINT referral_attributions_channel_check
  CHECK (channel IN ('paid_checkout', 'free_signup', 'tg'));
