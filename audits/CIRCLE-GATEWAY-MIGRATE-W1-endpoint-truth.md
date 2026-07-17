# CIRCLE-GATEWAY-MIGRATE-W1 — R0 endpoint-truth (Plan-Mode HALT)

**Probed:** 2026-07-17 · **Probe base:** `origin/main` @ `6766a71` · **Worktree:** `/Users/tank/code/cqsm-wt-circle-gateway` on `feat/circle-gateway-additive-scheme-w1`
**Verdict:** **0 fictional primitives** (HALT threshold ≥3 NOT met on the SDK axis) — **but HALT is still REQUIRED**: one spec premise (R3/AC3 scheme naming) is factually impossible as written, and one unstated risk contradicts the wave's "zero risk to the live CDP rail" framing.

---

## 1. SDK-shape probe — `@circle-fin/x402-batching`

Probe method: `npm pack @circle-fin/x402-batching@3.2.0` → unpacked → grepped `dist/**/*.d.ts` + `dist/**/*.js` directly (published tarball, not a transitive install).

| claim | reality | resolution |
|---|---|---|
| SDK `@circle-fin/x402-batching@3.2.0` is LIVE | ✅ **TRUE.** `npm view` → `latest = 3.2.0`; versions `2.0.3 … 3.1.2, 3.2.0`; `time.modified = 2026-06-18` (~1 mo old, not stale) | Pin `^3.2.0`. No HALT (live major 3 == spec major 3). |
| Staged branch "almost certainly assumes an **older major** (v1/v2)" | ❌ **FALSE.** Staged branch pins `"@circle-fin/x402-batching": "^3.0.4"` — **same major**. `^3.0.4` already resolves to `3.2.0`. There has never been a v1; v2 line exists but the branch never used it. | **Spec premise withdrawn.** No major-version diff to perform. The R0 "SDK major drift" rationale for HALT does not hold. |
| `createGatewayMiddleware` | ✅ **REAL** — `@circle-fin/x402-batching/server`. `declare function createGatewayMiddleware(config: GatewayMiddlewareConfig): GatewayMiddleware` | Real, but **wrong shape for R3** — see §3. |
| `BatchFacilitatorClient` | ✅ **REAL** — `/server`. `declare class BatchFacilitatorClient implements FacilitatorClient` (`verify` / `settle` / `getSupported`) | **This is the R3-correct primitive.** |
| `GatewayEvmScheme` | ✅ **REAL** — `/server`. `declare class GatewayEvmScheme extends ExactEvmScheme` | **This is the R3-correct scheme primitive.** |
| (implied) symbols live at package root | ❌ All three are exported from the **`/server` subpath**, not `.`. Root exports only constants/types/`isBatchPayment`/`supportsBatching`/`getVerifyingContract`. | Import from `@circle-fin/x402-batching/server`. The staged branch already got this right. |
| Untyped pkg → may need ambient `src/types/*.d.ts` | ❌ **NOT NEEDED.** Package ships `types: ./dist/index.d.ts` + per-subpath `.d.ts`/`.d.mts` (dual CJS/ESM). | Drop the ambient-`.d.ts` conditional from the spec. |

### Peer-dep compatibility — ✅ GREEN (no skew)

| peer (declared by SDK) | our `origin/main` | satisfied? |
|---|---|---|
| `@x402/core: ^2.3.0` | `^2.9.0` (installed `2.9.0`) | ✅ `2.9.0 ∈ [2.3.0, 3.0.0)` |
| `@x402/evm: ^2.3.0` (optional) | `^2.9.0` | ✅ |
| `viem: ^2.0.0` | `^2.47.12` | ✅ |
| `node >=18` | repo runs Node ≥18 | ✅ |

The spec's flagged risk — *"major-line skew is a real risk"* — **does not materialize**. Only new dep = `@circle-fin/x402-batching`.

---

## 2. 🛑 The decisive finding — **there is no `GatewayWalletBatched` scheme**

Probed three independent ways, all agreeing:

