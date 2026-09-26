#!/usr/bin/env bash
# OPS-MCP-CHATID-SCRUB-W1 — wire scripts/check-chat-id-literals.mjs --push-range into the shared
# pre-push hook, through the ONE emitter (scripts/lib/hook-block.sh).
#
# WHY pre-push, when the tree scan already runs in CI and in the test gate: a commit MESSAGE is
# published by the push and read by nothing else. In the sibling bot repo, 4 of the 8 live chat
# ids on its public refs exist ONLY in commit messages — no tree scan can reach them, and once
# pushed only a history rewrite removes them. The same goes for an id added in one commit and
# deleted in the next: the final tree is clean and the history is not. This block is the one
# place such a leak can still be STOPPED rather than cleaned up.
#
# The block reads NO stdin (and is redirected from /dev/null): the push-safety block owns the
# hook's ref lines, and a second reader would starve it into passing an unprotected push. The
# gate therefore scans HEAD's commits that no remote-tracking ref of the pushing remote contains.
#
# No warn/override lever, same as secret-scan: the remedy for a finding is a synthetic id, a
# placeholder or `chat last4 NNNN` in a rewritten commit — never a bypass.
#
# NOT invoked from CI — developer-onboarding utility.
#   bash scripts/install_chat_id_literals_hook.sh
#   bash scripts/install_chat_id_literals_hook.sh --allow-unpublished   # audited bootstrap only
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

ALLOW_UNPUBLISHED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

GATE_SCRIPT='scripts/check-chat-id-literals.mjs'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Refuses a push that would PUBLISH a Telegram chat id: a Telegram-shaped number beside chat / tg
# / telegram / subscriber in an ADDED line or a commit MESSAGE of HEAD's unpushed commits. Reads
# NO stdin — the push-safety block owns the ref lines. Gates on CHAT_ID_LITERALS_VERDICT, never
# the bare exit code. Remedy: a synthetic id, a placeholder or `chat last4 NNNN`, never a bypass.
EOF

hook_block_install pre-push chat-id-literals OPS-MCP-CHATID-SCRUB-W1 "$GATE_SCRIPT" "$COMMENT" \
  'node "$(git rev-parse --show-toplevel)/scripts/check-chat-id-literals.mjs" --self-test >/dev/null </dev/null || { printf "%s\n" "✖ chat-id-literals: matcher self-test FAILED — the gate cannot be trusted; run: node scripts/check-chat-id-literals.mjs --self-test" >&2; exit 1; }
  _av_cid_out="$(node "$(git rev-parse --show-toplevel)/scripts/check-chat-id-literals.mjs" --push-range "${1:-origin}" </dev/null 2>&1)"
  _av_cid_verdict="$(printf "%s\n" "$_av_cid_out" | grep -aoE "^CHAT_ID_LITERALS_VERDICT=[A-Z]+" | head -1 | cut -d= -f2)"
  printf "%s\n" "CHAT_ID_LITERALS_VERDICT=${_av_cid_verdict:-INDETERMINATE}"
  if [ "${_av_cid_verdict:-}" != "PASS" ]; then printf "%s\n" "$_av_cid_out" >&2; exit 1; fi'
