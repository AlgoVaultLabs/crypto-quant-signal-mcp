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
# Report below this, escalate at/above it. MEASURED CADENCE, not folklore: /var/log/dpkg.log on
# BOTH hosts across 9 kernels (2026-04-06 -> 2026-08-20) gives n=15 install intervals, median 15d,
# range 12-29d. Two premises die on that data. The first is the one this comment used to carry,
# "unattended-upgrades lands kernels ~monthly". The second is the "~12 days" proposed as its
# replacement by the OPS-HOST-KERNEL-REBOOT-W3 dispatch, which read ONE gap (-137 -> -138) as a
# cadence — a single-interval estimate wearing a measurement's clothes.
# THRESHOLD_DAYS stays 7 ON THAT EVIDENCE: at a 12-29d cadence, 7 days pages 5-22 days after each
# install, which is the intended "you have had a window and did not take it" rather than "a kernel
# just landed". It is not tuned to the median; it is bounded below by the SHORTEST observed gap.
# INSTRUMENT WARNING for whoever re-derives this. The /var/lib/dpkg/info/linux-image-*.list mtime
# that AGE_DAYS below is computed from is RE-STAMPED by later dpkg activity: measured 2026-08-27,
# -136 reads 2026-08-20 on both hosts while dpkg.log records its real install as 2026-07-18. It is
# trustworthy ONLY for the NEWEST kernel — which is the only one this canary ever stats, so the
# live path is sound. Re-derive cadence from dpkg.log, never from the .list mtimes.
THRESHOLD_DAYS="${KERNEL_STALENESS_ALERT_DAYS:-7}"
# The former "TODO: revisit by 2027-02-28" is RETIRED, not moved. It asked a future reader to
# re-derive the cadence; that has now been done and the measured values are recorded above. A
# premise already falsified does not need a future reminder — it needs replacing, which is what
# OPS-HOST-KERNEL-REBOOT-W3 did.

# ── WHO REBOOTS THIS HOST ───────────────────────────────────────────────────────────────────
# OPS-HOST-KERNEL-REBOOT-W4. The Action paragraph below used to be a CONSTANT that named a manual
# procedure ("rehearse on aoe-1, then signal-1"). OPS-HOST-AUTO-REBOOT-W1 then shipped
# ops/monitoring/kernel-auto-reboot.sh, which performs that action unattended on aoe-1 — and never
# touched this body. For 15 days the alert instructed the operator to hand-reboot the one host that
# reboots itself, which RESETS its running-vs-installed delta and destroys an unattended cycle:
# the exact evidence the ratified promotion condition for signal-1 is counting.
#
# CONSUME, NEVER RE-DERIVE. Coverage is read from the LIVE SCHEDULE on this box. It is deliberately
# NOT re-derived from kernel-auto-reboot.sh's EXPECTED_HOST constant: that constant is a FIREWALL,
# and a second copy of a firewall is a firewall that can disagree with itself.
AUTO_REBOOT_BASENAME="kernel-auto-reboot.sh"
CRONTAB_BIN="${KERNEL_CANARY_CRONTAB:-crontab}"

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

# Echoes COVERED | UNCOVERED | UNKNOWN for THIS host. UNKNOWN is a real third state: a crontab we
# could not read is not evidence of absence, and reporting it as UNCOVERED would tell the operator
# to hand-reboot a host that may already be self-healing.
auto_reboot_coverage() {
  local out
  out="$("$CRONTAB_BIN" -l 2>/dev/null)" || { echo UNKNOWN; return; }
  case "$out" in
    *"$AUTO_REBOOT_BASENAME"*) echo COVERED ;;
    *) echo UNCOVERED ;;
  esac
}

# The Action paragraph, as a pure function of coverage. Extracted ONLY so the self-test can drive
# every branch with fixtures — the live path reaches at most one of them per fire, so the other two
# would otherwise be dark code in an alert body nobody proofreads.
#
# EVERY branch cites ops/monitoring/kernel-auto-reboot.sh on purpose: scripts/check-alert-copy-claims.mjs
# direction 2 requires the body of an alert to name the scheduled automation declared against it,
# and a branch that forgot would be a DRIFT rather than a silent regression.
decide_action() {
  case "$1" in
    COVERED)
      cat <<'ACT'
