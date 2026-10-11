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
# ── THE INTEGRAL (OPS-ALARM-OWNER-DERIVATION-W1 CH3, 2026-10-11) ─────────────────────────────────
# The window above holds 4 INSTANTS a day — each the median of 30 one-second `docker stats` reads —
# and it stood in for a 7-day mean. R0.7 measured the stand-in UNDER-reading that mean ~5×: point
# 28-mean 10.44 % vs the container's cgroup counter integral 46.05 % over 27.6 h (52.51 % over 7.84 h
# restart-aware, every UTC hour 38–61 %). Postgres CPU is bursty, and a median of short reads sits
# below the mean of a bursty process. So the persistent leg now decides on the INTEGRAL itself:
#  * every run appends `ts<TAB>usage_usec<TAB>started_at` (cgroup v2 cpu.stat, the container's start
#    instant) to $INTEGRAL_FILE — this script its only writer, atomic, trimmed by WALL time to 8 days;
#  * each consecutive pair is one covered segment — Δcounter on the same container; after a recreate
#    the new counter started at 0, so [started_at, ts] is kept and only the gap is lost, never guessed;
#    a counter that fell with no restart yields nothing;
#  * persistent = mean over the covered part of the trailing 7 days > INTEGRAL_PERSISTENT_PCT, and only
#    at >= INTEGRAL_COVERAGE_MIN_PCT coverage; below that it is INDETERMINATE (the full-window law, in
#    wall time). The point window keeps the trajectory leg, the peak, CRITICAL_BYPASS (inside the
#    autopilot), the log-only WARNING and the routing `case`, byte-identical; its 28-mean is compared to
#    BASELINE_PCT and REPORTED — it decides nothing.
#  * every run also asks the autopilot to record one pg_stat_statements snapshot (window attribution,
#    CH3 Req 4) — fail-open: logged, never a verdict change.
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
INTEGRAL_FILE="${PG_CPU_INTEGRAL_FILE:-/var/lib/algovault-monitoring/postgres-cpu-integral.tsv}"
CGROUP_ROOT="${PG_CPU_CGROUP_ROOT:-/sys/fs/cgroup/system.slice}"
# BASELINE_PCT is the POINT instrument's level: the `docker stats` median-of-30 at :47, calibrated at a
# point normal ≈ 5 % (≈ 7 % through Aug–Sep). Since OPS-ALARM-OWNER-DERIVATION-W1 CH3 the 28-instant
# mean is compared to it and REPORTED — it decides nothing (that instrument under-reads the 7-day mean
# ~5×, R0.7). Its value is unchanged on purpose: it is a level on THAT instrument, not on the mean.
BASELINE_PCT=10
THRESHOLD_PCT=$((BASELINE_PCT * 2))
# The persistent leg's level, on the INTEGRAL (the 7-day mean CPU, % of one core). PROVISIONAL: 2 × the
# integral normal R0.7 measured (46.05–52.51 % ⇒ 92–105, rounded); re-derived by
# OPS-POSTGRES-CPU-INTEGRAL-RECALIBRATE-W1 from >= 14 days of this script's own integral record.
# TODO: revisit by 2026-10-25 — `Claude files/defensive-reductions-to-revisit.md` row INTEGRAL_PERSISTENT_PCT.
INTEGRAL_PERSISTENT_PCT=100
INTEGRAL_PROVISIONAL_UNTIL=2026-10-25
INTEGRAL_WINDOW_S=$((7 * 86400))   # the persistent leg's window, in WALL time
INTEGRAL_KEEP_S=$((8 * 86400))     # the record keeps 8 days, trimmed by wall time
INTEGRAL_COVERAGE_MIN_PCT=70       # below this share of the 7 days covered, the persistent leg is INDETERMINATE
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
# The ONE definition of a valid INTEGRAL row — ts (epoch s) · usage_usec · started_at (RFC 3339, UTC) —
# shared by the writer and the evaluator the same way.
AWK_INT_ROW_VALID='function int_row_valid() { return NF == 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]([.][0-9]+)?Z$/ }'

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

# R0.7's instrument: the container's cumulative cgroup v2 CPU counter (cpu.stat usage_usec, the same
# number as the Docker API's cpu_usage.total_usage / 1000) and the instant the container started.
# Prints "<usage_usec><TAB><started_at>" or returns 1 — a failed read appends NOTHING to the record.
integral_read() {
  local id started usage
  id=$(docker inspect -f '{{.Id}}' "$CONTAINER" 2>/dev/null) || return 1
  started=$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null) || return 1
  [[ "$id" =~ ^[0-9a-f]{12,64}$ ]] || return 1
  usage=$(awk '$1 == "usage_usec" { print $2; exit }' "$CGROUP_ROOT/docker-$id.scope/cpu.stat" 2>/dev/null) || return 1
  # Judged by the ONE row predicate (behind a placeholder ts): a read the record would refuse is no read.
  printf '0\t%s\t%s\n' "$usage" "$started" | awk -F'\t' "$AWK_INT_ROW_VALID"' !int_row_valid() { exit 1 }' || return 1
  printf '%s\t%s\n' "$usage" "$started"
}

# Append one integral row; keep only valid rows from the last INTEGRAL_KEEP_S of WALL time. Temp file in
# the same directory + mv, exactly like the window: a reader never sees a partial record.
integral_append() {  # $1 ts (epoch s)  $2 usage_usec  $3 started_at
  local tmp="${INTEGRAL_FILE}.tmp.$$"
  mkdir -p "$(dirname "$INTEGRAL_FILE")" || return 1
  { if [ -f "$INTEGRAL_FILE" ]; then cat "$INTEGRAL_FILE"; fi; printf '%s\t%s\t%s\n' "$1" "$2" "$3"; } \
    | awk -F'\t' -v from="$(( $1 - INTEGRAL_KEEP_S ))" "$AWK_INT_ROW_VALID"' int_row_valid() && $1 >= from { print }' \
    > "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$INTEGRAL_FILE"
}

