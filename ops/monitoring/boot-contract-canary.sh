#!/usr/bin/env bash
# boot-contract-canary.sh — does THIS HOST still match the declared boot-survival contract?
#
# OPS-HOST-KERNEL-REBOOT-W3 / CH1.
#
# ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────────────────────
# `scripts/check-boot-readiness.mjs` verifies that the contract in
# `scripts/data/boot-critical-units.json` is internally COHERENT. It is a build-time gate, it runs
# in CI, and its own header says so: "Nothing above verifies that the hosts actually MATCH the
# contract. A `systemctl disable caddy` would pass every check in this file until the next reboot
# took the site down." Measured 2026-08-15 and re-confirmed 2026-08-27: there is no scheduled run
# of that gate on any box, and the script is not present on aoe-1 at all.
#
# Meanwhile the KERNEL_STALENESS alert body told the operator that "boot survival is asserted
# continuously by scripts/check-boot-readiness.mjs". That sentence was false for as long as it
# existed. THIS file is what makes it true; CH3 rewrites the sentence to name it.
#
# ── WHY IT READS A PROJECTION AND NOT THE SoT ────────────────────────────────────────────────
# The SoT lives at `scripts/data/`, which `declaration-sync.sh` structurally cannot reach (its
# BASE_URL is pinned to `.../main/ops/monitoring` and its entries are basenames used for both the
# fetch URL and the destination filename), and aoe-1 has no checkout of this repo at all. So
# `scripts/check-boot-contract-parity.mjs` projects the contract into
# `ops/monitoring/boot-contract.json` — one derivation, byte-asserted at build time — and the
# ordinary declaration-sync path carries it to both hosts. There is still exactly ONE authored
# copy of the fact.
#
# ── WHY EFFECTIVE ENABLEMENT, NEVER A RAW is-active DIFF ─────────────────────────────────────
# A naive check is WRONG on units whose "fix" would be a real misconfiguration: `ssh.service`
# reports `disabled` because Ubuntu 24.04 socket-activates it, and every `*.timer`-driven service
# reports `disabled` by design. W2's ad-hoc differ also flagged `polkit.service` — `static`,
# D-Bus-activated, no WantedBy, no TriggeredBy — as a casualty on both hosts, and was wrong. The
# committed contract declares HOW each unit is legitimately activated, and this asserts THAT.
#
# ── PORTABILITY, MEASURED ────────────────────────────────────────────────────────────────────
# `jq` is present on signal-1 (1.7) and ABSENT on aoe-1. `python3` is 3.12.3 on BOTH. So the
# contract is parsed with python3. A jq-based canary would have been dark on exactly one host —
# the "installed is not working" failure this repo has now hit five times.
#
# ── ALERT CONTRACT ───────────────────────────────────────────────────────────────────────────
# send_telegram.sh OWNS the severity gate, the 24h-per-alert_id cooldown, the recommended_wave
# {NEXT} resolver and the INERT/DRY_RUN gates. Never re-implement them here. `CRITICAL_PERSISTENT`
# is the only severity that fires; anything else is SUPPRESSED_SEVERITY. For a REPEATED smoke use
# ALGOVAULT_TG_TEST_INERT=1 (suppresses BEFORE the cooldown gate, writes NO marker) — never
# DRY_RUN_TG=1, which DOES write the marker so back-to-back dry runs false-green.
#
# BOTH DRIFT and INDETERMINATE fire, under one alert_id so the 24h cooldown bounds them to one
# page a day. A host that cannot answer "do I still match the contract" is operator-action-
# required: a fail-open exit 0 on an unreadable input must never be indistinguishable from health.
#
# IDENTITY IS ASSERTED, NEVER ASSUMED, and resolution FAILS TOWARD REFUSAL — env
# MONITORING_HOST_LABELS, then /etc/algovault-host-label, then INDETERMINATE. This is
# declaration-sync.sh's order verbatim, not a new dialect: that script once ran unlabelled on
# aoe-1, adopted signal-1's identity and littered five foreign declarations there, twice. Note the
# related trap this avoids by construction — monitoring-inventory-reconcile.py DEFAULTS its labels
# to signal-1, so a bare run on aoe-1 asserts signal-1's identity. A whole host evaluated against
# the wrong declaration is worse than no answer, so there is no default here.
#
# FIRST CYCLE IS REPORT-ONLY. A naive first run on a host that has drifted for months would page
# as though it had just happened, which is why quota-exhaustion-canary bootstraps silently too.
# The state file's existence is the "I have observed this host before" marker.
#
# Exit: ALWAYS 0 on the live path (fail-open — a canary outage must not bounce cron). The VERDICT
# line is the truth; read the token, never the code. `--self-test` is the exception: 0 pass,
# 1 fail, 3 indeterminate.
#
# Usage:
#   boot-contract-canary.sh              # evaluate this host
#   boot-contract-canary.sh --self-test  # hermetic, vacuity-guarded, no /opt and no network
set -uo pipefail

