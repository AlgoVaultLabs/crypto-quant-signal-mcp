# OPS-VENUE-GO-LIVE-15-W1 — CHAPTER 1 endpoint-truth

**Promote WHITEBIT · BITMART · XT (12 → 15).** Read-only truth probe. `claim | reality | resolution`.

- **Probed:** 2026-07-23 ~01:41–02:10 UTC · **box UTC** `2026-07-23T01:41Z` (TZ Etc/UTC — no clock-drift trap).
- **`$REPO`** `/Users/tank/code/crypto-quant-signal-mcp` @ **`c90b4dd`** — working tree **== origin/main** (anchors below are C2-accurate). Only untracked files present (`.claude/napkin.md`, two prior `audits/*-endpoint-truth.md`) → CH1 gate (`git diff --quiet`) holds.
- **Live SoT:** `/api/performance-public` → `exchange_count:12, shadow_venue_count:5, asset_count:1393, timeframe_count:11, funding_venue_count:7`; `byExchange` keys = the 12. `/api/performance-shadow` → **401** (readiness is not readable off-box → measured on-box below).
- **DB:** role `algovault`, db `signal_performance`, ctr `crypto-quant-signal-mcp-postgres-1` / `...-mcp-server-1`.

---

## A. Per-venue readiness + force decision (Probe #1)

Measured on-box via `DRY_RUN=1 venue-readiness-report.js` (no TG) + `venues` rows. Force floor (auto-HALT even with `--force`): `pfe_wr===null` **OR** `days_since<7` **OR** `pfe_wr<0.70`.

| Venue | status | day | BUY+SELL sample / min | PFE-WR | ext | seeding_started | Readiness | Force floor | **Decision** |
|---|---|--:|---|--:|--:|---|---|---|---|
| **BITMART** | shadow | ~42 | 10258 / 9490 (108%) | **93.9%** | 1 | 2026-06-11 | ✅ QUALIFIED | clear | **promote — NO `--force`** |
| **WHITEBIT** | shadow | ~42 | 4537 / 3150 (144%) | **89.9%** | 1 | 2026-06-11 | ✅ QUALIFIED | clear | **promote — NO `--force`** |
| **XT** | shadow | ~52 | 8538 / 8930 (96%, **392 short**) | **91.8%** | 1 | 2026-06-01 | ⏳ sample-short | clear (WR 91.8≥0.70, day 52≥7, not null) | **promote — `--force`** (pre-auth; 4% sample short, 1 extension already used) |

None trips the force floor. After the flip: shadow = {EDGEX, WEEX} → `shadow_venue_count` 5→**2**.

---

## B. The 10 probe rows

