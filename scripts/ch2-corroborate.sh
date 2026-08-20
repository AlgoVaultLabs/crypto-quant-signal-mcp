#!/usr/bin/env bash
# ch2-corroborate.sh — OPS-WORKTREE-WORK-PENDING-W1 CH2 R2.5 / P13
#
# INDEPENDENT CORROBORATION for a delete-adjacent safety property.
#
# CH2's invariant must not be measured only by the predicate CH1 just wrote. A single
# same-wave instrument agreeing with itself is not evidence. So this compares the predicate
# against `cc-session.sh clean`'s dry-run — an instrument written by a different wave, for a
# different purpose, that has independently decided what is safe to reclaim since before
# this wave existed.
#
#   exit 0  the two instruments AGREE
#   exit 1  they DISAGREE — CH2_RED, and CH3 must not run
#   exit 3  no independent instrument available — CH2_INDETERMINATE, HALT
#
# ── WHY THIS DOES NOT ASSERT WHAT THE SPEC LITERALLY SAID ────────────────────
#
# R2.5 asks for the tool's "dry-run refusal set" to EQUAL the predicate's "protected set".
# Measured 2026-08-20, that equality is unsatisfiable by construction and would red on a
# healthy estate — a gate that cannot pass when everything is fine is worse than no gate:
#
#   * `clean` also refuses a worktree carrying UNMERGED commits (`unmerged unpushed(n)`).
#     That is a refusal, but it is not a protection, and the predicate deliberately does not
#     count it as one — it answers a different question and is one merge from vanishing.
#   * `clean_consider` SHORT-CIRCUITS. It returns on `self` and on liveness BEFORE it ever
#     evaluates exemptions or dirtiness, so for those rows the tool emits no opinion at all
#     about the thing being compared. Liveness is also time-dependent, so folding it in
#     would make this gate's result a function of what a human was typing an hour ago.
#   * The tool never considers a MAIN worktree, so it has no opinion on any primary.
#
# So the comparison is scoped to two equalities that ARE falsifiable and that CH2 and CH3
# actually depend on, over the rows where BOTH instruments have an opinion:
#
#   (a) tool-dirty            ==  predicate-dirty
#   (b) tool locked|exempt:   ==  predicate protected_by in {lock, exempt_paths}
#
# Every excluded row is PRINTED with its exclusion reason. A row silently dropped by a parse
# miss looks identical to a row that agreed, which is the absence-of-alert anti-pattern.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREDICATE="$SELF_DIR/lib/worktree-work-pending.sh"
CC_SESSION="$SELF_DIR/cc-session.sh"
CONFIG="${WORK_PENDING_CONFIG:-$SELF_DIR/../ops/worktree-noise-config.json}"

indet() { echo "CH2_CORROBORATE_INDETERMINATE: $1" >&2; exit 3; }

[ -x "$PREDICATE" ] || [ -r "$PREDICATE" ] || indet "predicate not found at $PREDICATE"
[ -r "$CC_SESSION" ] || indet "no independent instrument: cc-session.sh not found at $CC_SESSION"
command -v jq  >/dev/null 2>&1 || indet "jq absent"
command -v awk >/dev/null 2>&1 || indet "awk absent"

T="$(mktemp -d "${TMPDIR:-/tmp}/ch2-corroborate.XXXXXX")" || indet "could not mktemp -d"
trap 'rm -rf "$T"' EXIT

# ── the declared scope. `cc-session.sh clean` sweeps EVERY primary on the machine (27 on
# 2026-08-20); the predicate reads a 3-repo manifest. Comparing them unscoped would compare
# two different populations and call the difference a disagreement.
jq -r '(.repos // [])[]' "$CONFIG" 2>/dev/null | sort -u > "$T/declared"
[ -s "$T/declared" ] || indet "the manifest declares no repos — nothing to corroborate"

# ── instrument 1: the predicate ─────────────────────────────────────────────
bash "$PREDICATE" --all > "$T/rows" 2>/dev/null
rc=$?
[ "$rc" -ne 3 ] || indet "the predicate could not evaluate its own estate"
[ -s "$T/rows" ] || indet "the predicate returned no rows"

