#!/usr/bin/env bash
# closedbar-w1-liveness.sh — SIGNAL-CLOSEDBAR-SHADOW-W1 CH6 AC8
#                            + OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W1 R2
#
# Live confirmation that watchlist dispatch is bucket-deterministic and late-bar. Determinism
# itself is proven OFFLINE by unit test; this exists because it cannot be proven at gate time
# (post-fix 15m fires need ~45-60 min of wall clock, and alerts_fired records only non-HOLD
# verdicts).
#
# ── R2: this probe used to recommend a HARMFUL action ────────────────────────
# It inherited `recommended_wave` from the READINESS alert, so a genuine regression told the
# operator to run the wave that sets ALGOVAULT_BOT_DISPATCH_OFFSET_PCT=0 — which would have
# RATIFIED the broken state as intended, and additionally retuned live thresholds against a
# shadow window one day old. One `recommended_wave` shared by two alerts with opposite
# remedies is a generator bug: a correct detector pointing at the wrong action is worse than
# no detector. This file now owns its remedy and never references that wave.
#
# ── R2: two DISTINCT faults, two ids ─────────────────────────────────────────
# The 2026-08-01 incident fired RATCHET_REGRESSION and the name was RIGHT — a full-tree rsync
# from a stale checkout had deleted dispatch_schedule.py, reverting prod to the relative-age
# scheduler. Sixteen rows hand-computed at the time were scattered from 5s to 11,286s into
# their bars (three 15m rows at 184s/184s/844s SIMULTANEOUSLY). No single offset value can
# produce that; independent per-row drift can. So:
#   scattered offsets  -> CLOSEDBAR_DISPATCH_RATCHET_REGRESSION  (the anchor is drifting)
#   tight but early    -> CLOSEDBAR_DISPATCH_OFFSET_FAULT        (bucket ok, offset wrong)
# Conflating them sends the operator to the wrong repair.
#
# ── Timestamp handling, corrected against the live DB ────────────────────────
# `fired_at` / `last_fetched_at` are SQLite `datetime('now')` TEXT — 'YYYY-MM-DD HH:MM:SS',
# SPACE separated, NOT 'YYYY-MM-DDTHH:MM:SSZ'. Two consequences, both measured:
#   1. Comparing such a string to a T-separated deploy stamp is wrong in the DANGEROUS
#      direction: ' ' (0x20) sorts BEFORE 'T' (0x54), so every row reads as older than the
#      deploy, the filter matches nothing, and the check passes VACUOUSLY.
#   2. `strftime('%s', …)` works correctly on this column (verified: '2026-08-01 09:15:09' ->
#      1785575709) — but it returns TEXT, and SQLite orders every INTEGER before every TEXT,
#      so `strftime('%s',…) > 1785589769` is ALWAYS TRUE. That bug was live in CHECK2 and was
#      caught by this incident's R0: the predicate returned 1792 rows including 2026-07-31
#      ones. Hence the explicit CAST below.
#
# Exit 0 always (a probe must not wedge its timer); operator-action-required failures go out
# through the shared send_telegram.sh, which owns cooldown / severity / fail-open. Silent on
# success.
set -uo pipefail

DB=${CLOSEDBAR_DB:-/var/lib/algovault-bot/state.db}
SQLITE=(sqlite3 -cmd '.timeout 5000')
TG=${CLOSEDBAR_TG:-/opt/algovault-monitoring/send_telegram.sh}
# When the CURRENTLY-RUNNING bot code went live. Read from a host stamp the deploy writes, so
# a redeploy cannot leave this probe judging rows against a stale baseline — which is exactly
# what happened on 2026-08-01: the constant still pointed at the 13:09 CH6 deploy while the
# code had been replaced at 15:45, so the realignment window was silently skipped and the
# probe judged rows that were still carrying pre-fix anchors. Falls back to the baked value.
DEPLOY_STAMP=${CLOSEDBAR_DEPLOY_STAMP:-/opt/algovault-bot/DEPLOYED_AT}
DEPLOY_EPOCH="__DEPLOY_EPOCH__"
if [ -r "$DEPLOY_STAMP" ]; then
  _stamped=$(head -1 "$DEPLOY_STAMP" 2>/dev/null | tr -dc '0-9')
  [ -n "$_stamped" ] && DEPLOY_EPOCH="$_stamped"
