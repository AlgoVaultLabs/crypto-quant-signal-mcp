# EQUITY-TOOLS-DARK-RETIRE-W1 — Plan-Mode endpoint-truth (R0)

**Probed:** 2026-07-16 · worktree `ops/equity-tools-dark-retire-w1` off `origin/main` (`b070a15`) · host `204.168.185.24` (read-only).
**Verdict:** ✅ **0 fictional primitives · 0 companion-manifest break · 0 client-dependency break · 0 canary break → NO HALT.** Proceed to R1–R6.
**Reversible / two-way-door · ZERO data deletion.**

---

## 0. Primitive probe (claim | reality | resolution)

| # | Spec claim | Reality (live-probed) | Resolution |
|---|---|---|---|
| 1 | Tool SoT = `feature-registry.ts`; has `enabled` field vs only `publicListing` | REAL. `FeatureSpec.enabled: boolean` (`src/lib/feature-registry.ts:87`) **and** `publicListing?` (:99). Equities: `enabled:true, publicListing:false` (:177,:188) | Use neither as the retire lever (see §2) — an **env flag** matching the codebase's `a2mcp`/`acp` "registry declares eligibility, env flag gates live reach" pattern (FeatureSpec doc :60–67) |
| 2 | Registration path in `index.ts` | REAL + **registry-driven**: `register(name,…)` fills `toolDefs`; loop `for (const name of allToolNames())` (`index.ts:864`) does the actual `server.tool()`; bidirectional parity guard (:864–872) throws on drift | **`allToolNames()` IS the live-surface lever.** Gate the loop → `liveMcpToolNames()` (§2) |
| 3 | Equity engine files present | REAL. `src/lib/equities/**` (13 files), `src/scripts/{seed-equities,backfill-equity-bars,backfill-equity-outcomes,build-equity-universe}.ts` all present | PRESERVE untouched (R4) |
| 4 | Host equity crons (204) | REAL. `crontab -l`: **L170** `seed-equities.js ; equity-verdict-watch.sh` (compound), **L171** `backfill-equity-outcomes.js`, **L172** `equity-launch-readiness.sh` | Remove L170–172 (R3); `venue-readiness-report.js` (**L167**) KEPT |
| 5 | Host monitoring scripts | REAL. `/opt/algovault-monitoring/equity-verdict-watch.sh` (2341B), `equity-launch-readiness.sh` (4508B) | Back up + disable (R3) |
| 6 | Readiness card path | REAL. `venue-readiness-report.ts:107–113` appends `renderToolReadiness(loadEquityReadinessInput(dbQuery))` before the single `sendDigest()` (:122) | Gate that block on the flag (R2) |
| 7 | Companion manifests enumerate equity tools? | **NO.** `server.json` / `manifest.json` (DXT) / `lobehub-manifest.json` — zero equity mention (equities were held off nav) | **No manifest change** (resolves Exec-Plan HALT condition) |
| 8 | Databento key | REAL. `DATABENTO_API_KEY` referenced by `equity-bars-provider.ts` (compose `.env`) | Untouched; spend → 0 once crons stop |

**Cron invocation is `docker exec crypto-quant-signal-mcp-mcp-server-1 …` (in-container)** for both tool registration and `venue-readiness-report.js` → **one env source** (`EQUITY_TOOLS_ENABLED` in the container `.env`) gates BOTH surfaces. Single-derivation confirmed feasible.

---

## 1. Consumer-liveness enumeration (before producer demotion)

Per `verify-consumer-liveness-before-producer-removal-or-demotion` — every consumer of the equity producers, and its disposition:

