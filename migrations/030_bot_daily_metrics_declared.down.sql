-- Reverses ONLY what 030 introduced. The table itself is NOT dropped: it predates this migration
-- by many waves and holds the bot's entire daily history. A down-migration that dropped it would
-- destroy production data that this file never created — see Data Integrity (THE LAW).
ALTER TABLE bot_daily_metrics DROP COLUMN IF EXISTS deployed_sha;
