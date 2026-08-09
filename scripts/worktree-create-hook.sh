#!/usr/bin/env bash
# worktree-create-hook.sh — the `WorktreeCreate` hook (OPS-WORKTREE-CREATE-HOOK-W1 CH2).
#
# Replaces Claude Code's default `git worktree` logic so placement is DECLARED rather than
# emergent. Destination comes from ops/shared-worktree-state.json's worktree_roots block —
# the SoT OPS-WORKTREE-ROOT-ENFORCE-W1 merged. ONE SoT, not a second one.
#
# ── THE CONTRACT (documented, and both halves are load-bearing) ───────────────────────────
#   stdout carries the absolute worktree path and NOTHING ELSE. Any extra byte gets
#   concatenated with the path, Claude Code cannot parse it, and the session HANGS SILENTLY.
#   Every diagnostic therefore goes to /dev/tty and $ALGOVAULT_HOOK_ARTIFACTS/hook.log.
#   Non-zero exit ABORTS worktree creation ("Any non-zero exit code aborts worktree creation").
#
# ── FAIL OPEN, ALWAYS — WITH ONE RATIFIED INVERSION ───────────────────────────────────────
#   Any error (unresolvable root, failed `git worktree add`, bad stdin) falls back to the
#   DEFAULT location and exits 0: a session that cannot create a worktree is a worse outage
#   than a worktree in the wrong place.
#   THE INVERSION: launched OUTSIDE any git repository there is no repo, so there is no valid
#   path to print AND the default logic could not have created one either. Printing a bogus
#   path is strictly worse than failing — it is either the silent hang or a worktree at an
#   arbitrary location. That single case exits NON-ZERO, loudly. (Ratified Q3, spec r2.)
#
# ── STDIN SCHEMA: MEASURED, NOT DOCUMENTED ────────────────────────────────────────────────
#   Measured on Claude Code 2.1.118 (CH1, 2026-08-09):
#       session_id · transcript_path · cwd · hook_event_name · name
#   The docs page /docs/en/hooks#worktreecreate claims `worktree_path`, `worktree_reason` and
#   `base_path`. NONE of the three exists. It omits `name` and `transcript_path`, which do.
#   Do not "restore" those fields from the docs — they were measured absent.
#   Canonical record: the measured U-table in the OPS-WORKTREE-CREATE-HOOK-W1 CH1 status.md
#   entry (with probe.json alongside it in $ALGOVAULT_HOOK_ARTIFACTS).
#
# ── REGISTRATION SHAPE: NESTED ONLY ───────────────────────────────────────────────────────
#   { "hooks": { "WorktreeCreate": [ { "hooks": [ { "type":"command","command":"<abs>" } ] } ] } }
#   The DIRECT array form shown on the docs page does not fire — and fails silently, with
#   Claude Code creating the worktree via default logic at exit 0 and no warning.

# NOT `set -e`: fail-open means errors are HANDLED, never fatal by default.
set -uo pipefail

ARTIFACTS="${ALGOVAULT_HOOK_ARTIFACTS:-$HOME/.local/state/algovault/OPS-WORKTREE-CREATE-HOOK-W1}"
LOG="$ARTIFACTS/hook.log"
mkdir -p "$ARTIFACTS" 2>/dev/null

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
# The SoT travels WITH this script (same pattern as scripts/check-worktree-root.mjs), so a
# user-level registration pointing at an absolute committed path resolves its config too.
SOT="${ALGOVAULT_WORKTREE_SOT:-$SELF_DIR/../ops/shared-worktree-state.json}"

now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
# say(): diagnostics NEVER touch stdout. /dev/tty is best-effort (absent under -p / CI).
say()  { printf '[worktree-create-hook] %s\n' "$*" >>"$LOG" 2>/dev/null
         printf '[worktree-create-hook] %s\n' "$*" >/dev/tty 2>/dev/null || true; }

