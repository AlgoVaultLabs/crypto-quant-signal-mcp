#!/usr/bin/env bash
# install-worktree-hook.sh — deploy the WorktreeCreate hook + reclaim entry point from a LANDED
# commit (OPS-WORKTREE-RECLAIM-ON-CREATE-W1-V2 R8).
#
#   install-worktree-hook.sh <sha>              materialize <sha> and swap `current` to it
#   install-worktree-hook.sh <sha> --register   ... then point the user registrations at it
#   install-worktree-hook.sh --verify           parity of `current` + registrations, no writes
#
# ── WHY A PINNED INSTALL ───────────────────────────────────────────────────────────────────
#   The hook was registered at an absolute path INSIDE the primary checkout, so the code that
#   ran was whatever branch that checkout happened to be on — measured 2026-10-17: a branch
#   444 commits behind origin/main. "A deploy materializes an explicit committed SHA" (vault
#   rules, deploy-and-infra.md): this installs exactly <sha>'s blobs, refuses a <sha> that is
#   not an ancestor of origin/main, and never copies a working tree.
#
# ── THE FILE SET IS DECLARED, NEVER INFERRED ───────────────────────────────────────────────
#   Every file the hook and the entry point read at runtime, resolved relative to themselves:
#     scripts/worktree-create-hook.sh   scripts/worktree-reclaim.sh   scripts/cc-session.sh
#     scripts/lib/*                     ops/shared-worktree-state.json
#     ops/worktree-noise-config.json
#   (the hook reads ../ops/shared-worktree-state.json; the work predicate reads
#   ../../ops/worktree-noise-config.json). The list is written to <dir>/.manifest, which the
#   entry point re-checks on EVERY run, so a stale install shows in every verdict line.
#
# ── LAYOUT ─────────────────────────────────────────────────────────────────────────────────
#   $ALGOVAULT_HOOK_INSTALL_ROOT (default ~/.local/share/algovault/worktree-hook)/
#     <full-sha>/            the materialized commit (+ .manifest, .installed-sha)
#     current -> <full-sha>  swapped by rename(2), so a reader sees the old or the new, never neither
#     registration-backup-<ts>.json   the user settings file as it was before --register
#
# ── VERDICT ────────────────────────────────────────────────────────────────────────────────
#   Exactly one terminal line:  WORKTREE_HOOK_INSTALL_VERDICT=PASS|FAIL|INDETERMINATE
#   0 = PASS (every installed file sha256-equals origin/main; registrations as declared)
#   1 = FAIL (a file or a registration differs) · 3 = INDETERMINATE (could not evaluate).
#
# Portable to macOS bash 3.2 and GNU coreutils.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
REPO="$(git -C "$SELF_DIR/.." rev-parse --show-toplevel 2>/dev/null)"
ROOT="${ALGOVAULT_HOOK_INSTALL_ROOT:-$HOME/.local/share/algovault/worktree-hook}"
USER_SETTINGS="${ALGOVAULT_USER_SETTINGS:-$HOME/.claude/settings.json}"
BASE_REF="${ALGOVAULT_HOOK_INSTALL_BASE:-origin/main}"
FIXED_FILES="scripts/worktree-create-hook.sh scripts/worktree-reclaim.sh scripts/cc-session.sh ops/shared-worktree-state.json ops/worktree-noise-config.json"

say()  { printf '[install-worktree-hook] %s\n' "$*" >&2; }
emit() { printf 'WORKTREE_HOOK_INSTALL_VERDICT=%s\n' "$1"; case "$1" in PASS) exit 0 ;; FAIL) exit 1 ;; *) exit 3 ;; esac; }
indet() { say "INDETERMINATE: $*"; emit INDETERMINATE; }

sha256_of() {   # <file> -> hex digest, or nothing
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  else sha256sum "$1" 2>/dev/null | awk '{print $1}'; fi
}
sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  else sha256sum | awk '{print $1}'; fi
}

# rename(2) a symlink over an existing symlink. Plain `mv` FOLLOWS a target that is a symlink
# to a directory and moves the new link INSIDE it; GNU spells "don't" -T, BSD spells it -h.
swap_link() {   # <new-link> <dest-link>
  if mv -T "$1" "$2" 2>/dev/null; then return 0; fi
  mv -h -f "$1" "$2" 2>/dev/null
}

hook_cmd()     { printf '%s/current/scripts/worktree-create-hook.sh' "$ROOT"; }
reclaim_cmd()  { printf '%s/current/scripts/worktree-reclaim.sh --trigger session-start' "$ROOT"; }

