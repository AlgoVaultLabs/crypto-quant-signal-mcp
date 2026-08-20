#!/usr/bin/env bash
# ── FIRST STATEMENT, AND IT MUST STAY FIRST ──────────────────────────────────
# Git exports these into any process it spawns. A script that then runs git inherits ANOTHER
# repository's identity and mutates the real index. Measured on THIS event 2026-08-20: a
# SessionEnd fire arrives with all five UNSET, because Claude Code is not git — but the hook
# is also invoked from git-adjacent contexts and from tests that poison the environment
# deliberately (AC4.4), and a guard that is only correct in the environment it was tested in
# is not a guard. Asserted BEHAVIOURALLY, never by grepping for this line: a comment
# containing it would pass.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
#
# session-end-work-pending.sh — OPS-WORKTREE-WORK-PENDING-W1 CH4
#
# THE EXIT BOUNDARY. The auto-commit LAW fires on R-step completion; NOTHING fired when a
# session ended — which is exactly when work gets stranded. The receipt: a wave's bot-side
# edits were written and tested, the wave crossed to another repo and halted, and the edits
# sat uncommitted for THREE DAYS while a live revenue metric read a false zero.
#
# ── THE CONTRACT, MEASURED NOT ASSUMED (Claude Code 2.1.118, 2026-08-20) ─────
#
# Registered a logging-only probe, fired one real session, read its stdin verbatim:
#
#   registration shape : NESTED — .hooks.SessionEnd[] = [{hooks:[{type,command}]}]
#                        (the same form the live WorktreeCreate entry uses; this estate has
#                        already measured the DIRECT [{type,command}] form to fail SILENTLY)
#   stdin payload      : {session_id, transcript_path, cwd, hook_event_name, reason}
#   reason observed    : "other"
#   cadence            : fired EXACTLY ONCE for one session
#   tty                : NONE on stdin or stdout -> writing to the controlling terminal
#                        device would fail ENXIO. Hooks frequently have no terminal at all.
#   git env            : GIT_DIR / GIT_INDEX_FILE / GIT_COMMON_DIR all UNSET at fire time
#   fires on failure   : yes — the probe session exited non-zero and the hook still fired
#
# ── HOW THIS BEHAVES, AND WHY ────────────────────────────────────────────────
#
#   * SCOPED TO THE WORKTREE AT `cwd`, not the estate. A session is responsible for the tree
#     it sits in. The estate-wide census stays a deliberate `--all` invocation.
#   * NOT IN A GIT REPO -> exit 0, silently. Cowork sessions run with the vault as cwd; this
#     is the ratified behaviour of the existing WorktreeCreate hook.
#   * A GUARD ON A LIVE PATH REFUSES, IT DOES NOT THROW. Every internal error logs
#     INDETERMINATE and exits 0. It must never wedge a session — and SessionEnd cannot block
#     anyway, which is why the blocking capability is deliberately unused. CH5 makes the work
#     SAFE automatically; nagging an agent whose work is already preserved is noise.
#     Detect -> Recover, with no Alert step needed.
#   * ALL OUTPUT to $GIT_COMMON_DIR/algovault-work-pending.log and stdout. NEVER to the
#     controlling-terminal device — measured above, there isn't one.
#
# ── SINGLE DERIVATION ────────────────────────────────────────────────────────
#
# This hook does NOT classify anything itself. It shells out to
# scripts/lib/worktree-work-pending.sh — the ONE predicate — and selects its own row. A
# second implementation of "is there unlanded work here" WOULD drift, and the bug would come
# back in whichever copy nobody was watching.
#
# Scoping is done by rewriting only the manifest's `repos` array to the cwd's repo and
# reusing its classification rows verbatim, through the predicate's documented
# WORK_PENDING_CONFIG seam. That is as narrow as the declared interface goes without adding
# a flag to a file CH4 is forbidden to write.
#
# ── EXIT CODE ────────────────────────────────────────────────────────────────
# ALWAYS 0. The verdict is in the log and on stdout, never in the exit status.
set -uo pipefail

