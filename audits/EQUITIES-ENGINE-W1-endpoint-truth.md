# EQUITIES-ENGINE-W1 — Endpoint Truth (C1 Plan-Mode probe)

**Status:** ✅ **C1 PROBES COMPLETE — recommend GO.** Awaiting architect approval + clean baseline (TRADFI-W1 commit) before C2.
**Probed:** 2026-06-04 ~05:15 UTC, live, by Code Plan-Mode pass. Key valid (HTTP 200 on all probes).
**Repo:** `/Users/tank/code/crypto-quant-signal-mcp` @ `524ace7` (HEAD == origin/main).
**Dataset:** Databento `EQUS.MINI` · auth HTTP Basic `curl -u "$DATABENTO_API_KEY:"` (trailing colon) · base `https://hist.databento.com/v0`.

## GATE LINES
- **COST_GATE: PASS** — (a) ALL_SYMBOLS ohlcv-1d 90d = **$1.28** + (b) ALL_SYMBOLS ohlcv-1d 2y = **$7.28** = **$8.56** conservative upper bound (universe ⊂ ALL_SYMBOLS=9,784). Actual 500-sym plan ≈ **$1.65**. Budget $50, credits $125 (verified, expires 183d). No universe/lookback shrink.
- **ADJUSTMENT_FACTORS: NO-GO** — adjustment-factors + corporate-actions both return `403 license_reference_dataset_no_subscription` ("A subscription is required"). Usage-based EQUS.MINI does NOT entitle reference datasets. → **gap-quarantine fallback** (R3); **DROP** the conditional `equity_adjustment_factors` table (E2).
- **OHLCV_1D: SERVED** · **SYMBOLOGY: Nasdaq raw_symbol (BRK.B) confirmed** · **FRESHNESS: T+1** · **KEY: VALID**

---

## §1 — Repo primitive truth table (live-verified)

