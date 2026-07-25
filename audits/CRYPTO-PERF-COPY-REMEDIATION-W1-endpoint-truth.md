# CRYPTO-PERF-COPY-REMEDIATION-W1 — endpoint-truth + execution record

**Wave:** make the public copy tell the same story as the DB. Copy-only; no value/span/selector/tool-description/manifest edits; no version bump / publish / TG.
**Base:** fresh worktree `ops/crypto-perf-copy-remediation-w1` off `origin/main` `d07cfad` (local `main` was 14 behind → all probes via `git grep origin/main` / live curl). **Classification: EXTERNAL.**
**Plan-Mode:** HALTed at R0 with 4 architect-confirm Q-rows; Mr.1 ratified 2026-07-25 (amended pack — S5-v2 + Q1–Q4 below). Then executed.

## Architect rulings applied (2026-07-25)

- **Q1 (S2) — (C) NO CHANGE.** Panel `src/index.ts:4044` "Only confidence ≥ 60% signals are recorded and evaluated" stays byte-unchanged. Interpretation on record: **"recorded" = recorded into the public track record = the ≥60 shown set.** Live reality (for the file): recording gate `MIN_TRACKABLE_CONFIDENCE=52` (`get-trade-call.ts:89`,`:712`); public evaluation/display filter `>=60` (`performance-db.ts:2673`; live `/api/performance-public.methodology.signalFilter="Confidence >= 60%"`). No number changed anywhere.
- **Q2 (A) — deletion-only** ("remove the false term, add nothing"), FLEET-WIDE canary/grep retained:
  - `landing/llms.txt:13` "PFE (directional-accuracy) win rate published live" → "PFE win rate published live"
  - `src/index.ts:3842` Dataset desc "Per-segment directional accuracy (PFE win rate)" → "Per-segment PFE win rate"
- **Q3 — CONCEPT-level scrub.** `<meta name="description">` "…with regime-aware filtering." → "…with market-regime context on every call." (edited in the committed SNAPSHOT-LINE the injector reads; "15 exchanges" + marker preserved). Canary concept regex `/regime-aware\s+(filter\w*|gating)/i`, both directions self-tested.
- **Q4 — S5-v2** (approved pack amendment). `README.md:71` replace sentences 2+3 (keep sentence 1). Rationale on record: sentence 2 ("Weights are calibrated from live trade outcomes") is disproven by the AOE probe (static serving weights; tuner consumer dark; zero promotions). Result: *"Under the hood, a self-tuning model fuses momentum, trend structure, derivatives positioning, open interest, and volume into one weighted call. Every call reports market regime — trending, ranging, or volatile — alongside direction and confidence. Directional calls fire only when conviction clears the threshold; roughly 99% of evaluations return HOLD."*

## Fleet-enumeration discovery (flagged for visibility)

The pack/rulings named specific literals; a concept enumeration (copy-flip discipline) surfaced **one surface the rulings did not individually name**: `landing/skills.html:77` JSON-LD `"description"` — *"…(89.4%+ Merkle-verified PFE Win Rate), **regime-aware filtering**, funding-arb monitoring…"*. `skills.html` **is in the R4 canary's `LANDING_FILES`**, so the Q3 fleet-wide canary would fail on it → it is an in-scope instance of the S7 concept (not unrelated "adjacent stale copy"). Fixed **deletion-only** per Q2's method: "regime-aware filtering, " removed → "…PFE Win Rate), funding-arb monitoring." The stale "89.4%" figure in the same line is OUT OF SCOPE (forward-stability), logged as follow-up, not touched.

## S1 / S4 / S6 (pack, unchanged rulings)

