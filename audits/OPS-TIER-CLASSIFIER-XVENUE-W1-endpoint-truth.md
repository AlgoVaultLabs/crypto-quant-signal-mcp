# OPS-TIER-CLASSIFIER-XVENUE-W1 — Plan-Mode Step-0 endpoint-truth

**Produced:** 2026-06-21 (BEFORE C1) · **Status:** 🛑 HALT — awaiting architect ratification of Q-rows.
**Checkout:** `/Users/tank/code/crypto-quant-signal-mcp` · **base `origin/main` = `c9d3582`** (worktree `../cqsm-wt-tier-classifier`, branch `ops/tier-classifier-xvenue-w1`).
**Method:** every venue endpoint live-curled 2026-06-21; every cited code anchor read at `origin/main` (NOT the local working tree, which is 33 commits stale at `eb97cf9`). Counts drift — we assert the **field**, never a hardcoded count.

> **Ship-boundary / greenfield:** `git ls-tree origin/main` shows NO `asset-class-registry.ts`, NO `getTradFiInstruments`, NO `tier-misclassification-canary` — wave is greenfield, not already shipped. The three tier/adapter worktrees (`fix/tier-escalation`, `fix/adapter-prevdaypx-24h-open`, `edgex-kline-order`) are all **0-ahead / behind `origin/main`** — already merged, no in-flight collision.

---

## §1 — Per-venue live-probe matrix (claim | live reality 2026-06-21 | resolution)

| Venue | Spec claim (authoritative field → TradFi) | Live reality (curl 2026-06-21) | Resolution |
|---|---|---|---|
| **HL** | `perpDexs` per-instrument; xyz | `perpDexs` → **9** (`null`/`xyz`/`flx`/`vntl`/`hyna`/`km`/`abcd`/`cash`/`para`); `meta dex=xyz` → **93** instruments (TSLA, NVDA, GOLD, HOOD, INTC) | ✅ CONFIRMS. `getXyzAssetsByOI()` exists (oi-ranking.ts). **Enumerate dexes dynamically** (9 now vs 5 named) — don't hardcode. |
| **Binance** | `underlyingType`∈{EQUITY,COMMODITY,INDEX,PREMARKET,KR_EQUITY}; `contractType=TRADIFI_PERPETUAL` | **100** `TRADIFI_PERPETUAL`; underlyingType `{EQUITY:87, COMMODITY:8, KR_EQUITY:3, PREMARKET:2}`; subType `{[TradFi]:97, [TradFi,ETF]:1, [Pre-IPO,TradFi]:2}`; CRWD/HIMS/GME/QNTX = EQUITY+TradFi; BTC = COIN | ✅ CONFIRMS. **ALREADY IMPLEMENTED** — `underlying-type.ts::resolveAssetClass` + `BINANCE_UNDERLYING_TO_ASSET_CLASS`. No `INDEX` value live (map lacks the key); Pre-IPO carried by subType but `underlyingType=EQUITY`→T3 already. |
| **Gate** | `contract_type`∈{stocks,indices,commodities,metals,forex} | n=776; `{'':555, stocks:188, indices:15, metals:12, commodities:3, forex:3}` = **221** TradFi; BTC_USDT = `''` | ✅ CONFIRMS exactly. New detector reads `contract_type`. |
| **MEXC** | `typeLabel==2` / `conceptPlate` tradfi-zone | n=911; typeLabel `{0:746, 2:161, 4:4}`; conceptPlate has `mc-trade-zone-tradfi`(191)+`-Stock`(163); SNDKSTOCK=2; BTC=0 | ✅ CONFIRMS exactly (**161**). Read `typeLabel` — naming non-uniform (NVIDIA_USDT/DRAM_USDT/SPX500_USDT also =2). |
| **Bitget** | `isRwa=="YES"` | n=649; `{NO:468, YES:181}`; VRT=YES, BTC=NO, QNT=NO (crypto Quant — correct) | ✅ CONFIRMS exactly (**181**). |
| **Bybit** | `symbolType`∈{stock,commodity} | n≥689; `{'':508, innovation:119, stock:59, commodity:3}` = **62**; SNDK=stock; BTC=`''` | ✅ CONFIRMS (**62**). Paginate (cursor) to full set. |
| **WhiteBit** | `isTradFiFutures` boolean | Field present on `GET /api/v4/public/markets` (**NOT** `/futures`, which uses `product_type`/`index_name`) | ✅ CONFIRMS — read `/markets`. |
| **BingX** | `NC{FX,CO,SK,SI}` naming prefix | NCSK=117, NCSI=16, NCCO=26, NCFX=28 (e.g. `NCSKTSLA2USD-USDT`); no class field | ✅ CONFIRMS — detect by prefix. |
| **EdgeX** | spec: ❌ empty crypto-DEX | **`isStock` boolean — 19 true** (SPYUSD, AAPLUSD, TSLAUSD, IAUUSD, SLVUSD) via `getMetaData` | ⚠️ **DRIFT (favorable): cleanest field of any venue.** Add an `isStock` detector — EdgeX is first-class, NOT empty. |
| **OKX** | no clean field → cross-venue fallback | `category=1` uniform (387 rows); `ruleType` `{normal:385, pre_market:2}`; BTC/ASML/SNDK/CRWD indistinguishable | ✅ CONFIRMS gap → cross-venue union fallback. |
| **Aster** | no usable field (`underlyingType=COIN` for stocks too) | `underlyingType=COIN` uniform (495). **BUT** carries unprobed `symbolType` + `tags` keys | ✅ CONFIRMS `underlyingType` gap → fallback. ⚠️ **Flag: probe `symbolType`/`tags` at build — may self-classify.** |
| **HTX** | spec: ❌ none now (correctly empty) | ⚠️ **NOW LISTS TradFi** — TSLAX, MSTRX, AAPL, NVDA, CRWD, SNDK (~14+); signal `business_type`/`contract_type` (undecoded) | 🛑 **DRIFT — Q-row.** Decode `business_type` OR route via cross-venue fallback this wave + flag follow-up. |
| **KuCoin** | spec: ❌ none now (correctly empty) | ⚠️ **NOW LISTS TradFi** — AAPLUSDTM, TSLAUSDTM, NVDA, MSTR, GOOGL, META; fields `marketType`/`sourceExchanges`/`preMarketToPerpDate` | 🛑 **DRIFT — Q-row.** Decode `marketType` OR cross-venue fallback + flag follow-up. |
| **Phemex** | spec: ✅ xStock/Ondo present | ⚠️ **NO xStock/Tokenized naming**; only the crypto token ONDO matched | 🛑 **DRIFT — Q-row.** Phemex detector returns **empty** (no detectable TradFi) — confirm acceptable. |
| **BitMart** | `product_type`/`index_name` | `product_type` constant `1` (useless). Real signal = dedicated **`tradfi_info`** key; AAPLXUSDT/TSLAXUSDT present | 🛑 **DRIFT — read `tradfi_info`** (confirm shape at build), not `product_type`. |
| **XT** | `underlyingType` | `underlyingType` constant **`U_BASED`** (useless). Stocks via `x_` suffix + `preMarket*` fields; `aaplx_usdt` | 🛑 **DRIFT — `underlyingType` is not a discriminator.** Naming/`preMarket` OR cross-venue fallback. |
| **WEEX** | `underlying_index` / `cmt_` prefix | `cmt_` is **universal** (all 762); `underlying_index` = base ticker; `cmt_aaplusdt` present | 🛑 **DRIFT — no clean field.** Naming heuristic OR cross-venue fallback. |

