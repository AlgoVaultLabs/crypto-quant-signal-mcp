# OPS-VENUE-SET-RECONCILE-W1 — CH1 Step-0 truth probe (READ-ONLY)

Probed **2026-09-02** (Mac `date -u` 15:21Z; Hetzner box 15:00Z — clocks agree). Worktree `venue-set-reconcile-w1` @ **`e85eec46`** == `origin/main` (verified `merge-base --is-ancestor` → YES). The stale `/Users/tank/code/crypto-quant-signal-mcp` (14b418a8) was never consulted. Format: `claim | reality | resolution`.

**Method:** 9 probes fanned out in parallel, each independently adversarially re-verified by a second agent (1 of 10 verdicts refuted a sub-claim — recorded below), plus a completeness critic. 2 probes (tsc cascade, faithful-TF computation) run directly.

**VERDICT: 🛑 HALT — 7 fictional/stale primitives (threshold is 3), 6 hard blockers on the WEEX half, and the spec's deploy ORDERING is inverted.** The BITMART half is well-founded. The WEEX half cannot be executed as written.

---

## Fictional / stale primitives (≥3 ⇒ HALT)

| # | Spec cites | Reality |
|---|---|---|
| 1 | a **force floor** (`pfe_wr` non-null ∧ `days≥7` ∧ `pfe_wr≥0.70`) that `--force` must clear; "HALT on WEEX only if it trips the force floor" | **NO SUCH GATE.** `src/scripts/promote-venue.ts:52` refuses when criteria fail *without* `--force`; `:58-62` **warns and promotes regardless of ANY failure, including a NULL `pfe_wr`**. The real criteria are `days≥15 ∧ sample≥min ∧ pfe_wr≥0.80` (`:25` `PFE_WR_THRESHOLD=0.80`, `:47` `DAY_15_FLOOR`). The floor is PROSE in `audits/OPS-VENUE-GO-LIVE-15-W1-endpoint-truth.md`. **The spec's only stated HALT condition is unsatisfiable by construction.** |
| 2 | `research/shadow-venues-api-limits-2026-06-05.md` | **Does not exist; the repo has no `research/` dir** (git history checked). It is a VAULT file. Worse: `src/scripts/seed-signals.ts:70` cites it **repo-relative** — every `DELAY_PER_EXCHANGE` value traces to an unreachable SoT. |
| 3 | `getVenueUniverse` as "the one scan SoT" (also in `New-Venue-SOP.md`) | **No definition anywhere in the repo.** Survives only in 3 prose comments (`scan-funding-arb.ts:55`, `funding-venues.ts:7`, `tests/unit/seed-signals-fetchers.test.ts:38`). |
| 4 | a **"promoted-regressed" section** in the readiness digest | **No such section.** `buildReport()` emits header / READY-TO-LAUNCH / Promoted / Shadow / Retired(conditional) only. Regressions are a *separate* producer (`evaluate-venues.ts`, separate 06:00 cron, separate `sendVenueStatusChange` family). A predicate written against it would gate nothing. |
| 5 | `capabilities.ts` claims *"a unit test asserts this set equals `listVenues('promoted')`"* | **That comment was DELETED** by OPS-VENUE-STATUS-DERIVED-REGISTRIES-W1 (2026-08-28). `capabilities.ts:79-88` now says the opposite, states the test **"NEVER EXISTED"**, and forbids restoring the claim. CH1#3's premise is already-done. |
| 6 | BITMART residuals in **"canary CSVs"** | **Zero.** `grep -rniE '\bbitmart\b' scripts/` → 0 hits; no `.csv` in the repo names BITMART. |
| 7 | BITMART residuals in **"manifests"** | **Zero.** `lobehub-manifest.json`, `server.json`, `manifest.json`, `glama.json`, `package.json`, `smithery.yaml` — all 0 hits. |

---

## Probe 1 — the live drift · CONFIRMED

