#!/usr/bin/env bash
# edge-crawler-report-canary.sh — daily host driver for the edge AI-crawler visibility reporter.
#
# GEO-EDGE-LOG-VISIBILITY-W1 / R5.2 + R5.3. Wave 4 of 4, arc close.
#
# THIS IS A REPORTER DRIVER, NOT A GATE DRIVER — and the distinction is the whole reason it is a
# separate file from robots-ai-allowlist-canary.sh rather than another branch inside it. That
# canary's BREACH means "crawl policy is broken", which is an operator-action-required fact. A
# failure to reach Cloudflare's analytics API is not that. Folding the two together would mean a
# Cloudflare outage paging with the same severity as our robots.txt being overwritten, and the
# first time that happened the gate would start being ignored. So: the reporter emits NO
# *_VERDICT token, and this wrapper raises exactly ONE alarm condition.
#
# THE ONE ALARM: a crawler that appeared in the trailing 7-day series has been at ZERO for 3
# consecutive days. That is the signal worth waking a human for — a crawler that stopped coming.
# Deliberately NOT alarmed on: volume changes (noisy and self-correcting), a daily summary
# (chatter), or the reporter failing to run (that is a reporting gap, visible in the series as a
# recorded INDETERMINATE, not an operator action).
#
# NO AUTO-RECOVERY ARM, BY DESIGN. The response to a crawler leaving is investigation — read the
# series, check robots.txt, check the content signal. There is nothing an unattended job could
# safely mutate, and per the recovery LAW it must never mutate a policy surface anyway.
#
# SINGLE DERIVATION: this wrapper owns no logic. It runs the committed reporter out of the deploy
# checkout at /opt/crypto-quant-signal-mcp, so the reporter AND the crawler list it reads
# (src/lib/ai-crawler-allowlist.ts — the same constant robots.txt, the allowlist gate and the
# api-catalog generator use) are the bytes CI tested. Nothing is vendored here.
#
# Alert contract: send_telegram.sh OWNS the severity gate, the 24h-per-alert_id cooldown, the
# recommended_wave {NEXT} resolver and the INERT/DRY_RUN gates. Never re-implement them here.
# For a REPEATED smoke use ALGOVAULT_TG_TEST_INERT=1 (suppresses BEFORE the cooldown gate and
# writes NO marker). DRY_RUN_TG=1 DOES write the marker, so back-to-back dry runs false-green.
#
# Exit: always 0 on the live path. A reporting failure must not bounce cron, and must not look
# like a policy failure to anything reading exit codes.
set -uo pipefail

ALERT_ID="EDGE_CRAWLER_DISAPPEARED"
SEND="${EDGE_CANARY_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${EDGE_CANARY_LOG:-/var/log/edge-crawler-report.log}"
REPORTER="${EDGE_CANARY_REPORTER:-/opt/crypto-quant-signal-mcp/scripts/edge-crawler-report.mjs}"
ENV_FILE="${EDGE_CANARY_ENV:-/opt/crypto-quant-signal-mcp/.env}"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*" | tee -a "$LOG" 2>/dev/null || true; }

run_report() {
  # The credential lives in exactly one place on this box and is never echoed. Sourcing in a
  # subshell keeps it out of this script's own environment for anything that follows.
  ( set -a; . "$ENV_FILE" 2>/dev/null; set +a; node "$REPORTER" --daily 2>&1 )
}

