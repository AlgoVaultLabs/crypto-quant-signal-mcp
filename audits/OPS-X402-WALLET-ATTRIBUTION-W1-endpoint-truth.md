# OPS-X402-WALLET-ATTRIBUTION-W1 — endpoint-truth (R1, Plan-Mode)

**Produced BEFORE any code (CLAUDE.md Plan-Mode: endpoint-truth before C1; wait for architect).**

- **Base:** `origin/main` @ `33eedf3` · worktree `/Users/tank/code/cqsm-wt-x402-wallet` · branch `feat/x402-wallet-attribution-w1`
- **Prod:** container `crypto-quant-signal-mcp-mcp-server-1`, DB `signal_performance` @ `crypto-quant-signal-mcp-postgres-1`, Hetzner `204.168.185.24`
- **Probed:** 2026-07-12 (live schema + row census)
- **Verdict:** every cited primitive EXISTS (0 fictional). **3 material findings (okx scope · operator self-settle · backfill infeasibility) → HALT for architect.**

---

## A. Cited primitives — `claim | reality | resolution`

| # | Prompt claim | Reality (live-verified) | Resolution |
|---|---|---|---|
| 1 | `processed_x402_payments` nonce-keyed idempotency store | `src/lib/x402-idempotency-store.ts:34` — cols `nonce TEXT PK, tool TEXT, amount TEXT, created_at TIMESTAMPTZ`. **Live prod: exactly these 4 cols, NO `payer_wallet`.** | ✅ additive `payer_wallet TEXT NULL` confirmed non-existent. `information_schema` pre-check + `ADD COLUMN IF NOT EXISTS` (PG); pre-apply via SSH (autodeploy). |
| 2 | the wallet is IN every payment (ERC-3009 `from`) | `extractPaymentNonce` reads `payload.authorization.nonce` (`:131`); the ERC-3009 `from` is the SIBLING `payload.authorization.from`. Also `verifyResult.payer` (`x402.ts:280`) = the SDK's authoritative payer. | ✅ NEW `extractPayerWallet(paymentPayload)` sibling reading `payload.authorization.from` (+ defensive fallbacks), symmetric with `extractPaymentNonce`. |
| 3 | store additively; nonce stays PK/idempotency | `tryClaimPayment(nonce,tool,amount)` `:74` = `INSERT … ON CONFLICT (nonce) DO NOTHING RETURNING nonce`. Conflict arbitration is on `nonce` (PK). | ✅ extend to `tryClaimPayment(nonce,tool,amount,payerWallet?)` (additive trailing param); INSERT the col; **conflict still keyed on nonce ⇒ dedup byte-identical**; wallet never gates. |
| 4 | **both rails** carry the wallet / write the store | ❌ **Only the BASE/USDC rail writes `processed_x402_payments`** — two sites: HTTP `/x402/<tool>` (`x402-http-routes.ts:281`) + MCP `/mcp` x-payment tier (`license.ts:284`). **okx a2mcp does NOT** (grep empty; OKX managed facilitator settles internally — not in the store or the scoreboard x402 count). | 🛑 **F1** — see §C. Scope to Base (recommended) vs instrument okx separately. |
| 5 | scoreboard `quota→paid` consumer | `funnel-scoreboard.ts:455` agent funnel `paid_x402` = `COUNT(*) processed_x402_payments` (windowed); **its `paid_note:459` literally names THIS wave**. 2nd consumer `:641` = x402_separate census (payment count). | ✅ R4 swaps `:455` to `COUNT(DISTINCT payer_wallet)` (+ payment count secondary + repeat-payer view). `:641` census optional (Q5). |
| 6 | backfill where recoverable | The store keeps **no `from`, no payload, no tx-hash** — historical rows can't self-recover. Settle logs DO print `payer=…` (`x402.ts:305`) but the container has recreated many times since 2026-06-30 → those logs are **gone**. Only precise recovery = on-chain `AuthorizationUsed(nonce)→authorizer`. | 🛑 **F2** — see §C. Forward-only+label (recommended) vs one-shot on-chain backfill of 7. |
| 7 | idempotency contract to preserve | INSERT-ON-CONFLICT-DO-NOTHING-RETURNING on nonce PK; fail-safe reject on empty-nonce/DB-error (`:79`,`:99`). | ✅ preserved verbatim; `payer_wallet` is additive metadata on the winning insert only. |
| 8 | MCP `tools/list` frozen | No `server.tool`/schema touched — schema col + settlement-record + dashboard read only. | ✅ byte-identical by construction. |

