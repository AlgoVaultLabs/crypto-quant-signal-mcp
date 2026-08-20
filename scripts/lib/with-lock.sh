#!/usr/bin/env bash
# shellcheck shell=bash
#
# scripts/lib/with-lock.sh — OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH1 R1.
#
# THE ONE LOCK PRIMITIVE on this machine. Same law as scripts/lib/alloc-port.sh and
# scripts/lib/branch-work-landed.sh, and here for the same reason: two implementations of
# "who may write this right now" WILL drift, and the bug comes back in whichever copy nobody
# is watching. There is deliberately no second copy — scripts/check-shared-state.mjs asserts it.
#
# ─── WHY A LOCK EXISTS AT ALL ───────────────────────────────────────────────────────────────
#
# 49 checkouts (measured 2026-08-20, `git worktree list`) share ONE pre-push hook carrying NINE
# guarded blocks, the last of which is a full vitest run. A push therefore holds a ~2-minute
# window during which `main` can move underneath it; the transfer is then refused
# non-fast-forward, the session rebases and re-runs the whole gate. With N parallel sessions
# that is a livelock whose cost grows with N.
#
# The lock does NOT live in the hook. Traced against the measured hook, a hook-held lock does
# not fix the race: git has already computed the refs being pushed by the time the hook runs,
# a pre-push hook cannot rebase, and there is no post-push hook to release against — so the
# second session would wait politely, run its gate, and still be refused non-fast-forward
# because it never rebased onto the first session's new tip.
#
# The critical section must contain the FETCH and the REBASE. That is scripts/land.sh, and this
# file is the mutex it uses.
#
# ─── R1a — THE PRIMITIVE IS PROBE-DERIVED, NOT ASSUMED ──────────────────────────────────────
#
# Probed on the operator machine 2026-08-20 (Darwin 25.5.0 arm64, GNU bash 3.2.57), in the
# order the spec prescribes:
#
#   (i)   command -v flock                  -> NOT FOUND. flock(1) is util-linux and is not
#                                             part of the macOS base system. CHOSEN: no.
#   (ii)  mkdir-atomic (POSIX)              -> available everywhere, no dependency, no process
#                                             spawn per acquire, works in bash 3.2.  ** CHOSEN **
#   (iii) python3 -c 'import fcntl'         -> available (/usr/bin/python3, LOCK_EX=2), but it
#                                             costs an interpreter start per acquire and cannot
#                                             hold a lock across a shell's lifetime without a
#                                             supervising process. CHOSEN: no.
#
# mkdir(2) is required by POSIX to fail if the directory exists, and to do so atomically, which
# is the whole mutex. Do not "improve" this to a `test -e` followed by a `mkdir` — that pair is
# not atomic and is the classic way to write a lock that does not lock.
#
# ─── R1b — STALE-HOLDER RECLAIM IS MANDATORY, AND IS THE POINT ──────────────────────────────
#
# Without reclaim, ONE crashed session deadlocks all 49 checkouts — strictly worse than the race
# it replaces, and the exact trap check-shared-state.mjs's own header warns about ("a reconciler
# that refuses every push until 69 stale worktrees are reclaimed is strictly worse than the
# problem"). A holder is stale when its pid is not alive on this host, or when it has held the
# lock longer than the declared TTL. A reclaim is LOGGED with the dead holder's identity.
#
# Reclaim itself is raced-safe: the reclaimer first `mv`s the lock directory aside to a unique
# name. Exactly one racer can win that rename; the losers see their mv fail and go back to
# polling, so two waiters can never both conclude "I reclaimed it" and both proceed.
#
# ─── R1c/R1d — VERDICT TOKEN, AND TIMEOUT FAILS *OPEN* ──────────────────────────────────────
#
#   LANDING_LOCK_VERDICT=ACQUIRED | RECLAIMED | TIMEOUT | BYPASSED | INDETERMINATE
#
#   exit 0 -> ACQUIRED · RECLAIMED · TIMEOUT · BYPASSED
#   exit 3 -> INDETERMINATE      (the token-law default for a NEW gate: deliberately not 1, and
#                                 deliberately not check_test_baseline.sh's 2, which exists only
#                                 because that script already deployed 2. One meaning, one code,
#                                 chosen locally — do not "align" these.)
#
# Four tokens share exit 0 and that is deliberate and compliant: the token law forbids exit 0
# encoding both "verified, clean" and "verified nothing" — it requires the TOKEN to distinguish
# them, and callers to gate on the token rather than the code. Which is what land.sh does.
#
# TIMEOUT PROCEEDS WITHOUT THE LOCK, LOUDLY. Today's behaviour is *no lock at all*, so failing
# open is never worse than the status quo, while failing closed would let one wedged session
# refuse every push in the estate — the fleet wedge arriving through a different door. The token
# is what makes the fail-open measurable; land.sh's bounded rebase-retry is what makes it
# survivable. This follows the shared-state registry's own ratified stance: "blocking without
# remediation is hostile."
#
# INDETERMINATE is reachable only for "could not evaluate" — no git repo and no explicit
# ALGOVAULT_LOCK_DIR, or a lock root that cannot be created. Never for a busy lock.
#
# ─── R1e — REENTRANCY IS BY EXPORTED MARKER, NOT BY PID ─────────────────────────────────────
#
# The nested case that actually happens is not "the same pid asks twice" — it is land.sh holding
# the lock and then spawning `git push`, which spawns the pre-push hook, which runs `--detect`.
# Every one of those is a DIFFERENT pid, so pid-based reentrancy would answer "not held" for the
# one call that matters. The marker is an exported environment variable, so it descends the whole
# process tree, and the detector's question ("is this push running inside a held lock?") is
# answered correctly for a grandchild.
#
# Re-acquisition inside a held lock is counted, never re-locked, and never self-deadlocks; the
# lock directory is removed only when the outermost holder releases. Pinned by tests.
#
# ─── THE MARKER IS A DETECTOR, NOT A SECURITY BOUNDARY ──────────────────────────────────────
#
# An environment variable can be set by hand. That is fine: --detect measures how often landing
# bypasses the lock so the report-only block can be promoted on evidence, and nothing about the
# repo's safety rests on it. It is cross-checked against the real lock directory and a live
# holder pid, so a bare `ALGOVAULT_LOCK_HELD_LANDING=1 git push` still reports BYPASSED.
#
# ─── USAGE ──────────────────────────────────────────────────────────────────────────────────
#
#   bash scripts/lib/with-lock.sh <name> -- <cmd> [args…]   # run cmd under the lock
#   bash scripts/lib/with-lock.sh --detect [<name>]         # report held/bypassed (READ-ONLY)
#   bash scripts/lib/with-lock.sh --self-test               # two-way, vacuity-guarded
#   . scripts/lib/with-lock.sh                              # defines algovault_lock_* functions
#
# --detect NEVER READS STDIN, and that is a BLOCKING contract, not a preference. It runs as a
# pre-push block sorting AHEAD of `push-safety`, and scripts/check-push-safety.sh:308 consumes
# the hook's stdin (`while IFS= read -r line || [ -n "$line" ]`) — stdin is the only channel by
# which a pre-push hook learns which refs are being pushed. Its documented 3-state contract
# returns PASS on zero lines, so a block ahead of it that drained stdin would make force-push
# and deletion protection silently PASS. The emitted block additionally redirects `</dev/null`,
# so consuming it is structurally impossible rather than merely promised. If --detect ever needs
# ref data, `tee` in check-push-safety.sh as its header instructs — NEVER reorder these blocks.
#
# No `set -e` at file scope: this file is sourceable and `set -e` in a sourced file changes the
# CALLER's shell. Portable to macOS bash 3.2 (no mapfile, no associative arrays, no ${x^^}).

