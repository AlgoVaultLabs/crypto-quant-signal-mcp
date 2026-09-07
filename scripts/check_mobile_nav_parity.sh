#!/usr/bin/env bash
# check_mobile_nav_parity.sh — CI parity canary (mobile-nav-header waves).
#
# Invariant A (MOBILE-NAV-HEADER-LANDING): every surface that ships the DESKTOP nav-links
#   container (`hidden sm:flex items-center gap-6`) MUST also ship the mobile-nav equivalent —
#   a `data-mobile-nav-toggle` hamburger AND a `#mobile-menu` (a.k.a. `data-mobile-nav-panel`)
#   slide-down panel.
#
# Invariant B (CONVERSION-SURFACES-W2 CH1): the same surface MUST ship EXACTLY ONE
#   `data-mobile-signup-pill`, and it MUST sit OUTSIDE `#mobile-menu` — i.e. in the header row,
#   reachable without opening the hamburger. A pill that renders only inside the collapsed panel
#   is the exact defect this wave retires (81% of /verify entrants are on mobile), and it is
#   indistinguishable from a correct one on a presence-only check. Position is therefore part of
#   the assertion, not a comment.
#
# Scope:
#   - RECURSIVE over landing/**/*.html — static pages incl. landing/integrations/*.html.
#   - RECURSIVE over src/**/*.ts — FUNCTION-RENDERED navs; currently the shared
#     src/lib/site-nav.ts generator. Any future rendered page that inlines a nav instead of
#     calling renderSiteNav() is caught here.
#
# VERDICT CONTRACT (CLAUDE.md § Verification gate patterns — token law).
#   This gate CAN fail open (an unreadable tree, a missing corpus), so it prints exactly ONE
#   terminal machine-readable line and callers gate on the TOKEN, never the bare exit code:
#       MOBILE_NAV_PARITY_VERDICT=PASS|FAIL|INDETERMINATE
#   Codes: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE.
#   3 (not 2) because this gate deploys no incumbent code for "could not verify", so it takes the
#   token-law default for a NEW gate. check_test_baseline.sh keeps 2 because it already shipped 2;
#   nothing reads both code spaces, and they must not be "aligned".
#
#   VACUITY, per the construction-vs-observation rule: in --self-test WE build the corpus, so an
#   empty one is a defect in the test -> REFUSE (INDETERMINATE). At runtime the WORLD builds it,
#   but this repo is the corpus's author too: `landing/` and `src/` are ours and are never legitimately
#   both absent, so zero scannable files is INDETERMINATE, never a silent pass. A surface we DID read
#   and found nav-less is a FACT, and contributes nothing either way.
#
# Standalone run:  bash scripts/check_mobile_nav_parity.sh
#                  bash scripts/check_mobile_nav_parity.sh --self-test
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || ROOT=""
DESKTOP_SIG='hidden sm:flex items-center gap-6'
TOGGLE_SIG='data-mobile-nav-toggle'
PANEL_SIG_A='id="mobile-menu"'
PANEL_SIG_B='data-mobile-nav-panel'
PILL_SIG='data-mobile-signup-pill'

# ── verdict emission ──────────────────────────────────────────────────────────────────────
# ONE terminal token per run, on stdout, always. `emit FAIL/INDETERMINATE` never returns.
emit() {
  echo "MOBILE_NAV_PARITY_VERDICT=$1"
  case "$1" in
    PASS) exit 0 ;;
    FAIL) exit 1 ;;
    *)    exit 3 ;;
  esac
}

fail=0
scanned=0
offenders=""

# Count non-overlapping occurrences of a FIXED string in a file. Never fails the script:
# grep -c exits 1 on zero matches, which under `set -e` would read as an error rather than a zero.
count_of() { grep -oaF "$2" "$1" 2>/dev/null | wc -l | tr -d ' '; }

