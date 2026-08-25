-- 031 — CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1
--
-- The quarantine lane: a third verdict for `contact_leads` meaning "stored, but not trustworthy".
--
-- WHY THIS IS THE GENERATOR FIX AND NOT ANOTHER HEURISTIC. Before these columns existed,
-- `ContactSubmitResult` was `ok | honeypot | invalid | server_error` — so every abuse control
-- faced a forced choice between DESTROYING a submission (a 400, which risks a real enterprise
-- lead and violates the Data Integrity LAW) and PAGING the operator. Measured 2026-08-25: the
-- second branch fired 65 times across 15 days, each one an email and an uncooled Telegram alert.
-- Once "stored but not notified" is expressible, every future detector ships behind the same
-- threshold with ZERO risk of losing a real lead, because quarantine never deletes and never
-- rejects. That is what these three columns buy; the rule table in src/lib/contact-spam.ts is
-- merely the first consumer.
--
-- `quarantined_at` IS THE DISCRIMINATOR, and that is why it is a separate column rather than a
-- flag derived from `spam_score >= threshold`. `email_sent_at IS NULL` already has two meanings —
-- "not sent yet" and "send failed" (the latter carrying `email_error`). A third, "deliberately
-- not sent", must not be inferred from a score that a later wave may retune: re-tuning the
-- threshold would silently restate history. The score records WHAT WE THOUGHT; `quarantined_at`
-- records WHAT WE DID. Those are different facts and they are stored separately.
--
-- NOTE ON THE NAME. `webhook_subscriptions.quarantined_at` already exists as a BIGINT epoch.
-- This one is TIMESTAMPTZ because every other timestamp on `contact_leads` (`created_at`,
-- `email_sent_at`) is TIMESTAMPTZ, and matching the table beats matching a distant namesake.
-- The two are deliberately NOT unified — same word, different tables, different storage
-- conventions, no shared consumer.
--
-- PRE-APPLIED TO PRODUCTION VIA SSH BEFORE THIS FILE WAS COMMITTED (CLAUDE.md's pre-apply rule).
-- Safe because `spam_score` is NOT NULL DEFAULT and the other two are nullable: on PostgreSQL 11+
-- ADD COLUMN with a non-volatile default is catalog-only, so there is no table rewrite and no
-- long lock, and the INSERT the deployed code was already running keeps working unchanged across
-- the ALTER. Any row written in the gap is genuinely un-scored, which is exactly what
-- `spam_score = 0, quarantined_at IS NULL` says about it.
--
-- The SQLite twin of this schema lives in src/lib/performance-db.ts (CREATE_CONTACT_LEADS_SQL +
-- SIGNAL_MIGRATIONS), because `contact_leads` has never been created by this directory — these
-- files are the Postgres schema-as-code record and the postgres-lane CI fixture.

ALTER TABLE contact_leads ADD COLUMN IF NOT EXISTS spam_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contact_leads ADD COLUMN IF NOT EXISTS spam_reasons TEXT;
ALTER TABLE contact_leads ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;

-- Serves the `ip-velocity` rule: "how many leads from this ip_hash in the last 24h". Composite
-- rather than a bare `ip_hash` index because the query is always (equality on ip_hash) AND
-- (range on created_at), so the second column turns an index scan + filter into a range scan.
CREATE INDEX IF NOT EXISTS idx_contact_leads_ip_created ON contact_leads (ip_hash, created_at);

-- Serves the campaign-alert cooldown: "has anything else been quarantined in the last 24h".
-- PARTIAL, because the column is NULL for every legitimate lead and a B-tree stores NULLs — on a
-- table whose healthy steady state is almost entirely NULL here, indexing them is pure overhead
-- on every insert. Both backends support this syntax (PostgreSQL, and SQLite since 3.8.0; this
-- repo runs better-sqlite3 11.10.0 / SQLite 3.49.2).
CREATE INDEX IF NOT EXISTS idx_contact_leads_quarantined ON contact_leads (quarantined_at)
  WHERE quarantined_at IS NOT NULL;

-- DELIBERATELY ABSENT: an index on `created_at`. `idx_contact_leads_created_at` ALREADY EXISTS in
-- production (verified 2026-08-25 against pg_indexes) and already serves the lookback window's
-- time bound. Re-declaring it here would be a second declaration of one live object.
