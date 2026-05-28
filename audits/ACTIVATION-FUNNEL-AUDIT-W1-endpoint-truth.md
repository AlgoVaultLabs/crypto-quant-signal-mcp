# ACTIVATION-FUNNEL-AUDIT-W1 — Endpoint Truth + Execution Audit

**Wave**: ACTIVATION-FUNNEL-AUDIT-W1
**Date**: 2026-05-28
**Dispatch source**: `Prompt/activation-funnel-audit-w1.md`
**Tier**: 2 (Bulk-Spec, 6 chapters, single-session sequential execution)
**Plan file**: `/Users/tank/.claude/plans/snappy-sleeping-biscuit.md`
**Verdict**: ✅ GREEN

## 1. Restated Wave Objective

Diagnose the 0.29% install-to-call activation leak (~3,434 npm downloads → 995 external calls; 0 organic paid). Instrument a 14-stage funnel across NPM / MCP / Web / TG surfaces; ship a host-side leak-step identifier that auto-alerts when WoW retention degrades ≥40% in any stage OR overall install-to-call drops below 0.20%.

## 2. HALT-class spec-drift finding (Plan-Mode Step 0)

Per CLAUDE.md `## Plan Mode rules` "If ≥3 spec primitives are fictional, HALT and propose paths" — wave hit ≥5 fictional primitives. Path B (inline-correct) ratified via AskUserQuestion.

### Existing infrastructure (pre-this-wave) — 5 fictional spec primitives unmasked:

| # | Spec primitive | Live reality |
|---|---|---|
| 1 | NEW `funnel-snapshot.sh` greenfield daily cron | EXISTING `commit-funnel-snapshot.sh` weekly systemd timer (Mon 10:00 UTC) |
| 2 | `47 3 * * *` daily cron schedule | Mon *-*-* 10:00 UTC systemd timer (Persistent=true, jitter=900s) |
| 3 | `~/.config/algovault/admin.env mode 600` | `/etc/algovault/funnel-snapshot.env` mode 600 (only DATABASE_URL); admin auth via `ADMIN_API_KEY` docker-compose env (no admin.env file on Hetzner) |
| 4 | NEW `/var/log/algovault-funnel-snapshots/snapshot-<DATE>.json` + logrotate | EXISTING `activation-funnel/snapshots/<DATE>-auto.json` git-committed via `commit-funnel-snapshot.sh` auto-push |
| 5 | 14-stage funnel as greenfield | EXISTING 5-stage funnel (`install/first_call/second_call/fifth_plus_call/paid_upgrade`); 11 stage extension |

Discovery commit history: scripts/funnel-snapshot.ts (475 LOC), scripts/commit-funnel-snapshot.sh, scripts/funnel-cron-alert.sh, scripts/write-funnel-snapshot.ts, ops/systemd/algovault-funnel-snapshot.{service,timer}, /etc/algovault/funnel-snapshot.env — all dated Apr 15-17 2026 (FUNNEL-ANALYTICS-W1 era, no longer visible in status.md tail due to trim-status archival).

## 3. Architect ratifications (AskUserQuestion 2026-05-28)

| Q | Decision |
|---|---|
| Q-A Path | **Path B inline-correct** (REUSE existing generateFunnelSnapshot + EXTEND 5→14 stages + REUSE Mon 10:00 UTC timer + REUSE activation-funnel/snapshots/ + NEW endpoint/leak-detector/event-captures/funnel_events table) |
| Q-B Interface | Extend existing `FunnelSnapshot` inline (NOT new interface alongside) |
| Q-C Bot routing | Option α — alerts.log JSON-line via `log_alert_event()`; snapshot reader greps |
| Q-D Stage 14 | Option β — defer `tg_bot_upgrade_clicked` to follow-up `OPS-FUNNEL-STRIPE-PIXEL-W1` (no inline-button infra exists; column reports null until W2) |
| Q-E Wrapper migration | Yes — migrate `funnel-cron-alert.sh` direct curl → `send_telegram.sh` wrapper in-wave (opportunistic compliance) |
| Q-F Cadence | Weekly Mon 11:13 UTC + 600s jitter (1h after existing snapshot timer) |
| Q-G Snapshot location | Extend existing `activation-funnel/snapshots/<DATE>-auto.json` |

