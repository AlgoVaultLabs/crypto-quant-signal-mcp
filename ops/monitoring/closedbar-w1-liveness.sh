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
# ── The probe row is SELECTED at runtime, never hardcoded ────────────────────
# SIGNAL-CLOSEDBAR-FLIP-W1 CH5. This used to pin chat 8776880162 / ETH / 15m / BINANCE. That
# row is a SUBSCRIBER'S watch — they unwatched it after 2026-08-02, so by the time this wave
# ran the guard resolved nothing and reported CLOSEDBAR_DISPATCH_RATCHET_REGRESSION: a
# CRITICAL page produced by a stranger tidying their watchlist. A guard whose subject any user
# can delete is not a guard.
#
# So: probe the most-recently-dispatched row on the target timeframe, whoever owns it. If the
# corpus is EMPTY that is a FACT about the world (nobody watches this TF), not a fault — the
# world builds this corpus, so empty means INSUFFICIENT and never a page.
TF=${CLOSEDBAR_TF:-15m}
TF_SECONDS=${CLOSEDBAR_TF_SECONDS:-900}
LOG=${CLOSEDBAR_LOG:-/var/log/closedbar-w1-liveness.log}

# Jitter may span ALGOVAULT_BOT_JITTER_WINDOW_MIN (default 3) minutes, plus one 60s scheduler
# tick. 300s leaves headroom above that 240s legitimate spread without masking a real drift,
# which grows by ~60s per period and blows past it within a few bars.
SCATTER_THRESHOLD=300

# stdout ONLY. The cron line already redirects stdout to $LOG, so tee-ing here wrote every
# line TWICE (visible in the 13:44 incident log). One writer, one copy.
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# ── R5: exactly one terminal verdict token; codes 0=PASS / 1=FAIL / 3=INDETERMINATE ──────────
# 3 is the token-law default for a NEW gate — deliberately NOT aligned to check_test_baseline's
# 2, which is 2 only because it already deployed that code for this meaning.
CLOSEDBAR_VERDICT_EMITTED=0
emit_verdict() {   # <PASS|FAIL|INDETERMINATE>
  [ "$CLOSEDBAR_VERDICT_EMITTED" -eq 1 ] && return 0
  CLOSEDBAR_VERDICT_EMITTED=1
  printf 'CLOSEDBAR_LIVENESS_VERDICT=%s\n' "$1"
  case "$1" in
    PASS) exit 0;; FAIL) exit 1;; *) exit 3;;
  esac
}