**(a) SDK constants** (`dist/index.js`):
```
CIRCLE_BATCHING_NAME    = "GatewayWalletBatched"
CIRCLE_BATCHING_VERSION = "1"
CIRCLE_BATCHING_SCHEME  = "exact"      ← the x402 scheme string
```

**(b) Live Circle testnet facilitator** — `GET https://gateway-api-testnet.circle.com/v1/x402/supported` → **HTTP 200**:
```json
{"x402Version":2,"scheme":"exact","network":"eip155:84532",
 "extra":{"name":"GatewayWalletBatched","version":"1",
          "verifyingContract":"0x0077777d7eba4688bdef3e311b846f25870a19b9",
          "minValiditySeconds":604800,
          "assets":[{"symbol":"USDC","address":"0x036cbd53842c5426634e7929541ec2318f3dcf7e","decimals":6}]}}
```
Every one of the 12 testnet kinds carries `"scheme":"exact"`.

**(c) Circle's own seller quickstart** (fetched live) — shows `"scheme": "exact"`, and `GatewayWalletBatched` only ever as `extra.name`.

> **`GatewayWalletBatched` is the EIP-712 _domain name_, not an x402 scheme identifier.**
> Circle Gateway **is** the `exact` scheme. It is differentiated from our CDP rail by **`network` + `extra.verifyingContract`/`extra.name`**, never by scheme string.
> This is *why* `GatewayEvmScheme extends ExactEvmScheme`, and why its only real override is `enhancePaymentRequirements` — merging `extra.verifyingContract` so the client can build the right EIP-712 domain. (Same class of trap as our own per-network USDC domain-name bug: `x402.ts:46-54`, `eip155:8453`="USD Coin" vs `:84532`="USDC".)

### Impact on R3 / AC3 — **unimplementable as written**

> R3: *"a gated route's `402` `accepts[]` lists **both** schemes (`GatewayWalletBatched` + `exact`)"*

A test asserting `accepts[].scheme === 'GatewayWalletBatched'` **can never pass**. The correct, achievable assertion is:

- **flag OFF** → `accepts[]` == today: `[{scheme:'exact', network:'eip155:8453', …}]`
- **flag ON** → `accepts[]` gains **additional entries**, each also `scheme:'exact'`, distinguished by `network:'eip155:84532'` + `extra.name === 'GatewayWalletBatched'` + `extra.verifyingContract`

**Proposed R3′ (needs architect ratification):** *"with the flag ON, `accepts[]` contains ≥1 additional entry with `scheme:'exact'` + `extra.name === 'GatewayWalletBatched'`; with the flag OFF, `accepts[]` is byte-identical to today."*

---

## 3. 🛑 Architecture fork — the staged branch is on the path that **cannot** satisfy R3

The SDK exposes **two mutually-exclusive integration shapes**:

| | **Path A — `createGatewayMiddleware`** | **Path B — facilitator + scheme registration** |
|---|---|---|
| Shape | standalone Express middleware; owns its **own** 402 lifecycle (`gateway.require('$0.01')`) | `new x402ResourceServer([cdp, new BatchFacilitatorClient({url})])` + `.register('eip155:84532', new GatewayEvmScheme())` |
| Circle's docs | **primary** documented pattern (seller quickstart) | documented in SDK typedoc, not the quickstart |
| Dual-advertise in ONE `402`? | ❌ **No** — separate middleware ⇒ separate 402 listing only Gateway | ✅ **Yes** — one resource server ⇒ one `accepts[]` with both |
| Satisfies R3? | ❌ | ✅ |
| Our precedent | ✅ this is what the **OKX rail** did (separate `/a2mcp/*` mount, own server) — system-map:284 | — |
| **Staged branch uses** | ✅ **this one** (`createGatewayMiddleware` + `gateway.require('$0.01')`) | — |