# ── DECLARED CONSTANTS ──────────────────────────────────────────────────────────────────────
# TTL 900s: the pre-push gate is ~2 min, so 15 minutes is ~7x the longest legitimate hold — far
# enough above it that a slow gate is never reclaimed under a live holder, and short enough that
# a crashed one frees within a quarter hour even if its pid was somehow recycled. The common
# crash case does not wait for the TTL at all: a dead pid reclaims immediately.
ALGOVAULT_LOCK_TTL="${ALGOVAULT_LOCK_TTL:-900}"
# TIMEOUT 600s: how long a waiter blocks before failing OPEN. Deliberately BELOW the TTL so a
# waiter never sits behind a holder it would have been entitled to reclaim.
ALGOVAULT_LOCK_TIMEOUT="${ALGOVAULT_LOCK_TIMEOUT:-600}"
ALGOVAULT_LOCK_POLL="${ALGOVAULT_LOCK_POLL:-1}"

# ── helpers ─────────────────────────────────────────────────────────────────────────────────

algovault_lock__now() { date +%s; }
algovault_lock__iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Marker variable name for a lock: `landing` -> ALGOVAULT_LOCK_HELD_LANDING.
algovault_lock__marker_var() {
  printf 'ALGOVAULT_LOCK_HELD_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"
}

algovault_lock__depth_var() {
  printf 'ALGOVAULT_LOCK_DEPTH_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_' | tr -cd 'A-Z0-9_')"
}