| # | Claim (spec) | Reality | Resolution |
|---|---|---|---|
| 1 | Repo path, HEAD==origin/main | ✅ both `524ace7` | PASS |
| 2 | OLD `/Users/tank/crypto-quant-signal-mcp` stale | ✅ exists, unused | PASS |
| 3 | test `vitest run` (vitest ^3.1.1) | ✅ | PASS |
| 4 | build `tsc`, Node16/ES2022/dist, `__dirname` | ✅ tsconfig confirms | PASS |
| 5 | `cron:prod` = seed-signals.js && backfill-outcomes.js | ✅ exact | PASS — C5 precedent |
| 6 | seed-signals.ts + backfill-outcomes.ts present | ✅ | PASS |
| 7 | `pg ^8.13.3` | ✅ | PASS |
| 8 | `p-limit 3.1.0` | ✅ | PASS — adapter concurrency |
| 9 | 6 MCP tools | ✅ get_trade_call/get_trade_signal/scan_funding_arb/get_market_regime/search_knowledge/chat_knowledge | PASS — 6→8 valid |
| 10 | `src/tool-annotations.ts` SoT (readOnly/destructive/openWorld) | ✅ readOnlyHint:true, openWorldHint:true, destructiveHint:false | PASS |
| 11 | precedent `e32f390` | ✅ "set destructiveHint on all 6 tools via shared SoT constant" | PASS |
| 12 | quota `checkQuotaByKey` | ✅ `license.ts:421` | PASS — C4 reuse |
| 13 | migration `00X` | 001–004 exist → **`005_equities_phase1.sql`** | RESOLVE 00X→005 |
| 14 | tests/unit + tests/integration | ✅ | PASS |
| 15 | src/scripts→dist/scripts via tsc, no Dockerfile change | ✅ precedent | PASS — keep code in src/ |
| 16 | pure indicator math | ✅ `indicators.ts` 100% pure (10 OHLCV-only exports) | PASS — §3 |
| 17 | `docs/RUNBOOK-POSTGRES-MAINT.md` convention | ❌ absent | **CREATE in C2** (architect-confirmed); docs/** is paths-ignore'd (verify line present) |
| 18 | PII regex `/"(outcome_return_pct\|outcome_price)"\s*:\s*[-\d.]/` precedent | ⚠️ forbidden-key NAMES present (chat-engine.ts:28, erc8004); value-binding regex literal not located | C4 introduces it + positive-assertion canary; extend to equity routes |
| 19 | E1 "external integration #34" | ⚠️ running count buried in system-map prose | CONFIRM at C2 system-map edit |

---

## §2 — Databento external-API truth table (LIVE-PROBED)

| # | Claim | Reality (live) | Resolution |
|---|---|---|---|
| D1 | host `hist.databento.com/v0/timeseries.get_range` | ✅ base confirmed; get_range 200 | PASS |
| D2 | HTTP Basic, key as username, blank pw | ✅ `-u "$KEY:"` → 200 on every probe | PASS — adapter uses Basic auth, key=username |
| D3 | redistribution/non-display, no license restriction | ✅ verbatim (blog) | PASS |
| D4 | usage-based, no subscription | ✅ | PASS |
| D5 | history starts 2023-03-28 | ✅ dataset_range start=2023-03-28 | PASS |
| D6 | **`ohlcv-1d` served** | ✅ list_schemas: `[mbp-1,tbbo,trades,bbo-1s,bbo-1m,ohlcv-1s,ohlcv-1m,ohlcv-1h,ohlcv-1d,definition]` | PASS — earlier blog-only drift RESOLVED |
| D7 | $125 signup credits | ✅ portal screenshot $125.00, expires 183d | PASS |
| D8 | Nasdaq symbology (BRK.B), raw_symbol≡nasdaq | ✅ `symbols=BRK.B stype_in=raw_symbol` → bars (instrument_id 2306) | PASS — BRK-B→BRK.B normalize correct |
| D9 | adjustment-factors + corporate-actions exist | ✅ paths exist (405 on GET → POST; need `countries=US` not `dataset`) but **403 no subscription** | **NO-GO** — gap-quarantine |
| D10 | EQUS.MINI universe size | record_count ALL_SYMBOLS ohlcv-1d 1 session = **9,784** | top-500 ADV is clean subset |
| D11 | smoke parse | ✅ CSV `ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol`; AAPL/SPY/BRK.B 2026-05-26→06-03 sane | PASS — adapter parses csv+map_symbols+pretty_px |
| D12 | ETF whitelist resolves | ✅ all 8 (SPY750.21,QQQ738.59,IWM287.19,DIA507.57,IBIT36.29,FBTC56.90,ETHA13.41,EWY205.62) @2026-06-03 | PASS — frozen |
| D13 | same-evening T-day availability (R5 cron) | now 2026-06-04 05:15 UTC; latest bar **2026-06-03**; available_end 2026-06-04T00:00 → **T+1** | **cron `17 9 * * 2-6`, as_of_session=previous**; seed processes max(available session) so timing affects freshness not correctness |

**Probe ladder used (reusable in adapter):**
- `$0` schema: `curl -u K: -G .../metadata.list_schemas -d dataset=EQUS.MINI`
- `$0` cost: `.../metadata.get_cost -d dataset -d schema -d symbols=ALL_SYMBOLS -d stype_in=raw_symbol -d start -d end -d mode=historical-streaming`
- data: `.../timeseries.get_range -d dataset -d schema=ohlcv-1d -d symbols -d stype_in=raw_symbol -d start -d end -d encoding=csv -d pretty_px=true -d pretty_ts=true -d map_symbols=true`
- freshness: `.../metadata.get_dataset_range -d dataset=EQUS.MINI` (→ available_end; seed reads this to pick latest session)
- reference (NOT entitled): `POST .../adjustment_factors.get_range -d countries=US -d symbols ...` → 403

---

## §3 — Pure-indicator inventory (frozen)

**PORTABLE (import to equity engine):** `src/lib/indicators.ts` — `ema, emaLast, rsi, atr, adx(+plusDI/minusDI/adxSlope), hurstExponent, bollingerBands, keltnerChannel, detectSqueeze, detectPriceStructure` (10 pure OHLCV-only). Plus `indicator-buckets.ts` PURE subset: `bucketTrendPersistence, bucketBreakoutPending` + regime/trend/breakout prose.
**EXCLUDED (venue-coupled, must NOT port):** funding (`tradfi-funding.ts`, `bucketFundingState`/`fundingProse`), open-interest (`oi-ranking.ts`), cross-venue (`scan-funding-arb.ts`), sentiment. Fusion lives `src/tools/get-trade-call.ts`.
→ Equity composite v1 = `technical:*` + `regime:*` families ONLY. Spec R3 premise SOUND. (≥12 portable primitives; exact "of 26" labeling is descriptive, the boundary is the pure/venue split above.)

## §4 — Calendar SoT (frozen — single-SoT WIN)
TRADFI-SIGNAL-HARDENING-W1 (committing first) ships `src/lib/market-sessions-constants.ts`:
`US_MARKET_HOLIDAYS` (**20 NYSE rows 2026-2027**), `isUsMarketHoliday(isoDate)`, `latestHolidayYear()`, `AssetClass`; and `market-sessions.ts`: `classifyUnderlyingSession()` (America/New_York DST). **→ C2 DROPS planned `equity-calendar-constants.ts`; imports this SoT.** Annual-refresh TODO already lives there.

## §5 — Edge enumeration
E1 Databento ext-integration (C2) · E2 equity_* tables **minus equity_adjustment_factors (NO-GO)** (C2) · E3 seed-equities (C5) · E4 backfill-equity-outcomes (C5) · E5 tools/list 6→8 (C4) · E6 additive `equities` resource key (C4) · E7 firewall.

## §6 — Resolved blockers
- Blocker A (key) — RESOLVED, persisted `~/.config/algovault/databento.env` mode 600 (single-view OTS consumed; C5 SSH-installs to Hetzner compose `.env` from here).
- Blocker B (clean baseline) — architect: TRADFI-W1 commits first. **C2 must re-check `git status -s` clean before any edit.**