SELF="${BASH_SOURCE[0]}"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Test seams. Every one defaults to real behaviour.
PREDICATE_OVERRIDE="${ALGOVAULT_WORK_PENDING_PREDICATE:-}"
CWD_OVERRIDE="${ALGOVAULT_WORK_PENDING_CWD:-}"
LOG_OVERRIDE="${ALGOVAULT_WORK_PENDING_LOG:-}"
PRESERVE_OVERRIDE="${ALGOVAULT_PRESERVE_SCRIPT:-}"

# The canonical primary, used ONLY as the last fallback for locating the predicate. The hook
# itself is installed at a stable path outside every checkout (R4.3) precisely so that a
# reclaimed checkout cannot break every session on the machine; this fallback is the one
# remaining dependency and it degrades to INDETERMINATE rather than to an error.
CANONICAL_REPO="/Users/tank/code/crypto-quant-signal-mcp"

LOG=""            # resolved once the repo is known; until then, stdout only
say() {           # stdout ALWAYS; log too once we have one. Never the terminal device.
  printf '%s\n' "$*"
  [ -n "$LOG" ] && printf '%s\n' "$*" >> "$LOG" 2>/dev/null
  return 0
}

finish() {        # the ONLY exit path. Always 0.
  exit 0
}

indeterminate() {
  say "[work-pending] $STAMP SESSION_END_WORK_PENDING=INDETERMINATE reason=$1"
  finish
}

# ── read the payload ─────────────────────────────────────────────────────────
# stdin may be absent (a manual invocation), malformed, or a valid SessionEnd payload. All
# three are survivable. `cwd` is extracted with sed rather than jq so the common path has no
# dependency; jq is still required later, by the predicate.
PAYLOAD=""
if [ ! -t 0 ]; then PAYLOAD="$(cat 2>/dev/null || true)"; fi
CWD="$CWD_OVERRIDE"
if [ -z "$CWD" ] && [ -n "$PAYLOAD" ]; then
  CWD="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$CWD" ] || CWD="$PWD"
SESSION_ID="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$SESSION_ID" ] || SESSION_ID="-"
REASON="$(printf '%s' "$PAYLOAD" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$REASON" ] || REASON="-"

# ── not a git repo -> exit 0, SILENTLY ───────────────────────────────────────
# Deliberately before every other check, and deliberately silent: a Cowork session in the
# vault must produce no output and no file. This is the ratified WorktreeCreate behaviour.
[ -d "$CWD" ] || finish
git -C "$CWD" rev-parse --git-dir >/dev/null 2>&1 || finish

WORKTREE="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)" || finish
[ -n "$WORKTREE" ] || finish

# $GIT_COMMON_DIR was unset above, on purpose. Recompute it from the worktree — that is the
# whole point of unsetting it: we want THIS repo's common dir, not an inherited one.
COMMON="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
if [ -n "$LOG_OVERRIDE" ]; then LOG="$LOG_OVERRIDE"
elif [ -n "$COMMON" ] && [ -d "$COMMON" ]; then LOG="$COMMON/algovault-work-pending.log"
fi
# The log lives inside .git/, so it is untracked BY CONSTRUCTION and can never make the repo
# it reports on look dirty. R4.4's telemetry went here rather than into the tracked config
# for exactly that reason: a run-counter in a tracked file would have made this hook a
# generator of the noise the wave exists to retire.
[ -n "$LOG" ] && { : > /dev/null; touch "$LOG" 2>/dev/null || LOG=""; }

command -v git >/dev/null 2>&1 || indeterminate "git-absent"
command -v jq  >/dev/null 2>&1 || indeterminate "jq-absent"

