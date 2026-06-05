# OPS-GRID-EXCHANGE-TRUTH-W1 — Plan-Mode endpoint-truth

**Date:** 2026-06-05 · **Wave:** OPS-GRID-EXCHANGE-TRUTH-W1 (single-session, sequential) · **Tier:** ALL (public response correctness)

- **Verdict:** **NOT a fiction-HALT** — **0 fictional primitives** (every cited production primitive live-verified). **3 MINOR drift items**, all fix-inline + within spec intent (NOT ≥3 *fictional* → no HALT). Mr.1 pre-signed the value-only public-shape change (2026-06-05 Cowork AskUserQuestion). V2-RESUME rule (hold only on NEW *blocking* drift) → **PROCEED**, drifts resolved below.
- **Pre-confirmation:** the bug is live — earlier `get_trade_call BTC` probes (during OPS-ADAPTER-RATELIMIT-UNIFY-W1 C4) returned `"closest_tradeable": {"coin":"ETH",...,"exchange":"HL"}` while the grid scores via the BINANCE default. The public surface states a false provenance.

---

## §1 — Primitive probe (claim | reality | resolution)

| Spec primitive | Probe | Reality | Resolution |
|---|---|---|---|
| `cross-asset-grid.ts` scores via `getTradeSignal` no-exchange → BINANCE | `grep -n getTradeSignal src/lib/cross-asset-grid.ts` | ✅ L216 `getTradeSignal({coin,timeframe,internal:true})`; get-trade-call.ts:116 `input.exchange \|\| 'BINANCE'` | R1 adds explicit `exchange: GRID_SCORING_EXCHANGE` |
| stale `exchange:'HL'` label | `grep -n "'HL'" …grid.ts` | ✅ L225 `exchange: 'HL' as const` (the ONE production source of the false label) | R1 → `exchange: GRID_SCORING_EXCHANGE` |
| backoff log "HL upstream rate-limited" | `grep -n "HL upstream"` | ✅ L290 `[cross-asset-grid] HL upstream rate-limited (…)` | R1 → `${GRID_SCORING_EXCHANGE} upstream rate-limited` |
| `GridCell` type | `grep -nA12 "interface GridCell" src/types.ts` | ✅ L215; **`exchange: ExchangeId`** (NOT literal `'HL'`) | constant swap is type-clean, NO widening |
| `ExchangeId` has BINANCE | `grep "type ExchangeId" src/types.ts` | ✅ `'HL' \| 'BINANCE' \| …` | `GRID_SCORING_EXCHANGE: ExchangeId = 'BINANCE'` valid |
| label flows to public fields | `grep -nA8 trimToLeaderboardCell src/lib/leaderboard-cell.ts` | ✅ L25 `exchange: c.exchange` passthrough → `closest_tradeable`/`also_see` (get-trade-call.ts:531/535) | value-only; single consumer |
| "scores via HL" comment | `grep -rn "scores via HL" src/` | ⚠️ **NOT a literal** — the real comment (L99) says "NOT HL. The `exchange:'HL'` label…". Spec paraphrase. | AC3 clause vacuously 0; real AC3 target = "HL upstream rate-limited" (L290) |
| 3 tests assert `'HL'` | `grep -rn "'HL'" tests/` | ⚠️ **drift** — see §3 | scope R2 to the 3 leaderboard assertions + add real-scorer test |
| README/docs/landing grid `'HL'` (R3) | `grep -rn closest_tradeable\|also_see\|try_next README.md docs/ landing/ \| grep HL` | ✅ **0 doc surfaces** | R3 satisfied — record "0 doc surfaces" |

## §2 — Value-only proof (no behavioral change)

- `grep -rnE "\.exchange === 'HL'" src/` → the only `=== 'HL'` branches (get-trade-call.ts:134, get-market-regime.ts:69, backfill-outcomes.ts:226, tradfi-funding.ts:152) key on the **request input** `exchange` for HL `dex` routing — **none read `GridCell.exchange`**.
- The grid's L216 call passes no `exchange` → `input.exchange || 'BINANCE'` = `'BINANCE'` → the `exchange === 'HL'` dex branch is already FALSE → `dex=undefined`. Adding explicit `exchange:'BINANCE'` keeps it FALSE → **true behavioral no-op** (R1's stated invariant).
- `GridCell.exchange`'s ONLY consumer is `trimToLeaderboardCell` (passthrough → label). Relabeling `'HL'`→`'BINANCE'` is **pure value**; no filter/router/branch keys on it. ✅

## §3 — Identifier diff (R-section ↔ AC-section ↔ live)

| Identifier | Spec sections | Live | Note |
|---|---|---|---|
| `GRID_SCORING_EXCHANGE` | R1, R2 | (new) | introduce in cross-asset-grid.ts; export for test import |
| `exchange:'HL'` | Obj/Ctx/R1/R2 | L225 (prod) + synthetic test fixtures | one prod source; rest synthetic |
| `closest_tradeable` | Obj/Ctx/AC2 | ✅ response field (get-trade-call.ts:535) | unchanged |
| **`try_next`** | Obj/Ctx/R1/AC2 | ❌ **renamed → `also_see`** (OUTPUT-SANITIZE-W1 C5; get-trade-call.ts:529-531) | **DRIFT-1**: AC2/R1 read as `also_see[].exchange` |
| `GridCell` | Ctx/R1 | ✅ types.ts:215 | unchanged |
| "HL upstream rate-limited" | AC3 | ✅ L290 | real AC3 target |

