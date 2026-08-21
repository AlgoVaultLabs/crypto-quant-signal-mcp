#!/usr/bin/env bash
# OPS-SECRET-SCAN-PREPUSH-W1 — wire scripts/security-canary.mjs Gate B into the shared pre-push
# hook, so a secret-shaped literal is refused BEFORE it can land on the trunk.
#
# ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
# Gate B is fail-closed and correct. Until this installer it ran in exactly ONE place —
# .github/workflows/deploy.yml:315 — which is AFTER the push. So its only possible expression
# was: the commit lands on main, the deploy dies, production is stranded behind main, and the
# operator is paged by the deploy-drift canary. The gate was never wrong; its LANE was.
#
# MEASURED, four times, always the same shape:
#   2026-07-xx  a gate's own finding message, written SECRET=-shaped   -> deploy 30521611174 red
#   2026-08-xx  a committed postgres://user:password@host DSN          -> deploy red
#   2026-08-19  an AUTH-THREE-STATE `Bearer av_live_<hex>` probe       -> deploy 32281821567 red
#   2026-08-21  the SAME probe literal, in a Plan-Mode audit doc       -> deploy 32488595037 red
#                 prod stranded at 81cf4f0 while main sat at 2c3a6ea for ~3h; DEPLOY_DRIFT paged
#
# The 2026-08-19 instance recorded its own remedy in status.md — "Add security-canary --check=pii
# to the chapter-gate template — it can refuse a deploy and no pre-push check runs it" — and that
# remedy was prose. Two days later the identical literal shipped again. This installer is that
# remedy retired into a gate, per the standing rule that a rule which has once failed as prose
# must become a gate or be deleted.
#
# ─── WHY THE WHOLE TREE, NOT THE PUSHED DIFF ────────────────────────────────────────────────
# A diff-scoped pre-push scan could go green on a push whose resulting TREE still fails CI —
# two corpora, two verdicts, and the drift class survives. Same corpus as deploy.yml means a
# green pre-push PREDICTS a green Gate B, which is the only property that actually retires this.
#
# It is affordable and it does not wedge the fleet. Both measured 2026-08-21, not assumed:
#   · one whole-tree run = 0.39s wall (1150 files) — noise beside the vitest gate that follows it
#   · run across ALL 55 live worktrees: 53 PASS, 2 FAIL, and both failures were the live defect
#     itself (the authoring worktree + a fresh checkout of main). No historical literal anywhere
#     in the fleet, so no stale checkout is wedged by this block.
#
# ─── ORDERING (this is a precondition, not a courtesy) ──────────────────────────────────────
# Install ONLY once the tree this hook governs is clean. Installing while origin/main still
# carried the offending audit literal would have refused every push from every rebased checkout.
# hook_block_assert_publishable covers the script-reachability half; tree-cleanliness is the
# operator's half, and `node scripts/security-canary.mjs --check=pii` is how you check it.
#
#   Flags: --allow-unpublished   skip the publishability precondition (installer-introduces-
#                                its-own-guard case only)
#          --check               report whether the block is installed; change nothing
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh" || { printf '%s\n' "✖ cannot source scripts/lib/hook-block.sh" >&2; exit 1; }

ALLOW_UNPUBLISHED=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

HOOK_PATH="$(hook_block_common_dir)/hooks/pre-push"
if [ "$CHECK_ONLY" = "1" ]; then
  if grep -q '^# >>> algovault secret-scan ' "$HOOK_PATH" 2>/dev/null; then
    printf '%s\n' "[secret-scan] block INSTALLED in $HOOK_PATH"
    exit 0
  fi
  printf '%s\n' "[secret-scan] block NOT installed in $HOOK_PATH" >&2
  exit 1
fi

GATE_SCRIPT='scripts/security-canary.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# NO warn/override lever, deliberately. Every historical hit has been a real credential-shaped
# literal in a tracked file, and the remedy is always the same three-second edit: abbreviate the
# value with an ellipsis, which security-canary.mjs's NOT_A_SECRET already blesses precisely
# because a truncated value cannot be a usable credential. An override here would only ever be
# used to push the thing the gate exists to stop. The skip-guard is NOT an override: it fires
# when the gate script is ABSENT from the pushing worktree, never when the gate FAILS.
#
# --self-test runs FIRST and in the same block: a matcher that has silently stopped matching is
# the one failure mode a passing scan cannot distinguish from a clean tree.
read -r -d '' COMMENT <<'EOF' || true
# Refuses a push carrying a credential-shaped literal in a tracked file — the same Gate B that
# .github/workflows/deploy.yml runs fail-closed, moved LEFT of the push so a hit costs an edit
# instead of a stranded production deploy. Gates on SECRET_SCAN_VERDICT, never the bare exit
# code: exit 0 alone cannot distinguish "scanned the tree, clean" from "scanned nothing".
# Remedy for a hit: abbreviate the value with an ellipsis (`av_live_0123…4567`), never delete
# the evidence and never bypass the hook.
EOF

hook_block_install pre-push secret-scan OPS-SECRET-SCAN-PREPUSH-W1 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/security-canary.mjs" --self-test >/dev/null || { printf "%s\n" "✖ secret-scan: matcher self-test FAILED — the gate cannot be trusted; run: node scripts/security-canary.mjs --self-test" >&2; exit 1; }
  _av_ss_out="$(node "$(git rev-parse --show-toplevel)/scripts/security-canary.mjs" --check=pii 2>&1)"
  _av_ss_verdict="$(printf "%s\n" "$_av_ss_out" | grep -aoE "^SECRET_SCAN_VERDICT=[A-Z]+" | head -1 | cut -d= -f2)"
  printf "%s\n" "SECRET_SCAN_VERDICT=${_av_ss_verdict:-INDETERMINATE}"
  if [ "${_av_ss_verdict:-}" != "PASS" ]; then printf "%s\n" "$_av_ss_out" >&2; exit 1; fi'
