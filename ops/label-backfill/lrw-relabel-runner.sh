#!/usr/bin/env bash
# lrw-relabel-runner.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the host-detached runner for the historical `-v2`
# relabel and the `race_gap_candles` annotation (ruling LRW-Q13). Installed to /opt by hand for the relabel nights;
# launched with nohup, one process per venue; never cron, never the nightly's lock or log.
#
#   relabel   lrw-relabel-runner.sh --venue <V> [--since <epoch>] [--cap-min <n>] [--rate <req/min>]
#   annotate  lrw-relabel-runner.sh --annotate <host-path.csv.gz>[,<host-path.csv.gz>]
# (the adapter-pending cell and T_CUT are pinned in the code — src/scripts/lrw/registered.ts — never flags)
#
# The contract (LRW-Q13):
#   * SLOT 18:30–02:15Z with a HARD STOP at 02:15Z — refuses to start outside it; every pass's budget is the time
#     left to 02:15Z (and --cap-min), enforced INSIDE the process (checked before every venue page and every
#     annotation batch), with a watchdog that TERMs this runner's own process in the container at 02:14Z should it
#     still be alive; the nightly labellers own 02:20–06:30Z.
#   * OWN flock (/var/lock/algovault-lrw-relabel-<V>.lock) and OWN log (/var/log/lrw-relabel/<V>.log) — never
#     /var/log/carry-labeler.log or the nightly lock.
#   * lock_timeout 5s on every statement (PGOPTIONS) — the annotation refuses to write without it.
#   * --rate = this process's OWN requests/min (≤ 50 % of the venue's documented limit, never above its batch cap;
#     the shared weight budget still meters every batch caller together, so HL / WEEX seeders are never displaced).
#   * DB-state RESUME: a pass skips every row that already has its `-v2`; a deploy that recreates the container
#     (SIGTERM → a DONE line with outcome "stopped", or exec exit 137 / 1 with the container gone) is waited out
#     (90 s), never counted as a pass and never re-exec'd straight into the dying container.
#   * CONVERGED = a pass whose DONE line reads outcome "complete", written 0, errors 0, budgetSkips 0, cutShort 0
#     (what is left is refused / unreachable — counted in the LRW_MANIFEST lines of the log, never filled). A
#     fetch error or a budget skip is not a class: it keeps the runner from CONVERGED. The annotation converges on
#     a DONE line with outcome "complete" — the ctid scan reached the end. The runner's word is still only a claim:
#     the pull and the CH3 gate re-measure DONE on the rows (dist/scripts/lrw/completeness.js).
# Prints one terminal line: LRW_RUNNER_VERDICT=CONVERGED | SLOT_END | MAX_PASSES | REFUSED | INDETERMINATE.
# A deploy during a pass: the deploy interlock's `carry-labeler` row matches this process too (same script), so
# it is SIGTERMed (checkpoint at the next group) and the runner resumes after the recreate. The 18–03Z
# deploy-free hours make that rare. Self-test: LRW_RUNNER_SELFTEST=1 lrw-relabel-runner.sh
set -u
CTR=crypto-quant-signal-mcp-mcp-server-1
LOGDIR=/var/log/lrw-relabel
SLOT_START_MIN=$((18 * 60 + 30))
SLOT_END_MIN=$((2 * 60 + 15))
MAX_PASSES=8
ERR_WAITS_MAX=20

venue="" since="" cap="" rate="" annotate=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "$1 needs a value" >&2; echo 'LRW_RUNNER_VERDICT=REFUSED'; exit 2; }
  case "$1" in
    --venue) venue="$2" ;;
    --since) since="$2" ;;
    --cap-min) cap="$2" ;;
    --rate) rate="$2" ;;
    --annotate) annotate="$2" ;;
    *) echo "unknown argument $1" >&2; echo 'LRW_RUNNER_VERDICT=REFUSED'; exit 2 ;;
  esac
  shift 2
done

# minutes left until the 02:15Z hard stop; 0 when outside the 18:30–02:15Z slot
slot_minutes_left() {
  local now; now=${LRW_NOW_MIN:-$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))}
  if [ "$now" -ge "$SLOT_START_MIN" ]; then echo $((24 * 60 - now + SLOT_END_MIN))
  elif [ "$now" -lt "$SLOT_END_MIN" ]; then echo $((SLOT_END_MIN - now))
  else echo 0; fi
}

# pass_state <DONE line> → converged | stopped | progress — what one pass's own DONE line says
pass_state() {
  local line="$1" f v
  printf '%s' "$line" | grep -q '"outcome":"stopped"' && { echo stopped; return; }
  printf '%s' "$line" | grep -q '"outcome":"complete"' || { echo progress; return; }
  for f in written errors budgetSkips cutShort; do
    v="$(printf '%s' "$line" | grep -oE "\"$f\":[0-9]+" | head -n 1 | cut -d: -f2)"
    [ "$v" = 0 ] || { echo progress; return; } # absent counts as not zero
  done
  echo converged
}

