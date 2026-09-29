#!/usr/bin/env bash
# cce-ch2-gate.sh — OPS-CLIENT-CLAIM-EVIDENCE-W1 CH2 (canary v2: confirm evidence, age from confirmation).
#
# Runs, in order, from the repo root:
#   1. python3 ops/monitoring/client-claim-freshness.py --self-test
#        -> a `SELF-TEST: PASS (<n> check(s) ran, floor <n>, 0 failure(s))` line AND exactly ONE
#           `CLIENT_CLAIM_FRESHNESS_VERDICT=PASS` line
#   2. BREAK-PROOF — every break below is applied to a temp copy of the canary, exactly once, and the
#      self-test must go RED on each: `BREAK_PROOF: PASS (k/k)` with k >= 8. A break that does not apply
#      exactly once is mis-specified and makes the leg INDETERMINATE — it would prove nothing.
#   3. rm -rf dist && npm run build && npm run build:knowledge, the full vitest suite with the CI
#      reporters, then scripts/classify-suite-verdict.mjs (SUITE_VERDICT=PASS|PASS_AFTER_ISOLATION), with
#      tests/unit/client-claim-freshness.test.ts RUN and passed — read from the JSON report.
#   4. node scripts/check-alert-copy-claims.mjs  -> ALERT_COPY_VERDICT=OK
#   5. node scripts/check-alert-registry.mjs     -> ALERT_REGISTRY_VERDICT=PASS
#   6. the inventory row `client-claim-freshness` sha256 == shasum -a 256 of the canary (same commit law)
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH2_GREEN          exit 0   every leg passed
#   CH2_RED            exit 1   any leg failed
#   CH2_INDETERMINATE  exit 3   a required tool is missing, or a leg produced no readable verdict
#
# A committed bash script on purpose (the tool shell is zsh). --self-test drives the REAL decide() (the
# script is sourceable) over synthetic legs, plus a PATH-stripped run for the missing-tool precondition.
#
# Usage:  bash scripts/gates/cce-ch2-gate.sh
#         bash scripts/gates/cce-ch2-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm npx python3 git grep shasum)
CANARY='ops/monitoring/client-claim-freshness.py'
NAMED_TEST='tests/unit/client-claim-freshness.test.ts'

# decide <selftest_line> <token_lines> <breakproof_line> <build_rc> <suite> <named> <copy> <registry> <sha>
#   selftest_line: the SELF-TEST: line, or ""        token_lines: count of CLIENT_CLAIM_FRESHNESS_VERDICT=PASS lines
#   breakproof_line: the BREAK_PROOF: line, or ""    named: passed | failed | missing
#   copy: OK | DRIFT | INDETERMINATE | ""            registry: PASS | FAIL | INDETERMINATE | ""
#   sha: match | mismatch | unreadable
decide() {
  local st="$1" toks="$2" bp="$3" build_rc="$4" suite="$5" named="$6" copy="$7" reg="$8" sha="$9"
  local red="" ind=""
  case "$st" in
    "SELF-TEST: PASS ("*", 0 failure(s))") [ "$toks" = "1" ] || red="$red selftest-token-count:$toks" ;;
    "SELF-TEST: FAIL"*) red="$red selftest" ;;
    *) ind="$ind selftest:no-line" ;;
  esac
  case "$bp" in
    "BREAK_PROOF: PASS ("*")")
      local k; k="$(printf '%s' "$bp" | sed -E 's/^BREAK_PROOF: PASS \(([0-9]+)\/([0-9]+)\)$/\1 \2/')"
      set -- $k
      if [ "${1:-x}" != "${2:-y}" ] || [ "${1:-0}" -lt 8 ] 2>/dev/null; then red="$red break-proof:${bp#BREAK_PROOF: }"; fi ;;
    "BREAK_PROOF: FAIL"*) red="$red break-proof" ;;
    *) ind="$ind break-proof:${bp:-no-line}" ;;
  esac
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) ;;
    FAIL) red="$red suite" ;;
    *) ind="$ind suite:${suite:-none}" ;;
  esac
  case "$named" in passed) ;; failed) red="$red named-test" ;; *) ind="$ind named-test:${named:-none}" ;; esac
  case "$copy" in OK) ;; DRIFT) red="$red alert-copy" ;; *) ind="$ind alert-copy:${copy:-none}" ;; esac
  case "$reg" in PASS) ;; FAIL) red="$red alert-registry" ;; *) ind="$ind alert-registry:${reg:-none}" ;; esac
  case "$sha" in match) ;; mismatch) red="$red inventory-sha" ;; *) ind="$ind inventory-sha:${sha:-none}" ;; esac
  if [ -n "$red" ]; then printf '[cce-ch2-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH2_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[cce-ch2-gate] cannot verify:%s\n' "$ind" >&2; echo CH2_INDETERMINATE; return 3; fi
  printf '[cce-ch2-gate] self-test + break-proof + suite + named test + alert copy + alert registry + inventory sha all passed\n' >&2
  echo CH2_GREEN; return 0
}

