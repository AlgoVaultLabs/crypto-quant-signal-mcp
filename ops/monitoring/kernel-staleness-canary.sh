#!/usr/bin/env bash
# kernel-staleness-canary.sh — alert when the RUNNING kernel falls behind the INSTALLED one.
#
# OPS-HOST-KERNEL-REBOOT-W1 / R3 — the standing signal for SEC-18.
#
# WHY NOT `/var/run/reboot-required` MTIME (the obvious implementation, and the wrong one):
# that file is RE-STAMPED by every new kernel package. Measured at R0 on 2026-07-31, both hosts
# showed mtime 2026-07-29 — two days old — while signal-1 had been 12 revisions behind and aoe-1
# THIRTY revisions behind, the latter on 14 weeks of uptime. The audit's own "pending 10 days"
# figure came from that mtime and understated both. Its age is the age of the LATEST trigger, never
# "how long a reboot has been pending", so an alert keyed on it silently resets its own clock every
# month when unattended-upgrades lands the next kernel — i.e. exactly the recurrence this canary
# exists to prevent. Instead: compare RUNNING against the newest INSTALLED kernel. That difference
# cannot be reset by anything except an actual reboot.
#
# Alert contract: send_telegram.sh OWNS the severity gate, the 24h-per-alert_id cooldown, the
# recommended_wave {NEXT} resolver, and the INERT/DRY_RUN gates. Never re-implement them here.
# For a REPEATED smoke use ALGOVAULT_TG_TEST_INERT=1 (suppresses BEFORE the cooldown gate and
# writes NO marker). DRY_RUN_TG=1 DOES write the marker, so back-to-back dry runs false-green:
# the second is cooldown-suppressed, not silent-because-healthy.
#
# Exit: always 0 (fail-open — a canary outage must not bounce cron). The VERDICT line is the truth;
# read the token, never the code. `--self-test` is the exception and exits non-zero on failure.
set -uo pipefail

ALERT_ID="KERNEL_STALENESS"
SEND="${KERNEL_CANARY_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${KERNEL_CANARY_LOG:-/var/log/kernel-staleness-canary.log}"
# Report below this, escalate at/above it. unattended-upgrades lands kernels ~monthly, so 7 days is
# "you have had a maintenance window and did not take it", not "a kernel just landed".
THRESHOLD_DAYS="${KERNEL_STALENESS_ALERT_DAYS:-7}"
# TODO: revisit by 2027-02-28 — re-derive against the observed kernel cadence; a threshold nobody
# re-checks is how the last "reboot pending" signal decayed into background noise.

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*" | tee -a "$LOG" 2>/dev/null || true; }

# --- the decision, as a pure function of its inputs -----------------------------------------
# Extracted ONLY so the self-test can drive it with fixtures. Both hosts are freshly rebooted, so
# the real BREACH branch is unreachable from live state — and an unreachable branch that has never
# executed is precisely the dark guard this wave exists to retire.
# Echoes: <VERDICT> <detail>
decide() {
  local running="$1" installed="$2" age="$3" threshold="$4"
  if [ -z "$installed" ]; then
    echo "INDETERMINATE installed=<none-found> (dpkg query returned nothing — cannot decide)"; return
  fi
  if [ "$running" = "$installed" ]; then
    echo "OK delta=0 — running the newest installed kernel"; return
  fi
  if [ "$age" -ge 0 ] && [ "$age" -lt "$threshold" ]; then
    echo "REPORT age_days=$age (< ${threshold}d threshold — reporting, not paging)"; return
  fi
  echo "BREACH age_days=$age (>= ${threshold}d) — firing wrapper"
}

fire() {
  local hostlabel="$1" running="$2" installed="$3" age="$4"
  if [ ! -x "$SEND" ]; then
    log "FAIL_OPEN: wrapper not executable at $SEND — operator NOT notified"; return
  fi
  printf '%s\n' "$(cat <<EOF
Host <b>${hostlabel}</b> is running an out-of-date kernel.

running:   ${running}
installed: ${installed}
pending:   ${age} days

The newer kernel is installed but not running, so every security fix between the two is on disk and
inactive. A local privilege-escalation there also un-bounds the least-privilege work elsewhere in
the stack, which assumes the app cannot become root.

Action: schedule a reboot. The procedure is validated end-to-end by OPS-HOST-KERNEL-REBOOT-W1
(verify Hetzner console access first, rehearse on aoe-1, then signal-1); boot survival is asserted
continuously by scripts/check-boot-readiness.mjs. recommended_wave: OPS-HOST-KERNEL-REBOOT-W{NEXT}
EOF
)" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
}

