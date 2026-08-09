#!/usr/bin/env bash
# install_worktree_root_hook.sh — install the worktree-root guard as a pre-push block.
# OPS-WORKTREE-ROOT-CONFINEMENT-W2 R3b. The 7th guarded block.
#
# Composable: emits a marker-delimited block via scripts/lib/hook-block.sh, which imposes a
# canonical block order on every write, so the result is byte-identical regardless of the
# sequence installers happen to run in. Idempotent — re-running replaces the block, never
# appends a second one.
#
# The block SKIPS LOUDLY (if/else, never a bare `exit 0`) when the gate script is absent from
# the pushing worktree: an early exit would abort the whole hook and silently take every LATER
# block with it. A skip writes a ledger row to $GIT_COMMON_DIR/algovault-hook-skip.log.
#
# `hook_block_assert_publishable` refuses to install a block whose script is on NO remote ref —
# that conjunction is what deadlocked ~70 checkouts on 2026-08-01/02, and it is a precondition
# here rather than a rule anyone has to remember. Do NOT pass --allow-unpublished to work
# around it; push the script first.
#
#   usage: bash scripts/install_worktree_root_hook.sh [--allow-unpublished]
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-worktree-root.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Worktree placement was the last EMERGENT shared resource on this machine: CWD-derived and
# tool-version-dependent, with ONE primary observed holding FOUR distinct worktree parents and
# all three modern placements appearing inside a single ~24h window. A convention that mutable
# cannot be documented, only DECLARED — ops/shared-worktree-state.json#worktree_roots.
#
# TWO assertions, counted separately in one token, because they clear on different timelines:
#   R1 CONFINEMENT — every worktree under the declared worktree_root
#   R2 NON-NESTING — no worktree inside a primary's or another worktree's tree
# R2 is NOT a subset of R1: <repo>/.claude/worktrees/x is under ~/code yet nested, which is the
# shape behind the vitest-discovery pathology (1779 discovered test files vs 298 real).
#
# Ships mode=report: violations are counted and printed, the push is never blocked. Promotion
# to blocking carries a count AND a date, per assertion, in the SoT.
EOF

hook_block_install pre-push worktree-root OPS-WORKTREE-ROOT-CONFINEMENT-W2 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/check-worktree-root.mjs" --check || exit 1'
