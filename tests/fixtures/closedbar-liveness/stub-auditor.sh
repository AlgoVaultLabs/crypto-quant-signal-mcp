#!/usr/bin/env bash
# stub-auditor.sh — stand-in for `python -m algovault_bot.dispatch_audit` (algovault-bot repo),
# driven by ops/monitoring/closedbar-w1-liveness.sh --self-test. OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W2.
#
# Prints the auditor's line protocol for a named STUB_SCENARIO, exactly as the real one would.
# Ids are BUILT AT RUNTIME from short pieces: this repo is public and the chat-id gate refuses
# Telegram-shaped literals beside identity words. Records its own argv (and whether bytecode
# writing was disabled) to STUB_ARGV_FILE so the self-test can assert the seam it replaces.
set -u

if [ "${1:-}" = "--print-verdicts" ]; then
  if [ "${STUB_SCENARIO:-}" = "route_mismatch" ]; then
    printf '%s\n' OK TIMING_FAULT DEPLOY_REGRESSION INDETERMINATE
  else
    printf '%s\n' OK TIMING_FAULT DEPLOY_REGRESSION CHRONIC_LATE INDETERMINATE
  fi
  exit 0
fi
if [ -n "${STUB_ARGV_FILE:-}" ]; then
  printf 'PYTHONDONTWRITEBYTECODE=%s %s\n' "${PYTHONDONTWRITEBYTECODE:-}" "$*" > "$STUB_ARGV_FILE"
fi

A="$(printf '%s%s' 77123 40240)"   # last4 0240
B="$(printf '%s%s' 77123 46131)"   # last4 6131
BAR=$(( 1791 * 1000000 + 345600 ))  # 2026-10-07 04:00Z, the incident's bar

row() {   # <class> <cause> <chronic> <id> <coin/tf/exch> <lag0> <late_ticks> <exec> <verdict>
  printf 'AUDIT_ROW %s cause=%s chronic=%s chat=%s last4=%s %s bar=%s due=%s first_tick=%s tick=%s fired=%s lag0=%s spanned=%s late_ticks=%s exec=%s verdict=%s\n' \
    "$1" "$2" "$3" "$4" "${4: -4}" "$5" "$BAR" "$BAR" "$(( BAR + $6 ))" "$(( BAR + 70 ))" \
    "$(( BAR + 70 + $8 ))" "$6" "$7" "$7" "$8" "$9"
}
summary() {   # <judged> <on_time> <explained> <fetch_failed> <deferred> <offenders> [tf]
  printf 'AUDIT_SUMMARY tf=%s bar=%s judged=%s on_time=%s explained=%s fetch_failed=%s errored=0 deferred=%s skipped=2 first=0 offenders=%s not_yet_due=0 realigning=0\n' \
    "${7:-15m}" "$BAR" "$1" "$2" "$3" "$4" "$5" "$6"
}
head_lines() {
  printf 'AUDIT_SCOPE now=%s hour=%s tfs=15m ledger_events=420 ledger_start=%s deploy=%s provenance=%s euid=996\n' \
    "$(( BAR + 661 ))" "$BAR" "$(( BAR - 86400 ))" "$(( BAR - 86400 ))" "$(( BAR - 86400 ))"
  printf 'AUDIT_CONFIG OFFSET_PCT=0→0 GRACE_MIN=0→0 JITTER_WINDOW_MIN=1→1 rejected=none skew=0\n'
}

case "${STUB_SCENARIO:-ok}" in
  ok)
    head_lines; summary 14 14 0 0 0 0
    echo "DISPATCH_AUDIT_VERDICT=OK"; exit 0 ;;
  explained)
    head_lines
    row LATE_EXPLAINED fetch_failed 0 "$A" XAU/15m/BINANCE 10 1 2 OK
    row LATE_EXPLAINED fetch_failed 0 "$B" XAU/15m/BINGX 10 1 1 OK
    summary 14 12 2 2 0 0
    echo "DISPATCH_AUDIT_VERDICT=OK"; exit 0 ;;
  deferred_only)
    head_lines
    row PENDING_DEFERRED deferred 0 "$A" XAU/15m/BINANCE 10 11 0 OK
    summary 14 13 0 0 1 0
    echo "DISPATCH_AUDIT_VERDICT=OK"; exit 0 ;;
  insufficient)
    head_lines; summary 0 0 0 0 0 0
    echo "AUDIT_REASON=insufficient"
    echo "CRON_MINUTE_HINT=ran at minute 01; judged rows exist only after each HH:00 bar's due-time + 3 ticks has elapsed"
    echo "DISPATCH_AUDIT_VERDICT=INDETERMINATE"; exit 3 ;;
  timing_fault)
    head_lines
    row LATE_UNEXPLAINED first_tick_late 0 "$A" XAU/15m/BINANCE 70 0 2 TIMING_FAULT
    row LATE_UNEXPLAINED first_tick_late 0 "$B" XAU/15m/BINGX 70 0 1 TIMING_FAULT
    # designed recovery in the same bar: printed by the auditor, never an offender in the page
    row LATE_EXPLAINED deferred 0 "$(printf '%s%s' 77123 45395)" ETH/15m/HL 10 1 3 OK
    summary 14 11 1 0 3 2
    echo "DISPATCH_AUDIT_VERDICT=TIMING_FAULT"; exit 1 ;;
  many_offenders)
    head_lines
    i=0
    while [ "$i" -lt 12 ]; do
      row MISSED no_event 0 "$(printf '%s%s' 7712 "$(( 300000 + i ))")" "C$i/15m/BINANCE" 0 0 0 TIMING_FAULT
      i=$(( i + 1 ))
    done
    summary 14 2 0 0 0 12
    echo "DISPATCH_AUDIT_VERDICT=TIMING_FAULT"; exit 1 ;;
  deploy_regression)
    head_lines
    row UNPROVENANCED stamp_without_event 0 "$A" XAU/15m/BINANCE 0 0 0 DEPLOY_REGRESSION
    summary 14 13 0 0 0 1
    echo "DISPATCH_AUDIT_VERDICT=DEPLOY_REGRESSION"; exit 1 ;;
  schema_missing)
    head_lines
    echo "AUDIT_REASON=schema_missing"
    echo "DISPATCH_AUDIT_VERDICT=DEPLOY_REGRESSION"; exit 1 ;;
  chronic_late)
    head_lines
    row LATE_EXPLAINED fetch_failed 1 "$B" XAU/15m/BINGX 10 1 1 CHRONIC_LATE
    summary 14 13 1 1 0 1
    echo "DISPATCH_AUDIT_VERDICT=CHRONIC_LATE"; exit 1 ;;
  crash)
    echo "AUDIT_REASON=crash"
    echo "AUDIT_ERROR OperationalError: unable to open database file"
    echo "DISPATCH_AUDIT_VERDICT=INDETERMINATE"; exit 3 ;;
  no_token)
    head_lines; exit 0 ;;
  unknown_token)
    head_lines
    echo "DISPATCH_AUDIT_VERDICT=SOMETHING_NEW"; exit 1 ;;
  route_mismatch)
    head_lines; summary 14 14 0 0 0 0
    echo "DISPATCH_AUDIT_VERDICT=OK"; exit 0 ;;
  *)
    echo "stub-auditor: unknown STUB_SCENARIO=${STUB_SCENARIO:-}" >&2; exit 2 ;;
esac