fi
CHAT_ID=8776880162
COIN=ETH
TF=15m
TF_SECONDS=900
EXCHANGE=BINANCE
LOG=${CLOSEDBAR_LOG:-/var/log/closedbar-w1-liveness.log}

# Jitter may span ALGOVAULT_BOT_JITTER_WINDOW_MIN (default 3) minutes, plus one 60s scheduler
# tick. 300s leaves headroom above that 240s legitimate spread without masking a real drift,
# which grows by ~60s per period and blows past it within a few bars.
SCATTER_THRESHOLD=300

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

# ── pure helpers (exercised hermetically by --self-test) ─────────────────────

# Accepts either an all-digit epoch or SQLite's 'YYYY-MM-DD HH:MM:SS' TEXT. Empty on failure.
iso_to_epoch() {
  local v="${1:-}"
  [ -z "$v" ] && { printf ''; return 1; }
  case "$v" in
    *[!0-9]*) ;;                      # has non-digits -> parse as a datetime
    *) printf '%s' "$v"; return 0 ;;  # already an epoch
  esac
  # GNU (the Hetzner host) first, then BSD/macOS — the committed copy has to be runnable
  # from a laptop too, or "there is a committed ancestor" is true but useless. Third
  # BSD-portability bug in this guard layer after `wc -l` and `mktemp`'s XXXXXX.
  date -u -d "$v UTC" +%s 2>/dev/null \
    || date -u -j -f '%Y-%m-%d %H:%M:%S' "$v" +%s 2>/dev/null \
    || printf ''
}

secs_into_bar() {   # <timestamp|epoch> <period_seconds>
  local e; e=$(iso_to_epoch "${1:-}") || { printf ''; return 1; }
  [ -z "$e" ] && { printf ''; return 1; }
  printf '%s' "$(( e % ${2} ))"
}

# ── The expected band is DERIVED from the bot's live dispatch config ─────────
# SIGNAL-CLOSEDBAR-FLIP-W1 CH5. This used to hardcode "late is >= 2/3 of the bar, which is
# where OFFSET_PCT=75 plus grace and jitter lands". That literal was correct only for the
# offset in force when it was written, and the flip moved OFFSET_PCT 75 -> 0 — which would
# have made EVERY correct post-flip fire (now ~1/60 of the bar in) read as OFFSET_FAULT. A
# guard that pages on correct behaviour gets muted, and a muted guard is worse than none.
#
# So the band is a FUNCTION of the same knobs the dispatcher reads, taken from the bot's own
# env file. Change the offset and this follows; there is no second copy to update.
BOT_ENV=${CLOSEDBAR_BOT_ENV:-/etc/algovault-bot/env}
_bot_cfg() {   # <VAR> <default>  — default applies when the file or key is unreadable
  local v=""
  [ -r "$BOT_ENV" ] && v=$(grep -E "^$1=" "$BOT_ENV" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'\'' ')
  case "$v" in (''|*[!0-9]*) printf '%s' "$2";; (*) printf '%s' "$v";; esac
}
# Named, so the self-test can assert the ACTUAL fallback rather than re-supplying its own —
# an unreadable env must never fall back to a band that pages on correct behaviour.
DEFAULT_OFFSET_PCT=0
DEFAULT_GRACE_MIN=1
DEFAULT_JITTER_MIN=1
OFFSET_PCT=${CLOSEDBAR_OFFSET_PCT:-$(_bot_cfg ALGOVAULT_BOT_DISPATCH_OFFSET_PCT "$DEFAULT_OFFSET_PCT")}
GRACE_MIN=${CLOSEDBAR_GRACE_MIN:-$(_bot_cfg ALGOVAULT_BOT_CLOSE_GRACE_MIN "$DEFAULT_GRACE_MIN")}
JITTER_MIN=${CLOSEDBAR_JITTER_MIN:-$(_bot_cfg ALGOVAULT_BOT_DISPATCH_JITTER_MIN "$DEFAULT_JITTER_MIN")}
TICK_SECONDS=60   # OnCalendar=*:*:00 — the scheduler grid, so a due time rounds UP to it

band_lo() { printf '%s' "$(( $1 * OFFSET_PCT / 100 ))"; }
band_hi() {   # offset + grace + jitter spread + one tick of quantization, clamped inside the bar
  local hi=$(( $1 * OFFSET_PCT / 100 + GRACE_MIN * 60 + JITTER_MIN * 60 + TICK_SECONDS ))
  [ "$hi" -ge "$1" ] && hi=$(( $1 - 1 ))
  printf '%s' "$hi"
}

# <period> <offset…> -> OK | OFFSET_FAULT | RATCHET | INSUFFICIENT
classify_offsets() {
  local period="$1"; shift
  local lo hi; lo=$(band_lo "$period"); hi=$(band_hi "$period")
  local n=0 min=-1 max=-1 inband=0 o
  for o in "$@"; do
    [ -z "$o" ] && continue
    n=$((n + 1))
    [ "$min" -lt 0 ] && min=$o
    [ "$o" -lt "$min" ] && min=$o
    [ "$o" -gt "$max" ] && max=$o
    if [ "$o" -ge "$lo" ] && [ "$o" -le "$hi" ]; then inband=$((inband + 1)); fi
  done
  [ "$n" -eq 0 ] && { printf 'INSUFFICIENT'; return 0; }
  [ "$inband" -eq "$n" ] && { printf 'OK'; return 0; }
  if [ $(( max - min )) -gt "$SCATTER_THRESHOLD" ]; then printf 'RATCHET'; else printf 'OFFSET_FAULT'; fi
}

# recommended_wave is TEMPLATED — a literal wave number in this field is HALT-class, and it
# must never resolve to the basis-flip wave, whose remedy is the opposite of this one.
alert_id_for() {
  case "$1" in
    RATCHET) printf 'CLOSEDBAR_DISPATCH_RATCHET_REGRESSION';;
    OFFSET_FAULT) printf 'CLOSEDBAR_DISPATCH_OFFSET_FAULT';;
  esac
}
recommended_wave_for() {
  case "$1" in
    RATCHET) printf 'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}';;
    OFFSET_FAULT) printf 'OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W{NEXT}';;
  esac
}