# The predicate's TSV carries no `dirty` column, so dirtiness is DERIVED from its own
# declared interface: a worktree is dirty iff it contributed any Class-A or Class-B path.
bash "$PREDICATE" --all --paths class_a 2>/dev/null | awk -F'\t' 'NF>=3{print $2}' >  "$T/dirty-src"
bash "$PREDICATE" --all --paths class_b 2>/dev/null | awk -F'\t' 'NF>=3{print $2}' >> "$T/dirty-src"
sort -u "$T/dirty-src" > "$T/pred-dirty-all"

awk -F'\t' 'NF>=7 && ($5=="lock" || $5=="exempt_paths") {print $1}' "$T/rows" | sort -u > "$T/pred-declared-all"
# Every worktree the predicate saw, and its primary, so exclusions can be applied to both.
awk -F'\t' 'NF>=7 {print $1"\t"$2}' "$T/rows" | sort -u > "$T/pred-index"

# ── instrument 2: cc-session.sh clean, DRY-RUN (read-only: it neither removes nor prunes
# unless --force is passed, verified by reading cmd_clean before running it).
if ! ( cd "$SELF_DIR/.." && bash "$CC_SESSION" clean ) > "$T/clean.out" 2>"$T/clean.err"; then
  indet "cc-session.sh clean dry-run did not complete (see stderr): $(tail -1 "$T/clean.err" 2>/dev/null)"
fi
grep -q 'DRY-RUN' "$T/clean.out" || indet "cc-session.sh clean did not report DRY-RUN — refusing to corroborate against an unknown mode"

# Parse per-primary, keeping only the DECLARED repos.
# The separator is an EM DASH, which is THREE bytes in UTF-8. `index($0,"— ")+2` lands
# inside the character and silently yields a garbage reason — measured, it made every row
# look reasonless, which read as "the tool has no opinion" and manufactured six false
# disagreements. match()/RSTART+RLENGTH is self-consistent in bytes or characters.
awk '
  /^=== primary /   { p=$3; next }
  /^(KEEP|WOULD-REMOVE|REMOVED) / {
      disp=$1; path=$2; reason=""
      if (match($0, /— /)) reason = substr($0, RSTART + RLENGTH)
      print p "\t" disp "\t" path "\t" reason
  }
' "$T/clean.out" > "$T/tool-all"

# A parse that yields no reasons at all is INDETERMINATE, not agreement: the comparison
# would then be against an empty tool-side set and every predicate row would read as a
# disagreement — or, with the sets reversed, every row would read as agreeing about nothing.
if [ "$(awk -F'\t' '$4 != ""' "$T/tool-all" | wc -l | tr -d ' ')" -eq 0 ]; then
  indet "parsed $(wc -l < "$T/tool-all" | tr -d ' ') tool rows but ZERO reasons — the dry-run output format has moved under this parser"
fi

awk -F'\t' 'NR==FNR{d[$1]=1; next} ($1 in d)' "$T/declared" "$T/tool-all" > "$T/tool"
[ -s "$T/tool" ] || indet "the independent instrument produced no rows for any declared repo"

# ── EXCLUSIONS ARE PER-EQUALITY, because clean_consider SHORT-CIRCUITS in a fixed order:
#
#     is_main -> is_caller(self) -> in_use(liveness) -> exempt/locked -> dirty -> landed
#
# Each `return` means the tool never evaluated anything BELOW it, so for those rows it holds
# no opinion about the lower question. Folding them in does not measure a disagreement, it
# measures the tool's control flow — and it would red a healthy estate the moment CH2 adds
# an exemption, since an exempt row stops being asked whether it is dirty.
#
#   excluded from (a) dirtiness            : self, in-use, locked, exempt  (all return above it)
#   excluded from (b) declared protection  : self, in-use                  (return above it)
awk -F'\t' '$4 ~ /^self / || $4 ~ /^in-use\(/ {print $3"\t"$4}' "$T/tool" | sort -u > "$T/excl-b"
{ cat "$T/excl-b"
  awk -F'\t' '$4 ~ /^locked \(/ || $4 ~ /^exempt: / {print $3"\t"$4}' "$T/tool"
} | sort -u > "$T/excl-a"
cut -f1 "$T/excl-b" | sort -u > "$T/excl-b-paths"
cut -f1 "$T/excl-a" | sort -u > "$T/excl-a-paths"
cp "$T/excl-a" "$T/excluded"

