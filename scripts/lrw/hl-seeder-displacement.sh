#!/usr/bin/env bash
# hl-seeder-displacement.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3, ruling LRW-Q17 rider 2: does HL's relabel take
# HL seeding capacity? Measured, not judged. Read-only over the HL seeders' own logs on signal-1.
#
#   hl-seeder-displacement.sh --window night|day --date <YYYY-MM-DD> --baseline <D1,D2,D3> [--logs <dir>]
#   hl-seeder-displacement.sh --self-test
#
# Throughput of a window = Σ seeded over the HL seed runs that ENDED inside it — each run's own summary line,
# "[<iso>] HL seed complete: <n> seeded, <n> skipped, <n> errors." in seed-hl.log and its rotations (*.gz read
# with gzip -dc). night = <date> 18:31Z → <date+1> 02:15Z · day = <date> 06:31Z → 17:45Z (the relabel's own slots).
# A displaced seeder waits or skips on the shared HL budget: its runs finish later (flock -n drops the next fire)
# or seed fewer assets — both lower the sum.
#
# The instrument (recorded with every number): the seeders' per-run summary lines. The budget's closed-window
# roll() lines are not used: they land in whichever process rolls the window — mostly the mcp-server, whose
# docker logs a container recreate destroys (the baseline nights' were gone by 2026-10-05), so a log-only
# comparison would set the subject against a baseline read through another instrument.
#
# Rule (LRW-Q17): subject < 0.90 × min(baseline) → DISPLACED. Prints exactly one HL_SEEDER_DISPLACEMENT line:
#   HL_SEEDER_DISPLACEMENT=<ratio> verdict=OK|DISPLACED floor=0.90 subject=<date>:<seeded>/<runs> baseline=<d:seeded/runs,…>
#   HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=<why> …
# and one HL_PACING=<240|464|464+day|UNKNOWN> line (the HL relabel units' own arguments). exit 0 OK ·
# 1 DISPLACED · 3 INDETERMINATE. INDETERMINATE is never OK: a window the logs do not cover, a baseline window with
# no run (a zero comparator approves everything), or a subject with no run (a seeder outage is not this rule's
# evidence) — each is named.
set -u
FLOOR_NUM=90 # percent

# next_day <YYYY-MM-DD> → the following date (GNU date on the host, BSD date on a Mac)
next_day() { date -u -d "$1 +1 day" +%F 2>/dev/null || date -u -j -v+1d -f %F "$1" +%F; }

# window_bounds night|day <date> → "<start iso> <end iso>" (second resolution, lexicographically comparable)
window_bounds() {
  case "$1" in
    night) echo "$2T18:31:00 $(next_day "$2")T02:15:00" ;;
    day) echo "$2T06:31:00 $2T17:45:00" ;;
    *) return 1 ;;
  esac
}

# the log stream, oldest first: rotations (.N.gz … .1) then the live file
log_stream() {
  local dir="$1" f n
  for n in 9 8 7 6 5 4 3 2; do f="$dir/seed-hl.log.$n.gz"; [ -f "$f" ] && gzip -dc "$f"; done
  [ -f "$dir/seed-hl.log.1" ] && cat "$dir/seed-hl.log.1"
  [ -f "$dir/seed-hl.log" ] && cat "$dir/seed-hl.log"
}

# measure <stream file> <start> <end> → "<seeded> <runs> <skipped> <errors> <first_ts> <last_ts>" (first/last over the
# whole stream, for the coverage test; '-' when the stream has no stamped line). skipped = the seeders' budget skips;
# errors = assets the seeder refused (mostly below HL's eligibility cut — market churn, not budget).
measure() {
  awk -v s="$2" -v e="$3" '
    match($0, /^\[[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) {
      ts = substr($0, 2, 19)
      if (first == "" || ts < first) first = ts
      if (ts > last) last = ts
      if (ts >= s && ts < e && $0 ~ /\] HL seed complete: [0-9]+ seeded,/) {
        x = $0; sub(/.*HL seed complete: /, "", x); split(x, a, /[ ,.]+/)
        seeded += a[1]; skipped += a[3]; errors += a[5]; runs++
      }
    }
    END { printf "%d %d %d %d %s %s\n", seeded, runs, skipped, errors, (first == "" ? "-" : first), (last == "" ? "-" : last) }' "$1"
}

# hl_pacing <ExecStart of the night unit> <day timer present: 0|1> → 240 | 464 | 464+day | UNKNOWN
hl_pacing() {
  local cap; cap="$(printf '%s' "$1" | grep -oE -- '--cap-min [0-9]+' | head -n 1 | awk '{print $2}')"
  case "$cap" in 240|464) ;; *) echo UNKNOWN; return ;; esac
  if [ "$2" = 1 ]; then echo "$cap+day"; else echo "$cap"; fi
}

