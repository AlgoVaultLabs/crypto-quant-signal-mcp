# PILOT-ADAPTERS-W3A — Plan Mode Step 0 (endpoint-truth + identifier-diff + HALT triage)

## Context

Tier-2 Bulk-Spec wave shipping 3 NEW perp-CEX adapters (Phemex + BingX + HTX) into shadow mode in `/Users/tank/crypto-quant-signal-mcp`. Sequential chapters C1 → C2 → C3 with Verification Gate between each. 4 risk markers fire (external API first-use × 3, identifier × 15 sites, cross-chapter peek, scaled-integer encoding novelty). Plan-Mode required per CLAUDE.md `## Execution flow` step 3.

Plan-Mode Step 0 work below is **read-only**: no edits to repo, no commits, no deploys. Surfaces are: WebFetch of 3 vendor docs, live curl probes of 14 endpoints across 3 venues, Read of 8 source files (types.ts, exchange-adapter.ts, gateio.ts, venue-store.ts, venue-coverage.ts, migrations/003, gateio-adapter.test.ts, system-map.md grep).

## Wave Objective (verbatim restate)

Ship 3 perp-CEX adapters (Phemex, BingX, HTX) into `shadow` venue status. Adapters implement the canonical adapter interface (candles + asset-context + funding + current-price + venue-wide predicted-fundings + name) mirroring established Binance / Bybit / Gate / MEXC / KuCoin patterns. Each venue seeded into `venues` table with `status='shadow'`, `asset_count = (probed live USDT perp count)`, `min_buy_sell_sample = asset_count × 10`. Existing infrastructure (`evaluate-venues` cron, `/api/performance-shadow` endpoint, restricted-universe seed cron, `mcp://algovault/venues` resource) absorbs the 3 new venues automatically.

## HALT triage (collapse-class — 10 fictional spec primitives, 1 root cause)

Per CLAUDE.md `plan-mode-halt-root-cause-collapse-vs-independent-primitives`. All 10 fictionals collapse to **ONE root cause**: spec drafted from training-time memory rather than from `src/types.ts:84-91` and Phemex's V2 hedged perpetual docs. Recommendation: **Path A inline rebase** (Code substitutes actual primitives during execution; spec drift documented inline in commit body + status.md; no Cowork rewrite needed).

| # | Spec claim | Live reality | Resolution |
|---|---|---|---|
| 1 | Interface name `TradingExchangeAdapter` | Actual: `ExchangeAdapter` (`src/types.ts:84-91`) | Inline rebase — adapters `implements ExchangeAdapter` |
| 2 | Method `fetchCandles(coin, interval, limit)` | Actual: `getCandles(coin, interval, startTime, dex?)` | Inline rebase — `startTime` ms not `limit`; W3A adapters convert internally |
| 3 | Method `fetchAssetContext(coin)` | Actual: `getAssetContext(coin, dex?)` returns full `AssetContext` shape (OI + mark + funding + 24h vol bundled) | Inline rebase — name only; semantics aligned |
| 4 | Method `fetchFunding(coin)` | Actual: `getFundingHistory(coin, startTime)` per-coin + `getPredictedFundings()` venue-wide | Inline rebase — funding rate already returned inside `AssetContext`; `getFundingHistory` for historical |
| 5 | Method `fetchOpenInterest(coin)` | Not in `ExchangeAdapter` interface; OI is part of `AssetContext.openInterest` | Inline rebase — no separate method; OI comes through `getAssetContext` |
| 6 | Method `getInstruments()` | Not in `ExchangeAdapter` interface (internal helper only) | Inline rebase — adapter-private function used by `getPredictedFundings()` |
| 7 | "11 venues post-W2" → "14 post-W3A" | Actual: 10 venues post-W2 → 13 post-W3A (Lighter is DEX, served via `HL` route per W1; not in `ExchangeId` union) | Inline rebase — adapter count math fixed throughout |
| 8 | Phemex requires `decodeEv(value, scale)` scaled-integer helper | Phemex V2 hedged USDT perpetual (`perpProductsV2`) uses **Real** values: `closeRp`, `markPriceRp`, `fundingRateRr`, `openInterestRv` — `priceScale: 0`, `ratioScale: 0`. Probed live for BTCUSDT V2 contract metadata. The Ev/Er encoded family is the LEGACY non-hedged contracts (different product) | **Drop `decodeEv()` machinery entirely for V2 hedged target**. Document in commit body + runbook appendix |
| 9 | Phemex symbol `cBTCUSDT` (cross-margin hedged) candidate | V2 hedged perp uses `BTCUSDT` (no prefix). `c`-prefix only for legacy non-hedged contracts | Inline rebase — Phemex `toPhemexSymbol(coin) → coin + 'USDT'` |
| 10 | "Phemex 557 perps / BingX 633 / HTX 248" approximate counts | Live: Phemex 538 USDT listed in `perpProductsV2`; BingX 638 USDT listed; HTX 233 swap listed | Inline rebase — actual `asset_count` used in `insertVenue` |

