#!/usr/bin/env bash
# aoe-peer-watchdog.sh — OPS-HOST-AUTO-REBOOT-W1, generalized by
# OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1 into ONE implementation with a hardcoded PAIR TABLE, and
# given an UNARMED half by OPS-HOST-OUTAGE-WATCHDOG-W1.
#
# TWO JOBS FROM ONE PEER VANTAGE, selected by whether an arm is present:
#   ARMED    the escalation half of an unattended kernel reboot: if a host ARMS its peer's watchdog
#            and then does not come back, the peer pages. Byte-identical to before the unarmed half.
#   UNARMED  per-pair outage liveness: with NO arm present, a pair whose `unarmed` key is `page`
#            classifies its target from two independent vantages and pages an UNPLANNED outage.
# The filename is historical (it predates the second direction and the second job) and is kept so
# both crontab lines and the inventory row stay put.
#
# ── THE PAIR TABLE (the watcher -> what it watches) ─────────────────────────────────────────
#                      on signal-1 (watches aoe-1)          on aoe-1 (watches signal-1)
#   cadence            9 * * * *                            3,8,13,…,53 * * * *
#   ARMED
#   alert id           AOE_PEER_UNREACHABLE                 SIGNAL1_PEER_UNREACHABLE
#   probe              ssh root@aoe-1 true, with signal-1's TCP connect to signal-1:22 AND the
#                      EXISTING algovault_deploy key        public https://api.algovault.com/health
#                                                           — CREDENTIAL-FREE (PR-4): zero new uses
#                                                           of aoe_to_smpg (audit finding AOE-01)
#   return budget      90 s  (measured 31-42 s, W2/W3,      100 s (measured 48.6 s reboot->SSH, W5
#                      +100%)                               M2, +100% = 97.2 -> 100)
#   arm file           .aoe-reboot-arm                      .signal1-reboot-arm
#   breach counter     .aoe-peer-watchdog-breaches          .signal1-peer-watchdog-breaches
#   UNARMED
#   unarmed            page                                 page
#   alert id           AOE1_UNREACHABLE                     SIGNAL1_UNREACHABLE
#   probe              TCP connect to aoe-1:22 ONLY —       TCP connect to signal-1:22 AND /health,
#                      credential-free; liveness never      the same two signals as the armed probe
#                      spends the deploy key
#   control            https://api.algovault.com/cdn-cgi/trace — served by Cloudflare's EDGE without
#                      reaching the origin, so it proves the watcher's own path and nothing else
#   counter            .aoe-unarmed-breaches                .signal1-unarmed-breaches
#   episode marker     .aoe-unarmed-episode                 .signal1-unarmed-episode
#   console server     127346106 (algovault-aoe-permanent)  125906315 (AlgoVault-MCP)
#   BOTH
#   log                algovault-aoe-peer-watchdog.log      algovault-signal1-peer-watchdog.log
# (arm/counters/markers under /var/lib/algovault-monitoring/, logs under /var/log/). An unlisted
# host REFUSES.
#
# "Returned" for the revenue host means SERVING, not just booted: both probes must pass. A host
# whose SSH answers but whose /health does not has not come back from our reboot in any sense
# that matters.
#
# ── TWO DIFFERENT NUMBERS, BOTH STATED ──────────────────────────────────────────────────────
#   RETURN BUDGET  (armed only) below this age the arm is simply too young to judge -> ARMED_WAITING.
#   DETECTION LATENCY  how long a genuine failure can go unnoticed: the cadence times the
#                      confirmation. It is NOT the budget and must never be quoted as one.
#     aoe-1 watching signal-1  ≈ 5–15 min. Fires every 5 min from :03 to :53, so one gap per hour
#                              is 10 min (:53 -> :03), and a page needs the next fire to confirm:
#                              best = the failure lands just before a fire (+5 min), worst = it
#                              straddles the 10-min gap (fail :53, confirm :03 — or :03 then :08).
#     signal-1 watching aoe-1  ≈ 1–2 h. Hourly at :09; a page needs the following hour to confirm.
#   Add <= 30 s of probe timeouts and the wrapper's delivery. A resolution follows one fire after
#   the target answers again.
#
# ── THE PROPERTY THIS DESIGN HAS, STATED EXPLICITLY (OPS-HOST-OUTAGE-WATCHDOG-W1, OW-1…OW-5) ───
# Superseded: "with NO arm present the watchdog is SILENT and CANNOT page on an outage it was not
# armed for" (PR-5). That trade was deliberate when aoe-1 was a non-revenue target with nothing
# depending on it. It no longer holds: a host whose only liveness watcher is armed by the host
# itself cannot be detected when it fails without arming — and unplanned failures never arm. Since
# PROMOTE-W1 aoe-1 is also signal-1's reboot escalation, so it is watched too (the watcher of the
# watcher). The reversal is PER PAIR, AS DATA (the `unarmed` key), never an env seam.
# ARMED — escalate OUR OWN unattended reboot. Unchanged:
#   * CONFIRMATION — a breach needs >= 2 consecutive unreachable runs; the counter persists and any
#     success resets it.
#   * STALE CEILING — an arm older than 6 h pages regardless of reachability: the target came back
#     but its post-boot run never disarmed, which is itself operator-action-required.
# UNARMED — an outage nobody planned:
#   * OW-5 NEVER PAGE WHAT THE WATCHER CANNOT VOUCH FOR. The edge control runs first; control != 200
#     -> WATCHER_BLIND (silent, nothing else probed, counter untouched). TCP :22 down while /health
#     is 200 -> PATH_ONLY (silent, counter reset: serving is fine). A page needs two vantages that
#     agree: the watcher's own path proven, the target failing.
#   * CLASSES. tcp+health: open/200 OK · down/200 PATH_ONLY · down/!200 HOST_DOWN · open/!200
#     SERVING_DOWN (host up, app or Caddy down — a different remedy). tcp: open OK · down HOST_DOWN.
#   * OW-3 CONFIRMATION — 2 consecutive failing probes, on a counter SEPARATE from the armed one.
#     Planned gaps are shorter than one interval (measured: deploy recreate <= 7 s over 36 deploys,
#     signal-1 reboot 39.5 s, against >= 270 s needed to fail two 5-min probes), so a planned gap
#     can fail at most one probe — and a planned reboot is ARMED anyway.
#   * ONE PAGE PER EPISODE — the episode marker stops a re-page; the wrapper's cooldown is not
#     relied on.
#   * OW-4 ONE RESOLUTION — on OK with an open episode, OR with the wrapper's delivered-page marker
#     still present, the watchdog calls `send_telegram.sh --clear <id> <reason>` (mode flag FIRST).
#     Both rows carry announce_resolution: true; the wrapper announces only if a page was actually
#     DELIVERED, and keeps its marker for a retry if the resolution could not be.
#   * An arm present -> the armed logic runs exactly as before, and the unarmed counter and marker
#     are untouched. A pair whose `unarmed` key is `silent` keeps the old IDLE behaviour.
#   * KNOWN RESIDUAL, stated not proposed: both hosts down at once pages nothing (hel1 / nbg1 — a
#     correlated failure a peer design cannot close).
#
# Verdict token: PEER_WATCHDOG_VERDICT=
#   armed    ARMED_WAITING|ARMED_OK|BREACH|STALE|INDETERMINATE
#   unarmed  UNARMED_OK|UNARMED_WAITING|UNARMED_BREACH|UNARMED_RESOLVED|PATH_ONLY|WATCHER_BLIND,
#            and IDLE only for a pair whose `unarmed` key is `silent`
#   either   REFUSED
# Exit ALWAYS 0 on the live path; callers read the TOKEN. --self-test: 0 pass / 1 fail / 3 indeterminate.
set -uo pipefail