**`@x402/core@2.9.0` supports Path B — verified in installed `node_modules`:**
```ts
constructor(facilitatorClients?: FacilitatorClient | FacilitatorClient[])   // ← array accepted
register(network: Network, server: SchemeNetworkServer): x402ResourceServer // ← per-network
```
Our CDP registration is already `resourceServer.register(caip2, {scheme:'exact', …})` on `eip155:8453` (`x402.ts:149`), so registering `GatewayEvmScheme` on `eip155:84532` is a **different network key → no collision.** Path B is feasible.

⚠️ **Forward risk to record now:** on an eventual *mainnet* flip, CDP `exact`/`eip155:8453` and Gateway `exact`/`eip155:8453` **collide on the same (scheme, network) key** — dispatch would differ only by `extra.verifyingContract`. Testnet (84532 vs 8453) hides this. The mainnet dispatch story must be designed *before* the mainnet wave, not discovered by it.

---

## 4. 🛑 The wave's "zero risk to the live CDP rail" premise is **not true under Path B**

`src/lib/x402.ts:169-176` (live, unchanged on `origin/main`):
```ts
try {
  await resourceServer.initialize();
} catch (err) {
  console.warn('x402: Failed to initialize resource server (facilitator unreachable?)', …);
  console.warn('x402: Payments disabled — server will operate on free/API-key tiers only.');
  resourceServer = null;   // ← kills the WHOLE x402 rail, CDP included
  return;
}
```
`initialize()` fans out `getSupported()` across **every** facilitator in the array. Path B puts Circle's facilitator **inside the same array as CDP's** ⇒ **a Circle outage / slow response / auth change takes the live CDP mainnet revenue rail dark**, not just Gateway.

This is the **exact failure mode already suffered on this codebase**: system-map:284 records the 2026-07-01 OKX crash-loop — *"a missing scheme registration threw an uncaught async `RouteConfigurationError` at boot → api.algovault.com 502 ~1-2min"*, hardened by making `mountOkxA2mcpRoutes` pre-`initialize()` in try/catch, boot-safe, fail-to-DARK.

**Mitigation required in R1 (not optional):** the Circle facilitator must be added **fail-open / boot-safe** — its own try/catch, its own `initialize()` probe, and on ANY failure it is dropped from the array and the CDP rail proceeds byte-unchanged. Flag-OFF must not even construct it. This must be an explicit AC, and it should be pinned by a test that stubs a throwing Circle facilitator and asserts the CDP rail still serves its 402.

### Additional footguns found (both real, both cheap to avoid)

1. **`BatchFacilitatorClient` defaults to MAINNET.** `BatchFacilitatorConfig.url?: string` — *optional*, `"Defaults to https://gateway-api.circle.com"`. `new BatchFacilitatorClient()` with no args silently points at **mainnet**, directly contradicting R5/AC5 "mainnet stays OFF". → **`url` must be explicitly passed and default-denied**; add a unit test asserting the constructed client's `.url` is the testnet host.
2. **Circle's own JSDoc cites a dead host.** The `BatchFacilitatorClient` example says `url: "https://gateway.circle.com"` — that host is **NXDOMAIN** (`curl` → `Could not resolve host`). The correct hosts are `gateway-api.circle.com` (mainnet, HTTP 200) / `gateway-api-testnet.circle.com` (testnet, HTTP 200). Do not copy the example verbatim.

---

## 5. Repo-anchor probes — all spec claims **CONFIRMED**

