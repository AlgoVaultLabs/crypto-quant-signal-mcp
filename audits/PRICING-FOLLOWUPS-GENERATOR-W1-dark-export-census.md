# Dark-export census — the settled empirical negative

**Wave:** `PRICING-FOLLOWUPS-GENERATOR-W1` CH2 · **Measured:** 2026-08-09 at `e8a9c05` · **Ratified:** Mr.1, Q1-a

Recorded so nobody re-litigates a whole-repo dark-export guard. The answer is measured, not argued.

## What prompted it

`hoursUntilUtcDayReset()` shipped in CH4 of `PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1`: exported, unit-tested against four boundary cases, deployed — and with **one reference in all of `src/`, its own declaration**. Production told callers walled for two hours to come back in 30 days, for a day and a half, with a green suite throughout. Every assertion pointed at the primitive; none at the path. A live probe found it.

The obvious guard is "flag exported symbols nothing uses". Measured, that guard is unbuildable.

## The census — `src/lib/**` at `e8a9c05`

| | count |
|---|---|
| exported symbols | **1,812** |
| zero non-owning-file consumers in `src/` | **971** |
| ├ runtime symbol **with** a test consumer | **475** |
| ├ type / interface only | **350** |
| └ no consumer anywhere (not even tests) | **146** |

**`hoursUntilUtcDayReset` lands in the 475 bucket** — the largest one.

## Why whole-repo loses

1. **971 allowlist rows.** CH2's own draft required "every hit gets an allowlist row with a reason or a named fix — no silent seeding". That is not an afternoon's work, it is a permanent tax, and an exemption list guarding a mostly-legitimate class is negative value.
2. **It fights the house style.** The 475 bucket *is* CLAUDE.md's mandated test-importable-seam pattern ("Make entrypoints test-importable… a tool's quota/envelope/business logic lives in an exported `src/tools/<tool>.ts`"). A guard that flags the pattern the manual requires gets allowlisted into uselessness on day one — "a guard that cries wolf once is ignored forever."
3. **Signal-to-noise ≈ 0.2%.** One real defect inside 475 flagged symbols.

Type-only exports (350) and re-exports are excluded **by construction** in the delta guard rather than by row, so no one is tempted to allowlist a whole class.

## Why the delta wins — same defect, measured

Exports **new vs the merge-base** whose reference count across `src/` is **1** (the declaration alone), counting intra-file use so a module's own helpers are not flagged.

Run against the wave that shipped the defect (`f8158f0..668d808`):

| | count |
|---|---|
| new `src/lib` exports | **23** |
| flagged | **2** |
| └ `hoursUntilUtcDayReset` | the actual defect |
| └ `dailyUsedFor` | a second of the same class, previously unknown |

Correctly **not** flagged, because they are used inside their own module: `getDailyCap` (3 refs) · `utcDayKey` (3) · `INTERVAL_MONTHS` (4) · `planPrepayTotalUsd` (4).

**Two rows per wave instead of 971, catching 100% of the known defect.**

## Verification of the guard itself

- `--self-test`: 8 must-fire, 7 must-not-fire, 3 token→exit mappings; vacuity-guarded (an empty corpus REFUSES rather than passing); a config whose exemption lacks a reason must be unloadable, asserted both ways.
- **Proven able to fail on the production path**, not only in fixtures: appending one unreferenced export made the real run print `DARK_EXPORTS_VERDICT=FAIL` naming it; removing it returned `PASS`.
- Post-CH1 the same base reports **23 new declarations, 0 dark, 2 exempt** — the guard registers that `hoursUntilUtcDayReset` is now wired and `dailyUsedFor` deleted.

## Standing decision

Whole-repo dark-export scanning is **REJECTED on measurement**, not on taste. Reopening it requires new numbers, not a new argument — and the numbers to beat are in the table above.
