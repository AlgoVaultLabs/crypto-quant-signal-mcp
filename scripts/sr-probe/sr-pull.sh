#!/usr/bin/env bash
# sr-pull.sh — EDGE-SR-LEVEL-PROBE-W1: the probe's two READ-ONLY sessions against signal-1, in ADS-1's form.
#
#   bash scripts/sr-probe/sr-pull.sh --part labelfree --out <dir>                       # CH1: no label, no outcome column
#   bash scripts/sr-probe/sr-pull.sh --part labels    --out <dir> --registration <sha>  # CH2: label + ambiguous flag
#   bash scripts/sr-probe/sr-pull.sh --self-test
#
# Channel: ssh → docker exec -i <postgres> psql -U aoe_readonly, one BEGIN READ ONLY per part, the token line first.
# The statements are the generator's (src/scripts/sr-probe/sr-extract-sql.ts), never typed here.
#
# Run conditions, each printed; the first false one is a WAIT (exit 3), never a failure:
#   · clock inside 06:30–17:45Z            · no labeller / relabel runner alive on signal-1 (LRW's WRITER_PATTERN)
#   · --out is OUTSIDE the repository (the extracts are private; the repo is public)
#   · part `labels` only: <sha> is an ancestor of origin/main, it ADDS audits/sr-level-probe-preregistration-*.md,
#     and its commit time is before this pull. The label read cannot precede the registration.
#
# Output: <dir>/coverage.csv + extract.csv (labelfree) or labels.csv (labels), and <dir>/pull-<part>.json with the
# sha256 of every file, of the session script, the row counts and the pull's own UTC clock.
# One terminal line: SR_PULL_VERDICT=PASS|FAIL|INDETERMINATE (exit 0 / 1 / 3). Callers gate on the TOKEN.
set -uo pipefail

HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
PG_CTR='crypto-quant-signal-mcp-postgres-1'
RO_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'
WINDOW_MIN=390   # 06:30Z
WINDOW_MAX=1065  # 17:45Z
REG_GLOB_RE='^audits/sr-level-probe-preregistration-[0-9-]+\.md$'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LRW_PULL="$HERE/../lrw/lrw-pull.sh"

log() { echo "[sr-pull] $*" >&2; }
wait_line() { echo "SR_PULL_WAIT: $1"; return 3; }

# in_window <minutes since 00:00Z> → 0 iff inside [06:30, 17:45)
in_window() { [ "$1" -ge "$WINDOW_MIN" ] && [ "$1" -lt "$WINDOW_MAX" ]; }

# decide <tokens> <order> <files> → the verdict line, returns its code.
#   tokens: ok|fail|ind   order: ok|na|fail|ind (na = the label-free part, which has no order to prove)   files: ok|empty|ind
decide() {
  local tokens="$1" order="$2" files="$3" red="" ind=""
  case "$tokens" in ok) ;; fail) red="$red token-not-read-only" ;; *) ind="$ind tokens" ;; esac
  case "$order" in ok | na) ;; fail) red="$red label-read-before-registration" ;; *) ind="$ind order" ;; esac
  case "$files" in ok) ;; empty) ind="$ind empty-corpus" ;; *) ind="$ind outputs" ;; esac
  if [ -n "$red" ]; then log "FAIL:$red"; echo 'SR_PULL_VERDICT=FAIL'; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo 'SR_PULL_VERDICT=INDETERMINATE'; return 3; fi
  echo 'SR_PULL_VERDICT=PASS'; return 0
}

# token_state <raw-file> → ok | fail | ind   (the FIRST line must be the read-only token; an empty file is ind)
token_state() {
  [ -s "$1" ] || { echo ind; return; }
  local first; first="$(head -n 1 "$1")"
  case "$first" in
    "$RO_TOKEN") echo ok ;;
    TOKEN\ *) echo fail ;;
    *) echo ind ;;
  esac
}

# section <raw-file> <NAME> → the lines between ===NAME=== and the next ===…=== marker (or EOF)
section() {
  awk -v want="===$2===" '
    /^===[A-Z]+===$/ { on = ($0 == want); next }
    on { print }' "$1"
}

# files_state <header-csv> <file> → ok | empty | ind   (header must match exactly; a header-only file is empty)
files_state() {
  [ -s "$2" ] || { echo ind; return; }
  [ "$(head -n 1 "$2")" = "$1" ] || { echo ind; return; }
  [ "$(awk 'END { print NR }' "$2")" -ge 2 ] && echo ok || echo empty
}

sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
lrw_writer_pattern() { (. "$LRW_PULL" && printf '%s' "$WRITER_PATTERN"); }
gen() { npx --no-install tsx src/scripts/sr-probe/sr-extract-sql.ts --part "$1"; }

# adds_registration <sha> → yes | no : the commit ADDS a registration file
adds_registration() {
  git show --name-only --diff-filter=A --format= "$1" 2>/dev/null | grep -Eq "$REG_GLOB_RE" && echo yes || echo no
}

