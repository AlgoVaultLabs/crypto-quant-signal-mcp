#!/usr/bin/env bash
# alloc-port.sh — OPS-WORKTREE-HOOK-PORT-PARITY-W1
#
# THE ONE DERIVATION for "which local PORT does worktree task <T> get?"
#
# SINGLE DERIVATION, deliberately — same law as scripts/lib/branch-work-landed.sh, and it
# is here for the same reason: two implementations of one answer WILL drift, and we get the
# bug back in whichever one nobody is looking at.
#
# ── WHAT WENT WRONG, MEASURED 2026-08-10 ──────────────────────────────────────
#
# OPS-WORKTREE-CREATE-HOOK-W1 moved worktree PLACEMENT to one file outside every repo, and
# the hook's own comment states the intent: "A hook that REPLACES creation must replace ALL
# of creation." The PORT half was replaced with a SECOND implementation rather than a reuse
# of the first, and the two disagreed on both the input and the trigger:
#
#                     cc-session.sh alloc_port()   worktree-create-hook.sh (inline)
#   hashed input      the TASK NAME                the DESTINATION PATH
#   in-use bump       yes                          no
#   no .env.local     writes it (`>>` creates)     skipped it entirely
#   window            PORT_BASE / PORT_RANGE       literals 3100 / 400
#
# Same window, different number. `cc-session.sh port <task>` is DOCUMENTED as "the
# deterministic port a task would use" and is what the SessionStart bootstrap calls, so it
# could not reproduce a port the hook had written; `list` renders whatever is in .env.local,
# so `list` and `port` could disagree about one worktree with neither being detectably wrong.
#
# ── THE CANONICAL INPUT IS THE TASK NAME, NOT THE PATH ────────────────────────
#
# This is the direction that keeps the documented `port <task>` oracle TRUE and keeps the
# bootstrap's answer identical to the hook's. Moving the wrapper to path-hashing instead
# would have broken both. Do not "improve" this to hash the destination.
#
# ── NOT PURE, AND SAID ONCE HERE RATHER THAN NOWHERE ──────────────────────────
#
# The in-use bump makes the result depend on what is LISTENING at the moment of the call, so
# two calls can differ. That is pre-existing behaviour, is deliberate (a deterministic port
# that is already taken is worse than a nearby free one), and is now recorded in one place
# instead of being an unremarked property of two implementations.
#
# ── USAGE ─────────────────────────────────────────────────────────────────────
#   bash scripts/lib/alloc-port.sh <task>     # prints the port  (the house pattern)
#   . scripts/lib/alloc-port.sh               # defines algovault_alloc_port <task>
#
# No `set -e` at file scope: this file is sourceable, and `set -e` in a sourced file changes
# the CALLER's shell. Portable to macOS bash 3.2.

# Window: avoids server 3000 / facilitator 4022 / landing 5500. Candidates 3100..3499.
ALGOVAULT_PORT_BASE=3100
ALGOVAULT_PORT_RANGE=400

# true (0) iff something is LISTENING on $1. Cannot check → assume free (1).
algovault_port_in_use() {
  local p="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w1 127.0.0.1 "$p" >/dev/null 2>&1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

# ONE derivation means one INPUT NORMALIZATION too, or it is not one derivation.
#
# The two callers arrive with differently-normalized strings for the same worktree: the hook's
# sanitize() preserves case (its output is also the DIRECTORY name), while cc-session.sh's
# slugify() lowercases. Hashing those raw would hand back two ports for one worktree and undo
# the whole point of this file. The key is therefore normalized here, with slugify's rule, and
# it is idempotent — an already-slugged task is unchanged, which is every real task on this
# machine, so no existing worktree's port moves.
#
# Residual, stated rather than hidden: the two sanitizers still differ on characters no real
# task name uses (`/` becomes `-` in the hook, and is dropped by slugify). The consumer that
# matters agrees regardless — the SessionStart bootstrap passes the worktree's DIRECTORY name,
# which is exactly the hook's own TASK.
algovault_port_task_key() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9._-'
}

# deterministic base port from the TASK NAME, bumped past any in-use port
algovault_alloc_port() {
  local task h p tries=0
  task="$(algovault_port_task_key "$1")"
  h=$(printf '%s' "$task" | cksum | awk '{print $1}')
  p=$(( ALGOVAULT_PORT_BASE + (h % ALGOVAULT_PORT_RANGE) ))
  while algovault_port_in_use "$p"; do
    p=$(( p + 1 ))
    [ "$p" -ge $(( ALGOVAULT_PORT_BASE + ALGOVAULT_PORT_RANGE )) ] && p="$ALGOVAULT_PORT_BASE"
    tries=$(( tries + 1 ))
    [ "$tries" -ge 50 ] && break
  done
  printf '%s\n' "$p"
}

# Executed directly (not sourced) → act as the CLI. bash 3.2 safe under `set -u`.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  [ $# -ge 1 ] || { echo "usage: alloc-port.sh <task>" >&2; exit 2; }
  algovault_alloc_port "$1"
fi
