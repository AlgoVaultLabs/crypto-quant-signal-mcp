-- 040 down — IDENTITY-LIFECYCLE-W3 CH1.
--
-- 🛑 DROPPING `lifecycle_suppressions` DESTROYS CONSENT STATE THAT CANNOT BE RECONSTRUCTED.
-- Every row in it is somebody who unsubscribed, bounced, or filed a spam complaint. There is no
-- other record: a bounce webhook hands us an address we may hold nowhere else, and an
-- unsubscribe is by definition the absence of a relationship. Re-running the up migration after
-- this gives an EMPTY suppression list, and the very next dispatcher tick mails everyone who
-- had opted out — the one outcome §Data Integrity forbids outright.
--
-- So this file drops the two tables that are pure derived/operational state and REFUSES the
-- third. If a suppression drop is ever genuinely wanted, it is a deliberate operator act with an
-- export taken first, not a migration rollback.

DROP TABLE IF EXISTS lifecycle_step_state;
DROP TABLE IF EXISTS lifecycle_sends;

-- Deliberately NOT dropped: lifecycle_suppressions. See the header.
