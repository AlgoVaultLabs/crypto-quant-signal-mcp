#!/usr/bin/env bash
# ops/cron/product-updates-digest.sh — IDENTITY-LIFECYCLE-W3 CH4 R1.
#
# The monthly digest. Sends the README "What's new" blocks a recipient has not already had.
#
# ── SCHEDULE: 27 9 * * 2  with a first-Tuesday guard ─────────────────────────────────────
# cron cannot express "first Tuesday", so the line runs EVERY Tuesday and the script exits
# early on the others. That is deliberate: encoding it as a day-of-month range (1-7) plus a
# weekday is a well-known cron trap — the two fields are OR'd, not AND'd, so `27 9 1-7 * 2`
# would fire on every day of the first week AND every Tuesday. The guard is one line of bash
# and cannot be misread.
#
# Minute 27 of hour 9 is clear of the other lifecycle jobs (readout 19 9) and off the :00
# boundary.
#
# safe-to-kill: every write is guarded by UNIQUE(recipient_id, step, period_key), so a killed
# run re-sends nothing and the next month's run picks up whatever was missed.
set -uo pipefail

CTR="${LIFECYCLE_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
LOG="${LIFECYCLE_DIGEST_LOG:-/var/log/product-updates-digest.log}"
TAG="[product-updates-digest]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }
emit() { echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) LIFECYCLE_DIGEST_VERDICT=$1 $2"; log "$1 $2"; exit "$3"; }

# FIRST-TUESDAY GUARD. Day-of-month 1-7 is the first occurrence of whatever weekday today is,
# and the crontab already restricts this line to Tuesdays.
DOM="$(date -u +%-d)"
if [ "$DOM" -gt 7 ]; then
  emit PASS "not the first Tuesday (day $DOM) — nothing evaluated" 0
fi

if ! docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -q true; then
  emit INDETERMINATE "container $CTR is not running — the digest did NOT run" 3
fi

OUT="$(docker exec "$CTR" node dist/scripts/product-updates-digest.js 2>&1)"; RC=$?
printf '%s\n' "$OUT" >> "$LOG" 2>/dev/null || true
printf '%s\n' "$OUT"
TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/.*LIFECYCLE_DIGEST_VERDICT=\([A-Z]*\).*/\1/p' | tail -1)"
SUMMARY="$(printf '%s\n' "$OUT" | grep -o 'mode=.*' | tail -1)"
case "$TOKEN" in
  PASS) emit PASS "${SUMMARY:-ran} (rc=$RC)" 0 ;;
  FAIL) emit FAIL "${SUMMARY:-failed} (rc=$RC)" 1 ;;
  *) [ "$RC" -eq 137 ] && emit INDETERMINATE "SIGKILLed mid-run (rc=137) — safe-to-kill, next month repeats" 3
     emit INDETERMINATE "no verdict token (rc=$RC)" 3 ;;
esac
