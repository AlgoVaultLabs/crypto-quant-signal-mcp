-- 055_call_ledger.sql — DECISION-CALL-V2-W5 CH1
-- The call ledger: every logged pre_trade_check verdict is committed to a leaf, and a daily root on Base
-- anchors the leaves (contract: vault `Prompt/call-ledger-contract.md` v1 — its formats freeze at the first
-- anchor). One row per leaf:
--
--   ledger_id   the served receipt id, `pcl_` + 32 hex (16 CSPRNG bytes, never derived from a row, request or time)
--   kind        verdict | odds — two leaves per check
--   tool        the tool whose record the leaf commits (`pre_trade_check`; a later tool joins under its own tag)
--   ref_id      the check row's id (`pre_trade_checks.id`); no FK, so a later tool references its own table
--   leaf        `0x` + 64 hex. verdict: k(k(TAG_VERDICT ‖ k(JCS(record)))); odds: k(k(TAG_ODDS ‖ k(salt ‖ k(JCS(odds)))))
--   salt        odds rows only: 32 CSPRNG bytes. NEVER SERVED — no reader returns it, the lookup never selects it
--   batch_id    the call ledger's own batch sequence (1, 2, 3…; migrations/056), NULL until sealed
--   proof       the leaf's Merkle proof in its batch (a JSON array of `0x` hex), NULL until sealed
--
-- pre_trade_checks.ledger_id ties the check row to its receipt. INTERNAL except a leaf and its proof, which
-- `verify://check/{id}` serves; no record field, odds value, salt, caller or equity reaches any public surface.
--
-- Producer: recordPreTradeCheck (src/lib/pre-trade-check-log.ts) writes the check row and both leaves in ONE
--   statement, after the response, fail-open. Consumers: the daily anchor (publish-call-ledger-batch) and its
--   recheck; the health canary's leaf legs; the verify lookup.
--
-- Not pre-applied: the lazy ensure in src/lib/pre-trade-check-log.ts runs these exact statements once per
-- process before its first insert, under the app's own role. The new column is nullable with no default — a
-- catalog-only change — so a row written by code that predates it stays valid and reads NULL. The statements
-- are identical (pinned by tests/unit/call-ledger-pglite.test.ts).

CREATE TABLE IF NOT EXISTS call_ledger (
  id         BIGSERIAL   PRIMARY KEY,
  ledger_id  TEXT        NOT NULL CHECK (ledger_id ~ '^pcl_[0-9a-f]{32}$'),
  kind       TEXT        NOT NULL CHECK (kind IN ('verdict', 'odds')),
  tool       TEXT        NOT NULL,
  ref_id     BIGINT      NOT NULL,
  leaf       TEXT        NOT NULL UNIQUE CHECK (leaf ~ '^0x[0-9a-f]{64}$'),
  salt       TEXT        CHECK (salt ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id   INTEGER,
  proof      JSONB,
  UNIQUE (ledger_id, kind),
  CHECK ((kind = 'odds') = (salt IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_call_ledger_batch_id ON call_ledger (batch_id);

ALTER TABLE pre_trade_checks
  ADD COLUMN IF NOT EXISTS ledger_id TEXT;
