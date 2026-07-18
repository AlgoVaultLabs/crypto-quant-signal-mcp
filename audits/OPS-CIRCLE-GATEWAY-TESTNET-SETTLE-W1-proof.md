# OPS-CIRCLE-GATEWAY-TESTNET-SETTLE-W1 — Base-Sepolia settlement proof

**Executed:** 2026-07-18 · **Chain:** Base Sepolia `eip155:84532` · **Facilitator:** `gateway-api-testnet.circle.com`
**SDK:** `@circle-fin/x402-batching@3.2.0` · **Worktree:** `ops/circle-gateway-testnet-settle-w1` off `origin/main`
**Closes:** CIRCLE-GATEWAY-MIGRATE-W1 open item #2 (R5 escape-hatch)
**Mainnet touched:** **NO.** Prod untouched; `CIRCLE_GATEWAY_ENABLED` still OFF in production.

---

## 1. Verdict

**The full loop is PROVEN end-to-end on Base Sepolia through AlgoVault's own Gateway `exact`-scheme:**

> **deposit → pay → real batched settle → seller's Gateway balance credited → seller withdraws to on-chain USDC.**

Every requirement (R0–R4) is satisfied **as originally specified**. One **production defect** was discovered that would have made the merged rail unable to receive payments at all (§3) — that is this wave's most valuable output.

| requirement | outcome |
|---|---|
| R0 — SDK / chain / EOA probe | ✅ all primitives confirmed |
| R1 — real deposit → pay → settle | ✅ settle `success: true` via Circle's live facilitator |
| R2 — seller Gateway-balance increment == price | ✅ **0 → 0.02** on transfer completion |
| R3 — seller `withdraw()` lands on-chain | ✅ real USDC Transfer **0.01 → seller wallet** |
| R4 — artifact + clean skip | ✅ this file + JSON; suite skips without `INTEGRATION=1` or keys |

### ⚠️ Corrections to my own earlier analysis (recorded, not hidden)

I published two "spec corrections" mid-wave that were **both wrong**, each from concluding on too short an observation window. The spec was right; I was not.

| my earlier claim | reality | why I got it wrong |
|---|---|---|
| "An x402 recipient never gets a Gateway balance — only an on-chain wallet mint; R2 is unsatisfiable." | **FALSE.** A completed payment credits the recipient's **Gateway balance** (seller `0 → 0.02`). R2 was correct as written. | I observed seller `0/0` for ~40 min and generalised. The transfer was merely still `received`/`batched`; it completed at **~36 min** and credited exactly then. |
| "`withdraw()` is gasless; the seller needs no ETH." | **FALSE.** `withdraw()` performs an on-chain `gatewayMint()` **from the withdrawer's own wallet** and needs gas. | My grep window over the minified SDK (2600 chars) truncated **before** the `writeContract` call. The buyer's withdraw only succeeded because the buyer happened to hold ETH. |

**`pay()` is genuinely gasless** — that one is verified (payment settled with a signature only, no on-chain tx from the payer).

---

## 2. Wallets

| role | address | funded with |
|---|---|---|
| BUYER (payer / depositor) | `0x5f3B062EFEEA0bF91C8e1E3A5bDc2770bD1a7bc4` | 20 USDC + 0.0002 ETH (operator) |
| SELLER (`payTo`) | `0x67dA7304b98D52dd04850134E32640166B382cE6` | 0.00005 ETH, forwarded **from the buyer** mid-wave once the gas requirement was discovered |

Both verified as **EOAs with no contract code** (Gateway verifies via `ecrecover`; contract wallets are rejected). Keys at `~/.config/algovault/circle-testnet.env`, mode `600`, **outside any git repo**. Testnet-only, zero real value, never reused on mainnet.

---

## 3. 🛑 PRODUCTION DEFECT — the merged rail cannot receive a Gateway payment

**`src/lib/x402.ts` reads only the x402 v1 header. Every v2 client sends a different one. With `CIRCLE_GATEWAY_ENABLED=true` in production today, a Gateway payment would be invisible and the route would 402 forever.**

```ts
// src/lib/x402.ts — verifyX402Payment()
const paymentHeader = headers['x-payment'] || headers['X-Payment'];   // v1 ONLY
```

Circle's `GatewayClient.pay()` sends the signed payload in **`Payment-Signature`** — the x402 **v2** canonical header (`@x402/core/http` ships `encode`/`decodePaymentSignatureHeader` for exactly this). `X-PAYMENT` is the v1 header our CDP buyers use.

