# OPS-CIRCLE-GATEWAY-PAY-REGRESSION-W1 — R0 endpoint-truth

**Wave:** OPS-CIRCLE-GATEWAY-PAY-REGRESSION-W1 · **Target ICP:** META (payments infra)
**Probed:** 2026-07-29 06:20–08:00 UTC (Hetzner `204.168.185.24`, prod `v1.24.1`, container up since
`2026-07-28T15:29Z`) · **Mode:** Plan-Mode, read-only · **Verdict:** spec premise REFUTED; two
distinct client-side causes; zero server defects in the payment path.

All addresses below are public on-chain identifiers. No credential, key, or PII appears here.

---

## 1. Spec claims vs reality

| # | Spec claim | Reality | Resolution |
|---|---|---|---|
| 1 | `grep -c 'proofBindsToAnyRail' /app/dist/index.js` = `0` ⇒ a release dropped the fix | `0`, but the probe is **fictional**. `tsc` emits per-module, not a bundle: the symbol lives at `/app/dist/lib/x402.js` (**3**, matching `src/lib/x402.ts:765,815,881`). `dist/index.js` can never contain it. | 🛑 **Probe wrong. Premise REFUTED.** AC3 as written was unsatisfiable. Fixed at the generator (CLAUDE.md + a pinning test). |
| 2 | A redeploy may have reset the Gateway env | `CIRCLE_GATEWAY_ENABLED=true` · `CIRCLE_GATEWAY_NETWORK=eip155:10` · `CIRCLE_GATEWAY_SELLER_ADDRESS=0x11447b963c1408E7c84868314eF2fe9304768717` · `CIRCLE_GATEWAY_FACILITATOR_URL=https://gateway-api.circle.com`. Boot log: `Circle Gateway scheme ACTIVE (additive) — network=eip155:10`. | ✅ **Intact. REFUTED.** |
| 3 | A release dropped/bypassed `6184d04` | `6184d04` is an ancestor of `origin/main`; **zero** commits in `6184d04..origin/main` touch `src/lib/x402.ts` or `src/lib/circle-gateway.ts`. Image built `2026-07-28T15:29Z`, ~6 min after tip `938e40c`. | ✅ **REFUTED.** |
| 4 | Wrong/empty `payTo` → `address_mismatch` | Live 402 `accepts[1]`: `exact` / `eip155:10` / `20000` / asset `0x0b2C63…Ff85` / `payTo 0x1144…8717` / `extra.name GatewayWalletBatched` / `verifyingContract 0x77777777dcc4d5a8b6e418fd04d8997ef11000ee`. **Byte-identical to Circle's live `/v1/x402/supported` kind for `eip155:10`.** | ✅ **Correct. REFUTED.** No domain staleness. |
| 5 | The rail worked, then regressed | Circle `/v1/x402/transfers`: exactly **one** transfer ever — `e621e40b-3322-4240-99f6-5d7db6341116`, `0x7da6…a45 → 0x1144…717`, `20000`, `completed`, tx `0x4e0b7f5a146ec1012e621e5a681e5bc36ecab81ecfb0492e3c49c84c46a6f77f`, created **`2026-07-26T10:54:07Z`**. | ✅ Rail did work once. ⚠️ Date drift: spec + `status.md` said 07-25; Circle records **07-26**. |
| 6 | Same "advertised-but-unpayable" binding shape as `6184d04` | **Different class, twice over.** Binding never executed in either failure. | 🛑 **REFUTED** — see §2. |

## 2. The two actual causes (both client-side)

### Cause A — `self_transfer` (2026-07-29 06:21:09Z)

```
x402 verify failed [v2-payment-signature]: self_transfer — undefined
[x402-route] POST /x402/get_market_regime status=402 paid=y dialect=v2 ua="node"
```

`self_transfer` is **not** in our source, our sidecar facilitator, or any bundled SDK (`grep` over
`/app/node_modules` = 0). It is a **Circle-defined** code — confirmed in Circle's OpenAPI
(`developers.circle.com/openapi/gateway.yaml:323`, alongside `address_mismatch` / `amount_mismatch`
/ `insufficient_balance`) — meaning **sender == recipient**.

