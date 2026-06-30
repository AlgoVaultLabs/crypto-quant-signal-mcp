# OPS-VENUE-GO-LIVE-2026-06-30 — endpoint-truth (Plan-Mode, PRE-APPROVAL)

**Wave:** OPS-VENUE-GO-LIVE-2026-06-30 (Venue Go-Live, RUNBOOK-VENUE-GO-LIVE.md §4 batch)
**Classification:** Phase A = INTERNAL code wave (NO version bump). Phase B = EXTERNAL (rides next daily `RELEASE-vX.Y.Z-W1`).
**Target ICP tier(s):** T1 (crypto perp traders / agents) + T2; META (capability-count milestone: 5→12 exchanges).
**Risk markers present (Plan-Mode mandatory):** live promotion (state mutation on public Merkle-anchored record) · public-copy · tool-schema change · identifier cited >1 place · ≥4 surfaces.
**Status:** 🛑 **HALT — awaiting architect approval.** All probes read-only. NO state mutation performed.

> $REPO = `/Users/tank/code/crypto-quant-signal-mcp`. Deploy host Hetzner `204.168.185.24` (CPX42, 8 vCPU/16 GB). Probed 2026-06-30.

---

## TL;DR for the architect

1. **The 7 flips are clean + safe.** All 7 (ASTER, BINGX, GATE, HTX, KUCOIN, MEXC, PHEMEX) re-confirmed **✅ QUALIFIED live** at 2026-06-30 (read-only readiness report against prod DB). No `--force`. BITMART correctly held (58% of sample bar). `promote-venue.ts` self-gates (re-checks criteria at flip-time, refuses below-bar). **The HALT gate (`venue-public-formatter.ts`) is FIELD-keyed, not venue-keyed → cleared, no blocker.**