# judge <window> <date> <baseline csv> <stream file> → the HL_SEEDER_DISPLACEMENT line; returns 0 / 1 / 3
judge() {
  local win="$1" date="$2" base="$3" stream="$4" b s e m seeded runs skipped errors first last min=-1 bl="" d ratio
  b="$(window_bounds "$win" "$date")" || { echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=bad-window:$win"; return 3; }
  s="${b% *}"; e="${b#* }"
  m="$(measure "$stream" "$s" "$e")"; read -r seeded runs skipped errors first last <<<"$m"
  if [ "$first" = "-" ] || [[ "$first" > "$s" ]] || [[ "$last" < "$e" ]]; then
    echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=logs-do-not-cover:$date span=$first..$last"; return 3
  fi
  if [ "$runs" -eq 0 ]; then echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=no-seed-run-in-subject:$date"; return 3; fi
  local subject="$date:$seeded/$runs" mix="skipped=$skipped errors=$errors"
  IFS=',' read -r -a days <<<"$base"
  [ "${#days[@]}" -ge 1 ] || { echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=no-baseline"; return 3; }
  for d in "${days[@]}"; do
    b="$(window_bounds "$win" "$d")" || { echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=bad-baseline-date:$d"; return 3; }
    m="$(measure "$stream" "${b% *}" "${b#* }")"; read -r seeded runs skipped errors first last <<<"$m"
    if [[ "$first" > "${b% *}" ]] || [[ "$last" < "${b#* }" ]]; then
      echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=logs-do-not-cover:$d span=$first..$last subject=$subject"; return 3
    fi
    if [ "$runs" -eq 0 ] || [ "$seeded" -eq 0 ]; then
      echo "HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=degenerate-baseline:$d:$seeded/$runs subject=$subject"; return 3
    fi
    bl="${bl:+$bl,}$d:$seeded/$runs:s$skipped:e$errors"
    if [ "$min" -lt 0 ] || [ "$seeded" -lt "$min" ]; then min="$seeded"; fi
  done
  seeded="${subject#*:}"; seeded="${seeded%/*}"
  ratio="$(awk -v a="$seeded" -v b="$min" 'BEGIN { printf "%.3f", a / b }')"
  if [ $((seeded * 100)) -lt $((FLOOR_NUM * min)) ]; then
    echo "HL_SEEDER_DISPLACEMENT=$ratio verdict=DISPLACED floor=0.$FLOOR_NUM subject=$subject $mix baseline=$bl"; return 1
  fi
  echo "HL_SEEDER_DISPLACEMENT=$ratio verdict=OK floor=0.$FLOOR_NUM subject=$subject $mix baseline=$bl"; return 0
}

self_test() {
  local ok=0 bad=0 tmp out rc want
  tmp="$(mktemp -d)"
  # a constructed corpus: four nights, the subject's sum chosen against the floor; a day; an uncovered date
  {
    echo '[2026-10-01T23:59:00.000Z] Starting 5m HL signal seed for 50 assets'
    for d in 2026-10-02 2026-10-03 2026-10-04; do
      echo "[${d}T18:30:59.999Z] HL seed complete: 900 seeded, 0 skipped, 0 errors."   # before the window: excluded
      echo "[${d}T18:31:00.000Z] HL seed complete: 50 seeded, 0 skipped, 1 errors."
      echo "[${d}T23:00:00.000Z] HL seed complete: 50 seeded, 2 skipped, 1 errors."
    done
    echo '[2026-10-03T02:14:59.000Z] HL seed complete: 0 seeded, 50 skipped, 0 errors.'  # inside night 10-02
    echo '[2026-10-03T02:15:00.000Z] HL seed complete: 900 seeded, 0 skipped, 0 errors.' # the end is exclusive
    echo '[2026-10-04T06:31:00.000Z] HL seed complete: 40 seeded, 0 skipped, 0 errors.'  # a day window
    echo '[2026-10-05T18:31:00.000Z] HL seed complete: 45 seeded, 0 skipped, 0 errors.'  # subject: 45+X vs min 100
    echo '[2026-10-05T19:00:00.000Z] HL seed complete: 45 seeded, 0 skipped, 0 errors.'
    echo '[2026-10-06T02:16:00.000Z] HL seed complete: 1 seeded, 0 skipped, 0 errors.'
  } > "$tmp/ok.log"
  check() { # <want rc> <want substring> <label> <judge args…>
    want="$1" sub="$2" label="$3"; shift 3
    out="$(judge "$@")"; rc=$?
    if [ "$rc" = "$want" ] && grep -qF -- "$sub" <<<"$out"; then ok=$((ok + 1)); else bad=$((bad + 1)); echo "SELF-TEST: FAIL $label: rc=$rc out=$out"; fi
  }
  # subject 90/2 vs min(100,100,100): 0.900 → OK at the floor exactly
  check 0 "verdict=OK" "at-floor-ok" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/ok.log"
  check 0 "baseline=2026-10-02:100/3:s52:e2,2026-10-03:100/2:s2:e2,2026-10-04:100/2:s2:e2" "window-membership" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/ok.log"
  check 0 "subject=2026-10-05:90/2 skipped=0 errors=0" "subject-sum" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/ok.log"
  # one seeded fewer → 89/100 → DISPLACED
  sed 's/^\[2026-10-05T19:00:00.000Z\] HL seed complete: 45/[2026-10-05T19:00:00.000Z] HL seed complete: 44/' "$tmp/ok.log" > "$tmp/low.log"
  check 1 "verdict=DISPLACED" "below-floor" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/low.log"
  check 1 "HL_SEEDER_DISPLACEMENT=0.890 " "ratio-printed" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/low.log"
  # a baseline window with no run → INDETERMINATE (a zero comparator approves everything), never OK
  grep -v '^\[2026-10-03T' "$tmp/ok.log" | grep -v '^\[2026-10-04T06' > "$tmp/gap.log"
  check 3 "reason=degenerate-baseline:2026-10-03" "zero-baseline" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/gap.log"
  # a subject the logs do not reach yet → INDETERMINATE
  check 3 "reason=logs-do-not-cover:2026-10-06" "uncovered-subject" night 2026-10-06 2026-10-02,2026-10-03,2026-10-04 "$tmp/ok.log"
  # rotated away: the first stamped line is after the baseline window → INDETERMINATE
  grep -v '^\[2026-10-0[12]' "$tmp/ok.log" > "$tmp/rot.log"
  check 3 "reason=logs-do-not-cover:2026-10-02" "rotated-baseline" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/rot.log"
  # a covered subject with no run → INDETERMINATE (an outage is not displacement evidence)
  grep -v '^\[2026-10-05T' "$tmp/ok.log" > "$tmp/out.log"
  check 3 "reason=no-seed-run-in-subject:2026-10-05" "subject-outage" night 2026-10-05 2026-10-02,2026-10-03,2026-10-04 "$tmp/out.log"
  # the day window: 06:31–17:45Z
  check 0 "subject=2026-10-04:40/1" "day-window" day 2026-10-04 2026-10-04 "$tmp/ok.log"
  # HL_PACING from the unit's own arguments
  local p
  for p in "240|0|/bin/bash /opt/lrw/lrw-relabel-runner.sh --venue HL --rate 10 --cap-min 240" \
           "464|0|/bin/bash /opt/lrw/lrw-relabel-runner.sh --venue HL --rate 10 --cap-min 464 --order depth-deadline" \
           "464+day|1|x --cap-min 464" "UNKNOWN|0|x --cap-min 300" "UNKNOWN|0|"; do
    want="${p%%|*}"; out="$(hl_pacing "${p#*|*|}" "$(cut -d'|' -f2 <<<"$p")")"
    if [ "$out" = "$want" ]; then ok=$((ok + 1)); else bad=$((bad + 1)); echo "SELF-TEST: FAIL hl_pacing: got $out want $want"; fi
  done
  # gz rotations are read, oldest first
  mkdir -p "$tmp/logs"; head -n 4 "$tmp/ok.log" | gzip -c > "$tmp/logs/seed-hl.log.2.gz"; tail -n +5 "$tmp/ok.log" > "$tmp/logs/seed-hl.log"
  if [ "$(log_stream "$tmp/logs" | grep -c .)" = "$(grep -c . "$tmp/ok.log")" ] && [ "$(log_stream "$tmp/logs" | head -n 1)" = "$(head -n 1 "$tmp/ok.log")" ]; then ok=$((ok + 1))
  else bad=$((bad + 1)); echo 'SELF-TEST: FAIL log_stream does not read the rotations oldest first'; fi
  rm -rf "$tmp"
  [ "$ok" -ge 1 ] || { echo 'HL_DISPLACEMENT_SELFTEST: FAIL (vacuous: no check ran)'; exit 1; }
  if [ "$bad" -eq 0 ] && [ "$ok" -ge 16 ]; then echo "HL_DISPLACEMENT_SELFTEST: PASS ($ok checks)"; exit 0; fi
  echo "HL_DISPLACEMENT_SELFTEST: FAIL ($bad of $((ok + bad)))"; exit 1
}

[ "${1:-}" = --self-test ] && self_test

win="" date="" base="" dir=/var/log
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "$1 needs a value" >&2; echo 'HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=usage'; exit 3; }
  case "$1" in
    --window) win="$2" ;;
    --date) date="$2" ;;
    --baseline) base="$2" ;;
    --logs) dir="$2" ;;
    *) echo "unknown argument $1" >&2; echo 'HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=usage'; exit 3 ;;
  esac
  shift 2
done
[ -n "$win" ] && [ -n "$date" ] && [ -n "$base" ] || { echo 'HL_SEEDER_DISPLACEMENT=INDETERMINATE reason=usage (--window --date --baseline)'; exit 3; }

execstart="$(systemctl show lrw-relabel-HL.service -p ExecStart --value 2>/dev/null)"
daytimer=0; systemctl cat lrw-relabel-HL-day.timer >/dev/null 2>&1 && daytimer=1
echo "HL_PACING=$(hl_pacing "$execstart" "$daytimer")"
stream="$(mktemp)"; trap 'rm -f "$stream"' EXIT
log_stream "$dir" > "$stream"
echo "instrument=seed-hl.log* 'HL seed complete' lines, $(grep -c 'HL seed complete' "$stream") in the stream"
judge "$win" "$date" "$base" "$stream"
exit $?
