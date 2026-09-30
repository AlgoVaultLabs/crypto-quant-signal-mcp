#!/usr/bin/env bash
# oah-ch2-gate.sh — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2 (the served-step anchor · meta · differential · budget).
#
# GREEN iff, from the repo root:
#   1. rm -rf dist && npm run build && npm run build:knowledge  exits 0 (deploy.yml's order)
#   2. the full vitest suite with the CI reporters → scripts/classify-suite-verdict.mjs:
#      SUITE_VERDICT ∈ {PASS, PASS_AFTER_ISOLATION} (the verdict deploy.yml gates on; never the raw exit code)
#   3. CONTRACT: tests/fixtures/adapter-history/BASELINE.json holds NO entry (CH2 empties it) AND
#      tests/unit/adapter-history-contract.test.ts RAN and passed inside that suite (read from the JSON report)
#   4. DIFFERENTIAL_VERDICT=PASS: tests/unit/adapter-history-differential.test.ts ran and passed (serving
#      byte-identical; non-violators identical; violators differ by exactly the missing slots)
#   5. BUDGET_DELTA_VERDICT=PASS: tests/unit/adapter-history-budget.test.ts ran and passed (integer pages per
#      span; delta 0 on every non-violator pair)
#   6. no changed path (vs the merge-base with origin/main, plus untracked) is in CH2's Must-NOT-write list:
#      src/scripts/backfill-*.ts · src/scripts/directional-labeler.ts · src/lib/tf-support.ts ·
#      src/lib/venue-budget-registry.ts · src/lib/adapters/_upstream-fetch.ts · src/types.ts · ops/monitoring/** ·
#      any adapter other than bitget.ts / okx.ts / _history-plan.ts · a package.json "version" change
#   7. the okx.ts diff touches no funding line (git diff … src/lib/adapters/okx.ts | grep -ci funding = 0)
#
# Verdict — exactly one terminal line; callers gate on the TOKEN:
#   CH2_GREEN 0 · CH2_RED 1 · CH2_INDETERMINATE 3 (a tool missing, or a leg produced no readable verdict).
# RED outranks INDETERMINATE.
#
# --post-landing: asserts T_ADAPTER is recorded in the vault status.md and equals `docker inspect StartedAt` of
#   crypto-quant-signal-mcp-mcp-server-1 whose GIT_SHA contains the CH2 commit. INDETERMINATE (3) when signal-1
#   is unreachable. Prints POST_LANDING_VERDICT=PASS|FAIL|INDETERMINATE.
#
# bash 3.2 compatible (no mapfile). --self-test drives the REAL decide() and the REAL leg functions over mutated
# copies (the script is sourceable); no env seam can fake a leg.
set -uo pipefail

REQUIRED_TOOLS=(node npm npx git grep sed sort)
FIXDIR='tests/fixtures/adapter-history'
CONTRACT_TEST='tests/unit/adapter-history-contract.test.ts'
DIFF_TEST='tests/unit/adapter-history-differential.test.ts'
BUDGET_TEST='tests/unit/adapter-history-budget.test.ts'
MUST_NOT_WRITE='^src/scripts/backfill-[^/]+\.ts$|^src/scripts/directional-labeler\.ts$|^src/lib/tf-support\.ts$|^src/lib/venue-budget-registry\.ts$|^src/lib/adapters/_upstream-fetch\.ts$|^src/types\.ts$|^ops/monitoring/'
ADAPTERS_ALLOWED='^src/lib/adapters/(bitget|okx|_history-plan)\.ts$'
STATUS_MD="${OAH_STATUS_MD:-$HOME/My Drive/Obsidian Vault/AlgoVault MCP/status.md}"
SSH_TARGET="${OAH_SSH_TARGET:-root@204.168.185.24}"
SSH_KEY="${OAH_SSH_KEY:-$HOME/.ssh/algovault_deploy}"

log() { printf '[oah-ch2-gate] %s\n' "$*" >&2; }

# baseline_empty_leg <BASELINE.json> -> OK | RED … | IND …
baseline_empty_leg() {
  [ -r "$1" ] || { echo "IND baseline-unreadable"; return; }
  node -e '
    let j; try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { console.log("IND baseline-unparseable"); process.exit(0); }
    if (!Array.isArray(j && j.entries)) { console.log("IND baseline-no-entries-array"); process.exit(0); }
    console.log(j.entries.length === 0 ? "OK" : "RED baseline-still-has-" + j.entries.length + "-violations");
  ' "$1" 2>/dev/null || echo "IND baseline-node-failed"
}

