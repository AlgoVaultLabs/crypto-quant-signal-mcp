#!/usr/bin/env bash
# ch3-count-untracked-node-modules.sh — OPS-WORKTREE-WORK-PENDING-W1 CH3
#
# Counts worktrees in which `node_modules` is STILL reported untracked, and prints that count
# — and nothing else — on stdout, because the CH3 gate captures it as an integer.
#
# ── MEASURED INSIDE WORKTREES, NOT THE PRIMARY (R3.4) ────────────────────────
#
# The bug is a worktree phenomenon. A primary checkout has a real `node_modules` DIRECTORY,
# which the old `node_modules/` pattern already ignored, so a primary-only check proves
# nothing about what CH3 changed. Measured 2026-08-20 across 47 signal-MCP worktrees: 42 hold
# a real directory, 2 hold a SYMLINK, 2 hold neither.
#
# The pattern is ANCHORED (`^node_modules$` after the status prefix). Unanchored, it would
# also match a modified `scripts/check-node_modules.mjs` and report a fix that had not
# happened.
#
# ── SCOPE, AND THE RESIDUAL THIS CANNOT FIX (D3) ─────────────────────────────
#
# `.gitignore` is a TRACKED FILE, so every worktree carries its own checkout of it at its own
# commit. CH3's commit therefore reaches:
#
#   * every worktree created from here on,      and
#   * every existing worktree once it rebases,
#
# and it reaches NO worktree that stays on an older base. Measured 2026-08-20, the two
# worktrees actually holding a node_modules symlink are 877 and 790 commits behind
# origin/main, so this fix cannot reach them and no commit could. Rebasing them is not this
# wave's to do: one carries unlanded work, and both belong to other waves.
#
# So the count is taken over worktrees whose checkout CARRIES THE FIX, and every worktree
# that does not is REPORTED on stderr by name and by distance from origin/main. That is the
# same shape as this estate's gate-staleness precedent: a fix to origin/main cannot reach a
# worktree until it rebases, and the honest gate measures what it changed while naming what
# it did not.
#
# A silently-narrowed denominator would read as "covered everything"; this one is printed.
#
#   exit 0  the scan completed (the COUNT is the finding, on stdout)
#   exit 3  the scan could not complete — the gate treats a non-zero exit as INDETERMINATE
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${WORK_PENDING_CONFIG:-$SELF_DIR/../ops/worktree-noise-config.json}"
FIXED_PATTERN='^node_modules$'
OLD_PATTERN='^node_modules/$'

# ── --self-test: the falsifiable core of this whole chapter ──────────────────
#
# The live set diff before/after CH3's commit is EMPTY by construction — the only worktree
# that picks the fix up in this wave holds a real directory, which the old pattern already
# ignored. An empty diff proves nothing on its own, so the claim that the one-character
# change actually does something is proven HERE, against real git, on both forms.
if [ "${1:-}" = "--self-test" ]; then
  pass=0; fail=0
  chk() { if [ "$2" = "$3" ]; then pass=$(( pass + 1 )); echo "  ok   $1"
          else fail=$(( fail + 1 )); echo "  FAIL $1 — got '$2' want '$3'"; fi; }
  T="$(mktemp -d "${TMPDIR:-/tmp}/ch3-selftest.XXXXXX")" || { echo "CH3_COUNT_VERDICT=INDETERMINATE"; exit 3; }
  trap 'rm -rf "$T"' EXIT
  for form in slash noslash; do
    d="$T/$form"; mkdir -p "$d"
    git -C "$d" init -q --initial-branch=main >/dev/null 2>&1
    git -C "$d" config core.hooksPath /dev/null
    if [ "$form" = "slash" ]; then printf 'node_modules/\n' > "$d/.gitignore"
    else printf 'node_modules\n' > "$d/.gitignore"; fi
    ln -s /tmp "$d/node_modules"                 # the live shape: a SYMLINK, stored as a blob
    mkdir -p "$d/real-dir-case"; : > "$d/real-dir-case/.keep"
    n=$(git -C "$d" status --porcelain=v1 -uall 2>/dev/null | grep -cE '^\?\? node_modules$' || true)
    if [ "$form" = "slash" ]; then
      chk "gitignore 'node_modules/' does NOT ignore a symlink (the bug)" "$n" "1"
    else
      chk "gitignore 'node_modules' DOES ignore a symlink (the fix)"     "$n" "0"
    fi
  done
  # And the fix must not stop ignoring the ordinary case it already handled.
  d="$T/dircase"; mkdir -p "$d/node_modules"
  git -C "$d" init -q --initial-branch=main >/dev/null 2>&1
  git -C "$d" config core.hooksPath /dev/null
  printf 'node_modules\n' > "$d/.gitignore"
  : > "$d/node_modules/pkg.js"
  chk "the fix still ignores a real node_modules DIRECTORY" \
      "$(git -C "$d" status --porcelain=v1 -uall 2>/dev/null | grep -c 'node_modules' || true)" "0"
  # The anchor: an unanchored grep would count a file whose NAME merely contains the pattern.
  d="$T/anchor"; mkdir -p "$d/scripts"
  git -C "$d" init -q --initial-branch=main >/dev/null 2>&1
  git -C "$d" config core.hooksPath /dev/null
  printf 'node_modules\n' > "$d/.gitignore"
  : > "$d/scripts/check-node_modules.mjs"
  chk "the ANCHOR excludes scripts/check-node_modules.mjs" \
      "$(git -C "$d" status --porcelain=v1 -uall 2>/dev/null | grep -cE '^\?\? node_modules$' || true)" "0"
  echo "[ch3-count] --self-test: $pass passed, $fail failed"
  [ "$pass" -eq 0 ] && { echo "CH3_COUNT_VERDICT=INDETERMINATE"; exit 3; }
  [ "$fail" -ne 0 ] && { echo "CH3_COUNT_VERDICT=FAIL"; exit 1; }
  echo "CH3_COUNT_VERDICT=PASS"; exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "[ch3-count] jq absent" >&2; exit 3; }
