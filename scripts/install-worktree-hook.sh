#!/usr/bin/env bash
# install-worktree-hook.sh — deploy the WorktreeCreate hook, the reclaim entry point and the
# two session hooks from a LANDED commit (OPS-WORKTREE-RECLAIM-ON-CREATE-W1-V2 R8; session
# hooks: OPS-SESSION-BUDGET-W1 CH2, cut down to the one-wave gate + compact line by -R2).
#
#   install-worktree-hook.sh <sha>              materialize <sha> and swap `current` to it
#   install-worktree-hook.sh <sha> --register   ... then point the user registrations at it
#   install-worktree-hook.sh --verify           parity of `current` + registrations + a drill, no writes
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
#     scripts/session-budget.mjs        scripts/lib/*                 ops/shared-worktree-state.json
#     ops/worktree-noise-config.json    ops/session-budget.json
#   (the hook reads ../ops/shared-worktree-state.json; the work predicate reads
#   ../../ops/worktree-noise-config.json; the session hooks read ../ops/session-budget.json).
#   The list is written to <dir>/.manifest, which the entry point re-checks on EVERY run, so a
#   stale install shows in every verdict line.
#
# ── THE REGISTRATIONS ARE DECLARED, AND --register MAKES ONLY THESE EDITS ──────────────────
#   WorktreeCreate            -> current/scripts/worktree-create-hook.sh  (the path, nested shape)
#   SessionStart(startup)     -> current/scripts/worktree-reclaim.sh --trigger session-start
#   UserPromptSubmit          -> <node> current/scripts/session-budget.mjs --on prompt
#   SessionStart(compact)     -> <node> current/scripts/session-budget.mjs --on compact
#   autoCompactWindow         =  window_tokens of the installed ops/session-budget.json, and the
#                                same value in any modelSettings entry that carries the key
#   Hooks run under a bare PATH (measured: `env -i … command -v node` is empty), so <node> is the
#   absolute path `command -v node` resolves at --register time, stamped at $ROOT/.node-bin.
#   Any other session-budget command (an older install, a checkout, the SessionEnd meter entry
#   -R2 retired) is removed from every event, leaving each foreign entry byte-identical: Claude
#   Code runs every distinct registered command, so a stale one would judge each prompt twice.
#   skillOverrides is user-owned config and is never written here (-R2 froze the value the
#   retired --skill-overrides mode last wrote).
#
# ── LAYOUT ─────────────────────────────────────────────────────────────────────────────────
#   $ALGOVAULT_HOOK_INSTALL_ROOT (default ~/.local/share/algovault/worktree-hook)/
#     <full-sha>/            the materialized commit (+ .manifest, .installed-sha)
#     current -> <full-sha>  swapped by rename(2), so a reader sees the old or the new, never neither
#     registration-backup-<ts>.json   the user settings file as it was before --register
#     .node-bin                       the node the session-budget registrations name
#
# ── VERDICT ────────────────────────────────────────────────────────────────────────────────
#   Exactly one terminal line:  WORKTREE_HOOK_INSTALL_VERDICT=PASS|FAIL|INDETERMINATE
#   0 = PASS (every installed file sha256-equals origin/main; registrations as declared; both
#            session hooks, run exactly as registered under a bare environment, answer a drill)
#   1 = FAIL (a file or a registration differs) · 3 = INDETERMINATE (could not evaluate).
#
# Portable to macOS bash 3.2 and GNU coreutils.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
REPO="$(git -C "$SELF_DIR/.." rev-parse --show-toplevel 2>/dev/null)"
ROOT="${ALGOVAULT_HOOK_INSTALL_ROOT:-$HOME/.local/share/algovault/worktree-hook}"
USER_SETTINGS="${ALGOVAULT_USER_SETTINGS:-$HOME/.claude/settings.json}"
BASE_REF="${ALGOVAULT_HOOK_INSTALL_BASE:-origin/main}"
FIXED_FILES="scripts/worktree-create-hook.sh scripts/worktree-reclaim.sh scripts/cc-session.sh scripts/session-budget.mjs ops/shared-worktree-state.json ops/worktree-noise-config.json ops/session-budget.json"

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
node_bin()     { cat "$ROOT/.node-bin" 2>/dev/null; }
budget_cmd()   { printf '%s %s/current/scripts/session-budget.mjs --on %s' "$(node_bin)" "$ROOT" "$1"; }
budget_key()   { jq -r ".$2 // empty" "$1/ops/session-budget.json" 2>/dev/null; }   # <install-dir> <key>

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