# test_file_leg <report.json> <test file> -> OK | RED … | IND …   (the file must have RUN, ≥1 assertion, all passed)
test_file_leg() {
  [ -r "$1" ] || { echo "IND report-unreadable"; return; }
  node -e '
    let r; try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { console.log("IND report-unparseable"); process.exit(0); }
    const f = (r.testResults || []).find((t) => String(t.name).endsWith(process.argv[2]));
    if (!f) { console.log("RED " + process.argv[2] + "-did-not-run"); process.exit(0); }
    const a = f.assertionResults || [];
    if (a.length === 0) { console.log("RED " + process.argv[2] + "-ran-zero-assertions"); process.exit(0); }
    const bad = a.filter((x) => x.status !== "passed").length;
    console.log(bad === 0 ? "OK" : "RED " + process.argv[2] + "-" + bad + "-not-passed");
  ' "$1" "$2" 2>/dev/null || echo "IND report-node-failed"
}

# firewall_leg <changed-paths file> <package.json diff file> -> OK | RED …
firewall_leg() {
  local hits adapters version
  hits="$(grep -E "$MUST_NOT_WRITE" "$1" | sort -u | tr '\n' ',' || true)"
  adapters="$(grep -E '^src/lib/adapters/[^/]+\.ts$' "$1" | grep -vE "$ADAPTERS_ALLOWED" | sort -u | tr '\n' ',' || true)"
  version="$(grep -cE '^[+-][[:space:]]*"version":' "$2" 2>/dev/null || true)"
  if [ -n "$hits$adapters" ] || [ "${version:-0}" -gt 0 ]; then
    echo "RED must-not-write:${hits}${adapters}${version:+version-lines=$version}"
  else echo "OK"; fi
}

# funding_leg <okx.ts diff file> -> OK | RED …
funding_leg() {
  local n; n="$(grep -ci funding "$1" 2>/dev/null || true)"
  if [ "${n:-0}" -eq 0 ]; then echo "OK"; else echo "RED okx-diff-touches-funding($n)"; fi
}

# leg_token <leg result> -> PASS | FAIL | INDETERMINATE  (a function: bash 3.2 mis-parses a `case` inside $( ))
leg_token() {
  case "$1" in
    OK) echo PASS ;;
    RED*) echo FAIL ;;
    *) echo INDETERMINATE ;;
  esac
}

# decide <build_rc> <suite> <baseline> <contract> <differential> <budget> <firewall> <funding>
decide() {
  local build_rc="$1" suite="$2" red="" ind="" leg name
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) ;;
    FAIL) red="$red suite" ;;
    *) ind="$ind suite:${suite:-none}" ;;
  esac
  shift 2
  for name in baseline contract differential budget firewall funding; do
    leg="${1:-}"; shift || true
    case "$leg" in
      OK) ;;
      RED*) red="$red $name(${leg#RED })" ;;
      *) ind="$ind $name(${leg#IND })" ;;
    esac
  done
  if [ -n "$red" ]; then log "RED:$red${ind:+ (also unverified:$ind)}"; echo CH2_RED; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo CH2_INDETERMINATE; return 3; fi
  log "build + suite + contract (baseline empty) + differential + budget + firewall + funding all passed"
  echo CH2_GREEN; return 0
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { log "required tool '$t' not on PATH"; echo CH2_INDETERMINATE; exit 3; }
  done
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "not inside a git checkout"; echo CH2_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH2_INDETERMINATE; exit 3; }
  [ -r scripts/classify-suite-verdict.mjs ] || { log "the wired suite runner is missing"; echo CH2_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/oah-ch2-gate.XXXXXX")" || { echo CH2_INDETERMINATE; exit 3; }
  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$? suite="" contract="IND suite-not-run" differential="IND suite-not-run" budget="IND suite-not-run"
  if [ "$build_rc" -eq 0 ]; then
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
    contract="$(test_file_leg "$tmp/report.json" "$CONTRACT_TEST")"
    differential="$(test_file_leg "$tmp/report.json" "$DIFF_TEST")"
    budget="$(test_file_leg "$tmp/report.json" "$BUDGET_TEST")"
  fi
  local base fw fu
  base="$(git merge-base origin/main HEAD 2>/dev/null)" || base=""
  if [ -z "$base" ]; then fw="IND no-merge-base"; fu="IND no-merge-base"
  else
    { git diff --name-only "$base"; git ls-files --others --exclude-standard; } >"$tmp/changed.txt" 2>/dev/null
    git diff "$base" -- package.json >"$tmp/pkg.diff" 2>/dev/null
    git diff "$base" -- src/lib/adapters/okx.ts >"$tmp/okx.diff" 2>/dev/null
    fw="$(firewall_leg "$tmp/changed.txt" "$tmp/pkg.diff")"
    fu="$(funding_leg "$tmp/okx.diff")"
  fi
  local bl; bl="$(baseline_empty_leg "$FIXDIR/BASELINE.json")"
  printf 'DIFFERENTIAL_VERDICT=%s\n' "$(leg_token "$differential")"
  printf 'BUDGET_DELTA_VERDICT=%s\n' "$(leg_token "$budget")"
  log "build_rc=$build_rc suite=${suite:-none} baseline=$bl contract=$contract differential=$differential budget=$budget firewall=$fw funding=$fu"
  local rc
  decide "$build_rc" "$suite" "$bl" "$contract" "$differential" "$budget" "$fw" "$fu"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"; else log "evidence kept: $tmp"; fi
  exit "$rc"
}