IDENTITY_FILE="${PEER_WATCHDOG_IDENTITY_FILE:-/etc/algovault-host-label}"
SSH_BIN="${PEER_WATCHDOG_SSH:-ssh}"
CURL_BIN="${PEER_WATCHDOG_CURL:-curl}"
# The credential-free TCP probe. Seamed so --self-test can drive it; the real default is asserted.
TCP_BIN="${PEER_WATCHDOG_TCP:-}"
SEND="${PEER_WATCHDOG_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
# Where send_telegram.sh records a DELIVERED page. READ ONLY here, to decide whether a resolution is
# owed: the wrapper's marker — never a private flag — is the one record that a page reached the
# operator (a private flag went stale and pinned FIRING_STALE in outcome-backfill-freshness.py).
ALERT_STATE_DIR="${PEER_WATCHDOG_ALERT_STATE_DIR:-/opt/algovault-monitoring/.alert-state}"
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
    # UNARMED (OW-2): credential-free TCP :22 only, at the existing hourly cadence.
    signal-1:unarmed)          echo page ;;
    signal-1:unarmed_alert_id) ALERT_ID="AOE1_UNREACHABLE"; echo "$ALERT_ID" ;;
    signal-1:unarmed_probe)    echo tcp ;;
    signal-1:control_url)      echo https://api.algovault.com/cdn-cgi/trace ;;
    signal-1:unarmed_state)    echo /var/lib/algovault-monitoring/.aoe-unarmed-breaches ;;
    signal-1:unarmed_episode)  echo /var/lib/algovault-monitoring/.aoe-unarmed-episode ;;
    signal-1:console_server)   echo 127346106 ;;
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
    # UNARMED (OW-1): the revenue host, TCP :22 + /health, classified host-down vs serving-down.
    aoe-1:unarmed)             echo page ;;
    aoe-1:unarmed_alert_id)    ALERT_ID="SIGNAL1_UNREACHABLE"; echo "$ALERT_ID" ;;
    aoe-1:unarmed_probe)       echo tcp+health ;;
    aoe-1:control_url)         echo https://api.algovault.com/cdn-cgi/trace ;;
    aoe-1:unarmed_state)       echo /var/lib/algovault-monitoring/.signal1-unarmed-breaches ;;
    aoe-1:unarmed_episode)     echo /var/lib/algovault-monitoring/.signal1-unarmed-episode ;;
    aoe-1:console_server)      echo 125906315 ;;
    *) return 1 ;;
  esac
}

ALERT_ID="" WATCHER="" TARGET="" TARGET_LABEL="" PROBE="" RETURN_BUDGET_S="" BUDGET_NOTE=""
ARM="" STATE="" LOG="${PEER_WATCHDOG_LOG:-/dev/null}" KEY="" HEALTH_URL=""
UNARMED="" UNARMED_ALERT_ID="" UNARMED_PROBE="" CONTROL_URL="" UNARMED_STATE="" UNARMED_EPISODE="" CONSOLE_SERVER=""
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
  # `unarmed`, the alert id, the probe and the console server are table-only on purpose: no env can
  # silence a pair or rename what it pages. The paths and the control URL are seamed for --self-test.
  UNARMED="$(pair "$1" unarmed)"
  UNARMED_ALERT_ID="$(pair "$1" unarmed_alert_id)"
  UNARMED_PROBE="$(pair "$1" unarmed_probe)"
  CONSOLE_SERVER="$(pair "$1" console_server)"
  CONTROL_URL="${PEER_WATCHDOG_CONTROL_URL:-$(pair "$1" control_url)}"
  UNARMED_STATE="${PEER_WATCHDOG_UNARMED_STATE:-$(pair "$1" unarmed_state)}"
  UNARMED_EPISODE="${PEER_WATCHDOG_UNARMED_EPISODE:-$(pair "$1" unarmed_episode)}"
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

# ═══ UNARMED — per-pair outage liveness (OPS-HOST-OUTAGE-WATCHDOG-W1) ════════════════════════
# Everything below runs ONLY with no arm present and `unarmed: page`. It never touches $STATE (the
# armed counter) or $ARM; its own state is $UNARMED_STATE and $UNARMED_EPISODE.

utc() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'epoch %s' "$1"; }
human_span() { # human_span <seconds>
  local s="$1"
  if [ "$s" -lt 60 ]; then printf '%ds' "$s"
  elif [ "$s" -lt 3600 ]; then printf '%dm' $(( s / 60 ))
  else printf '%dh %02dm' $(( s / 3600 )) $(( (s % 3600) / 60 )); fi
}
# The unarmed counter: "<consecutive> <first-failure epoch>". Never the armed breach counter.
UA_COUNT=0 UA_FIRST=""
ua_read() {
  UA_COUNT=0 UA_FIRST=""
  [ -r "$UNARMED_STATE" ] || return 0
  local line; line="$(head -1 "$UNARMED_STATE" 2>/dev/null)"
  UA_COUNT="$(printf '%s' "$line" | awk '{print $1}' | tr -cd '0-9')"
  UA_FIRST="$(printf '%s' "$line" | awk '{print $2}' | tr -cd '0-9')"
  [ -n "$UA_COUNT" ] || UA_COUNT=0
}
ua_write() { mkdir -p "$(dirname "$UNARMED_STATE")" 2>/dev/null; printf '%s %s\n' "$1" "${2:-}" > "$UNARMED_STATE" 2>/dev/null || true; }
# The episode marker: "<paged epoch> <class> <first-failure epoch>" — present from the page to the
# resolution, which is what makes a re-page impossible without leaning on the wrapper's cooldown.
ep_field() { [ -r "$UNARMED_EPISODE" ] && head -1 "$UNARMED_EPISODE" 2>/dev/null | awk -v f="$1" '{print $f}'; }

