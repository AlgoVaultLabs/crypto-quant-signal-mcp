#!/usr/bin/env bash
# aoe-peer-watchdog.sh — OPS-HOST-AUTO-REBOOT-W1, generalized by
# OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1 into ONE implementation with a hardcoded PAIR TABLE.
#
# The escalation half of an unattended kernel reboot: if a host ARMS its peer's watchdog and then
# does not come back, the peer pages. The filename is historical (it predates the second
# direction) and is kept so signal-1's `9 * * * *` crontab line and its inventory row stay put.
#
# ── THE PAIR TABLE (the watcher -> what it watches) ─────────────────────────────────────────
#                      on signal-1 (watches aoe-1)          on aoe-1 (watches signal-1)
#   alert id           AOE_PEER_UNREACHABLE                 SIGNAL1_PEER_UNREACHABLE
#   cadence            9 * * * *  (detection <= 60 min)     3,8,13,…,53 * * * * (<= ~15 min)
#   probe              ssh root@aoe-1 true, with signal-1's TCP connect to signal-1:22 AND the
#                      EXISTING algovault_deploy key        public https://api.algovault.com/health
#                                                           — CREDENTIAL-FREE (PR-4): zero new uses
#                                                           of aoe_to_smpg (audit finding AOE-01)
#   return budget      90 s  (measured 31-42 s, W2/W3,      100 s (measured 48.6 s reboot->SSH, W5
#                      +100%)                               M2, +100% = 97.2 -> 100)
#   arm file           .aoe-reboot-arm                      .signal1-reboot-arm
#   breach counter     .aoe-peer-watchdog-breaches          .signal1-peer-watchdog-breaches
#   log                algovault-aoe-peer-watchdog.log      algovault-signal1-peer-watchdog.log
# (arm/counter under /var/lib/algovault-monitoring/, logs under /var/log/). An unlisted host REFUSES.
#
# "Returned" for the revenue host means SERVING, not just booted: both probes must pass. A host
# whose SSH answers but whose /health does not has not come back from our reboot in any sense
# that matters.
#
# ── TWO DIFFERENT NUMBERS, BOTH STATED ──────────────────────────────────────────────────────
#   RETURN BUDGET  below this age the arm is simply too young to judge -> ARMED_WAITING.
#   DETECTION LATENCY  how long a genuine non-return can go unnoticed: the cadence plus the
#                      confirmation run. It is NOT the budget and must never be quoted as one.
#
# ── THE PROPERTY THIS DESIGN HAS, STATED EXPLICITLY (PR-5) ──────────────────────────────────
# With NO arm present the watchdog is SILENT, in BOTH directions. It cannot page on a blip — and,
# equally, it CANNOT page on an outage it was not armed for. This escalates OUR OWN unattended
# action; an unconditional liveness alarm is a different artifact with a different owner.
#   * CONFIRMATION — a breach needs >= 2 consecutive unreachable runs; the counter persists and any
#     success resets it.
#   * STALE CEILING — an arm older than 6 h pages regardless of reachability: the target came back
#     but its post-boot run never disarmed, which is itself operator-action-required.
#
# Verdict token: PEER_WATCHDOG_VERDICT=IDLE|ARMED_WAITING|ARMED_OK|BREACH|STALE|REFUSED|INDETERMINATE.
# Exit ALWAYS 0 on the live path; callers read the TOKEN. --self-test: 0 pass / 1 fail / 3 indeterminate.
set -uo pipefail

IDENTITY_FILE="${PEER_WATCHDOG_IDENTITY_FILE:-/etc/algovault-host-label}"
SSH_BIN="${PEER_WATCHDOG_SSH:-ssh}"
CURL_BIN="${PEER_WATCHDOG_CURL:-curl}"
# The credential-free TCP probe. Seamed so --self-test can drive it; the real default is asserted.
TCP_BIN="${PEER_WATCHDOG_TCP:-}"
SEND="${PEER_WATCHDOG_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
CONFIRM_RUNS="${PEER_WATCHDOG_CONFIRM_RUNS:-2}"
# 6h: past any plausible reboot, and short enough that a stuck arm is found the same working day.
STALE_CEILING_S="${PEER_WATCHDOG_STALE_CEILING_S:-21600}"
NOW_OVERRIDE="${PEER_WATCHDOG_NOW:-}"