# post_landing <ch2 sha>
post_landing() {
  local sha="${1:-}" line started gitsha
  [ -n "$sha" ] || { log "usage: --post-landing <CH2 landed sha>"; echo POST_LANDING_VERDICT=INDETERMINATE; exit 3; }
  [ -r "$STATUS_MD" ] || { log "status.md unreadable: $STATUS_MD"; echo POST_LANDING_VERDICT=INDETERMINATE; exit 3; }
  line="$(grep -oE 'T_ADAPTER = [0-9]{10} \([0-9T:.-]+Z\)' "$STATUS_MD" | head -n 1)"
  [ -n "$line" ] || { log "T_ADAPTER not recorded in status.md"; echo POST_LANDING_VERDICT=FAIL; exit 1; }
  started="$(ssh -o ConnectTimeout=10 -i "$SSH_KEY" "$SSH_TARGET" "docker inspect -f '{{.State.StartedAt}}' crypto-quant-signal-mcp-mcp-server-1" 2>/dev/null)" \
    || { log "signal-1 unreachable"; echo POST_LANDING_VERDICT=INDETERMINATE; exit 3; }
  gitsha="$(ssh -o ConnectTimeout=10 -i "$SSH_KEY" "$SSH_TARGET" "docker exec crypto-quant-signal-mcp-mcp-server-1 printenv GIT_SHA" 2>/dev/null)" \
    || { echo POST_LANDING_VERDICT=INDETERMINATE; exit 3; }
  git merge-base --is-ancestor "$sha" "$gitsha" 2>/dev/null || { log "running container $gitsha does not contain $sha"; echo POST_LANDING_VERDICT=FAIL; exit 1; }
  local epoch iso
  epoch="$(printf '%s' "$line" | sed -E 's/T_ADAPTER = ([0-9]+) .*/\1/')"
  iso="$(printf '%s' "$line" | sed -E 's/.*\(([^)]*)\).*/\1/')"
  if [ "${started%%.*}" = "${iso%%.*}" ] || [ "${started%%.*}Z" = "${iso%%.*}" ] || [ "${started%%.*}" = "${iso%Z}" ]; then
    log "T_ADAPTER $epoch ($iso) = StartedAt $started"; echo POST_LANDING_VERDICT=PASS; exit 0
  fi
  log "T_ADAPTER ($iso) != StartedAt ($started)"; echo POST_LANDING_VERDICT=FAIL; exit 1
}

