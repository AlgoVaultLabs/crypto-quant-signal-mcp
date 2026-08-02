#!/usr/bin/env bash
# OPS-CC-DRIFT-DETECTOR-W1 — wire scripts/check-session-drift.mjs into the shared pre-push hook.
#
# RETROFITTED onto scripts/lib/hook-block.sh by OPS-SHARED-WORKTREE-STATE-REGISTRY-W1. This
# installer previously mirrored install_test_gate_hook.sh's marker-block idiom by hand; all four
# now share ONE emitter, so emission, idempotence, composability and the skip-guard cannot drift
# between them. The GUARD's behaviour is unchanged.
#
# ⚠️ THIS IS THE GATE WITH REAL RESIDUAL EXPOSURE WHEN SKIPPED. check-source-greppable.mjs is
# backstopped by deploy.yml + prepublishOnly, so a skipped pre-push run costs only defence-in-
# depth. This one is NOT backstopped and cannot be: it reasons about the set of live worktrees,
# and a CI runner is a fresh clone with exactly one. A worktree lacking this file has NO
# stale_base protection at all — measured 2026-08-02 at 55 of 74 checkouts. That is precisely
# what scripts/check-shared-state.mjs's UNGUARDED_WORKTREE check exists to escalate.
#
# The hook lives in the shared $GIT_COMMON_DIR, so it governs every worktree and is installed
# once per clone.
#
# NOT invoked from CI — developer-onboarding utility.
#   bash scripts/install_session_drift_hook.sh
#   bash scripts/install_session_drift_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-session-drift.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Parallel-session drift detector. Mode 1 (a file changed on BOTH origin/main and this
# branch since its base) BLOCKS and prints the re-point command; modes 2 and 3 report.
# Override (report-only):
#   ALGOVAULT_SESSION_DRIFT=warn git push
EOF

hook_block_install pre-push session-drift OPS-CC-DRIFT-DETECTOR-W1 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/check-session-drift.mjs" || exit 1'
