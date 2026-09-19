#!/usr/bin/env bash
# install_primitive_resolution_hook.sh — OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH2.
#
# Installs the primitive-resolution gate as a guarded block in the shared `pre-commit` hook.
# Emission goes through scripts/lib/hook-block.sh — the ONE emitter — so this installer
# hand-rolls nothing: not the sentinels, not the skip guard, not the ordering.
#
# ─── READ BEFORE RUNNING: THE BLAST RADIUS IS EVERY CHECKOUT ────────────────────────────────
# `core.hooksPath` resolves every worktree to ONE hooks file. Measured 2026-09-19: 146 checkouts
# on this one hooks dir. A block installed before its script is reachable from a remote ref is
# the deadlock this estate already paid for once (2026-08-02, 69-70 checkouts unable to commit
# for over a day), and `--no-verify` is forbidden here. So hook_block_assert_publishable runs
# FIRST and is fail-closed — a PRECONDITION enforced by the tool, never a rule to remember.
#
# That precondition is a CONVENTION every install_*_hook.sh honours, NOT something
# hook_block_install enforces on its behalf. Deleting the asserts below would not fail loudly;
# it would install a block whose script no sibling can fetch. Do not.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_primitive_resolution_hook.sh
#   bash scripts/install_primitive_resolution_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0

for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-primitive-resolution.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# The gate REFUSES (INDETERMINATE) without its corpus or its shared tools/list parser, so both are
# asserted too. Asserting only the entry point is the hazard install_map_shape_hook.sh already paid
# for: a block installed while its config is unreachable makes every gated commit refuse with an
# INDETERMINATE the committer cannot act on.
hook_block_assert_publishable 'ops/primitive-registry.json' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'scripts/lib/mcp-tools-list.mjs' "$ALLOW_UNPUBLISHED" || exit 1

# This comment deliberately does NOT restate the rows. The SoT is ops/primitive-registry.json, and
# a duplicated fact goes stale.
read -r -d '' COMMENT <<'EOF' || true
# Blocks a commit while a primitive this estate NAMES does not RESOLVE. An `npm_package` row with
# `invocation: cli` needs a non-empty `bin` on `dist-tags.latest`; `invocation: library` needs only
# publication (bin is a CLI property, not an existence property — @modelcontextprotocol/sdk, zod and
# express are all bin-less and all correct); an `mcp_tool` row must be on the live `tools/list`,
# read through the shared scripts/lib/mcp-tools-list.mjs and exhausted via nextCursor.
# Rows live in ops/primitive-registry.json (the SoT). A row declared `live` that stops resolving
# FAILs, and so does a `planned` row that starts resolving — a stale registry is how this class
# returns.
#
# THE TWO CALLERS DO NOT SHARE ONE FAILURE RESPONSE, and that is deliberate.
#   FAIL          -> blocks here AND in CI. The primitive was measured; it does not resolve.
#   INDETERMINATE -> blocks in CI; HERE it prints the token and downgrades the EXIT CODE only.
# This is the FIRST network-dependent block in this hook — all six incumbents are local-only, so
# none of them has an INDETERMINATE state to mirror. Failing closed here would make 146 checkouts'
# ability to commit a function of npm's and api.algovault.com's uptime, with --no-verify forbidden;
# install_forbidden_phrases_hook.sh's own header records 2026-08-02, when a block installed ahead
# of its script left 69-70 checkouts unable to commit for over a day. CI is the gate that guards
# the estate; this is the fast local signal.
# The lever shape is ALGOVAULT_TEST_GATE=warn's, reused verbatim, not a second idiom: it downgrades
# the CODE, never the TOKEN, and the outcome stays legible in the log. The gate law asks that
# exit 0 never encode both "verified, clean" and "verified nothing" — the distinguishable token is
# what carries that, and it is always printed and never suppressed.
# A permanently-degraded read (a rotted URL, not a plane) surfaces loudly at the strict caller: CI
# refuses every PR until it is fixed. No local logger is needed and none is installed.
# Network legs carry a TOTAL wall-clock budget of 5s (PRIMRES_BUDGET_MS); exhaustion is
# INDETERMINATE. A refused port fails in milliseconds, but a blackholed route hangs — measured
# 2026-09-19, one unbounded curl to a dropped route took 30,031ms while the gate returned
# INDETERMINATE in 5,112ms.
# Escape hatch: ALGOVAULT_SKIP_PRIMITIVE_RESOLUTION=1 git commit …  (logged to the skip ledger).
EOF

# ONE invocation string. `hook_block_install`'s 7th arg is a legacy-drop REGEX, not a second body
# line — passing the verdict check there would silently delete matching lines from the hook instead
# of running it.
read -r -d '' INVOCATION <<'EOF' || true
ALGOVAULT_PR_OUT="$(node "$(git rev-parse --show-toplevel)/scripts/check-primitive-resolution.mjs" 2>&1)" || true
ALGOVAULT_PR_TOK="$(printf '%s\n' "$ALGOVAULT_PR_OUT" | grep -oE '^PRIMITIVE_RESOLUTION_VERDICT=[A-Z]+' | tail -1)"
case "$ALGOVAULT_PR_TOK" in
  PRIMITIVE_RESOLUTION_VERDICT=PASS) : ;;
  PRIMITIVE_RESOLUTION_VERDICT=INDETERMINATE)
    printf '%s\n' "$ALGOVAULT_PR_OUT" >&2
    printf '%s\n' "⚠️  primitive-resolution: $ALGOVAULT_PR_TOK downgraded to exit 0 here. Nothing is blocked locally; CI is fail-closed on this verdict and will refuse the PR." >&2 ;;
  *) printf '%s\n' "$ALGOVAULT_PR_OUT" >&2; exit 1 ;;
esac
EOF

hook_block_install pre-commit primitive-resolution OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
