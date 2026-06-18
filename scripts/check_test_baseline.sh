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
# MODES  (env ALGOVAULT_TEST_GATE)
#   block  (default) — exit 1 on regression.
#   warn             — report the regression but exit 0 (don't block).
#
# FAIL-OPEN (never block a legit push on tooling/infra breakage):
#   missing node_modules / vitest / jq, or a failed `npm run build`, or an
#   unparseable vitest report  → loud WARNING + exit 0.
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

# ── fail-open preflight: is the toolchain even present? ──
for need in node npx jq; do
  command -v "$need" >/dev/null 2>&1 || { warn "'$need' not found — cannot run suite; failing OPEN (exit 0)."; exit 0; }
done
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vitest ]; then
  warn "node_modules / vitest missing — run 'npm ci'. Failing OPEN (exit 0)."
  exit 0
fi

# ── build artifacts: snapshot-capabilities (--check reads dist/lib/capabilities.js)
#    and the knowledge-flow integration test (reads dist/knowledge/latest.json)
#    both need a fresh build. A failed compile is its own loud signal (it breaks
#    deploy) and is NOT a test regression → fail-open so the gate stays narrowly
#    scoped to test failures and never false-blocks on a build/infra error. ──
if ! npm run build >"$TMP/test-gate-build.log" 2>&1; then
  warn "npm run build failed — see $TMP/test-gate-build.log. Failing OPEN (exit 0) (compile errors surface via build/deploy, not this gate)."
  exit 0
fi
npm run build:knowledge >"$TMP/test-gate-knowledge.log" 2>&1 \
  || warn "npm run build:knowledge failed — knowledge-flow may not validate (see $TMP/test-gate-knowledge.log)."

# ── run vitest, capture the failing-file set ──
VITEST_JSON="$(mktemp "$TMP/test-gate-vitest.XXXXXX.json")"
npx vitest run --reporter=json --outputFile="$VITEST_JSON" >"$TMP/test-gate-vitest.log" 2>&1 || true
if ! jq -e '.testResults' "$VITEST_JSON" >/dev/null 2>&1; then
  warn "vitest produced no parseable report (see $TMP/test-gate-vitest.log) — infra error; failing OPEN (exit 0)."
  rm -f "$VITEST_JSON"
  exit 0
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
