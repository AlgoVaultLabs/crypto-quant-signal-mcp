# Changelog

All notable changes to `crypto-quant-signal-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.16.0] - 2026-05-19

### Added
- 3-minute timeframe added to the public track record. PFE win rate and sample count visible at algovault.com/track-record.
- Integration walkthroughs at algovault.com/integrations for Claude Desktop, Claude.ai, Cursor, Cline, and Codex CLI.
- Documentation section at algovault.com/docs covering the search_knowledge and chat_knowledge MCP tools.

### Improved
- Knowledge tools (search_knowledge, chat_knowledge) now index blog posts, YouTube videos, and GitHub Discussions. Bundle refreshes weekly.

## [1.15.1] - 2026-05-18

### Added
- Chat usage analytics (admin-gated `/admin/chat-analytics` dashboard) with weekly Telegram digest.

### Fixed
- Track-record dashboard: LATEST TRADE CALLS panel now matches surrounding card surfaces (visual unification).

### Distribution
- npm registry catches up from v1.14.0 (v1.15.0 was published to GitHub + MCP Registry but skipped npm; v1.15.1 publishes to all surfaces simultaneously).

## [1.15.0] - 2026-05-18 — v1.15.0 — `search_knowledge` + `chat_knowledge` MCP tools (AV-CHAT-MCP-W1)

### Added — two new MCP tools indexed automatically from the v1.14.1 KnowledgeBundle

- **`search_knowledge` MCP tool + `POST /api/search` HTTP endpoint.** BM25 lexical retrieval over `dist/knowledge/latest.json`. Free, fast, no LLM call, no quota cost. Self-pitching describe-text intentionally reads as an instruction to the calling agent ("Use this BEFORE attempting any tool call to confirm correct parameter usage"). Backed by `wink-bm25-text-search@^3.1.2` (MIT). Field weights: name=3, title=3, description=2, content_markdown=1. Response shape: `{ query, total_results, results[*], _algovault: { bundle_version, bundle_generated_at } }`. Public-shape contract: `audits/search-knowledge-shape-snapshot-2026-05-18.json`.
- **`chat_knowledge` MCP tool + `POST /api/chat` HTTP endpoint.** Natural-language Q&A with citations. Backed by Claude Haiku 4.5 (default) or Claude Sonnet 4.6 (opt-in). Locked verbatim 6-rule system prompt; prompt caching enabled (`cache_control: ephemeral`) for ~90% input-cost discount on the cached system block. Citations carry `source_type`, `source_url`, `title`, `excerpt`. Quota: Free 10/month, Starter 50/month, Pro 200/month, Enterprise 2000/month — tracked separately from trading-tool quotas in the new `chat_usage_monthly` Postgres table. Response shape: `{ question, answer, citations[*], model, _algovault: { bundle_version, bundle_generated_at, quota_remaining } }`. Token counts remain operator-internal — never leak to the public response. Public-shape contract: `audits/chat-knowledge-shape-snapshot-2026-05-18.json`.
- **In-process file watcher.** Both tools share a single `KnowledgeIndex` instance that watches `dist/knowledge/latest.json` via `fs.watchFile` (poll every 30s) and atomically rebuilds the BM25 docs on mtime change. Any future tool description, integration tutorial, audit snapshot, or `npm version` bump flows automatically into the next search/chat response within ≤30s — zero manual refresh, zero hand-curated answers.
- **`StubLLMProvider` graceful fallback.** If `ANTHROPIC_API_KEY` is unset, server still boots (once-only `console.warn` at startup); `chat_knowledge` returns recognizable `[STUB] <question>` text with citations intact. Live-key provisioning is a post-deploy operator step.
- **New deps.** `@anthropic-ai/sdk@^0.96.0` (MIT, Anthropic), `wink-bm25-text-search@^3.1.2` (MIT, GRAYPE Systems), `lru-cache@^10.4.3` (ISC, Isaac Schlueter) added as direct production dependencies.
- **Vitest coverage.** 30 new tests across 6 files: `tests/unit/{knowledge-index,search-engine,result-cache,llm-provider,chat-engine}.test.ts` + `tests/integration/knowledge-flow.test.ts`. Locks: BM25 build/rebuild semantics, atomic swap, cache TTL + LRU + clear, query/limit/cache invariants, stub fallback, chat context building + citations + cache + truncation, fix-at-generator regex canary (no `if question.includes(X) return Y` shortcuts), public response shapes match snapshot.

### Cache-refresh recommended

MCP clients cache `tools/list` at session start. To see the new tools:
- Claude.ai / Claude Desktop — toggle the connector off/on
- Cursor / Cline — restart the MCP server connection

## [1.14.1] - 2026-05-18 — Auto-generated per-release knowledge bundle JSON (KNOWLEDGE-ARTIFACT-W1)

### Added — `KnowledgeBundle` artifact through 3 surfaces

- **`/knowledge/latest.json` + `/knowledge/:slug.json` + `/knowledge/index.json` public HTTP endpoints.** Each serves the auto-generated per-release `KnowledgeBundle` (12-field allow-list — every MCP tool description, response-shape audit snapshot, integration tutorial, package metadata, and README "What's new" slice). `Cache-Control: public, max-age=3600`. Slug regex `^v\d+\.\d+\.\d+$` guards against path traversal.
- **MCP resource scheme `algovault://knowledge/*`.** New `server.resource()` registrations for `algovault://knowledge/latest` + every versioned bundle. MCP clients listing resources via the `tools/list` extension can discover and read the bundle in-session.
- **GitHub Release asset.** Every `npm version` git-tag push attaches `dist/knowledge/algovault-knowledge-v*.json` + `latest.json` + `index.json` via the new `.github/workflows/release-knowledge.yml` workflow (`softprops/action-gh-release@v2`, first-use in this repo).
- **Generator: `scripts/build-knowledge-json.mjs`** (ESM, Node-20-safe, idempotent). Generator-first design — globs over `src/tool-descriptions.ts` (4 tool entries) + `audits/*-shape-snapshot-*.json` (response_shapes) + `landing/integrations/*.html` (integrations) + `README.md` (whats_new) + `package.json` (metadata). Adding any new audit snapshot / integration HTML / tool flows automatically into the next bundle. **Zero hand-listed knowledge items.**
- **Pure formatter: `src/lib/knowledge-formatter.ts`** + **lazy-load store: `src/lib/knowledge-store.ts`.** Allow-list semantics — extra keys are silently dropped, so the public shape is guaranteed even if a buggy generator produces extras.
- **Two-sided PII guard** (Data Integrity LAW). DENY: build-time regex over the stringified bundle rejects value bindings of `outcome_return_pct` or `outcome_price`. REQUIRE: vitest canary asserts at least one `response_shapes[*].forbidden_keys` array lists `"outcome_return_pct"` — proves the term exists AS METADATA in the right place, never as a leaked value.
- **Public-shape snapshot:** `audits/knowledge-shape-snapshot-2026-05-18.json` (`allowed_keys` / `forbidden_keys` / `error_contract` / `cache_contract` / `consumers` / `drift_check_command`). Live drift probe: `curl -fsS https://api.algovault.com/knowledge/latest.json | jq -e '<has-chain> and (has("outcome_return_pct") | not)'`.
- **Vitest canary:** `tests/unit/knowledge-bundle.test.ts` (15 tests). Locks: schema-valid output, byte-idempotent generator, 4-entry tool runtime shape, response_shapes count matches `audits/*-shape-snapshot-*.json` glob, integrations count matches `landing/integrations/*.html` glob, two-sided PII guard, empty `examples` array, formatter rejects empty input.