self_test() {
  local pass=0 fail=0 cases=0
  ok_case() { cases=$((cases + 1)); pass=$((pass + 1)); echo "SELF-TEST: ok $1"; }
  bad_case() { cases=$((cases + 1)); fail=$((fail + 1)); echo "SELF-TEST: FAIL $1 ($2)"; }
  check() { local name="$1" want="$2" want_rc="$3"; shift 3; local out rc; out="$(decide "$@" 2>/dev/null)"; rc=$?
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then ok_case "$name"; else bad_case "$name" "got '$out' rc=$rc"; fi; }
  expect_leg() { case "$3" in "$2"*) ok_case "$1" ;; *) bad_case "$1" "leg said '$3', want '$2…'" ;; esac; }
  check green-control CH2_GREEN 0 0 PASS OK OK OK OK OK OK
  check build-failed-red CH2_RED 1 2 "" OK OK OK OK OK OK
  check suite-fail-red CH2_RED 1 0 FAIL OK OK OK OK OK OK
  check suite-unreadable-indeterminate CH2_INDETERMINATE 3 0 "" OK OK OK OK OK OK
  check red-outranks-indeterminate CH2_RED 1 0 "" "RED x" OK OK OK OK OK
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "OAH_CH2_GATE_SELFTEST: FAIL not-in-checkout"; exit 1; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/oah-ch2-selftest.XXXXXX")" || { echo "OAH_CH2_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  # a synthetic vitest report where the three files ran and passed
  node -e '
    const t = (n, s) => ({ name: "/x/" + n, assertionResults: [{ status: s }, { status: "passed" }] });
    const r = { testResults: [t(process.argv[1], "passed"), t(process.argv[2], "passed"), t(process.argv[3], "passed")] };
    require("fs").writeFileSync(process.argv[4], JSON.stringify(r));
  ' "$CONTRACT_TEST" "$DIFF_TEST" "$BUDGET_TEST" "$tmp/report.json"
  expect_leg differential-control-ok OK "$(test_file_leg "$tmp/report.json" "$DIFF_TEST")"
  # M1 (re-anchor on the requested step → the differential's violator assertion fails)
  node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f));r.testResults[1].assertionResults[0].status="failed";require("fs").writeFileSync(f+".m1",JSON.stringify(r))' "$tmp/report.json"
  expect_leg m1-reanchor-requested-step-red RED "$(test_file_leg "$tmp/report.json.m1" "$DIFF_TEST")"
  # M2 (stop reporting the substitution → the contract measures a C3 violation → BASELINE non-empty / contract fails)
  printf '{"entries":[{"venue":"OKX","tf":"1h","clause":"C3","disposition":"report","scenarios":["E"]}]}' >"$tmp/baseline-m2.json"
  expect_leg m2-unreported-substitution-red RED "$(baseline_empty_leg "$tmp/baseline-m2.json")"
  # M3 (absorb a front gap → the budget/contract meta assertion fails)
  node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f));r.testResults[2].assertionResults[0].status="failed";require("fs").writeFileSync(f+".m3",JSON.stringify(r))' "$tmp/report.json"
  expect_leg m3-absorbed-front-gap-red RED "$(test_file_leg "$tmp/report.json.m3" "$BUDGET_TEST")"
  # M4 (edit a passing adapter)
  printf 'src/lib/adapters/bitget.ts\nsrc/lib/adapters/gateio.ts\n' >"$tmp/changed-m4.txt"; : >"$tmp/pkg.diff"
  expect_leg m4-edit-passing-adapter-red RED "$(firewall_leg "$tmp/changed-m4.txt" "$tmp/pkg.diff")"
  # M5 (touch a funding function)
  printf '+  async getFundingHistory(coin: string) {\n' >"$tmp/okx-m5.diff"
  expect_leg m5-touch-funding-red RED "$(funding_leg "$tmp/okx-m5.diff")"
  # M6 (bump BITGET's ceiling)
  printf 'src/lib/adapters/bitget.ts\nsrc/lib/venue-budget-registry.ts\n' >"$tmp/changed-m6.txt"
  expect_leg m6-bump-ceiling-red RED "$(firewall_leg "$tmp/changed-m6.txt" "$tmp/pkg.diff")"
  # M7 (delete the differential → it did not run)
  node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f));r.testResults.splice(1,1);require("fs").writeFileSync(f+".m7",JSON.stringify(r))' "$tmp/report.json"
  expect_leg m7-delete-differential-red RED "$(test_file_leg "$tmp/report.json.m7" "$DIFF_TEST")"
  # controls + the version / zero-assertion / indeterminate edges
  printf 'src/lib/adapters/bitget.ts\nsrc/lib/adapters/okx.ts\nsrc/lib/adapters/_history-plan.ts\ntests/unit/adapter-history-differential.test.ts\n' >"$tmp/changed-ok.txt"
  expect_leg firewall-own-files-ok OK "$(firewall_leg "$tmp/changed-ok.txt" "$tmp/pkg.diff")"
  printf -- '-  "version": "1.27.0",\n+  "version": "1.28.0",\n' >"$tmp/pkg-bump.diff"
  expect_leg firewall-version-bump-red RED "$(firewall_leg "$tmp/changed-ok.txt" "$tmp/pkg-bump.diff")"
  node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f));r.testResults[1].assertionResults=[];require("fs").writeFileSync(f+".z",JSON.stringify(r))' "$tmp/report.json"
  expect_leg differential-zero-assertions-red RED "$(test_file_leg "$tmp/report.json.z" "$DIFF_TEST")"
  printf '{not json' >"$tmp/bad.json"
  expect_leg report-unparseable-indeterminate IND "$(test_file_leg "$tmp/bad.json" "$DIFF_TEST")"
  expect_leg baseline-real-empty OK "$(baseline_empty_leg "$root/$FIXDIR/BASELINE.json")"
  expect_leg token-pass PASS "$(leg_token OK)"
  expect_leg token-fail FAIL "$(leg_token 'RED x')"
  expect_leg token-indeterminate INDETERMINATE "$(leg_token 'IND y')"
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  if [ "$out" = "CH2_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then ok_case missing-tool-indeterminate
  else bad_case missing-tool-indeterminate "got '$out' rc=$rc"; fi
  rm -rf "$tmp"
  if [ "$cases" -lt 22 ]; then echo "OAH_CH2_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "OAH_CH2_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "OAH_CH2_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

if (return 0 2>/dev/null); then return 0; fi
case "${1:-}" in
  --self-test) self_test ;;
  --post-landing) post_landing "${2:-}" ;;
esac
run_gate