| # | Claim (spec / prior) | Reality (live-probed) | Resolution |
|---|---|---|---|
| **1** Readiness | "measure, don't assume" | See §A. BITMART/WHITEBIT clean QUALIFIED; XT 96% sample, WR 91.8% | BITMART/WHITEBIT no-force; XT `--force`. Zero floor trips. |
| **2** Repo anchors | `EXCHANGES`/`LB_EX_*`/formatter | `EXCHANGES` `capabilities.ts:42` (frozen), `EXCHANGE_COUNT=EXCHANGES.length` `:63`, `PromotedVenueId` `:74`, `PROMOTED_VENUE_IDS` `:77`. `LB_EX_LABEL/COLOR/ORDER` `index.ts:4185/4186/4187` (12 each). `venue-public-formatter.ts` **0 venue-name literals** | **FIELD-keyed confirmed** (backward-dep #3 TRUE). Anchors accurate. |
| **3** tsc cascade | `Record<PromotedVenueId>` surfaces | **Compile-forced:** `exchange-universe.ts:83` `FETCHERS: Record<PromotedExchangeId,…>` (needs 3 fetchers) · `venue-budget-registry.ts:336` `VENUE_BUDGETS: Record<PromotedVenueId,…>` (needs 3 budgets). **Auto-projecting** (widen with EXCHANGES, no error): scan Zod enum `scan-trade-calls.ts:73`, `SCAN_EXCHANGES` `trade-call-scanner.ts:50`, OI-sampler `PROMOTED_VENUE_IDS`. `LB_EX_*` are plain objects → **NOT** tsc-forced (C2 test must assert coverage). | Spec said "rate-limit-digest.ts" — real budget Record is **`venue-budget-registry.ts:336`**. Two files are hard tsc-forced. |
| **4** Interval synthesis | "synthesise 3m from 3×1m, or error/skip?" | **NEITHER — adapters SUBSTITUTE a coarser native interval, never throw.** `xt.ts:42` `3m→5m`,`2h→1h`,`8h/12h→4h` (native 5m ✓). `bitmart.ts:42` `3m=3` **native**,`5m` native, `8h→4h`,`1d→12h`. `whitebit.ts:47` kline supports only `{1m,15m,30m,1h,4h,1d}` → **`3m→15m` AND `5m→15m`** (5×/3× coarser); has native **1m** (synthesis possible, not built). Fallback `INTERVAL_MAP[x]||'1h'` / `STEP_MAP[x]??60` ⇒ no per-fire errors. | Promotion = **clean-running, coarser-than-labeled** sub-hourly bars, not errors. Only NEW interval on promotion = **3m** (shadow has none). BitMart 3m native = clean; XT 3m→5m = matches incumbents GATE/MEXC/PHEMEX; **WhiteBIT 3m/5m→15m = the outlier.** → **Q2.** |
| **5** 1d regression | "does promoting stop 1d accrual?" | **YES.** 1d line `crontab:177` = `--exchange-list BINANCE,BYBIT,OKX,BITGET` (fast-4 only). Shadow 1d `crontab:173` feeds shadow venues. Promotion drops them from shadow → **1d freezes.** Current 1d rows: **BITMART 23, WHITEBIT 7, XT 27** (accrued rows persist — add-only). Consistent w/ every other non-fast-4 promoted venue (GATE 7, MEXC 1, PHEMEX 28…). | Established policy since 2026-06-30. → **Q3** (accept vs add to 1d list). |
| **6** Ordering test | "live-DB test asserts EXCHANGES==listVenues('promoted')?" | **NO build-time live-DB test.** `capabilities.ts:72` is a *comment*; `scan-promoted-derivation.test.ts` explicitly **defers** DB parity to "C3 (live byExchange)"; `venue-store.test.ts` uses a mocked store. | No inverting constraint → **flip DB first, then push** (understate-never-overstate, C3 default). |
| **7** Capacity baseline | "3m top-15 ≈ 96 s" (SOP) | **3m: 11 venues c=2 → ~119–121 s** (one 69 s), `overrun=false` (warn 144 s → **83%**). **5m: ~180 s**, `overrun=false` (warn 240 s). **15m flip-flops** (551 s / one 916 s `overrun=true`). **1h `overrun=true` 7037 s vs 3600 cadence, 1839 errors**; **2h 7056 s** (both uncapped/ALL). | 3m higher than SOP's 96 s. Fast SLA lines green; **1h/2h pre-existing hard/soft overrun** (uncapped). → **Q4.** |
| **8** Ban baseline | "BitMart 429→418; uncapped 1h = likely ban vector" | 7d `rate_limit_events`: **WHITEBIT 0, XT 0, BITMART(=`Bitmart`) 523×429** (seed:15m 104 / 5m 99 / 1h 97 / 30m 84 / backfill 65 / 4h 65 …) **all in a 2026-07-20/21 burst, quiet since**. **0 × 418 EVER, any venue.** Root cause: **shadow venues have NO cross-process budget** (`SHADOW_VENUE_BUDGETS` empty `venue-budget-registry.ts:358`) → concurrent lines burst past 12/2s. Promoted 1h+ lines uncapped (`crontab:178-183`, no `--top`). Live universes: **BITMART 1186 perps, WHITEBIT 396, XT ~1054.** | On promotion C2 adds `bitmartWeightBudget` to the exhaustive `VENUE_BUDGETS` → **cross-process ceiling serializes all lines** → the burst cause is REMOVED. → **Q4** (confirm ceiling sizing). |
| **9** Vendor limits re-probe | BitMart/XT ⚠️ 7-wk-old | **CONFIRMED unchanged (official docs, 2026-07-23):** BitMart 12/2s (kline+details), **OI 2/2s**, 429→418. XT **1000/min per IP**, breach = **10-min account lock**. | 2026-06-05 research HOLDS → C2 budgets stand (WHITEBIT ~200 ms, BITMART ~500 ms, XT ~400 ms). No research-file correction needed. |
| **10** Canary + manifest shapes | "EXCHANGE_COUNT row FLOOR" | **Landing inject manifest** = `scripts/snapshot-landing-manifest.json` (NOT root — runbook §2 drift). Already has live-bind rows: `dtrf-exchange-count`, `jsonld-exchange-count`, `text-perp-exchange-count` (`\d+ exchanges`), `jsonld-perp-venue-count` (`\d+ crypto perp venues`), `eyebrow-venues-unified` → most landing counts **already live-bound** (find/replace manifest, has no `tolerance_type` concept). **Drift-canary** = `/opt/algovault-monitoring/website-drift-manifest.yaml`: both `.exchange_count` rows (`HOMEPAGE_VENUE_COUNT_EXACT`, `TRACKRECORD_EXCHANGE_COUNT_DTRF_EXACT`) are **`FLOOR`** ✅ (won't page on 12→15; `.py:415` "stays EXACT (5)" comment is STALE, yaml overrides). `.byExchange\|keys` **EXACT_SET** rows are `tg_fires:false` + already stale at 5 names. `shadow_venue_count` not canaried. `audits/byExchange-shape-snapshot-2026-06-01.json` forbids `outcome_return_pct` et al. | **No canary blocker for the flip.** C5 narrows to uncovered meta/FAQ enumerations + the CI canary. C6 dry-run confirms FLOOR + refreshes the shape snapshot. |

---

## C. C2 tsc-forced work (enumerated before triggering)

1. `capabilities.ts:42` — append 3 `EXCHANGES` entries. **Vendor-cased labels:** `WhiteBIT`, `BitMart`, `XT` (verify each vs venue site).
2. `exchange-universe.ts:83` `FETCHERS` Record — **3 new rich `ExchangeAsset[]` fetchers**: **BITMART** real-OI (`/contract/public/details` `open_interest×?`), **WHITEBIT** real-OI (`/api/v4/public/futures` `open_interest`), **XT volume-PROXY** (`oiIsProxy:true`, add to `OI_PROXY_VENUES` — adapter hardcodes `openInterest:0`, no OI endpoint). `ExchangeAsset` = `{coin, notionalOI_usd, volume24h_usd, oiIsProxy?, mark/index/bid/ask?…}`.
3. `venue-budget-registry.ts:336` `VENUE_BUDGETS` Record — **3 new `WeightBudget` instances + entries**, cited: WHITEBIT ceiling ~50% of 2000/10s; **BITMART ceiling ~50% of 12/2s ≈ 180/min (the binding safety mechanism)**; XT ~50% of 1000/min ≈ 500/min. Each needs `ledgerPath`/`lockPath` (mirror `phemexWeightBudget:323`).
4. `index.ts:4185-4187` `LB_EX_LABEL/COLOR/ORDER` — 3 entries each, **distinct colours** (Design.md). NOT tsc-forced → C2 test asserts `LB_EX_ORDER` covers every `PromotedVenueId`.
5. Auto-projecting (verify, don't edit): scan Zod enum, `SCAN_EXCHANGES`, OI-sampler venue list — all derive from `EXCHANGES`.

## D. Drift corrections (research/spec vs working tree — tree wins)

| Source claim | Reality | Action |
|---|---|---|
| research 2026-06-05: "WHITEBIT 3m ✅ native" | adapter: kline only `{1m,15m,30m,1h,4h,1d}`; 3m & 5m → 15m | Q2; correct the research row |
| research: "XT no native 3m" (implies others native) | XT also lacks native 5m? — no: XT `5m` native ✓; only 3m/2h/8h/12h substitute | XT 3m→5m accepted |
| spec: "rate-limit-digest.ts + Record" | budget Record is `venue-budget-registry.ts:336` | C2 targets the right file |
| runbook §2: manifest at repo root | `scripts/snapshot-landing-manifest.json` | C5 path |
| memory: "VENUE_BUDGETS holds only 5, rest hard-throw" | holds all 12 (exhaustive) | stale memory; tree wins |
| `.py:415` "exchange_count stays EXACT (5)" | yaml row = FLOOR | comment stale; no action |

## E. CH1 gate

```
test -f audits/OPS-VENUE-GO-LIVE-15-W1-endpoint-truth.md && git diff --quiet && git diff --cached --quiet && echo CH1_GREEN
```

**Status: awaiting architect ratification of the Q-set (§F) before C2.**
