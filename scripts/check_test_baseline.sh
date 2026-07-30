#!/usr/bin/env bash
# OPS-VITEST-SUITE-REPAIR-W1 / C4 — local test-baseline regression gate.
#
# Runs the full vitest suite (`vitest run`) AND the node:test canaries (the
# landing/design/geo `.test.mjs` files run via `node --test` in deploy.yml),
# then diffs the failing-FILE set against the committed baseline at
# audits/test-baseline-known-failures.txt. Exits 1 if ANY NEW failure appears
# (a regression) — this substitutes for the absent push-triggered CI greenness
# gate (deploys go via scripts/deploy-direct.sh; push-triggered GHA is flagged
# off). Sibling installer: scripts/install_test_gate_hook.sh wires this into
# .git/hooks/pre-push (composably).
#
# CONTRACT  [OPS-TEST-GATE-FAILOPEN-W1]
#   Every run prints EXACTLY ONE terminal machine-readable line:
#       TEST_GATE_VERDICT=PASS | FAIL | INDETERMINATE
#   Never absent, never more than one. Callers MUST read the token, not just the
#   exit code, and a chapter/CI verdict requires TEST_GATE_VERDICT=PASS.
#
#   exit 0  — PASS: the suite ran and no new failure appeared vs the baseline.
#   exit 1  — FAIL: at least one NEW failing file/runner vs the baseline.
#   exit 3  — INDETERMINATE: the suite did not produce a parseable report, so
#             NOTHING was verified. 3 (not 2) reuses the existing monitoring
#             convention — postgres-cpu-autopilot.py is 0=silent / 1=escalate /
#             2=critical-bypass / 3=framework-error — so there is ONE convention
#             in the tree rather than a second one. (Was exit 2 between
#             OPS-TEST-GATE-MKTEMP-PORTABILITY-W1 and this wave.)
#
# WHY A TOKEN AT ALL — this gate is the verdict source for every Bulk-Spec chapter
# gate, and `exit 0` alone cannot express the difference between "verified, clean"
# and "verified nothing". During SIGNAL-CLOSEDBAR-SHADOW-W1 CH2 it printed a pass
# having run zero tests; the chapter survived only because the operator re-ran it
# manually and refused the green. That is luck, not process. CLAUDE.md's law: a
# dark guard exiting 0 is indistinguishable from a healthy one.
#
# MODES  (env ALGOVAULT_TEST_GATE)
#   block  (default) — exit 0 / 1 / 3 as above.
#   warn             — the ONE fail-open lever and the documented operator opt-out.
#                      It downgrades the EXIT CODE to 0 but NEVER the token, so the
#                      degradation stays visible in the output. This is deliberately
#                      the only way to get a non-zero condition to exit 0: there is
#                      no `--hook` flag, because the installed pre-push hook is
#                      `… || exit 1` and therefore already blocks on any non-zero —
#                      a flag with no consumer would be dead config.
#
# NOTHING FAILS OPEN SILENTLY ANY MORE. Missing node/npx/jq, missing node_modules,
# a failed `npm run build`, an unusable report path (mktemp) and an unparseable
# report are ALL "the gate verified nothing" ⇒ INDETERMINATE / exit 3. The fix for
# the environment cases is `npm ci`; the escape hatch is ALGOVAULT_TEST_GATE=warn.
#   [pinned by tests/unit/test-gate-report-path.test.ts]
#
# IDEMPOTENT — read-only against the repo (only writes /tmp logs + the gitignored
# dist/). Safe to run repeatedly; accepts a no-op `--check` flag and `--self-test`.
set -uo pipefail

BASELINE_FILE="audits/test-baseline-known-failures.txt"
# Resolved BEFORE the first possible verdict() call, so warn-mode is honoured even
# on the earliest failure path.
MODE="${ALGOVAULT_TEST_GATE:-block}"

