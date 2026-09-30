# OPS-ADAPTER-HISTORY-ANCHOR-W1 — endpoint truth (repo, figure-free)

> **No label value is read by this wave.** Every DB read is a cardinality (row counts, presence, `race_gap_candles` distribution as counts) under `T_CAP = created_at ≤ 1790402400 ∧ created_at + (W+1)·max(requested, served) ≤ 1790402400`; above the cap, cardinalities and feature presence only. Venue candles are not labels. The repo endpoint-truth is **figure-free**; figures live only in the vault twin. No `-v1` row is edited. No scoring path is edited. No public copy.

This file is figure-free. Every measured figure (gap sizes, counts, ages, budgets, vantage tallies) lives in the vault twin `audits/OPS-ADAPTER-HISTORY-ANCHOR-W1-endpoint-truth.md` of the planning vault, next to its Plan-Mode evidence folder. The file:line anchors below are at the base the probes read.

## Rulings in force

The architect ruled OAH-Q1…Q10 all A: GO WITH SCOPE CHANGE. The Q7 form is pinned. Two spec behaviours are withdrawn:
- C3 "an empty window returns an empty page";
- importing `servedCandleStepMs` into the adapters.

| Ruling | What it fixes |
|---|---|
| Q1 | Two classes. **EDIT** covers C1 step fidelity (disposition `fix`) and C3 adapter-side substitution (disposition `report` via meta); they are pinned in `tests/fixtures/adapter-history/BASELINE.json`. **REPORT** covers the front gap, C2 head gap, C4 holes and reach limits; these are measured for every pair and pinned in `REACH.json`. |
| Q2 | The meta carrier is a non-enumerable `meta` on the returned array, plus `historyMetaOf(page)`. `src/types.ts` is untouched. A copy of the page has unknown meta, never zero meta. |
| Q3 | Each adapter derives its step from its own module-local `servedIntervalMs`, which is the leaf. `tf-support` projects that leaf and is never imported by an adapter. Parity between the two is test-asserted. |
| Q4 | Adds `frontGapBars` (phase from the data, origin from `from`), `gapSlots` and `headGapBars`. The recent-branch 5-bar guard stays byte-identical as a routing predicate. |
| Q5 | C3 is report-only in this wave: bars are unchanged and `substitutedNewest` / `outOfRangeBars` expose the substitution. Real clipping waits for LRW to consume meta (`EDGE-LABELER-META-CONSUME-W1`). |
| Q6 | Serving reaches the history branch, and serving output staying byte-identical is an AC. The stale-serving defects are recorded, not fixed (`OPS-SERVED-CANDLE-TRUTH-W1`). The PFE producer is disclosed. |
| Q7 | One dated engineering-change paragraph is added under a new G5 sub-heading, "Engineering changes (input disclosures)", in the vault goals file. |
| Q8 | The LRW amendment text is drafted in CH3. It names §6 E5 and §7 E5 as deviations, and assigns cells by the time each `-v2` row was written. |
| Q9 | The contract universe is active promoted venues × faithful cron timeframes. OKX/8h and BYBIT/8h are declared UNSERVABLE. The WEEX second vantage is aoe-1. |
| Q10 | The canary takes a recent page plus a deep probe on the BITGET/OKX history branch. It runs at `24 10 * * *`, keeps its streaks under `/var/lib/algovault-monitoring/`, and uses the alert-registry row. |

## Truth table (claim | reality | resolution)

