# OPS-BINANCE-POLITE-DELAY-W1 — Endpoint-Truth Audit (Plan-Mode Step 0)

**Wave:** OPS-BINANCE-POLITE-DELAY-W1 — Reduce Binance per-IP weight usage from 78% → < 50% sustained.
**Plan-Mode probe time:** 2026-05-22 13:20-13:30 UTC (~80-90 min after Cowork's 12:00 UTC reading).
**Status:** HALT for architect ratification of fix path.

---

## Summary

- **Live weight observed RIGHT NOW** (idle-minute sampling): 1043-1560 / 2400 cap = 43-65%, decaying.
- **Recent burst (within last 60 min)**: 37 in-adapter `[Binance] Rate limit warning` logs all clustered between **13:13:58.250 → 13:13:59.951** (a 1.7-second concurrent-fire event) at weight 1835-1846 / 2400 = 76-77%. Matches Cowork's 78% spec reading.
- **Root cause = three-layered**: (a) per-coin `getAssetContext` issues **3 separate per-symbol calls** (premiumIndex@symbol + openInterest@symbol + ticker/24hr@symbol) where bulk versions of premiumIndex (weight 10) AND ticker/24hr (weight 40) exist; (b) **two separate full-universe `ticker/24hr` callers** (`seed-signals.fetchBinanceCoins` + `exchange-universe.fetchBinance`) within ONE node process, neither coalesced; (c) **cron burst-stacking** at minute boundaries (especially :02 where 5m+1h fire concurrently, :04/:19/:34/:49 where 15m fires, :07/:37 where 30m+5m overlap).
- **Projected top-50 risk for W2-PART-B**: NEW 3m top-50 cron adds ~97 weight/min average. Plus burst stacking with existing 5m+15m+30m+1h cycles at minute boundaries — pushes peak weight over 2400 cap during overlap windows.

**Recommended ratification: Path R4 (hybrid)** — adapter-layer bulk-coalescing for both `/fapi/v1/premiumIndex` (weight 10) and `/fapi/v1/ticker/24hr` full-universe (weight 40), 60s TTL each + inflight Map (mirroring OPS-HL-RATELIMIT-W1 pattern), refactor per-coin `getAssetContext` to read from caches, PLUS polite-delay bump 200→400ms for burst-spreading. Projected per-fire weight: top-50 5m fire 290 → 200 (-31%); top-100 15m fire 540 → 350 (-35%). New steady state with PART-B: top-50 3m fire at 200 weight × 20 fires/hour = 67 weight/min average, well below cap.

---

## A. Binance official policy

### A1. Per-IP weight cap (live exchangeInfo)

```bash
$ curl -sS 'https://fapi.binance.com/fapi/v1/exchangeInfo' | jq '.rateLimits'
```

```json
[
  { "rateLimitType": "REQUEST_WEIGHT", "interval": "MINUTE", "intervalNum": 1, "limit": 2400 },
  { "rateLimitType": "ORDERS", "interval": "MINUTE", "intervalNum": 1, "limit": 1200 },
  { "rateLimitType": "ORDERS", "interval": "SECOND", "intervalNum": 10, "limit": 300 }
]
```

**Confirmed: 2,400 weight per IP per fixed-minute window.** ORDERS limits don't apply (AlgoVault uses read-only endpoints).

### A2. Window semantics — FIXED-MINUTE, NOT ROLLING 60s

Sampled `x-mbx-used-weight-1m` 5 times over 60s via SSH:

| UTC time | Sec into minute | Weight reading | Notes |
|---|---|---|---|
| 13:23:37.843 | 37 | 1256 | mid-minute of :23 |
| 13:23:50.412 | 50 | 1460 | growing in minute :23 |
| 13:24:03.385 | 3 | **2** | **RESET at minute boundary** — our ping was first call in :24 |
| 13:24:16.268 | 16 | 1043 | +1041 weight in ~13s of minute :24 |
| 13:24:28.875 | 28 | 1224 | continuing in minute :24 |

**Critical insight: Binance uses FIXED 1-minute windows that reset at the top of each clock minute, NOT a rolling 60s.** This makes burst-at-minute-boundary the worst risk pattern.

### A3. Per-endpoint weight inventory (WebFetch + practical probe)

Sourced from `https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/<endpoint>`:

| Endpoint | With symbol | Without symbol (full universe) | Notes |
|---|---|---|---|
| `/fapi/v1/ticker/24hr` | **1** | **40** | 746-element response when no symbol |
| `/fapi/v1/premiumIndex` | **1** | **10** | 746-element response when no symbol (live-probe confirmed: pre→post weight delta = 10) |
| `/fapi/v1/openInterest` | **1** | **N/A — no bulk endpoint** | Must call per-symbol |
| `/fapi/v1/klines` | **1** for `limit∈[1,100)`; **2** for `[100,500)`; **5** for `[500,1000]`; **10** for `>1000` | n/a (symbol required) | Adapter uses `limit=200` → weight **2** |
| `/fapi/v1/fundingRate` | typical 1-5 | n/a | Adapter uses `limit=1000` for history; weight depends on docs (not load-bearing in this wave) |
| `/fapi/v1/ping` | 1 | n/a | Used as zero-cost weight-header probe |

**Header name**: canonical case is `x-mbx-used-weight-1m` (HTTP headers case-insensitive; `res.headers.get(...)` works either case). The spec's R4 verification command uses `X-MBX-USED-WEIGHT-1M` which works fine via `res.headers.get()`.

---

## B. AlgoVault Binance consumer enumeration

### B1. Grep — all Binance call sites in `crypto-quant-signal-mcp/src/`

```bash
$ grep -rn "fapi\.binance\.com\|BinanceAdapter\|fetchBinanceCoins\|fetchBinance" src/
```

| Caller | File:line | Endpoint | Per-call weight | Fire frequency |
|---|---|---|---|---|
| `fetchBinanceCoins(topN)` | `src/scripts/seed-signals.ts:395-409` | `/fapi/v1/ticker/24hr` (NO symbol → full universe) | **40** | 1× per seed fire (5m/15m/30m/1h/2h/4h/8h/12h/1d) ≈ 25 fires/day |
| `exchange-universe.fetchBinance(limit)` | `src/lib/exchange-universe.ts:80-95` | `/fapi/v1/ticker/24hr` (NO symbol → full universe) | **40** | Via `isMemeCoinLiquid(coin, BINANCE)` per-coin path; gated by 1-hour cache TTL (asset-tiers.ts:113 `CACHE_TTL_MS = 3_600_000`) ⇒ ~1×/hour cold-start fires + per-boot `warmTierCaches()` |
| `BinanceAdapter.getCandles(coin, tf, t)` | `src/lib/adapters/binance.ts:152-172` | `/fapi/v1/klines?symbol=X&limit=200` | **2** | Per-coin during seed fires + per-coin during backfill-outcomes (every 3 min) |
| `BinanceAdapter.getAssetContext(coin)` | `src/lib/adapters/binance.ts:174-196` | **3 parallel calls per coin**: premiumIndex@symbol + openInterest@symbol + ticker/24hr@symbol | **1+1+1 = 3** | Per-coin during seed fires + per-coin agent-driven `get_trade_call` |
| `BinanceAdapter.getPredictedFundings()` | `src/lib/adapters/binance.ts:198-212` | `/fapi/v1/premiumIndex` (NO symbol → bulk) | **10** | Used by `scan_funding_arb` MCP tool — low-frequency, on-demand |
| `BinanceAdapter.getCurrentPrice(coin)` | `src/lib/adapters/binance.ts:237-244` | `/fapi/v1/premiumIndex?symbol=X` | **1** | Used by backfill-outcomes evaluator + other consumers |
| `monitor.ts` | `src/scripts/monitor.ts:306` | `/fapi/v1/ping` | **1** | Health check; once per monitor cycle |

### B2. Per-fire weight breakdown — current state

**Top-50 fire (5m, 1h, 2h, 4h, 8h, 12h, 1d)**:

| Component | Calls | Weight per call | Subtotal |
|---|---|---|---|
| 1× fetchBinanceCoins (full universe ticker/24hr) | 1 | 40 | **40** |
| 50× getAssetContext.premiumIndex@symbol | 50 | 1 | **50** |
| 50× getAssetContext.openInterest@symbol | 50 | 1 | **50** |
| 50× getAssetContext.ticker24hr@symbol | 50 | 1 | **50** |
| 50× getCandles.klines@200 | 50 | 2 | **100** |
| **Total per top-50 fire (burst over 10s with 200ms delay)** | — | — | **290 weight in ~10s** |

**Top-100 fire (15m, 30m)**:

| Component | Calls | Weight per call | Subtotal |
|---|---|---|---|
| 1× fetchBinanceCoins | 1 | 40 | **40** |
| 100× premiumIndex@symbol | 100 | 1 | **100** |
| 100× openInterest@symbol | 100 | 1 | **100** |
| 100× ticker24hr@symbol | 100 | 1 | **100** |
| 100× klines@200 | 100 | 2 | **200** |
| **Total per top-100 fire (burst over 20s with 200ms delay)** | — | — | **540 weight in ~20s** |

### B3. Cache TTLs (in-process)

- `isMemeCoinLiquid` per-exchange cache: `CACHE_TTL_MS = 3_600_000` (1 hour) — `src/lib/asset-tiers.ts:113`. Cold-start fires ONE `getExchangeTopAssetsWithVolume(BINANCE, 50)` (weight 40) per hour per process. NOT a per-fire problem.
- `getTop20ByOI` cache: 1 hour TTL — HL-only, not Binance.
- `XYZ_CACHE_TTL` HL symbols: 1 hour — HL-only.
- **`BinanceAdapter` adapter-layer caching: NONE** — every `getAssetContext` call hits Binance fresh; every `fetchBinanceCoins` call hits Binance fresh. This is the gap vs HL post-OPS-HL-RATELIMIT-W1.

---

## C. Redundancy audit

### C1. Full-universe `ticker/24hr` callers (weight 40 each)

| Caller | Triggers | Coalescing? |
|---|---|---|
| `seed-signals.fetchBinanceCoins` | 1× per Binance seed fire | NONE |
| `exchange-universe.fetchBinance` (via isMemeCoinLiquid) | 1× per hour per BINANCE gate cold-start | NONE — separately reads the same data |
| `BinanceAdapter.getAssetContext` per-coin `ticker24hr@symbol` | 50-100× per fire | NONE — but could be replaced by ONE cached full-universe read (single 40-weight call covers all 50-100 coins instead of 50-100 × 1 = 50-100 weight) |

**Redundancy**: At minute :02 of every hour, fetchBinanceCoins (40 weight) AND the 5m fire's 50 per-coin ticker24hr@symbol (50 weight) BOTH fetch ticker data — total 90 weight. If isMemeCoinLiquid cache happens to expire at the same time, add another 40 → 130 weight on ticker data alone. A single cached full-universe fetch covers all three at 40 weight = saves up to 90 weight per burst.

### C2. Per-coin `getAssetContext` redundancy

`getAssetContext(coin)` issues **3 separate per-symbol calls** in parallel: premiumIndex@symbol (1) + openInterest@symbol (1) + ticker/24hr@symbol (1) = 3 weight per coin.

- `premiumIndex@symbol` could be served from a 60s-TTL cache of bulk `/fapi/v1/premiumIndex` (weight 10 for ALL 746 perps). Saves up to **(50-100)×1 - 10 = 40-90 weight per fire**.
- `ticker24hr@symbol` could be served from the same 60s-TTL cache of bulk `/fapi/v1/ticker/24hr` (weight 40 for ALL 746 perps). At 50-100 coins per fire: 50-100 weight → 0 (cache hit on existing fetchBinanceCoins read). Saves **40-90 weight per fire**.
- `openInterest@symbol` has **NO bulk endpoint** — Binance does not provide aggregated OI like Bybit or OKX. Must remain per-symbol.

### C3. `getAssetContext` weight after R4 (top-50 5m fire)

| Component | Pre-fix | Post-fix R4 |
|---|---|---|
| fetchBinanceCoins (full universe) | 40 | 40 (first call; populates cache for the burst) |
| premiumIndex@symbol → bulk-cache lookup | 50 | 10 (one bulk fetch at start of fire, cached for 60s) |
| openInterest@symbol (no bulk endpoint) | 50 | 50 |
| ticker24hr@symbol → bulk-cache lookup | 50 | 0 (read from full-universe cache populated by fetchBinanceCoins) |
| klines@200 (no aggregation opportunity) | 100 | 100 |
| **Total per top-50 5m fire** | **290** | **200 (-31%)** |

For top-100 15m fire: 540 → 350 (-35%).

---

## D. Live header probe

### D1. Single full-universe ticker/24hr — initial probe

```
{"status":200,"w1m":"1560","w1mLower":"1560","weightHeaders":{"x-mbx-used-weight-1m":"1560"}}
```

**1560 / 2400 = 65%**. Matches Cowork's spec range (78% reading was high-water mark; current is lower but still well above safe headroom).

### D2. 5-sample weight series (above, §A2)

Minute-boundary reset confirmed. Bursts inside minutes can grow 1000+ weight in 13-16 seconds.

### D3. Bulk premiumIndex probe (to validate weight cost in practice)

```
{"status":200,"weight_after":"1625","response_array_length":746}
```

Pre-call weight ~1615, post-call 1625 → **weight cost 10 confirmed via live delta**. 746-symbol response matches full-universe coverage.

### D4. Adapter "Rate limit warning" log

`binance.ts:96` warns when `x-mbx-used-weight-1m > 1800`. Sampled the last 60 min:

```
[Binance] Rate limit warning: 1835/2400 weight used   2026-05-22T13:13:58.250543653Z
[Binance] Rate limit warning: 1838/2400 weight used   2026-05-22T13:13:58.360926636Z
[Binance] Rate limit warning: 1837/2400 weight used   2026-05-22T13:13:58.363184319Z
... 31 more lines, all between 13:13:58.250 and 13:13:59.951 ...
[Binance] Rate limit warning: 1845/2400 weight used   2026-05-22T13:13:59.950663707Z
[Binance] Rate limit warning: 1846/2400 weight used   2026-05-22T13:13:59.951893593Z
```

**37 warnings in a 1.7-second window at 13:13:58-59.** All ~37 in-flight Binance calls observed weight in the 1835-1846 range as the response wave returned. Single concurrent-burst event, not 37 separate events.

### D5. 429 / UpstreamRateLimitError grep — last 60min

```
$ docker logs ... --since 60m | grep -ciE "binance.*429|UpstreamRateLimitError.*Binance"
37
```

Likely same burst — when 1835+ weight peaked, subsequent calls inside that minute would have hit 429. Bursts at minute boundaries are the active failure mode.

---

## E. Concurrent execution audit

### E1. Cron-firing enumeration — Binance entries

```
$ crontab -l | grep -v "^#" | grep -E "BINANCE|seed-signals" | grep -c BINANCE
9 timeframe lines × ~1 line each
```

| Cron | Minutes | Top | Weight per fire | Fires/hour |
|---|---|---|---|---|
| 5m BINANCE | 2,7,12,17,22,27,32,37,42,47,52,57 | 50 | 290 | 12 |
| 15m BINANCE | 4,19,34,49 | 100 | 540 | 4 |
| 30m BINANCE | 7,37 | 100 | 540 | 2 |
| 1h BINANCE | 2 | default 50 | 290 | 1 |
| 2h BINANCE | 32 (of even hours) | default 50 | 290 | 0.5 |
| 4h BINANCE | 12 (of 0,4,8,12,16,20) | default 50 | 290 | 0.25 |
| 8h BINANCE | 42 (of 0,8,16) | default 50 | 290 | 0.125 |
| 12h BINANCE | 52 (of 0,12) | default 50 | 290 | 0.083 |
| 1d BINANCE | 22 (of 0) | default 50 | 290 | 0.042 |
| backfill-outcomes | every 3 min | (per signal × candles@2) | varies | 20 |

### E2. Minute-boundary overlap windows

| Minute | Concurrent Binance fires | Combined weight (within ~20-30s of minute boundary) |
|---|---|---|
| **:02** | 5m (290) + 1h (290) | **580** |
| **:32** | 5m (290) + 2h (290, every 2h) | **580** (every 2h) |
| **:04, :19, :34, :49** | 15m (540) — solo | 540 |
| **:07, :37** | 5m (290) + 30m (540) | **830** |
| **:12** | 5m (290) + 4h (290, every 4h) | **580** (every 4h) |
| **:22** | 5m (290) + 1d (290, daily at 00:22) | **580** (once per day) |
| **:42** | 5m (290) + 8h (290, every 8h) | **580** (every 8h) |
| **:52** | 5m (290) + 12h (290, every 12h) | **580** (every 12h) |

**Worst case (rare): minute :07 of hour 0** (or 30-min-aligned hours) — 5m + 30m = 830 weight in ~30s. With backfill-outcomes (also firing every 3 min) overlapping, easy 1000+ weight spike at minute :07.

**The 13:13:58 burst observation** — minute :13 has no scheduled Binance cron; the spike came from backfill-outcomes (fires every 3 min, e.g. :12 or :15) processing Binance signals via `BinanceAdapter.getCandles` (weight 2 each) PLUS lingering load from prior :12 5m BYBIT (unrelated to Binance weight) or :09 prior fires. So unscheduled-minute bursts are agent-driven `/mcp` calls + backfill-outcomes — NOT just the cron schedule. The 60s polite-delay budget is being shared across cron + backfill + agent traffic.

### E3. Box-mate Binance consumers

```
$ docker ps --format "{{.Names}}"
crypto-quant-signal-mcp-mcp-server-1
crypto-quant-signal-mcp-postgres-1
crypto-quant-signal-mcp-facilitator-1

$ grep -rln -iE "binance|fapi\.binance" /opt/ | grep -v node_modules | grep -v "\.log" | grep -v "/dist/"
... only /opt/crypto-quant-signal-mcp/ hits (own repo, landing pages, audits) ...
```

**No box-mate Binance consumers.** AOE host is a separate VPS (not Hetzner mcp-server). algovault-bot runs in the same container but reads via `/mcp` loopback — its Binance call rate is already counted in agent-driven `getAssetContext` traffic above.

---

## F. Polite-delay current state

### F1. `DELAY_PER_EXCHANGE.BINANCE`

`src/scripts/seed-signals.ts:55-117`:

```typescript
const DELAY_PER_EXCHANGE: Record<ExchangeId, number> = {
  'HL':      750,  // ← bumped 500→750 in OPS-HL-RATELIMIT-W1
  'BINANCE': 200,  // generous rate limits ← CURRENT (per spec F13)
  'BYBIT':   200,
  'OKX':     150,
  'BITGET':  200,
  ...
};
```

**Confirmed: 200ms current value.**

### F2. Polite-delay arithmetic — top-50 fire

200ms × 50 coins = 10s burst window. With 3 parallel `getAssetContext` calls per coin (premiumIndex + openInterest + ticker24hr fired via `Promise.all`), peak concurrency = 3 in-flight Binance HTTPS calls at any instant. 290 weight in 10s = **average 1740 weight/min rate during the burst** — close to the 2400 cap.

Bump to 400ms: 400 × 50 = 20s burst window. Same 290 weight spread over 2× wider window. Peak rate halved to **870 weight/min during the burst**.

Bump to 600ms: 600 × 50 = 30s burst. Average 580 weight/min during burst.

200ms × 100 coins (15m top-100) = 20s burst, 540 weight → **1620 weight/min**.
400ms × 100 = 40s burst, 540 weight → 810 weight/min.

**Polite-delay alone (Path R2)** spreads bursts but does NOT reduce per-fire weight. If two fires overlap at a minute boundary, longer polite-delay actually INCREASES overlap risk because the first fire runs into the second. Only useful when paired with coalescing.

---

## G. Identifier diff

Spec primitives cross-checked against live state. Columns: **claim** | **reality** | **resolution**.

| Identifier | Spec claim | Live reality | Resolution |
|---|---|---|---|
| Hostname | `fapi.binance.com` (futures API) | `https://fapi.binance.com` matches adapter `BASE_URL` | ✅ match |
| Per-IP weight cap | 2,400 per min | exchangeInfo confirms 2400/min | ✅ match |
| Weight: `/fapi/v1/ticker/24hr` no-symbol | spec §A1 implies 40 | WebFetch confirms **40** | ✅ match |
| Weight: `/fapi/v1/ticker/24hr` w/ symbol | spec §A1 implies 1 | WebFetch confirms **1** | ✅ match |
| Weight: `/fapi/v1/premiumIndex` no-symbol | spec assumes ~10 | WebFetch confirms **10**; live delta-probe confirms 10 | ✅ match |
| Weight: `/fapi/v1/premiumIndex` w/ symbol | n/a | 1 | additional finding |
| Weight: `/fapi/v1/openInterest` w/ symbol | n/a | 1 (no bulk endpoint) | additional finding |
| Weight: `/fapi/v1/klines` limit=200 | n/a | 2 (range [100, 500)) | additional finding |
| Header name (weight) | `X-MBX-USED-WEIGHT-1M` | canonical case is `x-mbx-used-weight-1m` (case-insensitive HTTP) | ✅ equivalent — `res.headers.get()` resolves both |
| Container name | `crypto-quant-signal-mcp-mcp-server-1` | live `docker ps` confirms | ✅ match |
| `DELAY_PER_EXCHANGE.BINANCE` current value | spec §F13 claims 200ms | confirmed at `seed-signals.ts:63` | ✅ match |
| `/var/log/seed-binance.log` | spec implies path | confirmed in crontab routing | ✅ match |
| Adapter file path | spec §R2 cites `src/lib/adapters/binance.ts` | exists, matches HL pattern at hyperliquid.ts | ✅ match |
| Cowork-cited 78% reading | At 12:00 UTC | Current 13:25 UTC: 43-65% (decayed); 13:13:58 burst hit 76-77% | ✅ consistent — 78% was burst peak, not steady |
| Cowork-cited 4700 / 196% projection at top-50 | n/a explicit method | Probable assumption: all 5 venues concurrent at top-50 every cycle. Real cron schedule serializes — actual top-50 PART-B projection: 200 weight × 20 fires/hour = 67 weight/min average post-R4. Burst overlap (worst case :07 of 0h, 0,8,16h with 5m+30m+backfill) ~830-1000 weight in 30s = manageable post-fix. Spec's 196% is a worst-imagined-case, NOT measured. | ⚠️ flagged — spec's projection methodology not documented; real projection is bounded by per-minute cron schedule |
| fetchBinanceCoins call shape | spec §A1 implies single full-universe fetch | confirmed `seed-signals.ts:396` | ✅ match |
| `isMemeCoinLiquid` cache TTL | n/a | `CACHE_TTL_MS = 3_600_000` (1h) — `asset-tiers.ts:113` | additional finding; protects fetchBinance from per-fire firing |

**Identifier diff verdict: 0 fictional primitives.** Spec's projection methodology for "4700/196%" is the only soft point — not a primitive, but worth flagging.

---

## H. Fix-path options

### Path R1 — Adapter-layer full-universe `ticker/24hr` coalescing only

- Add `getTicker24hrFullCoalesced()` in `src/lib/adapters/binance.ts` (60s TTL `Map` + inflight Map, dex-agnostic).
- Refactor `getAssetContext` to read prevDayPx + quoteVolume from cache instead of per-coin ticker/24hr.
- Refactor `fetchBinanceCoins` (seed-signals.ts) AND `fetchBinance` (exchange-universe.ts) to call the coalescer.
- **Weight savings per top-50 fire**: 290 → 240 (ticker24hr@symbol 50 → 0; -50 weight). **-17%**.
- **Top-100 fire**: 540 → 440 (-19%).
- **Cleanest single change**, but burst peak still 240 weight in ~10s → 1440 weight/min during burst = 60% of cap. Not enough headroom for PART-B top-50.

### Path R2 — Polite-delay bump 200 → 400ms

- 1 line change in `seed-signals.ts:63`.
- **No per-fire weight reduction** — only spreads the same load over more time.
- Bursts spread 10s → 20s; rate halved during burst.
- 50-coin fire still consumes 290 weight per fire (unchanged).
- Doesn't help backfill-outcomes (which doesn't use the seed-signals delay) or agent traffic.
- **Insufficient alone** — at top-50 PART-B 3m cadence, 400ms × 50 = 20s burst per fire × 20 fires/hour = 6.7 min/hour spent in burst window. With current 200ms 12 fires/hour 5m + 4 fires/hour 15m it's already too much overlap.

