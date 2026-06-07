-- 010_processed_x402_payments.sql — SECURITY-FIX-X402-WEBHOOK-W1 / X402-02 (Stream A)
-- Bounded single-use claim store for x402 (ERC-3009) payments, closing the
-- pre-settle replay window (SECURITY-AUDIT-RECENT-FEATURES-W1 / area1-x402.md
-- finding X402-02: `verifyX402Payment` is stateless + `settleX402Async` is
-- fire-and-forget, so within the ~2s pre-settle window the SAME X-PAYMENT header
-- replayed concurrently unlocks N resources for ONE on-chain charge; the ERC-3009
-- nonce is only burned on-chain at settle).
--
-- The PRIMARY KEY on `nonce` (the buyer's per-payment EIP-3009 authorization
-- nonce, a 0x-hex 32-byte value) is the idempotency anchor. The store's
-- `tryClaimPayment(nonce, tool, amount)` does an atomic `INSERT ... ON CONFLICT
-- (nonce) DO NOTHING RETURNING nonce` (src/lib/x402-idempotency-store.ts) — the
-- first claimer inserts a row + serves; a concurrent replay's INSERT is a no-op
-- (rowCount=0) → 402 before serve. Atomic INSERT (NOT the stripe-events-store
-- SELECT-then-INSERT) because the x402 threat is *concurrent* replay, not the
-- seconds-apart retry Stripe does.
--
-- Append-only. Pre-applied to prod `signal_performance` via SSH psql BEFORE the
-- code commit lands (CLAUDE.md "pre-apply schema via SSH then deploy code with
-- IF NOT EXISTS idempotency"); IF NOT EXISTS makes the committed code a no-op
-- against the prepared DB. Additive only — no existing table/query touched;
-- Data-Integrity safe. Monthly VACUUM (ANALYZE) per docs/RUNBOOK-POSTGRES-MAINT.md.

CREATE TABLE IF NOT EXISTS processed_x402_payments (
  nonce      TEXT PRIMARY KEY,                  -- ERC-3009 authorization nonce (0x-hex, per-payment unique)
  tool       TEXT,                              -- route the proof was claimed for (audit / forensic)
  amount     TEXT,                              -- atomic USDC units paid (audit / forensic)
  created_at TIMESTAMPTZ DEFAULT now()          -- when the claim landed
);

-- Supports a future cleanup cron (rows older than maxTimeoutSeconds are dead).
CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_created_at ON processed_x402_payments (created_at);