# The pair table, keyed by the WATCHER's identity. Hardcoded on purpose.
pair() { # pair <watcher> <key>
  case "$1:$2" in
    signal-1:alert_id)      ALERT_ID="AOE_PEER_UNREACHABLE"; echo "$ALERT_ID" ;;
    signal-1:target)        echo 178.104.200.44 ;;
    signal-1:target_label)  echo aoe-1 ;;
    signal-1:probe)         echo ssh ;;
    signal-1:budget)        echo 90 ;;
    signal-1:budget_note)   echo "measured 31-42s + 100% margin" ;;
    signal-1:arm)           echo /var/lib/algovault-monitoring/.aoe-reboot-arm ;;
    signal-1:state)         echo /var/lib/algovault-monitoring/.aoe-peer-watchdog-breaches ;;
    signal-1:log)           echo /var/log/algovault-aoe-peer-watchdog.log ;;
    signal-1:key)           echo /root/.ssh/algovault_deploy ;;
    signal-1:health_url)    echo "" ;;
    aoe-1:alert_id)         ALERT_ID="SIGNAL1_PEER_UNREACHABLE"; echo "$ALERT_ID" ;;
    aoe-1:target)           echo 204.168.185.24 ;;
    aoe-1:target_label)     echo signal-1 ;;
    aoe-1:probe)            echo tcp+health ;;
    aoe-1:budget)           echo 100 ;;
    aoe-1:budget_note)      echo "measured 48.6s reboot->SSH (W5 M2) + 100% margin" ;;
    aoe-1:health_url)       echo https://api.algovault.com/health ;;
    aoe-1:arm)              echo /var/lib/algovault-monitoring/.signal1-reboot-arm ;;
    aoe-1:state)            echo /var/lib/algovault-monitoring/.signal1-peer-watchdog-breaches ;;
    aoe-1:log)              echo /var/log/algovault-signal1-peer-watchdog.log ;;
    aoe-1:key)              echo "" ;;
    *) return 1 ;;
  esac
}

ALERT_ID="" WATCHER="" TARGET="" TARGET_LABEL="" PROBE="" RETURN_BUDGET_S="" BUDGET_NOTE=""
ARM="" STATE="" LOG="${PEER_WATCHDOG_LOG:-/dev/null}" KEY="" HEALTH_URL=""
load_pair() { # load_pair <watcher> — fails for an unlisted watcher
  pair "$1" target >/dev/null || return 1
  WATCHER="$1"
  ALERT_ID="$(pair "$1" alert_id)"
  TARGET="${PEER_WATCHDOG_TARGET:-$(pair "$1" target)}"
  TARGET_LABEL="$(pair "$1" target_label)"
  PROBE="$(pair "$1" probe)"
  RETURN_BUDGET_S="${PEER_WATCHDOG_BUDGET_S:-$(pair "$1" budget)}"
  BUDGET_NOTE="$(pair "$1" budget_note)"
  ARM="${PEER_WATCHDOG_ARM:-$(pair "$1" arm)}"
  STATE="${PEER_WATCHDOG_STATE:-$(pair "$1" state)}"
  LOG="${PEER_WATCHDOG_LOG:-$(pair "$1" log)}"
  KEY="${PEER_WATCHDOG_KEY:-$(pair "$1" key)}"
  HEALTH_URL="${PEER_WATCHDOG_HEALTH_URL:-$(pair "$1" health_url)}"
}

_emit() { printf '%s\n' "$1"; ( printf '%s\n' "$1" >> "$LOG" ) 2>/dev/null || true; }
log() { _emit "$(printf '%s [%s] %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*")"; }
check() { _emit "$(printf 'PEER_WATCHDOG_CHECK=%s state=%s %s' "$1" "$2" "${3:-}")"; }
verdict() { echo "PEER_WATCHDOG_VERDICT=$1"; }
now() { [ -n "$NOW_OVERRIDE" ] && printf '%s' "$NOW_OVERRIDE" || date -u +%s; }

