#!/usr/bin/env bash
# cce-ch1-gate.sh — OPS-CLIENT-CLAIM-EVIDENCE-W1 CH1 (the evidence contract).
#
# Runs, in order, from the repo root:
#   1. rm -rf dist && npm run build && npm run build:knowledge   (deploy.yml's order)
#   2. the full vitest suite with the CI reporters, then scripts/classify-suite-verdict.mjs — the SAME
#      verdict deploy.yml gates on (SUITE_VERDICT=PASS|PASS_AFTER_ISOLATION|FAIL|INDETERMINATE). The raw
#      vitest exit code is NOT the gate. tests/unit/claim-evidence.test.ts AND
#      tests/unit/integrations-data.test.ts must have RUN and passed — read from the JSON report.
#   3. node scripts/emit-claim-evidence.mjs --check        -> CLAIM_EVIDENCE_VERDICT=IN_SYNC
#   4. node scripts/check-mcp-client-copy.mjs              -> MCP_CLIENT_COPY_VERDICT=PASS
#   5. node scripts/build_docs.mjs --check + node scripts/build_landing.mjs --check   (rc 0; 2 = could not run)
#   6. git diff --quiet <merge-base HEAD origin/main> -- landing/ docs/ README.md — no rendered file in the
#      WAVE's diff (working tree included). Against the merge-base, not origin/main itself: a sibling wave
#      landing a landing/ change after this branch was cut would otherwise read as this wave's diff.
#   7. V1_COMPAT — origin/main's client-claim-freshness.py parse_rows() over the edited mcp-clients.ts
#      yields the IDENTICAL (slug, kind, source, verifiedAt) tuples as over origin/main's. The deployed v1
#      canary keeps parsing the TS by regex until CH3, and its field() takes the FIRST `source:` in each
#      row chunk — which is why `evidence` must be every row's LAST property.
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH1_GREEN          exit 0   every leg passed
#   CH1_RED            exit 1   any leg failed
#   CH1_INDETERMINATE  exit 3   a required tool is missing, or a leg produced no readable verdict
#
# A committed bash script on purpose (the tool shell is zsh: ${PIPESTATUS[0]} is empty there, and
# [ "" -eq 0 ] reads TRUE). --self-test drives the REAL decide() (the script is sourceable) over
# synthetic leg results, plus a PATH-stripped run for the missing-tool precondition. No env seam can
# fake a leg.
#
# Usage:  bash scripts/gates/cce-ch1-gate.sh             (from anywhere inside the checkout)
#         bash scripts/gates/cce-ch1-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm npx python3 git grep)
NAMED_TESTS='tests/unit/claim-evidence.test.ts tests/unit/integrations-data.test.ts'

# decide <build_rc> <suite> <named> <evidence> <copy> <docs_rc> <landing_rc> <diff_rc> <v1>
#   suite:    PASS | PASS_AFTER_ISOLATION | FAIL | INDETERMINATE | ""   (no readable verdict)
#   named:    passed | failed | missing
#   evidence: IN_SYNC | DRIFT | INDETERMINATE | ""
#   copy:     PASS | FAIL | INDETERMINATE | ""
#   *_rc:     0 = ok · 1 = drift · anything else / "" = could not run
#   v1:       the V1_COMPAT line, or ""
decide() {
  local build_rc="$1" suite="$2" named="$3" ev="$4" copy="$5" docs="$6" landing="$7" diff="$8" v1="$9"
  local red="" ind=""
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) ;;
    FAIL) red="$red suite" ;;
    *) ind="$ind suite:${suite:-none}" ;;
  esac
  case "$named" in
    passed) ;;
    failed) red="$red named-tests" ;;
    *) ind="$ind named-tests:${named:-none}" ;;
  esac
  case "$ev" in
    IN_SYNC) ;;
    DRIFT) red="$red claim-evidence" ;;
    *) ind="$ind claim-evidence:${ev:-none}" ;;
  esac
  case "$copy" in
    PASS) ;;
    FAIL) red="$red mcp-client-copy" ;;
    *) ind="$ind mcp-client-copy:${copy:-none}" ;;
  esac
  case "$docs" in 0) ;; 1) red="$red build_docs" ;; *) ind="$ind build_docs:rc=${docs:-none}" ;; esac
  case "$landing" in 0) ;; 1) red="$red build_landing" ;; *) ind="$ind build_landing:rc=${landing:-none}" ;; esac
  case "$diff" in 0) ;; 1) red="$red rendered-diff" ;; *) ind="$ind rendered-diff:rc=${diff:-none}" ;; esac
  case "$v1" in
    "V1_COMPAT=PASS"*) ;;
    "V1_COMPAT=FAIL"*) red="$red v1-compat" ;;
    *) ind="$ind v1-compat:no-verdict" ;;
  esac
  if [ -n "$red" ]; then printf '[cce-ch1-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH1_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[cce-ch1-gate] cannot verify:%s\n' "$ind" >&2; echo CH1_INDETERMINATE; return 3; fi
  printf '[cce-ch1-gate] build + suite + named tests + lockstep + copy gate + docs/landing checks + byte-identity + v1 compat all passed\n' >&2
  echo CH1_GREEN; return 0
}

