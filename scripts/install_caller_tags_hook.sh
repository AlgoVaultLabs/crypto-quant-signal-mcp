#!/usr/bin/env bash
# install_caller_tags_hook.sh — OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 CH1.
#
# Installs the caller-tag integrity gate as a guarded block in the shared `pre-commit` hook.
# Emission goes through scripts/lib/hook-block.sh — the ONE emitter — so this installer hand-rolls
# nothing: not the sentinels, not the skip guard, not the ordering.
#
# ─── READ BEFORE RUNNING: THE BLAST RADIUS IS EVERY CHECKOUT ────────────────────────────────
# `core.hooksPath` resolves every worktree to ONE hooks file. A block installed before its script is
# reachable from a remote ref deadlocks every parallel session, and `--no-verify` is forbidden here.
# So hook_block_assert_publishable runs FIRST and is fail-closed. Install ORDER: the gate LANDS on the
# remote default, THEN this installer runs. A checkout whose tree predates the gate skips the block
# loudly (hook-block.sh's skip guard).
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_caller_tags_hook.sh
#   bash scripts/install_caller_tags_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"
ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done
GATE_SCRIPT='scripts/check-caller-tags.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1
read -r -d '' COMMENT <<'EOF' || true
# Blocks a commit that adds an upstream-budget caller tag which names two spenders: a name that is not
# a literal / conditional of literals / registered builder (src/lib/caller-tags.ts), or a name emitted
# by two entrypoints (import graph incl. dynamic import()). The per-caller acquisition ledger keys on
# this tag, so a shared tag silently merges two spenders' weight into one row.
#
# THE TWO CALLERS DO NOT SHARE ONE FAILURE RESPONSE, and that is deliberate (same contract as the
# form-action block):
#   FAIL          -> blocks here AND in CI (deploy.yml, fail-closed).
#   INDETERMINATE -> blocks in CI; HERE it prints the token and does NOT block. INDETERMINATE means the
#                    gate could not read the tree (typescript absent, helper module missing, zero call
#                    sites) — unfinished proof, not a proven defect — and this hook is ONE file governing
#                    every checkout on the machine.
EOF
read -r -d '' INVOCATION <<'EOF' || true
ALGOVAULT_CT_OUT="$(node "$(git rev-parse --show-toplevel)/scripts/check-caller-tags.mjs" --check 2>&1)" || true
ALGOVAULT_CT_TOK="$(printf '%s\n' "$ALGOVAULT_CT_OUT" | grep -oE '^CALLER_TAG_VERDICT=[A-Z]+' | tail -1)"
case "$ALGOVAULT_CT_TOK" in
  CALLER_TAG_VERDICT=PASS) printf '%s\n' "$ALGOVAULT_CT_TOK" ;;
  CALLER_TAG_VERDICT=FAIL) printf '%s\n' "$ALGOVAULT_CT_OUT" >&2; exit 1 ;;
  *)
    printf '%s\n' "$ALGOVAULT_CT_OUT" >&2
    printf '%s\n' "⚠️  caller-tags: ${ALGOVAULT_CT_TOK:-no verdict token} — not blocking this commit (FAIL-only here); CI is fail-closed on it and will refuse the deploy." >&2 ;;
esac
EOF
hook_block_install pre-commit caller-tags OPS-UPSTREAM-ACQUISITION-ACCOUNTING-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