**Side-by-side methods table for W3A adapter implementations:**

| Spec name | Actual `ExchangeAdapter` name | W3A action |
|---|---|---|
| (constructor) | `class XAdapter implements ExchangeAdapter` | use actual interface |
| `fetchCandles` | `getCandles(coin, interval, startTime, dex?)` | takes startTime ms; for Phemex compute `from = floor(startTime/1000), to = floor(now/1000)`; BingX/HTX similar |
| `fetchAssetContext` | `getAssetContext(coin, dex?) → AssetContext` | bundle from per-venue all-in-one ticker call (4 of 5 W2 venues do this) |
| `fetchFunding` | (no per-coin method); funding inside `AssetContext`; historical via `getFundingHistory` | already bundled |
| `fetchOpenInterest` | (no separate method); `AssetContext.openInterest` | already bundled |
| `getInstruments` | private helper; called by `getPredictedFundings()` | venue-internal |
| (no spec) | `getPredictedFundings() → FundingData[]` | C1+C2+C3 must implement venue-wide funding fanout (or return `[]` for shadow venues — see Q-4) |
| (no spec) | `getCurrentPrice(coin) → number \| null` | required; small wrapper over ticker |
| (no spec) | `getName() → string` | returns canonical display name ('Phemex' / 'BingX' / 'HTX') |

## Per-venue endpoint truth (LIVE-PROBED 2026-05-20)

### Phemex (https://api.phemex.com — V2 hedged USDT perpetual)

| Capability | Endpoint | Verified shape |
|---|---|---|
| Instruments | `GET /public/products` | `.data.perpProductsV2` array, 538 USDT listed; sample symbol `BTCUSDT`, `priceScale: 0`, `ratioScale: 0`, `tickSize: "0.1"`, `qtyPrecision: 3` |
| Klines | `GET /exchange/public/md/v2/kline/last?symbol=BTCUSDT&resolution=3600&limit=10` | Returns `data.rows[] = [timestamp_sec, interval_sec, last_close, open, high, low, close, volume, turnover, symbol]` — **non-standard 10-field row shape**, NOT `[t,o,h,l,c,v]`; **`limit<10` returns error `30000 'Please double check input arguments'`** (min limit). All values are direct decimals (real, no scaling) |
| Asset context (all-in-one ticker) | `GET /md/v2/ticker/24hr?symbol=BTCUSDT` | `result.{closeRp, markPriceRp, indexPriceRp, fundingRateRr, predFundingRateRr, openInterestRv, openRp, highRp, lowRp, turnoverRv, volumeRq, timestamp}` — all real decimals |
| Funding history | (no dedicated stable public endpoint; `predFundingRateRr` next-period rate available in ticker) | adapter can return `[]` for `getFundingHistory` (private endpoint requires auth) OR raise unsupported — defer to wave execution |
| OI | bundled in ticker (`openInterestRv` field) | as above |
| Mark price | bundled in ticker (`markPriceRp` field) | as above |
| Auth | None for all 5 capabilities | confirmed via live unauthenticated curl |
| Rate limit | Per-endpoint; not documented in primary-docs excerpt; 429-handling not header-exposed | adapter defaults: `Retry-After` if present, else exponential backoff |
| Interval enum | seconds integer: `60` (1m), `300` (5m), `900` (15m), `1800` (30m), `3600` (1h), `14400` (4h), `86400` (1d), `604800` (1w), `2592000` (1M) | per primary docs |
| Symbol convention | `BTCUSDT` (no separator, no `c` prefix) | live confirmed for V2 hedged perp |

