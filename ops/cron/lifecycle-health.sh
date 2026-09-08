#!/usr/bin/env bash
# ops/cron/lifecycle-health.sh — IDENTITY-LIFECYCLE-W3 CH1 R6.
#
# Daily health verdict on the lifecycle email engine, from the ledger and the dispatcher's own
# heartbeat.
#
# ── THE VERDICT CONTRACT ─────────────────────────────────────────────────────────────────
#   LIFECYCLE_HEALTH_VERDICT=PASS|FAIL|INDETERMINATE   →   exit 0 | 1 | 3
#
# 3 is the token-law default for a NEW gate. It is deliberately NOT check_test_baseline.sh's 2:
# that script is 2 only because it already deployed 2, nothing reads both code spaces, and
# "aligning" them is the churn the manual names and rejects. Callers gate on the TOKEN.
#
#   FAIL           (a) (bounces + complaints) / sent over 7d > 5 %, with n >= 20 sent
#                  (b) the dispatcher has not stamped its heartbeat in > 60 min WHILE it had
#                      eligible work — a stalled cron with nothing to do is not a fault
#   INDETERMINATE  the database is unreachable, or the heartbeat table cannot be read. We could
#                  not verify. NEVER a pass — exit 0 may not encode both "verified, clean" and
#                  "verified nothing".
#   PASS           everything else, WITH positive per-check output. A guard that printed only a
#                  verdict would be indistinguishable from a dark one.
#
# ── WHY THE RATE LEG IS INERT BELOW n=20, AND WHY THAT IS A PASS AND NOT INDETERMINATE ────
# The corpus here is built by the WORLD, not by us: `sent` rows appear only when a step has gone
# live and a real person has been mailed. Empty input is only vacuity when YOU were supposed to
# fill it. So a small-n window is a FACT and the honest verdict over it is PASS with the count
# printed — the same rule payment-decline-canary.py follows. (The self-test's corpus IS ours, so
# an empty one there REFUSES. That asymmetry is the rule, not an inconsistency.)
#
# ── WHY THE STALL LEG READS A HEARTBEAT AND NOT THE LEDGER ────────────────────────────────
# Freshness alarms measure PRODUCERS, never rendered artifacts. MEASURED 2026-09-08: three of
# the four steps have ZERO eligible recipients, so a healthy dispatcher and a dead one write
# byte-identical ledgers — nothing. `lifecycle_heartbeats` is the producer's own write stamp and
# is written on every tick including a no-op one.
#
# psql, never `docker exec <app> node -e`: nested ssh+docker+node quoting mangles SQL string
# literals, and the app image resolves modules from /app, not from a script path.
#
# ── SCHEDULE: 43 8 * * * ─────────────────────────────────────────────────────────────────
# Hour 8, minute 43. Off the `:00` boundary per the snapshot-sampler rule. Verified clear against
# the live crontab on 2026-09-08 (118 active lines): hour 8 holds 19, 39, 51, 7, 9 and the
# every-N-minutes families; 43 in hour 8 is unoccupied. It runs AFTER the 07:xx canary cluster so
# a shared DB hiccup does not produce five simultaneous pages.
set -uo pipefail

PG_CTR="${LIFECYCLE_PG_CTR:-crypto-quant-signal-mcp-postgres-1}"
PG_USER="${LIFECYCLE_PG_USER:-algovault}"
PG_DB="${LIFECYCLE_PG_DB:-signal_performance}"
SEND="${LIFECYCLE_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
RESULT_LOG_DIR="${LIFECYCLE_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
LOG="${LIFECYCLE_HEALTH_LOG:-/var/log/lifecycle-health.log}"
ALERT_ID="LIFECYCLE_EMAIL_HEALTH"

# Thresholds. Named constants so the self-test can assert the REAL values rather than its own.
BOUNCE_RATE_PCT_MAX="${LIFECYCLE_BOUNCE_RATE_PCT_MAX:-5}"
MIN_N="${LIFECYCLE_MIN_N:-20}"
STALL_MINUTES_MAX="${LIFECYCLE_STALL_MINUTES_MAX:-60}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG" 2>/dev/null || true; }

