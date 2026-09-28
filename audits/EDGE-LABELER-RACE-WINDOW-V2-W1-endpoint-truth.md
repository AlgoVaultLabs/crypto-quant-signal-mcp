# EDGE-LABELER-RACE-WINDOW-V2-W1 — endpoint truth (repo copy, figure-free)

> ## ⚠️ HEADER CLAUSE — REPRODUCE VERBATIM AT THE TOP OF EVERY REPORT THIS WAVE WRITES
>
> **A `-v1` label is never edited, overwritten or deleted.** The corrected race is a new, versioned label series (`tau{0.5,1.0,2.0}-floor0.30-v2`) written **beside** `-v1`; every consumer migrates by an explicit wave of its own; nothing switches silently (AVS-1 §5, §9: values preserved, methodology versioned, changes published before they take effect).
>
> **The seal is respected in full.** Writing `-v2` for rows above `T_DIAG_END` is a mechanical label write, exactly like the nightly labeler's. Reading a label value above `T_CAP` is not: the disagreement table is computed **under `T_CAP` only**; above it, cardinalities (rows written, holes counted) and nothing else.
>
> **Three foreign consumers are flagged, not routed around:** the B-DIR v3 FULL test (registered on `-v1`; owner B-DIR v3 FULL / Cowork Main-AOE), the HOLD-discipline pre-registration (earliest read 2026-10-07; owner EDGE-HOLD-DISCIPLINE) if R0 finds the hold labeler shares the defect, and the DWR SoT digest / `dwr_baseline_runs` / AOE `edge_gate` + retune (pinned to `-v1`). Each gets a migration row in the consumer registry and a line in `status.md`; none is changed here.

**This file is the public, figure-free projection** of the private vault record `audits/EDGE-LABELER-RACE-WINDOW-V2-W1-endpoint-truth.md` (figures, per-probe evidence) and its artifact directory `audits/EDGE-LABELER-RACE-WINDOW-V2-W1-planmode-2026-09-28/`. It carries identifiers, code citations, rulings and the CH1 probe lines `scripts/gates/lrw-ch1-gate.sh` reads.

**R0 (Plan Mode):** 2026-09-28 12:18Z → 13:46Z, read-only, on `origin/main` `3899ab71`; production reads as `aoe_readonly` only (`BEGIN READ ONLY`, token `current_user=aoe_readonly transaction_read_only=on` on every statement file); 10 probes, each re-derived by one or two adversarial verifiers, plus a completeness critic. **HALT** 13:59Z (0 fictional primitives, 7 HALT-class premise conflicts). **Rulings** LRW-Q1…Q14 received 2026-09-28 (architect: GO, resume from CH1).

---

## 1. R0 truth (figure-free)