- **S1** `src/index.ts:3902` — removed `<div class="sub">Directional Accuracy</div>`; card now title+value only; `id="pfe-wr"` value span untouched. (Live `/api/performance-public` has **no** `directionalAccuracy` field — the sub-label was a bare label, not a sourced number.)
- **S4** flywheel "How the model improves": deleted the monotonic sentence at the JSX SoT (`…/Design/AlgoVault How it Works V1/v1-howitworks.jsx:555`) + surgically patched the committed baked `landing/how-it-works.html` (Hetzner has no vault access → serves the committed baked file; host `snapshot-landing-data.mjs` refreshes numbers at deploy). Step 03 "AOE updates model weights" → "AOE retrains and re-tests the model" in BOTH `v1-howitworks.jsx:538` and the authoritative `render-jsx-static.mjs:1639` + baked ×2. **Chart untouched** (R1 default — the sentence never captioned the hardcoded `PFE WR OVER TIME` sparkline; Must-NOT forbids chart-data changes). Self-tuning/AOE intro preserved (S7 carve-out).
- **S6** `landing/index.html:668` FAQ "How does the trade call scoring work?" JSON-LD answer → the visible twin verbatim ("Each call is a multi-factor composite of trend persistence, breakout pressure, funding state, and volatility regime — scored on the same scale across crypto and TradFi. We only fire BUY/SELL when conviction clears the threshold; otherwise the call is HOLD (and HOLDs are free)."). `generate_jsonld.mjs` preserves FAQPage (`:36,:179`) → safe hand-edit; question names already matched.

## Verification

| Check | Result | Evidence |
|---|---|---|
| Banned phrases fleet-wide (raw, incl. comments) | ✅ 0/0/0 | per-file `grep -oiE` across index/how-it-works/skills/llms/llms-full/docs/faq/README/src-index.ts |
| Approved new copy present | ✅ | S1 card (no sub), Q2a/Q2b, Q3 meta, S6 FAQ, S5-v2 all grep=1 |
| Benign/kept copy survives | ✅ | "market regime" ×16, "Regime-Aware Trading" skill name, batch-id "increment monotonically", Dataset "called direction" all intact |
| Extended R4 canary (copy-consistency.test.ts) | ✅ 191 tests | vitest — new ban block + both-direction self-test |
| how_it_works + geo_jsonld consistency | ✅ 66 tests | node:test — nav/footer/≥5 JSON-LD/data-tr-field intact (surgical patch preserved injections) |
| Full vitest suite | ✅ 4065 pass / 10 skip, 0 fail | `npx vitest run` |
| node:test canaries (gate selection, excl. vitest-owned) | ✅ 494 pass, 0 fail | replicates `check_test_baseline.sh:88` |
| Preview render | ✅ no layout break | Browser pane served worktree landing/; hero renders clean; S4 copy live-verified in DOM (lead ends "the model gets sharper"; step 03 = "AOE retrains and re-tests the model"; "improved monotonically" absent). Pixel screenshot of the flywheel panel blocked by the design-artboard scroll-hijack — tooling limitation, not a change defect. |

## Files changed (repo)

| File | Change | Downstream |
|---|---|---|
| `src/index.ts` | S1 card sub removed; Q2a Dataset desc | served /track-record — rebuilt by deploy |
| `landing/how-it-works.html` | S4 baked (sentence ×2 + step03 ×2) | served static; numbers refreshed at deploy |
| `landing/index.html` | Q3 meta; S6 FAQ JSON-LD answer | served static |
| `landing/llms.txt` | Q2b directional-accuracy removed | served /llms.txt |
| `landing/skills.html` | fleet-discovery deletion-only | served /skills |
| `scripts/render-jsx-static.mjs` | S4a flywheel step-03 label | regen source |
| `README.md` | S5-v2 (reaches npm at next publish; no publish this wave) | npm README |
| `tests/unit/copy-consistency.test.ts` | R4 canary (+60, additive) | CI + pre-push gate |

Non-repo SoT edit (not committed — external vault path): `Design/AlgoVault How it Works V1/v1-howitworks.jsx` (S4 sentence + step-03), the how-it-works render SoT.

`system-map.md updated: n-a` — copy-only; no producer/consumer edge, role, or repo changed.
