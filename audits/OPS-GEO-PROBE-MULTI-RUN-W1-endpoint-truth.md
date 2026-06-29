# OPS-GEO-PROBE-MULTI-RUN-W1 — endpoint-truth (Plan Mode Step 0)

**Verdict: 🛑 HALT for architect approval.** Plan-Mode probing found the spec's core premises are **stale vs live PROD** (the multi-run sampling + the proposed schema columns **already ship and run**). The wave's *objective* (a trustworthy per-cycle citation rate + CI via single-derivation) is still valid and unbuilt, but the work is reshaped. Decisions needing approval are in §8.

**Target ICP tier(s): META.** Repo: signal-MCP (`crypto-quant-signal-mcp`). Internal probe/measurement only; no public copy.

**Date:** 2026-06-29. **Probed against:** `origin/main` @ `7b13f0c` (worktree `ops/geo-probe-multi-run-w1`) + live Hetzner PROD (`204.168.185.24`, container `crypto-quant-signal-mcp-mcp-server-1`, PG `signal_performance`).

**Ship-boundary / stale-checkout note:** the main local checkout was 83 commits behind `origin/main` with unrelated uncommitted files (parallel session). All findings below are taken from `origin/main` + live PROD, not the stale local HEAD. No `GEO-PROBE-MULTI-RUN` / `GEO-PROBE-SIGNIFICANCE` / `getQueryRates` commit exists on `origin/main` → wave is genuinely greenfield (not already shipped).

---

## §1 — DRIFT FINDINGS (claim → live reality → resolution)  ← the headline

| # | Spec claim | Live reality (verified) | Resolution |
|---|---|---|---|
| D1 | "probe's **N=1 single run** per query×engine"; "Mon-29 swung 2→0 on n=2" | **K=3 already.** Every (run_id,query_id,model) cell = exactly 3 samples (224/224 cells last 5wk); `runWeeklyProbe` has a `for(sample<samples)` loop, `DEFAULT_GEO_SAMPLES_PER_QUERY=3`, env-overridable `GEO_SAMPLES_PER_QUERY`. Shipped GEO-MEASUREMENT-W2 C5, deployed + running. | C1 is NOT "build sampling from scratch." C1 = (a) move K to yaml config + per-engine override, (b) bounded concurrency + per-engine pacing, (c) partial-K low-confidence flag. |
| D2 | "add `cited BOOLEAN` if not derivable + optional `sample_idx INT`; `ADD COLUMN IF NOT EXISTS`; pre-apply via SSH" | **Both columns are LIVE** in `geo_mentions` (`cited boolean`, `sample_idx integer`, + `retrieval`,`share_of_voice`,`query_tier`). Added GEO-MEASUREMENT-W2 C2. | **No schema migration.** The "pre-apply ADD COLUMN via SSH then deploy" step is a **no-op** — drop it. Rate+CI computed at READ time. |
| D3 | "denoise at read time" is the new work | Read-time denoising **partly exists**: views `geo_engine_weekly` (`cited_rate_pct`,`mention_rate_pct`,`avg_sov`) + `geo_sov_weekly` + `geo_weekly_summary`. | They aggregate **per-`model` across ALL queries**, with **no per-(query,engine) grain and no confidence interval**, and **no shared `getQueryRates()` helper** — consumers re-derive inline. THAT is the real C2 gap. |
| D4 | "15 queries" | **16 queries** live (16 distinct query_id/cycle). | Cosmetic; cost/pacing math uses 16. |
| D5 | cost "directional ~$2–5/wk at K=5"; cron comment "~$0.06/week" | Measured **K=3 ≈ $3.5–4/wk**; projected **K=5 ≈ $6/wk (~$26/mo)** — claude web_search dominates. Cron comment is wildly stale (W1 single-engine, no web search). | Approve a real cost cap (§2, §8). |
| D6 | *(not in spec)* | **NEW: Gemini = 59% errors (85/144), almost all HTTP 429 rate-limit.** Gemini's weekly rate is computed over ~6–7 successful samples of 48. | This is the *actual* measurement-quality failure (worse than non-determinism). K↑ makes 429s worse. The wave MUST add per-engine pacing/concurrency for gemini + the partial-K low-confidence flag. Surfaced in §8. |
| D7 | "retrying 418/429 (typed rate-limit, no retry)" forbidden | The live LLM providers **do** retry 429 (500/1500ms backoff) — standard for these APIs, and gemini needs *pacing* not no-retry. | Honor the *intent*: respect per-engine rate limits via pacing/concurrency, don't hammer. Not the Binance 418==IP-ban rule. Note in C1 commit. |

**≥3 stale/fictional spec primitives (D1, D2, D3 + cost D5) → HALT per CLAUDE.md Plan-Mode rule.** This is a "V2-RESUME"-shaped correction: fold the drift into thinner chapters, not a kill.

---

