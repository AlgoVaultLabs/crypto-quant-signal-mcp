#!/usr/bin/env bash
# closedbar-recalibrate-readiness.sh — OPS-CLOSEDBAR-RECALIBRATE-READINESS-W1 (M7)
#
# Hourly host wrapper for the READ-ONLY readiness harness. Cron invokes THIS file from the
# deploy checkout (`ops/cron/**` is deliberately NOT in deploy.yml's paths-ignore, because
# these wrappers are read from the host checkout rather than baked into the image). It is
# NOT copied into /opt/algovault-monitoring/ — a second copy would drift from its repo
# ancestor on every deploy and trip HASH_DRIFT / DIVERGENT_COPY.
#
# The harness itself runs INSIDE the app container, which is where DATABASE_URL lives, and
# computes its own verdict. This wrapper adds only the two things a verdict cannot do for
# itself: persist the series, and decide when a human should hear about it.
#
# ── Only two conditions are operator-actionable ──────────────────────────────
#   RECALIBRATE_READY            — fires ONCE EVER behind a marker. send_telegram's cooldown
#                                  is 24h, not once-ever, so a readiness gate without this
#                                  marker re-announces itself daily and gets muted.
#   RECALIBRATE_ACCRUAL_STALLED  — matured outcomes have not grown in 48h. This is the REAL
#                                  failure mode: a silently-stalled backfill holds the verdict
#                                  at NOT_READY forever and looks identical to "not enough
#                                  data yet". Without it, the wave that waits on this gate
#                                  waits forever with no explanation.
#
# NOT_READY is the expected steady state until the coarse timeframes accrue; it is logged,
# never paged. Alerts route through the shared send_telegram.sh, which owns cooldown /
# severity / fail-open — this wrapper never re-implements those gates.
set -uo pipefail

STATE_DIR=/var/lib/algovault-recalibrate
CTR=crypto-quant-signal-mcp-mcp-server-1
HARNESS=/app/dist/scripts/closedbar-recalibrate-readiness.js
TG=${RECALIBRATE_TG:-/opt/algovault-monitoring/send_telegram.sh}
STATE="$STATE_DIR/state.json"
READY_MARKER="$STATE_DIR/.recalibrate-ready.fired"
STALL_SECONDS=$((48 * 3600))
TODAY=$(date -u +%Y-%m-%d)
NOW_EPOCH=$(date -u +%s)

mkdir -p "$STATE_DIR"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/recalibrate.XXXXXX") || exit 0
trap 'rm -rf "$TMP"' EXIT

# M2 — re-read the methodology boundary from status.md HERE, on the host, because the harness
# runs inside the container where that path does not exist. Passed in by env; the harness falls
# back to its config copy (labelled) if this yields nothing, so a status.md change can never
# silently do nothing.
STATUS_MD=${RECALIBRATE_STATUS_MD:-/var/lib/algovault-monitoring/status.md}
BSTART=""; BEND=""
if [ -r "$STATUS_MD" ]; then
  IV=$(grep -oE '\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z → [0-9T:Z-]+\]' "$STATUS_MD" | head -1)
  BSTART=$(printf '%s' "$IV" | grep -oE '^\[[0-9-]{10}T[0-9:]{8}Z' | tr -d '[')
  BEND=$(printf '%s' "$IV" | sed -E 's/.*→ *//; s/\]//')
  # the record abbreviates the end when it shares the start's date
  case "$BEND" in
    ??:??:??Z) BEND="${BSTART%T*}T$BEND" ;;
  esac
  # Drift check: the config copy is a FALLBACK, not a second source of truth.
  CFG_END=$(python3 -c "import json;print(json.load(open('/opt/crypto-quant-signal-mcp/ops/closedbar-recalibrate-config.json'))['methodology_boundary']['end_utc'])" 2>/dev/null || echo '')
  if [ -n "$BEND" ] && [ -n "$CFG_END" ] && [ "$BEND" != "$CFG_END" ]; then
    echo "recalibrate-readiness: BOUNDARY DRIFT — status.md says end=$BEND, config says end=$CFG_END. status.md wins; reconcile the config."
  fi
fi