**How it surfaced:** `pay()` failed with a bare `Payment failed: Payment Required` while the server's rejection list was **empty** — proving the paid branch never executed (the retry was read as unpaid). Only after instrumenting every rejection path and grepping the client for its header name did the cause appear.

**Impact:** flag-OFF today ⇒ **no live impact**. But `CIRCLE-GATEWAY-MAINNET-ENABLE-W1` would have shipped a rail that silently cannot be paid.

**Fix (NOT applied here — this wave is test-scope):** `verifyX402Payment()` must accept `Payment-Signature` (via `decodePaymentSignatureHeader`) **in addition to** `x-payment`, with `x402-http-routes.ts` passing it through. → **`OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1`, hard prerequisite for mainnet.**

---

## 4. Evidence

### 4.1 Deposit — on-chain, real
| field | value |
|---|---|
| approval tx | `0x059936ca30ee9eff1acc49ddca4bc0294595e5f02efe42bf6f6859124f2a8a84` |
| deposit tx | `0xed65eef7114b46769d25787cf8ec7bf19c39fde0cdd27af96418192bc34d3861` |
| receipt | `success`, block `44297105` |
| effect | wallet 20 → 19 USDC; Gateway credited **1.00** |

**Deposits credit only after block FINALITY.** Base Sepolia finality lag measured at **~744 blocks ≈ 25 min**. A short poll reads `0` and is indistinguishable from a failed deposit — the first run failed exactly this way (`expected 0 to be >= 20000`) *after* the USDC had already left the wallet with a `success` receipt and 54 confirmations. Mainnet Base has a comparable L1-finality lag: **first-deposit onboarding is minutes, not seconds.**

### 4.2 The 402 challenge — AlgoVault's own scheme
```json
{ "scheme": "exact", "network": "eip155:84532", "amount": "20000",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x67dA7304b98D52dd04850134E32640166B382cE6",
  "extra": { "name": "GatewayWalletBatched", "version": "1",
             "verifyingContract": "0x0077777d7eba4688bdef3e311b846f25870a19b9" } }
```
`amount` `20000` atomic = **$0.02**, resolved from the real `TOOL_PRICING` SoT (no second price source). Reconfirms the parent wave's correction: **Gateway IS `scheme:"exact"`; `GatewayWalletBatched` is `extra.name`, the EIP-712 domain — never a scheme id.**

### 4.3 Verify + settle — REAL, not the Stub
| field | value |
|---|---|
| settle `success` | **`true`** |
| settlement id | `77bee72c-3d0e-40b5-aa5f-be5894975d27` |
| payer | `0x5f3b062efeea0bf91c8e1e3a5bdc2770bd1a7bc4` |
| HTTP | **200**, `{ ok: true, tool: "get_trade_signal", paidUsd: 0.02 }` |
| **payer debit** | Gateway **1.00 → 0.98** = exactly **0.02** ✅ |

The Stub always fails by design, so `success: true` is reachable only through the **real** `BatchFacilitatorClient`. A second independent payment (`1e2e91fa…`) reproduced the same result.

### 4.4 R2 — seller's Gateway balance credited ✅
```json
{ "id": "77bee72c-…", "status": "completed",
  "txHash": "0x07bea1464f1fc5b6175dbe9fe4042c9cd8b3b0910ee9f54a4696c834d48601e3",
  "amount": "20000",
  "fromAddress": "0x5f3b06…7bc4", "toAddress": "0x67da73…2cE6" }
```
Seller Gateway balance: **`0` → `0.02`** (`total` = `available` = `20000` atomic) — **exactly the tool price.**

**Batching is real and observable.** Lifecycle `received → batched → completed`; ~20 transfers shared a **single** mint tx (`0xc33fbc56…`) — N payments, one on-chain transaction. **Completion took ~36 min** (created 08:36:41 → completed 09:13:01); cadence is Circle-side and unbounded, so the test polls with a budget and records the outcome rather than failing on a vendor's schedule.

### 4.5 R3 — seller withdraw lands on-chain ✅
| field | value |
|---|---|
| `gatewayMint` tx | **`0xb8156d12e8d5bced40944dcfbf796bf9045ae851cd1fc673e76f6b71c93c233d`** |
| receipt | **`success`**, block `44299278`, gasUsed `150393` |
| **event log** | **`USDC Transfer 0.01  0x000…000 → 0x67da7304…2cE6`** |
| seller on-chain USDC | `0` → **`0.01`** (quorum-confirmed across 3 RPCs) |
| withdrawal fee | **0.01 USDC**, charged **on top** of the requested amount |