**Phemex live BTCUSDT ticker probe (2026-05-20)**: `closeRp = "76646.9"`, `markPriceRp = "76648.7"`, `fundingRateRr = "0.00007873"` — real decimals, matches BTC spot ±0.5%. **Confirms `priceScale=0` / `ratioScale=0` → no decoding required for V2 hedged USDT perp family.**

### BingX (https://open-api.bingx.com — Swap V2 USDT-M perpetual)

| Capability | Endpoint | Verified shape |
|---|---|---|
| Instruments | `GET /openApi/swap/v2/quote/contracts` | `.data[]` array, 638 USDT-perp listed (`currency=USDT` + `status=1`); sample: `{symbol: "BTC-USDT", pricePrecision: 1, asset: "BTC"}` |
| Klines | `GET /openApi/swap/v2/quote/klines?symbol=BTC-USDT&interval=1h&limit=3` | `data[]` of `{open, close, high, low, volume, time}` — direct float strings |
| Asset context | combine `GET /openApi/swap/v2/quote/premiumIndex?symbol=BTC-USDT` (funding+mark) + `GET /openApi/swap/v2/quote/openInterest?symbol=BTC-USDT` (OI) + `GET /openApi/swap/v2/quote/ticker?symbol=BTC-USDT` (24h vol + lastPrice) | 3 parallel calls (Binance-style fan-out pattern) |
| Funding | `GET /openApi/swap/v2/quote/premiumIndex` returns `{markPrice, indexPrice, lastFundingRate, nextFundingTime, fundingIntervalHours: 8}` — direct float strings | confirmed live |
| OI | `GET /openApi/swap/v2/quote/openInterest` returns `{openInterest, symbol, time}` | confirmed live |
| Mark price | bundled in premiumIndex | as above |
| Auth | None for all 5 capabilities | confirmed |
| Interval enum | string: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M` | per docs |
| Symbol convention | `BTC-USDT` (hyphen separator) | confirmed |
| Gate 3 | 85 USDT perps with ≥$10M 24h `quoteVolume` | passes ≥10 threshold ✓ |

### HTX / Huobi (https://api.hbdm.com — Linear USDT-M Swap)

| Capability | Endpoint | Verified shape |
|---|---|---|
| Instruments | `GET /linear-swap-api/v1/swap_contract_info?contract_type=swap` | `.data[]` array, 233 USDT swap listed; sample: `{contract_code: "BTC-USDT", contract_size: 0.001, price_tick: 0.1, business_type: "swap"}` |
| Klines | `GET /linear-swap-ex/market/history/kline?contract_code=BTC-USDT&period=60min&size=3` | `data[]` of `{id (unix sec), open, close, high, low, amount (coin units), vol (contract count = amount × 1/contract_size), trade_turnover (USDT), count}` |
| Asset context | combine `GET /linear-swap-ex/market/detail/merged?contract_code=BTC-USDT` (24h close+high+low+vol+turnover) + `GET /linear-swap-api/v1/swap_funding_rate?contract_code=BTC-USDT` (funding) + `GET /linear-swap-api/v1/swap_open_interest?contract_code=BTC-USDT` (OI) | 3 parallel calls |
| Funding | `GET /linear-swap-api/v1/swap_funding_rate` returns `{funding_rate, funding_time, estimated_rate (null when no estimate)}` | confirmed live |
| OI | `GET /linear-swap-api/v1/swap_open_interest` returns `{volume (contracts), amount (coin units), value (USDT)}` | confirmed live |
| Mark price | `GET /linear-swap-ex/market/detail/merged` → `tick.close` (last trade) or use `/index/market/history/linear_swap_mark_price_kline` (mark kline) | adapter uses `tick.close` from merged endpoint |
| Auth | None for all 5 capabilities | confirmed |
| Rate limit | 800 req/sec per-IP for market data (HTX is generous) | per primary docs |
| Period enum | string: `1min`, `5min`, `15min`, `30min`, `60min`, `4hour`, `1day`, `1week`, `1mon` | per primary docs |
| Symbol convention | `BTC-USDT` (hyphen separator) | confirmed |
| Gate 3 | batch tickers endpoint omits `trade_turnover` for some symbols; HTX per-symbol BTC-USDT shows `trade_turnover ≈ $581M` (≫$10M ✓). Plan-Mode flags Gate 3 ≥10 pairs as ASSUMED-PASS based on 248-perp catalog + HTX's $4.75B 24h OI; **C3 verification gate enumerates per-symbol if needed** |

## Phemex Ev/Rv scaling probe (the SPEC'S "CRITICAL bug class")

**SPEC CLAIM**: Phemex API uses `Ev/Rv/Rr/Er` scaled-integer encoding; adapter MUST implement `decodeEv(value, scale)` helper; "without this scaling, prices will be off by 10^4 → 10^8".

**LIVE PROBE FINDING (2026-05-20)**: For the V2 hedged USDT perpetual product family (the spec's intended target):

```
$ curl -sS 'https://api.phemex.com/public/products' | jq '.data.perpProductsV2[] | select(.symbol=="BTCUSDT") | {priceScale, ratioScale, tickSize, pricePrecision}'
{
  "priceScale": 0,
  "ratioScale": 0,
  "tickSize": "0.1",
  "pricePrecision": 1
}

