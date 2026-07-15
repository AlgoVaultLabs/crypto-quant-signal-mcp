# GEO-TARGET-DIGEST-REDESIGN-W1 — endpoint-truth (Plan-Mode Step 0)

**Probed against `origin/main`** (local `main` was 88 behind; every fact below via `git show origin/main:<path>`). Repo `/Users/tank/code/crypto-quant-signal-mcp`. Target ICP: **META**. No fictional primitives found → **no HALT**.

## 0. Primitive probe — claim | reality | resolution

| # | Spec claim | Reality (origin/main) | Resolution |
|---|---|---|---|
| 1 | `geo-queries.yaml` path | `landing/Prompt/geo-queries.yaml` (v2, 103 lines); `loadQueries()` in `geo-orchestrator.ts` reads it (`__dirname/../../landing/Prompt`) | ✅ edit in place |
| 2 | "16 live vs original 15 — reconcile the mystery 16th" | 16 queries = 15 authority + **`algovault-exists`** (`tier: presence`, added AI-CRAWLER-ACCESS-W2 R5). It is a known-entity retrieval check, **already EXCLUDED from every authority aggregate** at SQL (`query_tier IS DISTINCT FROM 'presence'`) | **Mystery resolved: the 16th is `algovault-exists`.** Keep it; classify `measure_only` (not a target, not a misfit) |
| 3 | `geo-objective.yaml` per-query classification SoT | `landing/Prompt/geo-objective.yaml` (v1, 149 lines); `loadObjective()` in `geo-decide.ts` reads it; already carries `revenue_proximity`, `product_fit`, `open_query`, `probe`, `alert_hygiene` | ✅ add NEW `target_set` block (additive) |
| 4 | `getQueryRates` = single rate+CI source | `geo-rates.ts::getQueryRates(windowWeeks)` → per-(query,engine) `{mention_rate, cited_rate, avg_sov, wilson lo/hi, low_confidence}`. Pure helpers `computeRates`/`wilsonInterval`/`rollupByEngine` exported + unit-tested. **Window is rolling-from-now only** (`ran_at > now() - make_interval(weeks=>$1)`) | ✅ reuse. For before/after Δ, extend with a **pooled-by-query** rollup + a windowed raw fetch feeding the SAME `computeRates` (no new Wilson/rate math inline) |
| 5 | digest / attribution / decision render code | `geo-digest.ts` (PURE, 536L: `computeMomentum`/`computeAttribution`/`buildDigest`/`DecisionHandoff`); `geo-weekly-cron.ts` (516L, wires data→`buildDigest`, persists `geo_decisions`); `geo-decide.ts` (`scoreWeek`/`renderDecisionBrief`) | ✅ C2 targets `geo-digest.ts` + `geo-weekly-cron.ts`; C1 scorer edit in `geo-decide.ts` |
| 6 | post↔query link for "our action" | **No `published_url` column exists.** `geo_content_gaps.injected_at` (set = post queued into editorial calendar) IS the ship signal (already used by attribution). `geo_decisions.ranked_candidates` JSONB carries `query_id` + `chosen_move` + `status`(proposed→approved→executed→measured) | **No schema change.** "Our action" derives from `geo_content_gaps.injected_at` (posted <date>) + `geo_decisions` status (in-flight) keyed by `query_id`. Minimal link already present |
| 7 | `geo_source_citations` shape (who's-winning) | cols `query_id, model, query_tier, source_url, source_domain, attributed_to, competitor_name, rank`; cron's WHO'S-WINNING reads `attributed_to='competitor'` grouped by query_id over 4w | ✅ filter to target-set query_ids (excludes historical misfits) |
| 8 | `geo_decisions.ranked_candidates` for decision-basis | JSONB, persisted from `ranked.ranked` (each Candidate = `{label, query_id, query_tier, product_fit, expected_lift, score, tier, move}`). Cron already computes `ranked` | ✅ thread top-N into `DecisionHandoff` + render (single-derivation — SAME object persisted) |
| 9 | 4 engines × K=3 | `DEFAULT_GEO_ENGINES='claude-web,perplexity,chatgpt,gemini'` (4); `probe.runs_per_query=3` (per-engine K override map exists) | ✅ cost basis below |
| 10 | Dockerfile bakes the yaml | `Dockerfile:45 COPY landing/Prompt/ ./landing/Prompt/` | ✅ **no Dockerfile / deploy.yml change** — editing the yaml deploys via the existing COPY |
| 11 | `deploy.yml` paths-ignore | `['audits/**','docs/**','*.md','CHANGELOG.md']` — src + landing/Prompt NOT ignored | ✅ push auto-deploys (GHA) |

## 1. Final query set (drop 2 · add 6 · keep presence) → **20 probed = 19 authority + 1 presence**

DROP (product misfit): `best-python-backtester`, `python-quant-for-ai` (+ their `product_fit` rows — orphaned once the queries go).

**Tier A — CONVERSION (11; measure on SIGNUPS):** composite-quant-signal, verifiable-track-record, market-regime-detection, crewai-trading-tools, claude-trading-stack, **trade-call-not-data (NEW)**, **verifiable-winrate-api (NEW)**, **altfins-alternative (NEW)**, **x402-signal-api (NEW)**, **signal-api-pricing (NEW)**, **retail-signals-verifiable (NEW)**.

**Tier B — BRAND-PRESENCE (6; measure on CITATIONS only):** ai-agent-trade-signals, mcp-server-discovery, build-crypto-agent, cross-venue-funding, langchain-crypto-integration, llamaindex-quant-stack.

**CONTESTED — EARNED-ONLY (2):** best-mcp-trading, agent-signal-api.

**PRESENCE (1, kept, not a target):** algovault-exists.

## 2. Two orthogonal tier dimensions (do NOT conflate)

- `geo-queries.yaml` **`tier`** = head/niche/branded/presence → drives `revenue_proximity` (autopilot value weight) + gap-list `TIER_WEIGHT` (coverage). **KEPT** — the 6 new queries each need one.
- `geo-objective.yaml` **`target_set.<id>.tier`** = **A/B/contested/measure_only** (NEW, additive) → drives the digest conversion split + who's-winning filter + earned routing. **This is the wave's SoT.**

## 3. Proposed per-query classification (`geo-objective.yaml target_set`) + head/niche/branded for the 6 new

| query_id | target tier | audience | target_mode | queries.yaml tier (new only) |
|---|---|---|---|---|
| composite-quant-signal | A | T2/T3 | owned | (branded, unchanged) |
| verifiable-track-record | A | ALL | owned | (branded) |
| market-regime-detection | A | T2/T3 | owned | (niche) |
| crewai-trading-tools | A | T3 | owned | (niche) |
| claude-trading-stack | A | T3 | owned | (head) |
| trade-call-not-data | A | T3 | owned | **branded** |
| verifiable-winrate-api | A | T2/T3 | owned | **branded** |
| altfins-alternative | A | T2/T3 | owned | **branded** |
| x402-signal-api | A | T3 | owned | **niche** |
| signal-api-pricing | A | ALL | owned | **head** |
| retail-signals-verifiable | A | T1 | owned | **head** |
| ai-agent-trade-signals | B | ALL | owned | (head) |
| mcp-server-discovery | B | T3 | owned | (head) |
| build-crypto-agent | B | T3 | owned | (head) |
| cross-venue-funding | B | T2 | owned | (niche) |
| langchain-crypto-integration | B | T3 | owned | (niche) |
| llamaindex-quant-stack | B | T3 | owned | (niche) |
| best-mcp-trading | contested | T3 | **earned** | (head) |
| agent-signal-api | contested | T2/T3 | **earned** | (branded) |
| algovault-exists | measure_only | META | measure_only | (presence) |

`target_mode: earned` → scorer emits an **`earned`** move (draft press/Reddit/listicle), NEVER `pursue_placement` on a competitor domain, NEVER an owned post.

## 4. Cost reconciliation (~19 authority queries)

- **Deterministic call count:** 20 queries × 4 engines × K=3 = **240 retrieval samples/wk** (+ ~240 Anthropic judge grades/wk). Current: 16×4×3 = 192/wk. Δ = **+48/wk (+25%)**.
- **Live anchor (factual):** host `llm-spend-monitor.py` alerts if **any** provider > $10/30d; **no `LLM_SPEND_OVER_THRESHOLD` alert is active** → the current 192-call baseline runs under $10/provider. 4 independent providers ⇒ aggregate already < $40/mo.
- **Per-call band (web_search surcharge-dominated, cheap models):** realistic ≈ $0.013–0.016/sample retrieval + ≈$0.003 judge → **≈ $16–17/mo** at 240/wk (current ≈ $13/mo). Pessimistic 2× band ≈ **$36/mo**. **Both under the $40/mo cap.**
- **Δ from the wave:** +25% volume ≈ **+$3–9/mo**. **No Tier-B drop required.** Mitigation lever if the live monitor ever nears the cap: per-engine K reduction via existing `probe.runs_per_query_by_engine` (e.g. gemini K=2), no code change.

## 5. Identifier diff (target_mode / tier keys across yaml + scorer + digest + tests)

| identifier | where added | collision? |
|---|---|---|
| `target_set` (+`.tier`/`.audience`/`.target_mode`) | geo-objective.yaml; `Objective` type (geo-decide.ts); threaded via cron into `GeoDigestData` | **none** (`git grep target_mode\|target_set\|targetMode` = 0 hits) |
| `earned` move-type | `Candidate.move` union in geo-decide.ts (`'pursue_placement'\|'seed_the_answer'\|'earned'`) | additive |

**Tests the C1 config change breaks (fixed in C3, per flip-absence-fixture discipline):**
- `tests/unit/geo-orchestrator.test.ts:91,94,96,114` — `toHaveLength(16)` → **20**; `queries[14].id==='python-quant-for-ai'` (dropped) → re-point; header "15 authority" → "19 authority + 1 presence"; assert last id `algovault-exists`.
- `tests/unit/geo-decide.test.ts:274-285` — real-yaml `product_fit['best-python-backtester'|'python-quant-for-ai']` assertions → **flip** to assert the new `target_set` (contested→earned; A/B present).
- `tests/unit/geo-digest.test.ts:178,207` — who's-winning fixture uses `best-python-backtester` → re-point to a real target query + assert misfit-exclusion.
- `tests/unit/geo-gap-list.test.ts:106,134` — MISFIT fixture uses `best-python-backtester` → re-point (generic id).

## 6. system-map.md edges (Map Anchor — enumerated)

All 4 wave edges are **INTERNAL to the `SIGNAL` component** (crypto-quant-signal-mcp); the system-map represents the GEO subsystem as prose inside the SIGNAL component row + the cross-host `SIGNAL --postgres geo_content_gaps--> EDITORIAL` hand-off (unchanged). This wave changes: (query SET = data) + (NEW `target_set` field on the already-consumed `geo-objective.yaml` config) + (internal digest projection cited-only→mention+cited+SoV) + (internal digest read of already-produced `geo_decisions`). **No new component / cross-component edge / role / repo / cron / tool / API-field / column / publish-target.**

→ **`system-map.md updated: n-a`** (pre-commit `check_system_map.sh` may force a `Last touched:` overwrite only; never a prepended log row).

## 7. Chapter plan (sequential, CH_GREEN gates)

- **C1** — geo-queries.yaml (−2, +6 with competitor_terms + head/niche/branded tier); geo-objective.yaml `target_set` block; drop orphaned `product_fit` misfit rows; `scoreWeek` reads `target_mode` → `earned` candidates for contested (never placement/owned). `CH1_GREEN`.
- **C2** — geo-digest.ts + geo-weekly-cron.ts: (a) attribution mention+cited+SoV Δ+CI via shared computeRates; (b) who's-winning filtered to target set (misfits gone); (c) per-query our-action from injected_at+geo_decisions; (d) decision-basis top-N from ranked_candidates; (e) Tier A 🎯 / Tier B 📣 split. `CH2_GREEN`.
- **C3** — vitest (classification parsed; contested→earned; attribution deltas; misfit-exclusion; our-action + decision-basis; A/B split) + in-container `--dry-run`. status.md + WIS. `CH3_GREEN` + `GEO_TARGET_DIGEST_REDESIGN_W1_WAVE_GREEN`.

Push to `main` (GHA auto-deploy). No version bump, no completion TG.