## §4 — DRIFT items + resolutions (3, all minor / non-fictional)

- **DRIFT-1 — `try_next` → `also_see`.** The legacy `try_next` field was stripped/renamed to `also_see` (OUTPUT-SANITIZE-W1 C5); live probe confirms `also_see` + `closest_tradeable`, no `try_next`. **Resolution:** R1/R4 target `also_see[].exchange` + `closest_tradeable.exchange`; AC2 live-probe asserts both == `"BINANCE"`. No behavior impact (the label-source `GridCell.exchange` is identical for both).
- **DRIFT-2 — "3 tests assert 'HL'" mischaracterizes the test landscape.** `'HL'` appears across **5 grid-context test files**, all as SYNTHETIC injection (via `_setScorerOverride`/`_setSnapshotForTest`/direct `GridCell`), asserting PASSTHROUGH — not "the real grid labels 'HL'". Two are genuine grid-OUTPUT label assertions (`get-trade-signal-envelope.test.ts:151` closest_tradeable, `integration/trade-call-also-see.test.ts:120-122` also_see); the third grep-match (`unit/leaderboard-cell-trim.test.ts`) is categorically different — a **trim-helper unit test that is intentionally exchange-AGNOSTIC** (`:51` asserts `'OKX'`, `:66-69` parametrizes all 5 venues, `:36/43/55` use BINANCE/BYBIT/BITGET). **Resolution (R2):** the **3 tests that import `GRID_SCORING_EXCHANGE` are the 2 grid-output tests (envelope, also-see) + the NEW real-scorer drift-guard test (DRIFT-3)** — this satisfies AC1's "3 updated tests import the constant" with the constant guarding the actual provenance label end-to-end. `leaderboard-cell-trim.test.ts` is left **entirely unchanged** (a pure passthrough unit test; coupling it to the grid module for a constant adds no semantic value and would erode its multi-venue coverage). `cross-asset-grid.test.ts` synthetic fixtures feed grid-LOGIC tests (sort/backoff/filter) where `exchange` is incidental and asserted on nothing → left as-is.
- **DRIFT-3 — L225's real label has ZERO test coverage (the generator gap).** `cross-asset-grid.test.ts` L18-19: "All tests bypass the real `getTradeSignal`… via `_setScorerOverride`" — the override returns at L206-209, BEFORE the real GridCell construction (L217-227). So changing L225 breaks no test AND nothing guards it. **Resolution (R2, honoring the GENERATOR + AUTOMATION-FIRST pillars "drift guarded by the imported-constant tests"):** ADD one test in `cross-asset-grid.test.ts` that mocks `getTradeSignal` (NO `_setScorerOverride`), drives `getGridSnapshot`/`refreshGrid` through the REAL L217-227 path, and asserts the produced `GridCell.exchange === GRID_SCORING_EXCHANGE`. This is the only test that actually guards the production label against re-drift.

## §5 — system-map edge-touch (Step 0)

- Touched component: `cross-asset-grid.ts` (Produces `GridCell[]` snapshot) → consumed by `get-trade-call.ts` `also_see`/`closest_tradeable` (via `leaderboard-cell.ts`). **Edge mutation: NONE structural — a VALUE correction (`exchange` label `'HL'`→`'BINANCE'`) on the existing grid → `also_see`/`closest_tradeable` consumer edge.** No new edge, no key added/removed, `tools/list`=9 unchanged. **system-map.md updated: Y** (value-correction annotation).

## §6 — Plan (R1-R4)

1. **R1** — `export const GRID_SCORING_EXCHANGE: ExchangeId = 'BINANCE'` in cross-asset-grid.ts. L216 scoring call → explicit `exchange: GRID_SCORING_EXCHANGE` (no-op). L225 `'HL' as const` → `GRID_SCORING_EXCHANGE`. L290 log → `${GRID_SCORING_EXCHANGE} upstream rate-limited`. Update the L96-108 comment (discrepancy RESOLVED, not "flagged for separate sign-off").
2. **R2** — the 2 grid-output tests (envelope, also-see) import `GRID_SCORING_EXCHANGE` (synthetic fixtures + assertions) + ADD the real-scorer drift-guard test (DRIFT-3) = **3 constant-importing tests** (AC1). `leaderboard-cell-trim.test.ts` unchanged (exchange-agnostic trim-helper unit test).
3. **R3** — 0 doc surfaces (recorded); nothing to change.
4. **R4** — `audits/grid-shape-snapshot-2026-06-05.json` pre/post; diff gate = keys identical, only `exchange` VALUES `'HL'`→`'BINANCE'`.

**Acceptance:** AC1 vitest +0 new failures; AC2 live `closest_tradeable.exchange == "BINANCE"` AND `also_see[].exchange == "BINANCE"` (try_next→also_see per DRIFT-1), keys byte-identical otherwise; AC3 `grep -rn "scores via HL\|HL upstream rate-limited" src/` = 0; AC4 status.md + system-map.md:Y + WIS. No version bump (EXTERNAL → next daily release CHANGELOG "Fixed").
