# OPS-ACTIVATION-LEAK-FIX-W1 — CH1 Step-0 Endpoint-Truth Doc

**Wave:** OPS-ACTIVATION-LEAK-FIX-W1 (Tier-2 Bulk-Spec, META/INTERNAL)
**Chapter:** CH1 (read-only probe; truth doc only — NO src/host mutation)
**Probed:** 2026-06-29 (UTC), live `origin/main` @ `7b13f0c` + Hetzner `204.168.185.24`
**Worktree:** `/Users/tank/code/cqsm-wt-activation-leak-fix` (branch `ops/activation-leak-fix-w1`, off `origin/main` — worktree-first LAW)
**Reconcile:** local `~/code/crypto-quant-signal-mcp` was 82 commits behind `origin/main` + had unrelated uncommitted dirt (README/landing) → worked off a fresh `origin/main` worktree, dirt untouched.
**Verdict:** 🛑 **HALT before CH2 mutation** — ≥3 load-bearing spec-vs-reality drifts that change the CH2/CH3 build and require architect (Mr.1 → Cowork) decisions. Q-block at bottom.

---

## Probe results (`claim | reality | resolution`)

### P1 — `mcp_tools_list` emit (the headline artifact)
**claim:** "the `tools/list` handler never emits the funnel event … emit `recordFunnelEvent('mcp_tools_list', …)` to fix the 0.000%."
**reality:** The snapshot does **not** read `mcp_tools_list` from `funnel_events` at all. It derives it from a **`request_log` query**: `getMcpToolsListSessionCount()` → `SELECT COUNT(DISTINCT session_id) FROM request_log WHERE tool_name='tools/list'` ([funnel-snapshot.ts:284-296](src/lib/funnel-snapshot.ts), comment line 281-283 claims "stored verbatim — confirmed via Plan-Mode P11"). **Live DB: `request_log` has 0 rows with `tool_name='tools/list'`, all-time.** The MCP `tools/list` JSON-RPC method is handled internally by the high-level `McpServer` SDK (`server.tool()` API, [index.ts:351](src/index.ts)) and **never calls `logRequest`** — `request_log` only ever contains real tool calls (`get_trade_call`=23749 rows/318 sessions, `scan_trade_calls`=339, `get_market_regime`=95, … — **no `tools/list`, no `initialize`**). Git pickaxe: the query was introduced in ONE commit `77baa0e` (ACTIVATION-FUNNEL-AUDIT-W1) — there was never prior working tools/list logging, so "P11 confirmed verbatim" was an **untested, false assumption**, not a regression.
**resolution:** 🛑 **LOAD-BEARING.** Emitting a `funnel_events` row alone will NOT move the snapshot (it reads `request_log`). The fix needs a **read-side redirect too** — the spec omits this. Architect decision on the capture locus (Q1). `getMcpToolsListSessionCount` will *always* return 0 as written.

### P2 — Stage order / count
**claim:** "system-map says 14 / retentions 13."
**reality:** ✅ Exact match. `CANONICAL_STAGE_ORDER` = **14** stages ([funnel-snapshot.ts:209-224](src/lib/funnel-snapshot.ts)): `install, mcp_tools_list, first_call, quota_hit_soft, quota_hit_hard, quota_hit_block, upgrade_cta_clicked, stripe_checkout_started, paid_upgrade, tg_bot_start, tg_bot_first_command, tg_bot_watchlist_add, tg_bot_quota_hit, tg_bot_upgrade_clicked`. **13** adjacent retentions. `install` = stage 1 (`npm_install`), `first_call` = stage 3.
**resolution:** No drift. NOTE the spec's "MAY NOT change `CANONICAL_STAGE_ORDER` count without Cowork sign-off" — this firewall is implicated by Q2 below (redefining install/first_call semantics).

