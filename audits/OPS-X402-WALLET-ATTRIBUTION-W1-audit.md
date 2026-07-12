# OPS-X402-WALLET-ATTRIBUTION-W1 — R1 Plan-Mode audit

**Status: 🛑 HALT for architect (Mr.1).** Audit-first complete; every cited primitive live-verified (see `…-endpoint-truth.md`). 0 fictional. Three material findings reshape scope/metric → architect decisions required before R2.

**Target ICP:** META (internal analytics). **INTERNAL-ONLY** (wallet addresses never published). No version bump, no TG.

---

## 1. What's true today (the payment-record path)

`processed_x402_payments` (nonce PK · tool · amount · created_at) is the x402 idempotency store, written by `tryClaimPayment(nonce,tool,amount)` (INSERT ON CONFLICT (nonce) DO NOTHING RETURNING nonce). **Two write sites, BOTH the Base/USDC rail:** HTTP `/x402/<tool>` (`x402-http-routes.ts:281`) + the MCP `/mcp` x-payment tier (`license.ts:284`). The payer wallet (ERC-3009 `from`) is present at both — in `pendingSettlement.paymentPayload.payload.authorization.from` (sibling of the `nonce` we already read) and as `verifyResult.payer` — **just not stored**. The scoreboard agent funnel's `paid_x402` step (`funnel-scoreboard.ts:455`) counts `COUNT(*)` of this table; its `paid_note` already flags this wave.

**okx a2mcp is NOT here** — it settles through the OKX managed facilitator and touches neither the store nor the scoreboard's x402 count.

## 2. Live census — the headline

**7 rows, all in one ~12-min burst 2026-06-30 14:45–14:57** (get_trade_signal×4 + scan/regime/funding ×1). That's the **x402 self-settle harness** (operator buyer `0x76de…c755` settling routes to earn Bazaar listings 2026-06-30), NOT organic agents. So today's x402 "revenue" is operator self-settle — counting it as agent conversion inflates the funnel (the `operator_dev_key` instrumentation-artifact pattern).

## 3. Proposed design (for architect sign-off)

- **R2 — capture (both Base write sites):** NEW pure `extractPayerWallet(paymentPayload)` in `x402-idempotency-store.ts` (reads `payload.authorization.from` + defensive fallbacks; mirrors `extractPaymentNonce`). Extend `tryClaimPayment(nonce,tool,amount,payerWallet?)` — additive trailing param; `INSERT (nonce,tool,amount,payer_wallet)`. **Conflict still keyed on nonce ⇒ dedup/settle byte-identical; fail-open** (missing `from` → NULL + one log, never blocks the claim). Both call sites pass `extractPayerWallet(pendingSettlement.paymentPayload)`.
- **Schema:** `information_schema.columns` pre-check → `ALTER TABLE processed_x402_payments ADD COLUMN IF NOT EXISTS payer_wallet TEXT` **pre-applied via SSH** (push autodeploys), then the `CREATE TABLE` SQL gains the col for fresh DBs (idempotent no-op against prod).
- **R4 — scoreboard:** `paid_x402` → `COUNT(DISTINCT payer_wallet)` **excluding operator wallet(s)** (Q2) + payment count as secondary + a repeat-payer view (top wallets by call count, **truncated `0x76de…c755`**, operator-only) + updated `paid_note`. `COUNT(DISTINCT)` ignores NULLs → label "N wallets / M payments; K pre-instrumentation".
- **R3 — backfill:** recommend forward-only + label the 7 as pre-instrumentation (value low per §2); optional one-shot on-chain `AuthorizationUsed(nonce)→authorizer` read for exactness.

## 4. Guardrails (pre-checked)

Nonce stays PK; dedup/settle byte-identical (payer_wallet never gates). Additive nullable col + info-schema pre-check. Internal-only — addresses never in public copy/endpoints; operator display truncated; `outcome_return_pct` untouched. `tools/list` byte-identical (no tool/schema change). No version bump.

## 5. system-map

`processed_x402_payments +payer_wallet` col; Base-rail settle-record write edge extended; scoreboard `paid_x402` read edge → distinct-wallet. `system-map.md updated: Y` at implementation (col + read-metric), edit the `crypto-quant-signal-mcp` row + overwrite `Last touched:`. (endpoint-truth §D.)

---

## 6. HALT — architect (Mr.1) decision block

Plain framing above; the questions Mr.1 answers are in ONE fenced block (copy-paste to Cowork):

```
OPS-X402-WALLET-ATTRIBUTION-W1 — Plan-Mode HALT (audit-first; base origin/main 33eedf3)
All cited primitives verified; 0 fictional. Blocking decisions:

Q1 [rail scope]. Only the BASE/USDC rail writes processed_x402_payments (HTTP /x402 +
    MCP x-payment); okx a2mcp settles via the OKX managed facilitator and is in NEITHER the
    store NOR the scoreboard's x402 count. Choose:
      (A, RECOMMENDED) scope wallet attribution to the Base rail (matches the store + the
          existing metric); okx = separate follow-up (needs a read of the OKX middleware
          payment context, not available in our store today).
      (B) also instrument okx now (larger; okx `from` capture is unverified).

Q2 [operator self-settle exclusion — HEADLINE]. The 7 historical payments are ALL the
    2026-06-30 14:45-14:57 self-settle-harness burst (operator buyer wallet 0x76de…c755
    listing routes on the Bazaar), NOT real agents. Exclude/flag operator wallet(s) from the
    distinct-paying-wallets CONVERSION metric (documented operator-wallet allowlist), so the
    funnel measures REAL agent conversion?
      (RECOMMENDED: YES — else "1 paying wallet" is the operator, inflating quota→paid.)
    Confirm the operator wallet set: 0x76de…c755 (self-settle buyer) — any others
    (e.g. a 2nd harness/dev wallet) to add to the exclusion allowlist?

Q3 [backfill]. `from` is NOT stored; the 2026-06-30 settle logs are gone (container recreated
    many times since); only precise recovery = on-chain AuthorizationUsed(nonce)→authorizer
    (read-only, feasible for 7 rows). Given Q2 (all operator), choose:
      (A, RECOMMENDED) forward-only — label the 7 rows "pre-instrumentation (wallet unknown)".
      (B) one-shot on-chain backfill of the 7 (read-only; would confirm they're all 0x76de…c755).

Q4 [cross-rail identity]. Store the raw 0x `from`; count distinct by raw 0x address (a wallet
    is a wallet). Moot until okx is captured (both rails are EVM 0x… so a future okx capture
    unifies by raw address). Confirm unified-by-raw-0x (not per-chain-namespaced).

Q5 [scoreboard scope]. R4 targets the AGENT FUNNEL quota→paid step (distinct wallets, exact).
    Also add distinct-wallets alongside payment-count to the x402_separate census
    (funnel-scoreboard.ts:641, paying-subscribers section)?
      (RECOMMENDED: add distinct alongside count — one extra scalar, consistent.)

After answers: R2 extract+store → R3 backfill/label → R4 scoreboard distinct-wallet → R5 tests
(both rails write payer_wallet from fixture ERC-3009; missing→null+log fail-open; idempotency
byte-identical; distinct-agg 1×N vs N×1; no public address exposure; tools/list byte-identical)
+ clean rebuild + both gates → R6 status.md + system-map + Activation.md ✅.
```
