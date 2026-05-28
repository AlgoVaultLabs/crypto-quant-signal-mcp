#!/usr/bin/env bash
# funnel-cron-alert.sh
#
# Sends a Telegram CRITICAL alert when the funnel snapshot cron fails.
# Invoked by systemd's OnFailure= directive on algovault-funnel-snapshot.service.
#
# ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): migrated from direct
# `curl https://api.telegram.org/...` to canonical
# `/opt/algovault-monitoring/send_telegram.sh` wrapper invocation per
# CLAUDE.md `wrapper-pure-pipe-subprocess-contract-3rd-consumer-confirmed`
# permanent rule (opportunistic compliance + 7th wrapper consumer
# alongside the new funnel-leak-detector.py as the 6th).
#
# Wrapper handles: severity gate, 24h cooldown per alert_id,
# DRY_RUN_TG=1 gate, fail-open semantics, recommended_wave template
# resolution. Caller (this script) just builds the body + pipes it.

set -euo pipefail

WRAPPER="/opt/algovault-monitoring/send_telegram.sh"
ALERT_ID="FUNNEL_SNAPSHOT_CRON_FAILED"
SEVERITY="CRITICAL_PERSISTENT"

if [ ! -x "${WRAPPER}" ]; then
  echo "[funnel-cron-alert] ERROR: wrapper not executable at ${WRAPPER} — cannot send alert" >&2
  # Fail-open per CLAUDE.md `Recovery alerts are noise, default policy is
  # silent recovery` — don't bounce systemd OnFailure handler.
  exit 0
fi

UNIT_NAME="${1:-algovault-funnel-snapshot.service}"
JOURNAL=$(journalctl -u "${UNIT_NAME}" --since "10 min ago" --no-pager --lines 30 2>&1 || echo "(journal read failed)")

# Compose alert body matching operator-action-required contract shape.
# recommended_wave_template uses W{NEXT} template form per CLAUDE.md
# `Hardcoded recommended_wave strings FORBIDDEN` rule; wrapper PATCH-B
# resolves at fire time via status.md grep.
BODY=$(cat <<EOF
🛑 ${ALERT_ID}
Unit: ${UNIT_NAME}
Host: $(hostname)
Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Last 10 min of journal output:
${JOURNAL}

Action: dispatch OPS-FUNNEL-SNAPSHOT-CRON-FIX-W{NEXT} via Cowork → Claude Code
Audit shape: audits/ACTIVATION-FUNNEL-AUDIT-W1-endpoint-truth.md
Source unit: ${UNIT_NAME}
EOF
)

set +e
echo "${BODY}" | "${WRAPPER}" "${ALERT_ID}" "${SEVERITY}" -
RC=$?
set -e
if [ "${RC}" = "0" ]; then
  echo "[funnel-cron-alert] wrapper exited OK (alert dispatched OR cooldown-suppressed OR DRY_RUN)"
else
  echo "[funnel-cron-alert] wrapper exited ${RC} — see /var/log/send-telegram.log" >&2
fi
exit 0