### Path R3 — Switch all per-coin Binance endpoint reads to bulk-coalesced reads

- Same as R1 but extended to include `premiumIndex@symbol` → bulk premiumIndex (weight 10).
- Add `getPremiumIndexBulkCoalesced()` to adapter.
- Refactor `getAssetContext` to read funding + markPrice from premiumIndex bulk cache.
- `openInterest@symbol` remains per-symbol (no bulk endpoint).
- **Weight savings per top-50 fire**: 290 → 200 (premiumIndex@symbol 50 → 10 saved 40; ticker24hr@symbol 50 → 0 saved 50; -90 weight). **-31%**.
- **Top-100 fire**: 540 → 350 (-35%).

### Path R4 — Hybrid (R3 + polite-delay bump 200→400ms) [RECOMMENDED]

- All of R3.
- PLUS polite-delay bump 200→400ms.
- **Weight per fire same as R3** (200 weight top-50 / 350 weight top-100).
- **Burst window spread to 2×** — peak weight rate during burst halved.
- Mirrors OPS-HL-RATELIMIT-W1's actual fix (coalescing + polite-delay bump in same wave; defense-in-depth).
- Top-50 5m fire: 200 weight over 20s burst = **600 weight/min during burst** (25% of cap).
- Top-100 15m fire: 350 weight over 40s burst = **525 weight/min during burst**.
- New PART-B top-50 3m cron at 200 weight × 20 fires/hour = 67 weight/min average. Burst windows still <30% of cap.

