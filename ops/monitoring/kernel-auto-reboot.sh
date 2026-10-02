#!/usr/bin/env bash
# kernel-auto-reboot.sh — OPS-HOST-AUTO-REBOOT-W1, promoted to signal-1 by
# OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1.
#
# A host reboots ITSELF for a kernel update: gated, watched by its peer, mutually exclusive with
# that peer, and refusing every host that is not on a HARDCODED allow-list.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
# Kernel packages land every 12-29 days (median 15, n=15, dpkg.log Apr-Aug 2026) and
# KERNEL_STALENESS pages at 7, so each cycle cost a hand-run Plan-Mode wave. aoe-1 has rebooted
# itself twice, both clean (2026-09-12 and 2026-10-02, each `REBOOTED` followed by
# `post_boot state=PASS`, zero AOE_PEER_UNREACHABLE). That was the RATIFIED promotion condition
# for signal-1 — "TWO clean unattended aoe-1 cycles AND a live peer watchdog" — and it has fired.
#
# ── THE ALLOW-LIST IS A FIREWALL, NOT A SEAM ────────────────────────────────────────────────
# The hosts this script may reboot are the case labels of host_policy() below. Not an env var, not
# a config file: a configurable firewall is not a firewall. Identity is evaluated FIRST, before any
# probe, and resolves env -> /etc/algovault-host-label -> REFUSE, with NO DEFAULT. An unlisted or
# unresolvable label REFUSES with zero side effects. (Until this wave the list was the single
# constant "aoe-1", and a signal-1 label refusing was the assertion that mattered most; the same
# ratification that promotes signal-1 retires that assertion, and the tests now pin the new one: an
# UNLISTED host refuses.)
#
# ── PER-HOST POLICY, BECAUSE THE TWO HOSTS ARE NOT THE SAME RISK ────────────────────────────
#                    aoe-1 (tuner)                    signal-1 (revenue)
#   window           any hour                         03:00-13:59Z (PR-1: outside the declared
#                                                     18:00-02:59 deploy-free window, inside the
#                                                     operator's reachable hours)
#   arm failure      DEGRADED — reboot unwatched      DEFERRED — never reboot the revenue host
#                    (unchanged from W1)              unwatched (PR-3)
#   serving probe    none                             local /health 200 after boot (R0.6)
#   registry         the SYNCED copy in               the CHECKOUT copy the deploy interlock reads
#                    /opt/algovault-monitoring        (/opt/crypto-quant-signal-mcp/ops/scripts)
#   population       its 4 declared rows              + the LIVE crontab and units, through
#                                                     scripts/check-cron-interlock-coverage.mjs
#   deploys          none declared                    3 host-side signatures (R0.5)
#
# ── CONSUME, NEVER RE-DERIVE ────────────────────────────────────────────────────────────────
# "Is a reboot due" is kernel-staleness-canary.sh's decide(). "Does this host still match its boot
# contract" is boot-contract-canary.sh. "What would a reboot cost" is the REBOOT scope of
# ops/scripts/cron-interlock-registry.json. "Is every live job classified" is
# check-cron-interlock-coverage.mjs. This harness READS all four verdicts and derives none.
#
# ── GATES, IN ORDER — every one prints a POSITIVE line on every path, reached or not ────────
#   identity          unlisted / unresolvable              -> REFUSED + page
#   post_boot         (only after our own reboot) kernel did not advance, reboot-required still
#                     present, boot contract != OK, or the serving probe fails -> ABORTED + page
#   due               staleness != BREACH                  -> NOT_DUE, silent
#   contract          BOOT_CONTRACT_VERDICT != OK          -> ABORTED + page
#   window            outside the host's window            -> NOT_DUE, silent
#   peer_busy         the PEER's arm marker is present LOCALLY (it is mid-cycle), or unreadable
#                                                          -> DEFERRED, silent
#   deploy_in_flight  a deploy's process signature is live -> DEFERRED, silent
#   in_flight         population check FAIL -> DEFERRED; INDETERMINATE -> INDETERMINATE + page;
#                     a REBOOT-scope no-safe-kill row live -> ABORTED (retry next run);
#                     a preempt-and-catchup row live with no recorded reboot recovery -> DEFERRED
#   arm               arm the peer's watchdog; failure -> DEFERRED (signal-1) / DEGRADED (aoe-1)
#   recheck           re-probe the same rows AFTER the arm; anything now in flight -> disarm, ABORTED
#   action            --apply -> REBOOT; otherwise DRY_RUN
#
# A persistent DEFERRED needs no alarm of its own: KERNEL_STALENESS's COVERED branch pages daily on
# a stale covered host with "a GATE REFUSED — read the harness log", and this log names the gate.
#
# ── MUTUAL EXCLUSION, FROM DATA EACH HOST ALREADY HOLDS ─────────────────────────────────────
# Both hosts get their kernels from the same unattended-upgrades slot and so become due on the same
# day. Each host's arm lives ON ITS WATCHER, which is the other host — so every arm marker is
# readable LOCALLY on the host that must not reboot while it exists. A host whose peer is mid-cycle
# DEFERS until the peer's own post-boot run disarms. No coordination channel, no new credential.
#
# ── VERDICT CONTRACT ────────────────────────────────────────────────────────────────────────
# Exactly ONE terminal AUTO_REBOOT_VERDICT=REBOOTED|NOT_DUE|DEFERRED|ABORTED|REFUSED|INDETERMINATE.
# Every run appends ONE canary_result_log record (canary `kernel-auto-reboot`) so the cycle count
# reaches the vault by itself through monitoring-results-sync.sh's pull leg — the 2026-08-29 entry
# recorded that "nothing counts the clean cycles". Exit is ALWAYS 0 on the live path; `--self-test`
# exits 0 pass / 1 fail / 3 indeterminate with its own SELF_TEST_VERDICT line.
#
# --dry-run IS THE DEFAULT. An actual reboot requires an explicit --apply on the cron line.
set -uo pipefail

ALERT_ID="KERNEL_AUTO_REBOOT"
RESULT_CANARY="kernel-auto-reboot"

LOG="${AUTO_REBOOT_LOG:-/var/log/algovault-kernel-auto-reboot.log}"
IDENTITY_FILE="${AUTO_REBOOT_IDENTITY_FILE:-/etc/algovault-host-label}"
STALENESS="${AUTO_REBOOT_STALENESS:-/opt/algovault-monitoring/kernel-staleness-canary.sh}"
BOOT_CONTRACT="${AUTO_REBOOT_BOOT_CONTRACT:-/opt/algovault-monitoring/boot-contract-canary.sh}"
# send_telegram.sh OWNS severity, cooldown, the {NEXT} resolver, the INERT gates and fail-open.
SEND="${AUTO_REBOOT_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
PY_BIN="${AUTO_REBOOT_PY:-python3}"
NODE_BIN="${AUTO_REBOOT_NODE:-node}"
CRONTAB_BIN="${AUTO_REBOOT_CRONTAB:-crontab}"
SYSTEMCTL_BIN="${AUTO_REBOOT_SYSTEMCTL:-systemctl}"
CURL_BIN="${AUTO_REBOOT_CURL:-curl}"
# ONE process-table snapshot per run, matched IN-PROCESS with bash `=~`. No child process ever
# carries a pattern in its argv, so the probe cannot see itself; patterns are bracketed anyway
# (Build Rule 10), because the W5 R0.3 probe DID self-match through an SSH `bash -c` argv. Seamed
# so --self-test can hand it a fixture table; the real default is asserted there.
PS_BIN="${AUTO_REBOOT_PS:-ps}"
# The destructive primitive, seamed so --self-test can prove the apply path REACHES it.
REBOOT_CMD="${AUTO_REBOOT_REBOOT_CMD:-/sbin/reboot}"
# Arms (and disarms) the PEER's watchdog for THIS host's reboot; it resolves its own pair.
ARM_CMD="${AUTO_REBOOT_ARM_CMD:-/opt/algovault-monitoring/arm-peer-watchdog.sh}"
# Survives the reboot: what we were running before, so the next run can assert the kernel MOVED.
STATE="${AUTO_REBOOT_STATE:-/var/lib/algovault-monitoring/.auto-reboot-pending}"
REBOOT_REQUIRED="${AUTO_REBOOT_REQUIRED_FILE:-/var/run/reboot-required}"
# Where canary_result_log.py sits (it is installed beside the monitoring artifacts on both hosts).
RESULT_LOG_DIR="${AUTO_REBOOT_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
# The UTC hour, seamed ONLY so the window gate's edges can be driven by --self-test.
NOW_HOUR="${AUTO_REBOOT_NOW_HOUR:-}"
DEFAULT_ARG="--dry-run"

