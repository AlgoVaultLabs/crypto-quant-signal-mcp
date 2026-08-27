# OPS-VENUE-STATUS-DERIVED-REGISTRIES-W1 — R0 classification (Plan-Mode, read-only)

Enumerate EVERY venue registry; classify (i) drives-live-calls / (ii) public-advertised / (iii) historical-rendering; state each's `venues.status` awareness. **Probed 2026-08-27**, worktree off `origin/main@957174e0`. Motivating premise (prior wave's close-out) re-derived TRUE: the static `PROMOTED_VENUE_IDS` (15, incl. BITMART) no longer equals prod `listVenues('promoted')` (14 — BITMART retired 2026-08-27T14:20:31Z). Nothing unit-guards that drift (see §parity).

## The derivation root

`EXCHANGES` (capabilities.ts:42, static 15) → `PROMOTED_VENUE_IDS = EXCHANGES.map(e=>e.id)` (capabilities.ts:84) → fans out to `SCAN_EXCHANGES`, the Zod tool enum, the x402 bazaar enum, **and the OI sampler**. One static root feeds class (i), (ii) AND (iii) — which is why "retire in the `venues` table" does not reach the static-list consumers.

## Classification table

| # | Registry | File:line | Class | Reads `venues.status`? | Iterates → LIVE API calls? | BITMART in it? | Action |
|---|---|---|---|---|---|---|---|
| 1 | **OI sampler venue list** | `oi-snapshot-sampler.ts:46` (`=PROMOTED_VENUE_IDS`), loop `:124` → `buildVenueRows` live fetch | **(i)** | ❌ | ✅ yes (per-venue OI fetch) | ✅ | **R1 fix — filter on status** |
| 2 | Funding-arb venue set | `funding-venues.ts:15` `FUNDING_VENUE_META` (curated 7: HL/BINANCE/BYBIT/GATE/KUCOIN/ASTER/OKX) | **(i)** | ❌ | ✅ yes (funding fetch per venue) | ❌ **absent** | **Q2 — filter generatively, or leave (no BitMart)?** |
| 3 | Seed loop | `seed-signals.ts:57,301` (`listVenues` + `--status`) | (i) | ✅ | ✅ | n/a | none — already status-aware |
| 4 | Labeler rotation | `backfill-directional-labels.ts` `loadGroups` retired-filter | (i) | ✅ (prior wave) | ✅ | excluded | none |
| 5 | Scan tool enum / `SCAN_EXCHANGES` | `trade-call-scanner.ts:51`, `tool-param-schema.ts:207` | (ii) | ❌ | validation allow-list only; exec Q3-protected | ✅ | DEFER |
| 6 | get_trade_call/regime enum | `tool-param-schema.ts:80` `VENUE_IDS_ALL` (17) | (ii) | ❌ | validation only; Q3-protected | ✅ | DEFER |
| 7 | `EXCHANGE_COUNT` | `capabilities.ts:70` | (ii) | ❌ | no | ✅ | DEFER |
| 8 | x402 bazaar enum | `x402-bazaar.ts:30` | (ii) | ❌ | no | ✅ | DEFER |
| 9 | `PUBLIC_VENUE_IDS` | `tool-param-schema.ts` (`=PROMOTED_VENUE_IDS`) | (ii) | ❌ | no | ✅ | DEFER |
| 10 | `EXCHANGES` array (root) | `capabilities.ts:42` | (iii) | ❌ | no | ✅ | KEEP (historical) |
| 11 | Brand colours | `venue-brand-colors.ts:33` | (iii) | ❌ | no | ✅ | KEEP (rendering) |
| 12 | Adapter registry | `getAdapter` | (iii)/infra | ❌ | per-request lookup, not iterated; Q3 refuses before it | ✅ | KEEP |
| 13 | Freshness canary | `ops/monitoring/directional-label-freshness.py:116` (SELECT all exchanges, **no status filter**) | monitoring (NOT live-calls) | ❌ | no (DB census) | via rows | **Q3 — status-filter or accept?** |
| 14 | Freshness/SLO tiers | `venue-slo-tiers.ts:23` `MAJOR_VENUES` (5) | monitoring tier | ❌ | no | ❌ (BitMart long-tail default) | none — not named |
| 15 | Rate-limit digest labels | `rate-limit-digest.ts:48` | internal report | ❌ | no | ✅ (name only) | note — cosmetic |
| 16 | Venue budgets | `venue-budget-registry.ts` | rate budget | ❌ | per-venue lookup, not iterated | 5 only | none |
| 17 | TradFi coverage matrix | `venue-coverage.ts:138` | validation | ❌ | no | n/a | none |

## The two class-(i) status-blind registries

- **#1 OI sampler** — the wave's premise. `for (const venue of PROMOTED_VENUES)` fetches OI for all 15 incl. BITMART every `:17`. Retired-in-DB, still-sampled. **Clean class-(i) fix.**
- **#2 FUNDING_VENUE_META** — drives live funding calls, but a hand-curated 7-venue set that never contained BITMART, so retirement has zero effect today. Filtering it on status is generative-correct (if GATE/KUCOIN/… retires later) but is not the motivating case. → Q2.

## Freshness canary (#13) — R3 honesty, downgraded

`directional-label-freshness.py` SELECTs `MAX(newest_signal)` vs `MAX(newest_labeled)` per exchange, **no `venues.status` filter**. `breach = input_flowing(≤48h recent signal) AND lag > slo`. BITMART's pre-retirement signals will never be labeled (labeler skips retired) → for **≤48h** post-retirement BitMart shows a `BREACH` **digest line**. BUT tiers (`:12-18`): MAJORS {BINANCE,BYBIT,OKX,BITGET,HL} page after 2 consecutive breaches; **LONG-TAIL (incl. BITMART) is digest-only, NEVER pages.** So: no false PAGE, a cosmetic ≤48h digest breach that self-resolves to `idle`. → Q3.

## Parity — the drift is real and unguarded

`capabilities.ts:79` comment claims "a unit test asserts this set equals `listVenues('promoted')`." **No such unit test exists** — `scan-promoted-derivation.test.ts:7` defers parity to a "C3 live byExchange" check, and `public-venue-scope.test.ts:39` asserts only static==static (`PUBLIC_VENUE_IDS`==`PROMOTED_VENUE_IDS`, "15 entries"). So the static(15)-vs-DB(14) drift has no unit guard. AC2 wants a zero-code-change test → Q4.

## Proposed R1 (single derivation)

New `getActivePromotedVenueIds()` in `venue-store.ts` = `PROMOTED_VENUE_IDS.filter(v => !(await getRetiredVenueSet()).has(v))` — reuses the shipped retired-set primitive (prior wave), **fail-SAFE**: `getRetiredVenueSet` fails open to an EMPTY retired set → active = full list (never silently drops a live venue, the R2 failure mode). Class-(i) consumers (OI sampler [+ funding-arb if Q2=A]) call it at their single construction point. No venue named in code.

## HALT — see chat for the Q-set.