| Consumer | Liveness | Disposition on retire |
|---|---|---|
| MCP tools `get_equity_call` / `get_equity_regime` (`index.ts:614,649`) | LIVE (tools/list=9) | **Gated** off tools/list via `liveMcpToolNames()` (R1) |
| Readiness card `venue-readiness-report.ts:107–113` | LIVE (in-container daily 06:05) | **Gated** off (R2); venue digest + `sendDigest()` unchanged |
| `equity-verdict-watch.sh` (fires `OPS_EQUITY_ZERO_VERDICT` when bars>0 ∧ 0 recent verdict-sessions) | LIVE (L170 chain) | **Would false-fire on the intentional stop** → STOP (remove L170 + disable script) — R3 |
| `equity-launch-readiness.sh` (one-shot launch latch) | LIVE (L172) | STOP (remove L172 + disable script) — R3 |
| x402 HTTP routes `HTTP_TOOLS` incl. equity (`x402-http-routes.ts:108,166–169`) | LIVE (paid) — dispatch **direct to `getEquityCall`/`getEquityRegime`**, independent of MCP registration | **LEFT LIVE** (see §3 scope) — gating tools/list cannot break it |
| x402-bazaar equity offerings (`x402-bazaar.ts:249,275`) | LIVE (paid, discovery) | **LEFT LIVE** (§3) |
| `signal-performance` MCP resource `equities` key (`index.ts:902–909`) | LIVE, **fail-open** to `{state:'pre_data'}` on DB miss | LEFT (additive, PFE-only, reads preserved data; degrades gracefully) |
| `get_trade_call` `assetClass:'equity'` routing (`index.ts:402,632`) | LIVE (power-user param) | LEFT — **schema frozen by AC5**; degrades to stale/pre_data via existing fail-open |
| `tier-misclassification-canary.sh` | LIVE (L201) but **mentions equity only in comments** — NOT an equity-data consumer | UNAFFECTED |
| `check-feature-registry-drift.mjs --live` (weekly host cron; asserts **live tools/list == /capabilities**, Section A) | LIVE — would FALSE-FIRE `FEATURE_REGISTRY_DRIFT` if tools/list gated to 7 but /capabilities left at 9 | **Fixed by gating /capabilities too** (§3) — both = 7 OFF → canary green. Its `--check` STATIC half is registry-internal (green, registry pristine) |
| `check-feature-registry-drift.mjs --check` (CI gate, `deploy.yml`) | LIVE — STATIC: `projectCapabilities()==allToolNames()` + `HTTP_TOOLS==httpX402` | UNAFFECTED (all read the pristine registry; both 9) |
| `deploy-direct.sh` (manual fallback deploy; asserts tools/list `== EXPECTED_TOOLS=9`) | NOT in the active path (GHA is; not run by `deploy.yml`/pre-push — comment-ref only) | Made **flag-aware** (reads container flag; 7 default / 9 ON) so a manual fallback run still verifies |
| `transport-coverage-matrix.mjs`, `check-mcp-stateless.mjs` | LIVE reports; matrix is print-only (not a gate); stateless asserts `nTools>=1` | UNAFFECTED (7≥1; matrix informational) |

**All equity-data + tool-surface consumers accounted for** (consumer-liveness swept across `scripts/`, `ops/`, `.github/`). The two watchdog scripts are the only ones that would *alert* on the stop — both stopped. The `--live` registry-drift canary is the one live tool-surface consumer that needed a code fix (gate /capabilities in lockstep).

---

## 2. Design decision — the single reversible lever

**Flag:** NEW env var **`EQUITY_TOOLS_ENABLED`**, default **false**. NOT the `enabled` registry field, NOT `publicListing`. Rationale:
- **Codebase idiom:** every prior flag flip (`X402_NUDGE_ENABLED`, `UNIFIED_SIGNIN_ENABLED`, `OKX_AI_ENABLED`, `ACP_ENABLED`) is an **env** flip (`.env` append + `docker compose up -d` recreate, no image rebuild). The FeatureSpec doc (`feature-registry.ts:60–67`) already codifies "registry declares eligibility, env flag gates live reach" for `a2mcp`/`acp`. This wave applies the same pattern to the `mcp` channel.
- Matches objective "**re-enable is a flag flip, not a rebuild**" + AC1 "**env-flip**".
- **Keeps `FEATURE_REGISTRY` / `allToolNames()` / `projectCapabilities()` / `HTTP_TOOLS` pristine** → every static/source-text parity canary stays green (feature-registry.test, channel-registry.test, x402-registry-derive, routing-shape snapshot, nav-manifest, …). No canary churn, no drift-canary breakage.
- Parser accepts `1` **or** `true` (case-insensitive) — bakes in the X402_NUDGE `=== 'true'`-only hotfix lesson (status.md 2026-07-12).

**Single derivation** — one predicate `isEquityToolsEnabled(env)` + one set `isEquityToolName(name)`, consumed by exactly the two surfaces the prompt names:
1. **Tool registration** (`index.ts` loop): `for (const name of liveMcpToolNames())` where `liveMcpToolNames(env) = allToolNames().filter(n => isEquityToolsEnabled(env) || !isEquityToolName(n))`. Flag OFF → 7; ON → 9. The two equity `register()` calls stay in source (harmless; unused when not iterated) → source-text canary (`trade-call-routing-shape.test.ts:44`) stays green. Parity guard B (`:871`, `toolDefs ⊆ allToolNames`) stays valid (toolDefs only ever holds registry names).
2. **Readiness card** (`venue-readiness-report.ts:107–113`): `if (isEquityToolsEnabled()) { …append card… }`.