# PURE. The integral persistent leg over the trailing INTEGRAL_WINDOW_S of wall time ending at $2. Reads
# only the rows the shared predicate accepts; prints int_* key=value lines. A segment straddling the
# window's start is clipped, its CPU pro-rated over its own span. $3 overrides the level (self-test only).
PY_INTEGRAL_EVAL='
import sys
from datetime import datetime, timezone
now, window_s, cov_min, level = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
def epoch(iso):
    base, _, frac = iso.rstrip("Z").partition(".")
    t = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    return t + (float("0." + frac) if frac else 0.0)
rows = [(int(a), int(b), c) for a, b, c in (l.rstrip("\n").split("\t") for l in sys.stdin if l.strip())]
segs, restarts, lost, rejected = [], 0, 0.0, 0
for (t0, c0, s0), (t1, c1, s1) in zip(rows, rows[1:]):
    if t1 <= t0:
        rejected += 1
    elif s1 == s0:
        if c1 >= c0:
            segs.append((t0, t1, c1 - c0))
        else:
            rejected += 1                          # the counter fell with no restart: no segment
    else:
        st = epoch(s1)
        if t0 <= st <= t1:                         # recreated inside the interval: the new counter began at 0
            restarts += 1
            lost += st - t0
            segs.append((st, t1, c1))
        else:
            rejected += 1
start = now - window_s
covered = cpu = 0.0
for a, b, c in segs:
    lo, hi = max(a, start), min(b, now)
    if hi > lo:
        covered += hi - lo
        cpu += c * (hi - lo) / (b - a)
coverage = 100.0 * covered / window_s
mean = (cpu / 1e6) / covered * 100.0 if covered > 0 else None
since = None
if rows:
    t, c, s = rows[-1]
    if t > epoch(s):
        since = (c / 1e6) / (t - epoch(s)) * 100.0
if mean is None:
    verdict, reason = "INDETERMINATE", "no_segments"
elif coverage < cov_min:
    verdict, reason = "INDETERMINATE", "coverage_short"
elif mean > level:
    verdict, reason = "FAIL", "integral_above_level"
else:
    verdict, reason = "PASS", "integral_below_level"
fmt = lambda v, d: "" if v is None else ("%." + str(d) + "f") % v
print("int_rows=%d" % len(rows))
print("int_segments=%d" % len(segs))
print("int_restarts=%d" % restarts)
print("int_lost_s=%d" % round(lost))
print("int_rejected=%d" % rejected)
print("int_covered_s=%d" % round(covered))
print("int_coverage_pct=%.1f" % coverage)
print("int_mean_pct=" + fmt(mean, 2))
print("int_since_start_pct=" + fmt(since, 2))
print("int_started_at=" + (rows[-1][2] if rows else ""))
print("int_level_pct=%g" % level)
print("int_verdict=" + verdict)
print("int_reason=" + reason)
'
integral_eval() {  # $1 integral file (absent ⇒ empty)  $2 now (epoch s)  [$3 level %]
  local f="$1"
  [ -f "$f" ] || f=/dev/null
  awk -F'\t' "$AWK_INT_ROW_VALID"' int_row_valid() { print }' "$f" \
    | python3 -c "$PY_INTEGRAL_EVAL" "$2" "$INTEGRAL_WINDOW_S" "$INTEGRAL_COVERAGE_MIN_PCT" "${3:-$INTEGRAL_PERSISTENT_PCT}"
}

# PURE. The run's decision: the persistent leg from the INTEGRAL, the trajectory leg from the POINT
# window (window_eval, unchanged). The point window's own verdict and trigger are carried as point_*
# — reported, never decisive.
decide() {  # $1 window file  $2 integral file  $3 now (epoch s)
  local ev iv ptrig traj=0 ipers=0 trig verdict reason
  ev=$(window_eval "$1")
  iv=$(integral_eval "$2" "$3")
  ptrig=$(kv trigger "$ev")
  case "$ptrig" in *trajectory) traj=1 ;; esac
  if [ "$(kv int_verdict "$iv")" = FAIL ]; then ipers=1; fi
  if [ "$ipers" = 1 ] && [ "$traj" = 1 ]; then trig=persistent_AND_trajectory
  elif [ "$ipers" = 1 ]; then trig=persistent
  elif [ "$traj" = 1 ]; then trig=trajectory
  else trig=""; fi
  if [ -n "$trig" ]; then verdict=FAIL; reason=$trig
  elif [ "$(kv int_verdict "$iv")" = PASS ]; then verdict=PASS; reason=integral_below_level
  else verdict=INDETERMINATE; reason="integral_$(kv int_reason "$iv")"; fi
  printf '%s\n' "$ev" | sed 's/^/point_/'
  printf '%s\n' "$iv"
  printf 'trigger=%s\nverdict=%s\nreason=%s\n' "$trig" "$verdict" "$reason"
}

# PURE. The integral's mean (% of one core) over the trailing $3 seconds ending at $2, or empty when no
# segment covers any of it — the container CPU over an ATTRIBUTION window (CH3 post-GREEN ruling Q7).
integral_window_mean() {  # $1 integral file  $2 now (epoch s)  $3 window seconds
  local f="$1"
  [ -f "$f" ] || f=/dev/null
  awk -F'\t' "$AWK_INT_ROW_VALID"' int_row_valid() { print }' "$f" \
    | python3 -c "$PY_INTEGRAL_EVAL" "$2" "$3" 0 "$INTEGRAL_PERSISTENT_PCT" | sed -n 's/^int_mean_pct=//p'
}