ALERT_ID="BOOT_CONTRACT_DRIFT"
SEND="${BOOT_CONTRACT_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${BOOT_CONTRACT_LOG:-/var/log/boot-contract-canary.log}"
CONTRACT="${BOOT_CONTRACT_FILE:-/opt/algovault-monitoring/boot-contract.json}"
# /var/lib, NOT the monitoring dir: a file under /opt/algovault-monitoring with no inventory row
# is exactly what the reconciler's ORPHAN check exists to catch. declaration-sync.sh's heartbeat
# already established /var/lib/algovault-monitoring as the state home.
STATE="${BOOT_CONTRACT_STATE:-/var/lib/algovault-monitoring/boot-contract-seen}"
# Identity resolution reuses the estate's EXISTING primitive rather than inventing a fourth
# dialect for the same question. OPS-DECLARATION-SYNC-HOST-IDENTITY-W1 established the order and
# the reason: declaration-sync.sh once ran on aoe-1 with no label, silently adopted signal-1's
# identity, and littered five foreign declarations there twice. So: env, then the host's own
# opaque marker, then REFUSE. A peer host's label may NEVER be a fallback, in any form.
HOST_IDENTITY_FILE="${BOOT_CONTRACT_IDENTITY_FILE:-/etc/algovault-host-label}"
SYSTEMCTL="${BOOT_CONTRACT_SYSTEMCTL:-systemctl}"
DOCKER="${BOOT_CONTRACT_DOCKER:-docker}"
# Overridable ONLY so the self-test can drive the revisit-date arm; never set in production.
TODAY="${BOOT_CONTRACT_TODAY:-$(date -u +%Y-%m-%d)}"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*" | tee -a "$LOG" 2>/dev/null || true; }

# ── the contract parser ──────────────────────────────────────────────────────────────────────
# ONE python3 pass emits a flat tab-separated record stream, so the rest of this script is plain
# shell and the parse happens exactly once. Records:
#   HOST   <label>  <address>
#   META   <acceptable_restart_policies|-joined>  <pg_stop_budget>  <revisit_by>
#   UNIT   <label>  <unit>  <activation>  <via-or-empty>
#   CONT   <label>  <name>
# A parse failure prints nothing and exits non-zero: input we were HANDED and could not parse is
# INDETERMINATE, always — never a pass over zero rows.
parse_contract() {
  python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1], 'r', encoding='utf-8') as fh:
        c = json.load(fh)
except Exception as exc:
    print(f'parse error: {exc}', file=sys.stderr)
    sys.exit(1)
hosts = c.get('hosts')
if not isinstance(hosts, dict) or not hosts:
    print('contract has no non-empty `hosts` object', file=sys.stderr)
    sys.exit(1)
pol = c.get('acceptable_restart_policies')
if not isinstance(pol, list) or not pol:
    print('contract has no non-empty `acceptable_restart_policies`', file=sys.stderr)
    sys.exit(1)
budget = c.get('postgres_stop_budget_seconds_min')
if not isinstance(budget, (int, float)):
    print('contract has no numeric `postgres_stop_budget_seconds_min`', file=sys.stderr)
    sys.exit(1)
out = ['\t'.join(('META', '|'.join(str(p) for p in pol), str(int(budget)), str(c.get('revisit_by') or '')))]
for label in sorted(hosts):
    h = hosts[label] or {}
    out.append('\t'.join(('HOST', label, str(h.get('address') or ''))))
    for u in (h.get('units') or []):
        out.append('\t'.join(('UNIT', label, str(u.get('unit') or ''), str(u.get('activation') or ''), str(u.get('via') or ''))))
    for name in (h.get('containers') or []):
        out.append('\t'.join(('CONT', label, str(name))))
print('\n'.join(out))
PY
}

# ── pure decisions, extracted so the self-test can drive them with fixtures ───────────────────
# Each echoes: <OK|DRIFT|INDETERMINATE> <detail>

# Which unit actually CARRIES the enablement for a row.
carrier_for() { # <activation> <unit> <via>
  case "$1" in
    enabled) printf '%s' "$2" ;;
    socket|timer) printf '%s' "$3" ;;
    *) printf '' ;;
  esac
}

decide_unit() { # <activation> <unit> <via> <is-enabled-output> <probe-ok:0|1>
  local activation="$1" unit="$2" via="$3" state="$4" probe_ok="$5"
  local carrier; carrier="$(carrier_for "$activation" "$unit" "$via")"
  if [ -z "$carrier" ]; then
    echo "INDETERMINATE unit=$unit activation=$activation — no carrier (unknown activation kind, or socket/timer row with no \`via\`)"; return
  fi
  if [ "$probe_ok" != "0" ]; then
    echo "INDETERMINATE unit=$unit carrier=$carrier — could not query enablement"; return
  fi
  case "$state" in
    enabled|enabled-runtime) echo "OK unit=$unit activation=$activation carrier=$carrier is-enabled=$state" ;;
    *) echo "DRIFT unit=$unit activation=$activation carrier=$carrier is-enabled=${state:-<empty>} (expected enabled|enabled-runtime)" ;;
  esac
}