# A file "ships a nav" if it contains the desktop nav-links signature; if so it MUST also ship
# the mobile toggle + panel (A) and exactly one pill outside #mobile-menu (B).
# Modifies globals fail/offenders/scanned.
check_file() {
  f="$1"
  grep -qaF "$DESKTOP_SIG" "$f" 2>/dev/null || return 0
  scanned=$((scanned+1))
  miss=""

  grep -qaF "$TOGGLE_SIG" "$f" 2>/dev/null || miss="${miss} [missing hamburger: ${TOGGLE_SIG}]"
  if ! grep -qaF "$PANEL_SIG_A" "$f" 2>/dev/null && ! grep -qaF "$PANEL_SIG_B" "$f" 2>/dev/null; then
    miss="${miss} [missing panel: ${PANEL_SIG_A} | ${PANEL_SIG_B}]"
  fi

  # Invariant B — count, then POSITION. Byte offsets, so it works on minified single-line HTML
  # as well as pretty-printed TS template literals.
  pills="$(count_of "$f" "$PILL_SIG")"
  if [ "$pills" != "1" ]; then
    miss="${miss} [expected exactly 1 ${PILL_SIG}, found ${pills}]"
  else
    pill_at="$(grep -oab "$PILL_SIG" "$f" 2>/dev/null | head -1 | cut -d: -f1)"
    panel_at="$(grep -oab "$PANEL_SIG_A" "$f" 2>/dev/null | head -1 | cut -d: -f1)"
    [ -n "$panel_at" ] || panel_at="$(grep -oab "$PANEL_SIG_B" "$f" 2>/dev/null | head -1 | cut -d: -f1)"
    if [ -n "$pill_at" ] && [ -n "$panel_at" ] && [ "$pill_at" -gt "$panel_at" ]; then
      miss="${miss} [${PILL_SIG} sits INSIDE the collapsed panel — it must render in the header row]"
    fi
  fi

  if [ -n "$miss" ]; then
    offenders="${offenders}
  - ${f#"$ROOT"/} —${miss}"
    fail=1
  fi
}

# Process substitution (not a pipe) so the while loop runs in the current shell and check_file's
# updates to fail/offenders/scanned persist.
scan_dir() {
  dir="$1"; pattern="$2"
  [ -d "$dir" ] || return 0
  while IFS= read -r f; do check_file "$f"; done < <(find "$dir" -type f -name "$pattern" | sort)
}

run_scan() {
  fail=0; scanned=0; offenders=""
  scan_dir "$1/landing" '*.html'
  scan_dir "$1/src" '*.ts'
}

# ── report ────────────────────────────────────────────────────────────────────────────────
report() {
  if [ -z "$ROOT" ] || { [ ! -d "$ROOT/landing" ] && [ ! -d "$ROOT/src" ]; }; then
    echo "✗ mobile-nav parity INDETERMINATE — neither landing/ nor src/ is readable under '${ROOT:-<unresolved>}'." >&2
    emit INDETERMINATE
  fi
  if [ "$scanned" -eq 0 ]; then
    echo "✗ mobile-nav parity INDETERMINATE — 0 surfaces carry the desktop signature '${DESKTOP_SIG}'." >&2
    echo "  This repo authors that corpus, so zero is 'the check read nothing', never 'nothing was wrong'." >&2
    emit INDETERMINATE
  fi
  if [ "$fail" -ne 0 ]; then
    echo "✗ mobile-nav parity FAILED — ${scanned} surface(s) scanned:$offenders" >&2
    echo "" >&2
    echo "Fix (static landing/*.html): regenerate via scripts/build_nav.mjs — never hand-edit a nav region." >&2
    echo "Fix (function-rendered): render the nav via src/lib/site-nav.ts renderSiteNav()." >&2
    echo "Fix (pill): it is rendered by mobileHeaderCluster() in the header row, NOT in #mobile-menu." >&2
    emit FAIL
  fi
  echo "✓ mobile-nav parity OK — ${scanned} surface(s): hamburger + panel present, exactly one ${PILL_SIG} in the header row."
  emit PASS
}

# ── self-test — build BOTH verdicts from fixtures, and assert the token→exit-code mapping ──
# Hermetic by construction, so it is structurally blind to the real tree. It therefore asserts
# the two BYPASSED artifacts explicitly: the byte-offset position predicate (on a fixture whose
# pill sits inside the panel) and the exit code each token maps to.
if [ "${1:-}" = "--self-test" ]; then
  st_fail=0
  st() { # name expected_verdict expected_code dir
    got_out="$(run_selftest_case "$4" 2>&1)"; got_rc=$?
    got_tok="$(printf '%s' "$got_out" | grep -o 'MOBILE_NAV_PARITY_VERDICT=[A-Z]*' | tail -1)"
    if [ "$got_tok" != "MOBILE_NAV_PARITY_VERDICT=$2" ] || [ "$got_rc" != "$3" ]; then
      echo "SELF-TEST: FAIL ($1) — got '$got_tok' rc=$got_rc, want 'MOBILE_NAV_PARITY_VERDICT=$2' rc=$3" >&2
      st_fail=$((st_fail+1))
    else
      echo "SELF-TEST: ok ($1) -> $got_tok rc=$got_rc"
    fi
  }
  run_selftest_case() { ( ROOT="$1"; run_scan "$1"; report ) }

  TMP="$(mktemp -d)" || emit INDETERMINATE
  trap 'rm -rf "$TMP"' EXIT

  NAV_OK='<div class="hidden sm:flex items-center gap-6">x</div><a data-mobile-signup-pill>Signup</a><button data-mobile-nav-toggle></button><div id="mobile-menu"></div>'
  NAV_PILL_IN_PANEL='<div class="hidden sm:flex items-center gap-6">x</div><button data-mobile-nav-toggle></button><div id="mobile-menu"><a data-mobile-signup-pill>Signup</a></div>'
  NAV_NO_PILL='<div class="hidden sm:flex items-center gap-6">x</div><button data-mobile-nav-toggle></button><div id="mobile-menu"></div>'
  NAV_TWO_PILLS='<div class="hidden sm:flex items-center gap-6">x</div><a data-mobile-signup-pill>a</a><a data-mobile-signup-pill>b</a><button data-mobile-nav-toggle></button><div id="mobile-menu"></div>'

  mk() { mkdir -p "$TMP/$1/landing"; printf '%s' "$2" > "$TMP/$1/landing/p.html"; }
  mk pass "$NAV_OK"
  mk inpanel "$NAV_PILL_IN_PANEL"
  mk nopill "$NAV_NO_PILL"
  mk twopills "$NAV_TWO_PILLS"
  mkdir -p "$TMP/empty"   # corpus we were supposed to fill, and did not

  st 'clean surface'                 PASS          0 "$TMP/pass"
  st 'pill inside collapsed panel'   FAIL          1 "$TMP/inpanel"
  st 'pill absent'                   FAIL          1 "$TMP/nopill"
  st 'two pills'                     FAIL          1 "$TMP/twopills"
  st 'empty corpus (vacuity)'        INDETERMINATE 3 "$TMP/empty"

  if [ "$st_fail" -ne 0 ]; then
    echo "✗ self-test FAILED ($st_fail case(s))" >&2
    emit INDETERMINATE
  fi
  echo "✓ self-test OK — 5 cases, both verdicts and the token→exit-code mapping asserted."
  emit PASS
fi

run_scan "$ROOT"
report
