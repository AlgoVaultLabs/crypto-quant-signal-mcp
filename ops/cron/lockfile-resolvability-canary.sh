#!/usr/bin/env bash
# ops/cron/lockfile-resolvability-canary.sh — OPS-SUPPLY-CHAIN-RESOLVABILITY-W1 (2026-08-04)
#
# Consumer of /opt/algovault-monitoring/send_telegram.sh. Asserts the one supply-chain property
# that nothing else asserts and that no gate on the push path CAN assert: is every version pinned
# in package-lock.json STILL listed on the npm registry, today?
#
# WHY THIS IS SCHEDULED AND NOT A PUSH GATE. `npm ci` installs from each entry's pinned `resolved`
# URL, so it keeps succeeding for as long as the TARBALL is served — even after that version has
# been unpublished from the registry LISTING. A fresh `npm install` resolves against the listing
# and fails ETARGET. The two can disagree for months, and the moment you discover it is the moment
# you need the rebuild: a bad deploy, a corrupted layer, a host rebuild, a Hetzner incident. But
# answering the question costs ~780 registry requests, so putting it on the push path would put
# npmjs.com's availability on the deploy critical path — and a flaky blocking gate gets disabled
# within a week, which is strictly worse than a scheduled one. The push path runs the same script
# in --offline mode (provenance only, zero network); this is where the live property is checked.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# this consumer ships ONLY the pure alert branch (severity hardcoded, contract body shape with the
# recommended-wave TEMPLATE). send_telegram.sh OWNS the severity gate, the 24h-per-alert_id
# cooldown, OPS-<CLASS>-W{NEXT} resolution, DRY_RUN_TG and its own fail-open. Do NOT re-implement
# any of those here.
#
# This script is ALSO fail-open: every infra error logs and exits 0 rather than bouncing the cron.
# The gate's INDETERMINATE verdict (exit 3 — an unreachable registry) is deliberately NOT an alert:
# npmjs.com being briefly unreachable is not operator-actionable, and paging on it is how a canary
# earns a mute. It is logged, and a persistently dark run is caught by the monitoring inventory's
# own DARK check rather than by a second freshness signal invented here.
#
# Verdict source: the TOKEN, never the exit code (CLAUDE.md verdict-token law).
set -uo pipefail

REPO="${LOCKRES_REPO:-/opt/crypto-quant-signal-mcp}"
GATE="${LOCKRES_GATE:-$REPO/scripts/check-lockfile-resolvable.mjs}"
SEND="${LOCKRES_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
NODE_BIN="${LOCKRES_NODE:-/usr/bin/node}"
LOG="${LOCKRES_LOG:-/var/log/lockfile-resolvability-canary.log}"
ALERT_ID="LOCKFILE_PIN_UNRESOLVABLE"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG"; }

[ -x "$NODE_BIN" ] || { log "FAIL_OPEN: node not executable at $NODE_BIN"; exit 0; }
[ -f "$GATE" ]     || { log "FAIL_OPEN: gate missing at $GATE"; exit 0; }

# Run from the repo root so the gate's ROOT-relative package-lock.json is the DEPLOYED one.
OUT="$(cd "$REPO" && "$NODE_BIN" "$GATE" 2>&1)"
VERDICT="$(printf '%s\n' "$OUT" | grep -oE 'LOCKFILE_RESOLVABLE_VERDICT=[A-Z]+' | tail -1 | cut -d= -f2)"

# No token at all means the gate did not run to completion. That is indistinguishable from a
# healthy silent pass unless we say so, so it is logged loudly and treated as unverified.
[ -n "$VERDICT" ] || { log "FAIL_OPEN: gate produced NO verdict token; output follows"; printf '%s\n' "$OUT" >> "$LOG"; exit 0; }

case "$VERDICT" in
  PASS)
    log "OK — every pinned version is still listed on the registry. $(printf '%s\n' "$OUT" | grep -F '+ resolvable:' || true)"
    exit 0
    ;;
  INDETERMINATE)
    log "INDETERMINATE — the registry did not answer; the property is UNVERIFIED this cycle (not alerting, not a pass)"
    printf '%s\n' "$OUT" >> "$LOG"
    exit 0
    ;;
  FAIL) : ;;
  *)
    log "FAIL_OPEN: unrecognised verdict token '$VERDICT'"
    exit 0
    ;;
esac

# ── FAIL: operator action required ───────────────────────────────────────────
# The gate already separates DELISTED-BUT-SERVED (npm ci works, a fresh npm install ETARGETs —
# there is time) from GONE (a clean-cache rebuild is ALREADY broken). Carry that distinction into
# the alert body verbatim, because it is the whole difference in urgency.
log "FAIL — unresolvable pin(s) detected"
printf '%s\n' "$OUT" >> "$LOG"

[ -x "$SEND" ] || { log "FAIL_OPEN: send_telegram.sh not executable at $SEND — alert NOT delivered"; exit 0; }

# Render the ID SET with its entity noun. A bare parenthesised number next to a count reads as a
# quantity — that cost a real operator misread on WEBHOOK_DELIVERY_DRIFT (2026-08-01), so pins are
# always named as `pinned version(s) <list>`, never as a naked figure.
PINS="$(printf '%s\n' "$OUT" | grep -oE '^   - [^ ]+' | sed 's/^   - //' | paste -sd', ' -)"
COUNT="$(printf '%s\n' "$OUT" | grep -cE '^   - ')"
DETAIL="$(printf '%s\n' "$OUT" | grep -E '^   - |DELISTED BUT SERVED|GONE:' | head -12)"
WORST="DELISTED_BUT_SERVED (npm ci still works; a fresh npm install already ETARGETs)"
printf '%s\n' "$OUT" | grep -q 'GONE:' && WORST="GONE (a clean-cache rebuild is ALREADY broken)"

# Pure alert branch. send_telegram.sh interface is POSITIONAL: `send_telegram.sh <alert_id>
# <severity> [body_file|-]`; body via stdin (the OPS-<CLASS>-W{NEXT} template resolves at send-time).
BODY="🛑 ${ALERT_ID}
${COUNT} pinned version(s) in package-lock.json are no longer listed on the npm registry: ${PINS}
Worst case: ${WORST}
Why it matters: every recovery path this project has ends in a rebuild, and \`npm ci\` masks this until the tarball is GC'd — the failure surfaces exactly when the rebuild is needed.

${DETAIL}

Fix: bump the PARENT that pins it (\`npm ls <pkg>\`), or add a scoped \`overrides\` entry if no parent bump is safe. Prefer the parent bump — an override pins a transitive resolution that then silently diverges from what the parent expects. Then re-run \`node scripts/check-lockfile-resolvable.mjs --attest\` and commit scripts/data/lockfile-resolvability.json.
Source log: ${LOG}
Recommended wave: OPS-SUPPLY-CHAIN-UNRESOLVABLE-PIN-W{NEXT}"
printf '%s\n' "$BODY" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
exit 0
