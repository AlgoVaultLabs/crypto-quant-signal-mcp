#!/usr/bin/env bash
#
# /opt/algovault-monitoring/postgres-cpu-snapshot.sh
#
# OPS-POSTGRES-RECAUDIT-W1 (2026-05-22) — closes the silent-monitoring-drift
# gap that allowed postgres CPU to drift 33× over 22 days (1% → 33%) without
# any alert firing. Takes a postgres-CPU observation every 6h (4/day × 7d =
# 28 in the rolling window).
#
# OPS-MONITORING-TELEGRAM-INTEGRATION-W1 (2026-05-23) — wires the alert
# branches to /opt/algovault-monitoring/send_telegram.sh. Fires TG ONLY
# when conditions meet the operator-action-required contract (see
# Claude files/monitoring-runbook.md). Single-sample spikes log silently;
# only sustained drift and 3-consecutive-samples-over-50% trajectories alert.
#
# Schedule: this artifact's row in ops/monitoring/monitoring-inventory.json is the
# SoT (the daily reconciler asserts it against the live schedule) — not restated here.
#
# ── WINDOW INTEGRITY (OPS-POSTGRES-CPU-WINDOW-INTEGRITY-W1, 2026-09-29) ─────────────────────
# The "7-day rolling average" used to be `tail -28` of THIS SCRIPT'S OWN LOG, which logrotate
# truncates every Sunday (weekly, rotate 8). So after each rotation the "7-day" window silently
# held 1..28 samples, and one spike became a "sustained" average. Measured: the 2026-09-27T18:48Z
# sample (37.68), the 4th after a rotation, read as avg 13.52 over n=4 while the true trailing 28
# was 7.15 — and POSTGRES_CPU_DRIFT_UNIFIED escalated on five consecutive runs (13.52 / 11.68 /
# 10.94 / 10.46 / 10.01, n=4..9) against a true 28-sample average that never left 6.93–7.22 in
# 58 days of logged history. The trajectory condition always had an `n == 3` guard; the
# persistent condition never had the equivalent, which is the whole defect.
#
# Three rules now hold BY CONSTRUCTION, not by convention:
#  1. The window lives in its own STATE FILE ($WINDOW_FILE), never in a log. This script is its
#     only writer, logrotate has no stanza for it, and it self-trims to WINDOW_N valid rows
#     atomically. The log keeps its exact line format and is forensic only.
#  2. Only a VALID OBSERVATION enters the window: the median of >= SAMPLE_MIN_VALID successful
#     reads. A failed `docker stats` read is dropped — it used to be persisted as 0 (`|| echo 0`),
#     reading a hung daemon as "postgres idle" — and the WARNING line never enters the window
#     (it used to occupy a slot AND count as 0, damping the average exactly when drift was high).
#  3. The persistent condition exists ONLY over a FULL window. There is no code path that turns
#     fewer than WINDOW_N rows into a persistent verdict: a short window — after a DR restore, a
#     reseed, a deleted state file — is INDETERMINATE, never a fire and never a pass.
#
# Verdict: exactly one terminal POSTGRES_CPU_SNAPSHOT_VERDICT=PASS|FAIL|INDETERMINATE line per
# run, also written to the log and recorded to canary-results.jsonl (readable off-host).
# FAIL = a drift trigger fired and was routed to the autopilot. Exit 0 PASS · 1 FAIL ·
# 3 INDETERMINATE (token-law default for a new gate; cron reads none of them — the TOKEN is the
# verdict).
#
#   postgres-cpu-snapshot.sh                       # the cron invocation
#   postgres-cpu-snapshot.sh --self-test           # hermetic; touches no host path
#   postgres-cpu-snapshot.sh --seed-window <log>…  # one-time, human-invoked: seed an ABSENT
#                                                  # window from forensic logs (oldest first)
set -euo pipefail

LOG="${LOG_FILE_OVERRIDE:-/var/log/postgres-cpu-snapshot.log}"
WINDOW_FILE="${PG_CPU_WINDOW_FILE:-/var/lib/algovault-monitoring/postgres-cpu-window.tsv}"
MON_DIR="${PG_CPU_MONITORING_DIR:-/opt/algovault-monitoring}"
BASELINE_PCT=10
THRESHOLD_PCT=$((BASELINE_PCT * 2))
WINDOW_N=28            # 7 days × 4 observations/day. The persistent condition needs ALL of them.
TRAJECTORY_N=3
TRAJECTORY_PCT=50
SAMPLE_N=30
SAMPLE_MIN_VALID=20    # an observation is the median of >= 20 successful 1s reads, or nothing
CONTAINER=crypto-quant-signal-mcp-postgres-1
NUM_RE='^[0-9]+([.][0-9]+)?$'