# Lock root. ALGOVAULT_LOCK_DIR overrides (tests, and any consumer outside a repo); otherwise
# $GIT_COMMON_DIR, which is exactly the boundary this lock serializes: every worktree on this
# one machine sharing one object store. A second machine or a cloud session is OUTSIDE it, by
# construction, which is why ops/shared-worktree-state.json declares that scope explicitly.
algovault_lock__root() {
  if [ -n "${ALGOVAULT_LOCK_DIR:-}" ]; then
    printf '%s' "$ALGOVAULT_LOCK_DIR"
    return 0
  fi
  local common
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  common="$(cd "$common" 2>/dev/null && pwd)" || return 1
  printf '%s/algovault-locks' "$common"
}

algovault_lock__field() {  # <lockdir> <field>
  [ -f "$1/holder" ] || return 1
  local v
  v="$(grep "^$2=" "$1/holder" 2>/dev/null | head -1 | cut -d= -f2-)" || return 1
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}

# Is the CURRENT holder of <lockdir> stale? 0 = stale (reclaimable), 1 = live.
# Prints a one-line reason on stdout when stale, so the reclaim can be logged with the dead
# holder's identity rather than as an anonymous event.
algovault_lock__stale() {  # <lockdir>
  local dir="$1" pid host acq now age
  now="$(algovault_lock__now)"

  if [ ! -f "$dir/holder" ]; then
    # Held but unidentified. Either a holder mid-write (microseconds) or a corrupt lock. Use the
    # directory's own age: young means mid-write and we keep waiting; older than the TTL means
    # nobody is going to write it.
    age="$(algovault_lock__dir_age "$dir")" || return 1
    if [ "$age" -gt "$ALGOVAULT_LOCK_TTL" ]; then
      printf 'no holder record and lock directory is %ss old (TTL %ss)' "$age" "$ALGOVAULT_LOCK_TTL"
      return 0
    fi
    return 1
  fi

  pid="$(algovault_lock__field "$dir" pid || true)"
  host="$(algovault_lock__field "$dir" hostname || true)"
  acq="$(algovault_lock__field "$dir" acquired_epoch || true)"

  # TTL first: it is host-independent and needs no pid.
  if [ -n "$acq" ]; then
    age=$((now - acq))
    if [ "$age" -gt "$ALGOVAULT_LOCK_TTL" ]; then
      printf 'pid=%s host=%s held for %ss, exceeding TTL %ss' \
        "${pid:-?}" "${host:-?}" "$age" "$ALGOVAULT_LOCK_TTL"
      return 0
    fi
  fi

  # Dead-pid reclaim is only meaningful for a holder on THIS host — a pid number from another
  # machine says nothing about a process here, and killing off its lock on that basis would be
  # a guess wearing a measurement's clothes.
  if [ -n "$pid" ] && [ "$host" = "$(hostname)" ]; then
    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'pid=%s host=%s is no longer alive' "$pid" "$host"
      return 0
    fi
  fi

  return 1
}

algovault_lock__dir_age() {  # <dir> -> seconds
  local mt now
  # BSD stat first (the operator machine), GNU stat second (CI / Linux hosts).
  mt="$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null)" || return 1
  [ -n "$mt" ] || return 1
  now="$(algovault_lock__now)"
  printf '%s' "$((now - mt))"
}

