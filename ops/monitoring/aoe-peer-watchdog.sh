#!/usr/bin/env bash
# aoe-peer-watchdog.sh — OPS-HOST-AUTO-REBOOT-W1. Runs on signal-1 ONLY, cron `9 * * * *`.
#
# The escalation half of aoe-1's unattended kernel reboot: if aoe-1 arms this watchdog and then
# does not come back, page.
#
# ── WHY A PEER, AND WHY NOT A CONSOLE PREFLIGHT ─────────────────────────────────────────────
# The three hand-run reboot waves each verified Hetzner console access before rebooting. That
# cannot be automated safely — an hcloud token on a host that can console into both boxes is a
# privilege escalation OF that host. signal-1 is a clean vantage instead: the dependency already
# runs aoe-1 -> signal-1 (aoe-pg-tunnel), never the reverse, so watching from here adds no new
# direction of trust. The probe uses signal-1's EXISTING /root/.ssh/algovault_deploy key.
#
# ── WHY :09, ON THE HOST WITH NO ROOM ───────────────────────────────────────────────────────
# R0.4 looked for an existing signal-1 artifact to extend and found none that fits: the only
# cross-host prober is monitoring-inventory-reconcile.py and it is DAILY, far too coarse. The
# sub-hourly artifacts (webhook-delivery 4x/h, deploy-drift 2x/h) have no cohesion with host
# liveness. So this is a new line on `:09` — one of the two minutes signal-1 has free of hourly
# work (the other is `:39`), which is exactly why signal-1 is out of scope for the reboot itself.
# offset(9) = 9 >= 3, so schedule-boundary-rule.json is satisfied.
#
# ── TWO DIFFERENT NUMBERS, BOTH STATED ──────────────────────────────────────────────────────
#   RETURN BUDGET  90s.  DERIVED: measured SSH return after a reboot is 31-42s (n=2, the W2 and W3
#                        hand-run cycles) -> +100% margin. Below this age the arm is simply too
#                        young to judge and the watchdog says ARMED_WAITING.
#   DETECTION LATENCY  <=60 min, because the cron is hourly. It is NOT the budget and must never be
#                        quoted as one; it is how long a genuine non-return can go unnoticed.
#
# ── THE PROPERTY THIS DESIGN HAS, STATED EXPLICITLY ─────────────────────────────────────────
# With NO arm present the watchdog is SILENT. That means it cannot page on an ordinary network
# blip — and, equally, it CANNOT page on an aoe-1 outage it did not initiate. That is a deliberate
# trade, not an oversight: an unconditional liveness pager on a non-revenue host is a new
# always-on alarm, and this wave's job is to escalate OUR OWN unattended action. A general aoe-1
# liveness alarm is a different artifact with a different owner.
#
# Two further guards make the arm honest:
#   * CONFIRMATION — a breach needs >=2 consecutive unreachable runs, so one flaky probe inside a
#     real reboot window cannot page. The counter is persistent and is reset by any success.
#   * STALE CEILING — an arm older than STALE_CEILING_S pages regardless of reachability. An arm
#     that never disarms IS the failure: it means aoe-1 came back but its post-boot assertion never
#     ran, or the disarm could not reach here.
#
# Verdict token: PEER_WATCHDOG_VERDICT=IDLE|ARMED_WAITING|ARMED_OK|BREACH|STALE|REFUSED|INDETERMINATE.
# Exit ALWAYS 0 on the live path; callers read the TOKEN. --self-test: 0 pass / 1 fail / 3 indeterminate.
set -uo pipefail

ALERT_ID="AOE_PEER_UNREACHABLE"
EXPECTED_HOST="signal-1"        # hardcoded: this watchdog runs on the PEER, not on aoe-1
TARGET="${PEER_WATCHDOG_TARGET:-178.104.200.44}"
TARGET_LABEL="aoe-1"
ARM="${PEER_WATCHDOG_ARM:-/var/lib/algovault-monitoring/.aoe-reboot-arm}"
STATE="${PEER_WATCHDOG_STATE:-/var/lib/algovault-monitoring/.aoe-peer-watchdog-breaches}"
LOG="${PEER_WATCHDOG_LOG:-/var/log/algovault-aoe-peer-watchdog.log}"
IDENTITY_FILE="${PEER_WATCHDOG_IDENTITY_FILE:-/etc/algovault-host-label}"
KEY="${PEER_WATCHDOG_KEY:-/root/.ssh/algovault_deploy}"
SSH_BIN="${PEER_WATCHDOG_SSH:-ssh}"
SEND="${PEER_WATCHDOG_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
# DERIVED, WITH ITS INSTRUMENT — never a round number pulled from the air.
#   measured SSH return after a reboot  31-42s   (n=2, the W2 and W3 hand-run cycles)
#   +100% margin on the observed MAX            -> 84s, taken to 90
RETURN_BUDGET_S="${PEER_WATCHDOG_BUDGET_S:-90}"
CONFIRM_RUNS="${PEER_WATCHDOG_CONFIRM_RUNS:-2}"
# 6h: comfortably past any plausible reboot, and short enough that a stuck arm is found the same
# working day. An arm this old means the disarm never ran, which is itself operator-action-required.
STALE_CEILING_S="${PEER_WATCHDOG_STALE_CEILING_S:-21600}"
NOW_OVERRIDE="${PEER_WATCHDOG_NOW:-}"

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

