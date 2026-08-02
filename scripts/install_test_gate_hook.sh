#!/usr/bin/env bash
# OPS-VITEST-SUITE-REPAIR-W1 / C4 — installer for the local pre-push test-gate.
#
# Wires scripts/check_test_baseline.sh into the shared pre-push hook so every push is checked
# against the committed green baseline (substitutes for the flag-disabled push-triggered CI).
#
# RETROFITTED onto scripts/lib/hook-block.sh by OPS-SHARED-WORKTREE-STATE-REGISTRY-W1. Emission,
# the idempotence key, composability and the skip-guard now live in ONE helper shared by all four
# installers — this was the 4th hand-rolled emitter, past the 3-example extraction threshold. The
# GUARD's behaviour is unchanged; only how it is installed changed.
#
# WORKTREE-SAFE — the helper resolves the hooks dir via `git rev-parse --git-common-dir`, the
# shared $GIT_COMMON_DIR. The hook governs EVERY linked worktree: install once per clone, not per
# worktree. (Measured 2026-08-02: 74 checkouts share one hooks dir on this machine.)
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_test_gate_hook.sh
#   bash scripts/install_test_gate_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check_test_baseline.sh'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Local greenness gate — substitutes for the flag-disabled push-triggered CI.
# Blocks a push that introduces a NEW test failure vs the committed baseline
# (audits/test-baseline-known-failures.txt). Override (report-only):
#   ALGOVAULT_TEST_GATE=warn git push
EOF

hook_block_install pre-push test-gate OPS-VITEST-SUITE-REPAIR-W1 "$GATE_SCRIPT" "$COMMENT" \
  '"$(git rev-parse --show-toplevel)/scripts/check_test_baseline.sh" || exit 1'