algovault_lock__write_holder() {  # <lockdir>
  {
    printf 'pid=%s\n' "$$"
    printf 'hostname=%s\n' "$(hostname)"
    printf 'acquired_at=%s\n' "$(algovault_lock__iso)"
    printf 'acquired_epoch=%s\n' "$(algovault_lock__now)"
    printf 'worktree=%s\n' "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  } >"$1/holder" 2>/dev/null
}

# Append one row to the bypass/reclaim ledger. Best-effort: a ledger write must never be able to
# fail a push. The ledger is what makes the report-only block's promotion criterion MEASURABLE
# rather than aspirational — "BYPASSED count is 0 across the window" is a question you can only
# answer if every observation was recorded.
algovault_lock__ledger() {  # <verdict> <detail>
  local root
  root="$(algovault_lock__root 2>/dev/null)" || return 0
  mkdir -p "$root" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(algovault_lock__iso)" "$1" \
    "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" \
    "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" \
    "$2" >>"$root/bypass-ledger.log" 2>/dev/null || true
  return 0
}

# ── public API ──────────────────────────────────────────────────────────────────────────────
#
# On return, ALGOVAULT_LOCK_VERDICT holds the token. Callers gate on the TOKEN, not the code.

algovault_lock_acquire() {  # <name>
  local name="$1" root dir marker depth reason waited deadline reclaimed=0 tmp
  ALGOVAULT_LOCK_VERDICT=INDETERMINATE

  [ -n "$name" ] || { printf '%s\n' "✖ with-lock: acquire needs a lock name" >&2; return 3; }

  marker="$(algovault_lock__marker_var "$name")"
  depth="$(algovault_lock__depth_var "$name")"

  # ── reentrancy: already inside this lock in THIS process tree ──
  if [ -n "${!marker:-}" ]; then
    eval "$depth=\$(( \${$depth:-1} + 1 ))"
    ALGOVAULT_LOCK_VERDICT=ACQUIRED
    printf '%s\n' "[with-lock] '$name' already held in this process tree (depth ${!depth}) — reentrant, not re-locked." >&2
    return 0
  fi

  root="$(algovault_lock__root)" || {
    printf '%s\n' "✖ with-lock: cannot resolve a lock root — not inside a git repository and ALGOVAULT_LOCK_DIR is unset." >&2
    return 3
  }
  mkdir -p "$root" 2>/dev/null || {
    printf '%s\n' "✖ with-lock: cannot create lock root '$root'" >&2
    return 3
  }
  dir="$root/$name.lock"

  waited=0
  deadline=$(( $(algovault_lock__now) + ALGOVAULT_LOCK_TIMEOUT ))

  while :; do
    # THE MUTEX. mkdir(2) fails atomically if the directory exists.
    if mkdir "$dir" 2>/dev/null; then
      # Marker FIRST: it is what algovault_lock_release keys on, so exporting it before the
      # (slower) holder write shrinks the window in which a signal could orphan this directory.
      eval "export $marker=\"\$dir\""
      eval "$depth=1"
      algovault_lock__write_holder "$dir"
      if [ "$reclaimed" -eq 1 ]; then ALGOVAULT_LOCK_VERDICT=RECLAIMED; else ALGOVAULT_LOCK_VERDICT=ACQUIRED; fi
      return 0
    fi

    # Held. Is the holder stale?
    if reason="$(algovault_lock__stale "$dir")"; then
      # Exactly one racer may win this rename, so two waiters can never both reclaim.
      tmp="$dir.reclaim.$$.${RANDOM:-0}"
      if mv "$dir" "$tmp" 2>/dev/null; then
        printf '%s\n' "⚠️  with-lock: RECLAIMING stale lock '$name' — $reason" >&2
        algovault_lock__ledger RECLAIMED "$reason"
        rm -rf "$tmp" 2>/dev/null || true
        reclaimed=1
      fi
      continue
    fi

    if [ "$(algovault_lock__now)" -ge "$deadline" ]; then
      # R1d — FAIL OPEN, loudly. See the header for why this is never worse than the status quo.
      printf '%s\n' "⚠️  with-lock: TIMEOUT after ${ALGOVAULT_LOCK_TIMEOUT}s waiting for '$name'." >&2
      printf '%s\n' "⚠️    Proceeding WITHOUT the lock — deliberate fail-open. Holder:" >&2
      sed -e 's/^/⚠️      /' "$dir/holder" >&2 2>/dev/null || printf '%s\n' "⚠️      (no holder record)" >&2
      algovault_lock__ledger TIMEOUT "waited ${ALGOVAULT_LOCK_TIMEOUT}s for $name"
      ALGOVAULT_LOCK_VERDICT=TIMEOUT
      return 0
    fi

    if [ "$waited" -eq 0 ]; then
      printf '%s\n' "[with-lock] '$name' is held; waiting (timeout ${ALGOVAULT_LOCK_TIMEOUT}s)…" >&2
    fi
    waited=$((waited + 1))
    sleep "$ALGOVAULT_LOCK_POLL"
  done
}

algovault_lock_release() {  # <name>
  local name="$1" marker depth held d
  marker="$(algovault_lock__marker_var "$name")"
  depth="$(algovault_lock__depth_var "$name")"
  held="${!marker:-}"

  [ -n "$held" ] || return 0          # never held (or a TIMEOUT fail-open) — nothing to release

  d="$(eval "printf '%s' \"\${$depth:-1}\"")"
  if [ "$d" -gt 1 ]; then
    eval "$depth=\$(( d - 1 ))"
    return 0
  fi

  rm -rf "$held" 2>/dev/null || true
  eval "unset $marker"
  eval "unset $depth"
  return 0
}

# READ-ONLY. Never reads stdin. Never mutates the lock.
algovault_lock_detect() {  # <name>
  local name="${1:-landing}" marker held pid
  marker="$(algovault_lock__marker_var "$name")"
  held="${!marker:-}"

  if [ -n "$held" ] && [ -d "$held" ]; then
    pid="$(algovault_lock__field "$held" pid || true)"
    # Cross-check the marker against a real directory AND a live holder: a hand-set env var is
    # not evidence of a lock.
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      ALGOVAULT_LOCK_VERDICT=ACQUIRED
      return 0
    fi
  fi
  ALGOVAULT_LOCK_VERDICT=BYPASSED
  return 0
}

# ── executable mode ─────────────────────────────────────────────────────────────────────────