| Probe | Result |
|---|---|
| R0.1 hole fixture | Reproduced end to end through the real `processGroup` (DB and adapter replaced at the golden test's seams): an off-grid first row, a `coveredUntil + tf` extension, one grid candle never requested, the race spanning W+1 slots and writing a label that differs from the gap-free race. The committed golden fixture contains no hole (its `created_at` sit on its candle grid), so the cache fix leaves its pinned `-v1` labels unchanged; the R0.1 fixture is CH2's regression test. |
| R0.2 hold labeler | **SHARED** — `backfill-hold-decision-labels.ts:466` carries its own copy of the extension, `:365,:380` page on the requested interval, `:486` races through the imported index race. |
| R0.3 consumers | Every SQL reader of `directional_labels` in both repos pins an exact `-v1` literal or a bound constant; none uses LIKE / prefix / GROUP BY on `barrier_spec`; no view, trigger or matview references the table — a `-v2` row cannot enter a `-v1`-pinned result. Scope hazards: the expiry-path SQL is spec-agnostic (`backfill-directional-labels.ts:936,:947,:986-992,:1018-1022`); ADS-1's pull asserts table-wide write counters (`scorecard.ts:639-641`); the scorer-input canary's `any_spec` leg is a non-gating record. AOE retune `edge_cilb_map` is LIVE (`retune_flow.py:98-103` defaults to `dwr_edge`). |
| R0.4 reach + budget | Measured (vault). Fetching one merged range per group on the served step is the load-bearing design; the nightly is saturated at its 210-minute budget. |
| R0.5 replay | Two independent implementations of a label-free replay agree row for row after two shared model corrections (a call is one INSERT instant — split at > 2 s; WEEX 30m / 12h were served 15m / 4h before `2828ac00`). Canonical worklist sha `58dcff766db9d120aa64b6ef8486fdd9742e304521447f1beced7a67e1df6022`; crossed stratum sha `9b36df47d0abf8429b3055939ba273ad67b0c57c8799f00e0dc5b8022282848e`. |
| R0.6 DDL | Next migration `044`; Postgres 16 → a nullable column is catalog-only; 0 CHECK, 0 triggers; UPDATE never moves `computed_at`; `label` is SMALLINT NOT NULL (no honest carrier for a refused window — ruled: no row). `ddl-parity` compares column names only (one ALTER per column). |
| R0.7 literals | The `-v1` set lives at `directional-labeler.ts:67-71` (aliased `backfill-directional-labels.ts:83`); hold `:99-101`; dwr `:64-65`; `venue-slo-tiers.ts:44`; 4 AOE Python constants + 2 sha-gated vendored JSON. `floor0.30-v2` has no prior meaning anywhere. Appending to `BARRIER_SPECS` would break six things — ruled a separate export. |
| R0.8 gate preconditions | Present. The deploy interlock SIGTERMs every `dist/scripts/backfill-directional-labels` process; `audits/**` and `docs/**` are not paths-ignored (a registration commit deploys prod). |
| Design probe — grid | The expiry derivation is phase-safe and extractable. Six venue × interval pairs open on UTC+8 boundaries (OKX 12H / 1D, BITGET 6H / 12H / 1D, HTX 1day). `bitget.ts:143,:166` anchor the history fallback on the requested bar while serving 1H / 6H (`:48-49`); OKX / Bitget recent paths accept a 5-bar front gap (`okx.ts:224`, `bitget.ts:160`). |

## 2. Identifier diff

| Identifier | Verdict |
|---|---|
| W (`EVAL_CANDLES`) | MATCH |
| served grid | MATCH in count; comments at `directional-labeler.ts:108` and `backfill-directional-labels.ts:956` say 29 (stale); the grid is time-varying (WEEX `2828ac00`) and phase ≠ 0 on six pairs |
| `-v1` literals | cite drift: `backfill-directional-labels.ts:57-59` → `directional-labeler.ts:67-71` (corrected inline) |
| race scan | cite drift: `directional-labeler.ts:204` → `:206` (corrected inline) |
| `T_CAP` | Build Rule 4's served-only form admitted finer-served rows the Q11 ruling seals → ruled the max form (LRW-Q8) |
| `T_DIAG_END`, `T_FLIP`, commits `20129e14` / `4d172810` / `09e87c6c`, nightly schedule | MATCH |

## 3. Rulings folded in (architect, 2026-09-28) — pre-resolved corrections

| # | Ruling | What it binds |
|---|---|---|
| LRW-Q1 | A | `-v2` σ = the `-v1` formula on a gap-free served-grid history (≥ 30 contiguous windows, else no `-v2` row, `unreachable:history`); R1 reads "same formula, corrected inputs"; σ-input-changed is a registered disagreement axis |
| LRW-Q2 | A + all-W | a refused window writes **no** `-v2` row; refusals counted per run and in a sha-pinned per-row manifest; DEFER (window not closed at fetch, the `directional-labeler.ts:132` predicate) is its own no-row class |
| LRW-Q3 | approved | `race_gap_candles` = served-grid slots of the row's TRUE W-window absent from the cache it was raced on; historical `-v1` = canonical replay `gap_served_L` keyed `(signal_id, barrier_spec)`; snapshot → CH2 container start = delta replay, same code; after CH2 = the one live derivation (expected 0, never asserted 0); `-v2` = 0 by construction; the canary asserts live-recount equality |
| LRW-Q4 | A | `-v2` = W served candles on coarser-served pairs (own registration cell); the `-v1` race input clipped to `[entry, entry+(W+2)·requested]` so `-v1` stays byte-identical to its registered self |
| LRW-Q5 | B | the historical `-v2` covers every eligible signal the corrected race reaches; the disagreement read is twins-only |
| LRW-Q6 | A | the nightly writes `-v2` only for signals whose `-v1` row the same run writes; `-v2` never joins the 21-day lookback |
| LRW-Q7 | A+B+C+D | no nightly disagreement rate; above `T_CAP` totals only; add-only proof = server-side digest under `T_CAP` + a static SQL assertion; no outcome tallies in `-v2`/relabel modes, and the existing `DONE` line's tallies stripped after a parser grep shows 0 |
| LRW-Q8 | yes | `T_CAP` = `created_at ≤ 1790402400 ∧ created_at + (W+1)·max(requested, served) ≤ 1790402400` everywhere |
| LRW-Q9 | granted (a)–(e) | `BARRIER_SPECS_V2` a separate export in `directional-labeler.ts`; `FRESHNESS_BARRIER_SPEC_V2` a test-pinned retype; the expiry derivation extracted into exported pure helpers with a byte-identical differential test; the whole fetch plan on `servedStepMs`; expiry SQL stays spec-agnostic and the `-v2` INSERT writes `ret_at_expiry_pct` inline; test re-pins |
| LRW-Q10 | B | adapter anchors → `OPS-ADAPTER-HISTORY-ANCHOR-W1`; BITGET 2h / 8h and 5-bar-front-gap windows counted in the cell "unreachable pending OPS-ADAPTER-HISTORY-ANCHOR-W1" |
| LRW-Q11 | A | CH2b write-only hold `-v2` nightly via the shared helpers (step passed in); hold `-v1` unchanged until its owner rules; no hold read, canary arm or DDL |
| LRW-Q12 | A (earlier) | order: LRW CH2 (≥ 06:30Z 2026-09-29, after ADS-1's fixed-nightly spot-check) → ADS-1 `-v2` amendment lands → LRW CH3 relabel + annotation → LRW disagreement pull → ADS-1 pull |
| LRW-Q13 | approved | group-ranged fetch; host-detached per-venue runner (own lock and log); ctid-ordered annotation batches; 18:30–02:15Z slots; the relabel's own request share ≤ 50 % of documented limits, never above the batch cap, HL never displacing seeders |
| LRW-Q14 | approved (a)–(d) | cite-only drift = CONFIRMED + a correction row; registration lands 06:30–17:45Z with no labeller alive; Q10 = registered in CH1, measured in CH3; the registration strata |

**Scheduling resolution (Code, recorded):** the `-v2` definition section of `docs/Directional-Accuracy-SoT.md` moves from CH4 to CH2, because the ADS-1 amendment — which lands between CH2 and CH3 — cites it. The migration table and `-v1` DEPRECATED notice stay in CH4.

## 4. Correction rows (cite-only drift fixed inline — ruling LRW-Q14-a)

```
CORRECTION_1=directional-labeler.ts:204 -> :206 (runTripleBarrier scan = forwardAsc.slice(0, W))
CORRECTION_7=backfill-directional-labels.ts:57-59 -> directional-labeler.ts:67-71 (BARRIER_SPECS; aliased backfill-directional-labels.ts:83)
CORRECTION_7=AOE "four byte-equal copies" -> 4 Python constants (equality observed, not gated) + 2 sha-gated vendored ADS-1 JSON
CORRECTION_7=code comments "29 fetch-and-relabel pairs" -> 30 (directional-labeler.ts:108, backfill-directional-labels.ts:956; fixed in CH2)
```

## 5. CH1 probe lines (read by `scripts/gates/lrw-ch1-gate.sh`)

```
PROBE_1=CONFIRMED hole reproduced through the real processGroup; golden fixture unaffected; cite corrected (CORRECTION_1)
PROBE_2=SHARED hold labeler carries its own copy of the extension and races through the imported index race
PROBE_3=MEASURED consumer census complete; no -v1-pinned reader can read a -v2 row; scope hazards ruled (LRW-Q7, Q9, Q12)
PROBE_4=MEASURED reach, pages, throughput and slots sized (vault); plan ruled (LRW-Q13)
PROBE_5=MEASURED canonical replay worklist 58dcff76…6022 (two implementations, 0 mismatches)
PROBE_6=MEASURED migration 044 free; catalog-only; refused-window carrier ruled (LRW-Q2)
PROBE_7=CONFIRMED literals located; cite drifts corrected (CORRECTION_7); -v2 home ruled (LRW-Q9a)
PROBE_8=CONFIRMED gate tooling present; deploy/landing constraints ruled (LRW-Q14b)
```
