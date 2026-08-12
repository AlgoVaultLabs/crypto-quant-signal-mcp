#!/usr/bin/env bash
# ops/cron/analytics-drift-canary.sh — OPS-ANALYTICS-TAG-SINGLE-SOURCE-W1 CH5 (2026-07-15)
#   REWIRED 2026-08-12 by OPS-DRIFT-CANARY-INVOCATION-FIX-W1.
#
# Belt-and-suspenders guard on the analytics-tag single-derivation invariant: every SERVED content
# page's <!-- ANALYTICS:START/END --> region MUST byte-match the ONE SoT (dist/lib/analytics-
# snippet.js renderAnalyticsSnippet()), and no content page may be missing the markers.
#
# ── WHAT CHANGED AND WHY (do not restore the old invocation) ─────────────────────────────
# This ran `docker exec <app-ctr> node scripts/build_analytics.mjs --check` — the same defect as
# its nav sibling, and for the same three reasons: the image ships no scripts/build_analytics.mjs,
# the stated subject is the SERVED HTML that Caddy serves from the HOST webroot
# /var/www/algovault, and 24 of the 54 marked pages are Express-served from the image rather than
# the webroot. The inventory's recorded root cause was also INVERTED here: `[ "$RC" -ne 1 ]`
# swallows everything EXCEPT rc=1, and node's MODULE_NOT_FOUND exits exactly 1 — measured on
# signal-1, this script reached its DRIFT branch and called send_telegram.sh. Installed, it would
# have FALSE-PAGED weekly, not gone dark.
#
# It now consumes the shared served-page checker, which FETCHES the served page and compares it to
# the one canonical render. Coverage is TOTAL per build_analytics's own law: every non-excluded
# landing content page (54 today; `_design/` + `_templates/` are the only exclusions).
#
# ── CONTRACT ─────────────────────────────────────────────────────────────────────────────
# Ships ONLY the pure alert branch (severity CRITICAL_PERSISTENT + the OPS-<CLASS>-W{NEXT}
# template). send_telegram.sh OWNS the severity gate, 24h cooldown, resolver, INERT/DRY_RUN gates.
# NO LONGER blanket fail-open: gates on the VERDICT TOKEN, never an exit code, and a "cannot
# check" outcome ESCALATES instead of exiting 0 silently.
#
# Installed crontab (weekly, off-:00 per snapshot-sampler discipline): 9 7 * * 4 (Thu 07:09 UTC).
# :09 is collision-free in hour 7 on this box; offset min(9,51)=9 >= min_offset_minutes 3.
set -uo pipefail

REPO="${ANALYTICS_DRIFT_REPO:-/opt/crypto-quant-signal-mcp}"
HELPER="${ANALYTICS_DRIFT_HELPER:-$REPO/ops/monitoring/served-region-check.mjs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
SEND="${ANALYTICS_DRIFT_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${ANALYTICS_DRIFT_LOG:-/var/log/analytics-drift-canary.log}"
ALERT_ID="ANALYTICS_REGION_DRIFT"
REGION="analytics"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

# Pure alert branch. send_telegram.sh's interface is POSITIONAL: `send_telegram.sh <alert_id>
# <severity> [body_file|-]`; body via stdin (the OPS-<CLASS>-W{NEXT} template resolves at
# send-time). An earlier --flag form was silently SUPPRESSED_SEVERITY.
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
Analytics region canary could not run: node is not available on the host (NODE_BIN=${NODE_BIN}).
The served-page analytics check has NOT run — this is an unverified state, not a clean one.
Recommended wave: OPS-ANALYTICS-DRIFT-RESTORE-W{NEXT}"
  exit 3
fi
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

if [ ! -r "$HELPER" ]; then
  log "INDETERMINATE: shared checker unreadable at $HELPER"
  alert "🛑 ${ALERT_ID}
Analytics region canary could not run: the shared served-page checker is unreadable at ${HELPER}.
The host checkout (${REPO}) may be missing or stale. The check has NOT run — unverified, not clean.
Recommended wave: OPS-ANALYTICS-DRIFT-RESTORE-W{NEXT}"
  exit 3
fi

# ── Run the shared checker. Gate on the TOKEN, never the exit code ──────────────────────
OUT=$("$NODE_BIN" "$HELPER" --region="$REGION" 2>&1); RC=$?
VERDICT=$(printf '%s\n' "$OUT" | sed -n "s/^SERVED_REGION_VERDICT=//p" | tail -1)
SUMMARY=$(printf '%s\n' "$OUT" | grep -m1 '^region=' || true)

case "$VERDICT" in
  PASS)
    log "OK: ${SUMMARY:-every served content page carries the in-sync analytics region} (rc=$RC)"
    exit 0
    ;;
  FAIL)
    log "DRIFT: ${SUMMARY:-analytics region drift} (rc=$RC)"
    alert "🛑 ${ALERT_ID}
Analytics region drift on the live site — a SERVED content page's injected Plausible tag no longer matches the single-derivation SoT (dist/lib/analytics-snippet.js renderAnalyticsSnippet()) or is missing its <!-- ANALYTICS:START/END --> markers. A page missing the tag is a page whose traffic is NOT being measured.
${SUMMARY}
$(printf '%s\n' "$OUT" | sed -n '/^  \(drifted\|missing markers\):/,/^[^ ]/p' | head -12)
Likely a host-side edit of the deployed HTML, or a webroot sync that published a bad bake (ops/cron/snapshot-landing-daily.sh writes /var/www/algovault daily).
Recover: redeploy from main (build_analytics re-injects), then re-run \`${HELPER} --region=${REGION}\`.
Recommended wave: OPS-ANALYTICS-DRIFT-RESTORE-W{NEXT}"
    exit 1
    ;;
  INDETERMINATE)
    log "INDETERMINATE: ${SUMMARY:-could not verify} (rc=$RC)"
    alert "🛑 ${ALERT_ID}
Analytics region canary could NOT verify the served pages — this is an unverified state, not a clean one.
${SUMMARY}
$(printf '%s\n' "$OUT" | sed -n '/^  unfetchable:/,/^[^ ]/p' | head -8)
Common causes: the canonical render is unreachable (host dist/ unusable AND docker exec failed), or one or more served pages could not be fetched.
Recommended wave: OPS-ANALYTICS-DRIFT-RESTORE-W{NEXT}"
    exit 3
    ;;
  *)
    log "INDETERMINATE: no ${ALERT_ID} verdict token in checker output (rc=$RC): $(printf '%s' "$OUT" | head -c 300)"
    alert "🛑 ${ALERT_ID}
Analytics region canary produced NO verdict token (rc=${RC}) — the shared checker died before reporting.
The check has NOT run. Treat as unverified, never as clean.
Recommended wave: OPS-ANALYTICS-DRIFT-RESTORE-W{NEXT}"
    exit 3
    ;;
esac