decide_container() { # <name> <policy> <acceptable-pipe-joined> <probe-ok:0|1>
  local name="$1" policy="$2" acceptable="$3" probe_ok="$4"
  if [ "$probe_ok" != "0" ]; then
    echo "DRIFT container=$name — declared but not present (docker inspect found no such object)"; return
  fi
  case "|$acceptable|" in
    *"|$policy|"*) echo "OK container=$name restart=$policy" ;;
    *) echo "DRIFT container=$name restart=${policy:-<empty>} (acceptable: ${acceptable//|/, })" ;;
  esac
}

decide_stop_budget() { # <name> <stop-timeout> <floor>
  local name="$1" timeout="$2" floor="$3"
  case "$timeout" in
    ''|*[!0-9]*) echo "INDETERMINATE container=$name stop_timeout=${timeout:-<nil>} — not a number, cannot compare to the ${floor}s floor"; return ;;
  esac
  if [ "$timeout" -ge "$floor" ]; then
    echo "OK container=$name stop_timeout=${timeout}s >= ${floor}s floor"
  else
    echo "DRIFT container=$name stop_timeout=${timeout}s < ${floor}s floor (a SIGKILL here means crash recovery at every reboot)"
  fi
}

# The contract SPECIFIES this behaviour: boot-critical-units.json's `_revisit_rationale` says
# "if the revisit date passes the canary reports INDETERMINATE rather than a confident pass".
decide_revisit() { # <today YYYY-MM-DD> <revisit_by YYYY-MM-DD>
  local today="$1" revisit="$2"
  if [ -z "$revisit" ]; then
    echo "INDETERMINATE revisit_by=<none> — the contract declares no revisit date"; return
  fi
  # Lexical compare is correct and total for zero-padded ISO dates.
  if [ "$today" \> "$revisit" ]; then
    echo "INDETERMINATE revisit_by=$revisit passed (today=$today) — the contract is out of its declared review window, so a pass would not be a confident one"
  else
    echo "OK revisit_by=$revisit not yet reached (today=$today)"
  fi
}

# Worst-wins: INDETERMINATE beats DRIFT beats OK. A host that could not be fully evaluated must
# never report the cleaner of the two verdicts.
worst() { # <current> <incoming>
  case "$1|$2" in
    INDETERMINATE*|*"|INDETERMINATE") printf 'INDETERMINATE' ;;
    DRIFT*|*"|DRIFT") printf 'DRIFT' ;;
    *) printf 'OK' ;;
  esac
}

# Extracted so the hermetic self-test can assert the resolution ORDER — a seam a suite replaces
# is otherwise the one thing it cannot see. Echoes the label, or empty when unresolved.
resolve_host_label() { # <env value> <identity file>
  if [ -n "${1:-}" ]; then printf '%s' "${1%%,*}"; return 0; fi
  [ -r "${2:-}" ] || return 0
  head -n1 "$2" 2>/dev/null | tr -d '[:space:]'
}

