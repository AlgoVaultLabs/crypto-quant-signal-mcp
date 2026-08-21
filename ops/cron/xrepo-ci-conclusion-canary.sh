#!/usr/bin/env bash
# ops/cron/xrepo-ci-conclusion-canary.sh — OPS-MARKETPLACE-CANARY-REPAIR-W1 (2026-08-06)
#
# WHY THIS EXISTS. `algovault-skills`'s Marketplace Health Check — the only automated
# watcher of AlgoVault's public distribution surface — failed FORTY consecutive runs
# (2026-06-27 → 2026-08-05) and alerted nobody. Two independent reasons:
#   1. it asserted a protocol contract the server deliberately abandoned (fixed in CH2), and
#   2. its own alert step resolved both Telegram secrets to empty and `exit 0`'d — dark by
#      construction, because that repo holds no Telegram credentials at all.
# Nothing else was watching, because `ops/monitoring/monitoring-inventory.json` models HOST
# artifacts and a GitHub Actions workflow in a SECOND repo sits outside it entirely.
#
# ARCHITECT RULING: do NOT duplicate bot credentials into a second repo. Watch it from here
# instead, and alert through the existing, proven send_telegram.sh. One mechanism, one place
# credentials live. This also subsumes the separate "cross-repo CI visibility" work.
#
# NO TOKEN REQUIRED. The watched repos are PUBLIC, so the workflow-runs REST endpoint is
# readable unauthenticated (verified 2026-08-06). A daily cron is far under the 60/hr
# unauthenticated limit. That is deliberate: a canary that needs a credential is a canary
# that dies when the credential expires — which is the class of failure it exists to catch.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# ships ONLY the pure alert branch. send_telegram.sh OWNS the severity gate, the 24h-per-
# alert_id cooldown, the recommended-wave resolver and its own fail-open.
#
# FAIL-OPEN, per the ops/cron convention: an infra error logs and exits 0 rather than
# bouncing the cron. The VERDICT TOKEN still tells the truth in that case — INDETERMINATE,
# never a laundered PASS — so a caller reading the token can tell "all watched workflows are
# green" from "I could not find out" (CLAUDE.md verdict-token law).
#
# Suggested crontab (daily, off-:00 per snapshot-sampler discipline; marketplace-check.yml
# runs at 08:00 UTC, so 09:41 leaves it time to finish): 41 9 * * *
#
# On the SECOND row's cadence (OPS-CI-MAIN-WRITER-HARDEN-W1, 2026-08-21): regenerate-landing.yml
# is event-driven (repository_dispatch from algovault-skills), not scheduled, so no clock offset
# can be "after it finishes". That is fine and is worth stating so nobody later tunes the cron
# hoping to fix it: this canary reads the LAST COMPLETED run, never the in-flight one, so the
# only thing the schedule governs is DETECTION LATENCY — a red regeneration is surfaced within
# 24h rather than at the moment it happens. Given that workflow fired 12 times in the four months
# to 2026-08-21, 24h is far inside the window in which it would otherwise have gone unnoticed
# indefinitely: before this row, nothing watched it at all.
set -uo pipefail

SEND="${XREPO_CI_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${XREPO_CI_LOG:-/var/log/xrepo-ci-conclusion-canary.log}"
API="${XREPO_CI_API:-https://api.github.com}"

# DECLARED watch list. Adding a workflow is a row here, not a code change.
# Format: <owner/repo>|<workflow-file>|<human label>
# `${VAR-default}` NOT `${VAR:-default}`: an EXPLICITLY EMPTY watch list is a config
# defect and must reach the refusal below, whereas `:-` would silently substitute the
# default and report a confident all-clear over a list someone had just emptied.
# regenerate-landing.yml is the ONE CI writer of this repo's `main` (enumerated 2026-08-21 across
# all 6 workflows; publish-npm.yml's `git push` hit is a comment). It commits regenerated landing
# surfaces AND README.md — the canonical npm-README SoT — and OPS-CI-MAIN-WRITER-HARDEN-W1 gave it
# a bounded rebase-retry so it survives losing the race. What that hardening CANNOT make safe is a
# genuine rebase conflict: it aborts and fails the run, deliberately, because auto-resolving would
# risk authored release copy. This row is what makes that refusal LOUD. Without it the fix would
# fail loudly into an empty room — the same shape as the 40 unnoticed red runs that produced this
# script in the first place, one repo over.
WATCHED="${XREPO_CI_WATCHED-AlgoVaultLabs/algovault-skills|marketplace-check.yml|Marketplace Health Check
AlgoVaultLabs/crypto-quant-signal-mcp|regenerate-landing.yml|Landing Regeneration}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >/dev/null 2>&1 || true; }
verdict() { echo "XREPO_CI_VERDICT=$1"; }