| claim | reality | resolution |
|---|---|---|
| `exchange_count` overstates by one | **CONFIRMED, single-caused.** `EXCHANGES` (`capabilities.ts:42-68`) = **15** entries, BITMART at **`:66`**, **WEEX ABSENT** (0 matches for "weex" in the file). `EXCHANGE_COUNT = EXCHANGES.length` (`:70`) → emitted at `src/index.ts:2984`. Live API: `exchange_count 15` vs `byExchange` **14 keys** (BITMART absent). `shadow_venue_count 1` · `funding_venue_count 7` · `asset_count 1872` · `totalCalls 552970`. | The sole counted-but-absent venue is **BITMART**. Set difference is exactly `{BITMART}` both ways. |

**Mechanism (measured, not inferred):** `byExchange` is gated by `resolvePublicPerformanceAllowList()` (`src/lib/public-performance-formatter.ts:127-148`) = `listVenues('promoted')` ∩ `getActivePromotedVenueIds()` (`venue-store.ts:277`). Retired ⇒ excluded. `exchange_count` bypasses that allow-list entirely. BITMART retired **2026-08-27T14:20:31.868Z**; it still holds 12,782 `signals` rows (newest 2026-08-27T02:30:40Z) — the absence is a FILTER, the count is a STATIC CONSTANT.

**Non-decrease baseline for CH3:** `totalCalls = 552970`, `asset_count = 1872`.

## Probe 2 — the BITMART residual set

**2a — tsc cascade (run directly; BITMART entry deleted, `tsc --noEmit`, then reverted; tree verified clean).** Exactly **THREE** files, not the 5+ the spec predicts:

| File:line | Record |
|---|---|
| `src/lib/exchange-universe.ts:656` | scan `FETCHERS` |
| `src/lib/venue-brand-colors.ts:47` | brand colours |
| `src/lib/venue-budget-registry.ts:407` | weight budgets |