# v1_compat <tmpdir>  -> prints one V1_COMPAT= line (or nothing when it cannot run)
v1_compat() {
  local tmp="$1"
  git show origin/main:ops/monitoring/client-claim-freshness.py >"$tmp/v1.py" 2>/dev/null || return 0
  git show origin/main:src/lib/integrations-data/mcp-clients.ts >"$tmp/base.ts" 2>/dev/null || return 0
  python3 - "$tmp/v1.py" "$tmp/base.ts" src/lib/integrations-data/mcp-clients.ts <<'PY' 2>/dev/null || true
import importlib.util, sys
spec = importlib.util.spec_from_file_location("v1canary", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def tuples(path):
    rows = m.parse_rows(open(path, encoding="utf-8").read(), "mcp-clients")
    return [(r["slug"], r["kind"], r["source"], r["verifiedAt"]) for r in rows]
base, edited = tuples(sys.argv[2]), tuples(sys.argv[3])
same = base == edited and len(base) > 0
print("V1_COMPAT=%s (%d origin/main tuples vs %d edited tuples%s)"
      % ("PASS" if same else "FAIL", len(base), len(edited),
         "" if same else "; first difference: %r" % next(
             ((a, b) for a, b in zip(base, edited) if a != b), ("length", len(base), len(edited)))))
PY
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[cce-ch1-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH1_INDETERMINATE; exit 3; }
  done
  # A wrapper that runs the test suite must not leak git's hook environment into it.
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[cce-ch1-gate] not inside a git checkout" >&2; echo CH1_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH1_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cce-ch1-gate.XXXXXX")" || { echo CH1_INDETERMINATE; exit 3; }

  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$?
  local suite="" named="missing" ev="" copy="" docs="" landing="" diff="" v1=""
  if [ "$build_rc" -eq 0 ]; then
    # deploy.yml's cold-DB pre-warm (best effort), then the suite exactly as deploy.yml runs it.
    npx vitest run tests/agent-session-source-stamp.test.ts </dev/null >/dev/null 2>&1 || true
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
    named="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let out = "passed";
      for (const want of process.argv[2].split(" ")) {
        const f = (r.testResults || []).find((t) => String(t.name).endsWith(want));
        if (!f) { out = "missing"; break; }
        const a = f.assertionResults || [];
        if (!(a.length > 0 && a.every((x) => x.status === "passed"))) out = "failed";
      }
      console.log(out);
    ' "$tmp/report.json" "$NAMED_TESTS" 2>/dev/null || echo missing)"
    ev="$(node scripts/emit-claim-evidence.mjs --check 2>/dev/null | grep -E '^CLAIM_EVIDENCE_VERDICT=' | tail -n 1 | sed 's/^CLAIM_EVIDENCE_VERDICT=//')"
    copy="$(node scripts/check-mcp-client-copy.mjs 2>/dev/null | grep -E '^MCP_CLIENT_COPY_VERDICT=' | tail -n 1 | sed 's/^MCP_CLIENT_COPY_VERDICT=//')"
    node scripts/build_docs.mjs --check >"$tmp/build_docs.log" 2>&1; docs=$?
    node scripts/build_landing.mjs --check >"$tmp/build_landing.log" 2>&1; landing=$?
    git fetch origin --quiet >/dev/null 2>&1 || true
    local base; base="$(git merge-base HEAD origin/main 2>/dev/null)"
    if [ -n "$base" ]; then git diff --quiet "$base" -- landing/ docs/ README.md; diff=$?; else diff=""; fi
    v1="$(v1_compat "$tmp" | tail -n 1)"
  fi
  printf '[cce-ch1-gate] build_rc=%s suite=%s named=%s evidence=%s copy=%s docs_rc=%s landing_rc=%s diff_rc=%s\n[cce-ch1-gate] %s\n' \
    "$build_rc" "${suite:-none}" "$named" "${ev:-none}" "${copy:-none}" "${docs:-none}" "${landing:-none}" "${diff:-none}" "${v1:-no V1_COMPAT line}" >&2
  local rc
  decide "$build_rc" "$suite" "$named" "$ev" "$copy" "$docs" "$landing" "$diff" "$v1"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"
  else printf '[cce-ch1-gate] evidence kept: %s\n' "$tmp" >&2; fi
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
  local V='V1_COMPAT=PASS (12 origin/main tuples vs 12 edited tuples)'
  check all-pass-green CH1_GREEN 0 0 PASS passed IN_SYNC PASS 0 0 0 "$V"
  check pass-after-isolation-green CH1_GREEN 0 0 PASS_AFTER_ISOLATION passed IN_SYNC PASS 0 0 0 "$V"
  check build-failed-red CH1_RED 1 2 "" missing "" "" "" "" "" ""
  check suite-fail-red CH1_RED 1 0 FAIL passed IN_SYNC PASS 0 0 0 "$V"
  check named-tests-failed-red CH1_RED 1 0 PASS failed IN_SYNC PASS 0 0 0 "$V"
  check evidence-drift-red CH1_RED 1 0 PASS passed DRIFT PASS 0 0 0 "$V"
  check copy-fail-red CH1_RED 1 0 PASS passed IN_SYNC FAIL 0 0 0 "$V"
  check docs-drift-red CH1_RED 1 0 PASS passed IN_SYNC PASS 1 0 0 "$V"
  check landing-drift-red CH1_RED 1 0 PASS passed IN_SYNC PASS 0 1 0 "$V"
  check rendered-diff-red CH1_RED 1 0 PASS passed IN_SYNC PASS 0 0 1 "$V"
  check v1-compat-fail-red CH1_RED 1 0 PASS passed IN_SYNC PASS 0 0 0 'V1_COMPAT=FAIL (12 vs 11)'
  check suite-unreadable-indeterminate CH1_INDETERMINATE 3 0 "" passed IN_SYNC PASS 0 0 0 "$V"
  check named-missing-indeterminate CH1_INDETERMINATE 3 0 PASS missing IN_SYNC PASS 0 0 0 "$V"
  check evidence-indeterminate-is-not-green CH1_INDETERMINATE 3 0 PASS passed INDETERMINATE PASS 0 0 0 "$V"
  check copy-token-missing-indeterminate CH1_INDETERMINATE 3 0 PASS passed IN_SYNC "" 0 0 0 "$V"
  check docs-could-not-run-indeterminate CH1_INDETERMINATE 3 0 PASS passed IN_SYNC PASS 2 0 0 "$V"
  check diff-could-not-run-indeterminate CH1_INDETERMINATE 3 0 PASS passed IN_SYNC PASS 0 0 128 "$V"
  check v1-no-verdict-indeterminate CH1_INDETERMINATE 3 0 PASS passed IN_SYNC PASS 0 0 0 ""
  check red-outranks-indeterminate CH1_RED 1 0 FAIL missing "" "" "" "" "" ""
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cce-ch1-selftest.XXXXXX")" || { echo "CCE_CH1_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH1_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 20 ]; then echo "CCE_CH1_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "CCE_CH1_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "CCE_CH1_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
