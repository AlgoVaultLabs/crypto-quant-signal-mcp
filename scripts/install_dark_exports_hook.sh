#!/usr/bin/env bash
# install_dark_exports_hook.sh — install the new-dark-export guard as a pre-push block.
# PRICING-FOLLOWUPS-GENERATOR-W1 CH2. The 8th guarded block.
#
# Composable: emits a marker-delimited block via scripts/lib/hook-block.sh, which imposes a
# canonical block order on every write, so the result is byte-identical regardless of the
# sequence installers happen to run in. Idempotent — re-running replaces the block, never
# appends a second one.
#
# The block SKIPS LOUDLY (if/else, never a bare `exit 0`) when the gate script is absent from
# the pushing worktree: an early exit would abort the whole hook and silently take every LATER
# block with it. A skip writes a ledger row to $GIT_COMMON_DIR/algovault-hook-skip.log.
#
# `hook_block_assert_publishable` refuses to install a block whose script is on NO remote ref —
# the precondition that exists because installing one before publishing it once wedged ~70
# checkouts, and `--no-verify` is forbidden by policy so it was a deadlock, not a failure.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-new-dark-exports.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# "Built, tested, never wired." hoursUntilUtcDayReset shipped exported, unit-tested against four
# boundary cases, and called by NOTHING — one reference in all of src/, its own declaration.
# Production told daily-walled callers "come back in 30 days" for a day and a half with a green
# suite the whole time, because every assertion pointed at the primitive rather than the path.
#
# Flags exports the branch ADDS whose src/ reference count is 1. NOT a whole-repo census: that
# was measured and rejected — 1,812 exports, 971 dark, and the largest bucket (475) is
# CLAUDE.md's own mandated test-importable-seam pattern, so it would be allowlisted into
# uselessness on day one. On the wave that shipped the defect the delta flagged 2 of 23.
# Numbers in audits/PRICING-FOLLOWUPS-GENERATOR-W1-dark-export-census.md.
#
# Ships mode=report: findings print, the push is never blocked. Promotion needs BOTH a zero
# count and a date (ops/dark-exports-config.json) — a numeric criterion alone can never fire if
# the count never heals, and a date alone flips a guard that is still noisy.
EOF

hook_block_install pre-push dark-exports PRICING-FOLLOWUPS-GENERATOR-W1 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/check-new-dark-exports.mjs" || exit 1'
