#!/usr/bin/env bash
# install_map_edges_hook.sh — OPS-SYSTEM-MAP-DIRECTORY-W1 CH5.
#
# Installs the system-map EDGE-SET gate as a guarded block in the shared `pre-commit` hook, beside
# the map-SHAPE and map-FRESHNESS gates. Emission goes through scripts/lib/hook-block.sh — the ONE
# emitter — so this installer hand-rolls nothing: not the sentinels, not the skip guard, not the
# ordering.
#
# ─── THE BLOCK IS REPORT-ONLY, AND THAT IS THE DESIGN, NOT A SOFT START ─────────────────────
# The corpus is the VAULT. A one-sided edge is authored by whoever edited a card there, while the
# committer here may be a different session that the Scope Rule forbids from writing cards at all.
# A blocking verdict must land on someone who can act on it, so this block prints the token and
# ledgers a non-PASS, and never fails a commit. The BLOCKING half is .github/workflows/deploy.yml,
# which verifies the committed identifier lock — an artifact the committer does own.
#
# ─── READ BEFORE RUNNING: THE BLAST RADIUS IS EVERY CHECKOUT ────────────────────────────────
# `core.hooksPath` is set --local to the ABSOLUTE /Users/tank/code/crypto-quant-signal-mcp/
# .git/hooks, so every worktree resolves to this one file regardless of $GIT_COMMON_DIR —
# 139 checkouts measured 2026-09-15. A block installed before its script is reachable from a
# remote ref is what left ~70 of them unable to push for over a day in 2026-08, which is why
# hook_block_assert_publishable runs FIRST, for the script, its lock AND the path library, and is
# fail-closed. Ordering is a precondition here, never a rule someone has to remember.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_map_edges_hook.sh
#   bash scripts/install_map_edges_hook.sh --allow-unpublished   # audited bootstrap only
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

GATE_SCRIPT='scripts/check-map-edges.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# The two dependencies are asserted too. The gate resolves its corpus by SOURCING
# scripts/lib/system-map-path.sh and compares against ops/system-map-edges.lock.json; a block
# installed while either is unreachable would report INDETERMINATE in every gated commit, which is
# noise nobody can act on. Three files, one precondition — asserting only the entry point would
# leave the real hazard unguarded.
hook_block_assert_publishable 'scripts/lib/system-map-path.sh' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'ops/system-map-edges.lock.json' "$ALLOW_UNPUBLISHED" || exit 1

# This comment deliberately does NOT restate the grammar or the checks. The SoT is
# scripts/check-map-edges.mjs; a duplicated fact goes stale, and — measured on a sibling installer
# — a pattern list quoted in prose can MATCH ITSELF and block the very commit that introduces it.
read -r -d '' COMMENT <<'EOF' || true
# Reports whether the system map's edge set is bidirectionally consistent: every backticked §3
# counterpart has its mirror edge, every counterpart exists in the router, every edge carries a
# coupling flag, and per-card unresolved debt may only SHRINK. Grammar, checks and the lock
# contract live in scripts/check-map-edges.mjs (the SoT) — never duplicated here.
# Verdict is a TOKEN, never the bare exit code: MAP_EDGES_VERDICT=PASS|FAIL|INDETERMINATE (0/1/3),
# printed beside MAP_EDGES_RECIPROCITY_COVERAGE=<resolved>/<total>.
# REPORT-ONLY BY CONSTRUCTION: the corpus is the vault, so a defect here is usually authored by a
# session other than the committer, and the Scope Rule forbids that committer from fixing a card.
# A non-PASS prints the tail of the run and appends one row to the shared skip ledger; it NEVER
# fails the commit. The blocking half is .github/workflows/deploy.yml, over the committed lock.
EOF

read -r -d '' INVOCATION <<'EOF' || true
ALGOVAULT_MAP_EDGES_OUT="$(node "$(git rev-parse --show-toplevel)/scripts/check-map-edges.mjs" 2>&1 || true)"
if ! printf '%s\n' "$ALGOVAULT_MAP_EDGES_OUT" | grep -qE '^MAP_EDGES_VERDICT=PASS$'; then
  printf '%s\n' "$ALGOVAULT_MAP_EDGES_OUT" | tail -n 12 >&2
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" MAP_EDGES_REPORT map-edges "$(git rev-parse --show-toplevel)" scripts/check-map-edges.mjs \
    >>"$(cd "$(git rev-parse --git-common-dir)" && pwd)/algovault-hook-skip.log" 2>/dev/null || true
fi
EOF

hook_block_install pre-commit map-edges OPS-SYSTEM-MAP-DIRECTORY-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