# The ONE definition of a valid window row, shared by the writer and the evaluator so the two
# can never disagree about what the window contains.
AWK_ROW_VALID='function row_valid() { return NF == 2 && $1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/ && $2 ~ /^[0-9]+([.][0-9]+)?$/ }'

is_num() { [[ "$1" =~ $NUM_RE ]]; }

# One observation = the lower median of SAMPLE_N one-second `docker stats` reads. A failed or
# non-numeric read is DROPPED. Prints "<valid> <median>"; on fewer than SAMPLE_MIN_VALID valid
# reads prints "<valid>" alone and returns 1.
observe() {
  local vals="" valid=0 s i k
  for i in $(seq 1 "$SAMPLE_N"); do
    s=$(docker stats --no-stream --format '{{.CPUPerc}}' "$CONTAINER" 2>/dev/null | tr -d '%' || true)
    if is_num "$s"; then
      vals="${vals}${s}
"
      valid=$((valid + 1))
    fi
    if [ "$i" -lt "$SAMPLE_N" ]; then sleep "${PG_CPU_SAMPLE_INTERVAL_S:-1}"; fi
  done
  if [ "$valid" -lt "$SAMPLE_MIN_VALID" ]; then
    echo "$valid"
    return 1
  fi
  k=$(( (valid + 1) / 2 ))   # SAMPLE_N=30 → 15: the pre-fix `NR==15`, so a full read is unchanged
  echo "$valid $(printf '%s' "$vals" | sort -n | awk -v k="$k" 'NR==k{print; exit}')"
}

# Keep only valid rows, newest last, at most WINDOW_N of them. Pure filter over stdin.
window_trim() {
  awk -F'\t' "$AWK_ROW_VALID"' row_valid() { print }' | tail -n "$WINDOW_N"
}

# Append one observation to the window. Temp file in the SAME directory + mv, so a reader never
# sees a partial window and a failed write leaves the previous window intact.
window_append() {  # $1 ts  $2 value
  local tmp="${WINDOW_FILE}.tmp.$$"
  mkdir -p "$(dirname "$WINDOW_FILE")" || return 1
  { if [ -f "$WINDOW_FILE" ]; then cat "$WINDOW_FILE"; fi; printf '%s\t%s\n' "$1" "$2"; } \
    | window_trim > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$WINDOW_FILE"
}

# PURE. Evaluate a window file; prints key=value lines. `persistent` requires window_n == WINDOW_N
# and there is no other route to it. `avg` is still reported on a short window — so the log shows
# exactly what the pre-fix script would have fired on — but it decides nothing there.
window_eval() {  # $1 window file (absent ⇒ empty)
  local f="$1"
  [ -f "$f" ] || f=/dev/null
  awk -F'\t' -v N="$WINDOW_N" -v B="$BASELINE_PCT" -v TN="$TRAJECTORY_N" -v TP="$TRAJECTORY_PCT" \
    "$AWK_ROW_VALID"'
    row_valid() { n++; ts[n] = $1; raw[n] = $2 }
    END {
      s = (n > N) ? n - N + 1 : 1
      k = (n >= s) ? n - s + 1 : 0
      sum = 0; pk = -1; peak = ""
      for (i = s; i <= n; i++) { v = raw[i] + 0; sum += v; if (v > pk) { pk = v; peak = raw[i] } }
      avg = (k > 0) ? sprintf("%.2f", sum / k) : "0.00"
      lo = n - TN + 1; if (lo < s) lo = s
      recent = ""; tcount = 0; tover = 0
      for (i = lo; i <= n; i++) {
        recent = recent (recent == "" ? "" : ",") raw[i]
        tcount++; if (raw[i] + 0 > TP) tover++
      }
      full = (k >= N) ? 1 : 0
      persistent = (full && avg + 0 > B) ? 1 : 0
      trajectory = (tcount == TN && tover == TN) ? 1 : 0
      if (persistent && trajectory) trig = "persistent_AND_trajectory"
      else if (persistent) trig = "persistent"
      else if (trajectory) trig = "trajectory"
      else trig = ""
      if (trig != "") { verdict = "FAIL"; reason = trig }
      else if (full) { verdict = "PASS"; reason = "full_window_below_baseline" }
      else { verdict = "INDETERMINATE"; reason = "window_short" }
      printf "window_n=%d\navg=%s\npeak=%s\nrecent=%s\nfirst_ts=%s\nlast_ts=%s\ntrigger=%s\nverdict=%s\nreason=%s\n", \
        k, avg, peak, recent, (k > 0 ? ts[s] : ""), (k > 0 ? ts[n] : ""), trig, verdict, reason
    }' "$f"
}