| claim | reality | resolution |
|---|---|---|
| `src/lib/x402-bazaar.ts` exists, CDP facilitator config | ✅ 369 lines on `origin/main` | — |
| **`BAZAAR_ROUTES = 6`** | ✅ **TRUE** — enumerated: `get_trade_signal`, `scan_funding_arb`, `get_market_regime`, `scan_trade_calls`, `get_equity_call`, `get_equity_regime` | Accurate. ⚠️ note: 2 of the 6 are equity tools, dark-retired 2026-07-16 (`f00b1f5`, `EQUITY_TOOLS_ENABLED` default OFF) → effective live gated set is 4. |
| payTo Rabby `0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59` | ✅ correct address, but **not a literal in `src/`** — resolved at runtime from `process.env.X402_WALLET_ADDRESS` (`x402.ts:26`) | Spec's "payTo …" is an env value, not a code constant. Gateway `sellerAddress` should resolve the same way — see Q3. |
| `feature-registry.ts` = transport channels SoT | ✅ `src/lib/feature-registry.ts`; `channels: { mcp, httpX402, bot, webhook, a2mcp, acp }` | Derive from `httpX402` — Gateway is a payment **method** on an existing channel, **not** a new channel. **Do NOT add a `gateway:` flag** (reach is identical; would widen the frozen `/capabilities` projection for no consumer). |
| single `TOOL_PRICING` SoT | ✅ `x402.ts:73` — `Object.fromEntries(FEATURE_REGISTRY.flatMap(f => f.x402 ? … f.x402.basePriceUsd …))` | Genuinely single-source. R4 premise sound. |
| — | ⚠️ **unstated by spec:** `SIGNAL_TIMEFRAME_PRICING` (`x402.ts:80-92`) overrides per timeframe for `get_trade_signal` ($0.05 @1m → $0.02 @1d) | R4's "one price per tool" is **not** a scalar for `get_trade_signal`. The parity test must cover the timeframe dimension or it pins an incomplete surface. |
| test runner `vitest run` (`npm test`) | ✅ `scripts.test = "vitest run"`; `scripts.build = "tsc"` | — |
| deps `@coinbase/x402@^2.1.0`, `@x402/core@^2.9.0`, `@x402/evm@^2.9.0`, `@x402/extensions@~2.9.0`, `viem@^2.47.12`, `express@^4.21.2` | ✅ **all six exact** on `origin/main` | — |
| "the ONLY new dep is `@circle-fin/x402-batching`" | ✅ TRUE | — |

### Testnet host + chain — ✅ CONFIRMED LIVE

| | host | HTTP | chains offered |
|---|---|---|---|
| testnet | `gateway-api-testnet.circle.com` | **200** | 12 kinds incl. **Base Sepolia `eip155:84532`** ✅ and **Arc Testnet `eip155:5042002`** ✅ |
| mainnet | `gateway-api.circle.com` | **200** | 11 kinds incl. Base `eip155:8453` |

Our `x402.ts:35-36` already maps `base-sepolia → eip155:84532` and holds its USDC address (`0x036CbD…cF7e`) — **matching Circle's testnet asset address exactly**. → **Base Sepolia is the recommended testnet chain** (zero new chain config; Arc would need new config).

---

## 6. system-map Step-0 edge enumeration