## §0 — system-map.md edges touched

- `geo-objective.yaml probe.runs_per_query` **(NEW config)** → `geo-weekly-cron.ts` (reads via `loadObjective()`, already imported) → `runWeeklyProbe(opts.samples, perEngineSamples)` — config edge.
- `geo_mentions` (unchanged producer) → **NEW `getQueryRates(window)`** shared aggregator (per-(query,engine) cited/total rate + Wilson CI + avg_sov + low-confidence) → **consumers project from it**: `geo-weekly-cron.ts` digest (`perEngine`/`deltaRows`), `geo-gap-list.ts::computeGapList` (`sov`→scorer `expected_lift`), attribution loop.
- No new table, no new column, no new tool/route, `tools/list` unchanged. **system-map update at wave end: Y** (new `getQueryRates` leaf consumed by 3 surfaces + the config edge).

---

## §2 — Cost reconcile (measured, not estimated)

Per **weekly cycle** = 16 queries × 4 engines × K samples retrieval calls + 1 Haiku judge call per *successful* retrieval. Token volumes are **measured from `geo_query_runs`** (last 3wk); fees from vendor pricing (Jun 2026, sources below).

| Engine (model) | calls/wk @K=3 | err% (live) | token cost/wk | search/grounding fee/wk | **~$/wk @K=3** | **~$/wk @K=5** |
|---|---|---|---|---|---|---|
| claude-web (haiku-4.5) | 48 | 0% | ~$0.85 (14.5k in /638 out · $1/$5 Mtok) | ~$1.4 (≈3 searches/call · $10/1k) | **~$2.3** | ~$3.8 |
| chatgpt (gpt-4.1-mini) | 48 | 0% | ~$0.19 (8k flat in-block/search · ~$0.40/$1.60) | $0.48 ($10/1k calls) | **~$0.67** | ~$1.1 |
| perplexity (sonar) | 48 | 0% | ~$0.03 ($1/$1 Mtok) | $0.24 ($5/1k req, low ctx) | **~$0.27** | ~$0.45 |
| gemini (2.5-flash) | 48 | **59% (429)** | ~$0 (grounding ctx not token-billed) | $0 (within 1,500 RPD **free**; $35/1k after) | **~$0** | ~$0 |
| Haiku judge (extractor) | ~168 ok | — | ~$0.32 (~900 in /200 out · $1/$5) | — | **~$0.32** | ~$0.55 |
| **TOTAL** | | | | | **≈ $3.6/wk (~$15/mo)** | **≈ $6/wk (~$26/mo)** |

- **Dominant lever = claude-web web_search** (multiple $10/1k searches + 14.5k injected input tok/call). Everything else is cents.
- **Gemini cost ≈ $0** (free grounding tier) — its problem is *reliability* (429), not dollars.
- Recommended **cap: $40/mo (~$9.2/wk)** — comfortable headroom over K=5 incl. claude search variance + judge.

## §3 — Pacing / rate-limits / concurrency plan

