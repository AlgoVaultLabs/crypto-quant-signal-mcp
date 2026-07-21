# OPS-STRUCTURAL-FEATURE-ACCRUAL-W1 — endpoint-truth (Plan Mode, pre-C1)

**Probed:** 2026-07-21, 08:57–09:10 UTC · **Host:** 204.168.185.24 (all venue curls issued host-side — the
authoring Mac's IP is TCP-blocked by Binance/Bybit/KuCoin) · **Branch:** `ops/structural-feature-accrual-w1`
off `origin/main@f6ed070`.

**Outcome: 🛑 HALT — 6 spec-vs-reality drifts (CLAUDE.md threshold is ≥3). No state mutated.**
**One drift is dated: accrued OI history begins permanent deletion 2026-07-26 12:00 UTC.**

---

## 0 · system-map edge-touch enumeration

| Component | Produces | Consumes | Consumer tightness |
|---|---|---|---|
| `oi-snapshot-sampler` (cron `:17`) | `oi_snapshots` rows | `fetchVenueUniverse` (12 venues), `fetchCurrentOiUsd` | — |
| `oi_snapshots` | OI time series | `computeOiDelta` (get_trade_call OI factor), `computeOiDeltaForPool` (`oi_change` rankBy lens), `oiscore-shadow` | **tight** ×3 |
| `ExchangeAsset` | universe rows | `oi-sources`, `okx-funding-poller`, `rank-metrics`, `seed-signals`, `scan-funding-arb`, `backfill-funding-episodes`, `oi-snapshot-backfill` | **tight** ×7 (all explicit field copies, never spreads → additive optional fields are safe) |
| *(planned)* `structural_snapshots` | basis/spread series | B-DIR v3, carry ranker v2, AVS examples | **documented-only** (no consumer exists yet — deferred verification) |

---

## 1 · Spec primitive probes — `claim | reality | resolution`

| # | Claim (spec) | Probe | Reality | Resolution |
|---|---|---|---|---|
| 1 | "the structural feature stream the directional model has **never had**: open interest" | `psql … GROUP BY exchange` | **FALSE.** `oi_snapshots` live since **2026-06-26 12:00Z**: 318,660 rows / 58 MB / 10 venues × 71–209 syms, hourly. Last fire 2026-07-21T08:00Z wrote 600 rows, all 12 venues attempted, 0 errors | HALT → **Q1**. Widen the live stream, do not duplicate it |
| 2 | Retention "permanent (INTERNAL training data)" | `printenv \| grep RANK_OI` | `RANK_OI_RETENTION_H` **unset in prod** → sampler default 720 h. `pruneOiSnapshots` runs every hour. Oldest row 2026-06-26 12:00Z ⇒ **first permanent deletion 2026-07-26 12:00 UTC** | HALT → **Q2**. Dated, 5 days out |
| 3 | "Spot refs: reuse **the carry lane's spot-price path** where quotable" | `git grep -in spot -- src/`; `information_schema.columns` | **FICTIONAL.** No spot-price path exists. All 17 adapters are perps-only; `ExchangeAdapter` exposes `getCandles/getAssetContext/getPredictedFundings/getFundingHistory/getCurrentPrice/getName` — no spot method. `funding_history` = `(id, coin, funding_rate, recorded_at)`. Every `spot` hit in `src/` is a **symbol-alias comment** (GOLD→XAU etc.), not an endpoint | HALT → **Q3**. Basis must use venue-native index/oracle price |
| 4 | R3 "retro-backfill … probe per-venue OI-history endpoints; Binance-family `openInterestHist`-class (~30 d)" | `git ls-tree src/scripts` | **ALREADY BUILT.** `src/scripts/oi-snapshot-backfill.ts` + `fetchOiHistoryUsd()` in `src/lib/oi-sources.ts` — Binance `futures/data/openInterestHist`, Bybit `v5/market/open-interest` × hourly close. OKX/Bitget/HL documented warm-forward | R3 = re-run + coverage report, **not new code** |
| 5 | New table `structural_snapshots`, PK `(venue, symbol, ts)` | `pg_tables`; `pg_indexes` | Table **absent** ✅ (DDL absence confirmed). But `oi_snapshots` PK is `(exchange, symbol, ts)` — the *same key*. A second table ⇒ a second OI derivation, contradicting `oi-snapshots.ts`'s stated contract *"This is the ONLY OI fetcher"* | HALT → **Q6**. Widen + expose a view |
| 6 | Cadence "hourly at `:37`" | `crontab -l` (70 lines) | `:37` hourly is **free** (only `37 4 * * 0` carry-retrain and `37 5 * * 1` feature-registry-drift, both weekly host-side). But a 2nd hourly universe pass ≈ **2× venue load** for ~90 % duplicative data. Existing sampler is `17 * * * * … oi-snapshot-sampler.js` | HALT → **Q1**. Keep `:17`, one pass |
| 7 | Pre-registered dates assume the clock starts today | derived | OI's clock **already started 2026-06-26** (25 days banked); basis/spread would start today | → **Q7**. Spec's dates stand if anchored on the new class |

### Primitives that probed CLEAN (no drift)

| Primitive | Probe | Result |
|---|---|---|
| Pacing budgets exist for all 12 promoted venues | read `src/lib/venue-budget-registry.ts` | ✅ `VENUE_BUDGETS: Record<PromotedVenueId, VenueBudgetEntry>` is **exhaustive** (tsc-enforced). *Corrects a stale note claiming only the original 5 were budgeted — fixed by OPS-TELEMETRY-DIGEST-REFRAME-W1.* |
| Live budget headroom | `/var/log/oi-sampler.log` | ✅ HTX window at the `:17` fire: `used:114 waits:0 skips:0 throws:0` (ceiling 24000) |
| Storage headroom | `df -h /`; `pg_database_size` | ✅ 205 GB free; DB 8.6 GB; `oi_snapshots` 58 MB |
| `src/scripts/` entry-point-guard convention | read sampler | ✅ `if (require.main === module) void runScript(...)` — CJS, matches CLAUDE.md |
| DDL idempotency idiom | read `oi-snapshots.ts` | ✅ `ADD COLUMN IF NOT EXISTS` (Postgres-only; matches `migrations/020`) + lazily-ensured fresh-box path |
| Universe fetch is shared/cached | read `exchange-universe.ts` | ✅ 60 s TTL coalesced cache — the sampler's per-venue bulk call is already paid for |

---

## 2 · R1 venue census — mark / index / bid / ask availability

Method: `curl | jq -c '<path> | keys'` on the **exact bulk endpoint each venue's universe fetcher already
calls hourly** (structural pre-check per CLAUDE.md), then targeted probes for the gaps. Zero assumed rows.

| Venue | Bulk endpoint already fetched at `:17` | mark | index (basis ref) | bid | ask | Extra calls to close |
|---|---|:--:|:--:|:--:|:--:|---|
| HL | `POST info {metaAndAssetCtxs}` | `markPx` | `oraclePx` | `impactPxs[0]` | `impactPxs[1]` | **0** (also ships native `premium`) |
| BYBIT | `v5/market/tickers?category=linear` | `markPrice` | `indexPrice` | `bid1Price` | `ask1Price` | **0** (also ships native `basis`,`basisRate`,`basisRateYear`) |
| BITGET | `api/v2/mix/market/tickers?productType=USDT-FUTURES` | `markPrice` | `indexPrice` | `bidPr` | `askPr` | **0** |
| GATE | `api/v4/futures/usdt/tickers` | `mark_price` | `index_price` | `highest_bid` | `lowest_ask` | **0** |
| MEXC | `api/v1/contract/ticker` | `fairPrice` | `indexPrice` | `bid1` | `ask1` | **0** |
| OKX | `v5/market/tickers?instType=SWAP` | — | — | `bidPx` | `askPx` | **+2** · `v5/public/mark-price?instType=SWAP` → `markPx` · `v5/market/index-tickers?quoteCcy=USDT` → `idxPx` (862 rows) |
| KUCOIN | `api/v1/contracts/active` | `markPrice` | `indexPrice` | — | — | **+1** · `api/v1/allTickers` → `bestBidPrice`/`bestAskPrice` (670 rows) |
| PHEMEX | `md/v2/ticker/24hr/all` | `markPriceRp` | `indexPriceRp` | — | — | **+1** · `md/v3/ticker/24hr/all` → `bidRp`,`askRp`,`markRp`,`indexRp` (478 rows — v3 carries all four) |
| BINANCE | `fapi/v1/ticker/24hr` | — | — | — | — | **+2** · `fapi/v1/premiumIndex` → `markPrice`,`indexPrice` · `fapi/v1/ticker/bookTicker` → `bidPrice`,`askPrice` |
| HTX | `linear-swap-ex/market/detail/batch_merged` | — | — | `bid` | `ask` | **+1** · `linear-swap-api/v1/swap_index` → `index_price` (268 rows). **No bulk mark endpoint found → `mark_price` NULL, counted** |
| ASTER † | `fapi/v1/ticker/24hr` | — | — | — | — | **+2** · `fapi/v1/premiumIndex` ✅ live · `fapi/v1/ticker/bookTicker` (Binance-compatible) |
| BINGX † | `openApi/swap/v2/quote/ticker` | — | — | `bidPrice` | `askPrice` | **+1** · `openApi/swap/v2/quote/premiumIndex` → `markPrice`,`indexPrice` ✅ live |

† ASTER and BINGX are currently skipped **entirely** by `fetchCurrentOiUsd` (`OI_PROXY_VENUES` — their
`notionalOI_usd` is a 24 h-volume proxy, never real OI). They remain basis/spread-capable → **Q4**.

**Free today: 5 of 12 venues complete (HL, BYBIT, BITGET, GATE, MEXC); 7/12 have mark+index; 8/12 have bid+ask.**
**Cost to close every remaining cell: 10 bulk calls/hour**, all via `upstreamFetch` under existing budgets —
against a Path-B design that would repeat all 12 universe fetches *plus* Binance's 60-symbol
`openInterestHist` fan-out every hour.

---

## 3 · Derivations (proposed — pending Q3)

```
basis_bps  = (mark − index) / index × 10_000     // NULL if either side missing
spread_bps = (ask  − bid)   / ((ask+bid)/2) × 10_000   // NULL if either side missing
```

Never fabricated: a venue exposing neither side yields NULL and is **counted** in the coverage table.
Venue-native pre-computed values (Bybit `basisRate`, HL `premium`) are *not* substituted — one derivation,
applied uniformly, per the single-derivation LAW; the native fields serve as a cross-check only.

---

## 4 · Side-findings (flagged, not actioned)

| Finding | Evidence | Impact |
|---|---|---|
| Duplicate index on `oi_snapshots` | `oi_snapshots_pkey` and `idx_oi_snapshots_exch_sym_ts` are both `btree (exchange, symbol, ts)` — byte-identical | ~½ the table's index storage wasted; matters more once retention goes permanent → **Q8** |
| No `(exchange, ts)` index | `pg_indexes` | `computeOiDeltaForPool` filters `exchange=$1 AND ts>=$2` with no symbol predicate; the `(exchange,symbol,ts)` btree cannot range-scan `ts`, so the read degrades linearly once the prune is off → bundled into **Q2(b)** |

---

## 5 · Blocking questions

The architect Q-set (Q1–Q8, with recommended answers) is carried verbatim in the wave's plan file and was
surfaced to Mr.1 as a single copy-paste block. **No DDL, no cron edit, no commit, no push until answered.**