fire() { # <verdict> <label> <summary-block>
  local verdict="$1" hostlabel="$2" detail="$3"
  if [ ! -x "$SEND" ]; then
    log "FAIL_OPEN: wrapper not executable at $SEND — operator NOT notified"; return
  fi
  printf '%s\n' "$(cat <<EOF
Host <b>${hostlabel}</b> no longer provably matches its declared boot-survival contract.

verdict: ${verdict}

${detail}

The contract is scripts/data/boot-critical-units.json, projected to
${CONTRACT}. A unit that is running but not effectively enabled, or a
container without an acceptable restart policy, comes back only until the next reboot — and an
unplanned reboot (Hetzner maintenance, a panic, an OOM) is a discovery, not a test.

Action: restore effective enablement, or amend the contract if the change was intended.
recommended_wave: OPS-BOOT-CONTRACT-W{NEXT}
EOF
)" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--self-test" ]; then
  fails=(); checked=0
  ck() { # <label> <got> <want>
    checked=$((checked + 1))
    if [ "$2" = "$3" ]; then printf '  ✓ %s\n' "$1"; else printf '  ✗ %s — expected %s, got %s\n' "$1" "$3" "$2"; fails+=("$1"); fi
  }
  expect() { # <expected-verdict> <label> <command...>
    local want="$1" label="$2"; shift 2
    local got; got="$("$@")"
    checked=$((checked + 1))
    case "$got" in
      "$want"*) printf '  ✓ %s ⇒ %s\n' "$label" "$want" ;;
      *) printf '  ✗ %s ⇒ expected %s, got: %s\n' "$label" "$want" "$got"; fails+=("$label") ;;
    esac
  }

  echo "--- unit decisions (must-fire and must-not-fire) ---"
  expect OK            "enabled unit reporting enabled"          decide_unit enabled docker.service ''           enabled          0
  expect OK            "enabled-runtime counts as enabled"       decide_unit enabled docker.service ''           enabled-runtime  0
  expect OK            "socket row asserts the SOCKET"           decide_unit socket  ssh.service    ssh.socket   enabled          0
  expect OK            "timer row asserts the TIMER"             decide_unit timer   x.service      x.timer      enabled          0
  expect DRIFT         "a disabled carrier is DRIFT"             decide_unit enabled caddy.service  ''           disabled         0
  expect DRIFT         "a vanished unit is DRIFT, not unknown"   decide_unit enabled gone.service   ''           ''               0
  expect INDETERMINATE "socket row with no via"                  decide_unit socket  ssh.service    ''           enabled          0
  expect INDETERMINATE "activation kind with no carrier rule"    decide_unit static  polkit.service ''           enabled          0
  expect INDETERMINATE "probe could not run"                     decide_unit enabled docker.service ''           ''               1
  # The false positive W2's ad-hoc differ produced: ssh.service itself reads `disabled` by design.
  # Asserting the SERVICE instead of the SOCKET is the bug, and this pins that it does not happen.
  ck 'ssh row carries ssh.socket, never ssh.service' "$(carrier_for socket ssh.service ssh.socket)" 'ssh.socket'

  echo "--- container decisions ---"
  expect OK            "an acceptable policy"                    decide_container c1 unless-stopped 'always|unless-stopped' 0
  expect OK            "the other acceptable policy"             decide_container c1 always         'always|unless-stopped' 0
  expect DRIFT         "\`no\` is not acceptable"                decide_container c1 no             'always|unless-stopped' 0
  expect DRIFT         "a declared container that is absent"     decide_container c1 ''             'always|unless-stopped' 1
  # A substring match would accept "stopped" for "unless-stopped"; the |-delimited compare must not.
  expect DRIFT         "no substring match on the policy list"   decide_container c1 stopped        'always|unless-stopped' 0

  echo "--- postgres stop budget (read from the contract, never a literal) ---"
  expect OK            "120s clears a 30s floor"                 decide_stop_budget pg 120 30
  expect OK            "exactly at the floor"                    decide_stop_budget pg 30  30
  expect DRIFT         "below the floor"                         decide_stop_budget pg 10  30
  expect INDETERMINATE "docker's <nil> is not a number"          decide_stop_budget pg '<nil>' 30

  echo "--- revisit-date arm (behaviour the CONTRACT specifies) ---"
  expect OK            "before the revisit date"                 decide_revisit 2026-08-27 2027-02-28
  expect OK            "on the revisit date"                     decide_revisit 2027-02-28 2027-02-28
  expect INDETERMINATE "past the revisit date"                   decide_revisit 2027-03-01 2027-02-28
  expect INDETERMINATE "no revisit date declared"                decide_revisit 2026-08-27 ''

  echo "--- worst-wins aggregation ---"
  ck 'OK + OK            = OK'            "$(worst OK OK)"                       'OK'
  ck 'OK + DRIFT         = DRIFT'         "$(worst OK DRIFT)"                    'DRIFT'
  ck 'DRIFT + OK         = DRIFT'         "$(worst DRIFT OK)"                    'DRIFT'
  ck 'DRIFT + INDETERMIN = INDETERMINATE' "$(worst DRIFT INDETERMINATE)"         'INDETERMINATE'
  ck 'INDETERMIN + OK    = INDETERMINATE' "$(worst INDETERMINATE OK)"            'INDETERMINATE'

  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/boot-contract.XXXXXX")"
  trap 'rm -rf "$probe_dir"' EXIT   # BSD mktemp: XXXXXX must be TERMINAL, so -d plus fixed names inside

  echo "--- the PARSER, which every block above bypasses ---"
  # A hermetic suite is structurally blind to exactly what its own seam replaces. Here the seam
  # would be the python parse, so it is driven with a real file through the real function.
  cat > "$probe_dir/contract.json" <<'FIX'
{
  "revisit_by": "2027-02-28",
  "acceptable_restart_policies": ["always", "unless-stopped"],
  "postgres_stop_budget_seconds_min": 30,
  "hosts": {
    "signal-1": { "address": "10.0.0.1",
      "units": [{"unit":"ssh.service","activation":"socket","via":"ssh.socket"},{"unit":"docker.service","activation":"enabled"}],
      "containers": ["c1","c2"] },
    "aoe-1": { "address": "10.0.0.2", "units": [{"unit":"cron.service","activation":"enabled"}], "containers": [] }
  }
}
FIX
  parsed="$(parse_contract "$probe_dir/contract.json")"; parse_rc=$?
  ck 'a well-formed contract parses'          "$parse_rc" '0'
  ck '  hosts emitted in sorted order'        "$(echo "$parsed" | awk -F'\t' '$1=="HOST"{printf "%s,",$2}')" 'aoe-1,signal-1,'
  ck '  META carries policies|budget|revisit' "$(echo "$parsed" | awk -F'\t' '$1=="META"{print $2"/"$3"/"$4}')" 'always|unless-stopped/30/2027-02-28'
  ck '  a socket row keeps its via'           "$(echo "$parsed" | awk -F'\t' '$1=="UNIT" && $3=="ssh.service"{print $4"/"$5}')" 'socket/ssh.socket'
  ck '  an enabled row has an empty via'      "$(echo "$parsed" | awk -F'\t' '$1=="UNIT" && $3=="docker.service"{print $4"/"$5}')" 'enabled/'
  ck '  containers are emitted per host'      "$(echo "$parsed" | awk -F'\t' '$1=="CONT" && $2=="signal-1"{printf "%s,",$3}')" 'c1,c2,'
  printf '{"hosts":{' > "$probe_dir/truncated.json"
  parse_contract "$probe_dir/truncated.json" >/dev/null 2>&1
  ck 'a truncated contract REFUSES (never a pass over zero rows)' "$?" '1'
  printf '{"hosts":{},"acceptable_restart_policies":["always"],"postgres_stop_budget_seconds_min":30}' > "$probe_dir/nohosts.json"
  parse_contract "$probe_dir/nohosts.json" >/dev/null 2>&1
  ck 'an EMPTY hosts object REFUSES'          "$?" '1'
  printf '{"hosts":{"a":{"address":"1","units":[],"containers":[]}},"postgres_stop_budget_seconds_min":30}' > "$probe_dir/nopol.json"
  parse_contract "$probe_dir/nopol.json" >/dev/null 2>&1
  ck 'a missing restart-policy list REFUSES'  "$?" '1'

  echo "--- wrapper invocation (both hosts are healthy, so the fire path is otherwise unreachable) ---"
  cat > "$probe_dir/fake-send.sh" <<'PROBE'