# Signal handler for `-- <cmd>` mode. Kills the command, releases, and exits 128+SIGINT — the
# conventional shell code for "terminated by interrupt", so a caller can tell an interruption
# from the command's own failure.
algovault_lock__interrupt() {  # <name>
  [ -n "${ALGOVAULT_LOCK__CMD_PID:-}" ] && kill -TERM "$ALGOVAULT_LOCK__CMD_PID" 2>/dev/null
  algovault_lock_release "$1"
  trap - EXIT INT TERM
  printf '\n%s\n' "⚠️  with-lock: interrupted — lock '$1' released." >&2
  # The token reports how the LOCK behaved, not how the command ended: the lock was taken and
  # released correctly, so it emits the acquisition mode. The 130 exit code is what says the
  # work was interrupted. Conflating the two would make a clean lock look like a failed one.
  printf 'LANDING_LOCK_VERDICT=%s\n' "${ALGOVAULT_LOCK__MODE:-ACQUIRED}"
  exit 130
}

algovault_lock__emit() {  # <token> -> prints the ONE terminal token, returns its exit code
  printf 'LANDING_LOCK_VERDICT=%s\n' "$1"
  case "$1" in
    ACQUIRED|RECLAIMED|TIMEOUT|BYPASSED) return 0 ;;
    *) return 3 ;;
  esac
}

algovault_lock__main() {
  local mode name rc

  case "${1:-}" in
    --self-test) algovault_lock__self_test; return $? ;;
    --detect)
      name="${2:-landing}"
      algovault_lock_detect "$name"
      case "$ALGOVAULT_LOCK_VERDICT" in
        BYPASSED)
          printf '%s\n' "⚠️  landing-lock: this push is NOT running inside scripts/land.sh's lock." >&2
          printf '%s\n' "⚠️    REPORT-ONLY this wave — nothing is blocked. Prefer: bash scripts/land.sh" >&2
          algovault_lock__ledger BYPASSED "raw push outside land.sh"
          ;;
        ACQUIRED)
          algovault_lock__ledger ACQUIRED "inside land.sh"
          ;;
      esac
      algovault_lock__emit "$ALGOVAULT_LOCK_VERDICT"
      return $?
      ;;
    ''|--help|-h)
      sed -n '2,60p' "$0" | sed -e 's/^# \{0,1\}//'
      return 0
      ;;
  esac

  name="$1"; shift
  [ "${1:-}" = "--" ] || {
    printf '%s\n' "✖ with-lock: expected '<name> -- <cmd>'; got '$name ${1:-}'" >&2
    algovault_lock__emit INDETERMINATE
    return 3
  }
  shift
  [ "$#" -gt 0 ] || {
    printf '%s\n' "✖ with-lock: no command after '--'" >&2
    algovault_lock__emit INDETERMINATE
    return 3
  }

  # ── TRAPS ARE ARMED BEFORE THE LOCK IS TAKEN, NOT AFTER ───────────────────────────────────
  #
  # Arming them after `algovault_lock_acquire` leaves a window: the lock directory exists, but a
  # signal arriving before the trap is installed takes bash's DEFAULT action and terminates it
  # without releasing — an orphaned lock. That window is microseconds on an idle machine and
  # wide enough to hit reliably under load; it was caught by this wave's own SIGINT test, which
  # passed in isolation and failed in the full parallel suite. Arming first closes it: releasing
  # when nothing is held is a no-op, so there is no cost to arming early.
  #
  # The irreducible remainder — a signal landing between `mkdir` returning and the marker being
  # exported one statement later — is covered by stale-holder reclaim (dead pid, then TTL), so
  # the worst case is self-healing rather than a deadlock.
  trap 'algovault_lock__interrupt "'"$name"'"' INT TERM
  trap 'algovault_lock_release "'"$name"'"' EXIT

  algovault_lock_acquire "$name" || { algovault_lock__emit "$ALGOVAULT_LOCK_VERDICT"; return 3; }
  mode="$ALGOVAULT_LOCK_VERDICT"
  ALGOVAULT_LOCK__MODE="$mode"

  # ── THE COMMAND RUNS IN THE BACKGROUND, AND THAT IS NOT A STYLE CHOICE ────────────────────
  #
  # bash does not run a trap while a FOREGROUND command is executing — it defers until that
  # command returns. Measured by this wave's own SIGINT test: `with-lock t -- sleep 30`, sent
  # SIGINT, held the lock for the full 30s before the trap fired. In an interactive terminal
  # that is invisible, because Ctrl-C signals the whole foreground process GROUP and the child
  # dies first; it is very visible to anything that signals the wrapper's pid directly, and it
  # is exactly the case that matters — interrupting `land.sh` during its ~2-minute gate must
  # free the lock now, not in two minutes.
  #
  # Backgrounding + `wait` makes the trap prompt: `wait` is interruptible, so the handler runs
  # immediately, kills the command, and releases.
  #
  # A background command in a NON-INTERACTIVE shell has its stdin redirected to /dev/null by
  # POSIX default, which would silently break any `-- <cmd>` that reads stdin. Duplicating fd 0
  # to fd 3 and feeding it back preserves the caller's stdin exactly.
  exec 3<&0
  "$@" <&3 &
  ALGOVAULT_LOCK__CMD_PID=$!

  wait "$ALGOVAULT_LOCK__CMD_PID"
  rc=$?

  algovault_lock_release "$name"
  trap - EXIT INT TERM
  # The ONE terminal token. The COMMAND's exit code is what we return — the token reports how
  # the lock behaved, the code reports what the caller's work did, and conflating them would
  # make a failed push look like a failed lock.
  printf 'LANDING_LOCK_VERDICT=%s\n' "$mode"
  return "$rc"
}