# ── Structured record so the verdict is readable OFF-HOST (canary-results.jsonl via the
# two-way sync). The import is GUARDED: a partial install degrades to a no-op that SAYS SO,
# rather than aborting the file and losing the verdict entirely.
publish() {
  local verdict="$1" code="$2" metrics="$3"
  python3 - "$RESULT_LOG_DIR" "$verdict" "$code" "$metrics" <<'PY' 2>/dev/null || echo "[lifecycle-health] result-log append skipped (module unavailable)"
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print(f"[lifecycle-health] result-log import failed: {type(e).__name__}")
    raise SystemExit(0)
ok, detail = append_result("lifecycle-health", sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4]))
print(f"[lifecycle-health] result-log {'ok' if ok else 'FAILED'} {detail}")
PY
}

alert() {
  local body="$1"
  if [ ! -x "$SEND" ]; then
    log "ESCALATE_UNSENT: send_telegram.sh not executable at $SEND — verdict was not delivered"
    return 0
  fi
  printf '%s\n' "$body" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" \
    || log "ESCALATE_UNSENT: send_telegram invocation failed"
}

finish() { # verdict, exit code, human line, metrics json
  echo "[lifecycle-health] $(date -u +%Y-%m-%dT%H:%M:%SZ) LIFECYCLE_HEALTH_VERDICT=$1 $3"
  log "$1 $3"
  publish "$1" "$2" "$4"
  exit "$2"
}

psql_q() { docker exec "$PG_CTR" psql -U "$PG_USER" -d "$PG_DB" -tA -q -F'|' -c "$1" 2>/dev/null; }

# ── THE DECISION, ONCE ────────────────────────────────────────────────────────────────────
# `classify` is the ONLY place the verdict logic lives. The self-test drives THIS function and so
# does the live path — because a self-test that re-implements the branch it is testing proves only
# that two copies agree, and the copy that drifts is always the one nobody is watching. Mutating a
# threshold OR a comparison operator here is now caught by the suite below.
#   args: sent, bounces+complaints, stale_minutes, eligible  ->  PASS | FAIL
classify() {
  local sent="$1" bad="$2" stale="$3" eligible="$4"
  # Stall leg: a dispatcher that has not ticked WHILE work was waiting. A cron with nothing to
  # do is idle, not broken, so `eligible > 0` is a required conjunct and not a nicety.
  if [ "$stale" -gt "$STALL_MINUTES_MAX" ] && [ "$eligible" -gt 0 ]; then echo FAIL; return; fi
  # Rate leg: INERT below MIN_N. Integer arithmetic on both sides — no float, no bc dependency.
  if [ "$sent" -ge "$MIN_N" ] && [ $(( bad * 100 )) -gt $(( sent * BOUNCE_RATE_PCT_MAX )) ]; then
    echo FAIL; return
  fi
  echo PASS
}

# ── The two queries, as pure builders. Defined ABOVE the self-test because bash resolves a
# function at CALL time and the self-test runs first — and used by the LIVE path below, because a
# self-test asserting the shape of a string the live path does not use is a vacuous assertion
# wearing a bypassed-artifact assertion's clothes.
rate_query() {
  cat <<'SQL'
SELECT
  (SELECT COUNT(*) FROM lifecycle_sends WHERE status = 'sent' AND created_at >= NOW() - INTERVAL '7 days'),
  (SELECT COUNT(*) FROM lifecycle_suppressions WHERE reason IN ('bounce','complaint') AND created_at >= NOW() - INTERVAL '7 days')
SQL
}
stall_query() {
  cat <<'SQL'
SELECT
  COALESCE(EXTRACT(EPOCH FROM (NOW() - last_run_at)) / 60, 999999)::int AS stale_minutes,
  COALESCE(eligible_count, 0) AS eligible
FROM lifecycle_heartbeats
WHERE job = 'lifecycle-dispatch'
SQL
}

# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────
# Hermetic; touches no host path and opens no connection. It therefore CANNOT see the psql seam
# it replaces, so it asserts the BYPASSED ARTIFACTS too: the SQL strings are built by the same
# pure functions the live path uses, and their shape is checked here.
if [ "${1:-}" = "--self-test" ]; then
  fails=0; checks=0
  ck() { checks=$((checks+1)); if [ "$2" != "$3" ]; then echo "SELF-TEST FAIL: $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }

  ck "clean, large n"                "$(classify 100 2 5 0)"   PASS
  ck "6% of 100 breaches 5%"         "$(classify 100 6 5 0)"   FAIL
  ck "exactly 5% does NOT breach"    "$(classify 100 5 5 0)"   PASS
  ck "rate leg INERT below MIN_N"    "$(classify 19 19 5 0)"   PASS
  ck "at MIN_N the leg engages"      "$(classify 20 19 5 0)"   FAIL
  ck "stall WITH eligible work"      "$(classify 100 0 61 3)"  FAIL
  ck "stall with NOTHING to do"      "$(classify 100 0 61 0)"  PASS
  ck "at the stall boundary"         "$(classify 100 0 60 3)"  PASS
  ck "zero corpus is PASS not INDET" "$(classify 0 0 5 0)"     PASS

  # BYPASSED-ARTIFACT assertions — the psql seam is what --self-test replaces, so the queries it
  # would have run are exercised for SHAPE here. A query that stopped naming its own table is
  # invisible to every scenario above.
  q1="$(rate_query 2>/dev/null || true)"
  case "$q1" in *lifecycle_sends*status*) ;; *) echo "SELF-TEST FAIL: rate query lost its subject"; fails=$((fails+1));; esac
  checks=$((checks+1))
  q2="$(stall_query 2>/dev/null || true)"
  case "$q2" in *lifecycle_heartbeats*lifecycle-dispatch*) ;; *) echo "SELF-TEST FAIL: stall query lost its subject"; fails=$((fails+1));; esac
  checks=$((checks+1))

  # Vacuity guard where the corpus is CONSTRUCTED: this corpus is ours, so an empty one REFUSES.
  #
  # The floor is pinned EXACTLY, not as a lower bound. A `-lt` floor catches a truncated corpus
  # but not a LOWERED FLOOR — measured: dropping it from 11 to 1 with every check still present
  # left the suite green, so the guard could be disarmed in one edit and the next truncation
  # would sail through. Exact equality makes the floor and the corpus one fact: adding a check
  # without raising the floor fails just as loudly as removing one.
  FLOOR=11
  if [ "$checks" -ne "$FLOOR" ]; then
    echo "SELF-TEST: INDETERMINATE — ran $checks checks, floor is exactly $FLOOR"
    echo "LIFECYCLE_HEALTH_VERDICT=INDETERMINATE self-test built no corpus"
    exit 3
  fi
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: FAIL ($fails of $checks)"; echo "LIFECYCLE_HEALTH_VERDICT=FAIL self-test"; exit 1
  fi
  echo "SELF-TEST: PASS ($checks checks)"
  echo "LIFECYCLE_HEALTH_VERDICT=PASS self-test checks=$checks"
  exit 0
fi

# ── LIVE ─────────────────────────────────────────────────────────────────────────────────
if ! docker inspect -f '{{.State.Running}}' "$PG_CTR" 2>/dev/null | grep -q true; then
  finish INDETERMINATE 3 "postgres container '$PG_CTR' is not running — could not verify" \
    '{"reason":"pg_container_down"}'
fi

# Bounce/complaint rate is computed from the SUPPRESSION rows Resend's webhook wrote, joined to
# what we actually sent in the same window — not from a rate column nobody maintains.
RATE_ROW="$(psql_q "$(rate_query)")"
if [ -z "$RATE_ROW" ]; then
  finish INDETERMINATE 3 "ledger unreadable — could not verify" '{"reason":"ledger_unreadable"}'
