#!/usr/bin/env bash
# install_forbidden_phrases_hook.sh — GROWTH-TG-QUOTA-PARITY-W1 CH4.
#
# Installs the retired-brand-phrase gate as a guarded block in the shared `pre-commit` hook.
# Emission goes through scripts/lib/hook-block.sh — the ONE emitter — so this installer
# hand-rolls nothing: not the sentinels, not the skip guard, not the ordering.
#
# ─── READ BEFORE RUNNING: THE BLAST RADIUS IS EVERY CHECKOUT ────────────────────────────────
# `core.hooksPath` resolves every worktree to ONE hooks file. Measured 2026-08-02: 74 checkouts
# on one hooks dir; a block installed before its script was reachable from any remote ref left
# 69-70 of them unable to commit or push for over a day, and `--no-verify` is forbidden here.
# That is why hook_block_assert_publishable runs FIRST and is fail-closed — the ordering is a
# PRECONDITION enforced by the tool, never a rule someone has to remember.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_forbidden_phrases_hook.sh
#   bash scripts/install_forbidden_phrases_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-forbidden-phrases.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

# The gate reads THREE files and refuses without any of them, so all three are asserted. A block
# installed while its config is unreachable would make every gated commit REFUSE with an
# INDETERMINATE the committer cannot act on — asserting only the entry point leaves the real
# hazard unguarded, which is the lesson install_map_shape_hook.sh already paid for.
hook_block_assert_publishable 'ops/forbidden-phrases.json' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'ops/forbidden-phrase-targets.json' "$ALLOW_UNPUBLISHED" || exit 1
hook_block_assert_publishable 'scripts/lib/strip-comments.mjs' "$ALLOW_UNPUBLISHED" || exit 1

# This comment deliberately does NOT restate the patterns. The SoT is ops/forbidden-phrases.json;
# a duplicated fact goes stale, and — measured on a sibling installer — a pattern list quoted in
# prose can MATCH ITSELF and block the very commit that introduces it. A mention is not an
# occurrence, which is also why the gate strips comments before scanning code.
read -r -d '' COMMENT <<'EOF' || true
# Blocks a commit that puts a RETIRED brand phrase on a live surface — a superseded quota figure,
# a retired price, a weakened tagline, a link to the 404 pricing page. Patterns live in
# ops/forbidden-phrases.json (enforcement SoT); the corpus is glob-derived from
# ops/forbidden-phrase-targets.json with every exemption carrying its reason IN DATA; the RATIONALE
# for each retirement stays in the vault's brand-facts.md. Comments are stripped before scanning
# code (scripts/lib/strip-comments.mjs) because a mention is not an occurrence, and a phrase that
# the same line explicitly retires is suppressed and COUNTED rather than dropped.
# Verdict is a TOKEN, never the bare exit code: FORBIDDEN_PHRASE_VERDICT=PASS|FAIL|INDETERMINATE
# (0/1/3). Fail-closed on BOTH non-PASS verdicts — an empty corpus means the manifest is broken,
# not that the estate is clean.
# Escape hatch: ALGOVAULT_SKIP_FORBIDDEN_PHRASES=1 git commit …  (logged to the skip ledger).
EOF

# ONE invocation string. `hook_block_install`'s 7th arg is a legacy-drop REGEX, not a second
# body line — passing the verdict check there would silently delete matching lines from the hook
# instead of running it.
read -r -d '' INVOCATION <<'EOF' || true
ALGOVAULT_FP_OUT="$(node "$(git rev-parse --show-toplevel)/scripts/check-forbidden-phrases.mjs" 2>&1)" || true
printf '%s\n' "$ALGOVAULT_FP_OUT" | grep -qE '^FORBIDDEN_PHRASE_VERDICT=PASS$' || { printf '%s\n' "$ALGOVAULT_FP_OUT" >&2; exit 1; }
EOF

hook_block_install pre-commit forbidden-phrases GROWTH-TG-QUOTA-PARITY-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