resolve_host() {
  local h="${MONITORING_HOST_LABELS:-}"
  [ -n "$h" ] || { [ -r "$IDENTITY_FILE" ] && h="$(head -1 "$IDENTITY_FILE" 2>/dev/null | tr -d '[:space:]')"; }
  printf '%s' "${h%%,*}"
}

# TCP connect with a bounded wait. bash's /dev/tcp needs no binary and no credential.
tcp_open() { # tcp_open <host> <port>
  if [ -n "$TCP_BIN" ]; then "$TCP_BIN" "$1" "$2"; return $?; fi
  timeout 10 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
}

PROBE_DETAIL=""
reachable() {
  case "$PROBE" in
    ssh)
      "$SSH_BIN" -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "root@$TARGET" true >/dev/null 2>&1
      local rc=$?; PROBE_DETAIL="ssh rc=$rc"; return $rc ;;
    tcp+health)
      # NEVER ssh in this direction: the only aoe-1 -> signal-1 credential is aoe_to_smpg, and
      # this probe adds zero uses of it (AOE-01).
      local t=down code
      tcp_open "$TARGET" 22 && t=open
      code="$("$CURL_BIN" -s -o /dev/null -m 10 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)" || true
      PROBE_DETAIL="tcp22=$t health=${code:-000}"
      [ "$t" = open ] && [ "${code:-000}" = 200 ] ;;
    *) PROBE_DETAIL="no probe declared"; return 2 ;;
  esac
}

page() { # page <condition> <context>
  printf '%s\n' \
    "🛑 $ALERT_ID — $TARGET_LABEL did not return from its unattended kernel reboot" \
    "Condition: $1" \
    "Context: $2" \
    "Watched from: $WATCHER · target $TARGET_LABEL ($TARGET) · probe $PROBE · return budget ${RETURN_BUDGET_S}s ($BUDGET_NOTE)" \
    "Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT} via Cowork → Claude Code" \
    "Audit shape: ops/monitoring/aoe-peer-watchdog.sh --self-test" \
    "Source log: $LOG" \
  | ( "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" ) 2>/dev/null \
  || log "FAIL_OPEN: send_telegram invocation failed (rc=$?) — the wrapper owns fail-open; this is the record that it did"
}

breaches() { [ -r "$STATE" ] && head -1 "$STATE" 2>/dev/null | tr -cd '0-9' || printf '0'; }
set_breaches() { mkdir -p "$(dirname "$STATE")" 2>/dev/null; printf '%s\n' "$1" > "$STATE" 2>/dev/null || true; }