# Control first, then the probe. Sets UA_CLASS, UA_CONTROL and UA_DETAIL.
UA_CLASS="" UA_CONTROL="" UA_DETAIL=""
unarmed_classify() {
  UA_CONTROL="$("$CURL_BIN" -s -o /dev/null -m 10 -w '%{http_code}' "$CONTROL_URL" 2>/dev/null)" || true
  UA_CONTROL="${UA_CONTROL:-000}"
  if [ "$UA_CONTROL" != 200 ]; then UA_CLASS=WATCHER_BLIND; UA_DETAIL="control=$UA_CONTROL"; return 0; fi
  local t=down code
  case "$UNARMED_PROBE" in
    tcp)
      # Credential-free on purpose (OW-2): liveness never spends the deploy key.
      tcp_open "$TARGET" 22 && t=open
      UA_DETAIL="control=200 tcp22=$t"
      if [ "$t" = open ]; then UA_CLASS=OK; else UA_CLASS=HOST_DOWN; fi ;;
    tcp+health)
      tcp_open "$TARGET" 22 && t=open
      code="$("$CURL_BIN" -s -o /dev/null -m 10 -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)" || true
      code="${code:-000}"
      UA_DETAIL="control=200 tcp22=$t health=$code"
      case "$t:$code" in
        open:200) UA_CLASS=OK ;;
        down:200) UA_CLASS=PATH_ONLY ;;
        down:*)   UA_CLASS=HOST_DOWN ;;
        *)        UA_CLASS=SERVING_DOWN ;;
      esac ;;
    *) UA_CLASS=UNDECLARED; UA_DETAIL="no unarmed probe declared for this pair" ;;
  esac
}

page_unarmed() { # page_unarmed <class> <detail> <consecutive> <first-failure epoch>
  local action
  if [ "$1" = HOST_DOWN ]; then
    action="Action: $TARGET_LABEL is not answering from $WATCHER — recover it from the Hetzner console: HCLOUD_CONTEXT=algovault-mcp hcloud server request-console $CONSOLE_SERVER"
  else
    action="Action: $TARGET_LABEL is UP (:22 answers) but not serving /health — check its containers (docker ps) and Caddy (systemctl status caddy)"
  fi
  local body
  body="$(printf '%s\n' \
    "🛑 $UNARMED_ALERT_ID — $TARGET_LABEL is $1 (unplanned: no reboot arm present)" \
    "Condition: $2 on $3 consecutive probes (>= $CONFIRM_RUNS required); first failure $(utc "$4")" \
    "Watched from: $WATCHER · target $TARGET_LABEL ($TARGET) · probe $UNARMED_PROBE · the edge control $CONTROL_URL answered 200, so the watcher's own path is proven" \
    "$action" \
    "Then: dispatch OPS-HOST-OUTAGE-W{NEXT} via Cowork → Claude Code for the root cause" \
    "Resolution: ONE resolved message follows when $TARGET_LABEL answers again" \
    "Audit shape: ops/monitoring/aoe-peer-watchdog.sh --self-test" \
    "Source log: $LOG")"
  # A here-string, not a pipe: the wrapper exits WITHOUT reading stdin on its suppressed paths, and
  # under pipefail a writer killed by SIGPIPE would read as a failed page and re-page every run.
  # The return code is therefore the wrapper's alone.
  ( "$SEND" "$UNARMED_ALERT_ID" CRITICAL_PERSISTENT - <<<"$body" 2>>"$LOG" ) 2>/dev/null
}

cmd_unarmed() {
  ALERT_ID="$UNARMED_ALERT_ID"   # every log line from here on is about the unarmed alert
  unarmed_classify
  ua_read
  local now_s; now_s="$(now)"
  case "$UA_CLASS" in
    WATCHER_BLIND)
      check control WATCHER_BLIND "the edge control $CONTROL_URL answered $UA_CONTROL from $WATCHER — the watcher cannot vouch for its own path; nothing else probed, counter untouched (consecutive=$UA_COUNT)"
      log "WATCHER_BLIND: control=$UA_CONTROL — INDETERMINATE, silent by design (OW-5)"
      verdict WATCHER_BLIND; return 0 ;;
    UNDECLARED)
      check probe REFUSED "$UA_DETAIL"
      verdict REFUSED; return 0 ;;
  esac
  check control PASS "the edge control answered 200 — the $WATCHER -> edge path is proven, so what follows is about $TARGET_LABEL"

  case "$UA_CLASS" in
    OK)
      ua_write 0
      local wmarker="$ALERT_STATE_DIR/${UNARMED_ALERT_ID}-last-fired-at"
      if [ ! -f "$UNARMED_EPISODE" ] && [ ! -f "$wmarker" ]; then
        check probe OK "$TARGET_LABEL answered ($UA_DETAIL)"
        verdict UNARMED_OK; return 0
      fi
      local cls since span reason
      cls="$(ep_field 2)"; since="$(ep_field 3 | tr -cd '0-9')"
      [ -n "$since" ] || since="$( [ -r "$wmarker" ] && head -1 "$wmarker" 2>/dev/null | tr -cd '0-9')"
      if [ -n "$since" ] && [ "$now_s" -ge "$since" ]; then span="$(human_span $(( now_s - since )))"; else span="an unknown duration"; fi
      reason="${cls:-outage} resolved after $span"
      check probe OK "$TARGET_LABEL answered ($UA_DETAIL)"
      # Mode flag FIRST: `<id> --clear` parses as a FIRE with severity "--clear" and exits 0.
      ( "$SEND" --clear "$UNARMED_ALERT_ID" "$reason" </dev/null 2>>"$LOG" ) >/dev/null 2>&1 \
        || log "FAIL_OPEN: send_telegram --clear invocation failed (rc=$?) — the wrapper keeps its marker, so the next OK retries"
      rm -f "$UNARMED_EPISODE" 2>/dev/null || true
      check resolution CLEARED "send_telegram.sh --clear $UNARMED_ALERT_ID '$reason' — announced only if a page was DELIVERED (announce_resolution: true)"
      log "UNARMED_RESOLVED: $reason"
      verdict UNARMED_RESOLVED; return 0 ;;
    PATH_ONLY)
      ua_write 0
      check probe PATH_ONLY "$TARGET_LABEL serves /health but :22 is unreachable from $WATCHER ($UA_DETAIL) — serving is fine; silent, counter reset"
      log "PATH_ONLY: $UA_DETAIL — silent by design (OW-5)"
      verdict PATH_ONLY; return 0 ;;
  esac

  # HOST_DOWN | SERVING_DOWN
  local n first
  n=$(( UA_COUNT + 1 ))
  if [ "$UA_COUNT" -gt 0 ] && [ -n "$UA_FIRST" ]; then first="$UA_FIRST"; else first="$now_s"; fi
  ua_write "$n" "$first"
  if [ -f "$UNARMED_EPISODE" ]; then
    check probe BREACH "$TARGET_LABEL is $UA_CLASS ($UA_DETAIL), consecutive=$n — this episode was paged at $(utc "$(ep_field 1 | tr -cd '0-9')"); not re-paging"
    verdict UNARMED_BREACH; return 0
  fi
  if [ "$n" -lt "$CONFIRM_RUNS" ]; then
    check probe WAITING "$TARGET_LABEL is $UA_CLASS ($UA_DETAIL) — consecutive=$n of $CONFIRM_RUNS required, not yet a breach"
    verdict UNARMED_WAITING; return 0
  fi
  check probe BREACH "$TARGET_LABEL is $UA_CLASS ($UA_DETAIL) on $n consecutive probes; first failure $(utc "$first")"
  log "UNARMED_BREACH: $UA_CLASS ($UA_DETAIL), consecutive=$n, first failure $(utc "$first")"
  if page_unarmed "$UA_CLASS" "$UA_DETAIL" "$n" "$first"; then
    mkdir -p "$(dirname "$UNARMED_EPISODE")" 2>/dev/null
    printf '%s %s %s\n' "$now_s" "$UA_CLASS" "$first" > "$UNARMED_EPISODE" 2>/dev/null || true
    check episode OPENED "paged $UNARMED_ALERT_ID once; the marker at $UNARMED_EPISODE suppresses a re-page until $TARGET_LABEL answers"
  else
    log "FAIL_OPEN: send_telegram invocation failed (rc=$?) — no episode marker written, so the next breaching run re-attempts the page"
    check episode NOT_OPENED "the wrapper invocation failed; no marker, the next breaching run re-attempts"
  fi
  verdict UNARMED_BREACH; return 0
}