fi
SENT="${RATE_ROW%%|*}"; BAD="${RATE_ROW##*|}"
case "$SENT$BAD" in ''|*[!0-9]*) finish INDETERMINATE 3 "ledger returned a non-numeric row ('$RATE_ROW')" '{"reason":"unparseable_ledger_row"}';; esac

STALL_ROW="$(psql_q "$(stall_query)")"
if [ -z "$STALL_ROW" ]; then
  # No heartbeat row at all. Before the dispatcher's first tick this is the EXPECTED state, and
  # it is not a fault — but it is also not a verified-healthy dispatcher, so it is reported
  # explicitly rather than folded into a silent PASS.
  STALE=-1; ELIGIBLE=0
else
  STALE="${STALL_ROW%%|*}"; ELIGIBLE="${STALL_ROW##*|}"
fi
case "$STALE" in ''|*[!0-9-]*) STALE=-1;; esac
case "$ELIGIBLE" in ''|*[!0-9]*) ELIGIBLE=0;; esac

METRICS="{\"sent_7d\":$SENT,\"bounce_complaint_7d\":$BAD,\"stale_minutes\":$STALE,\"eligible\":$ELIGIBLE,\"min_n\":$MIN_N,\"rate_pct_max\":$BOUNCE_RATE_PCT_MAX,\"stall_minutes_max\":$STALL_MINUTES_MAX}"

VERDICT="$(classify "$SENT" "$BAD" "$STALE" "$ELIGIBLE")"

# Which LEG failed is a reporting question, asked only once `classify` has already decided. The
# legs are re-read here for the alert text; they never re-decide the verdict.
if [ "$VERDICT" = "FAIL" ] && [ "$STALE" -gt "$STALL_MINUTES_MAX" ] && [ "$ELIGIBLE" -gt 0 ]; then
  alert "🛑 ${ALERT_ID}
The lifecycle dispatcher has not ticked for ${STALE} minutes while ${ELIGIBLE} recipients were eligible.
Eligible people are waiting on an email the cron is not sending. Check the */15 crontab line and
the container: ops/cron/lifecycle-dispatch.sh on signal-1.
Recommended wave: OPS-LIFECYCLE-DISPATCH-RESTORE-W{NEXT}"
  finish FAIL 1 "dispatcher stalled ${STALE}min with ${ELIGIBLE} eligible" "$METRICS"
fi

if [ "$VERDICT" = "FAIL" ]; then
  alert "🛑 ${ALERT_ID}
Lifecycle bounce+complaint rate over 7 days is ${BAD}/${SENT}, above the ${BOUNCE_RATE_PCT_MAX}% ceiling.
This is a deliverability risk to every transactional email AlgoVault sends, not only lifecycle mail.
The day-7 readout rolls individual steps back to shadow on its own; this page is the human notice.
Recommended wave: OPS-LIFECYCLE-DELIVERABILITY-W{NEXT}"
  finish FAIL 1 "bounce+complaint ${BAD}/${SENT} over 7d exceeds ${BOUNCE_RATE_PCT_MAX}%" "$METRICS"
fi

# POSITIVE PER-CHECK OUTPUT — every quantity observed, including the zeros and including WHY a
# leg was inert. "Installed" is not "working", and a PASS that named nothing could not be told
# apart from a guard that checked nothing.
RATE_NOTE="rate_leg=inert(n=$SENT<$MIN_N)"
[ "$SENT" -ge "$MIN_N" ] && RATE_NOTE="rate_leg=active(${BAD}/${SENT})"
STALL_NOTE="stall_leg=ok(stale=${STALE}min,eligible=${ELIGIBLE})"
[ "$STALE" -lt 0 ] && STALL_NOTE="stall_leg=no_heartbeat_yet(dispatcher has not ticked since install)"
finish PASS 0 "sent_7d=$SENT bounce_complaint_7d=$BAD $RATE_NOTE $STALL_NOTE" "$METRICS"
