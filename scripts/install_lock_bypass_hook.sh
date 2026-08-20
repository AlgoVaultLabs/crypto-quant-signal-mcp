#!/usr/bin/env bash
# OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH1 R3 — wire the landing-lock BYPASS DETECTOR into the
# shared pre-push hook.
#
# This is the 10th shared pre-push block. Installing a block into that one file is the action
# that took every parallel session down twice inside 27 hours on 2026-08-01/02, so nothing here
# is bespoke: the precondition, the emission, the idempotence key, the canonical ordering and the
# skip guard all come from scripts/lib/hook-block.sh, and this file only declares what to install.
# Deliberately NO --allow-unpublished: push scripts/lib/with-lock.sh first, then run this. If the
# precondition ever refuses here, that is the primitive succeeding.
#
# ─── REPORT-ONLY, WITH THE FLIP CRITERION NAMED ─────────────────────────────────────────────
#
# The block reports whether a push is running inside scripts/land.sh's lock. It NEVER blocks.
# Report-only is a STAGED control, not a permanent preference — a guard parked in REPORT forever
# is decoration, the same shape as a MANUAL_PENDING that sits for months. So the promotion has
# both a numeric and a TIME condition, and every run appends to the ledger so the rate is
# measured rather than guessed at the decision:
#
#   FLIP CRITERION — `bypass-detect` is promoted to BLOCKING in
#   OPS-LANDING-LOCK-ENFORCE-W{NEXT} when BOTH hold:
#     (a) the measured BYPASSED count in $GIT_COMMON_DIR/algovault-locks/bypass-ledger.log is
#         ZERO across a continuous 14-day observation window, and
#     (b) that window has actually elapsed since this block was installed.
#   Count them with:
#     awk -F'\t' '$2=="BYPASSED"' "$(git rev-parse --git-common-dir)/algovault-locks/bypass-ledger.log" | wc -l
#   If BYPASSED is non-zero at 14d, the promotion does NOT fire and the wave reports the rate
#   instead — a criterion that can never be met is worse than no criterion.
#
# ─── ORDERING IS LOAD-BEARING, AND SO IS NOT READING STDIN ──────────────────────────────────
#
# Blocks sort in canonical LC_ALL=C order. MEASURED 2026-08-20, the live order is:
#   dark-exports < gate-staleness < push-safety < quota-surface < session-drift <
#   shared-state < source-greppable < test-gate < worktree-root
# `bypass-detect` sorts before `dark-exports`, so it reports in milliseconds rather than after a
# full vitest run. (An earlier spec draft said the first block was `push-safety`; that came from a
# stale five-block list and is corrected here.)
#
# BLOCKING CONTRACT — THIS BLOCK MUST NOT READ STDIN. scripts/check-push-safety.sh:308 consumes
# the hook's stdin (`while IFS= read -r line || [ -n "$line" ]`), which is the ONLY channel by
# which a pre-push hook learns which refs are being pushed, and its documented three-state
# contract returns PASS on zero lines. A block sorting AHEAD of it that drained stdin would make
# force-push and deletion protection silently PASS — the guard would still print a green token
# while protecting nothing. `--detect` reads no input at all, AND the invocation below redirects
# `</dev/null`, so draining it is structurally impossible rather than merely promised. If this
# detector ever needs ref data, `tee` in check-push-safety.sh as its header instructs. NEVER
# reorder these two blocks.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_lock_bypass_hook.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (this installer takes none — see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/lib/with-lock.sh'
hook_block_assert_publishable "$GATE_SCRIPT" 0 || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Reports whether this push is running inside scripts/land.sh's landing lock.
# REPORT-ONLY — it never blocks, and `|| true` guarantees that mechanically.
#   LANDING_LOCK_VERDICT=ACQUIRED  -> landed through scripts/land.sh
#   LANDING_LOCK_VERDICT=BYPASSED  -> a raw `git push`; prefer: bash scripts/land.sh
# Reads NO stdin (and is redirected from /dev/null), because the push-safety block below
# consumes it and would otherwise see zero ref lines and PASS over an unprotected push.
EOF

hook_block_install pre-push bypass-detect OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 "$GATE_SCRIPT" "$COMMENT" \
  'bash "$(git rev-parse --show-toplevel)/scripts/lib/with-lock.sh" --detect landing </dev/null || true'
