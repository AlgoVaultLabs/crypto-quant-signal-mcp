<p align="center">
  <a href="https://algovault.com">
    <img src="https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/logo.png" alt="AlgoVault" width="120" />
  </a>
</p>

<h1 align="center">crypto-quant-signal-mcp</h1>

<p align="center">
  <strong>AlgoVault is the brain layer for AI trading agents — one MCP call returns verdict, confidence, and regime across major crypto perpetual venues.</strong>
</p>

<p align="center">
  <span data-tr-field="pfe_wr">91.3</span>% PFE win rate across <span data-tr-field="total_calls">134,276</span>+ verified calls. Merkle-verified on Base L2. Don't trust — verify. <!-- SNAPSHOT-LINE -->
</p>

<p align="center">
  <strong>100 free calls/month. HOLDs never cost. Start in 30 seconds.</strong>
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
  <a href="https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp"><img src="https://img.shields.io/github/stars/AlgoVaultLabs/crypto-quant-signal-mcp?style=social" alt="GitHub Repo stars" /></a>
  <a href="https://smithery.ai/server/@algovault/crypto-quant-signal-mcp"><img src="https://smithery.ai/badge/algovault/crypto-quant-signal-mcp" alt="Smithery" /></a>
</p>

---

## Quick start (30 seconds)

No code. No API key. No install. The server speaks Streamable HTTP at `https://api.algovault.com/mcp` — any [Model Context Protocol](https://github.com/modelcontextprotocol) client connects directly.

**1. Add the connector.** In Claude → Settings → Integrations → Add custom connector:

| Field | Value |
|---|---|
| Name | `Crypto Quant Signal` |
| URL | `https://api.algovault.com/mcp` |

![Add Connector](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/Add-Connector.png)

**2. Ask for a call.** In plain language:

> "Get me a trade call for ETH on the 4h timeframe"

![BTC trade call response — Binance, 1h](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/BTC-trade-call.png)

Your Claude now has a quant analyst built in. Prefer local? Run `npx -y crypto-quant-signal-mcp`.

---

## What one call returns

One API call. One verdict. Not 8 raw indicators. `get_trade_call` returns a directional **BUY / SELL / HOLD** with a confidence score and the detected market regime — a composite verdict, not a data dump for your agent to interpret.

Under the hood, a self-tuning model fuses momentum, trend structure, derivatives positioning, open interest, and volume into one weighted call. Weights are calibrated from live trade outcomes, not textbook defaults. Regime filters suppress low-edge setups, so the engine stays silent unless the signal is clear.

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
    "version": "1.23.0",
    "tool": "get_trade_call",
    "compatible_with": ["crypto-quant-risk-mcp", "crypto-quant-backtest-mcp"]
  }
}
```

The `_algovault` block makes outputs composable: downstream risk and backtest tools accept the object directly.

---

## Live, verifiable track record

<!-- SoT: this README is the single canonical source. The data-tr-field numbers below are
     auto-injected from live /api/performance-public + /api/merkle-batches by
     scripts/snapshot-landing-data.mjs at npm-publish + Hetzner-deploy. Do NOT hand-edit the
     numbers; edit "What's new" by hand. Wired by OPS-NPM-README-SINGLE-SOT-W1 (2026-05-31). -->
<p align="center">
  <strong><span data-tr-field="pfe_wr">91.3</span>% PFE Win Rate</strong> · <strong><span data-tr-field="total_calls">134,276</span> trade calls</strong> · <strong><span data-tr-field="merkle_batches">50</span> on-chain batches</strong> · <strong><span data-tr-field="hold_rate">98.9</span>% HOLD rate</strong> <!-- SNAPSHOT-LINE -->
</p>

<p align="center">
  Every call is hashed at emission and anchored on <a href="https://docs.base.org">Base L2</a> in daily Merkle batches. We cannot edit history.
</p>

The full record is public and on-chain — no cherry-picking, no survivorship bias:

- **Live dashboard** — [algovault.com/track-record](https://algovault.com/track-record)
- **Merkle batch verifier** — [algovault.com/verify](https://algovault.com/verify)
- **Anchor contract on Base L2** — [`0x6485…0f81`](https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81)
- **All batches (raw JSON)** — [api.algovault.com/api/merkle-batches](https://api.algovault.com/api/merkle-batches)

AlgoVault is also a verified agent on the ERC-8004 Identity Registry (Base L2), agentId [`44544`](https://basescan.org/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432?a=44544) — a portable, on-chain handle AI orchestrators can resolve.

---

## Works with your stack

AlgoVault is drop-in for every MCP-spec client, every major agent framework, and every official exchange Agent Trade Kit — no SDK, no wrapper. It serves Streamable HTTP at `https://api.algovault.com/mcp`; `tools/list` + `resources/list` is the API surface.

