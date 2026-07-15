# OPS-LANDING-FUNDING-VENUE-RECONCILE-W1 — CH1 Step-0 endpoint-truth

**Status:** architect-RATIFIED 2026-07-15 (Q1–Q5, no new drift) → proceeded to CH2. **Base advanced mid-wave** `e2b24d3` → **`9bee7de`** (concurrent `OPS-PUBLIC-API-CONVERT-NUDGE-W1` merged an additive `_algovault` CTA into `/api/performance-public` + a Plausible first-party-proxy tag swap on the landing files — re-verified: no venue-count anchor drift, only line-number shifts; the new `/api/performance-public` shape includes `_algovault`, folded into the 2026-07-15 shape snapshot).

**Probe date:** 2026-07-15 · **Base:** `origin/main` `e2b24d3` (local checkout `f6a2b52` is **80 commits behind** — every anchor derived from `origin/main` via `git show`/`git grep`, never the stale working tree) · **Mode:** READ-ONLY.

## Two canonical numbers (resolved)

| Claim surface | Canonical number | Single-derivation SoT |
|---|---|---|
| **General perp venues** | **12** | `EXCHANGES.length` → `EXCHANGE_COUNT` (`src/lib/capabilities.ts:42,63`) → live `/api/performance-public.exchange_count` |
| **Funding-arb venues** | **7** | `Object.keys(FUNDING_VENUE_META).length` (`src/lib/funding-venues.ts:15`) — **NOT** `FUNDING_ARB_FETCH_ADAPTERS.length` (=5) |

---

## Probe rows (claim | reality | resolution)