reachable() { "$SSH_BIN" -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "root@$TARGET" true >/dev/null 2>&1; }

page() { # page <condition> <context>
  printf '%s\n' \
    "🛑 $ALERT_ID — $TARGET_LABEL did not return from its unattended kernel reboot" \
    "Condition: $1" \
    "Context: $2" \
    "Watched from: $EXPECTED_HOST · target $TARGET_LABEL ($TARGET) · return budget ${RETURN_BUDGET_S}s (measured 31-42s + 100% margin)" \
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
  if [ "$host" != "$EXPECTED_HOST" ]; then
    check identity REFUSED "resolved='${host:-<none>}' expected=$EXPECTED_HOST — this watchdog is the PEER half and runs on $EXPECTED_HOST only"
    verdict REFUSED; return 0
  fi
  check identity PASS "resolved=$host"

  if [ ! -f "$ARM" ]; then
    # SILENT BY DESIGN — see THE PROPERTY THIS DESIGN HAS above. Still a POSITIVE line, so "no arm"
    # never reads like "the check did not run".
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
    # Too young to judge. Saying so is the point: a verdict of ARMED_OK here would be a guess.
    check budget WAITING "arm is ${age}s old, inside the ${RETURN_BUDGET_S}s return budget — too early to judge"
    verdict ARMED_WAITING; return 0
  fi

  if reachable; then
    check probe REACHABLE "$TARGET_LABEL answered SSH"
    set_breaches 0
    if [ "$age" -ge "$STALE_CEILING_S" ]; then
      # Reachable but still armed past the ceiling: aoe-1 came back and never disarmed, which means
      # its post-boot assertion did not run. That is operator-action-required on its own.
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
    # ONE unreachable probe is not a verdict. Requiring consecutive samples is what keeps a flaky
    # probe inside a real reboot window from paging.
    check probe UNREACHABLE "$TARGET_LABEL did not answer — consecutive=$b of $CONFIRM_RUNS required, not yet a breach"
    verdict ARMED_WAITING; return 0
  fi
  check probe BREACH "$TARGET_LABEL unreachable on $b consecutive runs with an arm ${age}s old"
  log "BREACH: $TARGET_LABEL unreachable, consecutive=$b, arm age ${age}s"
  page "$TARGET_LABEL armed a reboot ${age}s ago and has not returned" "unreachable on $b consecutive probes (>= $CONFIRM_RUNS required); return budget is ${RETURN_BUDGET_S}s, measured 31-42s across the W2/W3 cycles"
  verdict BREACH; return 0
}

