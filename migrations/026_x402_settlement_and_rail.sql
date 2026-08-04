-- 026_x402_settlement_and_rail.sql
-- REVENUE-METER-TRUTH-W2 · CH3
--
-- WHY. This table is named for payments and stores INTENTIONS. `tryClaimPayment` writes a row the
-- moment a buyer PRESENTS an ERC-3009 authorization; nothing has ever checked the authorization was
-- subsequently USED on-chain. REVENUE-METER-TRUTH-W1 CH2 ran that check for the first time, over
-- every live row, via Base USDC `AuthorizationUsed(address indexed authorizer, bytes32 indexed
-- nonce)`:
--
--     SETTLED=0 · OPERATOR=3 · CLAIMED_UNSETTLED=15 · UNRESOLVABLE=0   (X402_SETTLEMENT_VERDICT=COMPLETE)
--
-- i.e. 15 of 18 "payments" never moved any money, and external settled x402 revenue is $0.00. That
-- verdict existed only in a report. This migration persists it, so the table can answer the question
-- it has always implied.
--
-- Second column, same change: the table cannot distinguish RAILS. `/a2mcp/*` (OKX / X-Layer / USDT0)
-- does not write here at all, so any SUM over this table is a Base-only figure presented as an x402
-- total. `rail` describes ROWS THAT EXIST, never all x402 revenue. Making OKX write here is a
-- separate producer change: OPS-A2MCP-SETTLEMENT-RECORDING-W{NEXT}, filed not fixed.
--
-- One migration for one logical change: two ALTERs against a live payments table for a single
-- conceptual addition is strictly worse than one.
--
-- LIVE STATE at authoring (probed 2026-08-04 on prod):
--   rows = 18 · distinct payer_wallet = 4 · payer_wallet IS NULL = 0 · sum(amount) = 350000 atomic
--   The ZERO NULLs matter: migration 024 (:33) converted every NULL to '' and then set NOT NULL, so
--   any `WHERE ... IS NULL` selector matches NOTHING. That is not hypothetical — it silently reduced
--   src/scripts/backfill-x402-payer-wallet.ts to a no-op from 2026-08-02 until W1 CH2 widened it.
--
-- WHY NO CHECK CONSTRAINT on settlement_state. Enforcing the vocabulary in the database was the
-- first draft and is REJECTED on purpose. `tryClaimPayment` fails safe: any DB error returns false
-- and the route 402s. So a CHECK violation from an unexpected value would REFUSE PAYMENTS — the
-- exact shape of the 25-hour outage this arc already closed (an ON CONFLICT mismatch that made every
-- paid call fail). The vocabulary is enforced where a violation is cheap instead: the `SettlementClass`
-- union in src/scripts/backfill-x402-payer-wallet.ts plus its unit tests. A guard on the live money
-- path must not be able to refuse a real payment.
--
-- Postgres only. SQLite's tables are created fresh from CREATE_PROCESSED_X402_PAYMENTS_SQL in
-- src/lib/x402-idempotency-store.ts, which carries both columns directly, so test DBs need no
-- migration. (Dual-backend law: PG has ADD COLUMN IF NOT EXISTS, SQLite does not.)
--
-- DOWN-PATH: migrations/026_x402_settlement_and_rail.down.sql. Dropping these columns is lossless
-- for the CLAIM record (nonce/tool/amount/created_at/payer_wallet are untouched) but discards the
-- settlement classification, which costs an on-chain re-scan to rebuild. Not destructive; just slow
-- to undo.

BEGIN;

-- 1. Settlement state. Default CLAIMED_UNSETTLED is the HONEST default for a new claim: at insert
--    time nothing has verified settlement, so a fresh row is a claim and says so. Promotion to
--    SETTLED/OPERATOR is the on-chain scan's job (`backfill-x402-payer-wallet.ts --classify --execute`).
--    ADD COLUMN with a constant default is metadata-only on PG 11+, so no table rewrite.
ALTER TABLE processed_x402_payments
  ADD COLUMN IF NOT EXISTS settlement_state TEXT NOT NULL DEFAULT 'CLAIMED_UNSETTLED';

-- 2. Rail discriminator. `unknown` is the default because a writer that does not declare its rail
--    must not have one guessed for it.
ALTER TABLE processed_x402_payments
  ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'unknown';

-- 3. Historical backfill — this ENCODES CH2's completed scan; it does not re-derive it.
--
--    ⚠️ READ THIS BEFORE COPYING THE RULE. Matching on the operator wallet is NOT what makes a row
--    settled, and this is not an ongoing derivation. It is a one-time transcription that happens to
--    be expressible as a predicate, because CH2's scan found that the ONLY rows with an on-chain
--    `AuthorizationUsed` log were exactly the three carrying the operator wallet. A future operator
--    row that never settles would be mis-labelled by this predicate — which is precisely why the
--    forward path is the scan, not this WHERE clause.
UPDATE processed_x402_payments
   SET settlement_state = 'OPERATOR'
 WHERE lower(trim(payer_wallet)) IN ('0x76de895fdd3f7b5814eb59ccd244b06b47d8c755');

-- 4. Rail backfill. Every existing row was written by one of exactly TWO writers — the HTTP /x402
--    route and the MCP x-payment path — and both are Base/USDC. So this is structural, not a guess:
--    there is no code path by which a non-Base row could be in this table today.
UPDATE processed_x402_payments SET rail = 'base-usdc';

-- 5. The canary and the funnel both read settlement_state for a bounded window.
CREATE INDEX IF NOT EXISTS idx_processed_x402_payments_settlement
  ON processed_x402_payments (settlement_state, created_at);

COMMIT;