### P3 — `install` / `first_call` denominators (what they actually are)
**claim (North-Star §3):** "the `install` denominator is server-side connect events on the **remote HTTP transport only** … polluted by crawlers, registry health-checks, and stateless reconnects."
**reality:** ❌ **False.** `install` = **npm registry download count**, fetched at snapshot time from `https://api.npmjs.org/downloads/range/...` ([funnel-snapshot.ts:495-512](src/lib/funnel-snapshot.ts); comments lines 25, 43, 210). Live: `install`=**1113** (06-29), 740 (06-22). `first_call` = `COUNT(DISTINCT session_id)` from `agent_sessions` (server-side, =**279**). The actual **server-side connect** signal is a *separate* event, `mcp_connect` (funnel_events: **3809 rows / 672 distinct sessions** all-time; `by_source` in-window connects=**669** [658 unknown + 11 claude] on 06-29) — emitted once-per-session at the `/mcp` POST layer ([index.ts:2893-2907](src/index.ts)). **1113 (npm) ≠ 669 (connects)** — they are different numbers from different sources.
**resolution:** 🛑 **LOAD-BEARING.** The `install→first_call` 25.07% mixes an **npm-download count** (numerator-blind to our server) with a **server-side session count**. UA/IP bot-classification (CH3) **cannot clean npm downloads** — npm serves them; our server sees no UA/IP. See Q2.

### P4 — `funnel_events` schema
**claim:** "confirm cols id,event_type,ts,session_id,chat_id,license_tier,meta_json and that `meta_json` is **jsonb**."
**reality:** Columns ✅ all present. But `meta_json` is **`text`**, **not** `jsonb` (`\d funnel_events`: `meta_json | text`). Existing code already stores JSON strings via `recordFunnelEvent({meta:{…}})` and reads them with `JSON.parse(row.meta_json)` ([funnel-snapshot.ts:368](src/lib/funnel-snapshot.ts)).
**resolution:** ⚠️ Minor (fix inline + flag). The spec's *conclusion* — "can hold `is_automated`/`reason`/identity-tier without a migration" — **holds** (text-holding-JSON, no migration). Only the `jsonb` characterization is wrong. CH3 must JSON-merge into the text column (read-modify-write or stamp at emit), not use JSON operators.

### P5 — Shared resolver + emit-site audit
**claim:** "every `recordFunnelEvent` derives `session_id` from ONE `resolveSessionCorrelationId`; flag any site not using it."
**reality:** `resolveSessionCorrelationId(headers, ipHash)` ([index.ts:314](src/index.ts)) = `trackToken ?? ipHash ?? randomUUID()`, returns a **bare string** (does NOT expose which tier it resolved). At the POST layer ([index.ts:2827-2828](src/index.ts)) `sessionId` is resolved once and (a) used by the `mcp_connect` + `first_tool_call_with_track_token` emits and (b) stored in the `requestContext` ALS, which the per-tool cohort emits read via `getRequestSessionId()` (`quota_hit_*` via [license.ts:687](src/lib/license.ts), [tier-warning.ts:115](src/lib/tier-warning.ts); `first_non_hold_verdict` via [aha-event.ts](src/lib/aha-event.ts)). So emit sites **already share the resolver** (directly or via ALS). The landing/referral emits (`landing_cta_clicked`, `track_record_viewed`, `referral_*`) intentionally use a client-supplied id (clientReferenceId) — different surface, not a bug.
**resolution:** ✅ Mostly already single-derivation. The genuine gap is **only** `mcp_tools_list` (no emit + wrong read source, P1). CH2's "stamp identity tier" requires a **new companion helper** that returns `token|fallback|anon` (the bare resolver can't be inferred from its return value) — anticipated by the spec ("track-token.ts … if it needs an exported helper").

### P6 — Detector (host)
**claim:** "locate the host script behind `/var/log/algovault-funnel-leak-detector.log`; print trigger logic, snapshot load, test entrypoint, `send_telegram.sh` use."
**reality:** Script = `/opt/algovault-monitoring/funnel-leak-detector.py` (297 lines). **Repo-tracked** at `audits/ACTIVATION-FUNNEL-AUDIT-W1-funnel-leak-detector.py`, **md5-identical to host** (`e868b443c0d4e423fa1a206ebcfde888`) → CH4 edits in-repo, CH5 rsyncs to the host's canonical name. Trigger logic (2 conditions):
- **(a)** `install_to_first_call < 0.20%` floor (`INSTALL_TO_CALL_FLOOR=0.0020`). **DEAD GATE:** comment says "baseline ≈ 0.29%" but live is **25.07%** (100× drift) — never fires.
- **(b)** any of 13 stage transitions drops **≥40% WoW** (`WOW_DROP_THRESHOLD=0.40`), skipping pairs where `prev<=0`.
Loads `*-auto.json` from `/opt/crypto-quant-signal-mcp/activation-funnel/snapshots/` (latest vs previous). Entrypoint: `DRY_RUN_AUTOPILOT=1` → prints body, no wrapper. Uses `send_telegram.sh ACLERT_ID CRITICAL_PERSISTENT -` (no inline gate re-impl). The `/var/log/algovault-funnel-leak-detector.log` referenced in the alert body (line 211) **does NOT exist** — detector runs via `algovault-funnel-leak-detector.timer` (Mon 11:13 UTC) → journald stderr.
**🔑 What ACTUALLY fired today's alert (06-29 vs 06-22):** condition (b) on **ONE** transition: `tg_bot_start_to_tg_bot_first_command` 0.2857 (2/7) → 0 (0/7) = **100% WoW drop**. `install_to_mcp_tools_list` was **0 in BOTH weeks** → `prev<=0` → **skipped** (NOT a trigger reason; it appears only as `weakest_stage_transition` in the alert *body*). `install→first_call`=25% never breached the floor. So the spec's "two artifacts + one polluted number" is the funnel-health *narrative*; the *mechanical* trigger was a single small-N reason.
**resolution:** ⚠️ Record the precise trigger so CH4 tests assert reality. CH4's design still maps cleanly: Gate 0 neutralizes `install→mcp_tools_list` (structural zero); Gate 1 (n=7 < N_min=30) neutralizes the real `tg_bot` trigger. Note condition (a) is already inert.

