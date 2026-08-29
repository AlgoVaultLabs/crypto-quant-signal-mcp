#!/usr/bin/env bash
# kernel-auto-reboot.sh — OPS-HOST-AUTO-REBOOT-W1.
#
# aoe-1 reboots ITSELF for a kernel update, gated, watched, and structurally incapable of
# rebooting signal-1.
#
# ── WHY THIS EXISTS, AND WHAT IS ACTUALLY UNPROVEN ──────────────────────────────────────────
# Kernel packages land every 12-29 days (median 15, n=15, dpkg.log Apr-Aug 2026) and
# KERNEL_STALENESS pages at 7, so each cycle costs a hand-run wave — ~24 reboots/year across two
# hosts. THE REBOOT ITSELF IS PROVEN: three hand-run cycles (W1/W2/W3), every one uneventful,
# containers back on `unless-stopped` alone with the supervisor needed zero times, Postgres
# checkpointing in 51ms against a 120s budget, and aoe-1's aoe-pg-tunnel absorbing a peer-host
# outage unaided. What is UNPROVEN is the HARNESS: the decision logic, the abort path, the
# escalation. That is the whole reason this ships aoe-1-only.
#
# ── THE signal-1 FIREWALL ───────────────────────────────────────────────────────────────────
# aoe-1's clear run is :05-:12, an EIGHT-minute target. signal-1 has :09 and :39 — two minutes out
# of sixty, because entitlement-drain.sh occupies all ten canonical minutes hourly
# (OPS-BOT-CRON-SCHEDULE-GREED-W1). A harness bug against eight minutes degrades; against two it
# lands mid-cron on the revenue host. So EXPECTED_HOST is a hardcoded constant, deliberately NOT a
# seam: a configurable firewall is not a firewall. Identity is evaluated FIRST, before any probe,
# and resolves env -> /etc/algovault-host-label -> REFUSE, with NO DEFAULT. declaration-sync.sh
# once ran unlabelled on aoe-1, adopted signal-1's identity and littered five foreign declarations
# there, twice; monitoring-inventory-reconcile.py DEFAULTS its labels to signal-1, so a bare run on
# aoe-1 asserts signal-1's identity. Neither trap is available here.
#
# Ratified promotion condition for signal-1, recorded so it is not re-litigated: TWO clean
# unattended aoe-1 cycles (~30 days at median cadence) AND a live peer watchdog. Not this wave.
#
# ── CONSUME, NEVER RE-DERIVE ────────────────────────────────────────────────────────────────
# "Is a reboot due" already exists in kernel-staleness-canary.sh's decide(), keyed on
# running-vs-newest-installed — a fact nothing but an actual reboot can reset. "Does this host
# still match its boot contract" already exists in boot-contract-canary.sh. "What would a
# disruption cost" already exists in ops/scripts/cron-interlock-registry.json. This harness READS
# all three verdicts and derives none of them. A second derivation of one fact is what the
# single-derivation rule forbids, and two copies drift silently.
#
# ── FOUR GATES, ALL MUST PASS ───────────────────────────────────────────────────────────────
#   1. IDENTITY      != aoe-1                      -> REFUSED, immediately, before any other work
#   2. DUE           staleness verdict != BREACH   -> NOT_DUE, SILENT (nothing is wrong)
#   3. CONTRACT      BOOT_CONTRACT_VERDICT != OK   -> ABORTED + page. A reboot is not a repair tool
#   4. IN-FLIGHT     a no-safe-kill aoe-1 row runs -> ABORTED, retry next window
#
# Gate 4 CANNOT abort today: aoe-1's measured population is 4 rows, all safe-to-kill, and
# _residual_no_safe_kill["aoe-1"].count is 0. That is a REPORTED pass, never a silent one — the
# gate prints the row count it evaluated, so "nothing is unsafe" stays distinguishable from "the
# filter is broken". Its value is forward-looking: the day a no-safe-kill job lands on aoe-1, the
# reboot starts deferring without anyone remembering to wire it.
#
# ── ESCALATION REPLACES THE CONSOLE PREFLIGHT ───────────────────────────────────────────────
# The three hand-run waves each verified Hetzner console access first. That cannot be automated
# safely: an hcloud token on the host that can console into both boxes is a privilege escalation
# OF the host. The substitute is a PEER WATCHDOG on signal-1 (aoe-peer-watchdog.sh) — this script
# arms it immediately before rebooting and disarms it after a verified return.
#
# ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
# Exactly ONE terminal AUTO_REBOOT_VERDICT=REBOOTED|NOT_DUE|ABORTED|REFUSED|INDETERMINATE, with
# POSITIVE per-gate output on every path. Exit is ALWAYS 0 on the live path — a harness outage
# must not bounce cron, and callers read the TOKEN. `--self-test` is the exception: 0 pass / 1 fail
# / 3 indeterminate, with its own SELF_TEST_VERDICT line.
#
# --dry-run IS THE DEFAULT. An actual reboot requires an explicit --apply, and the cron entry
# carries it. A harness whose default action is destructive is one typo from an outage.
set -uo pipefail

