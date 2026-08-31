# OPS-HL-INTERACTIVE-STARVATION-W1 — endpoint-truth

**Probed 2026-08-31 15:12–15:56Z** (local `date -u`; signal-1 `date -u` = `2026-08-31 15:55:18Z`, consistent — no clock artifact).
Source of truth: **`origin/main` = `89ba1e8c`**, never a working tree. Live DB read via
`docker exec crypto-quant-signal-mcp-postgres-1 psql -U "$POSTGRES_USER" -d signal_performance -tAq`.

---

## 1 — Primitive probes (`claim | reality | resolution`)

| # | Claim | Reality | Resolution |
|---|---|---|---|
| 1 | `request_log.verdict` exists | `src/lib/analytics.ts:38` (base `CREATE TABLE`) | ✅ |
| 2 | `request_log.regime` exists | `analytics.ts:47` + idempotent ALTER `:119` (migration 032) | ✅ |
| 3 | verdict/regime NULL for `get_market_regime` | **0 of 36,836** rows non-null on either | ✅ |
| 4 | `HL_INTERACTIVE_RESERVE = 450` | `venue-budget-registry.ts:68` | ✅ |
| 5 | batch cap 700 | derived `1150 − 450` | ✅ |
| 6 | throw recorded | `upstream-weight-budget.ts:233` `recordRateLimitEvent(...)` | ✅ |
| 7 | tool runs `interactive` | `currentWeightClass()` default; `runAsCaller` sets caller only | ✅ |
| 8 | no `background` class | `WeightClass = 'interactive' \| 'batch'` | ✅ absent, deferred to follow-on |
| 9 | `rate_limit_events` retains history | `2026-06-06 01:56Z → now`, 4,092,395 rows | ✅ |
| 10 | **"≤50% of documented HL budget"** (CH2 AC) | **FALSE** — ceiling **1150 / 1200 = 95.8%**, deliberate (`OPS-HL-BUDGET-TUNE-W1`, architect-approved). 50%-of-published governs Bybit/OKX/Bitget | ❌ **Q1** |
| 11 | "throws begin 2026-08-21" | **FALSE** — first is **2026-07-07** | ❌ re-pinned, §2 |
| 12 | "08-16 → 08-20: **0** throws" | **FALSE** — **08-16 = 106 throws** | ❌ re-pinned, §2 |
| 13 | "7,680 throws … **all on `get_market_regime`**" | **FALSE** — 182 of them are `caller='unknown'` | ❌ re-pinned, §2 |
| 14 | "23,437 `get_market_regime` rows" | **36,836** (retention from 2026-04-07) | ❌ re-pinned |
| 15 | "the throw reaches the customer" | true for the **candles** leg only; the **funding** leg is swallowed | ❌ **Q3**, §3 |

**Fictional primitives: 0.** Every named file, symbol, column and table exists. The six ❌ rows are
**false figures and one false premise**, not fabrications — below the ≥3-fictional HALT threshold, so
they are fixed inline and flagged (Q1–Q4).

## 2 — Re-pinned figures (live `rate_limit_events`, HL · throw · `BUDGET_CEILING` · interactive)

`caller='get_market_regime'`, all time: **8,009 throws over 263 distinct minutes, first 2026-07-07 05:17Z.**

| date | throws | affected minutes | per affected min | **max in ONE minute** | calls that day |
|---|---|---|---|---|---|
| 2026-07-07 | 19 | **1** | 19.0 | 19 | — |
| 2026-07-16 | 1 | 1 | 1.0 | 1 | — |
| **2026-08-16** | **106** | **1** | 106.0 | **106** | **447** |
| 2026-08-21 | 234 | 5 | 46.8 | 88 | 832 |
| 08-22 | 995 | 42 | 23.7 | 76 | 2,527 |
| 08-23 | 975 | 42 | 23.2 | 62 | 2,922 |
| 08-24 | 782 | 30 | 26.1 | 55 | 2,323 |
| 08-25 | 1,062 | 24 | 44.3 | 81 | 2,380 |
| 08-26 | 665 | 25 | 26.6 | 68 | 2,332 |
| 08-27 | 538 | 22 | 24.5 | 57 | 2,294 |
| **08-28** | **0** | 0 | — | — | **581** |
| 08-29 | 904 | 23 | 39.3 | 95 | 2,662 |
| 08-30 | 1,110 | 26 | 42.7 | 92 | 3,516 |
| 08-31 (partial) | 618 | 21 | 29.4 | 75 | 2,349 |

**Reconciliation of status.md's 7,680.** `get_market_regime` 08-22→08-31 was **7,498** at the 14:10Z
write time, plus **182** `caller='unknown'` on 08-22/08-23 = **7,680**. The arithmetic is right; the
attribution **"all on `get_market_regime`"** is wrong by 182. (Those 182 are the untagged `monitor.ts`
path, last seen 08-23 — which is exactly the evidence status.md used to reject H5, so **H5 stays
rejected**; only the "all" is overstated.)

**"352 throws, ~30.6 per affected minute" fuses two windows.** `30.6 = 7,680 ÷ 251` — the full
history. `352` is the count inside the 6 h / n=222-closed-window reserve sample. Headline magnitude
is **8,009**, not 352.

### The burst hypothesis is now measured, not inferred

