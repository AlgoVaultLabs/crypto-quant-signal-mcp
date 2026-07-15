#!/usr/bin/env bash
# ops/cron/nav-drift-canary.sh — NAV-PLATFORM-GENERATOR-W1 CH5 (2026-07-12)
#
# 12th consumer of /opt/algovault-monitoring/send_telegram.sh. Belt-and-suspenders guard on the
# unified-nav single-derivation invariant: every served landing page's <!-- NAV:START/END -->
# region MUST byte-match the ONE model (dist/lib/site-nav.js renderSiteNav() ← nav-manifest.ts),
# and no nav-bearing page may be missing the markers.
#
# The PRIMARY gate is CI: `build_nav.mjs --check` runs in deploy.yml + prepublishOnly, so any
# drift entering via a git push is blocked BEFORE it deploys. This weekly cron only catches the
# marginal RUNTIME path CI can't see — a host-side manual edit of the DEPLOYED landing HTML
# (bypassing git). If that never happens, this canary is silently green forever.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# ships ONLY the pure alert branch (severity hardcoded CRITICAL_PERSISTENT + contract body with
# the OPS-<CLASS>-W{NEXT} recommended-wave template). send_telegram.sh OWNS the severity gate,
# 24h-per-alert_id cooldown, resolver, DRY_RUN_TG gate, and fail-open. This script is ALSO
# fail-open: every infra error logs + exits 0, never bouncing the cron.
#
# Suggested crontab (weekly, off-:00 per snapshot-sampler discipline): 37 6 * * 1
set -uo pipefail

APP_CTR="${NAV_DRIFT_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${NAV_DRIFT_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${NAV_DRIFT_LOG:-/var/log/nav-drift-canary.log}"
ALERT_ID="NAV_REGION_DRIFT"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

command -v docker >/dev/null 2>&1 || { log "FAIL_OPEN: docker not on PATH"; exit 0; }
docker inspect "$APP_CTR" >/dev/null 2>&1 || { log "FAIL_OPEN: container $APP_CTR not found"; exit 0; }

# Run the STATIC drift check inside the deployed container (dist + landing live at /app).
OUT=$(docker exec "$APP_CTR" node scripts/build_nav.mjs --check 2>&1); RC=$?

if [ "$RC" -eq 0 ]; then
  log "OK: every served nav region in sync."
  exit 0
fi
# Non-zero rc from --check (RC=1) = genuine drift; anything else = treat as infra + fail open.
if [ "$RC" -ne 1 ]; then
  log "FAIL_OPEN: build_nav --check returned rc=$RC (treating as infra error): ${OUT:0:200}"
  exit 0
fi

log "DRIFT: served nav region out of sync with the model. ${OUT:0:300}"
[ -x "$SEND" ] || { log "FAIL_OPEN: send_telegram.sh not executable at $SEND"; exit 0; }

# Pure alert branch. send_telegram.sh interface is POSITIONAL: `send_telegram.sh <alert_id>
# <severity> [body_file|-]`; body (incl the OPS-<CLASS>-W{NEXT} template, resolved at send-time)
# via stdin. (OPS-DOCS-JSONLD-TOOLCOUNT-W1 R3: the prior --flag form was silently
# SUPPRESSED_SEVERITY — flags landed in the alert_id/severity slots; fixed here + in docs-drift.)
BODY="🛑 ${ALERT_ID}
Nav region drift on the live site — a served landing page's injected nav no longer matches the single-derivation model (dist/lib/site-nav.js renderSiteNav()) or is missing its <!-- NAV:START/END --> markers. Likely a host-side manual edit of the deployed HTML.
Recover: redeploy from main (build_nav re-injects) or run \`docker exec ${APP_CTR} node scripts/build_nav.mjs\`.
Recommended wave: OPS-NAV-DRIFT-RESTORE-W{NEXT}"
printf '%s\n' "$BODY" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
exit 0
