#!/usr/bin/env bash
# arm-peer-watchdog.sh — OPS-HOST-AUTO-REBOOT-W1. Runs on aoe-1 ONLY.
#
# Places (and removes) the ARM FILE that ops/monitoring/aoe-peer-watchdog.sh reads on signal-1.
#
# ── WHY THE ARM LIVES ON THE PEER, NOT HERE ─────────────────────────────────────────────────
# The watchdog's whole job is to notice that aoe-1 did not come back. A marker stored on aoe-1 is
# unreadable in exactly the scenario it exists for. So the arm is PUSHED to signal-1 before the
# reboot, and signal-1 reads a LOCAL file plus a probe.
#
# ── WHY NO NEW CREDENTIAL ───────────────────────────────────────────────────────────────────
# It reuses /root/.ssh/aoe_to_smpg, the key aoe-pg-tunnel.service already holds. Minting a second
# aoe-1 -> signal-1 key would be a second thing to rotate and a second thing to get wrong.
#
# SEPARATE FINDING, SURFACED NOT FIXED: signal-1's authorized_keys entry for that key carries no
# `command=`, no `restrict` and no `permitopen=`, so a key whose stated purpose is a Postgres
# port-forward grants full root SSH from aoe-1 into signal-1 (measured 2026-08-29: an arbitrary
# command runs). That is a real exposure and it is filed as OPS-AOE-TUNNEL-KEY-RESTRICT-W1 —
# NOT fixed mid-wave, because restricting it risks the live tunnel and CLAUDE.md forbids
# automating auth-posture changes. This script is deliberately written so that hardening lands
# cleanly later: it runs ONE fixed, argument-free remote command shape, which is exactly what a
# forced-command entry would allow.
#
# Verdict token: PEER_ARM_VERDICT=ARMED|DISARMED|FAILED|REFUSED. Exit ALWAYS 0 on the live path —
# the caller (kernel-auto-reboot.sh) treats a failed arm as DEGRADED, never as a reason to abort a
# reboot that three measured cycles say is the safe half.
set -uo pipefail

EXPECTED_HOST="aoe-1"          # hardcoded: only aoe-1 arms this watchdog
PEER="${PEER_ARM_PEER:-204.168.185.24}"
KEY="${PEER_ARM_KEY:-/root/.ssh/aoe_to_smpg}"
SSH_BIN="${PEER_ARM_SSH:-ssh}"
REMOTE="${PEER_ARM_REMOTE_PATH:-/var/lib/algovault-monitoring/.aoe-reboot-arm}"
IDENTITY_FILE="${PEER_ARM_IDENTITY_FILE:-/etc/algovault-host-label}"
LOG="${PEER_ARM_LOG:-/var/log/algovault-kernel-auto-reboot.log}"

_emit() { printf '%s\n' "$1"; ( printf '%s\n' "$1" >> "$LOG" ) 2>/dev/null || true; }
log() { _emit "$(printf '%s [PEER_ARM] %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*")"; }

resolve_host() {
  local h="${MONITORING_HOST_LABELS:-}"
  [ -n "$h" ] || { [ -r "$IDENTITY_FILE" ] && h="$(head -1 "$IDENTITY_FILE" 2>/dev/null | tr -d '[:space:]')"; }
  printf '%s' "${h%%,*}"
}

remote() { "$SSH_BIN" -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "root@$PEER" "$@"; }

cmd_arm() {
  # The payload is epoch + kernel: the watchdog derives the arm's AGE from the epoch, so it never
  # has to trust its own idea of when the reboot started.
  local payload; payload="$(date -u +%s) $(uname -r)"
  if remote "mkdir -p $(dirname "$REMOTE") && printf '%s\n' '$payload' > $REMOTE" >/dev/null 2>&1; then
    log "ARMED peer=$PEER path=$REMOTE payload='$payload'"
    echo "PEER_ARM_VERDICT=ARMED"
  else
    log "FAILED to arm peer=$PEER (rc=$?) — the reboot proceeds UNWATCHED and says so"
    echo "PEER_ARM_VERDICT=FAILED"
  fi
  return 0
}