# ── the two session hooks, run exactly as registered: /bin/sh -c "<command>", no environment
#    but a scratch HOME, against a one-line transcript that dispatched one wave. Registered is
#    not working; this asserts the positive answer of each hook, never the absence of an error.
hook_drill() {   # prints one line; returns 0 iff all three answers are as declared
  local node d t p a c ok=0
  node="$(node_bin)"
  if [ -z "$node" ] || [ ! -x "$node" ]; then printf 'session hook drill         not run: no stamped node\n'; return 1; fi
  d="$(mktemp -d 2>/dev/null)" || { printf 'session hook drill         not run: no scratch dir\n'; return 1; }
  t="$d/drill.jsonl"
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"Read Prompt/OPS-VERIFY-DRILL-A-W1.md"},"timestamp":"2026-01-01T00:00:00.000Z"}' > "$t"
  drill_in() { printf '{"session_id":"verify-drill","transcript_path":"%s","prompt":"%s","source":"compact","hook_event_name":"drill"}' "$t" "$1"; }
  p="$(drill_in 'Read Prompt/OPS-VERIFY-DRILL-B-W1.md' | env -i HOME="$d" /bin/sh -c "$(budget_cmd prompt)" 2>/dev/null)"
  a="$(drill_in 'Read Prompt/OPS-VERIFY-DRILL-A-W1-R2.md' | env -i HOME="$d" /bin/sh -c "$(budget_cmd prompt)" 2>/dev/null; printf 'exit=%s' "$?")"
  c="$(drill_in '' | env -i HOME="$d" /bin/sh -c "$(budget_cmd compact)" 2>/dev/null)"
  rm -rf "$d"
  if printf '%s' "$p" | jq -e '.decision == "block" and (.reason | contains("one wave per session"))' >/dev/null 2>&1; then p="refused"; else p="NOT REFUSED (${p:0:120})"; ok=1; fi
  if [ "$a" = "exit=0" ]; then a="allowed"; else a="NOT ALLOWED (${a:0:120})"; ok=1; fi
  case "$c" in "Wave OPS-VERIFY-DRILL-A-W1 · spec Prompt/OPS-VERIFY-DRILL-A-W1.md"*) c="printed" ;; *) c="NOT PRINTED (${c:0:120})"; ok=1 ;; esac
  printf 'session hook drill         second wave %s · same wave -R2 %s · compact line %s\n' "$p" "$a" "$c"
  return "$ok"
}

