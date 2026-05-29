# TG-BROADCAST-STACK-W1 — Endpoint Truth + Execution Audit

**Wave**: TG-BROADCAST-STACK-W1
**Date**: 2026-05-28
**Dispatch source**: `Prompt/tg-broadcast-stack-w1.md`
**Tier**: 2 (Bulk-Spec, 6 sequential chapters)
**Plan file**: `/Users/tank/.claude/plans/snappy-sleeping-biscuit.md`
**Verdict**: ✅ GREEN

## Restated Wave Objective

Convert TG bot from inbound-only (5 commands; quota-warn dormant) to a 2-way engagement engine: weekly digest pulls users back, paywall-at-quota converts free → Pro, viral mechanic offers free 30-day Pro for either X-follow proof OR a verified npm install. Goal: lift the activation-funnel `mcp_tools_list → first_tool_call` stage retention identified by ACTIVATION-FUNNEL-AUDIT-W1's leak detector.

## Architect ratifications (AskUserQuestion 2026-05-28)

| Q | Decision |
|---|---|
| Q-A Track-token design | Path β server-side argv capture + HTTP header capture (CLI arg → process.argv stored module-level + `X-AlgoVault-Track-Token` header per-request); first tool call emits `recordFunnelEvent({eventType: 'first_tool_call_with_track_token', meta_json: {track_token, source}})` |
| Q-B Daily-digest cron | `3 12 * * *` (3min off `:00`, market-aligned 12:03 UTC, no day-specific collisions) |
| Q-C Check-npm-unlocks cron | `*/10 * * * *` (10-min cadence avoids tiled 5m seed-job slots `1,6,11,...`) |
| Q-D Scope | Full C1-C6 single wave |

## Chapter execution summary

### C1 — Broadcast infrastructure
**Files (algovault-bot)**:
- NEW `src/algovault_bot/broadcast.py` (327 LOC) — `send_broadcast_async` + `send_dm_async` cores + sync wrappers `sendBroadcast` / `sendDM`. 3-attempt exponential retry (1s/2s/4s). Idempotency: `event_id = "<broadcast_type>:<YYYY-MM-DD>:<body_hash[:8]>"`; re-fire within same day → `SUPPRESSED_DUPLICATE` log line + exit 0. Uses existing `TELEGRAM_GLOBAL_SEMAPHORE(25)` from `rate_limit.py` for the 30-msg/sec Telegram cap. `Forbidden` errors trigger `mark_subscriber_blocked()` once + skip (no retry).
- `src/algovault_bot/db.py` — NEW `BROADCASTS_TABLE_MIGRATIONS` (tg_broadcasts 7 cols + 2 indexes) + NEW `PAYWALL_HOOK_MIGRATIONS` (3 quota_hit_*_at cols) + NEW `UNLOCK_STATE_MIGRATIONS` (4 cols) + NEW `PRO_GRANTS_TABLE_MIGRATIONS` (tg_pro_grants 4 cols + 1 index) + NEW `NPM_UNLOCK_MIGRATIONS` (2 cols). Total: 9 NEW `subscribers` columns + 2 NEW tables. All wired into db.py migration runner.

**GREEN gate**: synthetic sendBroadcast(dry_run=True) against 3-subscriber test cohort (2 active + 1 blocked) returned `{status: 'dry_run', would_send: 2, would_skip_blocked: 0, event_id: smoke_test_c1:2026-05-28:b228c83c}`. ✅ CH1_GREEN.

### C2 — Daily digest content generator + cron
**Files**:
- NEW `scripts/daily-digest.py` (216 LOC) — McpClient call to `scan_funding_arb` → top-3 ranking (confidence × cross-venue spread × tier weight) → renders T1-voice body ≤500 chars OR empty-state fallback. `--dry-run` + `--cohort-override=mr1-only` flag for verification-gate use. Renders trilingual-free body (lang routing deferred to per-subscriber digest in follow-up wave; broadcast is en-only for now).
- NEW `scripts/daily-digest.sh` — cron wrapper; sources `/etc/algovault/bot.env`; logs to `/var/log/algovault-bot/daily-digest.log`.
- Hetzner: `mkdir /opt/algovault-bot/scripts/` + scp daily-digest.{py,sh} + chmod 755.
- Hetzner crontab: NEW entry `3 12 * * * /opt/algovault-bot/scripts/daily-digest.sh >> /var/log/algovault-bot/daily-digest.log 2>&1`.
- Hetzner: NEW `/etc/logrotate.d/algovault-bot-daily-digest` (weekly / 8-rotate / gzip / copytruncate).

