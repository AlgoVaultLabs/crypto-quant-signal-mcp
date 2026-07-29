# OPS-X402-TRADE-CALL-CONTENT-TYPE-W1 — R0 endpoint-truth

**Wave:** OPS-X402-TRADE-CALL-CONTENT-TYPE-W1 · **Target ICP:** META (payments infra)
**Probed:** 2026-07-29 10:58–11:15 UTC (prod `v1.24.1`) · **Mode:** Plan-Mode, read-only
**Verdict:** spec hypothesis **H1 REFUTED**, **H2 PROVEN** and client-side; free HOLDs already
compliant. One **new** server defect found by this wave's own canary (see §4).

---

## 1. Spec claims vs reality

| # | Claim | Reality | Resolution |
|---|---|---|---|
| 1 | H1: the free-HOLD branch returns a non-x402-compliant response that the Circle client rejects | The HOLD branch **never executed**. Every failing request died at input validation with `body-keys=0` — ~100 lines before `callCoreHandler` and the settle branch. No verdict was ever computed. | 🛑 **REFUTED** |
| 2 | H2: a literal wrong/blank content-type | **PROVEN.** 3 live rejections (09:42:52 / 09:43:44 / 09:43:49 UTC) each logged `content-type="application/json, application/json"` + `body-keys=0`. | ✅ **CONFIRMED** |
| 3 | "the failure is at settle, is route-specific, and is deterministic" | Wrong on all three: it is at **input validation**; it is **client**-specific; it is deterministic only because the bad header is hardcoded in one file. | 🛑 Reframed |
| 4 | "`/x402/get_market_regime` pays fine → the route differs" | Both routes are fine. **The CLIENTS differ**: `pay.mjs` (fixed 15:47, no `headers`) vs `pay-call.mjs` (created **17:39** from the pre-fix template, still passing `headers`). | 🛑 Reframed |
| 5 | Free HOLDs may need a pricing decision | **No decision needed.** See §3 — they are already compliant and already free. | ✅ Closed |

## 2. Root cause

`~/Desktop/demo-circle-pay/pay-call.mjs:12` passes `headers: { "content-type": "application/json" }`
to Circle's `GatewayClient.pay()`, which already sets `Content-Type` (`dist/client/index.js:1109`).
Both case-different keys survive its `{...defaults, ...options.headers}` spread; `fetch` combines
them into `application/json, application/json`; `express.json()` declines it; the body arrives
empty. `invalid_content_type` is the diagnostic shipped hours earlier by
`OPS-CIRCLE-GATEWAY-PAY-REGRESSION-W1` — it named the cause correctly on first contact.

**Two clients, opposite requirements** (measured, and now documented in the public docs):

| Client | Sets `Content-Type` itself? | Caller must pass one? |
|---|---|---|
| Circle `GatewayClient.pay()` | **yes** | **NO** — adding one duplicates it |
| `x402-fetch` `wrapFetchWithPayment` (wraps raw `fetch`) | **no** — a string body goes as `text/plain` | **YES** — omitting it breaks the same way |

Both mistakes land on the same 400, from opposite directions. The repo's public quickstart uses
`x402-fetch`, so its `content-type` header is **correct and required** — "fixing" it to match the
Circle client would have broken it.

## 3. Free HOLDs are already x402-compliant — no change required

`x402-http-routes.ts`: `res.json(result)` runs **unconditionally** (HTTP 200 + the verdict); only
`settleX402Async` is gated on `verdict !== 'HOLD'`. `GatewayClient.pay()` throws solely when
`!paidResponse.ok`, so a HOLD returns normally with `data` populated and an empty `transaction`.
The operator smoke script already documents this as success. **Preserving free HOLDs needed zero
code change** — but nothing *tested* it, so this wave adds the assertion (R3).

Scope: exactly **one** tool has the HOLD-skip — `tool === 'get_trade_signal'`, covering
`/x402/get_trade_signal` and the `/x402/get_trade_call` alias. All others are `'PAID'`.
No pricing trap: `SIGNAL_TIMEFRAME_PRICING['1h'] = 0.02` (standard).
Directional verdicts were **not reachable live** (5/5 sampled HOLD), so the directional branch is
driven by a mocked verdict.

## 4. 🛑 NEW DEFECT — found by this wave's canary on its first run

The R2 matrix (every payable route × {clean, duplicated} content-type) failed on **3 of 7** routes:
`scan_funding_arb`, `scan_trade_calls`, `get_equity_regime` returned **200, not 400**.

Cause: the previous wave nested the dropped-body check **inside** the `!validate(input)` branch.
Those three schemas have **no required fields**, so an unparsed body validates clean as `{}` — the
route then served a **defaults-only** result and **charged for it**, silently discarding every
parameter the caller paid to specify. Strictly worse than the 400 it was meant to produce.

**Fix:** the dropped-body check now runs **before, and independently of, schema validation** — a
declared-but-unparsed body is an error regardless of whether the schema tolerates `{}`. Legitimate
callers are unaffected: no declared body → null; clean JSON content-type → null.

## 5. Verification

- Full vitest **337 files / 4164 tests, 0 fail** (was 4143 pre-wave).
- **Mutation checks:** deleting the `verdict !== 'HOLD'` exemption turns exactly **2** tests red
  (35 green); reverting the dropped-body guard turns the same **3** matrix routes red.
- Public docs regenerated; `build_docs` / `build_nav` / `build_analytics` `--check` all ✅.
- The in-snippet warning reaches **all three** surfaces (partial + `landing/docs.html` +
  `landing/rest-api.html`) because it lives inside the reused `<pre>` block rather than in adjacent
  prose, which only `docs.html` would have carried.
