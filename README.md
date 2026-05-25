<p align="center">
  <a href="https://algovault.com">
    <img src="https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/logo.png" alt="AlgoVault" width="120" />
  </a>
</p>

<h1 align="center">crypto-quant-signal-mcp</h1>

<p align="center">
  <strong>The Brain Layer for AI Trading Agents</strong><br/>
  A self-tuning quant ML model with a published track record.<br/>
  Composite trade calls · cross-venue funding arbitrage · regime-aware market classification<br/>
  Across 5 exchanges (Binance · Hyperliquid · Bybit · OKX · Bitget) via MCP. <!-- SNAPSHOT-LINE -->
</p>

<p align="center">
  <a href="https://t.me/algovaultofficialbot"><strong>🤖 Try Free in Telegram</strong></a> ·
  <a href="https://algovault.com"><strong>algovault.com</strong></a> ·
  <a href="https://algovault.com/track-record"><strong>Live Track Record</strong></a> ·
  <a href="https://algovault.com/how-it-works"><strong>How it works</strong></a> ·
  <a href="https://api.algovault.com/signup"><strong>Sign Up</strong></a> ·
  <a href="https://algovault.com/docs.html"><strong>Docs</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/crypto-quant-signal-mcp"><img src="https://img.shields.io/npm/v/crypto-quant-signal-mcp" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/crypto-quant-signal-mcp"><img src="https://img.shields.io/npm/dw/crypto-quant-signal-mcp" alt="npm downloads" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT" /></a>
  <a href="https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81"><img src="https://img.shields.io/badge/Track_Record-On--Chain_Verified-blue?logo=ethereum" alt="On-Chain Verified" /></a>
  <a href="https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544"><img src="https://img.shields.io/badge/ERC--8004-Verified_Agent-8A2BE2?logo=ethereum" alt="ERC-8004 Verified Agent" /></a>
</p>

---

## 📊 Live Track Record

<p align="center">
  <strong><span data-tr-field="pfe_wr">90.5%</span> PFE Win Rate</strong> · <strong><span data-tr-field="total_calls">96,898</span> trade calls</strong> · <strong><span data-tr-field="merkle_batches">38</span> on-chain batches</strong> · <strong><span data-tr-field="hold_rate">99%</span> HOLD rate</strong> <!-- SNAPSHOT-LINE -->
</p>

<p align="center">
  Every call is hashed at emission and anchored on Base L2 daily. We can't edit history.
</p>

<p align="center">
  <a href="https://algovault.com/track-record"><strong>→ Open the live dashboard</strong></a>
</p>

---

## 🪪 ERC-8004 Verified Agent on Base

AlgoVault MCP is registered as a canonical trading-brain agent on the ERC-8004 Identity Registry (Base L2). The agent identity is on-chain; the track record links from it.

