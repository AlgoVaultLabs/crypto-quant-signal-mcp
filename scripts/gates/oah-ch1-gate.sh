#!/usr/bin/env bash
# oah-ch1-gate.sh — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH1 (truth table · adapter history contract suite · fixtures).
#
# GREEN iff, from the repo root:
#   1. rm -rf dist && npm run build && npm run build:knowledge  exits 0 (deploy.yml's order; tsc alone leaves
#      dist/knowledge/latest.json missing and a spawned KB gate then reads INDETERMINATE — measured 2026-09-27)
#   2. the full vitest suite with the CI reporters, then scripts/classify-suite-verdict.mjs: the SAME verdict
#      deploy.yml gates on, SUITE_VERDICT ∈ {PASS, PASS_AFTER_ISOLATION} (never the raw vitest exit code)
#   3. tests/fixtures/adapter-history/BASELINE.json holds ≥ 4 entries, each with a clause (C1|C3) and a
#      disposition (fix|report), including BITGET/2h C1 and BITGET/8h C1 (OAH-Q1: the RED-first evidence)
#   4. the fixtures verify against tests/fixtures/adapter-history/SHA256SUMS
#   5. audits/OPS-ADAPTER-HISTORY-ANCHOR-W1-endpoint-truth.md exists with one table row per probe P1…P10
#   6. no changed path (vs the merge-base with origin/main, plus untracked) is in CH1's Must-NOT-write list:
#      src/lib/adapters/*.ts · src/scripts/** · src/lib/tf-support.ts · ops/monitoring/** · docs/** ·
#      any audits/*preregistration*
#
# Verdict — exactly one terminal line; callers gate on the TOKEN, never the exit code alone:
#   CH1_GREEN          exit 0
#   CH1_RED            exit 1   any leg failed
#   CH1_INDETERMINATE  exit 3   a required tool is missing, or a leg produced no readable verdict
# RED outranks INDETERMINATE.
#
# A committed bash script on purpose (the tool shell is zsh: ${PIPESTATUS[0]} is empty and [ "" -eq 0 ] is
# TRUE — a pasted gate fails OPEN). bash 3.2 compatible: no mapfile.
# --self-test drives the REAL decision function and the REAL leg functions (the script is sourceable) over
# mutated copies, plus a PATH-stripped run for the missing-tool precondition. No env seam can fake a leg.
#
# Usage:  scripts/gates/oah-ch1-gate.sh            (from anywhere inside the checkout)
#         scripts/gates/oah-ch1-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm npx git grep sed sort)
FIXDIR='tests/fixtures/adapter-history'
TRUTH='audits/OPS-ADAPTER-HISTORY-ANCHOR-W1-endpoint-truth.md'
MUST_NOT_WRITE='^src/lib/adapters/[^/]+\.ts$|^src/scripts/|^src/lib/tf-support\.ts$|^ops/monitoring/|^docs/|^audits/.*preregistration'

log() { printf '[oah-ch1-gate] %s\n' "$*" >&2; }

sha_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo "sha256sum"
  elif command -v shasum >/dev/null 2>&1; then echo "shasum -a 256"
  else echo ""; fi
}

# baseline_leg <BASELINE.json>  -> OK | RED <why> | IND <why>
baseline_leg() {
  local f="$1"
  [ -r "$f" ] || { echo "IND baseline-unreadable"; return; }
  node -e '
    let j; try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (e) { console.log("IND baseline-unparseable"); process.exit(0); }
    const e = Array.isArray(j && j.entries) ? j.entries : null;
    if (!e) { console.log("IND baseline-no-entries-array"); process.exit(0); }
    const bad = e.filter((x) => !["C1", "C3"].includes(x.clause) || !["fix", "report"].includes(x.disposition) || !x.venue || !x.tf);
    if (bad.length) { console.log("RED baseline-entry-without-clause-or-disposition"); process.exit(0); }
    if (e.length < 4) { console.log("RED baseline-has-" + e.length + "-entries(<4)"); process.exit(0); }
    const has = (v, tf, c) => e.some((x) => x.venue === v && x.tf === tf && x.clause === c);
    if (!has("BITGET", "2h", "C1")) { console.log("RED baseline-missing-BITGET/2h-C1"); process.exit(0); }
    if (!has("BITGET", "8h", "C1")) { console.log("RED baseline-missing-BITGET/8h-C1"); process.exit(0); }
    console.log("OK");
  ' "$f" 2>/dev/null || echo "IND baseline-node-failed"
}

# sha_leg <fixture dir>  -> OK | RED <why> | IND <why>
sha_leg() {
  local dir="$1" tool out
  tool="$(sha_tool)"; [ -n "$tool" ] || { echo "IND no-sha256-tool"; return; }
  [ -r "$dir/SHA256SUMS" ] || { echo "RED SHA256SUMS-missing"; return; }
  [ "$(grep -c . "$dir/SHA256SUMS")" -gt 0 ] || { echo "RED SHA256SUMS-empty"; return; }
  out="$( (cd "$dir" && $tool -c SHA256SUMS) 2>&1 )" && { echo "OK"; return; }
  echo "RED fixture-hash-mismatch:$(printf '%s' "$out" | grep -v ': OK$' | head -n 1 | tr ' ' '_')"
}