### P7 — Snapshot cron / writer
**claim:** "what writes `<date>-auto.json`? where are 06-29 + 06-22?"
**reality:** Writer = `scripts/funnel-snapshot.ts` CLI + `commit-funnel-snapshot.sh`, scheduled by **`algovault-funnel-snapshot.timer`** (Mon 10:00 UTC; last fired 2026-06-29 10:00 → wrote 06-29; **next 2026-07-06 10:09** = the North-Star target snapshot). Snapshots are **both** git-tracked (`activation-funnel/snapshots/`, 13 files, 06-22 + 06-29 present locally) **and** on host (`/opt/.../snapshots/`, host has 06-22 + 06-29). CH4 offline replay can use the repo copies.
**resolution:** ✅ No drift. NOT a cron — systemd timer (so "snapshot cron" wording is loose; do not touch the timer per CH4 firewall).

### P8 — Test runners + `isbot`
**claim:** "expect vitest; detector test pattern (pytest? `python -m`?). `isbot` dep."
**reality:** TS: **vitest** (`"test": "vitest run"`). Detector: plain `python3` + `DRY_RUN_AUTOPILOT=1` (no pytest harness exists for it yet — CH4 must author its test). **`isbot` is NOT in `dependencies` nor `devDependencies`** (external first-use — CH3 adds it; verify published types).
**resolution:** ✅ As expected; `isbot` is a genuine new external dep (web-verify version + types at CH3 dispatch).

---

## Identifier diff (spec-cited identifier | live reality)

| spec identifier | live reality | class |
|---|---|---|
| `mcp_tools_list` ← `recordFunnelEvent` emit | ← `request_log WHERE tool_name='tools/list'` (=0 rows all-time) | 🛑 load-bearing |
| `install` = server-side HTTP connects | = **npm registry downloads** (api.npmjs.org); connects are `mcp_connect`=669 ≠ install=1113 | 🛑 load-bearing |
| "the tools/list **handler**" (emit attach point) | no custom handler (high-level `McpServer`); attach at `/mcp` POST layer (`req.body.method==='tools/list'`), beside `mcp_connect` emit @ [index.ts:2893](src/index.ts) | ⚠️ wording |
| `meta_json` is **jsonb** | `meta_json` is **text** (holds JSON; no migration needed) | ⚠️ minor |
| alert = install→mcp_tools_list 0% + tg_bot −100% (2 reasons) | sole condition-(b) reason = **tg_bot_start→tg_bot_first_command** (2/7→0/7); mcp_tools_list = body-only `weakest_stage_transition`; install→first_call never breached floor | ⚠️ narrative |
| host script behind `/var/log/algovault-funnel-leak-detector.log` | log file does NOT exist (journald); script = `/opt/algovault-monitoring/funnel-leak-detector.py` (repo md5-identical) | ⚠️ minor |
| detector condition (a) floor 0.20% (baseline 0.29%) | live install→first_call = 25.07% → gate is inert/dead | ⚠️ note |
| `resolveSessionCorrelationId` labels identity tier | returns bare string; needs new companion to expose token\|fallback\|anon | ✅ anticipated |
| every emit uses the shared resolver | already true (direct + ALS); only `mcp_tools_list` is uncaptured | ✅ confirmed |
| CANONICAL_STAGE_ORDER 14 / 13 retentions | ✅ exact | ✅ |
| `/api/admin/funnel-snapshot` admin-gated | ✅ exists [index.ts:1845](src/index.ts), 401 w/o key | ✅ |
| `funnel_events` cols id/event_type/ts/session_id/chat_id/license_tier/meta_json | ✅ all present | ✅ |

