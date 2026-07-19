# OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1 — endpoint-truth (R0)

**Date:** 2026-07-19 · **Base:** `origin/main` @ `973d615` · **Worktree:** `ops/x402-v2-payment-signature-w1`

Plan-Mode probe artifact. Every row below was produced by a concrete command against live code,
the installed SDK, or production — not from the spec text.

**Outcome: two independent HALT conditions fired** (the spec's own Step-0 condition, plus the
≥3-incorrect-premise threshold). Work resumed only after architect ratification (Q1–Q4 below).

---

## 1. `claim | reality | resolution`

| # | Spec claim | Probed reality | Resolution |
|---|---|---|---|
| 1 | `verifyX402Payment()` reads only `headers['x-payment']` | ✅ **TRUE** — `src/lib/x402.ts:369` (pre-wave) | proceed |
| 2 | "how is v1 decoded — **which `@x402/core` API**?" | ❌ **No SDK API.** Raw `JSON.parse(paymentHeader)` | premise correction |
| 3 | `@x402/core@2.9.0` exposes a v2 decoder | ✅ **TRUE** — `decodePaymentSignatureHeader(s: string): PaymentPayload`; runtime-verified among 12 exports of `@x402/core/http` | use it |
| 4 | HALT if the live CDP rail shares the touched fn | 🛑 **IT DOES.** `verifyX402Payment` is reached **only** via `resolveLicense` (`license.ts:217-218`) — the single chokepoint for **both** `/mcp` and `/x402/*`. No separate `x402ResourceServer` settle path exists. | **HALT** |
| 5 | "the CDP rail is **live-earning**" | ❌ **FALSE.** `processed_x402_payments` = **7 rows / 1 wallet / all 2026-06-30**; that wallet (`0x76de…c755`) is the operator's own self-settle harness. **Zero organic external payments, ever.** | premise correction |
| 6 | fix must "pass through `x402-http-routes.ts`" | ❌ **Not needed** — the route hands `req.headers` wholesale to `resolveLicense`. Only the `logCrawl` observability line read `x-payment` directly. | narrow scope |
| 7 | v2 is a **Gateway-only** concern | ❌ **Broader.** The live Base-**mainnet** 402 advertises `x402Version: 2` + a `PAYMENT-REQUIRED` header ⇒ a spec-conformant v2 client is invisible on the **live CDP rail today**. | reframe severity |
| 8 | Gateway flag-OFF ⇒ zero live impact | ✅ **TRUE** — prod log: `Circle Gateway scheme inactive — CIRCLE_GATEWAY_ENABLED is not "true"` | proceed |

## 2. The finding the spec did not contain

`@x402/core`'s own client **base64-encodes both versions** — only the header *name* differs:

```js
case 2: return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(p) };
case 1: return { "X-PAYMENT":          encodePaymentSignatureHeader(p) };
// encodePaymentSignatureHeader = safeBase64Encode(JSON.stringify(p))
```

Our v1 path was a bare `JSON.parse` — **raw JSON only**. So a *standards-conformant v1 client was
also invisible.* The live rail worked solely because the operator's harness deliberately emits raw
JSON to match our non-standard read.

**Runtime-probed discrimination invariant** (what makes accepting both provably safe):

| input | SDK base64 decoder | `JSON.parse` |
|---|---|---|
| raw JSON | ❌ throws `Invalid payment signature header` | ✅ |
| base64-of-JSON | ✅ | ❌ throws |

Neither dialect can be mistaken for the other. Circle's standard `Buffer.toString('base64')` is
byte-identical to the SDK's `safeBase64Encode` and decodes cleanly — no interop gap.

## 3. Behavior-identical proof (v1 rail)

Differential over a 10-input corpus, old `JSON.parse` vs new `decodeX402PaymentHeader`:

| result | count | detail |
|---|---|---|
| identical | **9 / 10** | raw JSON, whitespace-padded, unicode, empty, garbage, truncated, array, number, null |
| diverged | **1 / 10** | base64-of-JSON: OLD threw (silent false-reject of a conformant v1 client) → NEW accepts |

The single divergence **is** the architect-approved Q1=B widening. No input the old code accepted
changes behavior.

## 4. Architect decisions (ratified 2026-07-19)

| Q | Decision |
|---|---|
| Q1 decode scope | **B** — shape-tolerant on both headers (closes the conformant-v1 gap too) |
| Q2 cadence | **As specced** — no version bump; daily RELEASE batches it. No mainnet flip. |
| Q3 instrumentation | **Yes, both** — per-branch reject reasons + `logCrawl` v2 fix |
| Q4 v2 test payload | **B** — real `@x402/core` client encoder; no dependency on the unmerged settle branch |

## 5. Verification performed

| check | result |
|---|---|
| New suite `x402-v2-payment-signature.test.ts` | **16/16 pass** |
| **Mutation check** (disable the v2 header read) | **5 red** incl. the v2 cross-encoder canary; **all v1 tests stayed green** (proves teeth + no coupling) |
| Full `vitest run` | **300 files / 3446 tests pass**, 0 fail |
| node:test canaries | **487 pass / 0 fail** |
| Clean rebuild (`rm -rf dist && npm run build`) | clean `tsc`; `dist` carries the v2 read |
| Log-token consumer audit (`xpayment=`) | no live parser — only a `.bak` + historical audit text ⇒ format change safe |

## 6. Out of scope — follow-ups

- **No `PAYMENT-RESPONSE` receipt header** on the Base rail (only `okx-a2mcp` emits one). Circle
  reads it *optionally*, so it does **not** block payment. Settlement is fire-and-forget, so a
  synchronous receipt requires reordering ⇒ **separate wave**.
- Branch `ops/circle-gateway-testnet-settle-w1` (test-only, carries the captured Base-Sepolia
  payload) remains unmerged.