---

## B. Live prod census (backfill sizing + the headline finding)

```
processed_x402_payments: 7 rows, ALL within 2026-06-30 14:45:35 – 14:57:01 UTC (one ~12-min burst)
  by tool: get_trade_signal×4, scan_trade_calls×1, scan_funding_arb×1, get_market_regime×1
columns: nonce, tool, amount, created_at   (NO payer_wallet — additive confirmed)
```

**This burst = the x402 self-settle harness, NOT organic agent demand.** 2026-06-30 is when `scan_trade_calls` was listed on the CDP Bazaar; the harness (operator buyer wallet **`0x76de…c755`**, ref: x402 self-settle harness) settles THROUGH each route to earn its Bazaar listing. The 4× `get_trade_signal` + 1× each of the 3 newly-priced tools matches a route-listing sweep. So all 7 `from` are almost certainly the ONE operator wallet — the "1 whale × 7" case in the explainer. **High-confidence (verifiable on-chain); it means today's x402 "revenue" is operator self-settle, and counting it as agent conversion would inflate the funnel.**

---

## C. Findings → HALT (detail in the audit doc's Q-block)

- **F1 (okx scope):** attribution is naturally BASE-rail-scoped (okx isn't in the store or the scoreboard x402 count). Capturing okx `from` needs a separate read of the OKX middleware payment context. Recommend Base-only this wave; okx = follow-up. (Resolves the prompt's "cross-rail identity" Q: no cross-rail count exists today; both rails are EVM `0x…` so a future unified-by-raw-address count works.)
- **F2 (backfill infeasible cheaply):** `from` not stored; 2026-06-30 settle logs gone; only precise path = on-chain `AuthorizationUsed(nonce)→authorizer` (read-only, feasible for 7). Given F3 (all operator), value is low. Recommend forward-only + label 7 rows "pre-instrumentation"; optional one-shot on-chain backfill.
- **F3 (operator self-settle — HEADLINE):** the 7 rows are operator self-settle, not real agents. Per the `instrumentation_artifact: operator_dev_key` pattern, the operator wallet(s) should be EXCLUDED/flagged in the distinct-paying-wallets CONVERSION metric so the funnel measures REAL agent conversion (else "1 paying wallet" is the operator). Needs the operator-wallet allowlist confirmed.
- **F4 (null handling):** `COUNT(DISTINCT payer_wallet)` excludes NULLs (pre-instrumentation) — label the transition ("N wallets / M payments; K pre-instrumentation").

---

## D. system-map edges (Step-0 enumeration)

- **Column add:** `processed_x402_payments +payer_wallet` (additive, nullable).
- **Write edge (extended):** the Base-rail settle record (`tryClaimPayment` via `x402-http-routes.ts` + `license.ts`) now also writes `payer_wallet` (from `extractPayerWallet`).
- **Read edge (changed):** scoreboard agent funnel `paid_x402` reads `COUNT(DISTINCT payer_wallet)` (was `COUNT(*)`), minus operator wallets.
- No producer/role/repo change; okx rail, quota resolver, `tools/list` untouched. → `system-map.md updated: Y` (col + read-metric change), edit the `crypto-quant-signal-mcp` row + overwrite `Last touched:` at implementation.
