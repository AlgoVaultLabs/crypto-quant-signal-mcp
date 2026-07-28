#!/usr/bin/env bash
# OPS-STRIPE-WEBHOOK-EVENT-SUBSCRIPTION-W1 (R3) — host-side monthly Stripe webhook
# enabled_events drift canary. Runs check-stripe-webhook-events.mjs (which asserts the
# live endpoint's enabled_events ⊇ the handler's processed set) and pages via
# send_telegram.sh ONLY on drift (exit 1). Canary-infra errors (exit 2) are log-only
# (fail-open). send_telegram.sh owns the severity / cooldown / DRY_RUN_TG / fail-open
# gates — this wrapper MUST NOT re-implement them (per the monitoring alert contract).
#
# Install: scp this + check-stripe-webhook-events.mjs to /opt/algovault-monitoring/;
#   cron (monthly, off-:00):  19 8 1 * * /opt/algovault-monitoring/stripe-webhook-events-canary.sh
set -uo pipefail

SELF_DIR=/opt/algovault-monitoring
MCP=crypto-quant-signal-mcp-mcp-server-1
LOG=/var/log/stripe-webhook-events-canary.log
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Source the live key from the running container env (never persisted to a host file).
SECRET=$(docker exec "$MCP" printenv STRIPE_SECRET_KEY 2>/dev/null || true)

BODY=$(STRIPE_SECRET_KEY="$SECRET" node "$SELF_DIR/check-stripe-webhook-events.mjs" 2>>"$LOG")
RC=$?
echo "$TS rc=$RC $(printf '%s' "$BODY" | head -1)" >> "$LOG"

if [ "$RC" -eq 1 ]; then
  # DRIFT → page (send_telegram.sh enforces CRITICAL_PERSISTENT + 24h cooldown + fail-open
  # + resolves the OPS-...-W{NEXT} template from status.md).
  printf '%s\n' "$BODY" | "$SELF_DIR/send_telegram.sh" STRIPE_WEBHOOK_EVENT_DRIFT CRITICAL_PERSISTENT -
fi
# rc=0 clean (no page); rc=2 canary-infra error (logged above, fail-open, no page).
exit 0