fail() {   # <verdict: RATCHET|OFFSET_FAULT> <detail>
  local verdict="$1"; shift
  local aid; aid=$(alert_id_for "$verdict")
  local wave; wave=$(recommended_wave_for "$verdict")
  log "FAIL [$aid] $*"
  printf '🛑 %s\n\n%s\n\nRow: chat %s %s/%s/%s\nExpected: %ss..%ss into the %ss bar (OFFSET_PCT=%s + grace %smin + jitter %smin + tick)\nProbe: %s\nRollback: see status.md SIGNAL-CLOSEDBAR-SHADOW-W1 CH6\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$aid" "$*" "$CHAT_ID" "$COIN" "$TF" "$EXCHANGE" \
    "$(band_lo "$TF_SECONDS")" "$(band_hi "$TF_SECONDS")" "$TF_SECONDS" \
    "$OFFSET_PCT" "$GRACE_MIN" "$JITTER_MIN" "$0" "$wave" \
    | "$TG" "$aid" CRITICAL_PERSISTENT - || true
  exit 0
}

# ── --self-test: hermetic, no DB, no host access, vacuity-guarded ────────────
self_test() {
  local pass=0 fire=0 nofire=0 map=0 failures=0
  check() {  # <label> <expected> <actual>
    if [ "$2" = "$3" ]; then pass=$((pass + 1));
    else echo "  FAIL $1: expected '$2' got '$3'"; failures=$((failures + 1)); fi
  }

  # must-map: the timestamp shapes that actually occur, ISO and epoch alike.
  map=$((map + 1)); check "iso->epoch"        "1785575709" "$(iso_to_epoch '2026-08-01 09:15:09')"
  map=$((map + 1)); check "epoch passthrough" "1785575709" "$(iso_to_epoch '1785575709')"
  map=$((map + 1)); check "iso secs_into_bar" "9"          "$(secs_into_bar '2026-08-01 09:15:09' 900)"
  map=$((map + 1)); check "epoch secs_into_bar" "9"        "$(secs_into_bar '1785575709' 900)"
  # The literal that fired the 2026-08-01 incident, both shapes -> the same 5s.
  map=$((map + 1)); check "incident iso"      "5"          "$(secs_into_bar '2026-08-01 14:45:05' 900)"
  map=$((map + 1)); check "incident epoch"    "5"          "$(secs_into_bar '1785595505' 900)"
  # A T-separated stamp must NOT silently parse to something plausible-but-wrong.
  map=$((map + 1)); check "unparseable -> empty" ""        "$(secs_into_bar 'not-a-timestamp' 900)"

  # ── The band FOLLOWS the config, and THAT is the property under test ───────
  # Each scenario states the dispatch regime it is exercising. A hardcoded fraction passes
  # the pre-flip half and silently inverts on the post-flip half — which is precisely the
  # defect SIGNAL-CLOSEDBAR-FLIP-W1 would have shipped, so both halves are asserted with the
  # SAME fixtures and OPPOSITE expectations. If a future edit re-hardcodes the band, one half
  # of every pair below fails.
  _cfg_saved="$OFFSET_PCT $GRACE_MIN $JITTER_MIN"
  _with_cfg() { OFFSET_PCT=$1; GRACE_MIN=$2; JITTER_MIN=$3; }

  # POST-FLIP regime: OFFSET_PCT=0, grace 1, jitter 1 -> band [0, 180] on a 900s bar
  _with_cfg 0 1 1
  nofire=$((nofire + 1)); check "post-flip bar-close cluster -> OK"      "OK"           "$(classify_offsets 900 5 6 5)"
  nofire=$((nofire + 1)); check "post-flip 1h bar-close -> OK"           "OK"           "$(classify_offsets 3600 12 61 130)"
  fire=$((fire + 1));     check "post-flip LATE cluster -> OFFSET_FAULT" "OFFSET_FAULT" "$(classify_offsets 900 824 824 824)"

  # PRE-FLIP regime: OFFSET_PCT=75, grace 1, jitter 3 -> band [675, 899] on a 900s bar.
  # Same fixtures, inverted verdicts — the band moved because the CONFIG moved.
  _with_cfg 75 1 3
  nofire=$((nofire + 1)); check "pre-flip measured steady state -> OK"    "OK"           "$(classify_offsets 900 824 824 824)"
  nofire=$((nofire + 1)); check "pre-flip jitter spread -> OK"            "OK"           "$(classify_offsets 900 735 795 855)"
  nofire=$((nofire + 1)); check "pre-flip 1h late-bar -> OK"              "OK"           "$(classify_offsets 3600 2944 2945 2942)"
  fire=$((fire + 1));     check "pre-flip bar-close cluster -> OFFSET_FAULT" "OFFSET_FAULT" "$(classify_offsets 900 5 6 5)"
  fire=$((fire + 1));     check "pre-flip mid-bar cluster -> OFFSET_FAULT"   "OFFSET_FAULT" "$(classify_offsets 900 300 310 295)"

  # Scatter dominates regardless of regime — a ratchet is a ratchet under either band.
  _with_cfg 0 1 1
  fire=$((fire + 1)); check "incident scatter -> RATCHET (post-flip band)" "RATCHET" "$(classify_offsets 900 184 184 844)"
  _with_cfg 75 1 3
  fire=$((fire + 1)); check "incident scatter -> RATCHET (pre-flip band)"  "RATCHET" "$(classify_offsets 900 184 184 844)"
  fire=$((fire + 1)); check "wide scatter -> RATCHET"                      "RATCHET" "$(classify_offsets 900 5 450 880)"

  # An unreadable/absent bot env must fall back to the POST-FLIP defaults, never to a band
  # that would page on correct behaviour. Asserted against the DEFAULT_* constants the real
  # call site uses — an earlier version re-supplied its own default to _bot_cfg, which tested
  # the helper's fallback mechanism while the actual default could be anything (it survived a
  # deliberate 0 -> 75 mutation, i.e. it could not fail).
  map=$((map + 1)); check "absent-env default offset is post-flip" "0" "$DEFAULT_OFFSET_PCT"
  map=$((map + 1)); check "absent-env default grace"              "1" "$DEFAULT_GRACE_MIN"
  map=$((map + 1)); check "absent-env default jitter"             "1" "$DEFAULT_JITTER_MIN"
  map=$((map + 1)); check "_bot_cfg falls back when file absent"  "7" \
    "$( BOT_ENV=/nonexistent _bot_cfg ALGOVAULT_BOT_DISPATCH_OFFSET_PCT 7 )"
  map=$((map + 1)); check "_bot_cfg rejects a non-numeric value"  "3" \
    "$( BOT_ENV=/dev/null _bot_cfg ALGOVAULT_BOT_DISPATCH_OFFSET_PCT 3 )"

  set -- $_cfg_saved; _with_cfg "$1" "$2" "$3"
  nofire=$((nofire + 1)); check "empty -> INSUFFICIENT"  "INSUFFICIENT" "$(classify_offsets 900)"
  # Ordering regression guard: a row whose last fire predates a JUST-completed deploy is
  # REALIGNING, never a ratchet. Encoded as the arithmetic the live path uses, since the branch
  # itself needs a database.
  nofire=$((nofire + 1)); check "fresh deploy is inside the realignment window" "REALIGNING" \
    "$( [ 100 -lt $(( 900 * 2 )) ] && echo REALIGNING || echo JUDGE )"
  nofire=$((nofire + 1)); check "two bars past deploy leaves the window" "JUDGE" \
    "$( [ 1900 -lt $(( 900 * 2 )) ] && echo REALIGNING || echo JUDGE )"

  # The alert must never point at the basis-flip wave, and must stay templated.
  map=$((map + 1)); check "ratchet wave" "OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}" "$(recommended_wave_for RATCHET)"
  map=$((map + 1)); check "offset wave"  "OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W{NEXT}"  "$(recommended_wave_for OFFSET_FAULT)"
  map=$((map + 1)); check "distinct waves per id" "distinct" \
    "$([ "$(recommended_wave_for RATCHET)" != "$(recommended_wave_for OFFSET_FAULT)" ] && echo distinct || echo shared)"

  # Vacuity guard — a corpus that is empty means this suite verified nothing.
  if [ "$fire" -eq 0 ] || [ "$nofire" -eq 0 ] || [ "$map" -eq 0 ]; then
    echo "self-test VACUOUS: ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map"
    return 1
  fi
  if [ "$failures" -ne 0 ]; then
    echo "self-test FAILED: ${failures} failure(s) across ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map"
    return 1
  fi
  echo "self-test passed: ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map (${pass} assertions)"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi

# ── live run ────────────────────────────────────────────────────────────────
log "START deploy_epoch=$DEPLOY_EPOCH"

LAST_RAW=$("${SQLITE[@]}" "$DB" \
  "SELECT last_fetched_at FROM watchlists
    WHERE chat_id=$CHAT_ID AND coin='$COIN' AND timeframe='$TF' AND exchange='$EXCHANGE';" 2>/dev/null)
LAST_EPOCH=$(iso_to_epoch "$LAST_RAW")

if [ -z "$LAST_EPOCH" ]; then
  fail RATCHET "watchlist row not found or last_fetched_at unparseable (raw='$LAST_RAW')"
fi
# The realignment window is evaluated FIRST, against the WALL CLOCK rather than the row's own
# stamp. Ordering matters and this got it wrong once: the "has not dispatched since deploy"
# check below used to run first, so any run within two bars of a deploy paged a RATCHET for a
# row that had simply not reached its next bar yet. A probe that false-pages after every deploy
# trains the operator to ignore it, which is how a real one gets missed.
NOW_EPOCH=$(date -u +%s)
if [ $(( NOW_EPOCH - DEPLOY_EPOCH )) -lt $(( TF_SECONDS * 2 )) ]; then
  log "CHECK1 REALIGNING — only $(( NOW_EPOCH - DEPLOY_EPOCH ))s of wall clock since deploy (< 2 bars); the row may legitimately not have reached its next bar yet. No alert."
  exit 0
fi

if [ "$LAST_EPOCH" -le "$DEPLOY_EPOCH" ]; then
  fail RATCHET "row has not dispatched in the $(( NOW_EPOCH - DEPLOY_EPOCH ))s since deploy, which is over 2 bars (last=$LAST_EPOCH <= deploy=$DEPLOY_EPOCH) — the cron may be dark"
fi

OFFSET=$(secs_into_bar "$LAST_EPOCH" "$TF_SECONDS")
AGE=$(( LAST_EPOCH - DEPLOY_EPOCH ))
log "CHECK1 last='$LAST_RAW' epoch=$LAST_EPOCH offset_into_bar=${OFFSET}s of ${TF_SECONDS}s age_since_deploy=${AGE}s"

# Second realignment guard, on the ROW's own age rather than the wall clock. NOT a duplicate of
# the one above: that covers "no fire yet since the deploy", this covers "one fire, and it is
# the ragged realignment one".
# The first fire after a change is the REALIGNMENT fire: the anchor was written under the old
# contract, so its first bucket comparison can come due anywhere in the bar (measured: 464s).
# By design — judging it would be a false page.
if [ "$AGE" -lt $(( TF_SECONDS * 2 )) ]; then
  log "CHECK1 REALIGNING — only ${AGE}s since deploy (< 2 bars); not judging the realignment fire. No alert."
  exit 0
fi

# Every row on this timeframe, so the verdict can DISCRIMINATE scatter from a uniform offset.
PEERS=$("${SQLITE[@]}" "$DB" \
  "SELECT last_fetched_at FROM watchlists WHERE timeframe='$TF' AND last_fetched_at IS NOT NULL;" 2>/dev/null)
PEER_OFFSETS=()
while IFS= read -r ts; do
  [ -z "$ts" ] && continue
  o=$(secs_into_bar "$ts" "$TF_SECONDS") || continue
  [ -n "$o" ] && PEER_OFFSETS+=("$o")
done <<< "$PEERS"

VERDICT=$(classify_offsets "$TF_SECONDS" "${PEER_OFFSETS[@]:-}")
log "CHECK1 peers_on_${TF}=${#PEER_OFFSETS[@]} offsets=[${PEER_OFFSETS[*]:-}] verdict=$VERDICT"

case "$VERDICT" in
  OK)           log "CHECK1 PASS — all ${TF} rows dispatching late-bar as configured" ;;
  INSUFFICIENT) log "CHECK1 INSUFFICIENT_DATA — no ${TF} peer offsets; not judging. No alert."; exit 0 ;;
  RATCHET)      fail RATCHET "dispatch offsets are SCATTERED across ${#PEER_OFFSETS[@]} ${TF} rows ([${PEER_OFFSETS[*]}] into a ${TF_SECONDS}s bar). No single offset value produces that — the per-row anchor is drifting, i.e. bucket-deterministic dispatch is not in effect. Check that dispatch_schedule.py is present on the host and that db.list_due_watches uses target_epoch." ;;
  OFFSET_FAULT) fail OFFSET_FAULT "dispatch is bucket-CONSISTENT but lands at [${PEER_OFFSETS[*]}] into a ${TF_SECONDS}s bar — early. The ratchet is fixed; the offset value is wrong. Check ALGOVAULT_BOT_DISPATCH_OFFSET_PCT / _CLOSE_GRACE_MIN reach the process." ;;