cmd_run() {
  local host; host="$(resolve_host)"
  if [ -z "$host" ] || ! load_pair "$host"; then
    check identity REFUSED "resolved='${host:-<none>}' — not in the pair table (signal-1 watches aoe-1, aoe-1 watches signal-1)"
    verdict REFUSED; return 0
  fi
  check identity PASS "resolved=$host · watching $TARGET_LABEL via $PROBE"

  if [ ! -f "$ARM" ]; then
    # SILENT BY DESIGN — still a POSITIVE line, so "no arm" never reads like "did not run".
    check arm IDLE "no arm at $ARM — $TARGET_LABEL has not asked to be watched; this watchdog is silent by design"
    set_breaches 0
    verdict IDLE; return 0
  fi

  local stamp age
  stamp="$(head -1 "$ARM" 2>/dev/null | awk '{print $1}' | tr -cd '0-9')"
  if [ -z "$stamp" ]; then
    check arm INDETERMINATE "arm exists at $ARM but carries no epoch — cannot age it, and will not guess"
    log "INDETERMINATE: unparseable arm file"
    page "the peer arm file is unparseable" "path=$ARM — it exists, so a reboot was intended, but its age cannot be derived"
    verdict INDETERMINATE; return 0
  fi
  age=$(( $(now) - stamp ))
  check arm PRESENT "armed ${age}s ago (budget ${RETURN_BUDGET_S}s, stale ceiling ${STALE_CEILING_S}s)"

  if [ "$age" -lt "$RETURN_BUDGET_S" ]; then
    check budget WAITING "arm is ${age}s old, inside the ${RETURN_BUDGET_S}s return budget — too early to judge"
    verdict ARMED_WAITING; return 0
  fi

  if reachable; then
    check probe REACHABLE "$TARGET_LABEL answered ($PROBE_DETAIL)"
    set_breaches 0
    if [ "$age" -ge "$STALE_CEILING_S" ]; then
      check stale BREACH "arm is ${age}s old (>= ${STALE_CEILING_S}s) while $TARGET_LABEL is REACHABLE — it returned but never disarmed"
      log "STALE: arm age ${age}s with a reachable target"
      page "$TARGET_LABEL is reachable but its reboot arm was never cleared" "arm age ${age}s >= ceiling ${STALE_CEILING_S}s — the post-boot assertion on $TARGET_LABEL did not run, or its disarm could not reach here"
      verdict STALE; return 0
    fi
    check stale PASS "arm age ${age}s is inside the ${STALE_CEILING_S}s ceiling"
    verdict ARMED_OK; return 0
  fi

  local b; b=$(( $(breaches) + 1 ))
  set_breaches "$b"
  if [ "$b" -lt "$CONFIRM_RUNS" ]; then
    check probe UNREACHABLE "$TARGET_LABEL did not answer ($PROBE_DETAIL) — consecutive=$b of $CONFIRM_RUNS required, not yet a breach"
    verdict ARMED_WAITING; return 0
  fi
  check probe BREACH "$TARGET_LABEL unreachable ($PROBE_DETAIL) on $b consecutive runs with an arm ${age}s old"
  log "BREACH: $TARGET_LABEL unreachable ($PROBE_DETAIL), consecutive=$b, arm age ${age}s"
  page "$TARGET_LABEL armed a reboot ${age}s ago and has not returned" "unreachable ($PROBE_DETAIL) on $b consecutive probes (>= $CONFIRM_RUNS required); return budget ${RETURN_BUDGET_S}s ($BUDGET_NOTE)"
  verdict BREACH; return 0
}

