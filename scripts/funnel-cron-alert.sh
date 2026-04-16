#!/usr/bin/env bash
# funnel-cron-alert.sh
#
# Sends a Telegram CRITICAL alert when the funnel snapshot cron fails.
# Invoked by systemd's OnFailure= directive on algovault-funnel-snapshot.service.
#
# Env vars (sourced from /etc/algovault/funnel-snapshot.env + the mcp-server
# container's TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID via docker inspect):
#   TELEGRAM_BOT_TOKEN — the Telegram Bot API token
#   TELEGRAM_CHAT_ID   — the chat ID for alerts (same as the monitor uses)

set -euo pipefail

# Source env for DATABASE_URL (which also contains the Telegram creds if
# appended to /etc/algovault/funnel-snapshot.env during setup).
[ -f /etc/algovault/funnel-snapshot.env ] && source /etc/algovault/funnel-snapshot.env

# If Telegram creds aren't in the env file, try to read them from the
# running mcp-server container (which gets them from docker-compose .env).
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  TELEGRAM_BOT_TOKEN=$(docker inspect crypto-quant-signal-mcp-mcp-server-1 \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep '^TELEGRAM_BOT_TOKEN=' | cut -d= -f2 || true)
  TELEGRAM_CHAT_ID=$(docker inspect crypto-quant-signal-mcp-mcp-server-1 \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep '^TELEGRAM_CHAT_ID=' | cut -d= -f2 || true)
fi

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "[funnel-cron-alert] WARN: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not available — cannot send alert" >&2
  exit 1
fi

UNIT_NAME="${1:-algovault-funnel-snapshot.service}"
JOURNAL=$(journalctl -u "${UNIT_NAME}" --since "10 min ago" --no-pager --lines 30 2>&1 || echo "(journal read failed)")

# Telegram sendMessage with Markdown parse mode.
# Escape backticks and newlines for the Telegram API.
TEXT="🛑 *CRITICAL: Funnel snapshot cron failed*

Unit: \`${UNIT_NAME}\`
Host: \`$(hostname)\`
Time: \`$(date -u +%Y-%m-%dT%H:%M:%SZ)\`

\`\`\`
${JOURNAL}
\`\`\`"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg chat_id "${TELEGRAM_CHAT_ID}" --arg text "${TEXT}" '{chat_id: $chat_id, text: $text, parse_mode: "Markdown"}')" \
  2>/dev/null || echo "000")

if [ "${HTTP_CODE}" = "200" ]; then
  echo "[funnel-cron-alert] Telegram alert sent (HTTP ${HTTP_CODE})"
else
  echo "[funnel-cron-alert] Telegram alert FAILED (HTTP ${HTTP_CODE})" >&2
fi