# ── 1. Read stdin ONCE, and record it verbatim ────────────────────────────────────────────
# Q1: the hook is its own instrument. Unknown surfaces (Desktop, Cowork, isolation:worktree)
# are answered by OBSERVATION rather than inference, so every fire records what fired it.
STDIN_RAW="$(cat 2>/dev/null || true)"
{
  printf '{"at":"%s","pid":%s,"ppid":%s,"parent":"%s","cwd":"%s","term":"%s","payload":%s}\n' \
    "$(now)" "$$" "${PPID:-0}" \
    "$(ps -o comm= -p "${PPID:-0}" 2>/dev/null | tr -d '\n' | sed 's/"/\\"/g')" \
    "$(pwd 2>/dev/null | sed 's/"/\\"/g')" \
    "${TERM_PROGRAM:-${TERM:-unknown}}" \
    "$(printf '%s' "${STDIN_RAW:-null}" | tr -d '\n' | grep -q . && printf '%s' "$STDIN_RAW" | tr -d '\n' || printf 'null')"
} >>"$ARTIFACTS/hook-fires.jsonl" 2>/dev/null

jqr() { printf '%s' "$STDIN_RAW" | jq -r "$1 // empty" 2>/dev/null; }

HOOK_CWD="$(jqr '.cwd')"
RAW_NAME="$(jqr '.name')"
[ -n "$HOOK_CWD" ] || HOOK_CWD="$(pwd)"
say "fired: name='${RAW_NAME:-<absent>}' cwd='$HOOK_CWD'"

# ── 2. emit(): the ONE exit point that writes stdout ───────────────────────────────────────
emit_path() { printf '%s\n' "$1"; exit 0; }

# Fail-open: place at the DEFAULT location and still exit 0.
fail_open() {
  local reason="$1" name="$2"
  say "FAIL-OPEN: $reason — falling back to the default location"
  local root def
  root="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null)"
  if [ -z "$root" ]; then
    say "FAIL-OPEN-ABORT: no repository at '$HOOK_CWD' — no valid path exists to print"
    exit 1
  fi
  def="$root/.claude/worktrees/$name"
  mkdir -p "$(dirname "$def")" 2>/dev/null
  if [ ! -e "$def" ]; then
    git -C "$root" worktree add "$def" -b "worktree-$name" >/dev/null 2>&1 \
      || git -C "$root" worktree add "$def" >/dev/null 2>&1 \
      || mkdir -p "$def" 2>/dev/null
  fi
  emit_path "$def"
}

# ── 3. task = .name, sanitized ─────────────────────────────────────────────────────────────
# It becomes a filesystem path in a hook that runs on EVERY worktree creation on this
# machine, so an unsanitized field is a path traversal.
sanitize() {
  printf '%s' "$1" \
    | tr '/\\' '--' \
    | tr -c 'A-Za-z0-9._-' '-' \
    | sed -e 's/\.\{2,\}/./g' -e 's/^[-.]*//' -e 's/[-.]*$//' -e 's/--*/-/g'
}
TASK="$(sanitize "${RAW_NAME:-}")"
if [ -z "$TASK" ]; then
  # Absent .name is a REAL case (mid-session request). Declared fallback chain; never an
  # empty path component.
  BR="$(git -C "$HOOK_CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  [ "$BR" = "HEAD" ] && BR=""
  TASK="$(sanitize "${BR:-}")"
  [ -n "$TASK" ] || TASK="wt-$(date -u +%Y%m%dT%H%M%SZ)"
  say "name absent/empty — fallback task='$TASK'"
fi

# ── 4. repo, from --git-common-dir (NOT --show-toplevel) ───────────────────────────────────
# --show-toplevel returns the WORKTREE's top, not the repo's. Launch from inside
# cqsm-wt-tdqs and it resolves to `cqsm-wt-tdqs`, so the destination becomes
# <root>/cqsm-wt-tdqs/<task>: a plausible-looking path that silently fragments the tree
# per worktree. Worktree-launched sessions are the COMMON case here, not the edge.
# (Verbatim W2 CH1 F1/D1 — this estate has already fixed this exact bug once.)
GCD="$(git -C "$HOOK_CWD" rev-parse --git-common-dir 2>/dev/null)"
if [ -z "$GCD" ]; then
  # THE RATIFIED INVERSION — no repo means no valid path, for us or for the default logic.
  say "ABORT: '$HOOK_CWD' is not inside a git repository; no valid worktree path exists."
  say "ABORT: exiting non-zero deliberately — printing a bogus path would hang the session."
  exit 1
