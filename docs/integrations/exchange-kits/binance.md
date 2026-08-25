# AlgoVault × Binance — Build Verifiable AI Trading Agents

> <!-- snapshot: 2026-07-21 — live source of truth: /api/performance-public + /api/merkle-batches -->
<strong><span data-tr-field="pfe_wr">91.5%</span> PFE Win Rate · <span data-tr-field="call_count">383,789</span>+ calls · <span data-tr-field="batch_count">100</span>+ Merkle-verified on-chain batches.</strong>
> Don't trust — [verify the track record →](https://algovault.com/track-record?utm_source=tutorial&utm_medium=repo&utm_campaign=integration-binance)
> *Snapshot taken 2026-04-26 — live numbers refreshed in-page from <https://algovault.com/api/performance-public>*

## Using Binance Agent OS? Start here

Binance now ships its own agent stack, and it needs no API keys: you authenticate over OAuth, and trading is confined to an isolated Agentic sub-account that only you can fund. No withdrawal scope exists.

If that is your path, the tutorial below is not the one you want.

**→ [AlgoVault × Binance Agent OS](/integrations/binance-agent-os)** — connect both servers to one MCP client in two commands.

The page below teaches the direct API path. It is still correct, and still the right choice when you need custom order types, a non-MCP runtime, or a deterministic backtest harness.

---

AlgoVault MCP gives your agent a **composite verdict** in one call — direction, confidence, regime, and cross-venue funding/sentiment context — backed by a publicly auditable record anchored to Base L2. Pair it with Binance's [Skills Hub](https://github.com/binance/binance-skills-hub) and your agent has both the analytics brain and the execution venue.