# ── registrations: exactly one user WorktreeCreate (ours), one SessionStart(startup) entry,
#    one of each session hook and no stale one, the window, and both hooks answering ─────────
registrations_ok() {
  local wc ss tracked win aw ms ups cmp stale node drill
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

  win="$(budget_key "$ROOT/current" window_tokens)"
  aw="$(jq -r '.autoCompactWindow // "unset"' "$USER_SETTINGS" 2>/dev/null)"
  ms="$(jq -r --argjson w "${win:-0}" '[ (.modelSettings // {}) | objects | to_entries[] | .value | objects
      | select(has("autoCompactWindow") and .autoCompactWindow != $w) ] | length' "$USER_SETTINGS" 2>/dev/null)"
  cnt() {   # <event> <command> [<matcher>]
    jq -r --arg e "$1" --arg c "$2" --arg m "${3:-}" '[ (.hooks[$e] // [])[]
      | select($m == "" or (.matcher // "") == $m) | (.hooks // [])[] | select(.command == $c) ] | length' "$USER_SETTINGS" 2>/dev/null
  }
  ups="$(cnt UserPromptSubmit "$(budget_cmd prompt)")"
  cmp="$(cnt SessionStart "$(budget_cmd compact)" compact)"
  # any other session-budget command in any event — an older install, a checkout, the retired
  # SessionEnd entry — would run beside ours, so it is a FAIL until --register removes it
  stale="$(jq -r --arg p "$(budget_cmd prompt)" --arg c "$(budget_cmd compact)" '
      [ (.hooks // {}) | to_entries[] | .value[]? | (.hooks? // [])[]? | (.command? // "") | strings
        | select(test("/scripts/session-budget\\.mjs --on ")) | select(. != $p and . != $c) ] | length' "$USER_SETTINGS" 2>/dev/null)"
  printf 'autoCompactWindow          %s (installed window %s) · modelSettings disagreeing %s\n' "${aw:-?}" "${win:-?}" "${ms:-?}"
  node="$(node_bin)"
  printf 'session hooks              prompt %s · compact %s · stale %s · node %s\n' "${ups:-?}" "${cmp:-?}" "${stale:-?}" "${node:-<none>}"
  hook_drill; drill=$?

  [ "$wc" = "ok" ] && [ "$ss" = "1" ] && [ "$tracked" = "0" ] \
    && [ -n "$win" ] && [ "$aw" = "$win" ] && [ "$ms" = "0" ] \
    && [ "$ups" = "1" ] && [ "$cmp" = "1" ] && [ "$stale" = "0" ] && [ "$drill" -eq 0 ]
}

[ -n "$REPO" ] || indet "not run from inside a checkout of the repository"
command -v jq  >/dev/null 2>&1 || indet "jq is not on PATH"
command -v git >/dev/null 2>&1 || indet "git is not on PATH"

MODE="install"; SHA=""; REGISTER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --verify)          MODE="verify" ;;
    --register)        REGISTER=1 ;;
    -h|--help)  sed -n '2,55p' "$0" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
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

