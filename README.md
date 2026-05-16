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
</p>

---

## 📊 Live Track Record — Public, Verifiable, On-Chain

<p align="center">
  <a href="https://algovault.com/track-record">
    <img src="https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/docs/screenshots/track-record-2026-05-13.png" alt="AlgoVault Live Track Record — 90.4% PFE Win Rate across 86,093 trade calls, 33 Merkle batches anchored on Base L2" width="100%" />
  </a>
</p>

<p align="center">
  <strong><span data-tr-field="pfe_wr">90.4%</span> PFE Win Rate</strong> · <strong><span data-tr-field="total_calls">86,093</span> trade calls</strong> · <strong><span data-tr-field="merkle_batches">33</span> on-chain batches</strong> · <strong><span data-tr-field="hold_rate">99%</span> HOLD rate</strong> <!-- SNAPSHOT-LINE -->
</p>

<p align="center">
  Every call is hashed at emission, anchored on Base L2 daily, and re-evaluated against actual price action. We can't edit history. <em>Refetch live numbers any time at <a href="https://algovault.com/track-record">algovault.com/track-record</a> or <a href="https://api.algovault.com/api/performance-public">/api/performance-public</a>.</em>
</p>

<p align="center">
  <a href="https://algovault.com/track-record"><strong>→ Open the live dashboard</strong></a>
</p>

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

---

## What's new in v1.11.0

Live since 2026-05-XX (target):

- **🤖 Try Free in Telegram.** [`@algovaultofficialbot`](https://t.me/algovaultofficialbot) is now the primary on-ramp at the top of this README. One Telegram command (`/watch BTC 4h`) gets you live regime alerts and BUY/SELL trade calls in real time. Same composite-verdict signal stream as the MCP server, same <span data-tr-field="pfe_wr">90.4%</span> PFE win rate, same on-chain track record. No code, no API key, no install. 100 free trade-call alerts/month before the upgrade prompt fires. <!-- SNAPSHOT-LINE -->

- **🔁 Default exchange changed: Hyperliquid → Binance Futures.** `get_trade_call(coin: "BTC", timeframe: "1h")` (no `exchange` arg) now returns the Binance USDT-M Futures verdict by default. Binance is the highest-volume CEX and the most familiar default for devs onboarding. Hyperliquid remains fully supported — pass `exchange: "HL"` to keep prior behavior, or specify any of the 5 venues explicitly. No data loss; default-routing change only.

- **🧠 Self-tuning quant ML model — surfaced.** AlgoVault is a self-tuning quant ML model with a published track record. The composite trade-call verdict is produced by a model that continuously learns from outcomes via our [Autonomous Optimization Engine](https://algovault.com/how-it-works). Like an LLM API, you're not buying a one-shot signal — you're buying access to a model that gets sharper with every call. PFE win rate has improved monotonically since launch; verifiable on Base L2.

- **🔌 Drop-in client matrix enumerated.** Streamable HTTP at `api.algovault.com/mcp` works with Claude Desktop, Claude Code, Cursor, Cline, and every other MCP-spec-compliant client. See the [Drop-in section](#drop-in-for-every-mcp-client). No SDK; no wrapper library; protocol is the API.

- **📄 New `/how-it-works` page.** Substrate-level docs page now live at [algovault.com/how-it-works](https://algovault.com/how-it-works). Explains what AlgoVault is at the technical level for devs evaluating one click below the landing hero.

> **Upgrading from v1.10.x or earlier?** The MCP tool surface is unchanged structurally — `get_trade_call`, `scan_funding_arb`, `get_market_regime` keep their parameter shapes. The only behavioral diff: omitting `exchange` now returns the Binance result instead of Hyperliquid. Existing agents passing `exchange` explicitly are unaffected. MCP clients (Claude Desktop, Cursor, Cline) cache the tool list at session start — toggle the connector off/on to pick up the new default-routing behavior.

---

## Why AlgoVault

Most MCP trading servers give you raw data — prices, order books, candles. Your agent still has to figure out what to do with it.

AlgoVault is different. We give your agent **one answer**: a directional verdict with a confidence score, produced by a self-tuning quant ML model whose weights are calibrated from published trade outcomes. Every call is tracked, every outcome is measured, and the full track record is on-chain from day one.

**What makes this not just another indicator wrapper:**

- **Composite scoring, not single-indicator noise.** Multiple orthogonal signals — momentum oscillators, trend structure, derivatives positioning, volume dynamics, open interest flow — fused into a single weighted verdict. Weights are calibrated from live market outcome data, not textbook defaults.
- **Regime-aware call generation.** Calls are filtered through a market regime classifier before emission. The engine knows when to stay silent — a trend-following setup in a ranging market gets suppressed, not broadcast. (HOLD rate ~99%; we issue calls only when the edge is clear.) <!-- SNAPSHOT-LINE -->
- **Cross-venue intelligence.** Full signal generation on 5 exchanges with native candle, OI, funding, and volume data per venue. Cross-venue funding arbitrage scanning across all venues — nobody else does multi-exchange derivatives analysis via MCP. <!-- SNAPSHOT-LINE -->
- **Published track record with every release.** Every call is recorded with outcome prices at multiple horizons. PFE Win Rate, Profit Factor, Expected Value computed continuously. No cherry-picking, no survivorship bias. **Anchored on-chain on Base L2 — we cannot rewrite history.**
- **Self-tuning model.** Indicator weights are tuned from live outcome data by our [Autonomous Optimization Engine](https://algovault.com/how-it-works). The model gets sharper with every signal.
- **Crypto + TradFi coverage.** 730+ assets — standard crypto perps on all 5 venues; TradFi perps (stocks, indices, commodities, FX); liquidity-filtered meme coins. <!-- SNAPSHOT-LINE -->

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
- `coin` (string, required): Asset symbol — e.g. `"ETH"`, `"BTC"`, `"SOL"`, `"GOLD"`, `"TSLA"`, or any of 710+ supported assets <!-- SNAPSHOT-LINE -->
- `timeframe` (string, default `"15m"`): all 11 timeframes — `"1m"`, `"3m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`, `"2h"`, `"4h"`, `"8h"`, `"12h"`, `"1d"`
- `exchange` (string, default `"BINANCE"`): `"BINANCE"`, `"HL"` (Hyperliquid), `"BYBIT"`, `"OKX"`, `"BITGET"`. Asset availability varies per venue — pass exchange explicitly to target a specific venue.
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
    "version": "1.11.0",
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
| Assets | All 730+ | All 730+ | All 730+ | All 730+ | All 730+ | <!-- SNAPSHOT-LINE-TABLE -->
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

Every call is hashed (keccak256) at creation time and anchored on Base L2 via daily Merkle batches. The track record is tamper-proof — we cannot edit past calls.

- **Contract**: [`0x6485...0f81`](https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81) (Base L2)
- **Verify any call**: [`api.algovault.com/api/verify-signal?signalId=<ID>`](https://api.algovault.com/api/verify-signal)
- **View all batches**: [`api.algovault.com/api/merkle-batches`](https://api.algovault.com/api/merkle-batches)
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
  │    └─ Bitget USDT-M
  │
  ├─ Performance Tracker
  │    └─ PostgreSQL (remote) / SQLite (local)
  │
  └─ Exchange Public APIs (free, no auth — all 5 venues)
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