| Probe | Claim (spec) | Reality (measured) | Resolution |
|---|---|---|---|
| P1 | The Bitget fallback anchors on the requested bar: `bitget.ts:143`, `:166`; served map `:48-49`; recent slack `:160`; `okx.ts:224` | All five anchors match. The slack is counted in requested bars, so on 2h/8h it spans more served bars than its name says. The substitution sites are `bitget.ts:175` and `okx.ts:238`. | No anchor drift |
| P1 | The served table exists in ≥ 2 copies | There are per-adapter fetch maps (the leaf is `src/lib/served-interval.ts`) and two derived projections (`src/lib/tf-support.ts` private, `src/scripts/backfill-directional-labels.ts` exported). Requested-step tables still sit in `bitget.ts`, `okx.ts` and `edgex.ts`. The "29" comments are in the labeler files, not in `tf-support.ts`. | Matches; citation corrected |
| P1 | `servedCandleStepMs` (LRW CH2) is the one lookup | Absent on the probed `origin/main`. Importing it into an adapter creates a CommonJS cycle: in the labelers' load order, the served-step lookup silently returns the requested step for the importing venue. | Q3: the adapter is the leaf; a static check and a parity test enforce it |
| P2 | Separate "history-range" and "latest-N" functions per adapter | **Fictional.** There is one `getCandles`. On OKX and BITGET the two paths are runtime branches: R (the recent page accepted by the guard) and F (the history fallback). | Fixed inline: the paths are named by branch |
| P2 | Serving impact is NONE unless serving reaches F | **Reached.** The OKX 1h regime takes F on every call; BITGET 1d's R branch is clipped to 90 days; young coins take F on both venues; the public PFE producer reaches the misanchored BITGET F (latent) | Q6: byte-identical AC, disclosures, defects recorded |
| P2 | retro-basis is unchanged, as the differential proves | It has zero `getCandles` edges and its own fetchers through `upstreamFetch` | Unchanged by construction |
| P3 | The wired runner prints `SUITE_VERDICT` | `scripts/classify-suite-verdict.mjs`, fed by vitest with the CI reporters exactly as `deploy.yml` does | Gates use that recipe |
| P3 | Fixtures are pinned with `SHA256SUMS` | This is a new convention; the repo had per-file `.sha256` sidecars before | Disclosed; the gate checks `sha256sum`/`shasum` |
| P3 | Existing adapter-history tests | `tests/unit/{okx,bitget}-adapter-history.test.ts` pin endpoint presence and range. The OKX mock models `before` as the oldest page after the cursor, but the venue returns the newest page. | Q10: CH2 corrects the mock and keeps the assertions |
| P4 | `dist/scripts/` is in the image | Yes: the runtime stage copies the whole `dist`, and there are `docker exec … node dist/scripts/*.js` precedents | Matches |
| P4 | A CH1 commit deploys | Yes. `paths-ignore` does not cover `tests/**`, `audits/**`, `scripts/gates/**` or `docs/**`. | Landing law applies; land through `scripts/land.sh` |
| P5 | OKX and Bitget answer an empty history window with their newest bars | **False at the venue.** Both history endpoints return an empty page for a pre-listing window. The ADAPTER substitutes the recent page. | C3 is adapter-side (Q5) |
| P5 | The served lookup is truthful | OKX/8h (the venue rejects the interval) and BYBIT/8h (the venue returns an empty list) are counted as native. Bitget history-candles' page cap measured as expected. OKX history accepts a larger limit than documented. | Q9: UNSERVABLE declared; no served-map edit |
| P6 | Fixtures come from two vantages | Captured through the shipped adapters. The primary vantage is the Mac; for WEEX it is aoe-1, because the adapter timed out from the Mac at capture time. Every scenario is replayed by the SAME adapter from a second vantage that is not the prod IP: aoe-1, or the Mac for WEEX. Agreement on grid, phase and error class is recorded per scenario in `VANTAGES.json`. BITMART and EDGEX are retired and excluded. | Q9 AC2: every scenario has two agreeing vantages |
| P7 | Weight lives in `_upstream-fetch.ts`; costs ×2 / ×4⁄3 | The weight SoT is `src/lib/venue-budget-registry.ts`. The ratios are per-hour asymptotes; the page deltas at the labelers' real spans differ, so the harness counts integer pages per span. | Budget asserted in integer pages (CH2) |
| P8 | LRW state decides the CH3 amendment branch | As of the probe: pre-read (no `-v2` rows, pull not taken, LRW CH2 not landed) | CH3 re-probes before drafting |
| P9 | The B-DIR v3 FULL registration has a change-log section | **Fictional.** The FULL test is prose in the vault goals file (G5) plus a scheduled task; its formal registration is written at its own R0. | Q7: dated paragraph under a new G5 sub-heading |
| P10 | The runbook documents `canary_result_log`; a daytime minute is free; streaks go in `.alert-state/` | The contract lives in `ops/monitoring/canary_result_log.py`. No daytime minute is free of the every-other-minute monitor. `.alert-state/` belongs to the wrapper. | Q10: `24 10 * * *`; `/var/lib/algovault-monitoring/adapter-history-streak/` |

## Identifier diff (identifiers cited in more than one place)

| Identifier | Resolution |
|---|---|
| "30 pairs" | Replaced by the universe of active promoted venues × faithful cron timeframes (pinned in `UNIVERSE.json`) |
| "latest-N path" / "history-range path" | Branches R / F of one `getCandles`. The R branch's output stays byte-identical; the R guard is a routing predicate |
| `servedCandleStepMs` | Never imported by an adapter; parity-tested against each adapter's `servedIntervalMs` |
| `meta.headGapBars` / `gapSlots` / `outOfRangeDropped` | `headGapBars` · `frontGapBars` · `gapSlots` · `outOfRangeBars` · `substitutedNewest` (Q2, Q4, Q5) |
| page caps | Inline literals today; CH2 exports named constants |
| interlock row count | Derived from the registry with `jq` at write time, never hard-coded |
| Tree row for the nightly labeler | The map row after the one the spec cites |
| "dormant BITMART / EDGEX" | "retired" (venue store) |
| "no retries" | No rate-limit retries; at most one inherent transient retry |

## The contract suite

`tests/unit/adapter-history-contract.test.ts` replays every captured scenario through the shipped adapter, using `tests/harness/adapter-history-model.ts`. The network is stubbed and a spy asserts no real host is reached.

**Scenarios.** Each pair has two scenarios, and two violators carry extras:
- **R:** the recent page, with no `endTime`, as serving calls it.
- **D:** a deep window beyond every venue's recent reach, with `endTime`.
- **Extras:** a young coin's pre-listing window (C3), and deeper BITGET 2h/8h windows.

**Classification.** One classification (`measure`) produces three things:
- the EDIT set, which must equal `BASELINE.json`;
- the REPORT facts, which must equal `REACH.json`;
- the dead pairs, which must equal `UNSERVABLE.json`.

An incomplete deep window is classified C1 only when a CONTROL capture shows the venue serves that window on the served step (`CONTROLS.json`). Without a control, the pair fails as unclassified. A request the capture did not record is a `REPLAY_MISS`: the adapter changed what it asks for, and the fixtures must be recaptured.

**Gate.** `scripts/gates/oah-ch1-gate.sh` covers build, suite, baseline, fixture hashes, this table and the write firewall; `--self-test` covers the mutations.