# back up the user settings and stage a copy that keeps its mode; prints the staging path
stage_settings() {
  [ -r "$USER_SETTINGS" ] || indet "user settings unreadable: $USER_SETTINGS"
  jq -e . "$USER_SETTINGS" >/dev/null 2>&1 || indet "user settings are not valid JSON: $USER_SETTINGS"
  BAK="$ROOT/registration-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  cp -p "$USER_SETTINGS" "$BAK" || indet "cannot back up $USER_SETTINGS"
  say "backup: $BAK"
  TMP="$USER_SETTINGS.tmp.$$"
  # Copied first so the replacement keeps the original's mode; `>` below truncates in place.
  cp -p "$USER_SETTINGS" "$TMP" || indet "cannot stage $TMP"
}

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
  NODE="$(command -v node 2>/dev/null)"
  case "$NODE" in /*) ;; *) indet "node is not on PATH as an absolute path (got '${NODE:-}')" ;; esac
  WIN="$(budget_key "$DEST" window_tokens)"
  HTO="$(budget_key "$DEST" hook_timeout_seconds)"
  printf '%s' "$WIN" | grep -Eq '^[1-9][0-9]*$' || indet "no window_tokens in $DEST/ops/session-budget.json"
  printf '%s' "$HTO" | grep -Eq '^[1-9][0-9]*$' || indet "no hook_timeout_seconds in $DEST/ops/session-budget.json"
  printf '%s\n' "$NODE" > "$ROOT/.node-bin.$$" && mv -f "$ROOT/.node-bin.$$" "$ROOT/.node-bin" || indet "cannot stamp $ROOT/.node-bin"
  stage_settings
  say "previous WorktreeCreate:   $(jq -c '.hooks.WorktreeCreate // null' "$USER_SETTINGS")"
  say "previous SessionStart:     $(jq -c '.hooks.SessionStart // null' "$USER_SETTINGS")"
  say "previous UserPromptSubmit: $(jq -c '.hooks.UserPromptSubmit // null' "$USER_SETTINGS")"
  say "previous SessionEnd:       $(jq -c '.hooks.SessionEnd // null' "$USER_SETTINGS")"
  say "previous autoCompactWindow: $(jq -c '.autoCompactWindow // null' "$USER_SETTINGS")"
  # The declared edits (header), every one idempotent: (1) the WorktreeCreate command path,
  # keeping the nested shape — the direct shape is measured not to fire; (2) one
  # SessionStart(startup) entry, appended only if that exact command is not already
  # registered; (3) the window, and the same value in any modelSettings entry carrying it;
  # (4) the two session hooks, each appended once after every session-budget command (current
  # or stale) is removed from the event, so a re-run is a no-op; (5) every session-budget
  # command removed from SessionEnd, where -R2 retired ours — any other entry is untouched, and
  # the key is dropped only when removing ours emptied it.
  if ! jq --arg h "$(hook_cmd)" --arg r "$(reclaim_cmd)" \
        --arg bp "$(budget_cmd prompt)" --arg bc "$(budget_cmd compact)" \
        --argjson w "$WIN" --argjson t "$HTO" '
        def ours: (.command // "") | test("/scripts/session-budget\\.mjs --on ");
        def strip_ours: map(if any((.hooks // [])[]; ours) then .hooks |= map(select(ours | not)) else . end)
                        | map(select(((.hooks // [0]) | length) > 0));
        .hooks = (.hooks // {})
        | .hooks.WorktreeCreate = (
            if ((.hooks.WorktreeCreate // []) | length) > 0
            then .hooks.WorktreeCreate | (.[0].hooks[0].command = $h)
            else [{hooks: [{type: "command", command: $h}]}] end)
        | .hooks.SessionStart = (
            (.hooks.SessionStart // [])
            | if any(.[]; (.matcher // "") == "startup" and any((.hooks // [])[]; .command == $r))
              then . else . + [{matcher: "startup", hooks: [{type: "command", command: $r}]}] end)
        | .autoCompactWindow = $w
        | if (.modelSettings | type) == "object"
          then .modelSettings |= with_entries(if (.value | type) == "object" and (.value | has("autoCompactWindow"))
                                              then .value.autoCompactWindow = $w else . end)
          else . end
        | .hooks.UserPromptSubmit = (((.hooks.UserPromptSubmit // []) | strip_ours)
            + [{hooks: [{type: "command", command: $bp, timeout: $t}]}])
        | .hooks.SessionStart = ((.hooks.SessionStart | strip_ours)
            + [{matcher: "compact", hooks: [{type: "command", command: $bc, timeout: $t}]}])
        | if (.hooks.SessionEnd | type) == "array" and any(.hooks.SessionEnd[]; any((.hooks // [])[]; ours))
          then .hooks.SessionEnd |= strip_ours
               | if (.hooks.SessionEnd | length) == 0 then del(.hooks.SessionEnd) else . end
          else . end
      ' "$USER_SETTINGS" > "$TMP" 2>/dev/null || ! jq -e . "$TMP" >/dev/null 2>&1; then
    rm -f "$TMP"; indet "could not rewrite $USER_SETTINGS (unchanged; backup at $BAK)"
  fi
  mv -f "$TMP" "$USER_SETTINGS" || { rm -f "$TMP"; indet "cannot replace $USER_SETTINGS (backup at $BAK)"; }
  say "registered: WorktreeCreate -> $(hook_cmd)"
  say "registered: SessionStart(startup) -> $(reclaim_cmd)"
  say "registered: UserPromptSubmit -> $(budget_cmd prompt)"
  say "registered: SessionStart(compact) -> $(budget_cmd compact)"
  say "SessionEnd now:            $(jq -c '.hooks.SessionEnd // null' "$USER_SETTINGS")"
  say "registered: autoCompactWindow = $WIN"
fi

parity "$DEST"; p=$?
[ "$p" -eq 2 ] && indet "installed tree has no manifest"
if [ "$REGISTER" -eq 1 ]; then registrations_ok; r=$?; else r=0; fi
[ "$p" -eq 0 ] && [ "$r" -eq 0 ] && emit PASS
emit FAIL
