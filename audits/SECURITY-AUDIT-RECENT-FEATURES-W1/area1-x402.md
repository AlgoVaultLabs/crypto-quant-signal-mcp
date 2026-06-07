# SECURITY-AUDIT-RECENT-FEATURES-W1 — Area 1: x402 Payment Path

**Owner:** X402-AUDITOR (teammate 1/5) · **Requirement:** R1 · **Type:** READ-ONLY forensic audit
**Canonical clone:** `~/code/crypto-quant-signal-mcp` @ `origin/main` `aec4175` · **Produced:** 2026-06-07
**Live prod posture (SSH-verified):** `X402_FACILITATOR=cdp`, `BAZAAR_DISCOVERABLE=true`, `X402_NETWORK=base-mainnet` → **the 3 `/x402/*` routes ARE mounted and live on Base mainnet** (GET+POST `/x402/get_trade_signal` → 402 confirmed). Findings below that depend on route mounting are therefore **live-exploitable today**, not theoretical.

---

## 1. Summary

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 1 | X402-01 |
| MEDIUM | 2 | X402-02, X402-03 |
| LOW | 2 | X402-04, X402-05 |
| INFO | 3 | X402-06, X402-07, X402-08 |

**Headlines (1 line each):**
- **X402-01 (HIGH)** — Cross-tool price downgrade: a valid **$0.01** `scan_funding_arb` proof, POSTed to the **$0.02** `/x402/get_trade_signal` (or `/x402/get_market_regime`) route, passes verify and is served — a **50% underpayment**, because `verifyX402Payment` matches against ALL tools' requirements with no route↔price binding and `isPaymentSufficient()` is dead code. **PoC passes.**
- **X402-02 (MEDIUM)** — No server-side payment idempotency: one valid `X-PAYMENT` replayed concurrently within the ~2s async-settle window unlocks N resources for ONE on-chain charge (bounded to the pre-settle window by on-chain nonce burn). **PoC passes.**
- **X402-03 (MEDIUM)** — Per-timeframe premium pricing (`SIGNAL_TIMEFRAME_PRICING`: 1m=$0.05/3m=$0.04/5m=$0.03) is **never enforced**; the 402 + requirement only ever charge the base $0.02, so an agent gets a 1m HFT signal for 40% of its intended price.
- **X402-04 (LOW)** — Verify-vs-settle release-before-confirm window (the "RISK-ACCEPTED-001" the spec cites is actually a **marketing-positioning** acceptance, NOT this payment risk — the race is *undocumented* as accepted). Per-request ceiling $0.01–$0.02; bounded by the facilitator's verify-time balance check.
- **X402-05 (LOW)** — `tolerantJson` swallows body-parse errors to `{}` and ajv runs with `coerceTypes:true`; harmless today (paywall precedes parsing; `additionalProperties:false` on all schemas) but a hardening note.
- **X402-06 (INFO)** — **R1.1 verdict: SVM path NOT exposed.** `@x402/svm` (the GHSA-qr2g-p6q7-w82m package, vulnerable `<2.6.0`) is **absent** from disk and lockfile; no Solana scheme is registered or advertised; EVM-only.
- **X402-07 (INFO)** — `viem@2.47.12` falls in a MODERATE advisory range (`<=2.49.3`) but is confined to the facilitator container + on-chain scripts, not the core verify path (LEAD cross-cutting item).
- **X402-08 (INFO)** — The paid PAID-path amount/tool binding is **completely untested** — existing `x402-http-routes.test.ts` only covers unpaid→402 + the two-flag mount; no test exercises a settled payment.

**AC-relevant verdicts:**
- **R1.1 SVM exposure: NO (not exposed)** — proven by lockfile + on-disk absence + EVM-only scheme registration.
- **R1.2 (a–d) independent assertion:** (a) amount **PARTIAL — fails for cross-tool** (X402-01); (b) asset **PASS**; (c) network **PASS**; (d) recipient **PASS**.
- **R1.4 verify-vs-settle:** race exists, bounded, **mis-attributed** in spec (not covered by RISK-ACCEPTED-001).
- **R1.6 CDP keys:** **PASS** — env-only, absent from logs (prod-proven), never hardcoded, `.env` untracked.
- **R1.7 two-flag firewall + onchain blocklist:** **PASS** — mount-gated; blocklist clean.

