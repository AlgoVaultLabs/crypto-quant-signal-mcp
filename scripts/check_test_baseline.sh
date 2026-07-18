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
# CONTRACT
#   exit 0  — no new failures vs baseline (or warn-mode, or fail-open).
#   exit 1  — at least one NEW failing file/runner vs baseline (block the push).
#
# MODES  (env)
#   ALGOVAULT_TEST_GATE=block  (default) — exit 1 on regression.
#   ALGOVAULT_TEST_GATE=warn             — report the regression but exit 0.
#   ALGOVAULT_TEST_GATE_AUTOINSTALL=0    — disable the `npm ci` auto-recovery below.
#
# FAIL-OPEN (never block a legit push on tooling/infra breakage):
#   missing node/npx/jq, an unrecoverable dependency state, a GENUINE compile
#   error, or an unparseable vitest report → banner + ledger entry + exit 0.
#
# OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1 (2026-07-18) — fail-open used to be a
# single stderr line, so a checkout whose node_modules was 17 days stale pushed
# UNGATED for weeks without anyone noticing. Two changes, neither of which
# relaxes the compile-error policy:
#   1. RECOVER the recoverable class. A build that fails ONLY on TS2307
#      "Cannot find module" for packages that are declared-but-not-installed is
#      stale node_modules, not a code defect — `npm ci` once, rebuild, then run
#      the suite for real. A genuine compile error still fails open (it surfaces
#      via build/deploy, per the original policy).
#   2. Make every remaining fail-open UNMISSABLE and AUDITABLE — banner + an
#      append to $GIT_COMMON_DIR/algovault-test-gate-failopen.log, which the next
#      GREEN run reports and clears. A ledger nobody reads would be theatre.
#
# IDEMPOTENT — read-only against the repo (only writes /tmp logs + the gitignored
# dist/). Safe to run repeatedly; accepts a no-op `--check` flag.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || { echo "[test-gate] cannot cd to repo root; failing OPEN" >&2; exit 0; }

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

BASELINE_FILE="audits/test-baseline-known-failures.txt"
MODE="${ALGOVAULT_TEST_GATE:-block}"
TMP="${TMPDIR:-/tmp}"

info() { echo "[test-gate] $*"; }
warn() { echo "[test-gate] WARNING: $*" >&2; }

# ── OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1 — loud + auditable fail-open ──────────
#
# The gate is allowed to fail OPEN so tooling breakage never blocks a legit push.
# But "fail open" means NO TEST RAN, and the original single-line stderr warning
# was easy to miss in the middle of push output — so a checkout with stale
# node_modules pushed UNGATED for 17 days without anyone noticing (found
# 2026-07-18; it had already been noted twice in status.md and shrugged off).
#
# Every fail-open now (a) prints an unmissable banner and (b) appends to a ledger
# in $GIT_COMMON_DIR (shared across worktrees, never committed). The ledger is
# READ BACK and surfaced by the next GREEN run — that is what keeps it honest
# rather than a write-only file nobody opens.
FAILOPEN_LOG="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)/algovault-test-gate-failopen.log"

fail_open() {
  local reason="$1" sha
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  {
    echo ""
    echo "════════════════════════════════════════════════════════════════════════"
    echo "  ⚠  TEST GATE SKIPPED — THIS PUSH IS UNGATED"
    echo "════════════════════════════════════════════════════════════════════════"
    echo "  reason : $reason"
    echo "  effect : NO tests ran. Nothing was verified. Allowing the push (exit 0)."
    echo "  logged : $FAILOPEN_LOG"
    echo "════════════════════════════════════════════════════════════════════════"
    echo ""
  } >&2
  printf '%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$sha" "$reason" >>"$FAILOPEN_LOG" 2>/dev/null || true
  exit 0
}

# Surfaced on the GREEN path: the suite has now actually run, so any previously
# ungated commits are covered — report them once, then clear the ledger.
report_and_clear_failopen_ledger() {
  [ -s "$FAILOPEN_LOG" ] || return 0
  local n; n="$(grep -cE '.' "$FAILOPEN_LOG" 2>/dev/null || true)"; n="${n:-0}"
  {
    echo ""
    echo "[test-gate] NOTE: $n push(es) went UNGATED since the last GREEN gate:"
    sed 's/^/  /' "$FAILOPEN_LOG"
    echo "[test-gate] the suite has now run GREEN, so those commits are covered — clearing the ledger."
    echo ""
  } >&2
  : >"$FAILOPEN_LOG"
}

