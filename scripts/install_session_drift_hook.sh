#!/usr/bin/env bash
# OPS-CC-DRIFT-DETECTOR-W1 — wire scripts/check-session-drift.mjs into pre-push.
#
# Mirrors scripts/install_test_gate_hook.sh's marker-block idiom VERBATIM rather than
# inventing a second dialect. This appends a THIRD guarded block to the same hook:
#   1. the live test-baseline gate (OPS-VITEST-SUITE-REPAIR-W1)
#   2. this one
#   3. AOE main-branch protection (OPS-AOE-PREPUSH-RESTORE-W1) — still NOT active
# so it also serves as the proof that the marker-block idiom composes past two consumers,
# de-risking the pending AOE guard.
#
# The hook lives in the shared $GIT_COMMON_DIR, so it governs every worktree and is
# installed once. NEVER restructure the existing blocks — append only.
#
# Idempotent: re-running once the marker is present is a no-op.
set -euo pipefail

COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
HOOKS_DIR="$COMMON_DIR/hooks"
HOOK_PATH="$HOOKS_DIR/pre-push"
MARKER_BEGIN='# >>> algovault session-drift (OPS-CC-DRIFT-DETECTOR-W1) >>>'
MARKER_END='# <<< algovault session-drift <<<'

# Resolves the repo root at hook-run time so it works from any worktree; honours
# ALGOVAULT_SESSION_DRIFT (block|warn), the same lever name-shape as the test gate.
read -r -d '' BLOCK <<EOF || true
$MARKER_BEGIN
# Parallel-session drift detector. Mode 1 (a file changed on BOTH origin/main and this
# branch since its base) BLOCKS and prints the re-point command; modes 2 and 3 report.
# Override (report-only):
#   ALGOVAULT_SESSION_DRIFT=warn git push
node "\$(git rev-parse --show-toplevel)/scripts/check-session-drift.mjs" || exit 1
$MARKER_END
EOF

mkdir -p "$HOOKS_DIR"

if [ -f "$HOOK_PATH" ]; then
  if grep -qF "$MARKER_BEGIN" "$HOOK_PATH"; then
    echo "[session-drift hook] already installed in $HOOK_PATH (idempotent no-op)"
    exit 0
  fi
  # Composable append — preserve the existing hook (do NOT overwrite).
  printf '\n%s\n' "$BLOCK" >>"$HOOK_PATH"
  chmod +x "$HOOK_PATH"
  echo "[session-drift hook] appended guarded block to existing $HOOK_PATH (composable)"
  exit 0
fi

# Fresh hook.
printf '%s\n\n%s\n' '#!/usr/bin/env bash' "$BLOCK" >"$HOOK_PATH"
chmod +x "$HOOK_PATH"
echo "[session-drift hook] created $HOOK_PATH"