---

## 2. Findings

### X402-01 · HIGH · payment-amount binding (R1.2a) · `src/lib/x402.ts:231` + `src/lib/x402-http-routes.ts:165-177`

**Exploit scenario.** The 3 paid HTTP routes are live on Base mainnet (prod flags confirmed). `verifyX402Payment` (x402.ts:215) builds its matching pool by flattening **every** tool's pre-built requirement:

```
const allReqs = Array.from(toolRequirements.values()).flat();   // x402.ts:231 — ALL tools
const matchingReqs = resourceServer.findMatchingRequirements(allReqs, paymentPayload);
```

`findMatchingRequirements` (x402Version 2, `@x402/core` server/index.mjs:632-647) returns whichever requirement **`deepEqual`s** the buyer's `payload.accepted` block. The requirement object the SDK builds is `{scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra}` (server/index.mjs:322-334) — it carries **no tool/route identity and no resource URL**. The HTTP route handler then gates ONLY on `license.tier === 'x402' && pendingSettlement` (x402-http-routes.ts:174) and **never re-asserts that the matched requirement's amount equals `TOOL_PRICING[<the route being called>]`**. The guard that would catch this, `isPaymentSufficient(toolName, paidAmount)` (x402.ts:364), has **zero callers** — it is dead code.

Because `scan_funding_arb` is the only $0.01 tool and the other two are $0.02, an attacker:
1. Fetches the legitimate **$0.01** `scan_funding_arb` 402 and signs a valid ERC-3009 authorization for `value=10000` to `payTo`.
2. POSTs that exact payment to **`/x402/get_trade_signal`** ($0.02) or **`/x402/get_market_regime`** ($0.02).
3. `findMatchingRequirements` deep-equals it to the $0.01 requirement (which is in `allReqs`); the facilitator's verify confirms `authorization.value(10000) === requirements.amount(10000)` and a sufficient balance — both true — so verify **passes**; the route serves the $0.02 tool output. The async settle then charges only **$0.01** on-chain.

Net: **the two most expensive tools are purchasable at half price, indefinitely.** (The same `allReqs`-flattening gap is in the MCP `/mcp` path at index.ts:2071, which shares `resolveLicense`→`verifyX402Payment`.)

**Evidence.** PoC `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/poc/x402-cross-tool-downgrade.mjs` (self-contained; re-implements the SDK `deepEqual`+`findMatchingRequirements` verbatim and the reconstructed prod requirement objects) → **RESULT: VULNERABILITY CONFIRMED — pay $0.01, receive $0.02 output.** `grep -rn isPaymentSufficient src/` → only the definition line (dead). `tests/x402-http-routes.test.ts` asserts nothing on the paid path (X402-08).

**Recommended GENERATOR-LEVEL fix.** Bind verification to the **route's** required amount, at the single chokepoint, so every present and future paid route inherits it:
- Pass the target `tool` (or its `requirements`) into `verifyX402Payment(headers, tool)` and match against **only `toolRequirements.get(tool)`**, not the global `allReqs` flatten — i.e. the matched requirement must be the requested route's requirement.
- AND add a post-verify assertion `assert(matched.amount === toolRequirements.get(tool)[0].amount)` (re-activate `isPaymentSufficient` against atomic units) as defense-in-depth.
- Add the missing **paid-path** test: a settled `scan_funding_arb` proof against `/x402/get_trade_signal` MUST 402/reject. This closes the class for the MCP path, the 3 HTTP routes, and any future paid tool.

**Proposed follow-up wave:** `OPS-X402-ROUTE-PRICE-BINDING-W1` (P0).

---

