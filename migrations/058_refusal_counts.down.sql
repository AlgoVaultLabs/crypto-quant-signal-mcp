-- 058_refusal_counts.down.sql — rollback of 058 (REGIME-TF-ADMISSION-W1 CH2).
-- ⚠ DESTRUCTIVE: this DROPS every daily refusal count — the demand record REGIME-15M-SERVE-W1's trigger reads. It is
-- internal telemetry, never public data, but it cannot be rebuilt: the refusals it counted left no other trace.
-- Never run it against production without explicit authorization; take `pg_dump -t refusal_counts` first. The lazy
-- ensure in src/lib/refusal-counter.ts re-creates the (empty) table on the next flush unless the code is reverted first.
DROP TABLE IF EXISTS refusal_counts;
