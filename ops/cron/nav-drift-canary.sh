#!/usr/bin/env bash
# ops/cron/nav-drift-canary.sh — NAV-PLATFORM-GENERATOR-W1 CH5 (2026-07-12)
#   REWIRED 2026-08-12 by OPS-DRIFT-CANARY-INVOCATION-FIX-W1.
#
# Belt-and-suspenders guard on the unified-nav single-derivation invariant: every SERVED landing
# page's <!-- NAV:START/END --> region MUST byte-match the ONE model (dist/lib/site-nav.js
# renderSiteNav() ← nav-manifest.ts), and no nav-bearing page may be missing the markers.
#
# ── WHAT CHANGED AND WHY (do not restore the old invocation) ─────────────────────────────
# This ran `docker exec <app-ctr> node scripts/build_nav.mjs --check`. Three defects at once:
#   1. The image ships no scripts/build_nav.mjs (measured 2026-08-12: /app/scripts/ holds only
#      fetchers/, funnel-by-channel.mjs, refresh-knowledge-pages.mjs).
#   2. Its stated subject is the SERVED HTML, which Caddy serves from the HOST webroot
#      /var/www/algovault — so even a working in-container run read the wrong bytes.
#   3. 10 of the 36 nav pages are absent from the image entirely, so they were uncheckable.
#
# And the inventory's recorded root cause was INVERTED. Line 41 read `[ "$RC" -ne 1 ]`, which
# swallows everything EXCEPT rc=1 — while node's MODULE_NOT_FOUND throw exits exactly 1. Measured
# on signal-1 under ALGOVAULT_TG_TEST_INERT=1, this script reached its DRIFT branch and called
# send_telegram.sh. So it was never a dark guard: installed, it would have FALSE-PAGED every week
# blaming "a host-side manual edit of the deployed HTML" for a missing module.
#
# It now consumes the shared served-page checker, which FETCHES the served page (the shape
# ops/cron/docs-drift-canary.sh already proved) and compares it to the one canonical render.
#
# ── CONTRACT ─────────────────────────────────────────────────────────────────────────────
# Ships ONLY the pure alert branch (severity CRITICAL_PERSISTENT + the OPS-<CLASS>-W{NEXT}
# recommended-wave template). send_telegram.sh OWNS the severity gate, 24h-per-alert_id cooldown,
# resolver, ALGOVAULT_TG_TEST_INERT + DRY_RUN_TG gates, and fail-open.
#
# This script is NO LONGER blanket fail-open. It gates on the helper's VERDICT TOKEN, never on an
# exit code, and a "cannot check" outcome ESCALATES rather than exiting 0 silently — a dark guard
# exiting 0 is indistinguishable from a healthy one, which is the class this wave retires.
#
# Installed crontab (weekly, off-:00 per snapshot-sampler discipline): 39 8 * * 2 (Tue 08:39 UTC).
# :39 is collision-free in hour 8 on this box; offset min(39,21)=21 >= min_offset_minutes 3.
set -uo pipefail

REPO="${NAV_DRIFT_REPO:-/opt/crypto-quant-signal-mcp}"
HELPER="${NAV_DRIFT_HELPER:-$REPO/ops/monitoring/served-region-check.mjs}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
SEND="${NAV_DRIFT_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${NAV_DRIFT_LOG:-/var/log/nav-drift-canary.log}"
ALERT_ID="NAV_REGION_DRIFT"
REGION="nav"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

# Pure alert branch. send_telegram.sh's interface is POSITIONAL: `send_telegram.sh <alert_id>
# <severity> [body_file|-]`; the body (incl the OPS-<CLASS>-W{NEXT} template, resolved at
# send-time) is piped via stdin. (OPS-DOCS-JSONLD-TOOLCOUNT-W1 R3: the prior --flag form was
# silently SUPPRESSED_SEVERITY — the flags landed in the alert_id/severity slots.)
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
# (A guard that resolves paths relative to a checkout goes structurally dark once installed to
# /opt; these two checks are what make that visible instead of green.)
if [ ! -x "$NODE_BIN" ] && ! command -v node >/dev/null 2>&1; then
  log "INDETERMINATE: node not found (NODE_BIN=$NODE_BIN)"
  alert "🛑 ${ALERT_ID}
Nav region canary could not run: node is not available on the host (NODE_BIN=${NODE_BIN}).
The served-page nav check has NOT run — this is an unverified state, not a clean one.
Recommended wave: OPS-NAV-DRIFT-RESTORE-W{NEXT}"
  exit 3
fi
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

if [ ! -r "$HELPER" ]; then
  log "INDETERMINATE: shared checker unreadable at $HELPER"
  alert "🛑 ${ALERT_ID}
Nav region canary could not run: the shared served-page checker is unreadable at ${HELPER}.
The host checkout (${REPO}) may be missing or stale. The check has NOT run — unverified, not clean.
Recommended wave: OPS-NAV-DRIFT-RESTORE-W{NEXT}"
  exit 3
fi

# ── Run the shared checker. Gate on the TOKEN, never the exit code ──────────────────────
OUT=$("$NODE_BIN" "$HELPER" --region="$REGION" 2>&1); RC=$?
VERDICT=$(printf '%s\n' "$OUT" | sed -n "s/^SERVED_REGION_VERDICT=//p" | tail -1)
SUMMARY=$(printf '%s\n' "$OUT" | grep -m1 '^region=' || true)

case "$VERDICT" in
  PASS)
    log "OK: ${SUMMARY:-served nav regions in sync} (rc=$RC)"
    exit 0
    ;;
  FAIL)
    log "DRIFT: ${SUMMARY:-nav region drift} (rc=$RC)"
    alert "🛑 ${ALERT_ID}
Nav region drift on the live site — a SERVED landing page's injected nav no longer matches the single-derivation model (dist/lib/site-nav.js renderSiteNav()) or is missing its <!-- NAV:START/END --> markers.
${SUMMARY}
$(printf '%s\n' "$OUT" | sed -n '/^  \(drifted\|missing markers\):/,/^[^ ]/p' | head -12)
Likely a host-side edit of the deployed HTML, or a webroot sync that published a bad bake (ops/cron/snapshot-landing-daily.sh writes /var/www/algovault daily).
Recover: redeploy from main (build_nav re-injects), then re-run \`${HELPER} --region=${REGION}\`.
Recommended wave: OPS-NAV-DRIFT-RESTORE-W{NEXT}"
    exit 1
    ;;
  INDETERMINATE)
    log "INDETERMINATE: ${SUMMARY:-could not verify} (rc=$RC)"
    alert "🛑 ${ALERT_ID}
Nav region canary could NOT verify the served pages — this is an unverified state, not a clean one.
${SUMMARY}
$(printf '%s\n' "$OUT" | sed -n '/^  unfetchable:/,/^[^ ]/p' | head -8)
Common causes: the canonical render is unreachable (host dist/ unusable AND docker exec failed), or one or more served pages could not be fetched.
Recommended wave: OPS-NAV-DRIFT-RESTORE-W{NEXT}"
    exit 3
    ;;
  *)
    # No token at all = the checker died before printing one. Never read as a pass.
    log "INDETERMINATE: no ${ALERT_ID} verdict token in checker output (rc=$RC): $(printf '%s' "$OUT" | head -c 300)"
    alert "🛑 ${ALERT_ID}
Nav region canary produced NO verdict token (rc=${RC}) — the shared checker died before reporting.
The check has NOT run. Treat as unverified, never as clean.
Recommended wave: OPS-NAV-DRIFT-RESTORE-W{NEXT}"
    exit 3
    ;;
esac