$ curl -sS 'https://api.phemex.com/md/v2/ticker/24hr?symbol=BTCUSDT' | jq '.result | {closeRp, markPriceRp, fundingRateRr, openInterestRv}'
{
  "closeRp": "76646.9",
  "markPriceRp": "76648.7",
  "fundingRateRr": "0.00007873",
  "openInterestRv": "2726.8480639"
}
```

`Rp` / `Rv` / `Rr` / `Rq` suffix = **R**eal value (already unscaled). Phemex V2's hedged USDT perpetual family ships pre-scaled real values. The `decodeEv()` helper requirement is FICTIONAL for the V2 target.

**Implication**: Drop `decodeEv()` machinery from C1 implementation + drop the 4 decode-scaling unit tests + drop the Ev/Rv decoding bullets from the runbook appendix. Document this 1-paragraph correction in C1 commit body + status.md.

**Where the encoded family lives**: The `data.products` (NOT `perpProductsV2`) array carries the LEGACY non-hedged inverse contracts (`cBTCUSD`, `cETHUSD`, etc.) which DO use `Ev/Er` encoding. Spec confused two product families. Targeting `perpProductsV2` (USDT-margined hedged perp) — the actual integration target — sidesteps encoding entirely.

## TradFi alias probe (3 venues × spec's `TRADFI_FALLBACK` canonical set)

Per `## Plan Mode rules` "Semantic fingerprint probe before alias map commit" + `adapter-tradfi-aliases-and-venue-coverage-matrix-are-coupled-pair`, EACH venue's TradFi catalog probed with FULL canonical set + price-probed for memecoin-trap candidates.

### Phemex TradFi (19 listed under V2 hedged USDT perp)

`SPXUSDT, CLOUSDT, TSLAUSDT, XAUUSDT, XAGUSDT, XPDUSDT, NVDAUSDT, METAUSDT, GOOGLUSDT, AAPLUSDT, AMZNUSDT, COINUSDT, MSTRUSDT, XPTUSDT, COPPERUSDT, VIXUSDT, SP500USDT, NGUSDT, MSFTUSDT`

**Semantic-fingerprint probes:**
- `SPXUSDT` closeRp = **$0.36** → SPX6900 MEMECOIN (3rd sighting per WIS bullet) — **DO NOT alias `SPX → SPXUSDT`**
- `SP500USDT` closeRp = **$7338.7** → REAL S&P 500 ✓ — `SP500 → SP500USDT` SAFE
- `XAUUSDT` closeRp = **$4465.26** → real gold ✓