**2026-08-16: all 106 throws in a SINGLE minute, on a day of 447 calls (≈0.31 calls/min average).**
No sustained-load story can produce that. Throws occupy **21–42 minutes of 1,440 per day (1.5–2.9%)**
even at peak. **The customer ramp amplified a defect that already existed on 2026-07-07** — five weeks
before the ramp the wave attributes it to.

## 3 — Surface-vs-degrade, answered from source

`src/tools/get-market-regime.ts:311-313`:

```ts
const [candles, allFundings] = await Promise.all([
  adapter.getCandles(coin, timeframe, startTime, dex),
  hlAdapter.getPredictedFundings().catch(() => []),   // ← throw SWALLOWED
]);
```

| leg | fires on | on `BUDGET_CEILING` | customer receives | `request_log` row |
|---|---|---|---|---|
| `getCandles` | `exchange=HL` only — **the default** (`REGIME_EXCHANGE_DEFAULT='HL'`, `tool-param-schema.ts:155`) | **surfaces** | `isError:true`, `error_code:'UPSTREAM_RATE_LIMIT'` (`index.ts:195-210`) | **none** |
| `getPredictedFundings` | **every call, every venue** | **caught → degraded** | `cross_venue_funding_sentiment:'NEUTRAL'`, `'Insufficient cross-venue data'` (`:637`), `funding_by_venue` omitted | written, verdict NULL |

The second row is the severe half and is absent from status.md: **an upstream refusal is rendered to
a paying customer as a substantive market verdict** (`NEUTRAL`), and `'Insufficient cross-venue data'`
is the same string returned when the coin genuinely has no HL funding — so the two are not separable
by any consumer. This is the sentinel-conflation the manual forbids.

## 4 — Why populating `verdict` alone would report a false 0%

`src/index.ts:673-696` — `logRequest` sits **inside** the `try`, **after** the awaited call; the
`catch` returns `toolErrorContent(err)` and logs nothing. A failed call therefore writes **no
`request_log` row at all**, so the 36,836 rows are **successes only** and a failure rate computed from
that table is **0.0% by construction**. Fourth substrate of "the instrument was structurally incapable
of observing the thing and returned a confident zero." **CH1 must log the error arm**, not just the
fields.

## 5 — CH2 lever, decided on measurement

Per default call (`exchange=HL`, `timeframe=4h`, `CANDLE_COUNTS['4h']=42`):

| leg | HL `/info` type | weight | coalesced? |
|---|---|---|---|
| `getCandles` | `candleSnapshot` | `20 + ceil(42/60)` = **21** | n/a — coin-specific |
| **`getPredictedFundings`** | `predictedFundings` | **20** (`weightFor`, `hyperliquid.ts:56`) | ❌ **no — direct `hlInfoPost`, `:241-242`** |
| `getAssetContext` | `metaAndAssetCtxs` | 20 | ✅ 60 s TTL via `coalescedCache` |
| | | **41/call ⇒ ~10.9 calls/min** under the 450 reserve | |

- **(a) larger reserve is nearly closed.** 1150 vs documented 1200 leaves **50 wt/min** unallocated;
  450→500 is **+11%** (~10.9 → ~12 calls/min) against measured bursts of **up to 106 throws in one
  minute**. It cannot fix this, and taking more from batch is forbidden wave-wide.
- **(b) coalescing is the lever, and the primitive is already imported in the same file.** 9th probe:
  `coalescedCache` (`src/lib/coalesced-cache.ts`) already wraps `metaAndAssetCtxs` at 60 s
  (`OPS-HL-CACHE-STAMPEDE-GENERATOR-W1`, pinned by `tests/hyperliquid-coalesce.test.ts`).
  `getPredictedFundings()` is the **one HL call in this path that bypasses it**.

**Output identity is structural:** `getPredictedFundings()` **takes no parameters** and returns the
whole perp universe, so concurrent callers already receive a byte-identical payload; funding also
moves far slower than the price data the 60 s TTL already covers.

**Projected:** 30-call burst `30×21 + 1×20 = 650` vs `1,230` (**−47%**); headroom ~10.9 → **~21
calls/min**. Non-HL venues: HL weight per call **20 → ~0**.

## 6 — system-map edges

`system-map.md:481-490` already names this wave. Mutated: the `upstream-weight-budget.ts`
interactive-reserve row (throw counts + the coalescing edge) and the HL-adapter → `get_market_regime`
fetch-pattern edge. `request_log.verdict/regime` consumers are `hold-decision-capture.ts` + the
directional labeler, both keyed on `get_trade_call` HOLDs — **unaffected**, because the new rows are
`get_market_regime` and are never selected by either. CH3: `NONE — verification only`.

## 7 — Architect Q-set (executed under stated assumptions; reverse on ruling)

| Q | Issue | Assumption taken |
|---|---|---|
| **Q1** | CH2 AC "≤50% of documented HL budget" is false of current state (95.8%); literal reading requires cutting the ceiling to ≤600 and **worsening** the starvation | AC read as **"ceiling unchanged at 1150, ≥50 wt/min headroom under the documented 1200"** |
| **Q2** | CH1's literal scope yields a measured 0.0% failure rate | CH1 **also logs the error arm** (additive; CH1's firewall does not forbid `index.ts`) |
| **Q3** | Silent-degrade path is the majority leg and is absent from status.md | CH1 **instruments** it with a distinguishable verdict; **customer-facing output is NOT changed** (CH2 requires identity) |
| **Q4** | Motivating figures are second-hand and six are wrong | Re-pinned above; **8,009 / first 2026-07-07**, not 352 / 08-21 |