**Spec expectations REFUTED:** the **OI-snapshot sampler is NOT in the cascade** — OPS-VENUE-STATUS-DERIVED-REGISTRIES-W1 made it runtime status-derived, so it needs no edit (the spec's "explicitly include the OI sampler" is already satisfied). **`tf-support` is NOT in the cascade** — `src/lib/tf-support.ts:46` is `Record<ExchangeId, …>` (the WIDE 17-member union), so its BITMART entry at `:47` is class-(ii) HISTORICAL and **must be KEPT**; removing it is a tsc ERROR, not a requirement.

**2b — the non-tsc half.** 322 hits; **47 across 14 files** are class-(i) promoted-set projections. The decisive one:

> **`src/index.ts:5147-5149` — `LB_EX_LABEL` / `LB_EX_COLOR` / `LB_EX_ORDER` are hand-maintained untyped literals inside a client-side script string. tsc CANNOT see them.** All three carry BITMART. The comment at `:5357` **falsely claims they "auto-grow with EXCHANGES"**. Runbook §2 independently confirms: "new venues render unlabeled".
> **`:5362` — the ANALYZING chip strip is UNGUARDED** (unlike the leaderboard's `if (!e) return` at `:5163`) — so **the live track-record page paints a BitMart chip today**, for a venue retired 6 days ago.

**The entire operational/live-fetch surface is ALREADY BitMart-clean** — three status-derived consumers: `oi-snapshot-sampler.ts`, `scan-funding-arb.ts` (curated 7 ∖ retired, `:244`), and `seed-signals.ts:1026-1029`. What remains is a **published-surface + test-fixture** sweep.

Other class-(i)/adjacent: `landing/docs.html:410/536/668` (baked BITMART enums, gated by an identity set-equality check at `scripts/check-docs-samples-live.mjs:396`) · `ops/monitoring/trend-mode-readout-gate.py:80` (`exchange <> 'BITMART'`, self-test `:568-569`) · `CHANGELOG.md:86` ("15 perpetual-futures venues", immutable release history).

## Probe 3 — the drift gate is **ABSENT**, not dark

| claim | reality | resolution |
|---|---|---|
| the test "should be FAILING right now"; report whether it is dark | **ABSENT — it never existed**, by the source's own admission (`capabilities.ts:84-86`). `scan-promoted-derivation.test.ts:7-8` *defers* parity to "C3 (live byExchange count == EXCHANGE_COUNT)"; grepped — **no such assertion exists** anywhere in `tests/`, `ops/` or `scripts/`. An unfulfilled deferral, not coverage. | There is no gate to repair. The wave must **BUILD** one. |

**And it cannot live in vitest:** the suite runs on SQLite with no production Postgres reachable (`recent-signals-shape.test.ts:54-55`). A vitest parity test ships structurally dark — the exact defect class this gate exists to catch. Correct venue: an **ops-scheduled PG-lane check** (container `PROMOTED_VENUE_IDS` vs `SELECT exchange_id FROM venues WHERE status='promoted'`, set equality, symmetric difference by id, verdict token, exit 3 = INDETERMINATE).

**Undeclared blast radius of a 15→14 change:** fails `tests/unit/capabilities.test.ts:37` (hard 15-id `toEqual` at `:27`), `tests/public-venue-scope.test.ts:40/:83`, `tests/unit/rate-limit-events.test.ts:94`, and trips the **hard DATA-INTEGRITY ABORT at `scripts/refresh-integrations-numbers.mjs:160-161`** ("exchange count would DECREASE") — a gate built precisely to block this.

## Probe 4 — WEEX readiness, measured

| Spec | Measured | Verdict |
|---|---|---|
| ~105 days | **83 days** (promotion clock is `COALESCE(seeding_started_at, integrated_at)` = `seeding_started_at 2026-06-11`; 105 is the `integrated_at` clock) | **WRONG CLOCK** — 21-day inflation |
| 4975/7230 (69%) | **4973/7230 (68.78%)** at the 06:00 snapshot; **5086/7230 (70.35%)** live | corrected |
| WR 93.5% | **93.568%** snapshot / **93.434%** live | confirmed (rounding) |
| ~30 rows/day | **STALE.** 7-day rate = **120.7/day**; per-day 08-30=55, 08-31=219, 09-01=306, 09-02=197 — a **~7× step-change on 2026-08-30/31** with no known cause | **unexplained producer anomaly** |

Shortfall **2144** (live). Extension budget **SPENT (2/2)**; `review_deadline_at 2026-10-16`, so the daily eval is silent on WEEX until then. **WEEX emits 98.43% BUY** — engine WR 93.43% vs mix-matched null 90.67% (**+2.76pp**) and always-BUY 92.09% (**+1.34pp**): positive but thin and effectively single-sided, which the estate's own identifiability LAW flags as barely-identifiable.

*(The spec's cadence SQL is also defective: `signals.created_at` is epoch-SECONDS `integer`, not epoch-ms — the given query returns 0.)*

## Probe 5 — WEEX has **no** rich fetcher and **no** true OI

Only `fetchWeexCoins(topN): Promise<string[]>` (`seed-signals.ts:640`), a volume-only seed fetcher. No `ExchangeAsset[]` fetcher — and `FETCHERS` is keyed by `PromotedExchangeId`, so one cannot exist until WEEX is in `EXCHANGES`. The ticker/contracts bulk payloads carry **no OI**; a newly-found per-symbol `/capi/v2/market/open_interest` returns 200 but is unit-undeclared, internally inconsistent (`base_volume === target_volume` on every symbol) and non-bulk (1027 calls/refresh) — **not** a usable OI source. `OI_PROXY_VENUES` (`exchange-universe.ts:665`) has **FOUR** members (BINANCE, ASTER, BINGX, XT), not two. WEEX can only ship as a **clearly-labelled volume proxy** (`oiIsProxy: true` + `OI_PROXY_VENUES`). Live WEEX perp count **1027** vs stored `venues.asset_count = 723` — a 42% stale count.

## Probe 6 — WEEX faithful-TF set (computed, not assumed) · **GREEN**

`FAITHFUL_MAX_RATIO = 2`; `CRON_TIMEFRAMES = 3m,5m,15m,30m,1h,2h,4h,8h,12h,1d`.

| tf | served | faithful |
|---|---|---|
| 3m | 5m (1.67× coarser — under the 2× bar) | ✅ |
| 5m | 5m | ✅ |
| 15m | 15m | ✅ |
| 30m | 15m (finer) | ✅ |
| 1h | 1h | ✅ |
| 2h | 1h (finer) | ✅ |
| 4h | 4h | ✅ |
| 8h | 4h (finer) | ✅ |
| 12h | 4h (finer) | ✅ |
| 1d | 1d | ✅ |

**`faithfulTimeframes(WEEX)` = all 10. SKIPPED = none.** No-stranded invariant satisfied with 3m/5m/15m/30m ≤30m. The spec's "verify which are finer-synthesised vs coarser-substituted" resolves: 3m is coarser-substituted but passes; 2h/8h/12h/30m are finer-synthesised.

## Probe 7 — heartbeat fix **SHIPPED and DEPLOYED**

`recordSeedHeartbeat` is stamped at **attempt-time, before** `isTimeframeFaithful` — verified in source, in the git graph (landed `523fee99`, 2026-07-24), and in the running container's compiled `dist`. **Spec's WHITEBIT-class risk premise is void twice over:** WEEX skips zero timeframes so never reaches the faithful-skip early-return, and WEEX is **not** the thinnest lane — 298 rows/24h vs WHITEBIT's 280.

## Probe 8 — WEEX rate limit: still discrepant, now **self-contradictory within one API**

WEEX's own `/capi/v3/market/exchangeInfo` declares `interval:"MINUTE", intervalNum:10, limit:500` (**0.833 req/s**) while its **response headers** say `x-used-weight-10s` (**50 req/s**) — a **60× spread**. Live setting is 300 ms. Conservative reading ⇒ budget ≤0.417 req/s ⇒ **≥2400 ms/request** (an 8× slowdown). Native intervals are **under-stated** by the spec: V3 serves `1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, 1w` (four more than claimed); "no native 3m" and "2h/8h absent" both CONFIRMED. **The live adapter is on the DEPRECATING V2 path** (`src/lib/adapters/weex.ts:93` `/capi/v2/market/candles`) carrying a "V2 Sunsets Sep 30" banner **with no year** — if 2026, it dies in 28 days. `weex.ts:33-38` also downgrades `30m→15m` and `12h→4h`, both of which **V3 serves natively** — a V2 artifact, not a venue limitation. **WEEX has no row in `venue-budget-registry.ts`** (shadow block `:412-416` "Empty today").

## Probe 9 — the digest seam

One `sendDigest()` at **`:132`**; six sections (5 pure + 1 flag-gated equity). `EQUITY_TOOLS_ENABLED` is **UNSET in the live container** and absent from `/opt/crypto-quant-signal-mcp/.env` — the equity card has never rendered in production. **Constraint the spec omits:** `scripts/check-delivery-assertion.mjs` R1/R3 require the `sendDigest` result bound and the `label:` present, and its self-test fixture **quotes `:132` verbatim at `:224`** — so the predicate must not restructure `:132`/`:126`. The equity leg needs a hoist (`renderToolReadiness(await loadEquityReadinessInput(dbQuery))` is inlined at `:117`, never bound) — **unbudgeted refactor**. Test file **EXISTS** (83 lines, pure-render only) — the spec should say EXTEND, not create.

## Probe 10 — canaries · **no edit required** (one sub-claim refuted and corrected)

**TWO** `exchange_count` rows, not one: `HOMEPAGE_VENUE_COUNT_EXACT` (`ops/monitoring/website-drift-manifest.yaml:80-89`) and `TRACKRECORD_EXCHANGE_COUNT_DTRF_EXACT` (`:258-267`) — both `tolerance_type: FLOOR`, both `tg_fires: true`. **Neither stores a floor VALUE**; FLOOR is relational and re-scraped (`website-drift-canary.py:478`: `fires = sot_value < page_value`). Names mislead — `*_EXACT` on FLOOR rows.

**Adversarial refutation (upheld):** the claim "a 15→14 breaks BOTH rows ⇒ two TG pages" is **FALSE — only ONE row can fire.** `TRACKRECORD_…` scrapes `/track-record`, which is **container-served per request** and renders `${EXCHANGE_COUNT}` (`src/index.ts:4824`) from the **same import** as the SoT (`:2984`), so page == SoT always. Only the **deploy-baked landing page** (`HOMEPAGE_…`) can skew.

**seed-coverage-canary** does **not** call `listVenues` — raw psql `SELECT … FROM venues WHERE status='promoted'` (`ops/cron/seed-coverage-canary.sh:37-39`). Live-derived ⇒ no edit. Host copies **md5-match** the worktree — "sync the host canary" would be a no-op. A length-preserving 15→15 swap needs **no manifest edit**.

---

## Completeness critic — SIX hard blockers on the WEEX half

1. `venue-budget-registry.ts:392/407` tsc-exhaustive; **no `weexWeightBudget`**, `SHADOW_VENUE_BUDGETS` **empty**.
2. `venue-brand-colors.test.ts:81` asserts WEEX **absent** while `:54-58` will demand it **present** — and `:68` pins "the exact Mr.1-approved palette (no silent re-tint)". **Needs an Mr.1-approved hex** (plus a second chart-distinct one for `LB_EX_COLOR`).
3. `public-venue-scope.test.ts:46` — a second WEEX-absence assertion.
4. `landing/docs.html:410/536/668` baked BITMART enums vs the identity set-equality gate at `check-docs-samples-live.mjs:396`.
5. `index.ts:5147-5149` hand-maintained `LB_EX_*` whose own comment falsely claims derivation.
6. **Promotion is NOT monotonic for coverage:** the promoted 1d lane is a hardcoded `--exchange-list BINANCE,BYBIT,OKX,BITGET`, so promoting WEEX **DELETES its 1d seeding** (it gets 1d today via the `--status shadow` lane), invisibly to the seed-coverage canary. 5m depth also drops 50→30. **Nine already-promoted venues have zero 1d accrual today.**

**Plus:** `README.md:260/267` and `CHANGELOG.md:38` ship a **BREAKING notice that WEEX returns `-32602`** — promoting it contradicts published copy, and a code wave cannot bump versions.

## 🔻 ORDERING IS INVERTED (the spec's CH3 #1 is wrong, and CH3 #1 authorises CH1 to say so)

`getActivePromotedVenueIds()` is **static-minus-retired** (`venue-store.ts:278-281`), and `byExchange` = `listVenues('promoted')` **∩** that set. Therefore:

- **DB-first (spec's order):** WEEX becomes `promoted` in the DB but is **not** in the static array ⇒ excluded by the intersection ⇒ WEEX vanishes from `byExchange` **and** `shadow_venue_count` drops to 0 **simultaneously**. WEEX is invisible everywhere for the whole deploy window.
- **CODE-first (correct):** the array swap lands (still 15); WEEX is in the static set but not yet `promoted` ⇒ intersection still excludes it ⇒ **nothing regresses**; the DB flip then makes it appear.

**Ship CODE first, flip the DB second.** And `−BITMART` + `+WEEX` must be **ONE commit** — a split 15→14 window hard-aborts `refresh-integrations-numbers.mjs:160-161` and breaks the one live FLOOR row.

**Data integrity:** no historical BitMart data is at risk — `byExchange` already excludes it (live 14 keys); it was removed at retirement. Any step premised on "preserve BitMart's historical rows through the removal" is a no-op.

---

## Ownership collision (governance)

`src/lib/capabilities.ts:88` explicitly assigns this exact removal to **`OPS-BITMART-ENUM-REMOVE-W1`** ("Reconciling this static list to the DB truth is owned by OPS-BITMART-ENUM-REMOVE-W1, which also removes retired venues from the public enum"). Executing it here without a ruling **routes around another wave's declared ownership** — a CLAUDE.md "Never" absent an explicit architect decision.

## CH1 Verification Gate

`audits/OPS-VENUE-SET-RECONCILE-W1-endpoint-truth.md` present · zero tracked files mutated (tsc-cascade probe reverted; probe scratch file deleted; `git diff --quiet` clean) · **CH1_GREEN as a probe**, wave **HALTED** pending architect ratification.