#!/usr/bin/env bash
printf 'argv=%s|%s|%s\n' "$1" "$2" "$3" > "$CAPTURE"
cat >> "$CAPTURE"
PROBE
  chmod +x "$probe_dir/fake-send.sh"
  CAPTURE="$probe_dir/captured.txt" SEND="$probe_dir/fake-send.sh" \
    bash -c 'SEND="'"$probe_dir"'/fake-send.sh"; CAPTURE="'"$probe_dir"'/captured.txt"; export CAPTURE
             LOG=/dev/null; ALERT_ID=BOOT_CONTRACT_DRIFT; CONTRACT=/opt/algovault-monitoring/boot-contract.json
             '"$(declare -f fire log)"'
             fire DRIFT testhost "DRIFT unit=caddy.service carrier=caddy.service is-enabled=disabled"' >/dev/null 2>&1
  if [ ! -s "$probe_dir/captured.txt" ]; then
    checked=$((checked + 1)); printf '  ✗ the fire path did not invoke the wrapper at all\n'; fails+=("wrapper-invoked")
  else
    cap="$(cat "$probe_dir/captured.txt")"
    ck 'invoked as <alert_id> CRITICAL_PERSISTENT -' "$(printf '%s' "$cap" | head -1)" 'argv=BOOT_CONTRACT_DRIFT|CRITICAL_PERSISTENT|-'
    ck '  body names the host'                       "$(printf '%s' "$cap" | grep -c 'testhost')" '1'
    ck '  body carries the per-row detail'           "$(printf '%s' "$cap" | grep -c 'caddy.service')" '1'
    ck '  recommended_wave is TEMPLATED, not literal' "$(printf '%s' "$cap" | grep -c 'W{NEXT}')" '1'
    ck '  and carries no literal wave number'        "$(printf '%s' "$cap" | grep -cE 'OPS-BOOT-CONTRACT-W[0-9]')" '0'
  fi

  echo "--- identity resolution ORDER (the estate's primitive, not a new dialect) ---"
  idf="$probe_dir/host-label"; printf 'aoe-1\n' > "$idf"
  ck 'env wins over the marker file'              "$(resolve_host_label signal-1 "$idf")" 'signal-1'
  ck 'a comma-list takes only its FIRST token'    "$(resolve_host_label signal-1,aoe-1 "$idf")" 'signal-1'
  ck 'the marker file is used when env is unset'  "$(resolve_host_label '' "$idf")" 'aoe-1'
  ck '  and is whitespace-stripped'               "$(printf 'aoe-1 \n' > "$idf"; resolve_host_label '' "$idf")" 'aoe-1'
  ck 'neither -> UNRESOLVED (never a default identity)' "$(resolve_host_label '' "$probe_dir/no-such-file")" ''

  echo "--- END-TO-END live path (the half no pure-function fixture can reach) ---"
  # Every block above drives an extracted function. The LIVE path — identity resolution, the
  # first-cycle gate, and the decision to invoke the wrapper at all — is the seam those fixtures
  # replace, so it is exercised here by re-invoking THIS script with stubbed systemctl/docker.
  e2e="$probe_dir/e2e"; mkdir -p "$e2e/bin" "$e2e/state"
  cat > "$e2e/bin/systemctl-ok" <<'STUB'
