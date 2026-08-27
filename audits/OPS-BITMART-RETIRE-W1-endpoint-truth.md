# OPS-BITMART-RETIRE-W1 — R0 endpoint-truth (Plan-Mode, read-only)

Retire a winding-down poison venue, emission-side only, reversibly. **Probed 2026-08-27**, worktree off `origin/main@e5698c5d`. `claim | reality | resolution`.

---

## R0.1 — wind-down verified (primary source)

| Claim | Reality | Resolution |
|---|---|---|
| BitMart winding down, terminal | **CONFIRMED.** BitMart announced an orderly wind-down **2026-07-26**; spot/futures trading **discontinued 2026-08-26 01:00 UTC** (yesterday), full closure **2027-01-31**. BMX −58%. 3rd CEX closure in July 2026 (after AscendEX, BitMEX). | API degradation is terminal, not transient — repair is wasted. Source: `coindesk.com/markets/2026/07/26/crypto-exchange-bitmart-to-shut-down-after-nine-years-bmx-token-crashes-58`. |

## R0.5 — the mechanism (use it, don't invent)

`src/scripts/retire-venue.ts` → `retireVenue('BITMART')` sets `venues.status='retired', retired_at=now`. The data-driven seed loop (`listVenues` table-driven selection) excludes `retired` → BitMart stops **seeding** on the next cron fire. Idempotent. **Reverse:** `node dist/scripts/promote-venue.js BITMART` (or `setStatus('BITMART','promoted')`). Live venues row today: `BITMART | promoted | promoted_at 2026-07-23`.

## R0.2 — enumeration (118 refs / ~23 files) + the emission map

| Surface | Data-driven off `venues.status`? | Action |
|---|---|---|
| **Seeding** (`seed-signals.ts` via `listVenues`) | ✅ | `retire-venue.ts` stops it |
| **Labeler rotation** (`backfill-directional-labels.ts`) | **❌ NOT** — venue set = `byVenue.keys()` from `loadGroups()` = venues with UNLABELED signals. BitMart's **12,782 historical signals** keep it in the rotation → the labeler fetches BitMart klines from the DEAD API → errors → the A2 circuit-breaker trips (the exact `venue-circuit-break` that voided the 2026-08-27 capacity run). | **R1 code change**: `loadGroups`/rotation must exclude `venues.status='retired'`. Emission/processing-side — NO row deletion; BitMart's unlabeled historical signals simply stay unlabeled. |
| **Freshness SLO tiers** (`venue-slo-tiers.ts` `MAJOR_VENUES`=5; BitMart = long-tail default) | BitMart not named (long-tail by default) | none needed; once out of the labeler set it can't trip |
| **Static registry** `EXCHANGES`/`PROMOTED_VENUE_IDS`/`FETCHERS`/budgets/adapters/brand-colors | static (compile-time) | **KEEP** — needed for historical `byExchange` rendering + count stability |
| **Public tool `exchange` enum** (`get_trade_call`/`get_market_regime`/`scan_trade_calls`, `docs.html`, x402 bazaar) | derived from static `PROMOTED_VENUE_IDS`/`VENUE_IDS_ALL` | **PUBLIC COPY — names BITMART. Mr.1-gated (Q3).** Retirement does NOT auto-remove it. |

## R0.3 — public-count impact (monotonic FLOOR)

`EXCHANGE_COUNT = EXCHANGES.length` (STATIC 15; `capabilities.ts:70`). `/api/performance-public.exchange_count = EXCHANGE_COUNT` (`index.ts:2890`). **Retiring via the venues table does NOT change EXCHANGE_COUNT** — it stays 15 as long as BitMart is kept in the `EXCHANGES` array → **no monotonic-counter regression**. Landing prose is count-free (OPS-VENUE-COPY-LIVEBIND-W1) ✓. The only public surfaces that NAME BitMart are the tool `exchange` enums (Q3).

## R0.4 — historical record (emission-side only)

Baseline (must be byte-unchanged): `signals` BITMART = **12,782**, `oi_snapshots` BITMART = **50,940** (directional_labels keyed via signal FK, no `exchange` col). Retirement flips a status flag + adds a labeler filter — it deletes/mutates NO rows. Forward effect: BitMart accrues no NEW signals/labels; its existing record + published aggregates are frozen, unchanged.

---

## R0.6 — R2 second-order fixes (in scope)

- `DIRECTIONAL_LABEL_CAPACITY_SHORTFALL` payload emits `outcome=venue-circuit-break` with NO venue + NO error class → add both (same class as OPS-AOE-APPROVED-CAUSE-RENDER-W1). Location TBD in R1 (labeler script / capacity canary).
- One breaker-tripped venue voids the WHOLE capacity claim → report capacity for the measurable venues, mark the excluded one INDETERMINATE *for that input* (the estate's vacuity rule), not for the corpus.

## R0.7 — Architect HALT (public-copy gate + labeler-filter confirm) — see chat.

Emission-side retirement + the labeler filter are the operational fix; the public tool-enum naming of BitMart is Mr.1-approval-gated and must be decided before the commit.