# PURE. The routing case's framework-error page (its `*)` arm). It names the level that DECIDES
# persistence — the 7-day integral vs INTEGRAL_PERSISTENT_PCT, with its coverage — and labels the point
# 28-mean as reported only. (CH3 post-GREEN ruling Q6: it said "persistent fires at > BASELINE_PCT", a
# level that decides nothing since the integral took the persistent leg.)
framework_error_body() {  # $1 integral mean (empty = n/a)  $2 coverage %  $3 point mean  $4 point window n  $5 trigger
  local mean=n/a
  if [ -n "$1" ]; then mean="$1%"; fi
  printf '🛑 POSTGRES_CPU_DRIFT_UNIFIED [autopilot framework_error]\n\n7-day mean (integral, cgroup usage_usec, coverage %s%%): %s vs %s%% (provisional until %s) — persistent fires above it, only at >= %s%% coverage\n28-instant mean (point, docker stats median-of-30 @ :47): %s%% over %s samples vs %s%% (reported, decides nothing) · trigger=%s\n\nAction: dispatch OPS-POSTGRES-AUTOPILOT-UNIFIED-W{NEXT} via Cowork → Claude Code\nAudit shape: audits/OPS-POSTGRES-AUTOPILOT-UNIFIED-W1-endpoint-truth.md\n\nSnapshot log: %s\n' \
    "${2:-0}" "$mean" "$INTEGRAL_PERSISTENT_PCT" "$INTEGRAL_PROVISIONAL_UNTIL" "$INTEGRAL_COVERAGE_MIN_PCT" "$3" "$4" "$BASELINE_PCT" "$5" "$LOG"
}

# An RFC 3339 UTC instant (as the window stores it) → epoch seconds.
iso_epoch() {
  python3 -c 'import sys; from datetime import datetime, timezone; print(int(datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()))' "$1"
}

# Window attribution's store (CH3 Req 4): one pg_stat_statements snapshot per run, written by the
# autopilot. FAIL-OPEN — logged, never a verdict change.
record_pgss() {
  local out
  if [ ! -x "$MON_DIR/postgres-cpu-autopilot.py" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) PGSS_RECORD=failed reason=autopilot_missing" >> "$LOG" 2>/dev/null || true
    return 0
  fi
  out=$(python3 "$MON_DIR/postgres-cpu-autopilot.py" --record-pgss 2>&1 | tail -1) || true
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${out:-PGSS_RECORD=failed reason=no_output}" >> "$LOG" 2>/dev/null || true
  return 0
}

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
  local ts now ir obs median ev win avg peak recent first last trig verdict reason metrics
  local ptrig imean icov icovs irows irst isince iver irsn attr_from attr_label attr_cpu facts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  now=$(date +%s)
  # The integral row FIRST and unconditionally: a failed point read must not cost the record a row.
  if ir=$(integral_read); then
    integral_append "$now" "${ir%%$'\t'*}" "${ir#*$'\t'}" \
      || echo "$ts INTEGRAL_WRITE_FAILED file=$INTEGRAL_FILE" >> "$LOG"
  else
    echo "$ts INTEGRAL_READ_FAILED container=$CONTAINER" >> "$LOG"
  fi
  record_pgss
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

  ev=$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$now")
  win=$(kv point_window_n "$ev"); avg=$(kv point_avg "$ev"); peak=$(kv point_peak "$ev"); recent=$(kv point_recent "$ev")
  first=$(kv point_first_ts "$ev"); last=$(kv point_last_ts "$ev"); ptrig=$(kv point_trigger "$ev")
  trig=$(kv trigger "$ev"); verdict=$(kv verdict "$ev"); reason=$(kv reason "$ev")
  imean=$(kv int_mean_pct "$ev"); icov=$(kv int_coverage_pct "$ev"); icovs=$(kv int_covered_s "$ev")
  irows=$(kv int_rows "$ev"); irst=$(kv int_restarts "$ev"); isince=$(kv int_since_start_pct "$ev")
  iver=$(kv int_verdict "$ev"); irsn=$(kv int_reason "$ev")

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
    # Attribution covers the SAME wall-time window the firing leg used (CH3 Req 5): the trailing 7 days
    # for persistent, the last TRAJECTORY_N point samples for trajectory alone.
    case "$trig" in
      trajectory)
        attr_from=$(iso_epoch "$(tail -n "$TRAJECTORY_N" "$WINDOW_FILE" | head -1 | cut -f1)") \
          || attr_from=$((now - INTEGRAL_WINDOW_S))
        attr_label="the last ${TRAJECTORY_N} point samples" ;;
      *)
        attr_from=$((now - INTEGRAL_WINDOW_S))
        attr_label="the trailing 7 days" ;;
    esac
    attr_cpu=$(integral_window_mean "$INTEGRAL_FILE" "$now" "$((now - attr_from))")
    facts="{\"persistent_instrument\":\"integral\",\"attribution_cpu_pct\":${attr_cpu:-null},\"integral_mean\":${imean:-null},\"integral_coverage_pct\":${icov:-0},\"integral_persistent_pct\":${INTEGRAL_PERSISTENT_PCT},\"provisional_until\":\"${INTEGRAL_PROVISIONAL_UNTIL}\",\"point_mean\":${avg:-0},\"point_baseline_pct\":${BASELINE_PCT},\"attribution_from_s\":${attr_from},\"attribution_label\":\"${attr_label}\"}"
    if [ ! -x "$MON_DIR/postgres-cpu-autopilot.py" ]; then
      AUTOPILOT_OUT="autopilot.py missing or not executable"; AUTOPILOT_EXIT=3
    else
      set +e
      AUTOPILOT_OUT=$(PG_CPU_WINDOW_N="$win" PG_CPU_WINDOW_SPAN="${first}..${last}" PG_CPU_FACTS="$facts" \
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
      *) framework_error_body "$imean" "$icov" "$avg" "$win" "$trig" | "$MON_DIR/send_telegram.sh" "POSTGRES_CPU_DRIFT_UNIFIED" CRITICAL_PERSISTENT - ;;
    esac
  fi

  metrics="{\"persistent_instrument\":\"integral\",\"integral_persistent_pct\":${INTEGRAL_PERSISTENT_PCT},\"integral_provisional_until\":\"${INTEGRAL_PROVISIONAL_UNTIL}\",\"integral_mean\":${imean:-null},\"integral_coverage_pct\":${icov},\"integral_covered_s\":${icovs},\"integral_window_s\":${INTEGRAL_WINDOW_S},\"integral_rows\":${irows},\"integral_restarts\":${irst},\"integral_since_start_pct\":${isince:-null},\"integral_verdict\":\"${iver}\",\"integral_reason\":\"${irsn}\",\"point_mean\":${avg},\"point_baseline_pct\":${BASELINE_PCT},\"point_trigger\":\"${ptrig}\",\"point_decides\":false,\"window_n\":${win},\"window_required\":${WINDOW_N},\"avg\":${avg},\"peak\":${peak:-0},\"trigger\":\"${trig}\",\"reason\":\"${reason}\",\"first_ts\":\"${first}\",\"last_ts\":\"${last}\"}"
  finish "$verdict" "reason=${reason} persistent_instrument=integral integral_persistent_pct=${INTEGRAL_PERSISTENT_PCT} integral_mean=${imean:-n/a} coverage=${icov}% integral_rows=${irows} restarts=${irst} provisional_until=${INTEGRAL_PROVISIONAL_UNTIL} since_start_mean=${isince:-n/a} (context) point_mean=${avg} vs ${BASELINE_PCT} (reported, decides nothing) point_trigger=${ptrig:--} window_n=${win}/${WINDOW_N} peak=${peak:-0} span=${first}..${last} trigger=${trig:--}" "$metrics"
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
SELFTEST_EXPECTED=73

