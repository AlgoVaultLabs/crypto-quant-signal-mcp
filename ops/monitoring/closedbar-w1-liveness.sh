#!/usr/bin/env bash
# closedbar-w1-liveness.sh — the dispatch-timing guard for the Telegram bot's watchlist dispatcher.
# Re-founded by OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W2.
#
# This file holds NO schedule arithmetic. The bot records one disposition per due row per tick in
# its own database (state.db `dispatch_ledger`), and the bot ships a read-only auditor
# (`python -B -m algovault_bot.dispatch_audit`) that classifies every due row of each bar that
# opened at HH:00 against that record. This script runs the auditor, routes its verdict, and pages
# through send_telegram.sh. Rule: a guard that judges a producer against its own COPY of the
# producer's schedule pages designed recovery as a fault every time the producer gains a behaviour
# the copy does not have — so the producer records why each row ran when it ran, and the guard
# judges that record. The history of the copy this replaced is in `git log`.
#
# Verdict token: exactly one terminal CLOSEDBAR_LIVENESS_VERDICT=PASS|FAIL|INDETERMINATE
# (0 / 1 / 3). Pages are CRITICAL_PERSISTENT and need BREACH_STREAK_REQUIRED consecutive runs.
set -uo pipefail

DB=${CLOSEDBAR_DB:-/var/lib/algovault-bot/state.db}
TG=${CLOSEDBAR_TG:-/opt/algovault-monitoring/send_telegram.sh}
# When the running bot code went live — written by ops/scripts/host-deploy.sh beside DEPLOYED_SHA.
DEPLOY_STAMP=${CLOSEDBAR_DEPLOY_STAMP:-/opt/algovault-bot/DEPLOYED_AT}
# The bot's env file. The auditor reads only its three dispatch knobs; this script never reads it.
BOT_ENV=${CLOSEDBAR_BOT_ENV:-/etc/algovault-bot/env}
# The producer's auditor, run from the bot's own venv. A command line, word-split on purpose.
AUDITOR=${CLOSEDBAR_AUDITOR:-/opt/algovault-bot/.venv/bin/python -B -m algovault_bot.dispatch_audit}
TF=${CLOSEDBAR_TF:-all}
LOG=${CLOSEDBAR_LOG:-/var/log/closedbar-w1-liveness.log}
BREACH_DIR=${CLOSEDBAR_BREACH_DIR:-/var/lib/algovault-monitoring/closedbar-breach}
BREACH_STREAK_REQUIRED=${CLOSEDBAR_BREACH_STREAK:-3}
# A run this soon after a bot deploy that cannot get a verdict out of the auditor is INDETERMINATE,
# never a page: the deploy may be mid-swap. Two 15m bars — one run straddling a deploy never pages,
# and the next scheduled run after a broken deploy does.
REALIGN_WINDOW_SECONDS=1800
# The verdicts this file can route. Checked against the auditor's own --print-verdicts on every
# live run, so the producer cannot grow a verdict this route table silently mis-files.
PINNED_VERDICTS="OK TIMING_FAULT DEPLOY_REGRESSION CHRONIC_LATE INDETERMINATE"
OFFENDER_CAP=10
INCIDENT_AUDIT="vault audits/CLOSEDBAR_DISPATCH_OFFSET_FAULT-2026-10-07.md"

# stdout ONLY: the cron line redirects stdout to $LOG, so tee-ing here would write every line twice.
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

CLOSEDBAR_VERDICT_EMITTED=0
emit_verdict() {   # <PASS|FAIL|INDETERMINATE>
  [ "$CLOSEDBAR_VERDICT_EMITTED" -eq 1 ] && return 0
  CLOSEDBAR_VERDICT_EMITTED=1
  printf 'CLOSEDBAR_LIVENESS_VERDICT=%s\n' "$1"
  case "$1" in
    PASS) exit 0;; FAIL) exit 1;; *) exit 3;;
  esac
}