# ── locate the ONE predicate ─────────────────────────────────────────────────
# Ordered, declared, and degrading to INDETERMINATE rather than to a broken session.
# An EXPLICIT override is EXCLUSIVE: if it is set and unreadable, that is INDETERMINATE, not
# a licence to quietly run a different predicate. A caller who pins one and silently gets
# another is being lied to — and the test for the not-found path was, until now, passing only
# because the canonical fallback happened to be missing from this machine. A test that passes
# because the estate is broken stops passing the moment it is fixed, which is exactly what
# happened here the hour the wave merged.
PREDICATE=""
if [ -n "$PREDICATE_OVERRIDE" ]; then
  [ -r "$PREDICATE_OVERRIDE" ] || indeterminate "pinned-predicate-unreadable: $PREDICATE_OVERRIDE"
  PREDICATE="$PREDICATE_OVERRIDE"
else
  for cand in \
    "$WORKTREE/scripts/lib/worktree-work-pending.sh" \
    "$CANONICAL_REPO/scripts/lib/worktree-work-pending.sh"
  do
    [ -n "$cand" ] && [ -r "$cand" ] && { PREDICATE="$cand"; break; }
  done
fi
if [ -z "$PREDICATE" ]; then
  # EXPECTED and BOUNDED before this wave merges: the predicate exists only on the wave's
  # branch, so the canonical-primary fallback cannot resolve yet. Degrade LOUDLY and exit 0 —
  # a hook that cannot evaluate must never wedge a session, and a silent skip would be
  # indistinguishable from a clean report. Self-heals the moment the branch lands on main.
  indeterminate "predicate-not-found (searched: this worktree, then $CANONICAL_REPO; the predicate lands there when OPS-WORKTREE-WORK-PENDING-W1 merges to main)"
fi

PREDICATE_DIR="$(cd "$(dirname "$PREDICATE")" && pwd)"
CONFIG="$PREDICATE_DIR/../../ops/worktree-noise-config.json"
[ -r "$CONFIG" ] || indeterminate "manifest-not-found"

# Which declared repo owns this worktree? `git rev-parse --show-toplevel` gives the WORKTREE,
# not the primary, so the common dir is what identifies the repo.
REPO=""
while IFS= read -r declared; do
  [ -n "$declared" ] || continue
  dc="$(git -C "$declared" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || continue
  [ "$dc" = "$COMMON" ] && { REPO="$declared"; break; }
done < <(jq -r '(.repos // [])[]' "$CONFIG" 2>/dev/null)

# A git repo that this wave does not declare is NOT an error and NOT indeterminate — it is
# out of scope, and saying so is the honest verdict. Silence here would be indistinguishable
# from a clean report.
if [ -z "$REPO" ]; then
  say "[work-pending] $STAMP SESSION_END_WORK_PENDING=OUT_OF_SCOPE worktree=$WORKTREE reason=repo-not-declared-in-manifest"
  finish
fi

# ── run the ONE predicate, scoped to this repo, and select our own row ───────
TMP="$(mktemp -d "${TMPDIR:-/tmp}/algovault-work-pending.XXXXXX")" || indeterminate "mktemp-failed"
trap 'rm -rf "$TMP"' EXIT
jq --arg r "$REPO" '.repos = [$r]' "$CONFIG" > "$TMP/config.json" 2>/dev/null || indeterminate "config-rewrite-failed"

WORK_PENDING_CONFIG="$TMP/config.json" bash "$PREDICATE" --all > "$TMP/rows" 2>"$TMP/err"
prc=$?
[ "$prc" -eq 3 ] && indeterminate "predicate-could-not-evaluate"
[ -s "$TMP/rows" ] || indeterminate "predicate-returned-no-rows"

ROW="$(awk -F'\t' -v w="$WORKTREE" 'NF>=7 && $1==w' "$TMP/rows" | head -1)"
[ -n "$ROW" ] || indeterminate "this-worktree-absent-from-the-census"

PENDING="$(printf '%s' "$ROW" | cut -f4)"
PROTECTED="$(printf '%s' "$ROW" | cut -f5)"
NCLASSA="$(printf '%s' "$ROW" | cut -f6)"
OLDEST="$(printf '%s' "$ROW" | cut -f7)"

