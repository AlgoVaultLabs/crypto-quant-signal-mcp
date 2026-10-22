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
#
# ── OPS-HOST-KERNEL-REBOOT-W6: THE PAGE PROJECTS THE HARNESS'S RECORD ─────────────────────────
# (audits/KERNEL_STALENESS-2026-10-22.md.) Measured live: every KERNEL_STALENESS page of the
# 2026-10-21/22 episode was sent by kernel-auto-reboot.sh, which ran this script's LIVE path bare as
# its `due` gate — so the page left BEFORE any reboot gate had decided, said "a GATE REFUSED" from
# crontab text alone, and on aoe-1 went out two seconds before that same run rebooted the host
# successfully. Fourth instance of one class in this body: a claim about ANOTHER producer derived
# from its schedule or a constant instead of its record. So, now:
#   --decide    is the harness's interface: ONE line, KERNEL_STALENESS_DECISION=…, no log, no page,
#               no crontab read. The harness never runs the paging path again.
#   coverage    is judged from the harness's own canary_result_log record (decision_record on the
#               KERNEL_STALENESS registry row), never from crontab text alone: UNKNOWN · UNCOVERED ·
#               COVERED_SILENT · COVERED_UNDECIDED (no page) · COVERED_REFUSING.
#   the cron    runs hourly (it used to be daily: the harness's call no longer pages, so this
#               schedule carries the latency); the 24 h wrapper cooldown keeps it ≤ 1 page/day/host.
#   the host    is named by the estate label chain, with the hostname beside it.
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
# W6 seams. Each real default is asserted in --self-test (a hermetic suite is blind to its seams).
# Where dpkg keeps its per-package file lists; the newest kernel's .list mtime is its install time.
DPKG_INFO_DIR="${KERNEL_CANARY_DPKG_INFO_DIR:-/var/lib/dpkg/info}"
# canary_result_log.py lives here on both hosts; `--show-path` names the results file (never a
# second hardcoded copy of that path).
RESULT_LOG_DIR="${KERNEL_CANARY_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
# The declaration-synced alert registry: KERNEL_STALENESS's related_automation[].decision_record
# names whose record to read and how fresh it must be.
ALERT_REGISTRY="${KERNEL_CANARY_ALERT_REGISTRY:-/opt/algovault-monitoring/alert-registry.json}"
# The estate host-label chain: MONITORING_HOST_LABELS, then this file, then `hostname -s`.
IDENTITY_FILE="${KERNEL_CANARY_IDENTITY_FILE:-/etc/algovault-host-label}"
PY_BIN="${KERNEL_CANARY_PY:-python3}"

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


# --- the decision's inputs, read ONCE by every path ------------------------------------------
# Echoes: <running> <installed|<none>> <age_days> <breach_at|none>. Read-only: uname, dpkg-query,
# stat. breach_at is the epoch at which this kernel falls due (its .list mtime + THRESHOLD_DAYS) —
# the instant a harness decision must POSTDATE to be a decision about this BREACH.
kernel_facts() {
  local running installed pkg mtime age=-1 breach=none
  running="$(uname -r 2>/dev/null)"
  # Newest installed kernel by dpkg version order (NOT lexical — 6.8.0-106 must beat 6.8.0-99).
  installed="$(dpkg-query -W -f='${Package}\n' 'linux-image-[0-9]*' 2>/dev/null \
    | sed 's/^linux-image-//' | sort -V | tail -1)"
  pkg="$DPKG_INFO_DIR/linux-image-${installed}.list"
  if [ -n "$installed" ] && [ -f "$pkg" ]; then
    # GNU stat on the hosts; BSD stat on the operator's Mac, where the self-tests run.
    mtime="$(stat -c %Y "$pkg" 2>/dev/null || stat -f %m "$pkg" 2>/dev/null)"
    if [ -n "$mtime" ]; then
      age=$(( ( $(date -u +%s) - mtime ) / 86400 ))
      [ "$running" != "$installed" ] && breach=$(( mtime + THRESHOLD_DAYS * 86400 ))
    fi
  fi
  printf '%s %s %s %s\n' "${running:-<unknown>}" "${installed:-<none>}" "$age" "$breach"
}

# --decide's ONE line (R2.1) — the harness's interface. Pure: no log, no page, no crontab read.
decision_line() {
  local running installed age breach result
  read -r running installed age breach <<<"$(kernel_facts)"
  [ "$installed" = "<none>" ] && installed=""
  result="$(decide "$running" "$installed" "$age" "$THRESHOLD_DAYS")"
  printf 'KERNEL_STALENESS_DECISION=%s running=%s installed=%s age_days=%s breach_at=%s\n' \
    "${result%% *}" "$running" "${installed:-<none>}" "$age" "$breach"
}

