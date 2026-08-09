#!/usr/bin/env bash
# OPS-GIT-IDENTITY-CANONICALIZE-W1 — wire scripts/check-author-identity.sh into the shared
# pre-commit hook.
#
# This is the SECOND pre-commit block (system-map is the first) and the 8th algovault hook block
# on this machine overall. Nothing here is bespoke: the publishability precondition, the block
# emission, the idempotence key, the timestamped backup and the skip-loudly guard all come from
# scripts/lib/hook-block.sh. This file only DECLARES what to install.
#
# Block name 'author-identity' is chosen, not incidental: the helper orders blocks canonically by
# LC_ALL=C name, and 'author-identity' < 'system-map', so the cheap check (one `git var` + one jq
# read) runs before the more expensive staged-diff scan. Same reasoning the push-safety installer
# records for pre-push.
#
# It does NOT read stdin — deliberately. A pre-push hook's stdin is a single-consumer stream that
# check-push-safety.sh already drains; that is the whole reason this guard lives on pre-commit.
#
# Deliberately NO --allow-unpublished flag. Push scripts/check-author-identity.sh first; if the
# precondition ever refuses here, that is the primitive succeeding, not failing.
#
# NOT invoked from CI — developer-onboarding utility. Run once per fresh clone:
#   bash scripts/install_author_identity_hook.sh
#   bash scripts/install_author_identity_hook.sh --remove    # rollback
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# shellcheck source=scripts/lib/hook-block.sh
. "$REPO_ROOT/scripts/lib/hook-block.sh"

GATE_SCRIPT='scripts/check-author-identity.sh'
BLOCK_NAME='author-identity'

DO_REMOVE=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    --remove)  DO_REMOVE=1 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [ "$DO_REMOVE" -eq 1 ]; then
  HOOKS_DIR="$(hook_block_common_dir)/hooks"
  HOOK_PATH="$HOOKS_DIR/pre-commit"
  if [ ! -f "$HOOK_PATH" ]; then
    printf '%s\n' "[author-identity] no pre-commit hook at $HOOK_PATH — nothing to remove."
    exit 0
  fi
  # Same convention as hook_block_install: timestamped backup BEFORE the first mutation.
  # Detection without recovery is half a guard.
  cp "$HOOK_PATH" "$HOOK_PATH.bak.OPS-GIT-IDENTITY-CANONICALIZE-W1-$(date -u +%Y%m%dT%H%M%SZ)"
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/algovault-ai-remove.XXXXXX")"   # XXXXXX must be TERMINAL on BSD
  trap 'rm -rf "$TMP"' EXIT
  awk -v name="$BLOCK_NAME" '
    $0 == "# >>> algovault " name " (OPS-GIT-IDENTITY-CANONICALIZE-W1) >>>" { skip=1; next }
    skip && $0 == "# <<< algovault " name " <<<" { skip=0; next }
    !skip { print }
  ' "$HOOK_PATH" > "$TMP/pre-commit"
  cat "$TMP/pre-commit" > "$HOOK_PATH"     # preserve the inode + mode rather than mv
  printf '%s\n' "[author-identity] removed the block from $HOOK_PATH (backup alongside)."
  exit 0
fi

hook_block_assert_publishable "$GATE_SCRIPT" 0 || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Refuses a commit whose AUTHOR EMAIL is not in ops/author-identity-allowlist.json. Ships
# REPORT-first: a violation prints AUTHOR_IDENTITY_VERDICT=FAIL and ledgers it, but exits 0 and
# does NOT block until promotion.mode flips (needs BOTH max_violations AND not_before).
# Retires the class behind 649 test@test.local + 633 megatronwarlord1998@gmail.com commits on
# public origin/main. Override (report-only): ALGOVAULT_AUTHOR_IDENTITY=warn git commit
EOF

hook_block_install pre-commit "$BLOCK_NAME" OPS-GIT-IDENTITY-CANONICALIZE-W1 "$GATE_SCRIPT" "$COMMENT" \
  'bash "$(git rev-parse --show-toplevel)/scripts/check-author-identity.sh" || exit 1'