cmd_run() {
  local host; host="$(resolve_host)"
  if [ -z "$host" ] || ! load_pair "$host"; then
    check identity REFUSED "resolved='${host:-<none>}' — not in the pair table (signal-1 watches aoe-1, aoe-1 watches signal-1)"
    verdict REFUSED; return 0
  fi
  check identity PASS "resolved=$host · watching $TARGET_LABEL via $PROBE"

  if [ ! -f "$ARM" ]; then
    if [ "$UNARMED" != page ]; then
      # SILENT BY DESIGN for this pair — still a POSITIVE line, so "no arm" never reads like "did not run".
      check arm IDLE "no arm at $ARM — $TARGET_LABEL has not asked to be watched; this watchdog is silent by design"
      set_breaches 0
      verdict IDLE; return 0
    fi
    check arm UNARMED "no arm at $ARM — no reboot was requested; running unarmed outage liveness ($UNARMED_PROBE) on $TARGET_LABEL"
    set_breaches 0   # unchanged: no arm resets the ARMED counter, exactly as before
    cmd_unarmed; return 0
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
  local REAL_ALERT_STATE="$ALERT_STATE_DIR"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 0\n'   "$tmp/ssh-argv" > "$tmp/ssh-up.sh";   chmod +x "$tmp/ssh-up.sh"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 255\n' "$tmp/ssh-argv" > "$tmp/ssh-down.sh"; chmod +x "$tmp/ssh-down.sh"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 0\n' "$tmp/tcp-argv" > "$tmp/tcp-up.sh";   chmod +x "$tmp/tcp-up.sh"
  printf '#!/bin/sh\necho "$@" >> %s\nexit 1\n' "$tmp/tcp-argv" > "$tmp/tcp-down.sh"; chmod +x "$tmp/tcp-down.sh"
  printf '#!/bin/sh\necho 200\n' > "$tmp/curl-200.sh"; chmod +x "$tmp/curl-200.sh"
  printf '#!/bin/sh\necho 502\n' > "$tmp/curl-502.sh"; chmod +x "$tmp/curl-502.sh"
  # The unarmed curl seam answers per URL: the edge control and the target's /health are DIFFERENT
  # vantages, so one canned code for both would make OW-5 untestable.
  printf '#!/bin/sh\necho "$@" >> %s\ncase "$*" in *cdn-cgi/trace*) echo "${ST_CONTROL:-200}" ;; *) echo "${ST_HEALTH:-200}" ;; esac\n' \
    "$tmp/curl-argv" > "$tmp/curl-url.sh"; chmod +x "$tmp/curl-url.sh"
  # The wrapper stub models BOTH modes, argv exactly as the real wrapper parses it: a fire reads the
  # body from stdin; `--clear <id> <reason>` (mode flag FIRST) does not. An inverted `<id> --clear`
  # would land in the fire branch as "SEV=--clear" — visible, never mistaken for a clear.
  printf '#!/bin/sh\ncase "$1" in --clear) echo "$1 $2|$3" >> %s ;; *) cat >> %s; echo "ALERT=$1 SEV=$2" >> %s ;; esac\n' \
    "$tmp/clears" "$tmp/paged" "$tmp/paged" > "$tmp/send.sh"; chmod +x "$tmp/send.sh"
  mkdir -p "$tmp/alert-state"
  # One sandbox per watcher, so the two directions never share an arm or a counter — and the
  # unarmed counter, episode marker and the wrapper's marker dir are sandboxed too: a self-test run
  # ON A HOST must never read or write production state.
  w() { # w <watcher> [VAR=value ...]
    local who="$1"; shift
    env MONITORING_HOST_LABELS="$who" PEER_WATCHDOG_LOG="$tmp/log-$who" PEER_WATCHDOG_ARM="$tmp/arm-$who" \
      PEER_WATCHDOG_STATE="$tmp/breaches-$who" PEER_WATCHDOG_WRAPPER="$tmp/send.sh" \
      PEER_WATCHDOG_UNARMED_STATE="$tmp/ua-$who" PEER_WATCHDOG_UNARMED_EPISODE="$tmp/ep-$who" \
      PEER_WATCHDOG_ALERT_STATE_DIR="$tmp/alert-state" \
      PEER_WATCHDOG_SSH="$tmp/ssh-down.sh" PEER_WATCHDOG_TCP="$tmp/tcp-down.sh" PEER_WATCHDOG_CURL="$tmp/curl-502.sh" \
      "$@" bash "$0" --run 2>/dev/null
  }
  u() { local who="$1"; shift; w "$who" PEER_WATCHDOG_CURL="$tmp/curl-url.sh" "$@"; }
  arm_at() { printf '%s some-kernel\n' "$2" > "$tmp/arm-$1"; }
  tok() { tail -1; }
  # cat|grep, never `grep -c <file>`: a missing file must count 0, not print nothing.
  pages() { cat "$tmp/paged" 2>/dev/null | grep -c '^ALERT='; }
  clears() { cat "$tmp/clears" 2>/dev/null | grep -c '^--clear '; }

  echo "aoe-peer-watchdog --self-test"

  # ── identity / pair table ─────────────────────────────────────────────────────────────────
  ck "an UNLISTED watcher REFUSES" "$(w mars-1 | tok)" "PEER_WATCHDOG_VERDICT=REFUSED"
  ck "…and never probes or pages" "$([ -f "$tmp/paged" ] || [ -f "$tmp/ssh-argv" ] && echo touched || echo clean)" "clean"

  # ── signal-1 watches aoe-1 — W1 behaviour, unchanged ─────────────────────────────────────
  rm -f "$tmp/arm-signal-1"
  ck "[s1->aoe] no arm + a blind watcher (control 502) -> WATCHER_BLIND, never a page" "$(w signal-1 PEER_WATCHDOG_NOW=1000000 | tok)" "PEER_WATCHDOG_VERDICT=WATCHER_BLIND"
  ck "[s1->aoe] …silent" "$([ -f "$tmp/paged" ] && echo yes || echo no)" "no"
  ck "[s1->aoe] …but POSITIVE" "$(w signal-1 | grep -c 'PEER_WATCHDOG_CHECK=arm state=UNARMED')" "1"
  arm_at signal-1 1000000
  ck "[s1->aoe] inside the 90s budget -> ARMED_WAITING" "$(w signal-1 PEER_WATCHDOG_NOW=1000030 | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[s1->aoe] past budget, target UP -> ARMED_OK" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=ARMED_OK"
  printf '0\n' > "$tmp/breaches-signal-1"
  ck "[s1->aoe] first unreachable probe is ARMED_WAITING" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[s1->aoe] the SECOND consecutive one BREACHES" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 | tok)" "PEER_WATCHDOG_VERDICT=BREACH"
  ck "[s1->aoe] …and pages AOE_PEER_UNREACHABLE" "$(grep -c 'ALERT=AOE_PEER_UNREACHABLE SEV=CRITICAL_PERSISTENT' "$tmp/paged" 2>/dev/null)" "1"
  ck "[s1->aoe] the page names the 90s derived budget" "$(grep -c 'return budget 90s (measured 31-42s + 100% margin)' "$tmp/paged")" "2"
  ck "[s1->aoe] the probe used signal-1's EXISTING deploy key" "$(grep -c -- '-i /root/.ssh/algovault_deploy' "$tmp/ssh-argv")" "3"
  # Armed page body, pinned LINE BY LINE — the armed differential (AC4) made permanent: a later
  # edit to the shared page path cannot change what an armed breach says without turning this red.
  ck "[s1->aoe] ARMED BODY header verbatim" "$(grep -c '^🛑 AOE_PEER_UNREACHABLE — aoe-1 did not return from its unattended kernel reboot$' "$tmp/paged")" "1"
  ck "[s1->aoe] ARMED BODY condition verbatim" "$(grep -c '^Condition: aoe-1 armed a reboot 200s ago and has not returned$' "$tmp/paged")" "1"
  ck "[s1->aoe] ARMED BODY context verbatim" "$(grep -c '^Context: unreachable (ssh rc=255) on 2 consecutive probes (>= 2 required); return budget 90s (measured 31-42s + 100% margin)$' "$tmp/paged")" "1"
  ck "[s1->aoe] ARMED BODY watched-from verbatim" "$(grep -c '^Watched from: signal-1 · target aoe-1 (178.104.200.44) · probe ssh · return budget 90s (measured 31-42s + 100% margin)$' "$tmp/paged")" "1"
  ck "[s1->aoe] ARMED BODY action verbatim" "$(grep -c '^Action: dispatch OPS-HOST-AUTO-REBOOT-W{NEXT} via Cowork → Claude Code$' "$tmp/paged")" "1"
  ck "[s1->aoe] ARMED BODY is exactly 7 lines (+ the stub's ALERT= line)" "$(wc -l < "$tmp/paged" | tr -d ' ')" "8"
  rm -f "$tmp/paged"
  ck "[s1->aoe] a reachable probe RESETS the counter" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" >/dev/null; cat "$tmp/breaches-signal-1")" "0"
  ck "[s1->aoe] reachable + arm past the 6h ceiling -> STALE" "$(w signal-1 PEER_WATCHDOG_NOW=1030000 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=STALE"
  printf 'not-an-epoch\n' > "$tmp/arm-signal-1"
  ck "[s1->aoe] an arm with no epoch is INDETERMINATE" "$(w signal-1 | tok)" "PEER_WATCHDOG_VERDICT=INDETERMINATE"

  # ── aoe-1 watches signal-1 — the new direction, CREDENTIAL-FREE ─────────────────────────
  rm -f "$tmp/arm-aoe-1" "$tmp/ssh-argv" "$tmp/paged"
  ck "[aoe->s1] no arm + a blind watcher -> WATCHER_BLIND, silent" "$(w aoe-1 PEER_WATCHDOG_NOW=1000000 | tok)" "PEER_WATCHDOG_VERDICT=WATCHER_BLIND"
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
  ck "[aoe->s1] ARMED BODY header verbatim" "$(grep -c '^🛑 SIGNAL1_PEER_UNREACHABLE — signal-1 did not return from its unattended kernel reboot$' "$tmp/paged")" "1"
  ck "[aoe->s1] an ARMED page never carries unarmed copy" "$(grep -c -E 'unplanned|request-console|OPS-HOST-OUTAGE' "$tmp/paged")" "0"

  # ═══ UNARMED — aoe-1 watches signal-1 (OW-1), tcp + health, every §1 row ═════════════════
  rm -f "$tmp/arm-aoe-1" "$tmp/paged" "$tmp/clears" "$tmp/ua-aoe-1" "$tmp/ep-aoe-1" "$tmp/tcp-argv" "$tmp/curl-argv"
  ck "[ua aoe->s1] control 000 -> WATCHER_BLIND" "$(u aoe-1 ST_CONTROL=000 ST_HEALTH=521 | tok)" "PEER_WATCHDOG_VERDICT=WATCHER_BLIND"
  ck "[ua aoe->s1] …silent (OW-5: never page what the watcher cannot vouch for)" "$(pages)" "0"
  ck "[ua aoe->s1] …and the target is never probed (control gates the probe)" "$([ -f "$tmp/tcp-argv" ] && echo probed || echo untouched)" "untouched"
  printf '1 999\n' > "$tmp/ua-aoe-1"
  ck "[ua aoe->s1] WATCHER_BLIND leaves the counter UNTOUCHED" "$(u aoe-1 ST_CONTROL=000 >/dev/null; cat "$tmp/ua-aoe-1")" "1 999"
  ck "[ua aoe->s1] …even with a primed counter, a blind watcher never pages" "$(rm -f "$tmp/paged"; printf '1 999\n' > "$tmp/ua-aoe-1"; u aoe-1 ST_CONTROL=000 ST_HEALTH=521 >/dev/null; pages)" "0"
  ck "[ua aoe->s1] WATCHER_BLIND is a POSITIVE line" "$(u aoe-1 ST_CONTROL=000 | grep -c 'PEER_WATCHDOG_CHECK=control state=WATCHER_BLIND')" "1"
  ck "[ua aoe->s1] control 200 · tcp open · health 200 -> UNARMED_OK" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_OK"
  ck "[ua aoe->s1] …OK resets the counter" "$(awk '{print $1}' "$tmp/ua-aoe-1")" "0"
  ck "[ua aoe->s1] …OK with nothing open calls no --clear" "$(clears)" "0"
  printf '1 999\n' > "$tmp/ua-aoe-1"
  ck "[ua aoe->s1] control 200 · tcp down · health 200 -> PATH_ONLY" "$(u aoe-1 | tok)" "PEER_WATCHDOG_VERDICT=PATH_ONLY"
  ck "[ua aoe->s1] …PATH_ONLY is silent" "$(pages)" "0"
  ck "[ua aoe->s1] …PATH_ONLY resets the counter (serving is fine)" "$(awk '{print $1}' "$tmp/ua-aoe-1")" "0"
  ck "[ua aoe->s1] HOST_DOWN (tcp down · health 521) first probe -> UNARMED_WAITING" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=2000000 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_WAITING"
  ck "[ua aoe->s1] …one failing probe never pages (OW-3)" "$(pages)" "0"
  ck "[ua aoe->s1] HOST_DOWN second consecutive probe -> UNARMED_BREACH" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=2000300 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_BREACH"
  ck "[ua aoe->s1] …pages SIGNAL1_UNREACHABLE, CRITICAL_PERSISTENT, once" "$(grep -c '^ALERT=SIGNAL1_UNREACHABLE SEV=CRITICAL_PERSISTENT$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] UNARMED BODY header" "$(grep -c '^🛑 SIGNAL1_UNREACHABLE — signal-1 is HOST_DOWN (unplanned: no reboot arm present)$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] UNARMED BODY condition: probe codes, count, first-failure UTC" "$(grep -c '^Condition: control=200 tcp22=down health=521 on 2 consecutive probes (>= 2 required); first failure 1970-01-24T03:33:20Z$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] UNARMED BODY HOST_DOWN action: the console for signal-1's server" "$(grep -c '^Action: signal-1 is not answering from aoe-1 — recover it from the Hetzner console: HCLOUD_CONTEXT=algovault-mcp hcloud server request-console 125906315$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] UNARMED BODY dispatches a TEMPLATED root-cause wave" "$(grep -c '^Then: dispatch OPS-HOST-OUTAGE-W{NEXT} via Cowork → Claude Code for the root cause$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] UNARMED BODY names its audit shape" "$(grep -c '^Audit shape: ops/monitoring/aoe-peer-watchdog.sh --self-test$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] an UNARMED page never borrows the reboot copy" "$(grep -c -E 'did not return|OPS-HOST-AUTO-REBOOT' "$tmp/paged")" "0"
  ck "[ua aoe->s1] the episode marker records page time, class, first failure" "$(cat "$tmp/ep-aoe-1" 2>/dev/null)" "2000300 HOST_DOWN 2000000"
  ck "[ua aoe->s1] a THIRD failing probe stays UNARMED_BREACH" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=2000600 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_BREACH"
  ck "[ua aoe->s1] …and a FOURTH" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=2000900 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_BREACH"
  ck "[ua aoe->s1] BREACH x4 paged ONCE — the episode marker, not the wrapper's cooldown" "$(pages)" "1"
  ck "[ua aoe->s1] recovery -> UNARMED_RESOLVED" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" PEER_WATCHDOG_NOW=2001000 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_RESOLVED"
  ck "[ua aoe->s1] …--clear exactly once, MODE FLAG FIRST, reason positional (OW-4)" "$(cat "$tmp/clears" 2>/dev/null)" "--clear SIGNAL1_UNREACHABLE|HOST_DOWN resolved after 16m"
  ck "[ua aoe->s1] …the episode marker is removed" "$([ -f "$tmp/ep-aoe-1" ] && echo kept || echo removed)" "removed"
  ck "[ua aoe->s1] a second OK -> UNARMED_OK" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" PEER_WATCHDOG_NOW=2001300 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_OK"
  ck "[ua aoe->s1] …and calls nothing" "$(clears)" "1"
  rm -f "$tmp/paged"
  ck "[ua aoe->s1] SERVING_DOWN (tcp open · health 502) first probe waits" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" ST_HEALTH=502 PEER_WATCHDOG_NOW=3000000 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_WAITING"
  ck "[ua aoe->s1] SERVING_DOWN second probe -> UNARMED_BREACH" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" ST_HEALTH=502 PEER_WATCHDOG_NOW=3000300 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_BREACH"
  ck "[ua aoe->s1] SERVING_DOWN header — host up, a different remedy" "$(grep -c '^🛑 SIGNAL1_UNREACHABLE — signal-1 is SERVING_DOWN (unplanned: no reboot arm present)$' "$tmp/paged")" "1"
  ck "[ua aoe->s1] SERVING_DOWN action: containers and Caddy, not the console" "$(grep -c '^Action: signal-1 is UP (:22 answers) but not serving /health — check its containers (docker ps) and Caddy (systemctl status caddy)$' "$tmp/paged")/$(grep -c 'request-console' "$tmp/paged")" "1/0"
  ck "[ua aoe->s1] SERVING_DOWN resolves with its own class" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" PEER_WATCHDOG_NOW=3004000 >/dev/null; tail -1 "$tmp/clears")" "--clear SIGNAL1_UNREACHABLE|SERVING_DOWN resolved after 1h 06m"
  # The counter is SEPARATE: an arm planted mid-episode runs the armed logic and consumes nothing.
  rm -f "$tmp/paged" "$tmp/ep-aoe-1"; printf '1 4000000\n' > "$tmp/ua-aoe-1"; printf '0\n' > "$tmp/breaches-aoe-1"
  arm_at aoe-1 4000100
  ck "[ua aoe->s1] an arm planted mid-episode switches to ARMED logic" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=4000110 | tok)" "PEER_WATCHDOG_VERDICT=ARMED_WAITING"
  ck "[ua aoe->s1] …armed past budget + unreachable counts on the ARMED counter" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=4000300 >/dev/null; cat "$tmp/breaches-aoe-1")" "1"
  ck "[ua aoe->s1] …while the UNARMED counter is untouched" "$(cat "$tmp/ua-aoe-1")" "1 4000000"
  ck "[ua aoe->s1] …and no unarmed control/probe line runs while armed" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=4000110 | grep -c -E 'PEER_WATCHDOG_CHECK=(control|episode|resolution)')" "0"
  ck "[ua aoe->s1] …nothing unarmed was paged" "$(cat "$tmp/paged" 2>/dev/null | grep -c 'SIGNAL1_UNREACHABLE')" "0"
  rm -f "$tmp/arm-aoe-1"
  ck "[ua aoe->s1] disarmed, the unarmed count resumes where it stood" "$(u aoe-1 ST_HEALTH=521 PEER_WATCHDOG_NOW=4003600 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_BREACH"
  ck "[ua aoe->s1] …first failure carried from before the arm" "$(cat "$tmp/ep-aoe-1")" "4003600 HOST_DOWN 4000000"
  # The wrapper's DELIVERED-page marker is what proves a resolution is owed — a lost episode marker
  # must not strand it (the outcome-backfill FIRING_STALE class).
  rm -f "$tmp/ep-aoe-1" "$tmp/clears"; printf '5000000\n' > "$tmp/alert-state/SIGNAL1_UNREACHABLE-last-fired-at"
  ck "[ua aoe->s1] OK with only the WRAPPER's marker still resolves" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" PEER_WATCHDOG_NOW=5000600 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_RESOLVED"
  ck "[ua aoe->s1] …with a reason derived from that marker" "$(cat "$tmp/clears")" "--clear SIGNAL1_UNREACHABLE|outage resolved after 10m"
  rm -f "$tmp/alert-state/SIGNAL1_UNREACHABLE-last-fired-at"
  ck "[ua aoe->s1] …and once the wrapper removed it, OK again calls nothing" "$(u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" >/dev/null; clears)" "1"

  # ═══ UNARMED — signal-1 watches aoe-1 (OW-2), TCP :22 only ═══════════════════════════════
  rm -f "$tmp/arm-signal-1" "$tmp/paged" "$tmp/clears" "$tmp/ua-signal-1" "$tmp/ep-signal-1" "$tmp/ssh-argv" "$tmp/curl-argv"
  ck "[ua s1->aoe] control 000 -> WATCHER_BLIND" "$(u signal-1 ST_CONTROL=000 | tok)" "PEER_WATCHDOG_VERDICT=WATCHER_BLIND"
  ck "[ua s1->aoe] tcp open -> UNARMED_OK" "$(u signal-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_OK"
  ck "[ua s1->aoe] tcp down first probe -> UNARMED_WAITING" "$(u signal-1 PEER_WATCHDOG_NOW=6000000 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_WAITING"
  ck "[ua s1->aoe] tcp down second probe -> UNARMED_BREACH" "$(u signal-1 PEER_WATCHDOG_NOW=6003600 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_BREACH"
  ck "[ua s1->aoe] …pages AOE1_UNREACHABLE once" "$(grep -c '^ALERT=AOE1_UNREACHABLE SEV=CRITICAL_PERSISTENT$' "$tmp/paged")" "1"
  ck "[ua s1->aoe] UNARMED BODY header" "$(grep -c '^🛑 AOE1_UNREACHABLE — aoe-1 is HOST_DOWN (unplanned: no reboot arm present)$' "$tmp/paged")" "1"
  ck "[ua s1->aoe] UNARMED BODY condition: control + tcp22 only" "$(grep -c '^Condition: control=200 tcp22=down on 2 consecutive probes (>= 2 required); first failure 1970-03-11T10:40:00Z$' "$tmp/paged")" "1"
  ck "[ua s1->aoe] UNARMED BODY console names aoe-1's server" "$(grep -c 'request-console 127346106$' "$tmp/paged")" "1"
  ck "[ua s1->aoe] OW-2 — the unarmed probe NEVER invokes ssh (captured argv)" "$([ -f "$tmp/ssh-argv" ] && echo yes || echo no)" "no"
  ck "[ua s1->aoe] …and requests only the edge control, never a target URL" "$(grep -c -v 'cdn-cgi/trace' "$tmp/curl-argv")" "0"
  ck "[ua s1->aoe] recovery -> UNARMED_RESOLVED" "$(u signal-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh" PEER_WATCHDOG_NOW=6007300 | tok)" "PEER_WATCHDOG_VERDICT=UNARMED_RESOLVED"
  ck "[ua s1->aoe] …--clear exactly once, mode flag first" "$(cat "$tmp/clears")" "--clear AOE1_UNREACHABLE|HOST_DOWN resolved after 2h 01m"

  # ── a `silent` pair keeps the old behaviour: IDLE, no probe, no page ─────────────────────
  # Driven through a SOURCED harness that overrides one table key, so no env seam exists that
  # could silence a pair on a live host.
  cat > "$tmp/silent.sh" <<EOF
