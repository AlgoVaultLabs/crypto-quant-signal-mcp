#!/usr/bin/env bash
# OPS-MONITORING-TELEGRAM-INTEGRATION-W1 + PATCH-A + OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1 PATCH-B
# Reusable Telegram alert wrapper.
# Usage: send_telegram.sh <alert_id> <severity> [body_file|-]
#   body via stdin if 3rd arg is "-" or omitted.
#
# CONTRACT (CLAUDE.md ## Automation-first recovery → Operator-action-required alert contract):
#   TG fires ONLY when:
#     (a) severity == CRITICAL_PERSISTENT, AND
#     (b) cooldown elapsed (24h per alert_id), AND
#     (c) DRY_RUN_TG env var is unset/0.
#   All other paths log silently. Fail-open exit 0 on every error path.
#
# PATCH-B (RECRESOLVER-W1): resolve_template() substitutes OPS-<CLASS>-W{NEXT} placeholders
#   in the body by greping /var/lib/algovault-monitoring/status.md for highest-completed
#   GREEN W<N> of the class. Runs AFTER body read + AFTER cooldown gate + BEFORE DRY_RUN
#   gate, so DRY_RUN_FIRED + FIRED log lines reflect the RESOLVED body.

set -euo pipefail

ALERT_ID="${1:?alert_id required}"
SEVERITY="${2:?severity required}"
BODY_INPUT="${3:--}"

LOG=/var/log/algovault-monitoring-telegram.log
STATE_DIR=/opt/algovault-monitoring/.alert-state
COOLDOWN_SEC=86400  # 24h per CLAUDE.md operator-action-required contract

mkdir -p "$STATE_DIR"

# `|| true` is LOAD-BEARING: under `set -euo pipefail` an unwritable $LOG made the FIRST log()
# call abort the wrapper, so every alert from a non-root caller died silently — the editorial units
# run as User=algovault against a root-owned log. The header promises fail-open on every error path;
# a logging failure must never be able to swallow an operator alert.
# (OPS-AUTOPUB-FULL-REVIEW-FIX-W1 C5. The perms themselves are fixed too, incl. the logrotate
# `create` line that regenerated them weekly — but the code must not depend on that.)
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG" 2>/dev/null || true; }

# === PATCH-B: resolve_template() — substitutes OPS-<CLASS>-W{NEXT} via status.md grep ===
# Reads STATUS_MD_PATH (default /var/lib/algovault-monitoring/status.md, refreshed per
# CLAUDE.md ## Execution flow step 6 SOP after every wave's status.md append).
# Behavior:
#   - Class has GREEN history: substitute W{NEXT} → W<max+1> (MAX-W<N> via grep -oE | sort -n | tail -1)
#   - Class has zero GREEN history (greenfield): substitute → W1 + log RESOLVER_MISS
#   - status.md unreachable OR regex extract fails: ship placeholder verbatim + log RESOLVER_MISS
# Three RESOLVER_MISS reasons enumerated: reachable_status_md_path_not_found,
# no_completed_waves_for_class, regex_extract_failed.
resolve_template() {
  local body="$1"
  local status_path="${STATUS_MD_PATH:-/var/lib/algovault-monitoring/status.md}"
  if [[ ! -r "$status_path" ]]; then
    log "RESOLVER_MISS: template=<not-extracted> reason=reachable_status_md_path_not_found"
    echo "$body"
    return 0
  fi
  local templates
  templates=$(echo "$body" | grep -oE 'OPS-[A-Z0-9-]+-W\{NEXT\}' | sort -u || true)
  if [[ -z "$templates" ]]; then
    echo "$body"
    return 0
  fi
  local tpl class highest next
  while IFS= read -r tpl; do
    [[ -z "$tpl" ]] && continue
    class="${tpl%-W\{NEXT\}}"
    # OPS-CLOSEDBAR-LIVENESS-BAND-W1 R4. The prior pattern was
    #   ^### .* — ${class}-W[0-9]+ — .*GREEN
    # which demands " — " IMMEDIATELY AFTER the wave id. CLAUDE.md MANDATES a
    # "(Target ICP tier(s): …)" block in exactly that position, so it could never match a
    # conforming entry. MEASURED 2026-08-07: 96 `OPS-*-W<N>` headings in status.md, ZERO
    # matches — this resolver had NEVER resolved anything for ANY class, so every templated
    # recommended_wave it shipped said "W1", a COMPLETED wave whenever the class had one.
    # A regex that encodes a format its own SoT does not produce is a dark guard.
    # Anchor on the wave id; require GREEN anywhere on the heading (accepting
    # GREEN_WITH_CAVEAT / GREEN_RETROACTIVE_CLOSE, which are completions too).
    highest=$(grep -oE "^### .*${class}-W[0-9]+.*GREEN" "$status_path" 2>/dev/null \
              | grep -oE "${class}-W[0-9]+" | grep -oE '[0-9]+$' | sort -n | tail -1 || true)
    if [[ -z "$highest" ]]; then
      # Ship the placeholder VERBATIM — exactly what this file's header has always documented.
      # The prior code asserted W1: a CONFIDENT WRONG ANSWER, strictly worse than an unresolved
      # template, because the operator cannot tell it was a guess.
      log "RESOLVER_MISS: template=${tpl} reason=no_completed_waves_for_class (placeholder shipped verbatim)"
      continue
    fi
    next=$((highest + 1))
    if ! [[ "$next" =~ ^[0-9]+$ ]]; then
      log "RESOLVER_MISS: template=${tpl} reason=regex_extract_failed"
      continue
    fi
    # Never hand the operator a wave that already shipped — re-running a completed wave is not
    # a remedy, and this alert family has now produced that Action line twice.
    if grep -qE "^### .*${class}-W${next}.*GREEN" "$status_path" 2>/dev/null; then
      log "RESOLVER_MISS: template=${tpl} reason=resolved_wave_already_green (${class}-W${next}); placeholder shipped verbatim"
      continue
    fi
    body="${body//${tpl}/${class}-W${next}}"
  done <<< "$templates"
  echo "$body"
}

