#!/usr/bin/env bash
# ops/cron/served-surface-values-canary.sh — OPS-SERVED-SURFACE-CANARY-AND-CLAIM-TRUTH-W1 CH4.
#
# Watches the VALUES the publicly-served surfaces publish, on the deployed host, every day.
#
# ── WHY THIS EXISTS, AND WHY IT IS A CRON AND NOT A WORKFLOW ─────────────────────────────
# `scripts/check-served-surface-values.mjs --live` was documented as "a scheduled canary" in three
# shipped artifacts and was scheduled NOWHERE — no cron, no inventory row, no alert-registry row.
# Two of the five registry surfaces are `live_only`, i.e. covered by a mode that never ran. This
# file is what makes that sentence true.
#
# Host cron rather than a scheduled GitHub Action, for the estate's own recorded reasons:
# send_telegram.sh's 24h cooldown is a marker file under /opt/algovault-monitoring that an
# ephemeral runner cannot persist, and CI must never hold prod credentials — so a CI-scheduled
# canary would declare an alert nothing can raise. A forbidden value on a live public surface is
# operator-action-required, so it needs a real alert with a real cooldown.
#
# ── CONTRACT ─────────────────────────────────────────────────────────────────────────────
# Ships ONLY the pure alert branch (severity CRITICAL_PERSISTENT + the OPS-<CLASS>-W{NEXT}
# template). send_telegram.sh OWNS the severity gate, the 24h cooldown, the resolver and the
# INERT/DRY_RUN gates; consumers must not re-implement them inline.
#
# 🛑 GATES ON THE VERDICT TOKEN, NEVER AN EXIT CODE, and never blanket fail-open. A "cannot check"
# outcome ESCALATES instead of exiting 0 silently. This is the posture of its sibling
# analytics-drift-canary.sh, and deliberately NOT that of docs-drift-canary.sh, which exits 0 on
# every infra error — the older posture that let a dark guard look healthy for weeks.
#
# ── AUTO-RECOVERY IS N/A, DELIBERATELY ───────────────────────────────────────────────────
# Detect -> Recover -> Alert -> Escalate stops at Alert here. A forbidden value on a served surface
# is fixed by a code change and a deploy; there is no idempotent safe-boundary action this script
# could take, and inventing one would be an unattended privileged mutation of public output.
# CRITICAL_PERSISTENT with a named follow-up wave is the correct terminal state.
#
# Installed crontab: 47 7 * * * (daily, 07:47 UTC). Minute 47 is in the canonical off-:00 set and
# its boundary offset is min(47, 60-47) = 13 >= min_offset_minutes 3. Hour 7 is free of every other
# DAILY named job on this box (19 7, 23 7, 27 7, 39 7, 53 7 are taken; 47 7 is not), and it sits
# outside the 18:00-02:59 deploy window.
set -uo pipefail

REPO="${SERVED_SURFACE_REPO:-/opt/crypto-quant-signal-mcp}"
HELPER="${SERVED_SURFACE_HELPER:-$REPO/scripts/check-served-surface-values.mjs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
SEND="${SERVED_SURFACE_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${SERVED_SURFACE_LOG:-/var/log/served-surface-values-canary.log}"
ALERT_ID="SERVED_SURFACE_VALUE_DRIFT"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

# Pure alert branch. send_telegram.sh's interface is POSITIONAL: `send_telegram.sh <alert_id>
# <severity> [body_file|-]`; body via stdin. A --flag form is silently SUPPRESSED_SEVERITY.
alert() {
  local body="$1"
  if [ ! -x "$SEND" ]; then
    log "ESCALATE_UNSENT: send_telegram.sh not executable at $SEND — verdict was not delivered"
    return 0
  fi
  printf '%s\n' "$body" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" \
    || log "ESCALATE_UNSENT: send_telegram invocation failed"
}

# ── Preconditions. An unusable guard is INDETERMINATE-and-escalate, never a silent pass ──
if [ ! -x "$NODE_BIN" ] && ! command -v node >/dev/null 2>&1; then
  log "INDETERMINATE: node not found (NODE_BIN=$NODE_BIN)"
  alert "🛑 ${ALERT_ID}
