# CIRCLE-GATEWAY-MAINNET-ENABLE-W1 — endpoint-truth (R0)

**Date:** 2026-07-19 · **Base:** `origin/main` @ `b2ba26c` · **Worktree:** `ops/circle-gateway-mainnet-enable-w1`

Plan-Mode probe artifact, produced BEFORE any code change. Every row was produced by a concrete
command against the real SDK, the live vendor APIs, or on-chain state — not from the spec text.

**R0 outcome: the blocker's answer is NO — CDP and Gateway cannot coexist on Base mainnet.** The
spec anticipated this ("if they cannot → design an alternative"). HALT was raised; work resumed only
after architect + operator ratification of Q1–Q4.

---

## 1. The collision — two independent layers, both silent

The SDK dispatches on `(x402Version, scheme, network)`. On Base mainnet CDP and Gateway are
**identical in all three** (`2`, `exact`, `eip155:8453`). There is no `extra` dimension anywhere.

| layer | mechanism (probed) | mainnet effect |
|---|---|---|
| scheme registry | `register()` = `Map<network, Map<scheme, server>>` guarded by `if (!serverByScheme.has(server.scheme))` → **first-wins, silent no-op** | CDP registers first (`x402.ts`) and WINS; `GatewayEvmScheme` **never registers** |
| facilitator kind lookup | `getSupportedKind(x402Version, network, scheme)` — **3 params, no `extra`** | two identical kinds; **first match wins**; `extra.name` cannot disambiguate |

**Measured consequence** (real `x402ResourceServer` + real `GatewayEvmScheme`, production
registration order):

| registration | resulting `extra` |
|---|---|
| CDP first, Gateway second, same network (= mainnet) | **`{}`** — no `GatewayWalletBatched`, no `verifyingContract` |
| Gateway on its own network key | `{name: 'GatewayWalletBatched', verifyingContract: '0x7777…00ee', …}` |

Root cause of the empty `extra`: with the Gateway scheme dropped, the build is served by
`cdpExactScheme`, whose `enhancePaymentRequirements` is a pass-through (`return reqs`, `x402.ts`).
Circle's `GatewayClient` selects its option by `extra.name === 'GatewayWalletBatched'` ⇒ finds none
⇒ **cannot pay**. Nothing throws.

**Two amplifiers that make this ship silently:**

1. The pre-existing post-`initialize()` liveness check asks `getSupportedKind(2, net, 'exact')`,
   which answers **TRUE from the CDP kind** ⇒ `gatewayActive` stays non-null ⇒ the server logs
   **`Circle Gateway scheme ACTIVE`** while advertising an unpayable rail.
2. `tests/circle-gateway-dual-advertise.test.ts` hardcodes `GW_NET = 'eip155:84532'`, pinning the
   *distinct-network* topology — so it passes while never exercising same-network registration.

## 2. Seller EOA

| check | result |
|---|---|
| `eth_getCode(0x778A…d59)` on Base mainnet | `0x` — **code-less EOA**, valid for Gateway's `ecrecover`. Verified across **2 independent RPCs** (Base RPCs have returned stale reads before) |
| decision | **Dedicated seller EOA** (operator Q3) — `0x778A…d59` is the CDP revenue wallet; reuse would commingle receipts and share one key's blast radius |

## 3. Mainnet primitives

| primitive | probed |
|---|---|
| Base mainnet chainId | `0x2105` = **8453** |
| Circle mainnet facilitator | `gateway-api.circle.com/v1/x402/supported` → **200, 11 networks**, all `exact` + `GatewayWalletBatched` |
| Circle networks | `eip155:` **1, 8453, 43114, 42161, 10, 137, 130, 146, 480, 1329, 999** |
| CDP networks | Base, Polygon, Arbitrum, World (+Solana) — [CDP network support](https://docs.cdp.coinbase.com/x402/network-support) |
| **collision-free set** | Ethereum(1) · Avalanche(43114) · **Optimism(10)** · Unichain(130) · Sonic(146) · Sei(1329) · Hyperliquid(999) |
| OP Mainnet Gateway kind | `verifyingContract 0x77777777dcc4d5a8b6e418fd04d8997ef11000ee` (**differs from testnet's** `0x0077777d7eba…`) |
| OP USDC (SDK-resolved) | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` — on-chain verified across 2 RPCs: **chainId 10, symbol `USDC`, decimals 6** |

`GatewayEvmScheme.parsePrice` resolves USDC **per-chain itself**, so **no new `USDC_ADDRESS` /
`USDC_EIP712_NAME` entries are required** — those maps serve the CDP path only. The Gateway EIP-712
domain is `GatewayWalletBatched` + the GatewayWallet contract, not the USDC domain, so the
mainnet-USDC-name trap from `X402-BAZAAR-HTTP-REDECLARE-W1` does not apply.

## 4. Decisions (ratified 2026-07-19)

| Q | Decision |
|---|---|
| Q1 collision design | **Network separation** — reproduce the proven distinct-network topology |
| Q2 network | **OP Mainnet `eip155:10`** — cheap withdraw gas, OP-stack sibling of Base, collision-free |
| Q3 seller | **Dedicated seller EOA**, operator-generated |
| Q4 withdrawal | **Threshold-triggered MANUAL** (≥$5); automation deferred |

## 5. Verification performed

| check | result |
|---|---|
| `circle-gateway-mainnet.test.ts` | **13/13** — incl. the first-wins characterization + `eip155:8453` env refusal |
| `circle-gateway-mainnet-guard.test.ts` | **4/4** — the R1b backstop driven through REAL `initX402()` |
| **Mutation check** (disable the R1b guard) | **3 red**, and the **positive control stayed green** — the guard is genuinely wired, not vacuously asserted |
| All 5 circle-gateway suites | **63/63** |
| Full `vitest run` | **301 files / 3463 tests**, 0 fail |
| node:test canaries | **487 / 0 fail** |
| Clean rebuild | clean `tsc`; `dist` carries `eip155:10` + the guard |
| CDP `exact` scheme body diff | **0 lines changed** |

**A pre-existing test correctly went red and was FLIPPED, not deleted.**
`circle-gateway.test.ts` asserted *"refuses the Circle MAINNET facilitator host"* — the scope
constraint `CIRCLE-GATEWAY-MIGRATE-W1` deliberately encoded. This wave lifts that constraint with
approval, so the assertion was inverted while its sibling (`eip155:8453` still refused) was kept and
strengthened — an exemption and the test encoding it are a pair. The stale
`"This wave is testnet-only"` refusal message was corrected at the same time so it cannot mislead an
operator debugging a failed flip.

## 6. Not done / open

- **No flip performed.** No seller key exists, no funds moved, **no real mainnet settle has ever
  run.** R-flip is operator-executed per `docs/RUNBOOK-CIRCLE-GATEWAY-MAINNET-FLIP.md`.
- ⚠️ **UNVERIFIED:** Circle documents unified cross-chain balances explicitly for *spending*;
  seller-side withdrawal-chain flexibility is only implied. Confirm at first withdrawal.
- No `PAYMENT-RESPONSE` receipt header on this rail — Circle reads it optionally and the
  Base-Sepolia loop settled without it. Non-blocking, tracked separately.