# ── THE ALLOW-LIST + PER-HOST POLICY. Hardcoded on purpose — see the header. ────────────────
# Every key a host lacks is a REFUSAL, never a fallback. Seam overrides (AUTO_REBOOT_*) exist only
# for paths a hermetic test must redirect; the host LIST and the POLICY values have none.
host_policy() { # host_policy <host> <key>
  case "$1:$2" in
    aoe-1:peer)               echo signal-1 ;;
    aoe-1:window)             echo any ;;
    aoe-1:arm_failure)        echo DEGRADED ;;
    aoe-1:serving_probe)      echo "" ;;
    aoe-1:registry)           echo /opt/algovault-monitoring/cron-interlock-registry.json ;;
    aoe-1:peer_arm_marker)    echo /var/lib/algovault-monitoring/.signal1-reboot-arm ;;
    aoe-1:deploy_signatures)  echo "" ;;
    aoe-1:population_check)   echo "" ;;
    signal-1:peer)            echo aoe-1 ;;
    signal-1:window)          echo "03-13" ;;
    signal-1:arm_failure)     echo DEFERRED ;;
    signal-1:serving_probe)   echo "http://127.0.0.1:3000/health" ;;
    signal-1:registry)        echo /opt/crypto-quant-signal-mcp/ops/scripts/cron-interlock-registry.json ;;
    signal-1:peer_arm_marker) echo /var/lib/algovault-monitoring/.aoe-reboot-arm ;;
    # R0.5: the three paths that deploy onto signal-1, by a process signature present for the
    # deploy's whole duration. BRACKETED ERE — the text of a pattern never matches itself.
    #   cqsm deploy.yml   appleboy/ssh-action runs the whole script as ONE remote shell argv that
    #                     carries `docker compose up -d --build --force-recreate` (git reset ->
    #                     build -> recreate -> catch-up), and the compose child carries it too
    #   editorial deploy  ssh-action script `cd /opt/algovault-editorial … git fetch …`
    #   bot / carry       ops/scripts/host-deploy.sh stages into `$DEST/.deploy-staging-<ts>`
    signal-1:deploy_signatures) printf '%s\n' '--force-recreat[e]' 'cd /opt/algovault-editoria[l]' '[.]deploy-stagin[g]' ;;
    signal-1:population_check)  echo /opt/crypto-quant-signal-mcp/scripts/check-cron-interlock-coverage.mjs ;;
    *) return 1 ;;
  esac
}
ALLOWED_HOSTS="aoe-1 signal-1"   # the case labels above, listed once for --print-allowed-hosts

# The hours a window string allows, inclusive: "any" or "HH-HH".
in_window() { # in_window <window> <hour>
  local w="$1" h="$2"
  [ "$w" = any ] && return 0
  local lo="${w%-*}" hi="${w#*-}"
  h=$((10#$h)); lo=$((10#$lo)); hi=$((10#$hi))
  [ "$h" -ge "$lo" ] && [ "$h" -le "$hi" ]
}

# STDOUT AND THE LOG ARE WRITTEN SEPARATELY, never through `… | tee -a "$LOG" || printf …` — that
# idiom double-prints a machine-readable line whenever the log is unwritable.
_emit() {
  printf '%s\n' "$1"
  ( printf '%s\n' "$1" >> "$LOG" ) 2>/dev/null || true
}
log() { _emit "$(printf '%s [%s] %s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*")"; }

# ── POSITIVE PER-GATE OUTPUT, including gates never reached ─────────────────────────────────
GATE_ORDER="identity post_boot due contract window peer_busy deploy_in_flight in_flight arm recheck action"
REACHED=""
gate() { # gate <name> <state> <detail>
  REACHED="$REACHED $1"
  _emit "$(printf 'AUTO_REBOOT_GATE=%s state=%s %s' "$1" "$2" "${3:-}")"
}

HOST="" PEER="" DECIDED_BY="" KERNEL_BEFORE="" KERNEL_AFTER=""
# Every path ends here: unreached gates are printed, ONE record is appended, ONE token is printed.
finish() { # finish <VERDICT> <deciding gate>
  local v="$1"; DECIDED_BY="$2"
  local g
  for g in $GATE_ORDER; do
    case " $REACHED " in *" $g "*) ;; *) _emit "AUTO_REBOOT_GATE=$g state=NOT_REACHED decided earlier by gate=$DECIDED_BY" ;; esac
  done
  record "$v"
  echo "AUTO_REBOOT_VERDICT=$v"
}

# ── the off-host record — every run, every path ─────────────────────────────────────────────
# canary_result_log.py defaults its host to signal-1, so the RESOLVED identity is passed in
# explicitly; a record from aoe-1 claiming to be signal-1 would corrupt the cycle count it exists
# for. A logging failure must never change the verdict, so it is a POSITIVE line either way.
record() { # record <VERDICT>
  local metrics
  metrics="$(printf '{"decided_by":"%s","peer":"%s","kernel_running":"%s","kernel_before":"%s","kernel_after":"%s"}' \
    "${DECIDED_BY:-none}" "${PEER:-none}" "$(uname -r)" "${KERNEL_BEFORE:-}" "${KERNEL_AFTER:-}")"
  local out
  out="$(MONITORING_HOST_LABEL="${HOST:-unresolved}" "$PY_BIN" - "$RESULT_LOG_DIR" "$RESULT_CANARY" "$1" "$metrics" <<'PYREC' 2>/dev/null
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print("CANARY_RESULT_LOG_FAILED=import:%s" % type(e).__name__); raise SystemExit(0)
try:
    metrics = json.loads(sys.argv[4])
except Exception:
    metrics = {"metrics_unparseable": True}
ok, detail = append_result(sys.argv[2], sys.argv[3], 0, metrics)
print(("CANARY_RESULT_LOG=%s" if ok else "CANARY_RESULT_LOG_FAILED=%s") % detail)
PYREC
)" || true
  _emit "${out:-CANARY_RESULT_LOG_FAILED=python_unavailable}"
}

# ── identity, evaluated FIRST ────────────────────────────────────────────────────────────────
resolve_host() {
  local h="${MONITORING_HOST_LABELS:-}"
  [ -n "$h" ] || { [ -r "$IDENTITY_FILE" ] && h="$(head -1 "$IDENTITY_FILE" 2>/dev/null | tr -d '[:space:]')"; }
  printf '%s' "${h%%,*}"
}

# ── the page ─────────────────────────────────────────────────────────────────────────────────
# recommended_wave is TEMPLATED; send_telegram.sh resolves it at send time.
page() { # page <verdict> <one-line condition> <context>
  printf '%s\n' \
    "🛑 $ALERT_ID — ${HOST:-<unresolved host>} unattended kernel reboot did not proceed" \
    "Condition: $2" \
    "Context: $3" \
    "Host: ${HOST:-<unresolved>} · peer: ${PEER:-<none>} · verdict: $1 · the reboot was NOT performed" \
    "Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT} via Cowork → Claude Code" \
    "Audit shape: ops/monitoring/kernel-auto-reboot.sh --self-test" \
    "Source log: $LOG" \
  | ( "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" ) 2>/dev/null \
  || log "FAIL_OPEN: send_telegram invocation failed (rc=$?) — the wrapper owns fail-open; this is the record that it did"
}

# ── consumed verdicts ───────────────────────────────────────────────────────────────────────
staleness_verdict() {
  [ -x "$STALENESS" ] || { printf 'INDETERMINATE'; return 0; }
  local out v
  out="$("$STALENESS" 2>/dev/null)" || true
  v="$(printf '%s\n' "$out" | grep -oE 'VERDICT=(OK|REPORT|BREACH|INDETERMINATE)' | tail -1 | cut -d= -f2)"
  printf '%s' "${v:-INDETERMINATE}"
}
boot_contract_verdict() {
  [ -x "$BOOT_CONTRACT" ] || { printf 'INDETERMINATE'; return 0; }
  local out v
  out="$("$BOOT_CONTRACT" 2>/dev/null)" || true
  v="$(printf '%s\n' "$out" | grep -oE 'BOOT_CONTRACT_VERDICT=(OK|DRIFT|INDETERMINATE)' | tail -1 | cut -d= -f2)"
  printf '%s' "${v:-INDETERMINATE}"
}

# ── the process table, ONE snapshot ─────────────────────────────────────────────────────────
PS_SNAPSHOT=""
snapshot_ps() { PS_SNAPSHOT="$("$PS_BIN" -eww -o args= 2>/dev/null)"; }
# probe_rows <reboot_rows output> — sets NSK_LIVE / PAC_LIVE / PROBED against the CURRENT snapshot.
# One body for both probes (in_flight and recheck), so the two can never disagree on what "in flight" means.
NSK_LIVE="" PAC_LIVE="" PROBED=0
probe_rows() {
  local id cls pat rec
  NSK_LIVE="" PAC_LIVE="" PROBED=0
  while IFS="$(printf '\t')" read -r id cls pat rec; do
    [ -n "$id" ] || continue
    PROBED=$((PROBED + 1))
    ps_matches "$(bracketed_ere "$pat")" || continue
    if [ "$cls" = no-safe-kill ]; then NSK_LIVE="$NSK_LIVE $id"
    elif [ "$rec" != 1 ]; then PAC_LIVE="$PAC_LIVE $id"; fi
  done <<< "$(printf '%s\n' "$1" | tail -n +2)"
}
# Any line of the snapshot matching an ERE. In-process: no child process ever sees the pattern.
ps_matches() { # ps_matches <ere>
  local re="$1" line
  while IFS= read -r line; do
    [[ "$line" =~ $re ]] && return 0
  done <<< "$PS_SNAPSHOT"
  return 1
}
# A registry pattern is a FIXED string. Escape every ERE metacharacter, then bracket the last
# alphanumeric so the pattern's own text never matches it (Build Rule 10).
bracketed_ere() { # bracketed_ere <fixed>
  local esc; esc="$(printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|]/\\&/g')"
  printf '%s' "$esc" | sed -E 's/([A-Za-z0-9])([^A-Za-z0-9]*)$/[\1]\2/'
}

