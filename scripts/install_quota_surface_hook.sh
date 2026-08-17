#!/usr/bin/env bash
# OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH3 — wire scripts/check-quota-surface-conformance.mjs
# into the shared pre-push hook.
#
# WHY A HOOK AND NOT ONLY prepublishOnly. The gate is in BOTH, deliberately. prepublishOnly runs at
# publish time, which is days after the defect is written and long after it has been merged and
# deployed; instances 9-13 all reached PRODUCTION and were found by reading live output. pre-push is
# the first moment a machine can refuse the shape. CLAUDE.md: "Prose addressed to whoever happens to
# read it is NOT a control" — and a gate that only runs when someone remembers to publish is prose.
#
# BACKSTOP STATUS, stated honestly. Unlike check-session-drift.mjs this gate IS backstopped: the
# same check runs in prepublishOnly, and check A rides the wired vitest suite that the test-gate
# block already enforces. So a worktree missing this file loses defence-in-depth, not the guard.
#
# The block runs `npm run quota:surface:check`, NOT the .mjs directly. That script is
# `tsc && node scripts/check-quota-surface-conformance.mjs`, and the tsc is load-bearing: the
# checker reads the registry from dist/lib/quota-surfaces.js (the same dist/-import shape
# check-rank-metrics-parity.mjs and check-feature-registry-drift.mjs use). Invoking the .mjs alone
# on a tree whose dist/ is stale would compare source against a registry from an older build —
# INDETERMINATE at best, quietly wrong at worst.
#
# COUPLING THE SKIP-GUARD DOES NOT COVER, named rather than assumed. hook_block_render's guard keys
# on the presence of the .mjs, but the invocation also needs package.json's `quota:surface:check`
# script. The two are safe because they arrive in the SAME merge — a worktree that has the checker
# necessarily has the script. A cherry-pick of the .mjs alone would break that pairing; if anyone
# ever does it, `npm run` exits non-zero and this block BLOCKS rather than skipping, which is the
# loud failure, not the silent one.
#
# The hook lives in the shared $GIT_COMMON_DIR, so it governs every worktree and is installed once
# per clone.
#
# NOT invoked from CI — developer-onboarding utility.
#   bash scripts/install_quota_surface_hook.sh
#   bash scripts/install_quota_surface_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

# PRECONDITION, never a rule to remember: a block whose script is on no remote ref deadlocks every
# parallel session (measured 2026-08-01/02 — 69 of 75 checkouts could not push a day later, and
# --no-verify is forbidden). hook_block_assert_publishable refuses that conjunction outright.
GATE_SCRIPT='scripts/check-quota-surface-conformance.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Quota-surface conformance. A quota fact may reach a caller only through the single
# derivation: every emitting call site must be covered by a row in src/lib/quota-surfaces.ts,
# and a row's declared status must match what the detectors read from its source. Deferred
# rows report loudly and do not block, but their blocker and emitted shape are re-verified
# on every run, so a deferral expires by itself.
EOF

hook_block_install pre-push quota-surface OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 "$GATE_SCRIPT" "$COMMENT" \
  'npm run --silent --prefix "$(git rev-parse --show-toplevel)" quota:surface:check || exit 1'
