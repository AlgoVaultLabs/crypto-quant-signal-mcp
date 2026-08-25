-- 031 DOWN — CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1
--
-- ⚠️ READ BEFORE RUNNING. Dropping these columns destroys the ONLY forensic record of the
-- 2026-08 contact-form campaign: which rows were judged spam, by which rules, and when. The rows
-- themselves survive (this file drops columns, never rows — Data Integrity LAW), but the
-- judgement does not, and it is NOT recomputable: `identity-rotation` and `ip-velocity` are
-- evaluated against a 24h lookback AS OF each row's own created_at, so re-scoring later reads a
-- different corpus and therefore answers a different question.
--
-- Prefer disabling the scorer over dropping its columns. If the quarantine lane is genuinely
-- being retired, EXPORT first:
--   SELECT id, spam_score, spam_reasons, quarantined_at FROM contact_leads WHERE spam_score > 0;
--
-- Safe order: stop the producer first. `handleContactSubmission` writes these columns on every
-- submission, so dropping them under a live container turns each write into a relation error
-- swallowed by the caller's catch — the lead would still be captured (the INSERT precedes the
-- score step by design), but silently un-scored.

DROP INDEX IF EXISTS idx_contact_leads_quarantined;
DROP INDEX IF EXISTS idx_contact_leads_ip_created;

ALTER TABLE contact_leads DROP COLUMN IF EXISTS quarantined_at;
ALTER TABLE contact_leads DROP COLUMN IF EXISTS spam_reasons;
ALTER TABLE contact_leads DROP COLUMN IF EXISTS spam_score;

-- NOT dropped: idx_contact_leads_created_at. It predates this wave and serves other queries.