- **Identity Registry**: [`0x8004A169...e539a432`](https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432)
- **AlgoVault agentId**: [`44544`](https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544) (8004-spec ERC-721)
- **Agent metadata (tokenURI)**: pinned to IPFS, mirrored at [`api.algovault.com/api/erc-8004-reputation`](https://api.algovault.com/api/erc-8004-reputation)
- **Trust signals**: Merkle-anchored track record. On-chain attestation pipeline rolling out separately.

> Verify the agent on Basescan: [open agentId](https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544)

---

## Drop-in for every MCP client

AlgoVault MCP serves Streamable HTTP at `https://api.algovault.com/mcp` — MCP-spec compliant, no SDK or wrapper library required. Drop-in for:

| Client | Config |
|---|---|
| **Claude Desktop** | Settings → Integrations → Add custom connector → `https://api.algovault.com/mcp` |
| **Claude Code** (CLI) | `claude mcp add crypto-quant-signal https://api.algovault.com/mcp` |
| **Cursor** | `~/.cursor/config.json` → `mcpServers` block → `url: "https://api.algovault.com/mcp"` |
| **Cline** | VS Code Cline extension → MCP server settings → add Streamable HTTP server |
| **Codex** (OpenAI CLI) | `~/.codex/config.toml` → `[mcp_servers.algovault]` table + `url = "https://api.algovault.com/mcp"` (or `codex mcp` CLI) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` → `mcpServers.algovault.serverUrl = "https://api.algovault.com/mcp"` |
| **Continue.dev** | `config.yaml` → `mcpServers: [{ name: algovault, type: streamable-http, url: "https://api.algovault.com/mcp" }]` |
| Any other MCP-spec-compliant client | Configure the Streamable HTTP transport with URL `https://api.algovault.com/mcp` |

MCP `tools/list` + `resources/list` is the API surface. No `@algovault/sdk`; the protocol is the contract.

Building inside an agent framework? See the **Framework integrations** section below for drop-in tutorials.

---

## Framework integrations

Drop-in tutorials for the major Python agent frameworks. Each tutorial pairs AlgoVault MCP with the framework's canonical MCP-adapter library — copy-pasteable demo code, no AlgoVault SDK required.

| Framework | Tutorial | Runnable demo | Mirror |
|---|---|---|---|
| **LangChain** | [`docs/integrations/langchain.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/langchain.md) | [`examples/langchain/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/langchain/demo.py) | [algovault.com/docs/integrations/langchain](https://algovault.com/docs/integrations/langchain) |
| **LlamaIndex** | [`docs/integrations/llamaindex.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/llamaindex.md) | [`examples/llamaindex/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/llamaindex/demo.py) | [algovault.com/docs/integrations/llamaindex](https://algovault.com/docs/integrations/llamaindex) |
| **Microsoft Agent Framework** | [`docs/integrations/maf.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/maf.md) | [`examples/maf/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/maf/demo.py) | [algovault.com/docs/integrations/maf](https://algovault.com/docs/integrations/maf) |
| **CrewAI** | [`docs/integrations/crewai.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/crewai.md) | [`examples/crewai/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/crewai/demo.py) | [algovault.com/docs/integrations/crewai](https://algovault.com/docs/integrations/crewai) |

Each demo is runnable as `python examples/<framework>/demo.py BTC 4h` — gets a real BUY/SELL/HOLD verdict from `api.algovault.com/mcp`, prints it. ≤5 minutes to first call.

---

## What's new in v1.18.2

Live since 2026-05-25:

- **🔌 Two new platform integration examples.** The `algovault-integrations` mono-repo now ships 5 reference implementations total (was 3 at v1.18.0):
  - **QuantDinger** (reference-architecture doc) — cross-MCP IDE-mediated orchestration. AlgoVault MCP and QuantDinger MCP connect through the user's IDE (Claude Desktop / Cursor / Codex CLI); no transformer code.
  - **Cryptohopper** (TypeScript) — Signaler webhook with HMAC-sha512 signed payloads. First HMAC-authed transport in the integrations repo.
- **🧭 "Connect Your Trading Platform" section** added to [algovault.com/integrations](https://algovault.com/integrations). Discoverable tiles for the 5 platform examples; "Why integrate with AlgoVault?" framing replaces the prior exchange-kit framing.

### v1.18.0 highlights (recap)

- **⏱️ 3-minute timeframe goes LIVE on the public Live Track Record.** The 3m card and Methodology > Evaluation Windows row are now visible at [algovault.com/track-record](https://algovault.com/track-record). The 9th evaluated timeframe is live. (The `3m` key shipped to `/api/performance-public.byTimeframe` in v1.16.0; v1.18.0 completes the dashboard-display chain.)
- **🔌 Platform integration examples.** New public repo at [github.com/AlgoVaultLabs/algovault-integrations](https://github.com/AlgoVaultLabs/algovault-integrations) ships reference implementations of the Verifiable-Signal v1.0 spec (introduced in v1.17.0). Three platforms in v1.18.0:
  - **AI4Trade** (TypeScript) — REST POST with token-in-body auth.
  - **Nautilus Trader** (Python) — Subclass of Nautilus's `Data` abstract base.
  - **3Commas** (TypeScript) — Signal Bot webhook via per-bot curry-pattern factory.

### v1.17.0 highlights (recap)

- **📊 Free-tier quota visibility.** MCP tool responses surface usage progress at 75% and 90% of the monthly quota. At 100% the tool returns a structured error (`TIER_LIMIT_REACHED`) with an upgrade link.
- **💳 Stripe webhook idempotency.** `checkout.session.completed` events processed exactly once; UTM tags round-trip through Stripe metadata.
- **📦 TensorBlock listing.** 5th external discovery channel alongside npm registry, MCP Registry, LobeHub, and Claude Desktop DXT.

### v1.16.0 highlights (recap)

- **⏱️ 3-minute timeframe public.** Added to the public track record. PFE win rate and sample count visible at [algovault.com/track-record](https://algovault.com/track-record).
- **🧩 Integration walkthroughs.** Five new walkthroughs at [algovault.com/integrations](https://algovault.com/integrations) for Claude Desktop, Claude.ai, Cursor, Cline, and Codex CLI.
- **📚 Knowledge tools docs.** New documentation section at [algovault.com/docs](https://algovault.com/docs.html) covering the `search_knowledge` and `chat_knowledge` MCP tools.
- **📰 Bundle expansion.** Knowledge tools now index blog posts, YouTube videos, and GitHub Discussions. Bundle refreshes weekly.

### v1.15.1 highlights (recap)

- **📊 Chat usage analytics.** Admin-gated `/admin/chat-analytics` dashboard with weekly Telegram digest. PII-safe per-call telemetry.
- **🎨 Track-record dashboard polish.** LATEST TRADE CALLS panel now matches surrounding card surfaces.
- **📦 npm catch-up.** v1.15.0 was published to MCP Registry + LobeHub + DXT + GitHub Release but skipped npm; v1.15.1 brought every surface into sync.

### v1.15.0 highlights (recap)

- **🔎 `search_knowledge` MCP tool.** BM25 lexical search over AlgoVault's full knowledge bundle. Free, fast, no LLM call, no quota cost. Also available via `POST /api/search`.
- **💬 `chat_knowledge` MCP tool.** Natural-language Q&A with citations, grounded in the canonical knowledge bundle. Backed by Claude Haiku 4.5 with prompt caching. Also available via `POST /api/chat`.
- **🔁 Zero manual refresh.** Both tools index the auto-generated `dist/knowledge/latest.json` bundle via an in-process `fs.watchFile` poll (30s).

### v1.14.1 highlights (recap)

- **🧠 Auto-generated knowledge bundle JSON.** New public endpoints `https://api.algovault.com/knowledge/latest.json` (+ versioned `/knowledge/v1.14.1.json` + index `/knowledge/index.json`) serve a single source-derived `KnowledgeBundle` (every MCP tool description, response-shape audit snapshot, integration tutorial, package metadata, README "What's new" section) indexed for LLM consumption. Discoverable via MCP resource scheme `algovault://knowledge/latest`. Also attached as a GitHub Release asset on every `npm version`. Cache-Control: 1 hour. Foundation for v1.15.0's `search_knowledge` / `chat_knowledge` agent tools above.
- **🪪 `get_trade_signal` alias description refreshed.** The `[ALIAS]` tag prefix replaces the prior parenthetical suffix. Future tool aliases follow the same shape.

### v1.14.0 highlights (recap)

- **🧩 Framework integrations live.** 4 drop-in tutorials shipped in [algovault-skills](https://github.com/AlgoVaultLabs/algovault-skills): LangChain, LlamaIndex, Microsoft Agent Framework, CrewAI. Each tutorial pairs AlgoVault MCP with the framework's canonical MCP-adapter library. Copy-pasteable demo code; no SDK required. See the [Framework integrations](#framework-integrations) section above.
- **📦 Cross-linked from algovault-skills + signal-MCP READMEs.** Both repos surface the 4 tutorials so framework users discovering AlgoVault from either side find the right entry point.

### v1.13.2 highlights (recap)

- **🔎 Tool descriptions rewritten for retrieval ranking.** `get_trade_call`, `scan_funding_arb`, `get_market_regime` descriptions rewritten for Anthropic Tool Search (BM25 + regex retrieval over `tools/list`). Param `describe()` strings tightened. Zero schema mutation — same enum members, same defaults, same Zod constraints. Pure prose payload change.
- **🪪 ERC-8004 Verified Agent on Base.** AlgoVault MCP is registered on the canonical ERC-8004 Identity Registry at [`0x8004A169...e539a432`](https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432). Each call traces back to a portable, censorship-resistant agent identity on Base L2. agentId [`44544`](https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544) on Basescan. Same on-chain track record; new verified agent handle that AI orchestrators can resolve.
- **🔌 `/api/erc-8004-reputation` endpoint.** Read-only JSON aggregator exposing agentId, identity registry address, registration timestamp, and Basescan link. Cached 5 minutes. `curl -s api.algovault.com/api/erc-8004-reputation | jq`.

> **Upgrading from v1.13.x or earlier?** The MCP tool surface is unchanged structurally — `get_trade_call`, `scan_funding_arb`, `get_market_regime` keep their parameter shapes. v1.14.0 only adds the Framework integrations cross-links; no tool schema change. If you upgraded across v1.13.2 you already picked up the refreshed tool descriptions — MCP clients cache `tools/list` at session start, so toggle the connector off/on if you haven't restarted since v1.13.2.

---

## Why AlgoVault

Most MCP trading servers give you raw data — prices, order books, candles. Your agent still has to figure out what to do with it.

AlgoVault is different. We give your agent **one answer**: a directional verdict with a confidence score, produced by a self-tuning quant ML model whose weights are calibrated from published trade outcomes. Every call is tracked, every outcome is measured, and the full track record is on-chain from day one. The agent itself is registered on ERC-8004.

**What makes this not just another indicator wrapper:**

- **Composite scoring, not single-indicator noise.** Multiple orthogonal signals — momentum oscillators, trend structure, derivatives positioning, volume dynamics, open interest flow — fused into a single weighted verdict. Weights are calibrated from live market outcome data, not textbook defaults.
- **Regime-aware call generation.** Calls are filtered through a market regime classifier before emission. The engine knows when to stay silent — a trend-following setup in a ranging market gets suppressed, not broadcast. (HOLD rate ~99%; we issue calls only when the edge is clear.) <!-- SNAPSHOT-LINE -->
- **Cross-venue intelligence.** Full signal generation on 5 exchanges with native candle, OI, funding, and volume data per venue. 2 DEX venues (Aster, edgeX) in experimental shadow phase. Cross-venue funding arbitrage scanning across the major CEX — nobody else does multi-exchange derivatives analysis via MCP. <!-- SNAPSHOT-LINE -->
- **Published track record with every release.** Every call is recorded with outcome prices at multiple horizons. PFE Win Rate, Profit Factor, Expected Value computed continuously. No cherry-picking, no survivorship bias. **Anchored on-chain on Base L2 — we cannot rewrite history.**
- **ERC-8004 verified agent.** AlgoVault MCP holds a registered agentId on the Base L2 Identity Registry. The agent identity is portable and on-chain.
- **Drop-in for every major agent framework.** First-party tutorials + runnable demos for LangChain, LlamaIndex, Microsoft Agent Framework, CrewAI. ≤5 minutes to first call. See the [Framework integrations](#framework-integrations) section.
- **Self-tuning model.** Indicator weights are tuned from live outcome data by our [Autonomous Optimization Engine](https://algovault.com/how-it-works). The model gets sharper with every signal.
- **Crypto + TradFi coverage.** 740+ assets — standard crypto perps on all 5 CEX; TradFi perps (stocks, indices, commodities, FX); liquidity-filtered meme coins. <!-- SNAPSHOT-LINE -->

---

## Try It in 30 Seconds

No code. No API key. No install.

**Step 1.** Open Claude → Settings → Integrations → Add custom connector

**Step 2.** Enter the name and URL:

| Field | Value |
|-------|-------|
| Name | `Crypto Quant Signal` |
| URL | `https://api.algovault.com/mcp` |

![Add Connector](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/Add-Connector.png)

**Step 3.** Ask Claude anything:

> "Get me a trade call for ETH on the 4h timeframe"

> "Get me a trade call for BTC on Binance, 1h timeframe"

![BTC trade call response — Binance, 1h](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/BTC-trade-call.png)

That's it. Your Claude now has a quant analyst built in.

---

## Tools

### `get_trade_call` <sub>(alias: `get_trade_signal`)</sub>

Returns a composite **BUY / SELL / HOLD** verdict with confidence score for any supported asset on any of 5 supported exchanges — crypto perps, TradFi perps (stocks, indices, commodities, FX) on Binance / Bybit / Bitget / OKX / Hyperliquid, and liquidity-filtered meme coins.

Under the hood: a self-tuning quant ML model evaluates momentum, trend structure, derivatives sentiment, open interest dynamics, and volume conviction. Scores pass through regime-aware filters and adaptive post-processing gates before a final verdict is emitted. Only high-conviction calls are generated; the model stays silent when the edge is unclear.

**Parameters:**
- `coin` (string, required): Asset symbol — e.g. `"ETH"`, `"BTC"`, `"SOL"`, `"GOLD"`, `"TSLA"`, or any of 730+ supported assets <!-- SNAPSHOT-LINE -->
- `timeframe` (string, default `"15m"`): all 11 timeframes — `"1m"`, `"3m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"2h"`, `"4h"`, `"8h"`, `"12h"`, `"1d"`
- `exchange` (string, default `"BINANCE"`): `"BINANCE"`, `"HL"` (Hyperliquid), `"BYBIT"`, `"OKX"`, `"BITGET"`. Asset availability varies per venue — pass exchange explicitly to target a specific venue. (DEX venues Aster + edgeX are in experimental shadow phase and not exposed via this parameter yet.)
- `includeReasoning` (boolean, default `true`): Human-readable explanation of the call logic

**Output:** v1.10.0 sanitized shape — `call` direction, `confidence` (0–100), bucketed `indicators` (`funding_rate` / `funding_24h_avg` / `funding_state` / `oi_change_pct` / `volume_24h` / `trend_persistence` / `breakout_pending`), detected `regime`, sanitized `reasoning` prose, and `_algovault` metadata for downstream tool composability.

Responses also include optional `closest_tradeable` (on HOLD verdicts) and `also_see` (top-3 cross-asset leads), trimmed to `{coin, timeframe, confidence}` only — direction requires another `get_trade_call` invocation.

**Example response:**

```json
{
  "call": "BUY",
  "confidence": 78,
  "price": 84250.50,
  "indicators": {
    "funding_rate": 0.0001,
    "funding_24h_avg": 0.00008,
    "funding_state": "NORMAL",
    "oi_change_pct": 2.4,
    "volume_24h": 2381602633,
    "trend_persistence": "HIGH",
    "breakout_pending": "INACTIVE"
  },
  "regime": "TRENDING_UP",
  "reasoning": "Trending regime, upward bias. Funding pressure mild. Volatility neither expanding nor compressed. Trend persistence elevated; momentum structure. Strong conviction from aligned signals.",
  "timestamp": 1712764800,
  "coin": "BTC",
  "timeframe": "1h",
  "also_see": [
    { "coin": "ETH", "timeframe": "1h", "confidence": 82 },
    { "coin": "SOL", "timeframe": "15m", "confidence": 73 }
  ],
  "_algovault": {
    "version": "1.14.0",
    "tool": "get_trade_call",
    "compatible_with": ["crypto-quant-risk-mcp", "crypto-quant-backtest-mcp"]
  }
}
```

### `scan_funding_arb`

Scans cross-venue funding rate differentials across Hyperliquid, Binance, and Bybit. Normalizes hourly vs 8-hour rate conventions, computes basis-point spreads, ranks opportunities by composite score (spread magnitude, time urgency, funding conviction from 24h history). OKX and Bitget funding data is available via their respective adapters — arb scanning expansion is planned.

This is the only MCP server providing cross-venue funding arbitrage intelligence — long one exchange, short another, capture the spread.

**Parameters:**
- `minSpreadBps` (number, default `5`): Minimum spread in basis points to include
- `limit` (number, default `10`): Maximum results returned (free tier capped at 5)

**Output includes:** per-opportunity venue rates, optimal long/short direction, annualized spread percentage, and next funding timestamps.

### `get_market_regime`

Classifies the current market environment: **TRENDING_UP**, **TRENDING_DOWN**, **RANGING**, or **VOLATILE**.

Combines directional strength measurement with ADX slope analysis (detecting trend strengthening vs exhaustion), volume-weighted pivot detection, ATR-adaptive funding thresholds, and cross-venue funding sentiment divergence. The regime classification directly informs how `get_trade_call` filters its output — agents can also use it independently for strategy selection and position sizing.

**Parameters:**
- `coin` (string, required): Asset symbol
- `timeframe` (string, default `"4h"`): Candle timeframe for analysis
- `exchange` (string, default `"BINANCE"`): Exchange to analyze — same options as `get_trade_call`

**Output includes:** regime label, confidence score, underlying metrics (trend strength, volatility interpretation, price structure), cross-venue funding sentiment, and a plain-English strategy suggestion.

---

## When You Hit the Free Limit

Free tier is 100 calls per calendar month. **HOLD calls don't count against it** — you only consume quota on BUY/SELL verdicts.

When the cap is reached, the next call's response includes:

```
Free tier limit reached (100/100 calls this month).
Upgrade to Starter ($9.99/mo) for 3,000 calls/mo,
or pay per call via x402.
→ https://api.algovault.com/signup?plan=starter
```

**Two zero-friction upgrade paths:**

| Path | When to use | Friction |
|------|-------------|----------|
| **Starter $9.99/mo** | Your agent runs on a known schedule (cron, hourly digests, daily scans). | Stripe checkout · API key delivered instantly · [signup →](https://api.algovault.com/signup?plan=starter) |
| **x402 micropayment** | Your agent is autonomous and pays per call in USDC on Base. No signup. | Wallet · ~$0.01–0.05 per BUY/SELL · zero account state · [x402.org](https://x402.org) |

---

## Pricing

| Feature | Free | Starter ($9.99/mo) | Pro ($49/mo) | Enterprise ($299/mo) | x402 (per call) |
|---------|------|-------------------|-------------|---------------------|-----------------|
| Exchanges | All 5 | All 5 | All 5 | All 5 | All 5 | <!-- SNAPSHOT-LINE-TABLE -->
| Assets | All 740+ | All 740+ | All 740+ | All 740+ | All 740+ | <!-- SNAPSHOT-LINE-TABLE -->
| Asset classes | Crypto + TradFi | Crypto + TradFi | Crypto + TradFi | Crypto + TradFi | Crypto + TradFi |
| Timeframes | All 11 | All 11 | All 11 | All 11 | All 11 |
| Funding arb results | Top 5 | Unlimited | Unlimited | Unlimited | Unlimited |
| Track record | Full access | Full access | Full access | Full access | Full access |
| Monthly calls | 100/mo | 3,000/mo | 15,000/mo | 100,000/mo | Unlimited |
| Support | Community | Email | Priority | Dedicated | — |
| Price | $0 | $9.99/mo | $49/mo | $299/mo | $0.01–0.05/call |
| HOLD calls | Free | Free | Free | Free | Free |

\* HOLD verdicts (engine says "don't trade") are always free across all tiers — no x402 charge, no quota deduction. We only get paid when we see a tradeable opportunity.

**Subscriptions:** Sign up at [api.algovault.com/signup](https://api.algovault.com/signup). Starter ($9.99/mo) unlocks 3,000 calls/mo. API key delivered instantly after checkout.

**x402 micropayments:** AI agents pay per HTTP call with USDC on Base — no signup, no API key, no billing. The payment receipt is the credential. See [x402.org](https://x402.org).

---

## Integrations

End-to-end tutorials pairing AlgoVault with each major exchange's Agent Trade Kit. AlgoVault returns the analytics; the agent's risk policy decides what to execute. **All demos run testnet/demo only — zero real-money risk.**

<!-- BUILD:README_INTEGRATIONS_TABLE -->
| # | Exchange | Tutorial | Demo | Mirror |
|---|---|---|---|---|
| 01 | Binance | [`docs/integrations/binance.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/binance.md) | [`examples/binance/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/binance/demo.mjs) | [algovault.com/docs/integrations/binance](https://algovault.com/docs/integrations/binance) |
| 02 | OKX | [`docs/integrations/okx.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/okx.md) | [`examples/okx/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/okx/demo.mjs) | [algovault.com/docs/integrations/okx](https://algovault.com/docs/integrations/okx) |
| 03 | Bybit | [`docs/integrations/bybit.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/bybit.md) | [`examples/bybit/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/bybit/demo.mjs) | [algovault.com/docs/integrations/bybit](https://algovault.com/docs/integrations/bybit) |
| 04 | Bitget | [`docs/integrations/bitget.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/bitget.md) | [`examples/bitget/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/bitget/demo.mjs) | [algovault.com/docs/integrations/bitget](https://algovault.com/docs/integrations/bitget) |
<!-- /BUILD:README_INTEGRATIONS_TABLE -->

---

## Skills (20 ready-to-use Anthropic Agent Skills)

20 single-prompt wrappers over 1–3 AlgoVault tool calls — composite verdicts, regime gating, multi-timeframe consensus, funding-arb monitoring, and more.

```bash
claude plugin install AlgoVaultLabs/algovault-skills
```

Browse the full catalog at [algovault.com/skills](https://algovault.com/skills) or [github.com/AlgoVaultLabs/algovault-skills](https://github.com/AlgoVaultLabs/algovault-skills).

<details>
<summary><strong>Show all 20 Skills</strong></summary>

<!-- BUILD:README_SKILLS_TABLE -->
| # | Slug | Name | Difficulty | Tools |
|---|---|---|---|---|
| 01 | [`quick-btc-check`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/quick-btc-check/SKILL.md) | Quick BTC Check | Beginner | `get_trade_call` |
| 02 | [`portfolio-scanner`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/portfolio-scanner/SKILL.md) | Portfolio Scanner | Intermediate | `get_trade_call` |
| 03 | [`regime-aware-trading`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/regime-aware-trading/SKILL.md) | Regime-Aware Trading | Intermediate | `get_market_regime`, `get_trade_call` |
| 04 | [`funding-arb-monitor`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/funding-arb-monitor/SKILL.md) | Funding Arb Monitor | Intermediate | `scan_funding_arb` |
| 05 | [`full-3-tool-pipeline`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/full-3-tool-pipeline/SKILL.md) | Full 3-Tool Pipeline | Advanced | `get_market_regime`, `get_trade_call`, `scan_funding_arb` |
| 06 | [`multi-timeframe-confirmation`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/multi-timeframe-confirmation/SKILL.md) | Multi-Timeframe Confirmation | Advanced | `get_trade_call` |
| 07 | [`tradfi-rotation`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/tradfi-rotation/SKILL.md) | TradFi Rotation | Advanced | `get_market_regime`, `get_trade_call` |
| 08 | [`risk-gated-entry`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/risk-gated-entry/SKILL.md) | Risk-Gated Entry | Advanced | `get_market_regime`, `get_trade_call` |
| 09 | [`funding-sentiment-dashboard`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/funding-sentiment-dashboard/SKILL.md) | Funding Sentiment Dashboard | Advanced | `get_market_regime` |
| 10 | [`contrarian-meme-scanner`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/contrarian-meme-scanner/SKILL.md) | Contrarian Meme Scanner | Advanced | `get_market_regime`, `get_trade_call` |
| 11 | [`divergence-detector`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/divergence-detector/SKILL.md) | Divergence Detector | Advanced | `get_market_regime`, `get_trade_call` |
| 12 | [`hourly-digest-bot`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/hourly-digest-bot/SKILL.md) | Hourly Digest Bot | Advanced | `get_trade_call`, `get_market_regime` |
| 13 | [`hedging-advisor`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/hedging-advisor/SKILL.md) | Hedging Advisor | Advanced | `get_market_regime`, `get_trade_call`, `scan_funding_arb` |
| 14 | [`volatility-breakout-watch`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/volatility-breakout-watch/SKILL.md) | Volatility Breakout Watch | Advanced | `get_market_regime`, `get_trade_call` |
| 15 | [`cross-asset-correlation`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/cross-asset-correlation/SKILL.md) | Cross-Asset Correlation | Advanced | `get_trade_call` |
| 16 | [`funding-cash-and-carry`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/funding-cash-and-carry/SKILL.md) | Funding Cash-and-Carry | Advanced | `scan_funding_arb`, `get_trade_call` |
| 17 | [`weekend-vs-weekday-patterns`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/weekend-vs-weekday-patterns/SKILL.md) | Weekend vs Weekday Patterns | Research | `get_trade_call`, `get_market_regime` |
| 18 | [`agent-portfolio-rebalance`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/agent-portfolio-rebalance/SKILL.md) | Agent Portfolio Rebalance | Advanced | `get_market_regime` |
| 19 | [`smart-dca-bot`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/smart-dca-bot/SKILL.md) | Smart DCA Bot | Advanced | `get_trade_call` |
| 20 | [`multi-agent-war-room`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/skills/multi-agent-war-room/SKILL.md) | Multi-Agent War Room | Expert | `get_market_regime`, `get_trade_call`, `scan_funding_arb` |
<!-- /BUILD:README_SKILLS_TABLE -->

</details>

---

## Performance Tracking & On-Chain Verification

Every call is tracked from emission to outcome. No exceptions.

**What we measure:**
- Outcome prices at timeframe-appropriate evaluation windows
- PFE Win Rate — did price move in the call direction at any point during the evaluation window
- Expected Value — probability-weighted average return per call
- Profit Factor — gross wins divided by gross losses
- Peak Favorable Excursion (PFE) and Maximum Adverse Excursion (MAE)
- Running statistics per asset, timeframe, and quality tier

**HOLD calls are free.** When the engine says "don't trade," you don't pay. Only BUY/SELL verdicts charge x402 or count against subscription quotas. Aligns incentives: we only get paid when we see a tradeable opportunity. Current HOLD rate ~99%. <!-- SNAPSHOT-LINE -->

### On-Chain Verification

Every call is hashed (keccak256) at creation time and anchored on Base L2 via daily Merkle batches. The agent identity is registered on the ERC-8004 Identity Registry. The track record is tamper-proof — we cannot edit past calls.

- **Merkle Anchor Contract**: [`0x6485...0f81`](https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81) (Base L2)
- **ERC-8004 Identity Registry**: [`0x8004...a432`](https://basescan.org/address/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) — AlgoVault agentId [`44544`](https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544)
- **Verify any call**: [`api.algovault.com/api/verify-signal?signalId=<ID>`](https://api.algovault.com/api/verify-signal)
- **View all batches**: [`api.algovault.com/api/merkle-batches`](https://api.algovault.com/api/merkle-batches)
- **Agent metadata**: [`api.algovault.com/api/erc-8004-reputation`](https://api.algovault.com/api/erc-8004-reputation)
- **Visual verification**: [algovault.com/verify](https://algovault.com/verify)
- **Live dashboard**: [algovault.com/track-record](https://algovault.com/track-record)

---

## For Developers

### Remote endpoint (recommended)

```
https://api.algovault.com/mcp
```

Streamable HTTP transport. Compatible with any MCP-spec client — Claude Desktop, Claude Code, Cursor, Cline, custom agents. No SDK or wrapper library required; MCP is the API.

### Local install via npx

```bash
npx -y crypto-quant-signal-mcp
```

### Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "crypto-quant-signal": {
      "command": "npx",
      "args": ["-y", "crypto-quant-signal-mcp"],
      "env": { "TRANSPORT": "stdio" }
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add crypto-quant-signal https://api.algovault.com/mcp
```

### npm install

```bash
npm install crypto-quant-signal-mcp
```

### Self-hosting

```bash
git clone https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp
cd crypto-quant-signal-mcp
cp .env.example .env  # Edit with your values
npm ci && npm run build
docker compose up -d
```

---

## Architecture

```
Agent / Claude Desktop / Claude Code / Cursor / Cline / any MCP client
  │
  ▼
api.algovault.com/mcp (Streamable HTTP)
  │
  ├─ x402 payment verification (USDC on Base)
  ├─ API key / subscription check
  ├─ Free tier fallback (100 calls/mo, all assets, all timeframes)
  │
  ▼
MCP Server (Express + @modelcontextprotocol/sdk)
  │
  ├─ Self-Tuning Quant ML Model
  │    ├─ Multi-factor indicator fusion
  │    ├─ Regime-aware signal filtering
  │    └─ Adaptive post-processing gates
  │
  ├─ Autonomous Optimization Engine (results published; mechanics confidential)
  │    └─ Closed-loop weight tuning from published outcomes
  │
  ├─ Asset Classification Engine
  │    ├─ 4-tier quality system (Blue Chip → Major Alt → TradFi → Meme)
  │    └─ Liquidity filter for meme/micro assets
  │
  ├─ Exchange Adapter Layer
  │    ├─ Binance USDT-M Futures (default)
  │    ├─ Hyperliquid (crypto + TradFi perps)
  │    ├─ Bybit Linear
  │    ├─ OKX Swap
  │    ├─ Bitget USDT-M
  │    ├─ Aster (DEX — experimental, shadow signal production)
  │    └─ edgeX (DEX — experimental, shadow signal production)
  │
  ├─ Performance Tracker
  │    └─ PostgreSQL (remote) / SQLite (local)
  │
  ├─ On-Chain Layer
  │    ├─ Merkle Anchor (daily) — Base L2 0x6485...0f81
  │    └─ ERC-8004 Identity Registry — Base L2 0x8004...a432
  │
  └─ Exchange Public APIs (free, no auth — all 5 CEX + 2 experimental DEX)
```

---

## Suite Composability

Every tool output includes an `_algovault` metadata block declaring version and compatible downstream tools:

| This tool | Feeds into (Phase 2+) |
|-----------|----------------------|
| `get_trade_call` | `crypto-quant-risk-mcp` (position sizing) · `crypto-quant-backtest-mcp` (validation) |
| `scan_funding_arb` | `crypto-quant-execution-mcp` (optimal entry/exit) · `crypto-quant-risk-mcp` (exposure) |
| `get_market_regime` | `crypto-quant-risk-mcp` (regime-aware sizing) · `crypto-quant-backtest-mcp` (filtered backtests) |

Schemas are designed for composability. All tools share consistent `timestamp`, `coin`, and `_algovault` fields — downstream tools accept these objects directly as input.

---

## Privacy

**Local mode:** Zero telemetry. No data sent to AlgoVault servers. Call history stored on your machine only.

**Remote mode:** Request metadata logged for analytics (IP hashed, never stored raw). See [privacy policy](https://api.algovault.com/privacy).

---

## License

MIT

---

> **Disclaimer:** AlgoVault provides directional entry interpretation for AI agents. Exit timing is determined by your agent or strategy. This is not financial advice. Past performance does not guarantee future results.

<p align="center">
  Built by <a href="https://algovault.com"><strong>AlgoVault Labs</strong></a><br/>
  <a href="https://algovault.com">algovault.com</a> ·
  <a href="https://algovault.com/how-it-works">how it works</a> ·
  <a href="https://algovault.com/track-record">track-record</a> ·
  <a href="https://api.algovault.com/mcp">MCP endpoint</a> ·
  <a href="https://t.me/algovaultofficialbot">Telegram bot</a>
</p>