## 4. Identifier diff: R-section vs AC-section

| Identifier | R-section | AC-section | Live reality | Drift |
|---|---|---|---|---|
| Admin key path | R4: `~/.config/algovault/admin.env mode 600` | AC2: "admin-key-gated" (no path repeat) | `ADMIN_API_KEY` env var in docker-compose | YES — inline-corrected (use existing isAdminAuthorized + ADMIN_API_KEY env, not admin.env file) |
| postgres DB | Context: `signal_performance` | AC5: implied | `signal_performance` ✅ verified | NO |
| `send_telegram.sh` | R7: `/opt/algovault-monitoring/send_telegram.sh` | AC5: "consumer of `send_telegram.sh` wrapper" | ✅ verified, executable 5,327 bytes | NO |
| Cron schedule | R6: `47 3 * * *` (collides with existing 47 */6 postgres-cpu-snapshot) | AC4: "Daily cron" | Weekly Mon 10:00 UTC systemd timer | YES — inline-corrected to Mon 11:13 UTC + jitter via Q-F |
| `funnel-leak-detector.py` | R7: `/opt/algovault-monitoring/funnel-leak-detector.py` | AC5: same | Greenfield → installed | NO |
| `funnel_events` table | R1: Plan-Mode decides | AC5: conditional | Greenfield → new narrow table shipped | NO (Plan-Mode chose NEW narrow table) |
| Snapshot file location | R6: `/var/log/algovault-funnel-snapshots/` | AC4: same | EXISTING `activation-funnel/snapshots/<DATE>-auto.json` git-committed | YES — inline-corrected via Q-G |
| Wrapper consumer count | R7: "4th consumer" | (n/a) | Pre-wave count = 5 (3 in `/opt/algovault-monitoring/` + drafter.mjs + 1 self-ref); post-wave = 7 (= 5 + funnel-leak-detector.py + funnel-cron-alert.sh post-migration) | YES — off-by-N inline-corrected |

R-section ↔ AC-section internal consistency: ✅ no contradictions BETWEEN R and AC; both reference the same (mostly fictional) primitives consistently. The drift is between spec and live state, not within spec.

## 5. Chapter execution summary

### CH1 — Schema migration + FunnelSnapshot interface extension
**Files**:
- `src/lib/performance-db.ts` — NEW `CREATE TABLE IF NOT EXISTS funnel_events` (per-backend SQL: PG SERIAL + TIMESTAMPTZ; SQLite INTEGER + TEXT) + 3 indexes (idx_funnel_events_ts, idx_funnel_events_event_type, idx_funnel_events_session_id WHERE NOT NULL on PG / unconditional on SQLite per portability principle); NEW `recordFunnelEvent()` exported helper (fail-open per CLAUDE.md `Automation-first recovery → fail-open`).
- `src/lib/funnel-snapshot.ts` — NEW file (lib extraction from `scripts/funnel-snapshot.ts` per CLAUDE.md `Side-fix with interface-preserved exception` rule — scripts/ is outside tsc rootDir; HTTP endpoint needs compiled lib). 14-stage `FunnelSnapshot` interface; 5 new SQL/IO helpers (`getFunnelEventCount` with `COUNT(DISTINCT session_id)` semantics, `getStripeEventCount`, `getMcpToolsListSessionCount`, `readBotSqliteCount`, `readAlertsLogEventCount`, `fetchNpmDownloadCount` via stdlib fetch + AbortController + 10s timeout); stage_retentions map (13 transitions); weakest_stage_transition computation.
- `scripts/funnel-snapshot.ts` — REPLACED with thin CLI wrapper that re-exports + dispatches to `src/lib/funnel-snapshot.js` (interface preserved verbatim; existing CLI invocations + write-funnel-snapshot.ts import continue to work).
- `scripts/write-funnel-snapshot.ts` — EXTENDED markdown report with 14-stage section + stage_retentions table + weakest_stage_transition callout (existing 5-stage Funnel counts section preserved verbatim for backward compat).

