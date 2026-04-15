-- Migration 2026-04-15: forum_post_failures + forum_post_audit_log
--
-- Created as part of the agent-forum-post hardening sprint
-- (harden-agent-forum-post.md, Teammate A, Reqs 4 + 6).
--
-- These tables give the forum-post pipeline a single-trail record of
--   (a) every publish attempt that was verified live or failed
--       verification, and
--   (b) every drift detected by the self-audit cron.
--
-- All statements are IDEMPOTENT — safe to re-apply on every boot. The
-- PostgreSQL dialect is authoritative; the matching SQLite dialect is
-- written inline in src/lib/forum-post-failures.ts so local dev can
-- run the same module without a PG instance.
--
-- Apply path (production):
--   ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 \
--     "docker exec -i $(docker ps --filter name=mcp-server -q | head -1) \
--        psql \"\$DATABASE_URL\" -f -" \
--     < schema/migrations/2026-04-15-forum-post-failures.sql

CREATE TABLE IF NOT EXISTS forum_post_failures (
  id SERIAL PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform TEXT NOT NULL,
  post_type TEXT NOT NULL,
  post_id TEXT,
  post_url TEXT,
  failure_reason TEXT NOT NULL,
  recovered BOOLEAN NOT NULL DEFAULT FALSE,
  recovered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_forum_post_failures_platform_detected
  ON forum_post_failures (platform, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_forum_post_failures_unrecovered
  ON forum_post_failures (platform) WHERE recovered = FALSE;

-- Audit log of every publish attempt. The self-audit cron (--self-audit)
-- reads the last N days of this table and re-verifies each post against
-- the platform to detect drift (post logged as published but removed
-- later). Any drift becomes a new row in forum_post_failures with reason
-- "drift-detected-on-self-audit".

CREATE TABLE IF NOT EXISTS forum_post_audit_log (
  id SERIAL PRIMARY KEY,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  platform TEXT NOT NULL,
  post_type TEXT NOT NULL,
  post_id TEXT NOT NULL,
  post_url TEXT,
  verified_at_publish BOOLEAN NOT NULL,
  verify_failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_forum_post_audit_log_platform_published
  ON forum_post_audit_log (platform, published_at DESC);
