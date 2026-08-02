#!/usr/bin/env bash
# OPS-GREPPABLE-SOURCE-GUARD-W1 — wire scripts/check-source-greppable.mjs into the shared
# pre-push hook.
#
# RETROFITTED onto scripts/lib/hook-block.sh by OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 — and this
# installer is the reason that wave exists. Installed 2026-08-01, it appended a block invoking a
# script that existed only in its own worktree and on no remote branch. Because the hook lives in
# the shared $GIT_COMMON_DIR it governs every worktree, so every other session's push died with
# MODULE_NOT_FOUND — a DEADLOCK, since `--no-verify` is forbidden and deleting the block would
# have disabled a real guard mid-install.
#
# Two things now make that structurally impossible, and neither is a rule anyone must remember:
#   · hook_block_assert_publishable REFUSES to install a block whose script is unreachable from
#     the resolved remote default ref (the precondition replaces "install the block last");
#   · the emitted block SKIPS LOUDLY — banner + ledger row — in a worktree that lacks the script,
#     instead of blocking the push. check-shared-state.mjs escalates anything left unguarded.
#
# WHY pre-push and not only CI: the incident this guard retires was a HAND-TYPED probe on a
# developer machine, not a CI run. Catching a raw NUL before it reaches origin means no other
# session — human or agent — ever greps the blinded file.
#
# NOT invoked from CI — developer-onboarding utility.
#   bash scripts/install_source_greppable_hook.sh
#   bash scripts/install_source_greppable_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-source-greppable.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# The guard deliberately has NO warn/override lever: unlike a flaky test suite or a concurrency
# heuristic, this is a pure byte property with no false-positive mode — a tracked text file
# either contains a NUL or it does not. An override would only ever be used to push the defect.
# The skip-guard is NOT an override: it fires when the gate is ABSENT, never when it FAILS.
read -r -d '' COMMENT <<'EOF' || true
# A raw NUL byte in a tracked text file makes grep-class tools that skip binaries drop the
# WHOLE file silently at exit 0, so its contents read as ABSENT. Blocks the push; the
# failure output names the file, the byte offset and the escape to use.
EOF

hook_block_install pre-push source-greppable OPS-GREPPABLE-SOURCE-GUARD-W1 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/check-source-greppable.mjs" --check || exit 1'