### Changed — MCP `tools/list` description for `get_trade_signal`

- **`TRADE_CALL_ALIAS_SUFFIX` literal rewritten.** OLD: `" (Alias for \`get_trade_call\` since v1.10.0; identical behavior. New agents should call \`get_trade_call\`.)"`. NEW: `" [ALIAS] This tool is an alias of get_trade_call — same behavior, kept for backward compatibility."`. Future tool aliases follow the same `[ALIAS]` tag pattern.

### Cache-refresh recommended

MCP clients cache `tools/list` at session start. To pick up the refreshed `get_trade_signal` alias description — Claude.ai / Claude Desktop: toggle connector off+on. Cursor / Cline: restart MCP server connection.

### Dockerfile

- **Stage 1 extended** with `COPY scripts/build-knowledge-json.mjs ./scripts/` + `COPY audits/ ./audits/` + `COPY landing/integrations/ ./landing/integrations/` + `COPY README.md ./README.md` + `RUN npm run build:knowledge`. The Hetzner host re-builds the image post-`git pull` via `docker compose up -d --build`, so the generator runs INSIDE the build context — NOT on the GHA runner. `dist/knowledge/*.json` is inherited into Stage 2 via the existing wholesale `COPY --from=builder /app/dist/ ./dist/`.

### Why a patch (not minor)

- New endpoints + new MCP resources are additive; no schema mutation on the existing 3 production tools. The alias-suffix copy change is non-breaking (back-compat alias still exists and works identically). Patch bump per SemVer.

## [1.14.0] - 2026-05-18 — Framework integrations live: LangChain · LlamaIndex · Microsoft Agent Framework · CrewAI

### Added — README cross-links to 4 framework tutorials

