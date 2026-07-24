# OPS-VENUE-COPY-LIVEBIND-W1 — R0 endpoint-truth (Plan-Mode LIGHT → escalated; read-only)

Retire the stale baked venue count from public landing/docs copy. **Probed 2026-07-24 ~08:3x UTC**, fresh worktree off `origin/main` (`634abf6`), clean. `claim | reality | resolution`.

> **R0 is NOT clean — the prompt materially under-scoped this. Escalating to a HALT.** The prompt names "3 sources feeding ~8 subpages"; the real surface is a `generate_jsonld.mjs`-owned JSON-LD across **11 pages** (its `--check` already FAILING — pre-existing 11-file drift), **two** stale variants ("5" and "12"), plus hand-authored meta/FAQ copy and a cross-repo prose hit. The core bug is a single hardcoded template line; fixing it correctly (via `generate_jsonld`) produces a **much broader diff** than "3 files" and needs scope + a live-bind decision ratified.

---

## A. The real generation model (the prompt missed `generate_jsonld.mjs`)

| Claim (prompt) | Reality (probed) |
|---|---|
| `product.json.template` is the shared source, "feeds ~8 subpages" | **`scripts/generate_jsonld.mjs`** renders `landing/_jsonld/{product,service,application,organization,website}.json.template` into the 5 managed inline `<script ld+json>` blocks across **11 pages** (docs, faq, glossary, how-it-works, index, integrations, privacy, skills, terms, tools, verify). It is the SINGLE OWNER of those blocks; has its own `--check`; **is NOT in `build:landing` and NOT a `deploy.yml` gate** (a developer runs it manually — deploy.yml:156 notes the "numerical refresh seam"). |
| the fix is "3 sources" | **Only `product.json.template` HARDCODES** a count: `"5 crypto perp venues (Hyperliquid, Binance, Bybit, OKX, Bitget)"`. **`service` + `application` templates already use a live-bound `{{exchange_count}}`** placeholder → `generate_jsonld` substitutes the LIVE SoT (15). |
| `build_landing`/`build_docs --check` gate the deploy | ✅ true (deploy.yml:89/95) — but they do NOT own the JSON-LD; `generate_jsonld --check` is the JSON-LD gate and is **NOT wired into deploy.yml** (so the 11-file drift never blocked a deploy). |

**`generate_jsonld --check` today = FAIL, 11 files drift** (pre-existing — it hasn't been run since the SoT snapshot moved). Simulated a write: pages become **Product = "5 crypto perp venues (Hyperliquid…)"** (hardcoded, stays 5), **Service/Application = "15 crypto perp venues[, 1405+ assets, 11 timeframes]"** (live-bound). A `generate_jsonld` run ALSO refreshes every other snapshot number (pfe_wr=91.8%, total_calls=403411, asset_count=1405, …) into all 11 pages — a broad diff, not venue-only.

## B. Full stale surface (14 files, 2 variants) — vs the prompt's 3

| Surface | Stale text | Owner | Fix |
|---|---|---|---|
| `landing/_jsonld/product.json.template` | `5 crypto perp venues (Hyperliquid…)` (hardcoded) | generate_jsonld source | **count-free** — the core bug |
| `landing/_jsonld/service.json.template` | `{{exchange_count}} crypto perp venues` | generate_jsonld source | DECISION (Q2): keep live-bound OR count-free |
| `landing/_jsonld/application.json.template` | `{{exchange_count}} crypto perp venues, {{asset_count}}+…` | generate_jsonld source | DECISION (Q2) |
| 11 generated pages' JSON-LD (`docs, faq, glossary, how-it-works, index, integrations, privacy, skills, terms, tools, verify`) | "5" (8 pages) / "15" once regenerated | generate_jsonld output | regenerate after template edit (11-file diff) |
| `landing/how-it-works.html:7` | `<meta name="description"> … 5 perp venues` | HAND-AUTHORED (not JSON-LD) | direct edit |
| `landing/faq.html:88/112/128` | visible FAQ + FAQPage `"text": …12 crypto perp venues` | HAND-AUTHORED (generate_jsonld **preserves** FAQPage) | direct edit |
| `landing/integrations/maf.html:300` | prose `across 5 crypto perp venues` | **cross-repo** — `render-integrations.mjs` from external `~/code/algovault-skills` | DEFER (Q4) — can't fix the source here |
| `docs-src/template.html:70/100/122` | `5 crypto perp venues` in its JSON-LD | build_docs source, but generate_jsonld overwrites docs.html's JSON-LD after | edit for source-consistency; generated docs.html re-owned by generate_jsonld |

SoT live: `exchange_count=15`.

## C. What a blind "fix 3 sources" would do wrong

1. Editing `product.json.template` alone WITHOUT `generate_jsonld` regen leaves all 11 pages stale (build_landing/build_docs don't own the JSON-LD).
2. Running `generate_jsonld` refreshes the WHOLE snapshot into 11 pages (broad diff, touches numbers other waves manage), AND re-binds service/application to "15" (a baked count the standing rule may not want).
3. Leaves how-it-works `<meta>`, faq visible text (the "12" variant), and maf.html prose still stale.

---

## D. Architect HALT — awaiting ratification (see chat fenced block)

R0 refuted the prompt's "3 sources" model. Proposed default: `product.json.template` → count-free + `generate_jsonld` regen (fixes all 11 Product blocks + resolves the 11-file drift), service/application → count-free too (strict "no count"), how-it-works `<meta>` + faq text → count-free direct edits, maf.html → cross-repo follow-up, canary extended to `_jsonld/*.template` + docs-src + static landing. HALT before any state mutation.
