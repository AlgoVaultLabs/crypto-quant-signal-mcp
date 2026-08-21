#!/usr/bin/env bash
# SYSTEM-MAP-SHAPE-GATE-W1 — markdown MAP-SHAPE gate. File-agnostic.
#
# ─── WHAT THIS GATES, AND WHY IT IS NOT THE SIBLING ─────────────────────────────────────────
# scripts/check_system_map.sh asks "was the map TOUCHED alongside an edge mutation?" — a
# freshness question. It is satisfied by any edit at all. This script asks the other half:
# "is the file still MAP-SHAPED?" Three properties, each of which fired on a real defect found
# in the pre-de-log archive on 2026-08-21 — none of this is speculative hardening:
#
#   LINE_TOO_LONG        changelog prose accreted into a table cell   (archive L356: 62,983 chars)
#   CELL_COUNT_MISMATCH  unescaped | inside a cell → phantom columns  (archive L356: 16 vs 3)
#   TABLE_INTERRUPTED    prose/blank splitting one table into two     (archive L358, L425)
#
# CELL_COUNT_MISMATCH is the one that matters most: length alone would miss a SHORT row that
# still carries an unescaped union type, and that row silently corrupts the rendered map.
#
# ─── ON THE CAUSE, STATED HONESTLY ──────────────────────────────────────────────────────────
# The file bloated to 430 KB, was hand-cleaned, and regrew to 174 KB in six weeks. It is
# tempting to blame the freshness gate for "rewarding growth" — that reading is WRONG and is
# recorded here so it does not get repeated. §5's prescribed n-a path is an explicitly
# zero-growth in-place overwrite, and WIS prefers a ledgered skip over even that. Neither
# documented path is "append". The bloat came from waves that legitimately edited Role cells
# and wrote them in a LOG STYLE — there was simply NO SHAPE CONSTRAINT on an otherwise-valid
# edit. This script is that missing constraint. The remedy is unchanged; the causal claim is.
#
# ─── REUSABLE BY CONSTRUCTION (Pillar 3) ────────────────────────────────────────────────────
# Nothing here is system-map.md-specific. The target is $1; each table's expected width is read
# from that table's OWN header row. status.md, CLAUDE.md and the monitoring-inventory docs can
# adopt it by adding one call each, with no code change.
#
# ─── VERDICT TOKEN (per Claude files/rules/verification-gates.md) ────────────────────────────
# This gate CAN fail open — a missing or unreadable target must never silently pass. So it
# prints exactly ONE terminal machine-readable line and callers gate on the TOKEN, never the code:
#
#   SYSTEM_MAP_SHAPE_VERDICT=PASS           exit 0   parsed, all three checks clean
#   SYSTEM_MAP_SHAPE_VERDICT=FAIL           exit 1   parsed, ≥1 check violated
#   SYSTEM_MAP_SHAPE_VERDICT=INDETERMINATE  exit 3   missing / unreadable / zero tables found
#
# 3 is the token-law DEFAULT for a gate with no incumbent code for "could not verify". It is
# deliberately NOT aligned to check_test_baseline.sh's 2 — that script uses 2 only because it
# already deployed 2, and nothing reads both code spaces.
#
# ZERO TABLES IS INDETERMINATE, NOT PASS. A vacuity guard belongs where the corpus is
# CONSTRUCTED, not where it is OBSERVED — and here the corpus is HANDED to us. Input we were
# handed and could not parse is INDETERMINATE, always. (In --self-test WE build the fixtures, so
# an empty scenario set there REFUSES instead; see run_self_test.)
#
# Usage:
#   check_map_shape.sh <file> [--max-line N]     # N defaults to 1200
#   check_map_shape.sh --system-map              # target resolved from the ONE shared definition
#   check_map_shape.sh --self-test
set -euo pipefail

GATE_NAME=SYSTEM_MAP_SHAPE
DEFAULT_MAX_LINE=1200

# Test-importable (CLAUDE.md's sourceable-shell law): a fixture may source this file to reach
# its pure functions without running the gate body. Same idiom as check_test_baseline.sh:155
# and check-author-identity.sh:39 — one convention, not a third dialect.
if (return 0 2>/dev/null); then MAP_SHAPE_SOURCED=1; else MAP_SHAPE_SOURCED=0; fi

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"