- **`README.md` overhauled from `NPM-readme-DRAFT.md` SoT.** New Framework integrations subsection mirroring the existing exchange-integrations pattern. 4-row table linking the [algovault-skills](https://github.com/AlgoVaultLabs/algovault-skills) tutorials:
  - **LangChain** — [`docs/integrations/langchain.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/langchain.md) (pairs with `langchain-mcp-adapters` 0.2.2)
  - **LlamaIndex** — [`docs/integrations/llamaindex.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/llamaindex.md) (pairs with `llama-index-tools-mcp` 0.4.8)
  - **Microsoft Agent Framework** — [`docs/integrations/maf.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/maf.md) (pairs with `agent-framework` 1.4.0)
  - **CrewAI** — [`docs/integrations/crewai.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/crewai.md) (pairs with `crewai` 1.14.4 + `crewai-tools[mcp]` 1.14.4)
- **Landing-page mirrors at `/docs/integrations/{langchain,llamaindex,maf,crewai}`** — extended `scripts/render-integrations.mjs` with a `FRAMEWORKS` array so the same Tailwind navy/mint canonical-chrome wrap that renders the 4 exchange mirrors now produces 4 framework mirrors alongside. Committed static HTML at `landing/integrations/{langchain,llamaindex,maf,crewai}.html`.
- **Snapshot lines refreshed** from live API: PFE WR `90.4%` → `90.5%`; total calls `86,093` → `96,898`; Merkle batches `33` → `38`; asset count `720+` → `730+`.

### Changed — README + landing mirrors only (no runtime change)

- Pure README + landing-mirror release. **Zero tool schema mutation** — no parameter changes, no enum changes, no default changes. MCP clients that have already picked up the v1.13.2 tool-description refresh need no further cache invalidation.

### Why a minor (not patch)

- Framework integrations are a NEW public capability surface cross-linked from the npm registry README. Additive, non-breaking. Minor bump per SemVer + per project release ritual (4 marketing artifacts on framework-grade releases).

## [1.13.2] - 2026-05-16 — Tool descriptions rewritten for BM25 + regex retrieval ranking

### Changed — `tools/list` description copy (no behavior change)

- **`get_trade_call`, `scan_funding_arb`, `get_market_regime` descriptions rewritten** for Anthropic Tool Search (`tool_search_tool_regex_20251119` + `tool_search_tool_bm25_20251119`) which ranks over `tools/list` name + description + arg-name + arg-description. Each tool's combined-text (tool description + sum of param `describe()` strings) now contains ≥15 of 20 canonical keyword phrases observed in AI-agent-builder search vocabulary. Length budget tightened: tool descriptions ≤350 chars, param descriptions ≤80 chars.
- **`get_trade_signal` alias** — same canonical description as `get_trade_call` + back-compat suffix unchanged.
- **`get_market_regime` no longer claims "for a Hyperliquid perp"** — the description now reflects the actual 5-venue coverage (Binance / Bybit / OKX / Bitget / Hyperliquid) via the same enum that `get_trade_call` uses; default value remains `HL` (out of scope for this wave).
- **Param `describe()` strings tightened** — verbose shadow-venue prose dropped from `exchange` describe (5+2 enum still functional; shadow status lives on the canonical `mcp://algovault/venues` resource).
- **Zero schema mutation.** Same enum members, same default values, same Zod constraints. Only the prose payload of `tools/list` changed.

### Added — keyword + brand-voice canary

- **`src/tool-descriptions.ts`** — new pure-data module exporting the description constants + `TOP_20_KEYWORDS` lock. Hoisted out of `src/index.ts` so the canary test can import without triggering bottom-of-file `startHttp()` / `startStdio()` bootstrap.
- **`tests/unit/tool-description-keywords.test.ts`** (14 cases) — locks: TOP_20 keyword constant shape; ≥15-of-20 keyword coverage per tool; brand-voice forbidden-phrase canary (`/intelligence layer|powerful|seamless|robust|cutting-edge|industry-leading|Quant LLM|Wall Street Quant Brain/i`); internal-detail forbidden-phrase canary (wave IDs, archetype labels, AOE substrate mechanics); length budget; alias-suffix structure.

### Cache-refresh recommended

MCP clients cache tools/list at session start. To pick up the refreshed tool descriptions — Claude.ai / Claude Desktop: toggle connector off+on. Cursor / Cline: restart MCP server connection.

### Why this matters

The [Arcade benchmark](https://blog.arcade.dev/anthropic-tool-search-claude-mcp-runtime) measured 56% regex / 64% BM25 retrieval at 4,027 tools — keyword tightness compounds with catalog growth. The [Stacklok comparison](https://stacklok.com/blog/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison/) shows gateway-side semantic routers reaching 98% retrieval; that's the medium-term direction but keyword retrieval remains the dominant path for the next ~6 months. This rewrite stays inside the brand-voice LAWs (`feedback_public_copy_professional_concise.md` + `feedback_no_internal_details_in_public_copy.md`) while packing the substantive search vocabulary AI-agent builders actually type.

## [1.13.1] - 2026-05-16 — README republish (NPM-readme-DRAFT.md → README.md)

### Changed — npm-surface README only (no code change)

- **README.md fully replaced from `NPM-readme-DRAFT.md` SoT**: canonical hero badge row (Track Record + ERC-8004 Verified Agent), expanded `## 🪪 ERC-8004 Verified Agent on Base` mini-section directly under the Live Track Record block, `## What's new in v1.13.0` block + v1.12.0 highlights recap, Architecture diagram now lists 5 CEX + 2 DEX experimental adapters (Aster + edgeX) explicitly, `_algovault.version` example bumped to `1.13.0`. AgentId placeholder `<AGENT_ID_PLACEHOLDER>` resolved to live `44544` across 5 anchor sites (hero badge href, identity mini-section bullets + blockquote, what's-new bullet, On-Chain Verification list).
- **Snapshot lines refreshed** from live API at publish time: PFE WR `90.4%` → `90.5%`; total calls `86,093` → `92,995`; Merkle batches `33` → `36`; asset count `720+` → `730+` (in 3 places — Tools `coin` description, pricing table assets row, Why AlgoVault crypto+TradFi bullet).
- **No `src/`, `dist/`, `tests/`, `landing/`, or runtime contract changes.** Pure README/marketing patch — publishes new tarball so npm registry README reflects v1.13.0's ERC-8004 surface for crawlers that read npm's `dist-tags.latest` content (npm caches README from the latest publish).



### Added — first AlgoVault on-chain presence beyond Merkle anchoring

- **ERC-8004 agent identity adopted on Base mainnet.** AgentId `44544` at canonical Identity Registry [`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`](https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544) (impl `getVersion()=2.0.0`). Originally minted 2026-04-12 by archived `molthunt-launch.ts` with non-canonical metadata; ERC-8004-W1 adopted the existing tokenId via `setAgentURI(44544, ipfs://bafkreidx3luset63ky5px35fbykcejwgn2ngwtx66tzgq67pvprc4hv5ki)` to land canonical-shape registration JSON on-chain. AgentURI now resolves to a spec-compliant ERC-8004 registration file (`type/name/description/image/services[]/registrations[]/supportedTrust[]`) with an `algovault` extension namespace (performance pointer, Merkle anchor pointer, verify/track-record URLs).
- **New `GET /api/erc-8004-reputation` endpoint** — public read-only JSON exposing agentId + identity registry + Basescan link + (deferred) attestation aggregator. Path-3 'pending' shape per Plan-Mode Amendment C: `score=null, status="pending", attestation_registry=null` until ERC-8004-W2 wires attestation (canonical mainnet ValidationRegistry not deployed as of 2026-05-16; Reputation Registry `giveFeedback` enforces hard-on-chain self-rejection). 5-min in-memory cache. Shape locked by `audits/api-erc-8004-reputation-shape-snapshot-2026-05-16.json` (6 sections: allowed_keys / forbidden_keys / error_contract / cache_contract / consumers / drift_check_command).
- **`landing/index.html` + `landing/verify.html` + `README.md` Verified-On-Chain surfaces.** Hero trust-mark line + verify-page footer row + README `### Verified on-chain` subsection, each citing agentId 44544 + the Basescan deep link. `data-tr-field="erc8004_agent_id"` span hydrated by extended `landing/js/track-record-proxy.js` (new `/api/erc-8004-reputation` fetch).

### Added — new library + script primitives

- **`src/lib/erc8004.ts`** — Identity Registry ABI + EIP-55-checksummed Base mainnet address constants (`IDENTITY_REGISTRY_ADDRESS`, `REPUTATION_REGISTRY_ADDRESS`, `VALIDATION_REGISTRY_ADDRESS=null` with rationale comment) + CAIP-10 binding + `getBaseRpcUrl()` + `normalizePrivateKey()`.
- **`src/lib/erc8004-registration-json.ts`** — pure `buildRegistrationJson(opts)` returning the canonical ERC-8004 + algovault-extension shape. Forbidden-key canary in tests covers top-level + algovault subtree against `/outcome_return_pct|outcome_price|phase_e/`.
- **`src/lib/erc8004-reputation.ts`** — pure `buildErc8004ReputationBody(opts)` for the new `/api/erc-8004-reputation` endpoint. Same forbidden-key canary.
- **`src/scripts/register-erc8004-agent.ts`** — dual-mode (mint OR `--update-uri`) script. Mint mode: pin v1 → register → pin v2 → setAgentURI (2 txs). Update-uri mode (this wave): single setAgentURI tx, adopts existing agentId with ownership verification. Idempotency via env-pin (`~/.config/algovault/erc8004.env`) + `balanceOf` PRE_MINT canary + Transfer-event scan hint. Pinata IPFS pinning.
- **`tests/unit/erc8004-registration.test.ts` (16 cases)** + **`tests/unit/erc8004-public-shape.test.ts` (12 cases)** — schema locks + forbidden-key canaries + idempotency subprocess + snapshot-vs-builder parity.

### Archived

- **`src/scripts/molthunt-launch.ts` → `archived/scripts/molthunt-launch.ts.deprecated`** per Plan-Mode Amendment E (D3 — zero external consumers per repo-wide grep). Referenced non-existent `agentIdOf(address)` ABI fn (canonical IdentityRegistry has only `ownerOf(uint256)` + `balanceOf(address)`); used non-canonical `{name, description, website, github}` metadata shape. `archived/scripts/README.md` carries deprecation rationale + restore command.

### Path 3 (DEFERRED) — attestation pipeline rolling out in ERC-8004-W2

- Per-resolved-signal attestation flow NOT yet shipped. Path 1 (ValidationRegistry) blocked because canonical mainnet ValidationRegistry not deployed (per `erc-8004/erc-8004-contracts/scripts/addresses.ts` `MAINNET_ADDRESSES.validationRegistry = TBD - need to mine vanity salts`; testnet v0.0.1 contract `0x8004Cb1B...` squats at the same Base-mainnet address but is risky to use). Path 2 (client-authorized feedback) contradicts zero-friction product positioning. ERC-8004-W2 will re-evaluate once canonical mainnet ValidationRegistry ships.

## [1.12.0] - 2026-05-16 — 2-DEX shadow cohort (Aster + edgeX) + tools/list enum widening

### Added — new shadow venues callable via explicit `exchange` arg

- **Aster (`ASTER`)** — BNB-Chain perp DEX, 410 listed perps, ~$2.14B 24h OI per CoinGecko 2026-05-16. REST API is a near-verbatim Binance Futures clone (`fapi.asterdex.com/fapi/v1/*`). Live trade-call probe: `get_trade_call({coin:"BTC", timeframe:"1h", exchange:"ASTER"})` returns Aster's BTCUSDT verdict.
- **edgeX (`EDGEX`)** — L2 zk-rollup perp DEX, 292 contracts, ~$970M OI per AMBCrypto 2026-05-16. REST API at `pro.edgex.exchange/api/v1/public/*` with `{code, data, msg}` envelope; numeric `contractId` ("10000001") with lazy-init lookup table (`byCoin/byId` cache, 1h TTL); `<COIN>USD` symbol naming; SNAKE_UPPERCASE klineType (`MINUTE_1`/`HOUR_1`/`DAY_1`); 4-hour funding cadence (annualized × 2190).

Both venues default to `status='shadow'` per the EXCHANGE-SHADOW-PROMOTE-W1 state machine. NOT in `/api/performance-public.byExchange` aggregates until promoted (≥80% PFE WR after `asset_count × 10` BUY/SELL calls, day-15 minimum window). Visible via:
- `mcp://algovault/venues` MCP resource (returns 7 venues: 5 promoted + 2 shadow)
- `/api/performance-shadow` public HTTP endpoint (returns per-venue lifecycle metadata)
- Daily `evaluate-venues` cron at 06:00 UTC (advances state machine; Telegram alerts on transitions)

### Changed

- **MCP `tools/list` exchange enum widened 5 → 7 venues.** Affects both `get_trade_call`/`get_trade_signal` (`TRADE_CALL_SCHEMA.exchange`) and `get_market_regime.exchange`. Describe-text gains addendum: `'ASTER' = Aster BNB-Chain perp DEX (shadow — experimental), 'EDGEX' = edgeX L2 zk-rollup perp DEX (shadow — experimental)`.
- `ExchangeId` TypeScript union widened 5 → 7 in `src/types.ts`.
- `getAdapter()` dispatch (`src/lib/exchange-adapter.ts`) gains `AsterAdapter` + `EdgeXAdapter` cases.

### Deferred (out of scope for this wave)

- **Lighter (zkSync perp DEX)** — Plan-Mode probe surfaced HALT-class finding: `/candlesticks` endpoint returns `HTTP/1.1 403 Forbidden` from CloudFront (`X-Cache: FunctionGeneratedResponse`) for unauthenticated callers (reproduces from both Kuala Lumpur and Hetzner-DE PoPs → function-level auth gate, not geo block). Without OHLCV bars, indicator pipeline cannot compute RSI/EMA/Hurst/squeeze. Architect ratified Path A (defer); file `LIGHTER-WHEN-CANDLES-W1` follow-up wave to revisit when (a) Lighter's candles endpoint becomes public or (b) we discover an auth scheme via Lighter's GitHub SDK / `app.lighter.xyz` web-app cookie. See `audits/PILOT-ADAPTERS-W1-endpoint-truth.md` §2.c.
- **Auto-seeding of ASTER + EDGEX from the daily restricted-universe cron** — `src/scripts/seed-signals.ts` has hardcoded per-venue branches and was out of C1/C2 scope per Bulk-Spec Scope Rule. Tracked as `PILOT-ADAPTERS-SEED-LOOP-W2` follow-up. Until then, ASTER + EDGEX are callable via explicit `get_trade_call({exchange:'ASTER'|'EDGEX'})` but won't auto-accumulate from the cron.

### Cache-refresh notice for MCP clients

**Upgrading?** MCP clients cache tools/list at session start. Refresh tool list — Claude.ai / Claude Desktop: toggle connector off+on; Cursor / Cline: restart MCP server connection.

The cached 5-venue enum will reject `exchange: 'ASTER'` / `'EDGEX'` until the client re-reads tools/list. After refresh, the new 7-venue enum + shadow-venue describe-text caveat surface.

### Plan-Mode artifact

`audits/PILOT-ADAPTERS-W1-endpoint-truth.md` — 22-row probe matrix across 3 DEX candidates (Aster, edgeX, Lighter); 15-site identifier diff (3 venues × 5 sites: ExchangeId union / TRADE_CALL_SCHEMA / get_market_regime / dispatch / venues seed); 7 nomenclature inline corrections (spec used pre-1.0 `fetchCandles`/`fetchAssetContext`/etc.; production is `getCandles`/`getAssetContext` per `ExchangeAdapter` interface); HALT-class Lighter finding with 3 architect-evaluated paths (defer / degraded-shadow / auth-investigate).

---

## [1.11.1] - 2026-05-15 — TradFi symbol aliasing across all 4 CEX adapters

### Added

- **Per-CEX TradFi symbol aliasing** in all 4 CEX adapters (`src/lib/adapters/{binance,bybit,bitget,okx}.ts`). `get_trade_call({coin: "GOLD", exchange: "BINANCE"})` now resolves to `XAUUSDT` instead of returning `400 Bad Request` from upstream. New `TRADFI_ALIASES` constant per adapter — alias-discovery derived from live Binance/Bybit/Bitget/OKX exchangeInfo probes (TRADFI-SYMBOL-ALIAS-W1, 2026-05-15). Aliases:
  - **Binance**: `GOLD → XAU`, `SILVER → XAG`, `PLATINUM → XPT`, `PALLADIUM → XPD`
  - **Bybit**: `GOLD → XAU`, `SILVER → XAG`
  - **Bitget**: `GOLD → XAU`, `SILVER → XAG`, `PLATINUM → XPT`, `PALLADIUM → XPD`
  - **OKX**: `GOLD → XAU`, `SILVER → XAG`, `COPPER → XCU`, `NATGAS → NG`, `PLATINUM → XPT`, `PALLADIUM → XPD`
  - Symmetric reverse-aliases in `fromBinanceSymbol` / `fromBybitSymbol` / etc. so `_algovault.coin` in the response envelope surfaces the AlgoVault-canonical name (`GOLD`), NOT the CEX-native (`XAU`).
- **`src/lib/venue-coverage.ts`** — static per-venue coverage matrix exporting `getVenuesSupporting(coin)` + `isVenueSupportedFor(coin, exchange)`. HL-only TIER_3 symbols enumerated (24 symbols: ALUMINIUM, BRENTOIL, BX, CORN, DKNG, DXY, EUR, HYUNDAI, JP225, JPY, KIOXIA, KR200, PURRDAT, RIVN, SKHX, SMSN, SOFTBANK, **SP500**, TTF, URANIUM, URNM, VIX, WHEAT, XYZ100). Partial-coverage TIER_3 symbols enumerated per-venue (14 symbols including HIMS, XLE, COST, GME, NFLX). Plus `COVERAGE_PROBED_AT = '2026-05-15'` for staleness audits.
- **`TradFiSymbolUnsupportedOnVenueError`** in `src/lib/errors.ts` — structured error class. Tool handler emits `{error_code: 'TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE', message, coin, requested_exchange, suggested_venues, probed_at}` instead of a flat `{error: 'upstream 400 ...'}`. LLM agents pattern-match on `error_code` and self-retry against `suggested_venues[0]`.
- **Venue-coverage gate** wired in `getTradeSignal` + `getMarketRegime` (`src/tools/get-trade-call.ts`, `src/tools/get-market-regime.ts`). Fires BEFORE the adapter call to avoid hitting upstream with known-unsupported pairs.
- **Plan-Mode artifacts** — `audits/TRADFI-SYMBOL-ALIAS-W1-endpoint-truth.md` (full identifier-diff + collision-fix audit) + `audits/TRADFI-SYMBOL-ALIAS-W1-symbol-coverage.csv` (248-row per-coin × per-CEX raw probe data).
- **NEW test suite `tests/unit/tradfi-symbol-alias.test.ts`** (35+ cases) — forward + reverse alias resolution per adapter; `getVenuesSupporting` invariants (HL-only / partial-coverage / all-5 paths); `isVenueSupportedFor` convenience helper; forbidden-phrase canary carrying over from v1.11.0.

### Refactored

- `src/lib/adapters/bybit.ts` + `src/lib/adapters/bitget.ts` — inline `coin + 'USDT'` (4 sites each) replaced with `toBybitSymbol` / `toBitgetSymbol` helpers (mirror existing `toBinanceSymbol` / `toOKXInstId` pattern). Reverse-map `fromBybitSymbol` / `fromBitgetSymbol` plumbed into `getPredictedFundings` so the canonical coin name surfaces on every adapter's output.
- All 4 adapter symbol-helpers (`toBinanceSymbol` / `fromBinanceSymbol` / etc.) marked `export` so the new unit tests can lock them.

### Notes — namespace collision caught in Plan Mode

The naive grep-against-symbol-list emitted `SP500 → SPX` as an alias candidate on all 4 CEXs (`SPXUSDT` / `SPX-USDT-SWAP` exists everywhere). Live spot-price probe revealed the collision: `SPX` on every CEX (and on HL standard perps) is the **SPX6900 memecoin** (price ≈ $0.40), NOT the S&P 500 index (price ≈ $7400 on HL). The `SP500 → SPX` alias was DROPPED from all 4 adapter maps BEFORE code-edit landed. `SP500` reclassified as HL-only in `venue-coverage.ts`. Documented in `audits/TRADFI-SYMBOL-ALIAS-W1-endpoint-truth.md` §3.b. The episode confirms the WIS pattern from v1.11.0: claim-removal and alias-discovery waves need a spot-price (or equivalent semantic-fingerprint) sanity check BEFORE any data table is committed to code.

### No client action needed

This is a tool BEHAVIOR change (more permissive resolution), not a schema change. MCP `tools/list` is unchanged — clients don't need a cache refresh. Existing callers passing `exchange: 'HL'` for TradFi are unaffected. Callers passing `coin: 'GOLD', exchange: 'BINANCE'` previously got `400`; now get a live verdict via XAUUSDT.

---

## [1.11.0] - 2026-05-15 — Default exchange flipped HL → Binance + README v1.11.0 refresh

### Changed (BEHAVIOR — minor bump)

- **Default `exchange` for `get_trade_call` and `get_trade_signal` flipped from `'HL'` (Hyperliquid) → `'BINANCE'` (Binance USDT-M Futures).** Callers omitting the `exchange` argument now receive the Binance verdict by default. Hyperliquid remains fully supported — pass `exchange: 'HL'` to preserve prior behavior, or any of the 5 venues explicitly. Rationale: Binance has higher per-IP rate-limit headroom than Hyperliquid (verified live during the wave's Plan-Mode probe — `GOLD/HL` returned `Hyperliquid API rate-limited (429)`; `TSLA/BINANCE` + `XAU/BINANCE` returned live verdicts in the same session), Binance is the most familiar venue for first-time integrators, and the `algovault-bot` already defaults to BINANCE (BOT-W1 D8 alignment).
- **`get_market_regime` default `exchange` is UNCHANGED** (still `'HL'`). Wave is scoped to call/signal tools per directive.
- **Tool describe-text rewritten** to lead with `BINANCE` as default and drop venue-order bias.
- **Schema-and-handler default coherent** — `src/tools/get-trade-call.ts` fallback `input.exchange || 'HL'` → `input.exchange || 'BINANCE'` (dead-code-equivalent post-Zod-default, flipped for consistency + future-proofing).

### Removed (FACTUALITY — stale claim deletion)

- **Dropped the "TradFi assets (GOLD, TSLA, etc.) are HL-only" claim** from README, tool describe-text, dashboard, asset-tiers description, llms-full.txt, and welcome-page. The claim was verifiably false at two layers:
  - **Exchange landscape (May 2026):** Binance ships TSLAUSDT (2026-01-28 launch), XAUUSDT + XAGUSDT (TradFi Perpetuals via Nest Exchange / FSRA regulated); Bybit launched 20 US stock perps + XAU/XAG/CL + 3 global ETFs (April 2026); Bitget ships 79+ TradFi instruments at launch (forex, metals, oil, indices, stock perps via Ondo); OKX announced ICE partnership for tokenized NYSE stocks targeting H2 2026.
  - **Repo behavior:** `src/scripts/seed-signals.ts:446` uses `SHADOW-SEED-W1` restricted-universe top-N-by-call-count fan-out across all 5 venues; venue-unsupported pairs self-skip via the existing 'Insufficient candle data' error path inside `seedExchange`. Confirmed empirically via 2026-05-15 postgres GROUP BY (signal_performance.signals): TSLA seeded on HL/BINANCE/BYBIT/OKX/BITGET (260 total), XAU on BINANCE/BYBIT/OKX/BITGET (497 total — notably zero on HL), MSTR on 5 venues (193), NVDA on 4 venues (124), SPX on 5 (192), COIN on 5 (104), AAPL on 4 (103). Only GOLD is HL-only (125) — but that's a symbol-naming artifact: Binance uses `XAUUSDT`, not `GOLDUSDT`; XAU coverage on Binance is heavy.
- **Tier-3 asset description rewritten** in `src/lib/asset-tiers.ts:26` and the dashboard `getPerformanceDashboardHtml` Tier-3 row in `src/index.ts:~1800`: `'TradFi perps — stocks, indices, commodities, FX via Hyperliquid'` → `'TradFi perps — stocks, indices, commodities, FX (seeded across Binance, Bybit, Bitget, OKX, and Hyperliquid via demand-driven SHADOW-SEED-W1 fan-out)'`.

### Added

- **NPM-readme-DRAFT.md transplanted to live `README.md`** as canonical README v1.11.0 source (per Mr.1 directive). Includes: hero substrate-frame line "A self-tuning quant ML model with a published track record"; new primary CTA "🤖 Try Free in Telegram"; "Drop-in for every MCP client" matrix (Claude Desktop, Claude Code, Cursor, Cline, Codex, Windsurf, Continue.dev); "What's new in v1.11.0" block with the default-exchange-change announcement; `/how-it-works` page reference. Architecture diagram updated to put Binance first as default in the exchange-adapter-layer.
- **`audits/CHANGE-DEFAULT-EXCHANGE-W1-endpoint-truth.md`** — Plan-Mode Step 0 artifact: identifier-diff table (36 sites), system-map edge-mutation table, TradFi cross-CEX seed-and-score empirical confirmation (per-coin × per-exchange postgres matrix + live MCP `tools/call` probes), test-runner probe, schema baseline.
- **NEW canary test `tests/unit/default-exchange-binance.test.ts`** — locks: TRADE_CALL_SCHEMA Zod default = `'BINANCE'`, describe-text contains `"Binance USDT-M Futures (default)"`, handler fallback uses `'BINANCE'`, `get_market_regime` keeps `'HL'`, no public surface ships the "HL-only TradFi" claim, package.json version = `1.11.0`.

### Cache-refresh notice for MCP clients

**Upgrading?** Refresh tool list — Claude.ai / Claude Desktop: toggle connector off+on; Cursor / Cline: restart MCP server connection. MCP clients cache `tools/list` at session start.

### Source citations (web research, 2026-05-13)

- Binance TSLAUSDT launch — https://www.binance.com/en/support/announcement/detail/40c76b4deaa247f09774e5d1ee747cb8
- Binance XAU/XAG TradFi launch — https://www.binance.com/en/support/announcement/detail/ecf7318c0d434c339e80878588e700d0
- Bybit 24/7 TradFi perpetuals (Chainwire, 2026-05-08) — https://chainwire.org/2026/05/08/bybit-introduces-24-7-tradfi-perpetual-contracts-trading-for-dozens-of-us-stocks-and-global-etfs/
- 2026 crypto-exchanges TradFi roundup (Bitget 79+ instruments + OKX/ICE) — https://forklog.com/en/old-is-new-again-top-5-crypto-exchanges-with-tradfi-trading-in-2026/

---

## [1.10.8] - 2026-05-08 — Telegram bot launch + per-user attribution loop

### Added

- **`/api/bot/validate-key` (server-internal HTTP).** New `GET` endpoint
  at `src/index.ts` returns `{valid, customer_id, tier}` for a Stripe-
  backed API key. Two-flag firewall via the existing internal-bypass env
  (`BOT_INTERNAL_BYPASS_ENABLED` outer + `X-AlgoVault-Internal-Key`
  header matching `ALGOVAULT_INTERNAL_BYPASS_KEY` inner). Consumed
  exclusively by the public Telegram bot
  (`github.com/AlgoVaultLabs/algovault-bot`) over loopback. **NOT
  exposed via the MCP transport** — `tools/list` still returns 3 tools
  (`get_trade_call`, `scan_funding_arb`, `get_market_regime`).
- **`/welcome` page deep-link button.** Post-Stripe-checkout, the
  welcome page now shows a "📱 Connect @algovaultofficialbot" button
  that opens `https://t.me/algovaultofficialbot?start=auth_<api_key>`.
  One click binds the user's Telegram chat to their subscription;
  bot-side tier-aware quota gate honors paid tiers (no 100/mo cap on
  the bot for Starter/Pro/Enterprise).
- **`tier: 'internal'` 4th license tier.** Recognized via the
  `X-AlgoVault-Internal-Key` header (`src/lib/license.ts`). Quota
  counter is bypassed (no tick); `request_log.license_tier` records
  `'internal'` and the new `is_bot_internal` boolean column for
  attribution. 10 vitest cases in `tests/license-internal-bypass.test.ts`.
- **`request_log.is_bot_internal BOOLEAN`** column. Idempotent
  `ALTER TABLE ADD COLUMN IF NOT EXISTS` migration in
  `src/lib/analytics.ts` for both Postgres and SQLite backends; existing
  rows default to false.
- **`src/lib/bot-auth.ts`** (NEW). `checkBotInternalAuth(headers)`
  helper for server-internal `/api/bot/*` endpoints. 8 vitest cases.
- **`src/lib/welcome-page.ts`** (NEW). Extracted `getWelcomePageHtml`
  from `src/index.ts` — pure module, importable in tests without
  triggering `app.listen(port)`. 5 vitest cases for button rendering +
  URL encoding + DOM ordering.

### Changed

- **`monitor.js` consecutive-fail tracking** + 4× exp-backoff on
  exchange health checks. Suppresses transient-blip alert spam
  (1-cycle outages) while keeping persistent-failure escalation
  intact. (Shipped 2026-05-05, included in this release tag.)

### Notes

- Public response shape, MCP tool list, and free-tier behavior
  unchanged from v1.10.6 / v1.10.7.
- Companion bot repo: `github.com/AlgoVaultLabs/algovault-bot` (BOT-W1
  + BOT-W2). Not bundled with this npm package — discovered via the
  `/welcome` button or directly at
  [@algovaultofficialbot](https://t.me/algovaultofficialbot).
- `BOT_INTERNAL_BYPASS_ENABLED` + `ALGOVAULT_INTERNAL_BYPASS_KEY` env
  vars are deployment-side; not required for `npx`-installed stdio
  usage of this package. Server-side defaults to `false` so the new
  endpoints are inert unless explicitly enabled.

## [1.10.7] - 2026-05-06 — README hero refresh + track-record image embed

### Changed

- README hero rebuilt around the live track-record image
  (`docs/screenshots/track-record-2026-05-06.png`, 2468×528 PNG, 90.0% PFE
  Win Rate across 74,733 trade calls, 26 Merkle batches anchored on Base
  L2). New `algovault.com` + `algovault.com/track-record` links surfaced
  prominently. Snapshot KPI line uses `<span data-tr-field="…">` tags so
  `algovault.com` can live-replace; npm renders the snapshot value as-is.
- Snapshot baseline refreshed from prior `89.4%+` / `60,000+` / `v1.10.3`
  to current `90.0%` / `74,733` / `v1.10.7`. All snapshot lines marked
  `<!-- SNAPSHOT-LINE -->` for future refetch.
- Documentation-only release. No API, schema, or tool changes.
  `_algovault.version` envelope bumps to `1.10.7`. Public response shape
  unchanged. Free-tier behavior unchanged.

## [1.10.6] - 2026-05-02 — README link fix (npm view 404s)

### Fixed

- All 28 relative-path links in README.md (Integrations + Skills tables) now
  point to absolute URLs at `https://github.com/AlgoVaultLabs/algovault-skills/blob/main/...`.
  Previous relative paths (`docs/integrations/<exchange>.md`,
  `examples/<exchange>/demo.mjs`, `skills/<slug>/SKILL.md`) resolved to 404s
  on both GitHub (the files live in the `algovault-skills` repo, not this
  one) and on npmjs.com (npm renders relative links against
  `https://www.npmjs.com/package/<pkg>/<rel>`). Display text unchanged —
  the rendered tables look identical; only the click-target URLs are fixed.
- No code or API changes; metadata-only patch release.

## [1.10.5] - 2026-04-30 — Shadow-seed 1m + 3m + grid re-sizing

### Added — Shadow-mode 1m + 3m signal seeding

- New cron entries for 1m (every minute, top-5 by call-count universe) and
  3m (every 3 minutes, top-20 universe) signals. Signals land in the
  `signals` table and accrue PFE/MAE outcomes via the existing backfill
  pipeline. The eval window for both is "12 candles" (12 minutes for 1m,
  36 minutes for 3m), matching the established `≤15m → 12 candles` rule.
- Shadow-mode filter on `/api/performance-public.byTimeframe`: 1m and 3m
  keys are stripped from the response unless the env flag
  `SHADOW_REVEAL_TIMEFRAMES` (comma-list) explicitly reveals them. After
  2 weeks of accumulation, Mr.1 reviews the data via the Sunday Telegram
  digest and flips the env if the timeframe clears the public-track-record
  bar (PFE WR ≥ 85% AND samples ≥ 3,000).
- New `--restricted-universe N` flag on `seed-signals.ts` + a
  `getRestrictedUniverse(N)` resolver that pulls the top-N coins by
  historical call-count from `byAsset` aggregation. Used by 1m + 3m crons
  to bound CPX22 load.
- New `src/scripts/shadow-digest-weekly.ts` runs Sunday 00:00 UTC, queries
  the prior 7 days of 1m/3m signals, posts a Telegram digest with PFE WR,
  sample size, top/bottom performers per coin, and PASS/FAIL/INSUFFICIENT_DATA
  verdict per timeframe.
- New `docs/SHADOW_SEED_DECISION_RUNBOOK.md` documents the public-flip + rollback
  recipes for after 2026-05-14 decision day.

### Changed — Cross-asset grid re-sized

- `GRID_TIMEFRAMES` re-sized from the v1.9.0 logarithmic ladder
  `['5m', '15m', '1h', '4h']` (24-cell grid) to
  `['1m', '3m', '5m', '15m', '30m', '1h', '2h']` (42-cell grid). Drops 4h
  (rank #6 with 2,124 calls) and adds 1m/3m/30m/2h based on empirical call
  distribution from `byAsset.count` rankings.
- New slow-grid circuit breaker: if 3 consecutive grid refreshes each
  exceed 30s, the breaker opens for 1 hour and the grid temporarily
  collapses to the v1.9.0 fallback set. Telegram WARNING on every trip.
- `GRID_CONCURRENCY` unchanged at 6 (peak ~12 simultaneous HL roundtrips,
  76% rate-limit headroom preserved).

### Changed — Track-record dashboard copy hygiene

- Removed three blocks of stale/redundant copy from the public
  `/track-record` page: (1) the "9 of 11 timeframes / sub-5m noise-dominated"
  disambiguation paragraph (it's premature given the empirical test now
  underway and would be wrong copy if 1m/3m pass), (2) the Methodology
  "Note" paragraph about directional entry calls (redundant with the
  PFE Win Rate definition above it), (3) the first two sentences of the
  bottom italic disclaimer (redundant with the removed Methodology Note);
  the financial-advice + past-performance sentences are preserved verbatim
  for legal cover.

### Tests

- `tests/unit/shadow-seed-restricted-universe.test.ts` (NEW, 7 tests) —
  resolver + cache + fallback behavior.
- `tests/unit/grid-circuit-breaker.test.ts` (NEW, 9 tests) — re-sized grid
  shape + circuit breaker open/close.
- `tests/unit/shadow-mode-filter.test.ts` (NEW, 7 tests) — env-driven
  filter behavior across 1m/3m + non-shadow timeframes.
- `tests/unit/shadow-digest-format.test.ts` (NEW, 6 tests) — digest
  formatter + PASS/FAIL/INSUFFICIENT_DATA verdict thresholds.
- `tests/cross-asset-grid.test.ts` updated — 24-cell expectations re-pegged
  to 42-cell new shape.
- `tests/unit/cross-asset-grid-backoff.test.ts` updated — failure-ratio
  thresholds re-scaled to 42-cell baseline.

### Upgrading

No code changes required. The `byTimeframe` aggregation stays at 9 keys
(5m–1d) until Mr.1 flips the public reveal env. Existing MCP clients
calling `get_trade_call` for 1m or 3m have always worked (the API enum
already accepted them); the only change is that those calls will now
warm faster on top-5 / top-20 assets via the new grid.

## [1.10.4] - 2026-04-30 — README polish

### Changed

- README "What's new in v1.10.3" trimmed: dropped the internal-context
  "Track-record disambiguation" bullet that exposed the 9-vs-11-timeframes
  nuance ("sub-5m indicators noise-dominated by design"). That nuance lives
  in `brand-facts.md` and on the track-record dashboard where it makes
  sense in-context; it doesn't belong on the public-facing npm/GitHub
  README.

No code or API changes — README-only patch.

## [1.10.3] - 2026-04-30 — Free-tier unlock + Connect-Your-MCP-Client docs

### Changed — Free-tier expansion

- **Free tier now includes all 716 assets and all 11 timeframes** (1m, 3m, 5m,
  15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d). Was previously gated to BTC + ETH on
  15m + 1h only. The 100-calls/month cap remains unchanged as the primary
  upsell trigger; funding-arb top-5 remains the secondary upsell hook
  (paid tiers get unlimited funding-arb results). HOLD calls are still
  always free at every tier.
- `freeGateMessage()` reduced to a no-op — coin/timeframe gating is removed;
  the quota-exhaustion path (`getQuotaExhaustedMessage`) owns the upgrade-
  prompt surface from now on. The legacy `FREE_COINS` / `FREE_TIMEFRAMES`
  constants are kept commented-out as reserved emergency-rate-limit-defense
  switches.
- Zod schema `describe()` for `get_trade_call`'s `timeframe` parameter
  updated from "Free tier: 15m and 1h only" to "Free tier: all 11 timeframes
  available, 100 calls/month" so MCP clients render the correct tier
  capability in their tool-form UIs.

### Added — Connect Your MCP Client docs section

- New `<section id="connect-mcp">` rendered into `landing/docs.html` between
  `<!-- BUILD:mcp-usage:start -->` / `<!-- BUILD:mcp-usage:end -->` markers.
  Source-of-truth: `src/lib/mcp-usage-docs.ts` mirroring the `signup-flow.ts`
  pattern. Surface / Setup / Result table plus per-client `<details>`
  walkthroughs for: Claude Desktop, Cursor, Cline (VSCode), Claude Code,
  Smithery CLI, plain HTTP / curl. Every config snippet was web-verified
  against upstream docs on 2026-04-30 with citations + fetch date in the
  section's footnote so future drift is auditable.
- `scripts/build_landing.mjs` extended to handle multiple BUILD blocks
  (signup-flow + mcp-usage). Idempotent canary preserved (`files=0` on
  second run); `--check` mode reports drift per-block.

### Fixed — Track-record-vs-API-capability disambiguation

- `brand-facts.md §Asset coverage` corrected: previously listed `11 timeframes`
  as a forbidden phrase ("currently 9"), but the canonical Zod enum at
  `src/index.ts` accepts 11. The 9 visible on the public track-record
  dashboard are the cron-seeded subset (5m–1d); 1m/3m calls work via API
  on-demand but don't accrue rolling-window PFE data.
- Track-record dashboard (`/track-record` page) gains an explainer line
  above the "Performance by Timeframe" table clarifying the 9-of-11
  distinction. `landing/llms-full.txt` pricing table gets a coverage
  disclaimer below it.

### Tests

- `tests/unit/license.test.ts` (NEW, 62 tests) — free tier accepts every
  coin + every timeframe; quota / funding-arb caps unchanged.
- `tests/unit/mcp-usage-docs.test.ts` (NEW, 14 tests) — `MCP_USAGE_HTML`
  structural snapshot.
- `tests/unit/copy-consistency.test.ts` (NEW, 113 tests) — grep-guards
  landing surfaces against legacy free-tier-gating phrases and enforces
  "11 timeframes" in canonical files.
- `tests/get-trade-signal.test.ts` — refreshed: was asserting old "throws
  with /Starter/" gating behavior, now asserts SOL/1h and BTC/4h succeed
  on free tier.

### Upgrading from v1.9.x or earlier?

MCP clients (Claude Desktop, Claude.ai custom connectors, Cursor, Cline)
cache the tool list at session start. The free-tier behavior changed in
v1.10.3 — even though no tool was renamed, **refresh your tool list** so
the client picks up the new permissive responses:

- **Claude.ai / Claude Desktop**: Settings → Connectors → AlgoVault →
  toggle off + on (or click "Refresh tools").
- **Cursor / Cline**: restart the MCP server connection from the
  integration panel.

Cached tool responses from before the unlock may still surface "requires
Starter" upgrade hints on free-tier calls. Refreshing fixes it instantly.
The server is backward-compatible — old code that called `get_trade_signal`
with BTC/ETH on 15m/1h continues to work; it now also accepts every other
coin/timeframe combination.

## [1.9.0] - 2026-04-15 — Activation patch

Addresses the activation bottleneck identified in
`experiments/crypto-quant-signal/analytics-funnel-snapshot-2026-04-15.md`:
70.5:1 install-to-call ratio, 100% agent one-and-done retention under 1h,
88% of `get_trade_signal` responses returning HOLD (free tier, zero billable
pressure).

### Added — Signal surface expansion

- **L2 — HOLD Rescue.** On a HOLD verdict, `get_trade_signal` responses now
  include `closest_tradeable`: the highest-confidence non-HOLD cell (BUY or
  SELL, confidence ≥ 52) from the pre-computed cross-asset grid, excluding
  the requested `(coin, timeframe)`. Omitted when the grid has no non-HOLD
  cell. This is a data surface, not a trade recommendation.
- **L4 — Next-Calls Hints.** Every response (HOLD and non-HOLD) now includes
  `try_next`: the top-3 highest-confidence non-HOLD cells from the same grid,
  excluding the requested `(coin, timeframe)`. Omitted when the grid is
  empty. Exposes what the scorer currently sees across the grid; agents
  decide execution.
- The grid is computed once per 60-second TTL across 6 assets
  (BTC, ETH, SOL, BNB, XRP, DOGE) × 4 timeframes (5m, 15m, 1h, 4h) = 24
  cells, promise-coalesced, lazy-refresh (no cron, no background worker).
  See `src/lib/cross-asset-grid.ts`.

### Added — Retention analytics

- **L3 — Session Cohort Surfacing.** The `mcp-session-id` header extracted at
  the transport layer is now surfaced in every tool response's
  `_algovault.session_id` field (null under stdio transport). Per-session
  cohort metadata is persisted in a new `agent_sessions` table
  (first_seen, last_seen, call_count, tools_used, tiers_seen) so retention
  cohorts are directly queryable without reconstructing from aggregates.
  Unblocks data-gap #2 from the funnel snapshot.

### Changed

- `package.json` version bumped `1.8.1` → `1.9.0`.
- Eliminated hardcoded `version: '1.x.x'` string literals across
  `src/tools/*.ts` and `src/index.ts`. All envelopes and the HTTP `/health`
  endpoint now read the version from a shared `PKG_VERSION` helper at
  `src/lib/pkg-version.ts`.

### Not in this release

- **L1 — Inline `track_record` surfacing** (re-exposing `signal-performance`
  on every `get_trade_signal` response) is gated on Phase E ✅
  (2026-04-17 ~02:30 UTC) and will ship in a follow-up patch.
- Forum-post cron hardening (Hashnode, Moltbook) shipped on a concurrent
  branch (`harden/agent-forum-post-verify`, now merged).

## [1.8.1] - 2026-04-13

### Changed
- Website branded around 5-exchange support (Hyperliquid, Binance, Bybit, OKX, Bitget).
- README rewritten to highlight multi-exchange coverage and adapter architecture.
- `server.json` bumped to v1.8.1 for the MCP Registry listing.

### Fixed
- Dashboard now reports consistent Trade Calls and Evaluated columns across all three tables.
- Exchange tab highlight updates instantly on click.
- Tier cards respond to exchange/tier filters; removed stale "Tier 1-2 + TradFi" tab.
- HL TradFi coverage limited to top 20 by OI.
- `backfill-outcomes` now passes `dex:'xyz'` for HL TradFi symbols.

### CI
- Auto-publish release post on version bump deploy.
- Use `grep` instead of `node` for version detection on the VPS (no node on host).
- Auto-sync landing pages to the Caddy serve path on deploy.

## [1.8.0] - 2026-04-11

### Added
- Exchange tabs on the public dashboard.
- Enriched tier cards with per-exchange breakdowns.

### Changed
- Methodology page updated to reflect the 5-exchange signal pipeline.

### Fixed
- Unicode rendering in public dashboard copy.
- Monitor treats HTTP 429 as alive; backfill alert threshold raised to 50K.
