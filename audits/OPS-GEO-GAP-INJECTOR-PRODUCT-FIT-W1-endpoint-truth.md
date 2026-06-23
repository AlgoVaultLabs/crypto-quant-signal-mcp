# OPS-GEO-GAP-INJECTOR-PRODUCT-FIT-W1 — Plan-Mode Step 0 endpoint-truth

**Probed:** 2026-06-23 (read-only). **Status: HALT — awaiting architect approval before any state mutation (schema ALTER, backfill, deploys, git).**
**Repos:** signal-MCP `~/code/crypto-quant-signal-mcp` (origin/main `5a2b6e7`) + editorial pipeline `/opt/algovault-editorial` (algovault-owned git, remote `algovault-editorial`, main synced `3c0298d`). Cross-repo boundary = Postgres `geo_content_gaps`.

## Probe results (claim | reality | resolution)

| # | Spec primitive | Reality (live-probed) | Resolution |
|---|---|---|---|
| 1 | injector gap-selection query | `geo_gap_injector.mjs:132-137` — `SELECT … FROM geo_content_gaps WHERE injected_at IS NULL ORDER BY rank_score DESC NULLS LAST, id LIMIT ${limit}` | add `AND injectable = true` to the WHERE (default-deny) |
| 2 | `geo_content_gaps` has product_fit/injectable | `\d` confirms: 12 cols, **NEITHER exists**. UNIQUE(iso_week, query_id); partial idx `…uninjected WHERE injected_at IS NULL` | `ADD COLUMN IF NOT EXISTS product_fit REAL`, `injectable BOOLEAN`; info-schema pre-check |
| 3 | shared `getProductFit` location | `geo-decide.ts:157` `function productFitOf(obj, query_id)` — **PRIVATE (not exported)**; used at `:203` in scoreWeek | EXPORT `productFitOf(obj, queryId)` from geo-decide.ts → import in geo-gap-list.ts (acyclic: geo-decide doesn't import geo-gap-list) |
| 4 | write-side persist | `geo-gap-list.ts:199` `persistGapBriefs` INSERT cols `(iso_week,query_id,query_tier,model,sov,top_competitor,top_competitor_domain,recommended_action,rank_score)` — live (called by `geo-orchestrator.ts:261`) | add `product_fit`, `injectable` to INSERT; resolve via `loadObjective()`+`productFitOf` |
| 5 | yaml product_fit + threshold | `geo-objective.yaml:63` product_fit `{best-python-backtester:0.15, python-quant-for-ai:0.2}`; `:76` `open_query.product_fit_threshold: 0.5`; **no `inject_threshold`** | add `inject_threshold` (see Q1 for placement) |
| 6 | injector --dry-run CLI | `lib/cli/geo-gap-inject.mjs` — `node lib/cli/geo-gap-inject.mjs --dry-run [--vault=…]` → `injectGeoGaps({vaultPath, dryRun})`; dry-run returns `rows_preview`, no write | use for AC verification (after seeding synthetic rows — see Q3) |
| 7 | row count + backfill dry-run | 2 rows: id=7 best-mcp-trading (pf→**1.0**, injectable=**true**), id=8 best-python-backtester (pf→**0.15**, injectable=**false**). BOTH already injected. **No unknown query_ids; no NULLs after backfill; no legit gap flipped off** | backfill: `product_fit` from yaml (default 1.0), `injectable = product_fit >= inject_threshold` |
| 8 | inject_threshold diff (yaml vs scorer) | scorer seed-promotion uses `open_query.product_fit_threshold: 0.5`; new injector gate `inject_threshold` = 0.5 (same value, **different decision**) | see Q1 — separate field recommended |

## Fictional primitives: **0.** Everything probed is real. One spec imprecision (Q1: `product_fit.inject_threshold` literal nesting would pollute the query_id→fit map) → fix inline + confirm.

## Canary homes (3-part single-derivation guard, spans both repos)
- (a) misfit→`injectable=false` + (c) write-side pf == scorer pf → **signal-MCP `tests/unit/geo-gap-list.test.ts`** (vitest; already mocks `dbRun`/`dbQuery`/`dbExec` — assert the INSERT args + import `productFitOf` for byte-identical projection).
- (b) injector selection returns zero `injectable=false` → **editorial `tests/unit/geo_gap_injector.test.mjs`** (node:test; injects `query` fn for tests).

## system-map edge-touch
`geo_content_gaps → geo_gap_injector` edge: producer/consumer UNCHANGED; a **predicate** (`injectable=true`) is added to the read-side selection + two columns to the write-side. Enumerate as a predicate-add row (or n-a if the edge isn't mapped — to confirm at Step 0 of execution).

## Deploy paths (per-repo norm; NEVER a root git op)
- signal-MCP: commit+push origin/main (worktree off `5a2b6e7`) → `scripts/deploy-direct.sh` (rebuild+recreate — yaml + code baked into image). **Schema ALTER+backfill pre-applied via SSH `docker exec …postgres-1` BEFORE the code deploy** (IF NOT EXISTS idempotency).
- editorial: edit `/opt/algovault-editorial/lib/geo_gap_injector.mjs` in place as **algovault** + `sudo -u algovault git commit/push` (live dir = checkout; systemd injector runs from here). NEVER root git.

## Sequenced plan (post-approval)
1. Schema: SSH info-schema pre-check → `ADD COLUMN IF NOT EXISTS product_fit REAL, injectable BOOLEAN` → backfill 2 legacy rows → verify no NULLs.
2. signal-MCP (worktree off 5a2b6e7, TDD): yaml `inject_threshold`; export `productFitOf`; `persistGapBriefs` writes product_fit+injectable; geo-gap-list.test.ts canary (a)+(c). Build/typecheck/test → commit+push → deploy-direct.sh.
3. editorial (as algovault): `geo_gap_injector.mjs` WHERE `+ AND injectable = true`; geo_gap_injector.test.mjs canary (b); node --test → commit+push.
4. Verify: seed 2 synthetic uninjected gaps (future iso_week) → injector `--dry-run` excludes best-python-backtester, includes ai-agent-trade-signals → DELETE synthetic rows.
5. status.md (both repos, cross-repo noted) + WIS + system-map row. No version bump, no completion TG.

## Architect-confirm questions — see HALT block in the dispatch response.
