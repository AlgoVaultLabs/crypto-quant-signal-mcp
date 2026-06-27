# SCAN-RANKBY-W1 — Plan-Mode endpoint-truth

**Probed:** 2026-06-27, BOTH repos @ origin/main (MCP `f7ec17f`, bot `c3ff717`). All 5 venue endpoints LIVE-curled (HTTP 200, no geo-block). Format: `claim | reality | resolution`.

**Verdict:** 2 fictional/false primitives + 1 correctness landmine + 2 under-spec scope items → Plan-Mode HALT → **architect RATIFIED 2026-06-27** (Q1 seam, Q2(A) OKX uniform shortlist, Q3a threading, Q3b /scanwatch migration). Design intent unchanged.

## §A — Repo / seam (claim | reality | resolution)

| # | claim | reality | resolution |
|---|---|---|---|
| 1 | universe ranked by OI via `src/lib/oi-ranking.ts`; generalize that path | **FALSE** — `oi-ranking.ts` is Hyperliquid-only (header: "fetches top N **Hyperliquid** perps"; only calls `hlInfoPost`; `trade-call-scanner.ts:14` + `exchange-universe.ts:10` both say "NOT oi-ranking.ts (HL-only)"). Real scan universe selector = **`exchange-universe.ts:getExchangeTopAssetsWithVolume`** (`FETCHERS: Record<PromotedExchangeId,fetcher>`, 5 venues, already `notionalOI_usd`+`volume24h_usd`, sorted OI-desc). | **Q1 RATIFIED.** `getRankedUniverse` = metric-keyed extension of the FETCHERS registry. oi-ranking.ts NOT touched. system-map edges move to exchange-universe.ts. |
| 2 | 5 venues (BINANCE/HL/BYBIT/OKX/BITGET) | **CONFIRMED** — schema enum + `SCAN_EXCHANGES` const + scanner comment agree. 19 adapters exist but `getExchangeTopAssetsWithVolume` throws on the 14 shadow venues. | rankBy scoped to these 5. |
| 3 | each call echoes `rank_value` + typed field | **UNDER-SPEC** — `getTopCoinSet` returns `string[]` (`assets.map(a=>a.coin)`), metric discarded; `toScanCallItem` allow-lists only `{coin,timeframe,exchange,call,confidence,regime}`. | **Q3a RATIFIED.** Thread coin→metric map universe→scanner→`toScanCallItem`. non-oi lenses add `rank_value` + typed field; omitted/oi ⇒ byte-identical. |
| 4 | one handler consumes scan params | **4 consumers** — `index.ts` server.tool closure (line ~669); `x402-http-routes.ts:148-153` **hardcodes only topN/tf/exchange**; bot `handlers.py`+`alert_engine.py`; `runScanTradeCall`. | rankBy threads through SCHEMA + index closure + **x402 route** + scanner. |
| 5 | `resolveRankBy` aliases collide? | **NO collision** — lens tokens (oi/vol/gain/lose/move/pfr/nfr + canonical) disjoint from venue enum + timeframes + digits. | Bot `_parse_scan_args` (type-tolerant any-order) extends cleanly. |
| 6 | CH2 canary `check-feature-registry-drift.mjs` | **EXISTS** (`scripts/check-feature-registry-drift.mjs`, 13.8KB). | Extend / focused sibling. |
| 7 | `/capabilities` advertises set; bot derives | **CONFIRMED** — `feature-registry.ts:projectCapabilities()`→`/capabilities` (index.ts:1114); bot `capabilities.py` 3-tier (live→fallback snapshot→synthetic). | Advertise rankBy set (canonical+aliases) from ONE source (rank-constants). |
| 8 | `tools/list` = 9 | **CONFIRMED** — 8 canonical + 1 alias (`get_trade_signal`). rankBy is a param. | Stays 9. No version bump. |
| 9 | `/scanwatch` accept+forward | **needs persistence** — `scan_watches` PK `(chat_id,top_n,timeframe,exchange)` (db.py:260); `process_scan_digests` groups by that. | **Q3b RATIFIED.** Migration ADD COLUMN `rank_by` + PK widen + group-key += rank_by, with row-preserving guardrails. |

## §B — Per-venue market-wide field map (LIVE 2026-06-27, HTTP 200)

| venue | call(s) | 24h % | volume USD | funding | interval | OI USD |
|---|---|---|---|---|---|---|
| **Binance** | `GET /fapi/v1/ticker/24hr` + `GET /fapi/v1/premiumIndex` | `priceChangePercent` (pct#) | `quoteVolume` | `premiumIndex.lastFundingRate` (2nd bulk; `getPremiumIndexBulkCoalesced`, 60s cache) | 8h | no bulk OI → `quoteVolume` proxy (existing) |
| **Bybit** | `GET /v5/market/tickers?category=linear` (ALL one call) | `price24hPcnt` / `prevPrice24h` | `turnover24h` | `fundingRate` (same call) | **`fundingIntervalHour` (same call!)** | `openInterestValue` (direct USD) |
| **OKX** | `GET /api/v5/market/tickers?instType=SWAP` + `GET /api/v5/public/open-interest?instType=SWAP` (+ per-instId funding) | from `open24h` | `volCcy24h × markPx` | ⚠️ `public/funding-rate` **requires instId**; bulk `?instType=SWAP` → `50014 "Parameter instId can not be empty"`. **No market-wide funding endpoint.** | 8h (derivable `fundingTime`→`nextFundingTime` gap = 28 800 000 ms) | `oiCcy × markPx` |
| **Bitget** | `GET /api/v2/mix/market/tickers?productType=USDT-FUTURES` (ALL one call) | `change24h` / `open24h` | `quoteVolume` / `usdtVolume` | `fundingRate` (same call) | 8h | `holdingAmount × markPrice` (base→USD) |
| **Hyperliquid** | `POST /info {"type":"metaAndAssetCtxs"}` (ALL one call) | from `prevDayPx` | `dayNtlVlm` (native USD) | `funding` (same call) | ⚠️ **1h (hourly), NOT 8h** | `openInterest × markPx` |

## §C — annualizeFunding

`APR = rate × (24/intervalHours) × 365`. **HL = 1h → ×8760** (NOT ×1095). Bybit = live `fundingIntervalHour`. Binance/Bitget/OKX = 8h default. Unknown interval → `funding_apr: null` (never guess). Worked check: `annualizeFunding(0.0001, 8)` = 0.0001 × 3 × 365 ≈ 0.10950 (10.95%).

## §D — Q2(A) OKX uniform-shortlist semantics (RATIFIED)

- `oi` / `volume` / `gainers` / `losers` / `movers` → **full-universe** (in every bulk ticker incl. OKX).
- `funding_positive` (pfr) / `funding_negative` (nfr) → rank funding within the **top-by-OI candidate pool** on ALL 5 venues (uniform). Pool funding: Bybit/Bitget/HL same-call; Binance bulk `premiumIndex`; **OKX per-instId over the bounded pool, served from a background-warmed few-min-TTL cache** (no request-path fan-out → <1s). Param/description note: *"funding ranks among the most-liquid perps."* Full-universe OKX funding poller = optional W2.
