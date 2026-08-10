#!/usr/bin/env bash
# cc-session.sh — per-session git-worktree isolation for parallel Claude Code sessions.
# Part of CC-PARALLEL-SESSION-ISOLATION-W1. See docs/RUNBOOK-PARALLEL-SESSIONS.md.
#
#   new <task> [--base <ref>]
#                   create/launch an isolated worktree session at the DECLARED destination
#                   <worktree_roots.worktree_root>/<repo>/<task>, based on a FRESHLY FETCHED
#                   remote default branch. --base overrides the default branch.
#                   BEHAVIOUR CHANGE (OPS-WORKTREE-CREATE-HOOK-W1 R3c): `claude -w` IS used
#                   again on the default path. W2 R3a had banned it because it takes a NAME
#                   and no destination, so placement could not be expressed through it — that
#                   reason is now RETIRED: the `WorktreeCreate` hook owns placement at
#                   creation time, so `claude -w <task>` lands at the declared destination
#                   without this script computing one. Placement moved from a per-worktree
#                   script (which goes stale per checkout) to one file outside every repo.
#                   `--base` STILL forces the manual path: an explicit base ref cannot be
#                   expressed through `claude --worktree`, and a flag that quietly does
#                   nothing is worse than no flag.
#                   ALGOVAULT_WORKTREE_ROOT overrides the root for a deliberate off-root
#                   session; on the manual path it is validated before anything is created,
#                   and on the hook path the hook reads the same variable.
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
# PORT_BASE/PORT_RANGE removed by OPS-WORKTREE-HOOK-PORT-PARITY-W1 R2b: the window belongs to
# the ONE derivation in scripts/lib/alloc-port.sh, which the WorktreeCreate hook also calls.
# Two copies of the window is how the hook ended up allocating from the same range with a
# different hash input — see that file's header for the measured divergence.
# WT_SUBDIR removed by OPS-WORKTREE-ROOT-CONFINEMENT-W2 R3a: it placed worktrees INSIDE the
# repo, which is the nesting shape behind the vitest-discovery pathology (1779 discovered
# test files vs 298 real). Placement now comes from worktree_roots.worktree_root in the SoT.

# Where THIS script lives. `clean` iterates every primary on the machine
# (OPS-WORKTREE-ROOT-CONFINEMENT-W2 R2c/F2), and the other primaries — algovault-bot,
# autonomous-optimizer, ~/git/* — do not contain scripts/lib/. Resolving a helper from the
# ITERATED repo would make every non-cqsm worktree report `unpushed(unverifiable)`: fail-safe,
# but it would refuse the whole fleet and read as a broken tool. The script knows where its
# own lib is; the repo being examined does not.
CC_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# --- helpers ---
die() { echo "cc-session: $*" >&2; exit 1; }

repo_root() { git rev-parse --show-toplevel 2>/dev/null; }

# Absolute path to the ONE shared-state SoT, resolved from this script, not from $PWD.
shared_state_file() { printf '%s\n' "$CC_SELF_DIR/../ops/shared-worktree-state.json"; }

# --- OPS-WORKTREE-ROOT-CONFINEMENT-W2 R2c: exemptions + locks ------------------------------
#
# `clean` reclaimed on dirty/unmerged/unpushed alone. None of those sees a worktree holding a
# gitignored local-only DATASET: measured, 10 worktrees carry ~1.63 GB of research data, and
# every one is merged+clean+pushed or one `git commit` from it — i.e. indistinguishable from
# garbage to the predicate. Two independent protections are consulted here, and BOTH are
# declared rather than inferred:
#
#   exempt_paths  — the SoT row, which survives an unlock and states WHY on the row
#   worktree lock — git's own mechanism, which is what actually refuses `worktree remove`
#
# Neither subsumes the other: a lock with no row is undocumented, and a row with no lock is
# only as strong as the code that reads it. `clean` honours either.
CC_EXEMPT_JSON=""
collect_exemptions() {
  local f; f="$(shared_state_file)"
  CC_EXEMPT_JSON=""
  [ -r "$f" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  # path<TAB>reason, one per line. Fails soft: an unreadable SoT must not break `list`.
  CC_EXEMPT_JSON="$(node -e '
    try {
      const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      for (const e of ((j.worktree_roots||{}).exempt_paths)||[]) {
        if (typeof e.path === "string" && e.path.startsWith("/"))
          console.log(e.path + "\t" + (e.reason||"declared exemption").slice(0,90));
      }
    } catch {}
  ' "$f" 2>/dev/null || true)"
}

# Locked worktree paths for ONE primary. `locked` follows `branch` in --porcelain, so the
# streaming loop cannot see it at dispatch time; collect the set up front instead.
CC_LOCKED_PATHS=""
collect_locked_paths() {
  local root="$1" line cur=""
  CC_LOCKED_PATHS=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) cur="${line#worktree }" ;;
      locked*)     [ -n "$cur" ] && CC_LOCKED_PATHS="$CC_LOCKED_PATHS$cur