New leaf: `src/lib/equities/equity-tools-flag.ts` (`EQUITY_TOOL_NAMES`, `isEquityToolName`, `isEquityToolsEnabled`, `liveMcpToolNames`) — pure, import-safe, unit-testable.

---

## 3. Explicit scope boundaries (fact-honest)

- **The flag gates the WHOLE live MCP channel (tools/list + /capabilities), not just tools/list.** The feature-registry `--live` drift canary (`check-feature-registry-drift.mjs`, weekly host cron) asserts **live tools/list == /capabilities** (Section A). Gating tools/list while leaving `/capabilities` at 9 would be a *real* MCP-channel inconsistency (a client reads `/capabilities`, calls `get_equity_call` over MCP, gets "not found") — the canary would correctly fire `FEATURE_REGISTRY_DRIFT`. So the `/capabilities` **route** filters to `liveMcpToolNames()` too (7 OFF / 9 ON) — both surfaces derive from the ONE predicate. **`projectCapabilities()` the pure function stays pristine (9)** → the STATIC `--check` CI canary + `feature-registry.test.ts` read it directly and stay green; only the *route output* is gated.
- **Declared (9) vs live MCP channel (7 default-OFF):** the **registry keeps declaring 9** (no add/remove/rename) → `allToolNames()`=9, `projectCapabilities()`=9, the routing-shape snapshot `tools_list_count=9`, `HTTP_TOOLS` (x402 rail) unchanged. Only the **runtime tools/list + /capabilities route** drop to 7 (env-gated). Matches the strategic decision (status.md 2026-07-15 §17: "unregister … + stop crons + silence card").
- The routing-shape snapshot (`audits/trade-call-routing-shape-snapshot-2026-06-09.json`) has **no automated consumer**; its manual `drift_check_command` asserts `/capabilities|length==9` (now env-gated to 7 default-OFF) + get_equity_call in tools/list (now env-gated). Left untouched (another wave's frozen artifact; the `tools_list_count=9` test asserts the DECLARED `allToolNames()`, still 9); distinction documented here + status.md.
- **x402 HTTP routes (`HTTP_TOOLS`) + bazaar offerings NOT gated** this wave (out of the prompt's flag scope = registration + card; leaving them keeps the static registry↔HTTP_TOOLS parity canary green). The equity tools stay callable via the **paid x402 rail** — capability preserved. Non-discoverable off tools/list, paid, degrade gracefully. Possible follow-up `OPS-EQUITY-X402-DARK-W{NEXT}` (WIS) for a full retire.
- **`get_trade_call.assetClass:'equity'` + `signal-performance.equities` key LEFT** (AC5 schema freeze / additive resource; both fail-open over preserved data).
- **`deploy-direct.sh` (manual fallback deploy)** hardcoded `EXPECTED_TOOLS=9` → made **flag-aware** (reads the container's `EQUITY_TOOLS_ENABLED`; 7 default / 9 when ON). GHA (`deploy.yml`) is the active deploy path and asserts no live tool count (only static `--check` canaries) → the push-deploy passes.

---

## 4. Identifier diff (R-section ↔ AC-section) — no mismatch

| Identifier | Value (verified) |
|---|---|
| Container | `crypto-quant-signal-mcp-mcp-server-1` ✓ |
| Postgres ctr / DB / user | `crypto-quant-signal-mcp-postgres-1` / `signal_performance` / `algovault` ✓ |
| Host | `204.168.185.24` ✓ |
| Deploy dir | `/opt/crypto-quant-signal-mcp` (compose) ✓ |
| Monitoring dir | `/opt/algovault-monitoring` ✓ |

## 5. Data-Integrity baseline (R4 — identical before/after)

`equity_universe`=**501** · `equity_bars_daily`=**267375** · `equity_verdicts`=**15000** (30 sessions, last `2026-07-14`). View `equity_pfe_by_rank_bucket` present. `EQUITY_TOOLS_ENABLED` currently **unset** in container → code default-OFF performs the retire on deploy.

---

## 6. Execution sequence (no HALT)

R1 flag leaf + registration gate + unit tests (7 vs 9) → R2 card gate → R3 host crons/watchdogs stop (crontab backup + script backups + disable) → R4 Data-Integrity assertions (row counts identical, engine in `dist`) → R5 re-enable runbook → R6 clean rebuild + full vitest + deploy + live tools/list=7 + flag-ON throwaway smoke=9 + in-container dry-run digest (no equity card) + status.md/system-map/WIS/scp.