run_pull() {
  local part="" out="" reg=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || { log "$1 needs a value"; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
    case "$1" in
      --part) part="$2" ;;
      --out) out="$2" ;;
      --registration) reg="$2" ;;
      *) log "unknown argument $1"; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3 ;;
    esac
    shift 2
  done
  case "$part" in labelfree | labels) ;; *) log '--part labelfree|labels is required'; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3 ;; esac
  [ -n "$out" ] || { log '--out is required'; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local t
  for t in ssh git awk shasum npx; do
    command -v "$t" >/dev/null 2>&1 || { log "required tool '$t' not on PATH"; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  done
  local root; root="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" || { echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  cd "$root" || { echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  mkdir -p "$out" || { log "cannot create $out"; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local out_abs; out_abs="$(cd "$out" && pwd -P)"
  case "$out_abs/" in "$(pwd -P)/"*) wait_line "out-dir-inside-the-repository($out_abs)"; exit 3 ;; esac
  log "run conditions at $(date -u +%FT%TZ):"
  local hm; hm=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))
  in_window "$hm" || { wait_line "outside-06:30-17:45Z($(date -u +%H:%M)Z)"; exit 3; }
  log '  clock inside 06:30–17:45Z — yes'
  [ -r "$LRW_PULL" ] || { log "$LRW_PULL missing"; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local pat alive; pat="$(lrw_writer_pattern)"
  [ -n "$pat" ] || { log 'empty WRITER_PATTERN'; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  alive="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" "pgrep -fc '$pat' || true" 2>/dev/null)" || { echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  [ "$alive" = 0 ] || { wait_line "label-writer-alive($alive)"; exit 3; }
  log '  no label writer alive on signal-1 — yes'

  local start_s order='na' reg_ts=''; start_s="$(date -u +%s)"
  if [ "$part" = labels ]; then
    [ -n "$reg" ] || { wait_line 'labels-part-needs---registration'; exit 3; }
    git fetch origin --quiet 2>/dev/null || { wait_line 'git-fetch-failed'; exit 3; }
    git merge-base --is-ancestor "$reg" origin/main 2>/dev/null || { wait_line "registration-not-on-origin-main($reg)"; exit 3; }
    [ "$(adds_registration "$reg")" = yes ] || { wait_line "commit-does-not-add-a-registration($reg)"; exit 3; }
    git ls-tree --name-only origin/main audits/ | grep -q 'sr-level-probe-preregistration-' || { wait_line 'registration-file-not-on-origin-main'; exit 3; }
    reg_ts="$(git log -1 --format=%ct "$reg" 2>/dev/null)"
    if [ -n "$reg_ts" ] && [ "$reg_ts" -lt "$start_s" ]; then order='ok'; else order='fail'; fi
    log "  registration $reg @ ${reg_ts:-?} on origin/main, before the pull @ $start_s — $order"
    [ "$order" = ok ] || { decide ok "$order" ok; exit $?; }
  fi

  local raw="$out_abs/session-$part.raw" script="$out_abs/session-$part.sql"
  gen "$part" > "$script" || { log 'the generator failed'; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  [ -s "$script" ] || { log 'the generator printed nothing'; echo 'SR_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local pull_at; pull_at="$(date -u +%FT%TZ)"
  ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
    "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q" < "$script" > "$raw"
  local rc=$? tokens files='ok' f st
  tokens="$(token_state "$raw")"
  [ "$rc" -eq 0 ] || { log "session exit $rc"; [ "$tokens" = fail ] || tokens='ind'; }
  local -a names headers
  if [ "$part" = labelfree ]; then
    names=(COVERAGE EXTRACT); headers=('exchange,timeframe,registered,v1_present,v2_present,v2_post_adapter' 'id,created_at,exchange,coin,timeframe,side,entry,rule_config_id,barrier_pct,low_vol_history')
  else
    names=(LABELS); headers=('signal_id,label,ambiguous_candle,barrier_spec')
  fi
  local i meta="$out_abs/pull-$part.json" rows
  {
    printf '{\n  "part": "%s",\n  "pull_at": "%s",\n  "pull_at_epoch": %s,\n  "session_sql_sha256": "%s",\n' "$part" "$pull_at" "$start_s" "$(sha "$script")"
    printf '  "registration_commit": "%s",\n  "registration_commit_epoch": %s,\n  "files": {' "$reg" "${reg_ts:-null}"
  } > "$meta"
  for i in "${!names[@]}"; do
    f="$out_abs/$(printf '%s' "${names[$i]}" | tr 'A-Z' 'a-z').csv"
    section "$raw" "${names[$i]}" > "$f"
    st="$(files_state "${headers[$i]}" "$f")"
    rows=$(($(awk 'END { print NR }' "$f") - 1))
    log "  ${names[$i]}: $rows rows — $st"
    [ "$st" = ok ] || files="$st"
    [ "$i" -eq 0 ] || printf ',' >> "$meta"
    printf '\n    "%s": { "sha256": "%s", "rows": %s }' "$(basename "$f")" "$(sha "$f")" "$rows" >> "$meta"
  done
  printf '\n  }\n}\n' >> "$meta"
  rm -f "$raw"
  decide "$tokens" "$order" "$files"
}

self_test() {
  local fails=0 cases=0 got exp tmp
  check() { cases=$((cases + 1)); if [ "$2" != "$3" ]; then fails=$((fails + 1)); log "self-test FAIL: $1 — got '$2' want '$3'"; fi; }
  dv() { decide "$1" "$2" "$3" 2>/dev/null | tail -n 1; }
  # decide(): the token law — one meaning per verdict, a red beats a cannot-verify
  check 'all ok (labels)' "$(dv ok ok ok)" 'SR_PULL_VERDICT=PASS'
  check 'all ok (labelfree)' "$(dv ok na ok)" 'SR_PULL_VERDICT=PASS'
  check 'token fail' "$(dv fail ok ok)" 'SR_PULL_VERDICT=FAIL'
  check 'token ind' "$(dv ind ok ok)" 'SR_PULL_VERDICT=INDETERMINATE'
  check 'order fail' "$(dv ok fail ok)" 'SR_PULL_VERDICT=FAIL'
  check 'order ind' "$(dv ok ind ok)" 'SR_PULL_VERDICT=INDETERMINATE'
  check 'empty corpus is never PASS' "$(dv ok ok empty)" 'SR_PULL_VERDICT=INDETERMINATE'
  check 'outputs ind' "$(dv ok na ind)" 'SR_PULL_VERDICT=INDETERMINATE'
  check 'red beats ind' "$(dv fail ind empty)" 'SR_PULL_VERDICT=FAIL'
  decide ok ok ok >/dev/null 2>&1; check 'PASS exit' "$?" 0
  decide fail ok ok >/dev/null 2>&1; check 'FAIL exit' "$?" 1
  decide ok ok empty >/dev/null 2>&1; check 'INDETERMINATE exit' "$?" 3
  # in_window(): [06:30, 17:45)
  in_window 389; check '06:29 out' "$?" 1
  in_window 390; check '06:30 in' "$?" 0
  in_window 1064; check '17:44 in' "$?" 0
  in_window 1065; check '17:45 out' "$?" 1
  # token_state() / section() / files_state() on a fixture session
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/sr-pull-selftest.XXXXXX")" || { echo 'SR_PULL_SELFTEST_VERDICT=INDETERMINATE'; return 3; }
  printf '%s\n===COVERAGE===\nexchange,timeframe\nOKX,1h\n===EXTRACT===\nid,side\n' "$RO_TOKEN" > "$tmp/good.raw"
  printf 'TOKEN current_user=postgres transaction_read_only=off\n===EXTRACT===\nid\n1\n' > "$tmp/bad.raw"
  printf 'psql: error\n' > "$tmp/err.raw"
  : > "$tmp/none.raw"
  check 'token ok' "$(token_state "$tmp/good.raw")" ok
  check 'token of a writable session' "$(token_state "$tmp/bad.raw")" fail
  check 'no token line' "$(token_state "$tmp/err.raw")" ind
  check 'empty session' "$(token_state "$tmp/none.raw")" ind
  section "$tmp/good.raw" COVERAGE > "$tmp/cov.csv"; section "$tmp/good.raw" EXTRACT > "$tmp/ext.csv"; section "$tmp/good.raw" LABELS > "$tmp/lab.csv"
  check 'section body' "$(tr '\n' ';' < "$tmp/cov.csv")" 'exchange,timeframe;OKX,1h;'
  check 'rows present' "$(files_state 'exchange,timeframe' "$tmp/cov.csv")" ok
  check 'header only' "$(files_state 'id,side' "$tmp/ext.csv")" empty
  check 'wrong header' "$(files_state 'id,label' "$tmp/ext.csv")" ind
  check 'absent section' "$(files_state 'signal_id,label' "$tmp/lab.csv")" ind
  # the writer pattern is LRW's, and it cannot match the pgrep command line that carries it
  got="$(lrw_writer_pattern)"; check 'writer pattern imported' "$([ -n "$got" ] && echo set || echo empty)" set
  printf '%s' "bash -c pgrep -fc '$got' || true" | grep -Eq "$got"; check 'writer pattern self-match-proof' "$?" 1
  rm -rf "$tmp"
  exp=26
  if [ "$cases" -lt "$exp" ]; then log "self-test ran $cases cases, floor $exp"; echo 'SR_PULL_SELFTEST_VERDICT=INDETERMINATE'; return 3; fi
  if [ "$fails" -gt 0 ]; then echo 'SR_PULL_SELFTEST_VERDICT=FAIL'; return 1; fi
  log "self-test: $cases cases"
  echo 'SR_PULL_SELFTEST_VERDICT=PASS'; return 0
}

# Sourceable: a `. sr-pull.sh` defines the functions and runs nothing.
if (return 0 2>/dev/null); then return 0; fi

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  *) run_pull "$@"; exit $? ;;
esac
