#!/usr/bin/env bash
# OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 — wire scripts/check-shared-state.mjs into the shared
# pre-push hook.
#
# DOGFOODING, deliberately: this reconciler polices the shared hooks, and it is installed by the
# very mechanism it polices (scripts/lib/hook-block.sh). A guard exempt from its own contract is
# the first one to rot — and the exemption would be invisible, because nothing would ever check
# it. It also means the reconciler cannot be installed before it is pushed, which is the exact
# workflow assert_publishable exists to enforce.
#
# The hook lives in the shared $GIT_COMMON_DIR, so it governs every worktree and is installed
# once per clone.
#
# NOT invoked from CI. CI runs `--self-test` ONLY (see .github/workflows/deploy.yml): a live
# `--check` on a runner is structurally vacuous — a fresh clone has exactly one worktree and no
# installed hooks, so every worktree-local check would pass over an empty corpus and read as
# coverage. Same treatment the workflow already gives check-session-drift.mjs.
#
#   bash scripts/install_shared_state_hook.sh
#   bash scripts/install_shared_state_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-shared-state.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Shared-across-worktree state reconciler. ONLY UNPUBLISHED_DEP blocks — a hook block whose
# script is unreachable from the remote default ref, i.e. the 2026-08-01 incident. Every other
# check reports. Override (report-only):
#   ALGOVAULT_SHARED_STATE=warn git push
EOF

hook_block_install pre-push shared-state OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/check-shared-state.mjs" --check || exit 1'