Action: this host IS inside the unattended reboot harness — ops/monitoring/kernel-auto-reboot.sh
is scheduled here hourly and should already have rebooted it. A page from a covered host therefore
means a GATE REFUSED, not that nobody has looked. Read /var/log/algovault-kernel-auto-reboot.log
for the AUTO_REBOOT_GATE line that stopped it and fix THAT cause; a hand-run reboot here would
paper over a harness defect and reset the delta that proves it.
ACT
      ;;
    UNCOVERED)
      cat <<'ACT'
Action: this host is deliberately OUTSIDE the unattended reboot harness, so a hand-run reboot is
the correct response. ops/monitoring/kernel-auto-reboot.sh hardcodes its target host and cannot
act here. Procedure: OPS-HOST-KERNEL-REBOOT-W1 — verify Hetzner console access FIRST.
Do NOT reboot the harness-covered host to "rehearse". That resets its running-vs-installed delta,
which only a real reboot can reset, and destroys one unattended cycle — and two clean unattended
cycles are the ratified condition for extending the harness to THIS host.
ACT
      ;;
    *)
      cat <<'ACT'
Action: this host's crontab could not be read, so whether ops/monitoring/kernel-auto-reboot.sh
covers it is UNKNOWN — not "no". Establish coverage by hand before doing anything: rebooting a
covered host destroys an unattended cycle, and waiting on an uncovered one leaves the kernel stale
indefinitely. Procedure once established: OPS-HOST-KERNEL-REBOOT-W1 — verify Hetzner console
access FIRST.
ACT
      ;;
  esac
}