### Path R5 — Escalation if R1-R4 insufficient

If, after R4 deploy + 30-min verification, weight still > 60% sustained or 429s persist:
- Add cross-process Redis coalescing (Redis SETEX `binance:ticker24hr:full` 60s TTL; all node processes read from Redis first).
- OR introduce request-budget rate limiter (token-bucket — separate `OPS-BINANCE-RATELIMITER-W2`).
- Mr.1 dispatches heavier wave with same diagnostic format.

---

## I. Plan-Mode conclusion — recommended fix path

**Path R4 (R3 hybrid + polite-delay bump).** Reasoning:

1. **R3 is mechanically analogous to OPS-HL-RATELIMIT-W1's coalescing pattern** at `src/lib/adapters/hyperliquid.ts:34-67`. Same shape (60s TTL `Map<string, MetaCacheEntry>` + inflight `Map<string, Promise>` + test seam). Code-pattern reuse is proven safe.
2. **R3 alone delivers -31% per-fire weight reduction** — comfortably below the spec's <50% sustained and <90% projected gates.
3. **Polite-delay bump 200→400ms** is a 1-line low-risk addition that spreads bursts at minute boundaries — defense-in-depth against unscheduled spike sources (backfill-outcomes overlapping with seed fires, agent-driven `/mcp` calls).
4. **Decouples ticker24hr from per-coin** — also removes the redundancy with `fetchBinanceCoins` + `fetchBinance` (two separate full-universe fetches now share one cached fetch within process lifetime).
5. **No bulk OI endpoint exists** — `openInterest@symbol` remains per-coin (weight 50/100 unavoidable). Not a fix-path blocker.

