-- 056_anchor_batches.sql — DECISION-CALL-V2-W5 CH2
-- The two batch tables of the ONE crash-safe anchor (src/lib/anchor-batch.ts): reconcile -> seal -> send -> verified,
-- one batch per UTC day per ledger, under one Postgres advisory lock (one publisher EOA, one nonce sequence).
--
-- call_ledger_batches — the call ledger's batches (contract: vault `Prompt/call-ledger-contract.md` v1). One row
--   per batch: its root, its leaf count, its state, the tx that anchored it on the call-ledger registry, the block,
--   the chain time it was anchored, and the last time the recheck rebuilt its root from the stored check rows and
--   found it equal to the one on chain. Leaves join it through call_ledger.batch_id (055).
--   Producer: publish-call-ledger-batch (cron 13 0 * * *). Consumers: its recheck; the health canary's anchor leg
--   (to_regclass, read-only); the verify lookup.
--
-- merkle_batch_seals — the signal record's seals. The pre-W5 publisher sent `publishRoot` and THEN wrote, so a kill
--   in between orphaned a root for good; now each batch is sealed here first (root, count, signal ids and each
--   signal's proof) and only the chain's confirmation moves it into merkle_batches + signals, in one statement,
--   with the same values the old writer produced. The seal row is kept (state verified, its ids and proofs
--   dropped once they are on signals): it records WHEN the batch was sealed, which "one batch per UTC day" is
--   judged on. merkle_batches and /api/merkle-batches keep their shapes.
--   Producer: publish-merkle-batch (cron 5 0 * * *). Consumer: its own reconcile.
--
-- Not pre-applied: each publisher's lazy ensure runs its statement once per process before first use, under the
-- app's own role (publish-call-ledger-batch.ts CREATE_CALL_LEDGER_BATCHES_SQL; publish-merkle-batch.ts
-- CREATE_MERKLE_BATCH_SEALS_SQL). The statements are identical (pinned by tests/unit/anchor-batch.test.ts).
-- Written to Postgres 16 (production 16.13); CI's Postgres lane applies it to postgres:16-alpine.

CREATE TABLE IF NOT EXISTS call_ledger_batches (
  batch_id      INTEGER     PRIMARY KEY CHECK (batch_id > 0),
  root          TEXT        NOT NULL CHECK (root ~ '^0x[0-9a-f]{64}$'),
  leaf_count    INTEGER     NOT NULL CHECK (leaf_count > 0),
  state         TEXT        NOT NULL CHECK (state IN ('sealed', 'sent', 'verified')),
  tx_hash       TEXT        CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number  BIGINT,
  sealed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  anchored_at   TIMESTAMPTZ,
  recheck_ok_at TIMESTAMPTZ,
  CHECK (state = 'sealed' OR tx_hash IS NOT NULL),
  CHECK ((state = 'verified') = (block_number IS NOT NULL AND anchored_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS merkle_batch_seals (
  batch_id     INTEGER     PRIMARY KEY CHECK (batch_id > 0),
  merkle_root  VARCHAR(66) NOT NULL,
  signal_count INTEGER     NOT NULL CHECK (signal_count > 0),
  signal_ids   INTEGER[],
  proofs       TEXT[],
  state        TEXT        NOT NULL CHECK (state IN ('sealed', 'sent', 'verified')),
  tx_hash      VARCHAR(66),
  sealed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at  TIMESTAMPTZ,
  CHECK (cardinality(signal_ids) = cardinality(proofs)),
  CHECK ((state = 'sealed') = (tx_hash IS NULL)),
  CHECK ((state = 'verified') = (verified_at IS NOT NULL)),
  CHECK ((state = 'verified') = (signal_ids IS NULL AND proofs IS NULL)),
  CHECK (state = 'verified' OR (signal_ids IS NOT NULL AND proofs IS NOT NULL))
);