fire() {
  local hostlabel="$1" running="$2" installed="$3" age="$4"
  if [ ! -x "$SEND" ]; then
    log "FAIL_OPEN: wrapper not executable at $SEND — operator NOT notified"; return
  fi
  local coverage action
  coverage="$(auto_reboot_coverage)"
  action="$(decide_action "$coverage")"
  log "auto_reboot_coverage=$coverage host=$hostlabel"
  printf '%s\n' "$(cat <<EOF
Host <b>${hostlabel}</b> is running an out-of-date kernel.

running:   ${running}
installed: ${installed}
pending:   ${age} days

The newer kernel is installed but not running, so every security fix between the two is on disk and
inactive. A local privilege-escalation there also un-bounds the least-privilege work elsewhere in
the stack, which assumes the app cannot become root.

${action}

Boot survival is asserted continuously by ops/monitoring/boot-contract-canary.sh, scheduled per
host (signal-1 08:09 UTC, aoe-1 08:37 UTC), which checks this box against the declared contract.
scripts/check-boot-readiness.mjs is the BUILD-TIME gate: it proves the contract is internally
coherent and never that a host matches it.

recommended_wave: OPS-HOST-KERNEL-REBOOT-W{NEXT}
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
  echo "--- Action paragraph: every coverage branch, incl. the two the live path never reaches ---"
  act() { # <expect-substring> <coverage> <label>
    local got; got="$(decide_action "$2")"; checked=$((checked + 1))
    case "$got" in
      *"$1"*) printf '  ✓ %s\n' "$3" ;;
      *) printf '  ✗ %s ⇒ missing %s\n' "$3" "$1"; fails+=("$3") ;;
    esac
  }
  act "IS inside the unattended reboot harness" COVERED   "COVERED sends the operator to the refusing gate"
  act "a GATE REFUSED"                          COVERED   "  and says a page means refusal, not neglect"
  act "deliberately OUTSIDE"                    UNCOVERED "UNCOVERED authorises the hand-run"
  act 'Do NOT reboot the harness-covered host'  UNCOVERED "  and forbids the rehearsal that voids a cycle"
  act "is UNKNOWN"                              UNKNOWN   "UNKNOWN refuses to guess"
  act "verify Hetzner console"                  UNKNOWN   "  and still names the console preflight"

  # DIRECTION-2 CONTRACT: scripts/check-alert-copy-claims.mjs requires this body to cite the
  # scheduled automation declared against KERNEL_STALENESS. A branch that forgets is a DRIFT, so
  # assert it on EVERY branch rather than on the one the live host happens to take.
  for cov in COVERED UNCOVERED UNKNOWN; do
    checked=$((checked + 1))
    case "$(decide_action "$cov")" in
      *ops/monitoring/kernel-auto-reboot.sh*) printf '  ✓ %s branch cites the declared automation\n' "$cov" ;;
      *) printf '  ✗ %s branch drops the citation (direction-2 DRIFT)\n' "$cov"; fails+=("cite-$cov") ;;
    esac
  done

  echo "--- coverage probe reads the LIVE schedule, not a hardcoded host ---"
  cov_dir="$(mktemp -d "${TMPDIR:-/tmp}/kernel-cov.XXXXXX")"
  printf '#!/usr/bin/env bash\necho "7 * * * * /opt/algovault-monitoring/kernel-auto-reboot.sh --apply"\n' > "$cov_dir/crontab-yes"
  printf '#!/usr/bin/env bash\necho "23 7 * * * /opt/algovault-monitoring/kernel-staleness-canary.sh"\n' > "$cov_dir/crontab-no"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$cov_dir/crontab-dead"
  chmod +x "$cov_dir"/crontab-*
  for pair in "yes COVERED" "no UNCOVERED" "dead UNKNOWN"; do
    set -- $pair
    checked=$((checked + 1))
    got="$(CRONTAB_BIN="$cov_dir/crontab-$1" auto_reboot_coverage)"
    if [ "$got" = "$2" ]; then printf '  ✓ crontab-%s ⇒ %s\n' "$1" "$2"
    else printf '  ✗ crontab-%s ⇒ expected %s, got %s\n' "$1" "$2" "$got"; fails+=("cov-$1"); fi
  done
  rm -rf "$cov_dir"

  echo "--- wrapper invocation ---"
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/kernel-canary.XXXXXX")"
  trap 'rm -rf "$probe_dir"' EXIT   # BSD mktemp: XXXXXX must be TERMINAL, so use -d + a fixed name inside
  cat > "$probe_dir/fake-send.sh" <<'PROBE'
#!/usr/bin/env bash
printf 'argv=%s|%s|%s\n' "$1" "$2" "$3" > "$CAPTURE"
cat >> "$CAPTURE"
PROBE
  chmod +x "$probe_dir/fake-send.sh"
  printf '#!/usr/bin/env bash\nexit 1\n' > "$probe_dir/crontab-dead"; chmod +x "$probe_dir/crontab-dead"
  CAPTURE="$probe_dir/captured.txt" SEND="$probe_dir/fake-send.sh" \
    bash -c 'SEND="'"$probe_dir"'/fake-send.sh"; CAPTURE="'"$probe_dir"'/captured.txt"; export CAPTURE
             '"$(declare -f fire log decide_action auto_reboot_coverage)"'
             LOG=/dev/null; ALERT_ID=KERNEL_STALENESS
             AUTO_REBOOT_BASENAME=kernel-auto-reboot.sh; CRONTAB_BIN="'"$probe_dir"'/crontab-dead"
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
    checked=$((checked + 1))
    grep -q "could not be read" "$probe_dir/captured.txt" \
      && echo "  ✓ the ASSEMBLED body carries the coverage-derived Action (seam not bypassed)" \
      || { echo "  ✗ fire() dropped the Action paragraph"; fails+=("action-in-body"); }
  fi

  # Vacuity guard: a self-test that asserts nothing must never report a pass.
  if [ "$checked" -lt 20 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 20)"; exit 3
  fi
  if [ "${#fails[@]}" -gt 0 ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${#fails[@]}/$checked: ${fails[*]}"; exit 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (3 must-fire, 2 must-not-fire, 1 indeterminate, 6 action-branch, 3 direction-2 citation, 3 coverage-probe, wrapper path + assembled body proven)"
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
