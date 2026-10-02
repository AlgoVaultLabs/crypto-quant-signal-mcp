#!/usr/bin/env bash
# lrw-pull.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH3: the REGISTERED read session (registration §1, §3.1).
#
# Runs, from a repo checkout on the Mac, after `npm run build`:
#   preconditions  the registration commit is an ancestor of origin/main and contains the file (§1.1); the ADS-1
#                  `-v2` amendment commit is an ancestor of origin/main AND introduces the amendment — its copy of
#                  the ADS-1 registration carries exactly one `## <n>. Amendment ` heading, its parent's none (§1.2);
#                  both committed BEFORE this pull; the clock is outside 02:20–06:30Z and no labeller / relabel
#                  runner is alive on signal-1; the relabel and the annotation are DONE — measured on the rows,
#                  read-only (dist/scripts/lrw/completeness.js), and every runner's own last line was CONVERGED (§1.3)
#   four parts     each its own `BEGIN READ ONLY` as `aoe_readonly`, the token printed first:
#                  counters-before → extract (+ counts apart, -v2 without -v1) → counters-after
#   assertions     every token line is the read-only token; the write counters did not move (no concurrent writer)
# Every statement comes from `dist/scripts/lrw/extract-sql.js --emit` — the generator the registration is pinned to —
# and T_CUT is the value pinned there (src/scripts/lrw/registered.ts), never an argument.
#
# Verdict — exactly one terminal line, the token is the contract:
#   LRW_PULL_VERDICT=PASS           exit 0
#   LRW_PULL_VERDICT=FAIL           exit 1   a precondition or an assertion broke (nothing is analysed)
#   LRW_PULL_VERDICT=INDETERMINATE  exit 3   a tool, the build, the network or the host could not be read
# A committed bash script on purpose (the tool shell is zsh). --self-test drives the real decide() and summary_state();
# --summary-state <file> prints the latter (the CH3 gate's D7 reads the runner summary through it).
#
# Usage: scripts/lrw/lrw-pull.sh --ads1-amendment <sha> --manifest <log>[,<log>…] --worklists <gz>,<gz>
#          --runner-summary <file> --out <dir>
#   runner-summary: one line per runner, `<venue|annotate> <LRW_RUNNER_VERDICT value>`, all CONVERGED.
#        scripts/lrw/lrw-pull.sh --self-test
set -uo pipefail

REG_COMMIT='b11529bf48631a4f3ff8fe2119e6a85773646001'
REG_FILE='audits/labeler-race-window-v2-preregistration-2026-09-28.md'
RO_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'
HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
PG_CTR='crypto-quant-signal-mcp-postgres-1'
APP_CTR='crypto-quant-signal-mcp-mcp-server-1'
ADS1_REG_FILE='audits/ads1-scorecard-preregistration-2026-09-27.md'
REQUIRED_TOOLS=(ssh node git shasum date grep sed wc)
# The writers that must not be alive. Each alternative starts with a bracket class, so the pattern's OWN text never
# matches it: the remote `bash -c "pgrep -f …"` that runs it carries the pattern on its command line, and procps
# pgrep excludes only itself, not its parent shell (the self-test proves the property locally).
WRITER_PATTERN='[b]ackfill-directional-labels|[b]ackfill-hold-decision-labels|[l]rw-relabel-runner'

# decide <pre> <tokens> <counters> <files> → prints the verdict line, returns its code.
#   pre:      ok | fail:<why> | ind:<why>     tokens: ok | fail | ind     counters: equal | moved | ind     files: ok | ind
decide() {
  local pre="$1" tokens="$2" counters="$3" files="$4" red="" ind=""
  case "$pre" in ok) ;; fail:*) red="$red ${pre#fail:}" ;; *) ind="$ind ${pre#ind:}" ;; esac
  case "$tokens" in ok) ;; fail) red="$red token-not-read-only" ;; *) ind="$ind tokens" ;; esac
  case "$counters" in equal) ;; moved) red="$red concurrent-writer" ;; *) ind="$ind counters" ;; esac
  case "$files" in ok) ;; *) ind="$ind outputs" ;; esac
  if [ -n "$red" ]; then printf '[lrw-pull] FAIL:%s\n' "$red" >&2; echo 'LRW_PULL_VERDICT=FAIL'; return 1; fi
  if [ -n "$ind" ]; then printf '[lrw-pull] cannot verify:%s\n' "$ind" >&2; echo 'LRW_PULL_VERDICT=INDETERMINATE'; return 3; fi
  echo 'LRW_PULL_VERDICT=PASS'; return 0
}