info() { echo "[test-gate] $*"; }
warn() { echo "[test-gate] WARNING: $*" >&2; }

# ── the ONE place a verdict is emitted ─────────────────────────────────────────
#
# Single-derivation: token → exit code is mapped here and nowhere else, and every
# `exit` in this script goes through it. That is what makes "exactly one
# TEST_GATE_VERDICT line per run" structural rather than a convention someone has
# to remember on the next early-return they add.
map_code() {  # $1 = token, $2 = mode → echoes the exit code
  local c
  case "$1" in
    PASS)          c=0 ;;
    FAIL)          c=1 ;;
    INDETERMINATE) c=3 ;;
    *)             echo 3; return 0 ;;
  esac
  # warn downgrades the CODE, never the token.
  if [ "$c" -ne 0 ] && [ "${2:-block}" = "warn" ]; then c=0; fi
  echo "$c"
}

verdict() {  # $1 = PASS|FAIL|INDETERMINATE
  local token="$1" code
  case "$token" in
    PASS|FAIL|INDETERMINATE) ;;
    *) warn "internal: unknown verdict token '$token' — reporting INDETERMINATE."; token=INDETERMINATE ;;
  esac
  code="$(map_code "$token" "$MODE")"
  if [ "$token" != "PASS" ] && [ "$MODE" = "warn" ]; then
    warn "ALGOVAULT_TEST_GATE=warn → $token downgraded to exit 0. Nothing is blocked."
  fi
  echo "TEST_GATE_VERDICT=$token"
  exit "$code"
}

# ── pure decision helpers (driven directly by --self-test) ─────────────────────
# Kept side-effect-free so the self-test can exercise the real logic hermetically
# instead of re-implementing it — a self-test against a copy proves nothing.
report_usable() {  # $1 = report path
  [ -n "${1:-}" ] && [ -f "$1" ] && jq -e '.testResults' "$1" >/dev/null 2>&1
}
compute_new_fails() {  # $1 = baseline set, $2 = current failing set
  comm -13 <(printf '%s\n' "$1") <(printf '%s\n' "$2") | grep -vE '^[[:space:]]*$' || true
}
decide_verdict() {  # $1 = new-failure set, $2 = node:test failure marker
  if [ -n "${1:-}" ] || [ -n "${2:-}" ]; then echo FAIL; else echo PASS; fi
}

