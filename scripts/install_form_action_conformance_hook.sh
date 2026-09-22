#!/usr/bin/env bash
# install_form_action_conformance_hook.sh — CANCEL-PATH-CSP-FORM-ACTION-W1 CH2.
#
# Installs the form-action conformance gate as a guarded block in the shared `pre-commit` hook.
# Emission goes through scripts/lib/hook-block.sh — the ONE emitter — so this installer
# hand-rolls nothing: not the sentinels, not the skip guard, not the ordering.
#
# ─── READ BEFORE RUNNING: THE BLAST RADIUS IS EVERY CHECKOUT ────────────────────────────────
# `core.hooksPath` resolves every worktree to ONE hooks file (146-147 checkouts, measured
# 2026-09-19/22). A block installed before its script is reachable from a remote ref deadlocks
# every parallel session, and `--no-verify` is forbidden here. So hook_block_assert_publishable
# runs FIRST and is fail-closed, for the gate AND both of its runtime imports.
#
# Install ORDER for this wave: CH1 (src/lib/off-origin-redirect.ts) has landed, THEN this gate
# lands, THEN this installer runs. A checkout whose tree predates the gate skips the block loudly
# (hook-block.sh's skip guard); a tree that contains the gate necessarily contains CH1's fix.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_form_action_conformance_hook.sh
#   bash scripts/install_form_action_conformance_hook.sh --allow-unpublished   # audited bootstrap only
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

GATE_SCRIPT='scripts/check-form-action-conformance.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1
# The gate imports the shared CSP parser/extractors and the shared comment stripper. A block whose
# gate is fetchable but whose imports are not fails every commit with MODULE_NOT_FOUND.
hook_block_assert_publishable 'scripts/check-token-resolution.mjs' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'scripts/check-external-origin-csp.mjs' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'scripts/lib/strip-comments.mjs' "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Blocks a commit that adds a form whose handler can be refused by the served CSP's form-action:
# Chrome/Safari refuse a cross-origin redirect after a form submission SILENTLY (no error page), so
# a form-reached `res.redirect(303, <other origin>)` ships green and does nothing in the browser.
# That is how the /account -> Stripe billing portal (cancel) path was dead from 2026-07-28 to
# 2026-09-22. Hand off with src/lib/off-origin-redirect.ts (200 same-origin interstitial) instead.
#
# THE TWO CALLERS DO NOT SHARE ONE FAILURE RESPONSE, and that is deliberate.
#   FAIL          -> blocks here AND in CI (deploy.yml, fail-closed).
#   INDETERMINATE -> blocks in CI; HERE it prints the token and does NOT block.
# The gate is local-only and network-free, so its INDETERMINATE means the gate could not PROVE the
# tree either way: an extractor could not build its corpus (a CSP literal it cannot read, zero
# forms, zero routes, no apex proxy map), or a form target could not be verified (a handler it
# cannot read, interpolated form attributes, a POST form to a path no registration it can parse
# serves). The '?' lines name each one. That is unfinished proof, not a proven refusal — and this
# hook is ONE file governing every checkout on the machine, so failing closed on it would let one
# unreadable shape stop all of them from committing, with --no-verify forbidden. CI stays the
# strict caller and refuses the deploy; the token is always printed here and never suppressed.
EOF

# ONE invocation string. hook_block_install's 7th arg is a legacy-drop REGEX, not a second body line.
read -r -d '' INVOCATION <<'EOF' || true
ALGOVAULT_FA_OUT="$(node "$(git rev-parse --show-toplevel)/scripts/check-form-action-conformance.mjs" --check 2>&1)" || true
ALGOVAULT_FA_TOK="$(printf '%s\n' "$ALGOVAULT_FA_OUT" | grep -oE '^FORM_ACTION_CONFORMANCE_VERDICT=[A-Z]+' | tail -1)"
case "$ALGOVAULT_FA_TOK" in
  FORM_ACTION_CONFORMANCE_VERDICT=PASS) printf '%s\n' "$ALGOVAULT_FA_TOK" ;;
  FORM_ACTION_CONFORMANCE_VERDICT=FAIL) printf '%s\n' "$ALGOVAULT_FA_OUT" >&2; exit 1 ;;
  *)
    printf '%s\n' "$ALGOVAULT_FA_OUT" >&2
    printf '%s\n' "⚠️  form-action-conformance: ${ALGOVAULT_FA_TOK:-no verdict token} — not blocking this commit (FAIL-only here); CI is fail-closed on it and will refuse the deploy." >&2 ;;
esac
EOF

hook_block_install pre-commit form-action-conformance CANCEL-PATH-CSP-FORM-ACTION-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
