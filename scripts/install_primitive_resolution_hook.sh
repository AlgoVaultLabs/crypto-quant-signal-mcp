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

# The self-test loads the shipped registry, and the gate imports its shared tools/list parser at
# module load, so both are asserted too. Asserting only the entry point is the hazard
# install_map_shape_hook.sh already paid for: a block installed while its config is unreachable makes
# every gated commit refuse with a verdict the committer cannot act on.
hook_block_assert_publishable 'ops/primitive-registry.json' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'scripts/lib/mcp-tools-list.mjs' "$ALLOW_UNPUBLISHED" || exit 1

# This comment deliberately does NOT restate the rows. The SoT is ops/primitive-registry.json, and
# a duplicated fact goes stale.
read -r -d '' COMMENT <<'EOF' || true
# OFFLINE (OPS-EDITORIAL-PRIMITIVE-LIVE-AT-PUBLISH-W1): no npm, no MCP endpoint. Blocks a commit
# while ops/primitive-registry.json (the SoT) no longer loads, or while the primitive-resolution
# gate's own two-way self-test fails — the two things a commit can actually break. Runs
# `--self-test`, which loads the shipped registry (every row needs its fields) and proves the gate
# still tells PASS from FAIL. Deterministic: no INDETERMINATE state, so nothing to downgrade.
#
# The LIVE reads live where they measure something a commit cannot:
#   - registry vs npm + the DEPLOYED tools/list: deploy.yml's post-deploy primitive step, on every
#     deploy — FAIL reds the run, INDETERMINATE (transport) is a ::warning::
#     (OPS-DEPLOY-LANE-NETWORK-FREE-W1);
#   - a post vs the real tools/list at the moment it ships: algovault-editorial's G14 live leg.
# Until this wave the block made those live reads on EVERY commit in every checkout. It could not
# fail closed on a transport error (with --no-verify forbidden, every checkout's ability to commit
# would follow npm's and api.algovault.com's uptime), so it was mostly network noise, measuring the
# deployed build at the one moment nothing is being deployed.
# Escape hatch: ALGOVAULT_SKIP_PRIMITIVE_RESOLUTION=1 git commit …  (logged to the skip ledger).
EOF

# ONE invocation string. `hook_block_install`'s 7th arg is a legacy-drop REGEX, not a second body
# line — passing the verdict check there would silently delete matching lines from the hook instead
# of running it.
read -r -d '' INVOCATION <<'EOF' || true
ALGOVAULT_PR_OUT="$(node "$(git rev-parse --show-toplevel)/scripts/check-primitive-resolution.mjs" --self-test 2>&1)" || true
ALGOVAULT_PR_TOK="$(printf '%s\n' "$ALGOVAULT_PR_OUT" | grep -oE '^PRIMITIVE_RESOLUTION_VERDICT=[A-Z]+' | tail -1)"
if [ "$ALGOVAULT_PR_TOK" != "PRIMITIVE_RESOLUTION_VERDICT=PASS" ]; then
  printf '%s\n' "$ALGOVAULT_PR_OUT" >&2
  printf '%s\n' "✖ primitive-resolution (offline): ${ALGOVAULT_PR_TOK:-no verdict token} — the registry or the gate's self-test is broken in this tree; run: node scripts/check-primitive-resolution.mjs --self-test" >&2
  exit 1
fi
EOF

hook_block_install pre-commit primitive-resolution OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