**Fictional/load-bearing-drift tally:** 2 load-bearing causal drifts (P1 read-source, P3 install-semantics) + 1 derived blocker (CH3 cannot UA/IP-clean npm) + 4 minor (meta_json type, handler wording, alert narrative, missing log file) + 1 dead gate. **≥3 → HALT before mutation** (also independently mandated by Plan-Mode risk-marker LAW: 5 chapters + cross-host + external first-use).

---

## Architect HALT — copy-paste Q-block for Mr.1 → Cowork

```
OPS-ACTIVATION-LEAK-FIX-W1 CH1 HALT — 3 architect decisions before CH2 mutation
(all evidence: audits/OPS-ACTIVATION-LEAK-FIX-W1-endpoint-truth.md, live origin/main 7b13f0c + Hetzner DB 2026-06-29)

Q1 [mcp_tools_list capture locus] The snapshot derives mcp_tools_list from request_log
   WHERE tool_name='tools/list' (funnel-snapshot.ts:284-296), and request_log has 0 such
   rows all-time because tools/list is SDK-handled and never calls logRequest. CH2's
   "emit recordFunnelEvent('mcp_tools_list')" alone will NOT move the snapshot. Pick the fix:
     (A) emit funnel_events('mcp_tools_list') at the /mcp POST layer (req.body.method==='tools/list',
         dedup per session via resolveSessionCorrelationId) AND redirect getMcpToolsListSessionCount()
         to read funnel_events (additive; keep request_log read as 0-fallback). [RECOMMENDED — isolated]
     (B) log tools/list into request_log at the POST layer (broader blast radius: also feeds
         tool_call_distribution/latency/analytics + is_bot_internal). 
   Confirm A, or choose B.

Q2 [denominator semantics — touches the byte-stable 14-stage contract] funnel.install is the
   npm-registry download count (1113), NOT server-side connects (mcp_connect=669). UA/IP bot
   classification (CH3) cannot clean npm downloads (npm serves them; our server sees no UA/IP).
   CH3 says "redefine ENTRY/install + ACTIVATION/first_call on a completed real action." Pick:
     (A) KEEP npm `install` + existing `first_call` byte-stable; ADD a NEW server-side, bot-cleaned
         denominator + activation rate ALONGSIDE (e.g. by_authenticity over mcp_connect→first-real-
         tool-call). No CANONICAL_STAGE_ORDER change. [RECOMMENDED — preserves history + spec firewall]
     (B) REDEFINE install/first_call onto the server-side bot-cleaned base (breaks install→first_call
         WoW history comparability; per spec this needs explicit sign-off as it changes stage semantics).
   Confirm A, or authorize B.

Q3 [scope of the bot-clean denominator] Given Q2, which server-side base should by_authenticity /
   the cleaned activation rate sit on?
     (A) mcp_connect sessions (672 all-time) → cleaned → first real tools/call. [RECOMMENDED]
     (B) the npm install figure (NOT cleanable server-side — informational only, leave raw).
   Also confirm: is the existing request_log.is_bot_internal column the canonical bot signal to
   reconcile against, or is the new classifyTraffic() meta_json tag authoritative + is_bot_internal
   left as-is? (avoid two drifting bot-derivations — single-derivation rule).

Non-blocking (fixing inline + flagging in status.md, no answer needed): meta_json is text not jsonb
(JSON-in-text, no migration); "tools/list handler" → /mcp POST-layer attach; detector condition-(a)
0.20% floor is dead vs live 25%; alert body's /var/log/...detector.log does not exist (journald);
today's sole real trigger was tg_bot_start→tg_bot_first_command (2/7→0/7), not install→mcp_tools_list.
```

---

## CH1 verification gate
`test -f audits/OPS-ACTIVATION-LEAK-FIX-W1-endpoint-truth.md && grep -q mcp_tools_list … && echo CH1_GREEN` → **CH1_GREEN** (probe complete). Mutation chapters CH2–CH5 **held** pending Q1–Q3.