- **Current cron:** host crontab `0 8 * * 1 docker exec …-mcp-server-1 node dist/scripts/geo-weekly-cron.js` (Mon 08:00 UTC). **No wall-clock kill** — but it's poor hygiene to run hours.
- **Current pacing:** orchestrator is **fully serial** with a **15s sleep after EVERY sample**. Measured cycle span @K=3 = **08:00→~09:13 ≈ 73 min** (192 samples). **@K=5 serial ≈ ~2 hrs.** So bounded concurrency is needed *even to keep K=3 healthy*, mandatory for K=5.
- **Per-engine limits:** claude/openai/perplexity tolerate the load (0% err). **Gemini free tier 429s at 59%** → needs concurrency=1 + a longer inter-call delay (the short 429-retry backoff is insufficient; pace, don't hammer).
- **Plan:** bounded engine-level concurrency (run ≤2–3 engines' sweeps in parallel; samples *within* an engine paced per that engine's limit). Per-engine pacing map; jitter; existing retry budget kept. Graceful **partial-K**: a cell that completes j<K reports rate over j + a `low_confidence` flag (and gemini will frequently be partial-K — that's the honest signal).

## §4 — Schema / view decision

- `\d geo_mentions` live = `cited boolean`, `sample_idx integer`, `share_of_voice numeric`, `retrieval boolean`, `query_tier text` — **all present.** `cited` is **deterministic** (any returned citation URL on algovault.com via `isOwnHost`) → the citation rate is clean and re-derivable historically (no backfill needed).
- **Decision: NO schema migration.** Rate + Wilson CI + low-confidence are computed at **read time** in the shared helper (and optionally a `CREATE OR REPLACE VIEW geo_query_rates_weekly` at boot — no SSH pre-apply; views replace idempotently in `ensureGeoSchema`). The prompt's "pre-apply ADD COLUMN via SSH then deploy via deploy-direct.sh" → **the ADD COLUMN is dropped; deploy still via `scripts/deploy-direct.sh`.**
- Backward-compat: legacy K=1 cycles (pre-W2) aggregate cleanly (rate = cited/1). ✔

## §5 — Consumer map (single-derivation target)

| Consumer | Reads today (inline) | After C2 (projects from `getQueryRates`) |
|---|---|---|
| digest "Named in answers" / cited (`geo-weekly-cron.ts` `perEngine`) | inline `count(*) FILTER(cited)…/count(*)` per **model** | per-engine rate **+ Wilson CI** from helper; render "cited X/K = R% [CI]" |
| digest momentum (`deltaRows`) | inline WoW cited/sov/mention | WoW deltas project from helper's per-cycle rate |
| scorer `expected_lift` (`geo-decide.ts::scoreWeek`) | `sov` from `computeGapList` = `AVG(share_of_voice)` per (query,model) | `computeGapList` sources `avg_sov`/rate from helper (one derivation). `expected_lift = 1 - sov` unchanged; `product_fit` multiplier untouched |
| attribution loop (`attrRows`) | inline `cited` before/after `injected_at` per query | cited-rate **definition** from helper; the before/after time-split stays inherent to attribution |
| dashboard (`geo-dashboard.ts`) | reads `geo_weekly_summary` view | unchanged (or add the new view); not in scope unless trivial |

**Single-derivation (LAW):** ONE `getQueryRates()` (TS, in `geo-storage.ts` or a new `geo-rates.ts`) returns per-(query,engine): `cited_count, total_runs, mention_count, rate, wilson_lo, wilson_hi, avg_sov, low_confidence`. Grep-canary: no inline `FILTER (WHERE cited)…/count(*)` rate re-derivation left in any consumer.

## §6 — Identifier diff

| Identifier | Spec form | Live / proposed | Note |
|---|---|---|---|
| K config | `geo-objective.yaml probe.runs_per_query` (default 5) | **new** `probe:` block in `geo-objective.yaml`; today K is `GEO_SAMPLES_PER_QUERY` env + const `DEFAULT_GEO_SAMPLES_PER_QUERY=3` | cron reads `objective.probe.runs_per_query` → `runWeeklyProbe({samples})`; maps to existing `opts.samples` |
| per-engine K override | "optional per-engine override map" | `probe.runs_per_query_by_engine: {gemini: 3, …}` keyed by engineId (`claude-web`/`perplexity`/`chatgpt`/`gemini`) | orchestrator loop uses `samplesFor(engine)` |
| rate helper | `getQueryRates(cycle)` | **new** export | does NOT exist today (grep-confirmed) |
| view (optional) | `geo_weekly_summary` | exists per-model; **new** optional `geo_query_rates_weekly` for per-(query,engine)+CI | CREATE OR REPLACE at boot, no SSH |
| engines | "4 engines" | live = `claude-web, perplexity, chatgpt, gemini` (all 4 keys present) | matches |
| queries | "15" | **16** | use 16 |

## §7 — Corrected chapter scopes

- **C1 — config + concurrency + partial-K** (NOT "build sampling"): add `probe.runs_per_query` (+per-engine map) to `geo-objective.yaml`; cron passes `samples`/per-engine map into `runWeeklyProbe`; replace serial-15s with **bounded concurrency + per-engine pacing** (fix 73-min runtime + gemini 429); partial-K → rate over j + `low_confidence` flag. Storage already writes K rows (sample_idx). AC: dry-run/staging cycle produces K samples/cell, finishes well inside window, gemini 429s materially reduced, partial-K degrades gracefully. `CH1_GREEN`.
- **C2 — rate + Wilson CI single-derivation:** ONE `getQueryRates()` (per-(query,engine) rate + Wilson interval + avg_sov + low_confidence); digest/scorer/attribution project from it; digest renders "cited X/K = R% [CI]". Legacy K=1 aggregates cleanly. Grep shows no inline rate re-derivation. `CH2_GREEN`.
- **C3 — tests + live dry-run + status/WIS:** vitest (K rows persisted; rate=cited/total; Wilson CI on a known fixture; partial-K→low-confidence; single-derivation parity digest/scorer/attribution; legacy K=1). In-container `--dry-run` renders rate+CI per query. status.md + WIS. `CH3_GREEN` + `OPS_GEO_MULTI_RUN_W1_WAVE_GREEN`.

---

## §8 — APPROVAL NEEDED (architect / Cowork) — see HALT block in the dispatch reply

Sources (pricing, Jun 2026): Anthropic [platform.claude.com/docs/pricing](https://platform.claude.com/docs/en/about-claude/pricing) + [websearchapi.ai](https://websearchapi.ai/blog/anthropic-claude-web-search-api); Perplexity [docs.perplexity.ai/pricing](https://docs.perplexity.ai/docs/getting-started/pricing); OpenAI [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing); Gemini [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing).