# The estate host-label chain (R2.6): MONITORING_HOST_LABELS, then the identity file, then
# `hostname -s` marked unlabelled. Echoes: <label> <hostname> <labelled|unlabelled>. The page used
# to say "Host AlgoVault-MCP" — a name that appears in no inventory, ssh config or cloud label.
host_label() {
  local h="${MONITORING_HOST_LABELS:-}" hn
  hn="$(hostname -s 2>/dev/null)"; hn="${hn:-unknown}"
  [ -n "$h" ] || { [ -r "$IDENTITY_FILE" ] && h="$(head -1 "$IDENTITY_FILE" 2>/dev/null | tr -d '[:space:]')"; }
  h="${h%%,*}"
  if [ -n "$h" ]; then printf '%s %s labelled\n' "$h" "$hn"; else printf '%s %s unlabelled\n' "$hn" "$hn"; fi
}

# Echoes COVERED | UNCOVERED | UNKNOWN for THIS host's CRONTAB — the first leg of coverage only.
# UNKNOWN is a real third state: a crontab we could not read is not evidence of absence, and
# reporting it as UNCOVERED would tell the operator to hand-reboot a host that may be self-healing.
#
# COVERED here means an ACTIVE line schedules the harness WITH `--apply` (OPS-HOST-AUTO-REBOOT-SIGNAL1-
# PROMOTE-W1). Matching the basename alone made a DRY-RUN soak read as coverage. A commented-out line
# is not a schedule either. Here-strings, never `printf | grep -q`: under pipefail an early-exiting
# grep can SIGPIPE its writer into a false miss. W6: a line is NOT a decision — what the harness did
# is read from its record by coverage_state(), never inferred from this.
auto_reboot_coverage() {
  local out lines
  out="$("$CRONTAB_BIN" -l 2>/dev/null)" || { echo UNKNOWN; return; }
  lines="$(grep -vE '^[[:space:]]*#' <<<"$out" | grep -F "$AUTO_REBOOT_BASENAME")" || true
  if [ -n "$lines" ] && grep -qE "${AUTO_REBOOT_BASENAME//./\\.}([^#]*[[:space:]])?--apply([[:space:]]|$)" <<<"$lines"; then
    echo COVERED
  else
    echo UNCOVERED
  fi
}

# The results file, named by canary_result_log.py itself — never a second hardcoded copy.
results_path() {
  local out
  out="$("$PY_BIN" -B "$RESULT_LOG_DIR/canary_result_log.py" --show-path 2>/dev/null)" || true
  out="$(grep -oE '^CANARY_RESULT_LOG_PATH=[^[:space:]]+' <<<"$out" | head -1)" || true
  printf '%s' "${out#CANARY_RESULT_LOG_PATH=}"
}

# The harness's NEWEST record for THIS host, judged against THIS breach (R2.4). Prints KEY=VALUE
# lines: state, at, verdict, decided_by, detail, streak_count, streak_since, note. Reads the
# registry's decision_record for WHOSE record and HOW FRESH; an unreadable one falls back to the
# harness's basename and says the freshness bound could not be applied (fail toward noise).
#   COVERED_SILENT     no record for this host, or the newest is older than max_age_s
#   COVERED_UNDECIDED  the newest predates breach_at; or it is the harness WAITING by its own design
#                      — NOT_DUE by gate window, or the FIRST DEFERRED by gate peer_busy (the
#                      mutual exclusion working while the peer cycles). Never paged.
#   COVERED_REFUSING   anything else after breach_at
record_state() { # record_state <host> <breach_at|none> <results-path|"">
  "$PY_BIN" -B - "$ALERT_REGISTRY" "${3:-}" "$1" "$2" "$(date -u +%s)" "${AUTO_REBOOT_BASENAME%.sh}" <<'PYSTATE' 2>/dev/null \
    || printf 'state=COVERED_SILENT\nnote=the record reader itself failed to run (%s)\n' "$PY_BIN"
import datetime, json, sys
reg, res, host, breach, now, fallback = sys.argv[1:7]
now = int(now)
notes = []
canary, max_age = fallback, None
try:
    with open(reg, encoding="utf-8") as fh:
        alerts = json.load(fh)["alerts"]
    row = [a for a in alerts if isinstance(a, dict) and a.get("alert_id") == "KERNEL_STALENESS"][0]
    dr = [e.get("decision_record") for e in (row.get("related_automation") or [])
          if isinstance(e, dict) and isinstance(e.get("decision_record"), dict)][0]
    if not isinstance(dr.get("canary"), str) or not dr["canary"].strip():
        raise ValueError("canary")
    if isinstance(dr.get("max_age_s"), bool) or not isinstance(dr.get("max_age_s"), int) or dr["max_age_s"] <= 0:
        raise ValueError("max_age_s")
    canary, max_age = dr["canary"].strip(), dr["max_age_s"]
except Exception as e:
    notes.append("the freshness bound could not be applied: no readable decision_record in %s (%s)" % (reg, type(e).__name__))


def epoch(at):
    return int(datetime.datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ")
               .replace(tzinfo=datetime.timezone.utc).timestamp())


def out(k, v):
    print("%s=%s" % (k, " ".join(str(v).split())))


newest = None
if not res:
    notes.append("the results file could not be located (canary_result_log.py --show-path)")
else:
    try:
        with open(res, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                    t = epoch(r["at"])
                except Exception:
                    continue  # a line torn by a concurrent trim is skipped, never fatal
                if r.get("canary") == canary and r.get("host") == host and (newest is None or t >= newest[0]):
                    newest = (t, r)
    except Exception as e:
        notes.append("the results file could not be read at %s (%s)" % (res, type(e).__name__))

if newest is None:
    state = "COVERED_SILENT"
else:
    t, r = newest
    m = r.get("metrics") if isinstance(r.get("metrics"), dict) else {}
    verdict, gate = str(r.get("verdict", "")), str(m.get("decided_by", ""))
    try:
        streak = int(m.get("streak_count"))
    except Exception:
        streak = 0
    out("at", r["at"])
    out("verdict", verdict)
    out("decided_by", gate)
    out("detail", str(m.get("detail", ""))[:400])
    out("streak_count", streak if streak > 0 else "")
    out("streak_since", m.get("streak_since", ""))
    if max_age is not None and now - t > max_age:
        state = "COVERED_SILENT"
    elif not breach.isdigit() or t < int(breach):
        state = "COVERED_UNDECIDED"
        notes.append("the harness's newest decision predates this BREACH" if breach.isdigit() else "there is no BREACH to judge")
    elif verdict == "NOT_DUE" and gate == "window":
        state = "COVERED_UNDECIDED"
        notes.append("the harness is waiting for its reboot window")
    elif verdict == "DEFERRED" and gate == "peer_busy" and streak == 1:
        state = "COVERED_UNDECIDED"
        notes.append("the peer is mid-cycle; one deferral is the mutual exclusion working")
    else:
        state = "COVERED_REFUSING"
out("state", state)
if notes:
    out("note", "; ".join(notes))
PYSTATE
}

# Coverage, in the order R2.4 declares: UNKNOWN · UNCOVERED · COVERED_SILENT · COVERED_UNDECIDED ·
# COVERED_REFUSING. Sets CV_* in the CALLING shell (never a subshell) so fire() can project them.
coverage_state() { # coverage_state <host> <breach_at|none>
  CV_STATE="" CV_AT="" CV_VERDICT="" CV_GATE="" CV_DETAIL="" CV_N="" CV_SINCE="" CV_NOTE=""
  local line k v
  line="$(auto_reboot_coverage)"
  case "$line" in UNKNOWN|UNCOVERED) CV_STATE="$line"; return ;; esac
  while IFS='=' read -r k v; do
    case "$k" in
      state) CV_STATE="$v" ;; at) CV_AT="$v" ;; verdict) CV_VERDICT="$v" ;; decided_by) CV_GATE="$v" ;;
      detail) CV_DETAIL="$v" ;; streak_count) CV_N="$v" ;; streak_since) CV_SINCE="$v" ;; note) CV_NOTE="$v" ;;
    esac
  done <<<"$(record_state "$1" "$2" "$(results_path)")"
  [ -n "$CV_STATE" ] || { CV_STATE=COVERED_SILENT; CV_NOTE="${CV_NOTE:-the record reader printed no state}"; }
}

