#!/usr/bin/env bash
# branch-work-landed.sh — OPS-UNPUSHED-WORK-TRIAGE-W1
#
# THE ONE PREDICATE for "has this worktree's work already landed on the default ref?"
#
# SINGLE DERIVATION, deliberately. Two consumers need this answer — `cc-session.sh clean`
# (may I reclaim this worktree?) and the unpushed-work detector (is there real exposure
# here?). Two independent implementations WOULD drift, and we would get this exact bug
# back in whichever one nobody was looking at. So it is implemented once, here, and both
# shell out to it.
#
# ── WHY THIS EXISTS: the metric it replaces was wrong ─────────────────────────
#
# `git rev-list '@{upstream}'..HEAD` measures distance from the branch's OWN REMOTE
# TRACKING REF. That ref is stale on any branch whose work reached the default ref by a
# squash- or rebase-merge, because nothing ever updated `origin/<branch>`. It is NOT a
# measure of unique work.
#
# MEASURED 2026-08-07: the naive form reported 30 commits "at risk" across 7 worktrees.
# The real figure was **ZERO** in those 7 — every HEAD was already an ancestor of
# origin/main — and 9 genuinely-unique commits sat in 5 OTHER worktrees the tool never
# even considered, because they were unmerged and thus outside its criterion.
#
# The correct questions are:
#   * is HEAD an ancestor of origin/main?           -> everything landed; nothing to lose
#   * `git cherry origin/main HEAD`                 -> which commits are unique BY PATCH-ID
#     (patch-id, so a rebased or cherry-picked commit is correctly seen as a duplicate)
#
# ── OUTPUT ────────────────────────────────────────────────────────────────────
#   LANDED <n_unique=0>       every commit is on origin/main; reclaim loses nothing
#   UNIQUE <n_unique>         real unlanded work; reclaim would lose it
#   UNKNOWN <reason>          could not determine — callers MUST treat as UNIQUE
#
# UNKNOWN is deliberately fail-safe: a caller that cannot determine the answer must
# behave as though there is work to lose, never as though there is none.
set -uo pipefail

WT="${1:-}"
BASE="${BRANCH_LANDED_BASE:-origin/main}"

[ -n "$WT" ] && [ -d "$WT" ] || { echo "UNKNOWN no-such-worktree"; exit 0; }
git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 || { echo "UNKNOWN not-a-git-worktree"; exit 0; }
git -C "$WT" rev-parse --verify --quiet "$BASE" >/dev/null 2>&1 || { echo "UNKNOWN no-base-ref:$BASE"; exit 0; }

HEAD_SHA="$(git -C "$WT" rev-parse HEAD 2>/dev/null)"
[ -n "$HEAD_SHA" ] || { echo "UNKNOWN no-head"; exit 0; }

# Strongest available safety statement: every commit reachable from HEAD is on the base.
if git -C "$WT" merge-base --is-ancestor "$HEAD_SHA" "$BASE" 2>/dev/null; then
  echo "LANDED 0"
  exit 0
fi

# Not an ancestor — but commits may still be present under different SHAs (rebase,
# cherry-pick, squash). `git cherry` compares by PATCH-ID, which is what catches that.
CHERRY="$(git -C "$WT" cherry "$BASE" HEAD 2>/dev/null)" || { echo "UNKNOWN cherry-failed"; exit 0; }
N_UNIQUE="$(printf '%s\n' "$CHERRY" | grep -c '^+' || true)"

if [ "${N_UNIQUE:-0}" -eq 0 ] 2>/dev/null; then
  echo "LANDED 0"
else
  echo "UNIQUE $N_UNIQUE"
fi
