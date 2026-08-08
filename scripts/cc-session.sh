#!/usr/bin/env bash
# cc-session.sh — per-session git-worktree isolation for parallel Claude Code sessions.
# Part of CC-PARALLEL-SESSION-ISOLATION-W1. See docs/RUNBOOK-PARALLEL-SESSIONS.md.
#
#   new <task> [--base <ref>]
#                   create/launch an isolated worktree session, based on a FRESHLY FETCHED
#                   remote default branch (native `claude -w` if available, else a
#                   `git worktree add` fallback). --base overrides the default and forces
#                   the fallback path, because `claude --worktree` takes no base ref.
#   list            show every worktree: path, branch, ahead/behind, dirty, assigned port,
#                   and GUARDS — how many registered pre-push/pre-commit gate scripts are
#                   actually present in that checkout (read-only projection of
#                   ops/shared-worktree-state.json; see OPS-SHARED-WORKTREE-STATE-REGISTRY-W1)
#   clean [--force] safely reclaim merged+clean+pushed worktrees (DRY-RUN unless --force)
#   port <task>     print the deterministic port a task would use (used by the SessionStart hook)
#
# Each worktree has its OWN index + working tree, so cross-session `git add` capture and
# `reset --hard` wipes are structurally impossible. Deps + port are provisioned by the
# SessionStart hook (scripts/cc-session-bootstrap.sh).
#
# Portable to macOS bash 3.2: no associative/empty arrays under `set -u`, no `realpath`.
set -euo pipefail

# --- config ---
PORT_BASE=3100                 # avoids server 3000 / facilitator 4022 / landing 5500
PORT_RANGE=400                 # candidate window 3100..3499
WT_SUBDIR=".claude/worktrees"  # native `claude -w` location; fallback mirrors it

# --- helpers ---
die() { echo "cc-session: $*" >&2; exit 1; }

repo_root() { git rev-parse --show-toplevel 2>/dev/null; }

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9._-'
}

port_in_use() {
  local p="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w1 127.0.0.1 "$p" >/dev/null 2>&1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1   # cannot check → assume free
  fi
}

# deterministic base port from task name, bumped past any in-use port
alloc_port() {
  local task="$1" h p tries=0
  h=$(printf '%s' "$task" | cksum | awk '{print $1}')
  p=$(( PORT_BASE + (h % PORT_RANGE) ))
  while port_in_use "$p"; do
    p=$(( p + 1 ))
    [ "$p" -ge $(( PORT_BASE + PORT_RANGE )) ] && p="$PORT_BASE"
    tries=$(( tries + 1 ))
    [ "$tries" -ge 50 ] && break
  done
  printf '%s\n' "$p"
}