command -v curl >/dev/null 2>&1 || { log "curl missing — cannot verify"; verdict INDETERMINATE; exit 0; }
command -v python3 >/dev/null 2>&1 || { log "python3 missing — cannot verify"; verdict INDETERMINATE; exit 0; }

CHECKED=0
RED=0
INDET=0
RED_DETAIL=""

while IFS='|' read -r REPO WF LABEL; do
  [ -n "${REPO:-}" ] || continue
  CHECKED=$((CHECKED + 1))
  URL="$API/repos/$REPO/actions/workflows/$WF/runs?per_page=1&status=completed"
  # -f would collapse every non-2xx into one opaque failure. Capture the status so a
  # RATE LIMIT is distinguishable from a genuinely unreachable API — measured on the
  # host 2026-08-06: the UNAUTHENTICATED budget is 60/hr PER IP and is SHARED with
  # everything else calling GitHub from that box, so exhaustion is a real, recurring
  # state and reads nothing like an outage.
  HTTP=$(curl -sS --max-time 25 -o /tmp/xrepo.body -w '%{http_code}' \
           -H 'Accept: application/vnd.github+json' "$URL" 2>/dev/null || echo 000)
  BODY=$(cat /tmp/xrepo.body 2>/dev/null || true)
  if [ "$HTTP" != "200" ]; then
    if [ "$HTTP" = "403" ] || [ "$HTTP" = "429" ]; then
      REM=$(printf '%s' "$BODY" | grep -o '"message"[^,}]*' | head -1)
      log "INDETERMINATE $REPO/$WF — HTTP $HTTP (rate limited) $REM"
      echo "  ? $LABEL ($REPO): HTTP $HTTP — GitHub API RATE LIMITED (unauthenticated 60/hr per IP, shared)"
    else
      log "INDETERMINATE $REPO/$WF — HTTP $HTTP"
      echo "  ? $LABEL ($REPO): HTTP $HTTP — API unreachable, cannot verify"
    fi
    INDET=$((INDET + 1)); continue
  fi
  # Parse defensively: a shape change must be INDETERMINATE, not a silent pass.
  PARSED=$(printf '%s' "$BODY" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    runs = d.get("workflow_runs") or []
    if not runs:
        print("NORUNS||"); sys.exit(0)
    r = runs[0]
    print(f'"'"'{r.get("conclusion") or "unknown"}|{r.get("created_at") or "?"}|{r.get("html_url") or "?"}'"'"')
except Exception:
    print("PARSEFAIL||")
' 2>/dev/null) || PARSED="PARSEFAIL||"

  CONC="${PARSED%%|*}"; REST="${PARSED#*|}"; WHEN="${REST%%|*}"; RUNURL="${REST#*|}"

  case "$CONC" in
    success)
      echo "  + $LABEL ($REPO): last completed run = success ($WHEN)"
      log "OK $REPO/$WF success $WHEN" ;;
    PARSEFAIL|NORUNS|unknown|"")
      echo "  ? $LABEL ($REPO): could not determine last conclusion (got '$CONC')"
      log "INDETERMINATE $REPO/$WF conclusion='$CONC'"
      INDET=$((INDET + 1)) ;;
    *)
      echo "  x $LABEL ($REPO): last completed run = $CONC ($WHEN)"
      log "RED $REPO/$WF $CONC $WHEN $RUNURL"
      RED=$((RED + 1))
      RED_DETAIL="$RED_DETAIL%0A- $REPO/$WF: $CONC ($WHEN)%0A  $RUNURL" ;;
  esac
done <<EOF
$(printf '%s\n' "$WATCHED")
EOF

if [ "$CHECKED" -eq 0 ]; then
  # We build this list, so an empty one is a defect in the config, not a fact about
  # the world — refuse rather than report a confident all-clear over nothing.
  echo "  x watch list is EMPTY — nothing was checked"
  log "INDETERMINATE empty watch list"
  verdict INDETERMINATE; exit 0
fi

if [ "$RED" -gt 0 ]; then
  MSG="🟡 AlgoVault Alert%0A%0A${RED} cross-repo CI workflow(s) RED${RED_DETAIL}%0A%0AAction: dispatch OPS-XREPO-CI-RED-W{NEXT}%0ASource: ops/cron/xrepo-ci-conclusion-canary.sh"
