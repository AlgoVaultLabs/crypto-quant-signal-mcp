#!/usr/bin/env bash
# CONVERSION-SURFACES-W2 — the four chapter gates, with every count HARD-CODED from Step 0
# rather than left as a `>=` the wave could satisfy by accident.
#
# Recorded verdicts, run against LIVE after each chapter's deploy (2026-09-07):
#   CH1_GREEN  ·  CH2_GREEN  ·  CH3_GREEN  ·  CH4_GREEN
#
# TWO DEVIATIONS FROM THE SPEC'S GATE TEXT, both because the committed text could not express
# the assertion it names:
#
#   CH2  The spec diffs the raw rendered text of `/`. It cannot: deploy.yml runs
#        snapshot-landing-data.mjs BEFORE `cp landing/*.html`, and two live captures 40 minutes
#        apart with NO deploy between them moved call_count 612,422 -> 615,255 and
#        total_calls_executed 67,317,144 -> 67,446,142. A raw diff measures the SNAPSHOT CADENCE,
#        not the wave, and would report RED for a page nobody edited. Both sides now go through
#        scripts/landing-text-normalize.mjs — ONE derivation, so they cannot drift apart.
#
#   CH3  `grep -q` on a whole page, not `grep -c '…' = 1`: landing pages are minified to one line
#        per artboard, so a line count says 1 for a page with two bands and 10 for the attribute
#        token. tests/unit/conversion-band.test.ts asserts the real property (bands === brand
#        footers) over the committed artifact.
set -u
cd "$(git rev-parse --show-toplevel)"
FAIL=0

# ── CH1 — the Signup pill renders in the <640px header row, not inside the panel ──────────────
out=$(bash scripts/check_mobile_nav_parity.sh 2>&1); rc=$?
tok=$(printf '%s' "$out" | grep -o 'MOBILE_NAV_PARITY_VERDICT=[A-Z]*' | tail -1)
pill=$(curl -s --max-time 15 https://algovault.com/verify | grep -c 'data-mobile-signup-pill') || pill=-1
if [ "$tok" = "MOBILE_NAV_PARITY_VERDICT=INDETERMINATE" ] || [ -z "$tok" ] || [ "$pill" = "-1" ]; then
  echo "CH1_INDETERMINATE $tok rc=$rc pill=$pill"; FAIL=3
elif [ "$tok" = "MOBILE_NAV_PARITY_VERDICT=PASS" ] && [ "$pill" -ge 1 ]; then echo CH1_GREEN
else echo "CH1_RED $tok pill=$pill"; FAIL=1; fi

# ── CH2 — landing: text unchanged, anchors twinned, doors tagged, COPY wired ──────────────────
# EXPECT_TAGS is EXACT, from Step 0: hero telegram + hero track-record + trust start-free +
# quickstart COPY = 4 doors, x2 artboards = 8. A new door must move this number deliberately.
EXPECT_TAGS=8
h=$(curl -s --max-time 20 https://algovault.com/) || h=''
if [ -z "$h" ] || [ ! -f audits/landing-text-before.txt ]; then
  echo "CH2_INDETERMINATE empty_fetch_or_missing_snapshot"; FAIL=3
else
  now=$(printf '%s' "$h" | node scripts/landing-text-normalize.mjs)
  was=$(cat audits/landing-text-before.txt)
  anch=$(printf '%s' "$h" | grep -o 'data-anchor="quickstart"' | wc -l | tr -d ' ')
  tags=$(printf '%s' "$h" | grep -o 'plausible-event-location=hero\|plausible-event-location=quickstart\|plausible-event-location=trust' | wc -l | tr -d ' ')
  clip=$(printf '%s' "$h" | grep -c 'navigator.clipboard')
  if [ "$now" = "$was" ] && [ "$anch" = "2" ] && [ "$tags" = "$EXPECT_TAGS" ] && [ "$clip" -ge 1 ]; then echo CH2_GREEN
  else echo "CH2_RED text_changed=$([ "$now" = "$was" ] && echo no || echo YES) anchors=$anch tags=$tags clip=$clip"; FAIL=1; fi
fi

# ── CH3 — the band reaches every content page and NO excluded one ─────────────────────────────
miss=0; leak=0; net=0
# FETCH and COUNT are separated deliberately. Piping curl into `grep -c` collapses them: grep
# exits 1 when it counts ZERO, which on the EXCLUDED list is the DESIRED result — so a
# `|| net=1` on that pipeline reported INDETERMINATE for a perfectly healthy wave. Measured: the
# first draft of this gate did exactly that and said CH3_INDETERMINATE while every page was
# correct. "Could not fetch" and "fetched, found none" are different facts and must be read from
# different places (curl's status vs the count).
band_count() { printf '%s' "$1" | grep -o 'data-conversion-band' | wc -l | tr -d ' '; }
for u in https://algovault.com/verify https://algovault.com/docs https://algovault.com/integrations/cline \
         https://algovault.com/track-record https://algovault.com/skills https://algovault.com/mcp; do
  b=$(curl -sf --max-time 20 "$u") || { net=1; continue; }
  [ "$(band_count "$b")" -ge 1 ] || miss=$((miss+1)); done
for u in https://algovault.com/ https://algovault.com/privacy https://api.algovault.com/welcome \
         https://api.algovault.com/account https://api.algovault.com/signup https://algovault.com/referral; do
  b=$(curl -sf --max-time 20 "$u") || { net=1; continue; }
  [ "$(band_count "$b")" = "0" ] || leak=$((leak+1)); done
if [ "$net" = "1" ]; then echo CH3_INDETERMINATE; FAIL=3
elif [ "$miss" = "0" ] && [ "$leak" = "0" ]; then echo CH3_GREEN
else echo "CH3_RED missing=$miss leaked_onto_excluded=$leak"; FAIL=1; fi

# ── CH4 — /welcome carries the canonical tagline and none of the three retired claims ─────────
w=$(curl -s --max-time 20 https://api.algovault.com/welcome) || w=''
if [ -z "$w" ]; then echo CH4_INDETERMINATE; FAIL=3
else
  ok=$(printf '%s' "$w" | grep -c 'The Brain Layer for AI Trading Agents')
  bad=$(printf '%s' "$w" | grep -c -i 'crypto signal layer\|unlimited Telegram\|full asset coverage')
  if [ "$ok" -ge 1 ] && [ "$bad" = "0" ]; then echo CH4_GREEN
  else echo "CH4_RED tagline=$ok forbidden=$bad"; FAIL=1; fi
fi

exit "$FAIL"
