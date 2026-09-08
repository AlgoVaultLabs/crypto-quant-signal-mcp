#!/usr/bin/env bash
# ops/cron/lifecycle-dispatch.sh — IDENTITY-LIFECYCLE-W3 CH1 R5.
#
# Evaluates the lifecycle step predicates and writes the ledger. In CH1 the step registry is
# deliberately EMPTY, so a tick is a no-op that still stamps liveness — the harness is on the host
# and observable a chapter before it has any behaviour to observe.
#
# ── WHY `docker exec … node dist/…` AND NOT psql ─────────────────────────────────────────
# The other host crons in this directory query Postgres directly, and that is right for them.
# It is WRONG here. The eligible set is a function of the monthly meter, and that meter is a
# ROLLING 30-DAY WINDOW whose expiry rule lives in `loadQuotaRows` (src/lib/license.ts): a row
# whose `period_start` is more than 30 days old is SKIPPED and reads as zero usage. Raw SQL over
# `quota_usage` does not know that. MEASURED 2026-09-08 on signal-1: two of the three metered
# email-bound buckets sit in EXPIRED periods, so a psql implementation would have mailed "you hit
# the wall" from a window that closed weeks ago. The app owns the meter; the cron asks the app.
#
# ── SCHEDULE: 7,22,37,52 * * * * ─────────────────────────────────────────────────────────
# Every 15 minutes on a FIXED-MINUTE OFFSET, never `*/15`. Two reasons:
#   1. `*/15` fires on the `:00` boundary, which the snapshot-sampler rule forbids.
#   2. `*/15 * * * *` is ALREADY OCCUPIED on this box by mcp-intelligence's launch_triggers
#      (measured 2026-09-08 against the live crontab, 118 active lines). Sharing the minute puts
#      two unrelated jobs on the same CPU spike for no reason.
# 7/22/37/52 were checked against every hourly family in that crontab and are unoccupied.
#
# ── INTERLOCK: safe-to-kill ──────────────────────────────────────────────────────────────
# A deploy recreates the container and SIGKILLs the `docker exec`. Nothing is corrupted and
# nothing is permanently lost: every write is guarded by `UNIQUE(recipient_id, step, period_key)`,
# so the next tick re-evaluates the same eligible set and lands the same rows. Exit 137 is
# EXPECTED here and is not a failure. What IS lost is at most one tick — 15 minutes of latency on
# a non-urgent email — which is why this is `safe-to-kill` and not `preempt-and-catchup`.
set -uo pipefail

REPO="${LIFECYCLE_REPO:-/opt/crypto-quant-signal-mcp}"
CTR="${LIFECYCLE_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
LOG="${LIFECYCLE_DISPATCH_LOG:-/var/log/lifecycle-dispatch.log}"
TAG="[lifecycle-dispatch]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }

emit() { # verdict, note
  echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) LIFECYCLE_DISPATCH_VERDICT=$1 $2"
  log "$1 $2"
  case "$1" in PASS) exit 0;; FAIL) exit 1;; *) exit 3;; esac
}

# A container that is not running is INDETERMINATE, never a silent pass: the dispatcher did not
# run, and "did not run" must not be indistinguishable from "ran and found nothing".
if ! docker inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -q true; then
  emit INDETERMINATE "container $CTR is not running — the tick did NOT happen"
fi

OUT="$(docker exec "$CTR" node dist/scripts/lifecycle-dispatch.js 2>&1)"; RC=$?
printf '%s\n' "$OUT" >> "$LOG" 2>/dev/null || true

# Gate on the TOKEN the app printed, never on this exec's exit code — a SIGKILL from a
# concurrent deploy exits 137 with no token, and that is not a FAIL.
TOKEN="$(printf '%s\n' "$OUT" | sed -n 's/.*LIFECYCLE_DISPATCH_VERDICT=\([A-Z]*\).*/\1/p' | tail -1)"
SUMMARY="$(printf '%s\n' "$OUT" | grep -o 'mode=.*' | tail -1)"

case "$TOKEN" in
  PASS) emit PASS "${SUMMARY:-tick completed} (rc=$RC)" ;;
  FAIL) emit FAIL "${SUMMARY:-a step evaluator threw} (rc=$RC)" ;;
  INDETERMINATE) emit INDETERMINATE "${SUMMARY:-app reported it could not verify} (rc=$RC)" ;;
  *)
    if [ "$RC" -eq 137 ]; then
      emit INDETERMINATE "SIGKILLed mid-tick (rc=137) — expected during a deploy; safe-to-kill, next tick repeats the work"
    fi
    emit INDETERMINATE "no verdict token in output (rc=$RC) — the app did not report"
    ;;
esac