### X402-02 · MEDIUM · replay / idempotency (R1.3) · `src/lib/x402.ts:215-284` + `src/index.ts:2196` + `src/lib/x402-http-routes.ts:202`

**Exploit scenario.** `verifyX402Payment` is **stateless** — it keeps no record of payment payloads it has already accepted (only `toolRequirements`, used for matching). `settleX402Async` is **fire-and-forget**, invoked AFTER `res.json(...)` at both call sites (index.ts:2196-2200; x402-http-routes.ts:198 then :203). The ERC-3009 nonce is only burned **on-chain at settle** (~2s later per the x402.ts header doc). The facilitator's verify (`@x402/evm` exact/facilitator `verifyEIP3009`) DOES `simulateEip3009Transfer`, so once the nonce is consumed on-chain a replay fails — **but only after the first settle lands**. Within the pre-settle window, an attacker firing the same valid `X-PAYMENT` header concurrently gets **N paid resources for ONE on-chain charge**.

**Evidence.** PoC `poc/x402-replay-window.mjs` → **20/20 concurrent replays SERVED before nonce burn; replay rejected after settle.** `grep -rniE 'nonce|idempotenc|consumed|dedup' src/lib/x402.ts src/lib/license.ts` → no payment-dedup store. (Contrast: CLAUDE.md mandates an idempotency store keyed by event-id for *webhook* side-effects — x402 has no equivalent.)

**Recommended GENERATOR-LEVEL fix.** Add a verify-time single-use claim BEFORE serving: a `tryClaimPayment(nonce|paymentId)` against a small store (in-memory LRU with TTL ≥ maxTimeoutSeconds, or the existing Postgres `processed_*` pattern), mirroring `webhooks-store.tryClaimDelivery()`. Claim on verify-pass; a second claim of the same nonce → 402. Bounds replay to exactly 1 regardless of settle latency.

**Proposed follow-up wave:** `OPS-X402-PAYMENT-IDEMPOTENCY-W1` (P1).

---

### X402-03 · MEDIUM · pricing-intent gap (R1.2a, adjacent) · `src/lib/x402.ts:65-77, 176-194`

**Exploit scenario.** `SIGNAL_TIMEFRAME_PRICING` declares premium prices for short timeframes (`1m`=$0.05, `3m`=$0.04, `5m`=$0.03) but has **zero callers** (`grep -rn SIGNAL_TIMEFRAME_PRICING src/` → definition only). `initX402` builds the `get_trade_signal` requirement from the BASE `TOOL_PRICING.get_trade_signal` ($0.02) only (x402.ts:177). So a buyer pays **$0.02 for a 1m signal intended to cost $0.05** — a 60% discount on the most valuable (HFT) timeframe. Because the 402 itself only ever advertises $0.02, this is a **pricing-realization** gap, not a verify bypass (the buyer pays exactly what the 402 asked), so it is MEDIUM not HIGH.

**Evidence.** `grep` (zero callers) + the requirement-build loop reading `TOOL_PRICING` not the timeframe table.

**Recommended fix.** Either (a) build per-timeframe requirements and advertise the correct price in the 402 for the requested timeframe (requires the route to know the timeframe before issuing the 402 — a body-aware 402), or (b) delete `SIGNAL_TIMEFRAME_PRICING` as dead intent and document base-flat pricing. Couple with X402-01's route-amount binding so the realized price always equals the advertised one.

**Proposed follow-up wave:** fold into `OPS-X402-ROUTE-PRICE-BINDING-W1`.

---

### X402-04 · LOW · verify-vs-settle release-before-confirm (R1.4) · `src/lib/x402.ts:266-284`, call sites index.ts:2196 / x402-http-routes.ts:203

**Exploit scenario.** The resource is served (`res.json`) BEFORE settle confirms; settle is async fire-and-forget. If settle later fails (on-chain revert, or the payer front-runs their own authorization by moving the USDC in the ~2s window), the resource was served free. The facilitator's verify performs a **balance check** (`balanceOf`, `@x402/evm` chunk-CRT6YNY5.mjs:341/383) and an exact `value===amount` check ~2s earlier, which makes settle-failure-by-insufficient-funds unlikely → per-request loss ceiling **$0.01–$0.02**, matching the deliberate "respond fast, settle async" design (x402.ts:11-12).

