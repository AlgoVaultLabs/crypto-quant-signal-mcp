-- 018_referral_notifications.sql — REFERRAL-PARITY-NOTIFS-W1 / C1
-- The reusable referrer-notification queue + the opt-out preference. Referrers are
-- auto-notified (default-ON, one-tap opt-out) when a friend joins via their link
-- and when they earn commission, through whatever channel reaches them (email +/or
-- the Telegram bot). One row per (referrer, event, channel); UNIQUE(channel, source_id)
-- makes webhook/replay re-queue a no-op (source_id = attr:<attribution_id> for
-- friend_joined, led:<ledger_id> for commission_earned).
--
-- Pre-applied to prod signal_performance via SSH psql BEFORE the code commit lands
-- (CLAUDE.md "pre-apply schema via SSH then deploy code with IF NOT EXISTS idempotency").
-- The in-code dual-backend DDL in src/lib/referral-store.ts mirrors this (fresh/test
-- DBs get it via CREATE TABLE IF NOT EXISTS + ensureReferralNotifyColumns).
--
-- PG-only. Idempotent / re-runnable.

CREATE TABLE IF NOT EXISTS referral_notifications (
  id BIGSERIAL PRIMARY KEY,
  referrer_code TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('friend_joined', 'commission_earned')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'tg')),
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered')),
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_notif_source ON referral_notifications (channel, source_id);
CREATE INDEX IF NOT EXISTS idx_referral_notif_pending ON referral_notifications (status, channel);

-- Notification preference (default-ON = opt_out false). Single column = single source
-- of truth; the TG /notifications toggle and the email manage-link both write it; the
-- notifier checks it once before queueing any channel.
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS notify_opt_out BOOLEAN NOT NULL DEFAULT false;