[ -r "$CONFIG" ]                || { echo "[ch3-count] manifest unreadable: $CONFIG" >&2; exit 3; }

repos="$(jq -r '(.repos // [])[]' "$CONFIG" 2>/dev/null)"
[ -n "$repos" ] || { echo "[ch3-count] manifest declares no repos" >&2; exit 3; }

count=0; scanned=0; residual=0; material=0
residual_report=""
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "[ch3-count] unreachable repo: $repo" >&2; exit 3; }
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    [ -d "$w" ] || continue
    # Does THIS worktree's checkout carry the fix? A repo that never had a node_modules line
    # at all (the two Python repos) has nothing to carry and nothing to be stale about, so it
    # counts as in-scope: there is no pattern here that can fail to match a symlink.
    if grep -qE "$OLD_PATTERN" "$w/.gitignore" 2>/dev/null; then
      residual=$(( residual + 1 ))
      # Split the residual by whether being stale COSTS anything here. A stale worktree
      # holding a real node_modules DIRECTORY is already ignored by the old pattern, so the
      # fix would change nothing for it; only a worktree actually reporting an untracked
      # node_modules is materially unfixed. Reporting 46 undifferentiated rows would bury
      # the two that matter, and a report nobody can read is the same as no report.
      if [ "$(git -C "$w" status --porcelain=v1 -uall 2>/dev/null | sed 's/^...//' | grep -cE "$FIXED_PATTERN" || true)" -gt 0 ] 2>/dev/null; then
        material=$(( material + 1 ))
        behind="$(git -C "$w" rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
        residual_report="$residual_report  UNFIXED  $w
             branch $(git -C "$w" rev-parse --abbrev-ref HEAD 2>/dev/null), ${behind} commits behind origin/main — still reports an untracked node_modules
"
      fi
      continue
    fi
    scanned=$(( scanned + 1 ))
    n="$(git -C "$w" status --porcelain=v1 -uall 2>/dev/null | sed 's/^...//' | grep -cE "$FIXED_PATTERN" || true)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null && count=$(( count + 1 ))
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
done <<EOF
$repos
EOF

# VACUITY: scanning nothing is not a clean estate. Refuse rather than print a green 0.
if [ "$scanned" -eq 0 ]; then
  echo "[ch3-count] scanned ZERO worktrees carrying the fix — refusing to report 0 as clean" >&2
  exit 3
fi

{
  echo "[ch3-count] scanned $scanned worktree(s) carrying the fixed pattern; $count still report an untracked node_modules"
  if [ "$residual" -ne 0 ]; then
    echo "[ch3-count] $residual worktree(s) NOT reached by this commit — .gitignore is a TRACKED file, so each"
    echo "[ch3-count] checkout carries its own copy and picks the fix up only when it rebases."
    echo "[ch3-count]   of those, $material are MATERIALLY unfixed (actually reporting an untracked node_modules)"
    echo "[ch3-count]   the other $(( residual - material )) hold a real node_modules DIRECTORY or none, which the OLD"
    echo "[ch3-count]   pattern already ignored — staleness costs them nothing."
    if [ "$material" -ne 0 ]; then
      printf '%s' "$residual_report"
      echo "[ch3-count] owner: whichever wave next touches those branches, or OPS-WORKTREE-STALE-BASE-REBASE-W{NEXT}."
      echo "[ch3-count] NOT rebased here: they are other waves' branches and one carries unlanded work."
    fi
  fi
} >&2

echo "$count"
exit 0