kv() { printf '%s\n' "$2" | sed -n "s/^$1=//p" | head -1; }

# Structured record so the verdict is readable OFF-HOST. A recorder, never a gate: its failure
# cannot change the verdict, and it always leaves a POSITIVE line either way.
publish() {  # $1 verdict  $2 exit code  $3 metrics json
  python3 - "$MON_DIR" "$1" "$2" "$3" >> "$LOG" 2>&1 <<'PY' || echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) CANARY_RESULT_LOG_FAILED=python3" >> "$LOG" 2>/dev/null || true
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print("CANARY_RESULT_LOG_FAILED=import:" + type(e).__name__)
    raise SystemExit(0)
ok, detail = append_result("postgres_cpu_snapshot", sys.argv[2], int(sys.argv[3]), json.loads(sys.argv[4]))
print(("CANARY_RESULT_LOG=" if ok else "CANARY_RESULT_LOG_FAILED=") + detail)
PY
}

finish() {  # $1 verdict  $2 human detail  $3 metrics json
  local code=0
  case "$1" in FAIL) code=1 ;; INDETERMINATE) code=3 ;; esac
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) POSTGRES_CPU_SNAPSHOT_VERDICT=$1 $2" >> "$LOG" 2>/dev/null || true
  publish "$1" "$code" "$3"
  echo "postgres-cpu-snapshot: $2"
  echo "POSTGRES_CPU_SNAPSHOT_VERDICT=$1"
  return "$code"
}

main() {
  local ts obs median ev win avg peak recent first last trig verdict reason metrics
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if ! obs=$(observe); then
    echo "$ts SAMPLE_FAILED valid=${obs}/${SAMPLE_N}" >> "$LOG"
    finish INDETERMINATE "reason=sample_failed valid=${obs}/${SAMPLE_N} window=unchanged" \
      "{\"reason\":\"sample_failed\",\"valid_reads\":${obs:-0}}"
    return $?
  fi
  median=${obs#* }
  echo "$ts $median" >> "$LOG"   # forensic line, same format as every line before this wave
  if ! window_append "$ts" "$median"; then
    finish INDETERMINATE "reason=window_write_failed file=$WINDOW_FILE" "{\"reason\":\"window_write_failed\"}"
    return $?
  fi

  ev=$(window_eval "$WINDOW_FILE")
  win=$(kv window_n "$ev"); avg=$(kv avg "$ev"); peak=$(kv peak "$ev"); recent=$(kv recent "$ev")
  first=$(kv first_ts "$ev"); last=$(kv last_ts "$ev"); trig=$(kv trigger "$ev")
  verdict=$(kv verdict "$ev"); reason=$(kv reason "$ev")

  # WARNING (log-only) keeps its pre-fix wording, and is only meaningful over a full window.
  if [ "$win" -ge "$WINDOW_N" ] && awk -v a="$avg" -v t="$THRESHOLD_PCT" 'BEGIN{exit !(a > t)}'; then
    echo "POSTGRES_CPU_DRIFT WARNING ${ts}: 7d rolling avg ${avg}% > ${THRESHOLD_PCT}% (2× baseline ${BASELINE_PCT}%)" >&2
    echo "POSTGRES_CPU_DRIFT WARNING ${ts}: 7d rolling avg ${avg}% > ${THRESHOLD_PCT}% (2× baseline ${BASELINE_PCT}%)" >> "$LOG"
  fi

  # Unified Condition 1+2 routing (OPS-POSTGRES-AUTOPILOT-UNIFIED-W1): one invocation, one
  # POSTGRES_CPU_DRIFT_UNIFIED alert_id + 24h cooldown. The window facts ride in ENV, never as
  # new flags — an autopilot that predates them ignores env, whereas an unknown flag is an
  # argparse exit 2, which the case below would route as CRITICAL_BYPASS.
  if [ -n "$trig" ]; then
    if [ ! -x "$MON_DIR/postgres-cpu-autopilot.py" ]; then
      AUTOPILOT_OUT="autopilot.py missing or not executable"; AUTOPILOT_EXIT=3
    else
      set +e
      AUTOPILOT_OUT=$(PG_CPU_WINDOW_N="$win" PG_CPU_WINDOW_SPAN="${first}..${last}" \
                      python3 "$MON_DIR/postgres-cpu-autopilot.py" \
                        --trigger "$trig" \
                        --avg "$avg" --peak "${peak:-0}" --recent-samples "$recent" 2>&1)
      AUTOPILOT_EXIT=$?
      set -e
    fi
    case "$AUTOPILOT_EXIT" in
      0) : ;;
      1) echo "$AUTOPILOT_OUT" | "$MON_DIR/send_telegram.sh" "POSTGRES_CPU_DRIFT_UNIFIED" CRITICAL_PERSISTENT - ;;
      2) echo "CRITICAL_BYPASS: $AUTOPILOT_OUT" | "$MON_DIR/send_telegram.sh" "POSTGRES_CPU_DRIFT_CRITICAL_BYPASS" CRITICAL_PERSISTENT - ;;
      *) printf '🛑 POSTGRES_CPU_DRIFT_UNIFIED [autopilot framework_error]\n\nRolling avg: %s%% over a full %s-sample window, trigger=%s (persistent fires at > %s%%)\n\nAction: dispatch OPS-POSTGRES-AUTOPILOT-UNIFIED-W{NEXT} via Cowork → Claude Code\nAudit shape: audits/OPS-POSTGRES-AUTOPILOT-UNIFIED-W1-endpoint-truth.md\n\nSnapshot log: %s\n' "$avg" "$win" "$trig" "$BASELINE_PCT" "$LOG" | "$MON_DIR/send_telegram.sh" "POSTGRES_CPU_DRIFT_UNIFIED" CRITICAL_PERSISTENT - ;;
    esac
  fi

  metrics="{\"window_n\":${win},\"window_required\":${WINDOW_N},\"avg\":${avg},\"peak\":${peak:-0},\"trigger\":\"${trig}\",\"reason\":\"${reason}\",\"first_ts\":\"${first}\",\"last_ts\":\"${last}\"}"
  finish "$verdict" "reason=${reason} window_n=${win}/${WINDOW_N} avg=${avg} peak=${peak:-0} span=${first}..${last} trigger=${trig:--}" "$metrics"
}