Earlier, the buyer's own withdraw independently proved the same primitive: mint `0x39dfce21…` (success, block 44298172), wallet 18.97 → 19.94.

**Withdrawal semantics (live-probed, absent from the quickstart):**
- **The fee is charged ON TOP of the amount.** Requesting `0.98` against a `0.98` balance fails `available 0.980000, required 0.99` ⇒ fee `0.01 USDC`.
- **`maxFee` is a signed cap that the SDK defaults to 2.01 USDC.** Blind-signing that on a small mainnet withdrawal is a real risk; every call here capped it explicitly (`0.05`–`0.10`).
- **Economics:** withdrawing a single $0.02 payment costs **50% in fees**. Recipients MUST accumulate before withdrawing — mainnet payout policy needs a threshold, never per-payment.

### 4.6 🛑 `withdraw()` is NOT atomic — funds can strand
When the seller's first withdraw was attempted **without gas**, the sequence was:
1. burn intent signed → **Gateway API accepted and DEBITED the balance** (0.02 → 0);
2. on-chain `gatewayMint()` **reverted** (`gas required exceeds allowance (0)`).

Result: the balance was burned ledger-side but **never minted on-chain** — `total`/`available`/`withdrawing`/`withdrawable` all `0`, wallet `0`. The funds were **stranded**, and the SDK exposes no retry path (a fresh `withdraw()` would need a balance that no longer exists).

**Recovery (performed here):** the attestation payload + signature are present in the revert error; re-submitting `gatewayMint(attestationPayload, signature)` directly to the GatewayMinter (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`) from a now-funded wallet redeemed them — that is the tx in §4.5.

**Mainnet implication:** a withdrawer with insufficient gas loses access to funds until someone manually re-submits the attestation. **Pre-flight the gas balance before calling `withdraw()`, and persist the attestation + signature** so a failed mint is recoverable.

### 4.7 Gas — corrected
| call | on-chain write | gas |
|---|---|---|
| `deposit()` | `approve` + `writeContract` | **yes** (one-time, payer) |
| `pay()` | none — signed payload only | **none** ✅ |
| `withdraw()` | **`gatewayMint()` from the withdrawer's wallet** | **YES** ← corrects my earlier "gasless" claim |

**Both parties need a little native ETH.** The seller was funded 0.00005 ETH from the buyer mid-wave; the mint used 150,393 gas.

### 4.8 Stale RPC reads bit twice
Immediately after a `success` receipt, `sepolia.base.org` returned the **pre-transaction** balance twice (seller ETH `0` after a confirmed funding tx; seller USDC `0` after a confirmed mint). A 3-RPC quorum showed the true value both times. **Post-write balance assertions must wait for the receipt AND read from ≥2 independent RPCs** — matching this project's existing 2-RPC-quorum rule for Base.

---

## 5. Scope — what this does NOT prove

- **Rail coexistence.** The local instance mounts the Gateway facilitator **only**. The default legacy facilitator (x402.org) advertises `exact/eip155:84532` but **not** `exact/eip155:8453`, so a local dual mount would either null the resource server or put CDP and Gateway on the **same `(scheme, network)` key** — the collision already flagged as the mainnet blocker. This wave reinforces that blocker; it does not resolve it.
- **Tool business logic.** The paid route returns a stand-in payload; this proves the **payment rail**. Tool correctness has its own suites, and live-venue calls would add unrelated flakiness.
- **Production settle.** Prod still reads the v1 header only (§3) — proven in a local flag-ON instance, **not** in production.

---

## 6. Mainnet prerequisites (cumulative)

1. **`OPS-X402-V2-PAYMENT-SIGNATURE-HEADER-W1`** — accept `Payment-Signature`; without it the rail cannot be paid (§3). **Hard blocker.**
2. **`exact`/`eip155:8453` CDP↔Gateway collision** — two facilitators, one `(scheme, network)` key (§5). Unresolved.
3. **Withdrawal policy** — explicit `maxFee` cap, an accumulation threshold, **gas pre-flight**, and attestation persistence for stranded-mint recovery (§4.5–4.6).
4. **Finality-aware onboarding** — first deposit is ~minutes (§4.1); payment completion ~36 min (§4.4).
5. **Real payout address** for `CIRCLE_GATEWAY_SELLER_ADDRESS` (still a testnet throwaway).
6. **Quorum reads** on post-write assertions (§4.8).