# break_proof <canary>  -> prints per-break lines and ONE terminal BREAK_PROOF: line
break_proof() {
  python3 - "$1" <<'PY'
import os, subprocess, sys, tempfile
SRC = sys.argv[1]
BREAKS = [
 # the eight the wave spec names
 ("reject ignored",
  'rejected = next((t for t in (anchor.get("reject") or []) if present(t, page["spaces"])), None)', 'rejected = None'),
 ("sha match skipped",
  'prior_ok = (isinstance(prior, dict) and prior.get("evidence_sha") == sha', 'prior_ok = (isinstance(prior, dict) and True'),
 ("headline classes merged",
  '"%d public integration %s not confirmed against %s live source for more than "',
  '"%d public integration %s contradicted by %s live source for more than "'),
 ("JSON vacuity guard removed", 'if len(rows_in) < mod["min_rows"]:', 'if False:'),
 ("moved treated as contradicted",
  '        else:\n            parts.append(AN_CONFIRMED)\n    scope = anchor.get("npmScopeAbsence")',
  '        else:\n            parts.append(AN_CONTRADICTED if out["moved"] else AN_CONFIRMED)\n    scope = anchor.get("npmScopeAbsence")'),
 ("a confirmed row allowed to go stale", '        confirmed_on = ref_day\n', '        confirmed_on = None\n'),
 ("Action literal W1", 'RECOMMENDED_WAVE = "LANDING-{CORPUS}-CLAIMS-W{{NEXT}}"', 'RECOMMENDED_WAVE = "LANDING-{CORPUS}-CLAIMS-W1"'),
 ("unreachable silently ok",
  '    if page["http"] != 200:\n        parts.append(AN_UNREACHABLE)', '    if page["http"] != 200:\n        parts.append(AN_CONFIRMED)'),
 # and the design decisions R0 measured
 ("case-insensitive match", 'return any(token in s for s in spaces)', 'return any(token.lower() in s.lower() for s in spaces)'),
 ("tags stripped to nothing", '_TAG_RE.sub(" ", body)', '_TAG_RE.sub("", body)'),
 ("global row floor", '"min_rows": floor}', '"min_rows": 8}'),
 ("log de-dup detector blind", 'return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)', 'return True'),
 ("vendor hit ignored", '            if hits:\n                parts.append(AN_CONTRADICTED)', '            if False:\n                parts.append(AN_CONTRADICTED)'),
 ("only the first anchor decides the row", 'strongest([a["verdict"] for a in anchors], ANCHOR_PRECEDENCE)]', 'anchors[0]["verdict"]]'),
]
try:
    src = open(SRC, encoding="utf-8").read()
except OSError as e:
    print("BREAK_PROOF: INDETERMINATE (canary unreadable: %s)" % e); sys.exit(3)
red = 0
for name, old, new in BREAKS:
    n = src.count(old)
    if n != 1:
        print("BREAK_PROOF: INDETERMINATE (break %r applies %d times; it must apply exactly once)" % (name, n)); sys.exit(3)
    d = tempfile.mkdtemp(prefix="cce-ch2-break-")
    p = os.path.join(d, "client-claim-freshness.py")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(src.replace(old, new))
    try:
        r = subprocess.run([sys.executable, p, "--self-test"], capture_output=True, text=True, timeout=180)
        went_red = r.returncode != 0 and "SELF-TEST: FAIL" in r.stdout
    except subprocess.TimeoutExpired:
        went_red = False
    red += went_red
    print("  %s %s" % ("RED  " if went_red else "GREEN", name))
print("BREAK_PROOF: %s (%d/%d)" % ("PASS" if red == len(BREAKS) else "FAIL", red, len(BREAKS)))
PY
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[cce-ch2-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH2_INDETERMINATE; exit 3; }
  done
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[cce-ch2-gate] not inside a git checkout" >&2; echo CH2_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH2_INDETERMINATE; exit 3; }
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cce-ch2-gate.XXXXXX")" || { echo CH2_INDETERMINATE; exit 3; }

  python3 "$CANARY" --self-test >"$tmp/selftest.log" 2>&1 || true
  local st toks bp
  st="$(grep -E '^SELF-TEST: ' "$tmp/selftest.log" | tail -n 1)"
  toks="$(grep -cE '^CLIENT_CLAIM_FRESHNESS_VERDICT=PASS$' "$tmp/selftest.log" || true)"
  break_proof "$CANARY" >"$tmp/breakproof.log" 2>&1 || true
  bp="$(grep -E '^BREAK_PROOF: ' "$tmp/breakproof.log" | tail -n 1)"

  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$?
  local suite="" named="missing" copy="" reg="" sha="unreadable"
  if [ "$build_rc" -eq 0 ]; then
    npx vitest run tests/agent-session-source-stamp.test.ts </dev/null >/dev/null 2>&1 || true
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
    named="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const f = (r.testResults || []).find((t) => String(t.name).endsWith(process.argv[2]));
      if (!f) { console.log("missing"); process.exit(0); }
      const a = f.assertionResults || [];
      console.log(a.length > 0 && a.every((x) => x.status === "passed") ? "passed" : "failed");
    ' "$tmp/report.json" "$NAMED_TEST" 2>/dev/null || echo missing)"
  fi
  copy="$(node scripts/check-alert-copy-claims.mjs 2>/dev/null | grep -E '^ALERT_COPY_VERDICT=' | tail -n 1 | sed 's/^ALERT_COPY_VERDICT=//')"
  reg="$(node scripts/check-alert-registry.mjs 2>/dev/null | grep -E '^ALERT_REGISTRY_VERDICT=' | tail -n 1 | sed 's/^ALERT_REGISTRY_VERDICT=//')"
  local want got
  want="$(node -e '
    const inv = JSON.parse(require("fs").readFileSync("ops/monitoring/monitoring-inventory.json", "utf8"));
    const row = (inv.artifacts || []).find((a) => a.id === "client-claim-freshness");
    console.log(row && typeof row.sha256 === "string" ? row.sha256 : "");
  ' 2>/dev/null)"
  got="$(shasum -a 256 "$CANARY" 2>/dev/null | awk '{print $1}')"
  if [ -n "$want" ] && [ -n "$got" ]; then
    if [ "$want" = "$got" ]; then sha=match; else sha=mismatch; fi
  fi
  printf '[cce-ch2-gate] %s | token lines=%s\n[cce-ch2-gate] %s\n[cce-ch2-gate] build_rc=%s suite=%s named=%s alert-copy=%s alert-registry=%s inventory-sha=%s (row %s, file %s)\n' \
    "${st:-no SELF-TEST line}" "$toks" "${bp:-no BREAK_PROOF line}" "$build_rc" "${suite:-none}" "$named" "${copy:-none}" "${reg:-none}" "$sha" "${want:0:12}" "${got:0:12}" >&2
  local rc
  decide "$st" "$toks" "$bp" "$build_rc" "$suite" "$named" "$copy" "$reg" "$sha"; rc=$?
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"
  else printf '[cce-ch2-gate] evidence kept: %s\n' "$tmp" >&2; fi
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
  local S='SELF-TEST: PASS (67 check(s) ran, floor 67, 0 failure(s))' B='BREAK_PROOF: PASS (14/14)'
  check all-pass-green CH2_GREEN 0 "$S" 1 "$B" 0 PASS passed OK PASS match
  check pass-after-isolation-green CH2_GREEN 0 "$S" 1 "$B" 0 PASS_AFTER_ISOLATION passed OK PASS match
  check selftest-fail-red CH2_RED 1 'SELF-TEST: FAIL (67 check(s) ran, floor 67, 1 failure(s))' 0 "$B" 0 PASS passed OK PASS match
  check two-token-lines-red CH2_RED 1 "$S" 2 "$B" 0 PASS passed OK PASS match
  check zero-token-lines-red CH2_RED 1 "$S" 0 "$B" 0 PASS passed OK PASS match
  check break-proof-fail-red CH2_RED 1 "$S" 1 'BREAK_PROOF: FAIL (13/14)' 0 PASS passed OK PASS match
  check break-proof-too-few-red CH2_RED 1 "$S" 1 'BREAK_PROOF: PASS (7/7)' 0 PASS passed OK PASS match
  check build-failed-red CH2_RED 1 "$S" 1 "$B" 2 "" missing OK PASS match
  check suite-fail-red CH2_RED 1 "$S" 1 "$B" 0 FAIL passed OK PASS match
  check named-test-failed-red CH2_RED 1 "$S" 1 "$B" 0 PASS failed OK PASS match
  check alert-copy-drift-red CH2_RED 1 "$S" 1 "$B" 0 PASS passed DRIFT PASS match
  check alert-registry-fail-red CH2_RED 1 "$S" 1 "$B" 0 PASS passed OK FAIL match
  check inventory-sha-mismatch-red CH2_RED 1 "$S" 1 "$B" 0 PASS passed OK PASS mismatch
  check selftest-line-missing-indeterminate CH2_INDETERMINATE 3 "" 0 "$B" 0 PASS passed OK PASS match
  check break-proof-indeterminate CH2_INDETERMINATE 3 "$S" 1 'BREAK_PROOF: INDETERMINATE (break x applies 0 times)' 0 PASS passed OK PASS match
  check suite-unreadable-indeterminate CH2_INDETERMINATE 3 "$S" 1 "$B" 0 "" passed OK PASS match
  check named-missing-indeterminate CH2_INDETERMINATE 3 "$S" 1 "$B" 0 PASS missing OK PASS match
  check alert-copy-token-missing-indeterminate CH2_INDETERMINATE 3 "$S" 1 "$B" 0 PASS passed "" PASS match
  check inventory-unreadable-indeterminate CH2_INDETERMINATE 3 "$S" 1 "$B" 0 PASS passed OK PASS unreadable
  check red-outranks-indeterminate CH2_RED 1 "" 0 "" 2 "" missing "" "" mismatch
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/cce-ch2-selftest.XXXXXX")" || { echo "CCE_CH2_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH2_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 21 ]; then echo "CCE_CH2_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "CCE_CH2_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "CCE_CH2_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
