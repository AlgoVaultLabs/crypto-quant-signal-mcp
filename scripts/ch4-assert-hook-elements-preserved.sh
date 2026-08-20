#!/usr/bin/env bash
# ch4-assert-hook-elements-preserved.sh — OPS-WORKTREE-WORK-PENDING-W1 CH4 (AC4.5)
#
# Assert that registering this wave's `SessionEnd` hook LOST NOTHING.
#
# ── ELEMENT-SET CONTAINMENT, NOT WHOLE-KEY EQUALITY ──────────────────────────
#
# The spec's r1 demanded `.hooks.Stop` be "byte-identical" while the wave's own job was to add
# an element to `.hooks`. That is logically unsatisfiable, so it would either halt a correct
# build or get waved through — and waving it through is how the real regression ships. The
# assertion that survives is: every element that was there before is STILL there, unchanged.
# A key may grow; it may never shrink or mutate.
#
#   exit 0  every pre-existing element of every pre-existing hook event survives
#   exit 1  an element was lost or mutated — CH4_RED
#   exit 3  cannot verify (no backup, no jq, unreadable settings) — never a silent pass
#
# The backup is the ONLY thing that makes this checkable, which is why R4.5 requires taking one
# BEFORE the edit rather than after.
set -uo pipefail

SETTINGS="${ALGOVAULT_SETTINGS:-$HOME/.claude/settings.json}"
BACKUP="${ALGOVAULT_SETTINGS_BACKUP:-}"

indet() { echo "HOOK_ELEMENTS_VERDICT=INDETERMINATE ($1)" >&2; exit 3; }

command -v jq >/dev/null 2>&1 || indet "jq absent"

if [ -z "$BACKUP" ]; then
  # Newest pre-merge backup first; fall back to any timestamped backup. Both are this wave's
  # own naming, so a miss means the evidence is gone and the honest answer is INDETERMINATE.
  BACKUP="$(ls -t "$HOME"/.claude/settings.json.premerge.*.bak 2>/dev/null | head -1)"
  [ -n "$BACKUP" ] || BACKUP="$(ls -t "$HOME"/.claude/settings.json.*.bak 2>/dev/null | head -1)"
fi
[ -n "$BACKUP" ] && [ -r "$BACKUP" ] || indet "no readable pre-edit backup to compare against"
[ -r "$SETTINGS" ] || indet "settings unreadable: $SETTINGS"
jq -e 'type=="object"' "$SETTINGS" >/dev/null 2>&1 || indet "settings is not a JSON object"
jq -e 'type=="object"' "$BACKUP"   >/dev/null 2>&1 || indet "backup is not a JSON object"

lost=0

# (1) every hook EVENT that existed before must still exist
while IFS= read -r ev; do
  [ -n "$ev" ] || continue
  if ! jq -e --arg e "$ev" 'has("hooks") and (.hooks|has($e))' "$SETTINGS" >/dev/null 2>&1; then
    echo "LOST: hook event .hooks.$ev no longer exists"
    lost=$(( lost + 1 ))
    continue
  fi
  # (2) every ELEMENT of it must still be present, compared as normalised JSON so key order
  #     cannot manufacture a false loss.
  n_before="$(jq --arg e "$ev" '(.hooks[$e] // []) | length' "$BACKUP")"
  i=0
  while [ "$i" -lt "$n_before" ]; do
    el="$(jq -c --arg e "$ev" --argjson i "$i" '.hooks[$e][$i]' "$BACKUP")"
    # Structural containment via jq's own `index`, which compares VALUES. The first form here
    # serialised both sides with `tojson` and compared strings — but `-S` sorts jq's OUTPUT,
    # not the strings `tojson` builds internally, so two identical objects with different key
    # order never matched and the assertion failed on a healthy estate. A gate that cannot
    # pass when nothing is wrong is worse than no gate, and it is exactly why this script
    # carries a MUST-NOT-FIRE case alongside its must-fire ones.
    if ! jq -e --arg e "$ev" --argjson el "$el" '[(.hooks[$e] // [])[]] | index($el) != null' "$SETTINGS" >/dev/null 2>&1; then
      echo "LOST: .hooks.$ev element $i is missing or mutated: $el"
      lost=$(( lost + 1 ))
    fi
    i=$(( i + 1 ))
  done
done < <(jq -r '(.hooks // {}) | keys[]' "$BACKUP" 2>/dev/null)

# (3) every TOP-LEVEL key must survive. settings.json here also carries top-level `Stop` and
#     `UserPromptSubmit` alongside `.hooks.*`, and a merge that dropped one of those would be
#     invisible to a hooks-only check.
while IFS= read -r k; do
  [ -n "$k" ] || continue
  jq -e --arg k "$k" 'has($k)' "$SETTINGS" >/dev/null 2>&1 || {
    echo "LOST: top-level key .$k no longer exists"; lost=$(( lost + 1 )); }
done < <(jq -r 'keys[]' "$BACKUP" 2>/dev/null)

# VACUITY: a backup with no hook events and no keys would pass this having compared nothing.
if [ "$(jq -r '(.hooks // {}) | keys | length' "$BACKUP")" -eq 0 ]; then
  indet "the backup declares ZERO hook events — nothing to compare, refusing to report a pass"
fi

if [ "$lost" -ne 0 ]; then
  echo "HOOK_ELEMENTS_VERDICT=FAIL ($lost lost or mutated; backup=$BACKUP)"
  exit 1
fi
echo "HOOK_ELEMENTS_VERDICT=PASS (every pre-existing element and top-level key survives; backup=$BACKUP)"
exit 0
