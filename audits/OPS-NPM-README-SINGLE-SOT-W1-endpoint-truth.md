# OPS-NPM-README-SINGLE-SOT-W1 — Endpoint-Truth (Plan-Mode Step 0)

**Probed:** 2026-05-31 (live) · **Verdict:** GREEN — wave executable; 2 architect-decision rows (injector-extend confirm + track-token-in-public-README). Doc-only; no release.

## R0.0 — $REPO

`/Users/tank/code/crypto-quant-signal-mcp` (HEAD==origin/main `b0bae85`, 0/0; contains current main). Old `/Users/tank/crypto-quant-signal-mcp` is **9 behind** — NOT used.

## R0.2 — Injector→README wiring (the make-or-break unknown) — RESOLVED

| claim | reality | resolution |
|---|---|---|
| "the repo README's SNAPSHOT-LINE numbers are auto-refreshed by the injector" | **FALSE.** `scripts/snapshot-landing-data.mjs` targets **`landing/*.html` ONLY** (docstring: "snapshot injection for landing/*.html fallbacks"; manifest `apply_to_files` = `landing/index.html`, `landing/how-it-works.html`, `landing/skills.html`, …). **Zero README references** in the injector or the manifest. | **README is NOT covered → R2 EXTENDS the manifest** (add `README.md` to relevant claims' `apply_to_files`, plus new claims for README-only span names). NOT the trivial "confirm" path. |

**Smoking-gun proof the README is hand-fed (stale)**: repo README `data-tr-field="total_calls"` literal = **96,898** but live `overall.totalCalls` = **134,276** (+37,378). Even the "current" repo README is stale — nothing auto-refreshes it.

Manifest shape (for R2): 20 claims; each `{id, find_pattern (regex on `data-tr-field="X"…`), replace_template, sot (merkle|performance), accessor, format, apply_to_files[], replace_all}`. `sot_endpoints = {merkle, performance}`. Note span-name mismatch: landing uses `data-tr-field="call_count"`; README uses `data-tr-field="total_calls"` + `"merkle_batches"` — so R2 adds README-keyed claims (or extends find_patterns), not just file-list appends.

## R0.3 — Field canonical values (live; correct API keys after shape-probe)

| README span | README literal (stale) | Live source | Canonical | Δ |
|---|---|---|---|---|
| `pfe_wr` | `90.5%` | `/api/performance-public .overall.pfeWinRate` = 0.9126136 → `formatPfe` (1-dp, %) | **`91.3%`** | +0.8pp |
| `total_calls` | `96,898` | `.overall.totalCalls` (== top `.totalCalls`) | **`134,276`** | +37,378 |
| `merkle_batches` | `38` | `/api/merkle-batches .batches \| length` | **`50`** | +12 |
| `hold_rate` | `99%` | `.hold_rate` = 98.9 → rounds | **`99%`** | = |
| agent-id | `44544` | `/api/erc-8004-reputation .agent_id` (key is `agent_id`, NOT `agentId`) | **`44544`** | = (already correct) |
| integrations URL | `/docs/integrations/<slug>` | live: `/integrations/langchain`→**200**, `/docs/integrations/langchain`→**301** | **`/integrations/<slug>`** | repo stale |

Data-Integrity note: every number MOVED UP (calls +37k, batches +12, pfe +0.8pp) — reconciliation only raises public numbers; none reduced. ✅

## R0.4 — LIVE consumers to repoint (vs historical)

Filtered `grep -rl NPM-readme` (excluding Old Status / status.md / audits / .bak / completed specs / ToDoList):

- **LIVE — repoint (3):** `CLAUDE.md` (SoT rule), `Prompt/release-wave-daily-template.md` (R3 step), `Claude files/release-cadence-session-handoff.md`.
- **VERIFY at R3 (2):** `system-map.md` (check for a live "Key file map" SoT row vs historical Last-touched narrative — repoint only the live row), `ToDoList.md` (check for a live open item).
- **LEAVE (historical/audit):** `Claude files/WIS-PENDING.md` (audit bullets incl. the v1.19.0 drift observation), `Prompt/npm-publish-v1.19.0-w1.md` (done wave), `Prompt/ops-npm-readme-single-sot-w1.md` (this spec), + ~25 archival specs/audits/Old-Status.

## R0.5 — Operator-notes header

`NPM-readme.md` lines 1–**42** (`<!-- … -->`). Not parsed by any live mechanism (AGENT_ID_PLACEHOLDER refs are historical specs + the README body). Migration target: a `## README maintenance` subsection in `Prompt/release-wave-daily-template.md`.

## R0.6 — Blast radius

Repo `README.md` edit = `*.md` → does NOT trigger `deploy.yml`. **R2 manifest/injector edit = non-`.md` → WILL trigger `deploy.yml`** (snapshot injector runs against landing; fail-open + ≥50%-zero-match exit-1 catastrophic guard preserved). Watch that run GREEN + verify post-deploy README numbers == live. No version bump / tag / publish / Discussion / X-thread.

## Architect-decision rows (for R0 approval)

1. **Injector-extend confirmed?** README is NOT injector-covered (proven). R2 will edit `scripts/snapshot-landing-manifest.json` (+ possibly add README-keyed claims) so the README's SNAPSHOT-LINE numbers auto-inject like landing/*.html. This is the "best" Option-1 path. (Alternative: leave README hand-fed but reconciled now — rejected, reintroduces the drift class.) → **approve injector extension.**
2. **Track-token header in PUBLIC README?** Repo README's Claude-Code-CLI example carries `--header "X-AlgoVault-Track-Token:chan-readme"` (from internal OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1 — channel attribution). KEEP (attributes README-sourced installs) or STRIP (cleaner public example, no tracking token)? → **Mr.1 decides.**

## HALT-class summary

0 HALT. 2 decision rows above. Wave executable: R1 reconcile (raise stale numbers to live) → R2 extend injector + smoke → R3 repoint 3 live docs + migrate header → R4 archive `NPM-readme.md` → `Claude files/` (NOT hard-delete; vault not git-backed) → R5 push/verify → R6 status/WIS. No release.