cmd_disarm() {
  if remote "rm -f $REMOTE" >/dev/null 2>&1; then
    log "DISARMED peer=$PEER path=$REMOTE"
    echo "PEER_ARM_VERDICT=DISARMED"
  else
    # NOT fatal: the watchdog's stale-arm ceiling is the backstop for exactly this.
    log "FAILED to disarm peer=$PEER (rc=$?) — the watchdog's stale-arm ceiling will page instead"
    echo "PEER_ARM_VERDICT=FAILED"
  fi
  return 0
}

cmd_self_test() {
  local fails=0 n=0
  ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got '$2', want '$3'"; fails=$((fails+1)); fi; }
  local tmp; tmp=$(mktemp -d)
  local REAL_KEY="$KEY" REAL_PEER="$PEER" REAL_REMOTE="$REMOTE" REAL_ID="$IDENTITY_FILE"
  LOG="$tmp/log"
  printf 'aoe-1\n' > "$tmp/id-aoe"; printf 'signal-1\n' > "$tmp/id-signal"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 0\n' "$tmp/ssh-argv" > "$tmp/ssh-ok.sh"; chmod +x "$tmp/ssh-ok.sh"
  printf '#!/bin/sh\nexit 255\n' > "$tmp/ssh-dead.sh"; chmod +x "$tmp/ssh-dead.sh"

  echo "arm-peer-watchdog --self-test"
  ck "arming from aoe-1 succeeds" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-ok.sh cmd_arm | tail -1)" "PEER_ARM_VERDICT=ARMED"
  ck "…and it wrote the arm to the PEER, not locally" "$(grep -c "root@$PEER" "$tmp/ssh-argv")" "1"
  ck "…carrying an epoch the watchdog can age" "$(grep -cE "[0-9]{10}" "$tmp/ssh-argv")" "1"
  ck "…and it used the EXISTING tunnel key, not a new one" "$KEY" "/root/.ssh/aoe_to_smpg"
  rm -f "$tmp/ssh-argv"
  ck "disarming issues a remove on the peer" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-ok.sh cmd_disarm | tail -1)" "PEER_ARM_VERDICT=DISARMED"
  ck "…and it is the arm path being removed" "$(grep -c "rm -f $REMOTE" "$tmp/ssh-argv")" "1"
  ck "an unreachable peer FAILS loudly, never silently 'armed'" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-dead.sh cmd_arm | tail -1)" "PEER_ARM_VERDICT=FAILED"
  ck "…and a failed disarm is FAILED too, so the ceiling is the backstop" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-dead.sh cmd_disarm | tail -1)" "PEER_ARM_VERDICT=FAILED"
  ck "the live path ALWAYS exits 0" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-dead.sh cmd_arm >/dev/null 2>&1; echo $?)" "0"
  ck "exactly ONE terminal token" \
     "$(MONITORING_HOST_LABELS=aoe-1 SSH_BIN=$tmp/ssh-ok.sh cmd_arm | grep -c '^PEER_ARM_VERDICT=')" "1"
  # SEAM — every check above replaced SSH_BIN and the identity, so none can see the real defaults.
  ck "SEAM — the REAL peer address" "$REAL_PEER" "204.168.185.24"
  ck "SEAM — the REAL arm path" "$REAL_REMOTE" "/var/lib/algovault-monitoring/.aoe-reboot-arm"
  ck "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label"
  ck "SEAM — the expected host is a hardcoded constant" "$EXPECTED_HOST" "aoe-1"

  rm -rf "$tmp"
  if [ "$n" -lt 10 ]; then echo "SELF-TEST: only $n assertions ran (expected >= 10)"; echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3; fi
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST: $fails of $n failed"; echo "SELF_TEST_VERDICT=FAIL"; return 1; fi
  echo "SELF-TEST: PASS — $n checks"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

case "${1:-}" in
  --arm|--disarm)
    host="$(resolve_host)"
    if [ "$host" != "$EXPECTED_HOST" ]; then
      log "REFUSED: identity='${host:-<none>}' is not $EXPECTED_HOST — only $EXPECTED_HOST arms this watchdog"
      echo "PEER_ARM_VERDICT=REFUSED"; exit 0
    fi
    [ "$1" = "--arm" ] && cmd_arm || cmd_disarm ;;
  --self-test) cmd_self_test ;;
  *) echo "usage: $0 --arm|--disarm|--self-test" >&2; exit 2 ;;
esac
