#!/usr/bin/env bash
# OPS-LABEL-FRESHNESS-W1 R2 — venue SLO-tier drift canary (host mirror vs in-image SoT).
#
# Single-derivation guard. The labeler orders venues by SLO-deadline from the in-image
# src/lib/venue-slo-tiers.ts; the freshness canary reads the host mirror
# /opt/algovault-monitoring/venue-slo-tiers.json. If those drift, the scheduler and the
# monitor optimise / measure different tier sets — the H1 failure. The committed JSON is
# byte-locked to the TS by the vitest suite (tests/unit/venue-slo-tiers.test.ts); THIS canary
# catches a stale HOST sync (a failed SSH install or a manual host edit) by comparing the host
# mirror against the exact bytes the RUNNING image derives its tiers from (serializeTierSot()).
#
# READ-ONLY. Fail-open (any probe error → exit 0, no page). Mirrors tier-misclassification-
# canary.sh: the host wrapper (send_telegram.sh) owns severity / cooldown / DRY_RUN / fail-open;
# this consumer only pipes the drift summary. Installed to /opt/algovault-monitoring/ via SSH
# (the repo copy is paths-ignored in deploy.yml, so it never triggers a prod rebuild).
# Suggested cron: weekly, e.g. `0 12 * * 1 /opt/algovault-monitoring/venue-slo-tiers-drift-canary.sh`.
set -uo pipefail

CTR=${LF_LABELER_CTR:-crypto-quant-signal-mcp-mcp-server-1}
HOST_JSON=${LF_TIERS_FILE:-/opt/algovault-monitoring/venue-slo-tiers.json}
WRAPPER=${SEND_TELEGRAM:-/opt/algovault-monitoring/send_telegram.sh}
LOG=/var/log/venue-slo-tiers-drift-canary.log
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# The exact bytes the labeler derives its tiers from (the in-image SoT serialisation).
IMG=$(docker exec "$CTR" node -e 'process.stdout.write(require("/app/dist/lib/venue-slo-tiers.js").serializeTierSot())' 2>/dev/null) || {
  echo "$(ts) [tier-drift] FAIL_OPEN could not read in-image SoT" >> "$LOG"; exit 0
}
HOST=$(cat "$HOST_JSON" 2>/dev/null) || {
  echo "$(ts) [tier-drift] FAIL_OPEN could not read host mirror $HOST_JSON" >> "$LOG"; exit 0
}

if [ "$IMG" = "$HOST" ]; then
  echo "$(ts) [tier-drift] in-sync ✅ host mirror == in-image SoT" >> "$LOG"
  exit 0
fi

echo "$(ts) [tier-drift] DRIFT host mirror != in-image SoT" >> "$LOG"
BODY=$(printf '%s\n' \
  "🛑 VENUE_SLO_TIER_DRIFT" \
  "The host freshness-canary tier mirror ($HOST_JSON) no longer matches the in-image labeler SoT." \
  "The scheduler (labeler) and the monitor (canary) disagree on the major/long-tail set — re-sync the mirror." \
  "Action: dispatch OPS-LABEL-TIER-DRIFT-W{NEXT} via Cowork → Claude Code" \
  "Source log: $LOG")
printf '%s' "$BODY" | "$WRAPPER" VENUE_SLO_TIER_DRIFT CRITICAL_PERSISTENT - >> "$LOG" 2>&1 || \
  echo "$(ts) [tier-drift] FAIL_OPEN wrapper error" >> "$LOG"
exit 0
