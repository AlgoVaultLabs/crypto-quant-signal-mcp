# OPS-WEEX-PROMOTION-READINESS-W1 — CH1 endpoint-truth + the five diagnoses

**Probed** 2026-09-03 (host clock `2026-09-03 09:06 UTC`). **Base** `origin/main` `d0425710`. **Worktree** `/Users/tank/code/.worktrees/crypto-quant-signal-mcp/weex-promotion-readiness-w1`.
**Backward dep** `audits/OPS-VENUE-SET-RECONCILE-W1-endpoint-truth.md` (read; its Probes 4/5/6/8 are re-derived below, not trusted).
**Read-only by construction.** Zero tracked files mutated outside `audits/`.

---

## 0 · Primitive probe — `claim | reality | resolution`

| # | Spec claim | Reality (one concrete command) | Resolution |
|---|---|---|---|
| 1 | `weex.ts:93` uses `/capi/v2` | ✅ `/capi/v2/market/candles`. **Three** more v2 sites: `weex.ts:118`, `weex.ts:162` (`/capi/v2/market/ticker`), `seed-signals.ts:641` (`/capi/v2/market/tickers`) | confirmed + inventory completed (§D3) |
| 2 | v3 equivalent `/capi/v3/market/klines` | ✅ `http=200` — **but only with symbol `BTCUSDT`.** `symbol=cmt_btcusdt` → `{"code":-1142,"msg":"Parameter 'symbol' is invalid."}` | **CH2 scope premise "endpoint move only" is FALSE** — v3 changes the symbol convention |
| 3 | v3 equivalent for tickers | 🛑 **`/capi/v3/market/tickers` → 404.** `/capi/v3/market/ticker` → 404. Real path is **`/capi/v3/market/ticker/24hr`** (per-symbol *and* bulk) | 1 fictional primitive; corrected inline |
| 4 | `/capi/v3/market/exchangeInfo` declares 0.833 req/s | ✅ `rateLimits[]` `interval MINUTE, intervalNum 10, limit 500`; `symbols[]` = **1023** (stored `venues.asset_count = 723`, 42% stale) | confirmed |
| 5 | "run the population comparison via `scripts/check-population-comparison.mjs`" | ⚠️ That script is a **registry/pattern TRIPWIRE** (its own header: *"Pass 1 is a TRIPWIRE, not a proof"*). It computes **no edge**. The computation is `ops/monitoring/population_comparison.py` → `class Arm` | **mis-assigned primitive.** D2 below runs the real one (`Arm`) |
| 6 | AC wants `IDENTIFIABLE (edge = X pp, **CI-lb = Y**)` | 🛑 `grep -c "bootstrap\|confidence\|ci_lb\|interval" ops/monitoring/population_comparison.py` → **0**. No interval machinery exists anywhere in the estate | **Q1** — the AC cannot be met by the primitive it names, and the same section forbids hand-rolling |
| 7 | CH2 gate `grep -rn "capi/v2" src/` must return nothing | 🛑 It also matches **`src/scripts/seed-shadow-venues-w3b.ts:33`** — a historical `notes:` provenance string from the 2026-05-20 pilot | **Q2** — gate is unsatisfiable without destroying evidence |
| 8 | `venue-brand-colors.test.ts:81`, `public-venue-scope.test.ts:46` assert WEEX absent | ✅ both exist, at **`:76-81`** and **`:45-48`** (shifted by `d0425710`) | anchors corrected inline; <3 mismatches |
| 9 | `venue-budget-registry.ts:392/407`, `SHADOW_VENUE_BUDGETS` empty | ✅ `new Map<string, VenueBudgetEntry>()` at `:403`, zero entries. `getVenueBudget('WEEX')` → **null** | confirmed — and load-bearing (§D4) |
| 10 | 1d lane is hardcoded `--exchange-list BINANCE,BYBIT,OKX,BITGET` | ✅ live crontab, `OPS-SEED-ORCHESTRATOR-W1` block | confirmed |
| 11 | CHANGELOG/README publish a WEEX `-32602` BREAKING notice | ✅ `README.md:260` + `:267` verbatim. **And live:** `POST https://api.algovault.com/mcp` `get_trade_call{exchange:"WEEX"}` → `-32602 invalid_enum_value`, options list excludes WEEX | confirmed, currently true |
| 12 | `landing/docs.html:410/536/668` + `check-docs-samples-live.mjs:396` | ✅ all four anchors exact | confirmed |