cmd_self_test() {
  local fails=0 n=0
  ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got '$2', want '$3'"; fails=$((fails+1)); fi; }
  local tmp; tmp=$(mktemp -d)
  local REAL_TARGET="$TARGET" REAL_ARM="$ARM" REAL_KEY="$KEY" REAL_SEND="$SEND" REAL_BUDGET="$RETURN_BUDGET_S" REAL_CONFIRM="$CONFIRM_RUNS" REAL_CEIL="$STALE_CEILING_S" REAL_ID="$IDENTITY_FILE"
  LOG="$tmp/log"; ARM="$tmp/arm"; STATE="$tmp/breaches"
  printf 'signal-1\n' > "$tmp/id-sig"; printf 'aoe-1\n' > "$tmp/id-aoe"
  printf '#!/bin/sh\nexit 0\n'   > "$tmp/ssh-up.sh";   chmod +x "$tmp/ssh-up.sh"
  printf '#!/bin/sh\nexit 255\n' > "$tmp/ssh-down.sh"; chmod +x "$tmp/ssh-down.sh"
  printf '#!/bin/sh\ncat >> %s; echo "ALERT=$1 SEV=$2" >> %s\n' "$tmp/paged" "$tmp/paged" > "$tmp/send.sh"; chmod +x "$tmp/send.sh"
  SEND="$tmp/send.sh"
  arm_at() { printf '%s some-kernel\n' "$1" > "$ARM"; }

  echo "aoe-peer-watchdog --self-test"

  # ── identity ──────────────────────────────────────────────────────────────────────────────
  ck "running on aoe-1 REFUSES — this is the peer half" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-down.sh cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=REFUSED"
  ck "…and a REFUSED run never probes or pages" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"

  # ── NO ARM => SILENT. The stated property, asserted rather than described. ────────────────
  rm -f "$ARM"
  ck "no arm -> IDLE even when the target is DOWN (it cannot page on a blip)" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-down.sh NOW_OVERRIDE=1000000 cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=IDLE"
  ck "…and it stayed silent" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  ck "…but it still printed a POSITIVE line, so IDLE never reads as 'did not run'" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-down.sh cmd_run | grep -c 'PEER_WATCHDOG_CHECK=arm state=IDLE')" "1"

  # ── inside the budget: too young to judge ────────────────────────────────────────────────
  arm_at 1000000
  ck "an arm younger than the budget is ARMED_WAITING, never a verdict" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-down.sh NOW_OVERRIDE=1000030 cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "…and it did not page" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"

  # ── past the budget, target UP ───────────────────────────────────────────────────────────
  ck "past the budget with the target UP -> ARMED_OK" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-up.sh NOW_OVERRIDE=1000200 cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=ARMED_OK"
  ck "…and it did not page" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"

  # ── past the budget, target DOWN: ONE probe is not a breach ──────────────────────────────
  printf '0\n' > "$STATE"
  ck "first unreachable probe is ARMED_WAITING, not a page" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-down.sh NOW_OVERRIDE=1000200 cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "…and it still did not page" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  ck "the SECOND consecutive unreachable probe BREACHES" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-down.sh NOW_OVERRIDE=1000200 cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=BREACH"
  ck "…and THAT pages" "$(grep -c 'ALERT=AOE_PEER_UNREACHABLE SEV=CRITICAL_PERSISTENT' "$tmp/paged")" "1"
  ck "the page BODY names the target and the derived budget" \
     "$(grep -c 'return budget 90s (measured 31-42s + 100% margin)' "$tmp/paged")" "1"
  ck "the page BODY carries a TEMPLATED wave, never a literal one" \
     "$(grep -c 'Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT}' "$tmp/paged")" "1"
  # A success RESETS the counter, or one historical blip would arm a future page forever.
  rm -f "$tmp/paged"
  ck "a reachable probe RESETS the consecutive counter" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-up.sh NOW_OVERRIDE=1000200 cmd_run >/dev/null; cat "$STATE")" "0"

  # ── the stale ceiling: an arm that never disarms IS the failure ─────────────────────────
  rm -f "$tmp/paged"; printf '0\n' > "$STATE"
  ck "a REACHABLE target with an arm past the ceiling is STALE" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-up.sh NOW_OVERRIDE=1030000 cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=STALE"
  ck "…and it pages, because the post-boot assertion never ran" "$(grep -c 'ALERT=AOE_PEER_UNREACHABLE' "$tmp/paged")" "1"

  # ── an unparseable arm is INDETERMINATE, never IDLE ─────────────────────────────────────
  rm -f "$tmp/paged"; printf 'not-an-epoch\n' > "$ARM"
  ck "an arm with no epoch is INDETERMINATE, never a silent IDLE" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-up.sh cmd_run | tail -1)" "PEER_WATCHDOG_VERDICT=INDETERMINATE"

  arm_at 1000000
  ck "exactly ONE terminal token per run" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-up.sh NOW_OVERRIDE=1000200 cmd_run | grep -c '^PEER_WATCHDOG_VERDICT=')" "1"
  ck "the live path ALWAYS exits 0" \
     "$(MONITORING_HOST_LABELS=signal-1 SSH_BIN=$tmp/ssh-down.sh NOW_OVERRIDE=1000200 cmd_run >/dev/null 2>&1; echo $?)" "0"

  # ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────
  ck "SEAM — the REAL target is aoe-1's address" "$REAL_TARGET" "178.104.200.44"
  ck "SEAM — the REAL arm path matches what arm-peer-watchdog.sh writes" "$REAL_ARM" "/var/lib/algovault-monitoring/.aoe-reboot-arm"
  ck "SEAM — the REAL probe key is signal-1's EXISTING deploy key" "$REAL_KEY" "/root/.ssh/algovault_deploy"
  ck "SEAM — the REAL alert wrapper (never re-implement its gates inline)" "$REAL_SEND" "/opt/algovault-monitoring/send_telegram.sh"
  ck "SEAM — the DERIVED return budget" "$REAL_BUDGET" "90"
  ck "SEAM — the budget exceeds the measured worst return (42s) with margin" "$([ "$REAL_BUDGET" -gt 42 ] && echo yes)" "yes"
  ck "SEAM — a breach needs more than one sample" "$([ "$REAL_CONFIRM" -ge 2 ] && echo yes)" "yes"
  ck "SEAM — the stale ceiling is far past any plausible reboot" "$([ "$REAL_CEIL" -gt 3600 ] && echo yes)" "yes"
  ck "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label"

  rm -rf "$tmp"
  if [ "$n" -lt 20 ]; then echo "SELF-TEST: only $n assertions ran (expected >= 20)"; echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3; fi
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST: $fails of $n failed"; echo "SELF_TEST_VERDICT=FAIL"; return 1; fi
  echo "SELF-TEST: PASS — $n checks"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

case "${1:-}" in
  ""|--run)    cmd_run ;;
  --self-test) cmd_self_test ;;
  *) echo "usage: $0 [--run|--self-test]" >&2; exit 2 ;;
esac
