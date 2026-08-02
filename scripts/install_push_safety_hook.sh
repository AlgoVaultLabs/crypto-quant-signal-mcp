#!/usr/bin/env bash
# OPS-AOE-PREPUSH-RESTORE-W1 — wire scripts/check-push-safety.sh into the shared pre-push hook.
#
# This is the 5th shared pre-push block, and CLAUDE.md carried "AOE main-branch (pre-push)
# protection — still NOT active, tracked by OPS-AOE-PREPUSH-RESTORE-W1" for months for one
# reason: installing a 5th block into the shared hook was, until 2026-08-02, the exact action
# that took every parallel session down. It did so twice in 27 hours.
#
# scripts/lib/hook-block.sh retired that. This installer is the FIRST consumer of that primitive
# written by someone other than its author, so it is also the primitive's first independent test.
# Nothing here is bespoke: the precondition, the emission, the idempotence key and the skip guard
# all come from the helper, and this file only declares what to install.
#
# Deliberately NO --allow-unpublished flag. The escape hatch exists in the helper for a genuine
# bootstrap, but this wave exists partly to demonstrate the precondition working — an override on
# its first independent use would be a poor advertisement, and if it ever refuses here, that is
# the primitive succeeding, not failing. Push the guard first; then run this.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_push_safety_hook.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (this installer takes none — see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-push-safety.sh'
hook_block_assert_publishable "$GATE_SCRIPT" 0 || exit 1

# Block name 'push-safety' is chosen, not incidental: the helper orders blocks canonically by
# LC_ALL=C name, so this sorts FIRST of the five (push-safety < session-drift < shared-state <
# source-greppable < test-gate). That is the right slot on both axes — it is the cheapest guard
# (one stdin read + one merge-base per ref) and the most consequential, so history destruction is
# refused in milliseconds instead of after a full vitest run.
#
# CONSEQUENCE, recorded because it is invisible otherwise: sorting first means this block CONSUMES
# the hook's stdin. Measured 2026-08-02, none of the other four read stdin, so nothing breaks —
# but a future stdin-reading block would find it drained. If one is ever added, tee stdin here
# rather than reordering.
read -r -d '' COMMENT <<'EOF' || true
# Refuses HISTORY DESTRUCTION on a ref declared in ops/push-safety-config.json: a
# non-fast-forward (what a force push IS, detected by effect) or a deletion. Ordinary
# fast-forward pushes, new branches, and every non-protected ref are explicitly ALLOWED —
# this repo auto-pushes, so blocking those would halt every wave. Override (report-only):
#   ALGOVAULT_PUSH_SAFETY=warn git push
EOF

hook_block_install pre-push push-safety OPS-AOE-PREPUSH-RESTORE-W1 "$GATE_SCRIPT" "$COMMENT" \
  'bash "$(git rev-parse --show-toplevel)/scripts/check-push-safety.sh" || exit 1'
