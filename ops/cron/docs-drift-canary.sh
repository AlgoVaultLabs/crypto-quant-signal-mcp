#!/usr/bin/env bash
# ops/cron/docs-drift-canary.sh — DOCS-GENERATOR-FROM-NAV-SOT-W1 CH5 (2026-07-14)
#
# 13th consumer of /opt/algovault-monitoring/send_telegram.sh. Belt-and-suspenders guard on the
# generated docs.html: the LIVE served page must still carry every section the ONE outline SoT
# (src/lib/docs-outline.ts ← nav publicToolEntries + channel-registry) emits.
#
# The PRIMARY gate is CI: `build_docs.mjs --check` runs in deploy.yml + prepublishOnly, so any
# structural drift entering via a git push is blocked BEFORE it deploys. This weekly cron catches
# the marginal RUNTIME path CI can't see — a host-side manual edit / partial sync-corruption of the
# DEPLOYED docs.html. NB: unlike nav-drift-canary, this runs a LIVE FETCH (curl), not
# `build_docs --check` in the container — docs.html is Caddy-static and is NOT copied into the app
# image (Dockerfile serves it host-side), so docs-src/ + docs.html are absent from the container.
# A live structural check on the served page is the faithful runtime equivalent.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# ships ONLY the pure alert branch (severity CRITICAL_PERSISTENT + OPS-<CLASS>-W{NEXT} template).
# send_telegram.sh OWNS the severity gate, 24h-per-alert_id cooldown, resolver, DRY_RUN_TG gate,
# and fail-open. This script is ALSO fail-open: every infra/network error logs + exits 0.
#
# Installed crontab (weekly, off-:00 per snapshot-sampler discipline): 29 6 * * 1  (Mon 06:29 UTC).
# NB: :43 / :37 collide with webhook-delivery-canary / seed-coverage-canary (per-hour) — :29 is clean
# (OPS-DOCS-JSONLD-TOOLCOUNT-W1 R3 endpoint-truth).
set -uo pipefail

URL="${DOCS_DRIFT_URL:-https://algovault.com/docs.html}"
RESOLVER="${DOCS_DRIFT_RESOLVER:-1.1.1.1}"   # pin a fixed resolver (DNS hygiene)
SEND="${DOCS_DRIFT_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${DOCS_DRIFT_LOG:-/var/log/docs-drift-canary.log}"
ALERT_ID="DOCS_STRUCTURE_DRIFT"

# Sections that MUST always be present in the served docs.html. Any absence = the served page has
# lost a section (host-side edit / partial-sync corruption). Kept in sync with docs-outline.ts:
# the 6 public tools + 4 channels + the 3 build_landing connect surfaces + the key H1/leaf sections.
REQUIRED_IDS=(
  quick-start
  get-trade-call get-market-regime scan-funding-arb scan-trade-calls chat-knowledge search-knowledge
  mcp rest-api webhooks telegram
  connect-mcp connect-ai-agent connect-exchange-kit
  live-dashboard verify pricing faq
)

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

command -v curl >/dev/null 2>&1 || { log "FAIL_OPEN: curl not on PATH"; exit 0; }

HOST=$(printf '%s' "$URL" | sed -E 's#https?://([^/]+).*#\1#')
IP=$(command -v dig >/dev/null 2>&1 && dig +short A "$HOST" "@$RESOLVER" 2>/dev/null | head -1 || true)
RESOLVE_ARGS=(); [ -n "$IP" ] && RESOLVE_ARGS=(--resolve "$HOST:443:$IP")

HTML=$(curl -fsS -m 20 --retry 2 --retry-delay 3 "${RESOLVE_ARGS[@]}" -A "algovault-docs-drift-canary" "$URL" 2>>"$LOG")
if [ -z "$HTML" ]; then
  log "FAIL_OPEN: empty/failed fetch of $URL (network/origin transient)"
  exit 0
fi

# Transient-fetch guard: a Cloudflare challenge / cold-cache miss / partial download can return a
# short non-docs body. Only proceed to the section check if this is CLEARLY the real docs page (its
# <title> + a reasonable size); otherwise FAIL-OPEN (log, no alert). A flaky fetch is NOT drift — the
# alarm fires only on a genuine served-page corruption, never on a transient (self-watch discipline).
BYTES=${#HTML}
# NB: use bash [[ == *…* ]], NOT `printf "$HTML" | grep -q …`. Under `set -o pipefail`, grep -q
# exits early on a match → printf gets SIGPIPE (141) → the pipeline reports FAILURE → a false
# "no-match" (which mismarked top-of-page sections as missing). [[ ]] has no pipe, no SIGPIPE.
if [ "$BYTES" -lt 50000 ] || [[ "$HTML" != *'<title>AlgoVault Docs'* ]]; then
  log "FAIL_OPEN: fetch of $URL returned ${BYTES} bytes without the docs <title> (transient CF challenge / partial) — not drift"
  exit 0
fi

# Synthetic-verification hook: append a guaranteed-absent id to FORCE the drift branch on the
# REAL page, so the alert path can be exercised end-to-end under DRY_RUN_TG=1 (no real corruption,
# no real send). Unset in production.
[ -n "${DOCS_DRIFT_FORCE_REQUIRE:-}" ] && REQUIRED_IDS+=("$DOCS_DRIFT_FORCE_REQUIRE")

MISSING=()
for id in "${REQUIRED_IDS[@]}"; do
  # bash substring match (no pipe → no pipefail+SIGPIPE false-negative; see the guard above)
  [[ "$HTML" == *"id=\"$id\""* ]] || MISSING+=("$id")
done

if [ "${#MISSING[@]}" -eq 0 ]; then
  log "OK: all ${#REQUIRED_IDS[@]} required docs sections present on $URL"
  exit 0
fi

log "DRIFT: served docs.html is missing ${#MISSING[@]} required section(s): ${MISSING[*]}"
[ -x "$SEND" ] || { log "FAIL_OPEN: send_telegram.sh not executable at $SEND"; exit 0; }

# Pure alert branch. send_telegram.sh owns every gate (severity → 24h cooldown → DRY_RUN_TG →
# fail-open). Its interface is POSITIONAL: `send_telegram.sh <alert_id> <severity> [body_file|-]`;
# the body (incl the OPS-<CLASS>-W{NEXT} recommended-wave template, resolved at send-time) is piped
# via stdin. (An earlier --flag form was silently SUPPRESSED_SEVERITY — the flags landed in the
# alert_id/severity slots.)
BODY="🛑 ${ALERT_ID}
Docs structure drift on the live site — the served ${URL} is missing required section(s): ${MISSING[*]}.
The docs sidebar/body derive from the ONE outline SoT (src/lib/docs-outline.ts); a section vanishing at runtime means a host-side edit or a partial deploy-sync corrupted the served page.
Recover: redeploy from main (build_docs regenerates docs.html) and re-verify \`node scripts/build_docs.mjs --check\`.
Recommended wave: OPS-DOCS-DRIFT-RESTORE-W{NEXT}"
printf '%s\n' "$BODY" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
exit 0
