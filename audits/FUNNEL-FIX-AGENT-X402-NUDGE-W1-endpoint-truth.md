# FUNNEL-FIX-AGENT-X402-NUDGE-W1 — endpoint-truth (R1, Plan-Mode)

**Produced BEFORE any code (per CLAUDE.md Plan-Mode: endpoint-truth before C1; wait for architect).**

- **Base:** `origin/main` @ `075d408` · worktree `/Users/tank/code/cqsm-wt-x402-nudge` · branch `feat/funnel-x402-nudge-w1`
- **Prod:** container `crypto-quant-signal-mcp-mcp-server-1` (Up), published port `3000`, Hetzner `204.168.185.24`; facilitator sidecar `crypto-quant-signal-mcp-facilitator-1` (healthy)
- **Probed:** 2026-07-12 (live env + live route-shape)
- **Verdict:** every cited primitive EXISTS (0 fictional). **1 MAJOR spec-vs-prod drift (ACP), 3 design findings.** HALT for architect.

---

## A. Cited primitives — `claim | reality | resolution`

| # | Prompt claim | Reality (live-verified) | Resolution |
|---|---|---|---|
| 1 | `TierLimitReachedError` envelope with `suggested_upgrade_url` + `referral_hint` | `src/lib/errors.ts:94` class; fields `{code:'TIER_LIMIT_REACHED', current_usage, monthly_limit, tier, suggested_upgrade_url, retry_after_days, referral_hint}`. Projected to wire **inline** at `src/index.ts:179‑193`. | ✅ exists. ⚠️ **D2**: projection is INLINE, not an exported allow‑list formatter (cf. `buildInsufficientCandlesPayload`). AC3 requires the formatter → wave must EXTRACT `buildTierLimitPayload()`. |
| 2 | `suggested_upgrade_url` (`upgrade_from=limit` + utm) | `errors.ts:99` (field), `:128` (appends `upgrade_from=limit`); projected `index.ts:187`. | ✅ verified, keep intact. |
| 3 | agent‑relayable `referral_hint` | `errors.ts:104` / `:124` (`buildReferralHint`); projected `index.ts:191`; type `ReferralHint` = `{cta, link_or_path, bonus_calls, from}` (`nudge-copy.ts:134`). | ✅ verified, keep intact. New `suggested_x402` mirrors this additive/allow‑listed shape. |
| 4 | rails unified via `feature-registry.ts channels{}` | `src/lib/feature-registry.ts:69` `channels:{mcp,httpX402,bot,webhook,a2mcp,acp}` (per‑tool REACH booleans). `FEATURE_REGISTRY` `:107`. | ✅ verified. This is the rail‑derivation SoT (registry owns REACH; helper maps SURFACE locally). |
| 5 | per‑tool price = the one `TOOL_PRICING` SoT | `src/lib/x402.ts:73` `TOOL_PRICING = Object.fromEntries(FEATURE_REGISTRY.flatMap(... f.x402.basePriceUsd ...))` — **derived** from the registry (canonical+aliases). | ✅ single‑derivation confirmed. Prices: `get_trade_call/get_market_regime/scan_trade_calls/get_equity_*`=**$0.02**, `scan_funding_arb`=**$0.01**, knowledge=`null`. |
| 6 | x402 middleware boot `registerExactEvmScheme` (don't perturb) | `src/lib/okx-a2mcp.ts:38` import, `:305` call — INSIDE `buildOkxHttpResourceServer()` → `mountLive()`. Boot‑safe (try/catch → DARK; incident 2026‑07‑01). | ✅ verified. Nudge helper is **read‑only** (`okxA2mcpTools()`, `selectOkxA2mcp()`), never touches the mount/boot path → structurally unperturbed. |
| 7 | CDP x402 Bazaar `POST /x402/<tool>` LIVE (Base/USDC) | Route mount `x402-http-routes.ts:191`, gated by `resolveFacilitatorFromEnv().discoveryEnabled` (`x402-facilitator.ts:97,127`). Canonical `POST /x402/get_trade_call` = paid alias (`x402-http-routes.ts:207‑213`). URL = `bazaarResourceUrl()` = `https://api.algovault.com/x402/<tool>` (`x402-bazaar.ts:321,324`). | ✅ **LIVE** — see §B route proofs (402). Nudge Bazaar predicate = the SAME `discoveryEnabled` the route‑mount uses. |
| 8 | okx.ai A2MCP `POST /a2mcp/<tool>` (X Layer/USDT0) behind `OKX_AI_ENABLED` | `okx-a2mcp.ts`: tools `okxA2mcpTools()` `:54` (`channels.a2mcp`), route `/a2mcp/<tool>` `:50,:170`, price `okxA2mcpPriceUsdt0()` `:65` = `basePriceUsd` (USDT0), gate `OKX_AI_ENABLED` `:92`, network `eip155:196`, asset USDT0 `0x779Ded0c…3736`. | ✅ **LIVE** — see §B (402). |
| 9 | Virtuals ACP behind `ACP_ENABLED` — **"NOT live yet… expect ACP OFF"** | ❌ **PROD `ACP_ENABLED=true`** (§B). ACP surface = `src/channels/acp/{seller-worker,provider,offerings}.ts`, started in‑process (`index.ts:38 startAcpSellerWorker`). **NO `/acp` HTTP route exists** (grep empty). ACP is the Virtuals seller‑worker PROTOCOL (job‑negotiated), not a synchronous HTTP 402 an agent settles with `x-payment`. | 🛑 **D1 (MAJOR drift)** — see §C. Two independent problems: (a) premise "not live" is stale; (b) ACP has no agent‑actionable route → cannot be represented as a `suggested_x402` `{url, price}` entry. **Architect decision required.** |
| 10 | Envelope‑only keeps `tools/list` byte‑identical | Change touches response CONTENT (`TierLimitReachedError` payload) + response METADATA (`_algovault.tier_warning`) only. No `server.tool(...)` registration / input schema touched. | ✅ byte‑identical by construction (verify with the existing tools/list canary in R5). |
| 11 | Quota stays `free:${ipHash}` stateless | `MCP_STATELESS` unset in prod (stateless default per CLAUDE.md). Envelope change is downstream of quota resolution; resolver untouched. | ✅ verified; resolver not in the change surface. |

---

## B. Live rail-enablement + route-shape proofs

**Prod env (allow-list grep of `/proc/1/environ`, non-secret flags only):**
```
ACP_ENABLED=true            ← prompt said OFF/not-live (DRIFT D1)
BAZAAR_DISCOVERABLE=true
OKX_AI_ENABLED=true
X402_FACILITATOR=cdp        → discoveryEnabled=true → /x402/* routes mounted
X402_NETWORK=base-mainnet
X402_WALLET_ADDRESS=0x778A…(set, masked)
X402_NUDGE_ENABLED          ← absent (default OFF, expected — this wave introduces it)
MCP_STATELESS               ← absent (stateless default, expected)
```

**Route-shape probes (server-side from Hetzner @ 127.0.0.1:3000; Bazaar also confirmed from Mac):**
```
GET  /capabilities            -> 200
POST /capabilities            -> 404   (GET-only; expected)
GET  /x402/get_trade_call     -> 402   POST -> 402   (Base/USDC Bazaar, canonical route LIVE)
GET  /x402/get_trade_signal   -> 402   POST -> 402   (alias route LIVE)
POST /x402/scan_funding_arb   -> 402                 (Bazaar)
GET  /a2mcp/get_trade_call    -> 402   POST -> 402   (okx.ai A2MCP, X Layer/USDT0 LIVE)
```
Both HTTP x402 rails return the expected 402 payment-required challenge. **ACP: no HTTP route to probe** (protocol-only).

---

## C. Drift & design findings (→ HALT Q-block in the audit doc)

- **D1 (MAJOR — spec vs prod):** `ACP_ENABLED=true` in prod (prompt: "not live, expect OFF"; the "auto-includes when ACP_ENABLED flips" premise is already satisfied). **Compounding:** ACP has **no HTTP pay-per-call route** — it is the Virtuals ACP seller-worker protocol, not an endpoint an agent settles autonomously with `x-payment`. A field literally named `suggested_x402`, shaped as `{url, method, price}`, **cannot faithfully represent ACP**, and emitting an ACP "route" that doesn't exist would point agents at nothing. → **Recommend: scope `suggested_x402` to the two real HTTP x402 rails (Bazaar primary, okx a2mcp alternative); EXCLUDE ACP** (or, if wanted, a separate protocol-shaped `suggested_acp` pointer — arguably out of this wave's scope). Architect to decide. This also reshapes AC2/R4's "ACP appears on flag" test → demonstrate rail-agnostic derivation via the **okx a2mcp toggle** (`OKX_AI_ENABLED`) or a fixture rail instead.
- **D2 (fix inline, in-scope):** `TierLimitReachedError` wire payload is built INLINE at `index.ts:179‑193` — there is **no** exported allow-list formatter yet. AC3 ("added via the allow-list formatter") ⇒ extract `buildTierLimitPayload(err, {suggestedX402?})` (mirroring `buildInsufficientCandlesPayload`) and add `suggested_x402` there. Must be byte-identical when `X402_NUDGE_ENABLED` OFF.
- **D3 (coverage — decision):** `scan_trade_calls` does NOT throw `TierLimitReachedError`; its quota wall RETURNS a separate `{error:'quota_exhausted', code:'tier_limit_reached', referral_hint, …}` payload (`scan-trade-calls.ts:~180`). R3 scopes to `TierLimitReachedError` + hard `tier_warning`, so the scanner is out-of-scope as written — **but the scanner IS x402-payable** (`/x402/scan_trade_calls` 402). Include it (consistent coverage) or defer to a follow-up? Architect to decide.
- **D4 (minor — confirm):** equities (`get_equity_call/get_equity_regime`) throw `TierLimitReachedError` and ARE x402-payable (`channels.httpX402=true`, `$0.02`, route mounted), so they'd naturally get `suggested_x402`. Memory notes an "equities = public-copy HOLD". `suggested_x402` is agent-relayable response metadata (a live payable route), not public track-record/marketing copy — believed fine, flagged for confirm.

---

## D. system-map edges (Step-0 enumeration)

- **New internal consumer edge:** the tier-limit envelope projection (`index.ts` handler / extracted `buildTierLimitPayload`) + `withTierWarning` (hard) now **READ** `feature-registry channels{}` + `TOOL_PRICING` + `resolveFacilitatorFromEnv().discoveryEnabled` + `selectOkxA2mcp()` via the new `src/lib/x402-nudge.ts` helper, to compose `suggested_x402`.
- **No producer/edge/role change** to the rails themselves, the quota resolver, or `tools/list`. If system-map has a row for the tier-limit envelope or the feature-registry consumer set, add the new read edge + overwrite the single `Last touched:` line same commit; else `system-map.md updated: n-a`. (Confirmed at implementation time.)