# -e MUST precede the container name: `docker exec [OPTIONS] CONTAINER COMMAND`. With the flags
# after "$CTR" docker took `-e` as the command and returned 127 — caught by the no-verdict-token
# branch below rather than passing silently, which is why that branch exists.
docker exec \
  -e RECALIBRATE_BOUNDARY_START="$BSTART" -e RECALIBRATE_BOUNDARY_END="$BEND" \
  "$CTR" node "$HARNESS" > "$TMP/report.txt" 2>"$TMP/err"
RC=$?

# The harness's contract: body first, verdict token ALWAYS LAST. A run that produced no
# token did not evaluate anything, and that is INDETERMINATE — never silently fine.
VERDICT=$(grep -E '^RECALIBRATE_READINESS_VERDICT=' "$TMP/report.txt" | tail -1)
if [ -z "$VERDICT" ]; then
  echo "recalibrate-readiness: harness produced NO verdict token (rc=$RC) — treating as INDETERMINATE"
  head -5 "$TMP/err" 2>/dev/null
  echo "RECALIBRATE_READINESS_VERDICT=INDETERMINATE"
  exit 3
fi

install -m 0644 "$TMP/report.txt" "$STATE_DIR/report-$TODAY.txt"

# `matured` is the growth signal for stall detection — parsed from the harness's own
# positive output line rather than re-queried, so the two can never disagree.
MATURED=$(grep -oE '^post_boundary: .*matured=[0-9]+' "$TMP/report.txt" | grep -oE 'matured=[0-9]+' | cut -d= -f2)
MATURED=${MATURED:-0}

PREV=0
LAST_GROWTH=$NOW_EPOCH
if [ -f "$STATE" ]; then
  PREV=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('last_matured',0))" "$STATE" 2>/dev/null || echo 0)
  LAST_GROWTH=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('last_growth_epoch',0))" "$STATE" 2>/dev/null || echo "$NOW_EPOCH")
fi
[ "$MATURED" -gt "$PREV" ] && LAST_GROWTH=$NOW_EPOCH

python3 - "$STATE" "$MATURED" "$LAST_GROWTH" "$NOW_EPOCH" "$VERDICT" <<'PY'
import json, sys
path, matured, growth, now, verdict = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
json.dump({"last_matured": matured, "last_growth_epoch": growth,
           "last_run_epoch": now, "last_verdict": verdict}, open(path, "w"), indent=1)
PY

STALLED_FOR=$((NOW_EPOCH - LAST_GROWTH))

case "$VERDICT" in
  *=PASS)
    if [ ! -f "$READY_MARKER" ]; then
      printf '✅ RECALIBRATE_READY\n\nPost-flip matured PFE outcomes have met the evidence bar — every per-timeframe and per-venue floor in ops/closedbar-recalibrate-config.json is satisfied.\n\nmatured=%s\nReport: %s\n\nThe recalibration can now READ instead of improvise. The atom-aware search is built in: any candidate adjacent to a mass point is rejected with the atom size named.\n\nAction: dispatch %s via Cowork → Claude Code\n' \
        "$MATURED" "$STATE_DIR/report-$TODAY.txt" "OPS-CLOSEDBAR-RECALIBRATE-W{NEXT}" \
        | "$TG" "RECALIBRATE_READY" CRITICAL_PERSISTENT - && touch "$READY_MARKER"
    fi
    ;;
esac

if [ "$STALLED_FOR" -gt "$STALL_SECONDS" ]; then
  printf '🛑 RECALIBRATE_ACCRUAL_STALLED\n\nMatured post-boundary outcomes have not grown in %sh (matured=%s, unchanged since the recorded growth stamp). The outcome backfill (`backfill-outcomes`, cron 2-59/3) is likely DARK — which would hold the readiness verdict at NOT_READY indefinitely while looking exactly like "not enough data yet".\n\nReport: %s\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$((STALLED_FOR / 3600))" "$MATURED" "$STATE_DIR/report-$TODAY.txt" "OPS-OUTCOME-BACKFILL-STALL-W{NEXT}" \
    | "$TG" "RECALIBRATE_ACCRUAL_STALLED" CRITICAL_PERSISTENT -
fi

# Positive, greppable evidence that this run evaluated something, verdict LAST so the gate
# (and a human) can `tail -1` it.
echo "recalibrate-readiness: date=$TODAY matured=$MATURED prev=$PREV stalled_for_h=$((STALLED_FOR / 3600)) report=$STATE_DIR/report-$TODAY.txt"
echo "$VERDICT"