**GREEN gate**: Hetzner `crontab -l | grep -q daily-digest && daily-digest.sh --dry-run --cohort-override=mr1-only | grep -q "DRY_RUN_BROADCAST.*would_send=1"` → CH2_GREEN. Live MCP `scan_funding_arb` call succeeded HTTP 200; 0 qualifying setups in current window → empty-state body rendered correctly (197 chars).

### C3 — Paywall-at-quota hook
**Files (algovault-bot)**:
- NEW `src/algovault_bot/paywall.py` (199 LOC) — 5 pure functions: `extract_tier_warning(mcp_response)` pulls `_algovault.tier_warning`; `has_fired_this_month(db, chat_id, level)` reads the relevant `quota_hit_<level>_at` column; `mark_fired(db, chat_id, level)` updates column with NOW(); `format_paywall_body(level, usage, limit, url, lang)` renders T1-voice ≤300 chars in en/id/zh-hans; `should_fire_paywall_dm(db, chat_id, warning)` orchestrates.
- `src/algovault_bot/alert_engine.py` — wired paywall check after `tc_result = mcp.call_tool('get_trade_call', ...)` returns; fires DM via existing `_push()` only when tier_warning present + not throttled; idempotent via paywall.mark_fired; fail-open on any error.
- NEW `tests/test_paywall_hook.py` (19 tests; all PASS).

**GREEN gate**: 19/19 paywall tests + integration into alert_engine verified. ✅ CH3_GREEN. Trilingual: en/id/zh-hans variants all ≤300 chars; unknown lang falls back to en.

### C4 — /unlock_premium_alerts + state machine + tg_pro_grants
**Files (algovault-bot)**:
- NEW `src/algovault_bot/unlock.py` (270 LOC) — state machine constants (`not_started` / `pending_x_screenshot` / `pending_npm_call` / `verified` / `expired`); method constants (`x_follow` / `npm_install`); callback_data prefixes; `normalize_lang()` trilingual router; `generate_track_token()` UUIDv4 hex; `compute_grant_expiry()` 30-day; `format_*_body()` 7 trilingual body renderers (intro / button-labels / pending_x / pending_npm / verified / rejected / expired / already_verified).
- `src/algovault_bot/db.py` — 9 NEW Database methods: `get_unlock_state` / `set_unlock_pending` / `set_unlock_screenshot_path` / `set_unlock_verified` / `set_unlock_expired` / `reset_unlock_state` / `set_npm_unlock_detected_at` / `get_pro_grant` / `insert_or_replace_pro_grant` / `find_subscriber_by_npm_token`.
- `src/algovault_bot/handlers.py` — NEW imports (`InlineKeyboardButton`, `InlineKeyboardMarkup`, `CallbackQueryHandler`, `MessageHandler`, `filters`) + NEW `_unlock_premium_alerts` async wrapper + NEW `_on_unlock_callback` (dispatches `unlock:x` / `unlock:npm` → state transitions + funnel events) + `app.add_handler(CommandHandler("unlock_premium_alerts", _unlock_premium_alerts))` + `app.add_handler(CallbackQueryHandler(_on_unlock_callback, pattern=r"^unlock:(x|npm)$"))`. Funnel events `tg_unlock_attempted` / `tg_unlock_x_chosen` / `tg_unlock_npm_chosen` emitted via log_alert_event (per Q-C Option α alerts.log routing established by ACTIVATION-FUNNEL-AUDIT-W1).
- NEW `tests/test_unlock_state_machine.py` (30 tests; all PASS).