2. **The runbook materially under-scopes the code side.** Three surfaces the runbook calls "🟢 AUTO / one enum" are actually hardcoded-at-5 in code and will NOT move on a status flip:
   - **`exchange_count`** is a *static* `EXCHANGES.length` in `capabilities.ts` — promotion does NOT increment it (this is the runbook's own §1.3 "one real gotcha", and the reality is it does not auto-move).
   - **The /track-record leaderboard** iterates a hardcoded `LB_EX_ORDER` of 5 (index.ts) — not data-driven over `byExchange` as the runbook claims; the 7 new venues are invisible there until extended.
   - **`scan_trade_calls` 5→12 is NOT "one tool-schema change."** Its universe engine (`getExchangeTopAssetsWithVolume`) is backed by a 5-only `FETCHERS` record and **throws** on any other venue. Widening the enum alone ships a tool that 500s on the 7 new venues across all 4 channels. The real work = **7 new live universe fetchers** + 4 set-representations widened + 1 test flipped.

3. **One decision needed (scan scope)** — see §8. Everything else has a defined resolution and is ready to execute on approval.

Nothing fictional (every file/script/endpoint exists). The gaps are spec-vs-code *semantics*, not missing primitives.

---

## Step 0 — system-map edge-touch enumeration

| Edge | Change | Same-commit map update |
|---|---|---|
| `venues` table → `/api/performance-public.byExchange` (WHERE status='promoted') | promoted count 5 → 12 (status-driven; auto) | Y (byExchange 5→12) |
| `EXCHANGES` (capabilities.ts) → `EXCHANGE_COUNT` → eyebrow / track-record header / Tier-2 FAQ / `/api/performance-public.exchange_count` | 5 → 12 (code edit) | Y |
| `LB_EX_ORDER`/`LB_EX_LABEL`/`LB_EX_COLOR` (index.ts) → /track-record leaderboard rows | 5 → 12 (code edit) | Y |
| `SCAN_EXCHANGES`/`ScanExchangeId` (trade-call-scanner.ts) → webhook-api + scan-digest-scheduler | 5 → 12 (scan decision) | Y if scan in-scope |
| `scan_trade_calls` Zod enum + x402-bazaar enum + `FETCHERS`/`PromotedExchangeId` (exchange-universe.ts) | 5 → 12 (scan decision) | Y if scan in-scope |
| `website-drift-manifest.yaml` `.exchange_count` (Hetzner host) | EXACT(5) → FLOOR | host-side; note in status |

---

## §1 Preflight (per venue) — RESULTS

### §1.1 Readiness re-confirm (LIVE, read-only)
Ran `DRY_RUN=1 node dist/scripts/venue-readiness-report.js` in `crypto-quant-signal-mcp-mcp-server-1` (prod DB) at 2026-06-30. Script is read-only (`listVenues` + `computeVenueStats` → stdout; DRY_RUN skips TG). Criteria: `days≥15 ∧ buy_sell_sample≥min ∧ pfe_wr≥0.80`.

| Venue | Day | Sample vs target | PFE WR | Verdict |
|---|---|---|---|---|
| ASTER | 28 | cleared (206%) | 83.3% | ✅ QUALIFIED |
| BINGX | 28 | cleared (154%) | 95.3% | ✅ QUALIFIED |
| GATE | 28 | cleared (229%) | 93.4% | ✅ QUALIFIED |
| HTX | 28 | cleared (211%) | 92.7% | ✅ QUALIFIED |
| KUCOIN | 19 | cleared (267%) | 94.1% | ✅ QUALIFIED |
| MEXC | 19 | cleared (103%) | 95.0% | ✅ QUALIFIED |
| PHEMEX | 28 | cleared (103%) | 87.1% | ✅ QUALIFIED |
| **BITMART** | — | **58% (below bar)** | 93.7% | **⏳ HELD — stays shadow, no --force** |
| EDGEX / WEEX / WHITEBIT / XT | — | 6% / 13% / 67% / 42% | — | stay shadow |

(Absolute sample/threshold numbers withheld from this public-repo file per SV-01; full numbers in the vault status entry.)

### §1.2 `--force` policy
**No `--force` this batch** — all 7 clean ✅. MEXC (103%) and PHEMEX (103%) are the thinnest margins but above bar.

### §1.3 `exchange_count` probe (the "one real gotcha")
`curl /api/performance-public` → `exchange_count: 5`, `shadow_venue_count: 12`, `byExchange` keys = `[BINANCE,BITGET,BYBIT,HL,OKX]` (5). **None of the 7 already promoted → ship-boundary clear.**
**GOTCHA CONFIRMED REAL:** `exchange_count` = `EXCHANGE_COUNT` = `EXCHANGES.length` (a *static frozen array* in `src/lib/capabilities.ts:42-50`), NOT `listVenues('promoted').length`. **Promotion does NOT increment it.** → Phase A must widen `EXCHANGES` 5→12 + redeploy, else the eyebrow/header/FAQ stay at 5 (see GAP-2).

### §1.4 Data-integrity guard intact
`venue-public-formatter.ts` = allow-list **by construction** (PFE-WR-only; `VENUE_FORBIDDEN_KEYS` deny-set). Promotion is add-only → no two-commit add-before-remove needed. Drift snapshot `audits/byExchange-shape-snapshot-2026-06-01.json` present.

---

## Spec-primitive probe table (claim | reality | resolution)

| # | Spec claim | Reality (probed) | Resolution |
|---|---|---|---|
| P1 | `src/scripts/promote-venue.ts` is the lever | EXISTS (102 ln); re-checks live criteria; refuses below-bar w/o `--force`; idempotent on already-promoted; `setStatus('promoted')` + TG + post-flip verify | Run in-container: `docker exec …-mcp-server-1 node dist/scripts/promote-venue.js <V>` (compiled present) |
| P2 | readiness report re-confirms QUALIFIED | EXISTS (113 ln); read-only; verdict logic matches criteria | Ran live (§1.1) ✅ |
| P3 | `venue-public-formatter.ts` field-keyed (HALT if venue-keyed) | **FIELD-keyed by construction; zero venue-name enumeration; `status` passed through** | **HALT GATE CLEARED ✅** |
| P4 | `/api/performance-public.byExchange` filters `WHERE status='promoted'` | TRUE — index.ts:2181 derives `promotedIds` from `listVenues('promoted')`; **fail-CLOSED** | Auto-updates on flip ✅ |
| P5 | per-coin tool enums already all 17 | TRUE — `get_trade_call`/`get_market_regime` (index.ts:391/560/609) all 17; `ExchangeId` (types.ts:103) all 17 | No change ✅ |
| P6 | leaderboard data-driven, grows to 12 auto | **FALSE** — index.ts:3839 `LB_EX_ORDER` hardcoded 5; iterates only that array | **GAP-3** — extend LB_EX_ORDER/LABEL/COLOR (code) |
| P7 | `scan_trade_calls` widen = one tool-schema change | **FALSE** — universe engine `getExchangeTopAssetsWithVolume` (exchange-universe.ts:243-277) is `Record<PromotedExchangeId>` 5-only + **throws** on others | **GAP-1 / §8 decision** |
| P8 | venue-store `WHERE exchange IN (5)` (line 83) gates promotion | NO — it's the one-time historical backfill (`SEED_PROMOTED_VENUES_SQL`, `ON CONFLICT DO NOTHING`); 7 are already shadow rows | benign; no action |
| P9 | drift canary venue rows | `website-drift-manifest.yaml` `.exchange_count` = **EXACT(5)** (host) | **GAP-4** — EXACT→FLOOR before next Mon 12:00 UTC |
| P10 | `scan_funding_arb` venue list | desc hardcodes 5 (tool-descriptions.ts:42); engine ranks whatever has funding data (no enum cap, no error risk) | Phase-B copy reconcile + coverage decision (non-blocking) |
| P11 | onboarding complete for the 7 (adapters etc.) | TRUE — adapters present for all 7 (`src/lib/adapters/{aster,bingx,gateio,htx,kucoin,mexc,phemex}.ts`); 28/19 days of real data | ✅ |

**Fictional primitives: 0.** Spec-vs-code semantic gaps: 4 (GAP-1..4).

---

## §7 dependency gate

### Backward deps (must be TRUE or the flip has no public effect)
- **#1 Onboarding complete** — ✅ (adapters + 28/19d data).
- **#2 `exchange_count` increments** — ❌ **does NOT auto-increment** (static `EXCHANGES`); resolved by GAP-2.
- **#3 formatter field-keyed** — ✅ **CLEARED** (no HALT).

### Forward deps
- **#4 `scan_trade_calls` 5→12** — **§8 decision** (GAP-1). The single non-automatic transport surface.
- **#5 `scan_funding_arb` coverage+desc** — engine not enum-capped; desc is Phase-B factuality; coverage-expansion = open question (non-blocking).
- **#6 tool descriptions distributed** — Phase-B (server.json→registry, lobehub, DXT) + ship tools-list cache-refresh notice.
- **#7 drift canary** — GAP-4 (host manifest EXACT→FLOOR, same release window).
- **#8 AOE per-venue tuning** — non-blocker; verify no AOE config hardcodes 5 (Phase-B/follow-up).
- **#9 signal-performance resource + mcp://venues** — derive from byExchange/status → auto ✅.

### Transport propagation
Per-coin tools reach all 4 channels automatically (enums already 17). `scan_trade_calls` is the ONLY non-automatic transport surface — and its 5-cap is replicated across **4 representations** (Zod enum [mcp], `SCAN_EXCHANGES` [webhook+scheduler], x402-bazaar enum [x402], `FETCHERS`/`PromotedExchangeId` [engine]). `/capabilities` is venue-agnostic — no change.

---

## The 4 spec-vs-code GAPS (evidence)

### GAP-1 — `scan_trade_calls` 5→12 is a 7-fetcher build, not an enum edit  *(§8 decision)*
`getExchangeTopAssetsWithVolume(exchange, limit)` (exchange-universe.ts:265) → `FETCHERS[exchange as PromotedExchangeId]`; `PromotedExchangeId = 'HL'|'BINANCE'|'BYBIT'|'OKX'|'BITGET'` (line 51); `FETCHERS` has 5 impls (line 243); **throws `unsupported exchange '<X>'`** otherwise (line 270). Same for `fetchVenueUniverse` (line 286). To make scan accept 12:
1. Implement 7 ranked-universe fetchers (`fetchAster/Bingx/Gate/Htx/Kucoin/Mexc/Phemex`) returning `ExchangeAsset[]` (coin, notionalOI_usd, volume24h_usd, changePct24h, fundingRate). Adapters expose OI/volume per-contract, but these are *whole-universe ranked* fetchers → per-venue endpoint + field-divergence work (CLAUDE.md per-venue field rule; 418==429; list-endpoint identity assert).
2. Widen `PromotedExchangeId` + `FETCHERS` (tsc-exhaustive forces all 12).
3. Widen `ScanExchangeId` + `SCAN_EXCHANGES` (trade-call-scanner.ts:46-47) → auto-propagates to `webhook-api.ts:243` + `scan-digest-scheduler.ts:62`.
4. Widen the Zod enum (scan-trade-calls.ts:67) [mcp] + x402-bazaar enum (x402-bazaar.ts:220) [x402].
5. Update `PARAM_DESC_SCAN_EXCHANGE`.
6. **Flip the C3 test** (tests/scan-trade-calls.test.ts:105 — currently asserts `exchange:'ASTER'` is *rejected*; must become accepted + assert a still-shadow venue is rejected). Exemption+test are a pair.

### GAP-2 — `exchange_count` is static, not DB-derived
`EXCHANGE_COUNT = EXCHANGES.length` (capabilities.ts:50); `EXCHANGES` = frozen 5-array. Consumers: `/api/performance-public.exchange_count` (index.ts:2199), track-record header (index.ts:3520 `data-tr-field="exchange_count"`), Tier-2 FAQ (index.ts:3707), landing eyebrow (proxy → API). **Fix:** widen `EXCHANGES` 5→12 (with display labels) + redeploy → all count surfaces follow from the single source. Static baked surfaces (README/manifest/landing meta/JSON-LD) refresh via `npm run snapshot:capabilities` in Phase B.

### GAP-3 — leaderboard hardcoded at 5
index.ts:3839 `LB_EX_ORDER=['HL','BINANCE','BYBIT','OKX','BITGET']`; line 3847 `LB_EX_ORDER.forEach(... if(!e) return ...)` renders only those; `LB_EX_LABEL`/`LB_EX_COLOR` (3837-3838) 5-keyed. **Fix:** extend all three to 12 (labels + brand colors for the 7). (Runbook cited P1-LEADERBOARD-W1 "no fixed skeleton" — the fixed `LB_EX_ORDER` skeleton remains.)

### GAP-4 — drift canary `.exchange_count` is EXACT(5)
`/opt/algovault-monitoring/website-drift-manifest.yaml` `.exchange_count` tolerance EXACT=5 (canary code line 415 treats it "fixed-cardinality, stays EXACT"). When count→12 it false-fires next Mon 12:00 UTC. **Fix:** set that row to **FLOOR** (monotonic-grow; fires only on regression) — aligns with EXCHANGE-EXPANSION-CADENCE + the monotonic-FLOOR memory; future →17 won't re-trip. Host-side edit, same release window, backup first.

---

## Identifier diff (cited >1 place — verified consistent)

| Identifier | Runbook | Live/code | Match |
|---|---|---|---|
| Promoted set (pre) | HL,BINANCE,BYBIT,OKX,BITGET (5) | same (API + DB) | ✅ |
| 7 to promote | ASTER,BINGX,GATE,HTX,KUCOIN,MEXC,PHEMEX | all in `ExchangeId` + readiness ✅ + adapters | ✅ |
| BITMART | held (58%) | 58% live | ✅ |
| Promoted after | 12 | 12 | ✅ |
| Deploy host | 204.168.185.24 CPX42 | 8 vCPU/16 GB, load 0.68 | ✅ |
| Version | 1.21.0 | local+origin 1.21.0 | ✅ |
| $REPO HEAD | origin/main | **local 6 behind** `9d45477` vs origin `98833c2`; package.json +1 dep | ⚠️ sync+`npm ci` before edits |

---

## §8 — ARCHITECT DECISION (scan scope)

`scan_trade_calls` 5→12 (operator: "must not skip") is GAP-1 — a 7-live-universe-fetcher build, not an enum edit. The per-coin tools already serve all 17 across all channels, so **the 7 venues are fully "live" for the primary path regardless of scan.** Two paths:

- **Option A — full scan widen inside this wave (completeness).** Implement the 7 fetchers + widen 4 representations + flip the C3 test, in a distinct, per-venue-probed chapter. Larger/riskier (7× live integration; live-probe each venue's perp-universe endpoint before mapping).
- **Option B — split scan to an immediate dedicated follow-up `OPS-SCAN-UNIVERSE-EXPAND-W1` (recommended).** This wave flips the 7 + moves count (EXCHANGES) + leaderboard + drift-canary now (low-risk, fully delivers the go-live + "12 exchanges live"); scan widen done properly next (stub-first/per-venue probe/tests) — avoids rushing 7 live integrations into a flip wave.

Recommendation: **B** (deliver the safe, complete go-live now; scan as a clean, well-probed follow-up). Open to A if you want scan in this wave.

---

## Proposed execution (PENDING APPROVAL — no mutation yet)

**Pre:** `git fetch` + `merge --ff-only origin/main` (or worktree off origin/main) + `npm ci` (new dep) before any edit.

**Phase A (code wave, NO version bump):**
1. Code edits: `EXCHANGES` 5→12 (capabilities.ts) [GAP-2]; `LB_EX_ORDER`/LABEL/COLOR 5→12 (index.ts) [GAP-3]; *(if Option A: the full scan widen [GAP-1])*. system-map.md same-commit.
2. `rm -rf dist && npm run build` (clean) + `npm test` (vitest) green (flip C3 test if Option A).
3. Per-file `git add` → diff audit → commit → push origin main (GHA auto-deploy) → verify deployed.
4. Flip the 7 (in-container, one at a time): `docker exec …-mcp-server-1 node dist/scripts/promote-venue.js <V>` → each prints QUALIFIED + verified. Verify `/api/performance-public` byExchange keys = 12, exchange_count = 12, leaderboard shows 12.
5. GAP-4: backup + edit `website-drift-manifest.yaml` `.exchange_count` → FLOOR; dry-run canary shows no trip.
6. status.md (newest-first; venues, enum change, §7 deps, byExchange/exchange_count 5→12, SHAs, GHA run, `system-map.md updated: Y`) → `scp` to monitoring host.

**Phase B (next daily `RELEASE-vX.Y.Z-W1`):** `npm run snapshot:capabilities` static refresh + hardcoded 🔴 copy sweep (meta/FAQ/JSON-LD/diagram chips) + `scan_funding_arb` desc reconcile + brand-facts/Marketing/ToDoList/XPost/m1-m7 mirror + tools-list cache-refresh notice + 4 marketing artifacts; lead What's-new with **"12 exchanges live."** Per Numerical-Citation LAW: counts via `<EXCHANGE_COUNT>`/`data-tr-field`, names de-enumerated/qualitative, EXCHANGE_COUNT FLOOR row in snapshot-landing-manifest.json.

**Rollback:** `retire-venue.ts <V>` per venue (status='retired' → drops from seed + byExchange); copy reverts next release.
