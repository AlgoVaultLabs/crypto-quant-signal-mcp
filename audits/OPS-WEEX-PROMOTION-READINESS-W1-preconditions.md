# OPS-WEEX-PROMOTION-READINESS-W1 — CH3 precondition audit

**Gate:** CH1 returned **GO-WITH-CONDITIONS**; architect verdict 2026-09-03 — *"CH2 ships unconditionally, CH3 runs, promotion HOLDS on a resume condition."*

**This chapter INVENTORIES and COSTS. It implements NOTHING.** No `capabilities.ts`, no `LB_EX_*`, no test flips, no CHANGELOG, no promotion, no `venues` write. Input to `OPS-WEEX-PROMOTE-W1`, which Cowork specs — not written here.

**Anchors re-resolved against `origin/main` `b5c13ade`** (the spec's line numbers predate `d0425710`; three had shifted and are corrected in place).

**Effort scale:** S = under an hour · M = half a day · L = more.

---

## Summary — what actually blocks

| # | Precondition | Blocking? | Effort |
|---|---|---|---|
| 1 | `weexWeightBudget` row | ✅ **SHIPPED in CH2** — but reopens as 🛑 **BLOCKING on CAPACITY**: WEEX is at **95% of its ceiling** today, **100% if promoted** | S–M |
| 2 | Two WEEX-absence tests | ⚪ not blocking — they record today's state | S |
| 3 | Brand hex | 🛑 **BLOCKING — PENDING-MR1**, the wave's single operator-action item | S once supplied |
| 4 | Docs identity gate | ⚪ **not blocking — generator-owned**, contrary to the spec's framing | S |
| 5 | `LB_EX_*` hand-adds | ⚠️ blocking-on-3 (needs the chart colour) | S |
| 6 | 1d lane deletion | ⚪ not blocking — consistent with ratified policy, and **quantified at 19 rows** | none |
| 7 | Rich fetcher + OI labelling | ⚠️ blocking for `scan_trade_calls` ordering | M |
| 8 | Faithful-TF set | ✅ **already satisfied — 10/10**, and CH2 improved it | none |
| 9 | Public-contract reversal (B1) | 🛑 **BLOCKING — release-wave act**, drafted below, not published | S (rides a release) |
| 10 | Ordering | ⚪ not blocking — a constraint on the promotion wave, recorded | none |

**Four blockers**, of which one (#3) needs Mr.1 and one (#9) needs a release wave. **#1 is the one that changed during the wave**: it shipped, then reopened as a capacity ceiling — WEEX cannot carry the promoted lane set at top-100 depth against its own declared limit. The binding constraint on promotion is still **B7** (CH1, the evidence base), with **#1 now a hard second**.

---

## 1 · `weexWeightBudget` — 🛑 BLOCKING, and CH2 proved why

**Anchors:** `src/lib/venue-budget-registry.ts:376` `const VENUE_BUDGETS: Record<PromotedVenueId, VenueBudgetEntry>` (tsc-exhaustive) · `:403` `SHADOW_VENUE_BUDGETS` — **was empty; WEEX is now its first occupant (`0835bb54`)** · `:409` `getVenueBudget()` returns `VENUE_BUDGETS[id] ?? SHADOW_VENUE_BUDGETS.get(id) ?? null`.

**What must change.** Promotion moves WEEX into `PromotedVenueId`, so `tsc` FAILS the build until a `WEEX:` row exists in the exhaustive record. A `weexWeightBudget` block must be authored alongside it.

**The budget value, cited.** WEEX `/capi/v3/market/exchangeInfo` `rateLimits[]` = `{interval: "MINUTE", intervalNum: 10, limit: 500}` → **0.833 req/s**, fetched 2026-09-03. Response headers advertise `x-used-weight-10s` (50 req/s) — a 60× self-contradiction. Architect D4 ruling: the venue's own **declared** limit governs; pace at ≤50% ⇒ **≥2400 ms**, i.e. a request-count budget of **250 requests / 10 min**.

**⚠️ This stopped being theoretical during CH2.** WEEX had **zero** 418/429 in 89 days on V2 at 300 ms. Within **four minutes** of the V3 cutover, **83 `429`s** landed in `rate_limit_events` (first seen at 45 and still climbing when I sampled — the final count for that window is 83). V3 enforces the declared limit that V2 did not. CH2 fixed the per-process delay (`DELAY_PER_EXCHANGE.WEEX` 300 → 2400).

**But the delay is PER-PROCESS and the budget is not.** `getVenueBudget('WEEX')` is `null`, so nothing serialises WEEX across concurrent lanes. The live cron grid overlaps them — minute 1 fires shadow-5m *and* shadow-4h; minute 4 fires shadow-1h *and* shadow-1d — so **two lanes each honouring 2400 ms jointly deliver ~1200 ms**, breaching a budget both independently respect. This is the "two individually compliant jobs breach one shared budget" class.

**Therefore the budget row is the cross-process enforcement.** ✅ **SHIPPED IN CH2** (`0835bb54`) rather than deferred, because the hazard proved live: after the per-process fix, **8 more 429s landed in a single minute (11:06Z) from FOUR concurrent callers** — `seed:5m`, `seed:15m`, `seed:30m`, `seed:1h`, whose ~240 s passes began 11:02/03/04/06. Ceiling **25/min** = 50% of the venue-declared 500 req/10 min; reserve 5. On promotion `tsc` demands it move into the exhaustive record, values unchanged.

**🛑 BUT THE PRECONDITION IS NOT CLOSED — IT CHANGED SHAPE, AND THIS IS THE WAVE'S SHARPEST CAPACITY FINDING.**

My D4 analysis checked each lane **independently** and never summed them. Aggregate steady-state demand across the nine shadow lanes (5m top-50 + eight top-100 lanes; 1 kline/symbol + 1 bulk ticker/pass):

| lane | 5m | 15m | 30m | 1h | 2h | 4h | 8h | 12h | 1d | **total** |
|---|---|---|---|---|---|---|---|---|---|---|
| req/hour | 612 | 404 | 202 | 101 | 50.5 | 25.2 | 12.6 | 8.4 | 4.2 | **1420** |

**1420 req/hour = 23.7 req/min against a 25/min ceiling — 95% utilisation, 1.3 req/min headroom.** With `interactiveReserve` 5 the batch share is **20/min**, so seeding is **over-subscribed** and will WAIT, and under sustained contention SKIP. **If promoted** (3m top-15 added, 5m depth 50→30): **25.0 req/min = 100% of the ceiling before any reserve.**

**WEEX cannot carry the promoted lane set at top-100 depth against its own declared limit.** This is the D4 question the spec actually asked — *"say which lanes it can and cannot fit… if it cannot fit the tight lanes, WEEX is an HL-class isolated-line venue and that is a promotion cost, not a footnote"* — and the per-lane table answered it **wrongly** by not aggregating. One of three things must give, and the choice is the architect's:

1. **Seed depth** — top-100 → top-50 on the slow lanes buys ~40% headroom. *(A Data Integrity change; not made here.)*
2. **Lane set** — drop WEEX from the 2h/8h/12h lanes it barely uses.
3. **The 50%-of-declared reading** — the headers claim 50 req/s; taking even 25% of *that* removes the problem entirely, at the cost of trusting the number the venue's own docs contradict.

Still **BLOCKING for promotion**, now on capacity rather than on absence. **Effort S to ship a decision, M if depth changes.**

## 2 · The two WEEX-absence assertions — ⚪ not blocking

| Anchor | Assertion | Why it asserts absence | Flipping it… |
|---|---|---|---|
| `tests/unit/venue-brand-colors.test.ts:76-81` | `VENUE_BRAND_COLORS` has no `EDGEX`/`WEEX` | the map is `Record<PromotedVenueId, string>`; these two are `ExchangeId` literals that are **not promoted and carry no approved brand colour** | **records today's state.** The real guard is `:68` `toEqual(APPROVED)`, which pins the whole palette — it survives and is what forces #3 |
| `tests/public-venue-scope.test.ts:45-48` | `PUBLIC_VENUE_IDS` excludes `EDGEX`, `WEEX` | projection of the promoted set | **records today's state.** The load-bearing assertion is `:40-42` (`length 14` + set-equality with `PROMOTED_VENUE_IDS`), which keeps working at 15 |

**Neither flip weakens a real guard** — both are set-membership snapshots downstream of the promoted set, and the invariants that matter (exact-palette, set-equality) are separate assertions that survive. **Effort S.** ⚠️ EDGEX must stay asserted-absent in both; it is retired, not merely unpromoted.

## 3 · Brand + leaderboard colour — 🛑 **PENDING-MR1**

`tests/unit/venue-brand-colors.test.ts:68` — `expect(VENUE_BRAND_COLORS).toEqual(APPROVED)`, *"pins the exact Mr.1-approved palette (no silent re-tint)"*. `src/lib/venue-brand-colors.ts:33` is `Record<PromotedVenueId, string>`, so `tsc` fails until WEEX has a value.

**One Mr.1-approved WEEX brand hex is owed. I will not invent a brand value.** This is the wave's single operator-action item.

Second colour: `LB_EX_COLOR` (#5) is the **chart-distinct leaderboard palette**, deliberately not the brand palette (`src/index.ts:5154`). It may be chosen for contrast *once the brand hex exists* — note `OKX #FFFFFF` and `WHITEBIT #F6F0FF` are already intentionally near-but-distinct, so the new value needs checking against both. **Effort S once supplied.**

## 4 · Docs identity gate — ⚪ **not blocking; the spec's framing is wrong**

**Anchors:** `landing/docs.html:410` (`get_trade_call`), `:536` (`get_market_regime`), `:668` (`scan_trade_calls`) · `scripts/check-docs-samples-live.mjs:391` `renderedClosedSetFor` · `:285` the projection branch · `:1128` the comparison.

**What the gate actually compares.** It reads `data-enum-value="…"` out of rows carrying `data-schema-param="exchange"` and compares them **by identity, in both directions**, against the **served tool schema**. The spec called these "baked enums", implying a hand-edit; they are **generator-emitted** — `scripts/build_docs.mjs` regenerates `docs.html` from `src/lib/docs-outline.ts` plus the compiled tool-param schema, and `:285` marks the row `projected`.

**So promotion changes nothing here by hand.** The promotion wave runs `node scripts/build_docs.mjs` in the same commit and the gate goes green because page and schema move together. It is only blocking if someone *forgets* to regenerate — which the gate then catches, loudly and by name. **Effort S.**

## 5 · `LB_EX_ORDER` / `LB_EX_LABEL` / `LB_EX_COLOR` — ⚠️ blocking on #3

**Anchors:** `src/index.ts:5147` (`LB_EX_LABEL`), `:5148` (`LB_EX_COLOR`), `:5149` (`LB_EX_ORDER`) — all 14 entries, hand-maintained.

**These are `var` literals inside a client-side script string, so `tsc` cannot see them.** A promotion that adds WEEX to `EXCHANGES` compiles clean and silently omits WEEX from the leaderboard, the filter tabs and the chip strip. Four render sites consume them: `:4835` (SSR), `:5163` (leaderboard rows), `:5347` (filter tabs), `:5362` (chip strip).

The class is *already covered*: `tests/unit/capabilities.test.ts` pins `LB_EX_ORDER` and `LB_EX_COLOR` **exactly** to the promoted set (`src/index.ts:5360` names it), so the parity test goes red until all three are updated. **The guard exists and works** — this is a known-cost edit, not a hazard. Needs the chart colour from #3. **Effort S.**

## 6 · The 1d lane deletion — ⚪ not blocking, **quantified**

Promotion moves WEEX off `--status shadow` onto the promoted lanes, where the 1d line is hardcoded `--exchange-list BINANCE,BYBIT,OKX,BITGET` (live crontab, `OPS-SEED-ORCHESTRATOR-W1` block). **WEEX therefore LOSES 1d accrual.**

**Measured, so the loss is known rather than discovered:**

- WEEX 1d rows since `seeding_started_at`: **19** (2026-07-09 → 2026-09-03), 18 of them in the last month.
- 1d rows across the whole fleet since 2026-08-01: BINANCE 60, BITGET 52, BYBIT 49, OKX 33, HL 22, **WEEX 18** — and **nobody else**. Nine promoted venues already have **zero** 1d accrual.
- 5m depth also drops **50 → 30** (`--top 50` shadow vs `--top 30` promoted); WEEX **gains** the 3m lane (`--top 15`), which it does not get today (0 rows since 2026-07-04).

**Consistent with ratified policy** — the same fast-4-only 1d trade accepted for WHITEBIT/BITMART/XT on 2026-06-30. Accrued rows persist (add-only). **No action; record it in the promotion wave's status entry so it is a decision, not a surprise.**

## 7 · Rich `ExchangeAsset[]` fetcher + OI labelling — ⚠️ blocking for ranked scans

Today WEEX has only `fetchWeexCoins(topN): Promise<string[]>` (`src/scripts/seed-signals.ts:657`) — volume-ranked, no OI. `UNIVERSE_FETCHERS` is `Record<ExchangeId, …>` (`:740`) and `scanUniverseCoins` requires the rich `ExchangeAsset[]` SoT that `fetchVenueUniverse` provides; without it `scan_trade_calls` cannot ORDER WEEX (`New-Venue-SOP` Lesson #2 — seed fetchers are not reusable for OI ranking).

**D5 changed the inputs here, so this is cheaper than the spec assumed.** B6's premise ("`base_volume === target_volume` is the signature of a placeholder") is **refuted**: V2's `open_interest` and V3's `openInterest` return the *identical* value (`140229.2102` for BTC), i.e. one real OI figure serialised into two legacy field names. It is distinct across symbols, stable across two fetches, and Spearman **+0.84** against 24h quote volume.

**Recommendation — ship the volume proxy, not the OI endpoint** (`oiIsProxy: true` + `OI_PROXY_VENUES`, `src/lib/exchange-universe.ts:664`, joining BINANCE/ASTER/BINGX/XT):

- `/capi/v3/market/openInterest` is **per-symbol only** (no `symbol` → `-1141`), so ranking 1023 symbols costs **1023 calls ≈ 41 min at 2400 ms**, every refresh.
- For a ranking that already correlates **+0.84** with `quoteVolume`, which arrives **free** in the single bulk `/capi/v3/market/ticker/24hr` call CH2 already makes.
- And the unit does not reconcile: BTC renders as **$10.9B** (base-units) or **$1.09M** (contractVal-notional); `contractVal` spans `0.0001 → 100`. A figure we cannot defend must not become a published magnitude.

**Effort M.** ⚠️ Also here: `venues.asset_count = 723` vs **1023** live perps — a 42% stale count the promotion wave should refresh (CH2's firewall forbids a `venues` write).

## 8 · Faithful-TF set — ✅ already satisfied, and CH2 *improved* it

Computed against the shipped `dist` after CH2, not assumed:

| tf | 3m | 5m | 15m | 30m | 1h | 2h | 4h | 8h | 12h | 1d |
|---|---|---|---|---|---|---|---|---|---|---|
| served | 5m | 5m | 15m | **30m** | 1h | 1h | 4h | 4h | **12h** | 1d |
| faithful | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**`faithfulTimeframes(WEEX)` = 10/10, SKIPPED = none.** The no-stranded invariant (≥1 faithful line ≤30m) is satisfied four times over. The spec's open question resolves: `3m` is coarser-substituted (1.67×, under the 2× bar); `2h`/`8h` are finer-synthesised; and **`30m` and `12h` are now NATIVE** — CH2 removed those two downgrades as V2 artifacts per architect ruling Q3(ii). **No action.**

## 9 · The public-contract reversal (B1) — 🛑 BLOCKING, **drafted, NOT FOR PUBLICATION IN THIS WAVE**

Confirmed live 2026-09-03: `get_trade_call{exchange:"WEEX"}` → `-32602 invalid_enum_value`, options list excludes WEEX. `README.md:260` and `:267` carry the notice verbatim; CHANGELOG `[1.28.0]` is its origin.

**This rides a `RELEASE-vX.Y.Z-W1`. A code wave cannot bump a version or publish.** Draft copy:

> **`WEEX` is an accepted `exchange` value again.**
> v1.28.0 announced that `EDGEX` and `WEEX` were no longer accepted and would return `-32602`. For `WEEX` that is now reversed: it has completed shadow evaluation and is served publicly, so the published enum accepts it. **`EDGEX` remains retired and still returns `-32602`.**
> If you removed `WEEX` from your integration on the earlier notice, no action is required — nothing else changed, and the enum is the source of truth. We are naming the reversal rather than quietly re-adding the value, because we asked you to switch away.

Integrator-facing honesty is deliberate: the earlier notice told people to change their code, so the reversal is announced as a reversal. **Effort S, but it gates on a release wave, not on this one.**

## 10 · Ordering for the promotion wave — ⚪ recorded

**CODE-FIRST, DB SECOND, one atomic commit.** `byExchange` = `listVenues('promoted')` **∩** `getActivePromotedVenueIds()` (static-minus-retired, `src/lib/venue-store.ts`).

- **DB-first (wrong):** WEEX flips to `promoted` but is not yet in the static array ⇒ the intersection excludes it ⇒ WEEX vanishes from `byExchange` **and** `shadow_venue_count` drops simultaneously. Invisible everywhere for the whole deploy window.
- **CODE-first (correct):** the array lands (15); WEEX is static-present but not `promoted` ⇒ intersection still excludes it ⇒ **nothing regresses**; the DB flip then reveals it.

The promotion wave also inherits the **codified force floor** from `OPS-BITMART-ENUM-RECONCILE-W1` CH4: `promote-venue.ts` `forceFloorBreaches()` REFUSES `pfe_wr = null` or `days_since < 7`, and `--force` now buys soft criteria only. **WEEX passes that floor** (84 days, `pfe_wr` non-null) — the floor is not what holds it.

---

## Recorded here, owned elsewhere

| Finding | Owner |
|---|---|
| `venue-budget-registry.ts:396` docblock still calls BITMART/WHITEBIT/XT "shadow venues" — stale since `OPS-BITMART-ENUM-RECONCILE-W1` (BITMART retired; WHITEBIT/XT promoted) | next wave touching that file |
| `venues.asset_count` 723 vs 1023 live (42% stale) | `OPS-WEEX-PROMOTE-W1` |
| V3 serves bulk `premiumIndex` (funding, all symbols, one call) and per-symbol `openInterest` — W3B's "no public funding/OI endpoints" is refuted; wiring them is a new capability | `OPS-WEEX-V3-FUNDING-AND-OI-W{NEXT}` |
| No interval machinery exists anywhere in the estate, and the LAW forbids hand-rolling — so **no effect claim can currently carry a CI** | ratchet owner, `EDGE-POPULATION-COMPARISON-W1` |
| 12 of 14 promoted venues sit at 98–102% of their attainable excess ceiling — at `q > 0.9` the excess measures the side mix more than skill | `OPS-FLEET-IDENTIFIABILITY-AUDIT-W{NEXT}` |