# truth_leg <endpoint-truth.md>  -> OK | RED <why>
truth_leg() {
  local f="$1" n missing=""
  [ -r "$f" ] || { echo "RED endpoint-truth-missing"; return; }
  for n in 1 2 3 4 5 6 7 8 9 10; do
    grep -qE "^\| *P${n} *\|" "$f" || missing="$missing P${n}"
  done
  if [ -n "$missing" ]; then echo "RED endpoint-truth-rows-missing:$(echo $missing | tr ' ' ',')"; else echo "OK"; fi
}

# firewall_leg <file listing changed paths, one per line>  -> OK | RED <paths>
firewall_leg() {
  local hits
  hits="$(grep -E "$MUST_NOT_WRITE" "$1" | sort -u | tr '\n' ',' || true)"
  if [ -n "$hits" ]; then echo "RED must-not-write-touched:${hits%,}"; else echo "OK"; fi
}

# decide <build_rc> <suite_token> <baseline> <sha> <truth> <firewall>  -> prints the token, returns its code
decide() {
  local build_rc="$1" suite="$2" red="" ind="" leg name
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) ;;
    FAIL) red="$red suite" ;;
    *) ind="$ind suite:${suite:-none}" ;;
  esac
  shift 2
  for name in baseline sha truth firewall; do
    leg="${1:-}"; shift || true
    case "$leg" in
      OK) ;;
      RED*) red="$red $name(${leg#RED })" ;;
      *) ind="$ind $name(${leg#IND })" ;;
    esac
  done
  if [ -n "$red" ]; then log "RED:$red${ind:+ (also unverified:$ind)}"; echo CH1_RED; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo CH1_INDETERMINATE; return 3; fi
  log "build + suite + baseline + fixture hashes + endpoint truth + firewall all passed"
  echo CH1_GREEN; return 0
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { log "required tool '$t' not on PATH"; echo CH1_INDETERMINATE; exit 3; }
  done
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "not inside a git checkout"; echo CH1_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH1_INDETERMINATE; exit 3; }
  [ -r scripts/classify-suite-verdict.mjs ] || { log "the wired suite runner scripts/classify-suite-verdict.mjs is missing"; echo CH1_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/oah-ch1-gate.XXXXXX")" || { echo CH1_INDETERMINATE; exit 3; }

  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$? suite=""
  if [ "$build_rc" -eq 0 ]; then
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
  fi
  local base; base="$(git merge-base origin/main HEAD 2>/dev/null)" || base=""
  local fw
  if [ -z "$base" ]; then fw="IND no-merge-base-with-origin/main"
  else
    { git diff --name-only "$base"; git ls-files --others --exclude-standard; } >"$tmp/changed.txt" 2>/dev/null
    fw="$(firewall_leg "$tmp/changed.txt")"
  fi
  local bl sh tr
  bl="$(baseline_leg "$FIXDIR/BASELINE.json")"
  sh="$(sha_leg "$FIXDIR")"
  tr="$(truth_leg "$TRUTH")"
  log "build_rc=$build_rc suite=${suite:-none} baseline=$bl sha=$sh truth=$tr firewall=$fw"
  local rc
  decide "$build_rc" "$suite" "$bl" "$sh" "$tr" "$fw"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else log "evidence kept: $tmp (build.log, vitest.log, report.json, shapes.json, changed.txt)"; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  ok_case() { cases=$((cases + 1)); pass=$((pass + 1)); echo "SELF-TEST: ok $1"; }
  bad_case() { cases=$((cases + 1)); fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 ($2)"; }
  check() { # <name> <want token> <want rc> <decide args...>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc; out="$(decide "$@" 2>/dev/null)"; rc=$?
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then ok_case "$name"; else bad_case "$name" "got '$out' rc=$rc, want '$want' rc=$want_rc"; fi
  }
  expect_leg() { # <name> <want prefix> <actual>
    case "$3" in "$2"*) ok_case "$1" ;; *) bad_case "$1" "leg said '$3', want '$2…'" ;; esac
  }
  # decision table
  check green-control CH1_GREEN 0 0 PASS OK OK OK OK
  check pass-after-isolation-green CH1_GREEN 0 0 PASS_AFTER_ISOLATION OK OK OK OK
  check build-failed-red CH1_RED 1 2 "" OK OK OK OK
  check suite-fail-red CH1_RED 1 0 FAIL OK OK OK OK
  check suite-unreadable-indeterminate CH1_INDETERMINATE 3 0 "" OK OK OK OK
  check red-outranks-indeterminate CH1_RED 1 0 "" "RED x" OK OK OK
  check leg-indeterminate-is-not-green CH1_INDETERMINATE 3 0 PASS OK "IND no-sha256-tool" OK OK

  # the REAL legs over mutated copies of the real artifacts (one mutation per condition)
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "OAH_CH1_GATE_SELFTEST: FAIL not-in-checkout"; exit 1; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/oah-ch1-selftest.XXXXXX")" || { echo "OAH_CH1_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  cp -R "$root/$FIXDIR" "$tmp/fix" && cp "$root/$TRUTH" "$tmp/truth.md" || { rm -rf "$tmp"; echo "OAH_CH1_GATE_SELFTEST: FAIL copy (run from a checkout carrying the CH1 artifacts)"; exit 1; }
  expect_leg baseline-real-ok OK "$(baseline_leg "$tmp/fix/BASELINE.json")"
  expect_leg sha-real-ok OK "$(sha_leg "$tmp/fix")"
  expect_leg truth-real-ok OK "$(truth_leg "$tmp/truth.md")"
  # 1. baseline loses BITGET/8h C1 (resp. 2h) while keeping ≥ 4 entries, so only the named check can catch it
  #    (measured: a drop that also shrank the count was caught by the count check and masked a dead 8h check)
  node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const e of j.entries)if(e.venue==="BITGET"&&e.tf==="8h"&&e.clause==="C1")e.tf="4h";require("fs").writeFileSync(f,JSON.stringify(j))' "$tmp/fix/BASELINE.json"
  expect_leg baseline-drops-bitget-8h-red RED "$(baseline_leg "$tmp/fix/BASELINE.json")"
  cp "$root/$FIXDIR/BASELINE.json" "$tmp/fix/BASELINE.json"
  node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));for(const e of j.entries)if(e.venue==="BITGET"&&e.tf==="2h"&&e.clause==="C1")e.tf="4h";require("fs").writeFileSync(f,JSON.stringify(j))' "$tmp/fix/BASELINE.json"
  expect_leg baseline-drops-bitget-2h-red RED "$(baseline_leg "$tmp/fix/BASELINE.json")"
  cp "$root/$FIXDIR/BASELINE.json" "$tmp/fix/BASELINE.json"
  node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.entries=j.entries.slice(0,3);require("fs").writeFileSync(f,JSON.stringify(j))' "$tmp/fix/BASELINE.json"
  expect_leg baseline-under-four-red RED "$(baseline_leg "$tmp/fix/BASELINE.json")"
  cp "$root/$FIXDIR/BASELINE.json" "$tmp/fix/BASELINE.json"
  # 2. baseline entry without a disposition
  node -e 'const f=process.argv[1],j=JSON.parse(require("fs").readFileSync(f,"utf8"));delete j.entries[0].disposition;require("fs").writeFileSync(f,JSON.stringify(j))' "$tmp/fix/BASELINE.json"
  expect_leg baseline-no-disposition-red RED "$(baseline_leg "$tmp/fix/BASELINE.json")"
  printf '{not json' >"$tmp/fix/BASELINE.json"
  expect_leg baseline-unparseable-indeterminate IND "$(baseline_leg "$tmp/fix/BASELINE.json")"
  cp "$root/$FIXDIR/BASELINE.json" "$tmp/fix/BASELINE.json"
  # 3. a fixture byte changes
  printf ' ' >>"$tmp/fix/BITGET.json"
  expect_leg fixture-byte-flip-red RED "$(sha_leg "$tmp/fix")"
  : >"$tmp/fix/SHA256SUMS"
  expect_leg sha-sums-empty-red RED "$(sha_leg "$tmp/fix")"
  # 4. the endpoint truth loses its P7 row (and P1 must not satisfy P10)
  grep -vE '^\| *P7 *\|' "$tmp/truth.md" >"$tmp/truth-no-p7.md"
  expect_leg truth-missing-p7-red RED "$(truth_leg "$tmp/truth-no-p7.md")"
  grep -vE '^\| *P10 *\|' "$tmp/truth.md" >"$tmp/truth-no-p10.md"
  expect_leg truth-missing-p10-red RED "$(truth_leg "$tmp/truth-no-p10.md")"
  # 5. a Must-NOT-write path in the change set
  printf 'tests/unit/adapter-history-contract.test.ts\nsrc/lib/adapters/bitget.ts\n' >"$tmp/changed-bad.txt"
  expect_leg firewall-adapter-edit-red RED "$(firewall_leg "$tmp/changed-bad.txt")"
  printf 'tests/unit/adapter-history-contract.test.ts\naudits/labeler-race-window-v2-preregistration-2026-09-28.md\n' >"$tmp/changed-reg.txt"
  expect_leg firewall-registration-edit-red RED "$(firewall_leg "$tmp/changed-reg.txt")"
  printf 'tests/unit/adapter-history-contract.test.ts\ntests/harness/adapter-history-model.ts\nscripts/gates/oah-ch1-gate.sh\n' >"$tmp/changed-ok.txt"
  expect_leg firewall-own-files-ok OK "$(firewall_leg "$tmp/changed-ok.txt")"
  # 6. the missing-tool precondition, through the real entry point with a PATH that holds only bash
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  if [ "$out" = "CH1_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then ok_case missing-tool-indeterminate
  else bad_case missing-tool-indeterminate "got '$out' rc=$rc"; fi
  rm -rf "$tmp"
  if [ "$cases" -lt 23 ]; then echo "OAH_CH1_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "OAH_CH1_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "OAH_CH1_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define the functions and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
