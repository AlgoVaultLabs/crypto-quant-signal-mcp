#!/usr/bin/env bash
# ads1-ch2-gate.sh — EDGE-ADS1-SCORECARD-W1-V2 CH2 (the ADS-1 library, the complete label, the expiry column).
#
# Runs, in order, from the repo root:
#   1. npm run build && npm run build:knowledge      (deploy.yml's order: tsc, then the KB bundle)
#   2. the full vitest suite with the CI reporters, then scripts/classify-suite-verdict.mjs — the SAME
#      verdict deploy.yml gates on (SUITE_VERDICT=PASS|PASS_AFTER_ISOLATION|FAIL|INDETERMINATE). The raw
#      vitest exit code is NOT the gate: measured 2026-09-27 it was 1 in 3/3 runs on an untouched main
#      (load timeouts, 0 failing tests) while the classifier said PASS.
#   3. the python3 differential (tests/unit/ads1-cluster-ci-differential.test.ts) must have RUN and passed
#      inside that suite — read from the JSON report, never assumed. python3 absent = the test fails = RED.
#   4. node dist/scripts/ads1/selftest.js       -> ADS1_SELFTEST: PASS
#   5. node dist/scripts/ads1/ddl-parity-check.js -> DDL_PARITY: PASS
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH2_GREEN          exit 0   every leg passed
#   CH2_RED            exit 1   any leg failed
#   CH2_INDETERMINATE  exit 3   a required tool is missing, or a leg produced no readable verdict
#
# A committed bash script on purpose (the tool shell is zsh: ${PIPESTATUS[0]} empty, [ "" -eq 0 ] TRUE).
# --self-test drives the REAL decision function (the script is sourceable) over synthetic leg results,
# plus a PATH-stripped run for the missing-tool precondition. There is no env seam that can fake a leg.
#
# Usage:  scripts/gates/ads1-ch2-gate.sh            (from anywhere inside the checkout)
#         scripts/gates/ads1-ch2-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm npx python3 grep)
DIFF_TEST='tests/unit/ads1-cluster-ci-differential.test.ts'

# decide <build_rc> <suite_token> <diff_status> <selftest_line> <ddl_line>  -> prints the token, returns its code
#   suite_token: PASS | PASS_AFTER_ISOLATION | FAIL | INDETERMINATE | "" (no readable verdict)
#   diff_status: passed | failed | missing
decide() {
  local build_rc="$1" suite="$2" diff="$3" st="$4" ddl="$5"
  local red="" ind=""
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) ;;
    FAIL) red="$red suite" ;;
    *) ind="$ind suite:${suite:-none}" ;;
  esac
  case "$diff" in
    passed) ;;
    failed) red="$red differential" ;;
    *) ind="$ind differential:${diff:-none}" ;;
  esac
  case "$st" in
    "ADS1_SELFTEST: PASS"*) ;;
    "ADS1_SELFTEST: FAIL"*) red="$red selftest" ;;
    *) ind="$ind selftest:no-token" ;;
  esac
  case "$ddl" in
    "DDL_PARITY: PASS"*) ;;
    "DDL_PARITY: FAIL"*) red="$red ddl-parity" ;;
    *) ind="$ind ddl-parity:no-verdict" ;;
  esac
  if [ -n "$red" ]; then printf '[ads1-ch2-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH2_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[ads1-ch2-gate] cannot verify:%s\n' "$ind" >&2; echo CH2_INDETERMINATE; return 3; fi
  printf '[ads1-ch2-gate] build + suite + python3 differential + selftest + DDL parity all passed\n' >&2
  echo CH2_GREEN; return 0
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[ads1-ch2-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH2_INDETERMINATE; exit 3; }
  done
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[ads1-ch2-gate] not inside a git checkout" >&2; echo CH2_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH2_INDETERMINATE; exit 3; }

  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-ch2-gate.XXXXXX")" || { echo CH2_INDETERMINATE; exit 3; }
  # the evidence outlives any verdict but GREEN: a RED whose report was deleted cannot be diagnosed
  # (measured 2026-09-27 — a one-off suite FAIL, PASS on the rerun, and nothing left to say which test)

  # deploy.yml's exact build order: tsc, THEN the knowledge bundle. `rm -rf dist` + tsc alone leaves
  # dist/knowledge/latest.json missing, and kb-reachability's spawned gate then reads INDETERMINATE —
  # measured 2026-09-27: two gate runs RED on exactly that, while a suite run on a dist a previous run had
  # already filled read PASS.
  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$?
  # a failed build must not leave the other legs reading a stale dist
  local suite="" diff="missing" st="" ddl=""
  if [ "$build_rc" -eq 0 ]; then
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
    diff="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const f = (r.testResults || []).find((t) => String(t.name).endsWith(process.argv[2]));
      if (!f) { console.log("missing"); process.exit(0); }
      const a = f.assertionResults || [];
      console.log(a.length > 0 && a.every((x) => x.status === "passed") ? "passed" : "failed");
    ' "$tmp/report.json" "$DIFF_TEST" 2>/dev/null || echo missing)"
    st="$(node dist/scripts/ads1/selftest.js 2>/dev/null | tail -n 1)"
    ddl="$(node dist/scripts/ads1/ddl-parity-check.js 2>/dev/null | tail -n 1)"
  fi
  printf '[ads1-ch2-gate] build_rc=%s suite=%s differential=%s\n[ads1-ch2-gate] %s\n[ads1-ch2-gate] %s\n' \
    "$build_rc" "${suite:-none}" "$diff" "${st:-no selftest line}" "${ddl:-no ddl line}" >&2
  local rc
  decide "$build_rc" "$suite" "$diff" "$st" "$ddl"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"
  else printf '[ads1-ch2-gate] evidence kept: %s (build.log, vitest.log, report.json, shapes.json)\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  check() { # <name> <want token> <want rc> <decide args...>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc
    out="$(decide "$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out' rc=$rc, want '$want' rc=$want_rc)"; fi
  }
  local S='ADS1_SELFTEST: PASS (42 checks)' D='DDL_PARITY: PASS (11 columns, labeler DDL == migrations)'
  check all-pass-green CH2_GREEN 0 0 PASS passed "$S" "$D"
  check pass-after-isolation-green CH2_GREEN 0 0 PASS_AFTER_ISOLATION passed "$S" "$D"
  check build-failed-red CH2_RED 1 2 "" missing "" ""
  check suite-fail-red CH2_RED 1 0 FAIL passed "$S" "$D"
  check differential-failed-red CH2_RED 1 0 PASS failed "$S" "$D"
  check selftest-fail-red CH2_RED 1 0 PASS passed 'ADS1_SELFTEST: FAIL L1 null' "$D"
  check ddl-fail-red CH2_RED 1 0 PASS passed "$S" 'DDL_PARITY: FAIL (only in migrations: [x])'
  check suite-unreadable-indeterminate CH2_INDETERMINATE 3 0 "" passed "$S" "$D"
  check differential-missing-indeterminate CH2_INDETERMINATE 3 0 PASS missing "$S" "$D"
  check selftest-token-missing-indeterminate CH2_INDETERMINATE 3 0 PASS passed "" "$D"
  check ddl-indeterminate-is-not-green CH2_INDETERMINATE 3 0 PASS passed "$S" 'DDL_PARITY: INDETERMINATE (cannot read)'
  check red-outranks-indeterminate CH2_RED 1 0 FAIL missing "" ""
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/ads1-ch2-selftest.XXXXXX")" || { echo "ADS1_CH2_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH2_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 13 ]; then echo "ADS1_CH2_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "ADS1_CH2_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "ADS1_CH2_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
