-- 044 — LIFECYCLE-GOLIVE-SEMANTICS-W1 R1 + R2.
--
-- `lifecycle_step_state.first_sent_at` — the instant a step's FIRST real email left. The 72 h
-- auto-rollback window opens HERE, never at `live_since`. MEASURED on signal-1 2026-09-28:
-- `activation_nudge` was stamped live 2026-09-16 while the global master held every send in
-- shadow, so a window keyed on `live_since` had expired (291 h) before a single email was sent —
-- the debut would have run with no automatic rollback at all. NULL ⇒ the window has not opened.
--
-- `lifecycle_sends.expired_reason` — why a shadow claim (`would_send`) was retired without a send
-- when its step went live: the step's own eligibility predicate, evaluated AS OF NOW, said no
-- (e.g. `key_older_than_30d`). Paired with the new `expired` status value; `status` is TEXT, so
-- the value needs no DDL. NULL on every row that is not `expired`.
--
-- ADDITIVE AND SAFE TO PRE-APPLY. Two nullable columns on existing tables: a metadata-only change
-- on PG 11+, no rewrite, no long lock. Every existing INSERT names its columns and every existing
-- reader tolerates an extra field, so the currently deployed code is unaffected. Applied on
-- signal-1 via SSH BEFORE the code lands (the 040/041 pattern); the boot-path twin is the ALTER
-- block in src/lib/lifecycle/schema.ts, and tests/unit/lifecycle-ddl-parity.test.ts pins the pair.
-- Rollback: migrations/044_lifecycle_golive_semantics.down.sql.

ALTER TABLE lifecycle_step_state ADD COLUMN IF NOT EXISTS first_sent_at TIMESTAMPTZ NULL;
ALTER TABLE lifecycle_sends ADD COLUMN IF NOT EXISTS expired_reason TEXT NULL;