**Spec correction (important).** The wave brief and `endpoint-truth.md` attribute this to `RISK-ACCEPTED-001 (2026-04-25)`. The actual `RISK-ACCEPTED-001` (status.md:3503) is **"Positioning rule removed from CLAUDE.md"** — a *securities-marketing/regulatory* risk acceptance, with re-eval triggers "first paying customer". **It says nothing about x402 settle.** So the verify-vs-settle race is **NOT** a documented accepted risk; treat it as an open (low) item, not a ratified one.

**Evidence.** status.md:3503-3537 full entry read (marketing positioning). `grep -rn RISK-ACCEPTED-001` across vault → only the positioning entry + archive markers.

**Recommended fix.** Accept as-is per design BUT (a) record an explicit, correctly-scoped `RISK-ACCEPTED` entry for the x402 async-settle window so it is actually documented, and (b) add a settle-failure reconciliation alert (the settle `.catch`/`result.success===false` branch at x402.ts:278-282 already logs — wire a periodic "failed-settle count" check into monitoring so silent free-grants are caught). Pairs with X402-02's idempotency claim.

**Proposed follow-up wave:** `OPS-X402-SETTLE-RECONCILIATION-W1` (P2) + a corrected RISK-ACCEPTED entry.

---

### X402-05 · LOW · tolerant-parse + coerceTypes hardening (R1.5 adjacent) · `src/lib/x402-http-routes.ts:41,51-56,180-188`

**Exploit scenario.** `tolerantJson` swallows malformed/empty bodies to `{}` (intentional, so the CDP crawler's empty probe still 402s). ajv is constructed with `useDefaults:true, coerceTypes:true, allErrors:true`. Today this is safe: the paywall (tier check) runs BEFORE the body is used, all 3 schemas set `additionalProperties:false` (x402-bazaar.ts:81/128/177), and `coerceTypes` only normalizes declared fields. Flagged as a note because `coerceTypes` can mask malformed numeric inputs (e.g. `"limit":"abc"` → coercion behavior) and the `{}`-swallow means a *paid* request with a broken body reaches ajv rather than failing fast.

**Evidence.** Source read; schemas confirmed `additionalProperties:false`.

**Recommended fix.** Keep `tolerantJson` for the unpaid/crawler path, but on the PAID path validate the **raw** parsed body and reject coercion-ambiguous inputs explicitly; or drop `coerceTypes` for these 3 schemas (inputs are already well-typed by the published schema).

**Proposed follow-up wave:** hardening backlog (Reject/defer unless bundled).

---

### X402-06 · INFO · R1.1 SVM-exposure verdict (NOT exposed) · dependency tree

**Finding / evidence.**
- `npm ls @coinbase/x402 @x402/extensions @x402/core @x402/evm @x402/svm x402` → installed: `@coinbase/x402@2.1.0`, `@x402/core@2.9.0`, `@x402/evm@2.9.0`, `@x402/extensions@2.9.0`. **`@x402/svm` and `x402` → `(empty)` (not installed).**
- GHSA-qr2g-p6q7-w82m (HIGH, "x402 SDK Security Advisory") pins authoritatively (via `gh api /advisories/...`): **`npm/@x402/svm < 2.6.0`** (patched 2.6.0), `pip/x402 < 2.3.0`, `go .../x402 < 2.5.0`. The vulnerable artifact for our ecosystem is `@x402/svm` specifically.
- `@x402/svm` is **physically absent** (`ls node_modules/@x402/` → only `core, evm, extensions`) and **absent from `package-lock.json`** (`grep @x402/svm package-lock.json` → empty).
- The `@solana/*` kit present in the tree (267 lockfile refs) is pulled by **`@coinbase/cdp-sdk`** (general Solana support), NOT by `@x402/svm` and NOT by `@x402/extensions` (whose `package.json` deps are `@noble/curves, @scure/base, ajv, jose, siwe, tweetnacl, viem, zod, @x402/core` — no solana, no svm).
- No Solana/SVM scheme is registered or reachable: `src/facilitator.ts:60` registers **only** `new ExactEvmScheme(...)` for `eip155:8453`; `grep -rniE '@x402/svm|solana|ExactSvm' src/` → none. `X402_NETWORK=base-mainnet` → CAIP2 `eip155:8453` (EVM). The live 402's `accepts[0].network` is `eip155:8453` with **no SVM scheme advertised** (endpoint-truth.md §3).
- `@coinbase/x402@2.1.0` is the **latest** published version of that package (newest publish 2025-12-23); the advisory's "2.6.0" is the `@x402/svm` lineage, NOT `@coinbase/x402` — so 2.1.0 is current, not stale, and is not flagged by `npm audit`.

**Verdict: SVM/Solana forged-proof path is NOT exposed (Y/N = N).** Even if `@x402/svm` were ever added, it could only matter if a `solana:*` scheme were registered + advertised, which it is not.

**Recommended (preventive).** Add `@x402/svm` to the npm-audit canary's watch-set so any future transitive pull of a `<2.6.0` `@x402/svm` fails CI (the wave's `security-canary.mjs` x402-family gate should include it explicitly).