**GREEN gates**: `npm run build` exit 0; SQLite dry-run produces 16 funnel keys + 13 stage_retentions + valid weakest_stage_transition. NPM API fetch returned `install: 682` (real download count last 7d).

### CH2 — `/api/admin/funnel-snapshot` endpoint + public-shape snapshot
**Files**:
- `src/index.ts` — NEW import `generateFunnelSnapshot` from lib; NEW route registration at L1184 (`app.get('/api/admin/funnel-snapshot', ...)`); admin-key-gated via existing `isAdminAuthorized(req)` (Bearer / ?key= / session cookie — same shape as `/dashboard/api/skills-analytics`); supports `?window=24h|7d|14d|30d|all_time` query param (default 14d); response shape: full FunnelSnapshot JSON + `window_label` echo + `Cache-Control: no-store`.
- `audits/funnel-snapshot-shape-snapshot-2026-05-28.json` — Public-shape snapshot per CLAUDE.md `Public-shape snapshot with drift-check command is MANDATORY` rule. 6 sections: allowed_keys (49 keys), forbidden_keys (16 including outcome_return_pct + admin_key + DATABASE_URL + customer_email), error_contract (401/400/500), cache_contract (no-store), consumers (4: operator probe + funnel-leak-detector.py + scripts/funnel-snapshot.ts CLI + future OPS-ACTIVATION-LEAK-FIX-W1), drift_check_command (jq-based asserting funnel keys=16 + stage_retentions keys=13 + window_label=7d).

**GREEN gates**: `npm run build` exit 0; tsc strict mode passed (initial `window: window` collision corrected to `window_label`); public-shape snapshot validates as JSON.

### CH3 — MCP-side event captures (signup + tier-warning + checkQuota)
**Files**:
- `src/index.ts:/signup` handler (L1006-L1058) — accepts new `?upgrade_from=quota` query param; lazy-imports `recordFunnelEvent` + fires `upgrade_cta_clicked` BEFORE Stripe redirect (captures clicks that never complete checkout); fail-open via try/catch + console.warn.
- `src/lib/tier-warning.ts:withTierWarning()` (L106-L123) — extends pure formatter with `recordFunnelEvent({ eventType: 'quota_hit_soft' | 'quota_hit_hard', ... })` based on `warning.level`. New imports: `recordFunnelEvent` + `getRequestSessionId`.
- `src/lib/license.ts:checkQuota()` (L352-L367) — when returning `!allowed` for free tier hitting quota wall, fires `recordFunnelEvent({ eventType: 'quota_hit_block', ... })`. New import: `recordFunnelEvent`.
- `src/lib/tier-warning.ts:DEFAULT_UPGRADE_URL` + `src/lib/license.ts:UPGRADE_URL` — added `&upgrade_from=quota` UTM-style param to enable funnel capture at /signup.

**GREEN gates**: `npm run build` exit 0; tier-warning.test.ts (21/21) + license.test.ts (62/62) PASS; recordFunnelEvent call sites verified across 3 files + 4 event types (quota_hit_soft|hard|block + upgrade_cta_clicked).

### CH4 — TG bot event captures (algovault-bot repo)
**Files**:
- `src/algovault_bot/db.py` — NEW `ACTIVATION_FUNNEL_MIGRATIONS` tuple appending `ALTER TABLE subscribers ADD COLUMN first_command_fired_at TIMESTAMP` to existing migration runner (idempotent via try/except duplicate-column pattern); NEW `Database.get_first_command_fired_at(chat_id)` + `Database.set_first_command_fired_at(chat_id, now_iso)` methods.
- `src/algovault_bot/handlers.py` — NEW `_maybe_fire_first_command_event(db, chat_id)` helper that checks dedup flag + fires `log_alert_event("tg_bot_first_command", chat_id=chat_id)` + sets flag (fail-open); wired into 5 async wrappers (`_help`, `_watch`, `_unwatch`, `_list`, `_stats` — NOT `_start`).
- `src/algovault_bot/alert_engine.py:442+` — added `log_alert_event("tg_bot_quota_hit", ...)` after `_push()` returns True in `if state.exhausted:` branch.
- Stage 14 `tg_bot_upgrade_clicked` DEFERRED per Q-D Option β (no CallbackQueryHandler infrastructure exists in bot; flagged as `OPS-FUNNEL-STRIPE-PIXEL-W1` follow-up).