**Tally:** 9 venues self-classify with a clean field (Gate, Binance, Bitget, Bybit, MEXC, WhiteBit, BingX, EdgeX, HL). 2 confirmed no-field → cross-venue fallback (OKX, Aster). **6 spec-matrix drifts (HTX, KuCoin, EdgeX, Phemex, BitMart, XT, WEEX = 7 venue-claims wrong)** → exceeds the ≥3-fictional HALT threshold.

---

## §2 — Code-anchor verification (spec identifier | reality at `origin/main` | resolution)

| # | Spec says | Reality (`origin/main` c9d3582) | Resolution |
|---|---|---|---|
| C-1 | adapters at `src/lib/exchanges/<venue>.ts` | adapters at **`src/lib/adapters/<venue>.ts`** (17 venue files) | Inline path correction. |
| C-2 | interface `TradingExchangeAdapter` | interface **`ExchangeAdapter`** (`src/types.ts:88`), `getAdapter()` registry (`exchange-adapter.ts:30`) | Inline name correction. (CLAUDE.md also says `TradingExchangeAdapter` — drift in the rule too.) |
| C-3 | add `AssetClass = 'equity'\|'index'\|'commodity'\|'fx'\|'preipo'` (NEW, lowercase) | **`AssetClass` ALREADY EXISTS** — `market-sessions-constants.ts:21` = `'CRYPTO'\|'EQUITY'\|'KR_EQUITY'\|'COMMODITY'\|'PREMARKET'` (UPPERCASE), used by **6 files** | 🛑 **Q-row (collision):** extend existing vs new parallel type. |
| C-4 | NEW `asset-class-registry.ts` (Map<venue,Map<sym,class>> + 3-tier cache live→stale→seed + PROBED_AT + fail-open) | **`underlying-type.ts::resolveAssetClass(coin, exchange)` already does this** — Binance live `exchangeInfo` detection + 3-tier (fresh 24h→stale→`STATIC_ASSET_CLASS_MAP`→UNKNOWN/CRYPTO) + cache-seam trio + never-throws. Only Binance has live detection; other venues use the static map. | 🛑 **Q-row (single-derivation):** extend `underlying-type.ts` for all venues vs build a parallel registry. |
| C-5 | C2 price-sanity gate (>2× off ⇒ not TradFi) | **`priceFingerprintPass(price, median, factor=2)` already exists** — `tradfi-funding.ts:111` + runtime fingerprint guard | Reuse — do NOT reimplement. |
| C-6 | `classifyAsset(coin, top20, venue?)` consults registry | `classifyAsset(coin, top20ByOI): AssetTier` @ `asset-tiers.ts:87` is **SYNC**; called **11×** in `performance-db.ts` rollup loops + `get-trade-call.ts:153`. `resolveAssetClass` is **async**. | 🛑 **Q-row:** registry must expose a **sync** read over pre-warmed state (mirror `dynamicXyzSymbols`/`warmTierCaches`); keep `classifyAsset` sync — async would cascade across 12 call sites. Optional-trailing `venue?` confirmed idiomatic (interface already uses `dex?, endTime?`). |
| C-7 | "OPS-TRADFI-XVENUE-FUNDING-W1 fingerprint gate, FIXED_PREIPO, equity engine" | `FIXED_PREIPO` (`indicator-buckets.ts`, `tradfi-funding.ts`, from TRADIFI-SIGNAL-HARDENING-W1) ✓; `tradfi-funding.ts` cross-venue module ✓; equity engine `src/lib/equities/equity-verdict.ts` ✓; semantic-fingerprint probes in gateio/mexc/bingx adapters ✓ | All real — integrate, don't duplicate. |
| C-8 | C2: "cross-venue union … **Binance excluded — it has zero TradFi**" | Binance has **100** TradFi perps (live); spec's own §Implications + correction (lines 28/60) say Binance is first-class authoritative | 🛑 **Q-row:** the "Binance=zero" parenthetical is factually dead → include Binance in the union? |
| C-9 | C3 canary mirrors `equity-verdict-watch.sh` via `send_telegram.sh` | `ops/monitoring/equity-verdict-watch.sh` ✓; `send_telegram.sh` is **host-side** (`/opt/algovault-monitoring/`), not in-repo | Canary = host-only (per spec note); no "deployed" claim without SSH probe. |
| C-10 | C4 "update `system-map.md` (code repo)" | **No `system-map.md` in code repo** — it's the **vault** file. `scripts/check_system_map.sh` (pre-commit gate) reads `SYSTEM_MAP_PATH` (default vault path), blocks edge-mutating commits unless vault map touched <600s; honors `[skip-map-check]` | Update the **vault** system-map.md; use `[skip-map-check]` on non-edge commits. |
| C-11 | tests `tests/asset-tiers.test.ts`, `tests/unit/api-performance-public.test.ts` | Both exist ✓; shape-snapshot baseline `audits/api-performance-public-shape-snapshot-2026-06-07.json` ✓ | Extend; add `…-shape-snapshot-2026-06-21.json`. |