# amendment_state <headings at the commit> <headings at its first parent> → introduces | not
amendment_state() { if [ "$1" = 1 ] && [ "$2" = 0 ]; then echo introduces; else echo not; fi; }

# summary_state <file> → ok | fail:<why> | ind:<why> — every runner's terminal verdict, one line each
# (`<name> <verdict>`); an unreadable, empty or malformed file is never ok, a non-CONVERGED runner is a fail.
summary_state() {
  local f="$1" text
  [ -r "$f" ] && [ -f "$f" ] || { echo 'ind:runner-summary-unreadable'; return; }
  text="$(cat "$f" 2>/dev/null)" || { echo 'ind:runner-summary-unreadable'; return; }
  [ -n "$text" ] || { echo 'ind:runner-summary-empty'; return; }
  printf '%s\n' "$text" | grep -qvE '^[A-Za-z0-9_-]+ (CONVERGED|SLOT_END|MAX_PASSES|REFUSED|INDETERMINATE)$' && { echo 'ind:runner-summary-malformed'; return; }
  printf '%s\n' "$text" | grep -qv ' CONVERGED$' && { echo 'fail:runner-not-converged'; return; }
  echo ok
}

# ro_part <out-file> <sql…> — one READ ONLY transaction as aoe_readonly; the token line first.
ro_part() {
  local out="$1"; shift
  { printf 'BEGIN READ ONLY;\n%s;\n' "$(node dist/scripts/lrw/extract-sql.js --emit TOKEN)"
    for s in "$@"; do printf '%s;\n' "$s"; done
    printf 'ROLLBACK;\n'; } |
    ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
      "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q -v ON_ERROR_STOP=1" > "$out"
}

