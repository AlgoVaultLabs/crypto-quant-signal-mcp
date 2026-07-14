#!/usr/bin/env bash
# ops/cron/docs-drift-canary.sh — DOCS-GENERATOR-FROM-NAV-SOT-W1 CH5 (2026-07-14)
#
# 13th consumer of /opt/algovault-monitoring/send_telegram.sh. Belt-and-suspenders guard on the
# generated docs.html: the LIVE served page must still carry every section the ONE outline SoT
# (src/lib/docs-outline.ts ← nav publicToolEntries + channel-registry) emits.
#
# The PRIMARY gate is CI: `build_docs.mjs --check` runs in deploy.yml + prepublishOnly, so any
# structural drift entering via a git push is blocked BEFORE it deploys. This weekly cron catches
# the marginal RUNTIME path CI can't see — a host-side manual edit / partial sync-corruption of the
# DEPLOYED docs.html. NB: unlike nav-drift-canary, this runs a LIVE FETCH (curl), not
# `build_docs --check` in the container — docs.html is Caddy-static and is NOT copied into the app
# image (Dockerfile serves it host-side), so docs-src/ + docs.html are absent from the container.
# A live structural check on the served page is the faithful runtime equivalent.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# ships ONLY the pure alert branch (severity CRITICAL_PERSISTENT + OPS-<CLASS>-W{NEXT} template).
# send_telegram.sh OWNS the severity gate, 24h-per-alert_id cooldown, resolver, DRY_RUN_TG gate,
# and fail-open. This script is ALSO fail-open: every infra/network error logs + exits 0.
#
# Suggested crontab (weekly, off-:00 per snapshot-sampler discipline): 43 6 * * 1
set -uo pipefail

URL="${DOCS_DRIFT_URL:-https://algovault.com/docs.html}"
RESOLVER="${DOCS_DRIFT_RESOLVER:-1.1.1.1}"   # pin a fixed resolver (DNS hygiene)
SEND="${DOCS_DRIFT_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${DOCS_DRIFT_LOG:-/var/log/docs-drift-canary.log}"
ALERT_ID="DOCS_STRUCTURE_DRIFT"

# Sections that MUST always be present in the served docs.html. Any absence = the served page has
# lost a section (host-side edit / partial-sync corruption). Kept in sync with docs-outline.ts:
# the 6 public tools + 4 channels + the 3 build_landing connect surfaces + the key H1/leaf sections.
REQUIRED_IDS=(
  quick-start
  get-trade-call get-market-regime scan-funding-arb scan-trade-calls chat-knowledge search-knowledge
  mcp rest-api webhooks telegram
  connect-mcp connect-ai-agent connect-exchange-kit
  live-dashboard verify pricing faq
)

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

command -v curl >/dev/null 2>&1 || { log "FAIL_OPEN: curl not on PATH"; exit 0; }

HOST=$(printf '%s' "$URL" | sed -E 's#https?://([^/]+).*#\1#')
IP=$(command -v dig >/dev/null 2>&1 && dig +short A "$HOST" "@$RESOLVER" 2>/dev/null | head -1 || true)
RESOLVE_ARGS=(); [ -n "$IP" ] && RESOLVE_ARGS=(--resolve "$HOST:443:$IP")

HTML=$(curl -fsS -m 20 --retry 2 --retry-delay 3 "${RESOLVE_ARGS[@]}" -A "algovault-docs-drift-canary" "$URL" 2>>"$LOG")
if [ -z "$HTML" ]; then
  log "FAIL_OPEN: empty/failed fetch of $URL (network/origin transient)"
  exit 0
fi

MISSING=()
for id in "${REQUIRED_IDS[@]}"; do
  printf '%s' "$HTML" | grep -q "id=\"$id\"" || MISSING+=("$id")
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  log "OK: all ${#REQUIRED_IDS[@]} required docs sections present on $URL"
  exit 0
fi

log "DRIFT: served docs.html is missing ${#MISSING[@]} required section(s): ${MISSING[*]}"
[ -x "$SEND" ] || { log "FAIL_OPEN: send_telegram.sh not executable at $SEND"; exit 0; }

# Pure alert branch — send_telegram.sh owns every gate.
"$SEND" \
  --alert-id "$ALERT_ID" \
  --severity CRITICAL_PERSISTENT \
  --title "Docs structure drift on the live site" \
  --body "The served $URL is missing required section(s): ${MISSING[*]}. The docs sidebar/body derive from the ONE outline SoT (src/lib/docs-outline.ts); a section vanishing at runtime means a host-side edit or a partial deploy-sync corrupted the served page. Recover: redeploy from main (build_docs regenerates docs.html) and re-verify \`node scripts/build_docs.mjs --check\`." \
  --recommended-wave "OPS-DOCS-DRIFT-RESTORE-W{NEXT}" 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
exit 0