self_test() {
  local self tmp pass=0 fail=0 ev line got i s
  self="${BASH_SOURCE[0]}"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/pgcpu-selftest.XXXXXX") \
    || { echo "SELF-TEST: cannot create temp dir"; echo "POSTGRES_CPU_SNAPSHOT_SELFTEST_VERDICT=INDETERMINATE"; return 3; }
  trap "rm -rf '$tmp'" EXIT   # expanded NOW: $tmp is local and gone by the time EXIT fires
  LOG="$tmp/snapshot.log"; WINDOW_FILE="$tmp/state/window.tsv"; MON_DIR="$tmp/mon"
  INTEGRAL_FILE="$tmp/state/integral.tsv"; CGROUP_ROOT="$tmp/cgroup"
  export CANARY_RESULT_LOG_PATH="$tmp/canary-results.jsonl" ALGOVAULT_TG_TEST_INERT=1 DRY_RUN_TG=1
  # Isolation is asserted, not assumed: a self-test that can write the live window or the live
  # log is a production mutation wearing a test's clothes.
  for p in "$LOG" "$WINDOW_FILE" "$MON_DIR" "$CANARY_RESULT_LOG_PATH" "$INTEGRAL_FILE" "$CGROUP_ROOT"; do
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

  # ── THE INTEGRAL (OPS-ALARM-OWNER-DERIVATION-W1 CH3) ────────────────────────────────────────
  # int_fixture <file> <now> <hours> <pct> <mode> [<cgroup cpu.stat>] — integral rows at a 6 h cadence
  # over the <hours> ending at <now>, CPU at <pct> % of one core. Modes: steady (one container) ·
  # alternate (a recreate 3 h into every other interval — K19's deploy cadence) · collision (5 % base +
  # a 20-min 40 % burst from 06:31 daily). With a cpu.stat path it also writes the counter at <now> for
  # the stub cgroup (the run's own read) and prints the live container's started_at.
  int_fixture() {
    python3 - "$@" <<'PY'
import sys
from datetime import datetime, timezone
path, now, hours, pct, mode = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
cg = sys.argv[6] if len(sys.argv) > 6 else None
iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def burst(a, b):                     # seconds of the daily 06:31-06:51 burst inside [a, b]
    tot, day = 0, a - a % 86400
    while day < b:
        lo, hi = day + 6 * 3600 + 31 * 60, day + 6 * 3600 + 51 * 60
        tot += max(0, min(b, hi) - max(a, lo))
        day += 86400
    return tot
rate = pct / 100.0 * 1e6
first = now - hours * 3600
started = first - 3600
def counter(t, st):
    if mode == "collision":
        return int(0.05e6 * (t - st) + 0.35e6 * burst(st, t))
    return int(rate * (t - st))
rows, t, k = [], first, 0
while t < now:
    if mode == "alternate" and k % 2 == 1:
        started = t - 3 * 3600       # recreated 3 h into the interval ending at t
    rows.append("%d\t%d\t%s" % (t, counter(t, started), iso(started)))
    t += 6 * 3600
    k += 1
with open(path, "w") as f:
    f.write("\n".join(rows) + "\n")
if cg:
    with open(cg, "w") as f:
        f.write("usage_usec %d\nuser_usec 1\nsystem_usec 1\n" % counter(now, started))
    print(iso(started))
PY
  }
  ie() { integral_eval "$INTEGRAL_FILE" "$@"; }
  I0=1791000000   # a fixed instant, so the integral arithmetic below is exact

  # I1 — arithmetic: 1,800 s of CPU over 3,600 s on one container = 50.00 % of one core.
  printf '%s\t%s\t%s\n' "$I0" 1000000000 2026-10-01T00:00:00Z "$((I0 + 3600))" 2800000000 2026-10-01T00:00:00Z > "$INTEGRAL_FILE"
  ev=$(ie "$((I0 + 3600))")
  check "I1 Δcounter / Δwall in % of one core" "50.00/3600/1" "$(kv int_mean_pct "$ev")/$(kv int_covered_s "$ev")/$(kv int_segments "$ev")"
  # I2 — a recreate 3 h into a 6 h interval keeps [started_at, ts] and loses ONLY the gap.
  printf '%s\t%s\t%s\n' "$I0" 7000000000 2026-10-01T00:00:00Z "$((I0 + 21600))" 5400000000 \
    "$(python3 -c 'import sys; from datetime import datetime, timezone; print(datetime.fromtimestamp(int(sys.argv[1]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.123456789Z"))' "$((I0 + 10800))")" > "$INTEGRAL_FILE"
  ev=$(ie "$((I0 + 21600))")
  check "I2 restart: segment [started_at, ts], the new counter from 0" "50.00/10800/1/10800" \
    "$(kv int_mean_pct "$ev")/$(kv int_covered_s "$ev")/$(kv int_restarts "$ev")/$(kv int_lost_s "$ev")"
  # I3 — a counter that FELL with no restart yields no segment.
  printf '%s\t%s\t%s\n' "$I0" 9000000000 2026-10-01T00:00:00Z "$((I0 + 21600))" 8000000000 2026-10-01T00:00:00Z > "$INTEGRAL_FILE"
  ev=$(ie "$((I0 + 21600))")
  check "I3 decreasing counter, same container → no segment, INDETERMINATE" "0/1/INDETERMINATE/no_segments" \
    "$(kv int_segments "$ev")/$(kv int_rejected "$ev")/$(kv int_verdict "$ev")/$(kv int_reason "$ev")"
  # I4 — coverage below 70 % of the 7 days is INDETERMINATE, whatever the mean.
  int_fixture "$INTEGRAL_FILE" "$I0" 96 250 steady; printf '%s\t%s\t%s\n' "$I0" "$(( 250 * 10000 * (96 * 3600 + 3600) ))" "$(tail -1 "$INTEGRAL_FILE" | cut -f3)" >> "$INTEGRAL_FILE"
  ev=$(ie "$I0")
  check "I4 4 of 7 days covered → INDETERMINATE coverage_short (even at 250 %)" "57.1/INDETERMINATE/coverage_short" \
    "$(kv int_coverage_pct "$ev")/$(kv int_verdict "$ev")/$(kv int_reason "$ev")"
  # I5 — MEASURED-NORMAL replay: 7 days at R0.7's 50 % at full coverage is a PASS — not the page
  #      that halted this chapter (that page compared this number to the point level, 10).
  int_fixture "$INTEGRAL_FILE" "$I0" 168 50 steady; printf '%s\t%s\t%s\n' "$I0" "$(( 50 * 10000 * (168 * 3600 + 3600) ))" "$(tail -1 "$INTEGRAL_FILE" | cut -f3)" >> "$INTEGRAL_FILE"
  ev=$(ie "$I0")
  check "I5 measured normal 50 % over 7 d → PASS" "50.00/100.0/PASS" "$(kv int_mean_pct "$ev")/$(kv int_coverage_pct "$ev")/$(kv int_verdict "$ev")"
  # I6 — SUSTAINED replay: 7 days at 120 % → FAIL.
  int_fixture "$INTEGRAL_FILE" "$I0" 168 120 steady; printf '%s\t%s\t%s\n' "$I0" "$(( 120 * 10000 * (168 * 3600 + 3600) ))" "$(tail -1 "$INTEGRAL_FILE" | cut -f3)" >> "$INTEGRAL_FILE"
  ev=$(ie "$I0")
  check "I6 sustained 120 % over 7 d → FAIL" "120.00/FAIL/integral_above_level" "$(kv int_mean_pct "$ev")/$(kv int_verdict "$ev")/$(kv int_reason "$ev")"
  # I7 — RESTART replay: a recreate in every other 6 h interval for 7 days still reaches >= 70 %
  #      coverage and a verdict (each recreate loses only the gap before it).
  int_fixture "$INTEGRAL_FILE" "$I0" 168 50 alternate
  printf '%s\t%s\t%s\n' "$I0" "$(( 50 * 10000 * 3 * 3600 + 50 * 10000 * 6 * 3600 ))" "$(tail -1 "$INTEGRAL_FILE" | cut -f3)" >> "$INTEGRAL_FILE"
  ev=$(ie "$I0")
  check "I7 restart replay → 14 restarts, 75.0 % coverage, a verdict" "14/75.0/50.00/PASS" \
    "$(kv int_restarts "$ev")/$(kv int_coverage_pct "$ev")/$(kv int_mean_pct "$ev")/$(kv int_verdict "$ev")"
  # I8 — COLLISION replay: a 20-min 40 % burst from 06:31 on a 5 % base, point-sampled at 06:47 daily.
  #      The point 28-mean exceeds the point level (reported) while the integral PASSes and decides.
  local cnow; cnow=$(iso_epoch 2026-10-08T18:47:00Z)
  int_fixture "$INTEGRAL_FILE" "$cnow" 168 5 collision
  python3 - "$INTEGRAL_FILE" "$cnow" <<'PY'
