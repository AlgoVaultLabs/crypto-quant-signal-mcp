#!/usr/bin/env bash
# selftest-mutation-proof.sh — OPS-WORKTREE-WORK-PENDING-W1 CH1 (R1.7)
#
# PROVES that scripts/lib/worktree-work-pending.sh's --self-test can actually FAIL.
#
# An assertion that has never failed is not an assertion, and a proof that lives in prose is
# not a control. So this does the proof by SCRIPT: it copies the classifier, breaks one
# load-bearing line, runs the suite against the broken copy, and requires the suite to go
# red. Repeated once per mutation, each aimed at a DIFFERENT leg — a suite that only catches
# one kind of damage is not covered, it is lucky.
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │  READ THIS BEFORE "FIXING" THE EXIT CODE. IT IS INVERTED ON PURPOSE.       │
# │                                                                           │
# │    exit NON-ZERO  =  GOOD. Every mutation was caught; falsifiability is    │
# │                      PROVEN. The CH1 gate treats this as green.            │
# │    exit 0         =  BAD.  Something was NOT proven — a mutation survived, │
# │                      or the proof could not run at all.                    │
# │                                                                           │
# │  The CH1 verification gate reads it as:                                    │
# │      mut=$(bash scripts/selftest-mutation-proof.sh >/dev/null 2>&1; echo $?)│
# │      [ "$mut" -eq 0 ] -> CH1_RED: "the self-test cannot fail"               │
# │                                                                           │
# │  So `exit 0` is the FAILURE signal. This inversion falls out of the gate's │
# │  contract, not from a preference, which is why it is stated here in a box  │
# │  rather than in a footnote.                                                │
# └───────────────────────────────────────────────────────────────────────────┘
#
# FAIL-CLOSED on "could not verify". The gate above only distinguishes zero from non-zero,
# so an INDETERMINATE run (no mktemp, no sed, an anchor that no longer matches) exits 0 and
# reds the gate. A guard that cannot prove its subject must not report success — and the
# gate's own message says "mutation proof passed", which is imprecise for that case, so the
# TOKEN below carries the truth:
#
#     MUTATION_PROOF_VERDICT=PROVEN | SURVIVED | INDETERMINATE
#
# An anchor that stops matching is a REAL finding, not a maintenance chore: it means the line
# this proof believes is load-bearing has moved or been rewritten, and nobody re-checked
# whether the suite still covers it.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="${MUTATION_PROOF_SUBJECT:-$SELF_DIR/lib/worktree-work-pending.sh}"

verdict() { echo "MUTATION_PROOF_VERDICT=$1"; }

[ -r "$SUBJECT" ] || {
  echo "✖ subject unreadable: $SUBJECT" >&2
  verdict INDETERMINATE; exit 0; }
command -v sed >/dev/null 2>&1 || { echo "✖ sed absent" >&2; verdict INDETERMINATE; exit 0; }

T="$(mktemp -d "${TMPDIR:-/tmp}/wpw-mutation.XXXXXX")" || {
  echo "✖ could not mktemp -d" >&2; verdict INDETERMINATE; exit 0; }
trap 'rm -rf "$T"' EXIT

# ── the mutation table ──────────────────────────────────────────────────────
# Each row: <label> :: <sed expression> :: <the assertion that MUST go red>
# Every anchor is a unique substring of the subject; none is a line number, because a line
# number in a gate goes stale on the next prose edit.
MUTATIONS='
classifier-never-matches-basename::s|\[ "\$bn" = "\$pat" \]|false|::Class-B stops being recognised
fold-swallows-UNKNOWN::s|UNKNOWN) echo "INDETERMINATE"; return 0 ;;|UNKNOWN) : ;;|::UNKNOWN would fold to CLEAN
indeterminate-maps-to-exit-0::s|    INDETERMINATE) echo 3 ;;|    INDETERMINATE) echo 0 ;;|::the token->code map is unasserted
expiry-never-lapses::s|if \[ "\$exp" .< "\$today" \]; then return 1; fi|if false; then return 1; fi|::a lapsed exemption still protects
work-pending-always-NO::s|if \[ "\$a" -gt 0 \]; then pending=YES; else pending=NO; fi|pending=NO|::real work reads as none
lock-never-detected::s|if is_locked "\$wt";  then protected=lock|if false;  then protected=lock|::a locked worktree reads unprotected
'

# A healthy baseline is a precondition: if the UNMUTATED suite is already red, every mutation
# "passes" for the wrong reason and this whole proof is vacuous.
if ! bash "$SUBJECT" --self-test >"$T/baseline.log" 2>&1; then
  echo "✖ the UNMUTATED self-test is already failing — a mutation proof over a red suite is vacuous" >&2
  tail -5 "$T/baseline.log" >&2
  verdict INDETERMINATE; exit 0
fi

total=0; caught=0; survived=0; unanchored=0
while IFS= read -r row; do
  [ -n "$row" ] || continue
  label="${row%%::*}"
  rest="${row#*::}"
  expr="${rest%%::*}"
  why="${rest##*::}"
  total=$(( total + 1 ))

  mutant="$T/mutant-$total.sh"
  sed "$expr" "$SUBJECT" > "$mutant" 2>/dev/null

  # An anchor that no longer matches means the line this proof believes is load-bearing has
  # moved. That is a finding, not a skip — it is reported and it blocks.
  if cmp -s "$SUBJECT" "$mutant"; then
    unanchored=$(( unanchored + 1 ))
    echo "  ANCHOR-LOST  $label — the sed anchor matched nothing; the subject has moved under this proof"
    continue
  fi

  chmod +x "$mutant"
  if bash "$mutant" --self-test >"$T/out-$total.log" 2>&1; then
    survived=$(( survived + 1 ))
    echo "  SURVIVED     $label — suite stayed GREEN with the subject broken ($why)"
  else
    caught=$(( caught + 1 ))
    echo "  caught       $label ($why)"
  fi
done <<EOF
$MUTATIONS
EOF

echo "[mutation-proof] $caught/$total caught · $survived survived · $unanchored anchors lost"

if [ "$total" -eq 0 ]; then
  echo "✖ the mutation table is EMPTY — this proof would report success having proven nothing" >&2
  verdict INDETERMINATE; exit 0
fi
if [ "$unanchored" -ne 0 ]; then
  verdict INDETERMINATE; exit 0
fi
if [ "$survived" -ne 0 ]; then
  verdict SURVIVED; exit 0
fi

verdict PROVEN
# NON-ZERO on success. See the box at the top of this file.
exit 1