run_pull() {
  local ads1="" out="" manifest="" worklists="" summary=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || { echo "[lrw-pull] $1 needs a value" >&2; echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3; }
    case "$1" in
      --ads1-amendment) ads1="$2" ;;
      --out) out="$2" ;;
      --manifest) manifest="$2" ;;
      --worklists) worklists="$2" ;;
      --runner-summary) summary="$2" ;;
      *) echo "[lrw-pull] unknown argument $1" >&2; echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3 ;;
    esac
    shift 2
  done
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { echo "[lrw-pull] required tool '$t' not on PATH" >&2; echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3; }
  done
  [ -n "$ads1" ] && [ -n "$out" ] && [ -n "$manifest" ] && [ -n "$worklists" ] && [ -n "$summary" ] || {
    echo '[lrw-pull] --ads1-amendment, --manifest, --worklists, --runner-summary and --out are required' >&2; echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3; }
  cd "$root" || exit 3
  [ -f dist/scripts/lrw/extract-sql.js ] && [ -f dist/scripts/lrw/completeness.js ] || { echo '[lrw-pull] dist/ missing — npm run build first' >&2; echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3; }
  mkdir -p "$out" || exit 3
  local t_cut; t_cut="$(node dist/scripts/lrw/extract-sql.js --emit T_CUT)" || { echo 'LRW_PULL_VERDICT=INDETERMINATE'; exit 3; }
  local start_iso start_s; start_iso="$(date -u +%FT%TZ)"; start_s="$(date -u +%s)"

  # ── preconditions (§1) ──
  local pre=ok
  git fetch origin --quiet 2>/dev/null || pre='ind:fetch'
  if [ "$pre" = ok ]; then
    git merge-base --is-ancestor "$REG_COMMIT" origin/main 2>/dev/null || pre='fail:registration-not-on-origin-main'
  fi
  if [ "$pre" = ok ]; then git cat-file -e "$REG_COMMIT:$REG_FILE" 2>/dev/null || pre='fail:registration-commit-lacks-file'; fi
  if [ "$pre" = ok ]; then git merge-base --is-ancestor "$ads1" origin/main 2>/dev/null || pre='fail:ads1-amendment-not-on-origin-main'; fi
  # §1.2: the commit that INTRODUCES the amendment — not the registration commit, and not any commit that merely
  # touches the file (the predicate ADS-1's own pull applies, so the two pulls agree on what "the amendment" is)
  if [ "$pre" = ok ]; then
    local here before
    here="$(git show "$ads1:$ADS1_REG_FILE" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
    before="$(git show "$ads1^:$ADS1_REG_FILE" 2>/dev/null | grep -cE '^## [0-9]+\. Amendment ')"
    [ "$(amendment_state "${here:-0}" "${before:-0}")" = introduces ] || pre="fail:ads1-commit-does-not-introduce-the-amendment(${here:-0}/${before:-0})"
  fi
  local reg_ts ads1_ts
  reg_ts="$(git log -1 --format=%ct "$REG_COMMIT" 2>/dev/null)"; ads1_ts="$(git log -1 --format=%ct "$ads1" 2>/dev/null)"
  if [ "$pre" = ok ] && { [ -z "$reg_ts" ] || [ "$reg_ts" -ge "$start_s" ] || [ -z "$ads1_ts" ] || [ "$ads1_ts" -ge "$start_s" ]; }; then pre='fail:commit-not-before-pull'; fi
  local hm; hm=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))
  if [ "$pre" = ok ] && [ "$hm" -ge 140 ] && [ "$hm" -lt 390 ]; then pre='fail:inside-02:20-06:30Z'; fi
  if [ "$pre" = ok ]; then
    local alive
    alive="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" "pgrep -fc '$WRITER_PATTERN' || true" 2>/dev/null)" || pre='ind:host'
    [ "$pre" = ok ] && [ "${alive:-x}" != 0 ] && pre="fail:writer-alive(${alive:-?})"
  fi
  # §1.3: the relabel and the annotation are DONE — each runner's last word, then the rows themselves
  if [ "$pre" = ok ]; then pre="$(summary_state "$summary")"; fi
  if [ "$pre" = ok ]; then
    if ro_part "$out/pre-missing-v2.txt" "$(node dist/scripts/lrw/completeness.js --emit MISSING_V2)" &&
       ro_part "$out/pre-null-v1-gap.txt" "$(node dist/scripts/lrw/completeness.js --emit NULL_V1_GAP)"; then
      local rel ann
      rel="$(node dist/scripts/lrw/completeness.js --relabel --missing "$out/pre-missing-v2.txt" --manifest "$manifest")"
      ann="$(node dist/scripts/lrw/completeness.js --annotation --null-keys "$out/pre-null-v1-gap.txt" --worklists "$worklists")"
      printf '%s\n%s\n' "$rel" "$ann" > "$out/pre-completeness.txt"
      case "$rel" in LRW_RELABEL_COMPLETE=YES*) ;; LRW_RELABEL_COMPLETE=NO*) pre='fail:relabel-not-done' ;; *) pre='ind:relabel-completeness' ;; esac
      if [ "$pre" = ok ]; then
        case "$ann" in LRW_ANNOTATION_COMPLETE=YES*) ;; LRW_ANNOTATION_COMPLETE=NO*) pre='fail:annotation-not-done' ;; *) pre='ind:annotation-completeness' ;; esac
      fi
    else pre='ind:completeness-read'; fi
  fi
  local manifest_shas="" m
  for m in $(printf '%s' "$manifest" | tr ',' ' '); do
    manifest_shas="${manifest_shas:+$manifest_shas,}$(shasum -a 256 "$m" 2>/dev/null | awk '{print $1}')"
  done

  local tokens=ind counters=ind files=ind before="" after=""
  if [ "$pre" = ok ]; then
    if ro_part "$out/part1-counters-before.txt" "$(node dist/scripts/lrw/extract-sql.js --emit COUNTERS)" &&
       ro_part "$out/part2-extract.txt" "$(node dist/scripts/lrw/extract-sql.js --emit EXTRACT)" &&
       ro_part "$out/part3-counts-apart.txt" "$(node dist/scripts/lrw/extract-sql.js --emit COUNTS_APART)" &&
       ro_part "$out/part4-v2-without-v1.txt" "$(node dist/scripts/lrw/extract-sql.js --emit V2_WITHOUT_V1)" &&
       ro_part "$out/part5-counters-after.txt" "$(node dist/scripts/lrw/extract-sql.js --emit COUNTERS)"; then
      tokens=ok
      local f
      for f in part1-counters-before part2-extract part3-counts-apart part4-v2-without-v1 part5-counters-after; do
        [ "$(head -n 1 "$out/$f.txt")" = "$RO_TOKEN" ] || tokens=fail
      done
      before="$(sed -n 2p "$out/part1-counters-before.txt")"; after="$(sed -n 2p "$out/part5-counters-after.txt")"
      if [ -n "$before" ] && [ "$before" = "$after" ]; then counters=equal; elif [ -n "$before" ]; then counters=moved; fi
      tail -n +2 "$out/part2-extract.txt" > "$out/extract.csv"
      tail -n +2 "$out/part3-counts-apart.txt" > "$out/counts-apart.csv"
      tail -n +2 "$out/part4-v2-without-v1.txt" > "$out/v2-without-v1.csv"
      # COPY … HEADER always writes the header line: an extract needs a DATA row, not just a non-empty file
      [ "$(wc -l < "$out/extract.csv" 2>/dev/null || echo 0)" -gt 1 ] && [ -s "$out/counts-apart.csv" ] && [ -s "$out/v2-without-v1.csv" ] && files=ok
    fi
  fi
  local end_iso; end_iso="$(date -u +%FT%TZ)"
  {
    echo "pull_start=$start_iso"; echo "pull_end=$end_iso"; echo "t_cut=$t_cut"
    echo "registration_commit=$REG_COMMIT committed_at=${reg_ts:-?}"; echo "ads1_amendment_commit=$ads1 committed_at=${ads1_ts:-?}"
    echo "manifest_sha256=$manifest_shas"
    echo "preconditions=$pre tokens=$tokens counters=$counters files=$files"
    echo "counters_before=$before"; echo "counters_after=$after"
    [ "$files" = ok ] && (cd "$out" && shasum -a 256 extract.csv counts-apart.csv v2-without-v1.csv)
  } > "$out/pull-meta.txt"
  local rc; decide "$pre" "$tokens" "$counters" "$files" | tee -a "$out/pull-meta.txt"; rc=${PIPESTATUS[0]}
  exit "$rc"
}