" ;;
    esac
  done < <(git -C "$root" worktree list --porcelain 2>/dev/null)
}

# Echo the exemption reason for $1 and return 0; return 1 if not protected.
worktree_exempt_reason() {
  local p="$1" line
  case "$CC_LOCKED_PATHS" in
    *"$p"$'\n'*) echo "locked (git worktree lock — remove refuses it)"; return 0 ;;
  esac
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      "$p"$'\t'*) echo "exempt: ${line#*$'\t'}"; return 0 ;;
    esac
  done <<EOF
$CC_EXEMPT_JSON
EOF
  return 1
}

# Every primary on this machine, discovered STRUCTURALLY (.git as a DIRECTORY), never by name.
# The network-backed Drive mounts are pruned by path: traversing them cost a measured 120 s.
discover_primaries() {
  find "$HOME" \
    -path "$HOME/Library" -prune -o \
    -path "$HOME/My Drive" -prune -o \
    -path "$HOME/Google Drive" -prune -o \
    -path "$HOME/.Trash" -prune -o \
    -path "$HOME/.cache" -prune -o \
    -name node_modules -prune -o \
    -maxdepth 4 -name .git -type d -print 2>/dev/null \
  | sed 's|/\.git$||' | sort -u || true
  # `|| true`: find exits non-zero on any unreadable directory, and under `set -o pipefail`
  # that killed the whole command substitution — the sweep printed its header and then
  # silently stopped, which is the failure mode this chapter exists to remove.
}

# Declared worktree root, read from the ONE SoT. No default and no fallback: an undeclared
# root is the emergent-placement state this wave exists to retire, so it must fail, not guess.
worktree_root_from_sot() {
  local f out; f="$(shared_state_file)"
  [ -r "$f" ] || die "cannot read $f — placement is declared there and has no default"
  command -v node >/dev/null 2>&1 || die "node is required to read the declared worktree root"
  out="$(node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const r=(j.worktree_roots||{}).worktree_root;
    if (typeof r !== "string" || !r.startsWith("/")) process.exit(2);
    console.log(r);
  ' "$f" 2>/dev/null)" || die "ops/shared-worktree-state.json declares no absolute worktree_roots.worktree_root"
  printf '%s\n' "$out"
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9._-'
}