cmd_self_test() {
  local fails=0 n=0
  ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got '$2', want '$3'"; fails=$((fails+1)); fi; }
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/pwd-st.XXXXXX")
  local REAL_ID="$IDENTITY_FILE" REAL_SEND="$SEND" REAL_SSH="$SSH_BIN" REAL_CONFIRM="$CONFIRM_RUNS" REAL_CEIL="$STALE_CEILING_S"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 0\n'   "$tmp/ssh-argv" > "$tmp/ssh-up.sh";   chmod +x "$tmp/ssh-up.sh"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 255\n' "$tmp/ssh-argv" > "$tmp/ssh-down.sh"; chmod +x "$tmp/ssh-down.sh"
  printf '#!/bin/sh\nexit 0\n' > "$tmp/tcp-up.sh";   chmod +x "$tmp/tcp-up.sh"
  printf '#!/bin/sh\nexit 1\n' > "$tmp/tcp-down.sh"; chmod +x "$tmp/tcp-down.sh"
  printf '#!/bin/sh\necho 200\n' > "$tmp/curl-200.sh"; chmod +x "$tmp/curl-200.sh"
  printf '#!/bin/sh\necho 502\n' > "$tmp/curl-502.sh"; chmod +x "$tmp/curl-502.sh"
  printf '#!/bin/sh\ncat >> %s; echo "ALERT=$1 SEV=$2" >> %s\n' "$tmp/paged" "$tmp/paged" > "$tmp/send.sh"; chmod +x "$tmp/send.sh"
  # One sandbox per watcher, so the two directions never share an arm or a counter.
  w() { # w <watcher> [VAR=value ...]
    local who="$1"; shift
    env MONITORING_HOST_LABELS="$who" PEER_WATCHDOG_LOG="$tmp/log-$who" PEER_WATCHDOG_ARM="$tmp/arm-$who" \
      PEER_WATCHDOG_STATE="$tmp/breaches-$who" PEER_WATCHDOG_WRAPPER="$tmp/send.sh" \
      PEER_WATCHDOG_SSH="$tmp/ssh-down.sh" PEER_WATCHDOG_TCP="$tmp/tcp-down.sh" PEER_WATCHDOG_CURL="$tmp/curl-502.sh" \
      "$@" bash "$0" --run 2>/dev/null
  }
  arm_at() { printf '%s some-kernel\n' "$2" > "$tmp/arm-$1"; }
  tok() { tail -1; }

  echo "aoe-peer-watchdog --self-test"

  # ── identity / pair table ─────────────────────────────────────────────────────────────────
  ck "an UNLISTED watcher REFUSES" "$(w mars-1 | tok)" "PEER_WATCHDOG_VERDICT=REFUSED"
  ck "…and never probes or pages" "$([ -f "$tmp/paged" ] || [ -f "$tmp/ssh-argv" ] && echo touched || echo clean)" "clean"

  # ── signal-1 watches aoe-1 — W1 behaviour, unchanged ─────────────────────────────────────
  rm -f "$tmp/arm-signal-1"
  ck "[s1->aoe] no arm -> IDLE even with the target DOWN" "$(w signal-1 PEER_WATCHDOG_NOW=1000000 | tok)" "PEER_WATCHDOG_VERDICT=IDLE"
  ck "[s1->aoe] …silent" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  ck "[s1->aoe] …but POSITIVE" "$(w signal-1 | grep -c 'PEER_WATCHDOG_CHECK=arm state=IDLE')" "1"
  arm_at signal-1 1000000
  ck "[s1->aoe] inside the 90s budget -> ARMED_WAITING" "$(w signal-1 PEER_WATCHDOG_NOW=1000030 | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[s1->aoe] past budget, target UP -> ARMED_OK" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=ARMED_OK"
  printf '0\n' > "$tmp/breaches-signal-1"
  ck "[s1->aoe] first unreachable probe is ARMED_WAITING" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[s1->aoe] the SECOND consecutive one BREACHES" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 | tok)" "PEER_WATCHDOG_VERDICT=BREACH"
  ck "[s1->aoe] …and pages AOE_PEER_UNREACHABLE" "$(grep -c 'ALERT=AOE_PEER_UNREACHABLE SEV=CRITICAL_PERSISTENT' "$tmp/paged" 2>/dev/null)" "1"
  ck "[s1->aoe] the page names the 90s derived budget" "$(grep -c 'return budget 90s (measured 31-42s + 100% margin)' "$tmp/paged")" "2"
  ck "[s1->aoe] the probe used signal-1's EXISTING deploy key" "$(grep -c -- '-i /root/.ssh/algovault_deploy' "$tmp/ssh-argv")" "3"
  rm -f "$tmp/paged"
  ck "[s1->aoe] a reachable probe RESETS the counter" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" >/dev/null; cat "$tmp/breaches-signal-1")" "0"
  ck "[s1->aoe] reachable + arm past the 6h ceiling -> STALE" "$(w signal-1 PEER_WATCHDOG_NOW=1030000 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=STALE"
  printf 'not-an-epoch\n' > "$tmp/arm-signal-1"
  ck "[s1->aoe] an arm with no epoch is INDETERMINATE" "$(w signal-1 | tok)" "PEER_WATCHDOG_VERDICT=INDETERMINATE"

  # ── aoe-1 watches signal-1 — the new direction, CREDENTIAL-FREE ─────────────────────────
  rm -f "$tmp/arm-aoe-1" "$tmp/ssh-argv" "$tmp/paged"
  ck "[aoe->s1] no arm -> IDLE, silent" "$(w aoe-1 PEER_WATCHDOG_NOW=1000000 | tok)" "PEER_WATCHDOG_VERDICT=IDLE"
  arm_at aoe-1 1000000
  ck "[aoe->s1] inside the 100s budget -> ARMED_WAITING" "$(w aoe-1 PEER_WATCHDOG_NOW=1000099 | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[aoe->s1] past budget, TCP open AND /health 200 -> ARMED_OK" \
     "$(w aoe-1 PEER_WATCHDOG_NOW=1000150 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" PEER_WATCHDOG_CURL="$tmp/curl-200.sh" | tok)" "PEER_WATCHDOG_VERDICT=ARMED_OK"
  ck "[aoe->s1] SSH up but /health 502 is NOT 'returned' (first run waits)" \
     "$(w aoe-1 PEER_WATCHDOG_NOW=1000150 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[aoe->s1] …and the second such run BREACHES" \
     "$(w aoe-1 PEER_WATCHDOG_NOW=1000150 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=BREACH"
  ck "[aoe->s1] …paging SIGNAL1_PEER_UNREACHABLE (a distinct id, a distinct remedy)" "$(grep -c 'ALERT=SIGNAL1_PEER_UNREACHABLE SEV=CRITICAL_PERSISTENT' "$tmp/paged" 2>/dev/null)" "1"
  ck "[aoe->s1] the page names the derived 100s budget and its instrument" "$(grep -c 'return budget 100s (measured 48.6s reboot->SSH (W5 M2) + 100% margin)' "$tmp/paged")" "2"
  ck "[aoe->s1] the page names what the probe saw" "$(grep -c 'tcp22=open health=502' "$tmp/paged")" "1"
  ck "[aoe->s1] AC2.2 — the signal-1-watching instance NEVER invokes ssh (captured argv)" "$([ -f "$tmp/ssh-argv" ] && echo yes || echo no)" "no"
  ck "[aoe->s1] the page carries a TEMPLATED wave" "$(grep -c 'Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT}' "$tmp/paged")" "1"

  # ── one token, exit 0 ───────────────────────────────────────────────────────────────────
  arm_at signal-1 1000000
  ck "exactly ONE terminal token per run" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" | grep -c '^PEER_WATCHDOG_VERDICT=')" "1"
  ck "the live path ALWAYS exits 0" "$(w aoe-1 PEER_WATCHDOG_NOW=1000200 >/dev/null 2>&1; echo $?)" "0"

  # ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────
  ck "SEAM — the REAL alert wrapper" "$REAL_SEND" "/opt/algovault-monitoring/send_telegram.sh"
  ck "SEAM — the REAL ssh binary" "$REAL_SSH" "ssh"
  ck "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label"
  ck "SEAM — a breach needs more than one sample" "$([ "$REAL_CONFIRM" -ge 2 ] && echo yes)" "yes"
  ck "SEAM — the stale ceiling is far past any plausible reboot" "$([ "$REAL_CEIL" -gt 3600 ] && echo yes)" "yes"
  ck "PAIR — signal-1 watches aoe-1's address over ssh" "$(pair signal-1 target)/$(pair signal-1 probe)" "178.104.200.44/ssh"
  ck "PAIR — aoe-1 watches signal-1's address credential-free" "$(pair aoe-1 target)/$(pair aoe-1 probe)/$(pair aoe-1 key)" "204.168.185.24/tcp+health/"
  ck "PAIR — the arm paths are what arm-peer-watchdog.sh writes" \
     "$(pair signal-1 arm)|$(pair aoe-1 arm)" "/var/lib/algovault-monitoring/.aoe-reboot-arm|/var/lib/algovault-monitoring/.signal1-reboot-arm"
  ck "PAIR — the budgets are 90 (31-42s +100%) and 100 (48.6s +100%)" "$(pair signal-1 budget)/$(pair aoe-1 budget)" "90/100"
  ck "PAIR — both budgets exceed their measured worst return" "$([ "$(pair signal-1 budget)" -gt 42 ] && [ "$(pair aoe-1 budget)" -gt 49 ] && echo yes)" "yes"
  ck "PAIR — the real health URL is the public one" "$(pair aoe-1 health_url)" "https://api.algovault.com/health"

  rm -rf "$tmp"
  if [ "$n" -lt 38 ]; then echo "SELF-TEST: only $n assertions ran (expected >= 38)"; echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3; fi
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST: $fails of $n failed"; echo "SELF_TEST_VERDICT=FAIL"; return 1; fi
  echo "SELF-TEST: PASS — $n checks"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

case "${1:-}" in
  ""|--run)    cmd_run ;;
  --self-test) cmd_self_test ;;
  *) echo "usage: $0 [--run|--self-test]" >&2; exit 2 ;;
esac
