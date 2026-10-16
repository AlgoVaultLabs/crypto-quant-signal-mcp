#!/usr/bin/env bash
# ARCH-MCP-CALL-PIPELINE-W1 CH3 — wire scripts/check-tool-dispatch-boundary.mjs into the shared
# pre-push hook.
#
# WHY A HOOK AND NOT ONLY prepublishOnly. The gate is in BOTH, deliberately, following
# install_quota_surface_hook.sh. prepublishOnly runs at publish time — days after a bypass is
# written and long after it has merged and deployed. pre-push is the first moment a machine can
# refuse the shape. The property this gate holds (every channel dispatches through the ONE
# pipeline) was a prose rule at build-and-runtime.md:75 and did not hold: the MCP-vs-twin drift
# class shipped three fixes and left an open gap under it. CLAUDE.md: "Prose addressed to whoever
# happens to read it is NOT a control."
#
# BACKSTOP STATUS, stated honestly. This gate IS backstopped: the same check runs in
# prepublishOnly, and tests/unit/tool-dispatch-boundary.test.ts runs the self-test inside the
# vitest suite that the test-gate block already enforces. So a worktree missing this file loses
# defence-in-depth, not the guard.
#
# The block runs `npm run tool-dispatch:check`, NOT the .mjs directly, so the invocation is the
# same one prepublishOnly and the docs name. The gate reads src/ with the TypeScript AST and needs
# no build; `typescript` is resolved from the repo's own node_modules.
#
# COUPLING THE SKIP-GUARD DOES NOT COVER, named rather than assumed. hook_block_render's guard
# keys on the presence of the .mjs, but the invocation also needs package.json's
# `tool-dispatch:check` script and ops/tool-dispatch-boundary.json. All three arrive in the SAME
# merge — a worktree that has the checker necessarily has the script and the config. A cherry-pick
# of the .mjs alone would break that pairing; `npm run` then exits non-zero and this block BLOCKS
# rather than skipping, which is the loud failure, not the silent one.
#
# The hook lives in the shared $GIT_COMMON_DIR, so it governs every worktree and is installed once
# per clone. The registry row is ops/shared-worktree-state.json#block-tool-dispatch-boundary.
#
# NOT invoked from CI — developer-onboarding utility.
#   bash scripts/install_tool_dispatch_hook.sh
#   bash scripts/install_tool_dispatch_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"
ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done
# PRECONDITION, never a rule to remember: a block whose script is on no remote ref deadlocks every
# parallel session (measured 2026-08-01/02 — 69 of 75 checkouts could not push a day later, and
# --no-verify is forbidden). hook_block_assert_publishable refuses that conjunction outright.
GATE_SCRIPT='scripts/check-tool-dispatch-boundary.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1
read -r -d '' COMMENT <<'EOF' || true
# Tool-dispatch boundary. Every tool call on every channel (MCP, x402 HTTP, A2MCP, ACP)
# dispatches through src/lib/tool-call-pipeline.ts. No other src/ file may call a tool engine
# or write a tool request_log row unless ops/tool-dispatch-boundary.json carries a reasoned
# row for it; an unregistered call site — and a stale row — fails the push.
EOF
hook_block_install pre-push tool-dispatch-boundary ARCH-MCP-CALL-PIPELINE-W1 "$GATE_SCRIPT" "$COMMENT" \
  'npm run --silent --prefix "$(git rev-parse --show-toplevel)" tool-dispatch:check || exit 1'