The served-surface value canary could not run: node is not available on the host (NODE_BIN=${NODE_BIN}).
The public surfaces have NOT been checked — this is an unverified state, not a clean one.
Recommended wave: OPS-SERVED-SURFACE-CANARY-RESTORE-W{NEXT}"
  exit 3
fi
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

if [ ! -r "$HELPER" ]; then
  log "INDETERMINATE: gate script unreadable at $HELPER"
  alert "🛑 ${ALERT_ID}
The served-surface value canary could not run: the gate script is unreadable at ${HELPER}.
The host checkout (${REPO}) may be missing or stale. The check has NOT run — unverified, not clean.
Recommended wave: OPS-SERVED-SURFACE-CANARY-RESTORE-W{NEXT}"
  exit 3
fi

# ── Run the gate. Gate on the TOKEN, never the exit code ────────────────────────────────
OUT=$("$NODE_BIN" "$HELPER" --live 2>&1); RC=$?
VERDICT=$(printf '%s\n' "$OUT" | sed -n "s/^SERVED_SURFACE_VALUES_VERDICT=//p" | tail -1)
SUMMARY=$(printf '%s\n' "$OUT" | grep -m1 '^served-surface values:' || true)

case "$VERDICT" in
  PASS)
    log "OK: ${SUMMARY:-no forbidden value on any checked surface} (rc=$RC)"
    exit 0
    ;;
  # The detail is taken GENERICALLY from the gate's own output, not by matching one phrasing:
  # --live can FAIL for a contract violation OR for a producer/registry enumeration gap, and an
  # earlier draft matched only the first, so an enumeration FAIL paged with an empty body. A body
  # that says nothing is indistinguishable from one that found nothing.
  FAIL)
    log "DRIFT: ${SUMMARY:-forbidden value on a served surface} (rc=$RC)"
    alert "🛑 ${ALERT_ID}
A publicly-served surface is publishing a FORBIDDEN VALUE, or has stopped publishing a required one.
${SUMMARY}
$(printf '%s\n' "$OUT" | grep -vE '^SERVED_SURFACE_VALUES_VERDICT=|^served-surface registry:' | tail -14)
These surfaces are unauthenticated, listed in .well-known/api-catalog and deliberately fed to AI
crawlers, so a wrong value here propagates into LLM answers about AlgoVault.
Auto-recovery is N/A by design: this needs a code change and a deploy, not an unattended mutation
of public output. Check the named assertion's \`reason\` in its dated contract under audits/.
Recommended wave: OPS-SERVED-SURFACE-VALUE-DRIFT-W{NEXT}"
    exit 1
    ;;
  INDETERMINATE)
    log "INDETERMINATE: ${SUMMARY:-could not verify} (rc=$RC)"
    alert "🛑 ${ALERT_ID}
The served-surface value canary could NOT verify the public surfaces — an unverified state, never a clean one.
$(printf '%s\n' "$OUT" | grep -vE '^SERVED_SURFACE_VALUES_VERDICT=' | tail -8)
Common causes: a surface or the .well-known/api-catalog producer was unreachable (transport is
INDETERMINATE, never FAIL), a contract path did not resolve against the body (shape divergence),
or the host checkout is stale.
Recommended wave: OPS-SERVED-SURFACE-CANARY-RESTORE-W{NEXT}"
    exit 3
    ;;
  *)
    log "INDETERMINATE: no ${ALERT_ID} verdict token in gate output (rc=$RC): $(printf '%s' "$OUT" | head -c 300)"
    alert "🛑 ${ALERT_ID}
The served-surface value canary produced NO verdict token (rc=${RC}) — the gate died before reporting.
The check has NOT run. Treat as unverified, never as clean.
$(printf '%s\n' "$OUT" | tail -6)
Recommended wave: OPS-SERVED-SURFACE-CANARY-RESTORE-W{NEXT}"
    exit 3
    ;;
esac
