-- 044 down — LIFECYCLE-GOLIVE-SEMANTICS-W1. Drops only the two columns 044 added.
-- Any row already carrying status 'expired' keeps that status (TEXT); only its reason is lost.
ALTER TABLE lifecycle_sends DROP COLUMN IF EXISTS expired_reason;
ALTER TABLE lifecycle_step_state DROP COLUMN IF EXISTS first_sent_at;
