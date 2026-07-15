#!/usr/bin/env bash
# ops/cron/analytics-drift-canary.sh — OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 CH4 (2026-07-15)
#
# Next consumer of /opt/algovault-monitoring/send_telegram.sh (confirm the live consumer ordinal
# at host-install; do NOT hardcode a number). Belt-and-suspenders guard on the analytics single-
# derivation invariant: every content landing page's <!-- ANALYTICS:START/END --> region MUST
# byte-match the ONE SoT (dist/lib/analytics-snippet.js renderAnalyticsSnippet()), and no content
# page may be missing the markers (TOTAL coverage — architect Q1(c)).
#
# The PRIMARY gate is CI: `build_analytics.mjs --check` runs in deploy.yml + prepublishOnly, so any
# drift entering via a git push is blocked BEFORE it deploys. This weekly cron only catches the
# marginal RUNTIME path CI can't see — a host-side manual edit of the DEPLOYED landing HTML
# (bypassing git). If that never happens, this canary is silently green forever.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract): ships
# ONLY the pure alert branch (severity hardcoded CRITICAL_PERSISTENT + contract body with the
# OPS-<CLASS>-W{NEXT} recommended-wave template resolved at send-time). send_telegram.sh OWNS the
# severity gate, 24h-per-alert_id cooldown, resolver, DRY_RUN_TG gate, and fail-open. This script
# is ALSO fail-open: every infra error logs + exits 0, never bouncing the cron.
#
# HOST-INSTALL: MANUAL_PENDING (mirrors nav-drift-canary.sh). Suggested crontab (weekly, off-:00
# per snapshot-sampler discipline; verify no collision at install): 47 6 * * 1
set -uo pipefail

APP_CTR="${ANALYTICS_DRIFT_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${ANALYTICS_DRIFT_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${ANALYTICS_DRIFT_LOG:-/var/log/analytics-drift-canary.log}"
ALERT_ID="ANALYTICS_REGION_DRIFT"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

command -v docker >/dev/null 2>&1 || { log "FAIL_OPEN: docker not on PATH"; exit 0; }
docker inspect "$APP_CTR" >/dev/null 2>&1 || { log "FAIL_OPEN: container $APP_CTR not found"; exit 0; }

# Run the STATIC drift check inside the deployed container (dist + landing live at /app).
OUT=$(docker exec "$APP_CTR" node scripts/build_analytics.mjs --check 2>&1); RC=$?

if [ "$RC" -eq 0 ]; then
  log "OK: every content page carries the in-sync analytics region."
  exit 0
fi
# Non-zero rc from --check (RC=1) = genuine drift/missing; anything else = infra → fail open.
if [ "$RC" -ne 1 ]; then
  log "FAIL_OPEN: build_analytics --check returned rc=$RC (treating as infra error): ${OUT:0:200}"
  exit 0
fi

log "DRIFT: served analytics region out of sync / a page missing the tag. ${OUT:0:300}"
[ -x "$SEND" ] || { log "FAIL_OPEN: send_telegram.sh not executable at $SEND"; exit 0; }

# Pure alert branch. send_telegram.sh interface is POSITIONAL: `send_telegram.sh <alert_id>
# <severity> [body_file|-]`; body via stdin (the OPS-<CLASS>-W{NEXT} template resolves at send-time).
BODY="🛑 ${ALERT_ID}
Analytics region drift on the live site — a served landing page's injected Plausible tag no longer matches the single-derivation SoT (dist/lib/analytics-snippet.js renderAnalyticsSnippet()) or is missing its <!-- ANALYTICS:START/END --> markers. Likely a host-side manual edit of the deployed HTML.
Recover: redeploy from main (build_analytics re-injects) or run \`docker exec ${APP_CTR} node scripts/build_analytics.mjs\`.
Recommended wave: OPS-ANALYTICS-DRIFT-RESTORE-W{NEXT}"
printf '%s\n' "$BODY" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
exit 0