import sys
path, now = sys.argv[1], int(sys.argv[2])
last = open(path).read().strip().split("\n")[-1].split("\t")   # same container as the last fixture row
open(path, "a").write("%d\t%d\t%s\n" % (now, int(last[1]) + int(0.05e6 * (now - int(last[0]))), last[2]))
PY
  seed "$(python3 - "$cnow" <<'PY'
import sys
from datetime import datetime, timezone
now = int(sys.argv[1])
for k in range(27, -1, -1):
    t = now - k * 21600
    d = datetime.fromtimestamp(t, timezone.utc)
    print(d.strftime("%Y-%m-%dT%H:%M:%SZ"), "40.00" if d.hour == 6 else "5.00")
PY
)"
  ev=$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$cnow")
  check "I8 collision: the point 28-mean crosses its level (reported)" "13.75/persistent" "$(kv point_avg "$ev")/$(kv point_trigger "$ev")"
  check "I8 collision: the integral decides — PASS, nothing fires" "5.49/PASS/" "$(kv int_mean_pct "$ev")/$(kv verdict "$ev")/$(kv trigger "$ev")"
  # I9 — decide(): persistent comes ONLY from the integral; trajectory ONLY from the point window.
  int_fixture "$INTEGRAL_FILE" "$I0" 168 120 steady; printf '%s\t%s\t%s\n' "$I0" "$(( 120 * 10000 * (168 * 3600 + 3600) ))" "$(tail -1 "$INTEGRAL_FILE" | cut -f3)" >> "$INTEGRAL_FILE"
  seed "$REAL_PRE_ROTATION"
  check "I9 integral FAIL + quiet point → persistent" "FAIL/persistent" "$(kv verdict "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")/$(kv trigger "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")"
  seed "$(printf '%s\n' "$REAL_PRE_ROTATION" | head -25)