**MCP clients.**

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

**Agent frameworks.** First-party tutorials pair AlgoVault with each framework's canonical MCP adapter — copy-pasteable demo code, no SDK.

| Framework | Tutorial | Runnable demo | Mirror |
|---|---|---|---|
| **LangChain** | [`docs/integrations/langchain.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/langchain.md) | [`examples/langchain/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/langchain/demo.py) | [algovault.com/integrations/langchain](https://algovault.com/integrations/langchain) |
| **LlamaIndex** | [`docs/integrations/llamaindex.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/llamaindex.md) | [`examples/llamaindex/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/llamaindex/demo.py) | [algovault.com/integrations/llamaindex](https://algovault.com/integrations/llamaindex) |
| **Microsoft Agent Framework** | [`docs/integrations/maf.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/maf.md) | [`examples/maf/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/maf/demo.py) | [algovault.com/integrations/maf](https://algovault.com/integrations/maf) |
| **CrewAI** | [`docs/integrations/crewai.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/crewai.md) | [`examples/crewai/demo.py`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/crewai/demo.py) | [algovault.com/integrations/crewai](https://algovault.com/integrations/crewai) |

Each demo is runnable as `python examples/<framework>/demo.py BTC 4h` — gets a real BUY/SELL/HOLD verdict from `api.algovault.com/mcp`, prints it. ≤5 minutes to first call.

**Exchange Agent Trade Kits.** AlgoVault returns the analytics; your agent's risk policy decides what to execute. All demos run testnet/demo only.

<!-- BUILD:README_INTEGRATIONS_TABLE -->
| # | Exchange | Tutorial | Demo | Mirror |
|---|---|---|---|---|
| 01 | Binance | [`docs/integrations/binance.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/binance.md) | [`examples/binance/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/binance/demo.mjs) | [algovault.com/integrations/binance](https://algovault.com/integrations/binance) |
| 02 | OKX | [`docs/integrations/okx.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/okx.md) | [`examples/okx/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/okx/demo.mjs) | [algovault.com/integrations/okx](https://algovault.com/integrations/okx) |
| 03 | Bybit | [`docs/integrations/bybit.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/bybit.md) | [`examples/bybit/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/bybit/demo.mjs) | [algovault.com/integrations/bybit](https://algovault.com/integrations/bybit) |
| 04 | Bitget | [`docs/integrations/bitget.md`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/bitget.md) | [`examples/bitget/demo.mjs`](https://github.com/AlgoVaultLabs/algovault-skills/blob/main/examples/bitget/demo.mjs) | [algovault.com/integrations/bitget](https://algovault.com/integrations/bitget) |
<!-- /BUILD:README_INTEGRATIONS_TABLE -->

---

## Tools & resources

The MCP tools live at `https://api.algovault.com/mcp`. Every asset works across the full supported timeframe range, on major crypto perpetual venues.

- **`get_trade_call`** <sub>(alias `get_trade_signal`)</sub> — composite BUY/SELL/HOLD verdict with confidence + regime, any asset, any timeframe.
- **`scan_trade_calls`** — scans the top-N perps by open interest on a venue; returns every actionable call in one shot.
- **`scan_funding_arb`** — cross-venue funding-rate spreads across 7 venues (Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster, OKX), ranked. The only MCP server doing multi-exchange derivatives arbitrage.
- **`get_market_regime`** — classifies TRENDING_UP / TRENDING_DOWN / RANGING / VOLATILE for strategy selection.
- **`search_knowledge`** + **`chat_knowledge`** — free BM25 search and grounded Q&A over the full knowledge bundle.

Performance is exposed as a read-only MCP resource: `performance://signal-performance` (aggregated PFE win rate, never raw outcomes). Full parameter reference at [algovault.com/docs](https://algovault.com/docs.html).

### Skills (20 ready-to-use Anthropic Agent Skills)

Single-prompt wrappers over 1–3 tool calls — regime gating, multi-timeframe consensus, funding-arb monitoring, and more. Install with `claude plugin install AlgoVaultLabs/algovault-skills`; browse at [algovault.com/skills](https://algovault.com/skills).

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

## Pricing

Quota-only tiers. Every tier gets all venues, all assets, all timeframes — you pay for call volume, nothing else. HOLD verdicts are always free.

| Feature | Free | Starter ($9.99/mo) | Pro ($49/mo) | Enterprise ($299/mo) | x402 (per call) |
|---------|------|-------------------|-------------|---------------------|-----------------|
| Exchanges | All 12 | All 12 | All 12 | All 12 | All 12 | <!-- SNAPSHOT-LINE-TABLE -->
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

**x402 micropayments:** AI agents pay per HTTP call with USDC on [Base](https://www.base.org) — no signup, no API key, no billing. The payment receipt is the credential. See [x402.org](https://x402.org).

---

## What's new in v1.23.1

- **🔗 A dedicated page for every way to connect.** New hub pages walk through each access channel end-to-end, with copy-paste code and a quick FAQ: [MCP](https://algovault.com/mcp), [REST API](https://algovault.com/rest-api), and [webhooks](https://algovault.com/webhooks).
- **🧭 Tools index + unified navigation.** Browse all public tools at [algovault.com/tools](https://algovault.com/tools); a new Platform menu makes the whole site easier to navigate.

### v1.23.0 highlights (recap)

- **📡 Cross-venue funding arbitrage now spans 7 venues.** `scan_funding_arb` expanded from 3 to 7 — Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster, and OKX — with interval-correct annualization per venue and a per-leg liquidity filter, so only tradeable spreads surface.

> MCP clients cache `tools/list` at session start — toggle the connector off/on (or restart the MCP connection) to pick up the updated `scan_funding_arb`.

### v1.22.0 highlights (recap)

- **🌐 <span data-tr-field="exchange_count">12</span> exchanges live.** **ASTER, BingX, Gate, HTX, KuCoin, MEXC, and Phemex** join Hyperliquid, Binance, Bybit, OKX, and Bitget on the verified, Merkle-anchored public track record — composite trade calls, market-regime detection, and the per-venue PFE leaderboard now span every promoted venue.
- **🏆 12-venue leaderboard.** The live [track-record leaderboard](https://algovault.com/track-record) now ranks per-venue PFE win rate across all 12 — filter to any newly-added venue.
- **🔁 Forward-stable coverage.** The venue count reads live everywhere it appears, so coverage stays accurate as we keep adding venues.

> **Refresh your MCP client to pick up this release.** MCP clients cache `tools/list` at session start — Claude.ai/Desktop: toggle the connector off+on; Cursor/Cline: restart the MCP server connection.

### v1.21.0 highlights (recap)

- **📊 `scan_trade_calls` ranking lenses (`rankBy`)** — rank the scan universe 9 ways (funding, gainers/losers, volume, open interest, volatility, 24h OI change) + aliases.
- **🧾 Verdict receipts (`_receipts`)** — inline conviction, top factors, live track record, and a verify link on every verdict.
- **🔌 Gemini, Kraken & Alpaca pairings** · **🏆 live track-record leaderboard** · **🎁 referral program** · **💸 pay-per-call** on the trade-call & scanner routes.
- **🔒 Security hardening** — x402 per-route price binding + replay protection; webhook egress-IP pinning + timestamped HMAC signatures. *Breaking for webhook subscribers* — update per [docs/WEBHOOKS.md](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/WEBHOOKS.md).

### v1.20.0 highlights (recap)

- **📡 `scan_trade_calls` — market-wide scanner.** One call scans the top-N perps (1–100, ranked by open interest) on your chosen venue and returns every actionable BUY/SELL with confidence and regime. HOLDs stay free — quota counts only actionable calls.
- **🔔 Webhooks: dynamic `top:N` watchlists.** Subscribe with `assets: ["top:25"]` and your webhook follows the venue's top perps automatically. No manual list upkeep.
- **🏛️ TradFi-aware analysis.** Both core tools now report the underlying market session (`underlying_session`, with weekend/holiday caveats), interpret fixed pre-IPO funding correctly, and aggregate cross-venue funding sentiment for stocks, indices, commodities, and FX across all 5 venues.
- **🧭 Smarter errors on young listings.** Insufficient history returns a structured `INSUFFICIENT_CANDLES` error with `suggested_timeframes` instead of a plain string.

> MCP clients cache `tools/list` at session start — toggle the connector off/on (or restart the MCP connection) to see `scan_trade_calls`.

---

## Privacy

**Local mode:** zero telemetry — call history stays on your machine. **Remote mode:** request metadata logged for analytics (IP hashed, never stored raw). See the [privacy policy](https://api.algovault.com/privacy).

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