### Files to modify (R4)

| File | Change |
|---|---|
| `src/lib/adapters/binance.ts` | Add `getTicker24hrFullCoalesced()` + `getPremiumIndexBulkCoalesced()` + `_resetBinanceAdapterCaches()` test seam (mirroring HL pattern). Refactor `getAssetContext` to read prevDayPx/quoteVolume from ticker24hr cache + funding/markPrice from premiumIndex cache. Keep `openInterest@symbol` per-coin. |
| `src/scripts/seed-signals.ts` | Bump `DELAY_PER_EXCHANGE.BINANCE` 200 → 400ms with explanatory comment. Refactor `fetchBinanceCoins` to call the coalescer (re-exported from adapter). |
| `src/lib/exchange-universe.ts` | Refactor `fetchBinance` to call the adapter's coalescer (instead of separate fetch). Removes the second full-universe consumer. |
| `tests/binance-coalesce.test.ts` (new) | Mirror `tests/hyperliquid-coalesce.test.ts` (if exists) — cases: N=20 concurrent callers share 1 fetch / sequential within TTL share 1 fetch / TTL expiry triggers refetch / cache reset / per-coin openInterest NOT coalesced / getAssetContext math equivalence pre/post-fix. |

### Out of scope (deferred or NOT this wave)

- `BinanceAdapter.getCandles` (klines) — no bulk endpoint, no caching opportunity. Stays per-coin.
- `BinanceAdapter.openInterest` — no bulk endpoint. Stays per-coin (weight 50-100 unavoidable; -31% savings still leaves comfortable headroom).
- Cross-process Redis coalescing — deferred to `OPS-BINANCE-RATELIMITER-W2` if R4 insufficient (architect re-dispatches).
- `BinanceAdapter.getFundingHistory` — low-frequency, on-demand. Not touched.