**Fabricated primitives: 1** (`/capi/v3/market/tickers`). Below the ≥3 HALT threshold — fixed inline and flagged.
**Refuted spec premises: 2** (B6's placeholder claim; W3B's "no public funding/OI endpoints"). Both material — §D5.

---

## D1 · The cadence step-change — **`EXPLAINED-BENIGN`** (fleet-wide, two named causes, neither WEEX)

### The control the spec demanded — every venue stepped, simultaneously

Daily `signals` rows, all venues (`created_at` is epoch **seconds**; the superseded spec's ms query returns 0):

| venue | 08-29 | 08-30 | 08-31 | 09-01 | ratio 08-29→09-01 |
|---|---|---|---|---|---|
| OKX | 35 | 291 | 256 | 647 | **18.5×** |
| PHEMEX | 38 | 141 | 226 | 495 | 13.0× |
| BINGX | 68 | 196 | 280 | 707 | 10.4× |
| BITGET | 137 | 533 | 622 | 1317 | 9.6× |
| BINANCE | 99 | 533 | 521 | 846 | 8.5× |
| HTX | 78 | 144 | 210 | 605 | 7.8× |
| HL | 100 | 473 | 322 | 749 | 7.5× |
| BYBIT | 92 | 387 | 241 | 635 | 6.9× |
| KUCOIN | 137 | 316 | 691 | 885 | 6.5× |
| MEXC | 188 | 353 | 654 | 1162 | 6.2× |
| XT | 82 | 116 | 450 | 424 | 5.2× |
| GATE | 469 | 937 | 1091 | 2071 | 4.4× |
| ASTER | 176 | 305 | 536 | 709 | 4.0× |
| WHITEBIT | 83 | 81 | 131 | 305 | 3.7× |
| **WEEX** | **14** | **55** | **219** | **306** | **21.9×** |

**All 15 venues stepped in the same window, in the same direction.** WEEX's ratio is the largest only because its baseline was the smallest — the same absolute uplift is a bigger multiple on 14 rows than on 469. **Nothing about the step is WEEX-specific.**

### Hypothesis enum — resolved

| H | Verdict | Evidence |
|---|---|---|
| **H1 universe growth** | ❌ not the cause | fleet distinct-coins/day rose 321→818, but that is an *output* of more coins qualifying; WEEX's listed perp count is unchanged (1023 in v3 `exchangeInfo`) |
| **H2 shared filter change** | ✅ **PARTIAL — this is cause (b)** | see below |
| **H3 cron / lane change** | ❌ | live crontab shadow lanes unchanged: 5m top-50, 15m/30m/1h/2h/4h/8h/12h/1d top-100. WEEX's 9 active timeframes match the shadow lane exactly (3m is `--status promoted`-only, and WEEX has 0 3m rows since 07-04) |
| **H4 venue-side change** | ❌ | cannot be simultaneous on 16 unrelated venue APIs |
| **H5 MEASUREMENT ARTIFACT (default)** | ❌ **actively ruled out, not assumed** | `signals` rows are emissions, not observations. A counting change cannot move the **BUY/SELL mix** (SELL: 16 → 0 → 646 → **2712**) or **mean confidence** (58.3 → 66.6). The scorer-input capture that began `2026-08-31T10:37:58Z` writes to a *sibling* table and inserts no `signals` row. `EMIT_BOOK_LIVENESS_ENABLED=1 / MODE=enforce` has been live since **2026-08-29 03:25:45Z**, is a *suppression* gate, and moves emissions **down** |

### The two actual causes, both dated

**(a) A market event, 2026-08-30 22:00 → 08-31 02:00 UTC.** Hourly fleet rows: `08-30 22 → 314`, **`08-30 23 → 1392`**, `08-31 00 → 971`, then decaying. The burst spans **all 10 timeframes at once** with broad coin coverage and elevated confidence (59–62 vs ~57 baseline) — a backfill would be one lane, one timeframe. WEEX contributed 40 rows in each of those two hours.

**(b) `TREND_MODE=on` — an estate-wide scorer polarity change.** Measured:

- `/opt/crypto-quant-signal-mcp/.env` mtime = **`2026-08-31 09:46:35 UTC`**, line 133 `TREND_MODE=on`; live container env confirms `TREND_MODE=on`.
- The sustained fleet level-shift begins in the **very next hour** — WEEX goes `08-31 09 → 2`, `10 → 10`, `11 → 16`, and never returns to baseline.
- It is emission-affecting by construction: `src/lib/trend-mode-flag.ts:32` reads `process.env.TREND_MODE === 'on'`; `performance-db.ts:1649` — *"2 = `TREND_MODE` on — a CONFIRMED trend flips the saturated RSI region's sign"*; `:501` — *"flipping `TREND_MODE` admits a different POPULATION into this table"*.

**Verdict `D1: EXPLAINED-BENIGN`** — the step is a market event plus a deliberate, dated, estate-wide scorer change. WEEX's emission behaviour did not change; **ours did**, on every venue at once. The spec's `UNEXPLAINED ⇒ NO-GO` condition is **not** met.

### ⚠️ D1 has a consequence the spec did not anticipate — a **NEW blocker, B7**

`signals.verdict_rule_version` records which scorer wrote each row, and it splits exactly at the flip:

| WEEX population | rows | PFE WR | q (BUY share) | window |
|---|---|---|---|---|
| `verdict_rule_version = 1` (TREND_MODE **off**) | **4412** | **93.97%** | 99.12% | 06-11 → 08-31 |
| `verdict_rule_version = 2` (TREND_MODE **on**, the LIVE rule) | **782** | **87.72%** | 93.86% | 08-31 → 09-03 |

**The headline 93.43% is a blend of two different scorers, 85% of it written by one that is no longer running.** Under the rule live today WEEX scores **87.72% on 782 rows — three days of evidence.**

This is fleet-wide, not a WEEX defect — but WEEX's regression is **the largest in the fleet**:

| venue | WR v1 | WR v2 | Δ | | venue | WR v1 | WR v2 | Δ |
|---|---|---|---|---|---|---|---|---|
| **WEEX** | 93.97 | **87.72** | **−6.25** | | MEXC | 92.69 | 91.27 | −1.42 |
| KUCOIN | 91.67 | 88.99 | −2.68 | | BINGX | 94.05 | 92.52 | −1.53 |
| OKX | 93.24 | 90.75 | −2.49 | | WHITEBIT | 89.80 | 88.29 | −1.51 |
| HL | 92.13 | 89.99 | −2.14 | | BINANCE | 93.51 | 92.30 | −1.21 |
| BYBIT | 92.97 | 90.99 | −1.98 | | BITGET | 92.05 | 91.29 | −0.76 |
| GATE | 90.93 | 89.43 | −1.50 | | ASTER / HTX / XT | 82.16 / 87.28 / 87.03 | 86.40 / 88.34 / 88.92 | **+** |

WEEX still clears the SOP's `pfe_wr ≥ 0.80` bar under the live rule. But its **sample under that rule is 782**, against a `min_buy_sell_sample` bar of **7230**.

---

## D2 · Identifiability of the WR — **`IDENTIFIABLE`, and WEEX is NOT the outlier the spec expected**

Computed with the estate's own primitive — `ops/monitoring/population_comparison.py` `class Arm` (`q`, `p_star`, `excess_pp`, `attainable_pp`), **not hand-rolled**. Population = the canonical `evaluate-venues.ts:177-187` WR predicate (`signal IN ('BUY','SELL') AND pfe_return_pct IS NOT NULL AND created_at > seeding_started_at`).

### Pooled, every venue on the same predicate and the same window (since 2026-06-11)

| venue | promoted | scored | q (BUY) | p̂ (WR) | p\* (mix-matched null) | excess | attainable width | excess as % of its ceiling |
|---|---|---|---|---|---|---|---|---|
| BITMART | retired | 11298 | 99.54% | 93.76% | 92.90% | +0.86pp | 0.92pp | — |
| WHITEBIT | ✅ | 8946 | 99.42% | 89.70% | 88.69% | +1.02pp | 1.16pp | 98.2% |
| BYBIT | ✅ | 28634 | 98.99% | 92.88% | 91.00% | +1.88pp | 2.01pp | 101.6% |
| PHEMEX | ✅ | 14783 | 98.95% | 86.44% | 84.67% | +1.77pp | 2.10pp | 98.9% |
| BINANCE | ✅ | 39703 | 98.70% | 93.46% | 91.05% | +2.40pp | 2.60pp | 100.2% |
| EDGEX | shadow | 441 | 98.64% | 67.12% | 66.21% | +0.91pp | 2.72pp | — |
| KUCOIN | ✅ | 36091 | 98.38% | 91.52% | 88.60% | +2.93pp | 3.24pp | 100.5% |
| **WEEX** | **shadow** | **5196** | **98.33%** | **93.03%** | **90.06%** | **+2.97pp** | **3.35pp** | **96.9%** |
| BINGX | ✅ | 18760 | 98.25% | 93.93% | 90.73% | +3.20pp | 3.51pp | 98.8% |
| OKX | ✅ | 20028 | 98.01% | 93.09% | 89.41% | +3.68pp | 3.98pp | 101.3% |
| MEXC | ✅ | 29685 | 97.78% | 92.58% | 88.56% | +4.02pp | 4.44pp | 100.0% |
| HL | ✅ | 11701 | 97.78% | 91.90% | 87.96% | +3.94pp | 4.44pp | 98.5% |
| GATE | ✅ | 45878 | 97.12% | 90.80% | 85.76% | +5.04pp | 5.75pp | 99.4% |
| BITGET | ✅ | 26171 | 95.77% | 91.98% | 84.45% | +7.53pp | 8.46pp | 101.2% |
| XT | ✅ | 15920 | 94.28% | 87.12% | 80.85% | +6.27pp | 11.45pp | 63.9% |
| HTX | ✅ | 11528 | 91.11% | 87.39% | 75.87% | +11.52pp | 17.78pp | 78.2% |
| ASTER | ✅ | 24071 | 90.36% | 82.46% | 70.84% | +11.61pp | 19.29pp | 77.3% |

*(The ceiling is the Fréchet bound on the binarised {up, not-up} table; ~6–7% of rows have `pfe_return_pct = 0` and sit in the denominator but no win bucket, which is why a few ratios round slightly above 100%.)*

**Three findings, in order of importance.**

1. **WEEX is the 8th most one-sided venue of 17 — not the most.** Seven venues are more one-sided, **five of them live promoted venues** (WHITEBIT, BYBIT, PHEMEX, BINANCE, KUCOIN), and every one of those five has a **narrower** attainable window than WEEX's 3.35pp. The spec's B2 framing ("barely identifiable, effectively single-sided") describes the **whole estate**, not WEEX.
2. **WEEX's excess is +2.97pp — larger than BINANCE (+2.40), BYBIT (+1.88), PHEMEX (+1.77), WHITEBIT (+1.02), KUCOIN (+2.93).** By the metric the spec proposes to refuse WEEX on, WEEX beats five published venues.
3. **⚠️ The separate, larger finding the spec told me to record and not act on.** Twelve of the fourteen promoted venues sit at **98–102% of their attainable excess ceiling**. At `q > 0.9` the excess is very nearly pinned to its Fréchet maximum by the marginals alone — so *"excess over the mix-matched null"* is, across this estate, **measuring the side mix more than it measures skill**. That is an estate-wide property of a fleet emitting ~91% BUY. **Named follow-up: `OPS-FLEET-IDENTIFIABILITY-AUDIT-W{NEXT}`.** Not widened into this wave.

### Per-cluster (UTC day) — the LAW's mandated aggregation

85 clusters (every UTC day with ≥1 scored row, 06-11 → 09-03):

- pooled excess **+2.971pp**; per-day mean **+2.002pp** (sd 3.973, se 0.431), median **+0.000pp**
- **days with excess > 0: 23/85 · = 0: 62/85 · < 0: 0/85** — never negative on any day
- per-day q: median **100.00%**, min 89.29%
- **62 of 85 days have an attainable width of exactly 0.000pp** — WEEX emitted one side only, so on those days the engine *could not* deviate from its own null by any amount. They contribute a structural zero, which biases the mean **downward**; the +2.00pp is therefore conservative.

**Verdict `D2: IDENTIFIABLE` — edge `+2.971pp` pooled / `+2.002pp` per-cluster, and strictly non-negative on all 85 clusters.**
**`CI-lb` is NOT reported** — see **Q1**. A hand-computed t-interval over the 85 daily excesses gives `[+1.14, +2.86]pp`, but the estate ships no interval machinery, the same LAW forbids hand-rolling the statistics, and 62 of the 85 inputs are structural zeros rather than draws, so a t-interval is the wrong instrument for this sample. I am not publishing it as the answer.

---

## D3 · The V2 sunset — deadline **2026-09-30 (27 days)**, corroborated by two dated vendor entries

| Source | Fetched | Finding |
|---|---|---|
| `weex.com/api-doc/contract/QuickStart/LIMITS` | 2026-09-03 | version selector renders `V3` and **`V2 (Sunsets Sep 30)`** — **the year is genuinely absent from the vendor's banner**, re-confirmed today |
| `weex.com/api-doc/contract/V2/log/changelog` | 2026-09-03 | 11 entries; V2 launched **2025-02-24**, **last entry 2025-12-29**. No 2026 activity — 8 months silent |
| `weex.com/api-doc/contract/changelog` (V3) | 2026-09-03 | active through **2026-09-01** (two days ago). **`2026-03-09`: "V3 will receive ongoing maintenance while V2 is sunset."** **`2026-03-18`: "Contract Websocket V3 service officially launched; V2 will be retired and no longer maintained."** |

**Stated as an assumption, not asserted as vendor fact:** the sunset was announced in dated 2026-03 entries and the banner says "Sep 30"; **the nearest Sep 30 after those announcements is 2026-09-30**. Until the vendor publishes a year, that is the working deadline — **27 days from today**. The V2 changelog's 8-month silence and the V3 changelog's activity two days ago are consistent with it.

### v2 call-site inventory — CH2's work order (complete)

| # | Site | v2 path | v3 equivalent | probed |
|---|---|---|---|---|
| 1 | `src/lib/adapters/weex.ts:93` `getCandles` | `/capi/v2/market/candles` (7-field rows, newest-first, `granularity`) | `/capi/v3/market/klines` (**11-field Binance-shaped rows**, `interval`) | ✅ 200 |
| 2 | `src/lib/adapters/weex.ts:118` `getAssetContext` | `/capi/v2/market/ticker?symbol=` | `/capi/v3/market/ticker/24hr?symbol=` (+ `markPrice`,`indexPrice`,`openPrice`) | ✅ 200 |
| 3 | `src/lib/adapters/weex.ts:162` `getCurrentPrice` | `/capi/v2/market/ticker?symbol=` | same as #2 | ✅ 200 |
| 4 | `src/scripts/seed-signals.ts:641` `fetchWeexCoins` | `/capi/v2/market/tickers` (bulk) | **`/capi/v3/market/ticker/24hr`** (bulk, **1023 rows, 312 KB**) — *not* `/capi/v3/market/tickers`, which 404s | ✅ 200 |
| — | `src/scripts/seed-shadow-venues-w3b.ts:33` | historical `notes:` string, **not a call site** | leave untouched | see **Q2** |

**Two changes the spec's "endpoint move only, same fields" premise does not cover:**

- **Symbol convention changes.** v2 `cmt_btcusdt` → v3 **`BTCUSDT`** (`exchangeInfo.symbols[].symbol`). `toWeexSymbol`/`fromWeexSymbol` (`weex.ts:47-56`) must be rewritten, and `TRADFI_ALIASES` re-verified against the v3 list.
- **The 30m→15m and 12h→4h downgrades in `INTERVAL_MAP` (`weex.ts:33-38`) are v2 artifacts.** v3 `exchangeInfo` serves `1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, 1w` natively. Removing them changes `servedIntervalMs('WEEX', tf)` — a **behaviour change beyond the endpoint move**, which CH2's `Must NOT write` forbids. See **Q3**.

### v3 is materially better than v2 — three capabilities W3B recorded as absent

| v3 endpoint | probed | what it gives us that v2 does not |
|---|---|---|
| `/capi/v3/market/ticker/24hr` (bulk) | ✅ 200, 1023 symbols | `markPrice` · `indexPrice` · **`openPrice`** (the 24h-prior field the per-venue divergence rule exists for) · `quoteVolume` — **in ONE call**, replacing every per-symbol ticker fetch |
| `/capi/v3/market/premiumIndex` (bulk) | ✅ 200, 234 KB | `lastFundingRate` + `forecastFundingRate` for **all** symbols in one call. `weex.ts:151-157` returns `funding = 0` today on W3B's *"NO public funding/OI endpoints surfaced"* — **refuted** |
| `/capi/v3/market/openInterest?symbol=` | ✅ 200 | a single clean `openInterest` field — see D5 |

---

## D4 · The rate-limit contradiction — conservative posture adopted; **every lane fits, and the budget row is what makes it real**

**Architect ruling implemented as given:** `exchangeInfo` `rateLimits[]` = `MINUTE / 10 / 500` ⇒ **0.833 req/s** is the venue's own declared limit; the `x-used-weight-10s` header's 50 req/s is treated as a generic gateway value. Budget ≤50% ⇒ **≥2400 ms/request**. All probing in this chapter was paced at **2500 ms**.

### The ban history, with its instrument stated

`rate_limit_events` covers **2026-06-06 01:56 → 2026-09-03 09:18**, **4,134,034 rows**.

**WEEX: ZERO events. No 429, no 418, no wait, no skip — in 89 days at 300 ms.**

The instrument is proven live on the same code path, not assumed: `VENUE_FETCH_CONFIGS.WEEX = { venueName: 'WEEX', banStatuses: [418, 429] }` (`_upstream-fetch.ts:229`), and `weexGet` (`weex.ts:59-68`) routes every request through `upstreamFetch`, which calls `recordRateLimitEvent(cfg.venueName, 'throw', String(res.status), …)` at `:173`. The same path recorded **562,318** Bitmart 429s, **7,704** edgeX 429s and **1,973** OKX 429s in this window. **The zero is a real zero, not a blind instrument.**

Per the spec: this is *evidence about the limit*, and it does not override the conservative posture. An absence of bans is not a documented budget.

### The cost, computed — and it is affordable

Per symbol per timeframe the adapter makes **2 requests** today (`getCandles` + `getAssetContext`). A v3 migration collapses the second into **one bulk call per pass**.

| lane (live shadow crontab) | period | symbols | requests @ v2 | @ 2400 ms | requests @ v3 bulk | @ 2400 ms | fits? |
|---|---|---|---|---|---|---|---|
| 5m `--top 50` | 300 s | 50 | 100 | 240 s | 51 | **122 s** | ✅ |
| 15m `--top 100` | 900 s | 100 | 200 | 480 s | 101 | **242 s** | ✅ |
| 30m `--top 100` | 1800 s | 100 | 200 | 480 s | 101 | 242 s | ✅ |
| 1h / 2h / 4h / 8h / 12h / 1d `--top 100` | ≥3600 s | 100 | 200 | 480 s | 101 | 242 s | ✅ |
| *(if promoted)* 3m `--top 15` | 180 s | 15 | 30 | 72 s | 16 | **38 s** | ✅ |
| *(if promoted)* 5m `--top 30` | 300 s | 30 | 60 | 144 s | 31 | 74 s | ✅ |

**Every lane fits at 2400 ms, promoted or shadow, even without the v3 bulk collapse. WEEX is NOT an HL-class isolated-line venue.** The spec's "~240 s for a top-100 pass" is right *only* after the v3 migration; at v2 it is 480 s, which still fits every lane it runs in.

### ⚠️ But "pace at 2400 ms" is not binding today, and that is the real D4 finding

`getVenueBudget('WEEX')` returns **null** — `SHADOW_VENUE_BUDGETS` is an empty Map, so WEEX has **no cross-process budget**. Pacing is per-process only. The live cron grid overlaps lanes on the same minute (minute 1 fires shadow-5m *and* shadow-4h; minute 4 fires shadow-1h *and* shadow-1d), so **two concurrent lanes each pacing at 2400 ms deliver an effective 1200 ms** — jointly breaching the budget each independently honours. This is precisely the "two individually compliant jobs breach one shared budget" class.

**Therefore the `weexWeightBudget` row (CH3 #1) is not paperwork — it is the mechanism that makes the conservative ruling enforceable.** Recorded as blocking for any promotion.

---

## D5 · OI proxy — **`MEANINGFUL-PROXY`, and B6's stated evidence is REFUTED**

### The placeholder claim is measurably false

| symbol | `/capi/v2/market/open_interest` | `/capi/v3/market/openInterest` |
|---|---|---|
| `cmt_btcusdt` / `BTCUSDT` | `base_volume: "140229.2102"`, `target_volume: "140229.2102"` | `openInterest: "140229.2102"` |

**They are the same number.** `base_volume === target_volume` is not the signature of a placeholder — it is a v2 serializer emitting **one real OI value into two legacy field names**, which v3 renders as the single field `openInterest`. B6's premise does not survive contact with v3.

### Is it a *usable ranking*? The three tests the spec named

**(1) Distinct values across symbols — ✅.** 13/13 sampled symbols distinct, spanning `0.20` → `18,238,225,000`.

**(2) Stability across two fetches (2500 ms apart) — ✅.** Not a constant, and not noise: BTC `140229.8874` → `140229.8874` (identical); ETH `2196136.202` → `2196128.970` (−0.0003%); BTW `498808400` → `498801600` (−0.0014%); INJ `5956236.6` → `5956641.2` (+0.007%). Live drift of the right magnitude.

**(3) Plausible ordering against an independent liquidity signal — ✅.** Sample spans four decades of 24h quote volume (`$2.5B` BTW → `$2.0k` CCJ), Spearman ρ against `quoteVolume`:

| ranking metric | ρ |
|---|---|
| `openInterest` raw | **+0.747** |
| `openInterest × lastPrice` | **+0.819** |
| `openInterest × contractVal × lastPrice` | **+0.841** |

**Verdict `D5: MEANINGFUL-PROXY`.** The field ranks. **But the unit remains undeclared and does not reconcile:** BTC's OI renders as `$10.9B` under base-units and `$1.09M` under `contractVal`-notional — neither is credible for this venue, and `contractVal` spans `0.0001 → 100` across the sample. So the number is **rankable but not publishable as a magnitude.**

**Recommendation — and it is the cheaper honest one:** ship WEEX as `oiIsProxy: true` in `OI_PROXY_VENUES` (joining BINANCE/ASTER/BINGX/XT) using **`quoteVolume` from the bulk `/capi/v3/market/ticker/24hr` call we already need**, not the OI endpoint. Rationale: the OI endpoint is **per-symbol only** (`/capi/v3/market/openInterest` with no symbol → `-1141 Parameter 'symbol' cannot be empty`), so ranking 1023 symbols costs 1023 calls ≈ **41 minutes at 2400 ms**, to obtain a ranking that correlates ρ=+0.84 with a signal already arriving free in one bulk call. **`scan_trade_calls` can order WEEX. B6 is retired as a blocker.**

---

## The blocker board, re-scored

| # | Blocker (as specced) | After CH1 | Cost to clear |
|---|---|---|---|
| **B1** | published `-32602` BREAKING notice | 🛑 **STANDS — confirmed live today.** Reversal is a `RELEASE-vX.Y.Z-W1` act with integrator-facing copy, never a code wave | 1 release wave; copy drafted in CH3 |
| **B2** | WR barely identifiable | ✅ **RETIRED as a WEEX-specific objection.** WEEX is 8th of 17 in one-sidedness, its window is wider than five promoted venues', and its excess beats five of them. **Escalated** to an estate-wide finding + named follow-up | none for WEEX; `OPS-FLEET-IDENTIFIABILITY-AUDIT-W{NEXT}` for the estate |
| **B3** | unexplained ~7× cadence step | ✅ **RETIRED.** Fleet-wide; two dated causes (market event 08-30 23:00; `TREND_MODE=on` 08-31 09:46:35). H5 actively excluded | none |
| **B4** | adapter on a sunsetting path | 🛑 **STANDS, 27 days.** And it is **larger than specced** — symbol convention changes, `/capi/v3/market/tickers` does not exist | CH2 (ships regardless) |
| **B5** | 60× rate-limit contradiction | ⚠️ **DOWNGRADED to a costed decision.** Conservative 2400 ms fits every lane; 0 bans in 89 days on a proven instrument. **But** the pacing is not binding without a budget row | CH3 #1, blocking |
| **B6** | no true OI | ✅ **RETIRED — its evidence is refuted.** v3 exposes one real, distinct, stable, rank-correlated `openInterest` | none; ship volume-proxy as planned |
| **B7** | *(NEW — found in CH1)* **`TREND_MODE=on` reset the evidence base on 2026-08-31.** WEEX's WR under the live rule is **87.72% on 782 rows**, not 93.43% on 5196. Fleet-wide, but WEEX's −6.25pp is the **largest regression of any venue** | 🛑 **STANDS** | see **Q4** |

**Corrected WEEX numbers (superseding both the digest and the spec header):** days **84** (`seeding_started_at 2026-06-11 02:00Z`) · sample **5196 / 7230 = 71.87%** · blended WR **93.03%** · **live-rule WR 87.72% on 782 rows** · q **98.33%** · listed perps **1023** (stored `asset_count` 723, 42% stale) · extension budget **spent 2/2** · `review_deadline_at 2026-10-16`.

---

## CH1 recommendation — **GO-WITH-CONDITIONS, but not yet, and the wave's own CH2 is the reason it can wait**

Four of the six specced blockers fall (B2, B3, B6 outright; B5 to a costed, clearable condition). **The two that stand are not statistical — they are a published contract and a vendor deadline** — and CH1 added a seventh that is about *timing*, not merit.

**WEEX is a promotable venue whose evidence base was reset 3 days ago by our own scorer change.** Promoting now would publish a 93.43% figure that 85% of belongs to a retired scorer, and reverse a shipped BREAKING notice on 3 days of live-rule data. **Waiting costs nothing** — CH2 keeps the lane alive regardless, and the sample accrues under the live rule at ~250 rows/day.

**Recommended sequence:** ship **CH2** (unconditional, deadline-driven). Hold promotion until the `verdict_rule_version = 2` sample clears the bar, then run `OPS-WEEX-PROMOTE-W1` off CH3's audit inside a release wave that carries the B1 reversal.

**Verdicts:** `D1: EXPLAINED-BENIGN` · `D2: IDENTIFIABLE (+2.971pp pooled / +2.002pp per-cluster; CI-lb withheld, Q1)` · `D3: sunset 2026-09-30 assumed, dated corroboration` · `D4: conservative 2400 ms adopted, all lanes fit, budget row required` · `D5: MEANINGFUL-PROXY (ship as labelled volume proxy)`