# ── the REBOOT scope of this host's registry rows ───────────────────────────────────────────
# Emits "<total>\n" then one "<id>\t<class>\t<pattern>\t<recovery>" line per row that a reboot
# kill would matter for (no-safe-kill / preempt-and-catchup), or exits non-zero if the registry
# cannot be read, has no row for this host, or carries a row on this host with no REBOOT
# classification (unanswered is never "safe").
reboot_rows() { # reboot_rows <registry> <host>
  [ -f "$1" ] || return 1
  "$PY_BIN" - "$1" "$2" <<'PY'
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
VALID = ("safe-to-kill", "preempt-and-catchup", "no-safe-kill")
for r in mine:
    ev = r.get("events")
    if not isinstance(ev, list) or "reboot" not in ev:
        sys.exit(1)
    if str(r.get("class") or "").strip() not in VALID or not str(r.get("reason") or "").strip():
        sys.exit(1)
print(len(mine))
for r in mine:
    if r.get("class") in ("no-safe-kill", "preempt-and-catchup"):
        pat = str(r.get("process_pattern") or "").strip()
        if not pat:
            sys.exit(1)
        rec = "1" if str(r.get("reboot_recovery") or "").strip() else "0"
        print("\t".join([str(r.get("id")), r["class"], pat, rec]))
PY
}

# ── the live population check (signal-1), through the ONE coverage gate ────────────────────
population_verdict() { # population_verdict <gate script>
  local gate="$1" tmp out tok
  [ -r "$gate" ] || { printf 'INDETERMINATE gate script unreadable at %s' "$gate"; return 0; }
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/autoreboot-pop.XXXXXX")" || { printf 'INDETERMINATE mktemp'; return 0; }
  if ! "$CRONTAB_BIN" -l > "$tmp/crontab" 2>/dev/null; then rm -rf "$tmp"; printf 'INDETERMINATE crontab unreadable'; return 0; fi
  { "$SYSTEMCTL_BIN" list-units --type=service --state=running --no-legend --plain 2>/dev/null | awk '{print $1}'
    "$SYSTEMCTL_BIN" list-unit-files --type=timer --state=enabled --no-legend 2>/dev/null | awk '{print $1}'; } > "$tmp/units"
  out="$("$NODE_BIN" "$gate" --host "$HOST" --event reboot --crontab "$tmp/crontab" --units "$tmp/units" 2>&1)" || true
  rm -rf "$tmp"
  tok="$(printf '%s\n' "$out" | grep -oE '^CRON_INTERLOCK_COVERAGE_VERDICT=[A-Z]+' | tail -1 | cut -d= -f2)"
  # The unmapped items, so the log names exactly what blocked the reboot.
  printf '%s %s' "${tok:-INDETERMINATE}" "$(printf '%s\n' "$out" | grep -E '✗ live (crontab line|unit)' | head -5 | tr '\n' ';' | cut -c1-600)"
}