fi
# --git-common-dir routinely returns a RELATIVE '.git' from a primary checkout.
case "$GCD" in /*) ;; *) GCD="$HOOK_CWD/$GCD" ;; esac
GCD="$(cd "$GCD" 2>/dev/null && pwd)" || GCD=""
if [ -z "$GCD" ] || [ "$(basename "$GCD")" != ".git" ]; then
  # A bare repo or an unusual layout: not fatal, but not our shape either.
  say "unexpected git-common-dir '$GCD' — cannot derive repo name"
  fail_open "git-common-dir did not resolve to a .git directory" "$TASK"
fi
REPO="$(basename "$(dirname "$GCD")")"
if [ -z "$REPO" ] || [ "$REPO" = ".git" ] || [ "$REPO" = "/" ]; then
  fail_open "derived repo name is degenerate ('$REPO')" "$TASK"
fi

# ── 5. worktree_root from the SoT ──────────────────────────────────────────────────────────
[ -r "$SOT" ] || fail_open "SoT unreadable at $SOT" "$TASK"
ROOT="$(jq -r '.worktree_roots.worktree_root // empty' "$SOT" 2>/dev/null)"
case "$ROOT" in
  /*) ;;
  *)  fail_open "SoT declares no absolute worktree_roots.worktree_root" "$TASK" ;;
esac
# ALGOVAULT_WORKTREE_ROOT overrides for a deliberate off-root session (same lever cc-session.sh uses).
ROOT="${ALGOVAULT_WORKTREE_ROOT:-$ROOT}"

DEST="$ROOT/$REPO/$TASK"
mkdir -p "$ROOT/$REPO" 2>/dev/null || fail_open "cannot create parent $ROOT/$REPO" "$TASK"

# ── 6. Idempotence + collision ─────────────────────────────────────────────────────────────
# Firing twice with the same task must not clobber an existing worktree.
if [ -e "$DEST" ]; then
  if git -C "$HOOK_CWD" worktree list --porcelain 2>/dev/null | grep -qxF "worktree $DEST"; then
    say "destination already a registered worktree — reusing it (idempotent): $DEST"
    emit_path "$DEST"
  fi
  n=2
  while [ -e "$ROOT/$REPO/$TASK-$n" ] && [ "$n" -lt 100 ]; do n=$((n+1)); done
  DEST="$ROOT/$REPO/$TASK-$n"
  say "collision — using distinct path: $DEST"
fi

# ── 7. Base ref — never hardcode `main` ────────────────────────────────────────────────────
# U6 MEASURED: `worktree.baseRef` is structurally BYPASSED once this hook is defined (the
# payload carries no base field at all), so this hook owns base-ref selection OUTRIGHT.
REPO_TOP="$(dirname "$GCD")"
if git -C "$REPO_TOP" fetch origin --quiet >/dev/null 2>&1; then
  :
else
  FETCH_HEAD="$REPO_TOP/.git/FETCH_HEAD"
  AGE="unknown"
  [ -f "$FETCH_HEAD" ] && AGE="$(( ( $(date +%s) - $(stat -f %m "$FETCH_HEAD" 2>/dev/null || echo 0) ) / 60 )) min"
  say "fetch failed — proceeding on the CACHED ref (age: $AGE). Refusing to start a session offline is worse than a slightly stale base."
fi
BASE="$(git -C "$REPO_TOP" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
[ -n "$BASE" ] || { git -C "$REPO_TOP" rev-parse --verify --quiet origin/main >/dev/null 2>&1 && BASE="origin/main"; }
[ -n "$BASE" ] || BASE="$(git -C "$REPO_TOP" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$BASE" ] || fail_open "cannot resolve any base ref" "$TASK"
say "base=$BASE dest=$DEST"

# ── 8. Create — ALL git output away from stdout (D3: extra bytes = silent hang) ────────────
BRANCH="worktree-$TASK"
if git -C "$REPO_TOP" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  BRANCH="$BRANCH-$(date -u +%H%M%S)"
fi
if ! git -C "$REPO_TOP" worktree add "$DEST" -b "$BRANCH" "$BASE" >>"$LOG" 2>&1; then
  say "git worktree add failed (see $LOG)"
  fail_open "git worktree add failed" "$TASK"
fi

# ── 9. A hook that REPLACES creation must replace ALL of creation ──────────────────────────
# `.worktreeinclude` is NOT processed once a WorktreeCreate hook exists ("Because the hook
# replaces the default git behavior, .worktreeinclude is not processed... Copy any local
# configuration files inside your hook script instead"), and cc-session.sh's manual path —
# which this hook displaces — also allocated PORT and installed dependencies. Replacing
# placement while silently dropping those is a partial replacement: the same
# instrument-blind-to-what-it-displaced class this arc keeps meeting.
# Every step below is INDIVIDUALLY fail-open: none may cost us the worktree.
if [ -r "$REPO_TOP/.worktreeinclude" ]; then
  while IFS= read -r pat; do
    case "$pat" in ''|'#'*) continue ;; esac
    [ -e "$REPO_TOP/$pat" ] || continue
    mkdir -p "$DEST/$(dirname "$pat")" 2>/dev/null
    cp -p "$REPO_TOP/$pat" "$DEST/$pat" 2>/dev/null && say "copied $pat"
  done < "$REPO_TOP/.worktreeinclude"
fi

# PORT allocation — same window cc-session.sh uses (base 3100, range 400), hashed off the path.
if [ -f "$DEST/.env.local" ] && ! grep -qs '^PORT=' "$DEST/.env.local" 2>/dev/null; then
  h=$(printf '%s' "$DEST" | cksum | cut -d' ' -f1)
  printf 'PORT=%s\n' "$(( 3100 + (h % 400) ))" >> "$DEST/.env.local" 2>/dev/null && say "assigned PORT"
fi

# Dependencies: BACKGROUNDED behind a sentinel. A worktree without node_modules is usable;
# one that does not exist is not — and blocking session start on a full install is its own
# outage. NEVER symlink node_modules: stale symlinked deps falsely trip the pre-push gate.
#
# Two things measured the hard way during CH2, both kept:
#   (a) The sentinel lives OUTSIDE the worktree. Written inside, it is an untracked file in
#       every worktree forever — and `cc-session.sh clean` reads dirtiness as an in-use
#       signal, so the hook would have quietly made every worktree look occupied.
#   (b) Concurrent `npm ci` runs share ONE cache (~/.npm/_cacache) and corrupt each other:
#       six rapid creates produced "tarball seems to be corrupted" retries and a hard
#       `ENOENT ... mkdir node_modules/<pkg>`. Installs are therefore SERIALIZED machine-wide
#       behind an atomic mkdir lock (macOS ships no flock).
if [ -f "$DEST/package.json" ] && [ ! -d "$DEST/node_modules" ]; then
  if command -v npm >/dev/null 2>&1; then
    SENT_DIR="$ARTIFACTS/npm-install"; mkdir -p "$SENT_DIR" 2>/dev/null
    SENT="$SENT_DIR/$(printf '%s' "${REPO}__${TASK}" | tr -c 'A-Za-z0-9._-' '-')"
    LOCK="$ARTIFACTS/.npm-install.lock"
    ( : > "$SENT.running"
      tries=0
      while ! mkdir "$LOCK" 2>/dev/null; do
        tries=$((tries+1))
        [ "$tries" -gt 180 ] && break     # 15 min ceiling; never wedge forever
        sleep 5
      done
      trap 'rmdir "$LOCK" 2>/dev/null' EXIT
      if ( cd "$DEST" && npm ci >>"$LOG" 2>&1 ); then mv "$SENT.running" "$SENT.done"
      else mv "$SENT.running" "$SENT.failed"; fi
    ) >/dev/null 2>&1 </dev/null &
    disown 2>/dev/null || true
    say "npm ci queued in background (serialized; sentinel $SENT.*)"
  else
    say "npm not found — skipping dependency install"
  fi
fi

# ── 10. THE path, and nothing else ─────────────────────────────────────────────────────────
say "OK -> $DEST"
emit_path "$DEST"