---

### X402-07 · INFO · viem moderate advisory (cross-cutting) · `src/facilitator.ts:21`, on-chain scripts

`viem@2.47.12` is within the MODERATE advisory range (`<=2.49.3`, surfaced by `npm audit`). It is confined to the facilitator container (`src/facilitator.ts`) and on-chain scripts (`merkle.ts`, `erc8004.ts`, `publish-merkle-batch.ts`) — **not** the core x402 verify/settle path (which goes to the hosted CDP facilitator under `X402_FACILITATOR=cdp`). MODERATE, container-scoped → LEAD's full-tree `npm audit` (R5) owns the upgrade decision.

---

### X402-08 · INFO · paid-path test gap (R1.5 / R1.2) · `tests/x402-http-routes.test.ts`

The only x402 route tests cover **unpaid → 402** and the **two-flag firewall mount** (the file's own comment: "unpaid → 402 short-circuits before any facilitator call"). **No test exercises a settled/paid request**, so neither the cross-tool downgrade (X402-01) nor amount-binding is guarded. This is why X402-01 shipped undetected. The X402-01 fix MUST land with a paid-path regression test.

---

## 3. Verification evidence — explicit PASS/FAIL per R1.1–R1.7

### R1.1 — Dependency CVE / SVM reachability — **PASS (not exposed)**
```
$ npm ls @coinbase/x402 @x402/extensions @x402/core @x402/evm @x402/svm x402
+-- @coinbase/x402@2.1.0
| `-- @x402/core@2.9.0 deduped
+-- @x402/core@2.9.0
+-- @x402/evm@2.9.0
`-- @x402/extensions@2.9.0
   ( @x402/svm  → npm ls @x402/svm x402 → `(empty)` )
$ ls node_modules/@x402/           → core  evm  extensions      (NO svm)
$ grep @x402/svm package-lock.json → (empty)
$ gh api /advisories/GHSA-qr2g-p6q7-w82m
   pkg=npm/@x402/svm  vulnerable=<2.6.0  patched=2.6.0   (+ pip/x402<2.3.0, go<2.5.0)
$ grep -rniE '@x402/svm|solana|ExactSvm' src/   → (none)
$ src/facilitator.ts:60  facilitator.register('eip155:8453', new ExactEvmScheme(evmSigner));   (EVM only)
```
Installed `@coinbase/x402` 2.1.0 = latest of its lineage; the GHSA-pinned `@x402/svm` is absent; EVM-only config; live 402 advertises only `eip155:8453`. **SVM forged-proof path unreachable → exposed: N.**

### R1.2 — amount/asset/network/recipient independent assertion
- **(a) amount == TOOL_PRICING[tool] — FAIL (cross-tool) / PARTIAL.** Within a single tool the facilitator enforces `authorization.value === requirements.amount` (verifyEIP3009) AND `findMatchingRequirements` deep-equals the amount — so a payment cannot under-pay *its own* requirement. BUT `verifyX402Payment` matches against the **global `allReqs`** pool (x402.ts:231) with no route↔price binding, and `isPaymentSufficient` is dead code → a $0.01 proof is accepted on a $0.02 route (**X402-01, HIGH**). PoC confirmed.
- **(b) asset == USDC — PASS.** Requirements built from `USDC_ADDRESS[CAIP2_NETWORK]` (x402.ts:132/148); deep-equal binds `asset`; facilitator reads `erc20Address` from requirements. Live 402 asset `0x8335…2913` ✓.
- **(c) network == X402_NETWORK — PASS.** `findMatchingRequirements` v2 deep-equals `network`; `verifyEIP3009` returns `ErrNetworkMismatch` on mismatch; facilitator only registers `eip155:8453`. A `base-sepolia` (`eip155:84532`) proof cannot deep-equal a mainnet requirement → **cross-network replay rejected**. ✓
- **(d) recipient == X402_WALLET_ADDRESS — PASS.** `payTo: WALLET_ADDRESS` baked into every requirement (x402.ts:181); deep-equal binds `payTo`; `verifyEIP3009` independently returns `ErrRecipientMismatch` if `authorization.to !== requirements.payTo`. Live 402 payTo `0x778A…7d59` == X402_WALLET_ADDRESS. ✓

### R1.3 — replay / idempotency — **FAIL (no idempotency store)** → X402-02 (MEDIUM)
`verifyX402Payment` stateless; `settleX402Async` fire-and-forget; nonce burned only on-chain at settle; facilitator verify simulates the transfer (so post-settle replay fails) but pre-settle concurrent replay succeeds. PoC: **20/20 replays served for 1 charge.** No `tryClaim`/nonce/dedup store in src.

### R1.4 — verify-vs-settle race — **NOTED (LOW, undocumented-as-accepted)** → X402-04
Resource served before settle confirms (index.ts:2196 / x402-http-routes.ts:203 both settle AFTER `res.json`). Per-request ceiling $0.01–$0.02; balance-checked at verify ~2s prior. **Spec's RISK-ACCEPTED-001 attribution is WRONG** — that entry (status.md:3503) is marketing positioning, not payment processing → the race is not actually a ratified risk.

### R1.5 — paywall gating & output parity — **PASS**
- Free vs paid gating correct: `get_trade_call` is FREE and intentionally NOT in `TOOL_PRICING`/`BAZAAR_ROUTES`; the 3 paid tools require `tier==='x402'` (x402-http-routes.ts:174). Unpaid → 402, no tool data in the body (existing test asserts this).
- No unpaid path returns real data: the `[STUB]` token is ONLY the facilitator-fallback log (x402-facilitator.ts:119) — it does not gate or fabricate output; an unkeyed CDP selection falls back to legacy and unpaid still 402s.
- HTTP↔MCP parity by construction: both call the same `getTradeSignal`/`scanFundingArb`/`getMarketRegime` (x402-http-routes.ts:35-37 imports the identical lib fns).
- **No `outcome_return_pct`/Phase-E leak:** `grep -rniE 'outcome_return_pct|outcome_price|phase.?e' src/tools/{get-trade-call,scan-funding-arb,get-market-regime}.ts` → **empty**. The Bazaar discovery metadata additionally runs `assertNoBazaarLeak` over a 7-token forbidden set (x402-bazaar.ts:29-37,202-209) at declaration time.

### R1.6 — CDP key handling — **PASS**
- `grep -rnE 'CDP_API_KEY_ID|CDP_API_KEY_SECRET' src/` → only env references + doc comments; **no hardcoded value**. The single facilitator `console.warn` (x402-facilitator.ts:118) logs key *names*, never values.
- `git log -p -S 'CDP_API_KEY_SECRET' --all` / `-S 'CDP_API_KEY'` across FULL history → every `+` hit is documentation/placeholder (`CDP_API_KEY_SECRET=…`); **no real secret ever committed**.
- `.env` is git-ignored (`.gitignore:3`); only `.env.example` tracked. No CDP key in `deploy/*.json` public half (none referenced in src for public split).
- **PROD PROOF (SSH-read, names-only to avoid logging secrets):**
  ```
  $ docker exec …mcp-server-1 cat /proc/1/environ | tr '\0' '\n' | grep -oE '^(CDP_API_KEY_ID|CDP_API_KEY_SECRET|…)='
    CDP_API_KEY_ID=   CDP_API_KEY_SECRET=   (both PRESENT in environ)
  $ docker logs …mcp-server-1   2>&1 | grep -icE 'CDP_API_KEY_SECRET=|Bearer …{20,}|sk_'   → 0
  $ docker logs …facilitator-1  2>&1 | grep -icE 'FACILITATOR_PRIVATE_KEY|0x[a-f0-9]{64}|Bearer|secret' → 0
  ```
  Keys present in environ, **ABSENT from container logs** (both containers). No bearer/URL/credential dump on any inspected error path.

### R1.7 — two-flag firewall + rollback + onchain blocklist — **PASS**
- Mount-gated: `mountX402HttpRoutes` (x402-http-routes.ts:145-147) returns `[]` unless `resolveFacilitatorFromEnv().discoveryEnabled`, which is `effectiveChoice==='cdp' && bazaarRequested` (x402-facilitator.ts:97) — i.e. **both** `X402_FACILITATOR=cdp` AND `BAZAAR_DISCOVERABLE=true`. Defaults (`legacy`/`false`) → nothing registered → `/x402/*` 404. Flipping either off = instant rollback. (Prod currently has BOTH on, so routes are live — see X402-01.)
- Stub-first: `X402_FACILITATOR=cdp` with missing CDP keys → falls back to legacy + `[STUB]` log, discovery disabled (selectFacilitator, x402-facilitator.ts:91-109).
- **Onchain blocklist intact:** `npm ls web3 eth-account eth-abi hexbytes` → `(empty)`; `grep -nE '"(web3|eth-account|eth-abi|hexbytes|py-solc-x|brownie|ipfshttpclient)"' package-lock.json` → none; `@x402/svm`/`@solana/web3` not pulled into the verify path. (`viem` is present but is a legitimate EVM client for the facilitator/merkle scripts, not on the blocklist.)

---

## 4. Read-only integrity
- All writes confined to `audits/SECURITY-AUDIT-RECENT-FEATURES-W1/` — this report + `poc/x402-cross-tool-downgrade.mjs` + `poc/x402-replay-window.mjs`. **No `src/` edits.** Both PoCs are self-contained (import nothing from `src/`), move no funds, and contact no network. No prod/DB/env mutation; SSH was read-only (`cat /proc/1/environ`, `docker logs`, env-name grep). No real `X-PAYMENT` was submitted to prod.

## 5. Prioritized backlog (this area)
| Priority | Finding | Wave ID |
|---|---|---|
| **P0** | X402-01 cross-tool downgrade (+ X402-03 timeframe pricing, + X402-08 paid-path test) | `OPS-X402-ROUTE-PRICE-BINDING-W1` |
| **P1** | X402-02 payment idempotency / replay claim | `OPS-X402-PAYMENT-IDEMPOTENCY-W1` |
| **P2** | X402-04 settle reconciliation alert + corrected RISK-ACCEPTED entry | `OPS-X402-SETTLE-RECONCILIATION-W1` |
| Defer/Reject | X402-05 tolerant-parse hardening; X402-07 viem (LEAD owns) | bundle / LEAD R5 |
| Preventive | X402-06 add `@x402/svm` to npm-audit canary watch-set | LEAD `security-canary.mjs` |