# One-time, human-invoked: build an ABSENT window from forensic logs. Refuses to overwrite a
# window this script already owns — the state file is authoritative once it exists.
seed_window() {  # $@ log files, oldest first (plain or gzip)
  if [ -f "$WINDOW_FILE" ]; then
    echo "seed-window: REFUSED — $WINDOW_FILE exists; it is the window of record"
    echo "POSTGRES_CPU_SEED_WINDOW_VERDICT=FAIL"; return 1
  fi
  [ "$#" -gt 0 ] || { echo "seed-window: no log files given"; echo "POSTGRES_CPU_SEED_WINDOW_VERDICT=INDETERMINATE"; return 3; }
  local tmp="${WINDOW_FILE}.tmp.$$" n
  mkdir -p "$(dirname "$WINDOW_FILE")"
  gzip -dcf "$@" | awk '{ if (NF == 2) print $1 "\t" $2 }' | window_trim > "$tmp"
  n=$(wc -l < "$tmp" | tr -d ' ')
  mv -f "$tmp" "$WINDOW_FILE"
  echo "seed-window: wrote $n/$WINDOW_N valid rows to $WINDOW_FILE"
  window_eval "$WINDOW_FILE" | sed 's/^/seed-window: /'
  if [ "$n" -ge "$WINDOW_N" ]; then echo "POSTGRES_CPU_SEED_WINDOW_VERDICT=PASS"; return 0; fi
  echo "POSTGRES_CPU_SEED_WINDOW_VERDICT=INDETERMINATE"; return 3
}

# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────────
# Hermetic: every path is redirected into a fresh temp dir and asserted to be there BEFORE any
# scenario runs, `docker` / the autopilot / the wrapper are stubs, and the end-to-end scenarios
# run THIS FILE as a child process exactly as cron does. The regression fixture is the real
# 2026-09-20..29 sample history, verbatim.
REAL_PRE_ROTATION='2026-09-20T00:48:03Z 3.99
2026-09-20T06:48:02Z 4.88
2026-09-20T12:48:02Z 2.86
2026-09-20T18:48:02Z 10.97
2026-09-21T00:48:03Z 4.69
2026-09-21T06:48:02Z 4.87
2026-09-21T12:48:02Z 4.06
2026-09-21T18:48:02Z 22.22
2026-09-22T00:48:02Z 2.04
2026-09-22T06:48:03Z 2.13
2026-09-22T12:48:02Z 2.70
2026-09-22T18:48:02Z 10.29
2026-09-23T00:48:02Z 8.52
2026-09-23T06:48:03Z 6.44
2026-09-23T12:48:03Z 6.19
2026-09-23T18:48:03Z 10.17
2026-09-24T00:48:03Z 3.66
2026-09-24T06:48:02Z 4.75
2026-09-24T12:48:02Z 1.52
2026-09-24T18:48:02Z 10.14
2026-09-25T00:48:02Z 5.05
2026-09-25T06:48:02Z 7.22
2026-09-25T12:48:03Z 1.73
2026-09-25T18:48:02Z 9.20
2026-09-26T00:48:03Z 3.89
2026-09-26T06:48:02Z 7.55
2026-09-26T12:48:02Z 3.43
2026-09-26T18:48:02Z 3.72'
REAL_POST_ROTATION='2026-09-27T00:48:02Z 4.29
2026-09-27T06:48:03Z 6.14
2026-09-27T12:48:02Z 5.95
2026-09-27T18:48:02Z 37.68
2026-09-28T00:48:03Z 4.35
2026-09-28T06:48:03Z 7.24
2026-09-28T12:48:03Z 1.90
2026-09-28T18:48:02Z 16.11
2026-09-29T00:48:02Z 6.43'
SELFTEST_EXPECTED=45