2026-09-26T06:48:02Z 60.00
2026-09-26T12:48:02Z 70.00
2026-09-26T18:48:02Z 80.00"
  check "I9 integral FAIL + point trajectory → persistent_AND_trajectory" "persistent_AND_trajectory" "$(kv trigger "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")"
  rm -f "$INTEGRAL_FILE"
  check "I9 no integral + point trajectory → trajectory alone, still live" "FAIL/trajectory" "$(kv verdict "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")/$(kv trigger "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")"
  seed "$REAL_PRE_ROTATION"
  check "I9 no integral + quiet point → INDETERMINATE (bootstrap), never a pass" "INDETERMINATE/integral_no_segments" "$(kv verdict "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")/$(kv reason "$(decide "$WINDOW_FILE" "$INTEGRAL_FILE" "$I0")")"
  # I10 — the record: trimmed by WALL time to 8 days; junk rows never enter it.
  int_fixture "$INTEGRAL_FILE" "$I0" 216 50 steady
  printf 'garbage\n1\t2\n%s\tx\t2026-10-01T00:00:00Z\n' "$I0" >> "$INTEGRAL_FILE"
  integral_append "$I0" 999999999999 2026-09-01T00:00:00Z
  check "I10 trimmed to the last 8 days (+ the new row), junk dropped" "33/$((I0 - 192 * 3600))" \
    "$(wc -l < "$INTEGRAL_FILE" | tr -d ' ')/$(head -1 "$INTEGRAL_FILE" | cut -f1)"
  # S8 — observe(): failed reads are dropped, never persisted as 0.
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
# stub: mode file decides; counter file makes per-call behaviour deterministic
if [ "$1" = inspect ]; then          # the integral's two reads; a daemon that is down answers neither
  [ "$(cat "$STUB_DIR/mode")" = fail-all ] && exit 1
  case "$3" in '{{.Id}}') echo "$STUB_CID" ;; '{{.State.StartedAt}}') echo "$STUB_STARTED" ;; *) exit 1 ;; esac
  exit 0