# --- two-way self-test, vacuity-guarded ------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fails=(); checked=0
  expect() { # <expected-verdict> <running> <installed> <age> <threshold> <label>
    local got; got="$(decide "$2" "$3" "$4" "$5")"; checked=$((checked + 1))
    case "$got" in
      "$1"*) printf '  ✓ %s ⇒ %s\n' "$6" "$1" ;;
      *) printf '  ✗ %s ⇒ expected %s, got: %s\n' "$6" "$1" "$got"; fails+=("$6") ;;
    esac
  }
  echo "--- decision fixtures (must-fire and must-not-fire) ---"
  expect BREACH        6.8.0-124-generic 6.8.0-136-generic 30 7 "12 revisions behind, 30d old"
  expect BREACH        6.8.0-106-generic 6.8.0-136-generic  8 7 "at threshold+1"
  expect BREACH        6.8.0-106-generic 6.8.0-136-generic -1 7 "age unknown (-1) — fail toward paging"
  expect REPORT        6.8.0-124-generic 6.8.0-136-generic  2 7 "behind but fresh — must NOT page"
  expect OK            6.8.0-136-generic 6.8.0-136-generic  9 7 "up to date — must NOT page"
  expect INDETERMINATE 6.8.0-136-generic ""                 9 7 "dpkg returned nothing"

  # The branch that matters most: does BREACH actually INVOKE the wrapper, with the contract's
  # argument shape? Asserting the verdict string alone would leave the send path unexercised —
  # which is the exact failure mode (`INVENTORY_LOAD_FAILED … exit 0`) this repo has hit 4 times.
  echo "--- wrapper invocation ---"
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/kernel-canary.XXXXXX")"
  trap 'rm -rf "$probe_dir"' EXIT   # BSD mktemp: XXXXXX must be TERMINAL, so use -d + a fixed name inside
  cat > "$probe_dir/fake-send.sh" <<'PROBE'
#!/usr/bin/env bash
printf 'argv=%s|%s|%s\n' "$1" "$2" "$3" > "$CAPTURE"
cat >> "$CAPTURE"
PROBE
  chmod +x "$probe_dir/fake-send.sh"
  CAPTURE="$probe_dir/captured.txt" SEND="$probe_dir/fake-send.sh" \
    bash -c 'SEND="'"$probe_dir"'/fake-send.sh"; CAPTURE="'"$probe_dir"'/captured.txt"; export CAPTURE
             '"$(declare -f fire log)"'
             LOG=/dev/null; ALERT_ID=KERNEL_STALENESS
             fire testhost 6.8.0-124-generic 6.8.0-136-generic 30' >/dev/null 2>&1
  checked=$((checked + 1))
  if [ ! -s "$probe_dir/captured.txt" ]; then
    echo "  ✗ BREACH did not invoke the wrapper at all"; fails+=("wrapper-invoked")
  else
    grep -q 'argv=KERNEL_STALENESS|CRITICAL_PERSISTENT|-' "$probe_dir/captured.txt" \
      && echo "  ✓ invoked as: <alert_id> CRITICAL_PERSISTENT - (matches send_telegram.sh usage)" \
      || { echo "  ✗ wrong argv: $(head -1 "$probe_dir/captured.txt")"; fails+=("wrapper-argv"); }
    grep -q '6.8.0-136-generic' "$probe_dir/captured.txt" \
      && echo "  ✓ body carries the running/installed pair and the {NEXT} template" \
      || { echo "  ✗ body lost its payload"; fails+=("wrapper-body"); }
    grep -q 'W{NEXT}' "$probe_dir/captured.txt" \
      || { echo "  ✗ hardcoded wave id — CLAUDE.md requires the OPS-<CLASS>-W{NEXT} template"; fails+=("recommended-wave"); }
  fi

  # Vacuity guard: a self-test that asserts nothing must never report a pass.
  if [ "$checked" -lt 7 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 7)"; exit 3
  fi
  if [ "${#fails[@]}" -gt 0 ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${#fails[@]}/$checked: ${fails[*]}"; exit 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (3 must-fire, 2 must-not-fire, 1 indeterminate, wrapper path proven)"
  exit 0
fi

# --- live path -------------------------------------------------------------------------------
HOSTLABEL="$(hostname -s 2>/dev/null || echo unknown)"
RUNNING="$(uname -r)"
# Newest installed kernel by dpkg version order (NOT lexical — 6.8.0-106 must beat 6.8.0-99).
INSTALLED="$(dpkg-query -W -f='${Package}\n' 'linux-image-[0-9]*' 2>/dev/null \
  | sed 's/^linux-image-//' | sort -V | tail -1)"

PKG_FILE="/var/lib/dpkg/info/linux-image-${INSTALLED}.list"
if [ -n "$INSTALLED" ] && [ -f "$PKG_FILE" ]; then
  AGE_DAYS=$(( ( $(date -u +%s) - $(stat -c %Y "$PKG_FILE") ) / 86400 ))
else
  AGE_DAYS=-1   # unknown → decide() treats it as a breach, not a pass
fi

RESULT="$(decide "$RUNNING" "$INSTALLED" "$AGE_DAYS" "$THRESHOLD_DAYS")"
VERDICT="${RESULT%% *}"
# POSITIVE per-host output on EVERY path: a row silently skipped by a load error must not look
# identical to a row that passed.
log "VERDICT=$VERDICT host=$HOSTLABEL running=$RUNNING installed=${INSTALLED:-<none>} ${RESULT#* }"

[ "$VERDICT" = "BREACH" ] && fire "$HOSTLABEL" "$RUNNING" "$INSTALLED" "$AGE_DAYS"
exit 0