---

## J. Architect ratification request

**Ratify Path R4** (hybrid coalescing + polite-delay bump) OR pick alternate path?

Plan-Mode HALT here pending architect Q-block response. Single targeted Q-block, copy-pasteable:

> **Q1 — Path ratification.** Ratify Path R4 (adapter-layer bulk-coalesce premiumIndex + ticker/24hr full-universe + polite-delay 200→400ms; mirrors HL fix) over R1 (ticker/24hr-only coalesce, -17%), R3 (coalesce-only no delay bump), or R5 (heavier wave)? Per Plan-Mode probe: R4 delivers -31% per-fire weight reduction + 2× burst spread. Recommendation: **R4**.
>
> **Q2 — Delay value.** If R4 ratified: 400ms (recommended; spreads top-50 5m burst to 20s) OR 500ms (more cushion) OR 300ms (less change vs 200ms current)? Recommendation: **400ms** (doubles current; matches HL post-fix 750ms-as-1.5× shape; symmetric defense-in-depth).
>
> **Q3 — `exchange-universe.fetchBinance` refactor.** R4 has `exchange-universe.fetchBinance` call the adapter's coalescer. This crosses module boundaries (`exchange-universe.ts` → imports from `adapters/binance.ts`). Acceptable, OR keep `exchange-universe.fetchBinance` as-is and only coalesce within the adapter (accepting the duplicate full-universe fetch on isMemeCoinLiquid cold-start)? Recommendation: **refactor — single full-universe cache for the entire process**.
>
> **Q4 — Spec's 4700/196% projection re-anchor.** Spec's "projected weight 4700 at top-50 = 196% of cap" is not derivable from the cron schedule (max realistic burst at minute :07 of hour 0 ≈ 830-1000 weight in 30s, not 4700/min). Confirm AC R5 ("top-50 synthetic probe shows projected weight < 90% cap") is interpreted as **"top-50 PART-B 3m cron added to baseline = post-fix sample shows < 2160 / 2400 sustained"** rather than the spec's projection number? Recommendation: **YES — interpret R5 as live-probe-based, not spec's worst-case number**.