> **Provenance:** OFFICIAL [Binance Skills Hub](https://github.com/binance/binance-skills-hub) (`github.com/binance/binance-skills-hub` · "Built by Binance" · 761⭐ at the time of writing · last updated 2026-04-25). Binance Skills Hub uses an open marketplace pattern — install via `npx skills add <repo-url>` rather than a classic npm MCP server. Demo execution runs against [Binance Spot Testnet](https://testnet.binance.vision) (`https://testnet.binance.vision/api`) with `BINANCE_TESTNET=true` + `MAINNET_BLOCKED=true` wrapper guards. Verified 2026-04-25.

## Direct API path (Spot Testnet, API keys)

Everything from here down is the key-based flow: you issue Binance API keys, sign your own requests, and run the demo against Spot Testnet.

### TL;DR (3-line hook)

- One API call → composite verdict (signal, confidence, regime, factors). Not 26 raw indicators.
- Cross-venue intelligence across 12 exchanges. Funding spreads, regime alignment, volatility — fused.
- Every signal Merkle-anchored on-chain. Verifiable accuracy, not a marketing claim.

### What you'll build (90s read)

A runnable Node.js agent that:

1. Calls AlgoVault MCP for a composite verdict on a chosen asset + timeframe.
2. Reads the verdict's `signal`, `confidence`, `regime`, and `factors` fields.
3. Hands the verdict to Binance Spot Testnet, which validates a small order in **testnet mode** when the agent's pre-configured policy fires.

The whole loop runs against Binance Spot Testnet — **zero real-money risk in any code path**.

### Prerequisites (4 items)

1. **Node.js ≥ 22** (`node --version` to check).
2. **AlgoVault skills plugin** installed:
   ```bash
   claude plugin install AlgoVaultLabs/algovault-skills
   ```
3. **Binance Spot Testnet account** (free signup at <https://testnet.binance.vision>; sign in with GitHub). API key + secret from the testnet console — the demo runs read-only out of the box; supplying keys unlocks the authenticated `order/test` validation step.
4. **Binance Skills Hub** installed (optional for the bare-minimum demo, recommended for the recipes):
   ```bash
   npx skills add https://github.com/binance/binance-skills-hub
   ```

### Demo: Confidence-filtered swing-entry validator on ETH (≤80 lines)

```javascript
// examples/binance/demo.mjs (excerpt — see file for full source)
import { getAlgoVaultVerdict } from '../_shared/algovault-helper.mjs';

const MAINNET_BLOCKED = true;
const BINANCE_TESTNET_BASE = 'https://testnet.binance.vision/api';

if (process.env.BINANCE_TESTNET !== 'true') {
  throw new Error('BINANCE_TESTNET=true required — demo refuses to run against mainnet.');
}

console.log('=== DEMO MODE ===');
console.log(`[BINANCE_TESTNET=true | base=${BINANCE_TESTNET_BASE}]`);

// 1. Fetch AlgoVault verdict on ETH 1h
const verdict = await getAlgoVaultVerdict({ coin: 'ETH', timeframe: '1h' });

// 2. Apply the agent's policy
const policy = verdict.signal === 'BUY' && verdict.confidence > 70;

// 3. Validate a small testnet order if policy fires (or just probe testnet
//    if no keys are set)
if (policy) {
  console.log(`[policy fires | signal=${verdict.signal} confidence=${verdict.confidence}]`);
  // ... order/test call (see full source for HMAC signing)
}

console.log('=== NO REAL ORDERS PLACED ===');
```

Run it:

```bash
BINANCE_TESTNET=true node examples/binance/demo.mjs
```

Expected output (last 3 lines):

```
[binance testnet | exchangeInfo HTTP 200 | symbols=...]
[verdict | signal=... confidence=... regime=...]
=== NO REAL ORDERS PLACED ===
```

### Walkthrough (line-by-line — neutral narration)

The script does three things in order:

1. **Fetch the AlgoVault verdict.** The shared helper opens an MCP session against `https://api.algovault.com/mcp`, calls `get_trade_call` with `{coin: 'ETH', timeframe: '1h'}`, and returns the parsed `signal`/`confidence`/`regime`/`factors` payload. Free tier covers {{PRICING.free_allowance}} — plenty for development.

2. **Apply the agent's policy.** When the verdict satisfies the agent's pre-configured policy (`signal === 'BUY' AND confidence > 70`), the script proceeds to the execution branch. The policy lives in your code — AlgoVault returns the analytics; the agent decides.

3. **Validate the order against Binance Spot Testnet.** The script POSTs to `/api/v3/order/test` (a Binance testnet endpoint that performs all order-placement validation but does NOT submit). On success Binance returns an empty `{}` body. The `=== NO REAL ORDERS PLACED ===` banner closes every run regardless of which branch fired. The script aborts immediately if `BINANCE_TESTNET` is not set to `true` — a hard guard against accidentally running against mainnet.

### 3 Recipes

#### Recipe 1 — Regime-gated DCA on BTC

The agent calls AlgoVault `get_market_regime` for `BTC` on the `4h` timeframe. The agent's pre-configured DCA policy fires its execution branch when the returned regime ∈ `{TRENDING_UP, RANGING}` and skips the week's DCA entirely when the regime is `VOLATILE` or `TRENDING_DOWN`. On execution, the agent sends a `MARKET BUY` for a small BTC notional via Binance Spot Testnet (HMAC-signed `POST /api/v3/order/test` for read-only validation, or `POST /api/v3/order` once the operator has chosen to switch to authenticated testnet order placement).

This recipe is the cleanest "AlgoVault as policy gate" pattern — DCA logic stays in your code; the regime read replaces hand-tuned VIX-style heuristics with a backtested cross-venue regime classifier.

#### Recipe 2 — Confidence-filtered swing entry on ETH

This is the recipe `examples/binance/demo.mjs` implements. The agent calls AlgoVault `get_trade_call` for `ETH` on the `1h` timeframe. The agent's policy fires its execution branch only when `signal === 'BUY'` AND `confidence > 70`. On execution, a small `LIMIT` order is validated via `POST /api/v3/order/test` against Binance Spot Testnet. The same shape works for `SELL` policies in production (with the appropriate side flip).

#### Recipe 3 — Funding-arb opportunity awareness

The agent calls AlgoVault `scan_funding_arb` to retrieve the top funding-spread opportunities across the 5 venues AlgoVault monitors. The output is a ranked list of `{coin, longVenue, shortVenue, spreadBps}` rows. **Multi-venue execution is out of scope for this single-exchange tutorial — the agent uses the rank to surface awareness and could route the long leg through Binance perp testnet (when shipped) and the short leg via the venue indicated.** AlgoVault returns the opportunity; the agent's risk policy decides whether to act on it.

### ⚠️ Production setup (real-money)

The demo above runs on Binance Spot Testnet only. Real-money setup requires:

- KYC completion on Binance.
- Production API keys with **only** the permissions your agent needs (no withdrawals, IP-allowlisted).
- Risk controls: per-order size cap, daily loss limit, kill switch.
- Position monitoring: a separate agent or watchdog that tracks open positions independently.

See `examples/binance/README.md` for the full real-money checklist. **AlgoVault provides analytics; your agent and your risk policy decide what (if anything) to execute.**

## Why AlgoVault?

- **Composite verdict, not raw indicators.** One JSON response replaces 26-indicator vote-counting.
- **Cross-venue intelligence.** Funding spreads, regime, and sentiment fused across 12 exchanges — not derivable from any single-venue API.
- **Publicly verified.** Every signal anchored to Base L2 via Merkle proof. Verify before you subscribe.
- <!-- snapshot: 2026-07-21 — live source of truth: /api/performance-public + /api/merkle-batches -->
<strong><span data-tr-field="pfe_wr">91.5%</span> PFE Win Rate · <span data-tr-field="call_count">383,789</span>+ calls · <span data-tr-field="batch_count">100</span>+ on-chain batches</strong> → [view live track record](https://algovault.com/track-record?utm_source=tutorial&utm_medium=repo&utm_campaign=integration-binance)

## Install

```bash
claude plugin install AlgoVaultLabs/algovault-skills
```

Once installed, every Skill in the [pack](https://github.com/AlgoVaultLabs/algovault-skills) is one-line invokable from Claude Code, Cowork, or any MCP-compatible client.

---

*Tutorial © AlgoVault Labs · MIT licensed · Provenance verified 2026-04-25 · Binance Skills Hub OFFICIAL (`github.com/binance/binance-skills-hub`)*
