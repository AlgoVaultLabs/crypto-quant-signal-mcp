#!/usr/bin/env bash
# OPS-GREPPABLE-SOURCE-GUARD-W1 — wire scripts/check-source-greppable.mjs into pre-push.
#
# Mirrors scripts/install_session_drift_hook.sh's marker-block idiom VERBATIM rather than
# inventing a second dialect. This appends a THIRD live guarded block to the same hook:
#   1. the test-baseline gate            (OPS-VITEST-SUITE-REPAIR-W1)
#   2. the parallel-session drift gate   (OPS-CC-DRIFT-DETECTOR-W1)
#   3. this one
#   4. AOE main-branch protection        (OPS-AOE-PREPUSH-RESTORE-W1) — still NOT active
# so it also demonstrates the idiom composing past three consumers, further de-risking the
# pending AOE guard.
#
# The hook lives in the shared $GIT_COMMON_DIR, so it governs every worktree and is
# installed once. NEVER restructure the existing blocks — append only.
#
# WHY pre-push and not only CI: the incident this retires was a HAND-TYPED probe on a
# developer machine, not a CI run. Catching a raw NUL before it reaches origin means no
# other session — human or agent — ever greps the blinded file.
#
# Idempotent: re-running once the marker is present is a no-op.
set -euo pipefail

COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
HOOKS_DIR="$COMMON_DIR/hooks"
HOOK_PATH="$HOOKS_DIR/pre-push"
MARKER_BEGIN='# >>> algovault source-greppable (OPS-GREPPABLE-SOURCE-GUARD-W1) >>>'
MARKER_END='# <<< algovault source-greppable <<<'

# Resolves the repo root at hook-run time so it works from any worktree. Deliberately has
# NO warn/override lever: unlike a flaky test suite or a concurrency heuristic, this gate
# is a pure byte property with no false-positive mode — a tracked text file either contains
# a NUL or it does not. An override would only ever be used to push the defect.
read -r -d '' BLOCK <<EOF || true
$MARKER_BEGIN
# A raw NUL byte in a tracked text file makes grep-class tools that skip binaries drop the
# WHOLE file silently at exit 0, so its contents read as ABSENT. Blocks the push; the
# failure output names the file, the byte offset and the escape to use.
node "\$(git rev-parse --show-toplevel)/scripts/check-source-greppable.mjs" --check || exit 1
$MARKER_END
EOF

mkdir -p "$HOOKS_DIR"

if [ -f "$HOOK_PATH" ]; then
  if grep -qF "$MARKER_BEGIN" "$HOOK_PATH"; then
    echo "[source-greppable hook] already installed in $HOOK_PATH (idempotent no-op)"
    exit 0
  fi
  # Composable append — preserve the existing hook (do NOT overwrite).
  printf '\n%s\n' "$BLOCK" >>"$HOOK_PATH"
  chmod +x "$HOOK_PATH"
  echo "[source-greppable hook] appended guarded block to existing $HOOK_PATH (composable)"
  exit 0
fi

# Fresh hook.
printf '%s\n\n%s\n' '#!/usr/bin/env bash' "$BLOCK" >"$HOOK_PATH"
chmod +x "$HOOK_PATH"
echo "[source-greppable hook] created $HOOK_PATH"