# ── THE ALERT INVOCATION — corrected 2026-08-21 (OPS-CI-MAIN-WRITER-HARDEN-W1 CH1, Q3) ──────
#
# send_telegram.sh's fire contract is POSITIONAL and always has been:
#     # Usage: send_telegram.sh <alert_id> <severity> [body_file|-]
#     ALERT_ID="${1:?alert_id required}"  SEVERITY="${2:?severity required}"  BODY_INPUT="${3:--}"
#
# This script called it with ENVIRONMENT variables and one positional, so `$1` was the MESSAGE
# and `$2` was unset: the wrapper died on `severity required` before reaching any send, and the
# `|| log "send_telegram.sh failed (fail-open)"` tail swallowed it into a log nobody reads.
#
# MEASURED on the live host 2026-08-21: this script's env-var form returns `line 56: 2: severity
# required` and sends nothing; the positional form reaches the fire path (the wrapper logs
# `[xrepo_ci_red] SUPPRESSED_TEST_CONTEXT` under ALGOVAULT_TG_TEST_INERT=1, i.e. it parsed the id
# and severity and stopped only at the deliberate test gate). `xrepo_ci` appears ONCE in the
# wrapper's entire log. It is the ONLY host caller using the env-var form — every other one of
# the ~30 is positional.
#
# So BOTH of this script's alerts have been dark since its first commit (ad32064,
# OPS-MARKETPLACE-CANARY-REPAIR-W1, 2026-08-06) — a script written specifically to fix a dark
# alert, shipping the same class of defect in its own alerter. Found only because
# OPS-CI-MAIN-WRITER-HARDEN-W1's Q3 made "a positive-output run WHERE THE SCHEDULER INVOKES IT"
# an acceptance criterion rather than a formality. Running it by hand in a terminal, which is how
# it had always been checked, hides this completely: the failure is swallowed by the fail-open.
  if [ -x "$SEND" ]; then
    printf '%s' "$MSG" | "$SEND" "xrepo_ci_red" "CRITICAL_PERSISTENT" - >/dev/null 2>&1 || log "send_telegram.sh failed (fail-open)"
  else
    log "send_telegram.sh not executable at $SEND — alert NOT sent (fail-open)"
    echo "  ! alerter missing at $SEND — a RED workflow went unannounced"
  fi
  verdict FAIL; exit 0
fi

# A canary that cannot answer must not be quietly content. CLAUDE.md: a dark guard
# exiting 0 is indistinguishable from a healthy one, so persistent INDETERMINATE
# escalates on its own rather than waiting to be noticed — which is precisely what
# nobody did for the 40 runs that motivated this script.
STATE="${XREPO_CI_STATE:-/var/lib/algovault-monitoring/xrepo-ci-indet-streak}"
if [ "$INDET" -gt 0 ]; then
  STREAK=$(cat "$STATE" 2>/dev/null || echo 0)
  case "$STREAK" in ''|*[!0-9]*) STREAK=0 ;; esac
  STREAK=$((STREAK + 1))
  echo "$STREAK" > "$STATE" 2>/dev/null || true
  echo "  checked $CHECKED workflow(s): $INDET indeterminate, 0 red (consecutive indeterminate runs: $STREAK)"
  if [ "$STREAK" -ge 3 ]; then
    MSG="🟡 AlgoVault Alert%0A%0Across-repo CI canary has been UNABLE TO VERIFY for ${STREAK} consecutive runs.%0AIt is dark, not green — no workflow conclusion has been read.%0ALikely cause: GitHub API rate limit (unauthenticated 60/hr per IP, shared with everything else on this host).%0A%0AAction: dispatch OPS-XREPO-CI-CANARY-DARK-W{NEXT}%0ASource: ops/cron/xrepo-ci-conclusion-canary.sh"
    if [ -x "$SEND" ]; then
      # Positional, for the same reason as the RED path above.
      printf '%s' "$MSG" | "$SEND" "xrepo_ci_dark" "CRITICAL_PERSISTENT" - >/dev/null 2>&1 || log "send_telegram.sh failed (fail-open)"
    fi
    log "DARK streak=$STREAK — escalated"
  fi
  verdict INDETERMINATE; exit 0
fi

echo 0 > "$STATE" 2>/dev/null || true
echo "  checked $CHECKED workflow(s): all green"
verdict PASS; exit 0
