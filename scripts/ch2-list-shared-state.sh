#!/usr/bin/env bash
# ch2-list-shared-state.sh — OPS-WORKTREE-WORK-PENDING-W1 CH2
#
# Emits, one absolute path per line, every `shared-worktree-state.json` belonging to the
# repos the classification manifest DECLARES. The CH2 gate loops over this list and asserts
# each file still parses as a JSON object, so an edit that leaves the SoT unparseable reds
# the chapter instead of shipping.
#
# ENUMERATED, never hardcoded. Measured 2026-08-20: there is exactly ONE such file, in
# crypto-quant-signal-mcp/ops/, and it carries absolute paths for algovault-bot and
# autonomous-optimizer worktrees — so it is the estate-wide SoT rather than one of three.
# That could change; a hardcoded path would not notice, and detection is strictly weaker
# than enumeration.
#
# VACUITY: finding nothing is NOT a pass. The gate's `for f in $(...)` over an empty list
# iterates zero times and falls straight through to green, which is the "verified nothing"
# outcome the verdict-token law exists to forbid. So a zero-result run emits a sentinel path
# that cannot be a JSON object, and the gate reds on it with a legible message.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${WORK_PENDING_CONFIG:-$SELF_DIR/../ops/worktree-noise-config.json}"

SENTINEL="/nonexistent/CH2-SHARED-STATE-ENUMERATION-FOUND-NOTHING"

command -v jq >/dev/null 2>&1 || { echo "$SENTINEL"; exit 3; }
[ -r "$CONFIG" ]                || { echo "$SENTINEL"; exit 3; }

found=0
# The checkout this script lives in FIRST: `ops/` is tracked, so every worktree carries its
# own copy and the declared repo roots resolve to the PRIMARY's — which still holds the
# pre-merge version. A gate that asserted only that one would be verifying a file the
# chapter never edited.
for f in "$SELF_DIR/../ops/shared-worktree-state.json"; do
  if [ -f "$f" ]; then ( cd "$(dirname "$f")" && pwd -P ) >/dev/null 2>&1 && \
    { printf '%s/%s\n' "$(cd "$(dirname "$f")" && pwd -P)" "$(basename "$f")"; found=$(( found + 1 )); }
  fi
done

while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  [ -d "$repo" ] || continue
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    echo "$f"
    found=$(( found + 1 ))
  done < <(find "$repo" -maxdepth 3 -name 'shared-worktree-state.json' -type f 2>/dev/null | sort)
done < <(jq -r '(.repos // [])[]' "$CONFIG" 2>/dev/null)

if [ "$found" -eq 0 ]; then echo "$SENTINEL"; exit 3; fi
exit 0