self_test() {
  local ok=0 bad=0 hm want got
  for pair in "1110:465" "1380:195" "130:5" "135:0" "720:0" "1109:0" "0:135"; do
    hm=${pair%%:*}; want=${pair##*:}; got=$(LRW_NOW_MIN=$hm slot_minutes_left)
    if [ "$got" = "$want" ]; then ok=$((ok + 1)); else bad=$((bad + 1)); echo "SELF-TEST: FAIL slot at minute $hm: got $got want $want"; fi
  done
  local D='RELABEL DONE {"outcome":"complete","groups":3,"written":0,"budgetSkips":0,"errors":0,"cutShort":0}'
  for pair in \
    "converged|$D" \
    "progress|${D/\"written\":0/\"written\":5}" \
    "progress|${D/\"errors\":0/\"errors\":2}" \
    "progress|${D/\"budgetSkips\":0/\"budgetSkips\":1}" \
    "progress|${D/\"cutShort\":0/\"cutShort\":1}" \
    "progress|${D/complete/global-budget}" \
    "stopped|${D/complete/stopped}" \
    "progress|${D/,\"errors\":0/}" \
    "converged|ANNOTATE DONE {\"outcome\":\"complete\",\"written\":0,\"errors\":0,\"budgetSkips\":0,\"cutShort\":0}"; do
    want=${pair%%|*}; got=$(pass_state "${pair#*|}")
    if [ "$got" = "$want" ]; then ok=$((ok + 1)); else bad=$((bad + 1)); echo "SELF-TEST: FAIL pass_state: got $got want $want for ${pair#*|}"; fi
  done
  if [ "$bad" -eq 0 ] && [ "$ok" -ge 16 ]; then echo "LRW_RUNNER_SELFTEST: PASS ($ok checks)"; exit 0; fi
  echo "LRW_RUNNER_SELFTEST: FAIL ($bad)"; exit 1
}
[ "${LRW_RUNNER_SELFTEST:-0}" = 1 ] && self_test

mkdir -p "$LOGDIR"
name="${venue:-annotate}"
LOG="$LOGDIR/$name.log"
exec 9>"/var/lock/algovault-lrw-relabel-$name.lock"
flock -n 9 || { echo "another lrw runner holds the $name lock" >&2; echo 'LRW_RUNNER_VERDICT=REFUSED'; exit 1; }
log() { echo "$(date -u +%FT%TZ) [lrw-runner $name] $*" >> "$LOG"; }

# run_watched <minutes left> <pkill pattern> <docker exec args…> — runs one pass; at the hard stop (1 min before
# the slot ends) TERMs THIS runner's process inside the container if it is still alive (the in-process deadline
# is the primary stop; this is the backstop). Returns the exec's exit code.
run_watched() {
  local left="$1" pat="$2"; shift 2
  local stop_at=$(( $(date -u +%s) + (left - 1) * 60 )) termed=0 pid rc
  docker exec -e PGOPTIONS='-c lock_timeout=5s' "$CTR" "$@" >> "$LOG" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$termed" = 0 ] && [ "$(date -u +%s)" -ge "$stop_at" ]; then
      docker exec "$CTR" pkill -TERM -f -- "$pat" >/dev/null 2>&1
      termed=1; log "watchdog: TERM at the hard stop ($pat)"
    fi
    sleep 5
  done
  wait "$pid"; rc=$?
  return "$rc"
}

left="$(slot_minutes_left)"
if [ "$left" -le 5 ]; then
  log "REFUSED — outside the 18:30–02:15Z slot (minutes left $left)"
  echo 'LRW_RUNNER_VERDICT=REFUSED'; exit 1
fi

if [ -n "$annotate" ]; then
  # the pinned worklists go into the container's /tmp (private host; never the repo — they are figures)
  inside=""
  IFS=',' read -r -a files <<< "$annotate"
  for f in "${files[@]}"; do
    [ -s "$f" ] || { log "REFUSED — worklist $f missing"; echo 'LRW_RUNNER_VERDICT=REFUSED'; exit 1; }
    b="/tmp/lrw-$(basename "$f")"
    docker cp "$f" "$CTR:$b" || { log "INDETERMINATE — docker cp $f failed"; echo 'LRW_RUNNER_VERDICT=INDETERMINATE'; exit 3; }
    inside="${inside:+$inside,}$b"
  done
  log "ANNOTATE start files=$inside sha256=$(sha256sum "${files[@]}" | awk '{print $1}' | tr '\n' ' ') (the process refuses any unpinned file)"
  if [ -n "$cap" ] && [ "$cap" -lt "$left" ]; then left="$cap"; fi
  before=$(grep -c 'ANNOTATE DONE' "$LOG" 2>/dev/null); before=${before:-0}
  run_watched "$left" "backfill-directional-labels.js --annotate-gaps" \
    node dist/scripts/backfill-directional-labels.js --annotate-gaps "$inside" --time-budget-min "$((left - 3))"
  rc=$?
  after=$(grep -c 'ANNOTATE DONE' "$LOG" 2>/dev/null); after=${after:-0}
  done_line=$(grep 'ANNOTATE DONE' "$LOG" | tail -n 1)
  log "ANNOTATE exit=$rc"
  # THIS run's DONE line only (a new one appeared), and it must say the scan reached the end of the table
  if [ "$rc" -eq 0 ] && [ "$after" -gt "$before" ] && printf '%s' "$done_line" | grep -q '"outcome":"complete"'; then
    echo 'LRW_RUNNER_VERDICT=CONVERGED'; exit 0
  fi
  if [ "$after" -gt "$before" ]; then log "ANNOTATE not complete (resumable: NULL-only)"; echo 'LRW_RUNNER_VERDICT=SLOT_END'; exit 0; fi
  echo 'LRW_RUNNER_VERDICT=INDETERMINATE'; exit 3
fi

[ -n "$venue" ] || { echo '--venue or --annotate is required' >&2; echo 'LRW_RUNNER_VERDICT=REFUSED'; exit 2; }
flags=(--relabel-v2 --venue "$venue")
[ -n "$since" ] && flags+=(--since "$since")
[ -n "$rate" ] && flags+=(--max-req-per-min "$rate")
started=$(date -u +%s)
pass=1 err_waits=0
log "START venue=$venue since=${since:-none} cap=${cap:-none} rate=${rate:-default}"
while [ "$pass" -le "$MAX_PASSES" ]; do
  left="$(slot_minutes_left)"
  if [ -n "$cap" ]; then
    used=$(( ($(date -u +%s) - started) / 60 )); capleft=$((cap - used))
    [ "$capleft" -lt "$left" ] && left="$capleft"
  fi
  if [ "$left" -le 5 ]; then log "SLOT_END — stopping before 02:15Z / cap (resumable)"; echo 'LRW_RUNNER_VERDICT=SLOT_END'; exit 0; fi
  budget=$((left - 3))
  log "pass=$pass START budget=${budget}m"
  before=$(grep -c 'RELABEL DONE' "$LOG" 2>/dev/null); before=${before:-0}
  run_watched "$left" "--relabel-v2 --venue $venue --" node dist/scripts/backfill-directional-labels.js "${flags[@]}" --time-budget-min "$budget"
  rc=$?
  done_line=$(grep 'RELABEL DONE' "$LOG" | tail -n 1)
  after=$(grep -c 'RELABEL DONE' "$LOG" 2>/dev/null); after=${after:-0}
  if [ "$after" -le "$before" ]; then
    # no DONE line: the exec died (a deploy recreate, or the container is gone) — wait it out, never burn a pass
    err_waits=$((err_waits + 1))
    if [ "$err_waits" -gt "$ERR_WAITS_MAX" ]; then log "INDETERMINATE — no DONE after $ERR_WAITS_MAX waits (rc=$rc)"; echo 'LRW_RUNNER_VERDICT=INDETERMINATE'; exit 3; fi
    log "pass=$pass no DONE (rc=$rc) — waiting 90s for a healthy container (err_wait=$err_waits/$ERR_WAITS_MAX)"
    sleep 90
    continue
  fi
  state="$(pass_state "$done_line")"
  log "pass=$pass END state=$state ${done_line#*RELABEL DONE }"
  case "$state" in
    converged) log "CONVERGED"; echo 'LRW_RUNNER_VERDICT=CONVERGED'; exit 0 ;;
    stopped)
      # a deploy's SIGTERM checkpoint: not a pass; let the container be recreated before the next exec
      err_waits=$((err_waits + 1))
      if [ "$err_waits" -gt "$ERR_WAITS_MAX" ]; then log "INDETERMINATE — stopped $ERR_WAITS_MAX times"; echo 'LRW_RUNNER_VERDICT=INDETERMINATE'; exit 3; fi
      log "pass=$pass stopped (SIGTERM checkpoint) — waiting 90s, not counted"
      sleep 90
      continue ;;
  esac
  pass=$((pass + 1))
done
log "MAX_PASSES reached (resumable)"
echo 'LRW_RUNNER_VERDICT=MAX_PASSES'
exit 0