#!/usr/bin/env bash
[ "$1" = "is-enabled" ] || exit 1
echo enabled
STUB
  cat > "$e2e/bin/systemctl-drift" <<'STUB'
#!/usr/bin/env bash
[ "$1" = "is-enabled" ] || exit 1
case "$2" in docker.service) echo disabled; exit 1 ;; *) echo enabled ;; esac
STUB
  cat > "$e2e/bin/docker" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "ps" ]; then printf 'c1\nc2\nnot-declared-1\n'; exit 0; fi
if [ "$1" = "inspect" ]; then
  case "$4" in c1|c2) [ "$3" = '{{.Config.StopTimeout}}' ] && echo 60 || echo unless-stopped; exit 0 ;; *) exit 1 ;; esac
fi
exit 1
STUB
  cat > "$e2e/bin/capture-send.sh" <<'STUB'
#!/usr/bin/env bash
{ printf 'argv=%s|%s|%s\n' "$1" "$2" "$3"; cat; } > "$E2E_CAPTURE"
STUB
  chmod +x "$e2e/bin/"*
  e2e_run() { # <systemctl-stub> <state-file> [extra env assignments...]
    local sc="$1" st="$2"; shift 2
    rm -f "$e2e/captured.txt"
    # The per-case overrides go LAST: `env` applies assignments left to right, so a default
    # placed after them silently wins. That bug made two INDETERMINATE cases read as OK here.
    env E2E_CAPTURE="$e2e/captured.txt" \
        BOOT_CONTRACT_FILE="$probe_dir/contract.json" BOOT_CONTRACT_STATE="$st" \
        BOOT_CONTRACT_LOG=/dev/null BOOT_CONTRACT_SYSTEMCTL="$e2e/bin/$sc" \
        BOOT_CONTRACT_DOCKER="$e2e/bin/docker" BOOT_CONTRACT_WRAPPER="$e2e/bin/capture-send.sh" \
        MONITORING_HOST_LABELS=signal-1 \
        "$@" \
        bash "$0" 2>/dev/null | tail -1
  }
  fired() { [ -s "$e2e/captured.txt" ] && echo yes || echo no; }

  rm -f "$e2e/state/fresh"
  ck 'first cycle on a DRIFTED host still reports DRIFT' "$(e2e_run systemctl-drift "$e2e/state/fresh")" 'BOOT_CONTRACT_VERDICT=DRIFT'
  ck '  ...and pages NOTHING (bootstrap must not replay history)' "$(fired)" 'no'
  ck '  ...and seeds its state file'                   "$([ -s "$e2e/state/fresh" ] && echo yes || echo no)" 'yes'
  ck 'second cycle on the same DRIFT now FIRES'        "$(e2e_run systemctl-drift "$e2e/state/fresh")" 'BOOT_CONTRACT_VERDICT=DRIFT'
  ck '  ...through the wrapper'                        "$(fired)" 'yes'
  ck 'a healthy host reports OK'                       "$(e2e_run systemctl-ok "$e2e/state/fresh")" 'BOOT_CONTRACT_VERDICT=OK'
  ck '  ...and pages nothing'                          "$(fired)" 'no'
  ck 'the token is the LAST stdout line even when fire() logs' "$(e2e_run systemctl-drift "$e2e/state/fresh")" 'BOOT_CONTRACT_VERDICT=DRIFT'
  ck 'an unknown MONITORING_HOST_LABELS is INDETERMINATE, never a default identity' \
     "$(e2e_run systemctl-ok "$e2e/state/fresh" MONITORING_HOST_LABELS=nope)" 'BOOT_CONTRACT_VERDICT=INDETERMINATE'
  ck 'an unreadable contract is INDETERMINATE'         "$(e2e_run systemctl-ok "$e2e/state/fresh" BOOT_CONTRACT_FILE=/nonexistent/x.json)" 'BOOT_CONTRACT_VERDICT=INDETERMINATE'
  ck 'a passed revisit date is INDETERMINATE on an otherwise-clean host' \
     "$(e2e_run systemctl-ok "$e2e/state/fresh" BOOT_CONTRACT_TODAY=2099-01-01)" 'BOOT_CONTRACT_VERDICT=INDETERMINATE'
  # The whole point of the identity work: an unlabelled run must REFUSE, not adopt a default.
  ck 'no env AND no marker file -> INDETERMINATE, never a borrowed identity' \
     "$(e2e_run systemctl-ok "$e2e/state/fresh" MONITORING_HOST_LABELS= BOOT_CONTRACT_IDENTITY_FILE=/nonexistent/label)" 'BOOT_CONTRACT_VERDICT=INDETERMINATE'
  # ...and the marker file alone is sufficient, which is how both hosts will actually run it.
  printf 'signal-1\n' > "$e2e/host-label"
  ck 'the marker file alone resolves identity end-to-end' \
     "$(e2e_run systemctl-ok "$e2e/state/fresh" MONITORING_HOST_LABELS= BOOT_CONTRACT_IDENTITY_FILE="$e2e/host-label")" 'BOOT_CONTRACT_VERDICT=OK'

  # Vacuity guard: this suite BUILDS its own corpus, so "nothing ran" is a defect in the test.
  MIN_ASSERTIONS=59
  if [ "$checked" -lt "$MIN_ASSERTIONS" ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= $MIN_ASSERTIONS)"; exit 3
  fi
  if [ "${#fails[@]}" -gt 0 ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${#fails[@]}/$checked: ${fails[*]}"; exit 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (10 unit, 5 container, 4 budget, 4 revisit, 5 aggregation, 9 parser, 5 wrapper, 5 identity, 13 end-to-end)"
  exit 0
fi

# ── live path ────────────────────────────────────────────────────────────────────────────────
VERDICT=OK
DETAIL=""
note() { DETAIL="${DETAIL}${DETAIL:+$'\n'}$1"; }
absorb() { # <"<verdict> <detail>"> — log it, fold it into the running verdict, keep DRIFT/INDET detail
  local row="$1" v="${1%% *}"
  log "  ${row}"
  VERDICT="$(worst "$VERDICT" "$v")"
  [ "$v" = "OK" ] || note "$row"
}

HOSTNAME_S="$(hostname -s 2>/dev/null || echo unknown)"

if [ ! -r "$CONTRACT" ]; then
  log "VERDICT=INDETERMINATE host=$HOSTNAME_S — contract unreadable at $CONTRACT"
  log "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  [ -f "$STATE" ] && fire INDETERMINATE "$HOSTNAME_S" "the contract is unreadable at $CONTRACT — this guard is DARK on this host"
  echo "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  exit 0
fi

PARSED="$(parse_contract "$CONTRACT" 2>&1)"
if [ $? -ne 0 ]; then
  log "VERDICT=INDETERMINATE host=$HOSTNAME_S — contract at $CONTRACT did not parse: $PARSED"
  log "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  [ -f "$STATE" ] && fire INDETERMINATE "$HOSTNAME_S" "the contract at $CONTRACT did not parse — this guard is DARK on this host"
  echo "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  exit 0
fi

# ── which host am I? ─────────────────────────────────────────────────────────────────────────
# Resolved from the host's OWN addresses against the contract, with MONITORING_HOST_LABELS as an
# explicit override. Deliberately NOT defaulted: monitoring-inventory-reconcile.py defaults its
# labels to signal-1, so a bare run on aoe-1 asserts signal-1's identity — a whole host's contract
# evaluated against the wrong declaration, silently. Unresolvable identity is INDETERMINATE.
WANT="$(resolve_host_label "${MONITORING_HOST_LABELS:-}" "$HOST_IDENTITY_FILE")"
LABEL_SRC="${MONITORING_HOST_LABELS:+MONITORING_HOST_LABELS}"
LABEL_SRC="${LABEL_SRC:-$HOST_IDENTITY_FILE}"
if [ -z "$WANT" ]; then
  log "VERDICT=INDETERMINATE host=$HOSTNAME_S — identity UNRESOLVED: MONITORING_HOST_LABELS is unset and $HOST_IDENTITY_FILE is unreadable"
  log "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  [ -f "$STATE" ] && fire INDETERMINATE "$HOSTNAME_S" "identity UNRESOLVED — this guard cannot know which host block to evaluate, so it evaluated none"
  echo "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  exit 0
fi
if echo "$PARSED" | awk -F'\t' -v w="$WANT" '$1=="HOST" && $2==w{found=1} END{exit !found}'; then
  LABEL="$WANT"
else
  log "VERDICT=INDETERMINATE host=$HOSTNAME_S — identity resolved to '$WANT' via $LABEL_SRC, which the contract does not declare"
  log "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  [ -f "$STATE" ] && fire INDETERMINATE "$HOSTNAME_S" "identity '$WANT' (via $LABEL_SRC) is not a host in the contract"
  echo "BOOT_CONTRACT_VERDICT=INDETERMINATE"
  exit 0
fi
DECLARED_ADDR="$(echo "$PARSED" | awk -F'\t' -v l="$LABEL" '$1=="HOST" && $2==l{print $3; exit}')"

POLICIES="$(echo "$PARSED" | awk -F'\t' '$1=="META"{print $2; exit}')"
BUDGET="$(echo "$PARSED"  | awk -F'\t' '$1=="META"{print $3; exit}')"
REVISIT="$(echo "$PARSED" | awk -F'\t' '$1=="META"{print $4; exit}')"

log "host=$LABEL (hostname=$HOSTNAME_S, declared address=$DECLARED_ADDR, identity via $LABEL_SRC) contract=$CONTRACT policies=$POLICIES pg_stop_floor=${BUDGET}s"
absorb "$(decide_revisit "$TODAY" "$REVISIT")"

# ── units ────────────────────────────────────────────────────────────────────────────────────
UNITS_SEEN=0
while IFS=$'\t' read -r _ _ unit activation via; do
  UNITS_SEEN=$((UNITS_SEEN + 1))
  carrier="$(carrier_for "$activation" "$unit" "$via")"
  state=""; probe_ok=1
  if [ -n "$carrier" ]; then
    state="$("$SYSTEMCTL" is-enabled "$carrier" 2>/dev/null)"; probe_ok=$?
    # `is-enabled` exits non-zero for `disabled` too, which is a real ANSWER, not a probe failure.
    [ -n "$state" ] && probe_ok=0
  fi
  absorb "$(decide_unit "$activation" "$unit" "$via" "$state" "$probe_ok")"
done < <(echo "$PARSED" | awk -F'\t' -v l="$LABEL" '$1=="UNIT" && $2==l')

# ── containers ───────────────────────────────────────────────────────────────────────────────
DECLARED_CONTAINERS=""
CONTAINERS_SEEN=0
while IFS=$'\t' read -r _ _ name; do
  CONTAINERS_SEEN=$((CONTAINERS_SEEN + 1))
  DECLARED_CONTAINERS="${DECLARED_CONTAINERS} ${name}"
  policy="$("$DOCKER" inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null)"; probe_ok=$?
  absorb "$(decide_container "$name" "$policy" "$POLICIES" "$probe_ok")"
  # The live half of check-boot-readiness.mjs's R3. Host-conditional by CONTRACT CONTENT, so a
  # host that declares no postgres prints a positive line rather than silently skipping.
  case "$name" in
    *postgres*)
      timeout="$("$DOCKER" inspect -f '{{.Config.StopTimeout}}' "$name" 2>/dev/null)"
      absorb "$(decide_stop_budget "$name" "$timeout" "$BUDGET")"
      ;;
  esac
done < <(echo "$PARSED" | awk -F'\t' -v l="$LABEL" '$1=="CONT" && $2==l')
case "$DECLARED_CONTAINERS" in
  *postgres*) : ;;
  *) log "  OK no postgres container declared on $LABEL — the ${BUDGET}s stop-budget floor does not apply here" ;;
