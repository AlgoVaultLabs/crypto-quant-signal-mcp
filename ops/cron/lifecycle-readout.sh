#!/usr/bin/env bash
# ops/cron/lifecycle-readout.sh — IDENTITY-LIFECYCLE-W3 CH2 R4. THE DECIDING HALF.
#
# Runs the readout in `--decide` mode: it applies the PER-STEP go-live and rollback decisions that
# `stepGoLiveBlocker` and `rollbackReason` compute from the ledger. NO HUMAN FLIPS THE FLAG — this
# cron is the only thing that ever does, and its decision is a pure function of recorded evidence.
#
# ── PER-STEP, NOT WAVE-LEVEL (architect ruling Q1(A), 2026-09-08) ─────────────────────────
# The spec's original gate was one wave-level flip on `would_send >= 1`. Measured on signal-1:
# `activation_nudge` has 28 eligible recipients and the other three have ZERO, so that gate was
# satisfiable by one step and would have lit three that had never rendered — their first-ever
# render going to a real person. Each step now has its own 7-day clock, its own canary batch of
# <= 5 on its first live tick, and its own rollback. A step with no eligible recipients simply
# stays in shadow, indefinitely, at zero cost.
#
# ── THE TWO PRECONDITIONS ARE MEASURED HERE, NOT ASSUMED ─────────────────────────────────
# `stepGoLiveBlocker` requires health PASS and an unsubscribe self-test PASS. Rather than trust a
# stale value, this wrapper RUNS both immediately before deciding and passes the results in. A
# go-live gated on a health verdict from yesterday is gated on nothing.
#
# ── SCHEDULE: 19 9 * * * ─────────────────────────────────────────────────────────────────
# Daily, after the 08:43 health canary so today's verdict already exists, and off the :00
# boundary. Minute 19 of hour 9 was checked clear against the live crontab (hour 9 holds 0, 29,
# 41 plus the every-N families).
set -uo pipefail

REPO="${LIFECYCLE_REPO:-/opt/crypto-quant-signal-mcp}"
CTR="${LIFECYCLE_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${LIFECYCLE_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${LIFECYCLE_READOUT_LOG:-/var/log/lifecycle-readout.log}"
ALERT_ID="LIFECYCLE_GOLIVE_ROLLBACK"
TAG="[lifecycle-readout]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }

alert() {
  [ -x "$SEND" ] || { log "ESCALATE_UNSENT: $SEND not executable"; return 0; }
  printf '%s\n' "$1" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" \
    || log "ESCALATE_UNSENT: send_telegram invocation failed"
}

finish() { echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) LIFECYCLE_GOLIVE_VERDICT=$1 $2"; log "$1 $2"; exit "$3"; }

if ! docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -q true; then
  finish INDETERMINATE "container $CTR is not running — no decision was made" 3
fi

# PRECONDITION 1 — health, measured NOW.
HEALTH_OUT="$(bash "$REPO/ops/cron/lifecycle-health.sh" 2>&1)"
HEALTH_TOK="$(printf '%s\n' "$HEALTH_OUT" | grep -o 'LIFECYCLE_HEALTH_VERDICT=[A-Z]*' | tail -1)"
[ "$HEALTH_TOK" = "LIFECYCLE_HEALTH_VERDICT=PASS" ] && HEALTH_OK=1 || HEALTH_OK=0

# PRECONDITION 2 — the unsubscribe endpoint still refuses a forged token. A step must never go
# live while the one control that lets a recipient stop it is broken.
UNSUB_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
  https://api.algovault.com/email/unsubscribe/INVALIDTOKEN 2>/dev/null || echo 000)"
case "$UNSUB_CODE" in 4??) UNSUB_OK=1 ;; *) UNSUB_OK=0 ;; esac

log "preconditions: health=$HEALTH_TOK unsub_invalid=$UNSUB_CODE"

OUT="$(docker exec -e LIFECYCLE_HEALTH_OK="$HEALTH_OK" -e LIFECYCLE_UNSUB_OK="$UNSUB_OK" \
        "$CTR" node dist/scripts/lifecycle-readout.js --decide 2>&1)"; RC=$?
printf '%s\n' "$OUT" >> "$LOG" 2>/dev/null || true
printf '%s\n' "$OUT"

VERDICT="$(printf '%s\n' "$OUT" | grep -o 'LIFECYCLE_GOLIVE_VERDICT=[A-Z_]*' | tail -1 | cut -d= -f2)"
READOUT="$(printf '%s\n' "$OUT" | grep -o 'LIFECYCLE_READOUT_VERDICT=[A-Z]*' | tail -1 | cut -d= -f2)"

if [ "$VERDICT" = "ROLLED_BACK" ]; then
  alert "🛑 ${ALERT_ID}
A lifecycle step was ROLLED BACK to shadow inside its first 72h live.
$(printf '%s\n' "$OUT" | grep 'ROLLED_BACK' | head -3)
The step stops sending immediately and does NOT re-light itself — a rolled-back step is held
until a human clears it. Nothing else is affected; rollback is per step.
Recommended wave: OPS-LIFECYCLE-DELIVERABILITY-W{NEXT}"
  finish ROLLED_BACK "a step returned to shadow (rc=$RC)" 1
fi

[ "$READOUT" = "INDETERMINATE" ] && finish INDETERMINATE "readout could not read the ledger (rc=$RC)" 3
[ -z "$VERDICT" ] && finish INDETERMINATE "no go-live token in output (rc=$RC)" 3
finish "$VERDICT" "readout=$READOUT health=$HEALTH_TOK unsub=$UNSUB_CODE (rc=$RC)" 0