Wait at gate.

---

## K. Pre-implementation checklist (post-ratification)

If architect ratifies R4:

- [ ] R0: `git status -s` on `/Users/tank/crypto-quant-signal-mcp/` confirms clean working tree before edits (cross-session contamination guard per CLAUDE.md).
- [ ] R1 sub-1: edit `src/lib/adapters/binance.ts` — add `getTicker24hrFullCoalesced()` + `getPremiumIndexBulkCoalesced()` + `_resetBinanceAdapterCaches()`.
- [ ] R1 sub-2: refactor `getAssetContext` to read from caches; keep `openInterest@symbol` per-coin.
- [ ] R1 sub-3: edit `src/scripts/seed-signals.ts:63` — bump 200→400 with comment.
- [ ] R1 sub-4: refactor `fetchBinanceCoins` to call adapter's `getTicker24hrFullCoalesced`.
- [ ] R1 sub-5: edit `src/lib/exchange-universe.ts:80` — refactor `fetchBinance` to call coalescer.
- [ ] R2: new `tests/binance-coalesce.test.ts` per §I files-to-modify table.
- [ ] R3: clean rebuild + npm test + commit (in-scope files only; `git diff --cached` verify per CLAUDE.md cross-session guard).
- [ ] R4: 30-min sustained `x-mbx-used-weight-1m` sampling — all 6 samples < 1200 (50% of 2400).
- [ ] R5: top-50 synthetic probe — post-coalescing weight reading immediately after `fetchBinanceCoins(50)` < 2160.
- [ ] R6: status.md + system-map.md Last-touched row + WIS bullets.

---

**End of Plan-Mode audit. Awaiting architect Q-block response.**