# The Action paragraph, as a pure function of the coverage state and the record it projects.
# Extracted ONLY so the self-test can drive every branch with fixtures — the live path reaches at
# most one of them per fire, so the others would otherwise be dark code in a body nobody proofreads.
#
# EVERY branch cites ops/monitoring/kernel-auto-reboot.sh on purpose: scripts/check-alert-copy-claims.mjs
# direction 2 requires the body of an alert to name the scheduled automation declared against it,
# and a branch that forgot would be a DRIFT rather than a silent regression.
decide_action() { # decide_action <state> <n> <since> <at> <verdict> <gate> <detail> <note>
  local state="$1" n="${2:-}" since="${3:-}" at="${4:-}" verdict="${5:-}" gate="${6:-}" detail="${7:-}" note="${8:-}"
  case "$state" in
    COVERED_REFUSING)
      cat <<ACT
Action: this host IS inside the unattended reboot harness — ops/monitoring/kernel-auto-reboot.sh
is scheduled here with --apply — and the harness has refused ${n:-an unrecorded number of} consecutive run(s)${since:+ since $since}.
Latest ${at}: ${verdict} by gate ${gate} — ${detail:-(no gate detail recorded by this harness version)}
Fix THAT cause; a hand-run reboot here would paper over a harness defect and reset the delta that
proves it.
ACT
      ;;
    COVERED_SILENT)
      cat <<ACT
Action: ops/monitoring/kernel-auto-reboot.sh is scheduled here with --apply but has written no decision since ${at:-never}
— it is not running, or it dies before deciding. That is the defect:
a hand-run reboot would hide a dead harness.
ACT
      ;;
    UNCOVERED)
      cat <<'ACT'
Action: this host is OUTSIDE the unattended reboot harness — its crontab schedules no
ops/monitoring/kernel-auto-reboot.sh --apply line (a dry-run soak does not count) — so a hand-run
reboot is the correct response. Procedure: OPS-HOST-KERNEL-REBOOT-W1 — verify Hetzner console
access FIRST. Do NOT reboot a harness-covered host to "rehearse": that resets its
running-vs-installed delta, which only a real reboot can reset, and destroys one unattended cycle.
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
  case "$state" in COVERED_*) [ -n "$note" ] && printf '(%s)\n' "$note" ;; esac
  return 0
}