self_test() {
  local pass=0 fail=0
  ck() { # <name> <want token> <want rc> <args…>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local got rc; got="$(decide "$@" 2>/dev/null)"; rc=$?
    if [ "$got" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$got' rc=$rc)"; fi
  }
  ck all-pass 'LRW_PULL_VERDICT=PASS' 0 ok ok equal ok
  ck registration-missing 'LRW_PULL_VERDICT=FAIL' 1 fail:registration-not-on-origin-main ind ind ind
  ck inside-nightly-window 'LRW_PULL_VERDICT=FAIL' 1 fail:inside-02:20-06:30Z ind ind ind
  ck writer-alive 'LRW_PULL_VERDICT=FAIL' 1 'fail:writer-alive(1)' ind ind ind
  ck token-not-read-only 'LRW_PULL_VERDICT=FAIL' 1 ok fail equal ok
  ck concurrent-writer 'LRW_PULL_VERDICT=FAIL' 1 ok ok moved ok
  ck host-unreadable 'LRW_PULL_VERDICT=INDETERMINATE' 3 ind:host ind ind ind
  ck counters-unread 'LRW_PULL_VERDICT=INDETERMINATE' 3 ok ok ind ok
  ck empty-output 'LRW_PULL_VERDICT=INDETERMINATE' 3 ok ok equal ind
  ck fail-outranks-ind 'LRW_PULL_VERDICT=FAIL' 1 ok fail ind ind
  ck relabel-not-done 'LRW_PULL_VERDICT=FAIL' 1 fail:relabel-not-done ind ind ind
  # the amendment predicate: exactly one heading at the commit and none before it — the registration commit (0/0),
  # a later touch (1/1) and a double amendment (2/0) are all refused
  local pair
  for pair in '1 0 introduces' '0 0 not' '1 1 not' '2 1 not' '2 0 not'; do
    set -- $pair
    if [ "$(amendment_state "$1" "$2")" = "$3" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok amendment-$1-$2"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL amendment-$1-$2"; fi
  done
  # the writer pattern never matches its own text (the remote shell's command line), and matches every writer
  local wp_ok=1 cmd
  printf '%s' "bash -c pgrep -fc '$WRITER_PATTERN' || true" | grep -Eq "$WRITER_PATTERN" && wp_ok=0
  for cmd in 'node dist/scripts/backfill-directional-labels.js --relabel-v2 --venue OKX' 'node dist/scripts/backfill-hold-decision-labels.js' 'bash /opt/lrw/lrw-relabel-runner.sh --venue OKX'; do
    printf '%s' "$cmd" | grep -Eq "$WRITER_PATTERN" || wp_ok=0
  done
  if [ "$wp_ok" = 1 ]; then pass=$((pass + 1)); echo 'SELF-TEST: ok writer-pattern-not-self-matching'
  else fail=$((fail + 1)); echo 'SELF-TEST: FAIL writer-pattern-not-self-matching'; fi
  # the runner summary: unreadable / empty / malformed → ind, a non-CONVERGED runner → fail, all CONVERGED → ok
  local st; st="$(mktemp -d)"
  printf 'OKX CONVERGED\nannotate CONVERGED\n' > "$st/ok"; printf 'OKX CONVERGED\nHL SLOT_END\n' > "$st/slot"; : > "$st/empty"; printf 'OKX done\n' > "$st/bad"; mkdir "$st/dir"
  local want got k
  for k in 'ok:ok' 'slot:fail:runner-not-converged' 'empty:ind:runner-summary-empty' 'bad:ind:runner-summary-malformed' 'dir:ind:runner-summary-unreadable' 'absent:ind:runner-summary-unreadable'; do
    want="${k#*:}"; got="$(summary_state "$st/${k%%:*}")"
    if [ "$got" = "$want" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok summary-${k%%:*}"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL summary-${k%%:*} (got '$got')"; fi
  done
  rm -rf "$st"
  # the missing-tool precondition through the real entry point, with a PATH that holds only bash
  local tmp; tmp="$(mktemp -d)"; ln -s "$(command -v bash)" "$tmp/bash"
  local out rc; out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" --ads1-amendment x --manifest m --worklists w --runner-summary s --out "$tmp/o" 2>&1)"; rc=$?
  rm -rf "$tmp"
  # the guard itself must fire (it names the tool), not some later failure
  if [ "$(printf '%s\n' "$out" | tail -n 1)" = 'LRW_PULL_VERDICT=INDETERMINATE' ] && [ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q "required tool 'ssh' not on PATH"; then pass=$((pass + 1)); echo 'SELF-TEST: ok missing-tool'
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool (got '$out' rc=$rc)"; fi
  if [ "$fail" -eq 0 ] && [ "$pass" -ge 24 ]; then echo "LRW_PULL_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "LRW_PULL_SELFTEST: FAIL ($fail of $((pass + fail)))"; exit 1
}

if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
# the ONE runner-summary reader, for the CH3 gate's D7 leg
if [ "${1:-}" = "--summary-state" ]; then summary_state "${2:-}"; exit 0; fi
run_pull "$@"