# Severity gate
if [[ "$SEVERITY" != "CRITICAL_PERSISTENT" ]]; then
  log "SUPPRESSED_SEVERITY: severity=$SEVERITY not in TG-fire set"
  exit 0
fi

# ── TEST-CONTEXT GATE (OPS-AUTOPUB-TEST-ALERT-LEAK-W1, 2026-07-22) ────────────────────────
# No alert may originate from a test process.
#
# WHY HERE AND NOT IN THE CALLERS: this wrapper is the single choke point for ALL Telegram
# egress, and node/vitest child processes inherit the parent env, so one gate here covers every
# current AND future consumer in any language — instead of each caller remembering to inject a
# stub. `lib/drafter.mjs` and `lib/anchor-numeric-claims.mjs` already accept an injectable
# `invoker` for exactly this, but the DEFAULT is the real wrapper, so any test that drives the
# module end-to-end (rather than calling the alert fn directly) fires for real. That happened on
# 2026-07-22T12:43:22Z: `tests/unit/drafter.test.mjs` runs the real drafter against a fake
# `claude` that emits malformed output, retries exhausted, and the escalation paged the operator
# with test-fixture text.
#
# DELIBERATELY BEFORE THE COOLDOWN GATE, and it does NOT write the marker. The dangerous half of
# that incident was not the spurious message — it was that firing WROTE the 24h cooldown marker,
# which would have SILENCED the next genuine drafter failure. A test run must leave production
# alert state untouched.
#
# Backward-compatible: both vars are unset in production, so prod behaviour is byte-identical.
# Forward-compatible: ALGOVAULT_TG_TEST_INERT is the explicit escape hatch for non-node harnesses.
if [[ -n "${NODE_TEST_CONTEXT:-}" || -n "${VITEST:-}" || "${ALGOVAULT_TG_TEST_INERT:-0}" == "1" ]]; then
  log "SUPPRESSED_TEST_CONTEXT: alert raised from a test process (NODE_TEST_CONTEXT=${NODE_TEST_CONTEXT:-} VITEST=${VITEST:-} ALGOVAULT_TG_TEST_INERT=${ALGOVAULT_TG_TEST_INERT:-0}); no POST, no cooldown marker"
  exit 0
fi

# Cooldown gate
MARKER="$STATE_DIR/${ALERT_ID}-last-fired-at"
if [[ -f "$MARKER" ]]; then
  LAST=$(cat "$MARKER")
  NOW=$(date +%s)
  AGE=$((NOW - LAST))
  if [[ $AGE -lt $COOLDOWN_SEC ]]; then
    HRS=$((AGE / 3600))
    log "SUPPRESSED_COOLDOWN: last fired ${HRS}h ago (cooldown ${COOLDOWN_SEC}s)"
    exit 0
  fi
fi

# Source TG credentials
if [[ ! -r /etc/algovault-monitoring/env ]]; then
  log "FAILED_NO_ENV: /etc/algovault-monitoring/env not readable"
  exit 0  # fail-open per contract row 5
fi
# shellcheck disable=SC1091
. /etc/algovault-monitoring/env
: "${TELEGRAM_BOT_TOKEN:?TG token unset}" "${TELEGRAM_CHAT_ID:?chat id unset}"

# Read body
if [[ "$BODY_INPUT" == "-" ]]; then
  BODY=$(cat)
else
  BODY=$(cat "$BODY_INPUT")
fi

# === PATCH-B: resolver invocation — AFTER body-read, AFTER cooldown, BEFORE DRY_RUN gate ===
BODY=$(resolve_template "$BODY")
BODY_LOG=$(echo "$BODY" | tr '\n' ' ' | head -c 1500)

# PATCH-A: DRY_RUN_TG gate — synthetic smokes + cred probes go through ALL gate logic
# but skip the actual TG POST. Marker is still written so cooldown-suppression smokes work.
if [[ "${DRY_RUN_TG:-0}" == "1" ]]; then
  date +%s > "$MARKER"
  log "DRY_RUN_FIRED: TG POST skipped (DRY_RUN_TG=1); marker written for cooldown smokes; body=${BODY_LOG}"
  exit 0
fi

# Post to TG (fail-open: log error but exit 0 so caller cron doesn't bounce)
TMP_RESP=$(mktemp /tmp/.tg-resp-XXXXXX)
HTTP_CODE=$(curl -sS -o "$TMP_RESP" -w "%{http_code}" -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${BODY}" \
  --max-time 10 || echo "000")

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  date +%s > "$MARKER"
  log "FIRED: HTTP $HTTP_CODE body=${BODY_LOG}"
  rm -f "$TMP_RESP"
  exit 0
else
  RESP=$(head -c 500 "$TMP_RESP" 2>/dev/null || echo "")
  log "FAILED_TG_API: HTTP $HTTP_CODE response='${RESP}'"
  rm -f "$TMP_RESP"
  exit 0  # fail-open per contract
fi