. "$0"
eval "_real_pair() \$(declare -f pair | sed 1d)"
pair() { if [ "\$2" = unarmed ]; then echo silent; else _real_pair "\$@"; fi; }
cmd_run
EOF
  rm -f "$tmp/paged" "$tmp/tcp-argv" "$tmp/curl-argv" "$tmp/ssh-argv"
  local who
  for who in signal-1 aoe-1; do
    ck "[silent $who] no arm -> IDLE even with the target DOWN" "$(env MONITORING_HOST_LABELS="$who" PEER_WATCHDOG_LOG="$tmp/log-s" PEER_WATCHDOG_ARM="$tmp/arm-none" \
      PEER_WATCHDOG_STATE="$tmp/breaches-s" PEER_WATCHDOG_WRAPPER="$tmp/send.sh" PEER_WATCHDOG_UNARMED_STATE="$tmp/ua-s" \
      PEER_WATCHDOG_UNARMED_EPISODE="$tmp/ep-s" PEER_WATCHDOG_ALERT_STATE_DIR="$tmp/alert-state" PEER_WATCHDOG_SSH="$tmp/ssh-down.sh" \
      PEER_WATCHDOG_TCP="$tmp/tcp-down.sh" PEER_WATCHDOG_CURL="$tmp/curl-url.sh" ST_HEALTH=521 bash "$tmp/silent.sh" 2>/dev/null | tok)" "PEER_WATCHDOG_VERDICT=IDLE"
  done
  ck "[silent] …never probes and never pages" "$([ -f "$tmp/paged" ] || [ -f "$tmp/tcp-argv" ] || [ -f "$tmp/curl-argv" ] || [ -f "$tmp/ssh-argv" ] && echo touched || echo clean)" "clean"
  ck "[silent] …but POSITIVE" "$(grep -c 'PEER_WATCHDOG_CHECK=arm state=IDLE' "$tmp/log-s")" "2"

  # ── one token, exit 0 ───────────────────────────────────────────────────────────────────
  arm_at signal-1 1000000
  ck "exactly ONE terminal token per run" "$(w signal-1 PEER_WATCHDOG_NOW=1000200 PEER_WATCHDOG_SSH="$tmp/ssh-up.sh" | grep -c '^PEER_WATCHDOG_VERDICT=')" "1"
  ck "the live path ALWAYS exits 0" "$(w aoe-1 PEER_WATCHDOG_NOW=1000200 >/dev/null 2>&1; echo $?)" "0"
  rm -f "$tmp/arm-aoe-1" "$tmp/ua-aoe-1" "$tmp/ep-aoe-1"
  ck "UNARMED — exactly ONE terminal token on every path" \
     "$( { u aoe-1 ST_CONTROL=000; u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh"; u aoe-1; u aoe-1 ST_HEALTH=521; u aoe-1 ST_HEALTH=521; u aoe-1 PEER_WATCHDOG_TCP="$tmp/tcp-up.sh"; } | grep -c '^PEER_WATCHDOG_VERDICT=')" "6"
  ck "UNARMED — the live path ALWAYS exits 0, breach included" "$(u aoe-1 ST_HEALTH=521 >/dev/null 2>&1; u aoe-1 ST_HEALTH=521 >/dev/null 2>&1; echo $?)" "0"

  # ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────
  ck "SEAM — the REAL alert wrapper" "$REAL_SEND" "/opt/algovault-monitoring/send_telegram.sh"
  ck "SEAM — the REAL ssh binary" "$REAL_SSH" "ssh"
  ck "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label"
  ck "SEAM — the REAL wrapper marker dir (send_telegram.sh STATE_DIR)" "$REAL_ALERT_STATE" "/opt/algovault-monitoring/.alert-state"
  ck "SEAM — a breach needs more than one sample" "$([ "$REAL_CONFIRM" -ge 2 ] && echo yes)" "yes"
  ck "SEAM — the stale ceiling is far past any plausible reboot" "$([ "$REAL_CEIL" -gt 3600 ] && echo yes)" "yes"
  ck "PAIR — signal-1 watches aoe-1's address over ssh" "$(pair signal-1 target)/$(pair signal-1 probe)" "178.104.200.44/ssh"
  ck "PAIR — aoe-1 watches signal-1's address credential-free" "$(pair aoe-1 target)/$(pair aoe-1 probe)/$(pair aoe-1 key)" "204.168.185.24/tcp+health/"
  ck "PAIR — the arm paths are what arm-peer-watchdog.sh writes" \
     "$(pair signal-1 arm)|$(pair aoe-1 arm)" "/var/lib/algovault-monitoring/.aoe-reboot-arm|/var/lib/algovault-monitoring/.signal1-reboot-arm"
  ck "PAIR — the budgets are 90 (31-42s +100%) and 100 (48.6s +100%)" "$(pair signal-1 budget)/$(pair aoe-1 budget)" "90/100"
  ck "PAIR — both budgets exceed their measured worst return" "$([ "$(pair signal-1 budget)" -gt 42 ] && [ "$(pair aoe-1 budget)" -gt 49 ] && echo yes)" "yes"
  ck "PAIR — the real health URL is the public one" "$(pair aoe-1 health_url)" "https://api.algovault.com/health"
  ck "PAIR — BOTH pairs page an unplanned outage (OW-1, OW-2)" "$(pair signal-1 unarmed)/$(pair aoe-1 unarmed)" "page/page"
  ck "PAIR — the unarmed alert ids" "$(pair signal-1 unarmed_alert_id)/$(pair aoe-1 unarmed_alert_id)" "AOE1_UNREACHABLE/SIGNAL1_UNREACHABLE"
  ck "PAIR — unarmed ids differ from the armed ids (different remedy)" \
     "$([ "$(pair signal-1 unarmed_alert_id)" != "$(pair signal-1 alert_id)" ] && [ "$(pair aoe-1 unarmed_alert_id)" != "$(pair aoe-1 alert_id)" ] && echo yes)" "yes"
  ck "PAIR — the unarmed probes (s1: tcp only, credential-free; aoe-1: tcp+health)" "$(pair signal-1 unarmed_probe)/$(pair aoe-1 unarmed_probe)" "tcp/tcp+health"
  ck "PAIR — the control is the edge-served trace, on both" "$(pair signal-1 control_url)|$(pair aoe-1 control_url)" "https://api.algovault.com/cdn-cgi/trace|https://api.algovault.com/cdn-cgi/trace"
  ck "PAIR — the unarmed counters" "$(pair signal-1 unarmed_state)|$(pair aoe-1 unarmed_state)" "/var/lib/algovault-monitoring/.aoe-unarmed-breaches|/var/lib/algovault-monitoring/.signal1-unarmed-breaches"
  ck "PAIR — the episode markers" "$(pair signal-1 unarmed_episode)|$(pair aoe-1 unarmed_episode)" "/var/lib/algovault-monitoring/.aoe-unarmed-episode|/var/lib/algovault-monitoring/.signal1-unarmed-episode"
  ck "PAIR — the unarmed counter is NEVER the armed counter" \
     "$([ "$(pair signal-1 unarmed_state)" != "$(pair signal-1 state)" ] && [ "$(pair aoe-1 unarmed_state)" != "$(pair aoe-1 state)" ] && echo yes)" "yes"
  ck "PAIR — the console servers (hcloud ids, context algovault-mcp)" "$(pair signal-1 console_server)/$(pair aoe-1 console_server)" "127346106/125906315"

  rm -rf "$tmp"
  if [ "$n" -lt 120 ]; then echo "SELF-TEST: only $n assertions ran (expected >= 120)"; echo "SELF_TEST_VERDICT=INDETERMINATE"; return 3; fi
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST: $fails of $n failed"; echo "SELF_TEST_VERDICT=FAIL"; return 1; fi
  echo "SELF-TEST: PASS — $n checks"; echo "SELF_TEST_VERDICT=PASS"; return 0
}

# Sourceable, for --self-test's silent-pair harness: sourced, it defines everything and dispatches
# nothing. Executed (cron, the gate, every test), this line is a no-op.
if (return 0 2>/dev/null); then return 0; fi

case "${1:-}" in
  ""|--run)    cmd_run ;;
  --self-test) cmd_self_test ;;
  *) echo "usage: $0 [--run|--self-test]" >&2; exit 2 ;;
esac