---

## §3 — Identifier diff (R-section vs AC-section)

| Identifier | R / Method section | AC / elsewhere | Verdict |
|---|---|---|---|
| Interface | `TradingExchangeAdapter` | (same) | Both wrong → `ExchangeAdapter`. |
| Adapter path | `src/lib/exchanges/` | (same) | Both wrong → `src/lib/adapters/`. |
| `AssetClass` casing | lowercase `equity\|index\|…` (C1) | AC asserts `→equity` (lowercase) | Conflicts with existing UPPERCASE type → Q-row C-3. |
| Cross-venue union | "Binance excluded — zero TradFi" (C2 Method) | §Implications: "Binance first-class authoritative ~100+" | Internal contradiction → Q-row C-8. |
| VRT / ASTEROID | VRT→T3, ASTEROID→crypto (both sections) | live: Bitget VRT=isRwa YES ✓; ASTEROID absent from all TradFi tags ✓ | Consistent + venue-confirmed. |

---

## §4 — 🛑 Q-ROWS FOR ARCHITECT (ratify before C1)

See the HALT block in the session message. Summary: Q1 architecture (extend `underlying-type.ts` vs new registry) · Q2 `AssetClass` shape · Q3 HTX/KuCoin now-listing · Q4 EdgeX `isStock` first-class · Q5 Phemex empty · Q6 BitMart/XT/WEEX field drift · Q7 Binance-in-union · Q8 sync classifyAsset · Q9 ratify inline identifier corrections.