esac

# ── Check 2 — constancy over post-deploy fires, when there are enough ────────
# CAST is load-bearing: strftime returns TEXT and SQLite orders every INTEGER before every
# TEXT, so the uncast comparison was ALWAYS TRUE and silently spanned all history.
OFFSETS=$("${SQLITE[@]}" "$DB" \
  "SELECT CAST(strftime('%s', fired_at) AS INTEGER) % $TF_SECONDS FROM alerts_fired
    WHERE chat_id=$CHAT_ID AND CAST(strftime('%s', fired_at) AS INTEGER) > $DEPLOY_EPOCH
    ORDER BY fired_at;" 2>/dev/null)
N=$(printf '%s\n' "$OFFSETS" | grep -c . || true)
log "CHECK2 post-deploy alerts_fired rows for chat $CHAT_ID: n=$N offsets=[$(printf '%s' "$OFFSETS" | tr '\n' ' ')]"

if [ "$N" -ge 2 ]; then
  SPREAD=$(( $(printf '%s\n' "$OFFSETS" | sort -n | tail -1) - $(printf '%s\n' "$OFFSETS" | sort -n | head -1) ))
  log "CHECK2 spread=${SPREAD}s"
  [ "$SPREAD" -gt "$SCATTER_THRESHOLD" ] && \
    fail RATCHET "bucket offset drifted ${SPREAD}s across $N post-deploy fires — the ratchet is back"
  log "CHECK2 PASS — bucket offset constant across $N fires"
else
  log "CHECK2 INSUFFICIENT_DATA — n=$N (<2). alerts_fired holds only non-HOLD verdicts; expected, not a failure. Check 1 carried the verdict."
fi

log "DONE all checks passed — silent success, no alert sent"
exit 0
