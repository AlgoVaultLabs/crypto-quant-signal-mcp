# FROZEN REFERENCE — the three Leg B / badge parsers of ops/cron/xrepo-ci-conclusion-canary.sh exactly
# as they were BEFORE OPS-XREPO-CI-RED-W1 CH3 turned them into shims over gh-run-conclusion.mjs
# (git show da08d74e:ops/cron/xrepo-ci-conclusion-canary.sh, verbatim). tests/unit/gh-run-conclusion.test.ts
# proves the module sub-modes stay byte-identical to THESE, so the shims change nothing a caller sees.
# Never edit: a reference that moves with the code under test proves nothing.
parse_runs_page() { # <html> -> "<run_number>|<run_id>|<iso-start>" for the NEWEST row, else 1
  local flat row id num iso
  flat=$(printf '%s' "$1" | tr '\n' ' ')
  row=$(printf '%s' "$flat" | sed 's/id="check_suite_/\
@@ROW@@/g' | grep '^@@ROW@@' | head -1)
  [ -n "$row" ] || return 1
  id=$(printf '%s' "$row" | grep -oE '/actions/runs/[0-9]+' | head -1 | sed 's|.*/||')
  num=$(printf '%s' "$row" | grep -oE 'Run[[:space:]]+[0-9]+[[:space:]]+of' | head -1 | grep -oE '[0-9]+')
  iso=$(printf '%s' "$row" | grep -oE '<relative-time[^>]*datetime="[^"]+"' | head -1 | sed -e 's/.*datetime="//' -e 's/"$//')
  [ -n "$id" ] && [ -n "$num" ] && [ -n "$iso" ] || return 1
  printf '%s|%s|%s' "$num" "$id" "$iso"
}
parse_badge_status() {
  local svg t
  svg=$(printf '%s' "$1" | tr '\n' ' ')
  t=$(printf '%s' "$svg" | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p' | head -1)
  [ -n "$t" ] || return 1
  case "$t" in
    *" - "*) printf '%s' "${t##* - }" ;;
    *) return 1 ;;
  esac
}
classify_status() {
  case "$1" in
    passing)     echo PASS ;;
    failing)     echo FAIL ;;
    "no status") echo INDETERMINATE ;;
    *)           echo INDETERMINATE ;;
  esac
}