ALERT_ID="KERNEL_AUTO_REBOOT"
# HARDCODED ON PURPOSE — see THE signal-1 FIREWALL above. Not a seam, not an env var.
EXPECTED_HOST="aoe-1"

LOG="${AUTO_REBOOT_LOG:-/var/log/algovault-kernel-auto-reboot.log}"
IDENTITY_FILE="${AUTO_REBOOT_IDENTITY_FILE:-/etc/algovault-host-label}"
STALENESS="${AUTO_REBOOT_STALENESS:-/opt/algovault-monitoring/kernel-staleness-canary.sh}"
BOOT_CONTRACT="${AUTO_REBOOT_BOOT_CONTRACT:-/opt/algovault-monitoring/boot-contract-canary.sh}"
# NOT the repo checkout path. FOUND BY THE FIRST LIVE RUN, 2026-08-29: /opt/crypto-quant-signal-mcp
# does not exist on aoe-1 — that checkout is signal-1's, and it is why the deploy interlock over
# there can read the registry with no sync at all. aoe-1 gets a SYNCED COPY installed by
# ops/scripts/install-monitoring-artifact.sh, with its own inventory row so the daily reconciler's
# HASH_DRIFT check polices divergence from the committed original.
#
# The defect was INVISIBLE at the time: both hosts were current, so every run short-circuited at
# gate 2 with NOT_DUE and never reached the registry. It would have surfaced on the FIRST run where
# a reboot was actually due — INDETERMINATE and a page instead of the reboot. "A gate's own first
# live run is the test", and this is what that run was for.
REGISTRY="${AUTO_REBOOT_REGISTRY:-/opt/algovault-monitoring/cron-interlock-registry.json}"
# send_telegram.sh OWNS severity, the 24h per-alert_id cooldown, the {NEXT} resolver, the INERT
# gates and fail-open. Consumers MUST NOT re-implement any of them inline.
SEND="${AUTO_REBOOT_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
PY_BIN="${AUTO_REBOOT_PY:-python3}"
DOCKER_BIN="${AUTO_REBOOT_DOCKER:-docker}"
# `pgrep -f` is the in-flight probe, and it is SEAMED for the same reason `flock` and `setsid` are
# seamed in ops/scripts/deploy-cron-interlock.sh: its behaviour diverges between the Linux host and
# the macOS laptop where --self-test and the pre-push gate run. Measured 2026-08-29: a pattern
# present in a live argv on this Mac matches `ps -eo args | grep` and does NOT match Darwin's
# `pgrep -f`. Without the seam the ABORT branch could not be driven deterministically off-host, and
# an undrivable branch is how "lock held" stayed indistinguishable from "ran" in a sibling script.
# The real default is asserted in --self-test.
PGREP_BIN="${AUTO_REBOOT_PGREP:-pgrep}"
# The destructive primitive, seamed so --self-test can prove the apply path REACHES it without
# rebooting a laptop. The real default is asserted in --self-test, because a hermetic test is
# structurally blind to exactly what its own seam replaces.
REBOOT_CMD="${AUTO_REBOOT_REBOOT_CMD:-/sbin/reboot}"
# Arms the signal-1 peer watchdog. Seamed for the same reason.
ARM_CMD="${AUTO_REBOOT_ARM_CMD:-/opt/algovault-monitoring/arm-peer-watchdog.sh}"
# Survives the reboot: what we were running before, so the next run can assert the kernel MOVED.
STATE="${AUTO_REBOOT_STATE:-/var/lib/algovault-monitoring/.auto-reboot-pending}"
REBOOT_REQUIRED="${AUTO_REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"
# ONE definition of the no-argument default, consumed by BOTH the dispatcher and
# --print-default-mode. They were two literals until a deliberate break flipped the dispatcher to
# --apply and the whole 55-check suite stayed GREEN: --print-default-mode was printing its own
# hardcoded string and could not disagree with anything. A declaration that cannot contradict the
# behaviour it describes is not an assertion.
DEFAULT_ARG="--dry-run"

# STDOUT AND THE LOG ARE WRITTEN SEPARATELY, never through `… | tee -a "$LOG" || printf …`.
# That idiom DOUBLE-PRINTS whenever the log is unwritable: tee still writes stdout, exits non-zero,
# and the `||` fallback prints the same line again. Measured on the first run of this script, where
# it emitted every gate line twice on a laptop with no /var/log write. For prose that is untidy;
# for a MACHINE-READABLE `AUTO_REBOOT_GATE=` line it is a caller counting two of everything.
_emit() { # _emit <line>
  printf '%s\n' "$1"
  # The redirect must be inside a SUBSHELL: bash reports a failed redirection itself, and a
  # trailing `2>/dev/null` on the command cannot suppress it. Without this a laptop run leaks a
  # "Permission denied" line per emit into stderr and buries the verdict.
  ( printf '%s\n' "$1" >> "$LOG" ) 2>/dev/null || true
}
log() { _emit "$(printf '%s [%s] %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*")"; }