# ── self-test: two-directional, vacuity-guarded, and PROVEN able to fail ────────────────────
#
# Every case runs the REAL functions against a REAL temp lock root. There is no seam that
# replaces the mutex, because the mutex is the only thing worth testing — a hermetic self-test
# is structurally blind to exactly what its own seam replaces, and this file has exactly one
# interesting line (`mkdir "$dir"`).
#
# Assertions are WRAPPED so a broken subject reports `SELF-TEST: FAIL (n)` rather than aborting
# the suite: an assertion that RAISES is not an assertion.

algovault_lock__self_test() {
  local pass=0 fail=0 root out rc v

  # ── HERMETICITY: clear any INHERITED lock marker before building fixtures. ────────────────
  #
  # Found the hard way. The pre-push test-gate runs the suite from inside `git push`, which
  # scripts/land.sh spawns while HOLDING the landing lock — so every child of that push inherits
  # ALGOVAULT_LOCK_HELD_LANDING, and the "--detect OUTSIDE a lock reports BYPASSED" case saw the
  # ambient marker and correctly answered ACQUIRED. The detector was right; the fixture was not
  # isolated. A self-test must CONSTRUCT its world, not inherit one, or it measures the harness.
  for v in $(env | grep -E '^ALGOVAULT_LOCK_(HELD|DEPTH)_' | cut -d= -f1); do
    unset "$v"
  done

  st_assert() {  # <label> <actual> <expected>
    if [ "$2" = "$3" ]; then
      pass=$((pass + 1)); printf '  ✓ %s\n' "$1"
    else
      fail=$((fail + 1)); printf '  ✖ %s — expected [%s], got [%s]\n' "$1" "$3" "$2"
    fi
  }

  root="$(mktemp -d "${TMPDIR:-/tmp}/algovault-lock-selftest.XXXXXX")" || {
    printf '%s\n' "✖ self-test: mktemp -d failed"; algovault_lock__emit INDETERMINATE; return 3; }
  trap 'rm -rf "'"$root"'"' EXIT

  printf '%s\n' "with-lock --self-test  (root: $root)"

  # ── 1. MUST-ACQUIRE ──
  ( ALGOVAULT_LOCK_DIR="$root/a" bash "$0" t1 -- true >/dev/null 2>&1 ); rc=$?
  st_assert "a free lock is acquired (exit)" "$rc" "0"
  out="$(ALGOVAULT_LOCK_DIR="$root/a" bash "$0" t1b -- true 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "a free lock emits ACQUIRED" "$out" "LANDING_LOCK_VERDICT=ACQUIRED"

  # ── 2. MUST-RELEASE — the lock dir is gone afterwards ──
  st_assert "the lock directory is removed on release" "$( [ -d "$root/a/t1b.lock" ] && echo present || echo absent )" "absent"

  # ── 3. MUST-RELEASE ON NON-ZERO EXIT (trap, not the happy path) ──
  ( ALGOVAULT_LOCK_DIR="$root/b" bash "$0" t2 -- sh -c 'exit 7' >/dev/null 2>&1 ); rc=$?
  st_assert "a failing command's exit code is propagated" "$rc" "7"
  st_assert "the lock is released after a NON-ZERO exit" "$( [ -d "$root/b/t2.lock" ] && echo present || echo absent )" "absent"

  # ── 4. MUST-BLOCK — a live holder is not stolen ──
  mkdir -p "$root/c"
  mkdir "$root/c/t3.lock"
  { printf 'pid=%s\nhostname=%s\nacquired_at=%s\nacquired_epoch=%s\nworktree=%s\n' \
      "$$" "$(hostname)" "$(algovault_lock__iso)" "$(algovault_lock__now)" "$root"; } >"$root/c/t3.lock/holder"
  out="$(ALGOVAULT_LOCK_DIR="$root/c" ALGOVAULT_LOCK_TIMEOUT=2 ALGOVAULT_LOCK_POLL=1 \
        bash "$0" t3 -- true 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "a LIVE holder is waited on, then fails OPEN with TIMEOUT" "$out" "LANDING_LOCK_VERDICT=TIMEOUT"
  ( ALGOVAULT_LOCK_DIR="$root/c" ALGOVAULT_LOCK_TIMEOUT=2 ALGOVAULT_LOCK_POLL=1 \
      bash "$0" t3 -- true >/dev/null 2>&1 ); rc=$?
  st_assert "a TIMEOUT fail-open still exits 0 (the work RAN)" "$rc" "0"
  st_assert "the live holder's lock was NOT stolen" "$( [ -d "$root/c/t3.lock" ] && echo present || echo absent )" "present"

  # ── 5. MUST-RECLAIM — dead pid ──
  mkdir -p "$root/d"; mkdir "$root/d/t4.lock"
  # pid 2^31-1 is not a live process on any real machine; assert that before relying on it.
  st_assert "the fixture's dead pid really is dead" "$(kill -0 2147483647 2>/dev/null && echo alive || echo dead)" "dead"
  { printf 'pid=2147483647\nhostname=%s\nacquired_at=%s\nacquired_epoch=%s\nworktree=%s\n' \
      "$(hostname)" "$(algovault_lock__iso)" "$(algovault_lock__now)" "$root"; } >"$root/d/t4.lock/holder"
  out="$(ALGOVAULT_LOCK_DIR="$root/d" ALGOVAULT_LOCK_TIMEOUT=5 bash "$0" t4 -- true 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "a DEAD-pid holder is reclaimed" "$out" "LANDING_LOCK_VERDICT=RECLAIMED"

  # ── 6. MUST-RECLAIM — TTL exceeded, holder pid alive ──
  mkdir -p "$root/e"; mkdir "$root/e/t5.lock"
  { printf 'pid=%s\nhostname=%s\nacquired_at=%s\nacquired_epoch=%s\nworktree=%s\n' \
      "$$" "$(hostname)" "1970-01-01T00:00:00Z" "1" "$root"; } >"$root/e/t5.lock/holder"
  out="$(ALGOVAULT_LOCK_DIR="$root/e" ALGOVAULT_LOCK_TTL=60 ALGOVAULT_LOCK_TIMEOUT=5 \
        bash "$0" t5 -- true 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "a TTL-exceeded holder is reclaimed even with a LIVE pid" "$out" "LANDING_LOCK_VERDICT=RECLAIMED"

  # ── 7. MUST-DETECT — both directions ──
  out="$(ALGOVAULT_LOCK_DIR="$root/f" bash "$0" --detect landing 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "--detect OUTSIDE a lock reports BYPASSED" "$out" "LANDING_LOCK_VERDICT=BYPASSED"
  out="$(ALGOVAULT_LOCK_DIR="$root/f" bash "$0" landing -- bash "$0" --detect landing 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | head -1)"
  st_assert "--detect INSIDE a lock reports ACQUIRED" "$out" "LANDING_LOCK_VERDICT=ACQUIRED"

  # ── 8. MUST-NOT-TRUST a hand-set marker (the detector is cross-checked) ──
  out="$(ALGOVAULT_LOCK_DIR="$root/f" ALGOVAULT_LOCK_HELD_LANDING="$root/f/nonexistent.lock" \
        bash "$0" --detect landing 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "a FORGED marker with no lock directory still reports BYPASSED" "$out" "LANDING_LOCK_VERDICT=BYPASSED"

  # ── 9. MUST-BE-REENTRANT — a nested acquire must not self-deadlock ──
  out="$(ALGOVAULT_LOCK_DIR="$root/g" ALGOVAULT_LOCK_TIMEOUT=5 \
        bash "$0" t6 -- bash "$0" t6 -- echo NESTED-OK 2>/dev/null | grep -c 'NESTED-OK')"
  st_assert "a nested acquire of the SAME lock does not deadlock" "$out" "1"

  # ── 10. MUST-BE-INDETERMINATE — could not evaluate ──
  out="$(ALGOVAULT_LOCK_DIR="$root/h" bash "$0" t7 no-double-dash 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "a malformed invocation is INDETERMINATE, never a pass" "$out" "LANDING_LOCK_VERDICT=INDETERMINATE"
  ( ALGOVAULT_LOCK_DIR="$root/h" bash "$0" t7 no-double-dash >/dev/null 2>&1 ); rc=$?
  st_assert "INDETERMINATE maps to exit 3 (token-law default for a new gate)" "$rc" "3"

  # ── 11. MUST-MAP — assert the token -> exit-code mapping itself, not only the tokens.
  # Re-coding a mapping while every token assertion stays green is a recorded live defect.
  ( algovault_lock__emit ACQUIRED      >/dev/null ); st_assert "ACQUIRED      -> 0" "$?" "0"
  ( algovault_lock__emit RECLAIMED     >/dev/null ); st_assert "RECLAIMED     -> 0" "$?" "0"
  ( algovault_lock__emit TIMEOUT       >/dev/null ); st_assert "TIMEOUT       -> 0 (fail-OPEN)" "$?" "0"
  ( algovault_lock__emit BYPASSED      >/dev/null ); st_assert "BYPASSED      -> 0 (report-only)" "$?" "0"
  ( algovault_lock__emit INDETERMINATE >/dev/null ); st_assert "INDETERMINATE -> 3" "$?" "3"

  # ── 12b. MUST BE HERMETIC — an inherited ambient marker must not change any verdict. This is
  # the case the pre-push gate found: the suite runs inside land.sh's lock, so every child sees
  # ALGOVAULT_LOCK_HELD_LANDING unless the fixture clears it.
  out="$(ALGOVAULT_LOCK_DIR="$root/j" ALGOVAULT_LOCK_HELD_LANDING="/nowhere/landing.lock" \
        bash "$0" --detect landing 2>/dev/null | grep -oE 'LANDING_LOCK_VERDICT=[A-Z]+' | tail -1)"
  st_assert "an INHERITED marker pointing at no real lock reports BYPASSED" "$out" "LANDING_LOCK_VERDICT=BYPASSED"

  # ── 12. MUST-RELEASE ON INTERRUPT, PROMPTLY.
  #
  # bash does not run a trap while a FOREGROUND command executes — it defers until that command
  # returns, so a naive `"$@"` holds the lock for the command's whole duration after a signal.
  # Measured on `-- sleep 30`: 30 seconds. Fixed by backgrounding the command and `wait`ing.
  #
  # THIS CASE SIGNALS WITH **SIGTERM, NOT SIGINT**, and the reason is a portability fact worth
  # recording rather than a convenience: a shell can only launch this fixture as a BACKGROUND
  # job, and POSIX requires a background job to start with SIGINT set to SIG_IGN — a disposition
  # a shell cannot trap or reset once inherited. So a SIGINT fixture written here would measure
  # the harness, not the handler. Measured 2026-08-20 on this exact file: backgrounded + SIGINT
  # released after 3000 ms (deferred, untrappable), backgrounded + SIGTERM after 100 ms. Both
  # signals run the SAME handler. SIGINT is asserted where it can be: tests/unit/with-lock.test.ts
  # spawns via node, which gives the child default signal dispositions.
  mkdir -p "$root/i"
  ALGOVAULT_LOCK_DIR="$root/i" bash "$0" t8 -- sleep 10 >/dev/null 2>&1 &
  local sig_pid=$! waited=0
  while [ ! -d "$root/i/t8.lock" ] && [ "$waited" -lt 50 ]; do sleep 0.1; waited=$((waited + 1)); done
  st_assert "the interrupt fixture actually acquired the lock" "$( [ -d "$root/i/t8.lock" ] && echo present || echo absent )" "present"
  kill -TERM "$sig_pid" 2>/dev/null
  waited=0
  while [ -d "$root/i/t8.lock" ] && [ "$waited" -lt 30 ]; do sleep 0.1; waited=$((waited + 1)); done
  wait "$sig_pid" 2>/dev/null || true
  st_assert "a signal releases the lock PROMPTLY (<3s, not the command's full duration)" \
    "$( [ "$waited" -lt 30 ] && echo prompt || echo deferred )" "prompt"

  # ── VACUITY GUARD — WE construct this corpus, so an empty one means the test built nothing.
  # That is a defect in the test and must REFUSE, never report a pass.
  local total=$((pass + fail))
  if [ "$total" -lt 20 ]; then
    printf '%s\n' "✖ self-test: only $total assertions ran — the fixture corpus is vacuous, REFUSING."
    algovault_lock__emit INDETERMINATE
    return 3
  fi

  printf '%s\n' "SELF-TEST: $pass passed, $fail failed ($total assertions; 6 must-acquire/reclaim, 2 must-block/timeout, 3 must-detect, 5 must-map)"
  if [ "$fail" -gt 0 ]; then
    printf '%s\n' "SELF-TEST: FAIL ($fail)"
    algovault_lock__emit INDETERMINATE
    return 3
  fi
  algovault_lock__emit ACQUIRED
  return 0
}

# ── dual-mode dispatch (mirrors scripts/lib/alloc-port.sh) ──────────────────────────────────
# Sourced: define the functions and return. Executed: run main.
if (return 0 2>/dev/null); then
  :
else
  algovault_lock__main "$@"
  exit $?
fi