esac

# ── undeclared live containers: REPORTED, never DRIFT ────────────────────────────────────────
# The contract is the authority on what MUST survive; a container it does not name is not a
# violation. But a bare pass would hide the coverage gap, so the count and the NAMES are printed
# on every run. Same code path on both hosts — signal-1's plausible-ce-* stack goes through it
# exactly as aoe-1's autonomous-optimizer-* containers do. Input to OPS-BOOT-CONTRACT-WIDEN-W1.
LIVE="$("$DOCKER" ps --format '{{.Names}}' 2>/dev/null)"
if [ -z "$LIVE" ]; then
  log "  REPORT undeclared_containers=<could not enumerate live containers>"
else
  UNDECLARED=""; UNDECLARED_N=0
  while read -r c; do
    [ -n "$c" ] || continue
    case " ${DECLARED_CONTAINERS} " in *" $c "*) continue ;; esac
    UNDECLARED="${UNDECLARED}${UNDECLARED:+, }$c"; UNDECLARED_N=$((UNDECLARED_N + 1))
  done <<< "$LIVE"
  log "  REPORT undeclared_containers=$UNDECLARED_N${UNDECLARED:+ — $UNDECLARED} (not a violation; the contract names what MUST survive — coverage input for OPS-BOOT-CONTRACT-WIDEN-W{NEXT})"