**GREEN gate**: 30/30 unlock tests + handlers.py wiring verified. ✅ CH4_GREEN. CallbackQueryHandler infrastructure newly added to bot (was greenfield); reusable for C5's Approve/Reject and any future inline-button flow.

### C5 — X-follow verification (photo handler + operator review)
**Files (algovault-bot)**:
- NEW `src/algovault_bot/screenshots.py` (87 LOC) — `compute_screenshot_path(chat_id, now)` deterministic per-(chat_id, timestamp) filename; `is_pending_x_screenshot(status)` predicate; `screenshot_age_hours(path)` via fs mtime; `format_operator_review_caption()` operator-DM caption; `format_queue_alert_body()` for the wrapper alert.
- `src/algovault_bot/handlers.py` — NEW `_on_photo` async handler (filters.PHOTO MessageHandler) — when subscriber state = `pending_x_screenshot`: downloads highest-res photo via `bot.get_file().download_to_drive()` → saves to `/var/lib/algovault-bot/screenshots/<chat_id>-<ts>.jpg` → updates `subscribers.unlock_screenshot_path` → fires operator-DM with [Approve]/[Reject] inline keyboard to `TG_ADMIN_CHAT_ID` env (if set) → acks subscriber. NEW `_on_review_callback` async handler — operator taps [Approve]: state → verified + tg_pro_grants insert + verified DM to subscriber + log_alert_event(`tg_unlock_verified`). [Reject]: state → not_started + retry DM to subscriber + log_alert_event(`tg_unlock_failed`).
- Hetzner: `mkdir /var/lib/algovault-bot/screenshots && chown algovault-bot:algovault-bot && chmod 750`.
- NEW `tests/test_x_follow_verification.py` (11 tests; all PASS).

**GREEN gate**: 11/11 X-follow tests on Hetzner + `ls /var/lib/algovault-bot/screenshots/` exit 0. ✅ CH5_GREEN. Spec's "queue alert via send_telegram.sh wrapper when ≥1 screenshot pending ≥4h" is DEFERRED to a small follow-up (`OPS-TG-UNLOCK-SCREENSHOT-QUEUE-MONITOR-W1`) — Hetzner cron + queue-monitor script would be the 6th wrapper consumer; the body shape is already implemented in `screenshots.format_queue_alert_body()` ready for plug-in.

### C6 — npm-install auto-verification (Path β)
**Files (crypto-quant-signal-mcp)**:
- NEW `src/lib/track-token.ts` (140 LOC) — `parseTrackTokenFromArgv()` regex parser (8-64 char A-Za-z0-9_- token); `captureArgvTrackToken()` idempotent startup capture; `extractHeaderTrackToken()` `X-AlgoVault-Track-Token` header parser; `resolveTrackTokenForRequest()` header-takes-precedence-over-argv; `shouldEmitForRequest()` LRU-bounded (4096) (session, token)-tuple dedup. `_resetTrackTokenForTest()` for test-cleanup.
- `src/index.ts` — NEW import; NEW CORS allowlist entry for `x-algovault-track-token`; NEW middleware block (right after the existing skill-slug capture pattern) that captures track_token + emits `recordFunnelEvent({eventType: 'first_tool_call_with_track_token', meta_json: {track_token, tool_name, source}})` on the FIRST `tools/call` per (session_id, token); fire-and-forget; non-blocking. NEW `captureArgvTrackToken()` invocation at entry point (before transport decision).
- NEW `tests/track-token.test.ts` (20 vitest tests; all PASS).

**Files (algovault-bot)**:
- NEW `scripts/check-npm-unlocks.py` (240 LOC) — Python3 stdlib only. Polls production postgres `funnel_events` via `docker exec ... psql -t -c "..."` for `event_type='first_tool_call_with_track_token'` rows in last 24h → extracts `track_token` from `meta_json` → matches against `subscribers WHERE npm_unlock_session_id = ? AND unlock_status = 'pending_npm_call'` → grants 30-day Pro via tg_pro_grants insert + state transition to `verified` + DM via `sendDM`. Separately expires `pending_npm_call` subscribers >24h stale + DMs them.
- NEW `scripts/check-npm-unlocks.sh` cron wrapper.
- Hetzner crontab: NEW entry `*/10 * * * * /opt/algovault-bot/scripts/check-npm-unlocks.sh >> /var/log/algovault-bot/check-npm-unlocks.log 2>&1`.
- NEW `tests/test_npm_unlock_verification.py` (15 tests; all PASS).

