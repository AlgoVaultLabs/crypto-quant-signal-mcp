#!/usr/bin/env bash
# install_map_shape_hook.sh — SYSTEM-MAP-SHAPE-GATE-W1.
#
# Installs the map-SHAPE gate as a guarded block in the shared `pre-commit` hook, beside the
# existing map-FRESHNESS gate. Emission goes through scripts/lib/hook-block.sh — the ONE
# emitter — so this installer hand-rolls nothing: not the sentinels, not the skip guard, not
# the ordering.
#
# ─── READ BEFORE RUNNING: THE BLAST RADIUS IS EVERY CHECKOUT ────────────────────────────────
# `core.hooksPath` is set --local to the ABSOLUTE /Users/tank/code/crypto-quant-signal-mcp/
# .git/hooks, so every worktree resolves to this one file regardless of $GIT_COMMON_DIR.
# Measured 2026-08-02: 74 checkouts on one hooks dir; a block installed before its script was
# reachable from any remote ref left 69-70 of them unable to push for over a day. That is why
# hook_block_assert_publishable runs FIRST and is fail-closed — ordering is a precondition
# here, never a rule someone has to remember.
#
# ─── ON BLOCK ORDER ─────────────────────────────────────────────────────────────────────────
# The dispatching spec asked for this block "immediately after the existing check_system_map.sh
# call". That is not achievable and must not be forced: hook_block_install imposes canonical
# LC_ALL=C name order on EVERY write (hook-block.sh design decision 3), so `map-shape` lands
# BEFORE `system-map`. This is behaviourally irrelevant — the two gates are independent
# processes, each `|| exit 1` — and order-independence is a property of our own rule rather
# than of installer sequence, which is the whole point of imposing it.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_map_shape_hook.sh
#   bash scripts/install_map_shape_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check_map_shape.sh'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# The dependency is asserted too. The gate resolves its target by SOURCING
# scripts/lib/system-map-path.sh, so a block installed while that library is unreachable would
# make every gated commit REFUSE with an INDETERMINATE it cannot act on. Two files, one
# precondition — asserting only the entry point would leave the real hazard unguarded.
hook_block_assert_publishable 'scripts/lib/system-map-path.sh' "$ALLOW_UNPUBLISHED" || exit 1

# This comment deliberately does NOT restate the three checks or the threshold. The SoT is
# scripts/check_map_shape.sh; a duplicated fact goes stale, and — measured on the sibling
# installer — a pattern list quoted in prose can MATCH ITSELF and block the very commit that
# introduces it. A mention is not an occurrence.
read -r -d '' COMMENT <<'EOF' || true
# Blocks a commit when system-map.md has stopped being MAP-SHAPED: over-long lines, rows whose
# cell count disagrees with their own header, or prose/blanks splitting a table. Checks,
# threshold and verdict tokens live in scripts/check_map_shape.sh (the SoT) — never duplicated
# here. Reads its target via --system-map from scripts/lib/system-map-path.sh, the ONE
# definition shared with the freshness gate, so this block carries no path of its own.
# Verdict is a TOKEN, never the bare exit code: SYSTEM_MAP_SHAPE_VERDICT=PASS|FAIL|INDETERMINATE
# (0/1/3). Fail-closed on BOTH non-PASS verdicts — a gate that cannot read its target blocks.
# Escape hatch: ALGOVAULT_SKIP_MAP_SHAPE=1 git commit …  (total, and logged to the skip ledger
# with the bypassed verdict in the event column; a FAIL-bypass also needs a commit-body reason).
EOF

hook_block_install pre-commit map-shape SYSTEM-MAP-SHAPE-GATE-W1 "$GATE_SCRIPT" "$COMMENT" \
  '"$(git rev-parse --show-toplevel)/scripts/check_map_shape.sh" --system-map || exit 1'
