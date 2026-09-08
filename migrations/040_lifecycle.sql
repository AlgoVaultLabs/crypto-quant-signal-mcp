-- 040 — IDENTITY-LIFECYCLE-W3 CH1
-- The ledger and the suppression list. Together they are the whole reason a behaviour-triggered
-- email can be sent safely at all: today there are 12 transactional senders in src/lib/email.ts,
-- none of which records what it sent, and NO suppression list of any kind.
--
-- `lifecycle_sends` — one row per (recipient, step, period). The UNIQUE constraint IS the
-- idempotency mechanism, not a nicety: the dispatcher runs every 15 minutes and is classified
-- `safe-to-kill`, so a run killed mid-flight by a deploy re-evaluates the same eligible set on
-- the next tick. Without the constraint that is a duplicate send to a real person.
--
--   status  would_send  shadow mode rendered it and did NOT call Resend (the default)
--           sent        live mode called Resend and it accepted
--           failed      live mode called Resend and it did not accept; retried next tick
--           suppressed  eligible, but the address is on the suppression list
--           capped      eligible and un-suppressed, but a frequency cap refused it
--
-- The rendered subject/body are stored on EVERY row including `would_send`. That is the point of
-- shadow mode — CH2's readout is a human reading the exact bytes that would have been sent,
-- before anyone receives them.
--
-- `email_hash` is the join key to `lifecycle_suppressions` and is an HMAC, never the address:
-- the suppression list must survive an account deletion, and a bounce webhook gives us an
-- address we may hold no other record of. `recipient_email` is nullable and holds plaintext ONLY
-- where an identity table already holds the same address in the clear (free_keys.email,
-- signup_emails.email) — it is a convenience for the readout, never the authority.
--
-- `lifecycle_suppressions` — absolute and permanent. `step_scope` distinguishes the two ways a
-- person can stop receiving mail:
--   'all'   unsubscribe / bounce / complaint — no lifecycle mail ever again
--   'usage' the /account preference toggle (CH3) — the four usage steps only; the product-updates
--           digest they explicitly opted into is unaffected, and vice versa.
-- Transactional mail (welcome, key recovery) is NOT governed by this table and never will be:
-- a key-recovery email is not marketing and suppressing it would lock someone out of their own
-- account.
--
-- PER-STEP GO-LIVE STATE (`lifecycle_step_state`) — architect ruling Q1(A), 2026-09-08.
-- The wave-level `LIFECYCLE_MODE` flip in the original spec was retired at Plan Mode because it
-- was measurably unsafe here: MEASURED on signal-1, `activation_nudge` has 28 eligible
-- recipients while `quota_80`, `quota_wall` and `reset_return` have ZERO and will still have
-- zero at day 7 (the all-time maximum on any email-bound bucket is 54/200 = 27 %, and the 80 %
-- threshold is 160). A wave-level gate reading `would_send >= 1` is satisfied by
-- `activation_nudge` alone and would light three steps that had never rendered once — their
-- first-ever render going to a real person, which is exactly what shadow mode exists to prevent.
-- So each step carries its OWN clock and its own canary:
--   first_would_send_at  starts that step's 7-day shadow clock (NULL ⇒ the clock has not started)
--   live_since           NULL ⇒ still shadow. A step with 0 eligibility stays NULL forever, free.
--   canary_batch_done    the first live tick sends to <= 5 recipients; the next tick is
--                        unlimited only once that batch has produced 0 bounces and 0 complaints.
--   rolled_back_at       set by the readout on a breach; clears live_since. Per step.
--
-- ADDITIVE AND SAFE TO PRE-APPLY. Three new tables touch no existing object, so this is applied
-- on signal-1 via SSH BEFORE the code deploys (CLAUDE.md's pre-apply rule), which makes the
-- boot-path `CREATE TABLE IF NOT EXISTS` in src/lib/lifecycle/schema.ts a no-op there rather
-- than a race. Both DDLs exist on purpose — the migrations directory never reaches a fresh DB or
-- the SQLite test backend — and tests/unit/lifecycle-ddl-parity.test.ts asserts the pair names
-- the same columns so they cannot drift.

CREATE TABLE IF NOT EXISTS lifecycle_sends (
  id               BIGSERIAL PRIMARY KEY,
  recipient_id     TEXT        NOT NULL,
  email_hash       TEXT        NOT NULL,
  recipient_email  TEXT        NULL,
  step             TEXT        NOT NULL,
  period_key       TEXT        NOT NULL,
  status           TEXT        NOT NULL,
  rendered_subject TEXT        NULL,
  rendered_html    TEXT        NULL,
  rendered_text    TEXT        NULL,
  resend_id        TEXT        NULL,
  error            TEXT        NULL,
  attempts         INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lifecycle_sends_unique UNIQUE (recipient_id, step, period_key)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_step_created ON lifecycle_sends (step, created_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_hash_created ON lifecycle_sends (email_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_status      ON lifecycle_sends (status);

CREATE TABLE IF NOT EXISTS lifecycle_suppressions (
  email_hash  TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  step_scope  TEXT        NOT NULL DEFAULT 'all',
  source      TEXT        NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lifecycle_suppressions_unique UNIQUE (email_hash, reason, step_scope)
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_suppressions_hash ON lifecycle_suppressions (email_hash);

CREATE TABLE IF NOT EXISTS lifecycle_step_state (
  step                TEXT        PRIMARY KEY,
  first_would_send_at TIMESTAMPTZ NULL,
  live_since          TIMESTAMPTZ NULL,
  canary_batch_done   BOOLEAN     NOT NULL DEFAULT FALSE,
  rolled_back_at      TIMESTAMPTZ NULL,
  rollback_reason     TEXT        NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `lifecycle_heartbeats` — the DISPATCHER'S OWN write stamp.
--
-- The health canary must be able to distinguish "the dispatcher is fine and there was nothing to
-- do" from "the dispatcher has not run since Tuesday". A freshness alarm measures PRODUCERS,
-- never rendered artifacts, and the ledger is a rendered artifact here: with zero eligible
-- recipients — which is the MEASURED state for three of the four steps — a stalled dispatcher and
-- a healthy one write byte-identical ledgers (nothing). So the producer stamps itself on EVERY
-- tick including a no-op one, which is the same rule `seed_heartbeats` follows: a skip still
-- stamps liveness, or the liveness signal is a function of the work rather than of the worker.
CREATE TABLE IF NOT EXISTS lifecycle_heartbeats (
  job            TEXT        PRIMARY KEY,
  last_run_at    TIMESTAMPTZ NOT NULL,
  last_verdict   TEXT        NOT NULL,
  eligible_count INTEGER     NOT NULL DEFAULT 0,
  note           TEXT        NULL
);