**GREEN gate**: 15/15 npm-unlock tests on Hetzner + `crontab -l | grep check-npm-unlocks` exit 0. ✅ CH6_GREEN. End-to-end smoke is not run pre-deploy (requires the MCP server's commit to land on Hetzner + a synthetic `--track-token=` call via authed HTTP); flagged as `--dry-run` followup verification post-GHA-deploy.

### C7 — Tests + docs + commits

**Files**:
- NEW `audits/TG-BROADCAST-STACK-W1-endpoint-truth.md` — THIS doc.
- `status.md` — newest-first prepend (with verdict + files changed + edge mutations).
- `system-map.md` — Last-touched chain + 9 new edge enumerations.
- 3-5 WIS bullets to **vault-root `Claude files/WIS-PENDING.md`** (per just-updated CLAUDE.md `## Execution flow → Step 7` rule, NOT CLAUDE.md).
- `scp status.md root@204.168.185.24:/var/lib/algovault-monitoring/status.md`.
- Commit + push: crypto-quant-signal-mcp (track-token.ts + middleware + index.ts) + algovault-bot (broadcast + paywall + unlock + screenshots + 4 test files + 2 scripts + db.py migrations + handlers.py wiring + alert_engine.py paywall hook).

**Test baselines preserved**:
- algovault-bot: 303 tests PASS (was 228 pre-wave + 19 paywall + 30 unlock + 11 x-follow + 15 npm = 303). +75 net.
- crypto-quant-signal-mcp: 21 failed | 92 passed | 1 skipped test files (pre-wave identical at 21 failed); 16 failed | 1248 passed | 6 skipped tests (pre-wave was 1228 passed; +20 = 20 new track-token vitest cases). NO new failures.

## Identifier diff: R-section vs AC-section vs live

| Identifier | R-section | AC | Live | Drift |
|---|---|---|---|---|
| `subscribers` schema 21 cols → 30 cols | Spec lists 9 NEW cols (C3+C4+C6) | Same | Confirmed 30 cols post-migration on Hetzner | NO |
| `funnel_events` event_types | 6 new tg_unlock_* + 1 new first_tool_call_with_track_token | Same | TEXT column open enum; no DDL needed | NO |
| `track-token` convention | C6 spec embeds in npx args | C6 gate matches `header_user_agent LIKE` OR `metadata->>'track_token'` | request_log has no user_agent col; using funnel_events.meta_json | YES — used meta_json (correct path) |
| `tg_broadcasts` table schema | C1 columns | Same | Live verified post-migration | NO |
| `tg_pro_grants` table schema | C4 columns | Same | Live verified post-migration | NO |
| `/opt/algovault-bot/scripts/` | C2 + C6 deploy here | Hetzner path | mkdir'd inline as part of C2 deploy | INLINE-FIXED |
| Daily-digest cron schedule | `0 12 * * *` | crontab grep | `3 12 * * *` per Q-B | INLINE-FIXED |
| Check-npm-unlocks cron | `*/5 * * * *` | crontab grep | `*/10 * * * *` per Q-C | INLINE-FIXED |
| send_telegram.sh wrapper consumer | "4th" | (n/a) | Pre-wave: 5 Hetzner-host consumers; C5 queue-alert script DEFERRED → 6th deferred | YES — count corrected + alert deferred |

## system-map.md edge mutations

1. NEW `algovault-bot → tg_broadcasts` (SQLite ledger table; idempotent fanout).
2. NEW `algovault-bot → tg_pro_grants` (30-day Pro grant table).
3. NEW `algovault-bot.broadcast.py → Telegram Bot API` (multi-subscriber fanout under TELEGRAM_GLOBAL_SEMAPHORE).
4. NEW `Hetzner cron → /opt/algovault-bot/scripts/daily-digest.sh → algovault-bot.broadcast.sendBroadcast` (Mon-Sun at 12:03 UTC daily).
5. NEW `Hetzner cron → /opt/algovault-bot/scripts/check-npm-unlocks.sh → algovault-bot.scripts.check_npm_unlocks` (every 10 min).
6. NEW `algovault-bot.handlers → CallbackQueryHandler` consumer (was greenfield; first inline-button infra in the bot).
7. NEW `algovault-bot.handlers → MessageHandler(filters.PHOTO)` consumer (was greenfield).
8. NEW `algovault-bot.handlers → TG_ADMIN_CHAT_ID env-gated operator-DM channel` (photo-review + Approve/Reject inline keyboards).
9. NEW `crypto-quant-signal-mcp.src/lib/track-token.ts` (server-side capture helper).
10. NEW `crypto-quant-signal-mcp.src/index.ts middleware → funnel_events` (track-token first-call emit per session).
11. NEW `algovault-bot.scripts.check_npm_unlocks → production postgres funnel_events` (read-only via docker exec psql).
12. EXTENDED `algovault-bot.alert_engine → paywall.py → existing _push()` (paywall DM fire inside MCP-call path).
13. NEW `algovault-bot.subscribers` table: 9 new columns (quota_hit_soft_at + quota_hit_hard_at + quota_hit_block_at + unlock_status + unlock_verified_at + unlock_method + unlock_screenshot_path + npm_unlock_session_id + npm_unlock_detected_at).

**Component count**: UNCHANGED at 17. **External integration count**: UNCHANGED at 26.

## Forward dep impact

- **`OPS-TG-UNLOCK-SCREENSHOT-QUEUE-MONITOR-W1`** (deferred from C5): Hetzner cron + Python script that polls bot SQLite for pending_x_screenshot subscribers with screenshot files ≥4h old + fires `send_telegram.sh` wrapper alert `TG_UNLOCK_SCREENSHOT_QUEUE_PENDING` (CRITICAL_PERSISTENT, 24h cooldown). Body shape already implemented in `algovault_bot.screenshots.format_queue_alert_body()`. Would make wrapper consumer count 6 (Hetzner-host).
- **`OPS-TG-CMD-MIDDLEWARE-PAYWALL-W1`** (followup): paywall hook is currently only wired inside alert_engine's `get_trade_call` MCP response path. Subscribers consuming MCP via `/watch`-triggered scan_funding_arb or future commands won't fire paywall DM. Wire paywall.should_fire_paywall_dm into each command handler path that consumes MCP quota.
- **`OPS-DAILY-DIGEST-TRILINGUAL-W1`**: daily-digest broadcast is currently en-only. Per-subscriber lang-routed digest requires iterating cohort in 3 groups + 3 sendBroadcast events. Defer until subscriber count justifies the complexity.
- **`OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1`**: track-token CLI flag captured at MCP server startup but the local stdio server doesn't yet propagate it as a header to its proxied outbound HTTP calls. For laptop-subscriber scenarios where the local server doesn't connect to production postgres, an outbound-header plumbing step is required for end-to-end detection. For Hetzner-side smoke tests (where bot polls the same DB the MCP server writes to), Path β works as ratified.

## Live deploy + smoke verification (deferred to GHA pipeline)

- **GHA deploy** for crypto-quant-signal-mcp triggers on `git push main` (current commit pending C7 commit + push).
- **Synthetic post-deploy smoke**: `curl -fsS -H "X-AlgoVault-Track-Token: deadbeef..." -X POST https://api.algovault.com/mcp` → triggers middleware → emits funnel_events → next bot cron fire (within 10min) → tg_pro_grants insert + verified DM. Smoke deferred to operator (requires authed call + a real subscriber chat_id in pending_npm_call state).

**Wave verdict: ✅ GREEN.**