# ── build-failure classifier ──────────────────────────────────────────────────
#
# Distinguishes the two build-failure classes, which need OPPOSITE responses:
#
#   RECOVERABLE   — every error is TS2307 "Cannot find module 'X'" where X
#                   resolves to a package that IS declared in the manifest but is
#                   NOT installed. That is stale node_modules, not a code defect:
#                   there is nothing for a human to fix and the gate can be made
#                   meaningful again by `npm ci`. Failing open here is simply wrong.
#   COMPILE_ERROR — anything else (a non-TS2307 error, a relative-path TS2307, or
#                   a package that is declared AND installed yet unresolvable).
#                   Real compile errors keep the documented fail-open policy:
#                   they surface via build/deploy, not this gate.
#
# Manifest/node_modules roots are overridable so the classifier is unit-testable
# against fixture logs (tests/unit/test-gate-build-classifier.test.ts).
TEST_GATE_MANIFEST="${TEST_GATE_MANIFEST:-package.json}"
TEST_GATE_NODE_MODULES="${TEST_GATE_NODE_MODULES:-node_modules}"

# '@scope/pkg/sub' → '@scope/pkg' · 'pkg/sub' → 'pkg' · './rel' → '' (not a package)
pkg_of_specifier() {
  case "$1" in
    .*|/*) echo "" ;;
    @*)    echo "$1" | cut -d/ -f1,2 ;;
    *)     echo "$1" | cut -d/ -f1 ;;
  esac
}

classify_build_log() {
  local log="$1" errs total ts2307 spec pkg
  [ -f "$log" ] || { echo "COMPILE_ERROR"; return 0; }
  errs="$(grep -E "error TS[0-9]+:" "$log" 2>/dev/null || true)"
  # A build that failed without emitting a single TS error is not a dependency
  # problem (OOM, tsc crash, bad tsconfig) → treat as COMPILE_ERROR (fail open).
  [ -n "$errs" ] || { echo "COMPILE_ERROR"; return 0; }

  total="$(printf '%s\n' "$errs" | grep -cE "error TS[0-9]+:" || true)"
  ts2307="$(printf '%s\n' "$errs" | grep -cE "error TS2307:" || true)"
  # Numeric compare, never string — `wc`/`grep -c` pad with whitespace on BSD.
  [ "${total:-0}" -eq "${ts2307:-0}" ] || { echo "COMPILE_ERROR"; return 0; }

  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    pkg="$(pkg_of_specifier "$spec")"
    # Relative/absolute import that cannot resolve = a real code defect.
    [ -n "$pkg" ] || { echo "COMPILE_ERROR"; return 0; }
    # Not declared anywhere = a real defect (or a missing dependency entry).
    jq -e --arg p "$pkg" \
      '((.dependencies[$p] // .devDependencies[$p] // .optionalDependencies[$p]) != null)' \
      "$TEST_GATE_MANIFEST" >/dev/null 2>&1 || { echo "COMPILE_ERROR"; return 0; }
    # Declared AND present on disk, yet unresolvable = not a stale-install issue.
    [ ! -d "$TEST_GATE_NODE_MODULES/$pkg" ] || { echo "COMPILE_ERROR"; return 0; }
  done < <(printf '%s\n' "$errs" | sed -n "s/.*Cannot find module '\([^']*\)'.*/\1/p" | sort -u)

  echo "RECOVERABLE"
}

# Test/debug entrypoint: classify a build log and exit. Keeps the classifier
# drivable from a unit test without running a build or a push.
if [ "${1:-}" = "--classify-build-log" ]; then
  command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }
  classify_build_log "${2:?usage: $0 --classify-build-log <build.log>}"
  exit 0
fi

# ── fail-open preflight: is the toolchain even present? ──
for need in node npx jq; do
  command -v "$need" >/dev/null 2>&1 || fail_open "'$need' not found on PATH — cannot run the suite."
done

# Auto-recovery is on by default; ALGOVAULT_TEST_GATE_AUTOINSTALL=0 disables it,
# and it never runs on CI (CI does its own install) or without a lockfile.
autoinstall_allowed() {
  [ "${ALGOVAULT_TEST_GATE_AUTOINSTALL:-1}" != "0" ] && [ -z "${CI:-}" ] && [ -f package-lock.json ]
}

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vitest ]; then
  autoinstall_allowed || fail_open "node_modules / vitest missing and auto-recovery is off — run 'npm ci'."
  info "node_modules / vitest missing → recovering with 'npm ci' (once)."
  info "This can take a few minutes; the push is NOT hung."
  npm ci >"$TMP/test-gate-npmci.log" 2>&1 \
    || fail_open "node_modules missing and 'npm ci' recovery FAILED — see $TMP/test-gate-npmci.log. Run 'npm ci' manually."
  [ -x node_modules/.bin/vitest ] \
    || fail_open "'npm ci' completed but node_modules/.bin/vitest is still absent — see $TMP/test-gate-npmci.log."
  info "recovered — dependencies installed."