# Sustained-breach gating, keyed by alert id so the three ids accrue independently.
breach_bump() {   # <alert_id> -> the new streak
  local f="$BREACH_DIR/$1"; local n=0
  mkdir -p "$BREACH_DIR" 2>/dev/null || true
  [ -r "$f" ] && n=$(tr -dc '0-9' < "$f")
  n=$(( ${n:-0} + 1 )); printf '%s' "$n" > "$f" 2>/dev/null || true
  printf '%s' "$n"
}
breach_clear() { rm -f "$BREACH_DIR"/* 2>/dev/null || true; }

# 'YYYY-MM-DD HH:MM' (UTC) for an epoch — GNU date on the host, BSD date on a laptop.
iso_from_epoch() {   # <epoch>
  case "${1:-}" in ''|*[!0-9]*) printf '?'; return 1;; esac
  date -u -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null || date -u -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null \
    || printf '?'
}

# ── the route table: the auditor's verdict → this probe's class (exhaustive) ─────────────────
route_for() {
  case "$1" in
    OK) printf 'PASS';;
    INDETERMINATE) printf 'INDETERMINATE';;
    TIMING_FAULT) printf 'OFFSET_FAULT';;
    DEPLOY_REGRESSION) printf 'RATCHET';;
    CHRONIC_LATE) printf 'CHRONIC_LATE';;
    *) printf 'UNKNOWN';;
  esac
}

# recommended_wave is TEMPLATED (`W{NEXT}`), one distinct wave per alert id.
alert_id_for() {
  case "$1" in
    RATCHET) printf 'CLOSEDBAR_DISPATCH_RATCHET_REGRESSION';;
    OFFSET_FAULT) printf 'CLOSEDBAR_DISPATCH_OFFSET_FAULT';;
    CHRONIC_LATE) printf 'CLOSEDBAR_DISPATCH_CHRONIC_LATE';;
  esac
}
recommended_wave_for() {
  case "$1" in
    RATCHET) printf 'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}';;
    OFFSET_FAULT) printf 'OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W{NEXT}';;
    CHRONIC_LATE) printf 'OPS-BOT-FETCH-DEGRADATION-INCIDENT-W{NEXT}';;
  esac
}

if [ "${1:-}" = "--print-routes" ]; then
  for v in $PINNED_VERDICTS; do printf '%s\n' "$v"; done
  exit 0
fi

# ── reading the auditor's line protocol (prefix-keyed, no JSON in bash) ─────────────────────
AUDIT_OUT=""
SENTENCE=""

proto_lines() {   # <prefix> -> every line of the auditor's output starting with it
  printf '%s\n' "$AUDIT_OUT" | grep -E "^$1" || true
}
kv() {   # <line> <key> -> the value of key=value in a protocol line
  printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1
}

# AUDIT_ROW lines whose verdict is a page (not OK, not unjudged).
offender_rows() {
  proto_lines 'AUDIT_ROW ' | grep -vE ' verdict=(OK|none)$' || true
}

render_offender() {   # <AUDIT_ROW line>
  local l="$1" cls
  cls=$(printf '%s\n' "$l" | awk '{print $2}')
  printf '  chat …%s %s — %s cause=%s · first tick due+%ss · %s late tick(s) · +%ss exec\n' \
    "$(kv "$l" last4)" "$(printf '%s\n' "$l" | awk '{print $7}')" "$cls" "$(kv "$l" cause)" \
    "$(kv "$l" lag0)" "$(kv "$l" late_ticks)" "$(kv "$l" exec)"
}

summary_total() {   # <field> -> the field summed over every AUDIT_SUMMARY line
  proto_lines 'AUDIT_SUMMARY ' | tr ' ' '\n' | sed -n "s/^$1=//p" | awk '{s+=$1} END {print s+0}'
}

render_body() {   # <alert_id> <streak> <wave>
  local aid="$1" streak="$2" wave="$3" offenders n judged sha config line
  offenders=$(offender_rows)
  n=$(printf '%s' "$offenders" | grep -c . || true)
  judged=$(summary_total judged)
  sha=$(sed -n 's/^sha=//p' "$(dirname "$DEPLOY_STAMP")/DEPLOYED_SHA" 2>/dev/null | cut -c1-8)
  config=$(proto_lines 'AUDIT_CONFIG ' | head -1 | sed 's/^AUDIT_CONFIG //')
  printf '🛑 %s\n\n%s\n\nSustained: %s consecutive checks\n' "$aid" "$SENTENCE" "$streak"
  proto_lines 'AUDIT_SUMMARY ' | while IFS= read -r line; do
    [ "$(kv "$line" offenders)" = "0" ] && continue
    printf 'Audited: %s bar %sZ\n' "$(kv "$line" tf)" "$(iso_from_epoch "$(kv "$line" bar)")"
  done
  if [ "$n" -gt 0 ]; then
    printf 'Offenders (%s of %s judged):\n' "$n" "$judged"
    printf '%s\n' "$offenders" | head -n "$OFFENDER_CAP" | while IFS= read -r line; do
      render_offender "$line"
    done
    [ "$n" -gt "$OFFENDER_CAP" ] && printf '  …and %s more\n' $(( n - OFFENDER_CAP ))
  fi
  printf 'Explained, not paged: fetch_failed %s · errored %s · deferred %s (owner: fetch-budget saturation alarm) · skipped %s · first fetch %s\n' \
    "$(summary_total fetch_failed)" "$(summary_total errored)" "$(summary_total deferred)" \
    "$(summary_total skipped)" "$(summary_total first)"
  printf 'Config: %s\n' "${config:-not reported}"
  printf 'Auditor: algovault_bot.dispatch_audit @ bot %s\n' "${sha:-unknown}"
  printf 'Audit: %s\nProbe: %s\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$INCIDENT_AUDIT" "$0" "$wave"
}

# Only what was MEASURED: the verdict, and the offending classes with their counts.
class_counts() {
  offender_rows | awk '{print $2}' | sort | uniq -c \
    | awk '{printf "%s%s %s", sep, $1, $2; sep=", "}'
}
sentence_for() {   # <class>
  local counts; counts=$(class_counts)
  case "$1" in
    OFFSET_FAULT)
      if [ -n "$counts" ]; then
        printf "The dispatcher's own record cannot explain these due rows (%s): no recorded deferral, retry, skip or first fetch accounts for them." "$counts"
      else
        printf "The bot's dispatch config was rejected or disagrees with what the dispatcher recorded (see Config) — the producer is not running the schedule its env file declares."
      fi;;
    RATCHET)
      if [ -n "$(proto_lines 'AUDIT_REASON=schema_missing' | head -1)" ]; then
        printf "state.db has no dispatch_ledger table: the running bot predates the ledger or its migration did not run."
      elif [ -n "$counts" ]; then
        printf "The dispatcher's record is missing, or the stamps contradict it (%s): a dark dispatcher, an absent ledger writer, or a second writer of last_fetched_at." "$counts"
      else
        printf "The dispatcher's record is missing for every due row of an audited bar."
      fi;;
    CHRONIC_LATE)
      printf "Due rows are chronically late or slow (%s): late for a fetch failure, an exception or a give-up in 3 consecutive serviced buckets, or more than 30 s of execution after the tick." "$counts";;
  esac
}

fail() {   # <RATCHET|OFFSET_FAULT|CHRONIC_LATE>
  local cls="$1" aid wave streak
  aid=$(alert_id_for "$cls")
  wave=$(recommended_wave_for "$cls")
  [ -n "$SENTENCE" ] || SENTENCE=$(sentence_for "$cls")
  streak=$(breach_bump "$aid")
  log "BREACH [$aid] streak=${streak}/${BREACH_STREAK_REQUIRED} — $SENTENCE"
  if [ "$streak" -lt "$BREACH_STREAK_REQUIRED" ]; then
    log "breach recorded but NOT paged — ${streak}/${BREACH_STREAK_REQUIRED} consecutive. A single excursion is not operator-action-required."
    log "DONE breach ${streak}/${BREACH_STREAK_REQUIRED} [$aid]"
    emit_verdict FAIL
  fi
  render_body "$aid" "$streak" "$wave" | "$TG" "$aid" CRITICAL_PERSISTENT - || true
  log "DONE paged [$aid]"
  emit_verdict FAIL
}

# A run that could not get a verdict out of the auditor. Inside the realignment window after a bot
# deploy that is INDETERMINATE; outside it the guard is blind, which pages RATCHET with the reason.
route_failure() {   # <reason>
  if [ "$DEPLOY_EPOCH" -gt 0 ] && [ $(( NOW - DEPLOY_EPOCH )) -lt "$REALIGN_WINDOW_SECONDS" ]; then
    log "INDETERMINATE — $1 — inside the ${REALIGN_WINDOW_SECONDS}s window after the bot deploy; not paging"
    log "DONE realigning"
    emit_verdict INDETERMINATE
  fi
  SENTENCE="The dispatch-timing auditor could not deliver a verdict: $1. The guard is blind until it can — check the bot deploy (it ships the auditor) first."
  fail RATCHET
}

run_auditor() {
  # shellcheck disable=SC2086 # AUDITOR is a command line and is word-split on purpose
  PYTHONDONTWRITEBYTECODE=1 $AUDITOR "$@"
}

# ── --self-test: hermetic, drives the LIVE path as a subprocess, vacuity-guarded ─────────────
self_test() {
  local pass=0 fire=0 nofire=0 map=0 failures=0
  check() {   # <label> <expected> <actual>
    if [ "$2" = "$3" ]; then pass=$((pass + 1))
    else echo "  FAIL $1: expected '$2' got '$3'"; failures=$((failures + 1)); fi
  }
  contains() {   # <label> <needle> <haystack>
    case "$3" in *"$2"*) pass=$((pass + 1));; *) echo "  FAIL $1: '$2' not found"; failures=$((failures + 1));; esac
  }
  lacks() {   # <label> <needle> <haystack>
    case "$3" in *"$2"*) echo "  FAIL $1: '$2' must not appear"; failures=$((failures + 1));; *) pass=$((pass + 1));; esac
  }

  local here repo stub tmp
  here=$(cd "$(dirname "$0")" && pwd)
  repo=$(cd "$here/../.." && pwd)
  stub="$repo/tests/fixtures/closedbar-liveness/stub-auditor.sh"
  if [ ! -x "$stub" ]; then
    echo "self-test: stub auditor not found or not executable at $stub"
    echo "CLOSEDBAR_SELFTEST_VERDICT=INDETERMINATE"; return 3
  fi
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/closedbar-selftest.XXXXXX") || {
    echo "self-test: mktemp failed"; echo "CLOSEDBAR_SELFTEST_VERDICT=INDETERMINATE"; return 3; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  # The capture stands in for send_telegram.sh: records argv and the body, never sends.
  cat > "$tmp/tg.sh" <<'TGEOF'
#!/usr/bin/env bash
n=$(ls "$CAPTURE_DIR" 2>/dev/null | wc -l | tr -d ' ')
{ printf 'ARGV %s|%s|%s\n' "$1" "$2" "$3"; cat; } > "$CAPTURE_DIR/page.$n"
TGEOF
  chmod +x "$tmp/tg.sh"
  printf '%s\n' "$(( $(date -u +%s) - 86400 ))" > "$tmp/DEPLOYED_AT"
  printf 'sha=%s\nunmerged=false\n' "0123abcd4567ef89" > "$tmp/DEPLOYED_SHA"
  mkdir -p "$tmp/fresh"
  printf '%s\n' "$(( $(date -u +%s) - 60 ))" > "$tmp/fresh/DEPLOYED_AT"
  : > "$tmp/env"

  SC_OUT=""; SC_RC=0; SC_PAGE=""
  run_live() {   # <scenario> <streak_required> <keep_breach:0|1> [auditor] [deploy_stamp]
    rm -rf "$tmp/cap"; mkdir -p "$tmp/cap"
    [ "$3" = "1" ] || rm -rf "$tmp/breach"
    # `-u PYTHONDONTWRITEBYTECODE`: an inherited value would satisfy the bytecode assertion on
    # behalf of a probe that no longer sets it (measured: this Mac's session exports it).
    SC_OUT=$(env -u PYTHONDONTWRITEBYTECODE CLOSEDBAR_AUDITOR="${4:-$stub}" STUB_SCENARIO="$1" STUB_ARGV_FILE="$tmp/argv" \
      CLOSEDBAR_TG="$tmp/tg.sh" CAPTURE_DIR="$tmp/cap" CLOSEDBAR_BREACH_DIR="$tmp/breach" \
      CLOSEDBAR_BREACH_STREAK="$2" CLOSEDBAR_DEPLOY_STAMP="${5:-$tmp/DEPLOYED_AT}" \
      CLOSEDBAR_DB="$tmp/state.db" CLOSEDBAR_BOT_ENV="$tmp/env" bash "$0" 2>&1)
    SC_RC=$?
    SC_PAGE=""
    [ -f "$tmp/cap/page.0" ] && SC_PAGE=$(cat "$tmp/cap/page.0")
    return 0
  }
  token() { printf '%s\n' "$SC_OUT" | sed -n 's/^CLOSEDBAR_LIVENESS_VERDICT=//p' | tail -1; }
  tokens() { printf '%s\n' "$SC_OUT" | grep -c '^CLOSEDBAR_LIVENESS_VERDICT=' || true; }

  # must-fire: each reaches the pager with the right id AND wave, offenders rendered, last4 only.
  expect_page() {   # <label> <scenario> <alert_id> <wave> <needle> [auditor]
    run_live "$2" 1 0 "${6:-}"
    fire=$((fire + 1))
    check "$1: token" "FAIL" "$(token)"
    check "$1: exit 1" "1" "$SC_RC"
    check "$1: one token" "1" "$(tokens)"
    contains "$1: paged with its id" "ARGV $3|CRITICAL_PERSISTENT|-" "$SC_PAGE"
    contains "$1: names its own wave" "Action: dispatch $4 via Cowork" "$SC_PAGE"
    contains "$1: says why" "$5" "$SC_PAGE"
  }
  expect_page "timing fault" timing_fault CLOSEDBAR_DISPATCH_OFFSET_FAULT \
    'OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W{NEXT}' "2 LATE_UNEXPLAINED"
  contains "timing fault: offender rendered" "chat …0240 XAU/15m/BINANCE — LATE_UNEXPLAINED" "$SC_PAGE"
  contains "timing fault: offenders counted" "Offenders (2 of 14 judged):" "$SC_PAGE"
  contains "timing fault: bar rendered" "Audited: 15m bar " "$SC_PAGE"
  contains "timing fault: explained not paged" "deferred 3 (owner: fetch-budget saturation alarm)" "$SC_PAGE"
  contains "timing fault: config line" "Config: OFFSET_PCT=0→0" "$SC_PAGE"
  contains "timing fault: auditor provenance" "Auditor: algovault_bot.dispatch_audit @ bot 0123abcd" "$SC_PAGE"
  lacks "timing fault: no full chat id (R8)" "$(printf '%s%s' 77123 40240)" "$SC_PAGE"
  lacks "timing fault: an explained row is not an offender" "ETH/15m/HL" "$SC_PAGE"
  expect_page "deploy regression" deploy_regression CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "UNPROVENANCED"
  expect_page "chronic late" chronic_late CLOSEDBAR_DISPATCH_CHRONIC_LATE \
    'OPS-BOT-FETCH-DEGRADATION-INCIDENT-W{NEXT}' "chronically late"
  contains "chronic late: offender rendered" "chat …6131 XAU/15m/BINGX — LATE_EXPLAINED cause=fetch_failed" "$SC_PAGE"
  expect_page "auditor missing" ok CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "auditor not executable" "$tmp/absent-auditor"
  expect_page "no token" no_token CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "printed no verdict token"
  expect_page "crash" crash CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "the auditor crashed: AUDIT_ERROR OperationalError"
  expect_page "unknown token" unknown_token CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "outside the probe's pinned list: SOMETHING_NEW"
  expect_page "route-list mismatch" route_mismatch CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "route list differs"
  expect_page "schema missing" schema_missing CLOSEDBAR_DISPATCH_RATCHET_REGRESSION \
    'OPS-CLOSEDBAR-DISPATCH-RATCHET-INCIDENT-W{NEXT}' "no dispatch_ledger table"
  expect_page "offender cap" many_offenders CLOSEDBAR_DISPATCH_OFFSET_FAULT \
    'OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W{NEXT}' "…and 2 more"

  # must-not-fire: designed recovery and unjudged runs never reach the pager.
  expect_quiet() {   # <label> <scenario> <token> <exit> [auditor] [deploy_stamp]
    run_live "$2" 1 0 "${5:-}" "${6:-}"
    nofire=$((nofire + 1))
    check "$1: token" "$3" "$(token)"
    check "$1: exit" "$4" "$SC_RC"
    check "$1: one token" "1" "$(tokens)"
    check "$1: nothing paged" "" "$SC_PAGE"
  }
  expect_quiet "ok" ok PASS 0
  expect_quiet "explained only" explained PASS 0
  expect_quiet "deferred only" deferred_only PASS 0
  expect_quiet "insufficient" insufficient INDETERMINATE 3
  expect_quiet "auditor missing inside the realignment window" ok INDETERMINATE 3 \
    "$tmp/absent-auditor" "$tmp/fresh/DEPLOYED_AT"

  # The SEAM: what the live path actually hands the auditor. A hermetic suite is blind to exactly
  # what its stub replaces, so the invocation itself is asserted.
  run_live ok 1 0
  map=$((map + 1))
  local argv; argv=$(cat "$tmp/argv" 2>/dev/null)
  contains "argv: bytecode off" "PYTHONDONTWRITEBYTECODE=1 " "$argv"
  contains "argv: db" "--db $tmp/state.db --tf all --now " "$argv"
  contains "argv: env file" "--env-file $tmp/env" "$argv"
  check "argv: now and deploy epoch are numbers" "ok" \
    "$(printf '%s\n' "$argv" | grep -Eq -- '--now [0-9]+ --deploy-epoch [0-9]+ ' && echo ok || echo bad)"

  # Sustain gate: 1/3 and 2/3 do not page, 3/3 does, a PASS clears, the next breach is 1/3 again.
  nofire=$((nofire + 1)); run_live timing_fault 3 0; check "sustain 1/3 silent" "" "$SC_PAGE"
  contains "sustain 1/3 logged" "streak=1/3" "$SC_OUT"
  nofire=$((nofire + 1)); run_live timing_fault 3 1; check "sustain 2/3 silent" "" "$SC_PAGE"
  fire=$((fire + 1)); run_live timing_fault 3 1
  contains "sustain 3/3 pages" "ARGV CLOSEDBAR_DISPATCH_OFFSET_FAULT|CRITICAL_PERSISTENT|-" "$SC_PAGE"
  contains "sustain 3/3 says so" "Sustained: 3 consecutive checks" "$SC_PAGE"
  run_live ok 3 1
  map=$((map + 1)); check "a PASS clears every streak" "0" "$(ls "$tmp/breach" 2>/dev/null | wc -l | tr -d ' ')"
  nofire=$((nofire + 1)); run_live timing_fault 3 1; check "after a PASS the count restarts" "" "$SC_PAGE"

  # Token + exit map, asserted on the CODE as well as the token.
  map=$((map + 1)); check "token PASS -> exit 0" "0|CLOSEDBAR_LIVENESS_VERDICT=PASS" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; emit_verdict PASS ); printf '%s|%s' "$?" "$out" )"
  map=$((map + 1)); check "token FAIL -> exit 1" "1|CLOSEDBAR_LIVENESS_VERDICT=FAIL" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; emit_verdict FAIL ); printf '%s|%s' "$?" "$out" )"
  map=$((map + 1)); check "token INDETERMINATE -> exit 3" "3|CLOSEDBAR_LIVENESS_VERDICT=INDETERMINATE" \
    "$( out=$( CLOSEDBAR_VERDICT_EMITTED=0; emit_verdict INDETERMINATE ); printf '%s|%s' "$?" "$out" )"

  # Route table: exhaustive over the pinned list, one distinct templated wave per id.
  local v
  for v in $PINNED_VERDICTS; do
    map=$((map + 1)); check "route for $v is known" "known" "$([ "$(route_for "$v")" != UNKNOWN ] && echo known || echo unknown)"
  done
  map=$((map + 1)); check "an unlisted token routes UNKNOWN" "UNKNOWN" "$(route_for SOMETHING_NEW)"
  map=$((map + 1)); check "three ids, three distinct waves" "3" \
    "$(for c in RATCHET OFFSET_FAULT CHRONIC_LATE; do recommended_wave_for "$c"; echo; done | sort -u | grep -c 'W{NEXT}$')"
  map=$((map + 1)); check "--print-routes is the pinned list" "$PINNED_VERDICTS" \
    "$(bash "$0" --print-routes | tr '\n' ' ' | sed 's/ $//')"
  map=$((map + 1)); check "iso_from_epoch" "2026-10-07 04:00" "$(iso_from_epoch "$(( 1791 * 1000000 + 345600 ))")"

  if [ "$fire" -eq 0 ] || [ "$nofire" -eq 0 ] || [ "$map" -eq 0 ]; then
    echo "self-test VACUOUS: ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map"
    echo "CLOSEDBAR_SELFTEST_VERDICT=INDETERMINATE"; return 3
  fi
  if [ "$failures" -ne 0 ]; then
    echo "self-test FAILED: ${failures} failure(s) across ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map"
    echo "CLOSEDBAR_SELFTEST_VERDICT=FAIL"; return 1
  fi
  echo "self-test passed: ${fire} must-fire, ${nofire} must-not-fire, ${map} must-map (${pass} assertions)"
  echo "CLOSEDBAR_SELFTEST_VERDICT=PASS"; return 0
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi

# ── live run ─────────────────────────────────────────────────────────────────────────────────
NOW=$(date -u +%s)
DEPLOY_EPOCH=0
if [ -r "$DEPLOY_STAMP" ]; then
  _stamped=$(head -1 "$DEPLOY_STAMP" 2>/dev/null | tr -dc '0-9')
  [ -n "$_stamped" ] && DEPLOY_EPOCH="$_stamped"
fi
log "START deploy_epoch=$DEPLOY_EPOCH tf=$TF"

# shellcheck disable=SC2086 # the first word of the auditor command line is its executable
set -- $AUDITOR
if [ ! -x "${1:-}" ]; then
  route_failure "auditor not executable: ${1:-<empty>}"
fi

LISTED=$(run_auditor --print-verdicts 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')
if [ "$LISTED" != "$PINNED_VERDICTS" ]; then
  route_failure "the auditor's route list differs from this probe's pinned list: auditor=[$LISTED] probe=[$PINNED_VERDICTS]"
fi

AUDIT_OUT=$(run_auditor --db "$DB" --tf "$TF" --now "$NOW" --deploy-epoch "$DEPLOY_EPOCH" --env-file "$BOT_ENV" 2>&1)
AUDIT_RC=$?
# Every line verbatim: the host log keeps the full ids the Telegram body masks.
printf '%s\n' "$AUDIT_OUT" | while IFS= read -r line; do log "$line"; done

TOKEN=$(printf '%s\n' "$AUDIT_OUT" | sed -n 's/^DISPATCH_AUDIT_VERDICT=//p' | tail -1)
REASON=$(printf '%s\n' "$AUDIT_OUT" | sed -n 's/^AUDIT_REASON=//p' | tail -1)
if [ -z "$TOKEN" ]; then
  route_failure "the auditor printed no verdict token (exit $AUDIT_RC)"
fi
if [ "$REASON" = "crash" ]; then
  route_failure "the auditor crashed: $(printf '%s\n' "$AUDIT_OUT" | grep -m1 '^AUDIT_ERROR ' | cut -c1-200)"
fi

CLASS=$(route_for "$TOKEN")
case "$CLASS" in
  PASS)
    log "PASS — every judged due row is on time or explained by the dispatcher's own record"
    breach_clear
    log "DONE all checks passed — silent success, no alert sent"
    emit_verdict PASS ;;
  INDETERMINATE)
    if [ "$REASON" = "insufficient" ]; then
      log "INDETERMINATE — nothing judgeable in the audited bars yet; not a fault, not a pass"
      log "DONE insufficient"
      emit_verdict INDETERMINATE
    fi
    route_failure "INDETERMINATE without a recognised reason (AUDIT_REASON=${REASON:-none})" ;;
  OFFSET_FAULT|RATCHET|CHRONIC_LATE)
    fail "$CLASS" ;;
  *)
    route_failure "a token outside the probe's pinned list: $TOKEN" ;;
esac