awk -F'\t' '$4 ~ /dirty/ {print $3}'                              "$T/tool" | sort -u > "$T/tool-dirty-all"
awk -F'\t' '$4 ~ /^locked \(/ || $4 ~ /^exempt: / {print $3}'     "$T/tool" | sort -u > "$T/tool-declared-all"
cut -f3 "$T/tool" | sort -u > "$T/tool-seen"

comm -23 "$T/tool-dirty-all"     "$T/excl-a-paths" > "$T/tool-dirty"
comm -23 "$T/tool-declared-all"  "$T/excl-b-paths" > "$T/tool-declared"
comm -12 "$T/pred-dirty-all"     "$T/tool-seen" | comm -23 - "$T/excl-a-paths" > "$T/pred-dirty"
comm -12 "$T/pred-declared-all"  "$T/tool-seen" | comm -23 - "$T/excl-b-paths" > "$T/pred-declared"

# VACUITY. If exclusions swallowed every comparable row, `comm -3` over two empty sets
# reports agreement having compared nothing — the exact "verified nothing at exit 0" the
# verdict-token law forbids. Both populations must be non-empty for this to mean anything.
comm -23 "$T/tool-seen" "$T/excl-a-paths" > "$T/comparable-a"
comm -23 "$T/tool-seen" "$T/excl-b-paths" > "$T/comparable-b"
[ -s "$T/comparable-a" ] || indet "every row was excluded from equality (a) — nothing left to corroborate"
[ -s "$T/comparable-b" ] || indet "every row was excluded from equality (b) — nothing left to corroborate"

echo "[corroborate] declared repos: $(wc -l < "$T/declared" | tr -d ' ') · predicate rows: $(wc -l < "$T/rows" | tr -d ' ') · tool rows in scope: $(wc -l < "$T/tool" | tr -d ' ')"

echo "[corroborate] comparable population — (a) dirtiness: $(wc -l < "$T/comparable-a" | tr -d ' ') rows · (b) declared protection: $(wc -l < "$T/comparable-b" | tr -d ' ') rows"
echo "[corroborate] comparable rows — POSITIVE per-row output, never absence-of-alert:"
while IFS= read -r w; do
  [ -n "$w" ] || continue
  td="no"; pd="no"; tp="no"; pp="no"
  if grep -qxF "$w" "$T/excl-a-paths"; then td="n/a"; pd="n/a"; else
    grep -qxF "$w" "$T/tool-dirty"   && td="yes"
    grep -qxF "$w" "$T/pred-dirty"   && pd="yes"
  fi
  grep -qxF "$w" "$T/tool-declared"  && tp="yes"
  grep -qxF "$w" "$T/pred-declared"  && pp="yes"
  [ "$td" = "no" ] && [ "$pd" = "no" ] && [ "$tp" = "no" ] && [ "$pp" = "no" ] && continue
  printf '    %s\n      dirty: tool=%s predicate=%s · declared-protection: tool=%s predicate=%s\n' "$w" "$td" "$pd" "$tp" "$pp"
done < "$T/comparable-b"

if [ -s "$T/excluded" ]; then
  echo "[corroborate] EXCLUDED — the tool short-circuited before it could form an opinion:"
  while IFS= read -r line; do printf '    %s\n' "$line"; done < "$T/excluded"
fi

fail=0
da="$(comm -3 "$T/tool-dirty" "$T/pred-dirty")"
db="$(comm -3 "$T/tool-declared" "$T/pred-declared")"
if [ -n "$da" ]; then
  echo "[corroborate] DISAGREEMENT on (a) dirtiness — left=tool-only right=predicate-only:"
  printf '%s\n' "$da" | sed 's/^/    /'
  fail=1
fi
if [ -n "$db" ]; then
  echo "[corroborate] DISAGREEMENT on (b) declared protection — left=tool-only right=predicate-only:"
  printf '%s\n' "$db" | sed 's/^/    /'
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "CH2_CORROBORATE_DISAGREE: the reclaim tool and the predicate do not agree about what is safe"
  exit 1
fi
echo "CH2_CORROBORATE_AGREE: dirtiness and declared protection match across both instruments"
exit 0