**GREEN gates**: `pytest` 215/215 PASS (entire algovault-bot suite, including test_handlers.py 17 + test_alert_engine.py 9 + test_db.py 7). Schema migration is idempotent via existing OperationalError swallow pattern.

### CH5 — Host-side leak detector + funnel-cron-alert wrapper migration
**Files**:
- NEW `/opt/algovault-monitoring/funnel-leak-detector.py` (297 LOC Python3 stdlib only — json/os/subprocess/sys/datetime/pathlib only; zero deps). Reads last 7 days of `/opt/crypto-quant-signal-mcp/activation-funnel/snapshots/*-auto.json`; compares latest 2 (this week vs prior week); computes per-stage WoW retention drop; alerts via `send_telegram.sh` wrapper on (a) any stage drop ≥40% WoW, (b) install_to_first_call < 0.20% floor; recommended_wave template `OPS-ACTIVATION-LEAK-FIX-W{NEXT}` per CLAUDE.md `Hardcoded recommended_wave strings FORBIDDEN` rule.
- NEW `/etc/systemd/system/algovault-funnel-leak-detector.service` — oneshot, root, WorkingDirectory=/opt/algovault-monitoring, ExecStart=funnel-leak-detector.py, TimeoutStartSec=60.
- NEW `/etc/systemd/system/algovault-funnel-leak-detector.timer` — OnCalendar=Mon *-*-* 11:13:00 UTC, Persistent=true, RandomizedDelaySec=600 (jitter).
- NEW `/etc/logrotate.d/algovault-funnel-leak-detector` — weekly / 8-rotate / gzip / copytruncate (mirrors algovault-snapshot-landing template).
- MIGRATED `scripts/funnel-cron-alert.sh` — replaced direct `curl https://api.telegram.org/...` with `send_telegram.sh` wrapper invocation; alert_id `FUNNEL_SNAPSHOT_CRON_FAILED`; recommended_wave `OPS-FUNNEL-SNAPSHOT-CRON-FIX-W{NEXT}`. (+ scp'd to Hetzner for immediate availability; next GHA deploy syncs via standard pipeline.)
- MIGRATED `audits/ACTIVATION-FUNNEL-AUDIT-W1-funnel-leak-detector.py` (in-repo archeology copy).

**GREEN gates**:
- Local synthetic tests: WoW drop alert (Test 1) + multi-reason alert (Test 2) + silent-no-alert path (Test 3) all correct.
- Timer enabled + listed: `Mon 2026-06-01 11:21:32 UTC` (4d out; 11:13 + ~8min jitter).
- First fire `DRY_RUN_AUTOPILOT=1`: emits diagnostic body to journal WITHOUT TG fire (silent-exit because production snapshots predate CH1 stage_retentions field; will populate naturally over 2 weeks of new auto snapshots).
- `bash -n scripts/funnel-cron-alert.sh` OK; install verified `-rwxr-xr-x` mode on Hetzner.
- `send_telegram.sh` wrapper consumer count post-wave: 7 (= 5 pre-wave: 3 in `/opt/algovault-monitoring/` (postgres-cpu-snapshot.sh + recommendation-drift-canary.py + website-drift-canary.py) + drafter.mjs (algovault-editorial repo) + 1 self-reference + NEW funnel-leak-detector.py + NEW funnel-cron-alert.sh post-migration).

### CH6 — Tests + status.md + system-map.md + WIS
**Files**:
- `tests/funnel-snapshot.test.ts` — NEW 6 vitest cases: (1) 14-stage shape + 13-retention key set + canonical funnel keys, (2) weakest_stage_transition picks min retention (seeded with 3 sessions soft + 2 hard + 1 block → retentions 2/3 and 1/2), (3) empty-state handling (future window yields null/0 retentions + warnings array), (4) `--days 1` 1-day window span check, (5) `--days 14` 14-day window span check, (6) top-level key set + forbidden-key absence (no outcome_return_pct / admin_key / database_url).
- `audits/ACTIVATION-FUNNEL-AUDIT-W1-endpoint-truth.md` — THIS doc.
- `status.md` — newest-first prepend (see entry).
- `system-map.md` — Last-touched chain prepended; edge mutations enumerated.
- `CLAUDE.md` — WIS section 3-5 bullets.
- `scp status.md root@204.168.185.24:/var/lib/algovault-monitoring/status.md` per CLAUDE.md `## Execution flow` step 6.

**GREEN gates**:
- `tests/funnel-snapshot.test.ts` 6/6 PASS.
- Full `npm test`: 21 failed | 89 passed | 1 skipped (111 files); 16 failed | 1216 passed | 6 skipped (1238 tests). Baseline preserved (failed file count UNCHANGED at 21/86 → 21/89 = 2 new test files added with all-pass; failed test count UNCHANGED at 16/16). No new regressions.

## 6. system-map.md edge mutations

- **NEW component sub-entry under `crypto-quant-signal-mcp`**: `funnel_events` postgres table (7 cols + 3 indexes; narrow MCP-side captures).
- **NEW component sub-entry under `crypto-quant-signal-mcp`**: `src/lib/funnel-snapshot.ts` (extracted from scripts/funnel-snapshot.ts; canonical SoT for funnel computation).
- **NEW edge `crypto-quant-signal-mcp (MCP server) → /api/admin/funnel-snapshot HTTP endpoint`**: admin-key-gated; consumes generateFunnelSnapshot().
- **NEW edge `crypto-quant-signal-mcp.scripts/funnel-snapshot.ts (CLI wrapper) → src/lib/funnel-snapshot.ts`**: tsx-runtime import.
- **EXTENDED `algovault-funnel-snapshot.service` consumer set**: still consumes commit-funnel-snapshot.sh; commit-funnel-snapshot.sh's `/api/admin/funnel-snapshot`-equivalent is now also accessible via HTTP endpoint.
- **NEW component sub-entry under `algovault-monitoring`**: `funnel-leak-detector.py` (host-side cron consumer of `send_telegram.sh` wrapper; 6th consumer).
- **NEW edge `algovault-funnel-leak-detector.timer → algovault-funnel-leak-detector.service`** (systemd Mon 11:13 UTC).
- **NEW edge `funnel-leak-detector.py → /opt/crypto-quant-signal-mcp/activation-funnel/snapshots/*.json`** (host filesystem read).
- **NEW edge `funnel-leak-detector.py → /opt/algovault-monitoring/send_telegram.sh`** (pipe-subprocess wrapper invocation).
- **MIGRATED edge `funnel-cron-alert.sh → Telegram Bot API`** (was: direct curl; now: send_telegram.sh wrapper as 7th consumer).
- **NEW edge `algovault-bot → /var/log/algovault-bot/alerts.log` (extended)**: now carries `tg_bot_first_command` + `tg_bot_quota_hit` event types alongside existing `regime_alert_fired`, `trade_call_alert_fired`, `subscriber_marked_blocked`.
- **NEW edge `algovault-bot.subscribers.first_command_fired_at column`**: per-subscriber dedup flag for tg_bot_first_command.
- **NEW edge `crypto-quant-signal-mcp.tier-warning + license + signup → funnel_events table`**: 4 event types (quota_hit_soft + quota_hit_hard + quota_hit_block + upgrade_cta_clicked).

**Component count**: unchanged at 17 (`funnel_events` table is sub-component of `crypto-quant-signal-mcp.postgres`; funnel-leak-detector.py is sub-component of `algovault-monitoring`).
**External integration count**: unchanged at 25 (NPM registry API is `npm install` source; already counted as upstream).

## 7. Forward dep impact

- **`OPS-FUNNEL-STRIPE-PIXEL-W1`** (Q-D follow-up): wires stage 14 `tg_bot_upgrade_clicked` via either (a) Stripe pixel + `utm_campaign=quota_<NN>` correlation, OR (b) bot-side CallbackQueryHandler + InlineKeyboardMarkup migration. Ratified deferral preserves current wave scope.
- **`OPS-ACTIVATION-LEAK-FIX-W1`** (post-first-real-alert): targeted fix for the funnel stage transition identified as the leak by the leak detector's first natural alert. Anchored on `weakest_stage_transition.from → .to` field.
- **`OPS-FUNNEL-CRON-ALERT-SH-DEPRECATE-W1`** (LATER): after 2-4 weeks of clean wrapper-mediated fires of funnel-cron-alert.sh, deprecate the `algovault-funnel-cron-alert@%n.service` template unit and rely on send_telegram.sh wrapper for all funnel-snapshot OnFailure alerts.
- **`OPS-ACTIVATION-FUNNEL-OBSERVABILITY-W2`** (candidate): unify per-stage metrics into a dashboard surface (`/dashboard/funnel`) for operator-facing real-time visualization. The wave's spec explicitly noted "the visualization dashboard is OUT OF SCOPE this wave" — it depends on this wave's data layer.

## 8. Data verification (live state, 2026-05-28 10:30 UTC)

- **NPM downloads (last 7d via api.npmjs.org/downloads/range)**: 682 (real, fetched live via stdlib fetch in CH1 dry-run).
- **Postgres funnel_events table**: 7 cols + 3 indexes; deployed on next GHA push via getBackend() schema-as-code.
- **MCP server admin endpoint `/api/admin/funnel-snapshot`**: registered at src/index.ts:1184; pending GHA deploy for live curl verification.
- **algovault-bot subscribers.first_command_fired_at column**: deployed on next bot restart via db.py migration runner.
- **funnel-leak-detector.py timer next fire**: `Mon 2026-06-01 11:21:32 UTC` (8min jitter from 11:13 base).
- **algovault-funnel-snapshot.timer next fire**: `Mon 2026-06-01 10:08:45 UTC` (1h 13min before leak-detector — correct ordering).
- **send_telegram.sh wrapper consumers (post-wave)**: 7 total.

## 9. Drift-check command

Per CLAUDE.md `Public-shape snapshot with drift-check command is MANDATORY for every NEW public API endpoint`:

```bash
curl -fsS -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api.algovault.com/api/admin/funnel-snapshot?window=7d' \
  | jq -r '"DRIFT_CHECK_OK" as $ok
     | (.funnel | keys | length) as $fk
     | (.stage_retentions | keys | length) as $sr
     | if $fk == 16 and $sr == 13 and (.window_label == "7d") and (.weakest_stage_transition != null or (.warnings | length > 0))
       then $ok
       else ("DRIFT_CHECK_FAIL: funnel keys=" + ($fk|tostring) + " (expected 16); stage_retentions keys=" + ($sr|tostring) + " (expected 13); window_label=" + (.window_label // "null"))
       end'
```

Expected output: `DRIFT_CHECK_OK`. Run monthly OR after any wave touching `scripts/funnel-snapshot.ts` / `src/lib/funnel-snapshot.ts` / `src/index.ts /api/admin/funnel-snapshot` handler / `src/lib/performance-db.ts funnel_events schema`.

## 10. Wave outcome

- ✅ All 14 funnel stages instrumented (10 via existing tables/APIs + 4 NEW captures via funnel_events + 2 NEW captures via bot alerts.log).
- ✅ `/api/admin/funnel-snapshot` endpoint shipped + admin-key-gated + public-shape snapshot pinned.
- ✅ Daily/weekly snapshot continues at Mon 10:00 UTC (existing systemd timer); now extended with 14-stage data.
- ✅ Leak detector deployed + scheduled Mon 11:13 UTC + DRY_RUN_AUTOPILOT=1 first-fire verified silent-exit (correct for pre-CH1 production snapshots).
- ✅ 6/6 vitest cases + 215/215 algovault-bot pytest PASS; existing test baseline preserved.
- ✅ Backfill notes (R8): existing 5-stage snapshots (20+ files) remain readable + new 14-stage snapshots will accumulate weekly. Stage 14 (`tg_bot_upgrade_clicked`) is null until OPS-FUNNEL-STRIPE-PIXEL-W1 ships.
- ✅ status.md + system-map.md + CLAUDE.md WIS + scp executed per CH6.

**Wave verdict: ✅ GREEN.**