# ── REPORT ───────────────────────────────────────────────────────────────────
say "[work-pending] $STAMP SESSION_END_WORK_PENDING=$PENDING worktree=$WORKTREE session=$SESSION_ID reason=$REASON class_a=$NCLASSA oldest_hours=$OLDEST protected_by=$PROTECTED"

if [ "$PENDING" = "YES" ]; then
  say "[work-pending]   this session is ending with UNCOMMITTED WORK in the tree it sat in:"
  WORK_PENDING_CONFIG="$TMP/config.json" bash "$PREDICATE" --all --paths class_a 2>/dev/null \
    | awk -F'\t' -v w="$WORKTREE" 'NF>=3 && $2==w {print "    " $3}' \
    | while IFS= read -r l; do say "$l"; done
fi

# ── R4.4 telemetry: one line per run, in the UNTRACKED log ───────────────────
# So the healing RATE is measured rather than guessed at the promotion decision. A guard
# permanently stuck in REPORT is decoration.
#
# LOCKING: macOS ships NO `flock` (it is util-linux). Measured 2026-08-20: `command -v flock`
# finds nothing. `mkdir` is the portable atomic primitive — it succeeds for exactly one
# caller — and needs no dependency at all. A stale lock is bounded by a bypass, because
# losing one telemetry line is strictly better than delaying a session exit.
if [ -n "$LOG" ]; then
  LOCK="$LOG.lock"
  locked=0
  i=0
  while [ "$i" -lt 20 ]; do
    if mkdir "$LOCK" 2>/dev/null; then locked=1; break; fi
    i=$(( i + 1 )); sleep 0.1
  done
  printf 'OBS\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$STAMP" "$SESSION_ID" "$REPO" "$WORKTREE" "$PENDING" "$NCLASSA" "$PROTECTED" >> "$LOG" 2>/dev/null
  [ "$locked" -eq 1 ] && rmdir "$LOCK" 2>/dev/null
fi

# ── CH5: RECOVER, not just detect ────────────────────────────────────────────
# Detect -> Recover -> Alert -> Escalate. A report alone leaves the stranding on the record
# exactly where it was: visible and still losable. So the work is made SAFE here, and no
# alert is raised for it — recovery alerts are noise, and there is nothing for an operator to
# do about work that has already been preserved. No Telegram on completion.
#
# Preservation failure is INDETERMINATE and NEVER fatal: this runs on a live path, the hook's
# only exit is 0, and a session must never be affected by a snapshot that could not be taken.
# The forensics go to the log.
PRESERVE=""
for cand in \
  "$PRESERVE_OVERRIDE" \
  "$PREDICATE_DIR/../preserve-pending-work.sh" \
  "$CANONICAL_REPO/scripts/preserve-pending-work.sh"
do
  [ -n "$cand" ] && [ -r "$cand" ] && { PRESERVE="$cand"; break; }
done

if [ -z "$PRESERVE" ]; then
  say "[work-pending]   PRESERVE=INDETERMINATE reason=preserve-script-not-found"
elif [ "$PENDING" = "YES" ]; then
  pout="$(ALGOVAULT_WORK_PENDING_PREDICATE="$PREDICATE" WORK_PENDING_CONFIG="$TMP/config.json" \
          bash "$PRESERVE" --worktree "$WORKTREE" 2>&1)"; prc=$?
  case "$prc" in
    0) say "[work-pending]   PRESERVE=PRESERVED $(printf '%s\n' "$pout" | sed -n 's/.*ref=\([^ ]*\).*/\1/p' | head -1)" ;;
    1) say "[work-pending]   PRESERVE=NOTHING_TO_PRESERVE (healthy no-op)" ;;
    *) say "[work-pending]   PRESERVE=INDETERMINATE rc=$prc — the session is UNAFFECTED" ;;
  esac
  # Full forensics to the log only, never to stdout: a session end is not the place for a
  # wall of text, but a failure nobody can diagnose later is worse.
  [ -n "$LOG" ] && printf '%s\n' "$pout" | sed 's/^/    /' >> "$LOG" 2>/dev/null
fi

finish