# POSITIVE PER-GATE OUTPUT. Printed for every gate on every path, including the ones that were
# never reached — a gate that produced no line is indistinguishable from a gate that passed.
gate() { # gate <name> <state> <detail>
  _emit "$(printf 'AUTO_REBOOT_GATE=%s state=%s %s' "$1" "$2" "${3:-}")"
}
verdict() { echo "AUTO_REBOOT_VERDICT=$1"; }

# ── identity, evaluated FIRST ────────────────────────────────────────────────────────────────
# env -> the host's own opaque marker -> REFUSE. A peer host's label may NEVER be a fallback, in
# any form, and there is no default: a whole host evaluated against the wrong identity is worse
# than no answer.
resolve_host() {
  local h="${MONITORING_HOST_LABELS:-}"
  [ -n "$h" ] || { [ -r "$IDENTITY_FILE" ] && h="$(head -1 "$IDENTITY_FILE" 2>/dev/null | tr -d '[:space:]')"; }
  printf '%s' "${h%%,*}"
}

# ── the page ─────────────────────────────────────────────────────────────────────────────────
# recommended_wave is TEMPLATED (OPS-<CLASS>-W{NEXT}); send_telegram.sh resolves it at send time
# from status.md. A literal wave id here is forbidden — it goes stale the moment that wave ships.
page() { # page <verdict> <one-line condition> <context>
  printf '%s\n' \
    "🛑 $ALERT_ID — aoe-1 unattended kernel reboot did not proceed" \
    "Condition: $2" \
    "Context: $3" \
    "Host: $EXPECTED_HOST · verdict: $1 · the reboot was NOT performed" \
    "Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT} via Cowork → Claude Code" \
    "Audit shape: ops/monitoring/kernel-auto-reboot.sh --self-test" \
    "Source log: $LOG" \
  | ( "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" ) 2>/dev/null \
  || log "FAIL_OPEN: send_telegram invocation failed (rc=$?) — the wrapper owns fail-open; this is the record that it did"
}

# ── gate 2 — is a reboot due? CONSUMED, never re-derived. ────────────────────────────────────
# kernel-staleness-canary.sh prints `VERDICT=<X> host=…`; its decide() is keyed on
# running-vs-newest-installed, which nothing but an actual reboot can reset. We read the token.
staleness_verdict() {
  [ -x "$STALENESS" ] || { printf 'INDETERMINATE'; return 0; }
  local out v
  out="$("$STALENESS" 2>/dev/null)" || true
  v="$(printf '%s\n' "$out" | grep -oE 'VERDICT=(OK|REPORT|BREACH|INDETERMINATE)' | tail -1 | cut -d= -f2)"
  printf '%s' "${v:-INDETERMINATE}"
}

# ── gate 3 — does the host still match its boot contract? ───────────────────────────────────
# A reboot is NOT a repair tool. If the host does not match the contract now, rebooting it is a
# bet that the contract will hold on the other side, and nobody is awake to take that bet.
boot_contract_verdict() {
  [ -x "$BOOT_CONTRACT" ] || { printf 'INDETERMINATE'; return 0; }
  local out v
  out="$("$BOOT_CONTRACT" 2>/dev/null)" || true
  v="$(printf '%s\n' "$out" | grep -oE 'BOOT_CONTRACT_VERDICT=(OK|DRIFT|INDETERMINATE)' | tail -1 | cut -d= -f2)"
  printf '%s' "${v:-INDETERMINATE}"
}

# ── gate 4 — is a no-safe-kill job in flight ON THIS HOST? ──────────────────────────────────
# Emits "<count> <id> <id> …" for THIS host's no-safe-kill rows, or exits non-zero if the registry
# cannot be read. The count is printed even when zero, so a reported pass never reads like a
# skipped check.
nsk_rows() {
  [ -f "$REGISTRY" ] || return 1
  "$PY_BIN" - "$REGISTRY" "$EXPECTED_HOST" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
rows = doc.get("rows")
if not isinstance(rows, list) or not rows:
    sys.exit(1)
host = sys.argv[2]
mine = [r for r in rows if isinstance(r, dict) and r.get("host") == host]
if not mine:
    sys.exit(1)
# An unclassifiable row is INDETERMINATE, never a silent safe-to-kill — so it refuses the load
# rather than being counted as "not no-safe-kill".
VALID = ("safe-to-kill", "preempt-and-catchup", "no-safe-kill")
for r in mine:
    if str(r.get("class") or "").strip() not in VALID or not str(r.get("reason") or "").strip():
        sys.exit(1)
nsk = [r for r in mine if r.get("class") == "no-safe-kill"]
print(len(mine), len(nsk), " ".join(str(r.get("process_pattern") or r.get("id")) for r in nsk))
PY
}