# ── the shared ledger ────────────────────────────────────────────────────────────────────────
# Writes to the EXISTING $GIT_COMMON_DIR/algovault-hook-skip.log in its established TSV shape —
# ONE log with an event column, never a second one to forget to read. INLINED rather than
# sourcing scripts/lib/hook-block.sh, deliberately: that library's design decision #1 forbids
# runtime dependence on it, because a worktree predating it would fail to source and — under
# `set -e` — block every commit there. check_system_map.sh inlines the identical printf.
#
# A 6th field (reason) is APPENDED. Verified safe before adding it: the ledger's only reader,
# scripts/check-shared-state.mjs:496-498, counts non-empty LINES and never splits on tabs.
# Best-effort throughout: a ledger that cannot be written must never change the verdict.
map_shape_ledger() {   # <event> <reason>
  local common
  common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd) || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" map-shape \
    "$(git rev-parse --show-toplevel 2>/dev/null || echo '?')" scripts/check_map_shape.sh \
    "${2:--}" \
    >>"$common/algovault-hook-skip.log" 2>/dev/null || true
}

# ── the ONE scanner ──────────────────────────────────────────────────────────────────────────
# awk, not bash string substitution. Two reasons, the second measured: (1) the archive carries a
# 62,983-char line and bash 3.2's ${var//pat/} degrades badly on strings that size; (2) this
# machine has bash 3.2.57 ONLY (no Homebrew bash at either prefix), so `mapfile` does not exist
# and `"${arr[@]}"` on an EMPTY array under `set -u` aborts with "unbound variable" — measured.
# Keeping the scan in one awk program sidesteps both without renting portability from luck.
#
# LC_ALL=C is set by the caller so `length()` is BYTES, deterministically, on every platform.
# That is the instrument, and it is recorded beside every number this gate prints.
#
# BYTES vs CHARACTERS is not pedantry here — it is a measured, resolved discrepancy. system-map.md
# line 451 is 852 BYTES and 844 CHARACTERS (8 multi-byte glyphs), and two readings of "the max
# line" that omit the instrument look exactly like one of them being wrong. The PASS summary
# therefore says "bytes". The VIOLATION message keeps the word "chars" because that wording is
# mandated verbatim by the gate's spec (R2) — the number is identical either way at that scale,
# and diverging from a mandated string to win a nuance is not a trade worth making.
#
# Emits, tab-separated:  V <line> <CHECK> <detail>     one per violation
#                        S <tables> <rows> <maxlen> <maxline>   summary, always last
read -r -d '' MAP_SHAPE_AWK <<'AWK' || true
function upipes(s,   n) {
  # UNESCAPED pipes only. `\|` inside a cell is legal markdown and must not count — a naive
  # split("|") reproduces the very bug this gate exists to catch. Strip the escaped form first,
  # then count what remains. gsub returns its substitution count.
  gsub(/\\[|]/, "", s)
  n = gsub(/[|]/, "&", s)
  return n
}
{ lines[NR] = $0 }
END {
  infence = 0; intable = 0; expect = 0; start = 0
  pend_line = 0; pend_tbl = 0
  tables = 0; rows = 0; maxlen = 0; maxline = 0
  for (i = 1; i <= NR; i++) {
    l = lines[i]
    # Fenced blocks are skipped. CLAUDE.md and status.md both carry fenced EXAMPLES holding
    # pipes and long lines; without this the file-agnostic claim above is simply false.
    if (l ~ /^[ \t]*```/) { infence = !infence; continue }
    if (infence) continue

    L = length(l)
    if (L > maxlen) { maxlen = L; maxline = i }
    if (L > MAXLINE) print "V\t" i "\tLINE_TOO_LONG\t" L " > " MAXLINE " chars"

    isrow = (l ~ /^[|]/)
    issep = (l ~ /^[|][-:| ]+[|]$/)
    ishdr = (isrow && !issep && i < NR && lines[i+1] ~ /^[|][-:| ]+[|]$/)

    if (ishdr) {
      expect = upipes(l); intable = 1; start = i; tables++
      pend_line = 0; pend_tbl = 0
      continue
    }
    if (isrow) {
      # An orphan row — a row reached while NOT inside a table — is the SIGNATURE of check 3.
      # Read naively ("any non-row line ends the table, therefore it interrupted it") the blank
      # line that TERMINATES every well-formed table scores as a violation, and the clean file
      # fails. The spec's own words are "between a table's FIRST and LAST row", so a non-row
      # line is only a violation once another row proves the table continued past it.
      if (!intable && pend_tbl > 0) {
        print "V\t" pend_line "\tTABLE_INTERRUPTED\tnon-row line inside table block starting at " pend_tbl
        intable = 1; pend_line = 0; pend_tbl = 0
      }
      if (issep) continue
      if (!intable) continue          # headerless stray row — no table context to judge against
      rows++
      k = upipes(l)
      if (expect > 0 && k != expect)
        print "V\t" i "\tCELL_COUNT_MISMATCH\t" (k - 1) " cells, header declares " (expect - 1)
      continue
    }
    if (intable) { pend_line = i; pend_tbl = start; intable = 0 }
  }
  print "S\t" tables "\t" rows "\t" maxlen "\t" maxline
}
AWK

# ── violation rendering ──────────────────────────────────────────────────────────────────────
# R2: a message must name the LAW, not just the number. "line 356: 62356 > 1200" teaches
# nothing and sends the reader to a manual. The remedy is stated inline so the fix needs no
# lookup — that is what makes this a developer-loop gate with no operator action on any path.
# The LINE_TOO_LONG remedy is TARGET-AWARE, and that is not cosmetic. R2 mandates the
# map-not-a-log wording verbatim, and system-map.md still gets exactly that text. But this script
# is file-agnostic by design, and printing "per-wave history belongs in status.md" while checking
# status.md is advice that contradicts itself — the kind of message that teaches a reader the gate
# does not know what it is looking at. Mandated text where it applies; honest text everywhere else.
explain() {   # <CHECK> <basename>
  case "$1" in
    LINE_TOO_LONG)
      if [ "${2:-}" = "system-map.md" ]; then
        echo "  This file is a MAP, not a log. Per-wave history belongs in status.md."
        echo "  Move the changelog prose out of the cell; keep the component's role + current edges."
      else
        echo "  A line this long is usually accreted history inside a single cell."
        echo "  Move the narrative out to this file's own log; keep the row's current facts."
      fi ;;
    CELL_COUNT_MISMATCH)
      echo "  Unescaped | inside a cell creates phantom columns. Escape it as \\| —"
      echo "  most often a TS union written as 'a'|'b' inside backticks." ;;
    TABLE_INTERRUPTED)
      echo "  Prose or a blank line between rows splits one table into two headerless tables."
      echo "  Move the paragraph below the table." ;;
  esac
}

# ── verdict emission ─────────────────────────────────────────────────────────────────────────
# The token is the LAST line on stdout on EVERY path, including error paths. The bypass lever
# may downgrade the EXIT CODE; it must NEVER launder the token into a pass. Same lever shape as
# ALGOVAULT_TEST_GATE=warn — one convention, not a second dialect.
finish() {   # <VERDICT>
  local verdict="$1" code
  case "$verdict" in
    PASS)          code=0 ;;
    FAIL)          code=1 ;;
    INDETERMINATE) code=3 ;;
    *)             verdict=INDETERMINATE; code=3 ;;
  esac

  if [ "$verdict" != PASS ] && [ -n "${ALGOVAULT_SKIP_MAP_SHAPE:-}" ]; then
    # The hatch is TOTAL — both non-PASS verdicts honour it — and that is deliberate. A hatch
    # that fails when it is most needed gets replaced by `git commit --no-verify`, which
    # bypasses EVERY hook and writes NO ledger row. Total-but-ledgered beats partial-and-evaded.
    #
    # The event column records WHICH verdict was bypassed, because they are DIFFERENT ACTS:
    #   INDETERMINATE-bypass  vault unmounted. Infrastructure. Expected.
    #   FAIL-bypass           routing around a red gate on our own map — the act the manual's
    #                         Never list forbids. It needs the reason in the commit body too.
    # Without that column a drift toward normalisation is invisible; the sibling hatch already
    # has 5 documented uses, most of them false positives.
    local reason="${ALGOVAULT_SKIP_MAP_SHAPE}"
    [ "$reason" = "1" ] && reason="-"
    map_shape_ledger "MAP_SHAPE_ENV_BYPASS_${verdict}" "$reason"
    {
      echo "⚠️  [map-shape] ALGOVAULT_SKIP_MAP_SHAPE set — exit code downgraded to 0."
      echo "⚠️    The verdict below is UNCHANGED and real: $verdict. Logged to the skip ledger."
      if [ "$verdict" = FAIL ]; then
        echo "⚠️    THIS IS A FAIL-BYPASS — you are routing around a red gate on our own map."
        echo "⚠️    Record the reason in the commit body (documented-relaxation practice)."
        echo "⚠️    A relaxation that outlives its reason becomes the norm."
      else
        echo "⚠️    INDETERMINATE-bypass: the gate could not read its target (vault unmounted?)."
      fi
    } >&2
    code=0
  fi

  printf '%s_VERDICT=%s\n' "$GATE_NAME" "$verdict"
  exit "$code"
}

# ── the gate body ────────────────────────────────────────────────────────────────────────────
run_gate() {   # <file> <max-line>
  local file="$1" max="$2" out rc=0

  if [ ! -f "$file" ]; then
    echo "[map-shape] cannot read target: $file"
    echo "  A gate that cannot read its target REFUSES — it never passes on unreadable input."
    finish INDETERMINATE
  fi
  if [ ! -r "$file" ]; then
    echo "[map-shape] target exists but is not readable: $file"
    finish INDETERMINATE
  fi

  # Put the failure on the PRODUCER: `set -e` plus a bare command substitution would abort here
  # with no verdict token at all — the one outcome the token law forbids outright.
  if ! out=$(LC_ALL=C awk -v MAXLINE="$max" "$MAP_SHAPE_AWK" "$file" 2>/dev/null); then rc=1; fi
  if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
    echo "[map-shape] scanner failed on: $file"
    echo "  Parsed nothing, so the verdict is undeterminable rather than clean."
    finish INDETERMINATE
  fi

  local summary tables rows maxlen maxline violations
  summary=$(printf '%s\n' "$out" | grep '^S	' | tail -1)
  tables=$(printf '%s\n' "$summary" | cut -f2)
  rows=$(printf '%s\n' "$summary" | cut -f3)
  maxlen=$(printf '%s\n' "$summary" | cut -f4)
  maxline=$(printf '%s\n' "$summary" | cut -f5)
  violations=$(printf '%s\n' "$out" | grep -c '^V	' || true)

  if [ "${tables:-0}" -eq 0 ]; then
    echo "[map-shape] zero tables found in: $file"
    echo "  Input we were handed and could not parse is INDETERMINATE, never a silent pass."
    finish INDETERMINATE
  fi

  if [ "$violations" -gt 0 ]; then
    printf '%s\n' "$out" | grep '^V	' | while IFS=$'\t' read -r _ line check detail; do
      printf '%s:%s  %s  %s\n' "$(basename "$file")" "$line" "$check" "$detail"
      explain "$check" "$(basename "$file")"
    done
    echo
    echo "[map-shape] $violations violation(s) across $tables table(s), $rows row(s)."
    finish FAIL
  fi

  # POSITIVE per-check output. A row silently skipped by a load error must never look identical
  # to a row that passed, so every check reports what it actually evaluated — never
  # absence-of-violation. This is also where R5's threshold-provenance number comes from: the
  # instrument and the number are the same artifact by construction, so they cannot drift apart.
  local headroom
  headroom=$(LC_ALL=C awk -v m="$maxlen" -v t="$max" 'BEGIN{printf "%.1f", (t>0)?(100-(m*100/t)):0}')
  echo "[map-shape] $(basename "$file") — $tables table(s), $rows row(s) checked."
  echo "  LINE_TOO_LONG        0 violations (max observed ${maxlen} bytes at line ${maxline}; threshold ${max}; ${headroom}% headroom)"
  echo "  CELL_COUNT_MISMATCH  0 violations (every row matches its own header's column count)"
  echo "  TABLE_INTERRUPTED    0 violations (no prose or blank between any table's first and last row)"
  finish PASS
}

# ── the shared target definition ─────────────────────────────────────────────────────────────
# Single-derivation: the vault path is defined ONCE, in scripts/lib/system-map-path.sh, and both
# this gate and check_system_map.sh project from that one value. Two gates on one file that can
# disagree about WHICH file is a defect waiting for the next vault move.
#
# Sourced HERE rather than in the emitted hook block, deliberately: hook-block.sh design
# decision #1 forbids a block from sourcing anything, because a worktree predating the library
# would fail to source and block every commit there. The block invokes `--system-map` and
# carries no path of its own.
resolve_system_map() {
  local lib="$SELF_DIR/lib/system-map-path.sh"
  # An explicit SYSTEM_MAP_PATH needs no resolution — the caller already decided. The library is
  # required only for the DEFAULT, which still exists in exactly one place.
  if [ -n "${SYSTEM_MAP_PATH:-}" ] && [ ! -f "$lib" ]; then
    printf '%s\n' "$SYSTEM_MAP_PATH"; return 0
  fi
  if [ ! -f "$lib" ]; then
    echo "[map-shape] scripts/lib/system-map-path.sh missing from this worktree."
    echo "  The gate cannot determine WHICH file it guards, so it refuses rather than guessing."
    echo "  Recover:  git checkout origin/main -- scripts/lib/system-map-path.sh"
    finish INDETERMINATE
  fi
  # shellcheck source=scripts/lib/system-map-path.sh
  . "$lib"
  printf '%s\n' "$ALGOVAULT_SYSTEM_MAP_PATH"
}

# ═══ SELF-TEST ═══════════════════════════════════════════════════════════════════════════════
# Two-way: it asserts PASS where a pass is correct AND each FAIL/INDETERMINATE where it is not.
#
# It asserts the token→EXIT-CODE MAPPING, not merely the token. That is not belt-and-braces: a
# recorded incident had a suite asserting verdict tokens only, so re-coding INDETERMINATE to 0
# left it fully green while the gate stopped blocking.
#
# It also asserts the artifacts its own seam BYPASSES. A hermetic self-test is structurally
# blind to exactly what its fixtures replace — here that is the real path resolution and the
# real hook wiring, which no fixture scenario would ever touch.
#
# And no assertion may RAISE. An assertion that aborts the suite silently converts "proven able
# to fail" into "crashes"; every scenario below reports SELF-TEST: FAIL(n) instead.
ST_PASS=0
ST_FAIL=0
st_assert() {   # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    ST_PASS=$((ST_PASS + 1))
    echo "  ok   $1  ($3)"
  else
    ST_FAIL=$((ST_FAIL + 1))
    echo "  FAIL $1  expected[$2] actual[$3]"
  fi
}

st_run() {   # <file> [extra args...] -> "VERDICT|rc|output"
  local f="$1"; shift
  local o rc=0
  o=$(ALGOVAULT_SKIP_MAP_SHAPE= bash "$SELF" "$f" "$@" 2>/dev/null) || rc=$?
  printf '%s|%s|%s' "$(printf '%s\n' "$o" | tail -1 | sed 's/^.*_VERDICT=//')" "$rc" "$(printf '%s' "$o" | tr '\n' ' ')"
}

run_self_test() {
  local tmp scenarios=0
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  echo "SELF-TEST: $GATE_NAME"

  # ── Fixture A — clean, WITH a legally escaped pipe in a cell (AC4) ────────────────────────
  cat >"$tmp/a.md" <<'EOF'
# clean

| Component | Role | Repo |
|---|---|---|
| `alpha` | does a thing | github.com/x/alpha |
| `beta` | mode is `shadow\|enforce` here | github.com/x/beta |

trailing prose after the table is fine.
EOF
  local r
  r=$(st_run "$tmp/a.md"); scenarios=$((scenarios + 1))
  st_assert "A clean            verdict" "PASS" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "A clean            exit"    "0"    "$(echo "$r" | cut -d'|' -f2)"
  case "$(echo "$r" | cut -d'|' -f3)" in
    *"2 row(s) checked"*) st_assert "A clean            rows counted" "yes" "yes" ;;
    *)                    st_assert "A clean            rows counted" "yes" "no"  ;;
  esac

  # ── Fixture B1 — LINE_TOO_LONG ────────────────────────────────────────────────────────────
  {
    echo '| Component | Role | Repo |'
    echo '|---|---|---|'
    printf '| `alpha` | '; printf 'x%.0s' $(seq 1 300); printf ' | github.com/x/alpha |\n'
  } >"$tmp/b1.md"
  r=$(st_run "$tmp/b1.md" --max-line 100); scenarios=$((scenarios + 1))
  st_assert "B1 too-long        verdict" "FAIL" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "B1 too-long        exit"    "1"    "$(echo "$r" | cut -d'|' -f2)"
  case "$(echo "$r" | cut -d'|' -f3)" in
    *LINE_TOO_LONG*) st_assert "B1 too-long        names check" "yes" "yes" ;;
    *)               st_assert "B1 too-long        names check" "yes" "no"  ;;
  esac

  # ── Fixture B2 — CELL_COUNT_MISMATCH (the union-type bug, verbatim) ───────────────────────
  cat >"$tmp/b2.md" <<'EOF'
| Component | Role | Repo |
|---|---|---|
| `alpha` | verdict is PASS|FAIL|INDETERMINATE here | github.com/x/alpha |
EOF
  r=$(st_run "$tmp/b2.md"); scenarios=$((scenarios + 1))
  st_assert "B2 cell-count      verdict" "FAIL" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "B2 cell-count      exit"    "1"    "$(echo "$r" | cut -d'|' -f2)"
  case "$(echo "$r" | cut -d'|' -f3)" in
    *CELL_COUNT_MISMATCH*) st_assert "B2 cell-count      names check" "yes" "yes" ;;
    *)                     st_assert "B2 cell-count      names check" "yes" "no"  ;;
  esac

  # ── Fixture B3 — TABLE_INTERRUPTED ────────────────────────────────────────────────────────
  cat >"$tmp/b3.md" <<'EOF'
| Component | Role | Repo |
|---|---|---|
| `alpha` | does a thing | github.com/x/alpha |

a paragraph jammed into the middle of the table.

| `beta` | does another | github.com/x/beta |
EOF
  r=$(st_run "$tmp/b3.md"); scenarios=$((scenarios + 1))
  st_assert "B3 interrupted     verdict" "FAIL" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "B3 interrupted     exit"    "1"    "$(echo "$r" | cut -d'|' -f2)"
  case "$(echo "$r" | cut -d'|' -f3)" in
    *TABLE_INTERRUPTED*) st_assert "B3 interrupted     names check" "yes" "yes" ;;
    *)                   st_assert "B3 interrupted     names check" "yes" "no"  ;;
  esac

  # ── Fixture C — missing file ──────────────────────────────────────────────────────────────
  r=$(st_run "$tmp/does-not-exist.md"); scenarios=$((scenarios + 1))
  st_assert "C missing          verdict" "INDETERMINATE" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "C missing          exit"    "3"             "$(echo "$r" | cut -d'|' -f2)"

  # ── Fixture D — prose, zero tables ────────────────────────────────────────────────────────
  printf 'just prose.\n\nno tables at all here.\n' >"$tmp/d.md"
  r=$(st_run "$tmp/d.md"); scenarios=$((scenarios + 1))
  st_assert "D zero-tables      verdict" "INDETERMINATE" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "D zero-tables      exit"    "3"             "$(echo "$r" | cut -d'|' -f2)"

  # ── Fixture E — a fenced block must not be scanned ─────────────────────────────────────────
  # Without fence-skipping the file-agnostic claim in this header is false: CLAUDE.md and
  # status.md both carry fenced examples holding pipes.
  {
    echo '| Component | Role | Repo |'
    echo '|---|---|---|'
    echo '| `alpha` | fine | github.com/x/alpha |'
    echo ''
    echo '```'
    echo '| this | is | an | example | with | many | pipes |'
    printf 'y%.0s' $(seq 1 400); echo ''
    echo '```'
  } >"$tmp/e.md"
  r=$(st_run "$tmp/e.md" --max-line 100); scenarios=$((scenarios + 1))
  st_assert "E fenced-skipped   verdict" "PASS" "$(echo "$r" | cut -d'|' -f1)"
  st_assert "E fenced-skipped   exit"    "0"    "$(echo "$r" | cut -d'|' -f2)"

  # ── SEAM assertions — the artifacts every fixture above BYPASSES ──────────────────────────
  # A hermetic self-test is structurally blind to exactly what its own seam replaces. Fixtures
  # pass an explicit path, so nothing above ever exercises the real target resolution or the
  # real wiring. Assert both directly, or they are the only code no scenario executes.
  local libf="$SELF_DIR/lib/system-map-path.sh"
  if [ -f "$libf" ]; then
    st_assert "SEAM path-lib      present" "yes" "yes"
    local resolved
    resolved=$( . "$libf"; printf '%s' "$ALGOVAULT_SYSTEM_MAP_PATH" )
    case "$resolved" in
      /*) st_assert "SEAM path-lib      absolute" "yes" "yes" ;;
      *)  st_assert "SEAM path-lib      absolute" "yes" "no"  ;;
    esac
    local overridden
    overridden=$( SYSTEM_MAP_PATH=/tmp/override.md; . "$libf"; printf '%s' "$ALGOVAULT_SYSTEM_MAP_PATH" )
    st_assert "SEAM path-lib      honours SYSTEM_MAP_PATH" "/tmp/override.md" "$overridden"
    # The sibling MUST consume the same definition — that is the whole point of extracting it.
    if grep -q 'lib/system-map-path.sh' "$SELF_DIR/check_system_map.sh" 2>/dev/null; then
      st_assert "SEAM sibling       shares the definition" "yes" "yes"
    else
      st_assert "SEAM sibling       shares the definition" "yes" "no"
    fi
  else
    st_assert "SEAM path-lib      present" "yes" "no"
  fi
  scenarios=$((scenarios + 1))

  # The installed hook, if present, must invoke --system-map and carry NO path of its own.
  # Asserting the BYPASSED wiring, not a fixture of it.
  local hookp
  hookp=$(git config --get core.hooksPath 2>/dev/null || echo "")
  if [ -n "$hookp" ] && [ -f "$hookp/pre-commit" ] && grep -q 'algovault map-shape' "$hookp/pre-commit"; then
    if grep -q 'check_map_shape.sh" --system-map' "$hookp/pre-commit"; then
      st_assert "SEAM hook          invokes --system-map" "yes" "yes"
    else
      st_assert "SEAM hook          invokes --system-map" "yes" "no"
    fi
    if grep -q 'Obsidian Vault' "$hookp/pre-commit"; then
      st_assert "SEAM hook          carries no literal path" "yes" "no"
    else
      st_assert "SEAM hook          carries no literal path" "yes" "yes"
    fi
  else
    echo "  note hook block not installed in this checkout — wiring assertions skipped"
  fi

  # ── VACUITY GUARD — at the point the corpus is CONSTRUCTED ────────────────────────────────
  # In --self-test WE build the fixtures, so an empty scenario set means the test built nothing.
  # That is a defect in the TEST, and it REFUSES. (At runtime the world builds the corpus, which
  # is why zero tables there is INDETERMINATE rather than this.)
  if [ "$scenarios" -eq 0 ] || [ "$((ST_PASS + ST_FAIL))" -eq 0 ]; then
    echo "SELF-TEST: REFUSE — zero scenarios ran; the suite built no corpus."
    finish INDETERMINATE
  fi

  echo "SELF-TEST: $ST_PASS passed, $ST_FAIL failed, across $scenarios scenarios."
  if [ "$ST_FAIL" -gt 0 ]; then finish FAIL; fi
  finish PASS
}

# ── argument parsing ─────────────────────────────────────────────────────────────────────────
main() {
  local target="" max="$DEFAULT_MAX_LINE" mode=file

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --self-test)  mode=selftest; shift ;;
      --system-map) mode=systemmap; shift ;;
      --max-line)
        [ "$#" -ge 2 ] || { echo "[map-shape] --max-line needs a value"; finish INDETERMINATE; }
        max="$2"; shift 2 ;;
      -h|--help)    sed -n '2,60p' "$SELF"; exit 0 ;;
      -*)           echo "[map-shape] unknown flag: $1"; finish INDETERMINATE ;;
      *)            target="$1"; shift ;;
    esac
  done

  case "$max" in
    ''|*[!0-9]*) echo "[map-shape] --max-line must be a positive integer, got: '$max'"
                 finish INDETERMINATE ;;
  esac

  case "$mode" in
    selftest)  run_self_test ;;
    systemmap) target=$(resolve_system_map); run_gate "$target" "$max" ;;
    file)
      if [ -z "$target" ]; then
        echo "[map-shape] no target given."
        echo "  usage: check_map_shape.sh <file> [--max-line N] | --system-map | --self-test"
        finish INDETERMINATE
      fi
      run_gate "$target" "$max" ;;
  esac
}

[ "$MAP_SHAPE_SOURCED" = "1" ] && return 0 2>/dev/null
main "$@"