**Recommended `TRADFI_ALIASES` for Phemex** (10-12 entries; conservative — only entries where canonical key ≠ venue-native):
```
GOLD → XAU, SILVER → XAG, PLATINUM → XPT, PALLADIUM → XPD,
COPPER → COPPER (identity; venue uses `COPPER`), NATGAS → NG,
BRENTOIL → (Phemex does NOT list — skip),
USOIL → CLO, SP500 → SP500, VIX → VIX,
// Stocks (TSLA, NVDA, META, GOOGL, AAPL, AMZN, COIN, MSTR, MSFT) — identity (no alias needed)
```
NOTE: identity entries don't need `TRADFI_ALIASES` rows — only mismatched canonical→native pairs. Final adapter map: `{GOLD: 'XAU', SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD', NATGAS: 'NG', USOIL: 'CLO'}` ≈ 6 entries.

### BingX TradFi (2 listed under Swap V2)

`SPX-USDT, XAUT-USDT`

**Semantic-fingerprint probes:**
- `SPX-USDT` markPrice = **$0.36** → SPX6900 MEMECOIN — **DO NOT alias `SPX → SPX-USDT`**
- `XAUT-USDT` markPrice = **$4464.81** → Tether Gold ≈ XAU spot (within 0.05%) — `GOLD → XAUT` SAFE (mirrors MEXC + KuCoin pattern from W2)

**Recommended `TRADFI_ALIASES` for BingX**: `{GOLD: 'XAUT'}` — 1 entry only. Sparse TradFi catalog.

### HTX TradFi (15 listed under Linear USDT swap)

`META-USDT, USOIL-USDT, COPPER-USDT, NVDA-USDT, XAUT-USDT, BRENTOIL-USDT, SPX-USDT, NATGAS-USDT, MSFT-USDT, XPD-USDT, XPT-USDT, GOOGL-USDT, AAPL-USDT, XAU-USDT, XAG-USDT`

**Semantic-fingerprint probes:**
- `SPX-USDT` close = **$0.36** → SPX6900 MEMECOIN — **DO NOT alias `SPX`**
- `XAU-USDT` close = **$4467.31** → real spot gold ✓
- `XAUT-USDT` close = **$4466.75** → Tether Gold (within 0.01% of XAU spot) — **HTX has BOTH XAU and XAUT** → prefer `GOLD → XAU` (spot, mirrors Gate.io W2 pattern)

**Recommended `TRADFI_ALIASES` for HTX** (≈8 entries):
```
{GOLD: 'XAU', SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD',
 BRENTOIL: 'BRENTOIL', // identity — omit
 NATGAS: 'NATGAS', // identity — omit
 // stocks (META/NVDA/MSFT/GOOGL/AAPL) identity — omit
}
```
Final adapter map: `{GOLD: 'XAU', SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD'}` — 4 entries.

## venue-coverage.ts PARTIAL_COVERAGE extensions (per CLAUDE.md couplet rule)

Each chapter MUST extend `src/lib/venue-coverage.ts` PARTIAL_COVERAGE map in lockstep with the adapter's TRADFI_ALIASES (the `adapter-tradfi-aliases-and-venue-coverage-matrix-are-coupled-pair` 1st-fix-then-2nd-sighting rule). Concretely:

| Coin | Current row (post-W2) | + Phemex (C1) | + BingX (C2) | + HTX (C3) |
|---|---|---|---|---|
| GOLD | `['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN']` | +PHEMEX | +BINGX | +HTX |
| SILVER | `['HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET', 'GATE', 'MEXC', 'KUCOIN']` | +PHEMEX (XAG) | (not listed) | +HTX (XAG) |
| PLATINUM | `['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'MEXC', 'KUCOIN']` | +PHEMEX | (not listed) | +HTX |
| PALLADIUM | `['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'MEXC', 'KUCOIN']` | +PHEMEX | (not listed) | +HTX |
| COPPER | `['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'MEXC', 'KUCOIN']` | +PHEMEX (COPPER) | (not listed) | +HTX (COPPER) |
| NATGAS | `['HL', 'BINANCE', 'BITGET', 'OKX', 'GATE', 'KUCOIN']` | +PHEMEX (NG) | (not listed) | +HTX (NATGAS direct) |
| USOIL | (currently HL_ONLY?) | +PHEMEX (CLO) | n/a | +HTX (USOIL direct) — **may need new PARTIAL_COVERAGE row + remove from HL_ONLY if present** |
| BRENTOIL | (status TBD) | n/a | n/a | +HTX (BRENTOIL direct) |
| SP500 | (status TBD — currently in HL_ONLY per grep showing `SP500` in HL_ONLY array) | +PHEMEX → **move SP500 out of HL_ONLY into PARTIAL_COVERAGE row** | n/a | n/a |
| VIX | (status TBD) | +PHEMEX direct | n/a | n/a |
| TSLA / NVDA / META / GOOGL / AAPL / AMZN / COIN / MSTR / MSFT | (HL_ONLY or PARTIAL — varies per coin) | +PHEMEX direct (each) | n/a | +HTX (META/NVDA/MSFT/GOOGL/AAPL direct) |

This adds significant scope to the wave's venue-coverage.ts touches (≈ 6 +PHEMEX rows for C1, 1 +BINGX row for C2, 5-6 +HTX rows for C3). **Each chapter must include venue-coverage.ts edits in the SAME commit as the adapter file** (per WIS rule from PILOT-ADAPTERS-W2 "🛑 adapter-tradfi-aliases-and-venue-coverage-matrix-are-coupled-pair", 2nd sighting promoted to permanent rule). Plan-Mode caught this exact failure mode in PILOT-ADAPTERS-W2 C1 (Gate.io) — DO NOT REPEAT.

## Identifier-diff (15 sites × 3 venues)

Plan-Mode greps every `'PHEMEX' | 'BINGX' | 'HTX'` literal occurrence in `Prompt/pilot-adapters-w3a.md` to confirm consistency. All 15 sites use the canonical UPPERCASE literal matching the actual `ExchangeId` widening target:

| Venue | Wave Obj | C1 scope | C2 scope | C3 scope | AC C1 | AC C2 | AC C3 | Gate bash | C1 venues seed | C2 seed | C3 seed | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `'PHEMEX'` | ✓ | ✓ | (Must NOT write) | (Must NOT write) | ✓ | (referenced in AC count) | ✓ | ✓ | ✓ | — | — | 5 sites |
| `'BINGX'` | ✓ | (Must NOT write) | ✓ | (Must NOT write) | — | ✓ | ✓ | ✓ | — | ✓ | — | 5 sites |
| `'HTX'` | ✓ | (Must NOT write) | (Must NOT write) | ✓ | — | — | ✓ (3-venue loop) | ✓ | — | — | ✓ | 5 sites |

All literals consistent. No identifier drift detected within spec text.

## system-map.md edge-touch enumeration (7 edges)

Per Map Anchor (spec lines 5-10): 3 NEW + 4 MUTATED = 7 edges total. C1/C2/C3 commits will modify system-map.md in same-commit per `system-map.md updated: Y` rule (CLAUDE.md `## Execution flow` step 6).

| # | Edge | Class | Touched by |
|---|---|---|---|
| E-NEW-1 | `signal-MCP → Phemex perp CEX (REST)` (couplers: tight) | NEW | C1 |
| E-NEW-2 | `signal-MCP → BingX perp CEX (REST)` (couplers: tight) | NEW | C2 |
| E-NEW-3 | `signal-MCP → HTX perp CEX (REST)` (couplers: tight) | NEW | C3 |
| E-MUT-1 | `signal-MCP → MCP clients (tools/list)` — `exchange` enum widened **10 → 13** venues (NOT 11 → 14 as spec says; spec count off by 1 — see HALT row #7) | MUTATED | C1 (+1), C2 (+1), C3 (+1) — incremental |
| E-MUT-2 | `mcp://algovault/venues` resource — returns **13** venues post-W3A (5 promoted + 8 shadow) — **NOT 14** as spec says | MUTATED | C3 |
| E-MUT-3 | `evaluate-venues cron → venues table` — next cron fire detects 3 new shadow rows + 6 existing W1+W2 shadow rows | MUTATED | C3 (manual fire) |
| E-MUT-4 | `seed-signals cron → 3 new adapter routes` — SHADOW-SEED-W1 restricted-universe fan-out auto-picks-up 3 new venues via `DELAY_PER_EXCHANGE` cascade | MUTATED | C1/C2/C3 (each adds Record key) |

## Public-copy firewall self-audit (clean — zero violations)

Grep result on `Prompt/pilot-adapters-w3a.md`: verbs touching public surfaces ZERO HITS. Spec only **defines** the firewall (listing forbidden file paths in §C1/C2/C3 scope tables + Wave Objective §148-150) but never instructs Code to write any forbidden file. AC lines REFERENCE the forbidden-phrase canary but the canary is read-only (grep). Verification: `grep -nE '(EDIT|MODIFY|UPDATE).*(getPerformanceDashboardHtml|landing/|NPM-readme-DRAFT|README\.md|manifest\.json description|lobehub-manifest description)' Prompt/pilot-adapters-w3a.md` → 0 hits.

**Forbidden files (explicit per spec line 28 + 144-150)**: `getPerformanceDashboardHtml` header / methodology / Tier descriptions, `landing/*.html`, `NPM-readme-DRAFT.md`, `manifest.json description`, `lobehub-manifest.json description`, `README.md`, version bumps (package.json / server.json / manifest.json / lobehub-manifest.json), CHANGELOG.md versioned entries.

## Concurrent-session clean-baseline check (per CLAUDE.md `## Git rules`)

`git status -s` on `/Users/tank/crypto-quant-signal-mcp` shows ONLY:
```
?? audits/ACTIVATION-FIX-W1-C4-MEASURE-endpoint-truth.md
?? audits/ACTIVATION-FIX-W1-C4-measurement-2026-05-20.md
?? audits/tool-desc-audit-w1-postdeploy-tools-list-2026-05-17.json
```

3 untracked audit artifacts from earlier waves; **zero modified source files**. Clean baseline confirmed. `git log --oneline -5`: most-recent commit `ff81911` (`docs(readme): v1.16.0 What's new`); HEAD pointing at v1.16.0 release wave. Safe to proceed with C1 from clean baseline.

## Architect ratification — Q-block RATIFIED 2026-05-20

All 4 questions answered with Code's Recommended option (Mr.1 inline-confirmed via AskUserQuestion):

| # | Decision | Ratified |
|---|---|---|
| Q-1 | **Path A inline rebase** for the 10 collapse-class fictional primitives (Path D Cowork rewrite NOT taken; Mixed Cowork-handoff NOT taken). Code substitutes actual `ExchangeAdapter` methods + drops fictional `decodeEv()` + uses `BTCUSDT` + corrects 13-venue count throughout. Drift documented verbatim in commit bodies + status.md. | ✓ |
| Q-2 | **INCLUDE TRADFI_ALIASES + venue-coverage.ts extensions per chapter**. Maps: Phemex 6 entries (`GOLD→XAU, SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD, NATGAS→NG, USOIL→CLO`); BingX 1 entry (`GOLD→XAUT`); HTX 4 entries (`GOLD→XAU, SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD`). venue-coverage.ts: +6 PARTIAL_COVERAGE rows for C1 (incl. moving SP500 out of HL_ONLY); +1 row for C2; +5 rows for C3. SAME-COMMIT coupling mandatory. **SPX explicitly NOT aliased on any venue** (4th-sighting SPX6900 memecoin trap; Phemex uniquely aliases SP500→SP500). | ✓ |
| Q-3 | **One-shot script `src/scripts/seed-shadow-venues-w3a.ts`** — calls `venue-store.insertVenue()` × 3 with probed asset_count values (Phemex 538 / BingX 638 / HTX 233); idempotent via `ON CONFLICT DO NOTHING`. Operator runs `npm run seed:shadow-venues:w3a` once per chapter (or all 3 at C3 end). In-repo audit trail. | ✓ |
| Q-4 | **`getPredictedFundings()` returns `[]` for shadow venues** on Phemex + BingX + HTX. Shadow venues not yet published to `scan_funding_arb`; cross-venue funding fanout fires only for promoted venues. Follow-up wave wires per-canonical-universe funding fetch when each venue clears promotion gates. Documented in each adapter's docstring + W3A runbook appendix. | ✓ |

## Execution path (after Q-1–Q-4 ratified)

### C1 — Phemex adapter (USDT-M Hedged Perpetual V2)
**Files written (≈ 7):**
- `src/lib/adapters/phemex.ts` (NEW; ~250 lines mirroring `gateio.ts` with Phemex's all-in-one ticker pattern + 10-field kline row decoder)
- `src/lib/exchange-adapter.ts` (extend switch with `case 'PHEMEX': adapter = new PhemexAdapter(); break;` + import)
- `src/types.ts` (widen `ExchangeId` literal type: add `'PHEMEX'`)
- `src/index.ts` (widen both Zod enums at lines 252 + 355: add `'PHEMEX'`)
- `src/scripts/seed-signals.ts` (add `'PHEMEX': 300` key to `DELAY_PER_EXCHANGE`)
- `src/lib/venue-coverage.ts` (extend ~6 PARTIAL_COVERAGE rows; move `SP500` out of HL_ONLY into new PARTIAL_COVERAGE row)
- `tests/unit/phemex-adapter.test.ts` (NEW; ≥12 tests mirroring `gateio-adapter.test.ts` setup + symbol round-trip + TRADFI_ALIASES + 10-field kline decoder + SPX6900 trap test + 429 retry; **NO `decodeEv()` tests — fictional spec requirement**)
- `src/scripts/seed-shadow-venues-w3a.ts` (NEW; one-shot Phemex `insertVenue()` call with probed `asset_count = 538`)
- `system-map.md` (add E-NEW-1 row + extend Last-touched chain)

**Verification gate** — adjusted from spec verbatim to drop fictional `decodeEv` assertion + use actual 13-venue count:
```bash
cd /Users/tank/crypto-quant-signal-mcp && \
  npm run build 2>&1 | tail -5 && \
  npm test -- phemex-adapter 2>&1 | tail -20 && \
  curl -sS https://api.algovault.com/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"get_trade_call","arguments":{"coin":"BTC","timeframe":"1h","exchange":"PHEMEX"}}}' \
    | jq '.result.content[0].text | fromjson | {price, exchange: ._algovault.exchange, venue_status: ._algovault.venue_status, error}' && \
  curl -sS https://api.algovault.com/api/performance-shadow | jq '{shadow_count: (.venues | length), phemex: (.venues[] | select(.exchange_id=="PHEMEX") | {asset_count, min_buy_sell_sample, status})}' && \
  curl -sS https://algovault.com/track-record | grep -cE '(promoted exchanges|0 shadow \(experimental|seeded across.*demand-driven)' && \
  echo "CH1_GREEN"
```
Expected: tests pass; live call returns `venue_status: "shadow"`, `exchange: "PHEMEX"`, **price within ±0.5% of BTC spot** (sanity-checks no decoding mistake despite no decoding being needed); shadow_count = 7 (post-C1); public-dashboard forbidden grep = 0; `CH1_GREEN`.

### C2 — BingX adapter (Swap V2 USDT-M Perpetual)
Same shape as C1; **fewer files** (no SP500 / venue-coverage.ts only 1 row for GOLD/XAUT).
**Files written (≈ 7):** `src/lib/adapters/bingx.ts`, `src/lib/exchange-adapter.ts`, `src/types.ts`, `src/index.ts`, `src/scripts/seed-signals.ts`, `src/lib/venue-coverage.ts`, `tests/unit/bingx-adapter.test.ts`, `src/scripts/seed-shadow-venues-w3a.ts` (append BingX insertVenue), `system-map.md` (add E-NEW-2). BingX uses Binance-style 3-call fan-out for `getAssetContext` (premiumIndex + openInterest + ticker in parallel).

### C3 — HTX adapter (Linear USDT-M Swap) + runbook appendix
Same shape; venue-coverage.ts gets ~5 rows. **Files written (≈ 8):** all of the above plus `docs/RUNBOOK-VENUE-SHADOW-ONBOARDING.md` (append "Wave 3A CEX adapter lessons" appendix per spec line 288 — covering symbol conventions per venue, Phemex V2 R-suffix real-values clarification (NOT Ev/Rv encoding for the hedged target), BingX rate-limit upgrade context, HTX 800/s rate-limit generosity, TradFi coverage per venue, SPX6900 4th-sighting affirmation). HTX also uses 3-call fan-out for `getAssetContext` (merged + funding + OI in parallel) — different endpoint paths from BingX.

Manual cron fires at end of C3:
```bash
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'sudo systemctl start evaluate-venues.service && sleep 5 && sudo journalctl -u evaluate-venues --since "1 minute ago" --no-pager | tail -20'
```
Expected: journal shows `shadow=9 actions=0` (3 new + 6 prior).

## Files outside scope (firewall — MUST NOT write)

Per spec lines 28, 144-150: `landing/*.html`, `getPerformanceDashboardHtml`, `NPM-readme-DRAFT.md`, `README.md`, `manifest.json description`, `lobehub-manifest.json description`, `package.json`, `server.json`, version bumps, CHANGELOG.md versioned entries, AOE weight registry, Wave 3B venues (WEEX/Bitmart/XT.COM/WhiteBIT), W1/W2 venues. status.md gets appended per chapter (audit-log entry, NOT public-copy).

## Verification (Plan-Mode artifact)

After approval, Code will save the full Plan-Mode artifact to `/Users/tank/crypto-quant-signal-mcp/audits/PILOT-ADAPTERS-W3A-endpoint-truth.md` as a permanent audit record (mirrors W1/W2 pattern). This plan file IS that artifact's draft.