# ── the run ──────────────────────────────────────────────────────────────────────────────────
cmd_run() { # cmd_run <apply|dry-run>
  local mode="$1"
  HOST="$(resolve_host)"

  # ── GATE identity — FIRST, before any probe. ────────────────────────────────────────────
  if [ -z "$HOST" ]; then
    gate identity REFUSED "resolved=<none> allowed=[$ALLOWED_HOSTS] — env MONITORING_HOST_LABELS and $IDENTITY_FILE both empty; there is deliberately NO default"
    log "REFUSED: unresolvable host identity"
    page REFUSED "host identity is unresolvable" "MONITORING_HOST_LABELS empty and $IDENTITY_FILE unreadable; no default is permitted"
    finish REFUSED identity; return 0
  fi
  if ! PEER="$(host_policy "$HOST" peer)"; then
    PEER=""
    gate identity REFUSED "resolved=$HOST allowed=[$ALLOWED_HOSTS] — not on the hardcoded allow-list"
    log "REFUSED: identity=$HOST is not on the allow-list — no further gate was evaluated, nothing was touched"
    page REFUSED "this harness was invoked on '$HOST', which is not on its allow-list" "allowed: $ALLOWED_HOSTS — the list is a hardcoded constant, not a seam"
    finish REFUSED identity; return 0
  fi
  gate identity PASS "resolved=$HOST via ${MONITORING_HOST_LABELS:+MONITORING_HOST_LABELS}${MONITORING_HOST_LABELS:-$IDENTITY_FILE} · peer=$PEER"

  local registry="${AUTO_REBOOT_REGISTRY:-$(host_policy "$HOST" registry)}"
  local peer_marker="${AUTO_REBOOT_PEER_ARM_MARKER:-$(host_policy "$HOST" peer_arm_marker)}"
  local serving; serving="$(host_policy "$HOST" serving_probe)"
  local window; window="$(host_policy "$HOST" window)"
  local arm_failure; arm_failure="$(host_policy "$HOST" arm_failure)"
  local pop_gate="${AUTO_REBOOT_POPULATION_GATE:-$(host_policy "$HOST" population_check)}"

  # ── POST-BOOT — our own action is verified before anything new is considered. ───────────
  if [ -f "$STATE" ]; then
    KERNEL_BEFORE="$(head -1 "$STATE" 2>/dev/null | tr -d '[:space:]')"
    KERNEL_AFTER="$(uname -r)"
    local bc; bc="$(boot_contract_verdict)"
    local still_req="no"; [ -f "$REBOOT_REQUIRED" ] && still_req="yes"
    local srv="SKIP"
    if [ -n "$serving" ]; then
      local code; code="$("$CURL_BIN" -s -o /dev/null -m 10 -w '%{http_code}' "$serving" 2>/dev/null)" || true
      srv="${code:-000}"
    fi
    rm -f "$STATE" 2>/dev/null
    "$ARM_CMD" --disarm >/dev/null 2>&1 || log "post-boot: disarm returned rc=$? (the watchdog's stale-arm ceiling is the backstop)"
    if [ "$KERNEL_BEFORE" = "$KERNEL_AFTER" ] || [ "$still_req" = yes ] || [ "$bc" != OK ] || { [ -n "$serving" ] && [ "$srv" != 200 ]; }; then
      gate post_boot FAIL "kernel_before=$KERNEL_BEFORE kernel_now=$KERNEL_AFTER reboot_required=$still_req boot_contract=$bc serving=${serving:+$srv}${serving:-SKIP}"
      log "ABORTED: post-boot assertion failed after our own reboot"
      page ABORTED "the previous unattended reboot did not verify" "kernel_before=$KERNEL_BEFORE kernel_now=$KERNEL_AFTER reboot_required=$still_req boot_contract=$bc serving=${serving:+$srv}${serving:-SKIP}"
      finish ABORTED post_boot; return 0
    fi
    gate post_boot PASS "kernel advanced $KERNEL_BEFORE -> $KERNEL_AFTER · reboot_required cleared · boot_contract=OK · serving=${serving:+$srv from $serving}${serving:-SKIP (no probe declared for $HOST)}"
  else
    gate post_boot SKIP "no pending marker — the last run did not reboot"
  fi

  # ── GATE due ─────────────────────────────────────────────────────────────────────────────
  local sv; sv="$(staleness_verdict)"
  case "$sv" in
    BREACH) gate due PASS "kernel-staleness-canary verdict=BREACH — a newer kernel has been installed past the threshold" ;;
    OK|REPORT)
      gate due NOT_DUE "kernel-staleness-canary verdict=$sv — nothing to do, and nothing is wrong"
      log "NOT_DUE: staleness verdict=$sv"
      finish NOT_DUE due; return 0 ;;
    *)
      gate due INDETERMINATE "kernel-staleness-canary verdict=${sv:-<unreadable>} at $STALENESS"
      log "INDETERMINATE: could not read the staleness verdict"
      page INDETERMINATE "the staleness canary's verdict could not be read" "path=$STALENESS verdict=${sv:-<unreadable>}; the harness will not reboot on an unknown answer"
      finish INDETERMINATE due; return 0 ;;
  esac

  # ── GATE contract — a reboot is not a repair tool. ──────────────────────────────────────
  local bc; bc="$(boot_contract_verdict)"
  if [ "$bc" != OK ]; then
    gate contract ABORT "boot-contract-canary verdict=$bc — a reboot is not a repair tool"
    log "ABORTED: boot contract verdict=$bc"
    page ABORTED "the host does not match its boot contract" "BOOT_CONTRACT_VERDICT=$bc — rebooting now bets that the contract holds on the other side, and nobody is awake to take that bet"
    finish ABORTED contract; return 0
  fi
  gate contract PASS "boot-contract-canary verdict=OK"

  # ── GATE window ──────────────────────────────────────────────────────────────────────────
  local hour="${NOW_HOUR:-$(date -u +%H)}"
  if ! in_window "$window" "$hour"; then
    gate window NOT_DUE "hour=${hour}Z is outside $HOST's window ($window) — the next run inside it decides"
    log "NOT_DUE: outside the $window window at ${hour}Z"
    finish NOT_DUE window; return 0
  fi
  gate window PASS "hour=${hour}Z inside $HOST's window ($window)"

  # ── GATE peer_busy — the peer's arm, read LOCALLY. ──────────────────────────────────────
  if [ -e "$peer_marker" ]; then
    gate peer_busy DEFERRED "$PEER's arm marker is present at $peer_marker — $PEER is mid-cycle; this host waits for its post-boot disarm"
    log "DEFERRED: peer $PEER is mid-cycle ($peer_marker present)"
    finish DEFERRED peer_busy; return 0
  fi
  if [ ! -d "$(dirname "$peer_marker")" ] || [ ! -r "$(dirname "$peer_marker")" ]; then
    gate peer_busy DEFERRED "cannot read $(dirname "$peer_marker") — whether $PEER is mid-cycle is unknown, and unknown is not 'free'"
    log "DEFERRED: peer marker directory unreadable"
    finish DEFERRED peer_busy; return 0
  fi
  gate peer_busy PASS "no $PEER arm at $peer_marker"

  # ── GATE deploy_in_flight ────────────────────────────────────────────────────────────────
  snapshot_ps
  if [ -z "$PS_SNAPSHOT" ]; then
    gate deploy_in_flight INDETERMINATE "the process table could not be read via $PS_BIN"
    log "INDETERMINATE: empty process snapshot"
    page INDETERMINATE "the process table could not be read" "PS_BIN=$PS_BIN returned nothing — no in-flight probe can run"
    finish INDETERMINATE deploy_in_flight; return 0
  fi
  local sigs sig live_sig="" nsig=0
  sigs="$(host_policy "$HOST" deploy_signatures)"
  while IFS= read -r sig; do
    [ -n "$sig" ] || continue
    nsig=$((nsig + 1))
    ps_matches "$sig" && live_sig="$live_sig $sig"
  done <<< "$sigs"
  if [ -n "$live_sig" ]; then
    gate deploy_in_flight DEFERRED "deploy signature(s) live:$live_sig — a reboot between a container's removal and its recreation strands it"
    log "DEFERRED: deploy in flight:$live_sig"
    finish DEFERRED deploy_in_flight; return 0
  fi
  gate deploy_in_flight PASS "$nsig declared deploy signature(s) for $HOST, none live"

  # ── GATE in_flight — the REBOOT scope ───────────────────────────────────────────────────
  if [ -n "$pop_gate" ]; then
    local pv; pv="$(population_verdict "$pop_gate")"
    case "${pv%% *}" in
      PASS) : ;;
      FAIL)
        gate in_flight DEFERRED "live population has unclassified job(s) — a reboot would kill work nobody has classified: ${pv#* }"
        log "DEFERRED: unclassified live population: ${pv#* }"
        finish DEFERRED in_flight; return 0 ;;
      *)
        gate in_flight INDETERMINATE "population check could not decide: ${pv#* }"
        log "INDETERMINATE: population check: $pv"
        page INDETERMINATE "the live population check could not decide" "${pv} — the harness will not reboot without knowing what a reboot would cost"
        finish INDETERMINATE in_flight; return 0 ;;
    esac
  fi
  local rows total
  if ! rows="$(reboot_rows "$registry" "$HOST" 2>/dev/null)" || [ -z "$rows" ]; then
    gate in_flight INDETERMINATE "registry unreadable, host-less, or carrying a row with no REBOOT classification: $registry"
    log "INDETERMINATE: cron-interlock registry could not be read for host=$HOST"
    page INDETERMINATE "the cron-interlock registry could not be read for $HOST" "path=$registry — the harness will not reboot without knowing what a reboot would cost"
    finish INDETERMINATE in_flight; return 0
  fi
  total="$(printf '%s\n' "$rows" | head -1)"
  probe_rows "$rows"
  if [ -n "$NSK_LIVE" ]; then
    gate in_flight ABORT "rows=$total probed=$PROBED no-safe-kill in flight:$NSK_LIVE — retry next run"
    log "ABORTED: no-safe-kill job in flight:$NSK_LIVE"
    finish ABORTED in_flight; return 0
  fi
  if [ -n "$PAC_LIVE" ]; then
    gate in_flight DEFERRED "rows=$total probed=$PROBED preempt-and-catchup in flight with no recorded reboot recovery:$PAC_LIVE — nothing relaunches it after a reboot"
    log "DEFERRED: preempt-and-catchup in flight:$PAC_LIVE"
    finish DEFERRED in_flight; return 0
  fi
  # POSITIVE even at zero: "nothing is unsafe" must stay distinguishable from "the filter broke".
  gate in_flight PASS "rows=$total probed=$PROBED in_flight=none — evaluated $total $HOST REBOOT-scope row(s)${pop_gate:+ · live population classified}"

  # ── GATE arm + action ────────────────────────────────────────────────────────────────────
  if [ "$mode" != apply ]; then
    gate arm SKIP "dry-run — the peer watchdog is armed only on the way to a real reboot"
    gate recheck SKIP "dry-run — nothing was armed, so there is no window to close"
    gate action DRY_RUN "every gate passed; --apply was NOT given, so nothing was rebooted"
    log "DRY_RUN: all gates passed; would have rebooted"
    finish NOT_DUE action; return 0
  fi
  # ARM BEFORE REBOOTING, never after — after is never. Read the TOKEN, never the exit code: the arm
  # helper exits 0 on every path, so an exit-code test (as W1 shipped) can never see a failed arm.
  local arm_out arm_tok
  arm_out="$("$ARM_CMD" --arm 2>/dev/null)" || true
  arm_tok="$(printf '%s\n' "$arm_out" | grep -oE 'PEER_ARM_VERDICT=[A-Z]+' | tail -1 | cut -d= -f2)"
  if [ "$arm_tok" != ARMED ]; then
    if [ "$arm_failure" = DEFERRED ]; then
      gate arm DEFERRED "arm via $ARM_CMD returned ${arm_tok:-<no token>} — $HOST never reboots unwatched; retry next run"
      log "DEFERRED: peer watchdog could not be armed (${arm_tok:-<no token>})"
      finish DEFERRED arm; return 0
    fi
    gate arm DEGRADED "arm via $ARM_CMD returned ${arm_tok:-<no token>} — rebooting $HOST unwatched, and saying so"
    log "WARN: could not arm the peer watchdog (${arm_tok:-<no token>}); proceeding per $HOST policy"
  else
    gate arm PASS "peer watchdog armed on $PEER via $ARM_CMD"
  fi
  # ── GATE recheck — close the check-then-act window ───────────────────────────────────────
  # The arm is a network round-trip, and signal-1 starts a no-safe-kill job every minute (the bot
  # alert engine at :10s). Re-snapshot and re-probe AFTER the arm and BEFORE the state file, so a job
  # that started inside the window aborts the reboot instead of being killed by it. On abort the arm
  # is withdrawn — a planted arm with no reboot behind it would otherwise sit until the 6 h ceiling.
  snapshot_ps
  if [ -z "$PS_SNAPSHOT" ]; then NSK_LIVE=" <process table unreadable>"; PAC_LIVE=""; else probe_rows "$rows"; fi
  if [ -n "$NSK_LIVE$PAC_LIVE" ]; then
    "$ARM_CMD" --disarm >/dev/null 2>&1 || true
    gate recheck ABORT "job(s) started after the in_flight probe:$NSK_LIVE$PAC_LIVE — arm withdrawn; retry next run"
    log "ABORTED: in flight at recheck:$NSK_LIVE$PAC_LIVE (arm withdrawn)"
    finish ABORTED recheck; return 0
  fi
  gate recheck PASS "re-probed $PROBED row(s) after the arm — still none in flight"
  uname -r > "$STATE" 2>/dev/null || { mkdir -p "$(dirname "$STATE")" 2>/dev/null; uname -r > "$STATE" 2>/dev/null; }
  KERNEL_BEFORE="$(uname -r)"
  gate action REBOOT "all gates passed and --apply was given"
  log "REBOOTED: issuing $REBOOT_CMD (kernel_before=$KERNEL_BEFORE)"
  finish REBOOTED action
  "$REBOOT_CMD" >/dev/null 2>&1 || log "WARN: reboot command returned rc=$?"
  return 0
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────
cmd_self_test() {
  local fails=0 n=0
  ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got '$2', want '$3'"; fails=$((fails+1)); fi; }
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/kar-st.XXXXXX")
  # Assign the RESOLVED GLOBALS, never the AUTO_REBOOT_* env: the constants resolve at LOAD.
  local REAL_PS="$PS_BIN" REAL_REBOOT="$REBOOT_CMD" REAL_ARM="$ARM_CMD" REAL_ID="$IDENTITY_FILE" REAL_STALE="$STALENESS" REAL_BC="$BOOT_CONTRACT" REAL_SEND="$SEND" REAL_RLD="$RESULT_LOG_DIR"
  LOG="$tmp/log"; REBOOT_REQUIRED="$tmp/reboot-required"
  # ONE pending-reboot marker PER HOST: the two simulated hosts must not read each other's.
  local STATE_A="$tmp/state-aoe" STATE_S="$tmp/state-signal"
  RESULT_LOG_DIR="$tmp/rl"; mkdir -p "$RESULT_LOG_DIR"
  export CANARY_RESULT_LOG_PATH="$tmp/results.jsonl"
  # A recorder stand-in with canary_result_log's real signature, so the record leg is exercised
  # without the host module (the --self-test runs on the operator's Mac).
  cat > "$RESULT_LOG_DIR/canary_result_log.py" <<'PYSTUB'
import json, os
def append_result(canary, verdict, exit_code, metrics=None, **kw):
    rec = {"host": os.environ.get("MONITORING_HOST_LABEL", "signal-1"), "canary": canary, "verdict": verdict, "metrics": metrics or {}}
    with open(os.environ["CANARY_RESULT_LOG_PATH"], "a") as fh:
        fh.write(json.dumps(rec) + "\n")
    return True, "line=1"
PYSTUB

  mk() { printf '#!/bin/sh\n%s\n' "$2" > "$1"; chmod +x "$1"; }
  mk "$tmp/stale-ok.sh"     'echo "VERDICT=OK host=x"'
  mk "$tmp/stale-breach.sh" 'echo "VERDICT=BREACH host=x"'
  mk "$tmp/stale-junk.sh"   'echo "nothing useful"'
  mk "$tmp/bc-ok.sh"        'echo "BOOT_CONTRACT_VERDICT=OK"'
  mk "$tmp/bc-drift.sh"     'echo "BOOT_CONTRACT_VERDICT=DRIFT"'
  mk "$tmp/reboot-log.sh"   "echo rebooted >> $tmp/rebooted"
  mk "$tmp/reboot-noarg.sh" "echo rebooted >> $tmp/rebooted-noarg"
  # The arm stub writes to a FILE that stands in for the peer's local marker, so mutual exclusion
  # is driven through the same marker the other host's harness reads.
  mk "$tmp/arm-ok.sh"       "echo \"\$@\" >> $tmp/armed; [ \"\$1\" = --arm ] && echo armed > \"\${ARM_MARKER_FILE:-$tmp/peer-marker}\"; [ \"\$1\" = --disarm ] && rm -f \"\${ARM_MARKER_FILE:-$tmp/peer-marker}\"; echo PEER_ARM_VERDICT=ARMED"
  mk "$tmp/arm-fail.sh"     "echo \"\$@\" >> $tmp/armed; echo PEER_ARM_VERDICT=FAILED"
  mk "$tmp/send-log.sh"     "cat >> $tmp/paged; echo \"ALERT=\$1 SEV=\$2\" >> $tmp/paged"
  mk "$tmp/ps-quiet.sh"     'printf "%s\n" "/sbin/init" "/usr/sbin/cron -f" "node dist/index.js"'
  mk "$tmp/ps-nsk.sh"       'printf "%s\n" "/sbin/init" "node dist/scripts/danger-job.js --go"'
  mk "$tmp/ps-pac.sh"       'printf "%s\n" "/sbin/init" "node dist/scripts/resumable-job.js"'
  mk "$tmp/ps-deploy.sh"    'printf "%s\n" "/sbin/init" "bash -c cd /opt/crypto-quant-signal-mcp && docker compose up -d --build --force-recreate"'
  mk "$tmp/ps-empty.sh"     'exit 0'
  # The check-then-act window: quiet on the in_flight snapshot, a job live by the recheck snapshot.
  mk "$tmp/ps-late.sh"      "n=\$(cat $tmp/ps-n 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > $tmp/ps-n; if [ \$n -ge 2 ]; then printf '%s\\n' /sbin/init 'node dist/scripts/danger-job.js --go'; else printf '%s\\n' /sbin/init; fi"
  mk "$tmp/ps-late-blind.sh" "n=\$(cat $tmp/ps-n 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > $tmp/ps-n; [ \$n -ge 2 ] || printf '%s\\n' /sbin/init"
  # The W5 R0.3 artifact: the probe's OWN command line in the process table, carrying the
  # signature text verbatim. Built FROM the declared signatures, so whatever they say is in it.
  mk "$tmp/ps-self.sh"      "printf '%s\n' '/sbin/init' \"bash -c probe \$(printf '%s ' \$(bash \"$0\" --print-deploy-signatures signal-1))\""
  mk "$tmp/curl-200.sh"     'echo 200'
  mk "$tmp/curl-502.sh"     'echo 502'
  mk "$tmp/pop-pass.sh"     'echo "CRON_INTERLOCK_COVERAGE_VERDICT=PASS"'
  mk "$tmp/pop-fail.sh"     'echo "  ✗ live crontab line has no reboot classification: 9 9 * * * /opt/new.sh"; echo "CRON_INTERLOCK_COVERAGE_VERDICT=FAIL"'
  mk "$tmp/pop-junk.sh"     'echo "node crashed"'
  mk "$tmp/crontab-ok.sh"   'echo "17 3 * * * /opt/x.sh"'
  mk "$tmp/systemctl-ok.sh" 'echo "cron.service"'
  printf 'aoe-1\n' > "$tmp/id-aoe"; printf 'signal-1\n' > "$tmp/id-signal"; printf 'mars-1\n' > "$tmp/id-mars"
  mkdir -p "$tmp/peerdir"

  reg() { printf '{"schema_version":2,"rows":[%s]}\n' "$2" > "$1"; }
  local A_SAFE='{"id":"aoe-containers","host":"aoe-1","events":["reboot"],"class":"safe-to-kill","reason":"unless-stopped","process_pattern":"n/a"}'
  local A_NSK='{"id":"aoe-danger","host":"aoe-1","events":["reboot"],"class":"no-safe-kill","reason":"stated","process_pattern":"dist/scripts/danger-job"}'
  local S_SAFE='{"id":"seed","host":"signal-1","events":["deploy","reboot"],"class":"safe-to-kill","reason":"idempotent","process_pattern":"dist/scripts/seed"}'
  local S_NSK='{"id":"s-danger","host":"signal-1","events":["reboot"],"class":"no-safe-kill","reason":"stated","process_pattern":"dist/scripts/danger-job"}'
  local S_PAC='{"id":"s-resumable","host":"signal-1","events":["deploy","reboot"],"class":"preempt-and-catchup","reason":"stated","process_pattern":"dist/scripts/resumable-job"}'
  local S_PAC_REC='{"id":"s-resumable","host":"signal-1","events":["deploy","reboot"],"class":"preempt-and-catchup","reason":"stated","process_pattern":"dist/scripts/resumable-job","reboot_recovery":"measured: resumes from DB state on its next nightly fire"}'
  local S_DEPLOYONLY='{"id":"deploy-only","host":"signal-1","events":["deploy"],"class":"safe-to-kill","reason":"stated","process_pattern":"x"}'
  local A_NOREASON='{"id":"bad","host":"aoe-1","events":["reboot"],"class":"safe-to-kill","reason":"  ","process_pattern":"p"}'
  reg "$tmp/reg-a.json"        "$A_SAFE"
  reg "$tmp/reg-a-nsk.json"    "$A_SAFE,$A_NSK"
  reg "$tmp/reg-a-noreason.json" "$A_NOREASON"
  reg "$tmp/reg-foreign.json"  "$S_SAFE"
  reg "$tmp/reg-s.json"        "$S_SAFE"
  reg "$tmp/reg-s-nsk.json"    "$S_SAFE,$S_NSK"
  reg "$tmp/reg-s-pac.json"    "$S_SAFE,$S_PAC"
  reg "$tmp/reg-s-pacrec.json" "$S_SAFE,$S_PAC_REC"
  reg "$tmp/reg-s-deployonly.json" "$S_SAFE,$S_DEPLOYONLY"
  printf 'not json\n' > "$tmp/reg-broken.json"

  # The all-gates-green baseline per host, so each case differs from it in ONE variable.
  # Positional overrides are passed as VAR=value words through `env`, so every case reads alike.
  run_as() { # run_as <host-id-file> <mode> [VAR=value ...]
    local idf="$1" mode="$2"; shift 2
    env MONITORING_HOST_LABELS= AUTO_REBOOT_IDENTITY_FILE="$idf" AUTO_REBOOT_STALENESS="$tmp/stale-breach.sh" \
      AUTO_REBOOT_BOOT_CONTRACT="$tmp/bc-ok.sh" AUTO_REBOOT_WRAPPER="$tmp/send-log.sh" \
      AUTO_REBOOT_REBOOT_CMD="$tmp/reboot-log.sh" AUTO_REBOOT_ARM_CMD="$tmp/arm-ok.sh" \
      AUTO_REBOOT_PS="$tmp/ps-quiet.sh" AUTO_REBOOT_CURL="$tmp/curl-200.sh" \
      AUTO_REBOOT_LOG="$LOG" AUTO_REBOOT_REQUIRED_FILE="$REBOOT_REQUIRED" \
      AUTO_REBOOT_RESULT_LOG_DIR="$RESULT_LOG_DIR" CANARY_RESULT_LOG_PATH="$CANARY_RESULT_LOG_PATH" \
      AUTO_REBOOT_PEER_ARM_MARKER="$tmp/peerdir/marker" AUTO_REBOOT_NOW_HOUR=05 \
      AUTO_REBOOT_NODE=bash \
      AUTO_REBOOT_CRONTAB="$tmp/crontab-ok.sh" AUTO_REBOOT_SYSTEMCTL="$tmp/systemctl-ok.sh" \
      "$@" bash "$0" "--$mode" 2>/dev/null
  }
  # Defaults come BEFORE "$@" so a case's own VAR=value wins (env applies the LAST assignment).
  aoe()  { local m="$1"; shift; run_as "$tmp/id-aoe" "$m" AUTO_REBOOT_STATE="$STATE_A" AUTO_REBOOT_REGISTRY="$tmp/reg-a.json" "$@"; }
  sig()  { local m="$1"; shift; run_as "$tmp/id-signal" "$m" AUTO_REBOOT_STATE="$STATE_S" AUTO_REBOOT_REGISTRY="$tmp/reg-s.json" AUTO_REBOOT_POPULATION_GATE="$tmp/pop-pass.sh" "$@"; }
  tok()  { tail -1; }
  reset() { rm -f "$STATE_A" "$STATE_S" "$tmp/rebooted" "$tmp/armed" "$tmp/paged" "$tmp/peer-marker" "$tmp/peerdir/marker" "$CANARY_RESULT_LOG_PATH" "$tmp/ps-n"; }

  echo "kernel-auto-reboot --self-test"

  # ── THE ALLOW-LIST. An UNLISTED host refuses, with zero side effects. ───────────────────
  reset
  ck "an UNLISTED label REFUSES" "$(run_as "$tmp/id-mars" apply AUTO_REBOOT_REGISTRY="$tmp/reg-a.json" | tok)" "AUTO_REBOOT_VERDICT=REFUSED"
  ck "…it never reboots, never arms" "$([ -f "$tmp/rebooted" ] || [ -f "$tmp/armed" ] && echo touched || echo clean)" "clean"
  ck "…and it never evaluates DUE (every later gate is NOT_REACHED)" \
     "$(run_as "$tmp/id-mars" apply | grep -c 'AUTO_REBOOT_GATE=due state=NOT_REACHED')" "1"
  ck "…and the refusal PAGES" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "2"
  ck "an UNRESOLVABLE identity REFUSES — never a default" \
     "$(run_as /nonexistent apply | tok)" "AUTO_REBOOT_VERDICT=REFUSED"
  ck "the allow-list is aoe-1 + signal-1, as a CONSTANT (no env can widen it)" \
     "$(AUTO_REBOOT_ALLOWED_HOSTS=mars-1 ALLOWED_HOSTS=mars-1 bash "$0" --print-allowed-hosts)" "aoe-1 signal-1"
  ck "…and host_policy has no default branch value for an unlisted host" "$(host_policy mars-1 peer >/dev/null 2>&1 && echo yes || echo no)" "no"

  # ── --dry-run IS THE DEFAULT ────────────────────────────────────────────────────────────
  reset
  ck "aoe-1 all gates green + dry-run does NOT reboot" "$(aoe dry-run | tok)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…and it says so positively" "$(aoe dry-run | grep -c 'AUTO_REBOOT_GATE=action state=DRY_RUN')" "1"
  ck "…and nothing rebooted, nothing armed" "$([ -f "$tmp/rebooted" ] || [ -f "$tmp/armed" ] && echo touched || echo clean)" "clean"
  ck "the CLI DEFAULT with no flag is dry-run" "$(bash "$0" --print-default-mode)" "dry-run"
  rm -f "$tmp/rebooted-noarg"
  MONITORING_HOST_LABELS= AUTO_REBOOT_LOG="$LOG" AUTO_REBOOT_STATE="$tmp/state-noarg" AUTO_REBOOT_REQUIRED_FILE="$tmp/rr-noarg" \
    AUTO_REBOOT_IDENTITY_FILE="$tmp/id-aoe" AUTO_REBOOT_STALENESS="$tmp/stale-breach.sh" AUTO_REBOOT_BOOT_CONTRACT="$tmp/bc-ok.sh" \
    AUTO_REBOOT_REGISTRY="$tmp/reg-a.json" AUTO_REBOOT_WRAPPER="$tmp/send-log.sh" AUTO_REBOOT_PS="$tmp/ps-quiet.sh" \
    AUTO_REBOOT_ARM_CMD="$tmp/arm-ok.sh" AUTO_REBOOT_PEER_ARM_MARKER="$tmp/peerdir/marker" AUTO_REBOOT_RESULT_LOG_DIR="$RESULT_LOG_DIR" \
    AUTO_REBOOT_REBOOT_CMD="$tmp/reboot-noarg.sh" bash "$0" >/dev/null 2>&1
  ck "…and a NO-ARGUMENT child process really does not reboot" "$([ -f "$tmp/rebooted-noarg" ] && echo yes || echo no)" "no"

  # ── aoe-1 --apply, unchanged from W1 ────────────────────────────────────────────────────
  reset
  ck "aoe-1 all gates green + --apply DOES reboot" "$(aoe apply | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  ck "…it invoked the reboot command" "$(grep -c rebooted "$tmp/rebooted" 2>/dev/null)" "1"
  ck "…it ARMED the peer watchdog before rebooting" "$(grep -c -- '--arm' "$tmp/armed" 2>/dev/null)" "1"
  ck "…and left a pending marker for the post-boot assertion" "$([ -f "$STATE_A" ] && echo yes || echo no)" "yes"
  reset
  ck "aoe-1 arm FAILURE -> DEGRADED and it STILL reboots (unchanged policy)" "$(aoe apply AUTO_REBOOT_ARM_CMD="$tmp/arm-fail.sh" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  rm -f "$STATE_A"
  ck "…and the arm gate says DEGRADED — read from the TOKEN, not the exit code" \
     "$(aoe apply AUTO_REBOOT_ARM_CMD="$tmp/arm-fail.sh" | grep -c 'AUTO_REBOOT_GATE=arm state=DEGRADED')" "1"

  # ── signal-1 --apply and its stricter policy ────────────────────────────────────────────
  reset
  ck "signal-1 all gates green + --apply DOES reboot" "$(sig apply | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  ck "…and armed its peer first" "$(grep -c -- '--arm' "$tmp/armed" 2>/dev/null)" "1"
  reset
  ck "signal-1 arm FAILURE -> DEFERRED (never reboot the revenue host unwatched)" "$(sig apply AUTO_REBOOT_ARM_CMD="$tmp/arm-fail.sh" | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  ck "…and it did NOT reboot" "$([ -f "$tmp/rebooted" ] && echo yes || echo no)" "no"
  ck "…and it left NO pending marker (a deferral must not read as a reboot next run)" "$([ -f "$STATE_S" ] && echo yes || echo no)" "no"
  ck "…and a deferral is SILENT" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"

  # ── WINDOW (signal-1: 03:00-13:59Z) ─────────────────────────────────────────────────────
  for pair in "02:NOT_DUE" "03:REBOOTED" "13:REBOOTED" "14:NOT_DUE"; do
    reset
    ck "signal-1 at ${pair%%:*}:xxZ -> ${pair##*:}" "$(sig apply AUTO_REBOOT_NOW_HOUR="${pair%%:*}" | tok)" "AUTO_REBOOT_VERDICT=${pair##*:}"
  done
  reset
  ck "…outside the window is SILENT and touches nothing" \
     "$(sig apply AUTO_REBOOT_NOW_HOUR=20 >/dev/null; [ -f "$tmp/paged" ] || [ -f "$tmp/armed" ] || [ -f "$tmp/rebooted" ] && echo touched || echo clean)" "clean"
  ck "aoe-1 is any-hour: 20:xxZ still reboots" "$(aoe apply AUTO_REBOOT_NOW_HOUR=20 | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"

  # ── PEER_BUSY ───────────────────────────────────────────────────────────────────────────
  reset; echo armed > "$tmp/peerdir/marker"
  ck "a peer arm present LOCALLY -> DEFERRED" "$(sig apply | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  ck "…with NO arm call and NO reboot" "$([ -f "$tmp/armed" ] || [ -f "$tmp/rebooted" ] && echo touched || echo clean)" "clean"
  rm -f "$tmp/peerdir/marker"
  ck "an UNREADABLE peer-marker directory -> DEFERRED (unknown is not free)" \
     "$(sig apply AUTO_REBOOT_PEER_ARM_MARKER=/nonexistent-dir/marker | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"

  # ── MUTUAL EXCLUSION, both orders, through ONE shared marker per direction ──────────────
  # aoe-1 reboots and arms signal-1's watch: its marker lands where signal-1's harness reads.
  reset
  ck "ORDER 1 — aoe-1 reboots and arms" "$(aoe apply ARM_MARKER_FILE="$tmp/peerdir/aoe-arm" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  ck "…signal-1's next run DEFERS on that marker" "$(sig apply AUTO_REBOOT_PEER_ARM_MARKER="$tmp/peerdir/aoe-arm" | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  printf 'some-older-kernel\n' > "$STATE_A"
  ck "…aoe-1's post-boot run disarms" "$(aoe apply ARM_MARKER_FILE="$tmp/peerdir/aoe-arm" AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | tok)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…and signal-1 then proceeds" "$(sig apply AUTO_REBOOT_PEER_ARM_MARKER="$tmp/peerdir/aoe-arm" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  reset
  ck "ORDER 2 — signal-1 reboots and arms" "$(sig apply ARM_MARKER_FILE="$tmp/peerdir/s1-arm" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  ck "…aoe-1's next run DEFERS on that marker" "$(aoe apply AUTO_REBOOT_PEER_ARM_MARKER="$tmp/peerdir/s1-arm" | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  printf 'some-older-kernel\n' > "$STATE_S"
  ck "…signal-1's post-boot run disarms" "$(sig apply ARM_MARKER_FILE="$tmp/peerdir/s1-arm" AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | tok)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…and aoe-1 then proceeds" "$(aoe apply AUTO_REBOOT_PEER_ARM_MARKER="$tmp/peerdir/s1-arm" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"

  # ── DEPLOY_IN_FLIGHT ────────────────────────────────────────────────────────────────────
  reset
  ck "a live cqsm deploy signature -> DEFERRED" "$(sig apply AUTO_REBOOT_PS="$tmp/ps-deploy.sh" | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  ck "…naming the gate" "$(sig apply AUTO_REBOOT_PS="$tmp/ps-deploy.sh" | grep -c 'AUTO_REBOOT_GATE=deploy_in_flight state=DEFERRED')" "1"
  reset
  ck "the probe's OWN command line (signature text in an argv) is NOT a deploy — bracketed" \
     "$(sig apply AUTO_REBOOT_PS="$tmp/ps-self.sh" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  reset
  ck "an empty process table is INDETERMINATE, never 'nothing is running'" "$(sig apply AUTO_REBOOT_PS="$tmp/ps-empty.sh" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "aoe-1 declares no deploy signature and says so positively" "$(aoe dry-run | grep -c 'AUTO_REBOOT_GATE=deploy_in_flight state=PASS 0 declared')" "1"

  # ── IN_FLIGHT — the REBOOT scope ────────────────────────────────────────────────────────
  reset
  ck "a REBOOT-scope no-safe-kill row in flight -> ABORTED (retry next run)" \
     "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-nsk.json" AUTO_REBOOT_PS="$tmp/ps-nsk.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…and an in-flight abort never reboots and never pages (it is transient)" \
     "$([ -f "$tmp/rebooted" ] || [ -f "$tmp/paged" ] && echo touched || echo clean)" "clean"
  reset
  ck "the SAME row NOT in flight proceeds — the abort is the probe, not the row" \
     "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-nsk.json" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  reset
  ck "a preempt-and-catchup row in flight with NO reboot recovery -> DEFERRED" \
     "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-pac.json" AUTO_REBOOT_PS="$tmp/ps-pac.sh" | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  reset
  ck "…the same row WITH a recorded reboot recovery proceeds" \
     "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-pacrec.json" AUTO_REBOOT_PS="$tmp/ps-pac.sh" | tok)" "AUTO_REBOOT_VERDICT=REBOOTED"
  # ── RECHECK — the check-then-act window ──────────────────────────────────────────────────
  reset
  ck "a no-safe-kill job that starts AFTER the in_flight probe -> ABORTED at recheck" \
     "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-nsk.json" AUTO_REBOOT_PS="$tmp/ps-late.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…in_flight itself PASSED (it was the recheck that caught it)" \
     "$(rm -f "$tmp/ps-n"; sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-nsk.json" AUTO_REBOOT_PS="$tmp/ps-late.sh" | grep -c -e 'AUTO_REBOOT_GATE=in_flight state=PASS' -e 'AUTO_REBOOT_GATE=recheck state=ABORT .*s-danger')" "2"
  ck "…the arm was withdrawn (armed, then disarmed)" "$(grep -c -e '^--arm' -e '^--disarm' "$tmp/armed" 2>/dev/null)" "4"
  ck "…no reboot was issued" "$([ -f "$tmp/rebooted" ] && echo yes || echo no)" "no"
  ck "…and no pending-reboot state was written" "$([ -f "$STATE_S" ] && echo yes || echo no)" "no"
  reset
  ck "a process table that goes UNREADABLE at recheck aborts too" \
     "$(sig apply AUTO_REBOOT_PS="$tmp/ps-late-blind.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  reset
  ck "a quiet recheck PASSES positively on the way to the reboot" \
     "$(sig apply | grep -c 'AUTO_REBOOT_GATE=recheck state=PASS re-probed')" "1"
  reset
  ck "a row on this host with NO reboot classification -> INDETERMINATE (+ page)" \
     "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-s-deployonly.json" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "…and THAT pages" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "1"
  ck "an UNREADABLE registry is INDETERMINATE" "$(sig apply AUTO_REBOOT_REGISTRY="$tmp/reg-broken.json" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "a registry with only ANOTHER host's rows is INDETERMINATE" "$(aoe apply AUTO_REBOOT_REGISTRY="$tmp/reg-foreign.json" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "an EMPTY reason is INDETERMINATE" "$(aoe apply AUTO_REBOOT_REGISTRY="$tmp/reg-a-noreason.json" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  reset
  ck "aoe-1's no-safe-kill row in flight aborts too (W1 behaviour)" \
     "$(aoe apply AUTO_REBOOT_REGISTRY="$tmp/reg-a-nsk.json" AUTO_REBOOT_PS="$tmp/ps-nsk.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  reset
  ck "a live-population FAIL (an unclassified cron line) -> DEFERRED, silent" \
     "$(sig apply AUTO_REBOOT_POPULATION_GATE="$tmp/pop-fail.sh" | tok)" "AUTO_REBOOT_VERDICT=DEFERRED"
  ck "…naming the unclassified line in the gate output" \
     "$(sig apply AUTO_REBOOT_POPULATION_GATE="$tmp/pop-fail.sh" | grep -c 'AUTO_REBOOT_GATE=in_flight state=DEFERRED .*/opt/new.sh')" "1"
  ck "…and silent" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  reset
  ck "a population check that emits NO token -> INDETERMINATE (+ page)" \
     "$(sig apply AUTO_REBOOT_POPULATION_GATE="$tmp/pop-junk.sh" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "a population gate that is not there -> INDETERMINATE" \
     "$(sig apply AUTO_REBOOT_POPULATION_GATE=/nonexistent/gate.mjs | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  ck "aoe-1 declares no population gate and still decides" "$(aoe dry-run | tok)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "bracketed_ere escapes ERE metacharacters and brackets the last alnum" \
     "$(bracketed_ere 'VACUUM (ANALYZE) oi_snapshots')" 'VACUUM \(ANALYZE\) oi_snapshot[s]'
  ck "…and a bracketed pattern matches its literal" "$([[ 'psql -c VACUUM (ANALYZE) oi_snapshots' =~ $(bracketed_ere 'VACUUM (ANALYZE) oi_snapshots') ]] && echo yes || echo no)" "yes"
  ck "…but not its own bracketed text" "$([[ "$(bracketed_ere 'dist/scripts/x')" =~ $(bracketed_ere 'dist/scripts/x') ]] && echo yes || echo no)" "no"

  # ── DUE, CONTRACT ───────────────────────────────────────────────────────────────────────
  reset
  ck "staleness OK -> NOT_DUE, silent" "$(sig apply AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | tok)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  ck "…silent" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  ck "an unreadable staleness verdict is INDETERMINATE (+ page)" "$(aoe apply AUTO_REBOOT_STALENESS="$tmp/stale-junk.sh" | tok)" "AUTO_REBOOT_VERDICT=INDETERMINATE"
  reset
  ck "boot-contract DRIFT -> ABORTED (+ page)" "$(sig apply AUTO_REBOOT_BOOT_CONTRACT="$tmp/bc-drift.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…pages" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "1"

  # ── POST-BOOT ───────────────────────────────────────────────────────────────────────────
  reset; printf '%s\n' "$(uname -r)" > "$STATE_A"
  ck "a post-boot run whose kernel did NOT advance is ABORTED" "$(aoe dry-run AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…and it DISARMED even on the failure path" "$(grep -c -- '--disarm' "$tmp/armed" 2>/dev/null)" "1"
  ck "…and the marker is consumed" "$([ -f "$STATE_A" ] && echo yes || echo no)" "no"
  reset; printf 'some-older-kernel\n' > "$STATE_S"
  ck "signal-1 post-boot with the serving probe at 200 passes" "$(sig dry-run AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | tok)" "AUTO_REBOOT_VERDICT=NOT_DUE"
  reset; printf 'some-older-kernel\n' > "$STATE_S"
  ck "signal-1 post-boot with the serving probe at 502 is ABORTED (+ page)" "$(sig dry-run AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" AUTO_REBOOT_CURL="$tmp/curl-502.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  ck "…pages" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT' "$tmp/paged" 2>/dev/null)" "1"
  reset; printf 'some-older-kernel\n' > "$STATE_A"
  ck "aoe-1 post-boot prints a POSITIVE serving SKIP (no probe declared)" "$(aoe dry-run AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | grep -c 'serving=SKIP (no probe declared for aoe-1)')" "1"
  reset; printf 'some-older-kernel\n' > "$STATE_A"; : > "$REBOOT_REQUIRED"
  ck "reboot-required STILL present after our reboot is ABORTED" "$(aoe dry-run AUTO_REBOOT_STALENESS="$tmp/stale-ok.sh" | tok)" "AUTO_REBOOT_VERDICT=ABORTED"
  rm -f "$REBOOT_REQUIRED"

  # ── THE OFF-HOST RECORD — one per run, on EVERY path, carrying the RESOLVED host ────────
  reset
  local paths="" before after
  for spec in "aoe:apply:" "sig:apply:AUTO_REBOOT_NOW_HOUR=20" "sig:apply:AUTO_REBOOT_ARM_CMD=$tmp/arm-fail.sh" \
              "sig:apply:AUTO_REBOOT_PS=$tmp/ps-deploy.sh" "sig:apply:AUTO_REBOOT_STALENESS=$tmp/stale-ok.sh" \
              "sig:apply:AUTO_REBOOT_BOOT_CONTRACT=$tmp/bc-drift.sh" "sig:apply:AUTO_REBOOT_REGISTRY=$tmp/reg-broken.json"; do
    before=$( { wc -l < "$CANARY_RESULT_LOG_PATH"; } 2>/dev/null || echo 0)
    if [ -n "${spec#*:*:}" ]; then "${spec%%:*}" "$(printf '%s' "$spec" | cut -d: -f2)" "${spec#*:*:}" >/dev/null
    else "${spec%%:*}" "$(printf '%s' "$spec" | cut -d: -f2)" >/dev/null; fi
    after=$( { wc -l < "$CANARY_RESULT_LOG_PATH"; } 2>/dev/null || echo 0)
    paths="$paths$((after - before))"; rm -f "$STATE_A" "$STATE_S" "$tmp/peerdir/marker"
  done
  run_as "$tmp/id-mars" apply >/dev/null; paths="${paths}$(( $(wc -l < "$CANARY_RESULT_LOG_PATH") - after ))"
  ck "exactly ONE record per run across 8 distinct paths (REBOOTED, window, arm, deploy, due, contract, registry, REFUSED)" "$paths" "11111111"
  ck "aoe-1's record says aoe-1 (never canary_result_log's signal-1 default)" "$(grep -c '"host": "aoe-1"' "$CANARY_RESULT_LOG_PATH")" "1"
  ck "the record names the deciding gate" "$(grep -c '"decided_by": "deploy_in_flight"' "$CANARY_RESULT_LOG_PATH")" "1"

  # ── one token per path; unwritable log; exit 0 ──────────────────────────────────────────
  reset
  ck "exactly ONE terminal token per run" "$(sig dry-run | grep -c '^AUTO_REBOOT_VERDICT=')" "1"
  ck "EVERY gate prints exactly once on a full path (11 gates)" "$(sig dry-run | grep -c '^AUTO_REBOOT_GATE=')" "11"
  ck "…and on an early exit too (the unreached are NOT_REACHED)" "$(sig apply AUTO_REBOOT_NOW_HOUR=20 | grep -c '^AUTO_REBOOT_GATE=')" "11"
  ck "each gate prints once even with an unwritable log" "$(sig dry-run AUTO_REBOOT_LOG=/nonexistent/dir/x.log | grep -c 'AUTO_REBOOT_GATE=identity')" "1"
  ck "the live path ALWAYS exits 0" "$(sig apply AUTO_REBOOT_STALENESS="$tmp/stale-junk.sh" AUTO_REBOOT_REGISTRY=/nonexistent >/dev/null 2>&1; echo $?)" "0"

  # ── THE PAGE BODY ───────────────────────────────────────────────────────────────────────
  reset
  sig apply AUTO_REBOOT_BOOT_CONTRACT="$tmp/bc-drift.sh" >/dev/null
  ck "the page names the alert id" "$(grep -c '🛑 KERNEL_AUTO_REBOOT — signal-1 unattended kernel reboot did not proceed' "$tmp/paged")" "1"
  ck "…derives host AND peer" "$(grep -c 'Host: signal-1 · peer: aoe-1' "$tmp/paged")" "1"
  ck "…carries a TEMPLATED wave" "$(grep -c 'Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT}' "$tmp/paged")" "1"
  ck "…is invoked as <alert_id> CRITICAL_PERSISTENT -" "$(grep -c 'ALERT=KERNEL_AUTO_REBOOT SEV=CRITICAL_PERSISTENT' "$tmp/paged")" "1"

  # ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────
  ck "SEAM — the REAL reboot command" "$REAL_REBOOT" "/sbin/reboot"
  ck "SEAM — the REAL process-table probe" "$REAL_PS" "ps"
  ck "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label"
  ck "SEAM — the REAL staleness canary" "$REAL_STALE" "/opt/algovault-monitoring/kernel-staleness-canary.sh"
  ck "SEAM — the REAL boot-contract canary" "$REAL_BC" "/opt/algovault-monitoring/boot-contract-canary.sh"
  ck "SEAM — the REAL alert wrapper" "$REAL_SEND" "/opt/algovault-monitoring/send_telegram.sh"
  ck "SEAM — the REAL arm helper" "$REAL_ARM" "/opt/algovault-monitoring/arm-peer-watchdog.sh"
  ck "SEAM — the REAL result-log dir" "$REAL_RLD" "/opt/algovault-monitoring"
  ck "POLICY — aoe-1 reads the SYNCED registry copy" "$(host_policy aoe-1 registry)" "/opt/algovault-monitoring/cron-interlock-registry.json"
  ck "POLICY — signal-1 reads the CHECKOUT registry the deploy interlock reads" "$(host_policy signal-1 registry)" "/opt/crypto-quant-signal-mcp/ops/scripts/cron-interlock-registry.json"
  ck "POLICY — signal-1's window is 03-13 (PR-1)" "$(host_policy signal-1 window)" "03-13"
  ck "POLICY — signal-1 DEFERS on arm failure (PR-3); aoe-1 is DEGRADED" "$(host_policy signal-1 arm_failure)/$(host_policy aoe-1 arm_failure)" "DEFERRED/DEGRADED"
  ck "POLICY — the arm markers each host reads are the ones its PEER's arm helper writes" \
     "$(host_policy signal-1 peer_arm_marker)|$(host_policy aoe-1 peer_arm_marker)" \
     "/var/lib/algovault-monitoring/.aoe-reboot-arm|/var/lib/algovault-monitoring/.signal1-reboot-arm"
  ck "POLICY — every deploy signature is BRACKETED" \
     "$(host_policy signal-1 deploy_signatures | grep -vc '\[')" "0"

  unset CANARY_RESULT_LOG_PATH
  rm -rf "$tmp"
  if [ "$n" -lt 112 ]; then
    echo "SELF-TEST: only $n assertions ran (expected >= 112) — a shrinking suite is a defect"
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
  --print-allowed-hosts) printf '%s\n' "$ALLOWED_HOSTS" ;;
  --print-deploy-signatures) host_policy "${2:-}" deploy_signatures ;;
  --print-default-mode)  printf '%s\n' "${DEFAULT_ARG#--}" ;;
  *) echo "usage: $0 [--dry-run|--apply|--self-test|--print-allowed-hosts|--print-deploy-signatures <host>|--print-default-mode]" >&2; exit 2 ;;
esac