# ── --self-test (hermetic: never runs the real suite) ──────────────────────────
if [ "${1:-}" = "--self-test" ]; then
  command -v jq >/dev/null 2>&1 || { echo "✖ self-test needs jq on PATH"; echo "TEST_GATE_VERDICT=INDETERMINATE"; exit 3; }
  st_dir="$(mktemp -d "${TMPDIR:-/tmp}"/test-gate-selftest.XXXXXX)" || { echo "✖ self-test could not mktemp -d"; echo "TEST_GATE_VERDICT=INDETERMINATE"; exit 3; }
  trap 'rm -rf "$st_dir"' EXIT
  printf '{"testResults":[{"name":"/r/tests/a.test.ts","status":"passed"}]}' > "$st_dir/good.json"
  printf 'not json at all'                                                   > "$st_dir/garbage.json"

  st_fails=(); st_fire=0; st_nofire=0; st_map=0

  # must-map: the token→exit-code mapping IS the contract, so it is asserted
  # directly and not merely implied by the token assertions.
  #
  # This corpus exists because the deliberate-breakage step found it missing:
  # re-coding `INDETERMINATE) c=3` to `c=0` — precisely the defect this wave
  # exists to fix — left the token assertions fully green. A self-test that
  # cannot catch the regression it was written for is decoration.
  chk_map() {  # $1 = label, $2 = expected code, $3 = token, $4 = mode
    st_map=$((st_map + 1))
    local got; got="$(map_code "$3" "$4")"
    if [ "$2" = "$got" ]; then echo "    ✓ must-map: $1 ⇒ exit $got"
    else st_fails+=("WRONG must-map: $1 — expected exit $2, got $got"); fi
  }
  # must-fire: each MUST be treated as "nothing was verified" / "a regression".
  chk_fire() {  # $1 = case name, $2 = expected token, $3 = actual token
    st_fire=$((st_fire + 1))
    if [ "$2" = "$3" ]; then echo "    ✓ must-fire: $1 ⇒ $3/$(map_code "$3" block)"
    else st_fails+=("MISSED must-fire: $1 — expected $2, got $3"); fi
  }
  chk_nofire() {
    st_nofire=$((st_nofire + 1))
    if [ "$2" = "$3" ]; then echo "    ✓ must-not-fire: $1 ⇒ $3/$(map_code "$3" block)"
    else st_fails+=("FALSE POSITIVE must-not-fire: $1 — expected $2, got $3"); fi
  }
  tok_for_report() { if report_usable "${1:-}"; then echo PASS; else echo INDETERMINATE; fi; }

  echo "[test-gate] --self-test (hermetic; no suite is run)"
  chk_fire   "empty report path (mktemp failure)"        INDETERMINATE "$(tok_for_report "")"
  chk_fire   "unparseable report"                        INDETERMINATE "$(tok_for_report "$st_dir/garbage.json")"
  chk_fire   "absent report file"                        INDETERMINATE "$(tok_for_report "$st_dir/nope.json")"
  chk_fire   "new failure absent from the baseline"      FAIL \
             "$(decide_verdict "$(compute_new_fails "tests/known.test.ts" "tests/known.test.ts
tests/brand-new.test.ts")" "")"
  chk_nofire "clean report matching the baseline"        PASS \
             "$(decide_verdict "$(compute_new_fails "tests/known.test.ts" "")" "")"
  chk_nofire "the only failure IS allow-listed"          PASS \
             "$(decide_verdict "$(compute_new_fails "tests/known.test.ts" "tests/known.test.ts")" "")"

  chk_map "PASS in block mode"          0 PASS          block
  chk_map "FAIL in block mode"          1 FAIL          block
  chk_map "INDETERMINATE in block mode" 3 INDETERMINATE block
  chk_map "FAIL under warn"             0 FAIL          warn
  chk_map "INDETERMINATE under warn"    0 INDETERMINATE warn
  chk_map "PASS is never downgraded"    0 PASS          warn

  # Vacuity guard — a self-test that ran zero assertions prints the same ✓ as one
  # that ran twelve. CLOSEDBAR CH2's PII-guard self-test shipped exactly that way
  # and reported a green "passed (0 must-fire, 0 must-not-fire)".
  if [ "$st_fire" -eq 0 ] || [ "$st_nofire" -eq 0 ] || [ "$st_map" -eq 0 ]; then
    echo "✖ self-test is VACUOUS — must-fire=$st_fire must-not-fire=$st_nofire must-map=$st_map (all must be > 0); refusing to report a pass."
    echo "TEST_GATE_VERDICT=INDETERMINATE"
    exit 3
  fi
  if [ "${#st_fails[@]}" -gt 0 ]; then
    echo "✖ self-test FAILED:"; printf '   - %s\n' "${st_fails[@]}"
    echo "TEST_GATE_VERDICT=FAIL"
    exit 1
  fi
  echo "[test-gate] ✓ self-test passed ($st_fire must-fire, $st_nofire must-not-fire, $st_map must-map)"
  echo "TEST_GATE_VERDICT=PASS"
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || { warn "cannot cd to repo root — nothing was verified."; verdict INDETERMINATE; }