# true (0) iff $1 is the MAIN checkout (its git-dir == the shared common-dir)
is_main_worktree() {
  local p="$1" gd gcd
  gd=$(git -C "$p" rev-parse --absolute-git-dir 2>/dev/null) || return 0
  gcd=$(cd "$p" && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || return 0
  [ "$gd" = "$gcd" ]
}

# true (0) iff $1 is the worktree the CALLER is standing in.
#
# `clean` used to be protected from this by accident: its `merged` leg tested against
# LOCAL `main`, which lags origin/main, so a session's own fresh worktree was almost
# always refused as "unmerged". Fixing that leg to ask the correct question (is the work
# on origin/main?) removes the accident — a session that commits, pushes, and then runs
# `clean --force` would delete the directory it is running from, mid-session. Measured
# 2026-08-08: the worktree executing this very wave appeared in its own WOULD-REMOVE list.
#
# The fix belongs here, not in the landed-predicate: "is this work safe to lose" and "is
# someone standing here" are different questions, and the second was never asked at all.
# `pwd -P` on both sides because /Users/tank and /private/... resolve to the same tree.
# [OPS-UNPUSHED-WORK-TRIAGE-W1]
is_caller_worktree() {
  local p="$1" pp cwd
  pp=$(cd "$p" 2>/dev/null && pwd -P) || return 1
  cwd=$(pwd -P) || return 1
  case "$cwd" in "$pp"|"$pp"/*) return 0 ;; esac
  return 1
}

native_worktree_supported() {
  claude --help 2>/dev/null | grep -q -- '--worktree'
}

# Remote default branch as a ref name (e.g. `origin/main`). Resolved, never hardcoded —
# `main` is this repo's default today, but that is not a property of the script.
default_base_ref() {
  local sym
  sym=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null) || sym=""
  if [ -n "$sym" ]; then
    printf '%s\n' "${sym#refs/remotes/}"
  elif git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    printf 'origin/main\n'   # symbolic-ref is set by `git clone` but not by `git remote add`
  else
    printf '\n'              # unresolvable — caller must require an explicit --base
  fi
}

# Fetch so the base ref is CURRENT, but never block session creation on the network.
#
# WHY THIS IS THE ACTUAL FIX (OPS-CC-SESSION-BASE-REF-W1). `cmd_new` execs to
# `claude --worktree`, which bases the new worktree on the LOCAL `refs/remotes/origin/<default>`
# ref — measured: 150 of 160 branches in this repo reflog "Created from origin/main". That ref
# is only as fresh as the last fetch, so without this a session started after a quiet period
# silently begins behind.
#
# ⚠️ The older claim that `cc-session.sh` makes every session branch off local `HEAD` was FALSE
# for the path that actually runs: the bare `git worktree add` below is a FALLBACK, reached only
# when `claude -w` is unavailable. It is still given an explicit base (correctness for those
# installs), but the missing fetch — not a missing base ref — was the real staleness source.
fetch_or_warn() {
  local base="$1" tip dist
  git fetch origin --quiet 2>/dev/null && return 0
  tip=$(git log -1 --format=%cr "$base" 2>/dev/null || echo 'unknown')
  dist=$(git rev-list --count "HEAD..$base" 2>/dev/null || echo '?')
  {
    echo "cc-session: WARNING — git fetch failed; using the CACHED $base."
    echo "cc-session:   cached $base tip is dated $tip, and is $dist commit(s) ahead of local HEAD."
    echo "cc-session:   Proceeding: a slightly-stale $base still beats branching off local HEAD,"
    echo "cc-session:   and refusing to create a session because the network is down is worse."
  } >&2
  return 0
}

# --- subcommands ---
cmd_new() {
  local root task wt branch port f base="" explicit_base=0 positional=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --base)   [ $# -ge 2 ] || die "--base requires a ref"; base="$2"; explicit_base=1; shift 2 ;;
      --base=*) base="${1#--base=}"; explicit_base=1; shift ;;
      -*)       die "unknown flag: $1 (usage: cc-session.sh new <task> [--base <ref>])" ;;
      *)        [ -z "$positional" ] || die "usage: cc-session.sh new <task> [--base <ref>]"
                positional="$1"; shift ;;
    esac
  done
  [ -n "$positional" ] || die "usage: cc-session.sh new <task> [--base <ref>]"
  root=$(repo_root) || die "not in a git repository"
  task=$(slugify "$positional"); [ -n "$task" ] || die "empty task name after slugify"
  cd "$root"

  if [ "$explicit_base" -eq 0 ]; then
    base=$(default_base_ref)
    [ -n "$base" ] || die "cannot resolve the remote default branch (refs/remotes/origin/HEAD is unset and origin/main does not exist) — pass --base <ref>"
  fi
  fetch_or_warn "$base"

  # Validate BEFORE creating anything, so a typo cannot leave a half-made worktree behind.
  git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1 \
    || die "base '$base' is not a resolvable commit-ish — nothing was created"

  # `claude --worktree` takes no base argument, so an explicit --base cannot be expressed on the
  # native path. Rather than accept the flag and silently ignore it, --base FORCES the manual
  # path. A flag that quietly does nothing is worse than no flag.
  if native_worktree_supported; then
    if [ "$explicit_base" -eq 0 ]; then
      echo "cc-session: native isolated session → claude --worktree $task (base: $base, freshly fetched)" >&2
      exec claude --worktree "$task"
    fi
    echo "cc-session: --base $base given → using the manual worktree path (claude --worktree accepts no base ref)" >&2
  fi

  # fallback: manual git worktree (older Claude Code without -w, or an explicit --base)
  wt="$WT_SUBDIR/$task"; branch="worktree-$task"
  echo "cc-session: git worktree add $wt -b $branch $base" >&2
  git worktree add "$wt" -b "$branch" "$base"
  for f in .env .env.local; do
    if [ -f "$f" ]; then cp "$f" "$wt/$f"; echo "cc-session: copied $f" >&2; fi
  done
  port=$(alloc_port "$task")
  if ! grep -qs '^PORT=' "$wt/.env.local" 2>/dev/null; then
    printf 'PORT=%s\n' "$port" >> "$wt/.env.local"
    echo "cc-session: assigned PORT=$port → $wt/.env.local" >&2
  fi
  ( cd "$wt" && { [ -d node_modules ] || npm ci; } )
  echo "cc-session: launching claude in $wt" >&2
  ( cd "$wt" && exec claude )
}

# Read-only projection of ops/shared-worktree-state.json: one registered gate-script path per
# line. OPS-SHARED-WORKTREE-STATE-REGISTRY-W1 — worktrees isolate the git index and nothing
# else, so a checkout can silently lack a guard the shared hook still invokes; `list` should
# say so. FAILS SOFT by design (prints nothing): this is a convenience view, and it must never
# break because the registry is absent, unparseable, or node is missing.
shared_state_scripts() {
  local root reg
  root=$(repo_root) || return 0
  reg="$root/ops/shared-worktree-state.json"
  [ -r "$reg" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    try {
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const s = new Set((j.resources || []).filter((r) => r.kind === "hook-block" && r.script).map((r) => r.script));
      for (const x of s) console.log(x);
    } catch {}
  ' "$reg" 2>/dev/null || true
}

list_row() {
  local path="$1" branch="$2" base ab dirty port guards="-" have=0 total=0 s
  if git -C "$path" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    base='@{upstream}'
  else
    base='main'
  fi
  ab=$(git -C "$path" rev-list --left-right --count "$base"...HEAD 2>/dev/null | awk '{print $2"/"$1}' || true)
  [ -n "$ab" ] || ab="0/0"
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then dirty="Y"; else dirty="N"; fi
  port=$(grep -hs '^PORT=' "$path/.env.local" 2>/dev/null | head -1 | cut -d= -f2 || true)
  [ -n "$port" ] || port="-"
  if [ -n "${SHARED_STATE_SCRIPTS:-}" ]; then
    while IFS= read -r s; do
      [ -n "$s" ] || continue
      total=$(( total + 1 ))
      if [ -f "$path/$s" ]; then have=$(( have + 1 )); fi
    done <<EOF
$SHARED_STATE_SCRIPTS
EOF
    if [ "$total" -gt 0 ]; then guards="$have/$total"; fi
  fi
  printf '%-46s %-26s %-9s %-5s %-6s %-7s\n' "$path" "$branch" "$ab" "$dirty" "$port" "$guards"
}

cmd_list() {
  local root path branch
  root=$(repo_root) || die "not in a git repository"
  # Resolved ONCE, not per row — 75 checkouts is a realistic count on this machine.
  SHARED_STATE_SCRIPTS="$(shared_state_scripts)"
  printf '%-46s %-26s %-9s %-5s %-6s %-7s\n' "WORKTREE" "BRANCH" "AHEAD/BEH" "DIRTY" "PORT" "GUARDS"
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ *)   branch="${line#branch refs/heads/}"; list_row "$path" "$branch" ;;
      detached)    list_row "$path" "(detached)" ;;
    esac
  done < <(git -C "$root" worktree list --porcelain)
}

clean_consider() {
  local root="$1" path="$2" branch="$3" force="$4" reasons="" landed
  is_main_worktree "$path" && return 1     # never the main checkout
  if is_caller_worktree "$path"; then      # never the directory we are standing in
    echo "KEEP          $path ($branch) — self (the worktree this command is running from)"
    return 1
  fi
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then reasons="$reasons dirty"; fi
  # ONE derivation of "has this worktree's work landed?", consumed here AND by the
  # unpushed-work detector. It replaces TWO separate wrong answers to that same question:
  #
  #   1. `merge-base --is-ancestor HEAD main` — against **local** `main`, which lags
  #      origin/main on this machine routinely. Refuses a worktree whose work is
  #      demonstrably on the shared remote.
  #   2. `git rev-list '@{upstream}'..HEAD`   — distance from the branch's OWN REMOTE
  #      TRACKING REF, stale on any branch whose work landed by a squash/rebase merge.
  #      Not a measure of unique work at all.
  #
  # MEASURED 2026-08-07: (2) reported 30 commits "at risk" across 7 worktrees when the
  # true figure in those 7 was ZERO — every HEAD was already an ancestor of origin/main —
  # while 9 genuinely-unique commits sat in 5 OTHER worktrees it never reached.
  #
  # Both legs asked "has this work landed", answered differently, and were wrong in
  # different ways; keeping two would drift again in whichever one nobody was watching.
  # STRICTLY SAFER than either, not a relaxation — "every commit is on origin/main" is
  # the strongest safety statement available and dominates local `main` in BOTH
  # directions (lagging, AND ahead-with-unpushed-commits-on-main). UNKNOWN is treated as
  # unsafe, so an undeterminable worktree is never reclaimed. Both reason tokens are
  # still emitted, so operator-facing output keeps its shape.
  # [OPS-UNPUSHED-WORK-TRIAGE-W1]
  landed="$(bash "$root/scripts/lib/branch-work-landed.sh" "$path" 2>/dev/null || echo 'UNKNOWN predicate-failed')"
  case "$landed" in
    LANDED\ *) : ;;                                                    # all on origin/main
    UNIQUE\ *) reasons="$reasons unmerged unpushed(${landed#UNIQUE })" ;;
    *)         reasons="$reasons unmerged unpushed(unverifiable)" ;;   # fail-safe
  esac
  if [ -z "$reasons" ]; then
    if [ "$force" -eq 1 ]; then
      git -C "$root" worktree remove "$path" && echo "REMOVED       $path ($branch)"
    else
      echo "WOULD-REMOVE  $path ($branch)"
    fi
    return 0
  fi
  echo "KEEP          $path ($branch) —$reasons"
  return 1
}

cmd_clean() {
  local force=0 root path branch removed=0
  [ "${1:-}" = "--force" ] && force=1
  root=$(repo_root) || die "not in a git repository"
  echo "cc-session clean: $([ $force -eq 1 ] && echo APPLY || echo 'DRY-RUN (use --force to apply)')"
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ *)
        branch="${line#branch refs/heads/}"
        if clean_consider "$root" "$path" "$branch" "$force"; then removed=$(( removed + 1 )); fi
        ;;
    esac
  done < <(git -C "$root" worktree list --porcelain)
  if [ "$force" -eq 1 ]; then
    git -C "$root" worktree prune
    echo "cc-session clean: pruned admin entries; removed $removed worktree(s)."
  fi
}

cmd_port() {
  [ $# -ge 1 ] || die "usage: cc-session.sh port <task>"
  alloc_port "$(slugify "$1")"
}

usage() {
  cat >&2 <<'EOF'
cc-session.sh — per-session git-worktree isolation for parallel Claude Code sessions
  cc-session.sh new <task> [--base <ref>]
                                 create/launch an isolated worktree session (fetches first,
                                 bases off the remote default; --base forces the fallback)
  cc-session.sh list             list worktrees (path, branch, ahead/behind, dirty, port)
  cc-session.sh clean [--force]  reclaim merged+clean+pushed worktrees (DRY-RUN default)
  cc-session.sh port <task>      print the deterministic port for a task
See docs/RUNBOOK-PARALLEL-SESSIONS.md
EOF
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    new)   cmd_new "$@" ;;
    list)  cmd_list "$@" ;;
    clean) cmd_clean "$@" ;;
    port)  cmd_port "$@" ;;
    ''|-h|--help|help) usage ;;
    *) die "unknown command: $cmd (try --help)" ;;
  esac
}

main "$@"