| line | content | verdict |
|---|---|---|
| 67-68 | `CIRC_MP[Circle Agent MP]` / `CIRC_GW[Circle Gateway x402]` | ✅ exact |
| 119 | `SIGNAL -- "402 PAYMENT-REQUIRED" --> CIRC_GW` | ✅ edge exists |
| 223 | `signal-MCP ships to ── … Circle Agent MP · Circle Gateway (x402) …` | ✅ exact |
| 281-282 | table rows; 282 = *"USDC settlement layer (gasless-for-seller); x402 testnet integration"* | ✅ exact quote |
| 3 | `**Last touched:**` — single line, **bold** prefix (spec's plain `Last touched:` grep misses it) | overwrite **in place**, never prepend (§5, line 318/325) |

**Touched edge:** yes → **`system-map.md updated: Y`**. Row 282 becomes *"additive `exact`-scheme second facilitator behind `CIRCLE_GATEWAY_ENABLED` (default OFF), Base-Sepolia testnet-verified"* + overwrite line 3.

---

## 7. Staged-branch drift verdict

`origin/feature/circle-gateway-x402-batching` @ `5ff864c`:
- merge-base `ff81911` = **2026-05-19** (v1.16.0) → **472 commits behind `origin/main`**; 1 commit ahead.
- Entire diff = `package.json` (+1, the dep at `^3.0.4`) · `package-lock.json` (+20) · `tests/integration/circle-gateway-smoke.test.ts` (+87). **Zero `src/` code.**
- The smoke test is **Path A** (`createGatewayMiddleware`) ⇒ cannot satisfy R3.

**Recommendation: Path-A-rebuild off `origin/main` (do NOT rebase the staged branch).** Rationale: rebasing 472 commits to recover a 1-line dep bump + a test on the wrong integration path is strictly more work than re-adding the dep at `^3.2.0`. Worktree `feat/circle-gateway-additive-scheme-w1` is already cut off `origin/main` `6766a71`.
**Salvage from the staged test** (it got these right): the `/server` import path; the `INTEGRATION=1` gate; the HTTP-503 "no supported networks" branch; the base64 `PAYMENT-REQUIRED` decode assertions.

---

## 8. Non-blocking / unverified

- Marketplace framing *"launched 2026-05-11; ~41 services / 640 endpoints as of 2026-07-17"* — **could not confirm these figures** from primary sources. Circle Agent Marketplace is real; a May-2026 launch is consistent with contemporaneous coverage; listing is via a **submission form** (⇒ `MANUAL_PENDING`, never wave-blocking, per existing distribution policy). Objective-framing only; gates no code. **Not fabricating confirmation.**
- `Distribution.md §E` (6 Bazaar routes + prices) — not re-probed; `BAZAAR_ROUTES=6` verified at source instead.

---

## 9. HALT — architect Q-set

```
CIRCLE-GATEWAY-MIGRATE-W1 — R0 HALT. 0 fictional primitives; SDK/peer-deps/testnet all GREEN.
HALT is on 3 spec premises falsified by probe + 1 operator decision. Q1/Q2/Q4 block R1.

Q1 [R3/AC3 unimplementable — scheme naming]
    Probe: Circle Gateway's x402 scheme IS "exact" (SDK CIRCLE_BATCHING_SCHEME="exact";
    live gateway-api-testnet.circle.com/v1/x402/supported returns "scheme":"exact" on all
    12 kinds; Circle's seller quickstart shows "scheme":"exact"). "GatewayWalletBatched" is
    extra.name — the EIP-712 domain name — NOT a scheme id. R3/AC3 as written
    ("accepts[] lists both schemes: GatewayWalletBatched + exact") can never pass.
    Ratify R3' ?
      R3' = flag ON  -> accepts[] gains >=1 entry with scheme:'exact'
                        + extra.name==='GatewayWalletBatched' + extra.verifyingContract
            flag OFF -> accepts[] byte-identical to today (single exact/eip155:8453 entry)
    [ ] ratify R3'   [ ] other wording: ______

Q2 [architecture fork — blocks R1; the staged branch is on the losing path]
    Path A createGatewayMiddleware = Circle's PRIMARY documented pattern; standalone Express
      middleware w/ its OWN 402 => CANNOT dual-advertise => fails R3. (= what the staged
      branch's smoke test uses; = what our OKX rail did, system-map:284.)
    Path B new x402ResourceServer([cdpFacilitator, new BatchFacilitatorClient({url})])
      + .register('eip155:84532', new GatewayEvmScheme())  => ONE 402, both entries => meets R3.
      Verified feasible: @x402/core@2.9.0 ctor accepts FacilitatorClient[]; register() is
      per-network; CDP is on eip155:8453 so no key collision on testnet.
    [ ] Path B (meets R3 as specified; accept the coupling in Q4)
    [ ] Path A (separate mount, matches OKX precedent + Circle docs; then R3 MUST be
        rewritten to "a Gateway-only 402 on a separate route", and "dual-advertise" is dropped)

Q3 [operator decision — Gateway seller payout address]
    Gateway revenue accrues to a Circle Gateway BALANCE until withdrawal (fund-flow change
    vs CDP's per-tx onchain receipt). Circle's seller quickstart documents no withdrawal flow.
    NB: payTo 0x778A...d59 is NOT a src literal — it's process.env.X402_WALLET_ADDRESS (x402.ts:26).
    [ ] reuse X402_WALLET_ADDRESS (0x778A...d59 Rabby)
    [ ] dedicated CIRCLE_GATEWAY_SELLER_ADDRESS (new env; testnet value for this wave)
    [ ] testnet-only throwaway now, decide at the mainnet wave

Q4 [safety — the wave's "zero risk to the live CDP rail" premise is FALSE under Path B]
    x402.ts:169-176 — resourceServer.initialize() fans getSupported() across EVERY facilitator
    in the array; ANY throw hits the existing catch -> resourceServer=null -> "Payments
    disabled" -> the LIVE CDP mainnet revenue rail goes dark. A Circle outage would take CDP
    down with it. This is the 2026-07-01 OKX crash-loop failure mode (system-map:284, 502 for
    ~1-2min), which was fixed by boot-safe fail-to-DARK mounting.
    Confirm the mitigation is in-scope for R1 (recommend YES; ~small):
      - flag OFF => Circle facilitator never constructed
      - flag ON  => own try/catch + own initialize() probe; ANY failure => drop Circle from the
                    array, CDP proceeds byte-unchanged; never throw at boot
      - test: stub a throwing Circle facilitator, assert CDP still serves its 402
      - BatchFacilitatorClient url is OPTIONAL and DEFAULTS TO MAINNET -> pass explicitly,
        default-deny, unit-test the constructed .url is the testnet host
    [ ] yes, in scope for R1  [ ] separate hardening wave (then R1 ships flag-OFF only)

Q5 [FYI — no answer needed unless you disagree]
    a) Testnet chain = Base Sepolia eip155:84532. Circle testnet offers it; our x402.ts:35-36
       already maps base-sepolia + holds USDC 0x036CbD...cF7e = Circle's exact testnet asset.
       Arc Testnet (eip155:5042002) also offered but needs new chain config. -> Base Sepolia.
    b) NO new feature-registry channel flag. Gateway is a payment METHOD on the existing
       httpX402 channel (identical reach) -> derive from channels.httpX402; adding a
       `gateway:` flag would widen the frozen /capabilities projection for zero consumer.
    c) Staged branch = 472 commits behind (base 2026-05-19), 1 commit, zero src/, dep at
       ^3.0.4 (SAME major as 3.2.0 -- the spec's "older major v1/v2" premise is FALSE).
       -> rebuild off origin/main (worktree already cut @ 6766a71), salvage the smoke test's
       /server import + INTEGRATION gate + 503 branch. No rebase.
    d) R4 price-parity: TOOL_PRICING is genuinely single-source (derives from
       FEATURE_REGISTRY.x402.basePriceUsd) BUT SIGNAL_TIMEFRAME_PRICING (x402.ts:80-92)
       overrides per timeframe for get_trade_signal ($0.05@1m -> $0.02@1d). The parity test
       must cover the timeframe dimension or it pins an incomplete surface.
    e) Ambient src/types/*.d.ts NOT needed -- package ships its own types.
    f) Circle's own BatchFacilitatorClient JSDoc cites url "https://gateway.circle.com" ->
       NXDOMAIN. Real hosts: gateway-api.circle.com / gateway-api-testnet.circle.com.
    g) Marketplace "~41 services / 640 endpoints, launched 2026-05-11" NOT confirmable from
       primary sources. Objective-framing only, gates no code. Listing = submission form =>
       MANUAL_PENDING. Flagging rather than asserting.
```

---

## 10. R0 status

| requirement | state |
|---|---|
| SDK-shape diff vs staged branch | ✅ done — 0 fictional, spec's "older major" premise falsified |
| peer-dep compat | ✅ GREEN — no skew |
| testnet host/chain confirm | ✅ both hosts HTTP 200; Base Sepolia recommended |
| test-runner confirm | ✅ `vitest run` |
| system-map Step-0 edge enumeration | ✅ edge touched → `updated: Y` |
| staged-branch drift verdict | ✅ rebuild off `origin/main`, no rebase |
| **HALT → architect approval** | 🛑 **BLOCKED on Q1 / Q2 / Q4 (+ Q3 operator decision)** |

**No code written. No dep installed into the repo. No commit. Worktree cut but untouched beyond this file.**