# ── parity: installed files vs $BASE_REF, one row per file ─────────────────────────────────
parity() {   # <install-dir> -> prints rows; returns 0 iff every file is equal
  local dir="$1" rel a b bad=0
  [ -r "$dir/.manifest" ] || { say "no .manifest in $dir"; return 2; }
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    a="$(sha256_of "$dir/$rel")"
    b="$(git -C "$REPO" show "$BASE_REF:$rel" 2>/dev/null | sha256_stdin)"
    if git -C "$REPO" cat-file -e "$BASE_REF:$rel" 2>/dev/null && [ -n "$a" ] && [ "$a" = "$b" ]; then
      printf 'EQUAL  %s  %s\n' "${a:0:12}" "$rel"
    else
      printf 'DIFF   %s %s  %s\n' "${a:0:12}" "${b:0:12}" "$rel"; bad=1
    fi
  done < "$dir/.manifest"
  return "$bad"
}

# ── registrations: exactly one user WorktreeCreate (ours), one SessionStart(startup) entry ──
registrations_ok() {
  local wc ss tracked
  [ -r "$USER_SETTINGS" ] || { say "user settings unreadable: $USER_SETTINGS"; return 2; }
  wc="$(jq -r --arg c "$(hook_cmd)" '
    [ (.hooks.WorktreeCreate // [])[] | (.hooks // [])[] | .command ] as $all
    | if ($all | length) == 1 and $all[0] == $c then "ok" else "bad:\($all | join(","))" end' "$USER_SETTINGS" 2>/dev/null)"
  ss="$(jq -r --arg c "$(reclaim_cmd)" '
    [ (.hooks.SessionStart // [])[] | select((.matcher // "") == "startup")
      | (.hooks // [])[] | select(.command == $c) ] | length' "$USER_SETTINGS" 2>/dev/null)"
  tracked="$(git -C "$REPO" show "$BASE_REF:.claude/settings.json" 2>/dev/null | jq -r '(.hooks.WorktreeCreate // []) | length' 2>/dev/null)"
  printf 'user WorktreeCreate        %s\n' "${wc:-unreadable}"
  printf 'user SessionStart(startup) %s entr(y|ies) -> %s\n' "${ss:-?}" "$(reclaim_cmd)"
  printf 'tracked WorktreeCreate     %s entr(y|ies) at %s:.claude/settings.json\n' "${tracked:-?}" "$BASE_REF"
  [ "$wc" = "ok" ] && [ "$ss" = "1" ] && [ "$tracked" = "0" ]
}

[ -n "$REPO" ] || indet "not run from inside a checkout of the repository"
command -v jq  >/dev/null 2>&1 || indet "jq is not on PATH"
command -v git >/dev/null 2>&1 || indet "git is not on PATH"

MODE="install"; SHA=""; REGISTER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)   MODE="verify" ;;
    --register) REGISTER=1 ;;
    -h|--help)  sed -n '2,38p' "$0" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
    -*)         indet "unknown flag: $1" ;;
    *)          SHA="$1" ;;
  esac
  shift
done

if [ "$MODE" = "verify" ]; then
  [ -L "$ROOT/current" ] || indet "no install: $ROOT/current is not a symlink"
  git -C "$REPO" rev-parse --verify --quiet "$BASE_REF" >/dev/null || indet "cannot resolve $BASE_REF"
  say "current -> $(readlink "$ROOT/current")"
  parity "$ROOT/current/"; p=$?
  [ "$p" -eq 2 ] && indet "installed tree has no manifest"
  registrations_ok; r=$?
  [ "$r" -eq 2 ] && indet "cannot read the user settings"
  [ "$p" -eq 0 ] && [ "$r" -eq 0 ] && emit PASS
  emit FAIL
fi

# ── install ─────────────────────────────────────────────────────────────────────────────────
[ -n "$SHA" ] || indet "usage: install-worktree-hook.sh <sha> [--register] | --verify"
git -C "$REPO" fetch origin --quiet >/dev/null 2>&1 || say "fetch failed — judging ancestry against the CACHED $BASE_REF"
FULL="$(git -C "$REPO" rev-parse --verify --quiet "$SHA^{commit}")" || indet "not a commit: $SHA"
git -C "$REPO" rev-parse --verify --quiet "$BASE_REF" >/dev/null || indet "cannot resolve $BASE_REF"
git -C "$REPO" merge-base --is-ancestor "$FULL" "$BASE_REF" \
  || { say "REFUSED: $FULL is not an ancestor of $BASE_REF — only a landed commit is deployed"; emit FAIL; }

LIB_FILES="$(git -C "$REPO" ls-tree --name-only "$FULL" scripts/lib/ 2>/dev/null | sort)"
[ -n "$LIB_FILES" ] || indet "no scripts/lib/ at $FULL"
FILES="$(printf '%s\n' $FIXED_FILES $LIB_FILES | sort -u)"
for f in $FILES; do
  git -C "$REPO" cat-file -e "$FULL:$f" 2>/dev/null || indet "declared file absent at $FULL: $f"