# CRITICAL: when invoked from a git hook (pre-push), git exports GIT_DIR /
# GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX / GIT_COMMON_DIR / GIT_QUARANTINE_PATH
# into the environment. Tests that spawn `git` subprocesses (e.g.
# tests/unit/check-system-map.test.ts, which inits temp git repos and runs
# `git -C <tmpdir> commit`) would inherit them and operate on the WRONG repo —
# the env GIT_DIR overrides even `git -C` → the temp-repo setup fails → false
# regressions that would block EVERY push. Scrub them so the suite runs in a
# clean git env (REPO_ROOT was already resolved above, before this point).
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_COMMON_DIR \
      GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH \
      GIT_NAMESPACE GIT_REFLOG_ACTION 2>/dev/null || true

# macOS exports TMPDIR WITH a trailing slash; strip it so composed paths don't
# contain a cosmetic `//` (it shows up in every log path this script prints).
TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"

# ── the gate could not run the suite ───────────────────────────────────────────
#
# Callers of this used to be split across two classes — "fail-open" for an
# environment the pusher can't fix (no node/npx/jq, no node_modules, a compile
# error) and "hard fail" for an unusable report path. OPS-TEST-GATE-FAILOPEN-W1
# collapses them: from the caller's point of view they are the SAME FACT — the
# gate verified nothing — and encoding one of them as `exit 0` is what let CH2
# read a broken toolchain as a green suite.
hard_fail() {
  {
    echo ""
    echo "[test-gate] ================================================================"
    echo "[test-gate] ✗ GATE COULD NOT VERIFY — NO TESTS RAN"
    echo "[test-gate]   $1"
    echo "[test-gate] ================================================================"
  } >&2
  [ "$MODE" = "warn" ] || echo "[test-gate] BLOCKED. Fix the toolchain (usually 'npm ci'), or override with: ALGOVAULT_TEST_GATE=warn" >&2
  verdict INDETERMINATE
}

# ── preflight: is the toolchain even present? ──
for need in node npx jq; do
  command -v "$need" >/dev/null 2>&1 || hard_fail "'$need' not found — the suite was never invoked."
done
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vitest ]; then
  hard_fail "node_modules / vitest missing — run 'npm ci'. The suite was never invoked."
fi

# ── build artifacts: snapshot-capabilities (--check reads dist/lib/capabilities.js)
#    and the knowledge-flow integration test (reads dist/knowledge/latest.json)
#    both need a fresh build, so a failed compile means those tests CANNOT run.
#    Previously fail-open (exit 0) on the reasoning that a compile error surfaces
#    loudly via deploy anyway — true, but it still left the gate reporting a pass
#    over a suite it never ran. It is INDETERMINATE, not PASS: the compile error
#    is still its own loud signal, and this gate simply stops claiming otherwise. ──
if ! npm run build >"$TMP/test-gate-build.log" 2>&1; then
  hard_fail "npm run build failed — see $TMP/test-gate-build.log. Part of the suite cannot run."
fi
npm run build:knowledge >"$TMP/test-gate-knowledge.log" 2>&1 \
  || warn "npm run build:knowledge failed — knowledge-flow may not validate (see $TMP/test-gate-knowledge.log)."

# ── run vitest, capture the failing-file set ──
#
# PORTABILITY — the template's `XXXXXX` MUST be the last thing in the name.
# BSD/macOS mktemp does not substitute `XXXXXX` when a suffix follows it, so the
# previous `mktemp "$TMP/test-gate-vitest.XXXXXX.json"` created a file named
# LITERALLY `test-gate-vitest.XXXXXX.json` (GNU mktemp substitutes, so this was
# invisible on ubuntu CI). Once that literal name existed — left by a concurrent
# worktree session, or by an interrupted run — the next mktemp exited 1 with
# EMPTY stdout ("mkstemp failed …: File exists"). With no `set -e` the script
# carried on with an empty path → `npx vitest run --outputFile=` →
# `CACError: option --outputFile <filename/-s> value is missing` → no report →
# the parse check below fired and the gate exited 0 having verified NOTHING
# (observed 2026-07-29, SIGNAL-CLOSEDBAR-SHADOW-W1 CH2).
#
# `mktemp -d` with a TRAILING `XXXXXX` substitutes on both BSD and GNU, and the
# per-run directory keeps a readable `report.json` inside it. The EXIT trap
# removes it even on an interrupted run, so no leftover can poison the next one.
VITEST_DIR="$(mktemp -d "$TMP/test-gate-vitest.XXXXXX" 2>/dev/null)" || VITEST_DIR=""
cleanup_vitest_dir() { [ -n "${VITEST_DIR:-}" ] && rm -rf "$VITEST_DIR"; return 0; }
trap cleanup_vitest_dir EXIT
if [ -z "$VITEST_DIR" ] || [ ! -d "$VITEST_DIR" ]; then
  hard_fail "could not create a temp report dir under $TMP (mktemp -d failed) — vitest was never invoked."