### P1 — funding-arb count/set
| claim | reality | resolution |
|---|---|---|
| Spec Method/CH2: derive funding count from `FUNDING_ARB_FETCH_ADAPTERS.length` | `FUNDING_ARB_FETCH_ADAPTERS = ['HL','GATE','KUCOIN','ASTER','OKX']` = **5** (the *fetch* adapters; HL's feed aggregates Bin+Bybit, per the file docstring) | ❌ Wrong SoT — 5 ≠ 7. Use **`Object.keys(FUNDING_VENUE_META).length` = 7** |
| Spec Context: "scan_funding_arb = 7 venues (Bitget excluded)" | `FUNDING_VENUE_META` has **7** keys: HlPerp, BinPerp, BybitPerp, GatePerp, KuCoinPerp, AsterPerp, OKXPerp. Docstring: "the 7 promoted venues"; Bitget excluded (no `nextFundingTime`) | ✅ Confirmed = **7** |
| — | **Live handshake** (`scan_funding_arb`, v1.23.1): union of venue-strings across opportunities = HlPerp, AsterPerp, BinPerp, BybitPerp, GatePerp, KuCoinPerp, OKXPerp = **exactly 7**; BitgetPerp absent | ✅ Engine matches SoT |
| — | **Live copy already correct on docs.html** (out-of-scope but canonical target): `docs.html:485` "across 7 venues: Hyperliquid, Binance, Bybit, Gate, KuCoin, Aster, and OKX"; `docs.html:1935` same | Target phrasing for CH3 funding copy |

### P2 — general perp count
| claim | reality | resolution |
|---|---|---|
| Spec: resolve 12 vs 17 vs live `exchange_count`; HALT if they disagree | `EXCHANGES.length`=**12** = `EXCHANGE_COUNT`=**12** = live `/api/performance-public.exchange_count`=**12** = `byExchange` (12 keys). All agree. | ✅ **12** canonical. **No Factuality HALT.** |
| AOE.html "17 venues tracked" | 17 = total *adapters* implemented (internal); AOE.html is **out-of-scope** (not in System Taxonomy) | Do NOT propagate 17; leave AOE.html untouched |

### P3 — `exchange_count` hydration source
| claim | reality | resolution |
|---|---|---|
| Spec "Verified now (2026-07-15)": `/api/performance-public` exposes **NO** venue/exchange/funding scalar; top keys = `totalCalls,period,overall,byCallType,byTimeframe,byAsset` | ❌ **FALSE.** Live curl (2026-07-15) top keys (17) = `asset_count, byAsset, byCallType, byExchange, byTier, byTimeframe, exchange_count, hold_rate, holdsByTier, methodology, overall, period, recentSignals, shadow_venue_count, timeframe_count, totalCalls, totalHolds`. **`exchange_count=12`**, `asset_count=1256`, `shadow_venue_count=5`, `timeframe_count=11` | General perp count is **already live-bound** — no new field needed for it |
| Spec CH1-P3: find `exchange_count` source (snapshot / JS const / endpoint) | **All three, single-derived from `EXCHANGES.length`:** (a) producer `src/index.ts:2279` `exchange_count: EXCHANGE_COUNT`; (b) runtime `landing/js/track-record-proxy.js:147` `setField('exchange_count', formatRawInt(perf.exchange_count))`; (c) deploy-time `scripts/snapshot-landing-manifest.json` rows `dtrf-exchange-count` + `jsonld-exchange-count` (accessor `exchange_count`), `apply_to_files: [index.html, how-it-works.html, skills.html]` — **NOT faq/glossary** | CH2 mechanism for funding = **mirror this exactly** |

### P4 — stale-literal edit sites (in-scope surfaces)
| surface | lines | current | target |
|---|---|---|---|
| `landing/index.html` | 18,73,103,125 | already "12" (JSON-LD hand-patched) | keep 12; make self-updating |
| `landing/index.html` | 2 residual "5 venues" | "5" | 12 (bind) |
| `landing/faq.html` (JSON-LD) | 88,112,128,171,201,223 | "5 crypto perp venues / 5 exchanges" | 12 |
| `landing/faq.html` (visible prose) | 458,479 | `<span data-tr-field="exchange_count">5</span>` (stale fallback; file not in manifest → never injected) | 12 fallback + add faq to manifest `apply_to_files` |
| `landing/faq.html` (funding) | 500 | "scan_funding_arb … (Hyperliquid vs Binance vs Bybit)" = 3 venues | 7-venue form |
| `landing/glossary.html` (JSON-LD) | 153,183,205 | "5 crypto perp venues" | 12 |
| `landing/glossary.html` (funding) | 88,453 | "across Hyperliquid, Binance, and Bybit" = 3 venues | 7-venue form |
| `scripts/render-jsx-static.mjs` | 177-192,400,508,746,783,805,1551-1553,1928,2113,2139 | many "5" (GENERATOR source) — baked index.html at 12 but generator at 5 ⇒ **active dual-render drift; a re-render REGRESSES 12→5** | bind at generator |
| `src/scripts/agent-forum-post.ts` | fetches `/api/performance-public` (line 154); **no `\d+ venues` literal found** | verify at CH3 whether it hardcodes a venue set/count | derive from SoT or `// keep in sync` |
| **JSON-LD blocks** (faq/glossary/index) | — | can't hold `data-tr-field` spans | needs snapshot-manifest `find_pattern` rows OR `generate_jsonld.mjs` template injection — **see Q1** |

### P5 — DOCS-GENERATOR merge state
| claim | reality | resolution |
|---|---|---|
| Spec line 38: `DOCS-GENERATOR-FROM-NAV-SOT-W1` is "HELD for operator preview / not yet merged" | ❌ **FALSE.** MERGED into `origin/main` 2026-07-14 (`0ae403c`→`e2b24d3`; status.md verdict ✅ GREEN, deployed + live-verified) | `docs.html`/`docs-src/**` stay OUT of scope (System Taxonomy); build off `origin/main` which includes the generator |

### P6 — dual-render sites + fictional `--check`
| claim | reality | resolution |
|---|---|---|
| Build Rule 5 / CH3 scope+gate: `node scripts/render-jsx-static.mjs --check` exit 0 | ❌ **FICTIONAL FLAG.** `render-jsx-static.mjs` `parseArgs()` (L69) handles `--target/--mobile/--out` only; **no `check` branch** (`git grep 'check'` on the file = 0). It renders to `--out`/stdout, never `--check`s. | Substitute the real gate: **`node scripts/build_landing.mjs --check`** (covers docs/integrations only — does **NOT** cover index.html) **+ a self-built desktop-render byte-equality proof** (per `landing-index-dual-render-surgical-insert-no-autobake`) |
| Dual-render 3 sites | (a) JSX SoT `Design/AlgoVault Landing Hero v1/v1-*.jsx` = **VAULT-ONLY** (origin/main has `landing/_design/` assets but no `.jsx`); (b) `scripts/render-jsx-static.mjs`; (c) baked `landing/index.html` | CH3 index.html edits = **surgical** per-artboard insert, NOT full re-render (drift landmine); repo commit ships only renderer + baked HTML + tests (JSX SoT edited vault-side) |

---

## Cited-identifier diff (spec R/Context ↔ live origin/main)

| Identifier | Spec says | Live reality | Verdict |
|---|---|---|---|
| Funding count derivation | `FUNDING_ARB_FETCH_ADAPTERS.length` | =5 (fetch adapters) vs required **7** = `\|FUNDING_VENUE_META\|` | **CORRECT to `\|FUNDING_VENUE_META\|`** |
| `/api/performance-public` venue scalar | "exposes NONE" | `exchange_count=12` present (live) | **Premise false — field exists** |
| General perp canonical | "12 vs 17 vs live (resolve/HALT)" | 12 == 12 == 12 (all agree) | **12, no HALT** |
| `render-jsx-static.mjs --check` | real gate | fictional flag | **Substitute build_landing --check + byte-eq** |
| DOCS-GENERATOR state | "HELD / not merged" | merged `e2b24d3` | **Merged; docs still out-of-scope** |
| Version | "v1.23.0" | live 1.23.1 | cosmetic; no count impact |
| `FUNDING_VENUE_META`, `EXCHANGES`, `EXCHANGE_COUNT`, `track-record-proxy.js`, `snapshot-landing-manifest.json` | cited | all exist on origin/main | ✅ real |

## Pre-resolved drift corrections (fold into V2 dispatch)
1. Funding SoT: `Object.keys(FUNDING_VENUE_META).length` (7), not `FUNDING_ARB_FETCH_ADAPTERS.length` (5).
2. General perp is already a live API scalar (`exchange_count=12`) — CH2 reuses it; only the funding field is new.
3. `--check` is fictional → `build_landing.mjs --check` + byte-equality.
4. DOCS-GENERATOR merged; base off `origin/main`; docs.html untouched.
5. Fictional-primitive count = **1** (`--check`) ⇒ fix-inline-and-flag, **not** the ≥3 auto-HALT.

## CH2 mechanism decision (recommended)
Mirror `exchange_count` for a new `funding_venue_count`:
- **Producer:** `funding_venue_count: FUNDING_VENUE_COUNT` in `/api/performance-public` (`src/index.ts:~2279`), where `FUNDING_VENUE_COUNT = Object.keys(FUNDING_VENUE_META).length` (define in `funding-venues.ts`).
- **Runtime:** `setField('funding_venue_count', formatRawInt(perf.funding_venue_count))` in `track-record-proxy.js`.
- **Deploy-time:** `dtrf-funding-venue-count` (+ optional jsonld) row in `snapshot-landing-manifest.json` (accessor `funding_venue_count`), and **add faq.html + glossary.html to the exchange-count + funding rows' `apply_to_files`** so their fallbacks inject too.
- **Shape snapshot:** add `funding_venue_count` to `audits/api-performance-public-shape-snapshot-*.json` ALLOW list. No `outcome_*` exposure.
- Unit test: served/injected count `== Object.keys(FUNDING_VENUE_META).length` (0-drift).

## Open architect decisions → see HALT Q-block (below / in chat).
