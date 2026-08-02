#!/usr/bin/env bash
# SYSTEM-MAP-ENFORCEMENT-W1 / C2 — onboarding installer for the pre-commit system-map gate.
#
# RETROFITTED onto scripts/lib/hook-block.sh by OPS-SHARED-WORKTREE-STATE-REGISTRY-W1, which
# fixed TWO latent defects measured in that wave's CH1 census:
#
#   1. WORKTREE-BROKEN. It wrote to "$REPO_ROOT/.git/hooks/pre-commit", but in a LINKED WORKTREE
#      `.git` is a FILE (a gitdir pointer), not a directory — `ls <wt>/.git/hooks` returns
#      "Not a directory". So this installer could only ever run from the primary checkout. The
#      defect was latent rather than active: the hook had been written once from the primary
#      checkout on 2026-06-18, `core.hooksPath` is set --local to an ABSOLUTE path, and
#      check_system_map.sh is old enough to be present on every branch — so the gate measured
#      present in 74/74 checkouts despite the installer being unable to run in 73 of them.
#      It now resolves the hooks dir via `git rev-parse --git-common-dir`, like its three
#      siblings.
#
#   2. NON-COMPOSABLE. It emitted a whole-file `exec` oneliner with `printf > "$HOOK_PATH"`,
#      truncating anything already in pre-commit. It is now a guarded marker block, so a future
#      wave can add a second pre-commit consumer without this installer erasing it. The legacy
#      `exec` line is migrated away in the same write (see the legacy-regex argument below) so
#      the gate is never invoked twice.
#
# Argument pass-through is PRESERVED: the block still forwards "$@" to check_system_map.sh.
# `exec cmd "$@"` became `cmd "$@" || exit 1`, which keeps the blocking behaviour identical.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_system_map_hook.sh
#   bash scripts/install_system_map_hook.sh --allow-unpublished   # audited bootstrap only
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

GATE_SCRIPT='scripts/check_system_map.sh'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# NOTE: this comment deliberately does NOT restate the gate's pattern list. Two reasons, and
# the second one bit during this very wave. (1) A duplicated fact goes stale — the SoT is
# scripts/check_system_map.sh, so point at it. (2) The pattern list quoted in prose MATCHES
# ITSELF: an earlier draft of this block listed the patterns, and the pre-commit gate then
# blocked the commit that introduced them. Same shape as the comment-strip lesson already
# recorded for check-canaries-wired.mjs — a mention is not an occurrence.
read -r -d '' COMMENT <<'EOF' || true
# Blocks a commit whose staged diff carries edge-mutation signals unless system-map.md is
# staged in the same commit, or its mtime is under 600s. Signal list + thresholds live in
# scripts/check_system_map.sh (the SoT) — never duplicated here.
EOF

# The 7th argument is the legacy-line regex: it drops this installer's pre-wave whole-file
# `exec` form from the preserved remainder. Without it the migrated hook would invoke the
# system-map gate twice — once from the stale exec line, once from the new block.
hook_block_install pre-commit system-map SYSTEM-MAP-ENFORCEMENT-W1 "$GATE_SCRIPT" "$COMMENT" \
  '"$(git rev-parse --show-toplevel)/scripts/check_system_map.sh" "$@" || exit 1' \
  '^[[:space:]]*exec[[:space:]].*check_system_map\.sh'