done

mkdir -p "$ROOT" 2>/dev/null || indet "cannot create $ROOT"
DEST="$ROOT/$FULL"
if [ ! -d "$DEST" ]; then
  STAGE="$ROOT/.staging-$FULL-$$"
  rm -rf "$STAGE"; mkdir -p "$STAGE" || indet "cannot create $STAGE"
  # shellcheck disable=SC2086 — $FILES is a newline list of repo paths without spaces
  if ! git -C "$REPO" archive --format=tar "$FULL" $FILES | tar -x -C "$STAGE"; then
    rm -rf "$STAGE"; indet "git archive | tar failed for $FULL"
  fi
  printf '%s\n' "$FILES" > "$STAGE/.manifest"
  printf '%s\n' "$FULL"  > "$STAGE/.installed-sha"
  mv "$STAGE" "$DEST" 2>/dev/null || { rm -rf "$STAGE"; indet "cannot move staging into $DEST"; }
  say "materialized $FULL -> $DEST"
else
  say "already materialized: $DEST (content of a commit is immutable; reused)"
fi

PREV="$(readlink "$ROOT/current" 2>/dev/null || echo '<none>')"
ln -s "$FULL" "$ROOT/.current.$$" 2>/dev/null || indet "cannot create the new link"
swap_link "$ROOT/.current.$$" "$ROOT/current" || { rm -f "$ROOT/.current.$$"; indet "atomic swap of $ROOT/current failed"; }
[ "$(readlink "$ROOT/current")" = "$FULL" ] || indet "current does not point at $FULL after the swap"
say "current: $PREV -> $FULL"

if [ "$REGISTER" -eq 1 ]; then
  [ -r "$USER_SETTINGS" ] || indet "user settings unreadable: $USER_SETTINGS"
  jq -e . "$USER_SETTINGS" >/dev/null 2>&1 || indet "user settings are not valid JSON: $USER_SETTINGS"
  BAK="$ROOT/registration-backup-$(date -u +%Y%m%dT%H%M%SZ).json"
  cp -p "$USER_SETTINGS" "$BAK" || indet "cannot back up $USER_SETTINGS"
  say "previous WorktreeCreate: $(jq -c '.hooks.WorktreeCreate // null' "$USER_SETTINGS")"
  say "previous SessionStart:   $(jq -c '.hooks.SessionStart // null' "$USER_SETTINGS")"
  say "backup: $BAK"
  TMP="$USER_SETTINGS.tmp.$$"
  # Copied first so the replacement keeps the original's mode; `>` below truncates in place.
  cp -p "$USER_SETTINGS" "$TMP" || indet "cannot stage $TMP"
  # EXACTLY two edits, both idempotent: (1) the WorktreeCreate command path, keeping the
  # nested shape — the direct shape is measured not to fire; (2) one SessionStart(startup)
  # entry, appended only if that exact command is not already registered.
  if ! jq --arg h "$(hook_cmd)" --arg r "$(reclaim_cmd)" '
        .hooks = (.hooks // {})
        | .hooks.WorktreeCreate = (
            if ((.hooks.WorktreeCreate // []) | length) > 0
            then .hooks.WorktreeCreate | (.[0].hooks[0].command = $h)
            else [{hooks: [{type: "command", command: $h}]}] end)
        | .hooks.SessionStart = (
            (.hooks.SessionStart // [])
            | if any(.[]; (.matcher // "") == "startup" and any((.hooks // [])[]; .command == $r))
              then . else . + [{matcher: "startup", hooks: [{type: "command", command: $r}]}] end)
      ' "$USER_SETTINGS" > "$TMP" 2>/dev/null || ! jq -e . "$TMP" >/dev/null 2>&1; then
    rm -f "$TMP"; indet "could not rewrite $USER_SETTINGS (unchanged; backup at $BAK)"
  fi
  mv -f "$TMP" "$USER_SETTINGS" || { rm -f "$TMP"; indet "cannot replace $USER_SETTINGS (backup at $BAK)"; }
  say "registered: WorktreeCreate -> $(hook_cmd)"
  say "registered: SessionStart(startup) -> $(reclaim_cmd)"
fi

parity "$DEST"; p=$?
[ "$p" -eq 2 ] && indet "installed tree has no manifest"
if [ "$REGISTER" -eq 1 ]; then registrations_ok; r=$?; else r=0; fi
[ "$p" -eq 0 ] && [ "$r" -eq 0 ] && emit PASS
emit FAIL