# Deterministic base port from task name, bumped past any in-use port.
#
# DELEGATED, not implemented here (OPS-WORKTREE-HOOK-PORT-PARITY-W1 R2b). The
# `WorktreeCreate` hook needs the same answer, and it had a second implementation that hashed
# the DESTINATION PATH instead of the task — so `cc-session.sh port <task>`, documented below
# as "the deterministic port a task would use" and called by the SessionStart bootstrap, could
# not reproduce a port the hook wrote. One derivation, in scripts/lib/alloc-port.sh.
#
# Resolved from CC_SELF_DIR for the reason stated there: `clean` iterates primaries that have
# no scripts/lib/ at all, and this script knows where its own lib is.
alloc_port() {
  bash "$CC_SELF_DIR/lib/alloc-port.sh" "$1"
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

# ── LIVENESS ──────────────────────────────────────────────────────────────────
#
# `clean` decides whether work is safe to LOSE. That says nothing about whether someone
# is WORKING here, and until 2026-08-08 nothing asked. The old `merged` leg tested against
# local `main` (which lags) and so refused fresh worktrees by accident; correcting it
# removed that accidental shield, so the question now has to be asked on purpose.
#
# TWO signals, because MEASURED 2026-08-08 neither is sufficient alone:
#
#   A. a live process whose cwd is at/under the worktree — a hard fact, never overridable.
#   B. working-tree content modified inside a recency window.
#
# (B) is LOAD-BEARING, not belt-and-braces. Measured: `closedbar-directional-balance` had
# been touched 54 MINUTES earlier and had ZERO processes holding cwd there — an idle
# session between turns leaves no process footprint at all. Signal (A) alone would have
# deleted it.
#
# The window is asymmetric ON PURPOSE and the asymmetry is the whole argument: a false
# "in use" costs a deferred reclaim (cheap, self-heals on the next run), a false "free"
# destroys live work. It is NOT tuned to make any particular set reclaimable.
#
# Deliberately NOT used: the git index mtime. It looked ideal, but `clean_consider` runs
# `git status` on every worktree, so a self-poisoned instrument was the obvious risk.
# Probed rather than assumed — `git status --porcelain` left the index mtime byte-identical,
# so it would in fact have been safe. It is still not used, because it only proves someone
# ran a git command, while (B) proves the tree itself changed. Recording the probe so the
# next reader does not repeat it. [OPS-UNPUSHED-WORK-TRIAGE-W1]

CC_LIVE_CWDS=""      # newline-delimited "<pid> <cmd> <cwd>", enumerated ONCE per run
CC_LIVE_CWDS_OK=0    # 1 iff enumeration actually succeeded

# Enumerate every process cwd on the box, once. 451 entries took <1s when measured.
collect_live_cwds() {
  command -v lsof >/dev/null 2>&1 || { CC_LIVE_CWDS_OK=0; return; }
  CC_LIVE_CWDS=$(lsof -d cwd -F pcn 2>/dev/null | awk '
    /^p/{pid=substr($0,2)} /^c/{cmd=substr($0,2)}
    /^n\//{print pid, cmd, substr($0,2)}')
  [ -n "$CC_LIVE_CWDS" ] && CC_LIVE_CWDS_OK=1 || CC_LIVE_CWDS_OK=0
}

# echoes a human reason and returns 0 iff $1 looks in use; returns 1 iff provably idle.
worktree_in_use_reason() {
  local p="$1" hours="$2" pp hit
  pp=$(cd "$p" 2>/dev/null && pwd -P) || { echo "in-use(unresolvable-path)"; return 0; }

  # (A) hard signal. Undeterminable => refuse: never delete on an unanswered question.
  if [ "$CC_LIVE_CWDS_OK" -ne 1 ]; then
    echo "in-use(undeterminable: lsof unavailable)"; return 0
  fi
  hit=$(printf '%s\n' "$CC_LIVE_CWDS" | awk -v d="$pp" '
    { c=$3; for (i=4; i<=NF; i++) c = c " " $i
      if (c == d || index(c, d "/") == 1) { print $2; exit } }')
  if [ -n "$hit" ]; then echo "in-use(process: $hit)"; return 0; fi

  # (B) recency. -print -quit short-circuits on the first hit; .git and node_modules
  # excluded (a symlinked node_modules is not matched by find without -L anyway).
  if [ -n "$(find "$pp" -maxdepth 3 -not -path '*/.git/*' -not -path '*/node_modules*' \
              -newermt "-${hours} hours" -print -quit 2>/dev/null)" ]; then
    echo "in-use(touched <${hours}h ago)"; return 0
  fi
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
  local root task wt wt_root branch port f base="" explicit_base=0 positional=""
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

  # ── PLACEMENT IS THE HOOK'S, NOT THIS SCRIPT'S (OPS-WORKTREE-CREATE-HOOK-W1 R3c) ─────────
  #
  # W2 R3a forced the manual path for EVERY session because `claude --worktree` accepts a
  # NAME and no destination, so a declared destination could not be expressed through it.
  # That reason is retired. The `WorktreeCreate` hook now replaces the tool's default
  # placement logic at creation time and reads the SAME SoT this script does, so the native
  # path lands at the declared destination without this script computing one.
  #
  # Why that is strictly better, and the whole point of the wave: this script is
  # PER-WORKTREE and goes stale per checkout (measured 24/43 on the sibling gate), while the
  # hook is ONE file outside every repo and cannot. Placement therefore stops being this
  # script's responsibility rather than being duplicated in two places that can disagree.
  #
  # `--base` STILL forces the manual path below: an explicit base ref cannot be expressed
  # through `claude --worktree`, and a flag that quietly does nothing is worse than no flag.
  if native_worktree_supported && [ "$explicit_base" -eq 0 ]; then
    echo "cc-session: delegating placement to the WorktreeCreate hook (\`claude --worktree $task\`)" >&2
    exec claude --worktree "$task"
  fi
  # ── MANUAL PATH — reached only for --base, or a Claude Code without native -w ────────────
  # Everything below is W2's frozen placement logic, unchanged.
  #
  # Placement used to be whatever the running tool preferred. Measured: ONE primary had FOUR
  # worktree parents, and all three modern placements appeared inside a single ~24h window —
  # it is CWD-derived and tool-version-dependent. A convention that mutable cannot be
  # documented, only declared, so the destination now comes from the SoT and is passed
  # explicitly.
  #
  # W2 R3a's clause here read "an explicit destination FORCES the manual path for every
  # session". That is no longer true and has been corrected rather than left standing: since
  # OPS-WORKTREE-CREATE-HOOK-W1 R3c, only `--base` (or a Claude Code without native `-w`)
  # reaches this path. Everything the native path provided is preserved above this line:
  # `git fetch origin` first, the remote default resolved via symbolic-ref (never hardcoded
  # `main`), and the warn-with-cached-ref-age fail-open when the network is down.
  wt_root="${ALGOVAULT_WORKTREE_ROOT:-$(worktree_root_from_sot)}"
  # Validated BEFORE anything is created, so a bad override cannot leave a half-made worktree.
  case "$wt_root" in
    /*) ;;
    *)  die "worktree root must be an ABSOLUTE path, got '$wt_root' (a relative or ~ root resolves against \$PWD and lands the worktree wherever you happened to stand — the exact failure this declares away)" ;;
  esac
  [ -n "$task" ] || die "empty task after slugify"
  wt="$wt_root/$(basename "$root")/$task"; branch="worktree-$task"
  [ -e "$wt" ] && die "destination already exists: $wt"
  mkdir -p "$(dirname "$wt")" || die "cannot create $(dirname "$wt")"
  # (W2's "NOT using \`claude --worktree\`" notice was here. It is unreachable now — the only
  # condition it announced is exactly the condition that `exec`s above — so it is removed
  # rather than left as dead code that reads like live behaviour.)
  echo "cc-session: git worktree add $wt -b $branch $base" >&2
  git worktree add "$wt" -b "$branch" "$base"
  for f in .env .env.local; do
    if [ -f "$f" ]; then cp "$f" "$wt/$f"; echo "cc-session: copied $f" >&2; fi
  done
  # Fail-soft (R2b): a missing/unrunnable helper must cost the PORT, never the worktree that
  # was just created. `set -e` would otherwise abort here with the worktree already on disk.
  port=$(alloc_port "$task" || true)
  if [ -n "$port" ] && ! grep -qs '^PORT=' "$wt/.env.local" 2>/dev/null; then
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
  local root="$1" path="$2" branch="$3" force="$4" reasons="" landed inuse exempt
  is_main_worktree "$path" && return 1     # never the main checkout — and never a counted row
  # Counted AFTER the main-checkout return, so `considered` means "rows that got a terminal
  # disposition". Counting the main worktree would make considered exceed the printed rows by
  # exactly one per primary, and the subtraction would stop reconciling against its own output.
  CC_CONSIDERED=$(( CC_CONSIDERED + 1 ))
  if is_caller_worktree "$path"; then      # never the directory we are standing in
    echo "KEEP          $path ($branch) — self (the worktree this command is running from)"
    return 1
  fi
  # Someone else may be working here. Asked BEFORE the landed-predicate: "safe to lose"
  # and "in use" are independent questions, and this one is cheaper to answer.
  if inuse=$(worktree_in_use_reason "$path" "$CC_MAX_AGE_HOURS"); then
    CC_HELD_LIVENESS=$(( CC_HELD_LIVENESS + 1 ))
    echo "KEEP          $path ($branch) — $inuse"
    return 1
  fi
  # Declared protection — a gitignored dataset is invisible to every predicate below this
  # line. Asked BEFORE dirty/landed for the same reason liveness is: it is decisive and
  # cheap, and a protected worktree's reclaim-eligibility is not a question worth computing.
  if exempt=$(worktree_exempt_reason "$path"); then
    CC_HELD_EXEMPT=$(( CC_HELD_EXEMPT + 1 ))
    echo "KEEP          $path ($branch) — $exempt"
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
  # Resolved from THIS SCRIPT's lib, not from "$root": `clean` now iterates every primary on
  # the machine, and only this repo carries scripts/lib/.
  landed="$(bash "$CC_SELF_DIR/lib/branch-work-landed.sh" "$path" 2>/dev/null || echo 'UNKNOWN predicate-failed')"
  case "$landed" in
    LANDED\ *) : ;;                                                    # all on origin/main
    UNIQUE\ *) reasons="$reasons unmerged unpushed(${landed#UNIQUE })" ;;
    *)         reasons="$reasons unmerged unpushed(unverifiable)" ;;   # fail-safe
  esac
  if [ -z "$reasons" ]; then
    CC_REMOVABLE=$(( CC_REMOVABLE + 1 ))
    if [ "$force" -eq 1 ]; then
      # EXACTLY ONE terminal disposition per row. The old form was `remove && echo REMOVED`,
      # so a refused remove printed NEITHER `REMOVED` NOR `KEEP` — a silent row, which is the
      # absence-of-alert anti-pattern: indistinguishable from a row that was never considered.
      if git -C "$root" worktree remove "$path" 2>/dev/null; then
        echo "REMOVED       $path ($branch)"
      else
        echo "KEEP          $path ($branch) — REFUSED by git (locked or dirty); nothing was removed"
        return 1
      fi
    else
      echo "WOULD-REMOVE  $path ($branch)"
    fi
    return 0
  fi
  echo "KEEP          $path ($branch) —$reasons"
  return 1
}

cmd_clean() {
  local force=0 root path branch removed=0 this_only=0 primaries P
  CC_HELD_LIVENESS=0; CC_CONSIDERED=0; CC_REMOVABLE=0; CC_HELD_EXEMPT=0
  # Default 24h: a Claude Code session is interactive, so a worktree untouched for a full
  # day is not mid-turn. Raise it to be more cautious, lower it deliberately to reclaim a
  # worktree you KNOW is finished. The window governs signal (B) ONLY — a live process
  # holding cwd is a fact and no flag overrides it.
  CC_MAX_AGE_HOURS=24
  while [ $# -gt 0 ]; do
    case "$1" in
      --force)          force=1 ;;
      --max-age-hours)  shift; CC_MAX_AGE_HOURS="${1:-24}" ;;
      --this-repo-only) this_only=1 ;;   # the pre-W2 single-repo behaviour, kept explicit
      *) die "clean: unknown argument '$1' (expected --force, --max-age-hours N, --this-repo-only)" ;;
    esac
    shift
  done
  case "$CC_MAX_AGE_HOURS" in
    ''|*[!0-9]*) die "clean: --max-age-hours needs a non-negative integer" ;;
  esac
  root=$(repo_root) || die "not in a git repository"
  collect_live_cwds
  collect_exemptions
  echo "cc-session clean: $([ $force -eq 1 ] && echo APPLY || echo 'DRY-RUN (use --force to apply)')"
  echo "  liveness: process-cwd $([ "$CC_LIVE_CWDS_OK" -eq 1 ] && echo "OK ($(printf '%s\n' "$CC_LIVE_CWDS" | grep -c . ) cwds)" || echo 'UNAVAILABLE — refusing all') · recency window ${CC_MAX_AGE_HOURS}h"
  echo "  exemptions: $(printf '%s\n' "$CC_EXEMPT_JSON" | grep -c . ) declared row(s) from $(shared_state_file)"

  # PER PRIMARY, not per repo. `cmd_clean` used to iterate only $(git rev-parse --show-toplevel),
  # so a run from THIS repo could never reach another primary's garbage — it would reclaim one
  # repo's worth and report success. Worse for safety: every exempt payload path is owned by
  # algovault-bot or autonomous-optimizer, so from here they appeared ZERO times and a
  # "no exempt paths seen" result was indistinguishable from "all exempt paths honoured".
  if [ "$this_only" -eq 1 ]; then primaries="$root"; else primaries="$(discover_primaries)"; fi
  [ -n "$primaries" ] || die "clean: discovered no primaries — refusing to report an empty sweep as success"

  while IFS= read -r P; do
    [ -n "$P" ] || continue
    git -C "$P" rev-parse --git-dir >/dev/null 2>&1 || { echo "=== primary $P === UNREACHABLE — FAIL, not skipped"; continue; }
    echo "=== primary $P ==="
    collect_locked_paths "$P"
    CC_CONSIDERED=0; CC_EXEMPT_HELD=0; CC_REMOVABLE=0; CC_HELD_EXEMPT=0
    while IFS= read -r line; do
      case "$line" in
        worktree\ *) path="${line#worktree }" ;;
        branch\ *)
          branch="${line#branch refs/heads/}"
          if clean_consider "$P" "$path" "$branch" "$force"; then removed=$(( removed + 1 )); fi
          ;;
      esac
    done < <(git -C "$P" worktree list --porcelain 2>/dev/null)
    # The subtraction, printed explicitly: an exemption that is never shown is an exemption
    # nobody can audit. considered counts rows REACHED, so it is comparable to the row count.
    echo "  considered=$CC_CONSIDERED exempt=$CC_HELD_EXEMPT removable=$CC_REMOVABLE"
  done <<EOF
$primaries
EOF

  if [ "$CC_HELD_LIVENESS" -gt 0 ]; then
    echo "cc-session clean: $CC_HELD_LIVENESS worktree(s) HELD BY LIVENESS — re-run later, or"
    echo "  --max-age-hours N to narrow the recency window (a live process is never overridable)."
  fi
  if [ "$force" -eq 1 ]; then
    while IFS= read -r P; do
      [ -n "$P" ] || continue
      git -C "$P" worktree prune 2>/dev/null || true
    done <<EOF
$primaries
EOF
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
