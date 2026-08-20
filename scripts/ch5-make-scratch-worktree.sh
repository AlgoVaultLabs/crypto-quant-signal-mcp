#!/usr/bin/env bash
# ch5-make-scratch-worktree.sh — OPS-WORKTREE-WORK-PENDING-W1 CH5
#
# Build (or reuse) a THROWAWAY worktree seeded with exactly one Class-A file, and print its
# path on stdout — and nothing else, because the CH5 gate captures stdout as a path.
#
# WHY THE GATE NEEDS THIS: CH5's gate hashes a worktree before and after preservation and
# asserts they are byte-identical. Running that against a LIVE worktree would mean asserting
# on a tree another session may be editing, so a green would be luck and a red would be
# someone else's. The subject has to be one this script owns outright.
#
# Placement follows the estate's declared destination template rather than /tmp, for two
# reasons: a worktree outside the declared root is an R1-confinement violation the moment it
# exists, and the predicate only enumerates worktrees of DECLARED repos — a /tmp git repo
# would report OUT_OF_SCOPE and the gate would assert on nothing.
#
#   --cleanup   remove the scratch worktree and its branch (safe: this script owns both)
#
# Idempotent: an existing scratch worktree is reused and re-seeded rather than duplicated.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF_DIR/.." && pwd)"
NAME="ch5-preserve-scratch"
DEST="/Users/tank/code/.worktrees/crypto-quant-signal-mcp/$NAME"
SEED="ch5-scratch-stranded-work.sql"

if [ "${1:-}" = "--cleanup" ]; then
  # --force because the tree is deliberately dirty: that is the whole point of the fixture,
  # and every byte in it was written by this script.
  git -C "$REPO" worktree remove --force "$DEST" 2>/dev/null || rm -rf "$DEST"
  git -C "$REPO" branch -D "$NAME" >/dev/null 2>&1 || true
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  echo "[ch5-scratch] removed $DEST" >&2
  exit 0
fi

if [ ! -d "$DEST" ]; then
  git -C "$REPO" worktree add -q --detach "$DEST" HEAD >/dev/null 2>&1 || {
    echo "[ch5-scratch] could not create $DEST" >&2; exit 3; }
fi

# One Class-A path: an untracked .sql, the same shape as the stranding on the record
# (untracked `migrations/029_*.sql` that no gate looked at for three days).
# Deliberately NOT real DDL: `scripts/check_system_map.sh` scans staged diffs for
# `ALTER TABLE ... ADD COLUMN` as an edge-mutation signal, and a fixture string is a false
# positive that would make every commit of this file need the bypass hatch. The .sql filename
# carries the shape that matters — it stands in for the untracked migration that sat stranded
# for three days.
printf -- '-- CH5 scratch fixture: stands in for an untracked migration left behind at a halt\n' > "$DEST/$SEED"

# Prove the fixture is what the gate needs BEFORE handing back a path: a scratch worktree
# that is accidentally clean would make every downstream assertion vacuous.
if [ -z "$(git -C "$DEST" status --porcelain -uall 2>/dev/null)" ]; then
  echo "[ch5-scratch] seeded worktree reports CLEAN — refusing to hand back a vacuous fixture" >&2
  exit 3
fi

echo "$DEST"
exit 0
