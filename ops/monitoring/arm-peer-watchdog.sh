#!/usr/bin/env bash
# arm-peer-watchdog.sh — OPS-HOST-AUTO-REBOOT-W1, generalized by
# OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1 into ONE implementation with a hardcoded PAIR TABLE.
#
# Places (and removes) the ARM FILE that the PEER's watchdog (aoe-peer-watchdog.sh, running on the
# peer) reads before this host reboots. The filename is historical — it predates the second
# direction — and is kept so no host crontab or inventory row has to move with it.
#
# ── THE PAIR TABLE (the rebooting host -> who watches it) ───────────────────────────────────
#   rebooting host   peer (watcher)               key on THIS host               arm file ON THE PEER
#   aoe-1            signal-1 204.168.185.24      /root/.ssh/aoe_to_smpg         .aoe-reboot-arm
#   signal-1         aoe-1    178.104.200.44      /root/.ssh/algovault_deploy    .signal1-reboot-arm
# (both under /var/lib/algovault-monitoring/). Hardcoded on purpose: an unlisted host REFUSES.
#
# ── WHY THE ARM LIVES ON THE PEER, NOT HERE ─────────────────────────────────────────────────
# The watchdog's job is to notice that THIS host did not come back. A marker stored here is
# unreadable in exactly the scenario it exists for. And because it lives on the peer, the peer's
# own reboot harness reads it LOCALLY as "my peer is mid-cycle" — that is the mutual exclusion
# kernel-auto-reboot.sh's peer_busy gate consumes, with no coordination channel of its own.
#
# ── NO NEW CREDENTIAL, IN EITHER DIRECTION ──────────────────────────────────────────────────
#   aoe-1 -> signal-1 reuses /root/.ssh/aoe_to_smpg, the key aoe-pg-tunnel.service already holds.
#   signal-1 -> aoe-1 reuses /root/.ssh/algovault_deploy, the key aoe-peer-watchdog.sh already uses
#   hourly to probe aoe-1. Zero new uses of aoe_to_smpg are added (audit finding AOE-01).
#
# SEPARATE FINDING, SURFACED NOT FIXED (W1): signal-1's authorized_keys entry for aoe_to_smpg
# carries no `command=` / `restrict` / `permitopen=`, so it grants full root SSH from aoe-1. Filed
# as OPS-AOE-TUNNEL-KEY-RESTRICT-W1. This script runs ONE fixed, argument-free remote command shape
# per verb so a forced-command entry can be added later without touching it.
#
# Verdict token: PEER_ARM_VERDICT=ARMED|DISARMED|FAILED|REFUSED. Exit ALWAYS 0 on the live path —
# callers read the TOKEN (kernel-auto-reboot.sh does since the promotion; W1 read the exit code and
# so could never see a failed arm). --self-test: 0 pass / 1 fail / 3 indeterminate.
set -uo pipefail

IDENTITY_FILE="${PEER_ARM_IDENTITY_FILE:-/etc/algovault-host-label}"
SSH_BIN="${PEER_ARM_SSH:-ssh}"
LOG="${PEER_ARM_LOG:-/var/log/algovault-kernel-auto-reboot.log}"

# The pair table. Seam overrides exist only for the paths a hermetic test must redirect.
pair() { # pair <rebooting host> <key>
  case "$1:$2" in
    aoe-1:peer)          echo 204.168.185.24 ;;
    aoe-1:peer_label)    echo signal-1 ;;
    aoe-1:key)           echo /root/.ssh/aoe_to_smpg ;;
    aoe-1:remote)        echo /var/lib/algovault-monitoring/.aoe-reboot-arm ;;
    signal-1:peer)       echo 178.104.200.44 ;;
    signal-1:peer_label) echo aoe-1 ;;
    signal-1:key)        echo /root/.ssh/algovault_deploy ;;
    signal-1:remote)     echo /var/lib/algovault-monitoring/.signal1-reboot-arm ;;
    *) return 1 ;;
  esac
}

_emit() { printf '%s\n' "$1"; ( printf '%s\n' "$1" >> "$LOG" ) 2>/dev/null || true; }
log() { _emit "$(printf '%s [PEER_ARM] %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*")"; }

resolve_host() {
  local h="${MONITORING_HOST_LABELS:-}"
  [ -n "$h" ] || { [ -r "$IDENTITY_FILE" ] && h="$(head -1 "$IDENTITY_FILE" 2>/dev/null | tr -d '[:space:]')"; }
  printf '%s' "${h%%,*}"
}