fi
VITEST_JSON="$VITEST_DIR/report.json"
npx vitest run --reporter=json --outputFile="$VITEST_JSON" >"$TMP/test-gate-vitest.log" 2>&1 || true
if ! report_usable "$VITEST_JSON"; then
  hard_fail "vitest wrote no parseable report to $VITEST_JSON — see $TMP/test-gate-vitest.log (tail below).
[test-gate]   $(tail -3 "$TMP/test-gate-vitest.log" 2>/dev/null | tr '\n' ' ')"
fi
CURRENT_FAILS="$(jq -r '.testResults[] | select(.status=="failed") | .name' "$VITEST_JSON" \
                 | sed "s#.*/tests/#tests/#" | sort -u)"
cleanup_vitest_dir

# ── run the node:test canaries (every tests/**/*.test.mjs that is NOT a vitest
#    file — detected by content so new node:test files are auto-covered) ──
NODE_TEST_FILES=()
while IFS= read -r f; do
  grep -q "from 'vitest'" "$f" 2>/dev/null && continue   # vitest-owned .mjs (e.g. snapshot-capabilities)
  NODE_TEST_FILES+=("$f")
done < <(find tests -name '*.test.mjs' 2>/dev/null | sort)
NODE_FAILS=""
if [ "${#NODE_TEST_FILES[@]}" -gt 0 ]; then
  if ! node --test "${NODE_TEST_FILES[@]}" >"$TMP/test-gate-nodetest.log" 2>&1; then
    NODE_FAILS="node:test canaries (see $TMP/test-gate-nodetest.log)"
  fi
fi

# ── baseline diff: NEW = current-failing − allow-listed-known-failing ──
BASELINE="$( [ -f "$BASELINE_FILE" ] && grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$BASELINE_FILE" | sort -u || true )"
NEW_FAILS="$(compute_new_fails "$BASELINE" "$CURRENT_FAILS")"
KNOWN_N="$(printf '%s' "$BASELINE" | grep -cE '.' || true)"

# The SAME pure helper the self-test drives, so the shipped decision and the
# asserted decision cannot drift.
VERDICT_TOKEN="$(decide_verdict "$NEW_FAILS" "$NODE_FAILS")"

if [ "$VERDICT_TOKEN" = "PASS" ]; then
  info "GREEN — vitest + node:test pass; no new failures vs baseline (${KNOWN_N} allow-listed)."
  verdict PASS
fi

echo "[test-gate] ✗ NEW test failure(s) vs the committed baseline ($BASELINE_FILE):" >&2
[ -n "$NEW_FAILS" ] && printf '  - %s\n' $NEW_FAILS >&2
[ -n "$NODE_FAILS" ] && echo "  - $NODE_FAILS" >&2
[ "$MODE" = "warn" ] || {
  echo "[test-gate] BLOCKED. Fix the regression, OR re-run with ALGOVAULT_TEST_GATE=warn to override," >&2
  echo "[test-gate] OR (if genuinely intractable) quarantine it with a ledger row + a line in $BASELINE_FILE." >&2
}
verdict FAIL
