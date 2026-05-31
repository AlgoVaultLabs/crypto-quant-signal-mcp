# X402-BAZAAR-HTTP-REDECLARE-W1 — endpoint-truth.md (Plan-Mode Step 0)

**Produced:** 2026-05-30 · **Status:** awaiting architect approval BEFORE any state mutation (C1).
**Verdict:** **0 fictional primitives** — every spec primitive live-probed real. 1 required design enhancement surfaced (the 402-carries-extension listing channel, item K). No HALT.

Target ICP tier(s): T3 + tier-agnostic autonomous agents (matches prompt header).

---

## 0. Baseline (clean-baseline + drift)

- Canonical clone `~/code/crypto-quant-signal-mcp`; branch `main` **HEAD `98ca2e5` == `origin/main`** (fetched). Clean baseline — only untracked = `.x402-sepolia-settle-proof.cjs` (last session's proof harness) + 2 concurrent-wave `audits/NPM-PUBLISH-v1.19.*-endpoint-truth.md`. No staged/modified tracked files (no parallel-session contamination).
- **Version drift since parent:** parent `X402-CDP-BAZAAR-DISCOVERY-W1` shipped at `74507f3` on v1.18.2; main is now **v1.19.x** (release waves landed since). **All anchors below re-derived from current `origin/main` (98ca2e5), not the parent commit.**
- **Parent's x402 files BYTE-UNCHANGED since `74507f3`:** `git log 74507f3..HEAD -- src/lib/x402.ts src/lib/x402-bazaar.ts src/lib/x402-facilitator.ts` → empty. So the FacilitatorAdapter + MCP-type declaration are exactly as shipped.
- **CDP key:** valid 64-byte Ed25519 already in Hetzner `.env` behind OFF flags (validated 3 ways last session — local + in-container `getSupported()` 28 kinds + live Sepolia settle). `payTo=0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59` (== `.env`, A6 confirmed).

## 1. Claim | reality | resolution

| # | Claim (spec) | Reality (probed 2026-05-30) | Resolution |
|---|---|---|---|
| A | `DeclareBodyDiscoveryExtensionConfig` / HTTP body-discovery exists in installed `@x402/extensions` | Installed **2.9.0** (live npm **2.14.0** — same major 2, NOT >6mo stale → no HALT). `DeclareBodyDiscoveryExtensionConfig` present (`index-DihVrF7v.d.ts:180`): `{ method?, input?, inputSchema?, pathParams?, pathParamsSchema?, bodyType:"json"\|"form-data"\|"text", output?:{example?,schema?} }`. `declareDiscoveryExtension(config)` accepts `DistributiveOmit<…,"method">` → `Record<string,DiscoveryExtension>` (`:400`). `method` is set later by `bazaarResourceServerExtension.enrichDeclaration` from the live request. **No `toolName`/`description` field** on the body config (description belongs to the resource/402, not the ext). | ✅ real. Use installed 2.9.0 (no bump — same major + symbol present). Declaration: `declareDiscoveryExtension({ bodyType:"json", input:spec.example, inputSchema:spec.inputSchema, output:{example:spec.output.example} })` → `{ bazaar:{ info:{ input:{type:"http",bodyType:"json",body:…}, output }, schema } }`. |
| B | Reuse the same tool handlers (DRY single-SoT) | Core fns exported: `getTradeSignal` (`tools/get-trade-call.ts:79` → `TradeCallResult`), `scanFundingArb` (`tools/scan-funding-arb.ts:140` → `FundingArbResult`), `getMarketRegime` (`tools/get-market-regime.ts:30` → `MarketRegimeResult`). The MCP `server.tool` handlers (`index.ts:281/345/385`) are THIN wrappers: `getRequestLicense()` → core fn → `logRequest`/`upsertAgentSession` → `toolErrorContent`. | ✅ HTTP routes import + call the SAME 3 core fns + the same thin wrapper (license=x402, analytics, error). NO scoring/logic duplication. |
| C | Server router mount point | `express()` app `index.ts:794`; rate-limit buckets `/mcp` `/analytics` `/webhooks` (:808-810); MCP at `app.all('/mcp', express.json(), …)` (:1936). Paywall = `const {license,pendingSettlement}=await resolveLicense(headers)` (:1939); request runs in `requestContext.run({license,…})` (:2004); **`settleX402Async(pendingSettlement)` fire-and-forget after response, skipped on HOLD** (:2066-67). | ✅ add 3 `app.post('/x402/<tool>', express.json(), …)` in the same app; reuse `resolveLicense` + `requestContext.run` + `settleX402Async`. |
| D | x402 paywall signaling | `resolveLicense(headers)` (`license.ts:110`) = 3-tier gate: `verifyX402Payment(headers)` (:119) → on valid `{ license:{tier:'x402'}, pendingSettlement:_settlement }`. `tier:'x402'` ⇒ `Infinity` quota (`:319`), no counter tick. | ✅ x402-paid ⇔ `license.tier==='x402'`. HTTP route: unpaid (`tier!=='x402'`) → **402**; paid → core fn + settle. |
| E | Current MCP-type declaration to switch | `x402-bazaar.ts:221-234` `declareBazaarRoute(tool)` → `declareDiscoveryExtension({toolName,description,inputSchema,example,output})` → `{bazaar:{info:{input:{type:"mcp",toolName,…}}}}`. `BAZAAR_ROUTES` (3 tools) + `assertNoBazaarLeak` + `FORBIDDEN_BAZAAR_TOKENS` already present. | ✅ retarget `declareBazaarRoute` to the HTTP body config; KEEP descriptions/schemas/examples + leak guard; description moves onto the resource/402. |
| F | Pricing + 402 + settle exports | `x402.ts`: `TOOL_PRICING` (:46) = get_trade_signal **$0.02**, scan_funding_arb **$0.01**, get_market_regime **$0.02**; `verifyX402Payment` (:203), `settleX402Async` (:254), `generate402Response(toolName)` (:279). | ✅ reuse `TOOL_PRICING` (no divergent pricing); enhance `generate402Response` per item K. |
| G | Response-shape parity / no leak (R3) | All 3 core result types grep-clean of `outcome_return_pct`/`outcome_price`/Phase-E (PFE-only — they ARE the public shape the MCP path already returns). `_algovault` block already on outputs. Shape-snapshot precedent: `audits/*-shape-snapshot-*.json` (10+ exist). | ✅ HTTP output == core fn output (byte-parity w/ MCP). Add `audits/x402-http-<tool>-shape-snapshot-2026-05-30.json` (allowed/forbidden keys + leak assertion). |
| H | Flag-gated mount (R5) | `resolveFacilitatorFromEnv().discoveryEnabled` = `effectiveChoice==='cdp' && bazaarRequested` (`x402-facilitator.ts:97`). Defaults legacy/false → `discoveryEnabled=false`. | ✅ mount the 3 routes ONLY when `discoveryEnabled` at server boot → defaults ⇒ routes never registered ⇒ **404** (byte-identical prod); flip = instant rollback. |
| I | Route-shape probe (R5/R7) | n/a (post-deploy) | Probe: `curl -sS -o /dev/null -w '%{http_code} %{content_type}' -X POST .../x402/<tool> -d '{}'` → expect **402** + `application/json` when flags ON; **404** when OFF. |
| J | CDP discovery endpoints | live (last session): `/discovery/{resources,search,merchant?payTo=}` all 200; catalog is **`type:"http"` only** (the reason this wave exists). Listing earned on first **settle** through `https://api.cdp.coinbase.com/platform/v2/x402`, ~10 min cache. | ✅ confirm Sepolia listing (R7) + mainnet listing (R8) via these. |
| **K** | **(design finding) how an HTTP route EARNS the listing** | Last session, empirically: `x402ResourceServer.settlePayment(payload,reqs,declaredExtensions)` does **NOT** forward `declaredExtensions` to `facilitatorClient.settle()` (`server/index.js:1017`); `bazaarResourceServerExtension` has only `enrichDeclaration` (no `enrichSettlementResponse`). **The catalog channel is the PAYMENT PAYLOAD's `extensions`** — the buyer's x402 client copies `PaymentRequired.extensions` + `resource` into the payload (`createPaymentPayload` extracts x402Version/resource/extensions), and CDP reads them on `/settle`, returning the `EXTENSION-RESPONSES` header. Current `generate402Response` (`x402.ts:279`) emits `accepts` but **no `resource.url` and no `extensions`**. | **REQUIRED enhancement (R2+R4):** the HTTP route's 402 must emit `PaymentRequired` with `resource:{url:"https://api.algovault.com/x402/<tool>", description:<tool desc>, mimeType:"application/json"}` **and** `extensions: declareBazaarRoute(<tool>)` (HTTP-body). Then a buyer settle carries them → CDP catalogs the http resource. This is the crux that makes the listing appear (proven failure mode for MCP-type). Verified end-to-end on Sepolia in R7 before mainnet. |

## 2. Identifier diff (R-section vs AC-section)

| Identifier | R-section | AC-section | Match |
|---|---|---|---|
| Route paths | `/x402/get_trade_signal`, `/x402/scan_funding_arb`, `/x402/get_market_regime` (R1) | same (AC) | ✅ |
| payTo | `0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59` (R Context, == `.env`) | `<sepolia payTo>` / `<mainnet payTo>` (AC) — same address both nets (Context) | ✅ |
| Network ids | `eip155:8453` mainnet / `eip155:84532` Sepolia (R7/R8) | same (AC) | ✅ |
| Flags | `X402_FACILITATOR=cdp`, `BAZAAR_DISCOVERABLE=true` (R5/R8) | same (AC) | ✅ |
| CDP facilitator | `https://api.cdp.coinbase.com/platform/v2/x402` (R2/R7) | same (AC) | ✅ |
| Tools (paid) | get_trade_signal, scan_funding_arb, get_market_regime; get_trade_call FREE (R4) | same (AC) | ✅ |
| Pricing | reuse `TOOL_PRICING` (R2) | "same price as MCP tool" (AC) | ✅ |

**0 identifier mismatches.**

## 3. system-map edge-touch enumeration

- **Existing (parent):** §4 External-integration #27 "CDP x402 Bazaar / Agentic.Market" (`system-map.md:286`) — currently describes the 3 paid **MCP** tools publishing via FacilitatorAdapter.
- **This wave touches:**
  1. Enrich #27 entry: MCP-type → **HTTP-type**; producer = 3 new HTTP x402 resource endpoints; consumer reach += **AWS Bedrock AgentCore** + Agentic.Market (consume CDP's catalog — downstream reach of the same CDP edge, not a new direct integration ⇒ external count stays **27**, enriched).
  2. §3 Component reference + §1 Mermaid + §2 ASCII: add `HTTP x402 routes (/x402/*)` node as a producer fed by the same core tool fns, gated by `discoveryEnabled`.
- `system-map.md updated: Y` at the final commit (per AC).

## 4. Proposed execution (R1→R11; R7 = HARD gate before R8)

```bash
# R1-R6 (code) — new module src/lib/x402-http-routes.ts (mount fn) + edits to
#   x402-bazaar.ts (MCP→HTTP-body declare), x402.ts (generate402Response += resource+extensions),
#   index.ts (mount 3 routes when discoveryEnabled). Tests R10. Snapshots R3.
rm -rf dist && npm run build && npm test     # clean rebuild + parity/402/flag-off/leak suites

# R7 SEPOLIA RE-PROOF (hard gate) — updated harness: HTTP-body declaration +
#   resource.url = https://api.algovault.com/x402/get_trade_signal (throwaway payer+seller, faucet)
node .x402-sepolia-settle-proof.cjs            # assert settle.success + EXTENSION-RESPONSES processing
curl -fsS ".../discovery/merchant?payTo=<sepolia-throwaway-seller>" | jq '.pagination.total'  # MUST be >0 (the MCP-type failure)

# R8 MAINNET FLIP (only after R7 green + Mr.1 payTo Basescan cross-check) — atomic .env edit on Hetzner:
ssh … 'cd /opt/crypto-quant-signal-mcp && sed -i "s/^X402_FACILITATOR=.*/X402_FACILITATOR=cdp/;s/^BAZAAR_DISCOVERABLE=.*/BAZAAR_DISCOVERABLE=true/" .env && docker compose up -d --force-recreate mcp-server'
# first real mainnet settle → within ~10 min:
curl -fsS ".../discovery/merchant?payTo=0x778A05280Fd8dB980E920fE9f31d0A8eAbD17d59" | jq
curl -fsS ".../discovery/search?query=perp%20funding%20signal" | jq
# post-deploy gate: confirm first mainnet settles land at the correct payTo (rolling check) before GREEN

# R9 repoint delist canary at HTTP payTo listing; DRY_RUN smoke. R11 retroactive-close parent caveat.
```

**Two-flag firewall + Sepolia-before-mainnet hard gate (execution contract):** routes + discovery mount ONLY when `cdp` AND `true`; defaults `legacy/false` ⇒ 404 byte-identical; `0x804B` sidecar kept warm = instant rollback. R7 (HTTP-type LISTS on Sepolia) is a hard gate before the R8 mainnet flip. Async settle preserved (verify in path, settle fire-and-forget).

## 5. Open points for architect

1. **Item K** (402 must carry `resource` + `extensions`) — confirm the resource URL form `https://api.algovault.com/x402/<tool>` (the public MCP host is `api.algovault.com`). This is the listing channel; without it the http routes settle but don't list (same failure class as MCP-type).
2. **AgentCore as edge:** treat AWS Bedrock AgentCore + Agentic.Market as downstream reach of the CDP edge (external count stays 27, enriched) — OR add as separate §4 rows? (default: enrich.)
3. **Sepolia proof resource URL:** R7 uses the real route URL `…/x402/get_trade_signal` with a throwaway seller (CDP indexes http resources even when the URL 404s — verified last session) — faithful + zero prod risk. Confirm acceptable.

**Awaiting approval — no code/deploy/flip until ratified.**