PEER="" KEY="" REMOTE=""
load_pair() { # load_pair <host> — fails for an unlisted host
  PEER="${PEER_ARM_PEER:-$(pair "$1" peer)}" || return 1
  KEY="${PEER_ARM_KEY:-$(pair "$1" key)}" || return 1
  REMOTE="${PEER_ARM_REMOTE_PATH:-$(pair "$1" remote)}" || return 1
  pair "$1" peer >/dev/null
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
    log "FAILED to arm peer=$PEER (rc=$?) — the caller's per-host policy decides (signal-1 DEFERS, aoe-1 proceeds DEGRADED)"
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
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/arm-st.XXXXXX")
  local REAL_ID="$IDENTITY_FILE" REAL_SSH="$SSH_BIN"
  LOG="$tmp/log"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 0\n' "$tmp/ssh-argv" > "$tmp/ssh-ok.sh"; chmod +x "$tmp/ssh-ok.sh"
  printf '#!/bin/sh\nexit 255\n' > "$tmp/ssh-dead.sh"; chmod +x "$tmp/ssh-dead.sh"
  run() { # run <host> <verb> [ssh]
    MONITORING_HOST_LABELS="$1" PEER_ARM_SSH="${3:-$tmp/ssh-ok.sh}" PEER_ARM_LOG="$LOG" bash "$0" "--$2" 2>/dev/null
  }

  echo "arm-peer-watchdog --self-test"
  # ── aoe-1 -> signal-1, unchanged from W1 ────────────────────────────────────────────────
  rm -f "$tmp/ssh-argv"
  ck "arming from aoe-1 succeeds" "$(run aoe-1 arm | tail -1)" "PEER_ARM_VERDICT=ARMED"
  ck "…to signal-1's address" "$(grep -c 'root@204.168.185.24' "$tmp/ssh-argv")" "1"
  ck "…with the EXISTING tunnel key" "$(grep -c -- '-i /root/.ssh/aoe_to_smpg' "$tmp/ssh-argv")" "1"
  ck "…at the arm path signal-1's watchdog reads" "$(grep -c '/var/lib/algovault-monitoring/.aoe-reboot-arm' "$tmp/ssh-argv")" "1"
  ck "…carrying an epoch the watchdog can age" "$(grep -cE '[0-9]{10} ' "$tmp/ssh-argv")" "1"
  # ── signal-1 -> aoe-1, the new direction ────────────────────────────────────────────────
  rm -f "$tmp/ssh-argv"
  ck "arming from signal-1 succeeds" "$(run signal-1 arm | tail -1)" "PEER_ARM_VERDICT=ARMED"
  ck "…to aoe-1's address" "$(grep -c 'root@178.104.200.44' "$tmp/ssh-argv")" "1"
  ck "…with signal-1's EXISTING deploy key — never aoe_to_smpg" "$(grep -c -- '-i /root/.ssh/algovault_deploy' "$tmp/ssh-argv"):$(grep -c aoe_to_smpg "$tmp/ssh-argv")" "1:0"
  ck "…at the arm path aoe-1's watchdog AND aoe-1's harness read" "$(grep -c '/var/lib/algovault-monitoring/.signal1-reboot-arm' "$tmp/ssh-argv")" "1"
  rm -f "$tmp/ssh-argv"
  ck "disarming from signal-1 removes that path on aoe-1" "$(run signal-1 disarm | tail -1)" "PEER_ARM_VERDICT=DISARMED"
  ck "…the fixed command shape" "$(grep -c 'rm -f /var/lib/algovault-monitoring/.signal1-reboot-arm' "$tmp/ssh-argv")" "1"
  # ── failure is LOUD, in the token ───────────────────────────────────────────────────────
  ck "an unreachable peer FAILS loudly, never silently 'armed'" "$(run signal-1 arm "$tmp/ssh-dead.sh" | tail -1)" "PEER_ARM_VERDICT=FAILED"
  ck "…and a failed disarm is FAILED too" "$(run aoe-1 disarm "$tmp/ssh-dead.sh" | tail -1)" "PEER_ARM_VERDICT=FAILED"
  ck "the live path ALWAYS exits 0 (callers read the TOKEN)" "$(run signal-1 arm "$tmp/ssh-dead.sh" >/dev/null 2>&1; echo $?)" "0"
  ck "exactly ONE terminal token" "$(run aoe-1 arm | grep -c '^PEER_ARM_VERDICT=')" "1"
  # ── the pair table is the allow-list ────────────────────────────────────────────────────
  rm -f "$tmp/ssh-argv"
  ck "an UNLISTED host REFUSES" "$(run mars-1 arm | tail -1)" "PEER_ARM_VERDICT=REFUSED"
  ck "…without ever invoking ssh" "$([ -f "$tmp/ssh-argv" ] && echo yes || echo no)" "no"
  ck "an UNRESOLVABLE identity REFUSES" "$(MONITORING_HOST_LABELS= PEER_ARM_IDENTITY_FILE=/nonexistent PEER_ARM_SSH="$tmp/ssh-ok.sh" PEER_ARM_LOG="$LOG" bash "$0" --arm | tail -1)" "PEER_ARM_VERDICT=REFUSED"
  ck "the pair table has no default for an unlisted host" "$(pair mars-1 peer >/dev/null 2>&1 && echo yes || echo no)" "no"
  # SEAM — every check above replaced SSH_BIN and the identity, so none can see the real defaults.
  ck "SEAM — the REAL ssh binary" "$REAL_SSH" "ssh"
  ck "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label"

  rm -rf "$tmp"
  if [ "$n" -lt 21 ]; then echo "SELF-TEST: only $n assertions ran (expected >= 21)"; echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3; fi
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST: $fails of $n failed"; echo "SELF_TEST_VERDICT=FAIL"; return 1; fi
  echo "SELF-TEST: PASS — $n checks"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

case "${1:-}" in
  --arm|--disarm)
    host="$(resolve_host)"
    if [ -z "$host" ] || ! load_pair "$host"; then
      log "REFUSED: identity='${host:-<none>}' is not in the pair table — only aoe-1 and signal-1 arm a peer watchdog"
      echo "PEER_ARM_VERDICT=REFUSED"; exit 0
    fi
    if [ "$1" = "--arm" ]; then cmd_arm; else cmd_disarm; fi ;;
  --self-test) cmd_self_test ;;
  *) echo "usage: $0 --arm|--disarm|--self-test" >&2; exit 2 ;;
esac