fire() { # fire <running> <installed> <age_days> <breach_at|0>
  local running="$1" installed="$2" age="$3" breach="$4"
  local label hn labelled action head
  read -r label hn labelled <<<"$(host_label)"
  coverage_state "$label" "$breach"
  log "auto_reboot_coverage=$CV_STATE host=$label${CV_AT:+ newest=$CV_AT $CV_VERDICT/$CV_GATE}${CV_NOTE:+ note=$CV_NOTE}"
  # PR-3: the harness has not judged this BREACH (or is waiting by its own design) — NO page.
  if [ "$CV_STATE" = COVERED_UNDECIDED ]; then
    log "REPORT: not paging — ${CV_NOTE:-the harness has not decided this BREACH yet}"; return
  fi
  if [ ! -x "$SEND" ]; then
    log "FAIL_OPEN: wrapper not executable at $SEND — operator NOT notified"; return
  fi
  action="$(decide_action "$CV_STATE" "$CV_N" "$CV_SINCE" "$CV_AT" "$CV_VERDICT" "$CV_GATE" "$CV_DETAIL" "$CV_NOTE")"
  if [ "$labelled" = labelled ]; then head="Host <b>${label}</b> (${hn})"
  else head="Host <b>${hn}</b> (unlabelled — no MONITORING_HOST_LABELS and no ${IDENTITY_FILE})"; fi
  printf '%s\n' "$(cat <<EOF
${head} is running an out-of-date kernel.

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
  REAL_SEND="$SEND" REAL_LOG="$LOG" REAL_DPKG="$DPKG_INFO_DIR" REAL_RLD="$RESULT_LOG_DIR"
  REAL_REG="$ALERT_REGISTRY" REAL_ID="$IDENTITY_FILE" REAL_PY="$PY_BIN" REAL_CRONTAB="$CRONTAB_BIN"
  ok() { checked=$((checked + 1)); printf '  ✓ %s\n' "$1"; }
  bad() { checked=$((checked + 1)); printf '  ✗ %s\n' "$1"; fails+=("$2"); }
  same() { # same <label> <got> <want> <tag>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — got [$2], want [$3]" "$4"; fi
  }
  has() { # has <label> <haystack> <needle> <tag>
    case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 — missing [$3]" "$4" ;; esac
  }
  expect() { # <expected-verdict> <running> <installed> <age> <threshold> <label>
    local got; got="$(decide "$2" "$3" "$4" "$5")"
    case "$got" in "$1"*) ok "$6 ⇒ $1" ;; *) bad "$6 ⇒ expected $1, got: $got" "$6" ;; esac
  }
  st="$(mktemp -d "${TMPDIR:-/tmp}/kernel-canary.XXXXXX")"
  trap 'rm -rf "$st"' EXIT   # BSD mktemp: XXXXXX must be TERMINAL, so use -d + fixed names inside

  echo "--- decision fixtures (must-fire and must-not-fire) ---"
  expect BREACH        6.8.0-124-generic 6.8.0-136-generic 30 7 "12 revisions behind, 30d old"
  expect BREACH        6.8.0-106-generic 6.8.0-136-generic  8 7 "at threshold+1"
  expect BREACH        6.8.0-106-generic 6.8.0-136-generic -1 7 "age unknown (-1) — fail toward paging"
  expect REPORT        6.8.0-124-generic 6.8.0-136-generic  2 7 "behind but fresh — must NOT page"
  expect OK            6.8.0-136-generic 6.8.0-136-generic  9 7 "up to date — must NOT page"
  expect INDETERMINATE 6.8.0-136-generic ""                 9 7 "dpkg returned nothing"

  # ── shims: the OS inputs, so --decide and the live path run for REAL against fixtures ──────
  mkdir -p "$st/bin" "$st/dpkg" "$st/rl"
  printf '#!/bin/sh\necho "${SHIM_RUNNING:-6.8.0-142-generic}"\n' > "$st/bin/uname"
  printf '#!/bin/sh\n[ -n "${SHIM_NO_KERNELS:-}" ] && exit 0\nprintf "%%s\\n" linux-image-6.8.0-142-generic linux-image-6.8.0-147-generic\n' > "$st/bin/dpkg-query"
  printf '#!/bin/sh\necho testhost\n' > "$st/bin/hostname"
  chmod +x "$st/bin/"*
  : > "$st/dpkg/linux-image-6.8.0-147-generic.list"
  # mtime = now - 7d - 1h: age_days 7 (>= the threshold ⇒ BREACH) and breach_at = now - 1h, so a
  # FRESH (< max_age_s) harness record can still PREDATE the breach — the only UNDECIDED that exists.
  iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
  list_at=$(( $(date -u +%s) - 7 * 86400 - 3600 ))
  TZ=UTC touch -t "$(date -u -r "$list_at" +%Y%m%d%H%M.%S 2>/dev/null || date -u -d "@$list_at" +%Y%m%d%H%M.%S)" "$st/dpkg/linux-image-6.8.0-147-generic.list"
  breach=$(( $(stat -c %Y "$st/dpkg/linux-image-6.8.0-147-generic.list" 2>/dev/null || stat -f %m "$st/dpkg/linux-image-6.8.0-147-generic.list") + 7 * 86400 ))
  sp() { PATH="$st/bin:$PATH" TZ=UTC KERNEL_CANARY_DPKG_INFO_DIR="$st/dpkg" "$@"; }

  echo "--- --decide: ONE line, pure (R2.1) ---"
  out="$(sp env KERNEL_CANARY_LOG="$st/decide.log" KERNEL_CANARY_WRAPPER="$st/no-send.sh" KERNEL_CANARY_CRONTAB="$st/no-crontab.sh" bash "$0" --decide 2>&1)"
  same "--decide prints exactly ONE line" "$(printf '%s\n' "$out" | grep -c .)" "1" decide-lines
  if [[ "$out" =~ ^KERNEL_STALENESS_DECISION=BREACH\ running=6\.8\.0-142-generic\ installed=6\.8\.0-147-generic\ age_days=7\ breach_at=([0-9]+)$ ]]; then
    ok "…KERNEL_STALENESS_DECISION=BREACH with running/installed/age_days/breach_at"
    same "…breach_at = the newest kernel's .list mtime + THRESHOLD_DAYS" "${BASH_REMATCH[1]}" "$breach" decide-breach-at
  else
    bad "…decision line shape — got [$out]" decide-shape; bad "…breach_at (shape failed)" decide-breach-at
  fi
  same "…and writes NO log (pure)" "$([ -e "$st/decide.log" ] && echo wrote || echo clean)" "clean" decide-nolog
  out="$(sp env SHIM_RUNNING=6.8.0-147-generic bash "$0" --decide 2>&1)"
  same "--decide on the newest kernel ⇒ OK, breach_at=none" "$out" "KERNEL_STALENESS_DECISION=OK running=6.8.0-147-generic installed=6.8.0-147-generic age_days=7 breach_at=none" decide-ok
  out="$(sp env SHIM_NO_KERNELS=1 bash "$0" --decide 2>&1)"
  same "--decide with no kernels ⇒ INDETERMINATE installed=<none>" "$out" "KERNEL_STALENESS_DECISION=INDETERMINATE running=6.8.0-142-generic installed=<none> age_days=-1 breach_at=none" decide-none

  echo "--- host label: the estate chain (R2.6) ---"
  same "MONITORING_HOST_LABELS wins" "$(sp env MONITORING_HOST_LABELS=signal-1,x KERNEL_CANARY_IDENTITY_FILE=/nonexistent bash -c "$(declare -f host_label); IDENTITY_FILE=/nonexistent host_label")" "signal-1 testhost labelled" label-env
  printf 'aoe-1\n' > "$st/id"
  same "…then the identity file" "$(sp env MONITORING_HOST_LABELS= bash -c "$(declare -f host_label); IDENTITY_FILE='$st/id' host_label")" "aoe-1 testhost labelled" label-file
  same "…then hostname -s, marked unlabelled" "$(sp env MONITORING_HOST_LABELS= bash -c "$(declare -f host_label); IDENTITY_FILE=/nonexistent host_label")" "testhost testhost unlabelled" label-host

  echo "--- coverage: judged from the harness's RECORD (R2.4) ---"
  now=$(date -u +%s)
  printf '%s\n' '{"alerts":[{"alert_id":"KERNEL_STALENESS","related_automation":[{"artifact":"ops/monitoring/kernel-auto-reboot.sh","decision_record":{"canary":"kernel-auto-reboot","max_age_s":7200}}]}]}' > "$st/reg.json"
  printf '%s\n' "import os, sys" "if '--show-path' in sys.argv: print('CANARY_RESULT_LOG_PATH=%s MAX_LINES=2000 MAX_LINE_BYTES=8192' % os.environ['ST_RESULTS'])" > "$st/rl/canary_result_log.py"
  rec() { # rec <at-epoch> <host> <verdict> <gate> <streak> [canary]
    printf '{"at":"%s","host":"%s","canary":"%s","verdict":"%s","exit_code":0,"metrics":{"decided_by":"%s","detail":"AUTO_REBOOT_GATE=%s state=%s fixture detail","streak_count":%s,"streak_since":"%s"}}\n' \
      "$(iso "$1")" "$2" "${6:-kernel-auto-reboot}" "$3" "$4" "$4" "$3" "$5" "$(iso "$breach")"
  }
  cron_yes="$st/crontab-yes"; printf '#!/bin/sh\necho "16 * * * * /opt/algovault-monitoring/kernel-auto-reboot.sh --apply >/dev/null 2>&1"\n' > "$cron_yes"; chmod +x "$cron_yes"
  cstate() { # cstate <results-file-body> [registry] [breach_at] → "STATE|N|GATE|NOTE"
    printf '%s' "$1" > "$st/results.jsonl"
    ( ST_RESULTS="$st/results.jsonl"; export ST_RESULTS
      CRONTAB_BIN="$cron_yes" RESULT_LOG_DIR="$st/rl" ALERT_REGISTRY="${2:-$st/reg.json}"
      coverage_state signal-1 "${3:-$breach}"; printf '%s|%s|%s|%s' "$CV_STATE" "$CV_N" "$CV_GATE" "$CV_NOTE" )
  }
  got="$(cstate '')"
  same "no record at all ⇒ COVERED_SILENT" "${got%%|*}" "COVERED_SILENT" cov-silent-none
  got="$(cstate "$(rec $((now - 3 * 3600)) signal-1 DEFERRED in_flight 9)")"
  same "newest record older than max_age_s (3 h > 7200 s) ⇒ COVERED_SILENT" "${got%%|*}" "COVERED_SILENT" cov-silent-stale
  got="$(cstate "$(rec $((breach - 1800)) signal-1 NOT_DUE due 1)")"
  same "newest record PREDATES breach_at ⇒ COVERED_UNDECIDED (no page)" "${got%%|*}" "COVERED_UNDECIDED" cov-undecided
  got="$(cstate "$(rec $((now - 1800)) signal-1 DEFERRED in_flight 13)")"
  same "a DEFERRED record after breach_at ⇒ COVERED_REFUSING" "${got%%|*}" "COVERED_REFUSING" cov-refusing
  same "…carrying the streak and the deciding gate" "$(cut -d'|' -f2,3 <<<"$got")" "13|in_flight" cov-refusing-fields
  got="$(cstate "$(rec $((now - 1800)) signal-1 NOT_DUE window 3)")"
  same "NOT_DUE by gate window after breach ⇒ UNDECIDED (waiting for its window)" "${got%%|*}" "COVERED_UNDECIDED" cov-window
  got="$(cstate "$(rec $((now - 1800)) signal-1 DEFERRED peer_busy 1)")"
  same "the FIRST peer_busy deferral ⇒ UNDECIDED (the mutual exclusion working)" "${got%%|*}" "COVERED_UNDECIDED" cov-peer-1
  got="$(cstate "$(rec $((now - 1800)) signal-1 DEFERRED peer_busy 2)")"
  same "a SECOND consecutive peer_busy deferral ⇒ REFUSING" "${got%%|*}" "COVERED_REFUSING" cov-peer-2
  got="$(cstate "$(rec $((now - 1800)) aoe-1 DEFERRED in_flight 13)")"
  same "another host's record is never this host's ⇒ SILENT" "${got%%|*}" "COVERED_SILENT" cov-host
  got="$(cstate "$(rec $((now - 1800)) signal-1 DEFERRED in_flight 13 some-other-canary)")"
  same "another canary's record is never the harness's ⇒ SILENT" "${got%%|*}" "COVERED_SILENT" cov-canary
  got="$(cstate "$(printf '%s\n{"at":"torn' "$(rec $((now - 1800)) signal-1 DEFERRED in_flight 13)")")"
  same "a line torn by a concurrent trim is skipped, never fatal" "${got%%|*}" "COVERED_REFUSING" cov-torn
  # breach 4 h ago, record 3 h ago: older than the 7200 s bound, yet after the breach.
  got="$(cstate "$(rec $((now - 3 * 3600)) signal-1 DEFERRED in_flight 9)" "$st/reg.json" $((now - 4 * 3600)))"
  same "…the same 3 h record WITH the bound readable ⇒ SILENT (the control for the next check)" "${got%%|*}" "COVERED_SILENT" cov-bound-control
  got="$(cstate "$(rec $((now - 3 * 3600)) signal-1 DEFERRED in_flight 9)" /nonexistent/reg.json $((now - 4 * 3600)))"
  same "an unreadable decision_record cannot apply the bound — the 3 h record is NOT called silent" "${got%%|*}" "COVERED_REFUSING" cov-nobound
  has "…and the page says so (fail toward noise)" "$got" "the freshness bound could not be applied" cov-nobound-note
  same "an UNREADABLE crontab ⇒ UNKNOWN" "$(CRONTAB_BIN=/nonexistent/crontab; coverage_state signal-1 "$breach"; echo "$CV_STATE")" "UNKNOWN" cov-unknown
  printf '#!/bin/sh\necho "16 * * * * /opt/algovault-monitoring/kernel-auto-reboot.sh >/dev/null 2>&1"\n' > "$st/crontab-dryrun"; chmod +x "$st/crontab-dryrun"
  same "a dry-run-only line ⇒ UNCOVERED" "$(CRONTAB_BIN="$st/crontab-dryrun"; coverage_state signal-1 "$breach"; echo "$CV_STATE")" "UNCOVERED" cov-uncovered
  # The crontab leg alone, every fixture shape it has ever been wrong about.
  printf '#!/bin/sh\necho "# 7 * * * * /opt/algovault-monitoring/kernel-auto-reboot.sh --apply"\n' > "$st/crontab-commented"
  printf '#!/bin/sh\necho "23 * * * * /opt/algovault-monitoring/kernel-staleness-canary.sh"\n' > "$st/crontab-no"
  printf '#!/bin/sh\nexit 1\n' > "$st/crontab-dead"; chmod +x "$st/crontab-commented" "$st/crontab-no" "$st/crontab-dead"
  for pair in "yes COVERED" "dryrun UNCOVERED" "commented UNCOVERED" "no UNCOVERED" "dead UNKNOWN"; do
    set -- $pair
    same "crontab leg: crontab-$1 ⇒ $2" "$(CRONTAB_BIN="$st/crontab-$1" auto_reboot_coverage)" "$2" "cov-leg-$1"
  done

  echo "--- Action paragraph: every state, incl. the ones the live path rarely reaches ---"
  a="$(decide_action COVERED_REFUSING 13 2026-10-21T06:16:03Z 2026-10-22T08:16:02Z DEFERRED in_flight 'AUTO_REBOOT_GATE=in_flight state=DEFERRED live population has unclassified job(s)')"
  has "REFUSING names the streak" "$a" "has refused 13 consecutive run(s) since 2026-10-21T06:16:03Z" act-ref-n
  has "…the latest decision, its gate and its detail" "$a" "Latest 2026-10-22T08:16:02Z: DEFERRED by gate in_flight — AUTO_REBOOT_GATE=in_flight state=DEFERRED live population" act-ref-detail
  has "…and forbids the hand reboot" "$a" "a hand-run reboot here would paper over a harness defect" act-ref-hand
  case "$a" in *"a GATE REFUSED"*) bad "…never the crontab-derived 'a GATE REFUSED' (W6 class)" act-ref-class ;; *) ok "…never the crontab-derived 'a GATE REFUSED' (W6 class)" ;; esac
  a="$(decide_action COVERED_SILENT '' '' '' '' '' '' 'the results file could not be read')"
  has "SILENT says the harness has written nothing" "$a" "has written no decision since never" act-silent
  has "…that a dead harness is the defect" "$a" "a hand-run reboot would hide a dead harness" act-silent-dead
  has "…and carries the reader's note" "$a" "(the results file could not be read)" act-silent-note
  a="$(decide_action UNCOVERED)"
  has "UNCOVERED authorises the hand-run" "$a" "is OUTSIDE the unattended reboot harness" act-uncov
  has "  and says WHY a scheduled dry-run is not coverage" "$a" "a dry-run soak does not count" act-uncov-dry
  has "  and forbids the rehearsal that voids a cycle" "$a" "Do NOT reboot a harness-covered host" act-uncov-rehearse
  a="$(decide_action UNKNOWN)"
  has "UNKNOWN refuses to guess" "$a" "is UNKNOWN" act-unknown
  has "  and still names the console preflight" "$a" "verify Hetzner console" act-unknown-console
  # DIRECTION-2 CONTRACT: every paged branch cites the declared automation.
  for s in COVERED_REFUSING COVERED_SILENT UNCOVERED UNKNOWN; do
    has "$s branch cites the declared automation (direction 2)" "$(decide_action "$s" 1 t t v g d)" "ops/monitoring/kernel-auto-reboot.sh" "cite-$s"
  done

  echo "--- --print-coverage: the state ALONE, read-only ---"
  printf '%s' "$(rec $((now - 1800)) signal-1 DEFERRED in_flight 13)" > "$st/results.jsonl"
  got="$(sp env ST_RESULTS="$st/results.jsonl" MONITORING_HOST_LABELS=signal-1 KERNEL_CANARY_CRONTAB="$cron_yes" KERNEL_CANARY_RESULT_LOG_DIR="$st/rl" KERNEL_CANARY_ALERT_REGISTRY="$st/reg.json" KERNEL_CANARY_LOG="$st/pc.log" bash "$0" --print-coverage 2>&1)"
  same "--print-coverage on a stale covered host with a refusal ⇒ COVERED_REFUSING" "$got" "AUTO_REBOOT_COVERAGE=COVERED_REFUSING" print-cov
  same "…and writes no log" "$([ -e "$st/pc.log" ] && echo wrote || echo clean)" "clean" print-cov-nolog
  got="$(sp env KERNEL_CANARY_CRONTAB="$st/crontab-dryrun" bash "$0" --print-coverage 2>&1)"
  same "--print-coverage on a dry-run-only crontab ⇒ UNCOVERED" "$got" "AUTO_REBOOT_COVERAGE=UNCOVERED" print-cov-uncov

  echo "--- the cron path, end to end: shims, a real record, a capturing wrapper ---"
  printf '#!/bin/sh\nprintf "argv=%%s|%%s|%%s\\n" "$1" "$2" "$3" >> "$CAPTURE"\ncat >> "$CAPTURE"\n' > "$st/send.sh"; chmod +x "$st/send.sh"
  live() { # live <results-body> → runs the LIVE path; the capture file holds any page
    printf '%s' "$1" > "$st/results.jsonl"; rm -f "$st/captured" "$st/live.log"
    sp env CAPTURE="$st/captured" ST_RESULTS="$st/results.jsonl" MONITORING_HOST_LABELS=signal-1 \
      KERNEL_CANARY_CRONTAB="$cron_yes" KERNEL_CANARY_RESULT_LOG_DIR="$st/rl" KERNEL_CANARY_ALERT_REGISTRY="$st/reg.json" \
      KERNEL_CANARY_WRAPPER="$st/send.sh" KERNEL_CANARY_LOG="$st/live.log" bash "$0" >/dev/null 2>&1
  }
  live "$(rec $((now - 1800)) signal-1 DEFERRED in_flight 13)"
  body="$(cat "$st/captured" 2>/dev/null)"
  has "REFUSING pages through the wrapper as <alert_id> CRITICAL_PERSISTENT -" "$body" "argv=KERNEL_STALENESS|CRITICAL_PERSISTENT|-" live-argv
  has "…headed by the estate LABEL with the hostname beside it" "$body" "Host <b>signal-1</b> (testhost) is running an out-of-date kernel." live-head
  has "…carries the running/installed pair" "$body" "installed: 6.8.0-147-generic" live-pair
  has "…projects the harness's record (gate + streak)" "$body" "refused 13 consecutive run(s)" live-record
  has "…and keeps the {NEXT} template" "$body" "OPS-HOST-KERNEL-REBOOT-W{NEXT}" live-next
  live "$(rec $((breach - 1800)) signal-1 NOT_DUE due 1)"
  same "UNDECIDED does NOT page" "$([ -s "$st/captured" ] && echo paged || echo silent)" "silent" live-undecided
  has "…and logs a REPORT line instead" "$(cat "$st/live.log" 2>/dev/null)" "REPORT: not paging" live-undecided-log
  has "…while the cron log keeps its VERDICT= token (check-boot-readiness reads it)" "$(cat "$st/live.log" 2>/dev/null)" "VERDICT=BREACH host=signal-1" live-verdict-token
  live ''
  has "SILENT pages that the harness is dead or not deciding" "$(cat "$st/captured" 2>/dev/null)" "has written no decision since never" live-silent

  echo "--- SEAMS: the real defaults no fixture above can see ---"
  same "SEAM — the REAL alert wrapper" "$REAL_SEND" "/opt/algovault-monitoring/send_telegram.sh" seam-send
  same "SEAM — the REAL canary log" "$REAL_LOG" "/var/log/kernel-staleness-canary.log" seam-log
  same "SEAM — the REAL dpkg info dir" "$REAL_DPKG" "/var/lib/dpkg/info" seam-dpkg
  same "SEAM — the REAL result-log dir" "$REAL_RLD" "/opt/algovault-monitoring" seam-rld
  same "SEAM — the REAL alert registry" "$REAL_REG" "/opt/algovault-monitoring/alert-registry.json" seam-reg
  same "SEAM — the REAL identity file" "$REAL_ID" "/etc/algovault-host-label" seam-id
  same "SEAM — the REAL python" "$REAL_PY" "python3" seam-py
  same "SEAM — the REAL crontab" "$REAL_CRONTAB" "crontab" seam-crontab
  same "SEAM — the harness record a decision is read from is the harness's own canary name" "${AUTO_REBOOT_BASENAME%.sh}" "kernel-auto-reboot" seam-canary

  # Vacuity guard: a self-test that asserts nothing must never report a pass.
  if [ "$checked" -lt 70 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 70)"; exit 3
  fi
  if [ "${#fails[@]}" -gt 0 ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${#fails[@]}/$checked: ${fails[*]}"; exit 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (decide fixtures, --decide purity + shape, the host-label chain, record-projected coverage in every state, every Action branch + direction-2 citations, --print-coverage, the cron path end to end, real seam defaults)"
  exit 0
fi

# --- --decide: the harness's interface. ONE line; never logs, never fires, never reads crontab ---
if [ "${1:-}" = "--decide" ]; then
  decision_line
  exit 0
fi

# --- --print-coverage: the coverage state ALONE, read-only -----------------------------------
# Coverage used to be computed only inside fire(), i.e. only on a host that is already stale — so
# no live instrument could read it on a HEALTHY host, which is exactly when an install must be
# verified. Prints the one line and writes nothing: no log, no wrapper (dpkg/uname are read-only).
if [ "${1:-}" = "--print-coverage" ]; then
  read -r _R _I _A PC_BREACH <<<"$(kernel_facts)"
  read -r PC_LABEL _HN _LBL <<<"$(host_label)"
  coverage_state "$PC_LABEL" "$PC_BREACH"
  echo "AUTO_REBOOT_COVERAGE=$CV_STATE"
  exit 0
fi

# --- live path -------------------------------------------------------------------------------
read -r RUNNING INSTALLED AGE_DAYS BREACH_AT <<<"$(kernel_facts)"
[ "$INSTALLED" = "<none>" ] && INSTALLED=""
read -r HOSTLABEL _HN _LBL <<<"$(host_label)"

RESULT="$(decide "$RUNNING" "$INSTALLED" "$AGE_DAYS" "$THRESHOLD_DAYS")"
VERDICT="${RESULT%% *}"
# POSITIVE per-host output on EVERY path: a row silently skipped by a load error must not look
# identical to a row that passed.
log "VERDICT=$VERDICT host=$HOSTLABEL running=$RUNNING installed=${INSTALLED:-<none>} ${RESULT#* }"

if [ "$VERDICT" = "BREACH" ]; then
  # An unknown install time cannot place a breach instant: every harness record then counts as a
  # decision about it (fail toward noise, never toward silence).
  [ "$BREACH_AT" = none ] && BREACH_AT=0
  fire "$RUNNING" "$INSTALLED" "$AGE_DAYS" "$BREACH_AT"
fi
exit 0
