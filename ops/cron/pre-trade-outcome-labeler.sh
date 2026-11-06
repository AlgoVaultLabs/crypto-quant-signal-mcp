#!/usr/bin/env bash
# pre-trade-outcome-labeler.sh — DECISION-CALL-V2-W4 CH3.
#
# Labels each logged `pre_trade_check` with what the decision venue's price did over its hold:
# `docker exec` dist/scripts/pre-trade-outcome-labeler.js (src/scripts/pre-trade-outcome-labeler.ts). It reads
# `pre_trade_checks` and writes ONLY `pre_trade_check_outcomes` (migrations/054). INTERNAL and QUARANTINED:
# prices only, never a return or a P&L, never a published track-record table.
#
# ── SCHEDULE: 13 7 * * * ──
#
# Fixed before the CH3 commit (DECISION-CALL-V2-W4 ruling Q4): the first canonical minute free of every
# other daily or weekly job at that HH:MM in the live signal-1 crontab, at least 2 h after the wave's
# planned land and outside 02:00–06:30Z, where the nightly labelers run (the nightly's latest measured
# end is 06:16Z). Planned land 2026-11-06T05:00Z, so the first candidate is 07:00Z; read from the live
# crontab at 2026-11-06T03:34Z (133 schedule lines), 07:13 holds no daily or weekly job — the first free
# canonical minute (13,17,23,27,33,37,43,47,53,57; schedule-boundary-rule.json) at or after 07:00. The
# hourly jobs on :13 (entitlement-drain holds all ten canonical minutes every hour) are not slot owners,
# as the hold-decision-labeler's own slot reading has it.
#
# THE CRONTAB LINE, appended exactly (diff +1/−0); the lock is the line's, as hold-decision-labeler's is:
#   13 7 * * * flock -n /var/lock/algovault-pre-trade-outcome-labeler.lock /opt/crypto-quant-signal-mcp/ops/cron/pre-trade-outcome-labeler.sh >> /var/log/pre-trade-outcome-labeler.log 2>&1  # DECISION-CALL-V2-W4 CH3 pre_trade_check outcome labeler (inventory row pre-trade-outcome-labeler; safe-to-kill)
#
# ── SILENT ON SUCCESS ──
#
# A data pipeline, not a guard: the token PRE_TRADE_OUTCOME_VERDICT=PASS|FAIL|INDETERMINATE lands in
# /var/log/pre-trade-outcome-labeler.log and nothing pages. Exit 3 is INDETERMINATE — the run was cut
# short (a fetch, a venue's weight budget, the time budget, a stop) or could not run at all — which is
# NOT the same as "nothing to label" (an empty work-list is the steady state and exits 0, PASS).
#
# ONE TOKEN PER RUN. The child prints its own; when it never reaches one (the container is down, a
# deploy SIGKILLed the `docker exec`, it crashed before main returned) this wrapper prints
# INDETERMINATE in its place, so every run in the log ends in exactly one token. (A tick that finds
# the crontab line's lock held prints nothing at all — `flock -n` exits before this file runs.)
#
# SAFE-TO-KILL (ops/scripts/cron-interlock-registry.json): each outcome row is inserted before the next
# check is read, `ON CONFLICT (check_id) DO NOTHING`, and the work-list is an anti-join on the outcome
# table — so a kill loses at most the check in flight, and the next run picks up the rest. Nothing is
# corrupted; what is lost is the venue weight spent on the unfinished check.
set -euo pipefail

CTR=crypto-quant-signal-mcp-mcp-server-1
LOG_TAG="[pre-trade-outcome-labeler]"
MAX_CHECKS="${PRE_TRADE_OUTCOME_MAX_CHECKS:-500}"
TIME_BUDGET_MIN="${PRE_TRADE_OUTCOME_TIME_BUDGET_MIN:-30}"

echo "$LOG_TAG $(date -u +%FT%TZ) start max_checks=$MAX_CHECKS time_budget_min=$TIME_BUDGET_MIN"

# A deploy recreates the container; `docker exec` into a stopped one exits 1 — the labeler's own FAIL code.
# "Could not run" is INDETERMINATE, never FAIL (the hold-decision-labeler.sh discriminator).
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CTR"; then
  echo "$LOG_TAG $(date -u +%FT%TZ) PRE_TRADE_OUTCOME_VERDICT=INDETERMINATE container $CTR not running"
  exit 3
fi

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
set +e
docker exec "$CTR" node dist/scripts/pre-trade-outcome-labeler.js \
  --max-checks "$MAX_CHECKS" --time-budget-min "$TIME_BUDGET_MIN" 2>&1 | tee "$OUT"
rc=${PIPESTATUS[0]}
set -e

if ! grep -q '^PRE_TRADE_OUTCOME_VERDICT=' "$OUT"; then
  if [ "$rc" -eq 137 ]; then why="killed (exit 137: a deploy recreated the container)"; else why="exit $rc before a verdict"; fi
  echo "$LOG_TAG $(date -u +%FT%TZ) PRE_TRADE_OUTCOME_VERDICT=INDETERMINATE $why"
  rc=3
fi
echo "$LOG_TAG $(date -u +%FT%TZ) exit=$rc"
exit "$rc"