self_test() {
  local self tmp pass=0 fail=0 ev line got i s
  self="${BASH_SOURCE[0]}"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/pgcpu-selftest.XXXXXX") \
    || { echo "SELF-TEST: cannot create temp dir"; echo "POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=INDETERMINATE"; return 3; }
  trap "rm -rf '$tmp'" EXIT   # expanded NOW: $tmp is local and gone by the time EXIT fires
  LOG="$tmp/snapshot.log"; WINDOW_FILE="$tmp/state/window.tsv"; MON_DIR="$tmp/mon"
  export CANARY_RESULT_LOG_PATH="$tmp/canary-results.jsonl" ALGOVAULT_TG_TEST_INERT=1 DRY_RUN_TG=1
  # Isolation is asserted, not assumed: a self-test that can write the live window or the live
  # log is a production mutation wearing a test's clothes.
  for p in "$LOG" "$WINDOW_FILE" "$MON_DIR" "$CANARY_RESULT_LOG_PATH"; do
    case "$p" in "$tmp"/*) ;; *) echo "SELF-TEST: path escaped the sandbox: $p"; echo "POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=INDETERMINATE"; return 3 ;; esac
  done

  check() {  # $1 description  $2 expected  $3 actual
    if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — expected [$2] got [$3]"; fi
  }
  seed() {  # $1 rows "ts value" → a fresh window file
    rm -f "$WINDOW_FILE"; mkdir -p "$(dirname "$WINDOW_FILE")"
    if [ -n "$1" ]; then printf '%s\n' "$1" | awk '{ print $1 "\t" $2 }' > "$WINDOW_FILE"; else : > "$WINDOW_FILE"; fi
  }

  # S1 — THE INCIDENT, with the fix: the state file is not rotated, so the window stays full and
  # every one of the nine post-rotation observations evaluates over 28 real samples.
  seed "$REAL_PRE_ROTATION"
  got=""
  while read -r line; do
    window_append "${line%% *}" "${line#* }"
    ev=$(window_eval "$WINDOW_FILE")
    got="$got$(kv verdict "$ev")/$(kv avg "$ev") "
  done <<EOF
$REAL_POST_ROTATION
EOF
  check "S1 incident replay: every run PASS over the true trailing 28" \
    "PASS/6.04 PASS/6.09 PASS/6.20 PASS/7.15 PASS/7.14 PASS/7.22 PASS/7.15 PASS/6.93 PASS/7.09 " "$got"
  check "S1 window stays exactly WINDOW_N rows" "28" "$(wc -l < "$WINDOW_FILE" | tr -d ' ')"

  # S2 — THE INCIDENT, as it happened: rotation empties the window. The pre-fix arithmetic still
  # runs (avg 13.52 at n=4, the number that paged) but decides nothing: no persistent trigger.
  seed ""
  got=""
  while read -r line; do
    window_append "${line%% *}" "${line#* }"
    ev=$(window_eval "$WINDOW_FILE")
    got="$got$(kv verdict "$ev")/$(kv window_n "$ev")/$(kv trigger "$ev") "
  done <<EOF
$REAL_POST_ROTATION
EOF
  check "S2 short window never fires (pre-fix fired at n=4,5,6,8,9)" \
    "INDETERMINATE/1/ INDETERMINATE/2/ INDETERMINATE/3/ INDETERMINATE/4/ INDETERMINATE/5/ INDETERMINATE/6/ INDETERMINATE/7/ INDETERMINATE/8/ INDETERMINATE/9/ " "$got"
  seed "$(printf '%s\n' "$REAL_POST_ROTATION" | head -4)"
  ev=$(window_eval "$WINDOW_FILE")
  check "S2 the paging number is still computed (13.52 at n=4)" "13.52" "$(kv avg "$ev")"
  check "S2 ...and still decides nothing" "window_short" "$(kv reason "$ev")"

  # S3 — REAL DRIFT STILL FIRES: the fix must not blind the alarm it protects.
  seed "$(i=0; while [ $i -lt 28 ]; do printf '2026-09-%02dT00:48:02Z 12.00\n' $((1 + i % 28)); i=$((i + 1)); done)"
  ev=$(window_eval "$WINDOW_FILE")
  check "S3 sustained 12% over a full window → FAIL" "FAIL" "$(kv verdict "$ev")"
  check "S3 → persistent" "persistent" "$(kv trigger "$ev")"
  check "S3 avg" "12.00" "$(kv avg "$ev")"

  # S4 — boundary: avg == baseline does not fire; 0.01 above does (pre-fix compared the %.2f avg).
  seed "$(i=0; while [ $i -lt 28 ]; do echo "2026-09-01T00:48:02Z 10.00"; i=$((i + 1)); done)"
  check "S4 avg == 10.00 → PASS" "PASS" "$(kv verdict "$(window_eval "$WINDOW_FILE")")"
  seed "$(i=0; while [ $i -lt 27 ]; do echo "2026-09-01T00:48:02Z 10.00"; i=$((i + 1)); done; echo "2026-09-02T00:48:02Z 10.28")"
  ev=$(window_eval "$WINDOW_FILE")
  check "S4 avg 10.01 → FAIL persistent" "FAIL/persistent/10.01" "$(kv verdict "$ev")/$(kv trigger "$ev")/$(kv avg "$ev")"

  # S5 — trajectory keeps its own n==3 guard and stays live on a short window.
  seed "2026-09-01T00:48:02Z 60.00
2026-09-01T06:48:02Z 70.00
2026-09-01T12:48:02Z 80.00"
  ev=$(window_eval "$WINDOW_FILE")
  check "S5 3 × >50% on a short window → trajectory" "FAIL/trajectory/3" "$(kv verdict "$ev")/$(kv trigger "$ev")/$(kv window_n "$ev")"
  seed "2026-09-01T00:48:02Z 90.00
2026-09-01T06:48:02Z 95.00"
  check "S5 two samples cannot make a trajectory" "INDETERMINATE" "$(kv verdict "$(window_eval "$WINDOW_FILE")")"
  seed "$(printf '%s\n' "$REAL_PRE_ROTATION" | head -25)
2026-09-26T06:48:02Z 60.00
2026-09-26T12:48:02Z 70.00
2026-09-26T18:48:02Z 80.00"
  ev=$(window_eval "$WINDOW_FILE")
  check "S5 both conditions → persistent_AND_trajectory" "persistent_AND_trajectory" "$(kv trigger "$ev")"
  check "S5 recent = last three, verbatim" "60.00,70.00,80.00" "$(kv recent "$ev")"
  check "S5 peak verbatim" "80.00" "$(kv peak "$ev")"

  # S6 — only valid rows exist in the window: a WARNING line, a blank, hex, a negative, an extra
  # field and a bad timestamp are all non-rows (the WARNING line used to be a zero).
  printf '%s\n' "2026-09-29T00:48:02Z	6.43" "POSTGRES_CPU_DRIFT WARNING 2026-09-29T00:48:02Z: 7d rolling avg 21.00%" "" \
    "2026-09-29T00:48:02Z	0x1" "2026-09-29T00:48:02Z	-5" "2026-09-29T00:48:02Z	1.0	extra" "garbage	5.0" > "$WINDOW_FILE"
  ev=$(window_eval "$WINDOW_FILE")
  check "S6 junk rows are not window rows" "1/6.43" "$(kv window_n "$ev")/$(kv avg "$ev")"
  window_append "2026-09-29T06:48:02Z" "7.00"
  check "S6 the writer drops them too (one shared predicate)" "2" "$(wc -l < "$WINDOW_FILE" | tr -d ' ')"
  rm -f "$WINDOW_FILE"
  check "S6 absent window → INDETERMINATE, n=0" "INDETERMINATE/0" "$(kv verdict "$(window_eval "$WINDOW_FILE")")/$(kv window_n "$(window_eval "$WINDOW_FILE")")"

  # S7 — trim: 30 appends keep exactly the newest 28.
  rm -f "$WINDOW_FILE"
  i=1; while [ $i -le 30 ]; do window_append "$(printf '2026-08-%02dT00:48:02Z' "$i")" "$i.00"; i=$((i + 1)); done
  check "S7 trimmed to WINDOW_N" "28" "$(wc -l < "$WINDOW_FILE" | tr -d ' ')"
  check "S7 oldest two dropped" "2026-08-03T00:48:02Z" "$(kv first_ts "$(window_eval "$WINDOW_FILE")")"

  # S8 — observe(): failed reads are dropped, never persisted as 0.
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
# stub: mode file decides; counter file makes per-call behaviour deterministic
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/count"
case "$(cat "$STUB_DIR/mode")" in
  steady)     echo "${STUB_VALUE:-12.34}%" ;;
  fail-half)  if [ $((n % 2)) -eq 0 ]; then exit 1; fi; echo "40.00%" ;;
  junk-5)     if [ "$n" -le 5 ]; then echo "--"; else echo "$n.00%"; fi ;;
  fail-all)   exit 1 ;;
esac
STUB
  chmod +x "$tmp/bin/docker"
  export STUB_DIR="$tmp"
  run_observe() {  # $1 mode → "rc|output"
    local out rc
    echo "$1" > "$tmp/mode"; rm -f "$tmp/count"
    set +e; out=$(PATH="$tmp/bin:$PATH" PG_CPU_SAMPLE_INTERVAL_S=0 observe); rc=$?; set -e
    echo "$rc|$out"
  }
  check "S8 30 valid reads → median of 30" "0|30 12.34" "$(run_observe steady)"
  check "S8 15/30 failed → no observation (was: fifteen zeros in the median)" "1|15" "$(run_observe fail-half)"
  check "S8 5 junk reads dropped, median of the 25 valid" "0|25 18.00" "$(run_observe junk-5)"
  check "S8 all reads failed → no observation" "1|0" "$(run_observe fail-all)"

  # S9 — END TO END, as cron invokes it: this file as a child process, stub docker + autopilot +
  # wrapper, every path in the sandbox. Asserts the ROUTING, the forensic line format, the
  # verdict token and the off-host record.
  mkdir -p "$MON_DIR"
  cat > "$MON_DIR/postgres-cpu-autopilot.py" <<'STUB'
import os, sys
with open(os.environ["STUB_DIR"] + "/autopilot.calls", "a") as f:
    f.write(" ".join(sys.argv[1:]) + " | window_n=" + os.environ.get("PG_CPU_WINDOW_N", "") + "\n")
print("stub escalation body")
sys.exit(1)
STUB
  chmod +x "$MON_DIR/postgres-cpu-autopilot.py"
  printf '#!/usr/bin/env bash\necho "$1 $2 $(cat)" >> "$STUB_DIR/wrapper.calls"\n' > "$MON_DIR/send_telegram.sh"
  chmod +x "$MON_DIR/send_telegram.sh"
  if [ -f "$(dirname "$self")/canary_result_log.py" ]; then cp "$(dirname "$self")/canary_result_log.py" "$MON_DIR/"; fi
  run_main() {  # $1 docker mode  $2 stub value → token line
    echo "$1" > "$tmp/mode"; rm -f "$tmp/count"
    set +e
    PATH="$tmp/bin:$PATH" STUB_VALUE="$2" PG_CPU_SAMPLE_INTERVAL_S=0 LOG_FILE_OVERRIDE="$LOG" \
      PG_CPU_WINDOW_FILE="$WINDOW_FILE" PG_CPU_MONITORING_DIR="$MON_DIR" bash "$self" > "$tmp/main.out" 2>&1
    echo "rc=$?"
    set -e
  }
  # (a) a full window of real drift → FAIL, autopilot called with persistent + window facts, the
  #     wrapper receives the UNIFIED alert id.
  seed "$(i=0; while [ $i -lt 27 ]; do echo "2026-09-01T00:48:02Z 12.00"; i=$((i + 1)); done)"
  rm -f "$tmp/autopilot.calls" "$tmp/wrapper.calls" "$LOG"
  check "S9a exit code" "rc=1" "$(run_main steady 12.00)"
  check "S9a token is the last line" "POSTGRES_CPU_SNAPSHOT_VERDICT=FAIL" "$(tail -1 "$tmp/main.out")"
  check "S9a autopilot invoked with the full-window facts" \
    "--trigger persistent --avg 12.00 --peak 12.00 --recent-samples 12.00,12.00,12.00 | window_n=28" \
    "$(cat "$tmp/autopilot.calls" 2>/dev/null)"
  check "S9a wrapper got the unified alert" "POSTGRES_CPU_DRIFT_UNIFIED CRITICAL_PERSISTENT stub escalation body" \
    "$(cat "$tmp/wrapper.calls" 2>/dev/null)"
  check "S9a forensic sample line keeps the pre-fix format" "1" \
    "$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z [0-9]+(\.[0-9]+)?$' "$LOG")"
  if [ -f "$MON_DIR/canary_result_log.py" ]; then
    check "S9a off-host record written" "1" "$(grep -c '"canary":"postgres_cpu_snapshot","verdict":"FAIL"' "$CANARY_RESULT_LOG_PATH" 2>/dev/null || echo 0)"
  else
    check "S9a recorder absent → says so, positively" "1" "$(grep -c 'CANARY_RESULT_LOG_FAILED=import' "$LOG")"
  fi
  # (b) the 2026-09-27 shape: an empty window and a 40% spike → INDETERMINATE, NOTHING routed.
  rm -f "$WINDOW_FILE" "$tmp/autopilot.calls" "$tmp/wrapper.calls"
  check "S9b exit code" "rc=3" "$(run_main steady 40.00)"
  check "S9b token" "POSTGRES_CPU_SNAPSHOT_VERDICT=INDETERMINATE" "$(tail -1 "$tmp/main.out")"
  check "S9b autopilot NOT invoked" "absent" "$([ -f "$tmp/autopilot.calls" ] && echo present || echo absent)"
  check "S9b nothing reached the wrapper" "absent" "$([ -f "$tmp/wrapper.calls" ] && echo present || echo absent)"
  # (c) a full healthy window → PASS, nothing routed.
  seed "$REAL_PRE_ROTATION"
  rm -f "$tmp/autopilot.calls" "$tmp/wrapper.calls"
  check "S9c exit code" "rc=0" "$(run_main steady 4.29)"
  check "S9c token" "POSTGRES_CPU_SNAPSHOT_VERDICT=PASS" "$(tail -1 "$tmp/main.out")"
  check "S9c autopilot NOT invoked" "absent" "$([ -f "$tmp/autopilot.calls" ] && echo present || echo absent)"
  # (d) docker down → SAMPLE_FAILED, window untouched, INDETERMINATE.
  before=$(cat "$WINDOW_FILE")
  check "S9d exit code" "rc=3" "$(run_main fail-all 0)"
  check "S9d token" "POSTGRES_CPU_SNAPSHOT_VERDICT=INDETERMINATE" "$(tail -1 "$tmp/main.out")"
  check "S9d window untouched by a failed observation" "$before" "$(cat "$WINDOW_FILE")"
  check "S9d failure logged, not persisted as 0" "1" "$(grep -c 'SAMPLE_FAILED valid=0/30' "$LOG")"

  # S10 — seed-window: builds an ABSENT window from logs, refuses to overwrite a live one.
  rm -f "$WINDOW_FILE"
  printf '%s\n' "$REAL_PRE_ROTATION" > "$tmp/log.1"
  printf '%s\nPOSTGRES_CPU_DRIFT WARNING junk line\n' "$REAL_POST_ROTATION" > "$tmp/log.0"
  gzip -c "$tmp/log.1" > "$tmp/log.1.gz"
  s=$(seed_window "$tmp/log.1.gz" "$tmp/log.0" | tail -1)
  check "S10 seed from rotated + current (gz and plain) → full window" "POSTGRES_CPU_SEED_WINDOW_VERDICT=PASS" "$s"
  check "S10 seeded window reproduces the true trailing 28" "7.09/2026-09-22T06:48:03Z" \
    "$(kv avg "$(window_eval "$WINDOW_FILE")")/$(kv first_ts "$(window_eval "$WINDOW_FILE")")"
  set +e; s=$(seed_window "$tmp/log.0" | tail -1); set -e
  check "S10 refuses to overwrite the window of record" "POSTGRES_CPU_SEED_WINDOW_VERDICT=FAIL" "$s"

  # S11 — the pre-fix shape must not come back: nothing may compute from the log's tail.
  check "S11 no window read from the log" "0" \
    "$(grep -vE '^[[:space:]]*#' "$self" | grep -cE 'tail -(n *)?[0-9]+ "?\$\{?LOG' || true)"

  # Vacuity: a scenario that silently did not run is not a pass.
  if [ $((pass + fail)) -ne "$SELFTEST_EXPECTED" ]; then
    echo "SELF-TEST: INDETERMINATE — ran $((pass + fail)) assertions, expected $SELFTEST_EXPECTED"
    echo "POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=INDETERMINATE"; return 3
  fi
  if [ "$fail" -gt 0 ]; then
    echo "SELF-TEST: FAIL ($fail of $((pass + fail)))"
    echo "POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=FAIL"; return 1
  fi
  echo "SELF-TEST: PASS ($pass assertions)"
  echo "POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=PASS"
}

case "${1:-}" in
  --self-test)   self_test ;;
  --seed-window) shift; seed_window "$@" ;;
  "")            main ;;
  *)             echo "usage: $0 [--self-test | --seed-window <log>...]" >&2; exit 3 ;;
esac