fi
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

  # I11 — integral_read(): the cgroup counter + start instant, through the stub docker. A missing
  #       cpu.stat, or a daemon that answers nothing, is NO read — nothing is appended for it.
  export STUB_CID; STUB_CID=$(printf 'a%.0s' $(seq 1 64))
  export STUB_STARTED=2026-10-11T02:33:08.764526901Z
  mkdir -p "$CGROUP_ROOT/docker-$STUB_CID.scope"
  printf 'usage_usec 123456\nuser_usec 100\n' > "$CGROUP_ROOT/docker-$STUB_CID.scope/cpu.stat"
  echo steady > "$tmp/mode"
  check "I11 reads usage_usec + started_at" "123456	2026-10-11T02:33:08.764526901Z" "$(PATH="$tmp/bin:$PATH" integral_read)"
  echo fail-all > "$tmp/mode"
  check "I11 daemon down → no read" "1" "$(PATH="$tmp/bin:$PATH" integral_read >/dev/null 2>&1; echo $?)"
  echo steady > "$tmp/mode"; mv "$CGROUP_ROOT/docker-$STUB_CID.scope/cpu.stat" "$tmp/cpu.stat.away"
  check "I11 missing cpu.stat → no read" "1" "$(PATH="$tmp/bin:$PATH" integral_read >/dev/null 2>&1; echo $?)"
  mv "$tmp/cpu.stat.away" "$CGROUP_ROOT/docker-$STUB_CID.scope/cpu.stat"

  # I12 — the framework-error page names the DECIDING level (ruling Q6); the point level is reported only.
  got=$(framework_error_body 112.40 84.2 10.46 28 persistent | sed -n '3,4p')
  check "I12 framework-error page: integral decides, point reported" \
    "7-day mean (integral, cgroup usage_usec, coverage 84.2%): 112.40% vs 100% (provisional until 2026-10-25) — persistent fires above it, only at >= 70% coverage|28-instant mean (point, docker stats median-of-30 @ :47): 10.46% over 28 samples vs 10% (reported, decides nothing) · trigger=persistent" \
    "$(printf '%s' "$got" | paste -sd '|' -)"
  # I13 — the container CPU over an attribution window (ruling Q7): the 6 h tail of the 50 % fixture,
  #       and empty — never a guess — where no segment covers the window.
  int_fixture "$INTEGRAL_FILE" "$I0" 168 50 steady; printf '%s\t%s\t%s\n' "$I0" "$(( 50 * 10000 * (168 * 3600 + 3600) ))" "$(tail -1 "$INTEGRAL_FILE" | cut -f3)" >> "$INTEGRAL_FILE"
  check "I13 attribution-window CPU from the integral; none covered → empty" "50.00|" \
    "$(integral_window_mean "$INTEGRAL_FILE" "$I0" 21600)|$(integral_window_mean "$tmp/absent.tsv" "$I0" 21600)"

  # S9 — END TO END, as cron invokes it: this file as a child process, stub docker + autopilot +
  # wrapper + cgroup counter, every path in the sandbox. Asserts the ROUTING, the forensic line
  # format, the verdict token and the off-host record — and that the point window no longer pages.
  mkdir -p "$MON_DIR"
  cat > "$MON_DIR/postgres-cpu-autopilot.py" <<'STUB'
import os, sys
d = os.environ["STUB_DIR"]
if sys.argv[1:] == ["--record-pgss"]:
    open(d + "/pgss.calls", "a").write("record\n")
    print("PGSS_RECORD=ok file=stub")
    sys.exit(0)
with open(d + "/autopilot.calls", "a") as f:
    f.write(" ".join(sys.argv[1:]) + " | window_n=" + os.environ.get("PG_CPU_WINDOW_N", "") + "\n")