Confirmed by the operator: the run signed with the **seller's** key, so the burn intent's sender
equalled the advertised `payTo`. Corroborating signal found during R0: the seller's Gateway balance
was **exactly `0.020000`** — exactly the price — so `scripts/circle-gateway-buyer-smoke.mjs` skipped
its deposit branch and reached `pay()` immediately, and its buyer-address check only **warned**.

### Cause B — `invalid_input` (2026-07-29 07:24:34Z and 07:26:35Z), after the key was corrected

```
07:24:33 [x402-route] POST /x402/get_market_regime status=402 paid=n dialect=-
07:24:34 [x402-route] POST /x402/get_market_regime status=400 paid=y dialect=v2 ua="node"
```

`paid=y` with **no** verify-failure line — the payment verified; our own body validation returned
400. `invalid_input` occurs exactly once in our source (`src/lib/x402-http-routes.ts:254`) and
**zero** times in Circle's error enum. The SDK surfaces our JSON body's `error` field verbatim
(`@circle-fin/x402-batching@3.2.0`, `dist/client/index.js:1199`).

The body never reached the validator. `demo-circle-pay/pay.mjs` passed
`headers: { 'content-type': 'application/json' }` to an SDK that already sets
`Content-Type: application/json` (`dist/client/index.js:1109`). Both case-different keys survive the
`{...defaults, ...options.headers}` spread; `fetch` then **combines** them. Measured:

| Client | merged keys | what `fetch` sends | `express.json()` parses? |
|---|---|---|---|
| `pay.mjs` | `["Content-Type","content-type"]` | `"application/json, application/json"` | **false** |
| `circle-gateway-buyer-smoke.mjs` (no `headers`) | `["Content-Type"]` | `"application/json"` | **true** |

→ `req.body` empty → ajv `required:['coin']` fails → 400. That is why the proven 07-26 smoke worked
and the demo script did not.

### Ruled out by evidence

- **Deployed schema is innocent** — ran the real `BAZAAR_ROUTES.get_market_regime.inputSchema`
  through the real ajv config **in-container** against `{coin:"BTC",timeframe:"1h"}` → `VALID: true`.
- **No server drift** — `src/lib/x402-http-routes.ts` and `src/lib/x402-bazaar.ts` byte-identical
  since `6184d04` (`git diff --stat` empty).
- **The one 07-28 serving-path commit (`98f4a1d`)** adds header middleware that calls `next()`, and
  its Caddyfile hunk is scoped to the **apex** static block, not `api.algovault.com`.
- **The operator's own two suspects** — a tight validity window (`604800..604900`) would surface as
  Circle `authorization_validity_too_short`/`authorization_expired` at verify (verify **passed**);
  a `BatchFacilitatorClient.settle` field cannot be implicated because settle never ran.
- **No money moved.** Validation precedes `tryClaimPayment` and `settleX402Async`. Circle still
  shows one transfer; buyer Gateway balance unchanged at `0.976983` on domain 2 (Optimism).

## 3. Server-side defects this wave DOES fix

Neither failure was a payment-path bug, but **both were undiagnosable from our own logs** — the
same class the 2026-07-18 wave named ("instrument every rejection path before debugging a payment
402"), discharged then for our rejections but never for the facilitator's inputs or the
post-payment 400.

| Defect | Fix |
|---|---|
| Verify failure logged the verdict, not the inputs | `x402.ts` — log payer, rail (`extra.name`), network, payTo, tool alongside Circle's reason |
| A paid, verified request could be 400'd silently | `x402-http-routes.ts` — log content-type, body-key count and ajv errors; return `invalid_content_type` when the body was dropped rather than a misleading schema error |
| Deployed-artifact canary aimed at a path that can't contain the symbol | Corrected to `dist/lib/x402.js`; mapping pinned by test; CLAUDE.md corrected |
| Buyer smoke warned-and-continued on the wrong key | Hard exit + an unconditional `buyer == advertised payTo` self-transfer guard |