fi

# ── build artifacts: snapshot-capabilities (--check reads dist/lib/capabilities.js)
#    and the knowledge-flow integration test (reads dist/knowledge/latest.json)
#    both need a fresh build. A failed compile is its own loud signal (it breaks
#    deploy) and is NOT a test regression → fail-open so the gate stays narrowly
#    scoped to test failures and never false-blocks on a build/infra error. ──
#
#    OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1: that fail-open is correct ONLY for a
#    genuine compile error. It was ALSO swallowing "stale node_modules", which is
#    not a code defect at all — so the gate silently skipped every test instead of
#    spending two minutes making itself meaningful again. Classify first, recover
#    the recoverable class, and keep the documented policy for the rest.
run_build() { npm run build >"$TMP/test-gate-build.log" 2>&1; }

if ! run_build; then
  case "$(classify_build_log "$TMP/test-gate-build.log")" in
    RECOVERABLE)
      autoinstall_allowed || fail_open \
        "build failed only on declared-but-uninstalled packages (stale node_modules) and auto-recovery is off — run 'npm ci'."
      info "build failed ONLY on declared-but-uninstalled packages → stale node_modules, not a compile error."
      info "recovering with 'npm ci' (once). This can take a few minutes; the push is NOT hung."
      npm ci >"$TMP/test-gate-npmci.log" 2>&1 \
        || fail_open "stale node_modules and 'npm ci' recovery FAILED — see $TMP/test-gate-npmci.log. node_modules may now be incomplete; run 'npm ci' manually."
      run_build \
        || fail_open "'npm ci' succeeded but the build STILL fails — see $TMP/test-gate-build.log. Treating as a genuine compile error."
      info "recovered — node_modules resynced and the build is clean. Running the suite (the gate is meaningful again)."
      ;;
    *)
      fail_open "npm run build failed with genuine compile error(s) — see $TMP/test-gate-build.log. (Policy unchanged: compile errors surface via build/deploy, not this gate.)"
      ;;
  esac
fi
npm run build:knowledge >"$TMP/test-gate-knowledge.log" 2>&1 \
  || warn "npm run build:knowledge failed — knowledge-flow may not validate (see $TMP/test-gate-knowledge.log)."

# ── run vitest, capture the failing-file set ──
VITEST_JSON="$(mktemp "$TMP/test-gate-vitest.XXXXXX.json")"
npx vitest run --reporter=json --outputFile="$VITEST_JSON" >"$TMP/test-gate-vitest.log" 2>&1 || true
if ! jq -e '.testResults' "$VITEST_JSON" >/dev/null 2>&1; then
  rm -f "$VITEST_JSON"
  fail_open "vitest produced no parseable report (see $TMP/test-gate-vitest.log) — infra error."
fi
CURRENT_FAILS="$(jq -r '.testResults[] | select(.status=="failed") | .name' "$VITEST_JSON" \
                 | sed "s#.*/tests/#tests/#" | sort -u)"
rm -f "$VITEST_JSON"

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
NEW_FAILS="$(comm -13 <(printf '%s\n' "$BASELINE") <(printf '%s\n' "$CURRENT_FAILS") | grep -vE '^[[:space:]]*$' || true)"
KNOWN_N="$(printf '%s' "$BASELINE" | grep -cE '.' || true)"

if [ -z "$NEW_FAILS" ] && [ -z "$NODE_FAILS" ]; then
  # The suite actually ran and is clean → any commits pushed while the gate was
  # failing open are now covered. Surface them once, then clear the ledger.
  report_and_clear_failopen_ledger
  info "GREEN — vitest + node:test pass; no new failures vs baseline (${KNOWN_N} allow-listed)."
  exit 0
fi

echo "[test-gate] ✗ NEW test failure(s) vs the committed baseline ($BASELINE_FILE):" >&2
[ -n "$NEW_FAILS" ] && printf '  - %s\n' $NEW_FAILS >&2
[ -n "$NODE_FAILS" ] && echo "  - $NODE_FAILS" >&2
if [ "$MODE" = "warn" ]; then
  warn "ALGOVAULT_TEST_GATE=warn → reporting only, NOT blocking (exit 0)."
  exit 0
fi
echo "[test-gate] push BLOCKED. Fix the regression, OR re-run with ALGOVAULT_TEST_GATE=warn to override," >&2
echo "[test-gate] OR (if genuinely intractable) quarantine it with a ledger row + a line in $BASELINE_FILE." >&2
exit 1