open(d + "/facts.calls", "a").write(os.environ.get("PG_CPU_FACTS", "") + "\n")
print("stub escalation body")
sys.exit(1)
STUB
  chmod +x "$MON_DIR/postgres-cpu-autopilot.py"
  printf '#!/usr/bin/env bash\necho "$1 $2 $(cat)" >> "$STUB_DIR/wrapper.calls"\n' > "$MON_DIR/send_telegram.sh"
  chmod +x "$MON_DIR/send_telegram.sh"
  if [ -f "$(dirname "$self")/canary_result_log.py" ]; then cp "$(dirname "$self")/canary_result_log.py" "$MON_DIR/"; fi
  run_main() {  # $1 docker mode  $2 stub value → rc line
    echo "$1" > "$tmp/mode"; rm -f "$tmp/count"
    set +e
    PATH="$tmp/bin:$PATH" STUB_VALUE="$2" PG_CPU_SAMPLE_INTERVAL_S=0 LOG_FILE_OVERRIDE="$LOG" \
      PG_CPU_WINDOW_FILE="$WINDOW_FILE" PG_CPU_MONITORING_DIR="$MON_DIR" \
      PG_CPU_INTEGRAL_FILE="$INTEGRAL_FILE" PG_CPU_CGROUP_ROOT="$CGROUP_ROOT" bash "$self" > "$tmp/main.out" 2>&1
    echo "rc=$?"
    set -e
  }
  stat_file="$CGROUP_ROOT/docker-$STUB_CID.scope/cpu.stat"
  rm -f "$tmp/pgss.calls"
  # (a) a real 7-day integral drift (120 %) → FAIL; the autopilot gets the point facts as before
  #     (CRITICAL_BYPASS stays on them) plus the integral facts in ENV; the wrapper gets the UNIFIED id.
  seed "$(i=0; while [ $i -lt 27 ]; do echo "2026-09-01T00:48:02Z 12.00"; i=$((i + 1)); done)"
  STUB_STARTED=$(int_fixture "$INTEGRAL_FILE" "$(date +%s)" 168 120 steady "$stat_file")
  rm -f "$tmp/autopilot.calls" "$tmp/facts.calls" "$tmp/wrapper.calls" "$LOG" "$CANARY_RESULT_LOG_PATH"
  check "S9a exit code" "rc=1" "$(run_main steady 12.00)"
  check "S9a token is the last line" "POSTGRES_CPU_SNAPSHOT_VERDICT=FAIL" "$(tail -1 "$tmp/main.out")"
  check "S9a autopilot invoked with the point facts, unchanged" \
    "--trigger persistent --avg 12.00 --peak 12.00 --recent-samples 12.00,12.00,12.00 | window_n=28" \
    "$(cat "$tmp/autopilot.calls" 2>/dev/null)"
  check "S9a ...and the integral facts + attribution window in ENV" "integral/100/the trailing 7 days" \
    "$(python3 -c 'import json,sys; f=json.loads(open(sys.argv[1]).read()); print("%s/%s/%s" % (f["persistent_instrument"], f["integral_persistent_pct"], f["attribution_label"]))' "$tmp/facts.calls" 2>/dev/null)"
  check "S9a wrapper got the unified alert" "POSTGRES_CPU_DRIFT_UNIFIED CRITICAL_PERSISTENT stub escalation body" \
    "$(cat "$tmp/wrapper.calls" 2>/dev/null)"
  check "S9a forensic sample line keeps the pre-fix format" "1" \
    "$(grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z [0-9]+(\.[0-9]+)?$' "$LOG")"
  check "S9a the run appended its own integral row" "29" "$(wc -l < "$INTEGRAL_FILE" | tr -d ' ')"
  if [ -f "$MON_DIR/canary_result_log.py" ]; then
    check "S9a off-host record names the deciding instrument" "1" \
      "$(grep -c '"canary":"postgres_cpu_snapshot","verdict":"FAIL".*"persistent_instrument":"integral","integral_persistent_pct":100' "$CANARY_RESULT_LOG_PATH" 2>/dev/null || true)"
  else
    check "S9a recorder absent → says so, positively" "1" "$(grep -c 'CANARY_RESULT_LOG_FAILED=import' "$LOG")"
  fi
  # (b) the 2026-09-27 shape at install: an empty window, an empty record and a 40 % spike →
  #     INDETERMINATE (bootstrap), NOTHING routed.
  rm -f "$WINDOW_FILE" "$INTEGRAL_FILE" "$tmp/autopilot.calls" "$tmp/wrapper.calls"
  check "S9b exit code" "rc=3" "$(run_main steady 40.00)"
  check "S9b token" "POSTGRES_CPU_SNAPSHOT_VERDICT=INDETERMINATE" "$(tail -1 "$tmp/main.out")"
  check "S9b autopilot NOT invoked" "absent" "$([ -f "$tmp/autopilot.calls" ] && echo present || echo absent)"
  check "S9b nothing reached the wrapper" "absent" "$([ -f "$tmp/wrapper.calls" ] && echo present || echo absent)"
  check "S9b the bootstrap says why" "1" "$(grep -c 'POSTGRES_CPU_SNAPSHOT_VERDICT=INDETERMINATE reason=integral_no_segments persistent_instrument=integral' "$LOG")"
  # (c) a measured-normal integral (50 %) + a healthy point window → PASS, nothing routed.
  seed "$REAL_PRE_ROTATION"
  STUB_STARTED=$(int_fixture "$INTEGRAL_FILE" "$(date +%s)" 168 50 steady "$stat_file")
  rm -f "$tmp/autopilot.calls" "$tmp/wrapper.calls" "$CANARY_RESULT_LOG_PATH"
  check "S9c exit code" "rc=0" "$(run_main steady 4.29)"
  check "S9c token" "POSTGRES_CPU_SNAPSHOT_VERDICT=PASS" "$(tail -1 "$tmp/main.out")"
  check "S9c autopilot NOT invoked" "absent" "$([ -f "$tmp/autopilot.calls" ] && echo present || echo absent)"
  if [ -f "$MON_DIR/canary_result_log.py" ]; then
    check "S9c the record carries both instruments, the point deciding nothing" "1" \
      "$(grep -c '"integral_verdict":"PASS".*"point_mean":[0-9.]*,"point_baseline_pct":10,.*"point_decides":false' "$CANARY_RESULT_LOG_PATH" 2>/dev/null || true)"
  else
    check "S9c (recorder absent — counted, not skipped)" "1" "1"
  fi
  # (d) docker down → SAMPLE_FAILED, the window AND the record untouched, INDETERMINATE.
  before=$(cat "$WINDOW_FILE"); ibefore=$(cat "$INTEGRAL_FILE")
  check "S9d exit code" "rc=3" "$(run_main fail-all 0)"
  check "S9d token" "POSTGRES_CPU_SNAPSHOT_VERDICT=INDETERMINATE" "$(tail -1 "$tmp/main.out")"
  check "S9d window untouched by a failed observation" "$before" "$(cat "$WINDOW_FILE")"
  check "S9d integral record untouched by a failed read" "$ibefore" "$(cat "$INTEGRAL_FILE")"
  check "S9d failures logged, not persisted as 0" "1/1" "$(grep -c 'SAMPLE_FAILED valid=0/30' "$LOG")/$(grep -c 'INTEGRAL_READ_FAILED' "$LOG")"
  # (e) THE POINT NO LONGER PAGES: a full point window over its level (12 > 10, the pre-wave
  #     persistent page) beside a measured-normal integral → PASS, nothing routed, the point reported.
  seed "$(i=0; while [ $i -lt 27 ]; do echo "2026-09-01T00:48:02Z 12.00"; i=$((i + 1)); done)"
  STUB_STARTED=$(int_fixture "$INTEGRAL_FILE" "$(date +%s)" 168 50 steady "$stat_file")
  rm -f "$tmp/autopilot.calls" "$tmp/wrapper.calls"
  check "S9e exit code" "rc=0" "$(run_main steady 12.00)"
  check "S9e autopilot NOT invoked" "absent" "$([ -f "$tmp/autopilot.calls" ] && echo present || echo absent)"
  check "S9e the point is reported, deciding nothing" "1" \
    "$(grep -c 'POSTGRES_CPU_SNAPSHOT_VERDICT=PASS reason=integral_below_level .*point_mean=12.00 vs 10 (reported, decides nothing) point_trigger=persistent' "$LOG")"
  # (f) every run asked the autopilot for a pg_stat_statements record, whatever docker did.
  check "S9f a pgss record was requested on every run" "5/5" \
    "$(wc -l < "$tmp/pgss.calls" | tr -d ' ')/$(grep -c 'PGSS_RECORD=ok file=stub' "$LOG")"

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