# ── the run ──────────────────────────────────────────────────────────────────────────────────
cmd_run() { # cmd_run <apply|dry-run>
  local mode="$1"

  # ── GATE 1 — IDENTITY. First, before any probe, and REFUSE on anything but aoe-1. ──────────
  local host; host="$(resolve_host)"
  if [ -z "$host" ]; then
    gate identity REFUSED "resolved=<none> expected=$EXPECTED_HOST — env MONITORING_HOST_LABELS and $IDENTITY_FILE both empty; there is deliberately NO default"
    log "REFUSED: unresolvable host identity"
    page REFUSED "host identity is unresolvable" "MONITORING_HOST_LABELS empty and $IDENTITY_FILE unreadable; no default is permitted"
    verdict REFUSED; return 0
  fi
  if [ "$host" != "$EXPECTED_HOST" ]; then
    gate identity REFUSED "resolved=$host expected=$EXPECTED_HOST — this harness reboots $EXPECTED_HOST ONLY"
    log "REFUSED: identity=$host is not $EXPECTED_HOST — no further gate was evaluated, nothing was touched"
    page REFUSED "this harness was invoked on '$host', not $EXPECTED_HOST" "signal-1 is explicitly out of scope; promotion needs 2 clean unattended aoe-1 cycles AND a live peer watchdog"
    verdict REFUSED; return 0
  fi
  gate identity PASS "resolved=$host via ${MONITORING_HOST_LABELS:+MONITORING_HOST_LABELS}${MONITORING_HOST_LABELS:-$IDENTITY_FILE}"

  # ── POST-BOOT ASSERTIONS — before deciding anything new. ──────────────────────────────────
  # A pending marker means the LAST run rebooted. Assert it actually worked before we are allowed
  # to consider doing it again; "installed is not working" applies to our own action too.
  if [ -f "$STATE" ]; then
    local prev; prev="$(head -1 "$STATE" 2>/dev/null | tr -d '[:space:]')"
    local now_k; now_k="$(uname -r)"
    local bc; bc="$(boot_contract_verdict)"
    local still_req="no"; [ -f "$REBOOT_REQUIRED" ] && still_req="yes"
    rm -f "$STATE" 2>/dev/null
    "$ARM_CMD" --disarm >/dev/null 2>&1 || log "post-boot: disarm returned rc=$? (the watchdog's stale-arm ceiling is the backstop)"
    if [ "$prev" = "$now_k" ] || [ "$still_req" = "yes" ] || [ "$bc" != "OK" ]; then
      gate post_boot FAIL "kernel_before=$prev kernel_now=$now_k reboot_required=$still_req boot_contract=$bc"
      log "ABORTED: post-boot assertion failed after our own reboot"
      page ABORTED "the previous unattended reboot did not verify" "kernel_before=$prev kernel_now=$now_k reboot_required=$still_req boot_contract=$bc"
      verdict ABORTED; return 0
    fi
    gate post_boot PASS "kernel advanced $prev -> $now_k · reboot_required cleared · boot_contract=OK"
  else
    gate post_boot SKIP "no pending marker — the last run did not reboot"
  fi

  # ── GATE 2 — DUE? Consumed from the staleness canary, never re-derived. ───────────────────
  local sv; sv="$(staleness_verdict)"
  case "$sv" in
    BREACH) gate due PASS "kernel-staleness-canary verdict=BREACH — a newer kernel has been installed past the threshold" ;;
    OK|REPORT)
      gate due NOT_DUE "kernel-staleness-canary verdict=$sv — nothing to do, and nothing is wrong"
      log "NOT_DUE: staleness verdict=$sv"
      verdict NOT_DUE; return 0 ;;
    *)
      gate due INDETERMINATE "kernel-staleness-canary verdict=${sv:-<unreadable>} at $STALENESS"
      log "INDETERMINATE: could not read the staleness verdict"
      page INDETERMINATE "the staleness canary's verdict could not be read" "path=$STALENESS verdict=${sv:-<unreadable>}; the harness will not reboot on an unknown answer"
      verdict INDETERMINATE; return 0 ;;
  esac

  # ── GATE 3 — BOOT CONTRACT. A reboot is not a repair tool. ───────────────────────────────
  local bc; bc="$(boot_contract_verdict)"
  if [ "$bc" != "OK" ]; then
    gate contract ABORT "boot-contract-canary verdict=$bc — a reboot is not a repair tool"
    log "ABORTED: boot contract verdict=$bc"
    page ABORTED "the host does not match its boot contract" "BOOT_CONTRACT_VERDICT=$bc — rebooting now bets that the contract holds on the other side, and nobody is awake to take that bet"
    verdict ABORTED; return 0
  fi
  gate contract PASS "boot-contract-canary verdict=OK"

  # ── GATE 4 — NO no-safe-kill JOB IN FLIGHT, on THIS host's rows. ─────────────────────────
  local rows total nsk pats
  if ! rows="$(nsk_rows 2>/dev/null)" || [ -z "$rows" ]; then
    gate in_flight INDETERMINATE "registry unreadable, host-less, or carrying an unclassifiable row: $REGISTRY"
    log "INDETERMINATE: cron-interlock registry could not be read for host=$EXPECTED_HOST"
    page INDETERMINATE "the cron-interlock registry could not be read for $EXPECTED_HOST" "path=$REGISTRY — the harness will not reboot without knowing what a reboot would cost"
    verdict INDETERMINATE; return 0
  fi
  total="$(printf '%s' "$rows" | awk '{print $1}')"
  nsk="$(printf '%s' "$rows" | awk '{print $2}')"
  pats="$(printf '%s' "$rows" | cut -d' ' -f3-)"
  local running=""
  if [ "$nsk" -gt 0 ]; then
    for p in $pats; do
      "$PGREP_BIN" -f "$p" >/dev/null 2>&1 && running="$running $p"
    done
  fi
  if [ -n "$running" ]; then
    gate in_flight ABORT "rows=$total no_safe_kill=$nsk in_flight=$running"
    log "ABORTED: no-safe-kill job in flight:$running"
    verdict ABORTED; return 0
  fi
  # POSITIVE even at zero: "nothing is unsafe" must stay distinguishable from "the filter broke".
  gate in_flight PASS "rows=$total no_safe_kill=$nsk in_flight=none — evaluated $total $EXPECTED_HOST row(s)"

  # ── ALL GATES PASSED ─────────────────────────────────────────────────────────────────────
  if [ "$mode" != "apply" ]; then
    gate action DRY_RUN "every gate passed; --apply was NOT given, so nothing was rebooted"
    log "DRY_RUN: all gates passed; would have rebooted"
    verdict NOT_DUE; return 0
  fi

  uname -r > "$STATE" 2>/dev/null || { mkdir -p "$(dirname "$STATE")" 2>/dev/null; uname -r > "$STATE" 2>/dev/null; }
  # ARM BEFORE REBOOTING, never after — after is never.
  if ! "$ARM_CMD" --arm >/dev/null 2>&1; then
    log "WARN: could not arm the peer watchdog (rc=$?); proceeding — an unwatched reboot is worse than a delayed one only if the reboot is the risky half, and three measured cycles say it is not"
    gate arm DEGRADED "arm command failed at $ARM_CMD — rebooting unwatched, and saying so"
  else
    gate arm PASS "peer watchdog armed on signal-1 via $ARM_CMD"
  fi
  gate action REBOOT "all gates passed and --apply was given"
  log "REBOOTED: issuing $REBOOT_CMD (kernel_before=$(uname -r))"
  verdict REBOOTED
  "$REBOOT_CMD" >/dev/null 2>&1 || log "WARN: reboot command returned rc=$?"
  return 0
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────
cmd_self_test() {
  local fails=0 n=0
  ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got '$2', want '$3'"; fails=$((fails+1)); fi; }
  local tmp; tmp=$(mktemp -d)
  # Assign the RESOLVED GLOBALS, never the AUTO_REBOOT_* env: the constants resolve at script LOAD,
  # so an env prefix inside a command substitution arrives too late and the suite would silently
  # drive the real /var/log and the real /sbin/reboot. This exact trap was caught by the sibling
  # interlock's self-test on this wave, one file over.
  local REAL_PGREP="$PGREP_BIN"
  local REAL_REBOOT="$REBOOT_CMD" REAL_ARM="$ARM_CMD" REAL_ID="$IDENTITY_FILE" REAL_STALE="$STALENESS" REAL_BC="$BOOT_CONTRACT" REAL_REG="$REGISTRY" REAL_SEND="$SEND"
  LOG="$tmp/log"; STATE="$tmp/state"; REBOOT_REQUIRED="$tmp/reboot-required"

  mk() { printf '#!/bin/sh\n%s\n' "$2" > "$1"; chmod +x "$1"; }
  mk "$tmp/stale-ok.sh"     'echo "VERDICT=OK host=x"'
  mk "$tmp/stale-breach.sh" 'echo "VERDICT=BREACH host=x"'
  mk "$tmp/stale-junk.sh"   'echo "nothing useful"'
  mk "$tmp/bc-ok.sh"        'echo "BOOT_CONTRACT_VERDICT=OK"'
  mk "$tmp/bc-drift.sh"     'echo "BOOT_CONTRACT_VERDICT=DRIFT"'
  mk "$tmp/reboot-log.sh"   "echo rebooted >> $tmp/rebooted"
  mk "$tmp/reboot-noarg.sh" "echo rebooted >> $tmp/rebooted-noarg"
  mk "$tmp/arm-log.sh"      "echo \"\$@\" >> $tmp/armed"
  mk "$tmp/send-log.sh"     "cat >> $tmp/paged; echo \"ALERT=\$1 SEV=\$2\" >> $tmp/paged"
  # The two in-flight branches, driven deterministically: rc0 = the pattern IS running, rc1 = it is
  # not. `pgrep -f <pat>` -> the stub sees the same argv the real binary would.
  mk "$tmp/pgrep-hit.sh"    "echo \"\$@\" >> $tmp/pgrepped; exit 0"
  mk "$tmp/pgrep-miss.sh"   "echo \"\$@\" >> $tmp/pgrepped; exit 1"
  printf 'aoe-1\n' > "$tmp/id-aoe"
  printf 'signal-1\n' > "$tmp/id-signal"

  reg() { printf '{"schema_version":1,"rows":[%s]}\n' "$2" > "$1"; }
  local ROW_SAFE='{"id":"aoe-containers","host":"aoe-1","script":"x","class":"safe-to-kill","reason":"unless-stopped","process_pattern":"n/a"}'
  local ROW_NSK='{"id":"aoe-danger","host":"aoe-1","script":"x","class":"no-safe-kill","reason":"stated","process_pattern":"aoe-danger-pattern"}'
  local ROW_FOREIGN='{"id":"sig","host":"signal-1","script":"x","class":"no-safe-kill","reason":"stated","process_pattern":"p"}'
  local ROW_NOREASON='{"id":"bad","host":"aoe-1","script":"x","class":"safe-to-kill","reason":"  ","process_pattern":"p"}'
  reg "$tmp/reg-ok.json"      "$ROW_SAFE"
  reg "$tmp/reg-nsk.json"     "$ROW_SAFE,$ROW_NSK"
  reg "$tmp/reg-foreign.json" "$ROW_FOREIGN"
  reg "$tmp/reg-noreason.json" "$ROW_NOREASON"
  printf 'not json\n' > "$tmp/reg-broken.json"

  # The all-gates-green baseline, so every case below differs from it in exactly one variable.
  green() { IDENTITY_FILE="$tmp/id-aoe" STALENESS="$tmp/stale-breach.sh" BOOT_CONTRACT="$tmp/bc-ok.sh" \
            REGISTRY="$tmp/reg-ok.json" SEND="$tmp/send-log.sh" REBOOT_CMD="$tmp/reboot-log.sh" ARM_CMD="$tmp/arm-log.sh" \
            MONITORING_HOST_LABELS= cmd_run "$1" 2>/dev/null | tail -1; }

  echo "kernel-auto-reboot --self-test"

  # ── THE FIREWALL. The single most important assertion in this wave. ───────────────────────
  ck "a signal-1 label REFUSES" \
     "$(MONITORING_HOST_LABELS=signal-1 IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=REFUSED"
  ck "…with ZERO side effects: it never reboots" "$([ -f "$tmp/rebooted" ] && echo yes || echo no)" "no"
  ck "…and never arms the watchdog" "$([ -f "$tmp/armed" ] && echo yes || echo no)" "no"
  ck "…and it never even reaches the DUE gate" \
     "$(MONITORING_HOST_LABELS=signal-1 IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh cmd_run apply 2>/dev/null | grep -c 'AUTO_REBOOT_GATE=due')" "0"
  ck "…and the refusal PAGES rather than failing silently" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "2"
  # The FILE leg of the identity chain, driven with the env empty.
  ck "an identity FILE saying signal-1 REFUSES too (the env is not the only door)" \
     "$(MONITORING_HOST_LABELS= IDENTITY_FILE=$tmp/id-signal STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=REFUSED"
  ck "an UNRESOLVABLE identity REFUSES — never a default to aoe-1" \
     "$(MONITORING_HOST_LABELS= IDENTITY_FILE=/nonexistent STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=REFUSED"
  ck "…and still nothing was rebooted across all four refusals" "$([ -f "$tmp/rebooted" ] && echo yes || echo no)" "no"

  # ── --dry-run IS THE DEFAULT, and --apply is the only way through. ───────────────────────
  ck "all gates green + dry-run does NOT reboot" "$(green dry-run)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…and it says so positively rather than going quiet" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | grep -c 'AUTO_REBOOT_GATE=action state=DRY_RUN')" "1"
  ck "…and the reboot command was never invoked" "$([ -f "$tmp/rebooted" ] && echo yes || echo no)" "no"
  ck "the CLI DEFAULT with no flag is dry-run" \
     "$(bash "$0" --print-default-mode)" "dry-run"
  # BEHAVIOURAL, not declarative: a child process invoked with NO ARGUMENT at all, every gate
  # green, must not reach the reboot command. This is the check that catches a dispatcher flipped
  # to --apply; the printed-default check above could not, and did not.
  rm -f "$tmp/rebooted-noarg"
  AUTO_REBOOT_LOG="$tmp/log" AUTO_REBOOT_STATE="$tmp/state-noarg" AUTO_REBOOT_REQUIRED_FILE="$tmp/rr-noarg" \
    AUTO_REBOOT_IDENTITY_FILE="$tmp/id-aoe" AUTO_REBOOT_STALENESS="$tmp/stale-breach.sh" \
    AUTO_REBOOT_BOOT_CONTRACT="$tmp/bc-ok.sh" AUTO_REBOOT_REGISTRY="$tmp/reg-ok.json" \
    AUTO_REBOOT_WRAPPER="$tmp/send-log.sh" AUTO_REBOOT_PGREP="$tmp/pgrep-miss.sh" \
    AUTO_REBOOT_ARM_CMD="$tmp/arm-log.sh" MONITORING_HOST_LABELS= \
    AUTO_REBOOT_REBOOT_CMD="$tmp/reboot-noarg.sh" bash "$0" >/dev/null 2>&1
  ck "…and a NO-ARGUMENT child process really does not reboot" \
     "$([ -f "$tmp/rebooted-noarg" ] && echo yes || echo no)" "no"

  ck "all gates green + --apply DOES reboot" "$(green apply)" "AUTO_REBOOT_VERDICT=REBOOTED"
  ck "…and it actually invoked the reboot command" "$(grep -c rebooted "$tmp/rebooted")" "1"
  ck "…and it ARMED the peer watchdog BEFORE rebooting" "$(grep -c -- '--arm' "$tmp/armed")" "1"
  ck "…and it left a pending marker for the post-boot assertion" "$([ -f "$STATE" ] && echo yes || echo no)" "yes"

  # ── GATE 2 — not due is SILENT, because nothing is wrong. ────────────────────────────────
  rm -f "$STATE" "$tmp/paged"
  ck "staleness OK -> NOT_DUE" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-ok.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…and NOT_DUE never pages — nothing is wrong" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  ck "an unreadable staleness verdict is INDETERMINATE, never 'not due'" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-junk.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "…and THAT one pages" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "1"

  # ── GATE 3 — a reboot is not a repair tool. ─────────────────────────────────────────────
  rm -f "$tmp/paged"
  ck "boot-contract DRIFT -> ABORTED" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-drift.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…and an ABORT pages" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "1"
  ck "…and an ABORT never reboots" "$(grep -c rebooted "$tmp/rebooted")" "1"

  # ── GATE 4 — the registry, per host. ────────────────────────────────────────────────────
  rm -f "$tmp/paged"
  ck "an UNREADABLE registry is INDETERMINATE, never a reboot" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-broken.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "a registry with only ANOTHER host's rows is INDETERMINATE — never an empty pass" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-foreign.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "an EMPTY reason on one row is INDETERMINATE, never a silent safe-to-kill" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-noreason.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=INDETERMINATE"
  # A no-safe-kill row IN FLIGHT aborts. The sentinel is this very process's argv, so `pgrep -f`
  # matches something that genuinely exists — a fixture that could never match would assert nothing.
  rm -f "$STATE" "$tmp/pgrepped"
  ck "a no-safe-kill row IN FLIGHT aborts the reboot" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-nsk.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh PGREP_BIN=$tmp/pgrep-hit.sh MONITORING_HOST_LABELS= cmd_run apply 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…and it probed the ROW'S OWN pattern, not something incidental" \
     "$(grep -c -- '-f aoe-danger-pattern' "$tmp/pgrepped")" "1"
  ck "…and an ABORT never reboots" "$(grep -c rebooted "$tmp/rebooted")" "1"
  rm -f "$STATE"
  ck "the SAME row NOT in flight proceeds — the abort is the probe, not the row's mere presence" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-nsk.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh PGREP_BIN=$tmp/pgrep-miss.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=NOT_DUE"
  rm -f "$STATE"
  ck "…and the zero case is REPORTED, never silent" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | grep -c 'AUTO_REBOOT_GATE=in_flight state=PASS')" "1"

  # ── POST-BOOT — our own action is verified, not assumed. ────────────────────────────────
  rm -f "$tmp/paged" "$tmp/armed"
  printf '%s\n' "$(uname -r)" > "$STATE"     # same kernel => the reboot did not take
  ck "a post-boot run whose kernel did NOT advance is ABORTED" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-ok.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…and it pages" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "1"
  ck "…and it DISARMED the watchdog even on the failure path" "$(grep -c -- '--disarm' "$tmp/armed")" "1"
  ck "…and the marker is consumed, so it cannot page forever" "$([ -f "$STATE" ] && echo yes || echo no)" "no"
  printf 'some-older-kernel\n' > "$STATE"    # kernel advanced => the reboot worked
  rm -f "$tmp/paged"
  ck "a post-boot run whose kernel DID advance passes and carries on" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-ok.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…and a clean post-boot never pages" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  printf 'some-older-kernel\n' > "$STATE"; : > "$REBOOT_REQUIRED"
  rm -f "$tmp/paged"
  ck "a post-boot run with /var/run/reboot-required STILL present is ABORTED" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-ok.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | tail -1)" \
     "AUTO_REBOOT_VERDICT=ABORTED"
  rm -f "$REBOOT_REQUIRED" "$STATE"

  # ── EVERY token value is reachable, and every path prints exactly ONE. ──────────────────
  local missing=""
  for v in REFUSED NOT_DUE ABORTED INDETERMINATE REBOOTED; do
    grep -q "AUTO_REBOOT_VERDICT=$v" "$tmp/onetoken" 2>/dev/null || true
  done
  ck "exactly ONE terminal token per run" \
     "$(green dry-run >/dev/null; IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | grep -c '^AUTO_REBOOT_VERDICT=')" "1"
  # ONE line per gate, even when the log is UNWRITABLE — the tee-fallback double-print.
  ck "each gate prints EXACTLY once, even with an unwritable log" \
     "$(LOG=/nonexistent/dir/x.log IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-ok.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | grep -c 'AUTO_REBOOT_GATE=identity')" "1"
  ck "…and so does the terminal token" \
     "$(LOG=/nonexistent/dir/x.log IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-ok.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run dry-run 2>/dev/null | grep -c '^AUTO_REBOOT_VERDICT=')" "1"
  ck "the live path ALWAYS exits 0 — a harness outage must not bounce cron" \
     "$(IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-junk.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=/nonexistent SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= cmd_run apply >/dev/null 2>&1; echo $?)" "0"

  # ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────
  # Every case above replaces REBOOT_CMD, SEND and the identity file, so all of them are blind to
  # the real ones. A wrong default here reboots nothing (or the wrong thing) with a green suite.
  ck "SEAM — the REAL reboot command default" "$REAL_REBOOT" "/sbin/reboot"
  ck "SEAM — the REAL in-flight probe default" "$REAL_PGREP" "pgrep"
  ck "SEAM — the REAL identity file default" "$REAL_ID" "/etc/algovault-host-label"
  ck "SEAM — the REAL staleness canary path" "$REAL_STALE" "/opt/algovault-monitoring/kernel-staleness-canary.sh"
  ck "SEAM — the REAL boot-contract canary path" "$REAL_BC" "/opt/algovault-monitoring/boot-contract-canary.sh"
  ck "SEAM — the REAL registry path is the aoe-1 SYNCED COPY, not signal-1's checkout" \
     "$REAL_REG" "/opt/algovault-monitoring/cron-interlock-registry.json"
  ck "SEAM — the REAL alert wrapper (never re-implement its gates inline)" "$REAL_SEND" "/opt/algovault-monitoring/send_telegram.sh"
  ck "SEAM — the expected host is a HARDCODED constant, not an env seam" \
     "$(AUTO_REBOOT_EXPECTED_HOST=signal-1 bash "$0" --print-expected-host)" "aoe-1"
  # Asserted POSITIVELY over a known single page: every invocation must carry the alert id and the
  # severity send_telegram.sh gates on. An `-eq 0` assertion here would pass on a wrapper that is
  # never called at all, which is the shape of a dark alerter.
  rm -f "$tmp/paged"
  IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-junk.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json \
    SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh MONITORING_HOST_LABELS= \
    cmd_run apply >/dev/null 2>&1
  ck "SEAM — the wrapper is invoked as <alert_id> CRITICAL_PERSISTENT -" \
     "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT SEV=CRITICAL_PERSISTENT' "$tmp/paged")" "1"
  # The alert body is asserted, not just the action verdict: reverting a format string once left
  # every action assertion green while the operator-facing text went wrong.
  rm -f "$tmp/paged"
  MONITORING_HOST_LABELS=signal-1 IDENTITY_FILE=$tmp/id-aoe STALENESS=$tmp/stale-breach.sh BOOT_CONTRACT=$tmp/bc-ok.sh REGISTRY=$tmp/reg-ok.json SEND=$tmp/send-log.sh REBOOT_CMD=$tmp/reboot-log.sh ARM_CMD=$tmp/arm-log.sh cmd_run apply >/dev/null 2>&1
  ck "the page BODY names the alert id" "$(grep -c '🛑 KERNEL_AUTO_REBOOT' "$tmp/paged")" "1"
  ck "the page BODY carries a TEMPLATED wave, never a literal one" \
     "$(grep -c 'Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT}' "$tmp/paged")" "1"
  ck "the page BODY says the reboot did NOT happen" "$(grep -c 'the reboot was NOT performed' "$tmp/paged")" "1"
  ck "the page BODY names its source log" "$(grep -c "Source log: $tmp/log" "$tmp/paged")" "1"

  rm -rf "$tmp"
  if [ "$n" -lt 25 ]; then
    echo "SELF-TEST: only $n assertions ran (expected >= 25) — a shrinking suite is a defect"
    echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3
  fi
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: $fails of $n failed"; echo "SELF_TEST_VERDICT=FAIL"; return 1
  fi
  echo "SELF-TEST: PASS — $n checks"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

case "${1:-$DEFAULT_ARG}" in
  --apply)   cmd_run apply ;;
  --dry-run) cmd_run dry-run ;;
  --self-test) cmd_self_test ;;
  --print-expected-host) printf '%s\n' "$EXPECTED_HOST" ;;
  --print-default-mode)  printf '%s\n' "${DEFAULT_ARG#--}" ;;
  *) echo "usage: $0 [--dry-run|--apply|--self-test|--print-expected-host|--print-default-mode]" >&2; exit 2 ;;
esac