fi

# Vacuity: the contract is a corpus WE author, so a host block with nothing in it is our defect.
if [ "$UNITS_SEEN" -eq 0 ]; then
  VERDICT=INDETERMINATE
  note "the contract declares ZERO units for $LABEL — an empty host block is a truncated contract, not a clean host"
  log "  INDETERMINATE units_declared=0 for $LABEL"
fi

log "VERDICT=$VERDICT host=$LABEL units=$UNITS_SEEN containers=$CONTAINERS_SEEN"
log "BOOT_CONTRACT_VERDICT=$VERDICT"

# ── first cycle is REPORT-only ───────────────────────────────────────────────────────────────
if [ ! -f "$STATE" ]; then
  mkdir -p "$(dirname "$STATE")" 2>/dev/null || true
  { printf 'first_seen=%s\nhost=%s\nfirst_verdict=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LABEL" "$VERDICT" > "$STATE"; } 2>/dev/null || true
  log "FIRST_CYCLE_REPORT_ONLY: state seeded at $STATE — this run pages nothing, whatever it found"
elif [ "$VERDICT" != "OK" ]; then
  fire "$VERDICT" "$LABEL" "$DETAIL"
fi

# THE TOKEN IS THE LAST LINE ON STDOUT, ALWAYS. `log()` tees to stdout so the cron log is
# self-describing, and `fire()` logs its own failures — so emitting the token before either would
# leave a FAIL_OPEN line after it, and a caller reading `| tail -1` would read the wrong thing.
# The token law says exactly one TERMINAL machine-readable line; terminal is the load-bearing word.
echo "BOOT_CONTRACT_VERDICT=$VERDICT"
exit 0