# ── R3: sustained-drift gating. A single 2-second excursion is not operator-action-required ──
# The alert contract's CRITICAL_PERSISTENT shape, matching webhook-delivery-canary.py at 3.
# The streak file is keyed by alert id so RATCHET and OFFSET_FAULT accrue independently.
BREACH_DIR=${CLOSEDBAR_BREACH_DIR:-/var/lib/algovault-monitoring/closedbar-breach}
BREACH_STREAK_REQUIRED=${CLOSEDBAR_BREACH_STREAK:-3}
breach_bump() {   # <alert_id> -> the new streak
  local f="$BREACH_DIR/$1"; local n=0
  mkdir -p "$BREACH_DIR" 2>/dev/null || true
  [ -r "$f" ] && n=$(tr -dc '0-9' < "$f")
  n=$(( ${n:-0} + 1 )); printf '%s' "$n" > "$f" 2>/dev/null || true
  printf '%s' "$n"
}
breach_clear() { rm -f "$BREACH_DIR"/* 2>/dev/null || true; }

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
DEFAULT_JITTER_WINDOW_MIN=3
OFFSET_PCT=${CLOSEDBAR_OFFSET_PCT:-$(_bot_cfg ALGOVAULT_BOT_DISPATCH_OFFSET_PCT "$DEFAULT_OFFSET_PCT")}
GRACE_MIN=${CLOSEDBAR_GRACE_MIN:-$(_bot_cfg ALGOVAULT_BOT_CLOSE_GRACE_MIN "$DEFAULT_GRACE_MIN")}
# OPS-CLOSEDBAR-LIVENESS-BAND-W1 R0.5: the previous revision read
# `ALGOVAULT_BOT_DISPATCH_JITTER_MIN`, WHICH DOES NOT EXIST. The bot reads
# `ALGOVAULT_BOT_JITTER_WINDOW_MIN` (dispatch_schedule.py ENV_JITTER_WINDOW_MIN, default 3), so
# this silently fell back to 1 while production ran 3 — the upper bound came out 180 instead of
# 240 and the guard paged on correct dispatch. Read the name the PRODUCER reads.
JITTER_WINDOW_MIN=${CLOSEDBAR_JITTER_WINDOW_MIN:-$(_bot_cfg ALGOVAULT_BOT_JITTER_WINDOW_MIN "$DEFAULT_JITTER_WINDOW_MIN")}
TICK_SECONDS=60   # OnCalendar=*:*:00 — the scheduler grid, so a due time rounds UP to it

# `--show-config` exists so the self-test can exercise the ASSIGNMENTS above against a fixture
# env file. Without it the suite is structurally blind to the seam it replaces: it sets
# OFFSET_PCT/GRACE_MIN/JITTER_WINDOW_MIN directly, so reverting a variable NAME to one that does
# not exist stayed GREEN — which is precisely the defect this wave exists to fix (the guard read
# ALGOVAULT_BOT_DISPATCH_JITTER_MIN, a name nothing writes, and silently used its default).
if [ "${1:-}" = "--show-config" ]; then
  printf 'OFFSET_PCT=%s GRACE_MIN=%s JITTER_WINDOW_MIN=%s\n' "$OFFSET_PCT" "$GRACE_MIN" "$JITTER_WINDOW_MIN"
  exit 0
fi

# ── The band is derived from the instant we MEASURE, not the instant dispatch is DUE ─────────
# OPS-CLOSEDBAR-LIVENESS-BAND-W1 R1. `last_fetched_at` is stamped AFTER the fetch + MCP call +
# send; the schedule says when the work STARTS. A band built from pure scheduling arithmetic can
# never accommodate a nonzero work time, so it is STRUCTURALLY guaranteed to overshoot on every
# jitter-max row, forever. That is what paged CRITICAL on [63 182 182] and [67 187 188] — both
# correct, each a due-time plus a few seconds of execution.
#
# MEASURED 2026-08-07, 44 fires across 5 timeframes, hand-computed from raw TEXT-ISO stamps:
#   p50 = +6s   p95 = +8s   max = +8s   min = +2s   rows below the minimum due-time = 0
#
# The allowance is 30s. NOT a round number chosen to silence the alarm: it is ~3.7x the measured
# p95, and it is bounded ABOVE by a principled constraint — it must stay under HALF a jitter step
# (60/2 = 30) so consecutive due-time intervals can never merge. Keep that inequality true if it
# is ever revised, or the grid degenerates into one wide band and stops discriminating.
DISPATCH_LATENCY_ALLOWANCE_SECONDS=${CLOSEDBAR_LATENCY_ALLOWANCE:-30}

# The DUE-TIME GRID: dispatch is due at offset + grace + j*60 for each jitter draw j < window.
due_times() {   # <period> -> space-separated due-times inside the bar
  local base=$(( $1 * OFFSET_PCT / 100 + GRACE_MIN * 60 )) j d out=""
  j=0
  while [ "$j" -lt "$JITTER_WINDOW_MIN" ]; do
    d=$(( base + j * 60 ))
    [ "$d" -lt "$1" ] && out="$out $d"
    j=$((j + 1))
  done
  printf '%s' "${out# }"
}

# On design iff the measured offset lands in [due, due + allowance] for SOME due-time.
# Deliberately a GRID rather than one wide [min, max+allowance] band: the grid still rejects a
# value sitting BETWEEN two due-times, which a single band cannot.
offset_on_grid() {   # <period> <offset> -> rc 0 on design
  local d
  for d in $(due_times "$1"); do
    if [ "$2" -ge "$d" ] && [ "$2" -le $(( d + DISPATCH_LATENCY_ALLOWANCE_SECONDS )) ]; then return 0; fi
  done
  return 1
}

# R2: direction is decided against the GRID, never hardcoded. The previous revision emitted the
# word "early" unconditionally, so 182 against an upper bound of 180 was reported as EARLY.
offset_direction() {   # <period> <offset> -> on-design | early | late | off-grid
  if offset_on_grid "$1" "$2"; then printf 'on-design'; return 0; fi
  local grid; grid=$(due_times "$1")
  local lo=${grid%% *} hi=${grid##* }
  if   [ "$2" -lt "$lo" ]; then printf 'early'
  elif [ "$2" -gt $(( hi + DISPATCH_LATENCY_ALLOWANCE_SECONDS )) ]; then printf 'late'
  else printf 'off-grid'; fi
}

# <period> <offset…> -> OK | OFFSET_FAULT | RATCHET | INSUFFICIENT
classify_offsets() {
  local period="$1"; shift
  local n=0 min=-1 max=-1 ondesign=0 o
  for o in "$@"; do
    [ -z "$o" ] && continue
    n=$((n + 1))
    [ "$min" -lt 0 ] && min=$o
    [ "$o" -lt "$min" ] && min=$o
    [ "$o" -gt "$max" ] && max=$o
    if offset_on_grid "$period" "$o"; then ondesign=$((ondesign + 1)); fi
  done
  [ "$n" -eq 0 ] && { printf 'INSUFFICIENT'; return 0; }
  [ "$ondesign" -eq "$n" ] && { printf 'OK'; return 0; }
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
  local streak; streak=$(breach_bump "$aid")
  log "BREACH [$aid] streak=${streak}/${BREACH_STREAK_REQUIRED} — $*"
  if [ "$streak" -lt "$BREACH_STREAK_REQUIRED" ]; then
    log "CHECK1 breach recorded but NOT paged — ${streak}/${BREACH_STREAK_REQUIRED} consecutive. A single excursion is not operator-action-required."
    emit_verdict FAIL
  fi
  printf '🛑 %s\n\n%s\n\nSustained: %s consecutive checks\nRow: chat %s %s/%s/%s\nMeasured: [%s] into the %ss bar\nOn design: due-times [%s] each +0..%ss execution latency\nConfig: OFFSET_PCT=%s grace=%smin jitter_window=%smin tick=%ss\nProbe: %s\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$aid" "$*" "$streak" "$CHAT_ID" "$COIN" "$TF" "$EXCHANGE" \
    "${PEER_OFFSETS[*]:-n/a}" "$TF_SECONDS" \
    "$(due_times "$TF_SECONDS")" "$DISPATCH_LATENCY_ALLOWANCE_SECONDS" \
    "$OFFSET_PCT" "$GRACE_MIN" "$JITTER_WINDOW_MIN" "$TICK_SECONDS" "$0" "$wave" \
    | "$TG" "$aid" CRITICAL_PERSISTENT - || true
  emit_verdict FAIL
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

  # ── The GRID follows the config, and THAT is the property under test ───────
  # Each scenario names the dispatch regime it exercises. The band is a DUE-TIME GRID plus a
  # measured latency allowance, so the same fixture must flip verdict when the config moves —
  # a re-hardcoded band passes one half and fails the other.
  _cfg_saved="$OFFSET_PCT $GRACE_MIN $JITTER_WINDOW_MIN"
  _with_cfg() { OFFSET_PCT=$1; GRACE_MIN=$2; JITTER_WINDOW_MIN=$3; }

  # POST-FLIP: OFFSET_PCT=0, grace 1, window 3 -> due {60,120,180}, allowance 30
  #   => on design = [60,90] u [120,150] u [180,210]
  _with_cfg 0 1 3
  map=$((map + 1));    check "post-flip 900s grid"  "60 120 180" "$(due_times 900)"
  # THE REGRESSION FIXTURES: the two payloads that actually paged CRITICAL on correct dispatch.
  nofire=$((nofire + 1)); check "real alert [63 182 182] -> OK"  "OK" "$(classify_offsets 900 63 182 182)"
  nofire=$((nofire + 1)); check "real alert [67 187 188] -> OK"  "OK" "$(classify_offsets 900 67 187 188)"
  nofire=$((nofire + 1)); check "exact due-times -> OK"          "OK" "$(classify_offsets 900 60 120 180)"
  nofire=$((nofire + 1)); check "p95 latency on every due -> OK" "OK" "$(classify_offsets 900 68 128 188)"
  fire=$((fire + 1));  check "before the first due -> OFFSET_FAULT" "OFFSET_FAULT" "$(classify_offsets 900 5 6 5)"
  fire=$((fire + 1));  check "past the last due+allowance -> OFFSET_FAULT" "OFFSET_FAULT" "$(classify_offsets 900 824 824 824)"
  # R2: the direction label, per case. 182 is LATE-of-180 only if it exceeds the allowance;
  # inside the allowance it is ON DESIGN. This is the label that was hardcoded to "early".
  map=$((map + 1)); check "direction: below the grid"      "early"     "$(offset_direction 900 5)"
  map=$((map + 1)); check "direction: on a due-time"       "on-design" "$(offset_direction 900 180)"
  map=$((map + 1)); check "direction: within allowance"    "on-design" "$(offset_direction 900 182)"
  map=$((map + 1)); check "direction: past last+allowance" "late"      "$(offset_direction 900 824)"
  map=$((map + 1)); check "direction: BETWEEN due-times"   "off-grid"  "$(offset_direction 900 100)"
  # The grid must still reject a value between due-times — the property one wide band loses.
  fire=$((fire + 1)); check "between due-times -> OFFSET_FAULT" "OFFSET_FAULT" "$(classify_offsets 900 100 100 100)"
  # The allowance must stay under HALF a jitter step or the intervals merge.
  map=$((map + 1)); check "allowance < half a jitter step" "ok" \
    "$([ "$DISPATCH_LATENCY_ALLOWANCE_SECONDS" -lt 30 ] || [ "$DISPATCH_LATENCY_ALLOWANCE_SECONDS" -eq 30 ] && echo ok || echo MERGED)"

  # PRE-FLIP: OFFSET_PCT=75, grace 1, window 3 -> due {735,795,855}. Same fixtures, inverted.
  _with_cfg 75 1 3
  map=$((map + 1));    check "pre-flip 900s grid" "735 795 855" "$(due_times 900)"
  nofire=$((nofire + 1)); check "pre-flip on-grid -> OK" "OK" "$(classify_offsets 900 735 795 855)"
  nofire=$((nofire + 1)); check "pre-flip +latency -> OK" "OK" "$(classify_offsets 900 740 800 860)"
  fire=$((fire + 1)); check "pre-flip bar-close cluster -> OFFSET_FAULT" "OFFSET_FAULT" "$(classify_offsets 900 5 6 5)"
  fire=$((fire + 1)); check "pre-flip mid-bar cluster -> OFFSET_FAULT"   "OFFSET_FAULT" "$(classify_offsets 900 300 310 295)"
  # The post-flip fixture must be REFUSED under the pre-flip config — proof the grid moved.
  fire=$((fire + 1)); check "post-flip payload under pre-flip cfg -> OFFSET_FAULT" "OFFSET_FAULT" \
    "$(classify_offsets 900 63 182 182)"

  # Scatter dominates under either regime.
  _with_cfg 0 1 3
  fire=$((fire + 1)); check "incident scatter -> RATCHET (post-flip)" "RATCHET" "$(classify_offsets 900 184 184 844)"
  _with_cfg 75 1 3
  fire=$((fire + 1)); check "incident scatter -> RATCHET (pre-flip)"  "RATCHET" "$(classify_offsets 900 184 184 844)"
  fire=$((fire + 1)); check "wide scatter -> RATCHET"                 "RATCHET" "$(classify_offsets 900 5 450 880)"

  # Absent-env fallbacks: asserted against the REAL call-site constants, not re-supplied here.
  map=$((map + 1)); check "absent-env default offset is post-flip" "0" "$DEFAULT_OFFSET_PCT"
  map=$((map + 1)); check "absent-env default grace"               "1" "$DEFAULT_GRACE_MIN"
  map=$((map + 1)); check "absent-env default jitter WINDOW"       "3" "$DEFAULT_JITTER_WINDOW_MIN"
  map=$((map + 1)); check "_bot_cfg falls back when file absent"   "7" \
    "$( BOT_ENV=/nonexistent _bot_cfg ALGOVAULT_BOT_JITTER_WINDOW_MIN 7 )"

  # THE SEAM ITSELF: a fixture written in the BOT's vocabulary must flow through the real
  # assignment lines. This is the assertion whose absence let the wrong variable name ship.
  _envf=$(mktemp)
  printf 'ALGOVAULT_BOT_DISPATCH_OFFSET_PCT=11\nALGOVAULT_BOT_CLOSE_GRACE_MIN=2\nALGOVAULT_BOT_JITTER_WINDOW_MIN=7\n' > "$_envf"
  map=$((map + 1)); check "reads the knob NAMES the bot writes" "OFFSET_PCT=11 GRACE_MIN=2 JITTER_WINDOW_MIN=7" \
    "$( CLOSEDBAR_BOT_ENV="$_envf" bash "$0" --show-config )"
  # and a file written in a vocabulary NOTHING produces must fall back, not silently half-resolve
  _envbad=$(mktemp)
  printf 'ALGOVAULT_BOT_DISPATCH_JITTER_MIN=7\n' > "$_envbad"
  map=$((map + 1)); check "a non-existent knob name yields the DEFAULT" "OFFSET_PCT=0 GRACE_MIN=1 JITTER_WINDOW_MIN=3" \
    "$( CLOSEDBAR_BOT_ENV="$_envbad" bash "$0" --show-config )"
  rm -f "$_envf" "$_envbad"

  # ── R5: the token AND its exit-code MAPPING. Asserting the token alone is not enough —
  # a prior self-test in this family passed while the INDETERMINATE mapping had been re-coded
  # to 0, because nothing checked the code. Run each in a subshell, since emit_verdict exits.
  map=$((map + 1)); check "token PASS -> exit 0"          "0|CLOSEDBAR_LIVENESS_VERDICT=PASS" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; emit_verdict PASS ); printf '%s|%s' "$?" "$out" )"
  map=$((map + 1)); check "token FAIL -> exit 1"          "1|CLOSEDBAR_LIVENESS_VERDICT=FAIL" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; emit_verdict FAIL ); printf '%s|%s' "$?" "$out" )"
  map=$((map + 1)); check "token INDETERMINATE -> exit 3" "3|CLOSEDBAR_LIVENESS_VERDICT=INDETERMINATE" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; emit_verdict INDETERMINATE ); printf '%s|%s' "$?" "$out" )"
  map=$((map + 1)); check "exactly one token per run" "1" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; ( emit_verdict PASS; emit_verdict FAIL ) ); printf '%s' "$out" | grep -c CLOSEDBAR_LIVENESS_VERDICT= )"

  # ── R3: sustained-drift gating. One excursion must NOT page; the Nth must.
  _bd=$(mktemp -d)
  map=$((map + 1)); check "streak 1st breach" "1" "$( BREACH_DIR=$_bd breach_bump T1 )"
  map=$((map + 1)); check "streak 2nd breach" "2" "$( BREACH_DIR=$_bd breach_bump T1 )"
  map=$((map + 1)); check "streak 3rd breach" "3" "$( BREACH_DIR=$_bd breach_bump T1 )"
  nofire=$((nofire + 1)); check "a single excursion does NOT reach the pager" "below-threshold" \
    "$( [ 1 -lt "$BREACH_STREAK_REQUIRED" ] && echo below-threshold || echo PAGES )"
  fire=$((fire + 1)); check "the Nth consecutive excursion DOES page" "pages" \
    "$( [ "$BREACH_STREAK_REQUIRED" -ge "$BREACH_STREAK_REQUIRED" ] && echo pages || echo silent )"
  map=$((map + 1)); check "streaks are per-alert-id" "1" "$( BREACH_DIR=$_bd breach_bump T2 )"
  map=$((map + 1)); check "a PASS clears the streak" "1" \
    "$( BREACH_DIR=$_bd breach_clear; BREACH_DIR=$_bd breach_bump T1 )"
  rm -rf "$_bd"

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

PROBE_ROW=$("${SQLITE[@]}" "$DB" \
  "SELECT chat_id||'|'||coin||'|'||exchange||'|'||last_fetched_at FROM watchlists
    WHERE timeframe='$TF' AND last_fetched_at IS NOT NULL
    ORDER BY last_fetched_at DESC LIMIT 1;" 2>/dev/null)
if [ -z "$PROBE_ROW" ]; then
  log "CHECK1 INSUFFICIENT — no dispatched ${TF} watchlist row exists. Nobody watches this"\
" timeframe right now; the world builds this corpus, so empty is a FACT, not a fault."
  log "DONE insufficient corpus — nobody watches ${TF}; the world builds this corpus, so empty is a FACT"
  emit_verdict INDETERMINATE
fi
CHAT_ID=${PROBE_ROW%%|*}; _rest=${PROBE_ROW#*|}
COIN=${_rest%%|*};        _rest=${_rest#*|}
EXCHANGE=${_rest%%|*}
LAST_RAW=${_rest#*|}
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
  OK)           log "CHECK1 PASS — all ${#PEER_OFFSETS[@]} ${TF} rows on the due-time grid [$(due_times "$TF_SECONDS")] +0..${DISPATCH_LATENCY_ALLOWANCE_SECONDS}s latency; measured [${PEER_OFFSETS[*]}]"; breach_clear ;;
  INSUFFICIENT) log "CHECK1 INSUFFICIENT_DATA — no ${TF} peer offsets; not judging. No alert."; emit_verdict INDETERMINATE ;;
  RATCHET)      fail RATCHET "dispatch offsets are SCATTERED across ${#PEER_OFFSETS[@]} ${TF} rows ([${PEER_OFFSETS[*]}] into a ${TF_SECONDS}s bar). No single offset value produces that — the per-row anchor is drifting, i.e. bucket-deterministic dispatch is not in effect. Check that dispatch_schedule.py is present on the host and that db.list_due_watches uses target_epoch." ;;
  OFFSET_FAULT) fail OFFSET_FAULT "dispatch is bucket-CONSISTENT but lands at [${PEER_OFFSETS[*]}] into a ${TF_SECONDS}s bar — $(offset_direction "$TF_SECONDS" "${PEER_OFFSETS[0]}") of the due-time grid [$(due_times "$TF_SECONDS")] (+0..${DISPATCH_LATENCY_ALLOWANCE_SECONDS}s latency). The ratchet is fixed; the offset value is wrong." ;;
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
emit_verdict PASS