if [ "${1:-}" = "--self-test" ]; then
  checked=0; fails=()
  expect() { # expect <want> <reporter-output> <label>
    local want="$1" out="$2" label="$3" got
    checked=$((checked + 1))
    if printf '%s\n' "$out" | grep -q '^  ALARM:'; then got=ALARM; else got=QUIET; fi
    [ "$got" = "$want" ] || fails+=("$label (want $want got $got)")
  }
  expect ALARM "$(printf '  alarm: none\n  ALARM: 1 crawler(s) at zero for 3 consecutive days: GPTBot\n')" \
         'an ALARM line is detected'
  expect QUIET "$(printf '  alarm: none (no allowlisted crawler has gone quiet for 3 consecutive days)\n')" \
         'the quiet line is NOT read as an alarm'
  expect QUIET "$(printf 'edge-crawler-report --daily\n  instrument=edge:graphql status=OK queries=1/300\n')" \
         'a run with no alarm line at all is quiet'
  expect QUIET "" 'empty output is quiet, not a phantom alarm'
  # The substring trap this shape invites: "alarm: none" contains "alarm", and an unanchored
  # grep would read every healthy run as a fire. The ^  ALARM: anchor is what prevents it, and
  # this assertion is here so a future edit cannot quietly drop the anchor.
  expect QUIET "$(printf '  alarm: none (no allowlisted crawler has gone quiet)\n  ALARM_LIKE_BUT_NOT: x\n')" \
         'a near-miss token is not an alarm'
  # Bypassed-seam assertions: --self-test never runs the reporter or the sender, so the paths
  # they resolve to are asserted directly rather than left dark.
  checked=$((checked + 1))
  # Assert the DEFAULT, read from this file, not $REPORTER — a smoke run legitimately overrides
  # the variable, and asserting the override would make the check untestable outside the host.
  grep -q 'EDGE_CANARY_REPORTER:-/opt/crypto-quant-signal-mcp/scripts/edge-crawler-report.mjs' "$0" \
    || fails+=('default reporter path is not inside the deploy checkout')
  checked=$((checked + 1))
  [ "$ALERT_ID" = "EDGE_CRAWLER_DISAPPEARED" ] \
    || fails+=('alert id drifted from the inventory row')
  checked=$((checked + 1))
  # Comments stripped first: the reporter's own docblock states that it emits NO verdict token,
  # and a naive grep would match that sentence and demand deleting the documentation. Same
  # invocation-vs-mention rule the repo's other ban-greps use.
  if [ -r "$REPORTER" ] && grep -vE '^[[:space:]]*(\*|//|/\*)' "$REPORTER" | grep -q '_VERDICT='; then
    fails+=('the reporter EMITS a verdict token - it must not; a reporter is not a gate')
  fi

  if [ "$checked" -lt 8 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 8)"; exit 3
  fi
  if [ "${#fails[@]}" -gt 0 ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${#fails[@]}/$checked: ${fails[*]}"; exit 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked/$checked"
  exit 0
fi

OUT="$(run_report)"
printf '%s\n' "$OUT" >> "$LOG" 2>/dev/null || true

STATUS_LINE="$(printf '%s\n' "$OUT" | grep -m1 'instrument=edge:graphql' || true)"
log "run complete: ${STATUS_LINE:-<no status line>}"

# Anchored on the line start AND the colon: `alarm: none (...)` also contains the word, and an
# unanchored match would fire on every healthy run.
if printf '%s\n' "$OUT" | grep -q '^  ALARM:'; then
  DETAIL="$(printf '%s\n' "$OUT" | grep -m1 '^  ALARM:')"
  log "ALARM: $DETAIL"
  { cat <<EOF
An AI crawler that was reaching algovault.com has stopped.

$DETAIL

Instrument: edge:graphql (Cloudflare GraphQL Analytics, zone-scoped Analytics:Read).
Series: /var/lib/algovault-monitoring/edge-crawler/daily-series.ndjson

This is operator-action-required and has NO auto-recovery arm by design: the response to a
crawler leaving is investigation, not a mutation. Check in this order:
  1. robots.txt still allows it        - npm run check:robots (token must read GREEN)
  2. the content signal is unchanged   - curl -sI https://algovault.com/ | grep -i content-signal
  3. that crawler's status page        - an outage on their side looks identical from here

CAVEAT THAT TRAVELS WITH EVERY NUMBER HERE: identification is user-agent matching, which
Cloudflare documents as spoofable. botDetectionIds_hasany (verified classification) is
Enterprise-only and REFUSED on this zone, so a UA change by the crawler is indistinguishable
from the crawler leaving. Rule that out before concluding anything.
EOF
  } | "$SEND" "$ALERT_ID" WARNING - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
else
  log "quiet: no allowlisted crawler has gone silent for 3 consecutive days"
fi

exit 0
